/** Encrypted home-state backup and inspection. Does not start writers or mutate the source home. */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
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
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { choosePortPlan, productEnvironment, readPrivateJSON, socketRootFor, validatePortPlan, withReservedPorts } from './product-environment.js';
import { PRODUCT_STATE_PATHS, readProductManifest, verifyProductPayload } from './product-payload.js';
import { inspectCoordinationDatabase, isProductStatePath, isRebuildableStatePath, ownedWriterNames } from './product-update-inventory.js';

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
// Inner header bound shared by writer and reader: the file inventory lives there, so it must fit every home the writer accepts.
const MAX_HEADER_BYTES = 512 * 1024 * 1024;
const BUSY = new Set(['online', 'launching', 'errored', 'stopping']);
const HOST_LOCK_STALE_MS = 180000;
const MOVE_FENCE_SCHEMA = 'home23.move-fence.v1';
const RECOVER_JOURNAL_SCHEMA = 'home23.recover-journal.v1';

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

function reviewedAdoptedLinkKind(root, relative, target) {
  try {
    const receipt = readPrivateJSON(join(root, 'runtime/adoption-preservation.json'));
    if (receipt?.schema !== 'home23.adoption-preservation-receipt.v1') return null;
    return Array.isArray(receipt.links)
      ? receipt.links.find(link => link.path === relative && link.target === target
        && ['retain-link', 'historical-link', 'retain-authority'].includes(link.kind))?.kind || null : null;
  } catch { return null; }
}
const reviewedAdoptedLink = (root, relative, target) => Boolean(reviewedAdoptedLinkKind(root, relative, target));

function retainedAuthorityDependencies(root) {
  const receiptPath = join(root, 'runtime/adoption-preservation.json');
  if (!exists(receiptPath)) return [];
  const receipt = readPrivateJSON(receiptPath);
  if (receipt?.schema !== 'home23.adoption-preservation-receipt.v1' || !Array.isArray(receipt.links)) throw new Error('Adopted authority receipt is invalid.');
  return receipt.links.filter(link => link.kind === 'retain-authority').map(link => {
    const file = join(root, link.path);
    const exact = safeRelative(link.path) && isAbsolute(link.target) && exists(file)
      && lstatSync(file).isSymbolicLink() && readlinkSync(file) === link.target;
    let present = false;
    try { present = exact && statSync(link.target).isDirectory(); } catch { /* external target unavailable */ }
    return { kind: 'retained-authority', path: link.path, target: link.target, present, required: true };
  });
}

function assertSymlinkInside(homeRoot, relative) {
  const file = join(homeRoot, relative);
  const target = readlinkSync(file);
  if (typeof target !== 'string' || target.includes('\0')) throw new Error(`Unsafe symlink: ${relative}`);
  let resolved;
  try { resolved = realpathSync(file); }
  catch {
    const linked = resolve(dirname(file), target);
    if (reviewedAdoptedLinkKind(homeRoot, relative, target) === 'retain-authority') throw new Error(`Retained external authority is unavailable: ${relative}`);
    if (!inside(homeRoot, linked) && !reviewedAdoptedLink(homeRoot, relative, target)) throw new Error(`Backup symlink escapes its home: ${relative}`);
    return target;
  }
  if (!inside(homeRoot, resolved) && !reviewedAdoptedLink(homeRoot, relative, target)) throw new Error(`Backup symlink escapes its home: ${relative}`);
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
  const residents = host.residentMap && typeof host.residentMap === 'object' && !Array.isArray(host.residentMap)
    ? Object.keys(host.residentMap) : [host.profile?.name];
  const names = [...new Set([...residents.flatMap(name => ownedWriterNames(name || '', { encoderRequired: host.encoderRequired === true }) || []),
    ...(Array.isArray(host.continuationServices) ? host.continuationServices.map(service => service.name) : [])])];
  const busy = rows.filter(row => BUSY.has(row.status));
  if (busy.some(row => !names.includes(row.name))) fail('backup_unknown_writer', 'An unexpected process is using this home.');
  if (busy.length) fail('backup_writers_active', 'Owned writers are still running. Stop them before backup. The desired-running flag is not proof they are stopped.');
}

/** Busy or unknown process rows refuse adoption/backup. An empty inventory is not inferred from a missing supervisor. */
export function assertWritersIdle(rows) {
  if (!Array.isArray(rows)) fail('process_inventory_unavailable', 'Home process inventory is unavailable.');
  const active = rows.filter(row => {
    const status = row?.status || 'unknown';
    return BUSY.has(status) || status === 'unknown';
  });
  if (active.length) {
    fail('writers_active', 'Writers are still running or have unknown status. Stop them before adoption. The desired-running flag is not proof they are stopped.');
  }
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
  let coordinationSchema = null;
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
    if (!isProductStatePath(relative)) return;
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
      const inspected = await inspectCoordinationDatabase(temporaryDatabase);
      if (!inspected.compatible) fail('backup_database_unsupported', 'The coordination checkpoint does not match a reviewed schema fingerprint.');
      coordinationSchema = inspected.version;
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
    // Walk each state tree once, starting at its highest declared root. A
    // separately listed child must not follow a retained authority symlink
    // and copy its files before the link itself is archived.
    const roots = PRODUCT_STATE_PATHS.filter(entry => !PRODUCT_STATE_PATHS.some(parent =>
      parent !== entry && (parent.type === 'directory' || parent.allowDescendants)
      && entry.path.startsWith(`${parent.path}/`)));
    for (const entry of roots) {
      if (!exists(join(homeRoot, entry.path))) continue;
      await visit(entry.path);
    }
    return { files, coordinationSchema };
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
    const { files, coordinationSchema } = await collectRecords(root, records, dirname(archive), lock);
    records.close();
    records = null;
    assertWritersStopped(root, await list(root));
    const identity = installIdentity(root);
    const authenticated = Buffer.from(JSON.stringify({
      schema: BACKUP_SCHEMA, version: 2, homeRoot: root, packageId: identity.packageId, sourceCommit: identity.sourceCommit,
      recipeId: null, createdAt: new Date().toISOString(),
      coordinationSchema,
      writersQuiesced: true, checkpoint: 'vacuum-and-stable-files', files,
    }));
    if (authenticated.length > MAX_HEADER_BYTES) fail('backup_inventory_too_large', 'The file inventory of this home exceeds one backup archive header.');
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
    if (reviewedAdoptedLinkKind(inspectionRoot, linkRelative, target) === 'retain-authority') return target;
    if (!inside(source, absolute)) {
      if (!reviewedAdoptedLink(inspectionRoot, linkRelative, target)) throw new Error(`Backup symlink escapes its home: ${linkRelative}`);
      return target;
    }
    const rebased = join(inspectionRoot, relative(source, absolute));
    if (!inside(inspectionRoot, rebased)) throw new Error(`Backup symlink escapes inspection: ${linkRelative}`);
    return relative(linkDirectory, rebased);
  }
  if (!inside(inspectionRoot, absolute) && !reviewedAdoptedLink(inspectionRoot, linkRelative, target)) throw new Error(`Backup symlink escapes inspection: ${linkRelative}`);
  return target;
}

function createExtractor(root, expectedFiles, sourceHome) {
  const byPath = new Map(expectedFiles.map(entry => [entry.path, entry]));
  let buffer = Buffer.alloc(0);
  let record = null;
  const seen = [];
  const pendingLinks = [];
  function finishRecord() {
    if (record.fd !== null) { fsyncSync(record.fd); closeSync(record.fd); }
    const digest = record.hash.digest('hex');
    const expected = byPath.get(record.path);
    if (digest !== expected.sha256) throw new Error(`Backup digest mismatch: ${record.path}`);
    if (record.type === 'symlink') {
      // Receipt files may appear later in the authenticated record stream.
      // Resolve reviewed links only after all file records are present.
      pendingLinks.push({ path: record.path, destination: record.destination, target: record.symlink.toString('utf8') });
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
      for (const entry of pendingLinks) {
        assertRealParents(root, entry.path);
        symlinkSync(restoredLink(sourceHome, root, entry.path, entry.target), entry.destination);
      }
    },
  };
}

/** Collects the length-prefixed inner header from the plaintext stream. Bounded, so a tampered length cannot demand memory. */
function headerCapture() {
  const prefix = Buffer.alloc(4);
  let prefixed = 0;
  let bytes = null;
  let filled = 0;
  return {
    /** Returns null until the header is complete, then the parsed header and the plaintext that followed it. */
    push(chunk) {
      let rest = chunk;
      if (!bytes) {
        const take = Math.min(4 - prefixed, rest.length);
        rest.copy(prefix, prefixed, 0, take);
        prefixed += take;
        rest = rest.subarray(take);
        if (prefixed < 4) return null;
        const headerLength = prefix.readUInt32BE(0);
        if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('Backup header is invalid or the key does not match this archive.');
        bytes = Buffer.alloc(headerLength);
      }
      const take = Math.min(bytes.length - filled, rest.length);
      rest.copy(bytes, filled, 0, take);
      filled += take;
      if (filled < bytes.length) return null;
      let header;
      try { header = JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error('Backup header is invalid or the key does not match this archive.'); }
      if (!header || header.schema !== BACKUP_SCHEMA || !Array.isArray(header.files)) throw new Error('Backup header is invalid.');
      return { header, rest: rest.subarray(take) };
    },
  };
}

/**
 * Decrypt and authenticate a backup in one streaming pass, writing nothing beside the archive.
 * The bounded inner header is parsed as soon as it arrives; `onHeader(header)` may return a
 * sink that receives the record bytes that follow. The GCM tag is verified at the end of the
 * pass and the header is returned only then, so a caller that wrote records must discard
 * them when this throws.
 */
function authenticateBackupArchive(archive, keyFile, onHeader = () => null) {
  const keyDocument = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (keyDocument?.schema !== KEY_SCHEMA || keyDocument.algorithm !== 'aes-256-gcm' || typeof keyDocument.key !== 'string') throw new Error('Backup key is invalid.');
  const key = Buffer.from(keyDocument.key, 'base64');
  if (key.length !== 32) throw new Error('Backup key is invalid.');
  const archiveFd = openSync(archive, 'r');
  try {
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
    const capture = headerCapture();
    let header = null;
    let sink = null;
    const consume = plain => {
      if (!header) {
        const captured = capture.push(plain);
        if (!captured) return;
        header = captured.header;
        sink = onHeader(header) || null;
        plain = captured.rest;
      }
      if (plain.length && sink) sink(plain);
    };
    const buffer = Buffer.alloc(CHUNK);
    let position = 8 + headerLength;
    while (true) {
      const count = readSync(archiveFd, buffer, 0, CHUNK, position);
      if (count <= 0) break;
      position += count;
      consume(decipher.update(buffer.subarray(0, count)));
    }
    consume(decipher.final());
    if (!header) throw new Error('Truncated backup payload.');
    return header;
  } finally { closeSync(archiveFd); }
}

/** Re-read the authenticated archive header (same authenticator as inspect). Does not extract files or write anywhere. */
export function readAuthenticatedBackupHeader({ archivePath, keyPath } = {}) {
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || !isAbsolute(archivePath) || !isAbsolute(keyPath)) {
    throw new Error('Archive and key paths must be absolute.');
  }
  return authenticateBackupArchive(resolve(archivePath), resolve(keyPath));
}

export async function inspectHomeBackup({ archivePath, keyPath, inspectionRoot } = {}) {
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || typeof inspectionRoot !== 'string' || !isAbsolute(archivePath) || !isAbsolute(keyPath) || !isAbsolute(inspectionRoot)) {
    throw new Error('Archive, key, and inspection paths must be absolute.');
  }
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  const root = absoluteRoot(inspectionRoot, 'inspection directory');
  if (readdirSync(root).length !== 0) throw new Error('Inspection directory must be empty.');
  let extractor = null;
  try {
    // One pass over the archive: records stream from the decipher straight into the inspection
    // root, which is emptied again unless the archive authenticates. No plaintext copy is written.
    const header = authenticateBackupArchive(archive, keyFile, authenticated => {
      if (!authenticated.homeRoot || resolve(authenticated.homeRoot) === root) throw new Error('Inspection directory must not be the backed-up home.');
      extractor = createExtractor(root, authenticated.files, authenticated.homeRoot);
      return chunk => extractor.push(chunk);
    });
    extractor.end();
    const reconnects = [machineReconnect()];
    if (header.files.some(entry => entry.path === 'app/config/secrets.yaml')) reconnects.push(credentialReconnect());
    const externalDependencies = retainedAuthorityDependencies(root);
    if (externalDependencies.length) reconnects.push({ kind: 'retained-authority', required: true,
      message: 'This archive contains links to authoritative external state. Reconnect those exact paths before recovery.' });
    return { ok: externalDependencies.every(item => item.present), schema: BACKUP_SCHEMA, packageId: header.packageId ?? null,
      fileCount: header.files.length, writersStarted: false, reconnects, externalDependencies,
      sourceAbsentReady: externalDependencies.length === 0, sourceHome: header.homeRoot };
  } catch (error) {
    if (extractor || readdirSync(root).length) emptyDirectory(root);
    throw error;
  }
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

function seedDirectories(home, name) {
  const substrate = join(home, 'app/instances', name, 'substrate');
  if (!exists(substrate)) return [];
  return readdirSync(substrate).filter(entry => entry.startsWith('seed-') && lstatSync(join(substrate, entry)).isDirectory()).sort();
}

function readAdoptionReceipt(home) {
  const file = join(home, 'runtime/adoption-preservation.json');
  if (!exists(file)) return null;
  const receipt = readPrivateJSON(file);
  return receipt?.schema === 'home23.adoption-preservation-receipt.v1' && Array.isArray(receipt.links) ? receipt : null;
}

/** What an adopted home is, independent of where it runs: rebind moves continuing-service run bindings and nothing else. */
function adoptionIdentityDigest(receipt) {
  const services = Array.isArray(receipt.continuationServices) ? receipt.continuationServices : [];
  return sha256(JSON.stringify({
    sourceRoot: receipt.sourceRoot ?? null, links: receipt.links, externalReferences: receipt.externalReferences ?? [],
    continuationServices: services.map(service => ({ ...service, run: undefined })),
  }));
}

function hostResidentDigest(host) {
  const map = host.residentMap && typeof host.residentMap === 'object' && !Array.isArray(host.residentMap) ? host.residentMap : null;
  const residents = map ? Object.keys(map).filter(name => /^[a-z][a-z0-9-]{0,62}$/.test(name)).sort() : [];
  return residents.length ? sha256(JSON.stringify(residents)) : null;
}

/**
 * Identity a move must carry over unchanged. A born home proves it with every Seed's birth
 * receipt and ledger. A home adopted without a birth proves it with its sealed adoption
 * receipt, or failing that the host's resident binding; its Seed ledgers still travel too.
 */
function residentIdentity(home) {
  const name = residentName(home);
  const seeds = seedDirectories(home, name);
  const paths = [];
  const born = seeds.some(seed => exists(join(home, `app/instances/${name}/substrate/${seed}/birth-receipt.json`)));
  for (const seed of seeds) {
    const birth = `app/instances/${name}/substrate/${seed}/birth-receipt.json`;
    if (exists(join(home, birth))) paths.push(birth);
    else if (born) fail('backup_identity_missing', `Resident ${name} is missing ${birth}.`);
    const ledger = `app/instances/${name}/substrate/${seed}/seed-ledger.jsonl`;
    if (exists(join(home, ledger))) paths.push(ledger);
  }
  if (born) return { paths, adoption: false, hostBinding: false };
  if (readAdoptionReceipt(home)) return { paths, adoption: true, hostBinding: false };
  if (hostResidentDigest(readHostState(home))) return { paths, adoption: false, hostBinding: true };
  fail('backup_identity_missing', `Resident ${name} has no Seed birth receipt, adoption receipt, or host resident binding to preserve.`);
}

export function residentIdentityPaths(home) {
  return residentIdentity(home).paths;
}

function identityDigests(home, evidence) {
  const digests = {};
  for (const relativePath of evidence.paths) {
    const file = join(home, relativePath);
    digests[relativePath] = exists(file) ? streamHash(file) : null;
  }
  if (evidence.adoption) {
    const receipt = readAdoptionReceipt(home);
    digests['runtime/adoption-preservation.json'] = receipt ? adoptionIdentityDigest(receipt) : null;
  }
  if (evidence.hostBinding) digests['.home23-host.json'] = hostResidentDigest(readHostState(home));
  return digests;
}

function compareIdentity(source, destination) {
  const evidence = residentIdentity(source);
  const identity = identityDigests(source, evidence);
  const restored = identityDigests(destination, evidence);
  for (const [relativePath, digest] of Object.entries(identity)) {
    if (!digest || restored[relativePath] !== digest) fail('backup_identity_mismatch', `Restored identity does not match the source: ${relativePath}`);
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

function recoverJournalPath(destination) {
  return join(dirname(destination), `.${basename(destination)}.home23-recover`, 'journal.json');
}

function readRecoverJournal(destination) {
  const file = recoverJournalPath(destination);
  if (!exists(file)) return null;
  const journal = JSON.parse(readFileSync(file, 'utf8'));
  if (journal?.schema !== RECOVER_JOURNAL_SCHEMA || journal.inspectionRoot !== destination) {
    fail('backup_recover_journal_invalid', 'The recovery journal belongs to another home.');
  }
  return journal;
}

function writeRecoverJournal(destination, journal) {
  const file = recoverJournalPath(destination);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function archiveFilesDigest(files) {
  return sha256(JSON.stringify(Array.isArray(files) ? files : []));
}

function archiveBindingFromHeader(header) {
  if (!header?.homeRoot || !isAbsolute(header.homeRoot) || header.homeRoot.includes('\0')) {
    fail('backup_recover_archive_mismatch', 'Authenticated archive has no recorded home path.');
  }
  if (!Array.isArray(header.files)) fail('backup_recover_archive_mismatch', 'Authenticated archive has no file inventory.');
  return {
    sourceHome: resolve(header.homeRoot),
    packageId: typeof header.packageId === 'string' && header.packageId.length > 0 ? header.packageId : null,
    sourceCommit: typeof header.sourceCommit === 'string' && header.sourceCommit.length > 0 ? header.sourceCommit : null,
    filesDigest: archiveFilesDigest(header.files),
  };
}

function bindingsMatch(left, right) {
  return left.sourceHome === right.sourceHome
    && left.packageId === right.packageId
    && left.sourceCommit === right.sourceCommit
    && left.filesDigest === right.filesDigest;
}

function hasRecoverableIdentity(host) {
  if (host.residentMap && typeof host.residentMap === 'object' && !Array.isArray(host.residentMap)
    && Object.keys(host.residentMap).some(name => /^[a-z][a-z0-9-]{0,62}$/.test(name))) {
    return true;
  }
  return typeof host.profile?.name === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(host.profile.name);
}

/** Host/config paths rewrite during rebind; identity bytes must still match the archive. */
function isRebindMutablePath(relative) {
  if (isLifecycleLockPath(relative)) return true;
  if (relative === '.home23-host.json' || relative === '.home23-install.json') return true;
  if (relative === 'app/config/home.yaml' || relative === 'app/config/agents.json') return true;
  if (relative === 'app/ecosystem.config.cjs' || relative === 'runtime/semantic-prep.json') return true;
  if (relative === 'runtime/ecosystem.config.json') return true;
  if (/^app\/instances\/[^/]+\/(config|engine)\.yaml$/.test(relative)) return true;
  return false;
}

const CURSOR_PATH = /^app\/instances\/[^/]+\/(?:substrate\/[^/]+|seed-[^/]+)\/adapter-cursor\.([a-zA-Z0-9_-]+)\.json$/;

function cursorId(sourcePath) {
  return `tail_${sha256(Buffer.from(sourcePath, 'utf8')).slice(0, 8)}`;
}

function cursorRebindShape(relativePath, original, source, destination, adopted) {
  const match = CURSOR_PATH.exec(relativePath);
  if (!match || !safeRelative(relativePath)) fail('move_rebind_incomplete', `Invalid Seed cursor path: ${relativePath}`);
  let cursor;
  try { cursor = JSON.parse(original); }
  catch { fail('move_rebind_incomplete', `Seed cursor is not JSON: ${relativePath}`); }
  if (!cursor || Array.isArray(cursor) || typeof cursor !== 'object'
    || cursor.schema !== 'home23.seed.adapter-cursor.v1'
    || typeof cursor.sourcePath !== 'string' || !isAbsolute(cursor.sourcePath) || cursor.sourcePath.includes('\0')
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    fail('move_rebind_incomplete', `Seed cursor is malformed: ${relativePath}`);
  }
  const mapped = replaceHomePath(cursor.sourcePath, source, destination, adopted);
  const nextId = match[1] === cursorId(cursor.sourcePath) ? cursorId(mapped) : match[1];
  const nextPath = `${relativePath.slice(0, relativePath.lastIndexOf('/') + 1)}adapter-cursor.${nextId}.json`;
  const after = mapped === cursor.sourcePath ? original : `${JSON.stringify({ ...cursor, sourcePath: mapped })}\n`;
  return { nextPath, after };
}

function cursorFiles(destination) {
  const found = [];
  const instances = 'app/instances';
  if (!exists(join(destination, instances))) return found;
  assertNoSymlinkAncestors(destination, instances);
  for (const resident of readdirSync(join(destination, instances))) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(resident)) continue;
    const residentPath = `${instances}/${resident}`;
    assertNoSymlinkAncestors(destination, residentPath);
    if (!lstatSync(join(destination, residentPath)).isDirectory()) continue;
    // Older continuing residents keep seed-01 directly below the resident
    // (Clay), while current homes use substrate/seed-01. Both are state.
    const states = readdirSync(join(destination, residentPath))
      .filter(name => /^seed-[^/]+$/.test(name)).map(name => `${residentPath}/${name}`);
    const substrate = `${residentPath}/substrate`;
    if (exists(join(destination, substrate))) {
      assertNoSymlinkAncestors(destination, substrate);
      if (!lstatSync(join(destination, substrate)).isDirectory()) fail('move_rebind_incomplete', `Invalid Seed state directory: ${substrate}`);
      states.push(...readdirSync(join(destination, substrate))
        .filter(name => /^[^/.][^/]*$/.test(name)).map(name => `${substrate}/${name}`));
    }
    for (const state of states) {
      assertNoSymlinkAncestors(destination, state);
      if (!lstatSync(join(destination, state)).isDirectory()) continue;
      for (const leaf of readdirSync(join(destination, state))) {
        if (!leaf.startsWith('adapter-cursor.')) continue;
        const path = `${state}/${leaf}`;
        if (!CURSOR_PATH.test(path)) fail('move_rebind_incomplete', `Invalid Seed cursor filename: ${path}`);
        assertNoSymlinkAncestors(destination, path);
        if (!lstatSync(join(destination, path)).isFile()) fail('move_rebind_incomplete', `Invalid Seed cursor file: ${path}`);
        found.push(path);
      }
    }
  }
  return found;
}

function prepareCursorBindings(destination, source, adopted) {
  const bindings = cursorFiles(destination).map(path => {
    const original = readFileSync(join(destination, path), 'utf8');
    const shape = cursorRebindShape(path, original, source, destination, adopted);
    return { path, original, nextPath: shape.nextPath };
  });
  const targets = new Set();
  for (const binding of bindings) {
    if (targets.has(binding.nextPath) || (binding.nextPath !== binding.path && bindings.some(other => other.path === binding.nextPath))) {
      fail('move_rebind_incomplete', `Seed cursor target is ambiguous: ${binding.nextPath}`);
    }
    targets.add(binding.nextPath);
  }
  return bindings;
}

function checkedCursorBinding(destination, source, adopted, binding, archiveEntry = null) {
  if (!binding || typeof binding.path !== 'string' || typeof binding.original !== 'string'
    || !CURSOR_PATH.test(binding.path) || !safeRelative(binding.path)
    || (archiveEntry && (archiveEntry.path !== binding.path || archiveEntry.sha256 !== sha256(Buffer.from(binding.original))))) {
    fail('backup_recover_archive_mismatch', 'Seed cursor rebind is not bound to the authenticated archive.');
  }
  const shape = cursorRebindShape(binding.path, binding.original, source, destination, adopted);
  if (shape.nextPath !== binding.nextPath) fail('backup_recover_archive_mismatch', 'Seed cursor rebind target changed.');
  for (const path of new Set([binding.path, shape.nextPath])) assertNoSymlinkAncestors(destination, path);
  const oldFile = join(destination, binding.path);
  const newFile = join(destination, shape.nextPath);
  const originalHash = sha256(Buffer.from(binding.original));
  const afterHash = sha256(Buffer.from(shape.after));
  const oldExists = exists(oldFile);
  const newExists = exists(newFile);
  if (binding.path !== shape.nextPath && oldExists && newExists) {
    if (lstatSync(oldFile).isFile() && lstatSync(newFile).isFile()
      && streamHash(oldFile) === originalHash && streamHash(newFile) === afterHash) return { state: 'cleanup', shape };
    fail('backup_recover_archive_mismatch', `Seed cursor target collides: ${shape.nextPath}`);
  }
  if (oldExists && lstatSync(oldFile).isFile() && streamHash(oldFile) === originalHash) return { state: 'before', shape };
  if (newExists && lstatSync(newFile).isFile() && streamHash(newFile) === afterHash) return { state: 'after', shape };
  fail('backup_recover_archive_mismatch', `Seed cursor differs from authenticated rebind: ${binding.path}`);
}

function applyCursorBindings(destination, source, adopted, bindings) {
  for (const binding of bindings) checkedCursorBinding(destination, source, adopted, binding);
  for (const binding of bindings) {
    const { state, shape } = checkedCursorBinding(destination, source, adopted, binding);
    if (state === 'after') continue;
    const next = join(destination, shape.nextPath);
    const old = join(destination, binding.path);
    if (state === 'cleanup') { unlinkSync(old); continue; }
    const temporary = `${next}.${randomUUID()}.tmp`;
    writeFileSync(temporary, shape.after, { mode: lstatSync(old).mode & 0o777 });
    renameSync(temporary, next);
    if (next !== old) unlinkSync(old);
  }
}

/**
 * Compare an inspected symlink to the archive digest using the same rebase
 * inspect applies via restoredLink (absolute internal targets become relative).
 */
function symlinkMatchesArchivedTarget(destination, sourceHome, linkRelative, entrySha256) {
  const absoluteLink = join(destination, linkRelative);
  let actual;
  try { actual = assertSymlinkInside(destination, linkRelative); }
  catch (error) {
    fail('backup_recover_archive_mismatch', error?.message || `Unsafe symlink: ${linkRelative}`);
  }
  if (sha256(Buffer.from(actual, 'utf8')) === entrySha256) return true;
  const linkDirectory = dirname(absoluteLink);
  const resolvedActual = isAbsolute(actual) ? resolve(actual) : resolve(linkDirectory, actual);
  if (!inside(resolve(destination), resolvedActual)) {
    fail('backup_recover_archive_mismatch', `Inspected home does not match the authenticated archive: ${linkRelative}`);
  }
  const originalAbsolute = join(resolve(sourceHome), relative(resolve(destination), resolvedActual));
  if (sha256(Buffer.from(originalAbsolute, 'utf8')) !== entrySha256) return false;
  try {
    return restoredLink(sourceHome, destination, linkRelative, originalAbsolute) === actual;
  } catch {
    return false;
  }
}

function assertExtractMatchesArchive(destination, header, { allowRebindMutation = false, adoptionReceiptHashes = [], cursorBindings = null } = {}) {
  const sourceHome = resolve(header.homeRoot);
  const archivedCursors = header.files.filter(entry => CURSOR_PATH.test(entry?.path || ''));
  if (!allowRebindMutation) {
    const archivedPaths = new Set(archivedCursors.map(entry => entry.path));
    for (const path of cursorFiles(destination)) {
      if (!archivedPaths.has(path)) fail('backup_recover_archive_mismatch', `Seed cursor was not in the authenticated archive: ${path}`);
    }
  }
  if (allowRebindMutation) {
    const allowed = new Set((cursorBindings || []).flatMap(binding => [binding?.path, binding?.nextPath]));
    for (const path of cursorFiles(destination)) {
      if (!allowed.has(path)) fail('backup_recover_archive_mismatch', `Seed cursor was not in the authenticated rebind: ${path}`);
    }
  }
  if (allowRebindMutation && archivedCursors.length) {
    if (!Array.isArray(cursorBindings) || cursorBindings.length !== archivedCursors.length) {
      fail('backup_recover_archive_mismatch', 'Authenticated Seed cursor rebind plan is missing.');
    }
    const seen = new Set();
    const targets = new Set();
    for (const binding of cursorBindings) {
      const entry = archivedCursors.find(candidate => candidate.path === binding?.path);
      if (!entry || entry.type !== 'file' || seen.has(binding.path)) fail('backup_recover_archive_mismatch', 'Seed cursor rebind plan is ambiguous.');
      seen.add(binding.path);
      const { shape } = checkedCursorBinding(destination, sourceHome, false, binding, entry);
      if (targets.has(shape.nextPath) || (shape.nextPath !== binding.path && archivedCursors.some(candidate => candidate.path === shape.nextPath))) {
        fail('backup_recover_archive_mismatch', `Seed cursor target is ambiguous: ${shape.nextPath}`);
      }
      targets.add(shape.nextPath);
    }
  }
  for (const entry of header.files) {
    if (!entry || typeof entry.path !== 'string' || !safeRelative(entry.path)) {
      fail('backup_recover_archive_mismatch', 'Authenticated archive inventory is invalid.');
    }
    if (isLifecycleLockPath(entry.path)) continue;
    if (allowRebindMutation && isRebindMutablePath(entry.path)) continue;
    if (allowRebindMutation && CURSOR_PATH.test(entry.path)) continue;
    const absolute = join(destination, entry.path);
    if (!exists(absolute)) {
      fail('backup_recover_archive_mismatch', `Inspected home is missing archived path: ${entry.path}`);
    }
    // Rebinding service paths updates this receipt, but never grants a blanket
    // exemption to its sealed authority links or original source bindings.
    if (allowRebindMutation && entry.path === 'runtime/adoption-preservation.json'
      && entry.type === 'file' && lstatSync(absolute).isFile()
      && adoptionReceiptHashes.includes(streamHash(absolute))) continue;
    if (entry.type === 'symlink') {
      if (!symlinkMatchesArchivedTarget(destination, sourceHome, entry.path, entry.sha256)) {
        fail('backup_recover_archive_mismatch', `Inspected home does not match the authenticated archive: ${entry.path}`);
      }
      continue;
    }
    if (entry.type !== 'file') continue;
    if (!lstatSync(absolute).isFile() || streamHash(absolute) !== entry.sha256) {
      fail('backup_recover_archive_mismatch', `Inspected home does not match the authenticated archive: ${entry.path}`);
    }
  }
}

/** Refuse symlink ancestors that would let installMovedRuntime write outside the destination.
 * An expected product-manifest symlink may already exist at the leaf after a partial install. */
function assertNoSymlinkAncestors(root, relativePath, { expectedLeafSymlinkTarget = null } = {}) {
  if (!safeRelative(relativePath)) {
    fail('backup_recover_unsafe_path', `Recovery path is invalid: ${relativePath}`);
  }
  const parts = relativePath.split('/');
  let current = resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    if (!exists(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const isLeaf = index === parts.length - 1;
      if (isLeaf && typeof expectedLeafSymlinkTarget === 'string') {
        const actual = readlinkSync(current);
        if (actual === expectedLeafSymlinkTarget) return;
        fail('backup_recover_unsafe_path', `Recovery destination symlink target differs at ${relativePath}.`);
      }
      fail('backup_recover_unsafe_path', `Recovery destination has an unsafe symlink at ${parts.slice(0, index + 1).join('/')}.`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail('backup_recover_unsafe_path', `Recovery destination blocks path ${relativePath}.`);
    }
  }
}

function expectedPayloadSymlinkTarget(payloadRoot, entry) {
  if (!entry || entry.type !== 'symlink' || typeof entry.path !== 'string') return null;
  if (typeof entry.target === 'string') return entry.target;
  if (typeof payloadRoot !== 'string') return null;
  const from = join(payloadRoot, entry.path);
  if (!exists(from) || !lstatSync(from).isSymbolicLink()) return null;
  return readlinkSync(from);
}

function assertSafeRuntimeDestination(destination, files, { payloadRoot = null } = {}) {
  for (const entry of files) {
    if (!entry || typeof entry.path !== 'string') continue;
    if (isProductStatePath(entry.path)) continue;
    assertNoSymlinkAncestors(destination, entry.path, {
      expectedLeafSymlinkTarget: expectedPayloadSymlinkTarget(payloadRoot, entry),
    });
  }
  assertNoSymlinkAncestors(destination, 'manifest.json');
}

function revalidateRecoveryDestination(destination, header, binding, phase, journal = null) {
  const host = readHostState(destination);
  if (!hasRecoverableIdentity(host)) {
    fail('backup_recover_invalid', 'Inspected home has no resident identity to recover.');
  }
  const midRebind = phase === 'runtime_installed'
    && journal?.rebindPlan
    && typeof journal.rebindPlan === 'object'
    && resolve(host.homeRoot) === destination;
  if (phase === 'claimed' || (phase === 'runtime_installed' && !midRebind)) {
    if (resolve(host.homeRoot) === destination) {
      fail('backup_recover_destination_refused', 'This home is already installed here. Choose the inspected restore folder for this archive.');
    }
    if (resolve(host.homeRoot) !== binding.sourceHome) {
      fail('backup_recover_archive_mismatch', 'Inspected home does not match the authenticated archive home.');
    }
    assertExtractMatchesArchive(destination, header, { allowRebindMutation: false });
    return;
  }
  if (midRebind || phase === 'rebound' || phase === 'committed') {
    if (resolve(host.homeRoot) !== destination) {
      fail('backup_recover_archive_mismatch', 'Interrupted recovery no longer points at this destination.');
    }
    const adoption = journal?.rebindPlan?.adoptionBindings;
    assertExtractMatchesArchive(destination, header, { allowRebindMutation: true,
      adoptionReceiptHashes: adoption ? [adoption.beforeHash, adoption.afterHash] : [],
      cursorBindings: journal?.rebindPlan?.cursorBindings });
    return;
  }
  fail('backup_recover_journal_invalid', 'Recovery journal has an unknown phase.');
}

async function inventoryDestinationWriters(destination, dependencies = {}) {
  if (dependencies.listProcesses) return dependencies.listProcesses(destination);
  const node = join(destination, 'bin', 'node');
  const pm2 = join(destination, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  if (!exists(node) || !exists(pm2)) return [];
  return listInstalledWriters(destination);
}

/** Backup may capture the update-lock marker while the source lock is held. Without the lock directory it is not a live claim. */
function clearOrphanedHostLockMarker(home) {
  const lockPath = join(home, 'runtime', '.host.lock');
  const markerPath = join(home, 'runtime', '.home23-update-lock.json');
  if (!exists(lockPath) && exists(markerPath)) unlinkSync(markerPath);
}

function isLifecycleLockPath(relative) {
  return relative === 'runtime/.home23-update-lock.json'
    || relative === 'runtime/.host.lock'
    || relative.startsWith('runtime/.host.lock/');
}

function writeRecoveredInstallReceipt(destination, manifest) {
  writeFileSync(join(destination, '.home23-install.json'), `${JSON.stringify({
    schema: INSTALL_SCHEMA,
    status: 'installed',
    homeRoot: destination,
    appRoot: join(destination, 'app'),
    nodePath: join(destination, 'bin', 'node'),
    pm2Path: join(destination, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'),
    packageId: manifest.packageId,
    sourceCommit: manifest.sourceCommit,
    replayed: false,
  })}\n`, { mode: 0o600 });
}

/** Native Host rejects a home root with group/other bits. Only the destination inode. */
function secureOwnedDestinationRoot(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return;
  chmodSync(directory, 0o700);
}

function replaceHomePath(value, source, destination, adopted = false) {
  if (value !== source && !value.startsWith(`${source}${sep}`)) return value;
  if (adopted) {
    const suffix = value.slice(source.length);
    if (['app', 'runtime', 'bin', 'tools'].some(name => suffix === `${sep}${name}` || suffix.startsWith(`${sep}${name}${sep}`))) {
      return `${destination}${suffix}`;
    }
    return `${join(destination, 'app')}${suffix}`;
  }
  return `${destination}${value.slice(source.length)}`;
}

function rewriteMachineStrings(value, source, destination, oldPorts, newPorts, adopted = false) {
  if (typeof value === 'string') {
    let next = replaceHomePath(value, source, destination, adopted);
    if (oldPorts && newPorts) {
      for (const key of Object.keys(newPorts)) {
        const previous = oldPorts[key];
        const assigned = newPorts[key];
        if (!Number.isInteger(previous) || !Number.isInteger(assigned) || previous === assigned) continue;
        next = next.split(`127.0.0.1:${previous}`).join(`127.0.0.1:${assigned}`);
      }
    }
    return next;
  }
  if (Array.isArray(value)) return value.map(item => rewriteMachineStrings(item, source, destination, oldPorts, newPorts, adopted));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteMachineStrings(child, source, destination, oldPorts, newPorts, adopted)]));
  }
  return value;
}

/** Only agent-turn prose in adopted cron jobs may contain embedded instance paths. */
export function rewriteAdoptedCronPromptPaths(jobs, source, destination) {
  if (!Array.isArray(jobs)) return jobs;
  const oldPrefix = `${source}${sep}instances${sep}`;
  const newPrefix = `${join(destination, 'app/instances')}${sep}`;
  for (const job of jobs) {
    const payload = job?.payload;
    if (payload?.kind !== 'agentTurn' || typeof payload.message !== 'string') continue;
    const message = payload.message;
    let cursor = 0, result = '';
    while (cursor < message.length) {
      const index = message.indexOf(oldPrefix, cursor);
      if (index < 0) { result += message.slice(cursor); break; }
      const previous = index === 0 ? '' : message[index - 1];
      const bounded = index === 0 || /\s/.test(previous) || ['"', "'", '`', '(', '['].includes(previous);
      result += message.slice(cursor, index) + (bounded ? newPrefix : oldPrefix);
      cursor = index + oldPrefix.length;
    }
    payload.message = result;
  }
  return jobs;
}

function treeContains(value, needle) {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some(item => treeContains(item, needle));
  if (value && typeof value === 'object') return Object.values(value).some(item => treeContains(item, needle));
  return false;
}

function assignHomePorts(home, destination, ports) {
  if (!home || typeof home !== 'object' || !ports) return;
  if (home.coordination && typeof home.coordination === 'object') {
    home.coordination.socketDirectory = socketRootFor(destination);
    if (home.coordination.publicApi && typeof home.coordination.publicApi === 'object' && Number.isInteger(ports.coordination)) {
      home.coordination.publicApi.port = ports.coordination;
    }
  }
  if (home.evobrew && typeof home.evobrew === 'object' && Number.isInteger(ports.evobrew)) home.evobrew.port = ports.evobrew;
  if (home.substrate && typeof home.substrate === 'object') {
    if (home.substrate.observatory && typeof home.substrate.observatory === 'object' && Number.isInteger(ports.observatory)) {
      home.substrate.observatory.port = ports.observatory;
    }
    if (home.substrate.embedding && typeof home.substrate.embedding === 'object' && Number.isInteger(ports.embedder)) {
      home.substrate.embedding.endpoint = `http://127.0.0.1:${ports.embedder}/api/embeddings`;
    }
  }
  if (home.embedder && typeof home.embedder === 'object' && Number.isInteger(ports.embedder)) home.embedder.port = ports.embedder;
  if (Array.isArray(home.embeddings?.providers) && Number.isInteger(ports.embedder)) {
    for (const provider of home.embeddings.providers) {
      if (provider && typeof provider === 'object' && typeof provider.endpoint === 'string' && provider.endpoint.includes('/api/embeddings')) {
        provider.endpoint = `http://127.0.0.1:${ports.embedder}/api/embeddings`;
      }
    }
  }
}

function assignInstancePorts(config, ports) {
  if (!config?.ports || typeof config.ports !== 'object' || !ports) return;
  for (const key of ['engine', 'dashboard', 'mcp', 'bridge']) {
    if (Number.isInteger(ports[key])) config.ports[key] = ports[key];
  }
}

/** Distinct engine/dashboard/mcp/bridge bindings per resident. Shared home ports stay on the Host record. */
export function residentInstancePortSets(homePorts, residentNames) {
  const names = Array.isArray(residentNames) ? residentNames.filter(name => typeof name === 'string' && name) : [];
  const used = new Set(Object.values(homePorts || {}).filter(value => Number.isInteger(value)));
  let cursor = Math.max(20000, ...used, 19999) + 1;
  const sets = {};
  for (const name of names) {
    const ports = {};
    for (const key of ['engine', 'dashboard', 'mcp', 'bridge']) {
      while (used.has(cursor)) cursor += 1;
      if (cursor > 60999) throw new Error('Could not allocate distinct resident ports.');
      ports[key] = cursor;
      used.add(cursor);
      cursor += 1;
    }
    sets[name] = ports;
  }
  return sets;
}

function writePrivateYaml(file, value, yaml) {
  const mode = exists(file) ? (lstatSync(file).mode & 0o777) : 0o600;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, yaml.dump(value, { lineWidth: 120, noRefs: true }), { mode });
  renameSync(temporary, file);
}

async function rebindMachineConfiguration(source, destination, oldPorts, newPorts, { residentPorts = null, adopted = false } = {}) {
  const { default: yaml } = await import('js-yaml');
  const files = [];
  const homeYaml = join(destination, 'app/config/home.yaml');
  if (exists(homeYaml)) files.push({ file: homeYaml, kind: 'home', resident: null });
  const targetsYaml = join(destination, 'app/config/targets.yaml');
  if (exists(targetsYaml)) files.push({ file: targetsYaml, kind: 'targets', resident: null });
  const instances = join(destination, 'app/instances');
  if (exists(instances)) {
    for (const name of readdirSync(instances)) {
      if (name.startsWith('.')) continue;
      const residentPath = join(instances, name);
      if (!lstatSync(residentPath).isDirectory()) continue;
      for (const [leaf, kind] of [['config.yaml', 'instance'], ['engine.yaml', 'engine']]) {
        const file = join(residentPath, leaf);
        if (exists(file)) files.push({ file, kind, resident: name });
      }
    }
  }
  for (const entry of files) {
    let document;
    try { document = yaml.load(readFileSync(entry.file, 'utf8')) || {}; }
    catch { fail('move_rebind_incomplete', `Destination configuration could not be read: ${relative(destination, entry.file)}`); }
    document = rewriteMachineStrings(document, source, destination, oldPorts, newPorts, adopted);
    if (entry.kind === 'home') assignHomePorts(document, destination, newPorts);
    if (entry.kind === 'instance') {
      const portsForResident = (residentPorts && entry.resident && residentPorts[entry.resident])
        ? residentPorts[entry.resident]
        : newPorts;
      assignInstancePorts(document, portsForResident);
    }
    if (treeContains(document, source)) fail('move_rebind_incomplete', `Destination configuration still names the source home: ${relative(destination, entry.file)}`);
    writePrivateYaml(entry.file, document, yaml);
  }
  const ecosystem = join(destination, 'app/ecosystem.config.cjs');
  if (exists(ecosystem)) {
    let text = readFileSync(ecosystem, 'utf8');
    if (adopted) {
      for (const name of ['app', 'runtime', 'bin', 'tools']) {
        text = text.split(`${source}${sep}${name}`).join(`${destination}${sep}${name}`);
      }
      text = text.split(source).join(join(destination, 'app'));
    } else {
      text = text.split(source).join(destination);
    }
    text = replaceAssignedPorts(text, oldPorts, newPorts);
    if (residentPorts) {
      for (const ports of Object.values(residentPorts)) {
        text = replaceAssignedPorts(text, oldPorts, { ...newPorts, ...ports });
      }
    }
    if (text.includes(source)) fail('move_rebind_incomplete', 'Destination process registration still names the source home.');
    const temporary = `${ecosystem}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: lstatSync(ecosystem).mode & 0o777 });
    renameSync(temporary, ecosystem);
  }
  for (const relative of ['app/config/cron-jobs.json', 'app/evobrew/config.json']) {
    const file = join(destination, relative);
    if (!exists(file)) continue;
    // A reviewed adoption may leave legacy Evobrew as one external authority.
    // Rebinding its config through the adopted link would mutate live source
    // material, so only destination-owned files are rewritten.
    if (!inside(destination, realpathSync(file))) {
      const parts = relative.split('/');
      const reviewed = parts.some((_, index) => {
        const prefix = parts.slice(0, index + 1).join('/');
        const ancestor = join(destination, prefix);
        return lstatSync(ancestor).isSymbolicLink()
          && reviewedAdoptedLink(destination, prefix, readlinkSync(ancestor));
      });
      if (reviewed) continue;
      fail('move_rebind_incomplete', `Destination ${relative} has an unreviewed external authority.`);
    }
    let config;
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { fail('move_rebind_incomplete', `Destination ${relative} could not be read.`); }
    config = rewriteMachineStrings(config, source, destination, oldPorts, newPorts, adopted);
    if (relative === 'app/config/cron-jobs.json' && adopted) {
      config = rewriteAdoptedCronPromptPaths(config, source, destination);
    }
    if (treeContains(config, source)) fail('move_rebind_incomplete', `Destination ${relative} still names the source home.`);
    writePrivateJSON(file, config);
  }
  rebindSemanticPrep(source, destination, newPorts, adopted);
  rebindAgentsManifest(source, destination, adopted);
  const savedProcesses = join(destination, 'runtime/ecosystem.config.json');
  if (exists(savedProcesses)) unlinkSync(savedProcesses);
}

function replaceAssignedPorts(text, oldPorts, newPorts) {
  if (!oldPorts || !newPorts) return text;
  let next = text;
  for (const key of Object.keys(newPorts)) {
    const previous = oldPorts[key];
    const assigned = newPorts[key];
    if (!Number.isInteger(previous) || !Number.isInteger(assigned) || previous === assigned) continue;
    next = next.split(`127.0.0.1:${previous}`).join(`127.0.0.1:${assigned}`);
    next = next.split(`String(${previous})`).join(`String(${assigned})`);
  }
  return next;
}

function writePrivateJSON(file, value) {
  const mode = exists(file) ? (lstatSync(file).mode & 0o777) : 0o600;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, file);
}

function rebindSemanticPrep(source, destination, newPorts, adopted = false) {
  const file = join(destination, 'runtime/semantic-prep.json');
  if (!exists(file)) return;
  let prep;
  try { prep = JSON.parse(readFileSync(file, 'utf8')); }
  catch { fail('move_rebind_incomplete', 'Destination semantic preparation could not be read.'); }
  if (prep?.schema !== 'home23.semantic-prep.v1') fail('move_rebind_incomplete', 'Destination semantic preparation has an unknown schema.');
  const recipeId = prep.recipeId;
  prep.homeRoot = destination;
  prep.workerPid = 0;
  if (Number.isInteger(newPorts?.embedder)) prep.port = newPorts.embedder;
  if (typeof prep.cacheDir === 'string') prep.cacheDir = replaceHomePath(prep.cacheDir, source, destination, adopted);
  if (Array.isArray(prep.workerArgv)) {
    prep.workerArgv = prep.workerArgv.map(part => (typeof part === 'string' ? replaceHomePath(part, source, destination, adopted) : part));
    const node = join(destination, 'bin/node');
    const worker = join(destination, 'app/scripts/product/semantic-prepare-worker.mjs');
    if (typeof prep.workerArgv[0] === 'string' && !prep.workerArgv[0].startsWith(`${destination}${sep}`)) prep.workerArgv[0] = node;
    const workerIndex = prep.workerArgv.findIndex(part => typeof part === 'string' && part.endsWith('semantic-prepare-worker.mjs'));
    if (workerIndex >= 0 && !prep.workerArgv[workerIndex].startsWith(`${destination}${sep}`)) prep.workerArgv[workerIndex] = worker;
  }
  if (recipeId) prep.recipeId = recipeId;
  if (treeContains(prep, source)) fail('move_rebind_incomplete', 'Destination semantic preparation still names the source home.');
  writePrivateJSON(file, prep);
}

function rebindAgentsManifest(source, destination, adopted = false) {
  const file = join(destination, 'app/config/agents.json');
  if (!exists(file)) return;
  let agents;
  try { agents = JSON.parse(readFileSync(file, 'utf8')); }
  catch { fail('move_rebind_incomplete', 'Destination agent registry could not be read.'); }
  if (!Array.isArray(agents)) fail('move_rebind_incomplete', 'Destination agent registry is not a list.');
  const keys = ['configPath', 'instanceRoot', 'brainPath', 'workspacePath', 'conversationsPath', 'logsPath'];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    for (const key of keys) {
      if (typeof agent[key] === 'string') agent[key] = replaceHomePath(agent[key], source, destination, adopted);
    }
  }
  if (treeContains(agents, source)) fail('move_rebind_incomplete', 'Destination agent registry still names the source home.');
  writePrivateJSON(file, agents);
}

function sourceHomePresent(source) {
  if (typeof source !== 'string' || !source || source.includes('\0')) return false;
  try {
    if (!exists(source)) return false;
    const stat = lstatSync(source);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function prepareAdoptionBindings(destination, host, source, oldPorts, newPorts, { adopting = false } = {}) {
  // Initial managed adoption already sealed these exact run bindings in the
  // source plan; rebasing against the retained source would corrupt deliberate
  // external authorities such as Evobrew and Caddy.
  if (adopting) return null;
  if (!host.continuationServices?.length && !host.networkBindings) return null;
  const file = join(destination, 'runtime/adoption-preservation.json');
  const before = readFileSync(file);
  const receipt = readPrivateJSON(file);
  if (receipt?.schema !== 'home23.adoption-preservation-receipt.v1'
    || !Array.isArray(receipt.continuationServices)
    || JSON.stringify(receipt.networkBindings || null) !== JSON.stringify(host.networkBindings || null)
    || JSON.stringify(host.continuationServices || []) !== JSON.stringify(
      receipt.continuationServices.map(service => ({ name: service.name, ...service.run })))) {
    fail('move_rebind_incomplete', 'Continuing services do not match their sealed adoption receipt.');
  }
  const rebound = { ...receipt, continuationServices: receipt.continuationServices.map(service => ({
    ...service,
    // The original source binding remains historical evidence. Only the
    // current run binding moves; external authorities keep their exact paths.
    run: rewriteMachineStrings(service.run, source, destination, oldPorts, newPorts),
  })) };
  return { beforeHash: sha256(before), afterHash: sha256(Buffer.from(`${JSON.stringify(rebound, null, 2)}\n`)),
    receipt: rebound };
}

async function prepareRebindPlan(source, destination, { adopting = false } = {}) {
  const host = readHostState(destination);
  const recordedHomeRoot = (typeof host.homeRoot === 'string' && isAbsolute(host.homeRoot) && !host.homeRoot.includes('\0'))
    ? resolve(host.homeRoot)
    : null;
  const sourcePresent = sourceHomePresent(source);
  let rewriteFrom;
  let oldPorts = null;
  if (sourcePresent) {
    rewriteFrom = resolve(source);
    const sourceHostPath = join(rewriteFrom, '.home23-host.json');
    if (exists(sourceHostPath)) {
      const sourceHost = readHostState(rewriteFrom);
      oldPorts = sourceHost.ports && typeof sourceHost.ports === 'object' ? sourceHost.ports : null;
    }
  } else {
    if (!recordedHomeRoot) {
      fail('move_rebind_incomplete', 'Destination host has no recorded home path to rewrite from.');
    }
    rewriteFrom = recordedHomeRoot;
    oldPorts = host.ports && typeof host.ports === 'object' ? host.ports : null;
  }
  let ports = host.ports && typeof host.ports === 'object' ? { ...host.ports } : null;
  if (host.networkBindings) {
    if (host.networkBindings.schema !== 'home23.adoption-network-bindings.v1'
      || JSON.stringify(ports) !== JSON.stringify(host.networkBindings.shared)) {
      fail('move_rebind_incomplete', 'Continuing-home network bindings changed.');
    }
    validatePortPlan(ports, { encoderRequired: host.encoderRequired === true, continuingBindings: true });
    await withReservedPorts(ports, async () => {}, { encoderRequired: host.encoderRequired === true,
      continuingBindings: true, residentPorts: host.networkBindings.residents });
  } else {
    const disjoint = Boolean(oldPorts && ports && Number.isInteger(ports.coordination) && ports.coordination !== oldPorts.coordination);
    if (!disjoint) ports = await choosePortPlan({ encoderRequired: host.encoderRequired === true });
  }
  let residentPorts = null;
  if (host.residentMap && typeof host.residentMap === 'object' && !Array.isArray(host.residentMap)) {
    const residents = Object.keys(host.residentMap).filter(name => /^[a-z][a-z0-9-]{0,62}$/.test(name));
    if (host.networkBindings) {
      residentPorts = host.networkBindings.residents;
      if (Object.keys(residentPorts || {}).sort().join('|') !== residents.sort().join('|')) {
        fail('move_rebind_incomplete', 'Continuing-home resident network bindings changed.');
      }
    } else if (residents.length > 1) residentPorts = residentInstancePortSets(ports, residents);
  }
  return {
    rewriteFrom,
    oldPorts,
    ports,
    residentPorts,
    recordedHomeRoot,
    sourcePresent,
    encoderRequired: host.encoderRequired === true,
    adoptionBindings: prepareAdoptionBindings(destination, host, rewriteFrom, oldPorts, ports, { adopting }),
    cursorBindings: prepareCursorBindings(destination, rewriteFrom, adopting),
  };
}

async function rebindDestination(source, destination, options = {}) {
  const plan = options.plan && typeof options.plan === 'object' ? options.plan : null;
  const host = readHostState(destination);
  let rewriteFrom;
  let oldPorts = null;
  let ports;
  let residentPorts = null;
  let sourcePresent;
  let adoptionBindings = null;
  let cursorBindings = null;

  if (plan) {
    rewriteFrom = plan.rewriteFrom;
    oldPorts = plan.oldPorts && typeof plan.oldPorts === 'object' ? plan.oldPorts : null;
    ports = plan.ports && typeof plan.ports === 'object' ? { ...plan.ports } : null;
    residentPorts = plan.residentPorts && typeof plan.residentPorts === 'object' ? plan.residentPorts : null;
    sourcePresent = plan.sourcePresent === true;
    adoptionBindings = plan.adoptionBindings || null;
    cursorBindings = plan.cursorBindings;
    if (typeof rewriteFrom !== 'string' || !isAbsolute(rewriteFrom) || !ports) {
      fail('move_rebind_incomplete', 'Recovery rebind plan is incomplete.');
    }
  } else {
    const prepared = await prepareRebindPlan(source, destination, { adopting: options.adoptManagedSource === true });
    rewriteFrom = prepared.rewriteFrom;
    oldPorts = prepared.oldPorts;
    ports = prepared.ports;
    residentPorts = prepared.residentPorts;
    sourcePresent = prepared.sourcePresent;
    adoptionBindings = prepared.adoptionBindings;
    cursorBindings = prepared.cursorBindings;
  }

  if (!Array.isArray(cursorBindings)) fail('move_rebind_incomplete', 'Recovery rebind plan has no Seed cursor bindings.');
  // Refuse a malformed/colliding cursor before changing the host record.
  for (const binding of cursorBindings) checkedCursorBinding(destination, rewriteFrom, options.adoptManagedSource === true, binding);

  if (adoptionBindings) {
    const file = join(destination, 'runtime/adoption-preservation.json');
    if (![adoptionBindings.beforeHash, adoptionBindings.afterHash].includes(streamHash(file))) {
      fail('move_rebind_incomplete', 'The sealed adoption receipt changed during recovery.');
    }
    host.continuationServices = adoptionBindings.receipt.continuationServices.map(service => ({ name: service.name, ...service.run }));
  }
  host.homeRoot = destination;
  host.desiredRunning = false;
  host.phase = 'stopped';
  host.ports = ports;
  if (residentPorts && host.residentMap && typeof host.residentMap === 'object' && !Array.isArray(host.residentMap)) {
    for (const name of Object.keys(residentPorts)) {
      host.residentMap[name] = { ...(host.residentMap[name] || {}), ports: residentPorts[name] };
    }
  }
  writeFileSync(join(destination, '.home23-host.json'), `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  if (options.afterHostWrite) await options.afterHostWrite(destination, host);
  if (adoptionBindings) writePrivateJSON(join(destination, 'runtime/adoption-preservation.json'), adoptionBindings.receipt);
  await rebindMachineConfiguration(rewriteFrom, destination, oldPorts, host.ports, {
    residentPorts, adopted: options.adoptManagedSource === true,
  });
  applyCursorBindings(destination, rewriteFrom, options.adoptManagedSource === true, cursorBindings);
  if (!sourcePresent) return null;
  const receiptPath = join(rewriteFrom, '.home23-install.json');
  if (!exists(receiptPath)) return null;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const rebound = {
    ...receipt, homeRoot: destination, appRoot: join(destination, 'app'),
    nodePath: join(destination, 'bin', 'node'), pm2Path: join(destination, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'), replayed: false,
  };
  writeFileSync(join(destination, '.home23-install.json'), `${JSON.stringify(rebound)}\n`, { mode: 0o600 });
  return rebound.packageId || null;
}

/** Port/path rebind for an adopted destination. Does not copy state or start writers. */
export async function rebindAdoptedHome(source, destination) {
  return rebindDestination(source, destination, { adoptManagedSource: true });
}

/**
 * Finish owner recovery in the same directory Inspect/Restore wrote.
 * Authenticates the archive, locks the destination, refuses unrelated installed or busy
 * homes, binds the destination to that archive in a durable journal, installs a verified
 * compatible runtime, then reuses the move rebind path. Does not run birth or start writers.
 */
export async function recoverInspectedHome({ inspectionRoot, payloadPath, archivePath, keyPath } = {}, dependencies = {}) {
  const destination = absoluteRoot(inspectionRoot, 'inspection directory');
  if (typeof payloadPath !== 'string' || !isAbsolute(payloadPath) || payloadPath.includes('\0')) {
    fail('backup_recover_invalid', 'Choose an absolute compatible payload directory.');
  }
  if (typeof archivePath !== 'string' || !isAbsolute(archivePath) || archivePath.includes('\0')
    || typeof keyPath !== 'string' || !isAbsolute(keyPath) || keyPath.includes('\0')) {
    fail('backup_recover_invalid', 'Recovery requires absolute archive and key paths.');
  }
  const payload = resolve(payloadPath);
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  const header = readAuthenticatedBackupHeader({ archivePath: archive, keyPath: keyFile });
  const binding = archiveBindingFromHeader(header);

  clearOrphanedHostLockMarker(destination);
  const lock = acquireHostLock(destination, { staleMs: dependencies.staleMs });
  if (!lock) fail('backup_lifecycle_busy', 'Another lifecycle operation holds this home. Recovery did not start.');
  lock.hooks = { beforeChunk: dependencies.beforeChunk, onLockRefresh: dependencies.onLockRefresh, refreshMs: dependencies.lockRefreshMs };
  try {
    assertWritersIdle(await inventoryDestinationWriters(destination, dependencies));
    if (retainedAuthorityDependencies(destination).some(item => !item.present)) {
      fail('backup_recover_external_authority_missing', 'A retained external authority is unavailable. Reconnect its exact path before recovery.');
    }

    let journal = readRecoverJournal(destination);
    if (journal) {
      if (!bindingsMatch(journal, binding)) {
        fail('backup_recover_archive_mismatch', 'This inspected home is already bound to a different archive.');
      }
      revalidateRecoveryDestination(destination, header, binding, journal.phase, journal);
    } else {
      revalidateRecoveryDestination(destination, header, binding, 'claimed', null);
    }

    let manifest;
    try { manifest = verifyProductPayload(payload); }
    catch (error) {
      fail('backup_recover_payload_invalid', error?.message || 'Payload is not a compatible Home23 runtime.');
    }
    if (binding.packageId && manifest.packageId !== binding.packageId) {
      fail('backup_recover_package_mismatch', 'Payload packageId does not match the authenticated archive.');
    }
    if (binding.sourceCommit && manifest.sourceCommit !== binding.sourceCommit) {
      fail('backup_recover_package_mismatch', 'Payload sourceCommit does not match the authenticated archive.');
    }

    if (!journal) {
      journal = {
        schema: RECOVER_JOURNAL_SCHEMA,
        inspectionRoot: destination,
        archivePath: archive,
        keyPath: keyFile,
        sourceHome: binding.sourceHome,
        packageId: binding.packageId,
        sourceCommit: binding.sourceCommit,
        filesDigest: binding.filesDigest,
        phase: 'claimed',
      };
      writeRecoverJournal(destination, journal);
      if (dependencies.afterClaim) await dependencies.afterClaim(destination, journal);
    }

    const sourceHome = binding.sourceHome;
    if (journal.phase === 'claimed') {
      assertSafeRuntimeDestination(destination, manifest.files, { payloadRoot: payload });
      const installedId = installMovedRuntime(payload, destination, lock, dependencies);
      if (!installedId || installedId !== manifest.packageId) {
        fail('backup_recover_payload_invalid', 'Compatible runtime was not installed into the inspected home.');
      }
      journal = { ...journal, phase: 'runtime_installed', payloadPath: payload };
      writeRecoverJournal(destination, journal);
      if (dependencies.afterRuntimeInstalled) await dependencies.afterRuntimeInstalled(destination, journal);
    }
    if (journal.phase === 'runtime_installed') {
      if (!journal.rebindPlan || typeof journal.rebindPlan !== 'object') {
        journal = { ...journal, rebindPlan: await prepareRebindPlan(sourceHome, destination) };
        writeRecoverJournal(destination, journal);
      }
      await rebindDestination(sourceHome, destination, {
        plan: journal.rebindPlan,
        afterHostWrite: dependencies.afterHostRebindWrite,
      });
      journal = { ...journal, phase: 'rebound' };
      writeRecoverJournal(destination, journal);
      if (dependencies.afterRebound) await dependencies.afterRebound(destination, journal);
    }
    writeRecoveredInstallReceipt(destination, manifest);
    if (journal.phase !== 'committed') {
      journal = { ...journal, phase: 'committed' };
      writeRecoverJournal(destination, journal);
    }

    const rebound = readHostState(destination);
    if (rebound.homeRoot !== destination) fail('backup_recover_invalid', 'Recovery did not keep the inspected home directory.');
    if (rebound.desiredRunning === true) fail('backup_recover_invalid', 'Recovery must leave the inspected home stopped.');
    if (rebound.phase !== 'stopped') fail('backup_recover_invalid', 'Recovery must leave the inspected home stopped.');
    secureOwnedDestinationRoot(destination);
    return {
      ok: true,
      schema: BACKUP_SCHEMA,
      packageId: manifest.packageId,
      homeRoot: destination,
      sourceHome,
      writersStarted: false,
      restoredRunning: false,
      birthInvoked: false,
      machineBindingsRebound: true,
      desiredRunning: false,
      ports: rebound.ports || null,
      archiveBound: true,
      filesDigest: binding.filesDigest,
    };
  } finally {
    lock.release();
  }
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

function installMovedRuntime(source, destination, lock, dependencies = {}) {
  let manifest;
  try { manifest = readProductManifest(source); }
  catch { return null; }
  assertSafeRuntimeDestination(destination, manifest.files, { payloadRoot: source });
  for (const entry of manifest.files) {
    if (isProductStatePath(entry.path)) continue;
    const from = join(source, entry.path);
    const to = join(destination, entry.path);
    if (!exists(from)) continue;
    const expectedLeaf = entry.type === 'symlink' && lstatSync(from).isSymbolicLink()
      ? readlinkSync(from)
      : expectedPayloadSymlinkTarget(source, entry);
    assertNoSymlinkAncestors(destination, entry.path, { expectedLeafSymlinkTarget: expectedLeaf });
    if (entry.type === 'directory') {
      mkdirSync(to, { recursive: true, mode: entry.mode });
      if (exists(to)) {
        const stat = lstatSync(to);
        if (stat.isDirectory() && !stat.isSymbolicLink()) chmodSync(to, entry.mode);
      }
      continue;
    }
    if (entry.type === 'symlink') {
      mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
      if (exists(to)) unlinkSync(to);
      const target = readlinkSync(from);
      symlinkSync(target, to);
      if (dependencies.afterInstalledSymlink) {
        dependencies.afterInstalledSymlink(destination, entry.path, target);
      }
      continue;
    }
    if (exists(to) && lstatSync(to).isFile() && streamHash(from, lock) === streamHash(to, lock)) {
      if ((lstatSync(to).mode & 0o777) !== entry.mode) chmodSync(to, entry.mode);
      continue;
    }
    copyInstalledFile(from, to, entry.mode, lock);
  }
  assertNoSymlinkAncestors(destination, 'manifest.json');
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
      secureOwnedDestinationRoot(destination);
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
    secureOwnedDestinationRoot(destination);
    return { ok: true, schema: MOVE_FENCE_SCHEMA, packageId, fileCount: Object.keys(identity).length, writersStarted: false, fenced: true, destinationStarted: false, identity, resumed };
  } finally {
    lock.release();
  }
}
