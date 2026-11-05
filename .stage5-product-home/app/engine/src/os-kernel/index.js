'use strict';

/**
 * os-kernel — public entry point.
 *
 * Wraps the per-agent OsKernelStore plus the authorize/receipts/operator-intents/
 * safe-actions helpers into a single kernel handle, and exposes the control-plane
 * snapshot the dashboard "Needs You" / "In Flight" / "Verified" rails read from.
 */

const { OsKernelStore } = require('./store');
const {
  createFromFuseNotify,
  snooze,
  resolve,
  deny,
  listOpen,
} = require('./operator-intents');
const { runSafeAction } = require('./safe-actions');
const {
  canAutoRun,
  requiresHuman,
  activateGoal,
  authorizeAction,
} = require('./authorize');
const { buildActionReceipt, SCHEMA_ACTION_RECEIPT } = require('./receipts');
const { recordBeliefDelta, recordBeliefDeltaFromIntent } = require('./belief-delta');
const schemas = require('./schemas');

function getControlPlaneSnapshot(store) {
  const now = Date.now();
  const intents = store.listOperatorIntents();
  const needsYou = intents.filter((i) => {
    if (i.status === 'open') return true;
    if (i.status === 'snoozed' && Date.parse(i.snoozeUntil || 0) <= now) return true;
    return false;
  });
  const inFlight = store.listActions().filter((a) => a.status === 'running');
  const verified = store.listGoals().filter((g) => g.status === 'complete').slice(-10).reverse();
  return { needsYou, inFlight, verified };
}

function getOsKernel(brainDir) {
  const store = new OsKernelStore({ brainDir });
  // Defensive: the constructor already loads fresh, but call explicitly so
  // this stays correct if getOsKernel is ever changed to reuse a cached
  // long-lived store instance instead of constructing a new one per call.
  store.reloadIfChanged();

  return {
    store,

    // Operator intents (fuse-box notify → "Needs You" queue)
    createFromFuseNotify: (opts) => createFromFuseNotify(store, opts),
    snoozeOperatorIntent: (id, hours) => snooze(store, id, hours),
    resolveOperatorIntent: (id) => resolve(store, id),
    denyOperatorIntent: (id) => deny(store, id),
    listOpenOperatorIntents: () => listOpen(store),

    // Safe actions (bounded, allowlist-governed remediations run from an intent)
    runSafeAction: (spec, ctx) => runSafeAction(spec, ctx),

    // Authorize / WIP-capped goal activation
    activateGoal: (goalId) => activateGoal(store, goalId),
    canAutoRun,
    requiresHuman,
    authorizeAction: (opts) => authorizeAction(store, opts),

    // Receipts (evidence-backed goal completion). Also upserts a completed
    // action record so "In Flight" -> "Verified" has a paper trail even for
    // callers that never called createAction/completeAction themselves.
    buildActionReceipt: (opts) => {
      const receipt = buildActionReceipt({ brainDir, ...opts });
      try {
        store.createAction({
          goalId: opts.goalId || receipt.goalId || null,
          kind: opts.actionClass || receipt.actionClass || 'action',
          detail: receipt.artifact?.path || null,
          status: 'complete',
          receiptId: receipt.id,
        });
      } catch {
        // Action-tracking is best-effort — never fail a receipt over it.
      }
      return receipt;
    },

    // Belief revision on verified outcomes
    recordBeliefDelta: (opts) => recordBeliefDelta(store, opts),
    recordBeliefDeltaFromIntent: (intent, ctx) => recordBeliefDeltaFromIntent(store, intent, ctx),

    // Control-plane snapshot for the dashboard rails
    getControlPlaneSnapshot: () => getControlPlaneSnapshot(store),

    schemas,
  };
}

module.exports = {
  getOsKernel,
  getControlPlaneSnapshot,
  createFromFuseNotify,
  runSafeAction,
  activateGoal,
  buildActionReceipt,
  recordBeliefDelta,
  recordBeliefDeltaFromIntent,
  SCHEMA_ACTION_RECEIPT,
};
