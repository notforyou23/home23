import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { EventLedgerTailAdapter } from '../../substrate/src/adapters/event-ledger-tail.js';
const { EventLedger: EngineLedger } = createRequire(import.meta.url)('../../engine/src/core/event-ledger.js');

test('both original writers version only newly appended experience; historical lines stay byte identical', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'prospective-learning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'event-ledger.jsonl');
  const old = JSON.stringify({ event_id: 'old', event_type: 'OutcomeObserved', timestamp: '2026-08-08T00:00:00Z', payload: { result: 'historical' } }) + '\n';
  appendFileSync(file, old);
  const a = new EventLedger(dir);
  const b = new EngineLedger(dir);
  a.record('OutcomeObserved', 'test', { result: 'new-ts' });
  b.record('OutcomeObserved', 'test', { result: 'new-js' });
  b.record('LearningDecisionObserved', 'test', { learningVersion: 3, schema: 'home23.learning-decision.v1',
    decisionId: 'future', scope: 'foreground.context', tags: ['operational'], sourceRefs: ['future:source'] });
  assert.ok(readFileSync(file, 'utf8').startsWith(old));
  const adapter = new EventLedgerTailAdapter({ sourcePath: file, cursorDir: join(dir, 'cursor'), id: 'versions', fromEnd: false });
  const events = await adapter.pull();
  assert.equal(events.length, 4);
  assert.equal(events[0]?.payload.learningVersion, undefined);
  assert.equal(events[1]?.payload.learningVersion, 2);
  assert.equal(events[2]?.payload.learningVersion, 2);
  assert.equal(events[3]?.payload.learningVersion, 3);
  assert.equal(events[3]?.payload.learningDecision, undefined, 'a future version is never downgraded into current learning');
});
