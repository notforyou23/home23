import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { createAsyncWorkRouter } from '../../src/routes/async-work.ts';

function startApp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'work-routes-'));
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const cancelled: string[] = [];
  const stopped: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/work', createAsyncWorkRouter({
    registry,
    token: 'secret',
    cancelCodingJob: async (jobId) => { cancelled.push(jobId); },
    stopChat: (chatId) => { stopped.push(chatId); return true; },
    readReceiptDetail: (work) => ({ note: `detail for ${work.workId}` }),
  }));
  const server = app.listen(0);
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const port = (server.address() as AddressInfo).port;
  return { registry, cancelled, stopped, base: `http://127.0.0.1:${port}` };
}

const AUTH = { headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' } };

test('auth required', async (t) => {
  const { base } = startApp(t);
  assert.equal((await fetch(`${base}/api/work`)).status, 401);
  assert.equal((await fetch(`${base}/api/work`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('list with filters, get, receipt', async (t) => {
  const { registry, base } = startApp(t);
  const a = registry.create({ kind: 'coding', originChatId: 'ios_c_jerry_x_y', label: 'a', resultHandle: { type: 'coding_job', jobId: 'cj_1' } });
  const b = registry.create({ kind: 'subagent', originChatId: '123', label: 'b', resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' } });
  registry.complete(b.workId, 'completed');

  const all = await (await fetch(`${base}/api/work`, AUTH)).json();
  assert.equal(all.work.length, 2);
  const active = await (await fetch(`${base}/api/work?active=1`, AUTH)).json();
  assert.deepEqual(active.work.map((w: { workId: string }) => w.workId), [a.workId]);
  const byChat = await (await fetch(`${base}/api/work?chatId=123`, AUTH)).json();
  assert.deepEqual(byChat.work.map((w: { workId: string }) => w.workId), [b.workId]);

  const one = await (await fetch(`${base}/api/work/${a.workId}`, AUTH)).json();
  assert.equal(one.workId, a.workId);
  assert.equal((await fetch(`${base}/api/work/aw_missing_x`, AUTH)).status, 404);

  const receipt = await (await fetch(`${base}/api/work/${a.workId}/receipt`, AUTH)).json();
  assert.equal(receipt.work.workId, a.workId);
  assert.equal(receipt.detail.note, `detail for ${a.workId}`);
});

test('cancel routes by kind and records intent', async (t) => {
  const { registry, cancelled, stopped, base } = startApp(t);
  const cod = registry.create({ kind: 'coding', originChatId: '1', label: 'c', resultHandle: { type: 'coding_job', jobId: 'cj_c_9' } });
  const sub = registry.create({ kind: 'subagent', originChatId: '1', label: 's', resultHandle: { type: 'subagent_chat', chatId: 'subagent:1:bbbb' } });

  const r1 = await fetch(`${base}/api/work/${cod.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r1.status, 202);
  assert.deepEqual(cancelled, ['cj_c_9']);

  const r2 = await fetch(`${base}/api/work/${sub.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r2.status, 202);
  assert.deepEqual(stopped, ['subagent:1:bbbb']);
  // cancel intent recorded: a failed landing maps to cancelled
  assert.equal(registry.complete(sub.workId, 'failed', 'aborted').status, 'cancelled');

  registry.complete(cod.workId, 'completed');
  const r3 = await fetch(`${base}/api/work/${cod.workId}/cancel`, { method: 'POST', ...AUTH });
  assert.equal(r3.status, 409); // already terminal
});
