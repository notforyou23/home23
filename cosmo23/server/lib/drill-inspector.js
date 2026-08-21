'use strict';

/**
 * Read-only inspection helpers for the drill control center.
 *
 * Disk is the tape. These helpers expose the existing run files and JSONL
 * tapes without creating another store and without opening the rest of the
 * run (config, secrets, snapshots) to the browser.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ALLOWED_ROOTS = Object.freeze(['outputs', 'drill']);
const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_PREVIEW_BYTES = 512 * 1024;
const DEFAULT_TAPE_WINDOW_BYTES = 32 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml',
  '.js', '.cjs', '.mjs', '.ts', '.py', '.html', '.css', '.xml', '.log'
]);

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeRelativePath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) {
    const error = new Error('A run-relative file path is required.');
    error.code = 'invalid_path';
    throw error;
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    const error = new Error('Path traversal is not allowed.');
    error.code = 'invalid_path';
    throw error;
  }
  if (!ALLOWED_ROOTS.includes(segments[0])) {
    const error = new Error(`Files are limited to ${ALLOWED_ROOTS.join('/ and ')}/.`);
    error.code = 'invalid_path';
    throw error;
  }
  return segments.join('/');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function classifyDrillFile(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (normalized === 'outputs/stream.jsonl') return 'brain_tape';
  if (normalized === 'outputs/sources.jsonl') return 'source_tape';
  if (normalized === 'outputs/candidates/findings.jsonl') return 'findings';
  if (normalized.startsWith('drill/') && ext === '.jsonl') return 'drill_tape';
  if (normalized.startsWith('drill/')) return 'drill_state';
  if (ext === '.md') return 'writeup';
  if (['.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml'].includes(ext)) return 'data';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (basename.endsWith('.pyc')) return 'compiled';
  return 'artifact';
}

function isPreviewable(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || !ext;
}

async function resolveAllowedFile(runPath, requested) {
  const relativePath = normalizeRelativePath(requested);
  const runRoot = path.resolve(runPath);
  const rootName = relativePath.split('/')[0];
  const allowedRoot = path.resolve(runRoot, rootName);
  const target = path.resolve(runRoot, relativePath);
  if (!isInside(allowedRoot, target)) {
    const error = new Error('Path is outside the allowed run files.');
    error.code = 'invalid_path';
    throw error;
  }

  // realpath closes the symlink-escape hole left by a lexical prefix check.
  const [realRoot, realTarget] = await Promise.all([
    fsp.realpath(allowedRoot),
    fsp.realpath(target)
  ]);
  if (!isInside(realRoot, realTarget)) {
    const error = new Error('Symlink target is outside the allowed run files.');
    error.code = 'invalid_path';
    throw error;
  }

  return { relativePath, target: realTarget };
}

async function listDrillFiles(runPath, options = {}) {
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 2000);
  const maxDepth = clampInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 1, 16);
  const files = [];
  let truncated = false;

  async function walk(rootName, dir, depth) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (!entry || entry.name === '.DS_Store' || entry.name.startsWith('.git')) continue;
      // Never follow symlinks: the inspector is a run-local, read-only view.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(rootName, full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      const relativePath = path.relative(path.resolve(runPath), full).replace(/\\/g, '/');
      files.push({
        path: relativePath,
        name: entry.name,
        directory: path.posix.dirname(relativePath),
        root: rootName,
        extension: path.extname(entry.name).toLowerCase(),
        kind: classifyDrillFile(relativePath),
        previewable: isPreviewable(relativePath),
        size: stat.size,
        modified: stat.mtimeMs
      });
    }
  }

  for (const rootName of ALLOWED_ROOTS) {
    await walk(rootName, path.resolve(runPath, rootName), 0);
  }

  files.sort((left, right) => {
    if (right.modified !== left.modified) return right.modified - left.modified;
    return left.path.localeCompare(right.path);
  });
  const counts = files.reduce((acc, file) => {
    acc[file.kind] = (acc[file.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    files,
    truncated,
    roots: [...ALLOWED_ROOTS],
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    counts
  };
}

async function readDrillFile(runPath, requested, options = {}) {
  const maxBytes = clampInteger(options.maxBytes, DEFAULT_PREVIEW_BYTES, 1024, 2 * 1024 * 1024);
  const { relativePath, target } = await resolveAllowedFile(runPath, requested);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    const error = new Error('Requested path is not a file.');
    error.code = 'not_file';
    throw error;
  }

  const previewable = isPreviewable(relativePath);
  if (!previewable) {
    return {
      path: relativePath,
      name: path.basename(relativePath),
      kind: classifyDrillFile(relativePath),
      size: stat.size,
      modified: stat.mtimeMs,
      previewable: false,
      truncated: false,
      content: null
    };
  }

  const bytesToRead = Math.min(stat.size, maxBytes);
  const handle = await fsp.open(target, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(bytesToRead);
    if (bytesToRead > 0) await handle.read(buffer, 0, bytesToRead, 0);
  } finally {
    await handle.close();
  }

  return {
    path: relativePath,
    name: path.basename(relativePath),
    kind: classifyDrillFile(relativePath),
    size: stat.size,
    modified: stat.mtimeMs,
    previewable: true,
    truncated: stat.size > bytesToRead,
    content: buffer.toString('utf8')
  };
}

async function readJsonlTape(runPath, channel, options = {}) {
  const channels = {
    stream: path.join('outputs', 'stream.jsonl'),
    sources: path.join('outputs', 'sources.jsonl')
  };
  if (!channels[channel]) {
    const error = new Error('Tape channel must be stream or sources.');
    error.code = 'invalid_channel';
    throw error;
  }

  const limit = clampInteger(options.limit, 100, 1, 200);
  const before = Number(options.before);
  const hasBefore = Number.isFinite(before) && before > 0;
  const file = path.join(runPath, channels[channel]);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        entries: [],
        totalMatching: 0,
        nextBefore: null,
        hasMore: false,
        historyLimited: false
      };
    }
    throw error;
  }

  const maxWindowBytes = clampInteger(
    options.maxWindowBytes,
    DEFAULT_TAPE_WINDOW_BYTES,
    64 * 1024,
    64 * 1024 * 1024
  );
  const start = Math.max(0, stat.size - maxWindowBytes);
  const length = stat.size - start;
  const handle = await fsp.open(file, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }
  const kind = String(options.kind || '').trim();
  const tool = String(options.tool || '').trim();
  const workerId = String(options.workerId || '').trim();
  const search = String(options.search || '').trim().toLowerCase();
  const goalNumber = Number(options.goalNumber);
  const phaseNumber = Number(options.phaseNumber);

  const matching = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Number(row.at) || 0;
    if (hasBefore && at >= before) continue;
    if (kind && row.kind !== kind) continue;
    if (tool && row.tool !== tool) continue;
    if (workerId && row.workerId !== workerId) continue;
    if (Number.isFinite(goalNumber) && goalNumber > 0 && Number(row.goalNumber) !== goalNumber) continue;
    if (Number.isFinite(phaseNumber) && phaseNumber > 0 && Number(row.phaseNumber) !== phaseNumber) continue;
    if (search && !JSON.stringify(row).toLowerCase().includes(search)) continue;
    matching.push(row);
  }
  if (channel === 'stream' && matching.length > 0) {
    try {
      const ackRows = (await fsp.readFile(path.join(runPath, 'outputs', 'stream-brain.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(row => row?.id && row.brain === 'live');
      const liveIds = new Set(ackRows.map(row => row.id));
      for (const row of matching) {
        if (row.id && liveIds.has(row.id)) row.brain = 'live';
      }
    } catch { /* pre-ack tapes remain honestly journaled */ }
  }
  matching.sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0));
  const entries = matching.slice(0, limit);
  const nextBefore = entries.length > 0 ? Number(entries[entries.length - 1].at) || null : null;

  return {
    entries,
    totalMatching: matching.length,
    nextBefore,
    hasMore: matching.length > limit || start > 0,
    historyLimited: start > 0
  };
}

module.exports = {
  ALLOWED_ROOTS,
  DEFAULT_PREVIEW_BYTES,
  classifyDrillFile,
  listDrillFiles,
  normalizeRelativePath,
  readDrillFile,
  readJsonlTape,
  resolveAllowedFile
};
