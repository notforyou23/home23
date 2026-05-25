import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCronResultPacket,
  buildIncomingMessagePacket,
  buildOutgoingResponsePacket,
} from '../../src/agency/world-stream.js';

test('buildIncomingMessagePacket turns structural conversation into agency-changing intake', () => {
  const packet = buildIncomingMessagePacket({
    id: 'm1',
    channel: 'telegram',
    chatId: '123',
    userId: 'jtr',
    userName: 'jtr',
    text: 'This Step28 agency spine needs to change behavior.',
    timestamp: 1770000000000,
    messageId: '42',
  });

  assert.equal(packet.source, 'telegram.message');
  assert.equal(packet.kind, 'conversation_message');
  assert.equal(packet.explicitNoChange, false);
  assert.match(packet.desiredChangedFuture || '', /Resident Jerry decides/);
  assert.equal(packet.evidence[0].ref, 'telegram:123:42');
});

test('buildIncomingMessagePacket records ordinary chatter as explicit no-change', () => {
  const packet = buildIncomingMessagePacket({
    id: 'm2',
    channel: 'telegram',
    chatId: '123',
    userId: 'jtr',
    userName: 'jtr',
    text: 'thanks',
    timestamp: 1770000000000,
  });

  assert.equal(packet.explicitNoChange, true);
  assert.equal(packet.nextMove, 'record no-change conversation receipt');
});

test('buildIncomingMessagePacket turns jtr corrections into durable truth claim packets', () => {
  const packet = buildIncomingMessagePacket({
    id: 'm-correction',
    channel: 'telegram',
    chatId: '123',
    userId: 'jtr',
    userName: 'jtr',
    text: 'Correction: the old newsletter feedback-loop frame is exhausted unless it cites lived system change.',
    timestamp: 1770000000000,
    messageId: '99',
  });

  assert.equal(packet.kind, 'operator_correction');
  assert.equal(packet.explicitNoChange, false);
  assert.equal(packet.claim?.sourceType, 'jtr_correction');
  assert.match(packet.claim?.claim || '', /feedback-loop frame is exhausted/);
  assert.equal(packet.tags.includes('correction'), true);
  assert.match(packet.desiredChangedFuture || '', /truth hierarchy/);
});

test('buildOutgoingResponsePacket makes response delivery non-terminal', () => {
  const packet = buildOutgoingResponsePacket({
    id: 'm3',
    channel: 'telegram',
    chatId: '123',
    userId: 'jtr',
    userName: 'jtr',
    text: 'what changed?',
    timestamp: 1770000000000,
  }, {
    text: 'I updated the resident spine.',
    channel: 'telegram',
    chatId: '123',
  });

  assert.equal(packet.source, 'telegram.response');
  assert.equal(packet.kind, 'conversation_response');
  assert.equal(packet.explicitNoChange, true);
  assert.match(packet.nextMove || '', /separate pursuit/);
});

test('buildCronResultPacket preserves declared agency delta fields', () => {
  const packet = buildCronResultPacket({
    id: 'x-timeline',
    name: 'X Timeline',
    schedule: { type: 'interval', minutes: 60 },
    payload: {
      kind: 'agentTurn',
      message: 'scan timeline',
      agencyChangedFuture: 'Create selected watch/pursuit/discard records from timeline signal.',
      agencyNextMove: 'follow promoted agent agency examples',
    },
    state: { enabled: true },
  }, {
    status: 'ok',
    response: 'Promoted one signal, discarded ten.',
    durationMs: 123,
  });

  assert.equal(packet.source, 'cron.x-timeline');
  assert.equal(packet.explicitNoChange, false);
  assert.equal(packet.desiredChangedFuture, 'Create selected watch/pursuit/discard records from timeline signal.');
  assert.equal(packet.nextMove, 'follow promoted agent agency examples');
});

test('buildCronResultPacket extracts machine-readable agency intake packets from reports', () => {
  const packet = buildCronResultPacket({
    id: 'x-timeline-evening',
    name: 'X Timeline Evening',
    schedule: { type: 'interval', minutes: 60 },
    payload: {
      kind: 'agentTurn',
      message: 'scan timeline',
    },
    state: { enabled: true },
  }, {
    status: 'ok',
    response: [
      'Delivered digest.',
      'AGENCY_INTAKE_PACKET:',
      '{',
      '  "schema": "home23.agency.intake-packet.v1",',
      '  "summary": "Timeline surfaced one agent-agency implementation signal.",',
      '  "actionWorthy": [{"summary": "Bind report outputs to resident pursuits."}],',
      '  "watchItems": [{"summary": "Watch repeated autonomy discourse."}],',
      '  "contradictions": [],',
      '  "discardedNoise": [{"ref": "viral meta thread", "reason": "no durable action"}],',
      '  "desiredChangedFuture": "Report digestion updates standing agency implementation pursuit.",',
      '  "nextMove": "merge with Home23 agency spine pursuit",',
      '  "tags": ["x-timeline", "agency"]',
      '}',
    ].join('\n'),
    durationMs: 321,
  });

  assert.equal(packet.explicitNoChange, false);
  assert.equal(packet.summary, 'Timeline surfaced one agent-agency implementation signal.');
  assert.equal(packet.desiredChangedFuture, 'Report digestion updates standing agency implementation pursuit.');
  assert.equal(packet.nextMove, 'merge with Home23 agency spine pursuit');
  assert.deepEqual(packet.discarded, [{ ref: 'viral meta thread', reason: 'no durable action' }]);
  assert.equal(packet.tags.includes('x-timeline'), true);
  assert.match(packet.seen.join('\n'), /Bind report outputs/);
});

test('buildCronResultPacket routes bound cron outcomes back to their resident pursuit', () => {
  const packet = buildCronResultPacket({
    id: 'legacy-cron',
    name: 'Legacy Cron',
    schedule: { kind: 'every', everyMs: 60000 },
    payload: { kind: 'exec', command: 'true' },
    agency: {
      pursuitId: 'ap_cron',
      charterRule: 'existing_recurring_cron_requires_pursuit',
    },
    state: { nextRunAtMs: 0, consecutiveErrors: 0 },
  }, {
    status: 'ok',
    response: 'updated artifact',
    durationMs: 12,
    semanticStatus: 'satisfied',
  });

  assert.equal(packet.pursuitId, 'ap_cron');
  assert.equal(packet.consequenceStatus, 'advanced');
  assert.equal(packet.explicitNoChange, false);
  assert.match(packet.desiredChangedFuture || '', /resident pursuit ap_cron/);
});
