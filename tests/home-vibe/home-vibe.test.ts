import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from '../../src/scheduler/cron.ts';
import { authorizeHomeVibeRefresh, configureHomeVibeJob, failHomeVibe, HOME_VIBE_JOB_ID,
  loadAvailableHomeVibeConfig, loadHomeVibeConfig, publishHomeVibe, readHomeVibeFeed,
  reconcileHomeVibeJob, type HomeVibeConfig } from '../../src/home-vibe/index.ts';

const config: HomeVibeConfig = { enabled: true, authorAgent: 'jerry', authorName: 'Jerry',
  contextURL: 'http://127.0.0.1:3036/api/cosmo/vibe-studio/preview', generationIntervalMs: 1_800_000,
  refreshToken: '0123456789abcdef0123456789abcdef' };

test('enabled config is resident scoped and refresh requires the exact bearer capability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  assert.equal(loadHomeVibeConfig(path, 'not-jerry'), null);
  assert.deepEqual(loadHomeVibeConfig(path, 'jerry'), config);
  assert.equal(authorizeHomeVibeRefresh(config, `Bearer ${config.refreshToken}`), true);
  assert.equal(authorizeHomeVibeRefresh(config, 'Bearer wrong'), false);
  assert.equal(authorizeHomeVibeRefresh(config, undefined), false);
});

test('malformed optional config and conflicting persisted job leave resident startup available', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-optional-'));
  const path = join(dir, 'config.json');
  const errors: string[] = [];
  writeFileSync(path, '{broken');
  assert.equal(loadAvailableHomeVibeConfig(path, 'jerry', error => errors.push(error)), null);
  assert.match(errors[0], /Home Vibe unavailable/);
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'jobs.json', runsDir: 'runs' },
    async () => ({ status: 'ok', durationMs: 0 }), dir);
  configureHomeVibeJob(scheduler, config);
  const conflicting = scheduler.getJob(HOME_VIBE_JOB_ID)!;
  conflicting.payload = { kind: 'systemEvent', text: 'conflict' };
  scheduler.saveJob(conflicting);
  assert.equal(reconcileHomeVibeJob(scheduler, config, error => errors.push(error)), null);
  assert.equal(scheduler.getJob(HOME_VIBE_JOB_ID)?.enabled, false);
  assert.match(errors[1], /conflicting payload/);
});

test('only a completed resident turn publishes with exact feed and ledger provenance; retry is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-publish-'));
  const path = join(dir, 'workspace', 'home-vibe', 'feed.json');
  const ledgerPath = join(dir, 'brain', 'event-ledger.jsonl');
  assert.throws(() => publishHomeVibe({ path, ledgerPath, config, text: ' ', turnId: 'turn-1', runId: 'run-1' }), /no publishable/);
  const first = publishHomeVibe({ path, ledgerPath, config, text: 'Jerry sees a calm morning.', turnId: 'turn-1', runId: 'run-1' });
  assert.deepEqual(readHomeVibeFeed(path), first);
  assert.equal(first.section.data?.authorName, 'Jerry');
  assert.equal(first.section.data?.runId, 'run-1');
  assert.equal(first.section.status, 'ok');
  const second = publishHomeVibe({ path, ledgerPath, config, text: 'Jerry sees a calm morning.', turnId: 'turn-1', runId: 'run-1' });
  assert.deepEqual(second, first);
  assert.throws(() => publishHomeVibe({ path, ledgerPath, config, text: 'Different result', turnId: 'turn-1', runId: 'run-1' }), /provenance/);
  assert.equal(second.history.length, 1);
  const events = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'ExecutionOutcomeObserved');
  assert.equal(events[0].payload.verificationStatus, 'verified');
  assert.equal(events[0].payload.turnId, 'turn-1');
  assert.match(events[0].payload.detail, /Authored Vibe publication text \(not a verified family fact\): Jerry sees a calm morning\./);
});

test('failed generation retains the last successful text and authorship with stale error state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-fail-'));
  const path = join(dir, 'feed.json');
  const old = publishHomeVibe({ path, ledgerPath: join(dir, 'ledger.jsonl'), config,
    text: 'A little warmth in the house.', turnId: 'turn-1', runId: 'run-1' });
  const failed = failHomeVibe(path, config, 'provider timed out');
  assert.equal(failed.section.status, 'error');
  assert.equal(failed.section.stale, true);
  assert.equal(failed.section.error, 'provider timed out');
  assert.equal(failed.section.lastSuccessAt, old.section.lastSuccessAt);
  assert.deepEqual(failed.section.data, old.section.data);
  assert.equal(readHomeVibeFeed(path)?.section.data?.authorName, 'Jerry');
});

test('same-run retry repairs a missing ledger receipt and clears failure without republishing history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-receipt-'));
  const path = join(dir, 'feed.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  mkdirSync(ledgerPath); // force receipt write failure after feed publication
  const input = { path, ledgerPath, config, text: 'A clear morning at home.', turnId: 'turn-1', runId: 'run-1' };
  assert.throws(() => publishHomeVibe(input));
  assert.equal(readHomeVibeFeed(path)?.section.data?.runId, 'run-1');
  failHomeVibe(path, config, 'ledger unavailable');
  rmSync(ledgerPath, { recursive: true });
  const repaired = publishHomeVibe(input);
  assert.equal(repaired.section.status, 'ok');
  assert.equal(repaired.history.length, 1);
  assert.equal(repaired.section.data?.text, input.text);
  assert.equal(readFileSync(ledgerPath, 'utf8').trim().split('\n').length, 1);
  publishHomeVibe(input);
  assert.equal(readFileSync(ledgerPath, 'utf8').trim().split('\n').length, 1);
});

test('next scheduled run repairs the previous published turn before replacing its feed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-next-run-'));
  const path = join(dir, 'feed.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  mkdirSync(ledgerPath);
  assert.throws(() => publishHomeVibe({ path, ledgerPath, config, text: 'First Vibe.', turnId: 'turn-1', runId: 'run-1' }));
  failHomeVibe(path, config, 'receipt unavailable');
  rmSync(ledgerPath, { recursive: true });
  const next = publishHomeVibe({ path, ledgerPath, config, text: 'Second Vibe.', turnId: 'turn-2', runId: 'run-2' });
  assert.equal(next.section.data?.runId, 'run-2');
  assert.equal(next.history.length, 2);
  const events = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event_id), ['home-vibe:run-1', 'home-vibe:run-2']);
});

test('boot job preserves owner edits and scheduler rejects overlapping manual refreshes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-scheduler-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'jobs.json', runsDir: 'runs' }, async () => {
    calls++;
    entered();
    await gate;
    return { status: 'ok', response: 'published', durationMs: 1 };
  }, dir);
  configureHomeVibeJob(scheduler, config);
  assert.equal(scheduler.getJob(HOME_VIBE_JOB_ID)?.queueClass, 'scheduled');
  scheduler.disableJob(HOME_VIBE_JOB_ID);
  configureHomeVibeJob(scheduler, config);
  assert.equal(scheduler.getJob(HOME_VIBE_JOB_ID)?.enabled, false);
  scheduler.enableJob(HOME_VIBE_JOB_ID);
  const first = scheduler.runJobNow(HOME_VIBE_JOB_ID);
  await started;
  const second = await scheduler.runJobNow(HOME_VIBE_JOB_ID);
  assert.equal(second.status, 'error');
  assert.match(second.error ?? '', /active run/);
  release();
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
});

test('normal scheduler tick admits an owned Vibe alongside other scheduled work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-vibe-tick-'));
  const called: string[] = [];
  const scheduler = new CronScheduler({ timezone: 'America/New_York', jobsFile: 'jobs.json', runsDir: 'runs',
    maxConcurrentJobsPerTick: 2, maxConcurrentAgentTurns: 1 }, async job => {
    called.push(job.id);
    return { status: 'ok', response: 'done', durationMs: 1, semanticStatus: 'satisfied' };
  }, dir);
  configureHomeVibeJob(scheduler, config);
  const vibe = scheduler.getJob(HOME_VIBE_JOB_ID)!;
  vibe.state.nextRunAtMs = Date.now() - 1_000;
  scheduler.saveJob(vibe);
  scheduler.addJob({ id: 'foreground', name: 'Other scheduled work', enabled: true,
    queueClass: 'scheduled', schedule: { kind: 'every', everyMs: 60_000 }, sessionTarget: 'isolated',
    wakeMode: 'now', payload: { kind: 'systemEvent', text: 'other work' },
    state: { nextRunAtMs: Date.now() - 1_000, consecutiveErrors: 0 } });
  const foreground = scheduler.getJob('foreground')!;
  foreground.state.nextRunAtMs = Date.now() - 1_000;
  scheduler.saveJob(foreground);
  await (scheduler as any).tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(called.sort(), ['foreground', HOME_VIBE_JOB_ID].sort());
  const runs = scheduler.getRecentRuns(HOME_VIBE_JOB_ID);
  assert.equal(runs[0]?.status, 'ok');
  assert.equal(runs[0]?.outcome?.semanticStatus, 'satisfied');
});
