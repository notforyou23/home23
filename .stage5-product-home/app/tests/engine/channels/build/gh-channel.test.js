import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhChannel } from '../../../../engine/src/channels/build/gh-channel.js';

test('GhChannel._parsePrList handles valid JSON and bad input', () => {
  const ch = new GhChannel({ intervalMs: 10 });
  const sample = JSON.stringify([{ number: 42, title: 't', state: 'OPEN', updatedAt: '2026-04-20T00:00:00Z' }]);
  assert.equal(ch._parsePrList(sample).length, 1);
  assert.deepEqual(ch._parsePrList('not-json'), []);
});

test('GhChannel.crystallize returns build_event draft', () => {
  const ch = new GhChannel({ intervalMs: 10 });
  const v = ch.verify({
    payload: { number: 42, title: 't', state: 'OPEN', updatedAt: '2026-04-20T00:00:00Z' },
    sourceRef: 'gh:pr:42', producedAt: '2026-04-20T00:00:00Z',
  });
  const d = ch.crystallize(v);
  assert.equal(d.topic, 'pr');
  assert.ok(d.tags.includes('OPEN'));
});
