const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { gunzipSync } = require('node:zlib');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.bus-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rows(file, compressed = false) {
  const bytes = fs.readFileSync(file);
  const text = (compressed ? gunzipSync(bytes) : bytes).toString('utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('channel rotation defaults to 64 MiB and three gzip segments', async () => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  for (const persistence of [undefined, null, false, 'invalid', []]) {
    const bus = new ChannelBus({ persistence });
    assert.deepEqual(bus.persistence, { enabled: true, maxBytes: 64 * 1024 * 1024, keep: 3 });
  }
});

test('concurrent channel appends rotate without lost, duplicated, or interleaved rows', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir, persistence: { maxBytes: 85, keep: 40 } });
  const channel = { id: 'machine.process', class: 'machine' };
  await Promise.all(Array.from({ length: 30 }, (_, id) => bus._persist(channel, { id, text: 'a'.repeat(40) })));
  await bus.stop();
  const file = path.join(dir, 'machine.process.jsonl');
  const persisted = [];
  for (let index = 40; index >= 1; index -= 1) {
    if (fs.existsSync(`${file}.${index}.gz`)) persisted.push(...rows(`${file}.${index}.gz`, true));
  }
  persisted.push(...rows(file));
  assert.deepEqual(persisted.map(row => row.id), Array.from({ length: 30 }, (_, id) => id));
  assert.equal(bus._pendingPersist.size, 0);
  assert.equal(bus._persistChains.size, 0);
});

test('channel rotation retains exactly the configured newest segments per channel', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir, persistence: { maxBytes: 1, keep: 3 } });
  const channel = { id: 'process', class: 'machine' };
  for (let id = 0; id < 6; id += 1) await bus._persist(channel, { id });
  await bus._persist({ id: 'neighbor.one', class: 'neighbor' }, { id: 'separate' });
  const file = path.join(dir, 'machine.process.jsonl');
  assert.deepEqual(rows(file), [{ id: 5 }]);
  assert.deepEqual(rows(`${file}.1.gz`, true), [{ id: 4 }]);
  assert.deepEqual(rows(`${file}.2.gz`, true), [{ id: 3 }]);
  assert.deepEqual(rows(`${file}.3.gz`, true), [{ id: 2 }]);
  assert.equal(fs.existsSync(`${file}.4.gz`), false);
  assert.deepEqual(rows(path.join(dir, 'neighbor.one.jsonl')), [{ id: 'separate' }]);
});

test('an oversized channel is untouched at startup and archived on its next append', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const file = path.join(dir, 'machine.process.jsonl');
  const existing = `${JSON.stringify({ id: 'old', text: 'é'.repeat(128) })}\n`;
  fs.writeFileSync(file, existing);
  const bus = new ChannelBus({ persistenceDir: dir, persistence: { maxBytes: 32 } });
  await bus.start();
  assert.equal(fs.readFileSync(file, 'utf8'), existing);
  assert.equal(fs.existsSync(`${file}.1.gz`), false);
  await bus._persist({ id: 'machine.process', class: 'machine' }, { id: 'next' });
  await bus.stop();
  assert.equal(gunzipSync(fs.readFileSync(`${file}.1.gz`)).toString('utf8'), existing);
  assert.deepEqual(rows(file), [{ id: 'next' }]);
});

test('disabled channel rotation keeps appending to the active file', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir, persistence: { enabled: false, maxBytes: 1 } });
  const channel = { id: 'machine.process', class: 'machine' };
  await bus._persist(channel, { id: 1 });
  await bus._persist(channel, { id: 2 });
  assert.deepEqual(rows(path.join(dir, 'machine.process.jsonl')), [{ id: 1 }, { id: 2 }]);
  assert.equal(fs.readdirSync(dir).some(file => file.endsWith('.gz')), false);
});

test('failed channel archive publication preserves existing data and allows retry', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const warnings = [];
  const bus = new ChannelBus({ persistenceDir: dir, persistence: { maxBytes: 1 }, logger: { warn: message => warnings.push(message) } });
  const channel = { id: 'machine.process', class: 'machine' };
  const file = path.join(dir, 'machine.process.jsonl');
  await bus._persist(channel, { id: 'old' });
  fs.mkdirSync(`${file}.3.gz`);
  await bus._persist(channel, { id: 'next' });
  assert.equal(warnings.length, 1);
  assert.deepEqual(rows(file), [{ id: 'old' }]);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  fs.rmdirSync(`${file}.3.gz`);
  await bus._persist(channel, { id: 'next' });
  assert.deepEqual(rows(`${file}.1.gz`, true), [{ id: 'old' }]);
  assert.deepEqual(rows(file), [{ id: 'next' }]);
});

function problemChannel(makeObservation) {
  return {
    id: 'work.live-problems', class: 'work',
    verify(raw) {
      return makeObservation({ channelId: this.id, sourceRef: raw.sourceRef, payload: raw.payload, flag: 'COLLECTED', confidence: 1, producedAt: new Date().toISOString() });
    },
    crystallize() { return { method: 'test', type: 'observation' }; },
  };
}

test('live problem persistence records state changes per key while emitting every observation', async t => {
  const [{ ChannelBus }, { makeObservation }] = await Promise.all([
    import('../../../engine/src/channels/bus.js'), import('../../../engine/src/channels/contract.js'),
  ]);
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir });
  const channel = problemChannel(makeObservation);
  const observed = [];
  const drafts = [];
  bus.on('observation', row => observed.push(row));
  bus.on('crystallize', row => drafts.push(row));
  const states = [
    { id: 'one', state: 'open', checkedAt: 'first' },
    { id: 'one', state: 'open', checkedAt: 'second' },
    { id: 'two', state: 'open' },
    { id: 'one', state: 'closed' },
    { id: 'one', state: 'closed' },
    { id: 'one', state: 'open' },
  ];
  await Promise.all(states.map((payload, index) => bus._handleRaw(channel, { payload, sourceRef: `problem:${payload.id}:${index}` })));
  assert.equal(observed.length, 6);
  assert.equal(drafts.length, 6);
  assert.deepEqual(rows(path.join(dir, 'work.live-problems.jsonl')).map(row => [row.payload.id, row.payload.state]), [
    ['one', 'open'], ['two', 'open'], ['one', 'closed'], ['one', 'open'],
  ]);
});

test('live problem persistence can be disabled and failed writes do not poison dedupe', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const channel = { id: 'work.live-problems', class: 'work' };
  const obs = { channelId: channel.id, payload: { id: 'one', state: 'open' } };
  const bus = new ChannelBus({ persistenceDir: dir, channelPolicy: { liveProblemsStateChangesOnly: false } });
  await bus._persist(channel, obs);
  await bus._persist(channel, obs);
  const file = path.join(dir, 'work.live-problems.jsonl');
  assert.equal(rows(file).length, 2);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  const warnings = [];
  const retryBus = new ChannelBus({ persistenceDir: dir, logger: { warn: message => warnings.push(message) } });
  await retryBus._persist(channel, obs);
  fs.rmdirSync(file);
  await retryBus._persist(channel, obs);
  await retryBus._persist(channel, obs);
  assert.equal(warnings.length, 1);
  assert.deepEqual(rows(file), [obs]);
});

test('disabling the whole channel policy persists unchanged live problem state', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir, channelPolicy: { enabled: false } });
  const channel = { id: 'work.live-problems', class: 'work' };
  const obs = { channelId: channel.id, payload: { id: 'one', state: 'open' } };
  await bus._persist(channel, obs);
  await bus._persist(channel, obs);
  assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, 2);
});

test('unchanged live problems persist at the default heartbeat without postponement by polls', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir });
  const channel = { id: 'work.live-problems', class: 'work' };
  const obs = { channelId: channel.id, payload: { id: 'one', state: 'open' } };
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(bus._liveProblemPolicy, { heartbeatMs: 30 * 60 * 1000, maxEntries: 10_000 });
  await bus._persist(channel, obs);
  now += 30 * 60 * 1000 - 1;
  await bus._persist(channel, obs);
  assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, 1);
  now += 1;
  await Promise.all([bus._persist(channel, obs), bus._persist(channel, obs)]);
  assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, 2);
  now += 30 * 60 * 1000;
  await bus._persist(channel, obs);
  assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, 3);
});

test('live-problem persistence heartbeat is configurable and can be disabled', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const channel = { id: 'work.live-problems', class: 'work' };
  const obs = { channelId: channel.id, payload: { id: 'one', state: 'open' } };
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  for (const liveProblemsHeartbeatMs of [25, 0, false]) {
    const dir = directory(t);
    const bus = new ChannelBus({ persistenceDir: dir, channelPolicy: { liveProblemsHeartbeatMs } });
    await bus._persist(channel, obs);
    now += 25;
    await bus._persist(channel, obs);
    assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, liveProblemsHeartbeatMs === 25 ? 2 : 1);
    await bus._persist(channel, { ...obs, payload: { ...obs.payload, state: 'closed' } });
    assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, liveProblemsHeartbeatMs === 25 ? 3 : 2);
  }
});

test('live-problem persistence bounds its LRU and records evicted keys on their next observation', async t => {
  const { ChannelBus } = await import('../../../engine/src/channels/bus.js');
  const dir = directory(t);
  const bus = new ChannelBus({ persistenceDir: dir, channelPolicy: { liveProblemsMaxEntries: 2 } });
  const channel = { id: 'work.live-problems', class: 'work' };
  const persist = id => bus._persist(channel, { channelId: channel.id, payload: { id, state: 'open' } });
  await persist('a');
  await persist('b');
  await persist('a'); // A suppressed poll still refreshes this key's recency.
  await persist('c');
  assert.deepEqual([...bus._persistedProblemStates.keys()], ['a', 'c']);
  await persist('a');
  await persist('b');
  assert.equal(bus._persistedProblemStates.size, 2);
  assert.deepEqual(rows(path.join(dir, 'work.live-problems.jsonl')).map(row => row.payload.id), ['a', 'b', 'c', 'b']);
});

test('live-problem polling heartbeats reach bus and memory despite delayed downstream writes', async t => {
  const [{ ChannelBus }, { LiveProblemsChannel }] = await Promise.all([
    import('../../../engine/src/channels/bus.js'), import('../../../engine/src/channels/work/live-problems-channel.js'),
  ]);
  const { MemoryIngest } = require('../../../engine/src/channels/memory-ingest.cjs');
  const dir = directory(t);
  const problemPath = path.join(dir, 'live-problems.json');
  const brainDir = path.join(dir, 'brain');
  fs.writeFileSync(problemPath, JSON.stringify({ problems: [{ id: 'one', state: 'open' }] }));
  const channel = new LiveProblemsChannel({ path: problemPath });
  const bus = new ChannelBus({ persistenceDir: dir });
  const ingest = new MemoryIngest({ brainDir });
  const observations = [];
  bus.on('observation', obs => observations.push(obs));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-11T12:00:00.000Z') });
  const persist = bus._persist.bind(bus);
  bus._persist = async (...args) => {
    t.mock.timers.tick(75);
    return persist(...args);
  };
  assert.deepEqual(await channel.poll(), []);
  t.mock.timers.tick(30 * 60 * 1000);
  for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
    const polled = await channel.poll();
    assert.equal(polled.length, 1);
    await bus._handleRaw(channel, polled[0]);
    t.mock.timers.tick(125);
    const obs = observations.at(-1);
    assert.ok(await ingest.writeFromObservation(obs, channel.crystallize(obs)));
    const receivedAt = Date.parse(obs.receivedAt);
    assert.equal(channel._seen.get('one').persistedAt, receivedAt);
    assert.equal(bus._persistedProblemStates.get('one').persistedAt, receivedAt);
    assert.equal(ingest._liveProblemStates.get('one').persistedAt, receivedAt);
    t.mock.timers.tick(30 * 60 * 1000 - 200);
  }
  assert.equal(observations.length, 3);
  assert.equal(rows(path.join(dir, 'work.live-problems.jsonl')).length, 3);
  assert.equal(rows(path.join(brainDir, 'crystallization-receipts.jsonl')).length, 3);
});
