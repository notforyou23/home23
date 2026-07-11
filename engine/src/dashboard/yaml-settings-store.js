'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const properLockfile = require('proper-lockfile');
const {
  countYamlCommentLines,
  makeBackupPath,
} = require('./yaml-write-safety.js');

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function versionOf(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function deepClone(value) {
  return structuredClone(value);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertConfinedRegularPath(home23Root, filePath, { optional = false } = {}) {
  const lexicalHome = path.resolve(home23Root);
  const lexicalFile = path.resolve(filePath);
  const relative = path.relative(lexicalHome, lexicalFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw typed('settings_path_invalid', 'settings path must be beneath Home23');
  }
  const canonicalHome = await fsp.realpath(home23Root);
  const absolute = path.join(canonicalHome, relative);
  const components = relative.split(path.sep);
  let cursor = canonicalHome;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT' && optional && index === components.length - 1) {
        return { canonicalHome, absolute, exists: false };
      }
      throw typed('settings_path_invalid', 'settings path is missing or unstable');
    }
    if (stat.isSymbolicLink()) {
      throw typed('settings_path_invalid', 'settings path must not contain symbolic links');
    }
    const leaf = index === components.length - 1;
    if ((!leaf && !stat.isDirectory()) || (leaf && !stat.isFile())) {
      throw typed('settings_path_invalid', 'settings path has an invalid file type');
    }
  }
  return { canonicalHome, absolute, exists: true };
}

async function ensurePrivateDirectory(parent, name) {
  const target = path.join(parent, name);
  try {
    await fsp.mkdir(target, { mode: 0o700 });
    await fsyncDirectory(parent);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw typed('settings_path_invalid', 'settings lock path is invalid');
  }
  return target;
}

function createYamlSettingsStore({
  home23Root,
  filePath,
  yaml,
  logger = console,
  crashInjector = null,
  lineWidth = 120,
} = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)
      || typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || !yaml || typeof yaml.load !== 'function' || typeof yaml.dump !== 'function') {
    throw typed('settings_configuration_invalid', 'valid settings-store dependencies required');
  }

  const absentBytes = Buffer.from(yaml.dump({}, { lineWidth }), 'utf8');

  async function readCurrent() {
    const validated = await assertConfinedRegularPath(home23Root, filePath, { optional: true });
    const bytes = validated.exists ? await fsp.readFile(validated.absolute) : absentBytes;
    let data;
    try { data = yaml.load(bytes.toString('utf8')) || {}; } catch (error) {
      throw Object.assign(typed('settings_invalid', 'settings YAML is invalid'), { cause: error });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw typed('settings_invalid', 'settings YAML root must be an object');
    }
    return {
      ...validated,
      bytes,
      data,
      version: versionOf(bytes),
    };
  }

  async function createLockAnchor() {
    const canonicalHome = await fsp.realpath(home23Root);
    const runtime = await ensurePrivateDirectory(canonicalHome, 'runtime');
    const locks = await ensurePrivateDirectory(runtime, 'settings-locks');
    const digest = crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
    const anchor = path.join(locks, `${digest}.anchor`);
    let handle = null;
    try {
      handle = await fsp.open(
        anchor,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      await handle.writeFile(`${path.resolve(filePath)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsyncDirectory(locks);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fsp.lstat(anchor);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw typed('settings_path_invalid', 'settings lock anchor is invalid');
    }
    return anchor;
  }

  async function withLock(callback) {
    const anchor = await createLockAnchor();
    const release = await properLockfile.lock(anchor, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 200, factor: 1.1, minTimeout: 5, maxTimeout: 50 },
    });
    try { return await callback(); } finally { await release(); }
  }

  async function read() {
    const current = await readCurrent();
    return Object.freeze({ data: deepClone(current.data), version: current.version });
  }

  async function update({ expectedVersion, mutate } = {}) {
    if (expectedVersion !== undefined && typeof expectedVersion !== 'string') {
      throw typed('invalid_request', 'expectedVersion must be a string');
    }
    if (typeof mutate !== 'function') throw typed('invalid_request', 'settings mutate callback required');
    return withLock(async () => {
      const current = await readCurrent();
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw typed('settings_changed', 'settings changed before update', true);
      }
      const draft = deepClone(current.data);
      const replacement = await mutate(draft);
      const nextData = replacement === undefined ? draft : replacement;
      if (!nextData || typeof nextData !== 'object' || Array.isArray(nextData)) {
        throw typed('settings_invalid', 'settings mutation must return an object');
      }
      const output = yaml.dump(nextData, { lineWidth });
      const outputBytes = Buffer.from(output, 'utf8');
      let backupPath = null;
      const commentLines = current.exists
        ? countYamlCommentLines(current.bytes.toString('utf8'))
        : 0;
      if (commentLines > 0) {
        backupPath = makeBackupPath(filePath, { rootDir: current.canonicalHome });
        await fsp.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
        await fsp.writeFile(backupPath, current.bytes, { mode: 0o600 });
        logger.warn?.('[yaml-settings-store] preserving commented YAML before rewrite', {
          filePath,
          backupPath,
          commentLines,
        });
      }

      const parent = path.dirname(current.absolute);
      const temporary = path.join(
        parent,
        `.${path.basename(current.absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      let handle = null;
      let renamed = false;
      try {
        handle = await fsp.open(
          temporary,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        await handle.writeFile(outputBytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await crashInjector?.('beforeRename', { filePath: current.absolute, temporary });
        await fsp.rename(temporary, current.absolute);
        renamed = true;
        await crashInjector?.('afterRenameBeforeDirectoryFsync', { filePath: current.absolute });
        await fsyncDirectory(parent);
      } finally {
        await handle?.close().catch(() => {});
        if (!renamed) await fsp.rm(temporary, { force: true }).catch(() => {});
      }
      return Object.freeze({
        data: deepClone(nextData),
        version: versionOf(outputBytes),
        commentsDetected: commentLines > 0,
        commentLines,
        backupPath,
      });
    });
  }

  return Object.freeze({ read, update });
}

module.exports = {
  assertConfinedRegularPath,
  createYamlSettingsStore,
  versionOf,
};
