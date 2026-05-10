import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');
const { seedAll, defaultSeeds } = require('../../../engine/src/live-problems/seed.js');
const { isRestartableProcess } = require('../../../engine/src/live-problems/remediators.js');
const {
  classifyDispatchRecipe,
  shouldAdvanceAfterIneffectiveSuccess,
  shouldReverifyResolvedProblem,
} = require('../../../engine/src/live-problems/loop.js');
const { runVerifier } = require('../../../engine/src/live-problems/verifiers.js');

test('seedAll prunes obsolete generic agent live-problem seeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    writeFileSync(join(dir, 'live-problems.json'), JSON.stringify({
      problems: [{
        id: 'agent_harness_online',
        seedOrigin: 'system',
        state: 'chronic',
        claim: 'Harness process home23-agent-harness is running',
        verifier: { type: 'pm2_status', args: { name: 'home23-agent-harness' } },
        remediation: [{ type: 'pm2_restart', args: { name: 'home23-agent-harness' } }],
      }],
    }));

    const store = new LiveProblemStore({ brainDir: dir });
    seedAll(store, { agentName: 'forrest', dashboardPort: '5012', bridgePort: '5014' });

    assert.equal(store.get('agent_harness_online'), undefined);
    assert.equal(store.get('forrest_harness_online')?.verifier?.args?.name, 'home23-forrest-harness');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedAll prunes cross-agent system seeds from an agent store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    writeFileSync(join(dir, 'live-problems.json'), JSON.stringify({
      problems: [
        {
          id: 'jerry_dashboard_port_owner',
          seedOrigin: 'system',
          state: 'open',
          claim: 'Dashboard port :5012 is owned by home23-jerry-dash, not a stale listener',
          verifier: { type: 'pm2_port_owner', args: { name: 'home23-jerry-dash', port: '5012' } },
          remediation: [{ type: 'pm2_restart', args: { name: 'home23-jerry-dash' } }],
        },
        {
          id: 'forrest_dashboard_port_owner',
          seedOrigin: 'system',
          state: 'resolved',
          claim: 'Dashboard port :5012 is owned by home23-forrest-dash, not a stale listener',
          verifier: { type: 'pm2_port_owner', args: { name: 'home23-forrest-dash', port: '5012' } },
          remediation: [{ type: 'pm2_restart', args: { name: 'home23-forrest-dash' } }],
        },
      ],
    }));

    const store = new LiveProblemStore({ brainDir: dir });
    seedAll(store, { agentName: 'forrest', dashboardPort: '5012', bridgePort: '5014' });

    assert.equal(store.get('jerry_dashboard_port_owner'), undefined);
    assert.equal(store.get('forrest_dashboard_port_owner')?.verifier?.args?.name, 'home23-forrest-dash');
    assert.equal(store.get('forrest_dashboard_port_owner')?.verifier?.args?.port, '5012');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default seeds include agent-local operational log pressure invariants', () => {
  const seeds = defaultSeeds({ agentName: 'forrest', dashboardPort: '5012', bridgePort: '5014' });
  const byId = new Map(seeds.map((seed) => [seed.id, seed]));

  const provider = byId.get('forrest_provider_scoring_failures_clear');
  assert.equal(provider?.verifier?.type, 'log_recent_count');
  assert.match(provider.verifier.args.path, /\/instances\/forrest\/logs\/engine-err\.log$/);
  assert.match(provider.verifier.args.pattern, /Scoring batch failed/);
  assert.match(provider.verifier.args.sincePattern, /CrashRecovery/);
  assert.equal(provider.verifier.args.windowMinutes, 30);
  assert.equal(provider.verifier.args.maxCount, 3);
  assert.equal(provider.remediation[0].type, 'dispatch_to_worker');

  const publish = byId.get('forrest_publish_starvation_clear');
  assert.equal(publish?.verifier?.type, 'log_recent_count');
  assert.equal(publish.verifier.args.pattern, '\\[publish\\] starvation:');
  assert.match(publish.verifier.args.sincePattern, /CrashRecovery/);
  assert.equal(publish.verifier.args.maxCount, 2);

  const cpu = byId.get('forrest_cpu_pressure_clear');
  assert.equal(cpu?.verifier?.type, 'log_recent_count');
  assert.equal(cpu.verifier.args.pattern, '\\[ResourceMonitor\\] High CPU usage');
  assert.match(cpu.verifier.args.sincePattern, /CrashRecovery/);
  assert.equal(cpu.verifier.args.maxCount, 3);

  const cron = byId.get('forrest_harness_cron_jobs_healthy');
  assert.equal(cron?.verifier?.type, 'cron_job_errors');
  assert.match(cron.verifier.args.path, /\/instances\/forrest\/conversations\/cron-jobs\.json$/);
  assert.equal(cron.remediation[0].type, 'dispatch_to_worker');
  assert.equal(cron.remediation[0].args.worker, 'systems');
});

test('default seeds verify dashboard port ownership separately from HTTP reachability', () => {
  const seeds = defaultSeeds({ agentName: 'forrest', dashboardPort: '5012', bridgePort: '5014' });
  const byId = new Map(seeds.map((seed) => [seed.id, seed]));

  const portOwner = byId.get('forrest_dashboard_port_owner');
  assert.equal(portOwner?.verifier?.type, 'pm2_port_owner');
  assert.equal(portOwner.verifier.args.name, 'home23-forrest-dash');
  assert.equal(portOwner.verifier.args.port, '5012');
  assert.equal(portOwner.remediation[0].type, 'pm2_restart');
  assert.equal(portOwner.remediation[0].args.name, 'home23-forrest-dash');
  assert.equal(portOwner.remediation[1].type, 'dispatch_to_agent');
  assert.match(portOwner.remediation[2].args.text, /stale listener/);
});

test('resolved verification clears stale escalation state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir });
    store.upsert({
      id: 'example',
      claim: 'example problem',
      verifier: { type: 'file_exists', args: { path: '/tmp/nope' } },
      remediation: [],
      escalated: true,
      escalatedAt: '2026-04-23T00:00:00.000Z',
    });

    store.recordVerification('example', { ok: true, detail: 'fixed' });

    const p = store.get('example');
    assert.equal(p.state, 'resolved');
    assert.equal(p.escalated, false);
    assert.equal(p.escalatedAt, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolved live problem stays resolved on transient verifier failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir });
    store.upsert({
      id: 'example',
      claim: 'example problem',
      verifier: { type: 'http_ping', args: { url: 'http://127.0.0.1:1' } },
      remediation: [],
    });

    store.recordVerification('example', { ok: true, detail: 'fresh', observed: { status: 200 } });
    store.recordVerification('example', { ok: false, detail: 'fetch failed: socket hang up' });

    const p = store.get('example');
    assert.equal(p.state, 'resolved');
    assert.equal(p.lastResult.ok, true);
    assert.equal(p.transientFailureCount, 1);
    assert.match(p.lastTransientFailure.detail, /socket hang up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolved live problem stays resolved when a selected JSON array element is briefly missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir });
    store.upsert({
      id: 'sauna_sensor_fresh',
      claim: 'Sauna tile sensor refreshing within last 10 min',
      verifier: { type: 'jsonpath_http', args: { path: 'sensors[id=tile.sauna-control].ts' } },
      remediation: [],
    });

    store.recordVerification('sauna_sensor_fresh', { ok: true, detail: 'fresh', observed: { value: new Date().toISOString() } });
    store.recordVerification('sauna_sensor_fresh', { ok: false, detail: 'sensors[id=tile.sauna-control].ts=undefined > 2026-05-10T05:00:00.000Z -> fail after 2 attempts (missing selected array element)' });

    const p = store.get('sauna_sensor_fresh');
    assert.equal(p.state, 'resolved');
    assert.equal(p.lastResult.ok, true);
    assert.equal(p.transientFailureCount, 1);
    assert.match(p.lastTransientFailure.detail, /missing selected array element/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolved log-backed problem re-verifies when source log changed inside cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const logPath = join(dir, 'engine-err.log');
    writeFileSync(logPath, '[12:00:00] INFO boot\n');
    const lastCheckedAt = '2026-05-09T20:00:00.000Z';
    utimesSync(logPath, new Date('2026-05-09T19:59:00.000Z'), new Date('2026-05-09T20:01:00.000Z'));

    assert.equal(shouldReverifyResolvedProblem({
      state: 'resolved',
      lastCheckedAt,
      verifier: {
        type: 'log_recent_count',
        args: { path: logPath, pattern: 'Cycle timeout exceeded' },
      },
    }, { nowMs: Date.parse('2026-05-09T20:03:00.000Z') }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolved problem stays in cooldown when verifier source has not changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const logPath = join(dir, 'engine-err.log');
    writeFileSync(logPath, '[12:00:00] INFO boot\n');
    const lastCheckedAt = '2026-05-09T20:00:00.000Z';
    utimesSync(logPath, new Date('2026-05-09T19:58:00.000Z'), new Date('2026-05-09T19:59:00.000Z'));

    assert.equal(shouldReverifyResolvedProblem({
      state: 'resolved',
      lastCheckedAt,
      verifier: {
        type: 'log_recent_count',
        args: { path: logPath, pattern: 'Cycle timeout exceeded' },
      },
    }, { nowMs: Date.parse('2026-05-09T20:03:00.000Z') }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manual resolved live-problem processing can force reverify inside cooldown', () => {
  assert.equal(shouldReverifyResolvedProblem({
    state: 'resolved',
    lastCheckedAt: '2026-05-09T20:00:00.000Z',
    verifier: { type: 'http_ping', args: { url: 'http://127.0.0.1:1' } },
  }, {
    force: true,
    nowMs: Date.parse('2026-05-09T20:01:00.000Z'),
  }), true);
});

test('store stamps updatedAt on verification and remediation transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir });
    store.upsert({
      id: 'example',
      claim: 'example problem',
      verifier: { type: 'file_exists', args: { path: '/tmp/nope' } },
      remediation: [{ type: 'fetch_url', args: { url: 'http://localhost' } }],
    });

    const first = store.get('example').updatedAt;
    assert.match(first, /^\d{4}-\d{2}-\d{2}T/);

    store.recordVerification('example', { ok: false, detail: 'still broken' });
    const afterVerify = store.get('example').updatedAt;
    assert.notEqual(afterVerify, undefined);

    store.recordRemediation('example', { step: 0, type: 'fetch_url', outcome: 'success', detail: '200' });
    const afterRemediation = store.get('example').updatedAt;
    assert.notEqual(afterRemediation, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful but ineffective remediation advances after max attempts', () => {
  const p = {
    id: 'example',
    state: 'open',
    openedAt: '2026-05-01T00:00:00.000Z',
    lastCheckedAt: '2026-05-01T00:02:00.000Z',
    stepIndex: 0,
    remediationLog: [{
      step: 0,
      type: 'pm2_restart',
      outcome: 'success',
      detail: 'restarted home23-jerry',
      at: '2026-05-01T00:01:00.000Z',
    }],
  };

  assert.equal(
    shouldAdvanceAfterIneffectiveSuccess(p, { type: 'pm2_restart', args: { name: 'home23-jerry' } }),
    true,
  );
  assert.equal(
    shouldAdvanceAfterIneffectiveSuccess(p, { type: 'pm2_restart', maxSuccessAttempts: 2 }),
    false,
  );
  assert.equal(
    shouldAdvanceAfterIneffectiveSuccess(p, { type: 'dispatch_to_agent' }),
    false,
  );
});

test('completed unknown diagnostic advances instead of looping forever', () => {
  assert.deepEqual(
    classifyDispatchRecipe({
      dispatchOutcome: 'unknown',
      verifierStatus: 'unknown',
      summary: 'agent completed without proving the verifier passes',
    }),
    { outcome: 'failed', advance: true },
  );
});

test('home23 engine process names remain restartable, including self names', () => {
  const prev = process.env.INSTANCE_ID;
  process.env.INSTANCE_ID = 'home23-jerry';
  try {
    assert.equal(isRestartableProcess('home23-jerry'), true);
    assert.equal(isRestartableProcess('home23-jerry-harness'), true);
    assert.equal(isRestartableProcess('cosmo23-jtr'), false);
    assert.equal(isRestartableProcess('home23-jerry;rm -rf /'), false);
  } finally {
    if (prev === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = prev;
  }
});

test('thoughts_flowing seed diagnoses before restarting the engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    const store = new LiveProblemStore({ brainDir: dir });
    seedAll(store, { agentName: 'jerry', dashboardPort: '5002', bridgePort: '5004' });

    const p = store.get('thoughts_flowing');
    assert.equal(p.remediation[0].type, 'dispatch_to_agent');
    assert.equal(p.remediation.some(step => step.type === 'pm2_restart'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix_recipe_recorded verifier closes agenda diagnostics after agent report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-live-problems-'));
  try {
    writeFileSync(join(dir, 'live-problems.json'), JSON.stringify({
      problems: [{
        id: 'agenda_ag-123',
        claim: 'Agenda action: investigate RECENT.md',
        fixRecipe: {
          at: '2026-04-24T12:00:00.000Z',
          dispatchOutcome: 'fixed',
          verifierStatus: 'pass',
          turnId: 'turn-1',
        },
      }],
    }));

    const result = await runVerifier({
      type: 'fix_recipe_recorded',
      args: { problemId: 'agenda_ag-123', since: '2026-04-24T11:00:00.000Z' },
    }, { brainDir: dir });

    assert.equal(result.ok, true);
    assert.equal(result.observed.turnId, 'turn-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
