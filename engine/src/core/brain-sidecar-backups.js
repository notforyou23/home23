'use strict';

// Community maintenance owns only snapshots created by this module. Historical
// sidecars, other cleanup reasons, and uncompleted operations remain untouched.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { hostname } = require('node:os');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { withBackupSources } = require('./brain-backups');
const { validateManifest } = require('../../../shared/memory-source');

const FILES = ['memory-nodes.jsonl.gz', 'memory-edges.jsonl.gz', 'brain-snapshot.json', 'state.json.gz', 'memory-delta.jsonl'];
const sidecarName = (name) => FILES.includes(name) || name === 'memory-manifest.json'
  || /^memory-(nodes|edges)\.[A-Za-z0-9_.-]+\.jsonl\.gz$/.test(name)
  || /^memory-delta\.[A-Za-z0-9_.-]+\.jsonl$/.test(name);
const MANIFEST = 'community-backup-manifest.json';
const SCHEMA = 'home23-community-sidecar-backup/v1';
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}-brain-communities$/;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const identity = (s) => ({ dev: s.dev, ino: s.ino });
const fileIdentity = (s) => ({ ...identity(s), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function ordinary(p, type) {
  const s = await fsp.lstat(p);
  if (s.isSymbolicLink() || !(type === 'directory' ? s.isDirectory() : s.isFile())) {
    throw new Error(`community_backup_not_ordinary_${type}: ${p}`);
  }
  return s;
}

async function syncDirectory(dir) {
  const handle = await fsp.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fsp.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const hashing = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  // Validate gzip framing/CRC in bounded memory while hashing compressed bytes.
  if (file.endsWith('.gz')) await pipeline(fs.createReadStream(file), hashing, createGunzip(), sink);
  else await pipeline(fs.createReadStream(file), hashing, sink);
  if (['brain-snapshot.json', 'memory-manifest.json'].includes(path.basename(file))) {
    if ((await fsp.stat(file)).size > 8 * 1024 * 1024) throw new Error('community_backup_snapshot_metadata_too_large');
    const json = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (path.basename(file) === 'memory-manifest.json') validateManifest(json);
  }
  return hash.digest('hex');
}

async function sourceInventory(sourceSet) {
  const rows = [];
  for (const name of sourceSet.files) {
    if (!sidecarName(name) || path.basename(name) !== name) throw new Error('community_backup_invalid_source_name');
    if (name === 'memory-manifest.json' && sourceSet.manifestBytes) {
      rows.push({ name, size: sourceSet.manifestBytes.length });
    } else rows.push({ name, ...fileIdentity(await ordinary(path.join(sourceSet.physicalRoot, name), 'file')) });
  }
  return rows;
}

async function copyVerified(source, target, expected) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _encoding, callback) {
    hash.update(chunk); callback(null, chunk);
  } }), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  const handle = await fsp.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  const sha256 = hash.digest('hex');
  const copied = await ordinary(target, 'file');
  if (copied.size !== expected.size || await hashFile(target) !== sha256) throw new Error('community_backup_copy_verification_failed');
  if (!sameFile(await ordinary(source, 'file'), expected)) throw new Error('community_backup_source_changed');
  return { name: expected.name, ...fileIdentity(copied), sha256 };
}

async function assertContext(context) {
  if (await fsp.realpath(context.link) !== context.root
      || !sameIdentity(await ordinary(context.root, 'directory'), context.rootIdentity)
      || !sameIdentity(await ordinary(context.brainDir, 'directory'), context.brainIdentity)) {
    throw new Error('community_backup_root_changed');
  }
}

async function inspectSnapshot(context, dir, manifest, { verifyHash = false } = {}) {
  await assertContext(context);
  if (await rootPinned(context)) throw new Error('community_backup_root_pinned');
  if (path.dirname(dir) !== context.root || !NAME.test(path.basename(dir))) throw new Error('community_backup_path_outside_owner');
  if (!sameIdentity(await ordinary(dir, 'directory'), manifest.directoryIdentity)) throw new Error('community_backup_directory_replaced');
  const names = (await fsp.readdir(dir)).sort();
  if (names.includes('.retention-pin')) throw new Error('community_backup_pinned');
  const expected = [MANIFEST, ...manifest.files.map((f) => f.name)].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('community_backup_unexpected_contents');
  const manifestStat = await ordinary(path.join(dir, MANIFEST), 'file');
  const bytes = await fsp.readFile(path.join(dir, MANIFEST));
  const completionPath = path.join(context.root, '.community-retention-receipts', `${path.basename(dir)}.complete.json`);
  await ordinary(path.dirname(completionPath), 'directory');
  await ordinary(completionPath, 'file');
  const completion = JSON.parse(await fsp.readFile(completionPath, 'utf8'));
  if (completion.schema !== SCHEMA || completion.path !== dir || !sameIdentity(completion.directoryIdentity || {}, manifest.directoryIdentity)
      || !sameFile(manifestStat, completion.manifestIdentity || {}) || digest(bytes) !== completion.manifestSha256
      || JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(manifest)) {
    throw new Error('community_backup_manifest_changed');
  }
  for (const row of manifest.files) {
    if (!sidecarName(row.name) || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error('community_backup_invalid_inventory');
    const file = path.join(dir, row.name);
    if (!sameFile(await ordinary(file, 'file'), row)) throw new Error('community_backup_payload_changed');
    if (verifyHash && await hashFile(file) !== row.sha256) throw new Error('community_backup_payload_hash_mismatch');
  }
}

function weekKey(time) {
  // UTC Monday weeks; keep an older weekly anchor independently of recent runs.
  return Math.floor((Date.parse(time) - Date.UTC(1970, 0, 5)) / WEEK);
}

async function openFiles() {
  const { stdout } = await execFileAsync('lsof', ['-nP', '-Fn'], { timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (!stdout.trim()) throw new Error('community_backup_open_file_inventory_empty');
  return stdout.split('\n').filter((s) => s.startsWith('n/')).map((s) => s.slice(1));
}

async function availableBytesAt(directory) {
  const stat = await fsp.statfs(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

async function rootPinned(context) {
  try { await fsp.lstat(path.join(context.root, '.retention-pin')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

async function recordCompletion(context, dir, manifest) {
  await assertContext(context);
  const receiptDir = path.join(context.root, '.community-retention-receipts');
  await fsp.mkdir(receiptDir, { recursive: true });
  await ordinary(receiptDir, 'directory');
  const manifestPath = path.join(dir, MANIFEST);
  const receipt = {
    schema: SCHEMA, path: dir, directoryIdentity: manifest.directoryIdentity,
    manifestIdentity: fileIdentity(await ordinary(manifestPath, 'file')),
    manifestSha256: digest(await fsp.readFile(manifestPath)),
  };
  // Published once for this unique snapshot. Missing or changed completion
  // evidence makes the snapshot ineligible for automatic expiry.
  const handle = await fsp.open(path.join(receiptDir, `${path.basename(dir)}.complete.json`), 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(receiptDir);
}

async function prune(context, successor, { keepRecent, keepWeekly, retainAll, inspectOpenFiles }) {
  const report = { retained: [], removed: [], errors: [] };
  const pinned = await rootPinned(context);
  if (retainAll || pinned) {
    report.retained.push({ reason: pinned ? 'backup root pinned' : 'retain-all policy' }); return report;
  }
  // Prove the newly completed recovery copy before touching an older one.
  await inspectSnapshot(context, successor.dir, successor.manifest, { verifyHash: true });
  const eligible = [];
  for (const entry of await fsp.readdir(context.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !NAME.test(entry.name)) continue;
    const dir = path.join(context.root, entry.name);
    try {
      await ordinary(path.join(dir, MANIFEST), 'file');
      const m = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8'));
      if (m.schema !== SCHEMA || m.reason !== 'brain-communities' || m.residentId !== context.residentId
          || m.brainDir !== context.brainDir || m.root !== context.root || !sameIdentity(m.rootIdentity || {}, context.rootIdentity)
          || m.status !== 'complete' || m.operation?.status !== 'succeeded' || !Array.isArray(m.files)
          || m.files.length < 2 || !Number.isFinite(Date.parse(m.createdAt))) {
        report.retained.push({ path: dir, reason: 'not a completed successful owned snapshot' }); continue;
      }
      await inspectSnapshot(context, dir, m);
      eligible.push({ dir, manifest: m });
    } catch (error) {
      report.retained.push({ path: dir, reason: error.message });
      // Unknown/corrupt receipts may be newer recovery points: fail closed.
      if (error instanceof SyntaxError) report.errors.push(error.message);
    }
  }
  if (report.errors.length) return report;
  eligible.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt));
  const keep = new Set(eligible.slice(0, keepRecent).map((r) => r.dir));
  keep.add(successor.dir);
  const weeks = new Set();
  for (const row of eligible.slice(keepRecent)) {
    const week = weekKey(row.manifest.createdAt);
    if (!weeks.has(week) && weeks.size < keepWeekly) { weeks.add(week); keep.add(row.dir); }
  }
  let opened = [];
  if (eligible.some((row) => !keep.has(row.dir))) {
    try {
      opened = await inspectOpenFiles();
      if (!Array.isArray(opened) || !opened.every((p) => typeof p === 'string' && path.isAbsolute(p))) throw new Error('invalid open-file inventory');
    } catch (error) {
      report.errors.push(`Open-file check unavailable; no expiry: ${error.message}`);
      return report;
    }
  }
  const receiptDir = path.join(context.root, '.community-retention-receipts');
  await fsp.mkdir(receiptDir, { recursive: true });
  await ordinary(receiptDir, 'directory');
  for (const row of eligible) {
    if (keep.has(row.dir)) { report.retained.push({ path: row.dir, reason: 'recent or weekly recovery point' }); continue; }
    if (opened.some((p) => p === row.dir || p.startsWith(`${row.dir}${path.sep}`))) {
      report.retained.push({ path: row.dir, reason: 'snapshot currently open' }); continue;
    }
    try {
      if (await rootPinned(context)) { report.retained.push({ path: row.dir, reason: 'backup root pinned' }); continue; }
      await inspectSnapshot(context, row.dir, row.manifest);
      const receiptPath = path.join(receiptDir, `${path.basename(row.dir)}.json`);
      const receipt = { schema: SCHEMA, operation: 'prune', path: row.dir, successor: successor.dir, manifest: row.manifest, status: 'intent', at: new Date().toISOString() };
      await writeJson(receiptPath, receipt);
      // No recursive traversal: only the exact ordinary flat payload inventory
      // can be removed. Recheck files and root after durable intent publication.
      await inspectSnapshot(context, row.dir, row.manifest);
      for (const file of [...row.manifest.files.map((f) => f.name), MANIFEST]) await fsp.unlink(path.join(row.dir, file));
      await fsp.rmdir(row.dir);
      await syncDirectory(context.root);
      await writeJson(receiptPath, { ...receipt, status: 'removed', completedAt: new Date().toISOString() });
      report.removed.push(row.dir);
    } catch (error) { report.errors.push(`${row.dir}: ${error.message}`); }
  }
  return report;
}

async function withCommunityBackup({ brainDir, residentId, home23Root, operation, now = new Date(), keepRecent = 7, keepWeekly = 4, retainAll = false, minFreeBytes = 4 * 1024 ** 3, availableBytes = availableBytesAt, inspectOpenFiles = openFiles }) {
  if (typeof brainDir !== 'string' || !brainDir || typeof residentId !== 'string' || !residentId
      || typeof operation !== 'function' || !Number.isInteger(keepRecent) || keepRecent < 1
      || !Number.isInteger(keepWeekly) || keepWeekly < 0 || typeof retainAll !== 'boolean'
      || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new Error('community_backup_invalid_options');
  const realBrain = await fsp.realpath(brainDir);
  const link = path.join(realBrain, 'backups');
  await fsp.mkdir(link, { recursive: true });
  const root = await fsp.realpath(link);
  const context = { brainDir: realBrain, link, root, residentId, rootIdentity: identity(await ordinary(root, 'directory')), brainIdentity: identity(await ordinary(realBrain, 'directory')) };
  const lock = path.join(root, '.community-backup.lock');
  try { await fsp.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`community_backup_locked: inspect ${path.join(lock, 'owner.json')} before recovering an abandoned lock`);
    throw error;
  }
  const lockIdentity = identity(await ordinary(lock, 'directory'));
  let manifest, finalDir, stage, completedResult, originalError;
  try {
    await writeJson(path.join(lock, 'owner.json'), { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    await assertContext(context);
    const stamp = new Date(now).toISOString();
    const id = randomUUID();
    const instancesRoot = path.dirname(path.dirname(realBrain));
    const ownerRoot = home23Root || (path.basename(instancesRoot) === 'instances' ? path.dirname(instancesRoot) : path.dirname(realBrain));
    const captured = await withBackupSources(realBrain, { home23Root: ownerRoot, requesterAgent: 'community-backup' }, async (sourceSet) => {
      const freeBytes = await availableBytes(root);
      if (!Number.isSafeInteger(freeBytes) || freeBytes < sourceSet.projectedBytes + minFreeBytes) {
        throw new Error('community_backup_insufficient_disk');
      }
      const source = await sourceInventory(sourceSet);
      stage = path.join(root, `.tmp-${id}-brain-communities`);
      await fsp.mkdir(stage);
      manifest = { schema: SCHEMA, reason: 'brain-communities', residentId, brainDir: realBrain, root, rootIdentity: context.rootIdentity, createdAt: stamp, status: 'copying', operation: { status: 'pending' }, source: sourceSet.source, descriptorDigest: sourceSet.descriptorDigest, omittedDerivedFiles: sourceSet.omittedDerivedFiles || [], files: [] };
      await writeJson(path.join(stage, MANIFEST), manifest);
      for (const row of source) {
        const target = path.join(stage, row.name);
        if (row.name === 'memory-manifest.json' && sourceSet.manifestBytes) {
          const handle = await fsp.open(target, 'wx', 0o600);
          try { await handle.writeFile(sourceSet.manifestBytes); await handle.sync(); }
          finally { await handle.close(); }
          const sha256 = await hashFile(target);
          if (sha256 !== createHash('sha256').update(sourceSet.manifestBytes).digest('hex')) throw new Error('community_backup_copy_verification_failed');
          manifest.files.push({ name: row.name, ...fileIdentity(await ordinary(target, 'file')), sha256 });
        } else manifest.files.push(await copyVerified(path.join(sourceSet.physicalRoot, row.name), target, row));
      }
      await sourceSet.assertCurrent();
      if (JSON.stringify(source) !== JSON.stringify(await sourceInventory(sourceSet))) throw new Error('community_backup_source_changed');
      await assertContext(context);
      manifest.status = 'complete';
      manifest.directoryIdentity = identity(await ordinary(stage, 'directory'));
      await writeJson(path.join(stage, MANIFEST), manifest);
      const destination = path.join(root, `${stamp.replace(/[:.]/g, '-')}-${id}-brain-communities`);
      await fsp.rename(stage, destination);
      finalDir = destination;
      await syncDirectory(root);
      return { created: true };
    });
    if (!captured?.created) throw new Error(`community_backup_source_unavailable:${captured?.reason || 'unconfirmed'}`);
    // Source pins/locks are released before saveState needs the writer lock.
    const backup = { ok: true, path: finalDir, files: manifest.files.map((f) => f.name), manifest: path.join(finalDir, MANIFEST) };
    let value;
    try {
      value = await operation(backup);
    } catch (error) {
      manifest.operation = { status: 'failed', at: new Date().toISOString(), error: error.message };
      try { await writeJson(path.join(finalDir, MANIFEST), manifest); }
      catch { /* Pending snapshots are protected too; preserve the save failure. */ }
      throw error;
    }
    manifest.operation = { status: 'succeeded', at: new Date().toISOString() };
    let retention;
    try {
      await writeJson(path.join(finalDir, MANIFEST), manifest);
      await recordCompletion(context, finalDir, manifest);
      retention = await prune(context, { dir: finalDir, manifest }, { keepRecent, keepWeekly, retainAll, inspectOpenFiles });
    } catch (error) {
      // The mutation/save already succeeded; never misreport it as failed just
      // because optional expiry was deferred. The snapshot stays preserved.
      retention = { retained: [], removed: [], errors: [error.message] };
    }
    completedResult = { backup: { ...backup, retention }, value };
    return completedResult;
  } catch (error) {
    originalError = error;
    if (stage && !finalDir && manifest) {
      // Preserve interrupted/failed copies, clearly distinguished from complete
      // recovery points. A later success must not silently prune them.
      try { await writeJson(path.join(stage, MANIFEST), { ...manifest, status: 'failed', error: error.message }); } catch { /* Original failure wins. */ }
    }
    throw error;
  } finally {
    try {
      await assertContext(context);
      if (!sameIdentity(await ordinary(lock, 'directory'), lockIdentity)) throw new Error('community_backup_lock_replaced');
      await fsp.unlink(path.join(lock, 'owner.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await fsp.rmdir(lock);
    } catch (error) {
      if (completedResult) completedResult.backup.retention.errors.push(`Lock cleanup deferred: ${error.message}`);
      else if (!originalError) throw error;
    }
  }
}

module.exports = { withCommunityBackup, MANIFEST };
