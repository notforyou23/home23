'use strict';

const path = require('node:path');

function authorityError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function freezePolicy(policy) {
  const copy = { ...policy };
  for (const field of ['modes', 'lifecycles', 'runStates']) {
    if (Array.isArray(copy[field])) copy[field] = Object.freeze([...copy[field]]);
  }
  return Object.freeze(copy);
}

const OPERATION_AUTHORITY = Object.freeze({
  search: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'none',
  }),
  graph: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'none',
  }),
  status: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'none',
  }),
  query: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'requester-scratch',
  }),
  pgs: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'requester-scratch',
  }),
  graph_export: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'requester-result',
  }),
  synthesis: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own'],
    lifecycles: ['resident'], writes: 'own-brain-cas',
  }),
  research_compile: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'],
    lifecycles: ['resident', 'completed'], writes: 'requester-workspace',
  }),
  research_launch: freezePolicy({
    domain: 'requester', requiresSourcePin: false, modes: ['own'],
    lifecycles: [], writes: 'requester-run',
  }),
  research_continue: freezePolicy({
    domain: 'owned-run', requiresSourcePin: false, modes: ['own'],
    runStates: ['paused', 'failed', 'completed'], writes: 'requester-run',
  }),
  research_stop: freezePolicy({
    domain: 'owned-run', requiresSourcePin: false, modes: ['own'],
    runStates: ['starting', 'active', 'stopping'], writes: 'requester-run',
  }),
  research_watch: freezePolicy({
    domain: 'owned-run', requiresSourcePin: false, modes: ['own'],
    runStates: ['starting', 'active', 'paused', 'failed', 'completed', 'stopped'],
    writes: 'none',
  }),
  research_intelligence: freezePolicy({
    domain: 'brain', requiresSourcePin: true, modes: ['read-only'],
    lifecycles: ['completed'], writes: 'none',
  }),
  ad_hoc_export: freezePolicy({
    domain: 'requester', requiresSourcePin: false, modes: ['own'], lifecycles: [],
    writes: 'requester-workspace-noncanonical', canonicalEvidence: false,
  }),
});

const INPUT_FIELDS = Object.freeze(['requesterAgent', 'operationType', 'target']);
const BRAIN_FIELDS = Object.freeze([
  'domain', 'brainId', 'canonicalRoot', 'accessMode', 'ownerAgent', 'displayName',
  'kind', 'lifecycle', 'catalogRevision', 'route', 'mutationBoundaries',
]);
const RUN_FIELDS = Object.freeze([
  'domain', 'runId', 'canonicalRoot', 'ownerAgent', 'runState', 'catalogRevision',
  'route', 'mutationBoundaries',
]);
const MUTATION_BOUNDARY_KINDS = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
]);

function hasExactOwnStringKeys(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== fields.length) return false;
  return fields.every((field) => Object.hasOwn(value, field));
}

function isIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(value)
    && value !== '.'
    && value !== '..';
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function isCanonicalAbsolutePath(value) {
  return isNonemptyString(value)
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && !value.includes('\0')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasCanonicalMutationBoundaries(value) {
  if (!Array.isArray(value) || value.length !== MUTATION_BOUNDARY_KINDS.length) return false;
  const seen = new Set();
  for (const boundary of value) {
    if (!hasExactOwnStringKeys(boundary, ['kind', 'path'])
        || !MUTATION_BOUNDARY_KINDS.includes(boundary.kind)
        || seen.has(boundary.kind)
        || !isCanonicalAbsolutePath(boundary.path)) return false;
    seen.add(boundary.kind);
  }
  return seen.size === MUTATION_BOUNDARY_KINDS.length;
}

function assertCanonicalBrainTarget(target, requesterAgent, policy) {
  if (!hasExactOwnStringKeys(target, BRAIN_FIELDS)
      || target.domain !== 'brain'
      || !isIdentifier(target.brainId)
      || !isCanonicalAbsolutePath(target.canonicalRoot)
      || !isNonemptyString(target.displayName)
      || !isIdentifier(target.catalogRevision)
      || !isCanonicalAbsolutePath(target.route)
      || !hasCanonicalMutationBoundaries(target.mutationBoundaries)
      || (target.ownerAgent !== null && !isIdentifier(target.ownerAgent))) {
    throw authorityError('access_denied');
  }

  const resident = target.kind === 'resident' && target.lifecycle === 'resident';
  const completed = target.kind === 'research' && target.lifecycle === 'completed';
  if ((!resident && !completed) || (resident && !isIdentifier(target.ownerAgent))) {
    throw authorityError('access_denied');
  }
  const accessMode = resident && target.ownerAgent === requesterAgent ? 'own' : 'read-only';
  if (target.accessMode !== accessMode
      || !policy.modes.includes(accessMode)
      || !policy.lifecycles.includes(target.lifecycle)) {
    throw authorityError('access_denied');
  }
}

function assertCanonicalOwnedRunTarget(target, requesterAgent, policy) {
  if (!hasExactOwnStringKeys(target, RUN_FIELDS)
      || target.domain !== 'owned-run'
      || !isIdentifier(target.runId)
      || !isCanonicalAbsolutePath(target.canonicalRoot)
      || !isIdentifier(target.ownerAgent)
      || !isIdentifier(target.runState)
      || !isIdentifier(target.catalogRevision)
      || !isCanonicalAbsolutePath(target.route)
      || !hasCanonicalMutationBoundaries(target.mutationBoundaries)
      || target.ownerAgent !== requesterAgent
      || !policy.runStates.includes(target.runState)) {
    throw authorityError('access_denied');
  }
}

function assertCanonicalRequesterTarget(target, requesterAgent) {
  if (!hasExactOwnStringKeys(target, ['domain', 'requesterAgent'])
      || target.domain !== 'requester'
      || target.requesterAgent !== requesterAgent) {
    throw authorityError('access_denied');
  }
}

function authorizeBrainOperation(input) {
  if (!hasExactOwnStringKeys(input, INPUT_FIELDS)
      || !isIdentifier(input.requesterAgent)
      || !isIdentifier(input.operationType)) {
    throw authorityError('invalid_request');
  }
  const policy = OPERATION_AUTHORITY[input.operationType];
  if (!policy) throw authorityError('invalid_request');
  if (!input.target || Array.isArray(input.target) || typeof input.target !== 'object') {
    throw authorityError('invalid_request');
  }
  if (policy.domain !== input.target.domain) throw authorityError('access_denied');

  if (policy.domain === 'brain') {
    assertCanonicalBrainTarget(input.target, input.requesterAgent, policy);
  } else if (policy.domain === 'owned-run') {
    assertCanonicalOwnedRunTarget(input.target, input.requesterAgent, policy);
  } else {
    assertCanonicalRequesterTarget(input.target, input.requesterAgent);
  }
  return policy;
}

module.exports = {
  OPERATION_AUTHORITY,
  authorityError,
  authorizeBrainOperation,
};
