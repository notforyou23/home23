import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryChannel } from '../../../../engine/src/channels/machine/memory-channel.js';

test('MemoryChannel.crystallize is null above threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10 });
  const v = ch.verify({ payload: { freePct: 50 }, sourceRef: 'm:1', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});

test('MemoryChannel.crystallize fires below threshold', () => {
  const ch = new MemoryChannel({ intervalMs: 10, lowFreePctThreshold: 10 });
  const v = ch.verify({ payload: { freePct: 5 }, sourceRef: 'm:2', producedAt: '2026-04-21T00:00:00Z' });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('low-free'));
});
