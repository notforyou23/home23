'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MemoryIngest } = require('../../../engine/src/channels/memory-ingest.cjs');
const { liveProblemState, normalizeLiveProblemPolicy, shouldWriteLiveProblem, rememberLiveProblem } = require('../../../shared/channel-observation-policy.cjs');

function fixture(t, options = {}) {
  const brainDir = fs.mkdtempSync(path.join(__dirname, '.memory-ingest-policy-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  return { brainDir, ingest: new MemoryIngest({ brainDir, logger: { warn() {} }, ...options }) };
}

function observation(channelId, payload = {}, sourceRef = `${channelId}:sample`) {
  return {
    channelId, sourceRef, payload,
    receivedAt: '2026-10-11T12:00:00.000Z',
    producedAt: '2026-10-11T12:00:00.000Z',
    flag: 'COLLECTED', confidence: 0.9,
  };
}

function receipts(brainDir) {
  return fs.readFileSync(path.join(brainDir, 'crystallization-receipts.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
}

test('default channel policy denies machine, neighbor and os.pm2 without changing existing data', async (t) => {
  const { brainDir, ingest } = fixture(t, { maxObjects: 1 });
  const priorFiles = {
    'memory-objects.json': JSON.stringify({ objects: [{ memory_id: 'old-a' }, { memory_id: 'old-b' }] }),
    'memory-objects.archive.jsonl': '{"prior":"archive"}\n',
    'crystallization-receipts.jsonl': '{"prior":"receipt"}\n',
  };
  for (const [name, content] of Object.entries(priorFiles)) fs.writeFileSync(path.join(brainDir, name), content);
  for (const channelId of [
    'machine.process', 'machine.cpu', 'machine.swap', 'machine.memory',
    'machine.disk', 'machine.pm2', 'os.pm2', 'neighbor.jerry', 'neighbor.forrest',
  ]) assert.equal(await ingest.writeFromObservation(observation(channelId)), null, channelId);
  for (const [name, content] of Object.entries(priorFiles)) {
    assert.equal(fs.readFileSync(path.join(brainDir, name), 'utf8'), content);
  }
});

test('denied first observation creates no memory-object or receipt files', async (t) => {
  const { brainDir, ingest } = fixture(t);
  assert.equal(await ingest.writeFromObservation(observation('machine.cpu')), null);
  assert.deepEqual(fs.readdirSync(brainDir), []);
  const allowed = await ingest.writeFromObservation(observation('work.report', { summary: 'work completed' }));
  assert.ok(allowed.memory_id);
  assert.equal(receipts(brainDir).length, 1);
});

test('channel deny list is configurable and the entire policy can be disabled', async (t) => {
  const custom = fixture(t, { channelPolicy: { deny: ['work.*'] } });
  assert.equal(await custom.ingest.writeFromObservation(observation('work.report')), null);
  assert.ok(await custom.ingest.writeFromObservation(observation('machine.cpu')));

  const disabled = fixture(t, { channelPolicy: { enabled: false } });
  assert.ok(await disabled.ingest.writeFromObservation(observation('neighbor.jerry')));
  const problem = observation('work.live-problems', { id: 'problem', state: 'open' });
  assert.ok(await disabled.ingest.writeFromObservation(problem));
  assert.ok(await disabled.ingest.writeFromObservation(problem));
  assert.equal(receipts(disabled.brainDir).length, 3);
});

test('live-problem writes retain lifecycle transitions per key while ignoring verifier churn', async (t) => {
  const { brainDir, ingest } = fixture(t);
  const problem = (id, at, extra = {}) => observation('work.live-problems', {
    id, state: 'open', stepIndex: 0, escalated: false, updatedAt: at,
    ...extra,
  }, `live-problem:${id}:${at}`);
  const first = problem('a', '2026-10-11T12:00:00.000Z');
  const same = problem('a', '2026-10-11T12:00:30.000Z', { evidence: { checks: 2 } });
  assert.ok(await ingest.writeFromObservation(first));
  assert.ok(await ingest.writeFromObservation(problem('b', '2026-10-11T12:00:00.000Z')));
  const before = fs.readFileSync(path.join(brainDir, 'memory-objects.json'), 'utf8');
  assert.equal(await ingest.writeFromObservation(same), null);
  assert.equal(fs.readFileSync(path.join(brainDir, 'memory-objects.json'), 'utf8'), before);
  assert.ok(await ingest.writeFromObservation(problem('a', '2026-10-11T12:01:00.000Z', { stepIndex: 1 })));
  assert.ok(await ingest.writeFromObservation(problem('a', '2026-10-11T12:02:00.000Z', { stepIndex: 1, escalated: true })));
  assert.ok(await ingest.writeFromObservation(problem('a', '2026-10-11T12:03:00.000Z', { state: 'resolved' })));
  assert.ok(await ingest.writeFromObservation(problem('a', '2026-10-11T12:04:00.000Z')));
  assert.equal(receipts(brainDir).length, 6);
});

test('concurrent identical live-problem observations write exactly one receipt', async (t) => {
  const { brainDir, ingest } = fixture(t);
  const observations = Array.from({ length: 20 }, (_, index) => observation(
    'work.live-problems', { problemKey: 'concurrent', state: 'open' }, `live-problem:concurrent:poll-${index}`,
  ));
  const written = await Promise.all(observations.map(obs => ingest.writeFromObservation(obs)));
  assert.equal(written.filter(Boolean).length, 1);
  assert.equal(receipts(brainDir).length, 1);
});

test('live-problem deduplication can be disabled independently', async (t) => {
  const { brainDir, ingest } = fixture(t, { channelPolicy: { liveProblemsStateChangesOnly: false } });
  const obs = observation('work.live-problems', { key: 'unfiltered', state: 'open' });
  assert.ok(await ingest.writeFromObservation(obs));
  assert.ok(await ingest.writeFromObservation(obs));
  assert.equal(await ingest.writeFromObservation(observation('machine.cpu')), null);
  assert.equal(receipts(brainDir).length, 2);
});

test('a failed live-problem write does not mark the state as ingested', async (t) => {
  const { brainDir, ingest } = fixture(t);
  const objectsPath = path.join(brainDir, 'memory-objects.json');
  fs.writeFileSync(objectsPath, JSON.stringify({ objects: [] }));
  const originalWrite = fs.promises.writeFile;
  let failNextWrite = true;
  fs.promises.writeFile = async function (file, ...args) {
    if (file === objectsPath && failNextWrite) {
      failNextWrite = false;
      throw new Error('injected write failure');
    }
    return originalWrite.call(this, file, ...args);
  };
  t.after(() => { fs.promises.writeFile = originalWrite; });
  const obs = observation('work.live-problems', { id: 'retry', state: 'open' });
  await assert.rejects(ingest.writeFromObservation(obs), /injected write failure/);
  assert.ok(await ingest.writeFromObservation(obs));
  assert.equal(receipts(brainDir).length, 1);
});

test('live-problem flag and error changes remain visible, with safe source identity fallback', async (t) => {
  const { brainDir, ingest } = fixture(t);
  const first = observation('work.live-problems', { state: 'open' }, 'live-problem:anon:2026-10-11T12:00:00.000Z');
  const second = { ...first, sourceRef: 'live-problem:anon:2026-10-11T12:00:30.000Z' };
  assert.equal(liveProblemState(first).key, liveProblemState(second).key);
  assert.ok(await ingest.writeFromObservation(first));
  assert.equal(await ingest.writeFromObservation(second), null);
  assert.ok(await ingest.writeFromObservation({ ...second, flag: 'UNKNOWN' }));
  for (const error of ['read failed', 'parse failed']) {
    assert.ok(await ingest.writeFromObservation({
      ...second, flag: 'UNKNOWN', payload: { error },
      sourceRef: 'poll-error:work.live-problems:2026-10-11T12:01:00.000Z',
    }));
  }
  assert.equal(liveProblemState(observation('build.git')), null);
  assert.equal(liveProblemState(observation('work.live-problems', {}, '')), null);
  assert.equal(liveProblemState(observation('work.live-problems', { id: '', problemKey: 'fallback' })).key, 'fallback');
  assert.equal(receipts(brainDir).length, 4);
});

test('shared live-problem state cache defaults to a bounded 10000-entry LRU', () => {
  const policy = normalizeLiveProblemPolicy();
  assert.deepEqual(policy, { heartbeatMs: 30 * 60 * 1000, maxEntries: 10_000 });
  for (const invalid of [undefined, null, false, 0, -1, 0.5, 'invalid', Infinity]) {
    assert.equal(normalizeLiveProblemPolicy({ liveProblemsMaxEntries: invalid }).maxEntries, 10_000);
  }
  const states = new Map();
  for (let index = 0; index < 10_000; index += 1) rememberLiveProblem(states, { key: String(index), signature: 'open' }, policy, 0);
  assert.equal(shouldWriteLiveProblem(states, { key: '0', signature: 'open' }, policy, 1), false);
  rememberLiveProblem(states, { key: '10000', signature: 'open' }, policy, 1);
  assert.equal(states.size, 10_000);
  assert.ok(states.has('0'));
  assert.equal(states.has('1'), false);
});

test('unchanged live problems write memory receipts every default heartbeat', async t => {
  const { brainDir, ingest } = fixture(t);
  const obs = observation('work.live-problems', { id: 'one', state: 'open' });
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(ingest._liveProblemPolicy, { heartbeatMs: 30 * 60 * 1000, maxEntries: 10_000 });
  assert.ok(await ingest.writeFromObservation(obs));
  now += 30 * 60 * 1000 - 1;
  assert.equal(await ingest.writeFromObservation(obs), null);
  now += 1;
  const written = await Promise.all([ingest.writeFromObservation(obs), ingest.writeFromObservation(obs)]);
  assert.equal(written.filter(Boolean).length, 1);
  assert.equal(receipts(brainDir).length, 2);
  now += 30 * 60 * 1000;
  assert.ok(await ingest.writeFromObservation(obs));
  assert.equal(receipts(brainDir).length, 3);
});

test('memory-ingest heartbeat is configurable and can be disabled without suppressing changes', async t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const obs = observation('work.live-problems', { id: 'one', state: 'open' });
  for (const liveProblemsHeartbeatMs of [25, 0, false]) {
    const { brainDir, ingest } = fixture(t, { channelPolicy: { liveProblemsHeartbeatMs } });
    assert.ok(await ingest.writeFromObservation(obs));
    now += 25;
    const heartbeat = await ingest.writeFromObservation(obs);
    assert.equal(Boolean(heartbeat), liveProblemsHeartbeatMs === 25);
    assert.ok(await ingest.writeFromObservation({ ...obs, payload: { ...obs.payload, state: 'closed' } }));
    assert.equal(receipts(brainDir).length, liveProblemsHeartbeatMs === 25 ? 3 : 2);
  }
});

test('memory-ingest bounds live-problem states by LRU and writes evicted keys again', async t => {
  const { brainDir, ingest } = fixture(t, { channelPolicy: { liveProblemsMaxEntries: 2 } });
  const write = id => ingest.writeFromObservation(observation('work.live-problems', { id, state: 'open' }, `problem:${id}`));
  assert.ok(await write('a'));
  assert.ok(await write('b'));
  assert.equal(await write('a'), null);
  assert.ok(await write('c'));
  assert.deepEqual([...ingest._liveProblemStates.keys()], ['a', 'c']);
  assert.equal(await write('a'), null);
  assert.ok(await write('b'));
  assert.equal(ingest._liveProblemStates.size, 2);
  assert.deepEqual(receipts(brainDir).map(row => row.sourceRef), ['problem:a', 'problem:b', 'problem:c', 'problem:b']);
});
