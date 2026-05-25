import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditExistingRecurringCronJobsForAgency,
  mergeExternalCronJobPreservingAgency,
} from '../../src/agency/cron-bootcamp.js';
import type { CronJob } from '../../src/scheduler/cron.js';

function recurringJob(id: string, agency?: CronJob['agency']): CronJob {
  return {
    id,
    name: `Recurring ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'exec', command: 'true' },
    delivery: { mode: 'failures' },
    ...(agency ? { agency } : {}),
    state: { nextRunAtMs: 0, consecutiveErrors: 0 },
  };
}

test('auditExistingRecurringCronJobsForAgency binds legacy recurring jobs to resident pursuits with consequence receipts', async () => {
  const saved: CronJob[] = [];
  const intakePackets: Array<Record<string, unknown>> = [];
  const consequences: Array<Record<string, unknown>> = [];
  const jobs = [
    recurringJob('legacy-recurring'),
    recurringJob('already-bound', { pursuitId: 'ap_existing', charterRule: 'no_new_cron_without_pursuit' }),
    {
      ...recurringJob('one-shot'),
      schedule: { kind: 'at', at: '2026-05-26T09:00:00-04:00' },
    } as CronJob,
  ];

  const result = await auditExistingRecurringCronJobsForAgency({
    scheduler: {
      getJobs: () => jobs,
      saveJob: (job) => saved.push(job),
    },
    kernel: {
      intake: async (packet) => {
        intakePackets.push(packet);
        return { pursuit: { id: 'ap_legacy' } };
      },
      recordConsequence: async (packet) => {
        consequences.push(packet);
      },
    },
    now: '2026-05-25T20:00:00.000Z',
  });

  assert.equal(result.checked, 3);
  assert.equal(result.bound, 1);
  assert.equal(result.skippedAlreadyBound, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'legacy-recurring');
  assert.equal(saved[0].agency?.pursuitId, 'ap_legacy');
  assert.equal(saved[0].agency?.charterRule, 'existing_recurring_cron_requires_pursuit');
  assert.equal(saved[0].agency?.auditDecision, 'bound_existing_recurring_job');
  assert.equal(intakePackets[0].source, 'scheduler.cron.bootcamp');
  assert.equal(intakePackets[0].kind, 'cron_bootcamp_audit');
  assert.match(String(intakePackets[0].desiredChangedFuture), /bound to a resident pursuit/);
  assert.equal(consequences[0].pursuitId, 'ap_legacy');
  assert.equal(consequences[0].changeType, 'cron_bound_to_pursuit');
  assert.equal(consequences[0].status, 'applied');
});

test('mergeExternalCronJobPreservingAgency keeps runtime pursuit bindings when config jobs are reloaded', () => {
  const existing = recurringJob('external-configured', {
    pursuitId: 'ap_runtime',
    charterRule: 'existing_recurring_cron_requires_pursuit',
  });
  existing.state.consecutiveErrors = 2;
  const incoming = recurringJob('external-configured');
  incoming.name = 'External configured renamed';

  const merged = mergeExternalCronJobPreservingAgency(existing, incoming);

  assert.equal(merged.name, 'External configured renamed');
  assert.equal(merged.state.consecutiveErrors, 2);
  assert.equal(merged.agency?.pursuitId, 'ap_runtime');
  assert.equal(merged.agency?.charterRule, 'existing_recurring_cron_requires_pursuit');
});
