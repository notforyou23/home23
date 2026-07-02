'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function byteLength(content, encoding = 'utf8') {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content), encoding);
}

function fsyncDirectorySync(dirPath) {
  let dirFd = null;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(dirFd);
    return true;
  } catch {
    return false;
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch {}
    }
  }
}

async function fsyncDirectory(dirPath) {
  let handle = null;
  try {
    handle = await fsp.open(dirPath, 'r');
    await handle.sync();
    return true;
  } catch {
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

function writeFileDurableSync(filePath, content, options = 'utf8') {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
  const bytes = byteLength(content, encoding);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, options);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
    const directorySynced = fsyncDirectorySync(dir);
    return buildReceipt(filePath, bytes, true, directorySynced);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function appendJsonlDurableSync(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(obj)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'a+');
    fs.writeSync(fd, line, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

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

    return {
      path: filePath,
      bytesWritten: bytes,
      size: stat.size,
      fileSynced: true,
      verified: true,
    };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    throw err;
  }
}

async function writeFileDurable(filePath, content, options = 'utf8') {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const encoding = typeof options === 'string' ? options : options?.encoding || 'utf8';
  const bytes = byteLength(content, encoding);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let handle = null;
  try {
    handle = await fsp.open(tmpPath, 'w');
    await handle.writeFile(content, options);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmpPath, filePath);
    const directorySynced = await fsyncDirectory(dir);
    return buildReceipt(filePath, bytes, true, directorySynced);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch {}
    }
    try { await fsp.unlink(tmpPath); } catch {}
    throw err;
  }
}

module.exports = {
  appendJsonlDurableSync,
  writeFileDurable,
  writeFileDurableSync,
};
