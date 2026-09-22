/** Encrypted home-state backup and inspection. Does not start writers or mutate the source home. */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { choosePortPlan, productEnvironment } from './product-environment.js';
import { PRODUCT_STATE_PATHS } from './product-payload.js';
import { isProductStatePath, isRebuildableStatePath, ownedWriterNames, SUPPORTED_COORDINATION_SCHEMA } from './product-update-inventory.js';
import { readProductManifest } from './product-payload.js';

const executeFile = promisify(execFile);
const BACKUP_SCHEMA = 'home23.backup.v1';
const KEY_SCHEMA = 'home23.backup-key.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const HOST_SCHEMAS = new Set(['home23.host.v1', 'home23.host.v2']);
const MAGIC = Buffer.from('H23B', 'ascii');
const COORDINATION_DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const TYPE_FILE = 1;
const TYPE_SYMLINK = 2;
const CHUNK = 64 * 1024;
const BUSY = new Set(['online', 'launching', 'errored', 'stopping']);
const HOST_LOCK_STALE_MS = 180000;
const MOVE_FENCE_SCHEMA = 'home23.move-fence.v1';

const exists = file => {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const inside = (root, target) => target === root || target.startsWith(root + sep);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function realDirectory(directory) {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (exists(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${current}`);
    }
    if (dirname(current) === current) break;
  }
}

function absoluteRoot(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`Choose an absolute ${label}.`);
  const root = resolve(value);
  realDirectory(root);
  if (!exists(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`Expected a real directory: ${root}`);
  return root;
}

function assertOutsideHome(homeRoot, candidate, label) {
  if (inside(homeRoot, resolve(candidate))) fail('backup_path_invalid', `${label} must not be inside the home.`);
}

function assertAbsentPath(file, label) {
  if (exists(file)) fail('backup_path_exists', `${label} already exists.`);
}

function readHostState(homeRoot) {
  const hostPath = join(homeRoot, '.home23-host.json');
  if (!exists(hostPath)) fail('backup_host_unreadable', 'Home host state is missing; refuse backup.');
  try {
    const stat = lstatSync(hostPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('backup_host_unreadable', 'Home host state is not a regular file.');
    const host = JSON.parse(readFileSync(hostPath, 'utf8'));
    if (!HOST_SCHEMAS.has(host?.schema)) fail('backup_host_unreadable', 'Home host state is not a Host v1 or v2 record.');
    return host;
  } catch (error) {
    if (error.code === 'backup_host_unreadable') throw error;
    fail('backup_host_unreadable', 'Home host state is unreadable.');
  }
}

function installIdentity(homeRoot) {
  const receiptPath = join(homeRoot, '.home23-install.json');
  if (!exists(receiptPath)) return { packageId: null, sourceCommit: null };
  try {
    const stat = lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { packageId: null, sourceCommit: null };
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt?.schema !== INSTALL_SCHEMA || receipt.status !== 'installed' || typeof receipt.packageId !== 'string' || typeof receipt.sourceCommit !== 'string') {
      return { packageId: null, sourceCommit: null };
    }
    return { packageId: receipt.packageId, sourceCommit: receipt.sourceCommit };
  } catch {
    return { packageId: null, sourceCommit: null };
  }
}

function omitSidecar(relative) {
  return relative === `${COORDINATION_DATABASE}-wal` || relative === `${COORDINATION_DATABASE}-shm` || relative.endsWith('.sqlite3-wal') || relative.endsWith('.sqlite3-shm');
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0')
    && !isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..');
}

function assertSymlinkInside(homeRoot, relative) {
  const file = join(homeRoot, relative);
  const target = readlinkSync(file);
  if (typeof target !== 'string' || target.includes('\0')) throw new Error(`Unsafe symlink: ${relative}`);
  let resolved;
  try { resolved = realpathSync(file); }
  catch {
    const linked = resolve(dirname(file), target);
    if (!inside(homeRoot, linked)) throw new Error(`Backup symlink escapes its home: ${relative}`);
    return target;
  }
  if (!inside(homeRoot, resolved)) throw new Error(`Backup symlink escapes its home: ${relative}`);
  return target;
}

/** Same supervisor inventory as the update controller. A missing supervisor is not proof that writers are stopped. */
export async function listInstalledWriters(home) {
  const node = join(home, 'bin', 'node');
  const pm2 = join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  if (!exists(node) || !exists(pm2)) {
    fail('process_inventory_unavailable', 'Installed process inventory cannot be established. A missing supervisor is not proof that writers are stopped.');
  }
  try {
    const { stdout } = await executeFile(node, [pm2, 'jlist', '--silent'], {
      cwd: join(home, 'app'), env: productEnvironment(home), timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    });
    if (!String(stdout || '').trim()) return [];
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) fail('process_inventory_unavailable', 'Home process inventory is unavailable.');
    return rows.map(row => ({ name: row.name, status: row.pm2_env?.status || 'unknown' }));
  } catch (error) {
    if (error.code === 'process_inventory_unavailable') throw error;
    fail('process_inventory_unavailable', 'Home process inventory is unavailable.');
  }
}

function assertWritersStopped(home, rows) {
  if (!Array.isArray(rows)) fail('process_inventory_unavailable', 'Home process inventory is unavailable.');
  const host = readHostState(home);
  const names = ownedWriterNames(host.profile?.name || '', { encoderRequired: host.encoderRequired === true }) || [];
  const busy = rows.filter(row => BUSY.has(row.status));
  if (busy.some(row => !names.includes(row.name))) fail('backup_unknown_writer', 'An unexpected process is using this home.');
  if (busy.length) fail('backup_writers_active', 'Owned writers are still running. Stop them before backup. The desired-running flag is not proof they are stopped.');
}

/** Holds runtime/.host.lock, the same path Start uses. Refresh from the copy loop: a blocked event loop never runs setInterval, and Start treats a lock older than 180s as stale. */
export function acquireHostLock(home, { staleMs = HOST_LOCK_STALE_MS } = {}) {
  const runtime = join(home, 'runtime');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lockPath = join(runtime, '.host.lock');
  const markerPath = join(runtime, '.home23-update-lock.json');
  const claim = () => {
    mkdirSync(lockPath);
    writeFileSync(markerPath, `${JSON.stringify({ pid: process.pid, purpose: 'backup' })}\n`, { mode: 0o600, flag: 'wx' });
  };
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let marker = null;
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { marker = null; }
    const ownerAlive = Boolean(marker && alive(marker.pid));
    const fresh = Date.now() - lstatSync(lockPath).mtimeMs < staleMs;
    // A live owner is the lock, including this process. Stale mtime must not let Start steal it.
    if (ownerAlive || (!marker && fresh)) return null;
    rmSync(lockPath, { recursive: true, force: true });
    if (exists(markerPath)) unlinkSync(markerPath);
    claim();
  }
  let touchedAt = Date.now();
  return {
    path: lockPath,
    noteActivity() {
      const hooks = this.hooks || {};
      if (hooks.beforeChunk) hooks.beforeChunk(lockPath);
      if (Date.now() - touchedAt >= (hooks.refreshMs ?? 5000)) {
        utimesSync(lockPath, new Date(), new Date());
        touchedAt = Date.now();
        if (hooks.onLockRefresh) hooks.onLockRefresh(lockPath);
      }
    },
    release() {
      rmSync(lockPath, { recursive: true, force: true });
      if (exists(markerPath)) rmSync(markerPath, { force: true });
    },
  };
}

async function consistentDatabaseCopy(homeRoot, temporaryPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const source = new DatabaseSync(join(homeRoot, COORDINATION_DATABASE));
  try { source.exec(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`); }
  finally { source.close(); }
}

function recordHeader(relative, type, size) {
  const pathBytes = Buffer.from(relative, 'utf8');
  if (pathBytes.length > 4096) fail('backup_path_invalid', `Backup path is too long: ${relative}`);
  const header = Buffer.alloc(4 + pathBytes.length + 1 + 8);
  let offset = 0;
  header.writeUInt32BE(pathBytes.length, offset); offset += 4;
  pathBytes.copy(header, offset); offset += pathBytes.length;
  header.writeUInt8(type === 'symlink' ? TYPE_SYMLINK : TYPE_FILE, offset); offset += 1;
  header.writeUInt32BE(Math.floor(size / 2 ** 32), offset); offset += 4;
  header.writeUInt32BE(size >>> 0, offset);
  return header;
}

function streamHash(absolute, lock) {
  const hash = createHash('sha256');
  const fd = openSync(absolute, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
      lock?.noteActivity();
      const count = readSync(fd, buffer, 0, CHUNK, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function streamFile(sink, absolute, size, lock) {
  const hash = createHash('sha256');
  const fd = openSync(absolute, 'r');
  const buffer = Buffer.alloc(CHUNK);
  let read = 0;
  try {
    while (read < size) {
      lock?.noteActivity();
      const count = readSync(fd, buffer, 0, Math.min(CHUNK, size - read), read);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      sink.write(buffer.subarray(0, count));
      read += count;
    }
  } finally { closeSync(fd); }
  if (read !== size) fail('backup_state_changed', `State changed while reading ${absolute}.`);
  return hash.digest('hex');
}

function cipherSink(tempPath) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const fd = openSync(tempPath, 'wx', 0o600);
  return {
    key, iv, fd,
    write(chunk) {
      const output = cipher.update(chunk);
      if (output.length) writeSync(fd, output);
    },
    end() {
      const output = cipher.final();
      if (output.length) writeSync(fd, output);
      const tag = cipher.getAuthTag();
      fsyncSync(fd);
      closeSync(fd);
      return tag;
    },
  };
}

async function collectRecords(homeRoot, sink, archiveParent, lock) {
  const files = [];
  const seen = new Set();
  let temporaryDatabase = null;
  const add = (relative, type, absolute, size) => {
    if (seen.has(relative) || isRebuildableStatePath(relative) || omitSidecar(relative)) return;
    seen.add(relative);
    sink.write(recordHeader(relative, type, size));
    const digest = streamFile(sink, absolute, size, lock);
    if (type !== 'symlink') {
      const again = streamHash(absolute, lock);
      if (again !== digest) fail('backup_state_changed', `State changed while checkpointing ${relative}.`);
    }
    files.push({ path: relative, sha256: digest, bytes: size, type });
  };
  const visit = async relative => {
    if (!relative || seen.has(relative) || isRebuildableStatePath(relative) || omitSidecar(relative)) return;
    const absolute = join(homeRoot, relative);
    if (!exists(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = assertSymlinkInside(homeRoot, relative);
      const bytes = Buffer.from(target, 'utf8');
      sink.write(recordHeader(relative, 'symlink', bytes.length));
      sink.write(bytes);
      seen.add(relative);
      files.push({ path: relative, sha256: sha256(bytes), bytes: bytes.length, type: 'symlink' });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) await visit(`${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) return;
    if (relative === COORDINATION_DATABASE) {
      temporaryDatabase = join(archiveParent, `.home23-backup-${randomUUID()}.sqlite3`);
      await consistentDatabaseCopy(homeRoot, temporaryDatabase);
      const size = lstatSync(temporaryDatabase).size;
      sink.write(recordHeader(relative, 'file', size));
      const digest = streamFile(sink, temporaryDatabase, size, lock);
      files.push({ path: relative, sha256: digest, bytes: size, type: 'file' });
      seen.add(relative);
      return;
    }
    add(relative, 'file', absolute, stat.size);
  };
  try {
    for (const entry of PRODUCT_STATE_PATHS) {
      if (!exists(join(homeRoot, entry.path))) continue;
      await visit(entry.path);
    }
    return files;
  } finally {
    if (temporaryDatabase && exists(temporaryDatabase)) {
      try { unlinkSync(temporaryDatabase); } catch { /* The copy is only an intermediate checkpoint. */ }
    }
  }
}

function durableWrite(file, data, mode) {
  const fd = openSync(file, 'wx', mode);
  try { writeSync(fd, data); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function copyStream(source, destination, lock) {
  const input = openSync(source, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
      lock?.noteActivity();
      const count = readSync(input, buffer, 0, CHUNK, null);
      if (count <= 0) break;
      writeSync(destination, buffer, 0, count);
    }
  } finally { closeSync(input); }
}

function emptyDirectory(directory) {
  for (const name of readdirSync(directory)) rmSync(join(directory, name), { recursive: true, force: true });
}

function machineReconnect() {
  return { kind: 'machine-bindings', required: true, message: 'Ports, supervisor registration, and absolute machine paths have to be rebound before this home runs.' };
}
function credentialReconnect() {
  return { kind: 'provider-credentials', required: false, transferred: true, message: 'Provider credentials were inside the encrypted archive. They still need a reachable provider endpoint.' };
}

function plainSink(file) {
  const fd = openSync(file, 'wx', 0o600);
  return {
    write(chunk) { if (chunk?.length) writeSync(fd, chunk); },
    close() { fsyncSync(fd); closeSync(fd); },
  };
}

function encryptFile(source, sink, lock) {
  const input = openSync(source, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
      lock?.noteActivity();
      const count = readSync(input, buffer, 0, CHUNK, null);
      if (count <= 0) break;
      sink.write(buffer.subarray(0, count));
    }
  } finally { closeSync(input); }
}

export async function createHomeBackup({ homeRoot, archivePath, keyPath } = {}, dependencies = {}) {
  const root = absoluteRoot(homeRoot, 'home directory');
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || !isAbsolute(archivePath) || !isAbsolute(keyPath)) throw new Error('Archive and key paths must be absolute.');
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  assertOutsideHome(root, archive, 'Archive');
  assertOutsideHome(root, keyFile, 'Key');
  realDirectory(dirname(archive));
  realDirectory(dirname(keyFile));
  assertAbsentPath(archive, 'Archive');
  assertAbsentPath(keyFile, 'Key');
  readHostState(root);
  const ownsLock = !dependencies.existingLock;
  const lock = dependencies.existingLock || acquireHostLock(root, { staleMs: dependencies.staleMs });
  if (!lock) fail('backup_lifecycle_busy', 'Another lifecycle operation holds this home. Backup did not start.');
  lock.hooks = { beforeChunk: dependencies.beforeChunk, onLockRefresh: dependencies.onLockRefresh, refreshMs: dependencies.lockRefreshMs };
  const recordsPath = join(dirname(archive), `.home23-backup-${randomUUID()}.records`);
  const ciphertext = join(dirname(archive), `.home23-backup-${randomUUID()}.ciphertext`);
  let records = null;
  let sink = null;
  try {
    const list = dependencies.listProcesses || listInstalledWriters;
    assertWritersStopped(root, await list(root));
    if (dependencies.afterLock) await dependencies.afterLock(root);
    assertWritersStopped(root, await list(root));
    records = plainSink(recordsPath);
    const files = await collectRecords(root, records, dirname(archive), lock);
    records.close();
    records = null;
    assertWritersStopped(root, await list(root));
    const identity = installIdentity(root);
    const authenticated = Buffer.from(JSON.stringify({
      schema: BACKUP_SCHEMA, version: 2, homeRoot: root, packageId: identity.packageId, sourceCommit: identity.sourceCommit,
      recipeId: null, createdAt: new Date().toISOString(),
      coordinationSchema: exists(join(root, COORDINATION_DATABASE)) ? SUPPORTED_COORDINATION_SCHEMA : null,
      writersQuiesced: true, checkpoint: 'vacuum-and-stable-files', files,
    }));
    sink = cipherSink(ciphertext);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(authenticated.length, 0);
    sink.write(length);
    sink.write(authenticated);
    encryptFile(recordsPath, sink, lock);
    const key = sink.key;
    const iv = sink.iv;
    const tag = sink.end();
    sink = null;
    const outer = Buffer.from(JSON.stringify({ schema: BACKUP_SCHEMA, version: 2, encrypted: { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') } }));
    const outerLength = Buffer.alloc(4);
    outerLength.writeUInt32BE(outer.length, 0);
    const archiveFd = openSync(archive, 'wx', 0o600);
    try {
      writeSync(archiveFd, MAGIC);
      writeSync(archiveFd, outerLength);
      writeSync(archiveFd, outer);
      copyStream(ciphertext, archiveFd, lock);
      fsyncSync(archiveFd);
    } finally { closeSync(archiveFd); }
    durableWrite(keyFile, `${JSON.stringify({ schema: KEY_SCHEMA, algorithm: 'aes-256-gcm', key: key.toString('base64') }, null, 2)}\n`, 0o600);
    return { ok: true, schema: BACKUP_SCHEMA, packageId: identity.packageId, fileCount: files.length, archivePath: archive, keyPath: keyFile, writersStarted: false };
  } catch (error) {
    if (exists(archive)) unlinkSync(archive);
    if (exists(keyFile)) unlinkSync(keyFile);
    throw error;
  } finally {
    if (ownsLock && !dependencies.retainLock) lock.release();
    if (records) { try { records.close(); } catch { /* The records file is partial. */ } }
    if (sink) { try { sink.end(); } catch { /* The backup is already failing. */ } }
    for (const file of [recordsPath, ciphertext]) if (exists(file)) { try { unlinkSync(file); } catch { /* Temporary backup material is not an archive. */ } }
  }
}

function assertRealParents(root, relativePath) {
  const parts = relativePath.split('/');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]);
    if (!exists(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Backup path escapes inspection root: ${relativePath}`);
  }
}

function openNewFile(destination) {
  return openSync(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
}

function restoredLink(sourceHome, inspectionRoot, linkRelative, target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw new Error(`Unsafe symlink: ${linkRelative}`);
  const linkDirectory = dirname(join(inspectionRoot, linkRelative));
  const absolute = isAbsolute(target) ? target : resolve(linkDirectory, target);
  const source = resolve(sourceHome);
  if (isAbsolute(target)) {
    if (!inside(source, absolute)) throw new Error(`Backup symlink escapes its home: ${linkRelative}`);
    const rebased = join(inspectionRoot, relative(source, absolute));
    if (!inside(inspectionRoot, rebased)) throw new Error(`Backup symlink escapes inspection: ${linkRelative}`);
    return relative(linkDirectory, rebased);
  }
  if (!inside(inspectionRoot, absolute)) throw new Error(`Backup symlink escapes inspection: ${linkRelative}`);
  return target;
}

function createExtractor(root, expectedFiles, sourceHome) {
  const byPath = new Map(expectedFiles.map(entry => [entry.path, entry]));
  let buffer = Buffer.alloc(0);
  let record = null;
  const seen = [];
  function finishRecord() {
    if (record.fd !== null) { fsyncSync(record.fd); closeSync(record.fd); }
    const digest = record.hash.digest('hex');
    const expected = byPath.get(record.path);
    if (digest !== expected.sha256) throw new Error(`Backup digest mismatch: ${record.path}`);
    if (record.type === 'symlink') {
      const link = restoredLink(sourceHome, root, record.path, record.symlink.toString('utf8'));
      symlinkSync(link, record.destination);
    }
    seen.push(record.path);
    record = null;
  }
  function consume() {
    while (true) {
      if (!record) {
        if (buffer.length < 4) return;
        const pathLength = buffer.readUInt32BE(0);
        if (pathLength > 4096 || buffer.length < 4 + pathLength + 1 + 8) {
          if (pathLength > 4096) throw new Error('Backup path is too long.');
          return;
        }
        const pathText = buffer.subarray(4, 4 + pathLength).toString('utf8');
        if (!safeRelative(pathText)) throw new Error(`Backup path escapes inspection root: ${pathText}`);
        const typeCode = buffer.readUInt8(4 + pathLength);
        const size = buffer.readUInt32BE(5 + pathLength) * 2 ** 32 + buffer.readUInt32BE(9 + pathLength);
        buffer = buffer.subarray(13 + pathLength);
        const expected = byPath.get(pathText);
        const type = typeCode === TYPE_SYMLINK ? 'symlink' : typeCode === TYPE_FILE ? 'file' : null;
        if (!expected || !type || expected.type !== type || expected.bytes !== size) throw new Error(`Backup record mismatch: ${pathText}`);
        if (type === 'symlink' && size > 4096) throw new Error(`Backup symlink is too long: ${pathText}`);
        const destination = join(root, pathText);
        if (!inside(root, destination)) throw new Error(`Backup path escapes inspection root: ${pathText}`);
        assertRealParents(root, pathText);
        record = {
          path: pathText, type, remaining: size, hash: createHash('sha256'), destination,
          fd: type === 'file' ? openNewFile(destination) : null, symlink: Buffer.alloc(0),
        };
      }
      if (record.remaining === 0) { finishRecord(); continue; }
      if (!buffer.length) return;
      const take = Math.min(buffer.length, record.remaining);
      const slice = buffer.subarray(0, take);
      record.hash.update(slice);
      if (record.type === 'file') writeSync(record.fd, slice);
      else record.symlink = Buffer.concat([record.symlink, slice]);
      buffer = buffer.subarray(take);
      record.remaining -= take;
      if (record.remaining === 0) finishRecord();
    }
  }
  return {
    push(chunk) { buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk; consume(); },
    end() {
      if (record || buffer.length) throw new Error('Truncated backup payload.');
      if (seen.length !== expectedFiles.length) throw new Error('Backup file inventory mismatch.');
    },
  };
}

export async function inspectHomeBackup({ archivePath, keyPath, inspectionRoot } = {}) {
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || typeof inspectionRoot !== 'string' || !isAbsolute(archivePath) || !isAbsolute(keyPath) || !isAbsolute(inspectionRoot)) {
    throw new Error('Archive, key, and inspection paths must be absolute.');
  }
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  const root = absoluteRoot(inspectionRoot, 'inspection directory');
  if (readdirSync(root).length !== 0) throw new Error('Inspection directory must be empty.');
  let wrote = false;
  let archiveFd = null;
  let plainPath = null;
  try {
    const keyDocument = JSON.parse(readFileSync(keyFile, 'utf8'));
    if (keyDocument?.schema !== KEY_SCHEMA || keyDocument.algorithm !== 'aes-256-gcm' || typeof keyDocument.key !== 'string') throw new Error('Backup key is invalid.');
    const key = Buffer.from(keyDocument.key, 'base64');
    if (key.length !== 32) throw new Error('Backup key is invalid.');
    archiveFd = openSync(archive, 'r');
    const prefix = Buffer.alloc(8);
    if (readSync(archiveFd, prefix, 0, 8, 0) !== 8 || prefix.subarray(0, 4).toString('ascii') !== 'H23B') throw new Error('Not a Home23 backup archive.');
    const headerLength = prefix.readUInt32BE(4);
    if (headerLength < 2 || headerLength > 32 * 1024 * 1024) throw new Error('Backup header is invalid.');
    const headerBytes = Buffer.alloc(headerLength);
    if (readSync(archiveFd, headerBytes, 0, headerLength, 8) !== headerLength) throw new Error('Truncated backup archive.');
    const outer = JSON.parse(headerBytes.toString('utf8'));
    if (outer?.schema !== BACKUP_SCHEMA || outer.version !== 2 || outer.encrypted?.algorithm !== 'aes-256-gcm' || outer.files) throw new Error('Backup header is invalid.');
    const iv = Buffer.from(outer.encrypted.iv, 'base64');
    const tag = Buffer.from(outer.encrypted.tag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plainPath = join(dirname(root), `.home23-backup-auth-${randomUUID()}`);
    const plainFd = openSync(plainPath, 'wx', 0o600);
    const buffer = Buffer.alloc(CHUNK);
    let position = 8 + headerLength;
    try {
      while (true) {
        const count = readSync(archiveFd, buffer, 0, CHUNK, position);
        if (count <= 0) break;
        position += count;
        const plain = decipher.update(buffer.subarray(0, count));
        if (plain.length) writeSync(plainFd, plain);
      }
      const tail = decipher.final();
      if (tail.length) writeSync(plainFd, tail);
      fsyncSync(plainFd);
    } finally { closeSync(plainFd); }
    const authenticated = readAuthenticatedHeader(plainPath);
    if (!authenticated?.header || authenticated.header.schema !== BACKUP_SCHEMA || !Array.isArray(authenticated.header.files)) throw new Error('Backup header is invalid.');
    const header = authenticated.header;
    if (!header.homeRoot || resolve(header.homeRoot) === root) throw new Error('Inspection directory must not be the backed-up home.');
    const extractor = createExtractor(root, header.files, header.homeRoot);
    wrote = true;
    pushPlainRecords(plainPath, authenticated.recordsOffset, extractor);
    extractor.end();
    const reconnects = [machineReconnect()];
    if (header.files.some(entry => entry.path === 'app/config/secrets.yaml')) reconnects.push(credentialReconnect());
    return { ok: true, schema: BACKUP_SCHEMA, packageId: header.packageId ?? null, fileCount: header.files.length, writersStarted: false, reconnects, sourceHome: header.homeRoot };
  } catch (error) {
    if (wrote || readdirSync(root).length) emptyDirectory(root);
    throw error;
  } finally {
    if (archiveFd !== null) closeSync(archiveFd);
    if (plainPath && exists(plainPath)) unlinkSync(plainPath);
  }
}

function readAuthenticatedHeader(plainPath) {
  const fd = openSync(plainPath, 'r');
  try {
    const lengthBytes = Buffer.alloc(4);
    if (readSync(fd, lengthBytes, 0, 4, 0) !== 4) throw new Error('Truncated backup payload.');
    const headerLength = lengthBytes.readUInt32BE(0);
    if (headerLength < 2 || headerLength > 32 * 1024 * 1024) throw new Error('Backup header is invalid.');
    const headerBytes = Buffer.alloc(headerLength);
    if (readSync(fd, headerBytes, 0, headerLength, 4) !== headerLength) throw new Error('Truncated backup payload.');
    return { header: JSON.parse(headerBytes.toString('utf8')), recordsOffset: 4 + headerLength };
  } finally { closeSync(fd); }
}

function pushPlainRecords(plainPath, offset, extractor) {
  const fd = openSync(plainPath, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    let position = offset;
    while (true) {
      const count = readSync(fd, buffer, 0, CHUNK, position);
      if (count <= 0) break;
      position += count;
      extractor.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally { closeSync(fd); }
}

export function readMoveFence(homeRoot) {
  const file = join(homeRoot, 'runtime', 'home23-move-fence.json');
  if (!exists(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schema !== MOVE_FENCE_SCHEMA) return { schema: 'invalid' };
    return value;
  } catch {
    return { schema: 'invalid' };
  }
}

function residentName(home) {
  const host = readHostState(home);
  const name = host.profile?.name;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || '')) fail('backup_identity_missing', 'The home has no resident identity to preserve.');
  return name;
}

export function residentIdentityPaths(home) {
  const name = residentName(home);
  const substrate = join(home, 'app/instances', name, 'substrate');
  if (!exists(substrate)) fail('backup_identity_missing', `Resident ${name} has no Seed substrate.`);
  const seeds = readdirSync(substrate).filter(entry => entry.startsWith('seed-') && lstatSync(join(substrate, entry)).isDirectory()).sort();
  if (!seeds.length) fail('backup_identity_missing', `Resident ${name} has no Seed.`);
  const paths = [];
  for (const seed of seeds) {
    const birth = `app/instances/${name}/substrate/${seed}/birth-receipt.json`;
    if (!exists(join(home, birth))) fail('backup_identity_missing', `Resident ${name} is missing ${birth}.`);
    paths.push(birth);
    const ledger = `app/instances/${name}/substrate/${seed}/seed-ledger.jsonl`;
    if (exists(join(home, ledger))) paths.push(ledger);
  }
  return paths;
}

function compareIdentity(source, destination) {
  const identity = {};
  for (const relativePath of residentIdentityPaths(source)) {
    const from = join(source, relativePath);
    const copy = join(destination, relativePath);
    if (!exists(copy) || streamHash(from) !== streamHash(copy)) fail('backup_identity_mismatch', `Restored identity does not match the source: ${relativePath}`);
    identity[relativePath] = streamHash(from);
  }
  return identity;
}

function moveJournalPath(source) {
  return join(dirname(source), `.${basename(source)}.home23-move`, 'journal.json');
}

function readMoveJournal(source) {
  const file = moveJournalPath(source);
  if (!exists(file)) return null;
  const journal = JSON.parse(readFileSync(file, 'utf8'));
  if (journal?.schema !== 'home23.move-journal.v1' || journal.sourceHome !== source) fail('move_journal_invalid', 'The move journal belongs to another home.');
  return journal;
}

function writeMoveJournal(source, journal) {
  const file = moveJournalPath(source);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

async function rebindDestination(source, destination) {
  const host = readHostState(destination);
  host.homeRoot = destination;
  host.desiredRunning = false;
  host.phase = 'stopped';
  if (host.ports) host.ports = await choosePortPlan({ encoderRequired: host.encoderRequired === true });
  writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  const receiptPath = join(source, '.home23-install.json');
  if (!exists(receiptPath)) return null;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const rebound = {
    ...receipt, homeRoot: destination, appRoot: join(destination, 'app'),
    nodePath: join(destination, 'bin', 'node'), pm2Path: join(destination, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'), replayed: false,
  };
  writeFileSync(join(destination, '.home23-install.json'), `${JSON.stringify(rebound)}\n`, { mode: 0o600 });
  return rebound.packageId || null;
}

function copyInstalledFile(from, to, mode, lock) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  const temporary = `${to}.${randomUUID()}.next`;
  const input = openSync(from, 'r');
  const output = openSync(temporary, 'wx', mode);
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
      lock?.noteActivity();
      const count = readSync(input, buffer, 0, CHUNK, null);
      if (count <= 0) break;
      writeSync(output, buffer, 0, count);
    }
    fsyncSync(output);
  } finally {
    closeSync(input);
    closeSync(output);
  }
  renameSync(temporary, to);
}

function installMovedRuntime(source, destination, lock) {
  let manifest;
  try { manifest = readProductManifest(source); }
  catch { return null; }
  for (const entry of manifest.files) {
    if (isProductStatePath(entry.path)) continue;
    const from = join(source, entry.path);
    const to = join(destination, entry.path);
    if (!exists(from)) continue;
    if (entry.type === 'directory') {
      mkdirSync(to, { recursive: true, mode: entry.mode });
      continue;
    }
    if (entry.type === 'symlink') {
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      if (exists(to)) unlinkSync(to);
      symlinkSync(readlinkSync(from), to);
      continue;
    }
    if (exists(to) && lstatSync(to).isFile() && streamHash(from, lock) === streamHash(to, lock)) continue;
    copyInstalledFile(from, to, entry.mode, lock);
  }
  copyInstalledFile(join(source, 'manifest.json'), join(destination, 'manifest.json'), 0o644, lock);
  return manifest.packageId;
}

function publishFence(source, destination) {
  mkdirSync(join(source, 'runtime'), { recursive: true, mode: 0o700 });
  const file = join(source, 'runtime', 'home23-move-fence.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schema: MOVE_FENCE_SCHEMA, sourceHome: source, destinationRoot: destination, movedAt: new Date().toISOString(), writersStarted: false,
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export async function moveHome({ sourceHome, destinationRoot, archivePath, keyPath } = {}, dependencies = {}) {
  const source = absoluteRoot(sourceHome, 'home directory');
  const destination = absoluteRoot(destinationRoot, 'destination directory');
  if (source === destination || inside(source, destination) || inside(destination, source)) throw new Error('Move source and destination must be separate real directories.');
  const sourceHostBefore = readFileSync(join(source, '.home23-host.json'));
  const lock = acquireHostLock(source, { staleMs: dependencies.staleMs });
  if (!lock) fail('backup_lifecycle_busy', 'Another lifecycle operation holds this home. Move did not start.');
  lock.hooks = { beforeChunk: dependencies.beforeChunk, onLockRefresh: dependencies.onLockRefresh, refreshMs: dependencies.lockRefreshMs };
  try {
    const list = dependencies.listProcesses || listInstalledWriters;
    assertWritersStopped(source, await list(source));
    if (readMoveFence(source)) {
      if (readdirSync(destination).length === 0) fail('move_journal_invalid', 'The fenced move has no destination to finish.');
      installMovedRuntime(source, destination, lock);
      const packageId = await rebindDestination(source, destination);
      const identity = compareIdentity(source, destination);
      if (!readFileSync(join(source, '.home23-host.json')).equals(sourceHostBefore)) fail('backup_identity_mismatch', 'Move changed the source host record.');
      return { ok: true, schema: MOVE_FENCE_SCHEMA, packageId, fileCount: Object.keys(identity).length, writersStarted: false, fenced: true, destinationStarted: false, identity, resumed: true };
    }
    let journal = readMoveJournal(source) || { schema: 'home23.move-journal.v1', sourceHome: source, destinationRoot: destination, phase: 'claimed' };
    const resumed = journal.phase !== 'claimed';
    if (journal.destinationRoot !== destination) fail('move_journal_invalid', 'An unfinished move belongs to another destination.');
    const held = { ...dependencies, existingLock: lock, retainLock: true };
    if (!['backed_up', 'restored', 'fenced', 'committed'].includes(journal.phase)) {
      if (readdirSync(destination).length !== 0) throw new Error('Move destination must be empty.');
      await createHomeBackup({ homeRoot: source, archivePath, keyPath }, held);
      journal = { ...journal, phase: 'backed_up', archivePath, keyPath };
      writeMoveJournal(source, journal);
    }
    if (!['restored', 'fenced', 'committed'].includes(journal.phase)) {
      if (readdirSync(destination).length !== 0 && journal.phase !== 'backed_up') throw new Error('Move destination must be empty.');
      if (readdirSync(destination).length === 0) await inspectHomeBackup({ archivePath, keyPath, inspectionRoot: destination });
      journal = { ...journal, phase: 'restored' };
      writeMoveJournal(source, journal);
      if (dependencies.afterRestore) await dependencies.afterRestore(source);
    }
    const identity = compareIdentity(source, destination);
    installMovedRuntime(source, destination, lock);
    const packageId = await rebindDestination(source, destination);
    publishFence(source, destination);
    if (!readFileSync(join(source, '.home23-host.json')).equals(sourceHostBefore)) fail('backup_identity_mismatch', 'Move changed the source host record.');
    journal = { ...journal, phase: 'fenced' };
    writeMoveJournal(source, journal);
    assertWritersStopped(source, await list(source));
    return { ok: true, schema: MOVE_FENCE_SCHEMA, packageId, fileCount: Object.keys(identity).length, writersStarted: false, fenced: true, destinationStarted: false, identity, resumed };
  } finally {
    lock.release();
  }
}
