'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const provenanceAudit = require('../../scripts/audit-brain-provenance.cjs');
const {
  auditPinnedBrainProvenance,
  main,
} = provenanceAudit;

test('first-rollout provenance CLI rejects apply mode before opening a source', async () => {
  await assert.rejects(
    () => main(['--apply', 'true', '--requester', 'requester']),
    /first rollout is dry-run-only; CLI apply is disabled/,
  );
});

test('first-rollout provenance module exposes no apply capability', () => {
  assert.equal(provenanceAudit.applyPinnedBrainProvenanceAudit, undefined);
  assert.equal(provenanceAudit.APPLY_RECEIPT_SCHEMA, undefined);
});

test('provenance audit is bounded, includes mandatory risk strata, and writes only requester-owned output', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-audit-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  const requesterRoot = path.join(home23Root, 'instances', 'requester', 'runtime');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.mkdirSync(requesterRoot, { recursive: true });

  const nodes = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `high-${index}`,
      concept: `high activation artifact ${index}`,
      activation: 100 - index,
      metadata: {
        provenance: {
          schema: 'home23.node-provenance.v1',
          authorityClass: 'artifact_log',
          retrievalDomain: 'project_history',
          sourceRefs: [`file:/artifact-${index}`],
          evidenceRefs: [`sha256:${index}`],
        },
      },
    })),
    {
      id: 'risk-report-only', concept: 'generated report claims the live service is healthy', activation: 0.01,
      metadata: { provenance: {
        schema: 'home23.node-provenance.v1',
        generationMethod: 'reflection_synthesis',
        authorityClass: 'verified_current_state',
        operationalAuthority: true,
      } },
      tag: ['generated-report', 'current-state'],
    },
    {
      id: 'risk-unverified-current', concept: 'current machine state without evidence', activation: 0.02,
      metadata: { provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'verified_current_state',
        operationalAuthority: true,
      } },
      tag: ['current-state'],
    },
  ];
  const source = {
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 44 },
    revision: 44,
    getEvidence: () => ({ implementation: 'manifest-v1', sourceRevision: 44, generation: 'g1' }),
    async *iterateNodes() { for (const node of nodes) yield node; },
    query() { throw new Error('query mutation/read path forbidden'); },
    recordAccess() { throw new Error('access mutation forbidden'); },
    patchNode() { throw new Error('node mutation forbidden'); },
  };

  const result = await auditPinnedBrainProvenance({
    source,
    home23Root,
    requesterAgent: 'requester',
    targetBrainRoot: brainRoot,
    maxHighActivation: 3,
    maxPerRiskStratum: 1,
    now: '2026-07-14T12:00:00.000Z',
  });

  assert.equal(result.schema, 'home23.brain-provenance-audit.v1');
  assert.equal(result.receiptSchema, 'home23.brain-provenance-audit-receipt.v1');
  assert.equal(result.firstRolloutDryRunOnly, true);
  assert.equal(result.applyCapability, 'none-first-rollout-dry-run-only');
  assert.equal(result.sourceRevision, 44);
  assert.ok(result.recordsWritten <= 6, `expected bounded output, got ${result.recordsWritten}`);
  assert.ok(result.outputFile.startsWith(`${fs.realpathSync(requesterRoot)}${path.sep}`));
  assert.equal(result.outputFile.startsWith(`${fs.realpathSync(brainRoot)}${path.sep}`), false);
  const rows = fs.readFileSync(result.outputFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.nodeId === 'risk-report-only'));
  assert.ok(rows.some((row) => row.nodeId === 'risk-unverified-current'));
  const reportOnly = rows.find((row) => row.nodeId === 'risk-report-only');
  const unverifiedCurrent = rows.find((row) => row.nodeId === 'risk-unverified-current');
  assert.equal(reportOnly.proposedAuthorityClass, 'narrative');
  assert.notEqual(unverifiedCurrent.proposedAuthorityClass, 'verified_current_state');
  assert.ok(unverifiedCurrent.missingEvidence.includes('verifier_evidence'));
  assert.ok(unverifiedCurrent.reasons.includes('attestation_missing'));
  for (const row of rows) {
    assert.equal(row.schema, 'home23.brain-provenance-audit.v1');
    assert.equal(row.sourceRevision, 44);
    assert.equal(row.sourceGeneration, 'g1');
    assert.match(row.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(row.proposedAuthorityClass);
    assert.ok(row.proposedRetrievalDomain);
    assert.ok(Array.isArray(row.reasons));
    assert.ok(Array.isArray(row.missingEvidence));
    assert.equal(typeof row.reviewRequired, 'boolean');
  }
});

test('provenance audit rejects output outside requester runtime and never rewrites target brain', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-boundary-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  const sentinel = path.join(brainRoot, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  const source = {
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 1 },
    revision: 1,
    getEvidence: () => ({ sourceRevision: 1, generation: 'g1' }),
    async *iterateNodes() { yield { id: 'n1', concept: 'test', activation: 1 }; },
  };

  await assert.rejects(() => auditPinnedBrainProvenance({
    source,
    home23Root,
    requesterAgent: 'requester',
    targetBrainRoot: brainRoot,
    outputFile: path.join(brainRoot, 'forbidden.jsonl'),
  }), /requester-owned runtime|canonical nonsymlink/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
});

test('provenance audit rejects a requester output directory symlinked into the target brain', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-symlink-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  const requesterRuntime = path.join(home23Root, 'instances', 'requester', 'runtime');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.mkdirSync(requesterRuntime, { recursive: true });
  fs.symlinkSync(brainRoot, path.join(requesterRuntime, 'brain-provenance-audits'));
  const source = {
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 1 },
    revision: 1,
    async *iterateNodes() { yield { id: 'n1', concept: 'test', activation: 1 }; },
  };

  await assert.rejects(() => auditPinnedBrainProvenance({
    source,
    home23Root,
    requesterAgent: 'requester',
    targetBrainRoot: brainRoot,
    now: '2026-07-14T12:00:00.000Z',
  }), /requester-owned runtime|canonical nonsymlink/);
  assert.deepEqual(fs.readdirSync(brainRoot), []);
});

test('provenance audit binds target, generation, and revision to the pinned source', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-source-bind-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  const otherBrainRoot = path.join(home23Root, 'instances', 'other', 'brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.mkdirSync(otherBrainRoot, { recursive: true });
  const makeSource = (overrides = {}) => ({
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 9, ...overrides.descriptor },
    revision: overrides.revision ?? 9,
    manifest: overrides.manifest || { generation: 'g1', currentRevision: 9 },
    async *iterateNodes() { yield { id: 'n1', concept: 'current status', tag: 'current-state' }; },
  });

  await assert.rejects(() => auditPinnedBrainProvenance({
    source: makeSource(), home23Root, requesterAgent: 'requester', targetBrainRoot: otherBrainRoot,
  }), /own brain|canonical root/);
  await assert.rejects(() => auditPinnedBrainProvenance({
    source: makeSource({ descriptor: { canonicalRoot: otherBrainRoot } }),
    home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
  }), /canonical root/);
  await assert.rejects(() => auditPinnedBrainProvenance({
    source: makeSource({ revision: 10 }), home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
  }), /revision/);
  await assert.rejects(() => auditPinnedBrainProvenance({
    source: makeSource({ manifest: { generation: 'g2', currentRevision: 9 } }),
    home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
  }), /generation/);
});

test('provenance audit refuses requester runtime that resolves outside canonical home', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-runtime-bind-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-runtime-outside-'));
  t.after(() => {
    fs.rmSync(home23Root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const instancesRoot = path.join(home23Root, 'instances');
  const outsideRequester = path.join(outside, 'requester');
  fs.mkdirSync(instancesRoot, { recursive: true });
  fs.mkdirSync(path.join(outsideRequester, 'brain'), { recursive: true });
  fs.symlinkSync(outsideRequester, path.join(instancesRoot, 'requester'));
  const brainRoot = path.join(instancesRoot, 'requester', 'brain');
  const source = {
    descriptor: { canonicalRoot: fs.realpathSync(brainRoot), generation: 'g1', cutoffRevision: 1 },
    revision: 1,
    async *iterateNodes() { yield { id: 'n1', concept: 'test', tag: 'current-state' }; },
  };

  await assert.rejects(() => auditPinnedBrainProvenance({
    source, home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
  }), /own brain|nonsymlink|canonical home/);
  assert.equal(fs.existsSync(path.join(outsideRequester, 'runtime')), false);
});

test('provenance audit selects low-activation legacy operational risk instead of archive noise', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-legacy-risk-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  const nodes = [
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `archive-${index}`,
      concept: `old X digest archive ${index}`,
      activation: 1000 - index,
      tag: 'news',
      metadata: { provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'narrative',
        retrievalDomain: 'external_intake',
      } },
    })),
    {
      id: 'legacy-current-risk',
      concept: 'current engine health is good',
      activation: 0.001,
      tag: 'current-state',
    },
  ];
  const source = {
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 2 },
    revision: 2,
    async *iterateNodes() { for (const node of nodes) yield node; },
  };

  const result = await auditPinnedBrainProvenance({
    source, home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
    maxHighActivation: 2, maxPerRiskStratum: 1, now: '2026-07-14T12:00:00.000Z',
  });
  const rows = fs.readFileSync(result.outputFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.nodeId === 'legacy-current-risk'));
  assert.equal(rows.some((row) => row.nodeId.startsWith('archive-')), false);
  const risk = rows.find((row) => row.nodeId === 'legacy-current-risk');
  assert.ok(risk.missingEvidence.includes('verifier_evidence'));
});

test('provenance audit completes exact writes when the filesystem returns short writes', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-short-write-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  const source = {
    descriptor: { canonicalRoot: brainRoot, generation: 'g1', cutoffRevision: 8 },
    revision: 8,
    async *iterateNodes() {
      yield { id: 'n1', concept: 'current status', tag: 'current-state' };
    },
  };
  const originalWriteSync = fs.writeSync;
  fs.writeSync = function shortWrite(fd, buffer, offset, length, position) {
    if (Buffer.isBuffer(buffer)) {
      return originalWriteSync.call(fs, fd, buffer, offset, Math.min(length, 7), position);
    }
    return originalWriteSync.call(fs, fd, String(buffer).slice(0, 7));
  };
  t.after(() => { fs.writeSync = originalWriteSync; });

  const receipt = await auditPinnedBrainProvenance({
    source, home23Root, requesterAgent: 'requester', targetBrainRoot: brainRoot,
    now: '2026-07-14T12:00:00.000Z',
  });
  fs.writeSync = originalWriteSync;
  const bytes = fs.readFileSync(receipt.outputFile);
  assert.equal(bytes.toString('utf8').trim().split('\n').length, receipt.recordsWritten);
  assert.equal(
    receipt.reportSha256,
    `sha256:${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}`,
  );
});
