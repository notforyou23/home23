import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsWatchChannel } from '../../../../engine/src/channels/build/fswatch-channel.js';

test('FsWatchChannel.crystallize tags design-doc paths', () => {
  const ch = new FsWatchChannel({ paths: ['/x'] });
  const v = ch.verify({
    payload: { type: 'add', path: '/x/docs/design/STEP24.md', ts: '2026-04-21T00:00:00Z' },
    sourceRef: 'fs:add:/x/docs/design/STEP24.md', producedAt: '2026-04-21T00:00:00Z',
  });
  const d = ch.crystallize(v);
  assert.ok(d.tags.includes('design-doc'));
  assert.equal(d.topic, 'filesystem');
});

test('FsWatchChannel.crystallize tags config and engine paths', () => {
  const ch = new FsWatchChannel({ paths: ['/x'] });
  const v = ch.verify({
    payload: { type: 'change', path: '/x/config/home.yaml', ts: 't' },
    sourceRef: 'fs:change:/x/config/home.yaml', producedAt: 't',
  });
  assert.ok(ch.crystallize(v).tags.includes('config'));
  const v2 = ch.verify({
    payload: { type: 'change', path: '/x/engine/src/cognition/critique.js', ts: 't' },
    sourceRef: 's2', producedAt: 't',
  });
  assert.ok(ch.crystallize(v2).tags.includes('engine'));
});
