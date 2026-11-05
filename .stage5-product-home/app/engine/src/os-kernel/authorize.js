'use strict';
const { ACTION_CLASSES, GOAL_STATUSES, DEFAULT_WIP_ACTIVE_MAX } = require('./schemas');

function canAutoRun(actionClass) {
  return [
    ACTION_CLASSES.OBSERVE,
    ACTION_CLASSES.ANALYZE,
    ACTION_CLASSES.DRAFT,
    ACTION_CLASSES.LOCAL_REVERSIBLE,
  ].includes(actionClass);
}

function requiresHuman(actionClass) {
  return actionClass === ACTION_CLASSES.EXTERNAL_CONSEQUENTIAL
    || actionClass === ACTION_CLASSES.DESTRUCTIVE;
}

function activateGoal(store, goalId) {
  const max = store.wipActiveMax ?? DEFAULT_WIP_ACTIVE_MAX;
  const active = store.listGoals().filter((g) => g.status === GOAL_STATUSES.ACTIVE);
  if (active.length >= max) {
    throw new Error(`WIP cap: ${active.length}/${max} active goals`);
  }
  return store.setGoalStatus(goalId, GOAL_STATUSES.ACTIVE);
}

function authorizeAction(store, { goalId, actionClass, capabilityId, preview }) {
  if (requiresHuman(actionClass)) {
    return { allowed: false, reason: 'needs_you', actionClass, preview, capabilityId, goalId };
  }
  if (!canAutoRun(actionClass)) {
    return { allowed: false, reason: 'unknown_class', actionClass };
  }
  return { allowed: true, actionClass, capabilityId, goalId };
}

module.exports = { canAutoRun, requiresHuman, activateGoal, authorizeAction };
