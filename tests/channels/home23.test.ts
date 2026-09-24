import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home23Adapter } from '../../src/channels/home23.js';

test('Home23 outbox survives restart and retries the same message after a lost acknowledgement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-outbox-')); t.after(() => rmSync(root, { recursive: true }));
  const committed = new Set<string>(); const seen: string[] = [];
  const first = new Home23Adapter(root, async input => { committed.add(input.messageId); seen.push(input.messageId); throw new Error('lost ack'); });
  assert.equal((await first.send({ text: 'Forrest report', channel: 'home23', chatId: 'owner', deliveryId: 'run-1' })).status, 'queued');
  const next = new Home23Adapter(root, async input => { committed.add(input.messageId); seen.push(input.messageId); });
  await next.flush(); await next.flush();
  assert.equal(committed.size, 1); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
  assert.equal((await next.send({ text: 'Forrest report', channel: 'home23', chatId: 'owner', deliveryId: 'run-1' })).status, 'delivered');
  assert.equal(seen.length, 2);
  await assert.rejects(next.send({ text: 'Changed report', channel: 'home23', chatId: 'owner', deliveryId: 'run-1' }), /identity changed/);
  assert.equal(JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), 'utf8')).delivered, 1);
});

test('long Unicode notifications retain all content and only retry unfinished chunks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-outbox-')); t.after(() => rmSync(root, { recursive: true }));
  const text = '🏠 Home23 report\n'.repeat(6000); const committed: string[] = []; let offline = true;
  const adapter = new Home23Adapter(root, async input => {
    if (committed.length === 1 && offline) throw new Error('offline');
    assert.ok(Buffer.byteLength(input.text) <= 48_000); committed.push(input.text);
  });
  assert.equal((await adapter.send({ text, channel: 'home23', chatId: 'owner', deliveryId: 'long' })).status, 'queued');
  offline = false; await adapter.flush(); assert.equal(committed.join(''), text);
});

test('concurrent sends with one delivery ID persist and deliver one message', async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-outbox-')); t.after(() => rmSync(root, { recursive: true }));
  const seen: string[] = [];
  const adapter = new Home23Adapter(root, async input => { seen.push(input.messageId); });
  const input = { text: 'One notice', channel: 'home23', chatId: 'owner', deliveryId: 'same-run' };
  const [first, second] = await Promise.all([adapter.send(input), adapter.send(input)]);
  assert.equal(first.status, 'delivered');
  assert.equal(second.status, 'delivered');
  assert.equal(seen.length, 1);
  assert.equal(readdirSync(root).filter(name => name.endsWith('.json')).length, 1);
});

test('an unavailable outbox does not reject its unattended startup scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-outbox-'));
  const adapter = new Home23Adapter(root, async () => {});
  rmSync(root, { recursive: true });
  await adapter.start();
  await assert.doesNotReject(adapter.flush());
  await adapter.stop();
});
