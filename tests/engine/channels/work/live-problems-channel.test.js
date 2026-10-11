import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveProblemsChannel } from '../../../../engine/src/channels/work/live-problems-channel.js';

function directory(t) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.live-problems-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('LiveProblemsChannel primes on first poll then emits on change', async t => {
  const dir = directory(t);
  const path = join(dir, 'live-problems.json');
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'open', updatedAt: '2026-04-21T00:00:00Z' }] }));
  const ch = new LiveProblemsChannel({ path, intervalMs: 10 });
  // First poll seeds baseline — should NOT emit
  assert.equal((await ch.poll()).length, 0);
  // Unchanged second poll
  assert.equal((await ch.poll()).length, 0);
  // Update state -> emit
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'resolved', updatedAt: '2026-04-21T01:00:00Z' }] }));
  const changed = await ch.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'resolved');
});

test('LiveProblemsChannel ignores verifier-only updatedAt bumps', async t => {
  const dir = directory(t);
  const path = join(dir, 'live-problems.json');
  const write = (problem) => writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', ...problem }] }));
  write({ state: 'open', stepIndex: 0, updatedAt: '2026-09-21T00:00:00Z' });
  const ch = new LiveProblemsChannel({ path, intervalMs: 10 });
  await ch.poll();
  write({ state: 'open', stepIndex: 0, updatedAt: '2026-09-21T00:05:00Z' });
  assert.equal((await ch.poll()).length, 0);
  write({ state: 'open', stepIndex: 1, updatedAt: '2026-09-21T00:10:00Z' });
  assert.equal((await ch.poll()).length, 1);
});

test('LiveProblemsChannel emits unchanged state at the default heartbeat after priming', async t => {
  const path = join(directory(t), 'live-problems.json');
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'open' }] }));
  const ch = new LiveProblemsChannel({ path });
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(ch._liveProblemPolicy, { heartbeatMs: 30 * 60 * 1000, maxEntries: 10_000 });
  assert.deepEqual(await ch.poll(), []);
  now += 30 * 60 * 1000 - 1;
  assert.deepEqual(await ch.poll(), []);
  now += 1;
  assert.equal((await ch.poll()).length, 1);
  assert.deepEqual(await ch.poll(), []);
  now += 30 * 60 * 1000;
  assert.equal((await ch.poll()).length, 1);
});

test('LiveProblemsChannel heartbeat can be configured or disabled while lifecycle changes still emit', async t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  for (const heartbeatMs of [25, 0, false]) {
    const path = join(directory(t), 'live-problems.json');
    writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'open' }] }));
    const ch = new LiveProblemsChannel({ path, heartbeatMs });
    assert.deepEqual(await ch.poll(), []);
    now += 25;
    assert.equal((await ch.poll()).length, heartbeatMs === 25 ? 1 : 0);
    writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'resolved' }] }));
    assert.equal((await ch.poll()).length, 1);
  }
});

test('LiveProblemsChannel caps its baseline and forgets disappeared problem keys', async t => {
  const path = join(directory(t), 'live-problems.json');
  const write = ids => writeFileSync(path, JSON.stringify({ problems: ids.map(id => ({ id, state: 'open' })) }));
  write(['a', 'b', 'c']);
  const ch = new LiveProblemsChannel({ path, maxEntries: 2 });
  assert.deepEqual(await ch.poll(), []);
  assert.deepEqual([...ch._seen.keys()], ['b', 'c']);
  write(['b', 'c']);
  assert.deepEqual(await ch.poll(), []);
  write(['c']);
  assert.deepEqual(await ch.poll(), []);
  assert.deepEqual([...ch._seen.keys()], ['c']);
  write(['b', 'c']);
  assert.deepEqual((await ch.poll()).map(problem => problem.id), ['b']);
  assert.equal(ch._seen.size, 2);
});
