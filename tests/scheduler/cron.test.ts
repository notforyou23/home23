import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler, type CronJob, type JobResult } from '../../src/scheduler/cron.ts';
import { runScheduledChannelTurn } from '../../src/scheduler/channel-run.js';
import { ResidentProtocolError } from '../../src/coordination/resident-protocol/errors.js';

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeDueJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'Freshness watch',
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000, anchorMs: Date.parse('2026-05-11T00:00:00.000Z') },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'systemEvent', text: 'check freshness' },
    state: {
      nextRunAtMs: Date.now() - 1_000,
      consecutiveErrors: 0,
    },
    ...overrides,
  };
}

test('reattached channel work retains its original firing and whole elapsed duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-original-firing-'));
  const config = { timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' };
  const dueAt = Date.now() - 1_000;
  const job = makeDueJob({ payload: { kind: 'agentTurn', channelId: 'chn_1', message: 'one step' },
    state: { nextRunAtMs: dueAt, consecutiveErrors: 0 } });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job]));
  let scheduler = new CronScheduler(config, async () => ({ status: 'error', canonicalRunPending: true, durationMs: 1 }), dir);
  await (scheduler as any).tick(); await new Promise(resolve => setImmediate(resolve)); scheduler.stop();
  const first = readJsonl(join(dir, 'cron-decisions.jsonl'))[0];
  const saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  saved[0].state.activeChannelRun.startedAtMs = Date.now() - 60_000;
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify(saved));
  scheduler = new CronScheduler(config, async () => ({ status: 'error', error: 'deadline', durationMs: 13 }), dir);
  await (scheduler as any).tick(); await new Promise(resolve => setImmediate(resolve)); scheduler.stop();
  const rows = readJsonl(join(dir, 'cron-runs', job.id + '.jsonl'));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].decision, first);
  assert.equal(rows[0].decision.dueAt, new Date(dueAt).toISOString());
  assert.ok(rows[0].durationMs >= 60_000);
  assert.equal(scheduler.getJob(job.id)!.state.lastDurationMs, rows[0].durationMs);
});

test('legacy active channel work never invents a firing from the next scheduled time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-legacy-firing-'));
  const job = makeDueJob({ payload: { kind: 'agentTurn', channelId: 'chn_1', message: 'one step' },
    state: { nextRunAtMs: Date.now() + 3_600_000, consecutiveErrors: 0,
      activeChannelRun: { runId: 'sched-run-legacy', startedAtMs: Date.now() - 60_000 } } });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job]));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' },
    async () => ({ status: 'ok', durationMs: 2 }), dir);
  await (scheduler as any).tick(); await new Promise(resolve => setImmediate(resolve)); scheduler.stop();
  const row = readJsonl(join(dir, 'cron-runs', job.id + '.jsonl'))[0];
  assert.equal(row.decision.dueAt, null);
  assert.match(row.decision.reason, /original firing unavailable/);
  assert.ok(row.durationMs >= 60_000);
});

test('due cron jobs write a preflight decision receipt before the handler runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-decision-'));
  const decisionsPath = join(dir, 'cron-decisions.jsonl');
  const job = makeDueJob();
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    const decisions = readJsonl(decisionsPath);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].action, 'run');
    assert.equal(decisions[0].durableState, 'allowed_after_decision');
    return { status: 'ok', response: 'fresh', durationMs: 2 };
  }, dir);

  await (scheduler as any).tick();

  await new Promise((resolve) => setTimeout(resolve, 25));
  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog.length, 1);
  assert.equal(runLog[0].status, 'ok');
  assert.equal(runLog[0].decision.action, 'run');
  assert.equal(runLog[0].outcome.schema, 'home23.scheduler.job-outcome.v1');
  assert.equal(runLog[0].outcome.mechanicalStatus, 'ok');
  assert.equal(runLog[0].outcome.semanticStatus, 'unknown');
  assert.equal(runLog[0].outcome.layers.process.status, 'success');
  assert.equal(runLog[0].outcome.layers.intent.status, 'unknown');
  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.equal(savedJobs[0].state.consecutiveNoConsequence, 1);
});

test('configured delivery is unknown until the handler records a delivery outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-unproven-delivery-'));
  const job = makeDueJob({ delivery: { mode: 'summary', channel: 'telegram', to: 'jtr' } });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    return { status: 'ok', response: 'Morning review reminder.', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog[0].outcome.layers.delivery.status, 'unknown');
  assert.match(runLog[0].outcome.layers.delivery.reason, /did not record a delivery outcome/);
});

test('configured delivery receipt records a missing adapter as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-no-adapter-delivery-'));
  const job = makeDueJob({ delivery: { mode: 'summary', channel: 'telegram', to: 'jtr' } });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    return {
      status: 'error',
      error: 'Delivery no_adapter: no configured delivery target has a registered adapter',
      durationMs: 1,
      deliveryOutcome: {
        status: 'no_adapter',
        reason: 'no configured delivery target has a registered adapter',
        retryEligible: true,
        unavailableTargets: [{ channel: 'telegram', to: 'jtr' }],
      },
    };
  }, dir);

  await (scheduler as any).tick();

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog[0].outcome.layers.delivery.status, 'failed');
  assert.equal(runLog[0].outcome.layers.delivery.evidence.deliveryStatus, 'no_adapter');
});

test('scheduler start delays first automatic tick to avoid startup stampede', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-start-delay-'));
  const job = makeDueJob();
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let handlerCalls = 0;
  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
    initialTickDelayMs: 60_000,
  }, async (): Promise<JobResult> => {
    handlerCalls++;
    return { status: 'ok', response: 'fresh', durationMs: 2 };
  }, dir);

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  scheduler.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(readJsonl(join(dir, 'cron-runs', 'job-1.jsonl')).length, 0);
  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.ok(savedJobs[0].state.nextRunAtMs > Date.now());
  assert.equal(savedJobs[0].state.lastDecisionAction, 'defer');
  assert.equal(savedJobs[0].state.lastDecisionReason, 'missed during scheduler downtime; rescheduled on startup');
});

test('cron preflight decisions carry a resource stewardship contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-resource-contract-'));
  const job = makeDueJob({
    queueClass: 'background',
    payload: { kind: 'agentTurn', message: 'make one field report step', timeoutSeconds: 420 },
    delivery: { mode: 'summary', channel: 'telegram', to: 'jtr' },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    return { status: 'ok', response: 'done', durationMs: 2, artifacts: ['issues/098.json'], semanticStatus: 'satisfied' };
  }, dir);

  await (scheduler as any).tick();

  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions[0].resourceContract.schema, 'home23.scheduler.resource-contract.v1');
  assert.equal(decisions[0].resourceContract.sourceIssue, 98);
  assert.equal(decisions[0].resourceContract.priority, 'background');
  assert.equal(decisions[0].resourceContract.maxRuntimeSeconds, 420);
  assert.match(decisions[0].resourceContract.pressureBehavior, /defer/);
  assert.match(decisions[0].resourceContract.retryPosture, /circuit-break after 3 consecutive errors/);
  assert.match(decisions[0].resourceContract.outputObligation, /delivery summary/);
  assert.match(decisions[0].resourceContract.duplicateDetection, /job id job-1/);
  assert.match(decisions[0].resourceContract.stopCondition, /one eligible scheduler firing/);
  assert.match(decisions[0].resourceContract.receipt, /cron-decisions.jsonl/);

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.deepEqual(runLog[0].outcome.resourceContract, decisions[0].resourceContract);
});

test('scheduler skips persisted agentTurn jobs with invalid effort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-invalid-effort-'));
  const job = makeDueJob({
    payload: { kind: 'agentTurn', message: 'bad persisted job', effort: 'ultra' } as never,
  });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));

  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
  }, async (): Promise<JobResult> => ({ status: 'ok', durationMs: 1 }), dir);

  assert.equal(scheduler.getJobs().length, 0);
});

test('due cron jobs with repeated errors escalate before executing again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-escalate-'));
  let handlerCalls = 0;
  const job = makeDueJob({
    state: {
      nextRunAtMs: Date.now() - 10_000,
      lastStatus: 'error',
      consecutiveErrors: 3,
    },
  });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    handlerCalls++;
    return { status: 'ok', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  assert.equal(handlerCalls, 0);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'escalate');
  assert.match(decisions[0].reason, /3 consecutive error/);
  assert.match(decisions[0].reason, /circuit opened|auto-revive/i);

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog.length, 1);
  assert.equal(runLog[0].status, 'error');
  assert.equal(runLog[0].withheld, true);
  assert.equal(runLog[0].decision.action, 'escalate');
  assert.equal(runLog[0].outcome.semanticStatus, 'withheld');
  assert.equal(runLog[0].outcome.layers.scheduler.status, 'skipped');
  assert.equal(runLog[0].outcome.layers.process.status, 'skipped');

  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.equal(savedJobs[0].state.lastStatus, 'error');
  assert.equal(savedJobs[0].state.lastSemanticStatus, 'withheld');
  assert.ok(savedJobs[0].state.nextRunAtMs > Date.now());
  assert.ok(Number(savedJobs[0].state.circuitOpenUntilMs) > Date.now());
});

test('cron circuit breaker auto-revives after backoff instead of permanent silence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-revive-'));
  let handlerCalls = 0;
  const job = makeDueJob({
    state: {
      nextRunAtMs: Date.now() - 10_000,
      lastStatus: 'error',
      consecutiveErrors: 3,
      circuitOpenUntilMs: Date.now() - 1_000,
    },
  });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    handlerCalls++;
    return { status: 'ok', response: 'revived', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  assert.equal(handlerCalls, 1);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions[0].action, 'repair');
  assert.match(decisions[0].reason, /revive probe/i);
  assert.equal(decisions[0].willExecute, true);

  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.equal(savedJobs[0].state.consecutiveErrors, 0);
  assert.equal(savedJobs[0].state.circuitOpenUntilMs, undefined);
  assert.equal(savedJobs[0].state.lastStatus, 'ok');
});

test('manual cron repair run bypasses repeated-error escalation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-manual-repair-'));
  let handlerCalls = 0;
  const job = makeDueJob({
    state: {
      nextRunAtMs: Date.now() - 10_000,
      lastStatus: 'error',
      consecutiveErrors: 3,
    },
  });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    handlerCalls++;
    return { status: 'ok', response: 'repair verified', durationMs: 1 };
  }, dir);

  const result = await scheduler.runJobNow('job-1');

  assert.equal(result.status, 'ok');
  assert.equal(handlerCalls, 1);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].source, 'manual');
  assert.equal(decisions[0].action, 'run');
  assert.equal(decisions[0].durableState, 'allowed_after_decision');

  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.equal(savedJobs[0].state.lastStatus, 'ok');
  assert.equal(savedJobs[0].state.consecutiveErrors, 0);
});

test('background cron jobs defer under mixed due load without counting as failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-load-'));
  const scheduled = makeDueJob({
    id: 'scheduled-work',
    name: 'Scheduled work',
    queueClass: 'scheduled',
  } as Partial<CronJob>);
  const background = makeDueJob({
    id: 'background-work',
    name: 'Background work',
    queueClass: 'background',
    delivery: { mode: 'summary', channel: 'telegram', to: 'jtr' },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([scheduled, background], null, 2));

  const calls: string[] = [];
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (job): Promise<JobResult> => {
    calls.push(job.id);
    return { status: 'ok', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  assert.deepEqual(calls, ['scheduled-work']);

  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  const backgroundDecision = decisions.find((decision) => decision.jobId === 'background-work');
  assert.equal(backgroundDecision.action, 'defer');
  assert.equal(backgroundDecision.sourceIssue, 71);
  assert.match(backgroundDecision.reason, /background work deferred/i);

  const runLog = readJsonl(join(dir, 'cron-runs', 'background-work.jsonl'));
  assert.equal(runLog.length, 1);
  assert.equal(runLog[0].withheld, true);
  assert.equal(runLog[0].status, 'ok');
  assert.equal(runLog[0].outcome.layers.delivery.status, 'skipped');
  assert.equal(runLog[0].outcome.layers.delivery.evidence.deliveryStatus, 'withheld');

  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  const savedBackground = savedJobs.find((job: CronJob) => job.id === 'background-work');
  assert.equal(savedBackground.state.lastStatus, 'ok');
  assert.equal(savedBackground.state.lastSemanticStatus, 'withheld');
  assert.equal(savedBackground.state.consecutiveErrors, 0);
  assert.ok(savedBackground.state.nextRunAtMs > Date.now());
});

test('scheduler caps scheduled agent turns so chat bridge stays responsive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-agent-cap-'));
  const first = makeDueJob({
    id: 'agent-first',
    name: 'Agent first',
    queueClass: 'scheduled',
    payload: { kind: 'agentTurn', message: 'first' },
  } as Partial<CronJob>);
  const second = makeDueJob({
    id: 'agent-second',
    name: 'Agent second',
    queueClass: 'scheduled',
    payload: { kind: 'agentTurn', message: 'second' },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([first, second], null, 2));

  const calls: string[] = [];
  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
    maxConcurrentAgentTurns: 1,
  }, async (job): Promise<JobResult> => {
    calls.push(job.id);
    return { status: 'ok', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  assert.deepEqual(calls, ['agent-first']);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  const deferred = decisions.find((decision) => decision.jobId === 'agent-second');
  assert.equal(deferred.action, 'defer');
  assert.match(deferred.reason, /preserve bridge\/chat responsiveness/);

  const runLog = readJsonl(join(dir, 'cron-runs', 'agent-second.jsonl'));
  assert.equal(runLog.length, 1);
  assert.equal(runLog[0].withheld, true);
  assert.equal(runLog[0].status, 'ok');
});

test('scheduler caps total jobs per tick to avoid live harness stampedes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-total-cap-'));
  const jobs = [1, 2, 3].map((n) => makeDueJob({
    id: `job-${n}`,
    name: `Job ${n}`,
    payload: { kind: 'exec', command: `echo ${n}` },
  } as Partial<CronJob>));
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify(jobs, null, 2));

  const calls: string[] = [];
  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
    maxConcurrentJobsPerTick: 2,
  }, async (job): Promise<JobResult> => {
    calls.push(job.id);
    return { status: 'ok', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  assert.deepEqual(calls, ['job-1', 'job-2']);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  const deferred = decisions.find((decision) => decision.jobId === 'job-3');
  assert.equal(deferred.action, 'defer');
  assert.match(deferred.reason, /preserve dashboard\/chat responsiveness/);
  const runLog = readJsonl(join(dir, 'cron-runs', 'job-3.jsonl'));
  assert.equal(runLog[0].status, 'ok');
  assert.equal(runLog[0].withheld, true);
});

test('run logs separate mechanical completion from failed semantic outcome layers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-semantic-'));
  const job = makeDueJob({
    delivery: { mode: 'none' },
  });
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));

  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    return {
      status: 'ok',
      response: 'handler finished but artifact verifier failed',
      durationMs: 3,
      semanticStatus: 'failed',
      outcomeLayers: {
        artifact: {
          status: 'failed',
          reason: 'expected report file was not created',
          evidence: { expectedPath: 'reports/daily.md' },
        },
        intent: {
          status: 'failed',
          reason: 'desired daily report outcome was not satisfied',
        },
      },
    };
  }, dir);

  await (scheduler as any).tick();

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog.length, 1);
  assert.equal(runLog[0].status, 'ok');
  assert.equal(runLog[0].outcome.mechanicalStatus, 'ok');
  assert.equal(runLog[0].outcome.semanticStatus, 'failed');
  assert.equal(runLog[0].outcome.layers.process.status, 'success');
  assert.equal(runLog[0].outcome.layers.task.status, 'success');
  assert.equal(runLog[0].outcome.layers.artifact.status, 'failed');
  assert.equal(runLog[0].outcome.layers.intent.status, 'failed');

  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  assert.equal(savedJobs[0].state.lastStatus, 'ok');
  assert.equal(savedJobs[0].state.lastSemanticStatus, 'failed');
});

test('scheduler exposes recent run-log excerpts for operator agency review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-run-excerpts-'));
  const job = makeDueJob();
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (): Promise<JobResult> => {
    return { status: 'ok', response: 'mechanical digest without consequence', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();

  const excerpts = scheduler.getRecentRuns('job-1', 1);
  assert.equal(excerpts.length, 1);
  assert.equal(excerpts[0].jobId, 'job-1');
  assert.equal(excerpts[0].outcome.semanticStatus, 'unknown');
  assert.match(String(excerpts[0].response), /without consequence/);
});

test('only one scheduler instance owns a runtime cron lease at a time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-owner-'));
  const job = makeDueJob();
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));

  const calls: string[] = [];
  const first = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (job): Promise<JobResult> => {
    calls.push(`first:${job.id}`);
    return { status: 'ok', response: 'owned', durationMs: 1 };
  }, dir);
  const second = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (job): Promise<JobResult> => {
    calls.push(`second:${job.id}`);
    return { status: 'ok', response: 'duplicate', durationMs: 1 };
  }, dir);

  await (first as any).tick();
  await (second as any).tick();

  assert.deepEqual(calls, ['first:job-1']);
  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(runLog.length, 1);

  first.stop();
  const savedJobs = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'));
  savedJobs[0].state.nextRunAtMs = Date.now() - 1_000;
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify(savedJobs, null, 2));

  const third = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (job): Promise<JobResult> => {
    calls.push(`third:${job.id}`);
    return { status: 'ok', response: 'took over', durationMs: 1 };
  }, dir);

  await (third as any).tick();

  assert.deepEqual(calls, ['first:job-1', 'third:job-1']);
});

test('manual canonical run retains caller and run identity, and rejects overlapping execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-joined-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const caller = { abortSignal: controller.signal, parentWorkId: 'wrk_root' };
  let calls = 0;
  let observedRunId = '';
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs' }, async (_job, execution) => {
    calls++;
    assert.equal(execution?.caller, caller);
    observedRunId = execution!.runId;
    await gate;
    return { status: 'ok', response: 'checked', durationMs: 1 };
  }, dir);
  scheduler.addJob(makeDueJob());
  const first = scheduler.runJobNow('job-1', caller);
  const second = await scheduler.runJobNow('job-1', caller);
  assert.equal(second.status, 'error');
  assert.match(second.error!, /active run/);
  release();
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
  assert.ok(observedRunId.startsWith('sched-run-'));
  assert.equal(scheduler.getRecentRuns('job-1', 1)[0]?.runId, observedRunId);
});

test('a pending canonical one-shot survives scheduler restart with its exact resolved input', async () => {
  const dir = mkdtempSync(join(tmpdir(),'home23-canonical-schedule-'));
  const config={timezone:'America/New_York',jobsFile:'cron-jobs.json',runsDir:'cron-runs'};
  writeFileSync(join(dir,'cron-jobs.json'),JSON.stringify([makeDueJob({schedule:{kind:'at',at:new Date(Date.now()-1000).toISOString()},payload:{kind:'agentTurn',channelId:'chn_topic',message:'Original'}})]));
  let savedInput: unknown;
  let scheduler=new CronScheduler(config,async (job,execution)=>{
    const before=JSON.parse(readFileSync(join(dir,'cron-jobs.json'),'utf8'))[0];
    assert.equal(before.state.activeChannelRun.runId,execution!.runId,'run ID durable before dispatch');
    const input={runId:execution!.runId,jobId:job.id,channelId:'chn_topic',prompt:'Resolved editorial source'};
    execution!.persistCanonicalTurn!(input); savedInput=input;
    return {status:'error',error:'Connection lost after admission',canonicalRunPending:true,durationMs:1};
  },dir);
  await (scheduler as any).tick(); scheduler.stop();
  assert.equal(readJsonl(join(dir,'cron-runs','job-1.jsonl')).length,0,'lost response is not a terminal run');
  const saved=JSON.parse(readFileSync(join(dir,'cron-jobs.json'),'utf8'));assert.equal(saved[0].enabled,false);
  saved[0].payload.message='New prompt for future runs';writeFileSync(join(dir,'cron-jobs.json'),JSON.stringify(saved));
  let resumed=0;
  scheduler=new CronScheduler(config,async (_job,execution)=>{
    resumed++;assert.deepEqual(execution!.canonicalTurn,savedInput);
    return {status:'ok',response:'Canonical result',durationMs:2};
  },dir);
  await (scheduler as any).tick();scheduler.stop();
  assert.equal(resumed,1);
  assert.equal(JSON.parse(readFileSync(join(dir,'cron-jobs.json'),'utf8'))[0].state.activeChannelRun,undefined);
  assert.equal(readJsonl(join(dir,'cron-runs','job-1.jsonl')).length,1);
});

test('a permanently rejected canonical one-shot has one durable failure receipt and does not reattach after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-rejected-schedule-'));
  const config = {timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs'};
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([makeDueJob({schedule: {kind: 'at', at: new Date(Date.now() - 1_000).toISOString()},
    payload: {kind: 'agentTurn', channelId: 'chn_foreign', message: 'Saved follow-up'}})]));
  let attempts = 0; let originalRun = '';
  const handler: ConstructorParameters<typeof CronScheduler>[1] = async (job, execution) => {
    attempts++; originalRun = execution!.runId;
    return runScheduledChannelTurn({runId: execution!.runId, jobId: job.id, channelId: 'chn_foreign', prompt: 'Saved follow-up'}, execution!,
      async () => {throw new ResidentProtocolError('request_invalid', 'Not the scheduling resident’s conversation');});
  };
  let scheduler = new CronScheduler(config, handler, dir);
  await (scheduler as any).tick(); scheduler.stop();
  await new Promise(resolve => setImmediate(resolve));
  const saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.enabled, false); assert.equal(saved.state.activeChannelRun, undefined);
  assert.equal(saved.state.lastStatus, 'error'); assert.equal(saved.state.consecutiveErrors, 1);
  const receipts = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.equal(receipts.length, 1); assert.equal(receipts[0].runId, originalRun); assert.equal(receipts[0].status, 'error');
  assert.match(receipts[0].error, /rejected/);
  scheduler = new CronScheduler(config, handler, dir); await (scheduler as any).tick(); scheduler.stop();
  assert.equal(attempts, 1); assert.equal(readJsonl(join(dir, 'cron-runs', 'job-1.jsonl')).length, 1);
});

test('a never-settling job cannot freeze later scheduler ticks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-detached-tick-'));
  const stuck = makeDueJob({ id: 'stuck', name: 'Stuck job' } as Partial<CronJob>);
  const later = makeDueJob({
    id: 'later',
    name: 'Later job',
    state: { nextRunAtMs: Date.now() + 60_000, consecutiveErrors: 0 },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([stuck, later], null, 2));

  const calls: string[] = [];
  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
  }, async (job): Promise<JobResult> => {
    calls.push(job.id);
    if (job.id === 'stuck') return await new Promise<JobResult>(() => {});
    return { status: 'ok', durationMs: 1 };
  }, dir);

  await (scheduler as any).tick();
  scheduler.getJob('later')!.state.nextRunAtMs = Date.now() - 1;
  await (scheduler as any).tick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, ['stuck', 'later']);
  assert.equal(readJsonl(join(dir, 'cron-runs', 'later.jsonl'))[0].status, 'ok');
});

test('a recurring due instance is withheld while the same job remains in flight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-inflight-dedupe-'));
  const job = makeDueJob({ id: 'recurring', name: 'Recurring job' } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let calls = 0;
  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
  }, async (): Promise<JobResult> => {
    calls++;
    return await new Promise<JobResult>(() => {});
  }, dir);

  await (scheduler as any).tick();
  scheduler.getJob('recurring')!.state.nextRunAtMs = Date.now() - 1;
  await (scheduler as any).tick();

  assert.equal(calls, 1);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].action, 'defer');
  assert.match(decisions[1].reason, /same job is still in flight/);
  const receipt = readJsonl(join(dir, 'cron-runs', 'recurring.jsonl'))[0];
  assert.equal(receipt.withheld, true);
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.outcome.semanticStatus, 'withheld');
});

// ─── Missed and failed scheduled runs (2026-10-05 investigation) ───────────

function schedulerFor(dir: string, handler: (job: CronJob) => Promise<JobResult>, extra: Record<string, unknown> = {}): CronScheduler {
  return new CronScheduler({ timezone: 'America/New_York', jobsFile: 'cron-jobs.json', runsDir: 'cron-runs', initialTickDelayMs: 60_000, ...extra } as any, handler, dir);
}

test('an in-flight durable channel run is not re-decided on every tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-inflight-channel-'));
  const job = makeDueJob({
    id: 'channel-job',
    name: 'Channel job',
    schedule: { kind: 'cron', expr: '7 */6 * * *', tz: 'America/New_York' },
    payload: { kind: 'agentTurn', message: 'field report', channelId: 'chn_1', timeoutSeconds: 3600 },
    state: { nextRunAtMs: Date.now() + 6 * 60 * 60 * 1000, consecutiveErrors: 0, activeChannelRun: { runId: 'sched-run-11111111-1111-1111-1111-111111111111', startedAtMs: Date.now() - 60_000 } },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let calls = 0;
  const scheduler = schedulerFor(dir, async () => { calls++; return await new Promise<JobResult>(() => {}); });

  await (scheduler as any).tick(); // reattaches the durable run
  await (scheduler as any).tick(); // still in flight and not due: nothing to decide
  await (scheduler as any).tick();

  assert.equal(calls, 1);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions.length, 1, 'only the reattach decision is recorded');
  assert.equal(decisions[0].action, 'run');
  assert.equal(readJsonl(join(dir, 'cron-runs', 'channel-job.jsonl')).length, 0, 'no withheld receipts while the run is in flight');
  const saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.state.lastDecisionAction, 'run');
});

test('a cron job that missed one firing during downtime stays due and runs as catch-up on the first tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-startup-catchup-'));
  const dueAt = Date.now() - 20 * 60 * 1000; // restart straddled the 06:00 firing; it is 06:20 now
  const job = makeDueJob({
    id: 'daily',
    name: 'Daily insight card',
    schedule: { kind: 'cron', expr: '0 6 * * *', tz: 'America/New_York' },
    state: { nextRunAtMs: dueAt, consecutiveErrors: 0 },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let calls = 0;
  const scheduler = schedulerFor(dir, async () => { calls++; return { status: 'ok', durationMs: 1 }; });

  scheduler.start();
  scheduler.stop();
  assert.equal(calls, 0, 'startup itself never runs jobs');
  let saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.state.nextRunAtMs, dueAt, 'a single missed firing is kept due');

  await (scheduler as any).tick();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions[0].action, 'run');
  assert.equal(decisions[0].willExecute, true);
  saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.ok(saved.state.nextRunAtMs > Date.now());
});

test('a cron job that missed several firings during downtime is rescheduled with a visible receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-startup-skip-'));
  const dueAt = Date.now() - 3 * 60 * 60 * 1000; // hourly job, three firings missed
  const job = makeDueJob({
    id: 'hourly',
    name: 'Hourly sync',
    schedule: { kind: 'cron', expr: '0 * * * *', tz: 'America/New_York' },
    state: { nextRunAtMs: dueAt, consecutiveErrors: 0 },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  const scheduler = schedulerFor(dir, async () => ({ status: 'ok', durationMs: 1 }));

  scheduler.start();
  scheduler.stop();

  const saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.ok(saved.state.nextRunAtMs > Date.now(), 'moved to the next firing');
  assert.equal(saved.state.lastDecisionAction, 'skip');
  assert.equal(saved.state.consecutiveErrors, 0, 'downtime is not the job\'s fault');
  const decisions = readJsonl(join(dir, 'cron-decisions.jsonl'));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'skip');
  assert.equal(decisions[0].willExecute, false);
  assert.match(decisions[0].reason, /missed during scheduler downtime/);
  const receipt = readJsonl(join(dir, 'cron-runs', 'hourly.jsonl'));
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].withheld, true);
  assert.equal(receipt[0].status, 'error');
  assert.match(receipt[0].error, /missed during scheduler downtime/);
});

test('a run interrupted by a harness restart is recorded and re-dispatched when its slot has not passed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-interrupted-'));
  const dispatchedAt = Date.now() - 50 * 60 * 1000; // 21:00 briefing dispatched, harness killed at 21:50
  const job = makeDueJob({
    id: 'evening',
    name: 'Evening briefing',
    schedule: { kind: 'cron', expr: '0 21 * * *', tz: 'America/New_York' },
    payload: { kind: 'agentTurn', message: 'brief me', timeoutSeconds: 600 },
    state: {
      nextRunAtMs: Date.now() + 23 * 60 * 60 * 1000, // tick already advanced it to tomorrow
      consecutiveErrors: 0,
      lastRunAtMs: dispatchedAt - 24 * 60 * 60 * 1000,
      lastStatus: 'ok',
      lastDecisionAtMs: dispatchedAt,
      lastDecisionAction: 'run',
      lastDecisionReason: 'job due and eligible',
      inFlightSinceMs: dispatchedAt,
    },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let calls = 0;
  const scheduler = schedulerFor(dir, async () => { calls++; return { status: 'ok', response: 'brief', durationMs: 1 }; });

  scheduler.start();
  scheduler.stop();

  const receipts = readJsonl(join(dir, 'cron-runs', 'evening.jsonl'));
  assert.equal(receipts.length, 1, 'the lost run gets a receipt');
  assert.equal(receipts[0].status, 'error');
  assert.match(receipts[0].error, /interrupted/i);
  let saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.state.inFlightSinceMs, undefined);
  assert.equal(saved.state.consecutiveErrors, 0, 'a restart is not the job\'s fault');
  assert.ok(saved.state.nextRunAtMs <= Date.now(), 'made due again because the next slot has not arrived');

  await (scheduler as any).tick();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1, 'the interrupted briefing is re-run');
  saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.state.lastStatus, 'ok');
  assert.equal(saved.state.inFlightSinceMs, undefined, 'marker cleared after completion');
});

test('dispatch marks the job in flight durably and completion clears the mark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-inflight-mark-'));
  const job = makeDueJob({ id: 'marked', name: 'Marked job' } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job], null, 2));
  let release: ((result: JobResult) => void) | null = null;
  const scheduler = schedulerFor(dir, async () => await new Promise<JobResult>((resolve) => { release = resolve; }));

  await (scheduler as any).tick();
  let saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.ok(typeof saved.state.inFlightSinceMs === 'number', 'persisted before the handler settles');

  release!({ status: 'ok', durationMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0];
  assert.equal(saved.state.inFlightSinceMs, undefined);
  assert.equal(saved.state.lastStatus, 'ok');
});

test('background deferral is reviewed off the five-minute grid so it cannot lock-step behind frequent foreground jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-cron-background-grid-'));
  const sampler = makeDueJob({ id: 'sampler', name: 'Process memory sampler', schedule: { kind: 'every', everyMs: 5 * 60 * 1000 } } as Partial<CronJob>);
  const nightly = makeDueJob({
    id: 'nightly',
    name: 'Conversation backfill',
    queueClass: 'background',
    schedule: { kind: 'cron', expr: '15 3 * * *', tz: 'America/New_York' },
  } as Partial<CronJob>);
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([sampler, nightly], null, 2));
  const scheduler = schedulerFor(dir, async () => ({ status: 'ok', durationMs: 1 }));

  const before = Date.now();
  await (scheduler as any).tick();

  const saved = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8')).find((j: CronJob) => j.id === 'nightly');
  const review = saved.state.nextRunAtMs - before;
  assert.ok(review >= 60_000, `review ${review}ms must respect the one-minute floor`);
  assert.ok(review < 4 * 60 * 1000, `review ${review}ms must land before the sampler's next five-minute firing`);
});
