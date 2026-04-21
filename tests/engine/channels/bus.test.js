import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBus } from '../../../engine/src/channels/bus.js';
import { PollChannel } from '../../../engine/src/channels/base/poll-channel.js';
import { ChannelClass, makeObservation } from '../../../engine/src/channels/contract.js';

class FakeChan extends PollChannel {
  constructor(id = 'fake.one') { super({ id, class: ChannelClass.MACHINE, intervalMs: 5 }); this.n = 0; }
  async poll() { this.n += 1; return [{ n: this.n }]; }
  parse(raw) { return { payload: raw, sourceRef: `n:${raw.n}`, producedAt: new Date().toISOString() }; }
  verify(parsed) { return makeObservation({
    channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
    flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt,
  }); }
  crystallize(obs) { return { method: 'test', type: 'observation', topic: 'tick', tags: ['test'] }; }
}

test('ChannelBus accepts registration and starts channels', async () => {
  const bus = new ChannelBus({ persistenceDir: null });
  const ch = new FakeChan();
  bus.register(ch);
  assert.equal(bus.channels.length, 1);
  await bus.stop();
});

test('ChannelBus rejects duplicate channel ids', async () => {
  const bus = new ChannelBus({ persistenceDir: null });
  bus.register(new FakeChan('x.y'));
  assert.throws(() => bus.register(new FakeChan('x.y')), /duplicate channel id/);
});

test('ChannelBus fans in observations and emits crystallize events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-'));
  const bus = new ChannelBus({ persistenceDir: dir });
  bus.register(new FakeChan());
  const obs = [];
  const drafts = [];
  bus.on('observation', (o) => obs.push(o));
  bus.on('crystallize', (e) => drafts.push(e));
  await bus.start();
  await new Promise((r) => setTimeout(r, 40));
  await bus.stop();
  assert.ok(obs.length >= 2);
  assert.equal(obs[0].channelId, 'fake.one');
  assert.equal(obs[0].flag, 'COLLECTED');
  assert.ok(drafts.length >= 1);
});

test('ChannelBus persists observations to per-channel JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-persist-'));
  const bus = new ChannelBus({ persistenceDir: dir });
  bus.register(new FakeChan('fake.persist'));
  await bus.start();
  await new Promise((r) => setTimeout(r, 40));
  await bus.stop();
  const expectedPath = join(dir, 'machine.fake.persist.jsonl');
  assert.ok(existsSync(expectedPath));
  const lines = readFileSync(expectedPath, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  assert.equal(JSON.parse(lines[0]).channelId, 'fake.persist');
});
