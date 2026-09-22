/** Encrypted home-state backup and inspection. Does not start writers or mutate the source home. */
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
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { PRODUCT_STATE_PATHS } from './product-payload.js';
import { hashFile, isRebuildableStatePath, SUPPORTED_COORDINATION_SCHEMA } from './product-update-inventory.js';

const BACKUP_SCHEMA = 'home23.backup.v1';
const KEY_SCHEMA = 'home23.backup-key.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const HOST_SCHEMAS = new Set(['home23.host.v1', 'home23.host.v2']);
const MAGIC = Buffer.from('H23B', 'ascii');
const COORDINATION_DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const TYPE_FILE = 1;
const TYPE_SYMLINK = 2;

const exists = file => {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const inside = (root, target) => target === root || target.startsWith(root + sep);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

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
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`Choose an absolute ${label}.`);
  }
  const root = resolve(value);
  realDirectory(root);
  if (!exists(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${root}`);
  }
  return root;
}

function assertOutsideHome(homeRoot, candidate, label) {
  const resolved = resolve(candidate);
  if (inside(homeRoot, resolved)) fail('backup_path_invalid', `${label} must not be inside the home.`);
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
    return JSON.parse(readFileSync(hostPath, 'utf8'));
  } catch (error) {
    if (error.code === 'backup_host_unreadable') throw error;
    fail('backup_host_unreadable', 'Home host state is unreadable.');
  }
}

function assertQuiesced(homeRoot) {
  const host = readHostState(homeRoot);
  if (HOST_SCHEMAS.has(host?.schema) && host.desiredRunning === true) {
    fail('backup_requires_quiesce', 'Stop this home before creating a backup.');
  }
  return host;
}

function installIdentity(homeRoot) {
  const receiptPath = join(homeRoot, '.home23-install.json');
  if (!exists(receiptPath)) return { packageId: null, sourceCommit: null };
  try {
    const stat = lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { packageId: null, sourceCommit: null };
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt?.schema !== INSTALL_SCHEMA || receipt.status !== 'installed' ||
        typeof receipt.packageId !== 'string' || typeof receipt.sourceCommit !== 'string') {
      return { packageId: null, sourceCommit: null };
    }
    return { packageId: receipt.packageId, sourceCommit: receipt.sourceCommit };
  } catch {
    return { packageId: null, sourceCommit: null };
  }
}

function omitSidecar(relative) {
  return relative === `${COORDINATION_DATABASE}-wal` || relative === `${COORDINATION_DATABASE}-shm` ||
    relative.endsWith('.sqlite3-wal') || relative.endsWith('.sqlite3-shm');
}

function assertSymlinkInside(homeRoot, relative) {
  const file = join(homeRoot, relative);
  const target = readlinkSync(file);
  if (typeof target !== 'string' || target.includes('\0')) {
    throw new Error(`Unsafe symlink: ${relative}`);
  }
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

async function consistentDatabaseCopy(homeRoot, temporaryPath) {
  const sourcePath = join(homeRoot, COORDINATION_DATABASE);
  const { DatabaseSync } = await import('node:sqlite');
  const source = new DatabaseSync(sourcePath);
  try {
    // Prefer the online backup API when present; Node 22.19 exposes VACUUM INTO only.
    if (typeof source.backup === 'function') {
      const task = source.backup(temporaryPath);
      if (task && typeof task.then === 'function') await task;
      else if (task?.completed && typeof task.completed.then === 'function') await task.completed;
    } else {
      source.exec(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`);
    }
  } finally {
    source.close();
  }
  return readFileSync(temporaryPath);
}

async function collectStateFiles(homeRoot, archiveParent) {
  const collected = [];
  const seen = new Set();
  let temporaryDatabase = null;

  async function addRecord(relative, type, bytes) {
    if (seen.has(relative) || isRebuildableStatePath(relative) || omitSidecar(relative)) return;
    seen.add(relative);
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    collected.push({
      path: relative,
      type,
      bytes: buffer.length,
      sha256: sha256(buffer),
      content: buffer,
    });
  }

  async function visit(relative) {
    if (!relative || seen.has(relative) || isRebuildableStatePath(relative) || omitSidecar(relative)) return;
    const absolute = join(homeRoot, relative);
    if (!exists(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = assertSymlinkInside(homeRoot, relative);
      await addRecord(relative, 'symlink', Buffer.from(target, 'utf8'));
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) await visit(`${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) return;
    if (relative === COORDINATION_DATABASE) {
      temporaryDatabase = join(archiveParent, `.home23-backup-${randomUUID()}.sqlite3`);
      const copy = await consistentDatabaseCopy(homeRoot, temporaryDatabase);
      await addRecord(relative, 'file', copy);
      return;
    }
    await addRecord(relative, 'file', readFileSync(absolute));
  }

  for (const entry of PRODUCT_STATE_PATHS) {
    if (!exists(join(homeRoot, entry.path))) continue;
    await visit(entry.path);
    if (entry.allowDescendants) {
      const nestedRoot = join(homeRoot, entry.path);
      // Rare: a declared file path that is actually a directory of descendants.
      if (exists(nestedRoot) && lstatSync(nestedRoot).isDirectory() && !lstatSync(nestedRoot).isSymbolicLink()) {
        for (const name of readdirSync(nestedRoot).sort()) await visit(`${entry.path}/${name}`);
      }
    }
  }

  return { collected, temporaryDatabase };
}

function encodePayload(records) {
  const parts = [];
  for (const record of records) {
    const pathBytes = Buffer.from(record.path, 'utf8');
    const header = Buffer.alloc(4 + pathBytes.length + 1 + 8);
    let offset = 0;
    header.writeUInt32BE(pathBytes.length, offset); offset += 4;
    pathBytes.copy(header, offset); offset += pathBytes.length;
    header.writeUInt8(record.type === 'symlink' ? TYPE_SYMLINK : TYPE_FILE, offset); offset += 1;
    const size = record.content.length;
    header.writeUInt32BE(Math.floor(size / 2 ** 32), offset); offset += 4;
    header.writeUInt32BE(size >>> 0, offset);
    parts.push(header, record.content);
  }
  return Buffer.concat(parts);
}

function decodePayload(buffer) {
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('Truncated backup payload.');
    const pathLength = buffer.readUInt32BE(offset); offset += 4;
    if (offset + pathLength + 1 + 8 > buffer.length) throw new Error('Truncated backup payload.');
    const pathText = buffer.subarray(offset, offset + pathLength).toString('utf8'); offset += pathLength;
    const typeCode = buffer.readUInt8(offset); offset += 1;
    const high = buffer.readUInt32BE(offset); offset += 4;
    const low = buffer.readUInt32BE(offset); offset += 4;
    const size = high * 2 ** 32 + low;
    if (offset + size > buffer.length) throw new Error('Truncated backup payload.');
    const content = Buffer.from(buffer.subarray(offset, offset + size)); offset += size;
    if (typeCode !== TYPE_FILE && typeCode !== TYPE_SYMLINK) throw new Error('Unknown backup record type.');
    records.push({ path: pathText, type: typeCode === TYPE_SYMLINK ? 'symlink' : 'file', content });
  }
  return records;
}

function durableWrite(file, data, mode) {
  const fd = openSync(file, 'wx', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function emptyDirectory(directory) {
  for (const name of readdirSync(directory)) {
    rmSync(join(directory, name), { recursive: true, force: true });
  }
}

function machineReconnect() {
  return {
    kind: 'machine-bindings',
    required: true,
    message: 'Ports, supervisor registration, and absolute machine paths have to be rebound before this home runs.',
  };
}

function credentialReconnect() {
  return {
    kind: 'provider-credentials',
    required: false,
    transferred: true,
    message: 'Provider credentials were inside the encrypted archive. They still need a reachable provider endpoint.',
  };
}

export async function createHomeBackup({ homeRoot, archivePath, keyPath }) {
  const root = absoluteRoot(homeRoot, 'home directory');
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || !isAbsolute(archivePath) || !isAbsolute(keyPath)) {
    throw new Error('Archive and key paths must be absolute.');
  }
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  assertOutsideHome(root, archive, 'Archive');
  assertOutsideHome(root, keyFile, 'Key');
  realDirectory(dirname(archive));
  realDirectory(dirname(keyFile));
  if (!exists(dirname(archive)) || !lstatSync(dirname(archive)).isDirectory()) throw new Error(`Expected a real directory: ${dirname(archive)}`);
  if (!exists(dirname(keyFile)) || !lstatSync(dirname(keyFile)).isDirectory()) throw new Error(`Expected a real directory: ${dirname(keyFile)}`);
  assertAbsentPath(archive, 'Archive');
  assertAbsentPath(keyFile, 'Key');
  assertQuiesced(root);

  const identity = installIdentity(root);
  const { collected, temporaryDatabase } = await collectStateFiles(root, dirname(archive));
  try {
    const plaintext = encodePayload(collected);
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = {
      schema: BACKUP_SCHEMA,
      homeRoot: root,
      packageId: identity.packageId,
      sourceCommit: identity.sourceCommit,
      recipeId: null,
      createdAt: new Date().toISOString(),
      coordinationSchema: exists(join(root, COORDINATION_DATABASE)) ? SUPPORTED_COORDINATION_SCHEMA : null,
      files: collected.map(({ path, sha256: digest, bytes, type }) => ({ path, sha256: digest, bytes, type })),
      encrypted: { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length, 0);
    const archiveBytes = Buffer.concat([MAGIC, length, headerBytes, ciphertext]);

    durableWrite(keyFile, `${JSON.stringify({
      schema: KEY_SCHEMA,
      algorithm: 'aes-256-gcm',
      key: key.toString('base64'),
    }, null, 2)}\n`, 0o600);
    durableWrite(archive, archiveBytes, 0o600);

    return {
      ok: true,
      schema: BACKUP_SCHEMA,
      packageId: identity.packageId,
      fileCount: collected.length,
      archivePath: archive,
      keyPath: keyFile,
      writersStarted: false,
    };
  } finally {
    if (temporaryDatabase && exists(temporaryDatabase)) {
      try { unlinkSync(temporaryDatabase); } catch { /* best-effort temp cleanup */ }
    }
  }
}

export async function inspectHomeBackup({ archivePath, keyPath, inspectionRoot }) {
  if (typeof archivePath !== 'string' || typeof keyPath !== 'string' || typeof inspectionRoot !== 'string' ||
      !isAbsolute(archivePath) || !isAbsolute(keyPath) || !isAbsolute(inspectionRoot)) {
    throw new Error('Archive, key, and inspection paths must be absolute.');
  }
  const archive = resolve(archivePath);
  const keyFile = resolve(keyPath);
  const root = absoluteRoot(inspectionRoot, 'inspection directory');
  if (readdirSync(root).length !== 0) throw new Error('Inspection directory must be empty.');

  let wrote = false;
  try {
    const keyDocument = JSON.parse(readFileSync(keyFile, 'utf8'));
    if (keyDocument?.schema !== KEY_SCHEMA || keyDocument.algorithm !== 'aes-256-gcm' || typeof keyDocument.key !== 'string') {
      throw new Error('Backup key is invalid.');
    }
    const key = Buffer.from(keyDocument.key, 'base64');
    if (key.length !== 32) throw new Error('Backup key is invalid.');

    const bytes = readFileSync(archive);
    if (bytes.length < 8 || bytes.subarray(0, 4).toString('ascii') !== 'H23B') throw new Error('Not a Home23 backup archive.');
    const headerLength = bytes.readUInt32BE(4);
    if (bytes.length < 8 + headerLength) throw new Error('Truncated backup archive.');
    const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8'));
    if (header?.schema !== BACKUP_SCHEMA || !header.encrypted || header.encrypted.algorithm !== 'aes-256-gcm') {
      throw new Error('Backup header is invalid.');
    }
    if (resolve(header.homeRoot || '') === root) throw new Error('Inspection directory must not be the backed-up home.');
    const ciphertext = bytes.subarray(8 + headerLength);
    if (!ciphertext.length && header.files?.length) throw new Error('Truncated backup archive.');

    const iv = Buffer.from(header.encrypted.iv, 'base64');
    const tag = Buffer.from(header.encrypted.tag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Backup decryption failed.');
    }

    const records = decodePayload(plaintext);
    if (!Array.isArray(header.files) || header.files.length !== records.length) throw new Error('Backup file inventory mismatch.');
    const byPath = new Map(header.files.map(entry => [entry.path, entry]));
    for (const record of records) {
      const expected = byPath.get(record.path);
      if (!expected || expected.type !== record.type || expected.bytes !== record.content.length) {
        throw new Error(`Backup record mismatch: ${record.path}`);
      }
      if (sha256(record.content) !== expected.sha256) throw new Error(`Backup digest mismatch: ${record.path}`);
    }

    for (const record of records) {
      const destination = join(root, record.path);
      if (!inside(root, destination)) throw new Error(`Backup path escapes inspection root: ${record.path}`);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      if (record.type === 'symlink') {
        symlinkSync(record.content.toString('utf8'), destination);
      } else {
        writeFileSync(destination, record.content, { mode: 0o600, flag: 'wx' });
      }
      wrote = true;
      const actual = record.type === 'symlink'
        ? sha256(Buffer.from(readlinkSync(destination), 'utf8'))
        : hashFile(destination);
      if (actual !== byPath.get(record.path).sha256) throw new Error(`Restored digest mismatch: ${record.path}`);
    }

    const reconnects = [machineReconnect()];
    if (byPath.has('app/config/secrets.yaml')) reconnects.push(credentialReconnect());
    return {
      ok: true,
      schema: BACKUP_SCHEMA,
      packageId: header.packageId ?? null,
      fileCount: records.length,
      writersStarted: false,
      reconnects,
    };
  } catch (error) {
    if (wrote || readdirSync(root).length) emptyDirectory(root);
    throw error;
  }
}
