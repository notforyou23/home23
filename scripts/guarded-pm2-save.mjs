#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  booleanFlag,
  failCli,
  isMain,
  one,
  parseCli,
  receiptContext,
  sha256Bytes,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);

export const APPROVED_BRAIN_PROCESS_NAMES = Object.freeze([
  'home23-cosmo23',
  'home23-jerry',
  'home23-forrest',
  'home23-jerry-dash',
  'home23-forrest-dash',
  'home23-jerry-harness',
  'home23-forrest-harness',
  'home23-jerry-mcp',
  'home23-forrest-mcp',
]);
const APPROVED_ALLOWLIST = new Set(APPROVED_BRAIN_PROCESS_NAMES);
const REQUIRED_CONFIGURED_PROCESS_NAMES = Object.freeze(APPROVED_BRAIN_PROCESS_NAMES.slice(0, 7));
const APPROVED_ENV_ADDITION = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';

function orderedStrings(value) {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => String(entry));
}

function normalizeExecMode(value) {
  const mode = String(value ?? 'fork_mode');
  if (mode === 'fork') return 'fork_mode';
  if (mode === 'cluster') return 'cluster_mode';
  return mode;
}

function envKeys(row) {
  const keys = new Set();
  for (const container of [row?.env, row?.pm2_env?.env]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const key of Object.keys(container)) keys.add(key);
  }
  const flattened = row?.pm2_env || row;
  const pm2Metadata = new Set([
    'name', 'namespace', 'status', 'pm_id', 'pm_pid', 'pid', 'pm_uptime', 'created_at',
    'restart_time', 'unstable_restarts', 'exit_code', 'node_version', 'version',
    'pm_exec_path', 'pm_cwd', 'exec_mode', 'instances', 'args', 'node_args', 'interpreter',
    'exec_interpreter', 'autorestart', 'autostart', 'watch', 'merge_logs', 'out_file',
    'error_file', 'pm_out_log_path', 'pm_err_log_path', 'pm_log_path', 'kill_retry_time',
    'vizion', 'treekill', 'windowsHide', 'username', 'uid', 'gid', 'cwd', 'script',
    'axm_dynamic', 'axm_options', 'axm_monitor', 'axm_actions', 'env', 'filter_env',
    'envKeys', 'unique_id', 'prev_restart_delay', 'restart_delay', 'max_memory_restart',
    'cron_restart', 'exp_backoff_restart_delay', 'stop_exit_codes', 'source_map_support',
    'instance_var', 'increment_var', 'automation', 'km_link', 'pmx', 'log_type',
    'log_date_format', 'combine_logs', 'time', 'wait_ready', 'listen_timeout',
    'kill_timeout', 'shutdown_with_message', 'namespace_id', 'from_chokidar',
  ]);
  if (flattened && typeof flattened === 'object' && !Array.isArray(flattened)) {
    for (const key of Object.keys(flattened)) {
      if (!pm2Metadata.has(key)) keys.add(key);
    }
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

export function normalizePm2Row(row) {
  // `pm2 jlist` nests process metadata under `pm2_env`, while dump.pm2 stores
  // that same metadata at the top level. Normalize both shapes through the
  // same view so a safe pre-save comparison does not report false drift.
  const environment = row?.pm2_env || row || {};
  const name = row?.name ?? environment.name;
  if (typeof name !== 'string' || !name || /[\0\r\n]/.test(name)) throw typedError('pm2_row_invalid');
  const rawPid = row?.pid ?? environment.pid ?? environment.pm_pid;
  const pid = rawPid === undefined || rawPid === null || rawPid === '' ? null : Number(rawPid);
  const restartCount = Number(environment.restart_time ?? row?.restartCount ?? 0);
  const instances = Number(environment.instances ?? row?.instances ?? 1);
  if ((pid !== null && (!Number.isSafeInteger(pid) || pid < 1))
      || !Number.isSafeInteger(restartCount) || restartCount < 0
      || !Number.isSafeInteger(instances) || instances < 1) {
    throw typedError('pm2_row_invalid', name);
  }
  return Object.freeze({
    name,
    status: String(environment.status ?? row?.status ?? 'unknown'),
    pid,
    restartCount,
    script: String(environment.pm_exec_path ?? row?.script ?? ''),
    cwd: String(environment.pm_cwd ?? row?.cwd ?? ''),
    namespace: String(environment.namespace ?? row?.namespace ?? 'default'),
    execMode: normalizeExecMode(environment.exec_mode ?? row?.execMode ?? ''),
    instances,
    args: orderedStrings(environment.args ?? row?.args),
    envKeys: envKeys(row),
  });
}

export function normalizeEcosystemRow(row, baseDir = process.cwd()) {
  const name = row?.name;
  if (typeof name !== 'string' || !APPROVED_ALLOWLIST.has(name)) {
    throw typedError('pm2_ecosystem_row_invalid', String(name || 'unnamed'));
  }
  const cwdValue = row?.cwd ?? baseDir;
  const scriptValue = row?.script;
  if (typeof cwdValue !== 'string' || !cwdValue
      || typeof scriptValue !== 'string' || !scriptValue
      || /[\0\r\n]/.test(cwdValue) || /[\0\r\n]/.test(scriptValue)) {
    throw typedError('pm2_ecosystem_row_invalid', name);
  }
  const cwd = path.resolve(baseDir, cwdValue);
  const script = path.isAbsolute(scriptValue)
    ? path.normalize(scriptValue)
    : path.resolve(cwd, scriptValue);
  const instances = Number(row?.instances ?? 1);
  if (!Number.isSafeInteger(instances) || instances < 1) {
    throw typedError('pm2_ecosystem_row_invalid', name);
  }
  return Object.freeze({
    name,
    script,
    cwd,
    namespace: String(row?.namespace ?? 'default'),
    execMode: normalizeExecMode(row?.exec_mode ?? row?.execMode ?? 'fork_mode'),
    instances,
    args: orderedStrings(row?.args),
  });
}

export function normalizeEcosystemTable(rows, baseDir = process.cwd()) {
  if (!Array.isArray(rows)) throw typedError('pm2_ecosystem_invalid');
  const table = new Map();
  for (const row of rows) {
    if (!APPROVED_ALLOWLIST.has(row?.name)) continue;
    const normalized = normalizeEcosystemRow(row, baseDir);
    if (table.has(normalized.name)) {
      throw typedError('pm2_ecosystem_duplicate_process', normalized.name);
    }
    table.set(normalized.name, normalized);
  }
  return table;
}

export function normalizePm2Table(rows, label = 'PM2 table') {
  if (!Array.isArray(rows)) throw typedError('pm2_table_invalid', label);
  const table = new Map();
  for (const row of rows) {
    const normalized = normalizePm2Row(row);
    if (table.has(normalized.name)) throw typedError('pm2_duplicate_process', normalized.name);
    if (normalized.status !== 'online') throw typedError('pm2_process_not_online', normalized.name);
    table.set(normalized.name, normalized);
  }
  return table;
}

function tableRows(table) {
  return [...table.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function equalRow(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dumpComparableLiveRow(live, dump) {
  return dump.pid === null ? { ...live, pid: null } : live;
}

function equalLiveAndDumpRow(live, dump) {
  return equalRow(dumpComparableLiveRow(live, dump), dump);
}

function equalAllowlistedIdentity(left, right) {
  const mutable = new Set(['pid', 'restartCount', 'envKeys']);
  const stableLeft = Object.fromEntries(
    Object.entries(left).filter(([key]) => !mutable.has(key)),
  );
  const stableRight = Object.fromEntries(
    Object.entries(right).filter(([key]) => !mutable.has(key)),
  );
  return equalRow(stableLeft, stableRight);
}

function processIdentity(row) {
  return {
    name: row.name,
    script: row.script,
    cwd: row.cwd,
    namespace: row.namespace,
    execMode: row.execMode,
    instances: row.instances,
    args: row.args,
  };
}

function equalEcosystemIdentity(live, expected) {
  return equalRow(processIdentity(live), expected);
}

function assertPlannedAllowlistedDelta(live, dump, name) {
  if (!equalAllowlistedIdentity(live, dump)) {
    throw typedError('pm2_allowlisted_identity_drift', name);
  }
  if (live.restartCount < dump.restartCount) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
  const liveKeys = new Set(live.envKeys);
  const dumpKeys = new Set(dump.envKeys);
  if ([...dumpKeys].some((key) => !liveKeys.has(key))) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
  const added = [...liveKeys].filter((key) => !dumpKeys.has(key));
  if (added.some((key) => key !== APPROVED_ENV_ADDITION)) {
    throw typedError('pm2_allowlisted_delta_invalid', name);
  }
}

export function comparePreSaveTables(live, dump, allowChanged, ecosystemIdentities = new Map()) {
  const names = new Set([...live.keys(), ...dump.keys()]);
  for (const name of names) {
    if (!live.has(name)) throw typedError('pm2_table_drift', name);
    if (!dump.has(name)) {
      if (allowChanged.has(name)) {
        const expected = ecosystemIdentities.get(name);
        if (!expected) throw typedError('pm2_ecosystem_identity_missing', name);
        if (!equalEcosystemIdentity(live.get(name), expected)) {
          throw typedError('pm2_ecosystem_identity_mismatch', name);
        }
        continue;
      }
      throw typedError('pm2_table_drift', name);
    }
    const liveRow = live.get(name);
    const dumpRow = dump.get(name);
    if (!allowChanged.has(name) && !equalLiveAndDumpRow(liveRow, dumpRow)) {
      throw typedError('pm2_unrelated_drift', name);
    }
    if (allowChanged.has(name)) assertPlannedAllowlistedDelta(liveRow, dumpRow, name);
  }
}

function assertExpectedConfiguredAuthority(expectedConfigured, ecosystemIdentities) {
  if (!Array.isArray(expectedConfigured) || expectedConfigured.length === 0
      || new Set(expectedConfigured).size !== expectedConfigured.length
      || expectedConfigured.some((name) => !APPROVED_ALLOWLIST.has(name))
      || REQUIRED_CONFIGURED_PROCESS_NAMES.some((name) => !expectedConfigured.includes(name))) {
    throw typedError('pm2_expected_configured_invalid');
  }
  const expected = new Set(expectedConfigured);
  if (expected.size !== ecosystemIdentities.size
      || [...expected].some((name) => !ecosystemIdentities.has(name))) {
    throw typedError('pm2_expected_configured_mismatch');
  }
}

function assertExpectedConfiguredPresent(table, expectedConfigured, label) {
  for (const name of expectedConfigured) {
    if (!table.has(name)) throw typedError('pm2_expected_process_missing', `${label}:${name}`);
  }
}

function assertApprovedAllowlist(values) {
  if (!Array.isArray(values) || values.length !== APPROVED_BRAIN_PROCESS_NAMES.length
      || new Set(values).size !== values.length
      || values.some((name) => !APPROVED_ALLOWLIST.has(name))) {
    throw typedError('pm2_allowlist_invalid');
  }
}

function assertFrozenLive(before, after) {
  if (before.size !== after.size) throw typedError('pm2_live_table_changed');
  for (const [name, row] of before) {
    if (!after.has(name) || !equalRow(row, after.get(name))) throw typedError('pm2_live_table_changed', name);
  }
}

function assertDumpEqualsLive(live, dump) {
  if (live.size !== dump.size) throw typedError('pm2_dump_postcondition_failed');
  for (const [name, row] of live) {
    if (!dump.has(name) || !equalLiveAndDumpRow(row, dump.get(name))) {
      throw typedError('pm2_dump_postcondition_failed', name);
    }
  }
}

async function defaultListProcesses() {
  const { stdout } = await execFile('pm2', ['jlist'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function defaultSave() {
  await execFile('pm2', ['save'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function loadEcosystemApps(ecosystemPath) {
  let resolved;
  try {
    resolved = require.resolve(ecosystemPath);
    delete require.cache[resolved];
    const document = require(resolved);
    if (!document || !Array.isArray(document.apps)) throw new Error('apps missing');
    return document.apps;
  } catch (error) {
    throw typedError('pm2_ecosystem_invalid', ecosystemPath, { cause: error });
  }
}

async function readDumpDocument(dumpPath) {
  const bytes = await fsp.readFile(dumpPath);
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw typedError('pm2_dump_invalid', 'dump.pm2 is invalid JSON', { cause: error }); }
  const stat = await fsp.lstat(dumpPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw typedError('pm2_dump_invalid');
  return { bytes, document, mode: Number(stat.mode & 0o777n) };
}

async function restoreDumpAtomic(dumpPath, bytes, mode) {
  const temporary = `${dumpPath}.${process.pid}.${Date.now()}.restore`;
  const handle = await fsp.open(temporary, 'wx', mode || 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, dumpPath);
  await fsp.chmod(dumpPath, mode || 0o600);
}

export async function guardedPm2Save({
  dumpPath,
  allowChanged = [],
  expectedConfigured,
  ecosystemApps,
  ecosystemBaseDir = process.cwd(),
  backupPath,
  apply = false,
  listProcesses = defaultListProcesses,
  save = defaultSave,
  readDump = readDumpDocument,
  restoreDump = restoreDumpAtomic,
} = {}) {
  if (typeof dumpPath !== 'string' || !path.isAbsolute(dumpPath)
      || typeof backupPath !== 'string' || !path.isAbsolute(backupPath)) {
    throw typedError('pm2_paths_invalid');
  }
  const allow = new Set(allowChanged);
  assertApprovedAllowlist(allowChanged);
  const ecosystemIdentities = normalizeEcosystemTable(ecosystemApps, ecosystemBaseDir);
  assertExpectedConfiguredAuthority(expectedConfigured, ecosystemIdentities);
  const original = await readDump(dumpPath).catch((error) => {
    if (error.code === 'ENOENT') throw typedError('pm2_dump_missing');
    throw error;
  });
  await fsp.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(backupPath, original.bytes, { mode: 0o600, flag: 'wx' });
  const backupStat = await fsp.lstat(backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()
      || (backupStat.mode & 0o777) !== 0o600
      || !Buffer.from(await fsp.readFile(backupPath)).equals(original.bytes)) {
    throw typedError('pm2_backup_invalid');
  }
  const liveBefore = normalizePm2Table(await listProcesses(), 'live PM2 table');
  const dumpBefore = normalizePm2Table(original.document, 'dump PM2 table');
  assertExpectedConfiguredPresent(liveBefore, expectedConfigured, 'live');
  comparePreSaveTables(liveBefore, dumpBefore, allow, ecosystemIdentities);
  const result = {
    ok: true,
    applied: false,
    dumpPath,
    backupPath,
    backupMode: '0600',
    originalMode: original.mode.toString(8).padStart(4, '0'),
    originalSha256: sha256Bytes(original.bytes),
    allowChanged: [...allow].sort(),
    expectedConfigured: [...expectedConfigured].sort(),
    ecosystemIdentity: tableRows(ecosystemIdentities),
    liveTable: tableRows(liveBefore),
    dumpTableBefore: tableRows(dumpBefore),
    dumpTableAfter: null,
    restored: false,
    restorationVerified: false,
  };
  if (!apply) return result;
  let saveInvoked = false;
  try {
    saveInvoked = true;
    await save();
    const liveAfter = normalizePm2Table(await listProcesses(), 'post-save live PM2 table');
    assertFrozenLive(liveBefore, liveAfter);
    const post = await readDump(dumpPath);
    const dumpAfter = normalizePm2Table(post.document, 'post-save dump PM2 table');
    assertExpectedConfiguredPresent(dumpAfter, expectedConfigured, 'post-save-dump');
    assertDumpEqualsLive(liveBefore, dumpAfter);
    result.applied = true;
    result.dumpTableAfter = tableRows(dumpAfter);
    result.dumpSha256After = sha256Bytes(post.bytes);
    return result;
  } catch (error) {
    if (saveInvoked) {
      await restoreDump(dumpPath, original.bytes, original.mode);
      result.restored = true;
      const [restoredBytes, restoredStat] = await Promise.all([
        fsp.readFile(dumpPath),
        fsp.lstat(dumpPath),
      ]).catch((cause) => {
        throw typedError('pm2_dump_restore_failed', 'restored dump could not be read', { cause });
      });
      if (!restoredStat.isFile() || restoredStat.isSymbolicLink()
          || Number(restoredStat.mode & 0o777) !== original.mode
          || !Buffer.from(restoredBytes).equals(original.bytes)) {
        throw typedError('pm2_dump_restore_failed', 'restored dump bytes or mode mismatch', {
          cause: error,
        });
      }
      result.restorationVerified = true;
    }
    error.pm2Save = result;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const context = await receiptContext(values, env);
  const dumpPath = path.resolve(one(values, 'dump', { required: true }));
  const ecosystemPath = path.resolve(one(values, 'ecosystem', { required: true }));
  const allowChanged = String(one(values, 'allow-changed', { required: true }))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const expectedConfigured = String(one(values, 'expected-configured', { required: true }))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const backupName = `pm2-dump-backup-${sha256Bytes(Buffer.from(`${context.receiptRunId}:${dumpPath}`)).slice(0, 16)}.pm2`;
  const backupPath = path.join(context.receiptRunDir, 'backups', backupName);
  const dryRun = booleanFlag(values, 'dry-run', false);
  const apply = values.apply === undefined ? !dryRun : booleanFlag(values, 'apply', true);
  if (dryRun && apply) throw typedError('pm2_apply_mode_conflict');
  const result = await guardedPm2Save({
    dumpPath,
    allowChanged,
    expectedConfigured,
    ecosystemApps: loadEcosystemApps(ecosystemPath),
    ecosystemBaseDir: path.dirname(ecosystemPath),
    backupPath,
    apply,
  });
  return writeJsonReceipt(context, path.resolve(one(values, 'output', { required: true })), {
    helper: 'guarded-pm2-save',
    ...result,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
