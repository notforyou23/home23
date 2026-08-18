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
const UNFINISHED_STATUS_PATTERN = /\b(?:in[\s-]*progress|incomplete|pending|draft|collecting|partial|still\s+(?:collecting|researching|working)|not\s+(?:started|finished|complete)|to\s+be\s+(?:populated|completed|added)|tbd|todo)\b/i;
const PROGRESS_BASENAME_PATTERN = /(?:^|[-_.])progress(?:[-_.]|$)/i;
const EMPTY_SECTION_PATTERN = /^(?:findings?|results?|evidence|quotes?|sources?)$/i;
const JSON_RESULT_KEY_PATTERN = /^(?:data|entries|evidence|findings?|items|quotes?|records?|results?|sources?)$/i;
const JSON_METADATA_KEY_PATTERN = /^(?:aborted|at|bytes|cancelled|complete|completed|count|createdAt|done|error|failed|failure|fileName|finished|generatedAt|id|name|path|sha256|state|status|success|timestamp|total|updatedAt|valid|verified|version)$/i;

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
  const raw = String(candidatePath || '').trim().replace(/^@/, '').replace(/\\/g, '/').replace(/^outputs\//, '');
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
  if (intentOnly.some(phrase => normalized.includes(phrase) && text.length < 400)) return false;
  if (UNFINISHED_STATUS_PATTERN.test(text)) return false;

  const markdownSections = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
  for (let index = 0; index < markdownSections.length; index += 1) {
    const heading = markdownSections[index][1]
      .replace(/[*_`:#]/g, '')
      .trim();
    if (!EMPTY_SECTION_PATTERN.test(heading)) continue;
    const bodyStart = markdownSections[index].index + markdownSections[index][0].length;
    const bodyEnd = markdownSections[index + 1]?.index ?? text.length;
    const body = text.slice(bodyStart, bodyEnd)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*(?:[-*]\s*)?(?:none|n\/a|pending|not yet)?\s*$/gim, '')
      .trim();
    if (!body) return false;
  }
  return true;
}

function canonicalOutputPath(runtimePath, candidatePath) {
  const target = normalizeOutputPath(runtimePath, candidatePath);
  if (!target) return null;
  return `outputs/${path.relative(path.resolve(runtimePath, 'outputs'), target).split(path.sep).join('/')}`;
}

function expectedOutputPaths(runtimePath, expectedOutput) {
  const candidates = Array.isArray(expectedOutput) ? expectedOutput : [expectedOutput];
  return [...new Set(candidates
    .filter(candidate => typeof candidate === 'string' && candidate.trim())
    .map(candidate => canonicalOutputPath(runtimePath, candidate))
    .filter(Boolean))];
}

function jsonHasFinishedWork(value, key = '') {
  if (Array.isArray(value)) {
    return value.length > 0 && value.some(entry => jsonHasFinishedWork(entry, key));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return false;
    for (const [entryKey, entryValue] of entries) {
      if (/^(?:state|status)$/i.test(entryKey)
          && (UNFINISHED_STATUS_PATTERN.test(String(entryValue || ''))
            || /^(?:error|failed|failure)$/i.test(String(entryValue || '').trim()))) {
        return false;
      }
      if (/^(?:complete|completed|done|finished|success|valid|verified)$/i.test(entryKey)
          && entryValue === false) {
        return false;
      }
      if (/^(?:aborted|cancelled|error|failed|failure)$/i.test(entryKey)
          && ((typeof entryValue === 'boolean' && entryValue)
            || (typeof entryValue === 'string' && entryValue.trim())
            || (Array.isArray(entryValue) && entryValue.length > 0))) {
        return false;
      }
    }
    const resultEntries = entries.filter(([entryKey]) => JSON_RESULT_KEY_PATTERN.test(entryKey));
    if (resultEntries.length > 0
        && !resultEntries.some(([entryKey, entryValue]) => jsonHasFinishedWork(entryValue, entryKey))) {
      return false;
    }
    return entries.some(([entryKey, entryValue]) => {
      if (JSON_METADATA_KEY_PATTERN.test(entryKey)) return false;
      return jsonHasFinishedWork(entryValue, entryKey);
    });
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0
      && !UNFINISHED_STATUS_PATTERN.test(text)
      && !/^(?:none|n\/a|pending|null)$/i.test(text);
  }
  if (typeof value === 'number') return value > 0;
  return value !== null && value !== undefined && value !== false;
}

function validateFinishedReceiptContent(filePath, content) {
  if (PROGRESS_BASENAME_PATTERN.test(path.basename(filePath))) {
    return { accepted: false, reason: 'progress_receipt' };
  }
  const text = String(content || '').trim();
  if (!text) return { accepted: false, reason: 'empty_receipt' };
  if (path.extname(filePath).toLowerCase() === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { accepted: false, reason: 'invalid_json_receipt' };
    }
    return jsonHasFinishedWork(parsed)
      ? { accepted: true, reason: 'finished_json' }
      : { accepted: false, reason: 'unfinished_receipt' };
  }
  if (isWriteupName(filePath)) {
    return isSubstantiveWriteupContent(text)
      ? { accepted: true, reason: 'finished_writeup' }
      : { accepted: false, reason: 'unfinished_receipt' };
  }
  if (UNFINISHED_STATUS_PATTERN.test(text)) {
    return { accepted: false, reason: 'unfinished_receipt' };
  }
  return text.length >= MIN_WRITEUP_CHARS
    ? { accepted: true, reason: 'finished_artifact' }
    : { accepted: false, reason: 'empty_receipt' };
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
    const content = fs.readFileSync(real, 'utf8');
    if (receipt.sha256
        && crypto.createHash('sha256').update(content).digest('hex') !== receipt.sha256) {
      return false;
    }
    return isSubstantiveWriteupContent(content);
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

function phaseArtifactReceipts(runtimePath, provenance = {}) {
  const writeups = readJsonl(path.join(runtimePath, 'outputs', WRITEUP_RECEIPT_BASENAME))
    .filter(receipt => receiptMatchesPhase(receipt, provenance));
  const writes = readJsonl(path.join(runtimePath, 'outputs', 'sources.jsonl'))
    .filter(receipt => receipt.tool === 'write_file')
    .filter(receipt => receiptMatchesPhase(receipt, provenance))
    .map(receipt => ({ ...receipt, path: receipt.path || receipt.query }));
  return [...writeups, ...writes].filter((receipt) => {
    const canonicalPath = canonicalOutputPath(runtimePath, receipt.path);
    return Boolean(canonicalPath);
  }).map(receipt => ({
    ...receipt,
    path: canonicalOutputPath(runtimePath, receipt.path)
  }));
}

function assessPhaseReceipt(runtimePath, expectedOutput, provenance = {}) {
  const expectedPaths = expectedOutputPaths(runtimePath, expectedOutput);
  if (expectedPaths.length === 0) {
    return {
      accepted: false,
      reason: 'missing_expected_output',
      expectedOutput: null,
      path: null
    };
  }
  const receipts = phaseArtifactReceipts(runtimePath, provenance);
  const expectedSet = new Set(expectedPaths);
  const matchingReceipts = receipts.filter(receipt => expectedSet.has(receipt.path));
  if (matchingReceipts.length === 0) {
    return {
      accepted: false,
      reason: receipts.length > 0 ? 'wrong_receipt' : 'missing_receipt',
      expectedOutput: expectedPaths.length === 1 ? expectedPaths[0] : expectedPaths,
      path: null
    };
  }

  let lastFailure = 'missing_receipt';
  for (const receipt of matchingReceipts) {
    const target = normalizeOutputPath(runtimePath, receipt.path);
    try {
      const real = fs.realpathSync(target);
      if (!isInside(path.resolve(runtimePath, 'outputs'), real)) {
        lastFailure = 'outside_outputs';
        continue;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile()) {
        lastFailure = 'missing_receipt_file';
        continue;
      }
      const content = fs.readFileSync(real, 'utf8');
      if (!receipt.sha256) {
        lastFailure = 'unverifiable_receipt';
        continue;
      }
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      if (sha256 !== receipt.sha256) {
        lastFailure = 'receipt_changed';
        continue;
      }
      const validation = validateFinishedReceiptContent(real, content);
      if (!validation.accepted) {
        lastFailure = validation.reason;
        continue;
      }
      return {
        accepted: true,
        reason: validation.reason,
        expectedOutput: expectedPaths.length === 1 ? expectedPaths[0] : expectedPaths,
        path: receipt.path,
        bytes: stat.size,
        sha256
      };
    } catch {
      lastFailure = 'missing_receipt_file';
    }
  }
  return {
    accepted: false,
    reason: lastFailure,
    expectedOutput: expectedPaths.length === 1 ? expectedPaths[0] : expectedPaths,
    path: matchingReceipts[0]?.path || null
  };
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
  phaseArtifactReceipts,
  assessPhaseReceipt,
  recordWriteupReceipt,
  isSubstantiveWriteupContent,
  validateFinishedReceiptContent,
  expectedOutputPaths,
  normalizeOutputPath,
  isHiddenDumpPath,
  phaseHasTape,
  buildHarvestDigest,
  isProductDrillRunning,
  shouldHonorLeftoverEngineLimits,
  readPersistedNotes
};
