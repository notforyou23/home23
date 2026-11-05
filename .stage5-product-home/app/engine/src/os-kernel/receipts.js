'use strict';

const fs = require('fs');
const path = require('path');
const {
  artifactFromPath,
  buildEvidenceReceipt,
} = require('../evidence/evidence-v1.js');

const SCHEMA_ACTION_RECEIPT = 'home23.os-kernel.action-receipt.v1';

function buildActionReceipt(opts = {}) {
  const {
    brainDir,
    goalId,
    actionClass,
    artifactPath,
    testResult,
    outcome,
    actor,
    createdAt,
  } = opts;

  if (!brainDir) throw new Error('brainDir required');
  if (!goalId) throw new Error('goalId required');
  if (!actionClass) throw new Error('actionClass required');
  if (!artifactPath) throw new Error('artifactPath required');

  const artifact = artifactFromPath(artifactPath, { role: 'deliverable' });
  const created = createdAt || new Date().toISOString();

  const evidence = buildEvidenceReceipt({
    actor: actor || 'os-kernel',
    action: actionClass,
    subject: goalId,
    derivedArtifacts: [artifact],
    checks: [{
      name: 'acceptance_test',
      pass: Boolean(testResult?.ok),
      detail: testResult?.detail,
    }],
    result: outcome,
    metadata: {
      goalId,
      actionClass,
      testResult,
      outcome,
    },
    createdAt: created,
  });

  const id = evidence.receiptId;

  const receipt = {
    schema: SCHEMA_ACTION_RECEIPT,
    id,
    goalId,
    actionClass,
    testResult,
    outcome,
    artifact: {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    evidence,
    createdAt: created,
    updatedAt: created,
  };

  const receiptsDir = path.join(brainDir, 'os-kernel', 'receipts');
  const receiptPath = path.join(receiptsDir, `${id}.json`);
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  return receipt;
}

module.exports = { buildActionReceipt, SCHEMA_ACTION_RECEIPT };
