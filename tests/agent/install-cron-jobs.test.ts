import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeInstallCronJobs, shouldLoadInstallCronJobs } from '../../src/install-cron-jobs.js';
import type { CronJob } from '../../src/scheduler/cron.js';

function cronJob(id: string, enabled = true): CronJob {
  return {
    id,
    name: id,
    enabled,
    schedule: { kind: 'cron', expr: '0 * * * *', tz: 'America/New_York' },
    payload: { kind: 'systemEvent', text: id },
    state: { nextRunAtMs: 0, consecutiveErrors: 0 },
  };
}

test('install cron jobs load by default so current local agents keep behavior', () => {
  assert.equal(shouldLoadInstallCronJobs({ scheduler: { timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' } }), true);
});

test('an agent can opt out of install cron jobs to avoid inheriting copied templates', () => {
  assert.equal(shouldLoadInstallCronJobs({
    scheduler: {
      timezone: 'America/New_York',
      jobsFile: 'cron-jobs.json',
      runsDir: 'cron-runs',
      loadInstallJobs: false,
    },
  }), false);
});

test('install cron merge preserves existing jobs and counts deterministic adds and updates', () => {
  const existing = new Map<string, CronJob>([
    ['jerry-only', cronJob('jerry-only')],
    ['conversation-backfill-daily', { ...cronJob('conversation-backfill-daily', false), state: { nextRunAtMs: 123, consecutiveErrors: 1 } }],
  ]);
  const saved: CronJob[] = [];
  const scheduler = {
    getJob(id: string) {
      return existing.get(id) || null;
    },
    addJob(job: CronJob) {
      existing.set(job.id, job);
    },
    saveJob(job: CronJob) {
      existing.set(job.id, job);
      saved.push(job);
    },
  };

  const merged = mergeInstallCronJobs({
    scheduler,
    jobs: [cronJob('conversation-backfill-daily', true), cronJob('new-job', true)],
  });

  assert.deepEqual(merged, { added: 1, updated: 1, total: 2 });
  assert.equal(existing.get('new-job')?.enabled, true);
  assert.equal(saved[0]?.id, 'conversation-backfill-daily');
  assert.equal(saved[0]?.enabled, true);
  assert.equal(saved[0]?.state?.nextRunAtMs, 123);
  assert.equal(saved[0]?.state?.consecutiveErrors, 1);
});
