'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomBytes } = require('crypto');

const LIFECYCLE_HOOK_NAMES = [
  'afterTempCreated',
  'afterWrite',
  'afterFileSync',
  'beforeRename',
  'afterRename',
  'afterDirectorySync',
  'beforeAppend',
  'afterAppend',
];

function byteLength(content, encoding = 'utf8') {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), encoding);
}

function temporaryPathFor(filePath) {
  const suffix = randomBytes(16).toString('hex');
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${suffix}`);
}

function collectLifecycleHooks(source, target) {
  if (!source || typeof source !== 'object') return;
  if (source.hooks && typeof source.hooks === 'object') Object.assign(target, source.hooks);
  if (source.lifecycle && typeof source.lifecycle === 'object') Object.assign(target, source.lifecycle);
  if (typeof source.onLifecycle === 'function') target.onLifecycle = source.onLifecycle;
  for (const name of LIFECYCLE_HOOK_NAMES) {
    if (typeof source[name] === 'function') target[name] = source[name];
  }
}

function normalizeWriteOptions(options, extraLifecycle) {
  const hooks = {};
  collectLifecycleHooks(options, hooks);
  collectLifecycleHooks(extraLifecycle, hooks);

  if (typeof options === 'string') {
    return { encoding: options, fsOptions: options, hooks };
  }

  const fsOptions = options && typeof options === 'object' ? { ...options } : {};
  delete fsOptions.hooks;
  delete fsOptions.lifecycle;
  delete fsOptions.onLifecycle;
  const strictDirectorySync = fsOptions.strictDirectorySync === true;
  delete fsOptions.strictDirectorySync;
  for (const name of LIFECYCLE_HOOK_NAMES) delete fsOptions[name];

  return {
    encoding: fsOptions.encoding || 'utf8',
    fsOptions,
    hooks,
    strictDirectorySync,
  };
}

function normalizeLifecycleOptions(options) {
  const hooks = {};
  collectLifecycleHooks(options, hooks);
  return hooks;
}

function callSyncHook(hooks, name, context) {
  const calls = [];
  if (typeof hooks.onLifecycle === 'function') {
    calls.push(() => hooks.onLifecycle(name, context));
  }
  if (typeof hooks[name] === 'function') {
    calls.push(() => hooks[name](context));
  }
  for (const call of calls) {
    const result = call();
    if (result && typeof result.then === 'function') {
      // Prevent an async hook's rejected promise from becoming unhandled. The
      // synchronous writer cannot safely continue while such a hook is pending.
      result.catch(() => {});
      throw new TypeError(`${name} must be synchronous when used with a synchronous durable-write API`);
    }
  }
}

async function callAsyncHook(hooks, name, context) {
  if (typeof hooks.onLifecycle === 'function') {
    await hooks.onLifecycle(name, context);
  }
  if (typeof hooks[name] === 'function') {
    await hooks[name](context);
  }
}

function fsyncDirectorySync(dirPath, options = {}) {
  let dirFd = null;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(dirFd);
    return true;
  } catch (error) {
    if (options.strict) throw error;
    return false;
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch {}
    }
  }
}

async function fsyncDirectory(dirPath, options = {}) {
  let handle = null;
  try {
    handle = await fsp.open(dirPath, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (options.strict) throw error;
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

function buildReceipt(filePath, bytes, fileSynced, directorySynced) {
  const stat = fs.statSync(filePath);
  const verified = stat.isFile() && stat.size === bytes;
  if (!verified) {
    throw new Error(`durable write verification failed for ${filePath}: expected ${bytes} bytes, saw ${stat.size}`);
  }
  return {
    path: filePath,
    bytes: stat.size,
    exists: true,
    fileSynced,
    directorySynced,
    verified,
  };
}

function writeFileDurableSync(filePath, content, options = 'utf8', lifecycle = null) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const normalized = normalizeWriteOptions(options, lifecycle);
  const bytes = byteLength(content, normalized.encoding);
  const tmpPath = temporaryPathFor(filePath);
  const context = { filePath, temporaryPath: tmpPath, bytes };
  let fd = null;
  let renamed = false;
  try {
    const mode = typeof normalized.fsOptions === 'object' ? normalized.fsOptions.mode : undefined;
    fd = fs.openSync(tmpPath, 'wx', mode);
    callSyncHook(normalized.hooks, 'afterTempCreated', context);
    fs.writeFileSync(fd, content, normalized.fsOptions);
    callSyncHook(normalized.hooks, 'afterWrite', context);
    fs.fsyncSync(fd);
    callSyncHook(normalized.hooks, 'afterFileSync', context);
    fs.closeSync(fd);
    fd = null;
    callSyncHook(normalized.hooks, 'beforeRename', context);
    fs.renameSync(tmpPath, filePath);
    renamed = true;
    callSyncHook(normalized.hooks, 'afterRename', context);
    const directorySynced = fsyncDirectorySync(dir, { strict: normalized.strictDirectorySync });
    callSyncHook(normalized.hooks, 'afterDirectorySync', { ...context, directorySynced });
    return buildReceipt(filePath, bytes, true, directorySynced);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!renamed) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

function verifyJsonlTailSync(filePath, line, bytes) {
  const stat = fs.statSync(filePath);
  const readLength = Math.min(stat.size, bytes);
  const verifyFd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readLength);
    fs.readSync(verifyFd, buffer, 0, readLength, stat.size - readLength);
    if (buffer.toString('utf8') !== line) {
      throw new Error(`durable JSONL append verification failed for ${filePath}`);
    }
  } finally {
    fs.closeSync(verifyFd);
  }
  return stat;
}

function appendJsonlDurableSync(filePath, obj, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const hooks = normalizeLifecycleOptions(options);
  const line = `${JSON.stringify(obj)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  const context = { filePath, bytes, value: obj };
  let fd = null;
  try {
    callSyncHook(hooks, 'beforeAppend', context);
    fd = fs.openSync(filePath, 'a+');
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    const stat = verifyJsonlTailSync(filePath, line, bytes);
    const directorySynced = fsyncDirectorySync(dir, { strict: options.strictDirectorySync === true });
    const receipt = {
      path: filePath,
      bytesWritten: bytes,
      size: stat.size,
      fileSynced: true,
      directorySynced,
      verified: true,
    };
    callSyncHook(hooks, 'afterAppend', { ...context, receipt });
    return receipt;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

async function writeFileDurable(filePath, content, options = 'utf8', lifecycle = null) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const normalized = normalizeWriteOptions(options, lifecycle);
  const bytes = byteLength(content, normalized.encoding);
  const tmpPath = temporaryPathFor(filePath);
  const context = { filePath, temporaryPath: tmpPath, bytes };
  let handle = null;
  let renamed = false;
  try {
    const mode = typeof normalized.fsOptions === 'object' ? normalized.fsOptions.mode : undefined;
    handle = await fsp.open(tmpPath, 'wx', mode);
    await callAsyncHook(normalized.hooks, 'afterTempCreated', context);
    await handle.writeFile(content, normalized.fsOptions);
    await callAsyncHook(normalized.hooks, 'afterWrite', context);
    await handle.sync();
    await callAsyncHook(normalized.hooks, 'afterFileSync', context);
    await handle.close();
    handle = null;
    await callAsyncHook(normalized.hooks, 'beforeRename', context);
    await fsp.rename(tmpPath, filePath);
    renamed = true;
    await callAsyncHook(normalized.hooks, 'afterRename', context);
    const directorySynced = await fsyncDirectory(dir, { strict: normalized.strictDirectorySync });
    await callAsyncHook(normalized.hooks, 'afterDirectorySync', { ...context, directorySynced });
    return buildReceipt(filePath, bytes, true, directorySynced);
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    if (!renamed) {
      try { await fsp.unlink(tmpPath); } catch {}
    }
  }
}

async function verifyJsonlTail(filePath, line, bytes) {
  const stat = await fsp.stat(filePath);
  const readLength = Math.min(stat.size, bytes);
  const verifyHandle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readLength);
    await verifyHandle.read(buffer, 0, readLength, stat.size - readLength);
    if (buffer.toString('utf8') !== line) {
      throw new Error(`durable JSONL append verification failed for ${filePath}`);
    }
  } finally {
    await verifyHandle.close();
  }
  return stat;
}

async function appendJsonlDurable(filePath, obj, options = {}) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const hooks = normalizeLifecycleOptions(options);
  const line = `${JSON.stringify(obj)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  const context = { filePath, bytes, value: obj };
  let handle = null;
  try {
    await callAsyncHook(hooks, 'beforeAppend', context);
    handle = await fsp.open(filePath, 'a+');
    await handle.writeFile(line, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    const stat = await verifyJsonlTail(filePath, line, bytes);
    const directorySynced = await fsyncDirectory(dir, { strict: options.strictDirectorySync === true });
    const receipt = {
      path: filePath,
      bytesWritten: bytes,
      size: stat.size,
      fileSynced: true,
      directorySynced,
      verified: true,
    };
    await callAsyncHook(hooks, 'afterAppend', { ...context, receipt });
    return receipt;
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

module.exports = {
  appendJsonlDurable,
  appendJsonlDurableSync,
  fsyncDirectory,
  fsyncDirectorySync,
  writeFileDurable,
  writeFileDurableSync,
};
