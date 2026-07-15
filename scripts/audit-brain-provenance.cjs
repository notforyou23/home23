#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  withEphemeralMemorySource,
} = require('../shared/memory-source/operation-context.cjs');
const {
  appendMemoryRevision,
  compareAndSwapSourceRevision,
  createDescriptor,
  memorySourceError,
  openMemorySource,
  readManifest,
  sourceDescriptorDigest,
} = require('../shared/memory-source');
const { canonicalJson } = require('../shared/brain-operations/canonical-json.cjs');
const {
  validateCoherentBackupReceipt,
} = require('../engine/src/core/brain-backups.js');
const authorityProfile = require('../engine/src/memory/provenance-salience.js');
const {
  deriveMemoryAuthorityAttestationKey,
  verifyMemoryAuthorityAttestation,
} = require('../shared/memory-authority-attestation.cjs');

const AUDIT_SCHEMA = 'home23.brain-provenance-audit.v1';
const AUDIT_RECEIPT_SCHEMA = 'home23.brain-provenance-audit-receipt.v1';
const APPLY_INTENT_SCHEMA = 'home23.brain-provenance-apply-intent.v1';
const APPLY_RECEIPT_SCHEMA = 'home23.brain-provenance-apply-receipt.v1';
const APPLY_CONFIRMATION = 'APPLY_REVIEWED_PROVENANCE_SWEEP';
const MAX_LIMIT = 1000;
const AUTHORITY_CLASSES = new Set([
  'verified_current_state', 'jtr_correction', 'artifact_log',
  'worker_receipt', 'generated_doctrine', 'narrative',
]);
const RETRIEVAL_DOMAINS = new Set([
  'current_ops', 'closed_incidents', 'project_history', 'external_intake',
]);

class BoundedActivationHeap {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
  }

  push(node) {
    if (this.limit < 1) return;
    const activation = finiteNumber(node?.activation);
    const entry = { node, activation };
    if (this.items.length < this.limit) {
      this.items.push(entry);
      this.items.sort((a, b) => a.activation - b.activation);
      return;
    }
    if (activation <= this.items[0].activation) return;
    this.items[0] = entry;
    this.items.sort((a, b) => a.activation - b.activation);
  }

  values() {
    return this.items.slice().sort((a, b) => b.activation - a.activation).map((entry) => entry.node);
  }
}

async function auditPinnedBrainProvenance({
  source,
  home23Root,
  requesterAgent,
  targetBrainRoot,
  outputFile = null,
  maxHighActivation = 200,
  maxPerRiskStratum = 50,
  signal,
  now = new Date().toISOString(),
  authorityKey,
} = {}) {
  if (!source || typeof source.iterateNodes !== 'function' || !source.descriptor) {
    throw new Error('pinned read-only source required');
  }
  const root = canonicalDirectory(home23Root, 'home23 root');
  const requester = safeSegment(requesterAgent, 'requester agent');
  const target = canonicalDirectory(targetBrainRoot || source.descriptor.canonicalRoot, 'target brain');
  const expectedTarget = path.join(root, 'instances', requester, 'brain');
  if (target !== expectedTarget) throw new Error('provenance audit is restricted to requester own brain');
  const descriptorRoot = canonicalDirectory(source.descriptor.canonicalRoot, 'pinned source canonical root');
  if (descriptorRoot !== target) throw new Error('pinned source canonical root does not match target brain');
  const generation = requiredGeneration(source.descriptor.generation);
  const revision = requiredRevision(source.descriptor.cutoffRevision, 'pinned descriptor revision');
  if (requiredRevision(source.revision, 'opened source revision') !== revision) {
    throw new Error('opened source revision does not match pinned descriptor revision');
  }
  if (source.manifest) {
    if (requiredGeneration(source.manifest.generation) !== generation) {
      throw new Error('opened source generation does not match pinned descriptor generation');
    }
    if (requiredRevision(source.manifest.currentRevision, 'manifest revision') !== revision) {
      throw new Error('manifest revision does not match pinned descriptor revision');
    }
  }
  const instancesRoot = ensureExactChildDirectory(root, 'instances', 'instances root');
  const requesterRoot = ensureExactChildDirectory(instancesRoot, requester, 'requester root');
  const canonicalRequesterRuntime = ensureExactChildDirectory(
    requesterRoot, 'runtime', 'requester runtime',
  );
  if (target === canonicalRequesterRuntime || isWithin(target, canonicalRequesterRuntime)) {
    throw new Error('requester-owned runtime must be outside target brain');
  }

  const highLimit = boundedLimit(maxHighActivation, 'maxHighActivation');
  const riskLimit = boundedLimit(maxPerRiskStratum, 'maxPerRiskStratum');
  const resolvedAuthorityKey = authorityKey || resolveAuthorityKey(root);
  const highActivation = new BoundedActivationHeap(highLimit);
  const risks = {
    report_only: new BoundedActivationHeap(riskLimit),
    unverified_operational: new BoundedActivationHeap(riskLimit),
    generated_authority: new BoundedActivationHeap(riskLimit),
  };
  let scanned = 0;
  for await (const node of source.iterateNodes({ signal })) {
    throwIfAborted(signal);
    scanned += 1;
    if (isOperationalCandidate(node)) highActivation.push(node);
    const riskKinds = riskKindsFor(node);
    for (const kind of riskKinds) risks[kind].push(node);
  }

  const selected = new Map();
  for (const node of highActivation.values()) selected.set(String(node.id), node);
  for (const heap of Object.values(risks)) {
    for (const node of heap.values()) selected.set(String(node.id), node);
  }

  const finalOutput = resolveRequesterOutput({
    outputFile,
    requesterRuntime: canonicalRequesterRuntime,
    target,
    revision,
    now,
  });

  const rows = [...selected.values()]
    .sort((a, b) => finiteNumber(b.activation) - finiteNumber(a.activation))
    .map((node) => auditRecord(node, {
      revision, generation, target, now, authorityKey: resolvedAuthorityKey,
    }));
  const outputParentBinding = captureDirectoryBinding(path.dirname(finalOutput));
  assertDirectoryBinding(outputParentBinding, 'audit output directory');
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error('audit output confinement requires O_NOFOLLOW');
  }
  const fd = fs.openSync(
    finalOutput,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const reportHash = crypto.createHash('sha256');
  let openedIdentity = null;
  let reportSha256 = null;
  let writeSucceeded = false;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    openedIdentity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || opened.nlink !== 1n
        || path.dirname(fs.realpathSync(finalOutput)) !== outputParentBinding.path) {
      throw new Error('audit output escaped requester-owned runtime');
    }
    assertDirectoryBinding(outputParentBinding, 'audit output directory');
    let expectedBytes = 0;
    for (const row of rows) {
      const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
      reportHash.update(line);
      writeAllSync(fd, line, expectedBytes);
      expectedBytes += line.length;
    }
    fs.fsyncSync(fd);
    const afterWrite = fs.fstatSync(fd, { bigint: true });
    if (afterWrite.dev !== opened.dev || afterWrite.ino !== opened.ino
        || afterWrite.size !== BigInt(expectedBytes) || afterWrite.nlink !== 1n) {
      throw new Error('audit output identity or size changed during write');
    }
    const readback = Buffer.alloc(expectedBytes);
    readAllSync(fd, readback);
    const intendedDigest = reportHash.digest('hex');
    const actualDigest = crypto.createHash('sha256').update(readback).digest('hex');
    if (actualDigest !== intendedDigest) throw new Error('audit output digest readback mismatch');
    reportSha256 = `sha256:${actualDigest}`;
    assertDirectoryBinding(outputParentBinding, 'audit output directory');
    const boundPath = fs.lstatSync(finalOutput, { bigint: true });
    if (!boundPath.isFile() || boundPath.isSymbolicLink()
        || boundPath.dev !== opened.dev || boundPath.ino !== opened.ino) {
      throw new Error('audit output path identity changed after write');
    }
    writeSucceeded = true;
  } finally {
    fs.closeSync(fd);
    if (!writeSucceeded && openedIdentity) {
      const current = (() => {
        try { return fs.lstatSync(finalOutput, { bigint: true }); } catch { return null; }
      })();
      if (current?.isFile() && !current.isSymbolicLink()
          && current.dev === openedIdentity.dev && current.ino === openedIdentity.ino) {
        fs.unlinkSync(finalOutput);
      }
    }
  }

  return Object.freeze({
    schema: AUDIT_SCHEMA,
    receiptSchema: AUDIT_RECEIPT_SCHEMA,
    sourceRoot: target,
    sourceRevision: revision,
    sourceGeneration: generation,
    scanned,
    recordsWritten: rows.length,
    riskCounts: Object.fromEntries(Object.entries(risks).map(([key, heap]) => [key, heap.values().length])),
    outputFile: finalOutput,
    reportSha256,
    dryRun: true,
    firstRolloutDryRunOnly: true,
    applyCapability: 'guarded-reviewed-report-and-coherent-backup',
  });
}

function writeAllSync(fd, buffer, startPosition) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, startPosition + offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('audit output short write made no progress');
    }
    offset += written;
  }
}

function readAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!Number.isSafeInteger(read) || read <= 0) {
      throw new Error('audit output readback was incomplete');
    }
    offset += read;
  }
}

function captureDirectoryBinding(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  const canonical = fs.realpathSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== directory) {
    throw new Error('audit output directory must be a canonical nonsymlink directory');
  }
  return Object.freeze({ path: directory, dev: stat.dev, ino: stat.ino });
}

function assertDirectoryBinding(binding, label) {
  const stat = fs.lstatSync(binding.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== binding.dev || stat.ino !== binding.ino
      || fs.realpathSync(binding.path) !== binding.path) {
    throw new Error(`${label} identity changed`);
  }
}

function auditRecord(node, { revision, generation, target, now, authorityKey }) {
  const stored = storedProfile(node);
  const proposedAuthorityClass = classifyAuthority(node, authorityKey);
  const proposedRetrievalDomain = classifyDomain(node, authorityKey);
  const sourceChain = projectSourceChain(node);
  const missingEvidence = missingEvidenceFor(node, proposedAuthorityClass, sourceChain);
  const reasons = [];
  if (!stored) reasons.push('missing_node_provenance');
  const attestationMissing = Boolean(stored)
    && !verifyMemoryAuthorityAttestation(node, authorityKey);
  if (attestationMissing) reasons.push('attestation_missing');
  if (stored?.authorityClass && stored.authorityClass !== proposedAuthorityClass) {
    reasons.push('authority_class_mismatch');
  }
  if (stored?.retrievalDomain && stored.retrievalDomain !== proposedRetrievalDomain) {
    reasons.push('retrieval_domain_mismatch');
  }
  if (isGenerated(node)) reasons.push('generated_content_cannot_self_verify');
  if (missingEvidence.length) reasons.push('evidence_gap');
  if (!reasons.length) reasons.push('classification_confirmed');
  const reviewRequired = missingEvidence.length > 0
    || attestationMissing
    || stored?.authorityClass !== proposedAuthorityClass
    || stored?.retrievalDomain !== proposedRetrievalDomain;
  return {
    schema: AUDIT_SCHEMA,
    auditedAt: now,
    sourceRoot: target,
    sourceGeneration: generation,
    sourceRevision: revision,
    nodeId: String(node.id),
    contentHash: contentHash(node),
    beforeNodeHash: canonicalDigest(node),
    beforeProfileHash: canonicalDigest(stored),
    activation: finiteNumber(node.activation),
    storedAuthorityClass: stored?.authorityClass || null,
    storedRetrievalDomain: stored?.retrievalDomain || null,
    proposedAuthorityClass,
    proposedRetrievalDomain,
    reasons: reasons.slice(0, 8),
    confidence: classificationConfidence(node, stored),
    missingEvidence: missingEvidence.slice(0, 8),
    sourceChain,
    reviewRequired,
    proposedAuthorityStatus: proposedAuthorityClass === 'narrative' && missingEvidence.length
      ? 'quarantine_pending_verification'
      : 'eligible',
    dryRun: true,
  };
}

function classifyAuthority(node, authorityKey) {
  const directChain = fallbackSourceChain(node);
  if (typeof authorityProfile.classifyClaimAuthority === 'function') {
    const projected = authorityProfile.classifyClaimAuthority(node, { authorityKey });
    const value = typeof projected === 'string'
      ? projected
      : projected?.authorityClass || projected?.claimAuthority;
    if (AUTHORITY_CLASSES.has(value)) {
      if (value === 'verified_current_state'
          && !directChain.evidenceRefs.some((ref) => ref.startsWith('verifier:'))) {
        return directChain.sourceRefs.length || directChain.evidenceRefs.length
          ? 'artifact_log'
          : 'narrative';
      }
      return value;
    }
  }
  if (isGenerated(node)) return 'narrative';
  if (directChain.sourceRefs.length || directChain.evidenceRefs.length) return 'artifact_log';
  return 'narrative';
}

function classifyDomain(node, authorityKey) {
  if (typeof authorityProfile.classifyMemoryDomain === 'function') {
    const projected = authorityProfile.classifyMemoryDomain(node, { authorityKey });
    const value = typeof projected === 'string'
      ? projected
      : projected?.retrievalDomain || projected?.domain;
    if (RETRIEVAL_DOMAINS.has(value)) return value;
  }
  const stored = storedProfile(node);
  if (RETRIEVAL_DOMAINS.has(stored?.retrievalDomain)) return stored.retrievalDomain;
  if (hasTag(node, 'closed', 'resolved', 'fixed', 'archived')) return 'closed_incidents';
  if (hasTag(node, 'news', 'external', 'x', 'twitter', 'market', 'cron', 'telemetry')) {
    return 'external_intake';
  }
  if (hasTag(node, 'current-state', 'current_state', 'live', 'operational')) return 'current_ops';
  return 'project_history';
}

function projectSourceChain(node) {
  const fallback = fallbackSourceChain(node);
  if (typeof authorityProfile.projectSourceChain === 'function') {
    const projected = authorityProfile.projectSourceChain(node);
    if (Array.isArray(projected)) {
      return {
        sourceRefs: boundedStrings(projected
          .filter((entry) => entry?.kind === 'source')
          .map((entry) => entry.ref)),
        evidenceRefs: boundedStrings(projected
          .filter((entry) => entry?.kind === 'evidence' || entry?.kind === 'artifact')
          .map((entry) => entry.ref)),
        traceId: fallback.traceId,
        generationMethod: fallback.generationMethod,
      };
    }
    if (projected && typeof projected === 'object') {
      return {
        sourceRefs: boundedStrings(projected.sourceRefs || projected.directSourceRefs),
        evidenceRefs: boundedStrings(projected.evidenceRefs || projected.directEvidenceRefs),
        traceId: boundedString(projected.traceId, 240),
        generationMethod: boundedString(projected.generationMethod, 120),
      };
    }
  }
  return fallback;
}

function fallbackSourceChain(node) {
  const profile = storedProfile(node) || {};
  const legacy = node.provenance || {};
  return {
    sourceRefs: boundedStrings(profile.sourceRefs || legacy.source_refs || node.source_refs),
    evidenceRefs: boundedStrings(profile.evidenceRefs || node.evidence?.evidence_links),
    traceId: boundedString(profile.traceId || legacy.trace_id, 240),
    generationMethod: boundedString(profile.generationMethod || legacy.generation_method, 120),
  };
}

function riskKindsFor(node) {
  const stored = storedProfile(node) || {};
  const chain = fallbackSourceChain(node);
  const noDirectEvidence = chain.sourceRefs.length === 0 && chain.evidenceRefs.length === 0;
  const generated = isGenerated(node);
  const kinds = [];
  if (generated && noDirectEvidence) kinds.push('report_only');
  if (isOperationalCandidate(node)
      && !chain.evidenceRefs.some((ref) => ref.startsWith('verifier:'))) {
    kinds.push('unverified_operational');
  }
  if (generated && (stored.operationalAuthority === true
      || stored.authorityClass === 'verified_current_state'
      || stored.authorityClass === 'artifact_log')) {
    kinds.push('generated_authority');
  }
  return kinds;
}

function missingEvidenceFor(node, authorityClass, chain) {
  const missing = [];
  if (authorityClass === 'narrative' && chain.sourceRefs.length === 0 && chain.evidenceRefs.length === 0) {
    missing.push('direct_source_or_evidence_ref');
  }
  if (isOperationalCandidate(node)
      && !chain.evidenceRefs.some((ref) => ref.startsWith('verifier:'))) {
    missing.push('verifier_evidence');
  }
  if (isGenerated(node) && !chain.evidenceRefs.some((ref) => ref.startsWith('adopted-doctrine-receipt:'))) {
    missing.push('independent_direct_evidence');
  }
  return [...new Set(missing)];
}

function isOperationalCandidate(node) {
  const stored = storedProfile(node);
  if (stored?.operationalAuthority === true) return true;
  if (stored?.retrievalDomain === 'current_ops' || stored?.retrievalDomain === 'closed_incidents') {
    return true;
  }
  if (['verified_current_state', 'jtr_correction', 'worker_receipt'].includes(stored?.authorityClass)) {
    return true;
  }
  if (hasTag(
    node,
    'current-state', 'current_state', 'state_snapshot', 'operational', 'live',
    'health', 'status', 'incident', 'alert', 'closure', 'resolved', 'fixed',
  )) return true;
  const text = String(node?.concept || node?.summary || node?.title || '').toLowerCase();
  return /\b(?:current|live|active|status|health|incident|alert|resolved|fixed)\b/.test(text)
    && !hasTag(node, 'news', 'external', 'x', 'twitter', 'market', 'cron', 'telemetry');
}

function storedProfile(node) {
  const candidates = [node?.metadata?.provenance, node?.provenance?.node_profile, node?.provenance];
  return candidates.find((value) => (
    value && !Array.isArray(value) && typeof value === 'object'
    && (value.schema === 'home23.node-provenance.v1'
      || value.authorityClass || value.retrievalDomain || value.operationalAuthority !== undefined)
  )) || null;
}

function isGenerated(node) {
  const profile = storedProfile(node) || {};
  const method = String(profile.generationMethod || node?.provenance?.generation_method || '').toLowerCase();
  return /(synthesis|generated|query|pgs|narrative|reflection)/.test(method)
    || hasTag(node, 'generated-report', 'generated_report', 'synthesis', 'narrative', 'query', 'pgs');
}

function hasTag(node, ...needles) {
  const tags = Array.isArray(node?.tag) ? node.tag : [node?.tag, ...(node?.tags || [])];
  const normalized = new Set(tags.filter(Boolean).map((tag) => String(tag).toLowerCase()));
  return needles.some((needle) => normalized.has(needle));
}

function classificationConfidence(node, stored) {
  if (stored?.schema === 'home23.node-provenance.v1') return 0.95;
  if (isGenerated(node) || fallbackSourceChain(node).evidenceRefs.length) return 0.85;
  if (fallbackSourceChain(node).sourceRefs.length) return 0.75;
  return 0.55;
}

function contentHash(node) {
  const content = node?.concept ?? node?.content ?? node?.statement ?? '';
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}

function canonicalDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value ?? null)).digest('hex')}`;
}

function resolveAuthorityKey(home23Root) {
  try {
    const secrets = yaml.load(fs.readFileSync(path.join(home23Root, 'config', 'secrets.yaml'), 'utf8')) || {};
    const capabilityKey = secrets?.brainOperations?.capabilityKey;
    return deriveMemoryAuthorityAttestationKey(capabilityKey);
  } catch {
    return null;
  }
}

function resolveRequesterOutput({ outputFile, requesterRuntime, target, revision, now }) {
  const auditsRoot = ensureExactChildDirectory(
    requesterRuntime, 'brain-provenance-audits', 'audit output directory',
  );
  const canonicalAuditsRoot = auditsRoot;
  const targetName = safeSegment(path.basename(path.dirname(target)) || 'brain', 'target name');
  const timestamp = String(now).replace(/[^0-9A-Za-z_.-]/g, '-');
  const candidate = outputFile
    ? path.resolve(outputFile)
    : path.join(auditsRoot, `${targetName}-r${revision}-${timestamp}.jsonl`);
  if (!isWithin(requesterRuntime, candidate)) {
    throw new Error('audit output must be under requester-owned runtime');
  }
  if (path.dirname(candidate) !== auditsRoot) {
    throw new Error('audit output must be a direct child of requester-owned runtime audit directory');
  }
  if (isWithin(target, candidate)) {
    throw new Error('audit output must be under requester-owned runtime, not target brain');
  }
  const parent = canonicalAuditsRoot;
  if (parent !== requesterRuntime && !isWithin(requesterRuntime, parent)) {
    throw new Error('audit output must be under requester-owned runtime');
  }
  if (parent === target || isWithin(target, parent)) {
    throw new Error('audit output must be under requester-owned runtime, not target brain');
  }
  return path.join(parent, path.basename(candidate));
}

function ensureExactChildDirectory(parent, segment, label) {
  const child = path.join(parent, safeSegment(segment, label));
  try {
    fs.mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(child);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(child) !== child) {
    throw new Error(`${label} must be a canonical nonsymlink directory under canonical home`);
  }
  return child;
}

function requiredGeneration(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 240) {
    throw new Error('pinned source generation is required');
  }
  return value;
}

function requiredRevision(value, label) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`${label} is required`);
  return revision;
}

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const canonical = fs.realpathSync(value);
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a nonsymlink directory`);
  return canonical;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`safe ${label} required`);
  }
  return value;
}

function boundedLimit(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return parsed;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedStrings(values, limit = 8, maxBytes = 240) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const bounded = boundedString(value, maxBytes);
    if (!bounded || result.includes(bounded)) continue;
    result.push(bounded);
    if (result.length >= limit) break;
  }
  return result;
}

function boundedString(value, maxBytes) {
  if (typeof value !== 'string' || !value) return null;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = value.slice(0, maxBytes);
  while (bounded && Buffer.byteLength(bounded, 'utf8') > maxBytes) bounded = bounded.slice(0, -1);
  return bounded || null;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('audit aborted');
    error.name = 'AbortError';
    throw error;
  }
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readBoundRegularFile(filePath, {
  label,
  maxBytes,
  exactParent,
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || path.normalize(filePath) !== filePath) {
    throw new Error(`${label} path must be canonical and absolute`);
  }
  if (exactParent && path.dirname(filePath) !== exactParent) {
    throw new Error(`${label} must be a direct child of requester-owned audit directory`);
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > BigInt(maxBytes)
      || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`${label} must be a bounded canonical nonsymlink regular file`);
  }
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error(`${label} validation requires O_NOFOLLOW`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.nlink !== 1n) {
      throw new Error(`${label} identity changed during open`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error(`${label} identity changed during readback`);
    }
    return Object.freeze({
      bytes,
      digest: sha256Bytes(bytes),
      binding: Object.freeze({
        path: filePath,
        dev: String(opened.dev),
        ino: String(opened.ino),
        size: String(opened.size),
        digest: sha256Bytes(bytes),
      }),
    });
  } finally {
    fs.closeSync(fd);
  }
}

function assertBoundRegularFile(binding, label) {
  const stat = fs.lstatSync(binding.path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || String(stat.dev) !== binding.dev || String(stat.ino) !== binding.ino
      || String(stat.size) !== binding.size || fs.realpathSync(binding.path) !== binding.path
      || sha256Bytes(fs.readFileSync(binding.path)) !== binding.digest) {
    throw memorySourceError('source_changed', `${label} changed after validation`, {
      retryable: true,
    });
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} digest is required`);
  }
  return value;
}

const AUDIT_ROW_KEYS = Object.freeze([
  'activation', 'auditedAt', 'beforeNodeHash', 'beforeProfileHash', 'confidence',
  'contentHash', 'dryRun', 'missingEvidence', 'nodeId', 'proposedAuthorityClass',
  'proposedAuthorityStatus', 'proposedRetrievalDomain', 'reasons', 'reviewRequired',
  'schema', 'sourceChain', 'sourceGeneration', 'sourceRevision', 'sourceRoot',
  'storedAuthorityClass', 'storedRetrievalDomain',
].sort());

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported fields or schema`);
  }
}

function assertBoundedStringArray(value, label) {
  if (!Array.isArray(value) || value.length > 8
      || value.some((entry) => typeof entry !== 'string' || !entry
        || Buffer.byteLength(entry, 'utf8') > 240)) {
    throw new Error(`${label} is malformed`);
  }
}

function parseAuditReport(bytes, { target, generation, revision }) {
  if (bytes.length < 2 || bytes[bytes.length - 1] !== 0x0a) {
    throw new Error('audit report is truncated or lacks final newline');
  }
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  if (lines.length < 1 || lines.length > MAX_LIMIT || lines.some((line) => !line)) {
    throw new Error('audit report row count is malformed');
  }
  const rows = [];
  const ids = new Set();
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('audit report is malformed'); }
    if (!row || Array.isArray(row) || typeof row !== 'object') {
      throw new Error('audit report row is malformed');
    }
    assertExactKeys(row, AUDIT_ROW_KEYS, 'audit report row');
    if (row.schema !== AUDIT_SCHEMA) throw new Error('unsupported audit report schema');
    if (row.sourceRoot !== target || row.sourceGeneration !== generation
        || row.sourceRevision !== revision) {
      throw new Error('audit report contains mixed source generation or revision');
    }
    if (row.dryRun !== true || typeof row.nodeId !== 'string' || !row.nodeId
        || Buffer.byteLength(row.nodeId, 'utf8') > 1024
        || typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash)
        || typeof row.beforeNodeHash !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(row.beforeNodeHash)
        || typeof row.beforeProfileHash !== 'string'
        || !/^sha256:[a-f0-9]{64}$/.test(row.beforeProfileHash)
        || !AUTHORITY_CLASSES.has(row.proposedAuthorityClass)
        || !RETRIEVAL_DOMAINS.has(row.proposedRetrievalDomain)
        || !['eligible', 'quarantine_pending_verification'].includes(row.proposedAuthorityStatus)
        || typeof row.reviewRequired !== 'boolean') {
      throw new Error('audit report source, identity, or classification is malformed');
    }
    if (ids.has(row.nodeId)) throw new Error('audit report contains duplicate node ID');
    ids.add(row.nodeId);
    assertBoundedStringArray(row.reasons, 'audit reasons');
    assertBoundedStringArray(row.missingEvidence, 'audit missing evidence');
    if (!row.sourceChain || Array.isArray(row.sourceChain)
        || typeof row.sourceChain !== 'object') {
      throw new Error('audit source chain is malformed');
    }
    assertExactKeys(
      row.sourceChain,
      ['evidenceRefs', 'generationMethod', 'sourceRefs', 'traceId'],
      'audit source chain',
    );
    assertBoundedStringArray(row.sourceChain.sourceRefs, 'audit source refs');
    assertBoundedStringArray(row.sourceChain.evidenceRefs, 'audit evidence refs');
    for (const field of ['traceId', 'generationMethod']) {
      if (row.sourceChain[field] !== null && typeof row.sourceChain[field] !== 'string') {
        throw new Error('audit source chain scalar is malformed');
      }
    }
    rows.push(Object.freeze(row));
  }
  return Object.freeze(rows);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectedProfileFromRow(node, row, authorityKey) {
  const current = storedProfile(node) || {};
  const currentValid = verifyMemoryAuthorityAttestation(node, authorityKey);
  if (currentValid) return cloneJson(current);
  const legacy = node?.provenance && !Array.isArray(node.provenance)
    && typeof node.provenance === 'object' ? node.provenance : {};
  const nestedLegacy = legacy.node_profile && !Array.isArray(legacy.node_profile)
    && typeof legacy.node_profile === 'object' ? legacy.node_profile : {};
  const hasSourceRefs = Object.hasOwn(current, 'sourceRefs') || Object.hasOwn(current, 'source_refs')
    || Object.hasOwn(legacy, 'source_refs') || Object.hasOwn(nestedLegacy, 'sourceRefs')
    || Object.hasOwn(nestedLegacy, 'source_refs') || Object.hasOwn(node || {}, 'source_refs');
  const hasEvidenceRefs = Object.hasOwn(current, 'evidenceRefs') || Object.hasOwn(current, 'evidence_refs')
    || Object.hasOwn(nestedLegacy, 'evidenceRefs') || Object.hasOwn(nestedLegacy, 'evidence_refs')
    || Object.hasOwn(node?.evidence || {}, 'evidence_links');
  const hasTraceId = Object.hasOwn(current, 'traceId') || Object.hasOwn(current, 'trace_id')
    || Object.hasOwn(legacy, 'trace_id') || Object.hasOwn(nestedLegacy, 'traceId')
    || Object.hasOwn(nestedLegacy, 'trace_id');
  const hasGenerationMethod = Object.hasOwn(current, 'generationMethod')
    || Object.hasOwn(current, 'generation_method') || Object.hasOwn(legacy, 'generation_method')
    || Object.hasOwn(nestedLegacy, 'generationMethod')
    || Object.hasOwn(nestedLegacy, 'generation_method');
  const projected = {
    ...cloneJson(current),
    schema: 'home23.node-provenance.v1',
    authorityClass: row.proposedAuthorityClass,
    retrievalDomain: row.proposedRetrievalDomain,
    authorityStatus: row.proposedAuthorityStatus,
    ...(!hasSourceRefs ? { sourceRefs: cloneJson(row.sourceChain.sourceRefs) } : {}),
    ...(!hasEvidenceRefs ? { evidenceRefs: cloneJson(row.sourceChain.evidenceRefs) } : {}),
    ...(!hasTraceId ? { traceId: row.sourceChain.traceId } : {}),
    ...(!hasGenerationMethod ? { generationMethod: row.sourceChain.generationMethod } : {}),
  };
  delete projected.attestation;
  return projected;
}

function patchedNodeFromRow(node, row, authorityKey) {
  const patched = cloneJson(node);
  patched.metadata = patched.metadata && !Array.isArray(patched.metadata)
    && typeof patched.metadata === 'object' ? patched.metadata : {};
  patched.metadata.provenance = projectedProfileFromRow(node, row, authorityKey);
  return patched;
}

function resolveApplyReceiptFile({ auditsRoot, reportDigest, applyReceiptFile }) {
  const supplied = applyReceiptFile ? path.resolve(applyReceiptFile) : null;
  const candidate = supplied
    ? path.join(fs.realpathSync(path.dirname(supplied)), path.basename(supplied))
    : path.join(auditsRoot, `provenance-apply-${reportDigest.slice('sha256:'.length)}.json`);
  if (path.dirname(candidate) !== auditsRoot) {
    throw new Error('apply receipt must be a direct child of requester-owned audit directory');
  }
  return candidate;
}

function reserveApplyReceipt(receiptFile, auditsRoot) {
  const directoryBinding = captureDirectoryBinding(auditsRoot);
  assertDirectoryBinding(directoryBinding, 'audit output directory');
  const fd = fs.openSync(
    receiptFile,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n
      || path.dirname(fs.realpathSync(receiptFile)) !== auditsRoot) {
    fs.closeSync(fd);
    throw new Error('apply receipt escaped requester-owned audit directory');
  }
  return {
    fd,
    directoryBinding,
    identity: { dev: stat.dev, ino: stat.ino },
    published: false,
  };
}

function fsyncDirectorySync(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writePreparedApplyIntent(receiptFile, reservation, intent) {
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, 'utf8');
  writeAllSync(reservation.fd, bytes, 0);
  fs.fsyncSync(reservation.fd);
  const readback = Buffer.alloc(bytes.length);
  readAllSync(reservation.fd, readback);
  if (!readback.equals(bytes)) throw new Error('apply intent readback mismatch');
  const opened = readBoundRegularFile(receiptFile, {
    label: 'apply intent', maxBytes: 1024 * 1024, exactParent: path.dirname(receiptFile),
  });
  reservation.preparedBinding = opened.binding;
  reservation.preparedBytes = bytes;
  reservation.intentSha256 = opened.digest;
  return opened.digest;
}

function retainPreparedApplyLedger(receiptFile, reservation, guardDirectory) {
  assertBoundRegularFile(reservation.preparedBinding, 'apply intent');
  const guardBinding = captureDirectoryBinding(guardDirectory);
  const recoveryLedgerFile = path.join(guardDirectory, 'provenance-apply-ledger.jsonl');
  fs.linkSync(receiptFile, recoveryLedgerFile);
  fsyncDirectorySync(guardDirectory);
  fsyncDirectorySync(path.dirname(guardDirectory));
  const primary = fs.lstatSync(receiptFile, { bigint: true });
  const recovery = fs.lstatSync(recoveryLedgerFile, { bigint: true });
  const opened = fs.fstatSync(reservation.fd, { bigint: true });
  if (!primary.isFile() || primary.isSymbolicLink()
      || !recovery.isFile() || recovery.isSymbolicLink()
      || primary.dev !== opened.dev || primary.ino !== opened.ino
      || recovery.dev !== opened.dev || recovery.ino !== opened.ino
      || opened.nlink !== 2n || opened.size !== BigInt(reservation.preparedBytes.length)
      || fs.realpathSync(recoveryLedgerFile) !== recoveryLedgerFile) {
    throw new Error('apply recovery ledger hard link identity mismatch');
  }
  reservation.guardDirectoryBinding = guardBinding;
  reservation.recoveryLedgerFile = recoveryLedgerFile;
}

function assertPreparedApplyLedger(receiptFile, reservation, expectedBytes, {
  requirePrimary = true,
} = {}) {
  assertDirectoryBinding(reservation.guardDirectoryBinding, 'apply recovery ledger directory');
  const opened = fs.fstatSync(reservation.fd, { bigint: true });
  const recovery = fs.lstatSync(reservation.recoveryLedgerFile, { bigint: true });
  if (!opened.isFile() || opened.dev !== reservation.identity.dev
      || opened.ino !== reservation.identity.ino || opened.nlink < 1n
      || opened.size !== BigInt(expectedBytes.length)
      || !recovery.isFile() || recovery.isSymbolicLink()
      || recovery.dev !== opened.dev || recovery.ino !== opened.ino
      || recovery.size !== opened.size
      || fs.realpathSync(reservation.recoveryLedgerFile) !== reservation.recoveryLedgerFile
      || !fs.readFileSync(reservation.recoveryLedgerFile).equals(expectedBytes)) {
    throw new Error('apply recovery ledger changed after validation');
  }
  if (requirePrimary) {
    const primary = fs.lstatSync(receiptFile, { bigint: true });
    if (!primary.isFile() || primary.isSymbolicLink()
        || primary.dev !== opened.dev || primary.ino !== opened.ino
        || opened.nlink !== 2n || fs.realpathSync(receiptFile) !== receiptFile) {
      throw new Error('apply receipt pathname changed after validation');
    }
  }
}

function removeReservedReceipt(receiptFile, reservation) {
  try { fs.closeSync(reservation.fd); } catch {}
  const current = (() => {
    try { return fs.lstatSync(receiptFile, { bigint: true }); } catch { return null; }
  })();
  if (current?.isFile() && !current.isSymbolicLink()
      && current.dev === reservation.identity.dev && current.ino === reservation.identity.ino) {
    fs.unlinkSync(receiptFile);
  }
}

function publishApplyReceipt(receiptFile, reservation, receipt, { beforeOutcomeAppend } = {}) {
  const outcomeBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
  assertDirectoryBinding(reservation.directoryBinding, 'audit output directory');
  assertPreparedApplyLedger(receiptFile, reservation, reservation.preparedBytes);
  beforeOutcomeAppend?.();
  writeAllSync(reservation.fd, outcomeBytes, reservation.preparedBytes.length);
  fs.fsyncSync(reservation.fd);
  const expectedBytes = Buffer.concat([reservation.preparedBytes, outcomeBytes]);
  const readback = Buffer.alloc(expectedBytes.length);
  readAllSync(reservation.fd, readback);
  if (!readback.equals(expectedBytes)) throw new Error('apply receipt ledger readback mismatch');
  assertPreparedApplyLedger(receiptFile, reservation, expectedBytes, { requirePrimary: false });
  const finalStat = fs.fstatSync(reservation.fd, { bigint: true });
  const pathStat = fs.lstatSync(receiptFile, { bigint: true });
  if (finalStat.size !== BigInt(expectedBytes.length) || finalStat.nlink !== 2n
      || pathStat.isSymbolicLink() || pathStat.dev !== finalStat.dev || pathStat.ino !== finalStat.ino
      || fs.realpathSync(receiptFile) !== receiptFile) {
    throw new Error('apply receipt pathname changed during outcome append');
  }
  fs.closeSync(reservation.fd);
  reservation.fd = null;
  fsyncDirectorySync(path.dirname(receiptFile));
  reservation.published = true;
  return sha256Bytes(expectedBytes);
}

async function applyPinnedBrainProvenanceAudit({
  home23Root,
  requesterAgent,
  targetBrainRoot,
  reportFile,
  reportSha256,
  backupReceiptFile,
  backupReceiptSha256,
  applyConfirmation,
  applyReceiptFile = null,
  authorityKey,
  now = new Date().toISOString(),
  beforeCommit,
  beforeReceiptPublication,
  beforeOutcomeAppend,
  signal,
} = {}) {
  if (applyConfirmation !== APPLY_CONFIRMATION) {
    throw new Error(`--apply must equal ${APPLY_CONFIRMATION}`);
  }
  const root = canonicalDirectory(home23Root, 'home23 root');
  const requester = safeSegment(requesterAgent, 'requester agent');
  const target = canonicalDirectory(targetBrainRoot, 'target brain');
  const expectedTarget = path.join(root, 'instances', requester, 'brain');
  if (target !== expectedTarget) throw new Error('provenance apply is restricted to requester own brain');
  const requesterRuntime = canonicalDirectory(
    path.join(root, 'instances', requester, 'runtime'),
    'requester runtime',
  );
  const auditsRoot = canonicalDirectory(
    path.join(requesterRuntime, 'brain-provenance-audits'),
    'requester-owned audit directory',
  );
  const reportPath = path.resolve(reportFile || '');
  const expectedReportDigest = assertDigest(reportSha256, 'audit report');
  const openedReport = readBoundRegularFile(reportPath, {
    label: 'audit report', maxBytes: 32 * 1024 * 1024, exactParent: auditsRoot,
  });
  if (openedReport.digest !== expectedReportDigest) throw new Error('audit report digest mismatch');

  const currentManifest = await readManifest(target);
  if (!currentManifest) throw new Error('manifest-v1 target is required');
  const generation = requiredGeneration(currentManifest.generation);
  const revision = requiredRevision(currentManifest.currentRevision, 'current source revision');
  const rows = parseAuditReport(openedReport.bytes, { target, generation, revision });
  const backup = validateCoherentBackupReceipt({
    brainDir: target,
    receiptFile: backupReceiptFile,
    expectedDigest: assertDigest(backupReceiptSha256, 'backup receipt'),
    expectedGeneration: generation,
    expectedRevision: revision,
  });
  const receiptFile = resolveApplyReceiptFile({
    auditsRoot, reportDigest: expectedReportDigest, applyReceiptFile,
  });
  const reservation = reserveApplyReceipt(receiptFile, auditsRoot);
  const guardDirectory = path.join(
    auditsRoot,
    `.provenance-backup-guard-${expectedReportDigest.slice('sha256:'.length)}`,
  );
  let retainedBackup = null;
  let commitCompleted = false;
  try {
    retainedBackup = backup.retainAt(guardDirectory);
    throwIfAborted(signal);
    const source = await openMemorySource(target, { signal });
    const selectedRows = new Map(rows.map((row) => [row.nodeId, row]));
    const selectedNodes = new Map();
    try {
      if (source.descriptor?.canonicalRoot !== target
          || source.descriptor?.generation !== generation
          || source.revision !== revision
          || source.manifest?.generation !== generation
          || source.manifest?.currentRevision !== revision) {
        throw memorySourceError('source_changed', 'source changed before provenance apply', {
          retryable: true,
        });
      }
      for await (const node of source.iterateNodes({ signal })) {
        const id = String(node?.id ?? '');
        if (!selectedRows.has(id)) continue;
        if (selectedNodes.has(id)) throw new Error('current source contains duplicate selected node ID');
        selectedNodes.set(id, node);
      }
    } finally {
      await source.close();
    }
    if (selectedNodes.size !== rows.length) {
      throw memorySourceError('source_changed', 'selected node identity is missing', { retryable: true });
    }
    const resolvedAuthorityKey = authorityKey || resolveAuthorityKey(root);
    const patchedNodes = [];
    for (const row of rows) {
      const node = selectedNodes.get(row.nodeId);
      if (contentHash(node) !== row.contentHash) {
        throw memorySourceError('source_changed', 'selected node content changed', { retryable: true });
      }
      if (canonicalDigest(node) !== row.beforeNodeHash) {
        throw memorySourceError('source_changed', 'selected node identity changed', { retryable: true });
      }
      if (canonicalDigest(storedProfile(node)) !== row.beforeProfileHash) {
        throw memorySourceError('source_changed', 'selected node profile changed', { retryable: true });
      }
      const justified = auditRecord(node, {
        revision,
        generation,
        target,
        now: row.auditedAt,
        authorityKey: resolvedAuthorityKey,
      });
      if (canonicalJson(justified) !== canonicalJson(row)) {
        throw new Error('audit report classification or source-chain projection is not justified');
      }
      const patched = patchedNodeFromRow(node, row, resolvedAuthorityKey);
      if (canonicalJson(patched) !== canonicalJson(node)) patchedNodes.push(patched);
    }
    const intentSha256 = writePreparedApplyIntent(receiptFile, reservation, Object.freeze({
      schema: APPLY_INTENT_SCHEMA,
      state: 'prepared',
      preparedAt: now,
      requesterAgent: requester,
      targetRootDigest: sha256Bytes(Buffer.from(target)),
      inputReportSha256: expectedReportDigest,
      backupReceiptSha256: backup.digest,
      backupIdentity: backup.identity,
      backupGuardIdentity: retainedBackup.identity,
      beforeGeneration: generation,
      beforeRevision: revision,
      selectedNodeIds: rows.map((row) => row.nodeId).sort(),
      requestedPatchCount: patchedNodes.length,
    }));
    retainPreparedApplyLedger(receiptFile, reservation, guardDirectory);
    const authorizeCommit = () => {
      assertBoundRegularFile(openedReport.binding, 'audit report');
      retainedBackup.assertCurrent();
      assertPreparedApplyLedger(receiptFile, reservation, reservation.preparedBytes);
    };
    const expectedDescriptorDigest = sourceDescriptorDigest(createDescriptor(target, currentManifest));
    let committedManifest;
    if (patchedNodes.length) {
      const append = await appendMemoryRevision(target, { nodes: patchedNodes }, {
        lockRoot: path.join(root, 'runtime', 'brain-source-locks'),
        signal,
        beforeLock: beforeCommit,
        authorize: authorizeCommit,
        expectedGeneration: generation,
        expectedRevision: revision,
        expectedDigest: expectedDescriptorDigest,
        summary: currentManifest.summary,
      });
      committedManifest = append.manifest;
    } else {
      await beforeCommit?.();
      const noOp = await compareAndSwapSourceRevision(target, {
        lockRoot: path.join(root, 'runtime', 'brain-source-locks'),
        signal,
        authorize: authorizeCommit,
        expectedGeneration: generation,
        expectedRevision: revision,
        expectedDigest: expectedDescriptorDigest,
        commit: async () => Object.freeze({ safeNoOp: true }),
      });
      if (!noOp.committed) {
        throw memorySourceError('source_changed', 'source changed before provenance no-op', {
          retryable: true,
        });
      }
      committedManifest = noOp.manifest;
    }
    commitCompleted = true;
    const afterGeneration = committedManifest.generation;
    const afterRevision = committedManifest.currentRevision;
    const receipt = Object.freeze({
      schema: APPLY_RECEIPT_SCHEMA,
      appliedAt: now,
      requesterAgent: requester,
      targetRootDigest: sha256Bytes(Buffer.from(target)),
      inputReportSha256: expectedReportDigest,
      backupReceiptSha256: backup.digest,
      backupIdentity: backup.identity,
      backupGuardIdentity: retainedBackup.identity,
      intentSha256,
      beforeGeneration: generation,
      beforeRevision: revision,
      afterGeneration,
      afterRevision,
      patchedNodeCount: patchedNodes.length,
      patchedNodeIds: patchedNodes.map((node) => String(node.id)).sort(),
      casResult: patchedNodes.length ? 'committed' : 'safe-no-op',
    });
    await beforeReceiptPublication?.();
    const receiptSha256 = publishApplyReceipt(
      receiptFile,
      reservation,
      receipt,
      { beforeOutcomeAppend },
    );
    return Object.freeze({
      ...receipt,
      applied: true,
      receiptFile,
      receiptSha256,
      rolloutPolicy: 'first-live-rollout-remains-dry-run-only',
      rolloutAuthorized: false,
    });
  } catch (error) {
    if (!commitCompleted) {
      if (!reservation.published) removeReservedReceipt(receiptFile, reservation);
      retainedBackup?.release();
      throw error;
    }
    if (!reservation.published) {
      try { fs.closeSync(reservation.fd); } catch {}
      reservation.fd = null;
      const reconciliation = new Error('provenance apply committed; receipt reconciliation is required');
      reconciliation.code = 'apply_receipt_reconciliation_required';
      reconciliation.committed = true;
      reconciliation.receiptFile = receiptFile;
      reconciliation.recoveryLedgerFile = reservation.recoveryLedgerFile;
      reconciliation.cause = error;
      throw reconciliation;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`value required for --${key}`);
    if (Object.hasOwn(args, key)) throw new Error(`duplicate argument: --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.apply !== undefined && args.apply !== APPLY_CONFIRMATION) {
    throw new Error(`--apply must equal ${APPLY_CONFIRMATION}`);
  }
  const home23Root = path.resolve(args['home23-root'] || path.join(__dirname, '..'));
  const requesterAgent = args.requester;
  if (!requesterAgent) throw new Error('--requester is required');
  const targetAgent = args['target-agent'] || requesterAgent;
  const targetBrainRoot = args['brain-dir']
    ? path.resolve(args['brain-dir'])
    : path.join(home23Root, 'instances', safeSegment(targetAgent, 'target agent'), 'brain');
  if (args.apply !== undefined) {
    for (const required of ['report', 'report-sha256', 'backup-receipt', 'backup-receipt-sha256']) {
      if (!args[required]) throw new Error(`--${required} is required with --apply`);
    }
    const applied = await applyPinnedBrainProvenanceAudit({
      home23Root,
      requesterAgent,
      targetBrainRoot,
      reportFile: path.resolve(args.report),
      reportSha256: args['report-sha256'],
      backupReceiptFile: path.resolve(args['backup-receipt']),
      backupReceiptSha256: args['backup-receipt-sha256'],
      applyReceiptFile: args['apply-receipt'] ? path.resolve(args['apply-receipt']) : null,
      applyConfirmation: args.apply,
    });
    process.stdout.write(`${JSON.stringify(applied)}\n`);
    return applied;
  }
  const result = await withEphemeralMemorySource({
    brainDir: targetBrainRoot,
    home23Root,
    requesterAgent,
    prefix: 'provenance-audit',
  }, async (source) => auditPinnedBrainProvenance({
    source,
    home23Root,
    requesterAgent,
    targetBrainRoot,
    outputFile: args.output ? path.resolve(args.output) : null,
    maxHighActivation: args['max-high-activation'] ? Number(args['max-high-activation']) : 200,
    maxPerRiskStratum: args['max-risk-per-stratum'] ? Number(args['max-risk-per-stratum']) : 50,
  }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPLY_CONFIRMATION,
  APPLY_INTENT_SCHEMA,
  APPLY_RECEIPT_SCHEMA,
  AUDIT_SCHEMA,
  AUDIT_RECEIPT_SCHEMA,
  applyPinnedBrainProvenanceAudit,
  auditPinnedBrainProvenance,
  main,
};
