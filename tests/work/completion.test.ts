import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../../src/work/work-store.ts';
import { WorkRegistry } from '../../src/work/registry.ts';
import { handleWorkCompletion, reviewPrompt, type CompletionDeps } from '../../src/work/completion.ts';
import type { ReceiptSinks } from '../../src/work/receipt-delivery.ts';
import type { AsyncWorkRecord } from '../../src/work/types.ts';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'work-comp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new WorkRegistry({ store: new WorkStore(dir), agent: 'jerry' });
  const calls = {
    history: [] as Array<{ chatId: string; text: string }>,
    push: [] as Array<{ chatId: string; workId: string }>,
    telegram: [] as string[],
    reviews: [] as Array<{ chatId: string; prompt: string }>,
  };
  const sinks: ReceiptSinks = {
    appendHistory: (chatId, text) => calls.history.push({ chatId, text }),
    sendTelegram: (chatId, _text) => calls.telegram.push(chatId),
    pushWork: (i) => calls.push.push({ chatId: i.chatId, workId: i.workId }),
  };
  const deps: CompletionDeps = {
    registry,
    sinks,
    review: { coding: true, subagent: false },
    isChatBusy: () => false,
    waitForIdleMs: 50,
    idlePollMs: 10,
    runReviewTurn: async (chatId, prompt) => {
      calls.reviews.push({ chatId, prompt });
      return 'Report: diff verified, tests green, work lives in cj_x_1111. Nothing remains.';
    },
  };
  return { registry, calls, deps };
}

test('failure delivers immediately with one push, verification none', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_f_1' } });
  const done = registry.complete(rec.workId, 'failed', 'exit 1');
  await handleWorkCompletion(done, 'receipt: it failed', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.push.length, 1);
  assert.equal(calls.history.length, 1);
  const final = registry.get(rec.workId)!;
  assert.equal(final.verification, 'none');
  assert.ok(final.deliveredAt);
});

test('coding success with human origin: evidence receipt (no push) then reviewed report (one push)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'sched fix', resultHandle: { type: 'coding_job', jobId: 'cj_s_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt: evidence tail', deps);

  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].chatId, `workreview:${rec.workId}`);
  assert.equal(calls.history.length, 2); // evidence receipt + report, both to origin
  assert.ok(calls.history.every(h => h.chatId === 'ios_conv_42'));
  assert.equal(calls.push.length, 1);   // exactly one push, after review
  assert.equal(registry.get(rec.workId)!.verification, 'reviewed');
});

test('review skipped when origin stays busy; receipt still delivered with telegram', async (t) => {
  const { registry, calls, deps } = setup(t);
  deps.isChatBusy = () => true;
  const rec = registry.create({ kind: 'coding', originChatId: '12345', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_b_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.telegram.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'skipped');
});

test('review turn throwing falls back to direct receipt, verification skipped', async (t) => {
  const { registry, calls, deps } = setup(t);
  deps.runReviewTurn = async () => { throw new Error('provider down'); };
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_e_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt', deps);
  assert.equal(calls.push.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'skipped');
});

test('subagent success delivers directly (review off by default)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'subagent', originChatId: 'ios_conv_42', label: 'sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_conv_42:aaaa' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'sub result text', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.push.length, 1);
  assert.equal(registry.get(rec.workId)!.verification, 'none');
});

test('non-human origin delivers history-only without review', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'coding', originChatId: 'cron-agent-daily', label: 'x', resultHandle: { type: 'coding_job', jobId: 'cj_c_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'receipt', deps);
  assert.equal(calls.reviews.length, 0);
  assert.equal(calls.push.length, 0);
  assert.equal(calls.history.length, 1);
  assert.ok(registry.get(rec.workId)!.deliveredAt);
});

test('already-delivered records are skipped (recovery dedupe)', async (t) => {
  const { registry, calls, deps } = setup(t);
  const rec = registry.create({ kind: 'subagent', originChatId: 'ios_conv_42', label: 'sub', resultHandle: { type: 'subagent_chat', chatId: 'subagent:ios_conv_42:aaaa' } });
  const done = registry.complete(rec.workId, 'completed');
  await handleWorkCompletion(done, 'text', deps);
  await handleWorkCompletion(registry.get(rec.workId)!, 'text', deps);
  assert.equal(calls.push.length, 1);
});

test('reviewPrompt includes work id, label, and evidence', () => {
  const work = { workId: 'aw_1_ab', label: 'sched fix', kind: 'coding' } as AsyncWorkRecord;
  const p = reviewPrompt(work, 'EVIDENCE');
  assert.ok(p.includes('aw_1_ab'));
  assert.ok(p.includes('sched fix'));
  assert.ok(p.includes('EVIDENCE'));
});

test('concurrent delivery calls for the same work item deliver exactly once', async (t) => {
  const { registry, calls, deps } = setup(t);
  // slow review so both calls overlap while the first is mid-pipeline
  deps.runReviewTurn = async (chatId, prompt) => {
    calls.reviews.push({ chatId, prompt });
    await new Promise(resolve => setTimeout(resolve, 30));
    return 'Report after slow review.';
  };
  const rec = registry.create({ kind: 'coding', originChatId: 'ios_conv_42', label: 'race', resultHandle: { type: 'coding_job', jobId: 'cj_r_1' } });
  const done = registry.complete(rec.workId, 'completed');
  await Promise.all([
    handleWorkCompletion(done, 'receipt', deps),
    handleWorkCompletion(done, 'receipt', deps),
  ]);
  assert.equal(calls.reviews.length, 1, 'review ran once');
  assert.equal(calls.push.length, 1, 'exactly one push');
});
