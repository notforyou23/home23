'use strict';

/**
 * Phase-close and leftover-limit law for a product drill.
 *
 * Tape is evidence of work. It is not a writeup. A phase closes only when
 * a durable markdown writeup exists under the run's outputs/. Hidden /tmp
 * dumps never count. While the drill is running, leftover engine
 * maxCycles/maxRuntime must not stop the process — the drill owns cycles
 * and time.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { RESEARCH_PRODUCT_LOOP } = require('../../../lib/research-launch');

const WRITEUP_EXTENSIONS = new Set(['.md', '.markdown']);
const SKIP_OUTPUT_DIRS = new Set(['candidates']);
const TAPE_BASENAMES = new Set(['stream.jsonl', 'sources.jsonl']);
const WRITEUP_RECEIPT_BASENAME = 'writeups.jsonl';
const HARVEST_DIGEST_KINDS = new Set(['harvest', 'finding', 'thought', 'writeup']);
const DEFAULT_DIGEST_LIMIT = 8;
const DEFAULT_DIGEST_CHARS = 1200;
const MIN_WRITEUP_CHARS = 20;

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWriteupName(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  return WRITEUP_EXTENSIONS.has(ext);
}

function normalizeOutputPath(runtimePath, candidatePath) {
  const outputsRoot = path.resolve(runtimePath, 'outputs');
  const raw = String(candidatePath || '').replace(/\\/g, '/').replace(/^outputs\//, '');
  const target = path.resolve(outputsRoot, raw);
  return isInside(outputsRoot, target) ? target : null;
}

function isSubstantiveWriteupContent(content) {
  const text = String(content || '').trim();
  if (text.length < MIN_WRITEUP_CHARS) return false;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const normalized = text.toLowerCase();
  const intentOnly = [
    'i will write',
    'writing now',
    'i am going to write',
    'next i will write',
    'let me write'
  ];
  return !intentOnly.some(phrase => normalized.includes(phrase) && text.length < 400);
}

function isHiddenDumpPath(filePath, runtimePath = null) {
  const resolved = path.resolve(String(filePath || ''));
  if (runtimePath) {
    const outputsRoot = path.resolve(runtimePath, 'outputs');
    if (isInside(outputsRoot, resolved)) return false;
  }
  if (resolved.startsWith('/tmp/') || resolved === '/tmp') return true;
  if (resolved.startsWith('/var/tmp/') || resolved === '/var/tmp') return true;
  return false;
}

/**
 * Durable writeups on disk under outputs/. Tapes, findings journals, and
 * anything outside outputs/ (including /tmp) are never writeups.
 */
function listWriteups(runtimePath) {
  const outputsRoot = path.resolve(runtimePath, 'outputs');
  const found = [];
  if (!runtimePath || !fs.existsSync(outputsRoot)) return found;

  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_OUTPUT_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (TAPE_BASENAMES.has(entry.name)) continue;
      if (!isWriteupName(entry.name)) continue;
      if (isHiddenDumpPath(full, runtimePath)) continue;
      try {
        const real = fs.realpathSync(full);
        if (!isInside(outputsRoot, real)) continue;
        if (!fs.statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      found.push(path.relative(path.resolve(runtimePath), full).split(path.sep).join('/'));
    }
  };

  walk(outputsRoot);
  return found;
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function receiptMatchesPhase(receipt, provenance = {}) {
  if (provenance.goalNumber != null && receipt.goalNumber !== provenance.goalNumber) return false;
  if (provenance.phaseNumber != null && receipt.phaseNumber !== provenance.phaseNumber) return false;
  return true;
}

function validateReceiptFile(runtimePath, receipt) {
  const target = normalizeOutputPath(runtimePath, receipt?.path);
  if (!target || !isWriteupName(target)) return false;
  try {
    const real = fs.realpathSync(target);
    if (!isInside(path.resolve(runtimePath, 'outputs'), real)) return false;
    if (!fs.statSync(real).isFile()) return false;
    return isSubstantiveWriteupContent(fs.readFileSync(real, 'utf8'));
  } catch {
    return false;
  }
}

function phaseWriteupReceipts(runtimePath, provenance = {}) {
  const receipts = readJsonl(path.join(runtimePath, 'outputs', WRITEUP_RECEIPT_BASENAME))
    .filter(receipt => receiptMatchesPhase(receipt, provenance));

  // Compatibility with earlier drill tapes: write_file source receipts carry
  // the same phase provenance and output path even before writeups.jsonl.
  const legacy = readJsonl(path.join(runtimePath, 'outputs', 'sources.jsonl'))
    .filter(receipt => receipt.tool === 'write_file')
    .filter(receipt => receiptMatchesPhase(receipt, provenance))
    .map(receipt => ({ ...receipt, path: receipt.path || receipt.query }));
  const seen = new Set();
  return [...receipts, ...legacy].filter(receipt => {
    if (!validateReceiptFile(runtimePath, receipt)) return false;
    const key = `${receipt.goalNumber ?? ''}:${receipt.phaseNumber ?? ''}:${receipt.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recordWriteupReceipt(runtimePath, relativePath, provenance = {}, content = '') {
  if (!isWriteupName(relativePath) || !isSubstantiveWriteupContent(content)) {
    return { recorded: false, reason: 'not_substantive_markdown' };
  }
  const target = normalizeOutputPath(runtimePath, relativePath);
  if (!target) return { recorded: false, reason: 'outside_outputs' };
  const entry = {
    at: Date.now(),
    path: `outputs/${path.relative(path.resolve(runtimePath, 'outputs'), target).split(path.sep).join('/')}`,
    bytes: Buffer.byteLength(String(content), 'utf8'),
    sha256: crypto.createHash('sha256').update(String(content)).digest('hex'),
    ...provenance
  };
  await fsp.mkdir(path.join(runtimePath, 'outputs'), { recursive: true });
  await fsp.appendFile(
    path.join(runtimePath, 'outputs', WRITEUP_RECEIPT_BASENAME),
    `${JSON.stringify(entry)}\n`
  );
  return { recorded: true, entry };
}

function hasPhaseWriteup(runtimePath, provenance = null) {
  if (provenance && (provenance.goalNumber != null || provenance.phaseNumber != null)) {
    return phaseWriteupReceipts(runtimePath, provenance).length > 0;
  }
  return listWriteups(runtimePath).some((relativePath) => {
    const target = path.join(runtimePath, relativePath);
    try {
      return isSubstantiveWriteupContent(fs.readFileSync(target, 'utf8'));
    } catch {
      return false;
    }
  });
}

function phaseHasTape(phase, runtimePath, provenance = {}) {
  if ((Number(phase?.evidence?.streamed) || 0) > 0) return true;
  try {
    const rows = fs.readFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return rows.some((row) => {
      if (provenance.goalNumber != null && row.goalNumber !== provenance.goalNumber) return false;
      if (provenance.phaseNumber != null && row.phaseNumber !== provenance.phaseNumber) return false;
      return HARVEST_DIGEST_KINDS.has(row.kind);
    });
  } catch {
    return false;
  }
}

/**
 * Short harvest digest from this phase's stream — enough for WRITE FIRST,
 * not a dump of the tape.
 */
function buildHarvestDigest(runtimePath, provenance = {}, options = {}) {
  const limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : DEFAULT_DIGEST_LIMIT;
  const maxChars = Number(options.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : DEFAULT_DIGEST_CHARS;
  let raw;
  try {
    raw = fs.readFileSync(path.join(runtimePath, 'outputs', 'stream.jsonl'), 'utf8');
  } catch {
    return '';
  }
  const rows = raw.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).filter((row) => {
    if (!HARVEST_DIGEST_KINDS.has(row.kind)) return false;
    if (provenance.goalNumber != null && row.goalNumber !== provenance.goalNumber) return false;
    if (provenance.phaseNumber != null && row.phaseNumber !== provenance.phaseNumber) return false;
    return Boolean(row.content);
  }).slice(-limit);

  if (rows.length === 0) return '';
  const lines = rows.map((row) => `- [${row.kind}] ${String(row.content).replace(/\s+/g, ' ').slice(0, 160)}`);
  const digest = lines.join('\n');
  return digest.length > maxChars ? `${digest.slice(0, maxChars)}…` : digest;
}

/**
 * A product drill owns cycles and time while it is running. Leftover
 * engine maxCycles/maxRuntime must not stop that process.
 */
function isProductDrillRunning(orchestrator) {
  const loop = orchestrator?.launchLoop;
  if (!loop) return false;
  if (loop.productLoop !== RESEARCH_PRODUCT_LOOP) return false;
  if (loop.running !== true) return false;
  return typeof loop.budgetExhaustedReason === 'function';
}

function shouldHonorLeftoverEngineLimits(orchestrator) {
  return !isProductDrillRunning(orchestrator);
}

async function readPersistedNotes(notesPath) {
  let raw;
  try {
    raw = await fsp.readFile(notesPath, 'utf8');
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((note) => note?.text);
}

module.exports = {
  WRITEUP_EXTENSIONS,
  WRITEUP_RECEIPT_BASENAME,
  MIN_WRITEUP_CHARS,
  listWriteups,
  hasPhaseWriteup,
  phaseWriteupReceipts,
  recordWriteupReceipt,
  isSubstantiveWriteupContent,
  normalizeOutputPath,
  isHiddenDumpPath,
  phaseHasTape,
  buildHarvestDigest,
  isProductDrillRunning,
  shouldHonorLeftoverEngineLimits,
  readPersistedNotes
};
