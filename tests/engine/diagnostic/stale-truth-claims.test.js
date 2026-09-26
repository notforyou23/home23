import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const staleTruthClaims = require('../../../engine/src/diagnostic/checks/stale-truth-claims.js');

test("a '~/...' claim source resolves under the owner home, not the Host's runtime HOME", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-stale-truth-'));
  const keys = ['HOME', 'HOME23_OWNER_HOME', 'HOME23_PRODUCT_HOST'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const owner = path.join(root, 'owner');
  const runtime = path.join(root, 'runtime-user');
  const brainDir = path.join(root, 'brain');
  for (const dir of [owner, runtime, path.join(brainDir, 'agency')]) fs.mkdirSync(dir, { recursive: true });
  // Only the Home23 runtime HOME has the "gone" file; the owner's is missing.
  fs.writeFileSync(path.join(owner, 'plan.md'), 'current\n');
  fs.writeFileSync(path.join(runtime, 'gone.md'), 'runtime copy\n');
  Object.assign(process.env, { HOME: runtime, HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true' });
  const claim = (id, sourceRef) => JSON.stringify({ id, status: 'current', claim: id, sourceRef, acceptedAt: '2020-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(brainDir, 'agency', 'truth.jsonl'), `${claim('kept', '~/plan.md')}\n${claim('lost', '~/gone.md')}\n`);

  const result = await staleTruthClaims.run({ brainDir });

  assert.equal(result.ok, true);
  const byCode = Object.fromEntries(result.findings.map((finding) => [finding.code, finding]));
  assert.equal(byCode.truth_claim_source_modified.evidence.claimId, 'kept');
  assert.equal(byCode.truth_claim_source_missing.evidence.claimId, 'lost');
  assert.match(byCode.truth_claim_source_missing.message, new RegExp(`references ${path.join(owner, 'gone.md').replaceAll('.', '\\.')} `));
});
