'use strict';

/**
 * Short Launch plan: goal, constraints, deliverable.
 * Not a 3-phase specialist recipe. Not "review what is already here."
 */

const FORBIDDEN_PLAN_PHRASES = [
  'review what is already here',
  'local evidence inventory',
  'guided_continuation_inventory',
  'guided_continuation_verdict',
  'read the existing local artifacts for this continuation before doing any new research'
];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function composeShortLaunchPlan(guidedFocus = {}) {
  const goal = nonEmpty(guidedFocus.domain) || 'Research the stated topic';
  const context = nonEmpty(guidedFocus.context);
  const constraints = [];
  if (context) constraints.push(context);

  const deliverable = nonEmpty(guidedFocus.deliverable)
    || 'Write the research into this run and Brain. Leave a concrete artifact in outputs/.';

  const plan = {
    goal,
    constraints,
    deliverable,
    executionKind: 'tool_loop',
    claimedBy: 'launch_loop'
  };

  assertShortPlan(plan);
  return plan;
}

function assertShortPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Short launch plan is required');
  }
  if (!nonEmpty(plan.goal) || !nonEmpty(plan.deliverable) || !Array.isArray(plan.constraints)) {
    throw new Error('Short launch plan requires goal, constraints, and deliverable');
  }

  const blob = JSON.stringify(plan).toLowerCase();
  for (const phrase of FORBIDDEN_PLAN_PHRASES) {
    if (blob.includes(phrase.toLowerCase())) {
      throw new Error(`Short launch plan must not contain: ${phrase}`);
    }
  }
}

function isToolLoopPlan(plan) {
  return Boolean(plan && plan.executionKind === 'tool_loop');
}

function isLegacySpecialistPlan(plan) {
  if (!plan) return false;
  if (isToolLoopPlan(plan)) return false;
  return true;
}

module.exports = {
  composeShortLaunchPlan,
  assertShortPlan,
  isToolLoopPlan,
  isLegacySpecialistPlan,
  FORBIDDEN_PLAN_PHRASES
};
