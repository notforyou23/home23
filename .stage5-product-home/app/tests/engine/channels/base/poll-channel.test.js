import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollChannel } from '../../../../engine/src/channels/base/poll-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakePoll extends PollChannel {
  constructor() {
    super({ id: 'test.fake', class: ChannelClass.MACHINE, intervalMs: 10 });
    this.count = 0;
  }
  async poll() { this.count += 1; return [{ n: this.count }]; }
  parse(raw) { return { payload: raw, sourceRef: `n:${raw.n}`, producedAt: new Date().toISOString() }; }
}

test('PollChannel constructor rejects non-positive intervalMs', () => {
  assert.throws(() => new PollChannel({ id: 'x.y', class: ChannelClass.MACHINE, intervalMs: 0 }), /positive intervalMs/);
  assert.throws(() => new PollChannel({ id: 'x.y', class: ChannelClass.MACHINE, intervalMs: -1 }), /positive intervalMs/);
});

test('PollChannel yields observations at configured interval', async () => {
  const ch = new FakePoll();
  const observed = [];
  ch.start();
  const iter = ch.source();
  const limit = 3;
  for await (const raw of iter) {
    observed.push(raw);
    if (observed.length >= limit) break;
  }
  ch.stop();
  assert.equal(observed.length, limit);
  assert.equal(observed[0].n, 1);
});

test('PollChannel stops yielding after stop()', async () => {
  const ch = new FakePoll();
  ch.start();
  ch.stop();
  const iter = ch.source();
  const result = await Promise.race([
    iter.next(),
    new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 50)),
  ]);
  assert.equal(result.done, true);
});

test('PollChannel.poll() throws when subclass does not override', async () => {
  const ch = new PollChannel({ id: 'x.y', class: ChannelClass.MACHINE, intervalMs: 10 });
  await assert.rejects(() => ch.poll(), /not implemented/);
});
