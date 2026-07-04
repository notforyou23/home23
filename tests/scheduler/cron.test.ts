import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler, nextMatch, type CronJob, type JobResult } from '../../src/scheduler/cron.ts';

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
  assert.match(decisions[0].resourceContract.retryPosture, /escalate after 3 consecutive errors/);
  assert.match(decisions[0].resourceContract.outputObligation, /delivery summary/);
  assert.match(decisions[0].resourceContract.duplicateDetection, /job id job-1/);
  assert.match(decisions[0].resourceContract.stopCondition, /one eligible scheduler firing/);
  assert.match(decisions[0].resourceContract.receipt, /cron-decisions.jsonl/);

  const runLog = readJsonl(join(dir, 'cron-runs', 'job-1.jsonl'));
  assert.deepEqual(runLog[0].outcome.resourceContract, decisions[0].resourceContract);
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

test('nextMatch rejects a zero step instead of looping forever', () => {
  // "*/0" would make the field expansion loop never advance — an infinite
  // loop that hangs the scheduler tick and the whole harness event loop.
  assert.throws(() => nextMatch('*/0 * * * *', new Date(), 'America/New_York'), /step must be a positive integer/);
  // A valid step still resolves.
  const next = nextMatch('*/15 * * * *', new Date('2026-01-01T00:00:00Z'), 'UTC');
  assert.ok(next instanceof Date && !Number.isNaN(next.getTime()));
});
