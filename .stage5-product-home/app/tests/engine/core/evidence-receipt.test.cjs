const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RECEIPT_FILE,
  enforceFullLoop,
  runSelfDiagnosis,
} = require('../../../engine/src/core/evidence-receipt');

function makeBrainDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'home23-evidence-'));
}

test('enforceFullLoop closes early-return cycles with a canonical fixture', () => {
  const brainDir = makeBrainDir();
  const logs = [];

  const result = enforceFullLoop({
    brainDir,
    runId: 'r-test-early',
    prevId: null,
    cycleCount: 42,
    stagesWritten: ['ingest'],
    logger: { info: (message, meta) => logs.push({ message, meta }) },
    fixtureContext: {
      memoryNodeCount: 7,
      goalCount: 2,
      roleId: 'critic',
      oscillatorMode: 'stable',
      energy: 0.75,
    },
  });

  const diagnosis = runSelfDiagnosis(brainDir, 'r-test-early', { cycle: 42 });
  const receipts = fs.readFileSync(path.join(brainDir, RECEIPT_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(diagnosis.learning_proven_durable, true);
  assert.equal(diagnosis.evidence_bundles_generated, 5);
  assert.ok(receipts.some((receipt) => receipt.provenance?.source === 'canonical_nonzero_fixture'));
  assert.equal(result.diagnosis.learning_proven_durable, true);
  assert.equal(logs.at(-1).meta.full_loop_closure, 'COMPLETE — durable learning proven');
});

test('orchestrator full-loop finally uses outer evidence context, not try-scoped role state', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'engine/src/core/orchestrator.js'), 'utf8');
  assert.match(source, /let evidenceRoleId = 'unknown';/);
  assert.match(source, /let evidenceEnergy = 0;/);
  assert.match(source, /evidenceRoleId = role\?\.id \|\| 'unknown';/);
  assert.match(source, /roleId: evidenceRoleId,/);
  assert.match(source, /energy: evidenceEnergy,/);
  assert.doesNotMatch(source, /roleId: role\?\.id \|\| 'unknown'/);
  assert.doesNotMatch(source, /energy: cognitiveState\?\.energy \|\| 0/);
});

test('executive no-viable-goals skip exits before expensive thought generation', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'engine/src/core/orchestrator.js'), 'utf8');
  const skipIdx = source.indexOf("executiveDecision.action === 'SKIP'");
  const idleIdx = source.indexOf("role: 'executive-idle'", skipIdx);
  const returnIdx = source.indexOf('return;', idleIdx);
  const superpositionIdx = source.indexOf('this.quantum.generateSuperposition', skipIdx);

  assert.notEqual(skipIdx, -1);
  assert.notEqual(idleIdx, -1);
  assert.notEqual(returnIdx, -1);
  assert.notEqual(superpositionIdx, -1);
  assert.ok(returnIdx < superpositionIdx);
  assert.match(source.slice(skipIdx, returnIdx), /no\[_ -\]\?viable\[_ -\]\?goals/);
});
