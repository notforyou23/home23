'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  canonicalJson,
} = require('./canonical-json.cjs');

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_STATES = new Set([
  'starting', 'active', 'stopping', 'paused', 'failed', 'completed', 'stopped',
]);
const MAX_CANONICAL_METADATA_BYTES = 256 * 1024;

function targetError(cause) {
  const error = new Error(
    'run_metadata_invalid',
    cause ? { cause } : undefined,
  );
  error.code = 'run_metadata_invalid';
  error.retryable = false;
  return error;
}

function canonicalMetadata(metadata) {
  let json;
  try {
    json = canonicalJson(metadata);
  } catch (error) {
    throw targetError(error);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CANONICAL_METADATA_BYTES) {
    throw targetError();
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw targetError(error);
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw targetError();
  return { json, value };
}

function assertIdentifier(value, pattern) {
  if (typeof value !== 'string'
      || !pattern.test(value)
      || value === '.'
      || value === '..') {
    throw targetError();
  }
  return value;
}

function assertCanonicalRoot(value, runId) {
  if (typeof value !== 'string'
      || !value
      || value.includes('\0')
      || /[\u0000-\u001f\u007f]/.test(value)
      || !path.isAbsolute(value)
      || path.normalize(value) !== value
      || path.dirname(value) === value
      || path.basename(value) !== runId) {
    throw targetError();
  }
  return value;
}

function buildMutationBoundaries(canonicalRoot) {
  return Object.freeze([
    Object.freeze({ kind: 'brain', path: canonicalRoot }),
    Object.freeze({ kind: 'run', path: canonicalRoot }),
    Object.freeze({ kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') }),
    Object.freeze({ kind: 'session', path: path.join(canonicalRoot, 'sessions') }),
    Object.freeze({ kind: 'cache', path: path.join(canonicalRoot, 'cache') }),
    Object.freeze({ kind: 'export', path: path.join(canonicalRoot, 'exports') }),
    Object.freeze({ kind: 'agency', path: path.join(canonicalRoot, 'agency') }),
  ]);
}

function catalogRevision(metadataJson, route, mutationBoundaries) {
  return crypto.createHash('sha256')
    .update('home23-owned-run-target-v1\0', 'utf8')
    .update(metadataJson, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson({ route, mutationBoundaries }), 'utf8')
    .digest('hex');
}

function buildResearchRunTarget(metadata) {
  const canonical = canonicalMetadata(metadata);
  const runId = assertIdentifier(canonical.value.runId, RUN_ID_PATTERN);
  const ownerAgent = assertIdentifier(canonical.value.ownerAgent, AGENT_PATTERN);
  const canonicalRoot = assertCanonicalRoot(canonical.value.canonicalRoot, runId);
  const runState = canonical.value.state;
  if (!RUN_STATES.has(runState)) throw targetError();

  const route = `/api/research/runs/${encodeURIComponent(runId)}`;
  const mutationBoundaries = buildMutationBoundaries(canonicalRoot);
  return Object.freeze({
    domain: 'owned-run',
    runId,
    canonicalRoot,
    ownerAgent,
    runState,
    catalogRevision: catalogRevision(canonical.json, route, mutationBoundaries),
    route,
    mutationBoundaries,
  });
}

module.exports = {
  buildResearchRunTarget,
};
