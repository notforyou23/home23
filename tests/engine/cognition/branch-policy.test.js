import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BranchPolicyController } = require('../../../engine/src/cognition/branch-policy.js');

test('BranchPolicyController logs enabled web-search branch count, not assignment array length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-branch-policy-'));
  const infos = [];

  try {
    const policy = new BranchPolicyController({ parallelBranches: 1 }, {
      info: (message, data) => infos.push({ message, data }),
      warn() {},
    });
    policy.policyDir = dir;
    policy.policyPath = join(dir, 'branch-policy.json');

    await policy.recordOutcome({
      effortAssignments: ['medium'],
      webSearchAssignments: [0],
      reward: 0,
    });

    assert.equal(infos[0].message, 'Recording branch policy outcome');
    assert.equal(infos[0].data.webSearchCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
