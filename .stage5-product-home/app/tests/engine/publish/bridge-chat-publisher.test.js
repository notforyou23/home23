import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeChatPublisher, computeSalience } from '../../../engine/src/publish/bridge-chat-publisher.js';

test('BridgeChatPublisher only publishes above salience threshold', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
  });
  await pub.onObservation({ salience: 0.6, summary: 'small' });
  assert.equal(sent.length, 0);
  await pub.onObservation({ salience: 0.9, summary: 'big' });
  assert.equal(sent.length, 1);
});

test('BridgeChatPublisher suppresses ambient high-salience observations', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
    logger: { info: () => {}, warn: () => {} },
  });

  const result = await pub.onObservation({
    salience: 0.95,
    summary: 'routine pressure sample',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: { severity: 'routine', pressure_pa: 101234 },
    },
  });

  assert.equal(result, null);
  assert.equal(sent.length, 0);
});

test('BridgeChatPublisher sends action-required high-salience observations', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
  });

  await pub.onObservation({
    salience: 0.95,
    summary: 'bridge needs owner decision',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: { severity: 'normal', requiresAction: true },
    },
  });

  assert.equal(sent.length, 1);
});

test('BridgeChatPublisher applies deep-work rhythm suppression', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
    logger: { info: () => {}, warn: () => {} },
    getTemporalContext: () => ({ jtrTime: { activeRhythms: ['deep-work'] } }),
  });

  await pub.onObservation({
    salience: 0.95,
    summary: 'interesting but non-action update',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: { severity: 'normal', summary: 'routine update' },
    },
  });
  await pub.onObservation({
    salience: 0.95,
    summary: 'action required',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: { severity: 'normal', requiresAction: true },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'action required');
});

test('BridgeChatPublisher suppresses stale high-salience action requests', async () => {
  const sent = [];
  const info = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
    logger: { info: (...args) => info.push(args.join(' ')), warn: () => {} },
    getTemporalContext: () => ({ now: Date.parse('2026-05-11T16:30:00.000Z') }),
  });

  const result = await pub.onObservation({
    salience: 0.95,
    summary: 'old bridge decision',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: {
        severity: 'urgent',
        requiresAction: true,
        observedAt: '2026-05-11T16:00:00.000Z',
        maxAgeMs: 10 * 60 * 1000,
      },
    },
  });

  assert.equal(result, null);
  assert.equal(sent.length, 0);
  assert.ok(info.some((line) => line.includes('stale_signal_deferred')));
});

test('BridgeChatPublisher sends fresh action requests with attention contact metadata', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
    getTemporalContext: () => ({ now: Date.parse('2026-05-11T16:05:00.000Z') }),
  });

  await pub.onObservation({
    salience: 0.95,
    summary: 'fresh bridge decision',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: {
        severity: 'urgent',
        requiresAction: true,
        observedAt: '2026-05-11T16:04:00.000Z',
        maxAgeMs: 10 * 60 * 1000,
      },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].attention.reason, 'action_required');
  assert.equal(sent[0].attention.contact.freshness.status, 'current');
});

test('BridgeChatPublisher suppresses family-evening non-urgent interruptions', async () => {
  const sent = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async (m) => sent.push(m),
    ledger: { record: async () => {} },
    logger: { info: () => {}, warn: () => {} },
    getTemporalContext: () => ({ jtrTime: { activeRhythms: ['family-evening'] } }),
  });

  const result = await pub.onObservation({
    salience: 0.95,
    summary: 'interesting but not urgent',
    observation: {
      flag: 'COLLECTED',
      confidence: 0.99,
      payload: { attentionMode: 'interruptive', severity: 'normal' },
    },
  });

  assert.equal(result, null);
  assert.equal(sent.length, 0);
});

test('BridgeChatPublisher does not record success when no sender is configured', async () => {
  let records = 0;
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    ledger: { record: async () => { records += 1; } },
  });

  const result = await pub.onObservation({ salience: 0.9, summary: 'big' });

  assert.equal(result, null);
  assert.equal(records, 0);
});

test('BridgeChatPublisher does not record success when sender fails', async () => {
  let records = 0;
  const warnings = [];
  const pub = new BridgeChatPublisher({
    salienceThreshold: 0.75,
    sender: async () => { throw new Error('HTTP 503 bridge-chat not configured'); },
    ledger: { record: async () => { records += 1; } },
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
  });

  const result = await pub.onObservation({ salience: 0.9, summary: 'big' });

  assert.equal(result, false);
  assert.equal(records, 0);
  assert.ok(warnings.some((args) => String(args[0]).includes('bridge-chat failed')));
});

test('computeSalience weights COLLECTED higher than UNCERTIFIED', () => {
  const now = Date.now();
  const collected = { confidence: 0.9, flag: 'COLLECTED', receivedAt: new Date(now).toISOString() };
  const uncertified = { confidence: 0.9, flag: 'UNCERTIFIED', receivedAt: new Date(now).toISOString() };
  assert.ok(computeSalience(collected, { now }) > computeSalience(uncertified, { now }));
});

test('computeSalience decays with age', () => {
  const now = Date.now();
  const fresh = { confidence: 0.9, flag: 'COLLECTED', receivedAt: new Date(now).toISOString() };
  const old = { confidence: 0.9, flag: 'COLLECTED', receivedAt: new Date(now - 60 * 60_000).toISOString() };
  assert.ok(computeSalience(fresh, { now }) > computeSalience(old, { now }));
});
