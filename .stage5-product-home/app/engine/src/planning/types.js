const { monotonicFactory } = require('ulid');

const ulid = monotonicFactory();

/**
 * @typedef {Object} Plan
 * @property {string} id - Unique plan identifier (ulid format)
 * @property {string} title - Human-readable plan name
 * @property {number} version - Version number for optimistic locking
 * @property {'ACTIVE'|'PAUSED'|'COMPLETED'|'CANCELLED'} status - Plan status
 * @property {string[]} milestones - Array of milestone IDs in order
 * @property {string|null} activeMilestone - Currently active milestone ID
 * @property {number} createdAt - Unix timestamp
 * @property {number} updatedAt - Unix timestamp
 */

/**
 * @typedef {Object} Milestone
 * @property {string} id - Unique milestone identifier (ulid format)
 * @property {string} planId - Parent plan ID
 * @property {string} title - Human-readable milestone name
 * @property {number} order - Order in plan sequence (1-indexed)
 * @property {'LOCKED'|'ACTIVE'|'COMPLETED'} status - Milestone status
 * @property {number} createdAt - Unix timestamp
 * @property {number} updatedAt - Unix timestamp
 */

/**
 * @typedef {Object} Task
 * @property {string} id - Unique task identifier (ulid format)
 * @property {string} planId - Parent plan ID
 * @property {string} milestoneId - Parent milestone ID
 * @property {string} title - Human-readable task title
 * @property {string} description - Detailed task description
 * @property {string[]} tags - Classification tags
 * @property {string[]} deps - Array of task IDs that must complete first
 * @property {number} priority - Priority score (higher = more important)
 * @property {'PENDING'|'CLAIMED'|'IN_PROGRESS'|'BLOCKED'|'DONE'|'FAILED'} state - Task state
 * @property {AcceptanceCriterion[]} acceptanceCriteria - Validation requirements
 * @property {Object[]} artifacts - Generated outputs
 * @property {string|null} claimedBy - Instance ID that claimed this task
 * @property {number|null} claimExpires - Unix timestamp when claim expires
 * @property {number} createdAt - Unix timestamp
 * @property {number} updatedAt - Unix timestamp
 */

/**
 * @typedef {Object} AcceptanceCriterion
 * @property {'literal'|'tool'|'qa'} type - Validation method
 * @property {string} [pattern] - Regex pattern for literal type
 * @property {string} [command] - Command to execute for tool type
 * @property {string} [rubric] - Evaluation criteria for qa type
 * @property {number} [threshold] - Minimum score for qa type (0-1)
 */

/**
 * @typedef {Object} PlanDelta
 * @property {string} planId - Target plan ID
 * @property {number} expectedVersion - Version check for optimistic locking
 * @property {Object} [addMilestones] - Milestones to add (keyed by ID)
 * @property {Object} [addTasks] - Tasks to add (keyed by ID)
 * @property {Object} [updateTasks] - Task updates (keyed by ID, partial objects)
 * @property {string[]} [removeTasks] - Task IDs to remove
 * @property {string} [setActiveMilestone] - Change active milestone
 */

/**
 * Validates a Plan object
 * @param {Plan} plan 
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePlan(plan) {
  const errors = [];
  
  if (!plan.id || typeof plan.id !== 'string') {
    errors.push('Plan must have a string id');
  }
  if (!plan.title || typeof plan.title !== 'string') {
    errors.push('Plan must have a string title');
  }
  if (typeof plan.version !== 'number' || plan.version < 1) {
    errors.push('Plan must have a version >= 1');
  }
  if (!['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'].includes(plan.status)) {
    errors.push('Plan status must be ACTIVE, PAUSED, COMPLETED, or CANCELLED');
  }
  if (!Array.isArray(plan.milestones)) {
    errors.push('Plan must have a milestones array');
  }
  if (typeof plan.createdAt !== 'number') {
    errors.push('Plan must have a numeric createdAt timestamp');
  }
  if (typeof plan.updatedAt !== 'number') {
    errors.push('Plan must have a numeric updatedAt timestamp');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates a Milestone object
 * @param {Milestone} milestone 
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateMilestone(milestone) {
  const errors = [];
  
  if (!milestone.id || typeof milestone.id !== 'string') {
    errors.push('Milestone must have a string id');
  }
  if (!milestone.planId || typeof milestone.planId !== 'string') {
    errors.push('Milestone must have a string planId');
  }
  if (!milestone.title || typeof milestone.title !== 'string') {
    errors.push('Milestone must have a string title');
  }
  if (typeof milestone.order !== 'number' || milestone.order < 1) {
    errors.push('Milestone must have an order >= 1');
  }
  if (!['LOCKED', 'ACTIVE', 'COMPLETED'].includes(milestone.status)) {
    errors.push('Milestone status must be LOCKED, ACTIVE, or COMPLETED');
  }
  if (typeof milestone.createdAt !== 'number') {
    errors.push('Milestone must have a numeric createdAt timestamp');
  }
  if (typeof milestone.updatedAt !== 'number') {
    errors.push('Milestone must have a numeric updatedAt timestamp');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates a Task object
 * @param {Task} task 
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateTask(task) {
  const errors = [];
  
  if (!task.id || typeof task.id !== 'string') {
    errors.push('Task must have a string id');
  }
  if (!task.planId || typeof task.planId !== 'string') {
    errors.push('Task must have a string planId');
  }
  if (!task.milestoneId || typeof task.milestoneId !== 'string') {
    errors.push('Task must have a string milestoneId');
  }
  if (!task.title || typeof task.title !== 'string') {
    errors.push('Task must have a string title');
  }
  if (!task.description || typeof task.description !== 'string') {
    errors.push('Task must have a string description');
  }
  if (!Array.isArray(task.tags)) {
    errors.push('Task must have a tags array');
  }
  if (!Array.isArray(task.deps)) {
    errors.push('Task must have a deps array');
  }
  if (typeof task.priority !== 'number') {
    errors.push('Task must have a numeric priority');
  }
  if (!['PENDING', 'CLAIMED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'FAILED'].includes(task.state)) {
    errors.push('Task state must be PENDING, CLAIMED, IN_PROGRESS, BLOCKED, DONE, or FAILED');
  }
  if (!Array.isArray(task.acceptanceCriteria)) {
    errors.push('Task must have an acceptanceCriteria array');
  }
  if (!Array.isArray(task.artifacts)) {
    errors.push('Task must have an artifacts array');
  }
  if (typeof task.createdAt !== 'number') {
    errors.push('Task must have a numeric createdAt timestamp');
  }
  if (typeof task.updatedAt !== 'number') {
    errors.push('Task must have a numeric updatedAt timestamp');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates an AcceptanceCriterion object
 * @param {AcceptanceCriterion} criterion 
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateAcceptanceCriterion(criterion) {
  const errors = [];
  
  if (!['literal', 'tool', 'qa'].includes(criterion.type)) {
    errors.push('AcceptanceCriterion type must be literal, tool, or qa');
  }
  
  if (criterion.type === 'literal' && !criterion.pattern) {
    errors.push('Literal acceptance criterion must have a pattern');
  }
  
  if (criterion.type === 'tool' && !criterion.command) {
    errors.push('Tool acceptance criterion must have a command');
  }
  
  if (criterion.type === 'qa') {
    if (!criterion.rubric) {
      errors.push('QA acceptance criterion must have a rubric');
    }
    if (typeof criterion.threshold !== 'number' || criterion.threshold < 0 || criterion.threshold > 1) {
      errors.push('QA acceptance criterion must have a threshold between 0 and 1');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates a PlanDelta object
 * @param {PlanDelta} delta 
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePlanDelta(delta) {
  const errors = [];
  
  if (!delta.planId || typeof delta.planId !== 'string') {
    errors.push('PlanDelta must have a string planId');
  }
  if (typeof delta.expectedVersion !== 'number' || delta.expectedVersion < 1) {
    errors.push('PlanDelta must have an expectedVersion >= 1');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generates a new ULID identifier
 * @returns {string}
 */
function generateId() {
  return ulid();
}

/**
 * Generates a plan ID with prefix
 * @returns {string}
 */
function generatePlanId() {
  return `plan:${ulid()}`;
}

/**
 * Generates a milestone ID with prefix
 * @returns {string}
 */
function generateMilestoneId() {
  return `ms:${ulid()}`;
}

/**
 * Generates a task ID with prefix
 * @returns {string}
 */
function generateTaskId() {
  return `task:${ulid()}`;
}

module.exports = {
  validatePlan,
  validateMilestone,
  validateTask,
  validateAcceptanceCriterion,
  validatePlanDelta,
  generateId,
  generatePlanId,
  generateMilestoneId,
  generateTaskId
};

