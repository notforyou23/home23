'use strict';

const path = require('node:path');

const {
  loadCanonicalRunMetadata,
} = require('../../../../cosmo23/server/lib/research-run-metadata.js');
const {
  buildResearchRunTarget,
} = require('../../../../shared/brain-operations/research-run-target.cjs');

const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function resolverError(code, message = code) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function createResearchRunTargetResolver({
  home23Root,
  requesterAgent,
  loadMetadata = loadCanonicalRunMetadata,
  buildTarget = buildResearchRunTarget,
} = {}) {
  if (typeof home23Root !== 'string'
      || !path.isAbsolute(home23Root)
      || path.normalize(home23Root) !== home23Root
      || typeof requesterAgent !== 'string'
      || !AGENT_PATTERN.test(requesterAgent)
      || typeof loadMetadata !== 'function'
      || typeof buildTarget !== 'function') {
    throw resolverError('brain_operations_configuration_invalid');
  }

  return async function resolveOwnedRunTarget({ runId } = {}) {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
      throw resolverError('invalid_request', 'Invalid research run target');
    }
    const canonicalRoot = path.join(
      home23Root,
      'instances',
      requesterAgent,
      'workspace',
      'research-runs',
      runId,
    );
    let metadata;
    try {
      metadata = await loadMetadata(canonicalRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (metadata?.runId !== runId
        || metadata?.ownerAgent !== requesterAgent
        || metadata?.canonicalRoot !== canonicalRoot) {
      throw resolverError('access_denied', 'Research run target identity mismatch');
    }
    const target = buildTarget(metadata);
    if (target?.domain !== 'owned-run'
        || target.runId !== runId
        || target.ownerAgent !== requesterAgent
        || target.canonicalRoot !== canonicalRoot) {
      throw resolverError('access_denied', 'Research run target identity mismatch');
    }
    return target;
  };
}

module.exports = {
  createResearchRunTargetResolver,
};
