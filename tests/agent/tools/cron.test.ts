import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../../src/agent/tools/index.ts';
import { cronRunTool } from '../../../src/agent/tools/cron.ts';

test('tool registry exposes cron_run', () => {
  const registry = createToolRegistry();
  assert.ok(registry.get('cron_run'));
});

test('cron_run executes a job through the scheduler and reports updated state', async () => {
  let ranJobId: string | null = null;
  const ctx = {
    scheduler: {
      getJob(id: string) {
        return id === 'job-1'
          ? {
              id,
              name: 'Health check',
              state: {
                nextRunAtMs: Date.parse('2026-05-11T10:00:00.000Z'),
                consecutiveErrors: 0,
              },
            }
          : undefined;
      },
      async runJobNow(id: string) {
        ranJobId = id;
        return { status: 'ok', response: 'passed', durationMs: 42 };
      },
    },
  } as any;

  const result = await cronRunTool.execute({ job_id: 'job-1' }, ctx);

  assert.equal(ranJobId, 'job-1');
  assert.equal(result.is_error, false);
  assert.match(result.content, /Ran job: Health check/);
  assert.match(result.content, /status: ok/);
  assert.match(result.content, /consecutiveErrors: 0/);
});

test('cron_run refuses unknown jobs without invoking scheduler execution', async () => {
  let ran = false;
  const ctx = {
    scheduler: {
      getJob() {
        return undefined;
      },
      async runJobNow() {
        ran = true;
        return { status: 'ok', durationMs: 1 };
      },
    },
  } as any;

  const result = await cronRunTool.execute({ job_id: 'missing' }, ctx);

  assert.equal(ran, false);
  assert.equal(result.is_error, true);
  assert.match(result.content, /Job not found: missing/);
});
