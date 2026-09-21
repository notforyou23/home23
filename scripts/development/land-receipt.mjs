#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA_PREFIX = /^[a-f0-9]{7,40}$/;
const RELEASE_ID = /^[a-f0-9]{40}$/;
const REPOSITORIES = new Set(['home23', 'home23-apple']);
const SCRIPT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LEDGER_ENV = 'HOME23_LAND_RECEIPT_LEDGER';

function lineError(lineNumber, message) {
  throw new Error(`Malformed land-receipt ledger line ${lineNumber}: ${message}`);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function nonemptyLine(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\r\n]/.test(value);
}

function validateRecord(record, lineNumber) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) lineError(lineNumber, 'expected a JSON object');
  if (record.schemaVersion !== 1) lineError(lineNumber, 'unsupported schemaVersion');
  if (!isIsoTimestamp(record.recordedAt)) lineError(lineNumber, 'recordedAt must be an ISO timestamp');
  if (!FULL_SHA.test(record.commit || '')) lineError(lineNumber, 'commit must be a full 40-character SHA');

  if (record.recordType === 'deployment') {
    if (!RELEASE_ID.test(record.releaseId || '')) lineError(lineNumber, 'releaseId must be a 40-character content hash');
    return 'deployment';
  }
  if (record.recordType !== undefined) lineError(lineNumber, `unsupported recordType ${JSON.stringify(record.recordType)}`);
  if (!REPOSITORIES.has(record.repo)) lineError(lineNumber, 'repo must be home23 or home23-apple');
  if (!nonemptyLine(record.branch)) lineError(lineNumber, 'branch must be a nonempty line');
  if (!nonemptyLine(record.summary)) lineError(lineNumber, 'summary must be one nonempty line');
  if (!nonemptyLine(record.verification)) lineError(lineNumber, 'verification must be one nonempty line');
  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0 || record.surfaces.some(surface => !nonemptyLine(surface))) {
    lineError(lineNumber, 'surfaces must contain at least one nonempty name');
  }
  if (record.deployed !== false || record.deployedReleaseId !== null || record.deployedAt !== null) {
    lineError(lineNumber, 'a land receipt must begin undeployed with null deployment fields');
  }
  if (!nonemptyLine(record.recordedBy)) lineError(lineNumber, 'recordedBy must be one nonempty line');
  return 'land';
}

export function parseLandReceiptLedger(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (!line) lineError(lineNumber, 'blank lines are not allowed');
    let record;
    try { record = JSON.parse(line); }
    catch { lineError(lineNumber, 'invalid JSON'); }
    validateRecord(record, lineNumber);
    return record;
  });
}

export function foldLandReceipts(records) {
  const byCommit = new Map();
  records.forEach((record, index) => {
    const lineNumber = index + 1;
    const type = validateRecord(record, lineNumber);
    if (type === 'land') {
      if (byCommit.has(record.commit)) lineError(lineNumber, `commit ${record.commit} already has a land receipt`);
      byCommit.set(record.commit, { ...record, surfaces: [...record.surfaces] });
      return;
    }
    const receipt = byCommit.get(record.commit);
    if (!receipt) lineError(lineNumber, `deployment for ${record.commit} has no prior land receipt`);
    receipt.deployed = true;
    receipt.deployedReleaseId = record.releaseId;
    receipt.deployedAt = record.recordedAt;
  });
  return [...byCommit.values()];
}

export function loadLandReceipts(ledgerPath = defaultLedgerPath()) {
  let bytes;
  try { bytes = fs.readFileSync(ledgerPath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`ledger file does not exist: ${ledgerPath}`);
    throw new Error(`cannot read ledger ${ledgerPath}: ${error.message}`);
  }
  return foldLandReceipts(parseLandReceiptLedger(bytes));
}

function assertLedgerDirectory(ledgerPath) {
  const directory = path.dirname(ledgerPath);
  let stat;
  try { stat = fs.statSync(directory); }
  catch { throw new Error(`ledger directory does not exist: ${directory}`); }
  if (!stat.isDirectory()) throw new Error(`ledger directory is not a directory: ${directory}`);
}

function appendRecord(ledgerPath, record) {
  let separator = '';
  if (fs.existsSync(ledgerPath)) {
    const stat = fs.lstatSync(ledgerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`ledger is not a regular file: ${ledgerPath}`);
    if (stat.size > 0) {
      const descriptor = fs.openSync(ledgerPath, 'r'), finalByte = Buffer.alloc(1);
      try { fs.readSync(descriptor, finalByte, 0, 1, stat.size - 1); }
      finally { fs.closeSync(descriptor); }
      if (finalByte[0] !== 0x0a) separator = '\n';
    }
  }
  const bytes = Buffer.from(`${separator}${JSON.stringify(record)}\n`);
  const descriptor = fs.openSync(ledgerPath, 'a+', 0o644);
  try {
    const before = fs.fstatSync(descriptor).size;
    const written = fs.writeSync(descriptor, bytes, 0, bytes.length);
    if (written !== bytes.length) throw new Error(`short ledger append: wrote ${written} of ${bytes.length} bytes`);
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const tail = Buffer.alloc(bytes.length);
    if (after.size !== before + bytes.length || fs.readSync(descriptor, tail, 0, tail.length, after.size - tail.length) !== tail.length
        || !tail.equals(bytes)) throw new Error('ledger append readback failed');
  } finally { fs.closeSync(descriptor); }
  return record;
}

function git(repoRoot, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// The ledger is private workspace state shared by every checkout and task
// worktree: <workspace>/verification/land-receipts.jsonl, where <workspace>
// contains the backend repository's main checkout. It is never tracked source.
export function defaultLedgerPath(repoRoot = SCRIPT_REPO_ROOT, env = process.env) {
  const override = env[LEDGER_ENV];
  if (override) {
    if (!path.isAbsolute(override)) throw new Error(`${LEDGER_ENV} must be an absolute path`);
    return override;
  }
  let common;
  try { common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']); }
  catch { throw new Error(`Cannot locate the ledger: ${repoRoot} is not a Git checkout`); }
  return path.join(path.dirname(path.dirname(common)), 'verification', 'land-receipts.jsonl');
}

function fullCommit(repoRoot, commit) {
  const candidate = String(commit || '').toLowerCase();
  if (!SHA_PREFIX.test(candidate)) throw new Error(`Commit ${String(commit)} does not exist in the repository`);
  try {
    git(repoRoot, ['cat-file', '-e', `${candidate}^{commit}`]);
    return git(repoRoot, ['rev-parse', '--verify', `${candidate}^{commit}`]);
  }
  catch { throw new Error(`Commit ${candidate} does not exist in the repository`); }
}

function repositoryIdentity(repoRoot) {
  let common;
  try { common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']); }
  catch { throw new Error(`Cannot inspect Git repository ${repoRoot}`); }
  const repo = path.basename(path.dirname(common));
  if (!REPOSITORIES.has(repo)) throw new Error(`Unsupported repository ${repo || '(unknown)'}`);
  const branch = git(repoRoot, ['branch', '--show-current']);
  if (!branch) throw new Error('Cannot record a land receipt from a detached HEAD because its branch is unknown');
  return { repo, branch };
}

function assertCommitOnBranch(repoRoot, commit, branch) {
  try { git(repoRoot, ['merge-base', '--is-ancestor', commit, 'HEAD']); }
  catch { throw new Error(`Commit ${commit} is not reachable from branch ${branch}`); }
}

function withLedgerWriteLock(ledgerPath, operation) {
  assertLedgerDirectory(ledgerPath);
  const lockPath = `${ledgerPath}.lock.sqlite3`;
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const database = new Database(lockPath, { timeout: 10_000 });
  try {
    database.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY)');
    database.exec('BEGIN EXCLUSIVE');
    return operation();
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
  }
}

function recordedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('Cannot record an invalid timestamp');
  return date.toISOString();
}

function validateInputLine(value, name) {
  if (!nonemptyLine(value)) throw new Error(`${name} must be one nonempty line`);
  return value;
}

export function recordLandReceipt({
  repoRoot,
  ledgerPath = defaultLedgerPath(),
  commit,
  summary,
  verification,
  surfaces,
  recordedBy,
  now = () => new Date(),
}) {
  repoRoot = fs.realpathSync(repoRoot);
  const resolved = fullCommit(repoRoot, commit);
  const identity = repositoryIdentity(repoRoot);
  assertCommitOnBranch(repoRoot, resolved, identity.branch);
  if (!Array.isArray(surfaces) || surfaces.length === 0) throw new Error('surfaces must contain at least one name');
  const receipt = {
    schemaVersion: 1,
    recordedAt: recordedAt(now),
    commit: resolved,
    ...identity,
    summary: validateInputLine(summary, 'summary'),
    verification: validateInputLine(verification, 'verification'),
    surfaces: surfaces.map(surface => validateInputLine(surface, 'surface')),
    deployed: false,
    deployedReleaseId: null,
    deployedAt: null,
    recordedBy: validateInputLine(recordedBy, 'recorded-by'),
  };
  return withLedgerWriteLock(ledgerPath, () => {
    const existing = fs.existsSync(ledgerPath) ? loadLandReceipts(ledgerPath) : [];
    if (existing.some(value => value.commit === resolved)) throw new Error(`Commit ${resolved} already has a land receipt`);
    validateRecord(receipt, existing.length + 1);
    return appendRecord(ledgerPath, receipt);
  });
}

function receiptCommit(receipts, commit) {
  const candidate = String(commit || '').toLowerCase();
  if (!SHA_PREFIX.test(candidate)) throw new Error('commit must be a 7- to 40-character hexadecimal SHA');
  const matches = receipts.filter(receipt => receipt.commit.startsWith(candidate));
  if (matches.length === 0) throw new Error(`No prior land receipt exists for commit ${candidate}`);
  if (matches.length > 1) throw new Error(`Commit prefix ${candidate} matches multiple land receipts`);
  return matches[0].commit;
}

export function recordDeployment({ ledgerPath = defaultLedgerPath(), commit, releaseId, now = () => new Date() }) {
  if (!RELEASE_ID.test(releaseId || '')) throw new Error('release must be a 40-character lowercase hexadecimal releaseId');
  return withLedgerWriteLock(ledgerPath, () => {
    const receipts = loadLandReceipts(ledgerPath);
    const record = {
      schemaVersion: 1,
      recordType: 'deployment',
      recordedAt: recordedAt(now),
      commit: receiptCommit(receipts, commit),
      releaseId,
    };
    validateRecord(record, receipts.length + 1);
    return appendRecord(ledgerPath, record);
  });
}

function gitRoot(cwd) {
  try { return git(cwd, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error(`Cannot find a Git checkout from ${cwd}`); }
}

function options(args, required) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!required.includes(flag) || value === undefined || value.startsWith('--') || Object.hasOwn(parsed, flag)) {
      throw new Error(`Invalid or duplicate option ${flag || '(missing)'}`);
    }
    parsed[flag] = value;
  }
  for (const flag of required) if (!Object.hasOwn(parsed, flag)) throw new Error(`Missing required option ${flag}`);
  return parsed;
}

function printJson(write, value) {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

export function runLandReceiptCommand(argv, {
  repoRoot,
  ledgerPath,
  now = () => new Date(),
  stdout = value => process.stdout.write(value),
  stderr = value => process.stderr.write(value),
  cwd = process.cwd(),
} = {}) {
  try {
    ledgerPath ??= defaultLedgerPath();
    const [command, ...args] = argv;
    if (command === 'record') {
      const parsed = options(args, ['--commit', '--summary', '--verification', '--surfaces', '--recorded-by']);
      const surfaces = parsed['--surfaces'].split(',');
      if (surfaces.some(surface => !surface.trim() || surface !== surface.trim())) throw new Error('surfaces must be comma-separated nonempty names without surrounding whitespace');
      printJson(stdout, recordLandReceipt({
        repoRoot: repoRoot ?? gitRoot(cwd),
        ledgerPath,
        commit: parsed['--commit'],
        summary: parsed['--summary'],
        verification: parsed['--verification'],
        surfaces,
        recordedBy: parsed['--recorded-by'],
        now,
      }));
      return 0;
    }
    if (command === 'land') {
      const parsed = options(args, ['--commit', '--release']);
      printJson(stdout, recordDeployment({ ledgerPath, commit: parsed['--commit'], releaseId: parsed['--release'], now }));
      return 0;
    }
    if (command === 'list') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--undeployed')) throw new Error('Usage: land-receipt.mjs list [--undeployed]');
      const receipts = loadLandReceipts(ledgerPath);
      printJson(stdout, args[0] === '--undeployed' ? receipts.filter(receipt => !receipt.deployed) : receipts);
      return 0;
    }
    if (command === 'check') {
      if (args.length) throw new Error('Usage: land-receipt.mjs check');
      const undeployed = loadLandReceipts(ledgerPath).filter(receipt => !receipt.deployed);
      printJson(stdout, undeployed);
      return undeployed.length ? 3 : 0;
    }
    throw new Error('Usage: land-receipt.mjs record|land|list|check');
  } catch (error) {
    stderr(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = runLandReceiptCommand(process.argv.slice(2));
}
