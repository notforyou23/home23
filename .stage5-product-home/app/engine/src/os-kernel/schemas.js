'use strict';

const ACTION_CLASSES = Object.freeze({
  OBSERVE: 'observe',
  ANALYZE: 'analyze',
  DRAFT: 'draft',
  LOCAL_REVERSIBLE: 'local_reversible',
  EXTERNAL_CONSEQUENTIAL: 'external_consequential',
  DESTRUCTIVE: 'destructive',
});

const GOAL_STATUSES = Object.freeze({
  QUEUED: 'queued',
  ACTIVE: 'active',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
});

const INTENT_STATUSES = Object.freeze({
  OPEN: 'open',
  SNOOZED: 'snoozed',
  RESOLVED: 'resolved',
  DENIED: 'denied',
});

const DEFAULT_WIP_ACTIVE_MAX = 3;

module.exports = {
  ACTION_CLASSES,
  GOAL_STATUSES,
  INTENT_STATUSES,
  DEFAULT_WIP_ACTIVE_MAX,
  SCHEMA_GOAL: 'home23.os-kernel.goal.v1',
  SCHEMA_ACTION: 'home23.os-kernel.action.v1',
  SCHEMA_OPERATOR_INTENT: 'home23.operator-intent.v1',
  SCHEMA_EVENT: 'home23.os-kernel.event.v1',
  SCHEMA_BELIEF_DELTA: 'home23.os-kernel.belief-delta.v1',
};
