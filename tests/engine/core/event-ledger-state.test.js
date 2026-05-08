import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EventLedger } = require('../../../engine/src/core/event-ledger.js');

test('EventLedger records replayable state-transition events by subject', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-event-ledger-'));
  try {
    const ledger = new EventLedger(dir);
    const first = ledger.recordStateTransition({
      eventType: 'issue.published',
      subject: 'from-the-inside/099',
      actor: 'jerry',
      payload: { status: 'published' },
      evidence: {
        receiptId: 'ev_issue_099',
        receiptPath: '/tmp/099.evidence.json',
        result: 'pass',
      },
      occurredAt: '2026-05-08T12:00:00.000Z',
    });
    const second = ledger.recordStateTransition({
      eventType: 'issue.corrected',
      subject: 'from-the-inside/099',
      actor: 'jerry',
      payload: { correctionOf: first.event_id },
      occurredAt: '2026-05-08T12:05:00.000Z',
      causedBy: first.event_id,
    });

    const raw = readFileSync(join(dir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(raw.length, 2);
    assert.equal(raw[0].event_type, 'issue.published');
    assert.equal(raw[0].payload.schema, 'home23.state-event.v1');
    assert.equal(raw[0].payload.subject, 'from-the-inside/099');
    assert.equal(raw[0].payload.evidence.receiptId, 'ev_issue_099');
    assert.equal(raw[1].payload.causedBy, first.event_id);

    const chain = ledger.readStateChain('from-the-inside/099');
    assert.deepEqual(chain.map(e => e.event_type), ['issue.published', 'issue.corrected']);

    const projection = ledger.projectSubject('from-the-inside/099');
    assert.equal(projection.subject, 'from-the-inside/099');
    assert.equal(projection.eventCount, 2);
    assert.equal(projection.latestEventType, 'issue.corrected');
    assert.equal(projection.latest.payload.correctionOf, first.event_id);
    assert.equal(second.payload.payloadHash.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
