'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { dirname } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createGzip, gzipSync } = require('node:zlib');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_KEEP = 3;

function normalizeRotationOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  return {
    enabled: options.enabled !== false,
    maxBytes: Number.isFinite(options.maxBytes) && options.maxBytes >= 1
      ? Math.floor(options.maxBytes) : DEFAULT_MAX_BYTES,
    keep: Number.isInteger(options.keep) && options.keep > 0 ? options.keep : DEFAULT_KEEP,
  };
}

function removeIfPresent(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publishSegment(file, temporary, keep) {
  removeIfPresent(`${file}.${keep}.gz`);
  for (let index = keep - 1; index >= 1; index -= 1) {
    try { fs.renameSync(`${file}.${index}.gz`, `${file}.${index + 1}.gz`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.renameSync(temporary, `${file}.1.gz`);
  // Make the archive's name durable before emptying the active file.
  // A failed compression, publication or directory sync leaves it intact.
  const directory = fs.openSync(dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  const active = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(active, 0);
    fs.fsyncSync(active);
  } finally { fs.closeSync(active); }
}

function needsRotation(file, options, incomingBytes) {
  if (!options.enabled) return false;
  let size;
  try { size = fs.statSync(file).size; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return size > 0 && size + incomingBytes > options.maxBytes;
}

async function rotateJsonl(file, options, incomingBytes = 0) {
  if (!needsRotation(file, options, incomingBytes)) return false;
  const temporary = `${file}.rotation-${randomUUID()}.tmp`;
  try {
    await pipeline(fs.createReadStream(file), createGzip(), fs.createWriteStream(temporary, { flags: 'wx' }));
    const handle = await fsp.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    publishSegment(file, temporary, options.keep);
    return true;
  } finally {
    removeIfPresent(temporary);
  }
}

function rotateJsonlSync(file, options, incomingBytes = 0) {
  if (!needsRotation(file, options, incomingBytes)) return false;
  const temporary = `${file}.rotation-${randomUUID()}.tmp`;
  let input;
  let output;
  try {
    input = fs.openSync(file, 'r');
    output = fs.openSync(temporary, 'wx');
    const chunk = Buffer.alloc(1024 * 1024);
    let bytes;
    // Concatenated gzip members let the synchronous append path compress
    // arbitrarily large existing inboxes without loading them into memory.
    while ((bytes = fs.readSync(input, chunk, 0, chunk.length, null)) > 0) {
      const compressed = gzipSync(chunk.subarray(0, bytes));
      let offset = 0;
      while (offset < compressed.length) {
        offset += fs.writeSync(output, compressed, offset, compressed.length - offset);
      }
    }
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = undefined;
    fs.closeSync(input);
    input = undefined;
    publishSegment(file, temporary, options.keep);
    return true;
  } finally {
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    removeIfPresent(temporary);
  }
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_KEEP, normalizeRotationOptions, rotateJsonl, rotateJsonlSync };
