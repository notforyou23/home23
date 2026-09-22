/** Encrypted home-state backup and inspection. Does not start writers or mutate the source home. */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { productEnvironment } from './product-environment.js';
import { PRODUCT_STATE_PATHS } from './product-payload.js';
import { isRebuildableStatePath, ownedWriterNames, SUPPORTED_COORDINATION_SCHEMA } from './product-update-inventory.js';

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

/** Same supervisor inventory as the update controller. A missing supervisor means there is no owned writer. */
export async function listInstalledWriters(home) {
  const node = join(home, 'bin', 'node');
  const pm2 = join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  if (!exists(node) || !exists(pm2)) return [];
  try {
    const { stdout } = await executeFile(node, [pm2, 'jlist', '--silent'], {
      cwd: join(home, 'app'), env: productEnvironment(home), timeout: 20000, maxBuffer: 8 * 1024 * 1024,
    });
    if (!String(stdout || '').trim()) return [];
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) fail('process_inventory_unavailable', 'Home process inventory is unavailable.');
    return rows.map(row => ({ name: row.name, status: row.pm2_env?.status || 'unknown' }));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'process_inventory_unavailable') {
      if (error.code === 'process_inventory_unavailable') throw error;
      return [];
    }
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

/** Holds runtime/.host.lock, the same path Start uses, so a concurrent Start cannot begin. */
function acquireHostLock(home) {
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
    const fresh = Date.now() - lstatSync(lockPath).mtimeMs < 180000;
    if ((marker && alive(marker.pid) && marker.pid !== process.pid) || (!marker && fresh)) return null;
    rmSync(lockPath, { recursive: true, force: true });
    if (exists(markerPath)) unlinkSync(markerPath);
    claim();
  }
  const timer = setInterval(() => { try { utimesSync(lockPath, new Date(), new Date()); } catch { /* The lock is already gone. */ } }, 20000);
  timer.unref();
  return () => {
    clearInterval(timer);
    rmSync(lockPath, { recursive: true, force: true });
    if (exists(markerPath)) rmSync(markerPath, { force: true });
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

function streamHash(absolute) {
  const hash = createHash('sha256');
  const fd = openSync(absolute, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, CHUNK, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function streamFile(sink, absolute, size) {
  const hash = createHash('sha256');
  const fd = openSync(absolute, 'r');
  const buffer = Buffer.alloc(CHUNK);
  let read = 0;
  try {
    while (read < size) {
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

async function collectRecords(homeRoot, sink, archiveParent) {
  const files = [];
  const seen = new Set();
  let temporaryDatabase = null;
  const add = (relative, type, absolute, size) => {
    if (seen.has(relative) || isRebuildableStatePath(relative) || omitSidecar(relative)) return;
    seen.add(relative);
    sink.write(recordHeader(relative, type, size));
    const digest = type === 'symlink'
      ? sha256(readFileSync(absolute).length ? readFileSync(absolute) : Buffer.alloc(0))
      : streamFile(sink, absolute, size);
    if (type === 'symlink') sink.write(readFileSync(absolute));
    if (type !== 'symlink') {
      const again = streamHash(absolute);
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
      const digest = streamFile(sink, temporaryDatabase, size);
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

function copyStream(source, destination) {
  const input = openSync(source, 'r');
  const buffer = Buffer.alloc(CHUNK);
  try {
    while (true) {
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
  const release = acquireHostLock(root);
  if (!release) fail('backup_lifecycle_busy', 'Another lifecycle operation holds this home. Backup did not start.');
  const ciphertext = join(dirname(archive), `.home23-backup-${randomUUID()}.ciphertext`);
  let sink = null;
  try {
    const list = dependencies.listProcesses || listInstalledWriters;
    assertWritersStopped(root, await list(root));
    if (dependencies.afterLock) await dependencies.afterLock(root);
    assertWritersStopped(root, await list(root));
    sink = cipherSink(ciphertext);
    const files = await collectRecords(root, sink, dirname(archive));
    assertWritersStopped(root, await list(root));
    const key = sink.key;
    const iv = sink.iv;
    const tag = sink.end();
    sink = null;
    const identity = installIdentity(root);
    const headerBytes = Buffer.from(JSON.stringify({
      schema: BACKUP_SCHEMA, homeRoot: root, packageId: identity.packageId, sourceCommit: identity.sourceCommit,
      recipeId: null, createdAt: new Date().toISOString(),
      coordinationSchema: exists(join(root, COORDINATION_DATABASE)) ? SUPPORTED_COORDINATION_SCHEMA : null,
      writersQuiesced: true, checkpoint: 'vacuum-and-stable-files', files,
      encrypted: { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length, 0);
    const archiveFd = openSync(archive, 'wx', 0o600);
    try {
      writeSync(archiveFd, MAGIC);
      writeSync(archiveFd, length);
      writeSync(archiveFd, headerBytes);
      copyStream(ciphertext, archiveFd);
      fsyncSync(archiveFd);
    } finally { closeSync(archiveFd); }
    durableWrite(keyFile, `${JSON.stringify({ schema: KEY_SCHEMA, algorithm: 'aes-256-gcm', key: key.toString('base64') }, null, 2)}\n`, 0o600);
    return { ok: true, schema: BACKUP_SCHEMA, packageId: identity.packageId, fileCount: files.length, archivePath: archive, keyPath: keyFile, writersStarted: false };
  } catch (error) {
    if (exists(archive)) unlinkSync(archive);
    if (exists(keyFile)) unlinkSync(keyFile);
    throw error;
  } finally {
    release();
    if (sink) { try { sink.end(); } catch { /* The backup is already failing. */ } }
    if (exists(ciphertext)) { try { unlinkSync(ciphertext); } catch { /* Partial ciphertext is not an archive. */ } }
  }
}

function createExtractor(root, expectedFiles) {
  const byPath = new Map(expectedFiles.map(entry => [entry.path, entry]));
  let buffer = Buffer.alloc(0);
  let record = null;
  const seen = [];
  function finishRecord() {
    if (record.fd !== null) { fsyncSync(record.fd); closeSync(record.fd); }
    const digest = record.hash.digest('hex');
    const expected = byPath.get(record.path);
    if (digest !== expected.sha256) throw new Error(`Backup digest mismatch: ${record.path}`);
    if (record.type === 'symlink') symlinkSync(record.symlink.toString('utf8'), record.destination);
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
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        record = {
          path: pathText, type, remaining: size, hash: createHash('sha256'), destination,
          fd: type === 'file' ? openSync(destination, 'wx', 0o600) : null, symlink: Buffer.alloc(0),
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
    const header = JSON.parse(headerBytes.toString('utf8'));
    if (header?.schema !== BACKUP_SCHEMA || header.encrypted?.algorithm !== 'aes-256-gcm' || !Array.isArray(header.files)) throw new Error('Backup header is invalid.');
    if (resolve(header.homeRoot || '') === root) throw new Error('Inspection directory must not be the backed-up home.');
    const iv = Buffer.from(header.encrypted.iv, 'base64');
    const tag = Buffer.from(header.encrypted.tag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const extractor = createExtractor(root, header.files);
    const buffer = Buffer.alloc(CHUNK);
    let position = 8 + headerLength;
    while (true) {
      const count = readSync(archiveFd, buffer, 0, CHUNK, position);
      if (count <= 0) break;
      position += count;
      const plain = decipher.update(buffer.subarray(0, count));
      if (plain.length) { wrote = true; extractor.push(plain); }
    }
    const tail = decipher.final();
    if (tail.length) { wrote = true; extractor.push(tail); }
    extractor.end();
    const reconnects = [machineReconnect()];
    if (header.files.some(entry => entry.path === 'app/config/secrets.yaml')) reconnects.push(credentialReconnect());
    return { ok: true, schema: BACKUP_SCHEMA, packageId: header.packageId ?? null, fileCount: header.files.length, writersStarted: false, reconnects };
  } catch (error) {
    if (wrote || readdirSync(root).length) emptyDirectory(root);
    throw error;
  } finally {
    if (archiveFd !== null) closeSync(archiveFd);
  }
}
