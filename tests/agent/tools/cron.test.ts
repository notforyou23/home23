import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cronScheduleTool } from '../../../src/agent/tools/cron.js';
import type { CronJob } from '../../../src/scheduler/cron.js';
import type { ToolContext } from '../../../src/agent/types.js';

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
