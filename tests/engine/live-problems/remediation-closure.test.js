import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LiveProblemStore } = require('../../../engine/src/live-problems/store.js');
const { seedAll } = require('../../../engine/src/live-problems/seed.js');
const { isRestartableProcess } = require('../../../engine/src/live-problems/remediators.js');
const { classifyDispatchRecipe, shouldAdvanceAfterIneffectiveSuccess } = require('../../../engine/src/live-problems/loop.js');
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
