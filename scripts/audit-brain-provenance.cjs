#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  withEphemeralMemorySource,
} = require('../shared/memory-source/operation-context.cjs');
const authorityProfile = require('../engine/src/memory/provenance-salience.js');

const AUDIT_SCHEMA = 'home23.brain-provenance-audit.v1';
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
    .map((node) => auditRecord(node, { revision, generation, target, now }));
  const outputParentBinding = captureDirectoryBinding(path.dirname(finalOutput));
  assertDirectoryBinding(outputParentBinding, 'audit output directory');
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error('audit output confinement requires O_NOFOLLOW');
  }
  const fd = fs.openSync(
    finalOutput,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
        || path.dirname(fs.realpathSync(finalOutput)) !== outputParentBinding.path) {
      throw new Error('audit output escaped requester-owned runtime');
    }
    assertDirectoryBinding(outputParentBinding, 'audit output directory');
    for (const row of rows) fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    fs.fsyncSync(fd);
    assertDirectoryBinding(outputParentBinding, 'audit output directory');
  } finally {
    fs.closeSync(fd);
  }

  return Object.freeze({
    schema: AUDIT_SCHEMA,
    sourceRevision: revision,
    sourceGeneration: generation,
    scanned,
    recordsWritten: rows.length,
    riskCounts: Object.fromEntries(Object.entries(risks).map(([key, heap]) => [key, heap.values().length])),
    outputFile: finalOutput,
    dryRun: true,
  });
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

function auditRecord(node, { revision, generation, target, now }) {
  const stored = storedProfile(node);
  const proposedAuthorityClass = classifyAuthority(node);
  const proposedRetrievalDomain = classifyDomain(node);
  const sourceChain = projectSourceChain(node);
  const missingEvidence = missingEvidenceFor(node, proposedAuthorityClass, sourceChain);
  const reasons = [];
  if (!stored) reasons.push('missing_node_provenance');
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

function classifyAuthority(node) {
  const directChain = fallbackSourceChain(node);
  if (isGenerated(node)) {
    const adopted = directChain.evidenceRefs.some((ref) => ref.startsWith('adopted-doctrine-receipt:'));
    return adopted ? 'generated_doctrine' : 'narrative';
  }
  if (typeof authorityProfile.classifyClaimAuthority === 'function') {
    const projected = authorityProfile.classifyClaimAuthority(node);
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
  const stored = storedProfile(node);
  if (hasTag(node, 'jtr-correction', 'jtr_correction', 'owner-correction')) return 'jtr_correction';
  if (stored?.authorityClass === 'verified_current_state'
      && directChain.evidenceRefs.some((ref) => ref.startsWith('verifier:'))) {
    return 'verified_current_state';
  }
  if (hasTag(node, 'worker-receipt', 'worker_receipt')) return 'worker_receipt';
  if (directChain.sourceRefs.length || directChain.evidenceRefs.length) return 'artifact_log';
  return 'narrative';
}

function classifyDomain(node) {
  if (typeof authorityProfile.classifyMemoryDomain === 'function') {
    const projected = authorityProfile.classifyMemoryDomain(node);
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

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`value required for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const home23Root = path.resolve(args['home23-root'] || path.join(__dirname, '..'));
  const requesterAgent = args.requester;
  if (!requesterAgent) throw new Error('--requester is required');
  const targetAgent = args['target-agent'] || requesterAgent;
  const targetBrainRoot = args['brain-dir']
    ? path.resolve(args['brain-dir'])
    : path.join(home23Root, 'instances', safeSegment(targetAgent, 'target agent'), 'brain');
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
  AUDIT_SCHEMA,
  auditPinnedBrainProvenance,
  main,
};
