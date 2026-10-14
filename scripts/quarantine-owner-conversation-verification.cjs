#!/usr/bin/env node
'use strict';

/**
 * Reclassify retrieval verification records without deleting their content.
 *
 * Usage:
 *   node scripts/quarantine-owner-conversation-verification.cjs <ledger-or-brain-dir> --dry-run --since 2026-10-14
 *   node scripts/quarantine-owner-conversation-verification.cjs <ledger-file> --apply --since 2026-10-14
 *
 * Default: dry-run. Supported JSON stores are relationship-ledger.json
 * (entries) and memory-objects.json (objects). A brain directory must contain
 * exactly one supported store; otherwise select each ledger file explicitly.
 * Apply obtains the writers' proper-lockfile lock, backs up the exact original
 * bytes to an exclusive timestamped sibling (0600), then atomically replaces
 * the ledger. Active readers may need to reload the store independently.
 * No runtime, graph, service, or process is discovered or modified.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');
const { classifyOwnerConversation } = require('../shared/owner-conversation-policy.cjs');

const SCHEMA = 'home23.owner-conversation-verification-quarantine.v1';
const SUPPORTED_FILES = ['relationship-ledger.json', 'memory-objects.json'];
const USAGE = 'Usage: node scripts/quarantine-owner-conversation-verification.cjs <ledger-or-brain-dir> [--dry-run | --apply] [--since YYYY-MM-DD|ISO-timestamp]';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function sinceTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$)/.test(value)) {
    throw new Error('Invalid --since: use YYYY-MM-DD or an ISO timestamp with a timezone');
  }
  const day = value.slice(0, 10);
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(ms) || !Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid --since date');
  }
  return ms;
}

function parseArguments(args) {
  let inputPath;
  let since;
  let selectedMode;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--apply') {
      if (selectedMode) throw new Error('Use only one --dry-run or --apply flag');
      selectedMode = arg;
    } else if (arg === '--since') {
      if (since !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid --since argument');
      since = args[++index];
      sinceTimestamp(since);
    } else if (arg.startsWith('-')) throw new Error('Unknown argument flag');
    else if (inputPath) throw new Error('A single ledger or brain path is required');
    else inputPath = arg;
  }
  if (!inputPath) throw new Error(USAGE);
  return { inputPath, dryRun: selectedMode !== '--apply', ...(since !== undefined ? { since } : {}) };
}

function resolveLedger(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('A ledger or brain path is required');
  let selected = path.resolve(inputPath);
  const stat = fs.lstatSync(selected);
  if (stat.isSymbolicLink()) throw new Error('Ledger input must not be a symbolic link');
  if (stat.isDirectory()) {
    const candidates = SUPPORTED_FILES.map(name => path.join(selected, name)).filter(candidate => fs.existsSync(candidate));
    if (candidates.length > 1) throw new Error('Ambiguous brain directory: supply an explicit ledger file path');
    if (candidates.length !== 1) throw new Error('Unsupported brain directory: no supported ledger file');
    selected = candidates[0];
  } else if (!stat.isFile()) throw new Error('Ledger input must be a regular file or brain directory');
  // Canonicalize the parent without following a symbolic-link ledger itself.
  return path.join(fs.realpathSync(path.dirname(selected)), path.basename(selected));
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].map(String).join(':');
}

function readSnapshot(ledgerPath) {
  const bound = fs.lstatSync(ledgerPath, { bigint: true });
  if (!bound.isFile() || bound.isSymbolicLink()) throw new Error('Ledger must be a regular nonsymbolic file');
  if (bound.nlink !== 1n) throw new Error('Ledger hard links are unsupported');
  const fd = fs.openSync(ledgerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (statIdentity(before) !== statIdentity(bound)) throw new Error('Ledger source changed before read');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (statIdentity(after) !== statIdentity(before) || BigInt(bytes.length) !== before.size) throw new Error('Ledger source changed during read');
    return { bytes, stat: before };
  } finally { fs.closeSync(fd); }
}

function parseDocument(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Invalid ledger UTF-8');
  let document;
  // Never forward JSON.parse's error: it can contain private source content.
  try { document = JSON.parse(text); } catch { throw new Error('Invalid ledger JSON'); }
  if (!object(document)) throw new Error('Unsupported ledger document');
  if (Object.hasOwn(document, 'entries') && Object.hasOwn(document, 'objects')) throw new Error('Ambiguous ledger document');
  const key = Object.hasOwn(document, 'entries') ? 'entries' : Object.hasOwn(document, 'objects') ? 'objects' : null;
  if (!key || !Array.isArray(document[key])) throw new Error('Unsupported ledger: entries or objects must be an array');
  for (const entry of document[key]) {
    const id = key === 'entries' ? entry?.id : entry?.memory_id;
    if (!object(entry) || typeof id !== 'string' || !id || !object(entry.provenance)
      || typeof entry.provenance.generation_method !== 'string') throw new Error('Invalid ledger record shape');
  }
  return { document, key, store: key === 'entries' ? 'relationship-ledger' : 'memory-objects' };
}

function lastObservedTimestamp(entry) {
  const raw = entry.semantic_time ?? entry.occurredAt ?? entry.occurred_at
    ?? entry.updatedAt ?? entry.updated_at ?? entry.createdAt ?? entry.created_at;
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) throw new Error('Owner conversation candidate has an invalid timestamp for --since');
  return ms;
}

function classificationInput(entry) {
  const metadata = object(entry.metadata) ? entry.metadata : {};
  const evidence = object(entry.evidence) ? entry.evidence : {};
  const sources = [entry, metadata, entry.provenance];
  const stringList = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string');
  const sessionRefs = sources.flatMap(source => [
    source.chatId, source.chat_id, source.sessionId, source.session_id,
    ...stringList(source.sessionRefs), ...stringList(source.session_refs),
    ...stringList(source.sessionIds), ...stringList(source.session_ids),
    ...stringList(source.chatIds), ...stringList(source.chat_ids),
  ]).filter(value => typeof value === 'string');
  const sourceRefs = sources.flatMap(source => [
    ...stringList(source.sourceRefs), ...stringList(source.source_refs),
  ]).concat(stringList(evidence.evidence_links), stringList(evidence.evidenceLinks));
  return {
    ...entry,
    chatId: entry.chatId ?? entry.chat_id ?? metadata.chatId ?? metadata.chat_id,
    sessionId: entry.sessionId ?? entry.session_id ?? metadata.sessionId ?? metadata.session_id,
    sessionRefs,
    sourceRefs,
    text: [entry.title, entry.statement, entry.summary, entry.evidence_note, evidence.grounding_note, evidence.groundingNote]
      .filter(value => typeof value === 'string').join('\n'),
    metadata: entry.metadata,
    provenance: entry.provenance,
  };
}

function planDocument(parsed, sinceMs) {
  const counts = {
    scanned: parsed.document[parsed.key].length, ownerCandidates: 0, inWindow: 0,
    classified: { substantive: 0, verification: 0, recap: 0, mention: 0 },
    exclusions: 0, applied: 0, alreadyExcluded: 0, skippedBeforeSince: 0, skipped: 0,
  };
  const records = parsed.document[parsed.key].map(entry => {
    if (entry.provenance.generation_method !== 'owner_conversation') {
      if (entry.provenance.verification === true && entry.provenance.owner_evidence === false) counts.alreadyExcluded++;
      return entry;
    }
    counts.ownerCandidates++;
    if (sinceMs !== null && lastObservedTimestamp(entry) < sinceMs) { counts.skippedBeforeSince++; return entry; }
    counts.inWindow++;
    const classification = classifyOwnerConversation(classificationInput(entry));
    counts.classified[classification.kind]++;
    if (classification.kind !== 'verification') return entry;
    counts.exclusions++;
    return { ...entry, provenance: {
      ...entry.provenance, generation_method: 'agent_note', verification: true,
      owner_evidence: false, source_class: 'verification', conversation_kind: classification.kind,
      classification_reasons: classification.reasons,
    } };
  });
  counts.skipped = counts.scanned - counts.exclusions;
  return { counts, document: { ...parsed.document, [parsed.key]: records } };
}

function assertUnchanged(ledgerPath, snapshot) {
  const current = readSnapshot(ledgerPath);
  if (statIdentity(current.stat) !== statIdentity(snapshot.stat) || !current.bytes.equals(snapshot.bytes)) {
    throw new Error('Ledger source changed; refusing replacement');
  }
}

function directoryBinding(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Ledger directory changed');
  return { directory, dev: stat.dev, ino: stat.ino };
}

function assertDirectory(binding) {
  const actual = directoryBinding(binding.directory);
  if (actual.dev !== binding.dev || actual.ino !== binding.ino) throw new Error('Ledger directory changed');
}

function createBackup(ledgerPath, bytes, now, directoryFd) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  for (let suffix = 0; suffix < 1000; suffix++) {
    const backupPath = `${ledgerPath}.backup-${stamp}${suffix ? `-${suffix}` : ''}`;
    let fd;
    try { fd = fs.openSync(backupPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') continue; throw new Error('Could not create exclusive ledger backup'); }
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      // Read back the durable copy before the source can be replaced.
      const readback = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < readback.length) {
        const read = fs.readSync(fd, readback, offset, readback.length - offset, offset);
        if (!read) throw new Error('Ledger backup readback was incomplete');
        offset += read;
      }
      if (fs.fstatSync(fd).size !== bytes.length || !readback.equals(bytes)) throw new Error('Ledger backup readback mismatch');
    } finally { fs.closeSync(fd); }
    fs.fsyncSync(directoryFd);
    return backupPath;
  }
  throw new Error('Ledger backup timestamp collision limit exceeded');
}

function quarantineOwnerConversationLedger({ inputPath, dryRun = true, since, now = new Date().toISOString(), hooks = {} } = {}) {
  const sinceMs = since === undefined ? null : sinceTimestamp(since);
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid backup timestamp');
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error('Ledger cleanup requires O_NOFOLLOW support');
  const ledgerPath = resolveLedger(inputPath);
  // Fail before lockfile resolves any unsupported symbolic or hard link.
  readSnapshot(ledgerPath);
  let release;
  if (!dryRun) {
    try { release = lockfile.lockSync(ledgerPath, { stale: 30_000, update: 5_000, retries: 0 }); }
    catch { throw new Error('Could not lock ledger; another writer may be active'); }
  }
  let tempPath;
  let directoryFd;
  try {
    const snapshot = readSnapshot(ledgerPath);
    const parsed = parseDocument(snapshot.bytes);
    const plan = planDocument(parsed, sinceMs);
    const report = {
      schema: SCHEMA, dryRun: Boolean(dryRun), ledgerPath, store: parsed.store,
      since: since === undefined ? null : new Date(sinceMs).toISOString(),
      ...plan.counts, backupPath: null,
    };
    if (dryRun || !plan.counts.exclusions) return report;

    const parent = directoryBinding(path.dirname(ledgerPath));
    directoryFd = fs.openSync(parent.directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    assertUnchanged(ledgerPath, snapshot);
    report.backupPath = createBackup(ledgerPath, snapshot.bytes, now, directoryFd);
    hooks.beforeReplace?.({ ledgerPath, backupPath: report.backupPath });
    assertDirectory(parent);
    assertUnchanged(ledgerPath, snapshot);
    const updatedBytes = Buffer.from(`${JSON.stringify(plan.document, null, 2)}\n`, 'utf8');
    tempPath = `${ledgerPath}.tmp-${crypto.randomUUID()}`;
    const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, Number(snapshot.stat.mode & 0o777n));
      fs.writeFileSync(fd, updatedBytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    assertDirectory(parent);
    assertUnchanged(ledgerPath, snapshot);
    fs.renameSync(tempPath, ledgerPath);
    tempPath = undefined;
    fs.fsyncSync(directoryFd);
    report.applied = report.exclusions;
    return report;
  } finally {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
    if (release) release();
  }
}

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { process.stdout.write(`${USAGE}\nDefault: --dry-run. --since dates start at 00:00 UTC.\n`); return; }
  const report = quarantineOwnerConversationLedger(parseArguments(args));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

module.exports = { quarantineOwnerConversationLedger, parseArguments, main };
if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
