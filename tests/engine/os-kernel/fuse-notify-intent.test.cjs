'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveProblemsLoop, isFuseBoxNotify } = require('../../../engine/src/live-problems/loop.js');

test('isFuseBoxNotify allows explicit fuseBox and critical/emergency severity only', () => {
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { fuseBox: true, severity: 'normal' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'critical' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'emergency' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'alert' } }), false);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'normal' } }), false);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: {} }), false);
  assert.equal(isFuseBoxNotify({ type: 'dispatch_to_agent', args: { fuseBox: true } }), false);
  assert.equal(isFuseBoxNotify(null), false);
  assert.equal(isFuseBoxNotify(undefined), false);
});

function makeFakeStore(problem) {
  const calls = { recordRemediation: [], advanceRemediationStep: [], markEscalated: [] };
  return {
    calls,
    recordVerification(id, result) {
      problem.lastResult = result;
      problem.lastCheckedAt = new Date().toISOString();
    },
    get(id) {
      return id === problem.id ? problem : null;
    },
    recordRemediation(id, entry) {
      calls.recordRemediation.push({ id, ...entry });
    },
    advanceRemediationStep(id) {
      calls.advanceRemediationStep.push(id);
      problem.stepIndex = (problem.stepIndex || 0) + 1;
    },
    markEscalated(id) {
      calls.markEscalated.push(id);
      problem.escalated = true;
    },
    clearDispatch() {},
    recordDispatch() {},
  };
}

function makeFakeOsKernelStore() {
  const intents = [];
  return {
    intents,
    upsertOperatorIntent(intent) {
      const record = { id: intent.id || `intent-${intents.length}`, ...intent };
      intents.push(record);
      return record;
    },
    listOperatorIntents() {
      return [...intents];
    },
  };
}

test('scenery notify_jtr (no fuseBox, non-critical severity) is starved and never raises an operator intent', async () => {
  const problem = {
    id: 'scenery_problem',
    claim: 'Scenery only — should never page jtr',
    state: 'open',
    verifier: { type: 'file_exists', args: { path: '/definitely-does-not-exist-fuse-notify-test-xyz' } },
    remediation: [
      {
        type: 'notify_jtr',
        args: { severity: 'normal', text: 'scenery ping, should be starved' },
        cooldownMin: 0,
      },
    ],
    stepIndex: 0,
    remediationLog: [],
    escalated: false,
  };

  const store = makeFakeStore(problem);
  const osKernelStore = makeFakeOsKernelStore();
  const ctx = { agentName: 'testagent', osKernel: { store: osKernelStore } };
  const loop = new LiveProblemsLoop({ store, ctxProvider: () => ctx });

  await loop._processOne(problem);

  // Starved: exactly one recorded remediation, marked skipped, with the
  // walk-away detail string — the remediator (and thus a real notify) never ran.
  assert.equal(store.calls.recordRemediation.length, 1);
  assert.equal(store.calls.recordRemediation[0].outcome, 'skipped');
  assert.match(store.calls.recordRemediation[0].detail, /notify_jtr starved — fuse-box only/);
  assert.equal(store.calls.markEscalated.length, 1);
  assert.equal(store.calls.advanceRemediationStep.length, 1);

  // No operator intent was ever raised for a scenery notify.
  assert.equal(osKernelStore.intents.length, 0);
});

test('fuse-box notify_jtr (fuseBox: true) raises a governed operator intent before running the remediator', async () => {
  const problem = {
    id: 'fuse_problem',
    claim: 'Fuse-box problem — should page jtr',
    state: 'open',
    verifier: { type: 'file_exists', args: { path: '/definitely-does-not-exist-fuse-notify-test-xyz' } },
    remediation: [
      {
        type: 'notify_jtr',
        args: {
          fuseBox: true,
          severity: 'normal',
          text: 'Fuse-box condition needs jtr',
          title: 'Fuse test title',
          checklist: ['Do the first thing', 'Do the second thing'],
        },
        cooldownMin: 0,
      },
    ],
    stepIndex: 0,
    remediationLog: [],
    escalated: false,
  };

  const store = makeFakeStore(problem);
  const osKernelStore = makeFakeOsKernelStore();
  // No harnessNotifyUrl — the remediator itself will reject, but the intent
  // must already have been raised by the time that happens.
  const ctx = { agentName: 'testagent', osKernel: { store: osKernelStore } };
  const loop = new LiveProblemsLoop({ store, ctxProvider: () => ctx });

  await loop._processOne(problem);

  assert.equal(osKernelStore.intents.length, 1);
  const intent = osKernelStore.intents[0];
  assert.equal(intent.problemId, 'fuse_problem');
  assert.equal(intent.agent, 'testagent');
  assert.equal(intent.title, 'Fuse test title');
  assert.equal(intent.status, 'open');
  assert.deepEqual(intent.checklist, ['Do the first thing', 'Do the second thing']);

  // The remediator was actually invoked (unlike the scenery path): one
  // recordRemediation call, and it's not the "skipped/starved" outcome.
  assert.equal(store.calls.recordRemediation.length, 1);
  assert.notEqual(store.calls.recordRemediation[0].outcome, 'skipped');
});

test('fuse-box notify_jtr with no ctx.osKernel does not throw and still runs the remediator', async () => {
  const problem = {
    id: 'fuse_no_kernel',
    claim: 'Fuse-box problem without an os-kernel wired in',
    state: 'open',
    verifier: { type: 'file_exists', args: { path: '/definitely-does-not-exist-fuse-notify-test-xyz' } },
    remediation: [
      {
        type: 'notify_jtr',
        args: { severity: 'critical', text: 'critical, but no os-kernel ctx' },
        cooldownMin: 0,
      },
    ],
    stepIndex: 0,
    remediationLog: [],
    escalated: false,
  };

  const store = makeFakeStore(problem);
  const ctx = { agentName: 'testagent' }; // no osKernel
  const loop = new LiveProblemsLoop({ store, ctxProvider: () => ctx });

  await assert.doesNotReject(() => loop._processOne(problem));
  assert.equal(store.calls.recordRemediation.length, 1);
  assert.notEqual(store.calls.recordRemediation[0].outcome, 'skipped');
});
