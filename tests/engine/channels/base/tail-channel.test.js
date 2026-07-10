import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailChannel } from '../../../../engine/src/channels/base/tail-channel.js';
import { ChannelClass } from '../../../../engine/src/channels/contract.js';

class FakeTail extends TailChannel {
  constructor(path) {
    super({ id: 'test.tail', class: ChannelClass.WORK, path });
  }
  parseLine(line) {
    if (!line.trim()) return null;
    return { payload: JSON.parse(line), sourceRef: `line:${line.slice(0, 16)}`, producedAt: new Date().toISOString() };
  }
}

test('TailChannel constructor rejects missing path', () => {
  assert.throws(() => new TailChannel({ id: 'x.y', class: ChannelClass.WORK }), /requires path/);
});

test('TailChannel emits each new JSONL line as a parsed observation', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const path = join(dir, 'log.jsonl');
  writeFileSync(path, '');
  const ch = new FakeTail(path);
  await ch.start();
  try {
    appendFileSync(path, JSON.stringify({ a: 1 }) + '\n');
    appendFileSync(path, JSON.stringify({ a: 2 }) + '\n');
    const out = [];
    for await (const parsed of ch.source()) {
      out.push(parsed);
      if (out.length >= 2) break;
    }
    assert.equal(out.length, 2);
    assert.equal(out[0].payload.a, 1);
    assert.equal(out[1].payload.a, 2);
  } finally {
    await ch.stop();
  }
});

test('TailChannel.parseLine throws when subclass does not override', () => {
  const ch = new TailChannel({ id: 'x.y', class: ChannelClass.WORK, path: '/tmp/x' });
  assert.throws(() => ch.parseLine('x'), /not implemented/);
});
