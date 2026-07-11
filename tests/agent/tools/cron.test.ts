import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cronScheduleTool } from '../../../src/agent/tools/cron.js';
import {
  CRON_TIMEOUT_MAX_SECONDS,
  preserveCronBrainQueryDeliveryFailure,
  runCronBrainQuery,
  runCronBrainQueryJob,
} from '../../../src/agent/cron-brain-query.js';
import { CORE_RUNTIME_PROMPT } from '../../../src/agents/system-prompt.js';
import type { BrainOperationsClient } from '../../../src/agent/brain-operations/client.js';
import type { BrainOperationResult } from '../../../src/agent/brain-operations/types.js';
import type { CronJob } from '../../../src/scheduler/cron.js';
import type { ToolContext } from '../../../src/agent/types.js';
import {
  canonicalBrainTarget,
  makeBrainOperationRecord,
} from '../../helpers/brain-operation-record.js';

function ctx(scheduler: { addJob(job: CronJob): void }): ToolContext {
  return {
    scheduler: scheduler as never,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5002,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => {},
    },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: 'chat',
    telegramAdapter: null,
    runAgentLoop: null,
  };
}

test('cron_schedule rejects new recurring jobs that are not tied to an agency pursuit', async () => {
  const scheduled: CronJob[] = [];
  const result = await cronScheduleTool.execute({
    name: 'orphan recurring report',
    schedule_kind: 'cron',
    cron_expr: '0 9 * * *',
    message: 'send a report',
  }, ctx({ addJob: (job) => scheduled.push(job) }));

  assert.equal(result.is_error, true);
  assert.match(result.content, /pursuit_id is required/);
  assert.equal(scheduled.length, 0);
});

test('cron_schedule records pursuit binding for approved recurring jobs', async () => {
  const scheduled: CronJob[] = [];
  const result = await cronScheduleTool.execute({
    name: 'bounded pursuit review',
    schedule_kind: 'every',
    every_ms: 60000,
    message: 'review this pursuit',
    pursuit_id: 'ap_bound123',
  }, ctx({ addJob: (job) => scheduled.push(job) }));

  assert.equal(result.is_error, undefined);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].agency?.pursuitId, 'ap_bound123');
  assert.match(result.content, /pursuit: ap_bound123/);
});

test('cron_schedule allows one-shot jobs without pursuit binding', async () => {
  const scheduled: CronJob[] = [];
  const result = await cronScheduleTool.execute({
    name: 'one shot reminder',
    schedule_kind: 'at',
    at: '2026-05-26T09:00:00-04:00',
    message: 'check once',
  }, ctx({ addJob: (job) => scheduled.push(job) }));

  assert.equal(result.is_error, undefined);
  assert.equal(scheduled.length, 1);
});

function cronOperation(overrides: Partial<BrainOperationResult> = {}): BrainOperationResult {
  return {
    ...makeBrainOperationRecord({
      operationId: 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requestId: 'brreq_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      operationType: 'query',
      requestParameters: { query: 'scheduled lookup' },
      parameters: { query: 'scheduled lookup' },
      recordVersion: 2,
      eventSequence: 3,
      target: canonicalBrainTarget('jerry', 'own'),
      state: 'complete',
      phase: 'done',
      completedAt: '2026-07-11T00:01:00.000Z',
      updatedAt: '2026-07-11T00:01:00.000Z',
      lastProviderActivityAt: '2026-07-11T00:00:59.000Z',
      lastProgressAt: '2026-07-11T00:00:59.000Z',
      result: { answer: 'durable scheduled answer' },
      resultHandle: 'brres_cccccccccccccccccccccccccccccccc',
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
    }),
    attachmentState: 'closed',
    ...overrides,
  };
}

test('scheduled brain query uses one durable client request with exact alias pair', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    query: async (request: Record<string, unknown>, signal?: AbortSignal) => {
      calls.push({ request, signal });
      return cronOperation();
    },
  } as unknown as BrainOperationsClient;
  const signal = new AbortController().signal;
  const result = await runCronBrainQuery(client, {
    message: 'scheduled lookup',
    mode: 'full',
    model: 'mini',
  }, {
    mini: { provider: 'openai', model: 'gpt-5.4-mini' },
  }, signal);

  assert.deepEqual(calls, [{
    request: {
      query: 'scheduled lookup',
      mode: 'full',
      modelSelection: { provider: 'openai', model: 'gpt-5.4-mini' },
    },
    signal,
  }]);
  assert.equal(result.text, 'durable scheduled answer');
  assert.equal(result.operationId, 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.state, 'complete');
});

test('scheduled brain query uses the coordinator 12000-character query boundary', async () => {
  const calls: string[] = [];
  const client = {
    query: async (request: { query: string }) => {
      calls.push(request.query);
      return cronOperation();
    },
  } as unknown as BrainOperationsClient;
  const withinBoundary = 'é'.repeat(12_000);

  await runCronBrainQuery(client, { message: withinBoundary }, {});
  assert.deepEqual(calls, [withinBoundary]);
  await assert.rejects(
    runCronBrainQuery(client, { message: `${withinBoundary}x` }, {}),
    (error: any) => error.code === 'cron_brain_query_message_invalid',
  );
  assert.equal(calls.length, 1, 'invalid input must fail before durable dispatch');
});

test('scheduled brain query preserves detached and useful partial authority without duplication', async () => {
  let calls = 0;
  const values = [
    cronOperation({
      state: 'running',
      phase: 'provider',
      result: null,
      completedAt: null,
      attachmentState: 'detached',
    }),
    cronOperation({
      state: 'partial',
      result: { answer: 'useful partial answer' },
      error: { code: 'provider_incomplete', message: 'provider ended early', retryable: true },
    }),
  ];
  const client = {
    query: async () => {
      calls += 1;
      return values.shift();
    },
  } as unknown as BrainOperationsClient;

  const detached = await runCronBrainQuery(client, { message: 'one' }, {});
  assert.match(detached.text, /still running/i);
  assert.match(detached.text, /brain_status \{action:"wait",operationId:/);
  const partial = await runCronBrainQuery(client, { message: 'two' }, {});
  assert.match(partial.text, /useful partial answer/);
  assert.match(partial.text, /partial.*provider_incomplete/i);
  assert.equal(calls, 2, 'each scheduled invocation starts at most one durable operation');
});

test('scheduled brain query rejects failed authority, invalid mode, and unknown model alias', async () => {
  const failed = {
    query: async () => cronOperation({
      state: 'failed',
      result: null,
      error: { code: 'source_unavailable', message: 'source unavailable', retryable: true },
    }),
  } as unknown as BrainOperationsClient;
  await assert.rejects(
    runCronBrainQuery(failed, { message: 'x' }, {}),
    (error: any) => error.code === 'source_unavailable'
      && error.operationId === 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  await assert.rejects(
    runCronBrainQuery(failed, { message: 'x', mode: 'legacy-normal' }, {}),
    (error: any) => error.code === 'cron_brain_query_mode_invalid',
  );
  await assert.rejects(
    runCronBrainQuery(failed, { message: 'x', model: 'missing' }, {}),
    (error: any) => error.code === 'cron_brain_query_model_alias_not_found',
  );
});

test('cron tool advertises the durable query deadline instead of the legacy 120-second cutoff', () => {
  const schema = cronScheduleTool.input_schema as {
    properties?: {
      timeout_seconds?: { type?: string; minimum?: number; maximum?: number; description?: string };
    };
  };
  const timeout = schema.properties?.timeout_seconds;
  const description = timeout?.description || '';
  assert.equal(timeout?.type, 'integer');
  assert.equal(timeout?.minimum, 1);
  assert.equal(CRON_TIMEOUT_MAX_SECONDS, 2_147_483);
  assert.equal(timeout?.maximum, CRON_TIMEOUT_MAX_SECONDS);
  assert.ok(CRON_TIMEOUT_MAX_SECONDS > 21_600, 'bound must preserve the six-hour agentTurn default');
  assert.match(description, /durable query=5400/);
  assert.doesNotMatch(description, /query=120/);
});

test('scheduled brain query job preserves typed terminal authority through the scheduler boundary', async () => {
  const failed = {
    query: async () => cronOperation({
      state: 'failed',
      result: null,
      error: { code: 'source_unavailable', message: 'source unavailable', retryable: true },
    }),
  } as unknown as BrainOperationsClient;

  const outcome = await runCronBrainQueryJob(failed, { message: 'x' }, {});

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.semanticStatus, 'failed');
  assert.match(outcome.error || '', /source_unavailable/);
  assert.match(outcome.error || '', /brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(outcome.error || '', /source unavailable/);
});

test('delivery failure cannot overwrite durable terminal authority', () => {
  const outcome = preserveCronBrainQueryDeliveryFailure({
    status: 'error',
    error: '[code=source_unavailable operation=brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] source unavailable',
    semanticStatus: 'failed',
  }, 'telegram unavailable');

  assert.equal(outcome.status, 'error');
  assert.equal(outcome.semanticStatus, 'failed');
  assert.match(outcome.error || '', /source_unavailable/);
  assert.match(outcome.error || '', /brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(outcome.error || '', /delivery_failed/);
  assert.match(outcome.error || '', /telegram unavailable/);
});

test('scheduled brain query deadline carries wait_deadline and remains a detached unknown result', async () => {
  let scheduledDelay = -1;
  let cleared = false;
  const client = {
    query: async (_request: unknown, signal?: AbortSignal) => new Promise<BrainOperationResult>((resolve) => {
      assert.ok(signal);
      const finish = () => {
        assert.equal((signal.reason as { code?: string } | undefined)?.code, 'wait_deadline');
        resolve(cronOperation({
          state: 'running',
          result: null,
          completedAt: null,
          attachmentState: 'detached',
        }));
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    }),
  } as unknown as BrainOperationsClient;

  const outcome = await runCronBrainQueryJob(client, { message: 'x' }, {}, {
    setTimeout: (callback, delayMs) => {
      scheduledDelay = delayMs;
      queueMicrotask(callback);
      return 'deadline';
    },
    clearTimeout: (handle) => {
      assert.equal(handle, 'deadline');
      cleared = true;
    },
  });

  assert.equal(scheduledDelay, 5_400_000);
  assert.equal(cleared, true);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.semanticStatus, 'unknown');
  assert.match(outcome.response || '', /brain_status \{action:"wait",operationId:/);
});

test('cron timeout rejects invalid values before persistence and durable dispatch', async () => {
  const invalid = [-1, 1.5, Number.POSITIVE_INFINITY, CRON_TIMEOUT_MAX_SECONDS + 1];
  const scheduled: CronJob[] = [];
  for (const timeout_seconds of invalid) {
    const result = await cronScheduleTool.execute({
      name: 'invalid timeout',
      schedule_kind: 'at',
      at: '2030-01-01T00:00:00Z',
      payload_kind: 'query',
      message: 'x',
      timeout_seconds,
    }, ctx({ addJob: (job) => scheduled.push(job) }));
    assert.equal(result.is_error, true);
    assert.match(result.content, /timeout_seconds/i);
  }
  assert.equal(scheduled.length, 0);

  let calls = 0;
  const client = {
    query: async () => {
      calls += 1;
      return cronOperation();
    },
  } as unknown as BrainOperationsClient;
  const outcome = await runCronBrainQueryJob(client, {
    message: 'x',
    timeoutSeconds: -1,
  }, {});
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error || '', /cron_timeout_seconds_invalid/);
  assert.equal(calls, 0);
});

test('cron query guidance has no lightweight latency promise', () => {
  const lightweightQuery = /(?:\bquery\b[^\n]{0,100}\blightweight\b|\blightweight\b[^\n]{0,100}\bquery\b)/i;
  assert.doesNotMatch(cronScheduleTool.description, lightweightQuery);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, lightweightQuery);
});
