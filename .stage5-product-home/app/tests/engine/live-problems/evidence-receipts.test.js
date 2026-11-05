import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');

test('LiveProblemStore writes evidence.v1 receipt when verifier resolves a live problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problem-evidence-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir, logger: { info() {}, warn() {} } });
    store.upsert({
      id: 'good_life_test_problem',
      claim: 'Good Life test problem',
      seedOrigin: 'good-life',
      verifier: { type: 'file_exists', args: { path: '/tmp/example' } },
      remediation: [],
    });

    store.recordVerification('good_life_test_problem', {
      ok: true,
      detail: 'verified fixed',
      observed: { source: 'test' },
    });

    const indexPath = join(dir, 'evidence', 'live-problems.jsonl');
    assert.equal(existsSync(indexPath), true);
    const index = JSON.parse(readFileSync(indexPath, 'utf8').trim());
    const receipt = JSON.parse(readFileSync(index.path, 'utf8'));

    assert.equal(receipt.receiptVersion, 'evidence.v1');
    assert.equal(receipt.action, 'resolve_live_problem');
    assert.equal(receipt.subject, 'live-problem/good_life_test_problem');
    assert.equal(receipt.result, 'pass');
    assert.equal(receipt.claimLevel, 'verified_claim');
    assert.equal(receipt.checks.find(c => c.name === 'verifier_pass')?.pass, true);
    assert.equal(receipt.checks.find(c => c.name === 'state_resolved')?.pass, true);
    assert.equal(receipt.metadata.seedOrigin, 'good-life');
    assert.equal(store.get('good_life_test_problem').evidence.receiptId, receipt.receiptId);
    assert.equal(store.get('good_life_test_problem').evidence.result, 'pass');
    assert.equal(store.get('good_life_test_problem').evidence.claimLevel, 'verified_claim');
    assert.equal(store.get('good_life_test_problem').evidence.receiptPath, index.path);

    const events = readFileSync(join(dir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const fixed = events.find(e => e.event_type === 'live_problem.fixed');
    assert.ok(fixed);
    assert.equal(fixed.payload.schema, 'home23.state-event.v1');
    assert.equal(fixed.payload.subject, 'live-problem/good_life_test_problem');
    assert.equal(fixed.payload.evidence.receiptId, receipt.receiptId);

    const trustEvents = readFileSync(join(dir, 'trust', 'claims.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const verified = trustEvents.find(e => e.eventType === 'claim.verified');
    assert.ok(verified);
    assert.equal(verified.claim.id, 'live-problem.good_life_test_problem.fixed');
    assert.equal(verified.claim.status, 'known_verified');
    assert.equal(verified.claim.evidenceRefs[0].receiptId, receipt.receiptId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
