'use strict';

const { randomUUID } = require('crypto');
const { SCHEMA_BELIEF_DELTA } = require('./schemas');

function recordBeliefDelta(store, {
  goalId = null,
  intentId = null,
  claim,
  outcome,
  revisedBelief,
  evidenceReceiptId = null,
  source = null,
  at,
} = {}) {
  if (!store) throw new Error('store required');
  if (!claim) throw new Error('claim required');
  if (!outcome) throw new Error('outcome required');
  if (!revisedBelief) throw new Error('revisedBelief required');

  const delta = {
    schema: SCHEMA_BELIEF_DELTA,
    id: randomUUID(),
    at: at || new Date().toISOString(),
    goalId,
    intentId,
    claim,
    outcome,
    revisedBelief,
    evidenceReceiptId,
    source,
  };

  return store.appendBeliefDelta(delta);
}

function recordBeliefDeltaFromIntent(store, intent, { actionResult, verify, source } = {}) {
  const claim = String(intent?.why || intent?.title || 'operator intent');
  let revisedBelief = String(intent?.title || 'issue resolved');
  if (actionResult?.detail) {
    revisedBelief = `${revisedBelief}: ${actionResult.detail}`;
  } else if (verify?.result?.detail) {
    revisedBelief = `${revisedBelief}: ${verify.result.detail}`;
  }

  return recordBeliefDelta(store, {
    goalId: intent?.goal_id || intent?.goalId || null,
    intentId: intent?.id || null,
    claim,
    outcome: 'pass',
    revisedBelief,
    source: source || 'operator_intent',
  });
}

module.exports = {
  recordBeliefDelta,
  recordBeliefDeltaFromIntent,
  SCHEMA_BELIEF_DELTA,
};
