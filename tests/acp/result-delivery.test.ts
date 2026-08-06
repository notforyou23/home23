import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverCodingJobResult,
  codingPushBody,
  type CodingResultSinks,
} from '../../src/acp/result-delivery.ts';
import type { CodingJobRecord, CodingJobReceipt } from '../../src/acp/types.ts';

const SECRET_TAIL = 'API_KEY=sk-secret-123 and other private diff content that must not hit the lock screen';

function makeJob(overrides: Partial<CodingJobRecord> = {}): CodingJobRecord {
  return {
    id: 'cj_20260805_ab12',
    backend: 'claude-code',
    status: 'completed',
    prompt: 'refactor the scheduler delivery path and add regression tests',
    label: 'scheduler fix',
    requestedBy: 'ios_conv_42',
    ...overrides,
  } as CodingJobRecord;
}

function makeReceipt(): CodingJobReceipt {
  return { resultTail: SECRET_TAIL, durationMs: 1000 } as CodingJobReceipt;
}

interface Recorder {
  history: Array<{ chatId: string; text: string }>;
  telegram: Array<{ chatId: string; text: string }>;
  push: Array<{ chatId: string; turnId: string; body: string }>;
}

function sinks(rec: Recorder, opts: { telegram?: boolean; push?: boolean }): CodingResultSinks {
  const s: CodingResultSinks = {
    appendHistory: (chatId, text) => rec.history.push({ chatId, text }),
  };
  if (opts.telegram) s.sendTelegram = (chatId, text) => rec.telegram.push({ chatId, text });
  if (opts.push) s.pushIos = (input) => rec.push.push(input);
  return s;
}

function newRecorder(): Recorder {
  return { history: [], telegram: [], push: [] };
}

test('ios_* origin fires an iOS push to the origin conversation, not Telegram', () => {
  const rec = newRecorder();
  const route = deliverCodingJobResult(makeJob(), makeReceipt(), sinks(rec, { telegram: true, push: true }));

  assert.equal(route, 'ios');
  assert.equal(rec.push.length, 1, 'exactly one push (no duplicate)');
  assert.equal(rec.telegram.length, 0, 'Telegram is not used for an ios_ origin');
  assert.equal(rec.push[0].chatId, 'ios_conv_42', 'routes to the true requestedBy conversation');
  assert.equal(rec.push[0].turnId, 'cj_20260805_ab12', 'carries the job id as routing metadata');
  // History still gets the full transcript.
  assert.equal(rec.history.length, 1);
  assert.match(rec.history[0].text, /API_KEY=sk-secret-123/);
});

test('iOS lock-screen body is a concise status line and never contains the result tail', () => {
  const rec = newRecorder();
  deliverCodingJobResult(makeJob(), makeReceipt(), sinks(rec, { push: true }));

  assert.equal(rec.push[0].body, 'Coding job finished: scheduler fix');
  assert.doesNotMatch(rec.push[0].body, /sk-secret-123/, 'no secret result content on the lock screen');
  assert.doesNotMatch(rec.push[0].body, /API_KEY/);

  // Failure phrasing, and the no-label fallback stays generic (no prompt leak).
  assert.equal(codingPushBody(makeJob({ status: 'failed' })), 'Coding job failed: scheduler fix');
  assert.equal(
    codingPushBody(makeJob({ status: 'completed', label: undefined })),
    'Coding job finished.',
  );
  assert.doesNotMatch(codingPushBody(makeJob({ label: undefined })), /refactor the scheduler/);
});

test('numeric (Telegram) origin retains existing Telegram behavior and fires no iOS push', () => {
  const rec = newRecorder();
  const route = deliverCodingJobResult(
    makeJob({ requestedBy: '123456789' }),
    makeReceipt(),
    sinks(rec, { telegram: true, push: true }),
  );

  assert.equal(route, 'telegram');
  assert.equal(rec.telegram.length, 1, 'Telegram delivered');
  assert.equal(rec.telegram[0].chatId, '123456789');
  assert.equal(rec.push.length, 0, 'iOS push not fired for a numeric origin (no duplicate)');
  assert.equal(rec.history.length, 1, 'history still appended');
});

test('ios_* origin with no pusher installed degrades to history-only without throwing', () => {
  const rec = newRecorder();
  const route = deliverCodingJobResult(makeJob(), makeReceipt(), sinks(rec, { telegram: true }));

  assert.equal(route, 'none', 'unsupported push channel → no push route');
  assert.equal(rec.push.length, 0);
  assert.equal(rec.telegram.length, 0, 'an ios_ origin never falls back to Telegram');
  assert.equal(rec.history.length, 1, 'result is still preserved in history');
});

test('ios_* origin with a pusher but no registered device is a graceful no-op push call', () => {
  // The pusher IS installed, but the underlying registry has no device for this
  // chatId. deliverCodingJobResult still routes to 'ios'; the no-device no-op is
  // ApnsPusher.notifyTurnComplete's own guard (apns-pusher.ts:88-89 —
  // `if (devices.length === 0) return;`). Here we assert the routing hands off
  // exactly once and never throws.
  const rec = newRecorder();
  let calls = 0;
  const s: CodingResultSinks = {
    appendHistory: (chatId, text) => rec.history.push({ chatId, text }),
    pushIos: () => { calls += 1; /* pusher no-ops internally when no device */ },
  };
  const route = deliverCodingJobResult(makeJob(), makeReceipt(), s);

  assert.equal(route, 'ios');
  assert.equal(calls, 1, 'push sink invoked exactly once');
});

test('a job with no requestedBy origin delivers nothing (no history, no push)', () => {
  const rec = newRecorder();
  const route = deliverCodingJobResult(
    makeJob({ requestedBy: undefined }),
    makeReceipt(),
    sinks(rec, { telegram: true, push: true }),
  );

  assert.equal(route, 'none');
  assert.equal(rec.history.length, 0);
  assert.equal(rec.push.length, 0);
  assert.equal(rec.telegram.length, 0);
});

test('a non-numeric, non-ios origin (e.g. subagent tag) stays history-only', () => {
  const rec = newRecorder();
  const route = deliverCodingJobResult(
    makeJob({ requestedBy: 'subagent:audit-1' }),
    makeReceipt(),
    sinks(rec, { telegram: true, push: true }),
  );

  assert.equal(route, 'none');
  assert.equal(rec.history.length, 1);
  assert.equal(rec.push.length, 0);
  assert.equal(rec.telegram.length, 0);
});
