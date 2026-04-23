import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeighborChannel } from '../../../../engine/src/channels/neighbor/neighbor-channel.js';

test('NeighborChannel emits on snapshotAt/lastMemoryWrite advance', async () => {
  let calls = 0;
  const states = [
    { agent: 'forrest', activeGoals: [], lastMemoryWrite: 't-0', snapshotAt: 's-0' },
    { agent: 'forrest', activeGoals: [], lastMemoryWrite: 't-0', snapshotAt: 's-0' }, // same
    { agent: 'forrest', activeGoals: [], lastMemoryWrite: 't-1', snapshotAt: 's-1' },
  ];
  const ch = new NeighborChannel({
    peerName: 'forrest', url: 'http://x/__state/public.json', intervalMs: 10,
    fetchState: async () => states[Math.min(calls++, states.length - 1)],
  });
  assert.equal((await ch.poll()).length, 1);  // first advance -> emit
  assert.equal((await ch.poll()).length, 0);  // same key
  assert.equal((await ch.poll()).length, 1);  // advanced
});

test('NeighborChannel.verify flags UNCERTIFIED with 0.70 confidence', () => {
  const ch = new NeighborChannel({ peerName: 'x', url: 'http://x', intervalMs: 10 });
  const v = ch.verify({
    payload: { agent: 'x', snapshotAt: 's' },
    sourceRef: 'neighbor:x:s', producedAt: 's',
  });
  assert.equal(v.flag, 'UNCERTIFIED');
  assert.equal(v.confidence, 0.7);
});

test('NeighborChannel.crystallize uses neighbor_gossip method', () => {
  const ch = new NeighborChannel({ peerName: 'x', url: 'http://x', intervalMs: 10 });
  const v = ch.verify({
    payload: { agent: 'x', snapshotAt: 's', dispatchState: 'idle' },
    sourceRef: 'r', producedAt: 's',
  });
  const d = ch.crystallize(v);
  assert.equal(d.method, 'neighbor_gossip');
  assert.ok(d.tags.includes('idle'));
});

test('NeighborChannel sends bearer token when configured', async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders = null;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, json: async () => ({ agent: 'axiom', snapshotAt: 's-1' }) };
  };

  try {
    const ch = new NeighborChannel({
      peerName: 'axiom',
      url: 'http://jtrpi.local:5014/__state/public.json',
      token: 'secret',
      intervalMs: 10,
    });
    assert.equal((await ch.poll()).length, 1);
    assert.equal(capturedHeaders.authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
