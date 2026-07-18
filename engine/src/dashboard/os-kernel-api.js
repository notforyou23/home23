'use strict';

const { getOsKernel } = require('../os-kernel');
const { GOAL_STATUSES, INTENT_STATUSES } = require('../os-kernel/schemas');
const { recordBeliefDeltaFromIntent } = require('../os-kernel/belief-delta');
const { runVerifier } = require('../live-problems/verifiers');

function buildRemediatorCtx(target = {}) {
  const bport = target.bridgePort || process.env.HOME23_BRIDGE_PORT || process.env.BRIDGE_PORT || '5004';
  const dashboardPort = process.env.DASHBOARD_PORT || process.env.COSMO_DASHBOARD_PORT || '5002';
  return {
    brainDir: target.runtimeDir,
    agentName: target.agentName,
    dashboardBaseUrl: `http://127.0.0.1:${dashboardPort}`,
    harnessNotifyUrl: `http://127.0.0.1:${bport}/api/notify`,
    harnessDiagnoseUrl: `http://127.0.0.1:${bport}/api/diagnose`,
    workerConnectorBaseUrl: `http://127.0.0.1:${bport}`,
    harnessNotifyToken: process.env.BRIDGE_TOKEN || '',
  };
}

function findIntent(kernel, id) {
  return kernel.store.listOperatorIntents().find((intent) => intent.id === id) || null;
}

function hasAuthorizePreview(intent) {
  const preview = intent?.authorize?.action_preview || intent?.authorize?.actionPreview;
  return typeof preview === 'string' && preview.trim().length > 0;
}

function needsLocalActionAfterApprove(intent) {
  if (intent?.safe_action) return true;
  return Array.isArray(intent?.checklist) && intent.checklist.length > 0;
}

async function reverifyLinkedProblem(intent, { loadLiveProblems, getAgentContext, req }) {
  if (!intent?.problemId || typeof loadLiveProblems !== 'function') {
    return { ok: true, skipped: true };
  }

  const target = getAgentContext(req);
  const data = loadLiveProblems(target.agentName);
  const problem = (data.problems || []).find((entry) => entry.id === intent.problemId);
  if (!problem?.verifier) {
    return { ok: true, skipped: true, reason: 'no_verifier' };
  }

  const result = await runVerifier(problem.verifier, buildRemediatorCtx(target));
  return { ok: !!result.ok, result, problem };
}

function upsertIntentWithLastError(kernel, intent, lastError) {
  return kernel.store.upsertOperatorIntent({
    ...intent,
    status: INTENT_STATUSES.OPEN,
    lastError: String(lastError || 'verifier still failing').slice(0, 1000),
  });
}

function mountOsKernelApi(app, {
  getBrainDir,
  getAgentContext,
  loadLiveProblems,
} = {}) {
  if (!app || typeof getBrainDir !== 'function' || typeof getAgentContext !== 'function') {
    throw new Error('mountOsKernelApi requires app, getBrainDir, and getAgentContext');
  }

  app.get('/api/os-kernel/state', (req, res) => {
    try {
      const target = getAgentContext(req);
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const snapshot = kernel.getControlPlaneSnapshot();
      const activeGoalCount = kernel.store.listGoals()
        .filter((goal) => goal.status === GOAL_STATUSES.ACTIVE)
        .length;

      res.json({
        available: true,
        agent: target.agentName,
        snapshot,
        activeGoalCount,
        wipActiveMax: kernel.store.wipActiveMax,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/os-kernel/intents/:id/safe-action', async (req, res) => {
    try {
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const intent = findIntent(kernel, req.params.id);
      if (!intent) return res.status(404).json({ error: 'intent not found' });
      if (!intent.safe_action) {
        return res.status(400).json({ error: 'intent has no safe_action' });
      }

      const target = getAgentContext(req);
      const runningAction = kernel.store.createAction({
        kind: 'safe_action',
        detail: intent.safe_action?.id || intent.title || null,
        intentId: intent.id,
        status: 'running',
      });
      let actionResult;
      try {
        actionResult = await kernel.runSafeAction(intent.safe_action, buildRemediatorCtx(target));
      } catch (err) {
        kernel.store.completeAction(runningAction.id, { status: 'failed', detail: err.message });
        throw err;
      }
      kernel.store.completeAction(runningAction.id, {
        status: actionResult?.outcome === 'success' ? 'complete' : 'failed',
        detail: actionResult?.detail || null,
      });
      const verify = await reverifyLinkedProblem(intent, { loadLiveProblems, getAgentContext, req });

      if (!verify.ok && !verify.skipped) {
        const updated = upsertIntentWithLastError(
          kernel,
          intent,
          verify.result?.detail || 'linked live-problem verifier still failing',
        );
        kernel.store.appendEvent({
          type: 'operator_intent.safe_action',
          intentId: intent.id,
          outcome: 'verify_failed',
          actionResult,
          verify: verify.result || null,
        });
        return res.json({
          ok: false,
          intent: updated,
          actionResult,
          verify: verify.result || null,
        });
      }

      const resolved = kernel.resolveOperatorIntent(intent.id);
      recordBeliefDeltaFromIntent(kernel.store, intent, {
        actionResult,
        verify,
        source: 'operator_intent.safe_action',
      });
      kernel.store.appendEvent({
        type: 'operator_intent.safe_action',
        intentId: intent.id,
        outcome: 'resolved',
        actionResult,
        verify: verify.skipped ? null : (verify.result || null),
      });
      return res.json({ ok: true, intent: resolved, actionResult, verify: verify.result || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/os-kernel/intents/:id/mark-done', async (req, res) => {
    try {
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const intent = findIntent(kernel, req.params.id);
      if (!intent) return res.status(404).json({ error: 'intent not found' });

      const verify = await reverifyLinkedProblem(intent, { loadLiveProblems, getAgentContext, req });
      if (!verify.ok && !verify.skipped) {
        const updated = upsertIntentWithLastError(
          kernel,
          intent,
          verify.result?.detail || 'linked live-problem verifier still failing',
        );
        kernel.store.appendEvent({
          type: 'operator_intent.mark_done',
          intentId: intent.id,
          outcome: 'verify_failed',
          verify: verify.result || null,
        });
        return res.json({ ok: false, intent: updated, verify: verify.result || null });
      }

      const resolved = kernel.resolveOperatorIntent(intent.id);
      recordBeliefDeltaFromIntent(kernel.store, intent, {
        verify,
        source: 'operator_intent.mark_done',
      });
      kernel.store.appendEvent({
        type: 'operator_intent.mark_done',
        intentId: intent.id,
        outcome: 'resolved',
        verify: verify.skipped ? null : (verify.result || null),
      });
      return res.json({ ok: true, intent: resolved, verify: verify.result || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/os-kernel/intents/:id/snooze', (req, res) => {
    try {
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const intent = findIntent(kernel, req.params.id);
      if (!intent) return res.status(404).json({ error: 'intent not found' });

      const body = req.body || {};
      const hours = Number.isFinite(Number(body.hours)) ? Number(body.hours) : 12;
      const snoozed = kernel.snoozeOperatorIntent(intent.id, hours);
      kernel.store.appendEvent({
        type: 'operator_intent.snooze',
        intentId: intent.id,
        hours,
      });
      return res.json({ ok: true, intent: snoozed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/os-kernel/intents/:id/deny', (req, res) => {
    try {
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const intent = findIntent(kernel, req.params.id);
      if (!intent) return res.status(404).json({ error: 'intent not found' });

      const denied = kernel.denyOperatorIntent(intent.id);
      kernel.store.appendEvent({
        type: 'operator_intent.deny',
        intentId: intent.id,
        actor: (req.body || {}).actor || 'dashboard',
      });
      return res.json({ ok: true, intent: denied });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/os-kernel/intents/:id/approve', (req, res) => {
    try {
      const brainDir = getBrainDir(req);
      const kernel = getOsKernel(brainDir);
      const intent = findIntent(kernel, req.params.id);
      if (!intent) return res.status(404).json({ error: 'intent not found' });
      if (!hasAuthorizePreview(intent)) {
        return res.status(400).json({ error: 'intent has no authorize preview' });
      }

      const nowIso = new Date().toISOString();
      const body = req.body || {};

      if (!needsLocalActionAfterApprove(intent)) {
        const resolved = kernel.resolveOperatorIntent(intent.id);
        kernel.store.appendEvent({
          type: 'operator_intent.approve',
          intentId: intent.id,
          actor: body.actor || 'dashboard',
          outcome: 'resolved',
          approvedAt: nowIso,
        });
        return res.json({ ok: true, intent: resolved, resolved: true });
      }

      const approved = kernel.store.upsertOperatorIntent({
        ...intent,
        status: INTENT_STATUSES.OPEN,
        approvedAt: nowIso,
      });
      kernel.store.appendEvent({
        type: 'operator_intent.approve',
        intentId: intent.id,
        actor: body.actor || 'dashboard',
        outcome: 'approved_for_local_action',
        approvedAt: nowIso,
      });
      return res.json({ ok: true, intent: approved, resolved: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  mountOsKernelApi,
  buildRemediatorCtx,
  reverifyLinkedProblem,
};
