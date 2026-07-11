#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  canonicalDirectory,
  failCli,
  isInsideOrEqual,
  isMain,
  one,
  parseCli,
  readJson,
  sha256Bytes,
  typedError,
} from './lib/brain-acceptance-common.mjs';

const execFile = promisify(execFileCallback);

async function git(cwd, args, options = {}) {
  try {
    const result = await execFile('git', args, {
      cwd,
      encoding: options.encoding === null ? null : 'utf8',
      maxBuffer: options.maxBuffer || 256 * 1024 * 1024,
      env: options.env || process.env,
    });
    return result.stdout;
  } catch (error) {
    throw typedError('git_command_failed', `git ${args.join(' ')} failed`, { cause: error });
  }
}

function splitNull(bufferOrString) {
  const buffer = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(bufferOrString);
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

async function resolveCommit(liveRoot, value, label) {
  const resolved = String(await git(liveRoot, ['rev-parse', '--verify', `${value}^{commit}`])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(resolved)) throw typedError('commit_invalid', label);
  return resolved;
}

async function treeEntries(liveRoot, commit) {
  const raw = await git(liveRoot, ['ls-tree', '-rz', '-r', commit], { encoding: null });
  const entries = new Map();
  for (const row of splitNull(raw)) {
    const tab = row.indexOf('\t');
    const header = row.slice(0, tab).split(' ');
    const filePath = row.slice(tab + 1);
    if (tab < 0 || header.length !== 3 || entries.has(filePath)) throw typedError('tree_invalid');
    entries.set(filePath, { mode: header[0], type: header[1], oid: header[2] });
  }
  return entries;
}

async function blobBytes(liveRoot, entry) {
  if (!entry) return null;
  if (entry.type !== 'blob') throw typedError('unsupported_tree_entry');
  return git(liveRoot, ['cat-file', 'blob', entry.oid], { encoding: null });
}

function blobIdentity(entry, bytes) {
  if (!entry) return null;
  return { mode: entry.mode, bytes };
}

function sameBlob(left, right) {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.bytes.equals(right.bytes);
}

async function workingBlob(liveRoot, filePath) {
  const absolute = path.join(liveRoot, filePath);
  if (!isInsideOrEqual(liveRoot, absolute)) throw typedError('working_path_invalid');
  let stat;
  try { stat = await fsp.lstat(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { mode: '120000', bytes: Buffer.from(await fsp.readlink(absolute)) };
  }
  if (!stat.isFile()) throw typedError('working_path_invalid', filePath);
  return { mode: (stat.mode & 0o111) ? '100755' : '100644', bytes: await fsp.readFile(absolute) };
}

function containsBinary(bytes) {
  return bytes?.includes(0) === true;
}

async function mergeFileBytes({ auditDir, filePath, live, base, feature }) {
  if (!live || !base || !feature || live.mode !== base.mode || feature.mode !== base.mode
      || containsBinary(live.bytes) || containsBinary(base.bytes) || containsBinary(feature.bytes)) {
    return null;
  }
  const mergeRoot = path.join(auditDir, 'merge-inputs');
  await fsp.mkdir(mergeRoot, { recursive: true, mode: 0o700 });
  const token = createHash('sha256').update(filePath).digest('hex');
  const files = {
    live: path.join(mergeRoot, `${token}.live`),
    base: path.join(mergeRoot, `${token}.base`),
    feature: path.join(mergeRoot, `${token}.feature`),
  };
  await Promise.all([
    fsp.writeFile(files.live, live.bytes, { mode: 0o600 }),
    fsp.writeFile(files.base, base.bytes, { mode: 0o600 }),
    fsp.writeFile(files.feature, feature.bytes, { mode: 0o600 }),
  ]);
  try {
    const { stdout } = await execFile('git', [
      'merge-file', '-p', '--diff3', files.live, files.base, files.feature,
    ], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
    return { mode: live.mode, bytes: stdout };
  } catch (error) {
    if (error.code === 1) return null;
    throw typedError('three_way_merge_failed', filePath, { cause: error });
  }
}

function hashBlob(blob) {
  return blob ? sha256Bytes(blob.bytes) : null;
}

async function materializeBlob(root, filePath, blob) {
  if (!blob) return;
  const destination = path.join(root, filePath);
  if (!isInsideOrEqual(root, destination)) throw typedError('expected_path_invalid');
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (blob.mode === '120000') {
    await fsp.symlink(blob.bytes.toString('utf8'), destination);
    return;
  }
  await fsp.writeFile(destination, blob.bytes, {
    mode: blob.mode === '100755' ? 0o755 : 0o644,
    flag: 'wx',
  });
}

async function gitPath(liveRoot, name) {
  const value = String(await git(liveRoot, ['rev-parse', '--git-path', name])).trim();
  return path.isAbsolute(value) ? value : path.resolve(liveRoot, value);
}

async function fileHashOrAbsent(file) {
  try { return sha256Bytes(await fsp.readFile(file)); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function untrackedInventory(liveRoot, excluded = new Set()) {
  const raw = await git(liveRoot, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null });
  const output = [];
  for (const filePath of splitNull(raw).sort()) {
    if (excluded.has(filePath)) continue;
    const blob = await workingBlob(liveRoot, filePath);
    output.push({ path: filePath, mode: blob?.mode || null, sha256: hashBlob(blob) });
  }
  return output;
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writePreAuthorityFile(auditDir, relative, bytes) {
  const target = path.join(auditDir, relative);
  if (!isInsideOrEqual(auditDir, target) || target === auditDir) {
    throw typedError('deployment_output_invalid');
  }
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await fsp.realpath(parent);
  if (!isInsideOrEqual(auditDir, canonicalParent)) throw typedError('deployment_output_invalid');
  const temporary = path.join(
    canonicalParent,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw typedError('deployment_output_invalid');
    }
    await fsp.rename(temporary, target);
    await syncDirectory(canonicalParent);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

async function writePreAuthorityJson(auditDir, relative, value) {
  await writePreAuthorityFile(auditDir, relative, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

async function writeState(auditDir, state) {
  return writePreAuthorityJson(auditDir, 'deployment-state.json', {
    helper: 'verify-live-deployment-tree',
    artifact: 'state',
    preAuthority: true,
    ...state,
  });
}

async function readState(auditDir) {
  return readJson(path.join(auditDir, 'deployment-state.json'));
}

export async function prepareDeploymentTree({ base, feature, liveRoot, auditDir } = {}) {
  const live = await canonicalDirectory(liveRoot, 'live checkout');
  const audit = await canonicalDirectory(auditDir, 'deployment audit directory', { create: true });
  if (isInsideOrEqual(live.path, audit.path) || isInsideOrEqual(audit.path, live.path)) {
    throw typedError('audit_tree_overlap');
  }
  const baseCommit = await resolveCommit(live.path, base, 'base');
  const featureCommit = await resolveCommit(live.path, feature, 'feature');
  const baseEntries = await treeEntries(live.path, baseCommit);
  const featureEntries = await treeEntries(live.path, featureCommit);
  const tracked = new Set(splitNull(await git(live.path, ['ls-files', '-z'], { encoding: null })));
  const untracked = new Set(splitNull(await git(
    live.path, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: null },
  )));
  const paths = new Set([...baseEntries.keys(), ...featureEntries.keys(), ...tracked]);
  for (const candidate of untracked) {
    if (baseEntries.has(candidate) || featureEntries.has(candidate)) paths.add(candidate);
  }
  const expectedRoot = path.join(audit.path, 'expected', 'files');
  await fsp.rm(path.join(audit.path, 'expected'), { recursive: true, force: true });
  await fsp.mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  const threeWayRows = [];
  const expectedManifest = [];
  const expectedAbsent = [];
  const conflicts = [];
  for (const filePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const baseEntry = baseEntries.get(filePath) || null;
    const featureEntry = featureEntries.get(filePath) || null;
    const baseBlob = blobIdentity(baseEntry, await blobBytes(live.path, baseEntry));
    const featureBlob = blobIdentity(featureEntry, await blobBytes(live.path, featureEntry));
    const liveBlob = await workingBlob(live.path, filePath);
    let merged;
    let resolution;
    if (sameBlob(liveBlob, baseBlob)) {
      merged = featureBlob;
      resolution = 'feature';
    } else if (sameBlob(featureBlob, baseBlob)) {
      merged = liveBlob;
      resolution = 'live';
    } else if (sameBlob(liveBlob, featureBlob)) {
      merged = liveBlob;
      resolution = 'identical';
    } else {
      merged = await mergeFileBytes({ auditDir: audit.path, filePath, live: liveBlob, base: baseBlob, feature: featureBlob });
      resolution = merged ? 'merged' : 'conflict';
    }
    const row = {
      helper: 'verify-live-deployment-tree',
      artifact: 'three-way-row',
      path: filePath,
      baseOid: baseEntry?.oid || null,
      featureOid: featureEntry?.oid || null,
      liveHash: hashBlob(liveBlob),
      mergedHash: hashBlob(merged),
      liveMode: liveBlob?.mode || null,
      mergedMode: merged?.mode || null,
      resolution,
    };
    const pending = !sameBlob(baseBlob, featureBlob) || !sameBlob(baseBlob, liveBlob);
    if (pending) threeWayRows.push(row);
    if (!merged && resolution === 'conflict') conflicts.push(filePath);
    if (merged) {
      await materializeBlob(expectedRoot, filePath, merged);
      expectedManifest.push({ path: filePath, mode: merged.mode, sha256: hashBlob(merged) });
    } else if (resolution !== 'conflict') {
      expectedAbsent.push(filePath);
    }
  }
  const indexPath = await gitPath(live.path, 'index');
  const indexHash = await fileHashOrAbsent(indexPath);
  const unrelatedUntracked = await untrackedInventory(live.path, new Set(expectedManifest.map((row) => row.path)));
  const state = {
    schemaVersion: 1,
    phase: 'prepared',
    base: baseCommit,
    feature: featureCommit,
    liveRoot: live.path,
    auditDir: audit.path,
    expectedRoot,
    expectedManifest,
    expectedAbsent,
    conflicts,
    liveIndexPath: indexPath,
    liveIndexSha256: indexHash,
    unrelatedUntracked,
    expectedTree: null,
    actualTree: null,
  };
  await writePreAuthorityFile(
    audit.path,
    'three-way.jsonl',
    threeWayRows.map((row) => JSON.stringify(row)).join('\n') + (threeWayRows.length ? '\n' : ''),
  );
  await writeState(audit.path, state);
  await writePreAuthorityJson(audit.path, 'deployment-tree.json', {
    helper: 'verify-live-deployment-tree',
    mode: 'prepare',
    preAuthority: true,
    ok: conflicts.length === 0,
    ...state,
  });
  if (conflicts.length) throw typedError('deployment_tree_conflict', conflicts.join(','), { conflicts });
  return state;
}

async function externalTreeOid(auditDir, filesRoot, label) {
  const repository = path.join(auditDir, `tree-repository-${label}`);
  await fsp.rm(repository, { recursive: true, force: true });
  await fsp.mkdir(repository, { recursive: true, mode: 0o700 });
  await git(repository, ['init', '--quiet']);
  const gitDirectory = path.join(repository, '.git');
  const env = { ...process.env, GIT_INDEX_FILE: path.join(auditDir, `${label}.index`) };
  await fsp.rm(env.GIT_INDEX_FILE, { force: true });
  await git(repository, [
    `--git-dir=${gitDirectory}`, `--work-tree=${filesRoot}`, 'add', '-A', '--', '.',
  ], { env });
  return String(await git(repository, [
    `--git-dir=${gitDirectory}`, `--work-tree=${filesRoot}`, 'write-tree',
  ], { env })).trim();
}

function stateCore(state) {
  const fields = [
    'schemaVersion', 'base', 'feature', 'liveRoot', 'auditDir', 'expectedRoot',
    'expectedManifest', 'expectedAbsent', 'conflicts', 'liveIndexPath', 'liveIndexSha256',
    'unrelatedUntracked', 'expectedTree', 'actualTree',
  ];
  return Object.fromEntries(fields.map((field) => [field, state[field]]));
}

export async function sealDeploymentTree({ auditDir } = {}) {
  const audit = await canonicalDirectory(auditDir, 'deployment audit directory');
  const state = await readState(audit.path);
  if (state.phase !== 'prepared' || state.conflicts?.length) throw typedError('deployment_tree_not_prepared');
  const expectedTree = await externalTreeOid(audit.path, state.expectedRoot, 'expected');
  const next = { ...stateCore(state), phase: 'sealed', expectedTree, actualTree: null };
  await writeState(audit.path, next);
  await writePreAuthorityJson(audit.path, 'deployment-tree.json', {
    helper: 'verify-live-deployment-tree', mode: 'seal', preAuthority: true, ok: true, ...next,
  });
  return next;
}

async function materializeActual(state, auditDir) {
  const root = path.join(auditDir, 'actual', 'files');
  await fsp.rm(path.join(auditDir, 'actual'), { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  for (const expected of state.expectedManifest) {
    const blob = await workingBlob(state.liveRoot, expected.path);
    if (!blob || blob.mode !== expected.mode || hashBlob(blob) !== expected.sha256) {
      throw typedError('live_tree_drift', expected.path);
    }
    await materializeBlob(root, expected.path, blob);
  }
  if (!Array.isArray(state.expectedAbsent)) throw typedError('deployment_state_invalid');
  for (const filePath of state.expectedAbsent) {
    if (await workingBlob(state.liveRoot, filePath)) throw typedError('live_tree_drift', filePath);
  }
  return root;
}

export async function verifyDeploymentTree({ auditDir } = {}) {
  const audit = await canonicalDirectory(auditDir, 'deployment audit directory');
  const state = await readState(audit.path);
  if (state.phase !== 'sealed' || !state.expectedTree) throw typedError('deployment_tree_not_sealed');
  const currentIndexHash = await fileHashOrAbsent(state.liveIndexPath);
  if (currentIndexHash !== state.liveIndexSha256) throw typedError('live_index_changed');
  const currentUntracked = await untrackedInventory(
    state.liveRoot,
    new Set(state.expectedManifest.map((entry) => entry.path)),
  );
  if (JSON.stringify(currentUntracked) !== JSON.stringify(state.unrelatedUntracked)) {
    throw typedError('unrelated_untracked_changed');
  }
  const actualRoot = await materializeActual(state, audit.path);
  const actualTree = await externalTreeOid(audit.path, actualRoot, 'actual');
  if (actualTree !== state.expectedTree) throw typedError('live_tree_oid_mismatch');
  const next = { ...stateCore(state), phase: 'verified', actualTree };
  await writeState(audit.path, next);
  await writePreAuthorityJson(audit.path, 'deployment-tree.json', {
    helper: 'verify-live-deployment-tree', mode: 'verify', preAuthority: true, ok: true,
    indexUnchanged: true, unrelatedUntrackedUnchanged: true, ...next,
  });
  return next;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseCli(argv);
  const mode = positionals[0] || one(values, 'mode', { required: true });
  void env;
  const auditDir = path.resolve(one(values, 'audit-dir', { required: true }));
  if (mode === 'prepare') {
    return prepareDeploymentTree({
      base: one(values, 'base', { required: true }),
      feature: one(values, 'feature', { required: true }),
      liveRoot: path.resolve(one(values, 'live-root', { required: true })),
      auditDir,
    });
  }
  if (mode === 'seal') return sealDeploymentTree({ auditDir });
  if (mode === 'verify') return verifyDeploymentTree({ auditDir });
  throw typedError('mode_invalid');
}

if (isMain(import.meta.url)) main().catch(failCli);
