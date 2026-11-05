import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitChannel } from '../../../../engine/src/channels/build/git-channel.js';

test('GitChannel._parseLogOutput parses pipe-delimited log', () => {
  const ch = new GitChannel({ repoPath: '/tmp', intervalMs: 10 });
  const sample = 'abc1234|2026-04-21T10:00:00Z|jtr|feat: add thing\ndef5678|2026-04-21T11:00:00Z|jtr|fix: bug';
  const parsed = ch._parseLogOutput(sample);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sha, 'abc1234');
  assert.equal(parsed[0].subject, 'feat: add thing');
});

test('GitChannel.crystallize returns a build_event draft', () => {
  const ch = new GitChannel({ repoPath: '/tmp', intervalMs: 10 });
  const v = ch.verify({
    payload: { sha: 'abc', subject: 'feat: x', author: 'a', committed_at: '2026-04-21T00:00:00Z' },
    sourceRef: 'git:abc', producedAt: '2026-04-21T00:00:00Z',
  });
  const d = ch.crystallize(v);
  assert.equal(d.method, 'build_event');
  assert.equal(d.topic, 'git');
  assert.ok(d.tags.includes('commit'));
});
