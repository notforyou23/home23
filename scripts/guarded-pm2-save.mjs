#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import fsp from 'node:fs/promises';
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

function orderedStrings(value) {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => String(entry));
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
    execMode: String(environment.exec_mode ?? row?.execMode ?? ''),
    instances,
    args: orderedStrings(environment.args ?? row?.args),
    envKeys: envKeys(row),
  });
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

export function comparePreSaveTables(live, dump, allowChanged) {
  const names = new Set([...live.keys(), ...dump.keys()]);
  for (const name of names) {
    if (!live.has(name) || !dump.has(name)) throw typedError('pm2_table_drift', name);
    const liveRow = live.get(name);
    const dumpRow = dump.get(name);
    if (!allowChanged.has(name) && !equalLiveAndDumpRow(liveRow, dumpRow)) {
      throw typedError('pm2_unrelated_drift', name);
    }
    if (allowChanged.has(name) && !equalAllowlistedIdentity(liveRow, dumpRow)) {
      throw typedError('pm2_allowlisted_identity_drift', name);
    }
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
  if (allow.size !== allowChanged.length || allowChanged.some((name) => !name)) {
    throw typedError('pm2_allowlist_invalid');
  }
  const original = await readDump(dumpPath).catch((error) => {
    if (error.code === 'ENOENT') throw typedError('pm2_dump_missing');
    throw error;
  });
  await fsp.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(backupPath, original.bytes, { mode: 0o600, flag: 'wx' });
  const liveBefore = normalizePm2Table(await listProcesses(), 'live PM2 table');
  const dumpBefore = normalizePm2Table(original.document, 'dump PM2 table');
  comparePreSaveTables(liveBefore, dumpBefore, allow);
  const result = {
    ok: true,
    applied: false,
    dumpPath,
    backupPath,
    backupMode: '0600',
    originalMode: original.mode.toString(8).padStart(4, '0'),
    originalSha256: sha256Bytes(original.bytes),
    allowChanged: [...allow].sort(),
    liveTable: tableRows(liveBefore),
    dumpTableBefore: tableRows(dumpBefore),
    dumpTableAfter: null,
    restored: false,
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
    assertDumpEqualsLive(liveBefore, dumpAfter);
    result.applied = true;
    result.dumpTableAfter = tableRows(dumpAfter);
    result.dumpSha256After = sha256Bytes(post.bytes);
    return result;
  } catch (error) {
    if (saveInvoked) {
      await restoreDump(dumpPath, original.bytes, original.mode);
      result.restored = true;
    }
    error.pm2Save = result;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const context = await receiptContext(values, env);
  const dumpPath = path.resolve(one(values, 'dump', { required: true }));
  const allowChanged = String(one(values, 'allow-changed', { required: true }))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const backupName = `pm2-dump-backup-${sha256Bytes(Buffer.from(`${context.receiptRunId}:${dumpPath}`)).slice(0, 16)}.pm2`;
  const backupPath = path.join(context.receiptRunDir, 'backups', backupName);
  const dryRun = booleanFlag(values, 'dry-run', false);
  const apply = values.apply === undefined ? !dryRun : booleanFlag(values, 'apply', true);
  if (dryRun && apply) throw typedError('pm2_apply_mode_conflict');
  const result = await guardedPm2Save({
    dumpPath,
    allowChanged,
    backupPath,
    apply,
  });
  return writeJsonReceipt(context, path.resolve(one(values, 'output', { required: true })), {
    helper: 'guarded-pm2-save',
    ...result,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
