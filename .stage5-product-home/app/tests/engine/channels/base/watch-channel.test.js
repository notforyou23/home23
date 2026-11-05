import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchChannel } from '../../../../engine/src/channels/base/watch-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakeWatch extends WatchChannel {
  constructor(dir) { super({ id: 'test.watch', class: ChannelClass.BUILD, paths: [dir], usePolling: true, interval: 50 }); }
  parseEvent(evt) { return { payload: evt, sourceRef: `${evt.type}:${evt.path}`, producedAt: evt.ts }; }
}

test('WatchChannel constructor rejects empty paths', () => {
  assert.throws(() => new WatchChannel({ id: 'x.y', class: ChannelClass.BUILD, paths: [] }), /at least one path/);
  assert.throws(() => new WatchChannel({ id: 'x.y', class: ChannelClass.BUILD }), /at least one path/);
});

test('WatchChannel defaults to native events instead of hot polling', () => {
  const ch = new WatchChannel({ id: 'x.y', class: ChannelClass.BUILD, paths: ['/tmp'] });
  assert.equal(ch.usePolling, false);
  assert.equal(ch.interval, 1000);
});

test('WatchChannel emits events on file add', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  const ch = new FakeWatch(dir);
  await ch.start();
  writeFileSync(join(dir, 'hello.txt'), 'x');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(parsed);
    if (out.length >= 1) break;
  }
  await ch.stop();
  assert.ok(out.length >= 1);
  assert.ok(out[0].payload.path.endsWith('hello.txt'));
  assert.equal(out[0].payload.type, 'add');
});

test('WatchChannel.parseEvent throws when subclass does not override', () => {
  const ch = new WatchChannel({ id: 'x.y', class: ChannelClass.BUILD, paths: ['/tmp'] });
  assert.throws(() => ch.parseEvent({}), /not implemented/);
});
