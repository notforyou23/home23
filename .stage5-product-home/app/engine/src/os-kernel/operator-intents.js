'use strict';

const { SCHEMA_OPERATOR_INTENT, INTENT_STATUSES } = require('./schemas');

function createFromFuseNotify(store, {
  problemId,
  agent,
  title,
  why,
  evidence,
  checklist,
  safeAction,
}) {
  const id = problemId;
  const createdAt = new Date().toISOString();
  return store.upsertOperatorIntent({
    schema: SCHEMA_OPERATOR_INTENT,
    id,
    problemId,
    agent,
    title,
    why,
    evidence,
    checklist,
    safe_action: safeAction,
    status: INTENT_STATUSES.OPEN,
    deep_link: `/home23#needs-you=${id}`,
    createdAt,
  });
}

function _getIntent(store, id) {
  const intent = store.listOperatorIntents().find((i) => i.id === id);
  if (!intent) {
    throw new Error(`Operator intent not found: ${id}`);
  }
  return intent;
}

function snooze(store, id, hours = 12) {
  const intent = _getIntent(store, id);
  const snoozeUntil = new Date(Date.now() + hours * 3600000).toISOString();
  return store.upsertOperatorIntent({
    ...intent,
    status: INTENT_STATUSES.SNOOZED,
    snoozeUntil,
  });
}

function resolve(store, id) {
  const intent = _getIntent(store, id);
  return store.upsertOperatorIntent({
    ...intent,
    status: INTENT_STATUSES.RESOLVED,
  });
}

function deny(store, id) {
  const intent = _getIntent(store, id);
  return store.upsertOperatorIntent({
    ...intent,
    status: INTENT_STATUSES.DENIED,
  });
}

function listOpen(store) {
  const now = Date.now();
  return store.listOperatorIntents().filter((intent) => {
    if (intent.status === INTENT_STATUSES.OPEN) return true;
    if (intent.status === INTENT_STATUSES.SNOOZED
      && Date.parse(intent.snoozeUntil || 0) <= now) {
      return true;
    }
    return false;
  });
}

module.exports = {
  createFromFuseNotify,
  snooze,
  resolve,
  deny,
  listOpen,
};
