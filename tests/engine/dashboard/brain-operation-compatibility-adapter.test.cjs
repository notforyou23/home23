'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  BrainOperationsCompatibilityAdapter,
  DETACH_CLEANUP_MS,
} = require('../../../engine/src/dashboard/brain-operations/compatibility-adapter.js');
const {
  createBrainOperationExporter,
} = require('../../../engine/src/dashboard/brain-operations/exporter.js');

const OPERATION_ID = `brop_${'a'.repeat(32)}`;
const RESULT_HANDLE = `brres_${'b'.repeat(32)}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function record(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    operationType: 'query',
    requesterAgent: 'jerry',
    canonicalEvidence: true,
    state: 'running',
    eventSequence: 0,
    result: null,
    resultHandle: null,
    resultArtifact: null,
    resultExpiredAt: null,
    error: null,
    sourceEvidence: null,
    ...overrides,
  };
}

function exportReceipt(overrides = {}) {
  return {
    exportHandle: `brexp_${'c'.repeat(32)}`,
    relativePath: `workspace/brain-exports/result-brexp_${'c'.repeat(32)}.md`,
    bytes: 123,
    sha256: 'd'.repeat(64),
    sourceOperationId: OPERATION_ID,
    sourceResultHandleHash: crypto.createHash('sha256').update(RESULT_HANDLE).digest('hex'),
    format: 'markdown',
    canonicalEvidence: true,
    ...overrides,
  };
}

function makeAdapter(overrides = {}) {
  const coordinator = {
    start: async () => record({ state: 'queued' }),
    attach: async () => ({ done: Promise.resolve(record({ state: 'complete' })) }),
    detach: async () => ({ state: 'detached' }),
    ...overrides.coordinator,
  };
  const reader = {
    getAuthorized: async () => record({ state: 'complete', resultHandle: RESULT_HANDLE }),
    getResultAuthorized: async () => ({ answer: 'protected' }),
    ...overrides.reader,
  };
  const exporter = {
    exportResult: async () => exportReceipt(),
    ...overrides.exporter,
  };
  const adapter = new BrainOperationsCompatibilityAdapter({
    requesterAgent: 'jerry',
    coordinator,
    reader,
    exporter,
    ...(overrides.timers ? { timers: overrides.timers } : {}),
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
  });
  return { adapter, coordinator, reader, exporter };
}

test('compatibility adapter rejects terminal and cross-requester start records', async () => {
  for (const started of [
    record({ state: 'complete' }),
    record({ state: 'queued', requesterAgent: 'forrest' }),
  ]) {
    const { adapter } = makeAdapter({ coordinator: { start: async () => started } });
    await assert.rejects(
      adapter.start({ requestId: 'request-1', operationType: 'query', parameters: { query: 'x' } }),
      (error) => ['operation_contract_invalid', 'access_denied'].includes(error.code),
    );
  }
});

test('compatibility attachment deadline detaches durable work without cancelling it', async () => {
  const done = deferred();
  const timers = [];
  const calls = [];
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async () => ({ done: done.promise }),
      detach: async (_operationId, input) => {
        calls.push(['detach', input.reason]);
        done.resolve({ state: 'detached' });
        return { state: 'detached' };
      },
      cancel: async () => { calls.push(['cancel']); },
    },
    reader: { getAuthorized: async () => record({ state: 'running', eventSequence: 4 }) },
    timers: {
      setTimeout: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimeout: () => {},
    },
  });
  const pending = adapter.attachAndWait(record(), {
    attachmentId: 'attachment-1',
    waitMs: 5_400_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0].ms, 5_400_000);
  timers[0].callback();
  const result = await pending;
  assert.equal(result.state, 'running');
  assert.equal(result.attachmentState, 'detached');
  assert.equal(result.detachedReason, 'attachment_deadline');
  assert.deepEqual(calls, [['detach', 'attachment_deadline']]);
});

test('compatibility caller abort detaches only its attachment and keeps operation actionable', async () => {
  const done = deferred();
  const reasons = [];
  const controller = new AbortController();
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async () => ({ done: done.promise }),
      detach: async (_operationId, input) => {
        reasons.push(input.reason);
        done.resolve({ state: 'detached' });
        return { state: 'detached' };
      },
    },
    reader: { getAuthorized: async () => record({ state: 'running', eventSequence: 2 }) },
  });
  const pending = adapter.attachAndWait(record(), {
    attachmentId: 'attachment-2',
    waitMs: 5_400_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('caller left'));
  const result = await pending;
  assert.equal(result.attachmentState, 'detached');
  assert.deepEqual(reasons, ['caller_abort']);
});

test('compatibility deadline reports the last confirmed attached state when detach cleanup fails', async () => {
  const timers = [];
  const never = deferred();
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async () => ({ done: never.promise }),
      detach: async () => { throw Object.assign(new Error('disk busy'), { code: 'detach_failed' }); },
    },
    reader: { getAuthorized: async () => record({ state: 'running', eventSequence: 2 }) },
    timers: {
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      clearTimeout: () => {},
    },
  });
  const pending = adapter.attachAndWait(record(), {
    attachmentId: 'attachment-4',
    waitMs: 5_400_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  timers[0]();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'attachment_detach_failed');
    assert.equal(error.operationId, OPERATION_ID);
    assert.equal(error.state, 'running');
    assert.equal(error.attachmentState, 'attached');
    return true;
  });
});

test('compatibility detach cleanup is bounded and never reports a hanging detach as detached', async () => {
  const timers = [];
  const never = deferred();
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async () => ({ done: never.promise }),
      detach: async () => new Promise(() => {}),
    },
    reader: { getAuthorized: async () => record({ state: 'running', eventSequence: 2 }) },
    timers: {
      setTimeout: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimeout: () => {},
    },
  });
  const pending = adapter.attachAndWait(record(), {
    attachmentId: 'attachment-bounded-cleanup',
    waitMs: 5_400_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0].ms, 5_400_000);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[1].ms, DETACH_CLEANUP_MS);
  timers[1].callback();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'attachment_detach_failed');
    assert.equal(error.operationId, OPERATION_ID);
    assert.equal(error.state, 'running');
    assert.equal(error.attachmentState, 'attached');
    return true;
  });
});

test('compatibility attachment setup failures attempt durable detach cleanup', async () => {
  let detaches = 0;
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async () => ({ done: new Promise(() => {}) }),
      detach: async () => { detaches += 1; return { state: 'detached' }; },
    },
    timers: {
      setTimeout: () => { throw new Error('timer setup failed'); },
      clearTimeout: () => {},
    },
  });
  await assert.rejects(adapter.attachAndWait(record(), {
    attachmentId: 'attachment-5',
    waitMs: 5_400_000,
  }), /timer setup failed/);
  assert.equal(detaches, 1);
});

test('compatibility invalid replay event detaches the opened attachment', async () => {
  let detaches = 0;
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async (_operationId, input) => {
        input.onEvent({ operationId: OPERATION_ID, eventSequence: -1, type: 'progress' });
        return { done: Promise.resolve() };
      },
      detach: async () => { detaches += 1; return { state: 'detached' }; },
    },
  });
  await assert.rejects(adapter.attachAndWait(record(), {
    attachmentId: 'attachment-6',
    waitMs: 5_400_000,
    onEvent: () => {},
  }), (error) => error.code === 'event_stream_invalid');
  assert.equal(detaches, 1);
});

test('compatibility adapter emits monotonic events and reloads terminal bytes through reader', async () => {
  const seen = [];
  let protectedReads = 0;
  const { adapter } = makeAdapter({
    coordinator: {
      attach: async (_operationId, input) => {
        input.onEvent({ operationId: OPERATION_ID, eventSequence: 2, type: 'progress' });
        input.onEvent({ operationId: OPERATION_ID, eventSequence: 1, type: 'progress' });
        input.onEvent({ operationId: OPERATION_ID, eventSequence: 2, type: 'progress' });
        input.onEvent({ operationId: OPERATION_ID, eventSequence: 3, type: 'terminal' });
        return { done: Promise.resolve({ state: 'complete' }) };
      },
    },
    reader: {
      getAuthorized: async () => record({
        state: 'complete', eventSequence: 3, resultHandle: RESULT_HANDLE,
      }),
      getResultAuthorized: async (_operationId, handle) => {
        protectedReads += 1;
        assert.equal(handle, RESULT_HANDLE);
        return { answer: 'protected terminal bytes' };
      },
    },
  });
  const status = await adapter.attachAndWait(record(), {
    attachmentId: 'attachment-3',
    waitMs: 5_400_000,
    onEvent: (event) => seen.push(event.eventSequence),
  });
  assert.equal(status.attachmentState, 'closed');
  assert.deepEqual(seen, [2, 3]);
  const result = await adapter.getResult(OPERATION_ID);
  assert.equal(result.operationType, 'query');
  assert.deepEqual(result.result, { answer: 'protected terminal bytes' });
  assert.equal(protectedReads, 1);
});

test('compatibility canonical export normalizes the real receipt into durable and legacy fields', async () => {
  const calls = [];
  const { adapter } = makeAdapter({
    exporter: {
      exportResult: async (input) => {
        calls.push(input);
        return exportReceipt();
      },
    },
  });
  const result = await adapter.exportStored({
    kind: 'canonical',
    operationId: OPERATION_ID,
    resultHandle: RESULT_HANDLE,
    format: 'markdown',
    fileName: 'result',
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.state, 'complete');
  assert.equal(result.resultHandle, RESULT_HANDLE);
  assert.equal(result.canonicalEvidence, true);
  assert.equal(result.exportedTo, exportReceipt().relativePath);
  assert.deepEqual(
    Object.fromEntries(Object.keys(exportReceipt()).map((key) => [key, result[key]])),
    exportReceipt(),
  );
  assert.deepEqual(calls, [{
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    resultHandle: RESULT_HANDLE,
    format: 'markdown',
    fileName: 'result',
  }]);
});

test('compatibility canonical export rejects an unsafe or malformed public receipt', async () => {
  for (const receipt of [
    exportReceipt({ relativePath: '../outside.md' }),
    exportReceipt({ sourceOperationId: `brop_${'z'.repeat(32)}` }),
    exportReceipt({ canonicalEvidence: false }),
  ]) {
    const { adapter } = makeAdapter({
      exporter: { exportResult: async () => receipt },
    });
    await assert.rejects(adapter.exportStored({
      kind: 'canonical', operationId: OPERATION_ID, resultHandle: RESULT_HANDLE,
      format: 'markdown', fileName: 'result',
    }), (error) => error.code === 'export_receipt_invalid');
  }
});

test('compatibility canonical export normalizes the actual local exporter receipt', async (t) => {
  const home23Root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), 'brain-compat-export-'),
  ));
  for (const relative of [
    'instances/jerry/brain', 'instances/jerry/runtime', 'instances/jerry/workspace',
  ]) fs.mkdirSync(path.join(home23Root, relative), { recursive: true });
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const stored = record({
    state: 'complete',
    canonicalEvidence: true,
    result: { answer: 'stored result' },
    resultHandle: null,
  });
  const reader = {
    getAuthorized: async () => stored,
    getResultAuthorized: async () => stored.result,
    openResultArtifactAuthorized: async () => { throw new Error('not used'); },
  };
  const exporter = createBrainOperationExporter({
    home23Root,
    requesterAgent: 'jerry',
    reader,
    now: () => Date.parse('2026-07-10T16:00:00.000Z'),
    randomBytes: () => Buffer.alloc(24, 7),
  });
  const adapter = new BrainOperationsCompatibilityAdapter({
    requesterAgent: 'jerry',
    reader,
    exporter,
    coordinator: {
      start: async () => { throw new Error('not used'); },
      attach: async () => { throw new Error('not used'); },
      detach: async () => { throw new Error('not used'); },
    },
  });
  const result = await adapter.exportStored({
    kind: 'canonical', operationId: OPERATION_ID, format: 'json', fileName: 'real-result',
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.state, 'complete');
  assert.equal(result.resultHandle, null);
  assert.equal(result.canonicalEvidence, true);
  assert.equal(result.exportedTo, result.relativePath);
  assert.equal(fs.existsSync(path.join(home23Root, 'instances/jerry', result.exportedTo)), true);
});

test('compatibility ad hoc export creates an explicit noncanonical durable operation', async () => {
  const starts = [];
  const { adapter } = makeAdapter({
    coordinator: {
      start: async (input) => {
        starts.push(input);
        return record({ state: 'queued', operationType: 'ad_hoc_export' });
      },
      attach: async () => ({ done: Promise.resolve({ state: 'complete' }) }),
    },
    reader: {
      getAuthorized: async () => record({
        state: 'complete', operationType: 'ad_hoc_export', eventSequence: 1,
        resultHandle: RESULT_HANDLE,
      }),
      getResultAuthorized: async () => exportReceipt({
        relativePath: `workspace/brain-exports/ad-hoc-brexp_${'c'.repeat(32)}.md`,
        sourceResultHandleHash: null,
        canonicalEvidence: false,
      }),
    },
  });
  const result = await adapter.exportStored({
    kind: 'ad_hoc',
    requestId: 'request-export',
    query: 'x',
    answer: 'not canonical evidence',
    format: 'markdown',
    metadata: { canonicalEvidence: false },
  });
  assert.equal(starts[0].operationType, 'ad_hoc_export');
  assert.equal(starts[0].parameters.answer, 'not canonical evidence');
  assert.equal(result.canonicalEvidence, false);
  assert.equal(result.exportedTo, result.relativePath);
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.state, 'complete');
  assert.equal(result.resultHandle, RESULT_HANDLE);
});
