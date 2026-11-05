'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPLY_CONFIRMATION,
  APPLY_RECEIPT_SCHEMA,
  applyPinnedBrainProvenanceAudit,
  auditPinnedBrainProvenance,
  main,
} = require('../../scripts/audit-brain-provenance.cjs');
const { maybeBackup } = require('../../engine/src/core/brain-backups.js');
const {
  appendMemoryRevision,
  openMemorySource,
  rewriteMemoryBase,
} = require('../../shared/memory-source');
const {
  attestMemoryAuthority,
  verifyMemoryAuthorityAttestation,
} = require('../../shared/memory-authority-attestation.cjs');

const SECRET = 'a'.repeat(64);
const CAPABILITY = 'b'.repeat(64);

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(file) {
  return digestBytes(fs.readFileSync(file));
}

function summary(nodes) {
  return { nodeCount: nodes.length, edgeCount: 0, clusterCount: nodes.length ? 1 : 0 };
}

async function fixture(t, overrides = {}) {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-apply-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const brainRoot = path.join(home23Root, 'instances', 'requester', 'brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.writeFileSync(path.join(brainRoot, 'state.json.gz'), 'fixture-state\n');
  fs.writeFileSync(path.join(brainRoot, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const node = {
    id: 'report-only-1',
    concept: 'private operational claim must never enter receipt output',
    tag: 'generated-report',
    tags: ['current-state', 'private'],
    activation: 9,
    embedding: [0.1, 0.2, 0.3],
    cluster: 7,
    topology: { community: 7 },
    metadata: {
      ownerField: { preserve: true },
      provenance: {
        schema: 'home23.node-provenance.v1',
        generationMethod: 'reflection_synthesis',
        authorityClass: 'verified_current_state',
        retrievalDomain: 'current_ops',
      },
    },
    ...overrides.node,
  };
  overrides.mutateNode?.(node);
  const base = await rewriteMemoryBase(brainRoot, {
    nodes: [node],
    edges: [],
    summary: summary([node]),
  }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') });
  const source = await openMemorySource(brainRoot);
  const audit = await auditPinnedBrainProvenance({
    source,
    home23Root,
    requesterAgent: 'requester',
    targetBrainRoot: brainRoot,
    now: '2026-07-15T12:00:00.000Z',
    authorityKey: SECRET,
  });
  await source.close();
  const backup = await maybeBackup(brainRoot, {
    force: true,
    retention: 2,
    home23Root,
    requesterAgent: 'requester',
    minFreeBytes: 0,
  });
  assert.equal(backup.created, true);
  const backupReceiptFile = path.join(
    brainRoot, 'backups', backup.backupName, 'backup-manifest.json',
  );
  return {
    home23Root,
    brainRoot,
    node,
    base,
    reportFile: audit.outputFile,
    reportSha256: audit.reportSha256,
    backupReceiptFile,
    backupReceiptSha256: digestFile(backupReceiptFile),
  };
}

async function applyFixture(fx, overrides = {}) {
  return applyPinnedBrainProvenanceAudit({
    home23Root: fx.home23Root,
    requesterAgent: 'requester',
    targetBrainRoot: fx.brainRoot,
    reportFile: fx.reportFile,
    reportSha256: fx.reportSha256,
    backupReceiptFile: fx.backupReceiptFile,
    backupReceiptSha256: fx.backupReceiptSha256,
    applyConfirmation: APPLY_CONFIRMATION,
    now: '2026-07-15T13:00:00.000Z',
    authorityKey: SECRET,
    ...overrides,
  });
}

async function readOnlyNode(brainRoot, id = 'report-only-1') {
  const source = await openMemorySource(brainRoot);
  try {
    for await (const node of source.iterateNodes()) {
      if (String(node.id) === id) return node;
    }
    return null;
  } finally {
    await source.close();
  }
}

test('guarded apply patches metadata only, quarantines report-only claims, and writes a create-new receipt', async (t) => {
  const fx = await fixture(t);
  const before = await readOnlyNode(fx.brainRoot);
  const result = await applyFixture(fx);
  const after = await readOnlyNode(fx.brainRoot);

  assert.equal(result.schema, APPLY_RECEIPT_SCHEMA);
  assert.equal(result.applied, true);
  assert.equal(result.beforeGeneration, fx.base.manifest.generation);
  assert.equal(result.beforeRevision, fx.base.manifest.currentRevision);
  assert.equal(result.afterGeneration, fx.base.manifest.generation);
  assert.equal(result.afterRevision, fx.base.manifest.currentRevision + 1);
  assert.deepEqual(result.patchedNodeIds, ['report-only-1']);
  assert.equal(result.patchedNodeCount, 1);
  assert.equal(result.casResult, 'committed');
  assert.equal(fs.lstatSync(result.receiptFile).isSymbolicLink(), false);

  const preservedBefore = structuredClone(before);
  const preservedAfter = structuredClone(after);
  delete preservedBefore.metadata.provenance;
  delete preservedAfter.metadata.provenance;
  assert.deepEqual(preservedAfter, preservedBefore);
  assert.equal(after.metadata.provenance.authorityClass, 'narrative');
  assert.equal(after.metadata.provenance.retrievalDomain, 'current_ops');
  assert.equal(after.metadata.provenance.authorityStatus, 'quarantine_pending_verification');
  assert.deepEqual(after.metadata.provenance.sourceRefs, []);
  assert.deepEqual(after.metadata.provenance.evidenceRefs, []);
  assert.equal(verifyMemoryAuthorityAttestation(after, SECRET), false);
  assert.equal(after.metadata.provenance.attestation, undefined);

  const receiptBytes = fs.readFileSync(result.receiptFile);
  const receiptLines = receiptBytes.toString('utf8').trim().split('\n');
  assert.equal(receiptLines.length, 2);
  const receipt = JSON.parse(receiptLines[1]);
  assert.equal(receipt.schema, APPLY_RECEIPT_SCHEMA);
  assert.equal(receipt.inputReportSha256, fx.reportSha256);
  assert.equal(receipt.backupReceiptSha256, fx.backupReceiptSha256);
  assert.match(receipt.backupIdentity, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(receipt.patchedNodeIds, ['report-only-1']);
  assert.equal(receipt.receiptSha256, undefined);
  const serialized = JSON.stringify({ result, receipt });
  assert.equal(serialized.includes(fx.node.concept), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(CAPABILITY), false);
});

test('apply never truncates exact stored provenance refs to the bounded report projection', async (t) => {
  const sourceRefs = Array.from({ length: 12 }, (_, index) => `artifact:source-${index}`);
  const evidenceRefs = Array.from({ length: 12 }, (_, index) => `evidence:receipt-${index}`);
  const fx = await fixture(t, {
    mutateNode(node) {
      node.metadata.provenance.sourceRefs = sourceRefs;
      node.metadata.provenance.evidenceRefs = evidenceRefs;
    },
  });
  const row = JSON.parse(fs.readFileSync(fx.reportFile, 'utf8'));
  assert.ok(row.sourceChain.sourceRefs.length < sourceRefs.length);
  assert.ok(row.sourceChain.evidenceRefs.length < evidenceRefs.length);
  await applyFixture(fx);
  const after = await readOnlyNode(fx.brainRoot);
  assert.deepEqual(after.metadata.provenance.sourceRefs, sourceRefs);
  assert.deepEqual(after.metadata.provenance.evidenceRefs, evidenceRefs);
});

test('apply never shadows exact snake_case provenance refs with bounded camelCase aliases', async (t) => {
  const sourceRefs = Array.from({ length: 12 }, (_, index) => `artifact:snake-source-${index}`);
  const evidenceRefs = Array.from({ length: 12 }, (_, index) => `evidence:snake-receipt-${index}`);
  const fx = await fixture(t, {
    mutateNode(node) {
      node.metadata.provenance.source_refs = sourceRefs;
      node.metadata.provenance.evidence_refs = evidenceRefs;
      node.metadata.provenance.trace_id = 'trace:exact-snake';
      node.metadata.provenance.generation_method = 'reflection_synthesis';
      delete node.metadata.provenance.generationMethod;
    },
  });
  await applyFixture(fx);
  const after = await readOnlyNode(fx.brainRoot);
  assert.deepEqual(after.metadata.provenance.source_refs, sourceRefs);
  assert.deepEqual(after.metadata.provenance.evidence_refs, evidenceRefs);
  assert.equal(after.metadata.provenance.sourceRefs, undefined);
  assert.equal(after.metadata.provenance.evidenceRefs, undefined);
  assert.equal(after.metadata.provenance.traceId, undefined);
  assert.equal(after.metadata.provenance.generationMethod, undefined);
});

test('apply never shadows exact legacy node provenance or evidence-link refs', async (t) => {
  const sourceRefs = Array.from({ length: 12 }, (_, index) => `artifact:legacy-source-${index}`);
  const evidenceRefs = Array.from({ length: 12 }, (_, index) => `evidence:legacy-receipt-${index}`);
  const fx = await fixture(t, {
    mutateNode(node) {
      node.provenance = {
        source_refs: sourceRefs,
        trace_id: 'trace:legacy-exact',
        generation_method: 'reflection_synthesis',
      };
      node.evidence = { evidence_links: evidenceRefs };
      delete node.metadata.provenance.generationMethod;
    },
  });
  await applyFixture(fx);
  const after = await readOnlyNode(fx.brainRoot);
  assert.deepEqual(after.provenance.source_refs, sourceRefs);
  assert.deepEqual(after.evidence.evidence_links, evidenceRefs);
  assert.equal(after.metadata.provenance.sourceRefs, undefined);
  assert.equal(after.metadata.provenance.evidenceRefs, undefined);
  assert.equal(after.metadata.provenance.traceId, undefined);
  assert.equal(after.metadata.provenance.generationMethod, undefined);
});

test('apply never re-signs authenticated authority and missing verifier key fails safely', async (t) => {
  const fx = await fixture(t, {
    mutateNode(node) {
      node.tag = 'current-state';
      node.tags = ['current-state'];
      node.metadata.provenance = {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'verified_current_state',
        retrievalDomain: 'current_ops',
        evidenceRefs: ['verifier:fixture'],
        sourceRefs: ['artifact:fixture'],
      };
      attestMemoryAuthority(node, SECRET);
    },
  });
  const before = await readOnlyNode(fx.brainRoot);
  const manifestBefore = fs.readFileSync(path.join(fx.brainRoot, 'memory-manifest.json'));
  assert.equal(verifyMemoryAuthorityAttestation(before, SECRET), true);
  await assert.rejects(
    () => applyFixture(fx, { authorityKey: null }),
    /projection|classification|justified/,
  );
  assert.equal(verifyMemoryAuthorityAttestation(await readOnlyNode(fx.brainRoot), SECRET), true);

  const result = await applyFixture(fx);
  assert.equal(result.casResult, 'safe-no-op');
  assert.equal(result.patchedNodeCount, 0);
  assert.equal(result.afterRevision, result.beforeRevision);
  const after = await readOnlyNode(fx.brainRoot);
  assert.deepEqual(after, before);
  assert.deepEqual(
    fs.readFileSync(path.join(fx.brainRoot, 'memory-manifest.json')),
    manifestBefore,
  );
  assert.equal(verifyMemoryAuthorityAttestation(after, SECRET), true);
});

test('apply is own-brain-only and requires exact requester target and audit-directory report binding', async (t) => {
  const fx = await fixture(t);
  const otherBrain = path.join(fx.home23Root, 'instances', 'other', 'brain');
  fs.mkdirSync(otherBrain, { recursive: true });
  await assert.rejects(
    () => applyFixture(fx, { requesterAgent: 'other' }),
    /own brain|requester|audit directory/,
  );
  await assert.rejects(
    () => applyFixture(fx, { targetBrainRoot: otherBrain }),
    /own brain|target/,
  );
  const copied = path.join(fx.home23Root, 'copied-report.jsonl');
  fs.copyFileSync(fx.reportFile, copied);
  await assert.rejects(
    () => applyFixture(fx, { reportFile: copied }),
    /audit directory|requester-owned/,
  );
});

test('apply verifies exact report digest, complete readback, schema, unique IDs, and one source', async (t) => {
  const fx = await fixture(t);
  const original = fs.readFileSync(fx.reportFile, 'utf8');
  fs.appendFileSync(fx.reportFile, '{}\n');
  await assert.rejects(() => applyFixture(fx), /report digest mismatch/);
  fs.writeFileSync(fx.reportFile, original.slice(0, -1));
  await assert.rejects(
    () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
    /truncated|newline/,
  );
  const row = JSON.parse(original.trim());
  fs.writeFileSync(fx.reportFile, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
    /duplicate node/i,
  );
  const mixed = { ...row, nodeId: 'other-id', sourceGeneration: 'other-generation' };
  fs.writeFileSync(fx.reportFile, `${JSON.stringify(row)}\n${JSON.stringify(mixed)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
    /mixed source|generation/,
  );
  const unsupported = { ...row, schema: 'home23.brain-provenance-audit.v999' };
  fs.writeFileSync(fx.reportFile, `${JSON.stringify(unsupported)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
    /unsupported.*schema/i,
  );
});

test('apply recomputes the justified projection and rejects forged authority, verifier proof, or source chain', async (t) => {
  const fx = await fixture(t);
  const row = JSON.parse(fs.readFileSync(fx.reportFile, 'utf8'));
  row.proposedAuthorityClass = 'verified_current_state';
  row.proposedAuthorityStatus = 'eligible';
  row.sourceChain.evidenceRefs = ['verifier:forged'];
  row.missingEvidence = [];
  fs.writeFileSync(fx.reportFile, `${JSON.stringify(row)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
    /projection|classification|source chain|justified/i,
  );
  const unchanged = await readOnlyNode(fx.brainRoot);
  assert.equal(unchanged.metadata.provenance.authorityClass, 'verified_current_state');
  assert.equal(unchanged.metadata.provenance.evidenceRefs, undefined);
});

test('apply rejects symlinked report and path escape without mutating the manifest', async (t) => {
  const fx = await fixture(t);
  const before = fs.readFileSync(path.join(fx.brainRoot, 'memory-manifest.json'));
  const realReport = `${fx.reportFile}.real`;
  fs.renameSync(fx.reportFile, realReport);
  fs.symlinkSync(realReport, fx.reportFile);
  await assert.rejects(() => applyFixture(fx), /symlink|regular file|audit directory/);
  assert.deepEqual(fs.readFileSync(path.join(fx.brainRoot, 'memory-manifest.json')), before);
});

test('apply requires and fully verifies a coherent matching backup receipt', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    () => applyFixture(fx, { backupReceiptFile: undefined }),
    /backup receipt.*required/,
  );
  const manifest = JSON.parse(fs.readFileSync(fx.backupReceiptFile, 'utf8'));
  manifest.revision += 1;
  fs.writeFileSync(fx.backupReceiptFile, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { backupReceiptSha256: digestFile(fx.backupReceiptFile) }),
    /backup.*revision|backup.*source/,
  );
});

test('apply rejects a backup receipt that omits any authoritative manifest-v1 source file', async (t) => {
  const fx = await fixture(t);
  const receipt = JSON.parse(fs.readFileSync(fx.backupReceiptFile, 'utf8'));
  const manifestRecord = receipt.fileRecords.find((record) => record.file === 'memory-manifest.json');
  receipt.files = ['memory-manifest.json'];
  receipt.fileRecords = [manifestRecord];
  receipt.copiedBytes = manifestRecord.bytes;
  fs.writeFileSync(fx.backupReceiptFile, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    () => applyFixture(fx, { backupReceiptSha256: digestFile(fx.backupReceiptFile) }),
    /backup.*authoritative|backup.*required|backup.*file set/i,
  );
});

test('apply rejects a backup root symlinked outside the requester brain', async (t) => {
  const fx = await fixture(t);
  const backupsRoot = path.join(fx.brainRoot, 'backups');
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-provenance-backup-outside-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const movedBackups = path.join(outsideRoot, 'backups');
  fs.renameSync(backupsRoot, movedBackups);
  fs.symlinkSync(movedBackups, backupsRoot);
  await assert.rejects(
    () => applyFixture(fx),
    /backup.*canonical|backup.*symlink|backup.*brain/i,
  );
});

test('apply retains a durable backup guard through the CAS boundary', async (t) => {
  const fx = await fixture(t);
  const copiedManifest = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fx.backupReceiptFile), 'memory-manifest.json'),
    'utf8',
  ));
  const requiredBackupFile = path.join(
    path.dirname(fx.backupReceiptFile), copiedManifest.activeBase.nodes.file,
  );
  const result = await applyFixture(fx, {
    beforeCommit: async () => { fs.unlinkSync(requiredBackupFile); },
  });
  assert.equal(result.applied, true);
  assert.match(result.backupGuardIdentity, /^sha256:[a-f0-9]{64}$/);
  const auditsRoot = path.dirname(result.receiptFile);
  const guards = fs.readdirSync(auditsRoot).filter((name) => name.startsWith('.provenance-backup-guard-'));
  assert.equal(guards.length, 1);
  assert.equal(fs.existsSync(path.join(auditsRoot, guards[0], path.basename(requiredBackupFile))), true);
});

test('post-CAS receipt publication failure retains a durable reconciliation intent', async (t) => {
  const fx = await fixture(t);
  let error;
  try {
    await applyFixture(fx, {
      beforeReceiptPublication: async () => { throw new Error('injected receipt publication failure'); },
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, 'apply_receipt_reconciliation_required');
  assert.equal(error?.committed, true);
  const stored = await readOnlyNode(fx.brainRoot);
  assert.equal(stored.metadata.provenance.authorityStatus, 'quarantine_pending_verification');
  const auditsRoot = path.join(
    fs.realpathSync(fx.home23Root), 'instances', 'requester', 'runtime', 'brain-provenance-audits',
  );
  const intents = fs.readdirSync(auditsRoot).filter((name) => name.startsWith('provenance-apply-'));
  assert.equal(intents.length, 1);
  const intent = JSON.parse(fs.readFileSync(path.join(auditsRoot, intents[0]), 'utf8'));
  assert.equal(intent.schema, 'home23.brain-provenance-apply-intent.v1');
  assert.equal(intent.state, 'prepared');
  assert.equal(intent.inputReportSha256, fx.reportSha256);
  await assert.rejects(() => applyFixture(fx), /EEXIST|replay|receipt|source|revision/i);
});

test('receipt pathname swap after validation never overwrites a foreign file', async (t) => {
  const fx = await fixture(t);
  const auditsRoot = path.join(
    fs.realpathSync(fx.home23Root), 'instances', 'requester', 'runtime', 'brain-provenance-audits',
  );
  const receiptFile = path.join(auditsRoot, 'provenance-apply-path-swap.jsonl');
  const movedIntentFile = `${receiptFile}.moved`;
  const foreignBytes = Buffer.from('foreign receipt owner\n', 'utf8');
  let hookCalled = false;
  let error;
  try {
    await applyFixture(fx, {
      applyReceiptFile: receiptFile,
      beforeOutcomeAppend: () => {
        hookCalled = true;
        fs.renameSync(receiptFile, movedIntentFile);
        fs.writeFileSync(receiptFile, foreignBytes, { flag: 'wx' });
      },
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(hookCalled, true);
  assert.equal(error?.code, 'apply_receipt_reconciliation_required');
  assert.equal(error?.committed, true);
  assert.deepEqual(fs.readFileSync(receiptFile), foreignBytes);
  const intentLines = fs.readFileSync(movedIntentFile, 'utf8').trim().split('\n');
  assert.equal(intentLines.length, 2);
  assert.equal(JSON.parse(intentLines[0]).schema, 'home23.brain-provenance-apply-intent.v1');
  assert.equal(JSON.parse(intentLines[1]).schema, APPLY_RECEIPT_SCHEMA);
  const stored = await readOnlyNode(fx.brainRoot);
  assert.equal(stored.metadata.provenance.authorityStatus, 'quarantine_pending_verification');
});

test('receipt unlink after validation retains a discoverable reconciliation ledger', async (t) => {
  const fx = await fixture(t);
  const auditsRoot = path.join(
    fs.realpathSync(fx.home23Root), 'instances', 'requester', 'runtime', 'brain-provenance-audits',
  );
  const receiptFile = path.join(auditsRoot, 'provenance-apply-unlink.jsonl');
  let error;
  try {
    await applyFixture(fx, {
      applyReceiptFile: receiptFile,
      beforeOutcomeAppend: () => fs.unlinkSync(receiptFile),
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.code, 'apply_receipt_reconciliation_required');
  assert.equal(error?.committed, true);
  assert.equal(fs.existsSync(receiptFile), false);
  assert.equal(typeof error?.recoveryLedgerFile, 'string');
  assert.equal(fs.existsSync(error.recoveryLedgerFile), true);
  const recoveryLines = fs.readFileSync(error.recoveryLedgerFile, 'utf8').trim().split('\n');
  assert.equal(recoveryLines.length, 2);
  assert.equal(JSON.parse(recoveryLines[0]).schema, 'home23.brain-provenance-apply-intent.v1');
  assert.equal(JSON.parse(recoveryLines[1]).schema, APPLY_RECEIPT_SCHEMA);
  const stored = await readOnlyNode(fx.brainRoot);
  assert.equal(stored.metadata.provenance.authorityStatus, 'quarantine_pending_verification');
});

test('apply rejects generation or revision drift before writing', async (t) => {
  const revisionDrift = await fixture(t);
  await appendMemoryRevision(revisionDrift.brainRoot, {
    nodes: [{ id: 'new-revision', concept: 'unrelated concurrent revision' }],
  }, { lockRoot: path.join(revisionDrift.home23Root, 'runtime', 'brain-source-locks') });
  await assert.rejects(() => applyFixture(revisionDrift), /source|revision|generation/i);

  const generationDrift = await fixture(t);
  await rewriteMemoryBase(generationDrift.brainRoot, {
    nodes: [generationDrift.node], edges: [], summary: summary([generationDrift.node]),
  }, { lockRoot: path.join(generationDrift.home23Root, 'runtime', 'brain-source-locks') });
  await assert.rejects(() => applyFixture(generationDrift), /source|revision|generation/i);
});

test('apply compares selected node content, durable identity, and exact before-profile', async (t) => {
  for (const field of ['contentHash', 'beforeNodeHash', 'beforeProfileHash']) {
    const fx = await fixture(t);
    const row = JSON.parse(fs.readFileSync(fx.reportFile, 'utf8'));
    row[field] = field === 'contentHash' ? '0'.repeat(64) : `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(fx.reportFile, `${JSON.stringify(row)}\n`);
    await assert.rejects(
      () => applyFixture(fx, { reportSha256: digestFile(fx.reportFile) }),
      /content|identity|profile|node/i,
    );
  }
});

test('concurrent writer wins CAS and apply reports typed non-success without false receipt', async (t) => {
  const fx = await fixture(t);
  let raced = false;
  const receiptPath = path.join(
    fx.home23Root, 'instances', 'requester', 'runtime', 'brain-provenance-audits',
    'forced-apply-receipt.json',
  );
  await assert.rejects(() => applyFixture(fx, {
    applyReceiptFile: receiptPath,
    beforeCommit: async () => {
      raced = true;
      await appendMemoryRevision(fx.brainRoot, {
        nodes: [{ id: 'concurrent', concept: 'concurrent writer' }],
      }, { lockRoot: path.join(fx.home23Root, 'runtime', 'brain-source-locks') });
    },
  }), (error) => {
    assert.equal(error.code, 'source_changed');
    return true;
  });
  assert.equal(raced, true);
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal((await readOnlyNode(fx.brainRoot)).metadata.provenance.authorityStatus, undefined);
});

test('successful apply cannot be replayed and create-new receipt cannot be overwritten', async (t) => {
  const fx = await fixture(t);
  const first = await applyFixture(fx);
  const originalReceipt = fs.readFileSync(first.receiptFile);
  await assert.rejects(() => applyFixture(fx), /source changed|revision|replay/i);
  assert.deepEqual(fs.readFileSync(first.receiptFile), originalReceipt);
});

test('CLI apply requires every durable receipt argument and keeps dry-run as default', async () => {
  await assert.rejects(
    () => main(['--apply', APPLY_CONFIRMATION, '--requester', 'requester']),
    /--report.*required|--report-sha256.*required|--backup-receipt.*required/,
  );
  await assert.rejects(
    () => main(['--requester', 'missing-fixture-agent']),
    /ENOENT|no such file|canonical/i,
  );
});
