import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditExistingRecurringCronJobsForAgency,
  mergeExternalCronJobPreservingAgency,
  reviewBoundRecurringCronJobsForAgency,
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

test('reviewBoundRecurringCronJobsForAgency proposes retirement in dry-run when pursuit is discarded', async () => {
  const saved: CronJob[] = [];
  const consequences: Array<Record<string, unknown>> = [];
  const jobs = [
    recurringJob('stale-bound', { pursuitId: 'ap_stale', charterRule: 'existing_recurring_cron_requires_pursuit' }),
  ];

  const result = await reviewBoundRecurringCronJobsForAgency({
    scheduler: {
      getJobs: () => jobs,
      saveJob: (job) => saved.push(job),
    },
    kernel: {
      config: { mode: 'dry_run' },
      pursuit: (id: string) => ({ id, status: 'discarded', nextMove: 'editor killed repeated loop' }),
      recordConsequence: async (packet) => {
        consequences.push(packet);
      },
    },
    now: '2026-05-25T21:00:00.000Z',
  });

  assert.equal(result.checked, 1);
  assert.equal(result.proposed, 1);
  assert.equal(result.retired, 0);
  assert.equal(saved.length, 0);
  assert.equal(jobs[0].enabled, true);
  assert.equal(consequences[0].changeType, 'cron_retirement_proposed');
  assert.equal(consequences[0].status, 'proposed');
  assert.equal(consequences[0].pursuitId, 'ap_stale');
});

test('reviewBoundRecurringCronJobsForAgency proposes retirement for repeated no-consequence runs', async () => {
  const saved: CronJob[] = [];
  const consequences: Array<Record<string, unknown>> = [];
  const job = recurringJob('theater-bound', { pursuitId: 'ap_theater', charterRule: 'existing_recurring_cron_requires_pursuit' });
  job.state.lastStatus = 'ok';
  job.state.lastSemanticStatus = 'unknown';
  job.state.consecutiveNoConsequence = 3;

  const result = await reviewBoundRecurringCronJobsForAgency({
    scheduler: {
      getJobs: () => [job],
      saveJob: (next) => saved.push(next),
    },
    kernel: {
      config: { mode: 'dry_run' },
      pursuit: (id: string) => ({ id, status: 'active', nextMove: 'keep producing the report' }),
      recordConsequence: async (packet) => {
        consequences.push(packet);
      },
    },
    now: '2026-05-25T21:03:00.000Z',
  });

  assert.equal(result.checked, 1);
  assert.equal(result.proposed, 1);
  assert.equal(result.kept, 0);
  assert.equal(saved.length, 0);
  assert.equal(consequences[0].changeType, 'cron_retirement_proposed');
  assert.equal(consequences[0].status, 'proposed');
  assert.match(String(consequences[0].summary), /3 consecutive runs without satisfied consequence/);
});

test('reviewBoundRecurringCronJobsForAgency includes recent run-log excerpts in retirement evidence', async () => {
  const consequences: Array<Record<string, unknown>> = [];
  const job = recurringJob('opaque-bound', { pursuitId: 'ap_opaque', charterRule: 'existing_recurring_cron_requires_pursuit' });
  job.state.lastStatus = 'ok';
  job.state.lastSemanticStatus = 'unknown';
  job.state.consecutiveNoConsequence = 3;

  await reviewBoundRecurringCronJobsForAgency({
    scheduler: {
      getJobs: () => [job],
      saveJob: () => undefined,
      getRecentRuns: () => [
        {
          timestamp: '2026-05-25T20:00:00.000Z',
          status: 'ok',
          response: 'Delivered digest but no AGENCY_INTAKE_PACKET.',
          outcome: { semanticStatus: 'unknown', layers: { intent: { status: 'unknown', reason: 'no intent satisfaction contract was reported' } } },
        },
        {
          timestamp: '2026-05-25T19:00:00.000Z',
          status: 'ok',
          response: 'Delivered another digest.',
          outcome: { semanticStatus: 'unknown', layers: { artifact: { status: 'unknown', reason: 'no artifact contract or artifact output was reported' } } },
        },
      ],
    } as any,
    kernel: {
      config: { mode: 'dry_run' },
      pursuit: (id: string) => ({ id, status: 'active', nextMove: 'operator should inspect run quality' }),
      recordConsequence: async (packet) => {
        consequences.push(packet);
      },
    },
    now: '2026-05-25T21:07:00.000Z',
  });

  const runEvidence = (consequences[0].evidence as Array<Record<string, unknown>>).filter(item => item.type === 'cron_run_log_excerpt');
  assert.equal(runEvidence.length, 2);
  assert.equal(runEvidence[0].ref, 'opaque-bound');
  assert.equal(runEvidence[0].semanticStatus, 'unknown');
  assert.match(String(runEvidence[0].responsePreview), /no AGENCY_INTAKE_PACKET/);
  assert.match(String(runEvidence[0].layers), /intent:unknown/);
});

test('reviewBoundRecurringCronJobsForAgency proposes stale recurring cron retirement by default in live mode', async () => {
  const saved: CronJob[] = [];
  const consequences: Array<Record<string, unknown>> = [];
  const stale = recurringJob('stale-bound', { pursuitId: 'ap_stale', charterRule: 'existing_recurring_cron_requires_pursuit' });
  const open = recurringJob('open-bound', { pursuitId: 'ap_open', charterRule: 'existing_recurring_cron_requires_pursuit' });
  const oneShot = {
    ...recurringJob('one-shot', { pursuitId: 'ap_stale', charterRule: 'existing_recurring_cron_requires_pursuit' }),
    schedule: { kind: 'at', at: '2026-05-26T09:00:00-04:00' },
  } as CronJob;
  const jobs = [stale, open, oneShot];

  const result = await reviewBoundRecurringCronJobsForAgency({
    scheduler: {
      getJobs: () => jobs,
      saveJob: (job) => saved.push(job),
    },
    kernel: {
      config: { mode: 'live' },
      pursuit: (id: string) => ({ id, status: id === 'ap_stale' ? 'closed' : 'active' }),
      recordConsequence: async (packet) => {
        consequences.push(packet);
      },
    },
    now: '2026-05-25T21:05:00.000Z',
  });

  assert.equal(result.checked, 3);
  assert.equal(result.retired, 0);
  assert.equal(result.proposed, 1);
  assert.equal(result.kept, 1);
  assert.equal(result.skippedNonRecurring, 1);
  assert.equal(saved.length, 0);
  assert.equal(stale.enabled, true);
  assert.equal(consequences[0].changeType, 'cron_retirement_proposed');
  assert.equal(consequences[0].status, 'proposed');
});
