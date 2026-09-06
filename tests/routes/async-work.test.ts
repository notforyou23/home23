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
import { createToolRegistry } from '../../src/agent/tools/index.ts';
import type { ToolContext } from '../../src/agent/types.ts';
import { requestAsyncWorkCancel } from '../../src/work/cancel.ts';

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

function toolContext(registry: WorkRegistry) {
  const stopped: string[] = [];
  const ctx = {
    workRegistry: registry,
    requestWorkCancel: (workId: string) => requestAsyncWorkCancel({
      registry,
      cancelCodingJob: async () => {},
      stopChat: (chatId) => { stopped.push(chatId); return true; },
    }, workId),
  } as unknown as ToolContext;
  return { ctx, stopped };
}

test('agent work tools list active work, inspect an exact id, and request cancel', async (t) => {
  const { registry } = startApp(t);
  const { ctx, stopped } = toolContext(registry);
  const active = registry.create({
    kind: 'subagent', originChatId: '123', label: 'active audit',
    resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' },
  });
  const terminal = registry.create({
    kind: 'coding', originChatId: '123', label: 'finished fix',
    resultHandle: { type: 'coding_job', jobId: 'cj_done' },
  });
  registry.complete(terminal.workId, 'completed');
  const tools = createToolRegistry();

  const list = tools.get('work_list');
  const status = tools.get('work_status');
  const cancel = tools.get('work_cancel');
  assert.ok(list, 'work_list must be registered');
  assert.ok(status, 'work_status must be registered');
  assert.ok(cancel, 'work_cancel must be registered');

  const activeResult = await list.execute({}, ctx);
  assert.match(activeResult.content, new RegExp(active.workId));
  assert.doesNotMatch(activeResult.content, new RegExp(terminal.workId));
  const allResult = await list.execute({ include_terminal: true }, ctx);
  assert.match(allResult.content, new RegExp(terminal.workId));

  const exact = await status.execute({ work_id: active.workId }, ctx);
  assert.match(exact.content, /active audit/);
  const missing = await status.execute({ work_id: 'aw_missing_0000' }, ctx);
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /unknown work id/i);

  const requested = await cancel.execute({ work_id: active.workId }, ctx);
  assert.match(requested.content, /cancel.*requested/i);
  assert.deepEqual(stopped, ['subagent:123:aaaa']);
  assert.equal(registry.complete(active.workId, 'failed', 'operator_stop').status, 'cancelled');
  const alreadyTerminal = await cancel.execute({ work_id: active.workId }, ctx);
  assert.equal(alreadyTerminal.is_error, true);
  assert.match(alreadyTerminal.content, /already terminal/i);
});

test('work stream accepts EventSource query tokens', async (t) => {
  const { base } = startApp(t);
  const res = await fetch(`${base}/api/work/stream?chatId=dash-1&token=secret`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type') || ''), /text\/event-stream/);
  await res.body?.cancel();
});

test('inject enqueues steer and rejects empty, coding, and terminal work', async (t) => {
  const { registry, base } = startApp(t);
  const sub = registry.create({
    kind: 'subagent', originChatId: '123', label: 'audit',
    resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:aaaa' },
  });
  const cron = registry.create({
    kind: 'cron', originChatId: 'cron-nightly', label: 'Nightly',
    resultHandle: { type: 'cron_chat', chatId: 'cron-nightly' },
  });
  const coding = registry.create({
    kind: 'coding', originChatId: '123', label: 'fix',
    resultHandle: { type: 'coding_job', jobId: 'cj_1' },
  });

  const empty = await fetch(`${base}/api/work/${sub.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: '  ' }),
  });
  assert.equal(empty.status, 400);

  const codingRes = await fetch(`${base}/api/work/${coding.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: 'please stop' }),
  });
  assert.equal(codingRes.status, 400);

  const ok = await fetch(`${base}/api/work/${sub.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: 'do not restart nginx' }),
  });
  assert.equal(ok.status, 202);
  const okBody = await ok.json() as { pending: number; workId: string };
  assert.equal(okBody.workId, sub.workId);
  assert.equal(okBody.pending, 1);
  assert.match(String(registry.get(sub.workId)?.progressSummary || ''), /steer pending/i);

  const cronOk = await fetch(`${base}/api/work/${cron.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: 'skip the weekly dump' }),
  });
  assert.equal(cronOk.status, 202);

  registry.complete(sub.workId, 'completed');
  const terminal = await fetch(`${base}/api/work/${sub.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: 'too late' }),
  });
  assert.equal(terminal.status, 409);
});

test('inject overflow is rejected at 8 pending notes', async (t) => {
  const { registry, base } = startApp(t);
  const sub = registry.create({
    kind: 'subagent', originChatId: '123', label: 'audit',
    resultHandle: { type: 'subagent_chat', chatId: 'subagent:123:ffff' },
  });
  for (let i = 0; i < 8; i++) {
    const res = await fetch(`${base}/api/work/${sub.workId}/inject`, {
      method: 'POST', ...AUTH, body: JSON.stringify({ text: `note ${i}` }),
    });
    assert.equal(res.status, 202);
  }
  const overflow = await fetch(`${base}/api/work/${sub.workId}/inject`, {
    method: 'POST', ...AUTH, body: JSON.stringify({ text: 'ninth' }),
  });
  assert.equal(overflow.status, 409);
});

test('work stream sends a snapshot then live origin updates', async (t) => {
  const { registry, base } = startApp(t);
  const res = await fetch(`${base}/api/work/stream?chatId=dash-1`, AUTH);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type') || ''), /text\/event-stream/);
  const reader = res.body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let buf = '';
  const readJsonEvent = async () => {
    for (;;) {
      while (true) {
        const idx = buf.indexOf('\n\n');
        if (idx < 0) break;
        const chunk = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith('data:')) continue;
        return JSON.parse(chunk.slice(5).trim());
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed before event');
      buf += decoder.decode(value, { stream: true });
    }
  };
  const snap = await readJsonEvent();
  assert.equal(snap.type, 'snapshot');
  assert.deepEqual(snap.work, []);
  registry.create({
    kind: 'subagent',
    originChatId: 'dash-1',
    label: 'bg audit',
    resultHandle: { type: 'subagent_chat', chatId: 'subagent:dash-1:aa' },
  });
  const update = await readJsonEvent();
  assert.equal(update.type, 'update');
  assert.equal(update.work.label, 'bg audit');
  assert.equal(update.work.originChatId, 'dash-1');
});
