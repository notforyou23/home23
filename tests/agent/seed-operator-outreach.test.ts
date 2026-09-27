import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeedOperatorOutreach, seedOutreachDeliveryId, type SeedOutreachRequest } from '../../src/substrate/operator-outreach.js';
const NOW = Date.parse('2026-09-26T22:00:00.000Z');
const committed = { status: 'committed' as const, notification: 'not_confirmed' as const, messageIds: ['canonical-1'], channelId: 'owner-channel' };
function setup(t: {after(fn: () => void): void}) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-outreach-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const outbox = join(dir, 'outbox.jsonl');
  const record = (seq: number, date = NOW - 1000) => ({actSeq: seq, idempotencyKey: `act-${seq}`, commitmentId: `concern-${seq}`, message: `Would you like to revisit idea ${seq}?`, dispatchedAt: new Date(date).toISOString()});
  const append = (seq: number, date?: number) => appendFileSync(outbox, JSON.stringify(record(seq, date)) + '\n');
  const state = () => JSON.parse(readFileSync(join(dir, 'operator-outreach.json'), 'utf8'));
  return {dir, outbox, record, append, state};
}

test('committed owner messages carry deterministic Seed identity; restart and duplicate never resend', async t => {
  const f = setup(t); f.append(1); f.append(2); f.append(1);
  const sends: SeedOutreachRequest[] = [];
  const opts = {stateDir: f.dir, now: () => NOW, send: async (r: SeedOutreachRequest) => { sends.push(r); return committed; }};
  const relay = createSeedOperatorOutreach(opts);
  const result = await relay.flush();
  assert.equal(result.committed, 2); assert.equal(result.duplicate, 1);
  assert.equal(sends[0].deliveryId, seedOutreachDeliveryId(f.record(1)));
  assert.match(sends[0].reason, /concern-1.*authorized act 1/);
  assert.equal(f.state().offset, Buffer.byteLength(readFileSync(f.outbox)));
  assert.deepEqual(f.state().receipts[0].messageIds, ['canonical-1']);
  assert.equal(f.state().receipts[0].notification, 'not_confirmed');
  await createSeedOperatorOutreach(opts).flush();
  assert.equal(sends.length, 2);
  assert.equal('readAt' in f.state().receipts[0], false);
  assert.equal('deliveredAt' in f.state().receipts[0], false);
});

test('uncertain send and queued receipt survive restart with the same delivery ID until canonical commit', async t => {
  const f = setup(t); f.append(1); f.append(2);
  const ids: string[] = [];
  let attempt = 0;
  const opts = {stateDir: f.dir, now: () => NOW, send: async (r: SeedOutreachRequest) => {
    ids.push(r.deliveryId); attempt++;
    if (attempt === 1) throw new Error('response lost after possible commit');
    if (attempt === 2) return {status: 'queued' as const, notification: 'not_confirmed' as const};
    return committed;
  }};
  const failed = await createSeedOperatorOutreach(opts).flush();
  assert.equal(failed.failed, 1); assert.equal(failed.pending, 1); assert.equal(f.state().offset, 0);
  const queued = await createSeedOperatorOutreach(opts).flush();
  assert.equal(queued.queued, 1); assert.equal(queued.pending, 1); assert.equal(f.state().offset, 0);
  assert.equal(f.state().receipts[0].status, 'queued');
  assert.equal((await createSeedOperatorOutreach(opts).flush()).committed, 2);
  assert.equal(new Set(ids.slice(0, 3)).size, 1);
  assert.equal(f.state().receipts[0].attempts, 3);
});

test('old backlog expires, malformed committed entries are receipted, and an incomplete last line waits', async t => {
  const f = setup(t); f.append(1, NOW - 25 * 60 * 60 * 1000);
  appendFileSync(f.outbox, '{bad json}\n');
  const half = JSON.stringify(f.record(2)); appendFileSync(f.outbox, half);
  const sends: SeedOutreachRequest[] = [];
  const relay = createSeedOperatorOutreach({stateDir: f.dir, now: () => NOW, send: async r => { sends.push(r); return committed; }});
  const first = await relay.flush();
  assert.equal(first.expired, 1); assert.equal(first.invalid, 1); assert.equal(sends.length, 0);
  const oldCursor = f.state().offset;
  await relay.flush(); assert.equal(f.state().offset, oldCursor);
  appendFileSync(f.outbox, '\n');
  assert.equal((await relay.flush()).committed, 1); assert.equal(sends.length, 1);
});

test('bounded polling advances through a backlog and refuses changed bytes behind a durable cursor', async t => {
  const f = setup(t); for (let n = 1; n <= 80; n++) f.append(n);
  let sent = 0;
  const relay = createSeedOperatorOutreach({stateDir: f.dir, now: () => NOW, send: async () => {sent++; return committed;}});
  assert.equal((await relay.flush()).committed, 32);
  assert.equal((await relay.flush()).committed, 32);
  assert.equal((await relay.flush()).committed, 16);
  assert.equal(sent, 80);
  writeFileSync(f.outbox, JSON.stringify(f.record(100)) + '\n');
  await assert.rejects(relay.flush(), /truncated|matches/);
  assert.equal(sent, 80);
});

test('start/stop owns one in-flight flush and waits for a send before stopping', async t => {
  const f = setup(t); f.append(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  let sent = 0;
  const relay = createSeedOperatorOutreach({stateDir: f.dir, now: () => NOW, pollIntervalMs: 250, send: async () => {sent++; await gate; return committed;}});
  relay.start(); relay.start();
  const one = relay.flush(); const two = relay.flush();
  assert.equal(one, two); assert.equal(sent, 1);
  let stopped = false;
  const stop = relay.stop().then(() => {stopped = true;});
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stop;
  assert.equal(stopped, true); assert.equal(f.state().receipts[0].status, 'committed');
});

test('an already queued or uncertain attempt keeps its identity after 24h; oversized messages cannot jam later valid requests', async t => {
  const f = setup(t); f.append(1);
  let time = NOW;
  let attempt = 0;
  const ids: string[] = [];
  const relay = createSeedOperatorOutreach({stateDir: f.dir, now: () => time, send: async r => {
    ids.push(r.deliveryId); attempt++;
    return attempt === 1 ? {status: 'queued', notification: 'not_confirmed'} : committed;
  }});
  await relay.flush();
  time += 25 * 60 * 60 * 1000;
  assert.equal((await relay.flush()).committed, 1);
  assert.equal(ids[0], ids[1]);
  appendFileSync(f.outbox, JSON.stringify({...f.record(2, time), message: 'x'.repeat(4001)}) + '\n');
  f.append(3, time);
  const result = await relay.flush();
  assert.equal(result.invalid, 1); assert.equal(result.committed, 1);
});

test('Seed relay and real Home23 durable adapter share one canonical message identity across outage and restart', async t => {
  const { Home23Adapter } = await import('../../src/channels/home23.js');
  const { createOwnerOutreachSender } = await import('../../src/channels/owner-outreach.js');
  const f = setup(t); f.append(1);
  let available = false;
  const committedMessages = new Map<string, string>();
  const deliver = async ({messageId, text}: {messageId: string; text: string}) => {
    if (!available) throw new Error('Core unavailable');
    committedMessages.set(messageId, text);
  };
  const transportDir = join(f.dir, 'home23-outbox');
  const adapter = new Home23Adapter(transportDir, deliver);
  const relay = createSeedOperatorOutreach({stateDir: f.dir, now: () => NOW, send: createOwnerOutreachSender(adapter)});
  assert.equal((await relay.flush()).pending, 1);
  const queuedId = f.state().receipts[0].messageIds[0];
  assert.equal(committedMessages.size, 0);
  available = true;
  const restarted = new Home23Adapter(transportDir, deliver);
  await restarted.flush();
  const next = createSeedOperatorOutreach({stateDir: f.dir, now: () => NOW + 25 * 60 * 60 * 1000, send: createOwnerOutreachSender(restarted)});
  assert.equal((await next.flush()).committed, 1);
  assert.equal(committedMessages.size, 1);
  assert.equal(committedMessages.get(queuedId), f.record(1).message);
  assert.deepEqual(f.state().receipts[0].messageIds, [queuedId]);
  assert.equal(f.state().receipts[0].notification, 'not_confirmed');
});
