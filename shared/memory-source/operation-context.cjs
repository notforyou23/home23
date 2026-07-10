'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openMemorySource } = require('./reader.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { memorySourceError } = require('./contracts.cjs');

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw memorySourceError('invalid_request', `safe ${label} required`);
  }
  return value;
}

async function withEphemeralMemorySource({
  brainDir,
  home23Root,
  requesterAgent,
  identity = {},
  signal,
  prefix = 'local',
  uuid = randomUUID,
} = {}, callback) {
  if (typeof callback !== 'function') throw memorySourceError('invalid_request', 'callback required');
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw memorySourceError('invalid_request', 'trusted home23 root required');
  }
  const homeRoot = await fsp.realpath(home23Root).catch(async () => {
    await fsp.mkdir(home23Root, { recursive: true, mode: 0o700 });
    return fsp.realpath(home23Root);
  });
  const canonicalBrain = await fsp.realpath(brainDir);
  const operationId = `${safeSegment(prefix, 'prefix')}-${safeSegment(uuid(), 'uuid')}`;
  const operationRoot = path.join(homeRoot, 'instances', safeSegment(requesterAgent, 'requester'), 'runtime', 'brain-operations', operationId);
  const lockRoot = path.join(homeRoot, 'runtime', 'brain-source-locks');
  const crossing = path.relative(canonicalBrain, operationRoot);
  if (!crossing || (!crossing.startsWith('..') && !path.isAbsolute(crossing))) {
    throw memorySourceError('invalid_request', 'operation root must not cross target');
  }
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  let source = null;
  try {
    const effectiveIdentity = Object.freeze({ ...identity, canonicalRoot: canonicalBrain, operationId });
    source = await openMemorySource(canonicalBrain, {
      operationId,
      requesterAgent,
      identity: effectiveIdentity,
      signal,
      operationRoot,
      lockRoot,
      scratchQuota,
    });
    return await callback(source, {
      operationId,
      operationRoot,
      lockRoot,
      scratchQuota,
      identity: effectiveIdentity,
    });
  } finally {
    await source?.close?.().catch(() => {});
    scratchQuota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function createInstalledLocalSourceContext({
  home23Root,
  requesterAgent,
  brainDir,
  activeRunPath = null,
  buildCatalog,
} = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)
      || typeof brainDir !== 'string' || !path.isAbsolute(brainDir)) {
    throw memorySourceError('invalid_request', 'trusted roots required');
  }
  safeSegment(requesterAgent, 'requester');
  return Object.freeze({
    home23Root,
    requesterAgent,
    brainDir,
    async resolveTargetContext(selector = {}) {
      if (Object.keys(selector).length !== 0) {
        throw memorySourceError('invalid_request', 'public selectors are not accepted');
      }
      const canonicalRoot = await fsp.realpath(brainDir);
      const catalog = typeof buildCatalog === 'function' ? await buildCatalog() : { revision: 'local', entries: [] };
      const entries = catalog.entries || catalog.targets || [];
      const matches = entries.filter((entry) => entry?.canonicalRoot === canonicalRoot
        || entry?.target?.canonicalRoot === canonicalRoot);
      if (matches.length > 1) throw memorySourceError('invalid_request', 'ambiguous local source context');
      const target = matches[0]?.target || matches[0] || {
        canonicalRoot,
        requesterAgent,
        brainId: requesterAgent,
        kind: activeRunPath ? 'run' : 'resident',
      };
      return Object.freeze({
        catalogRevision: catalog.revision || catalog.catalogRevision || 'local',
        target: Object.freeze({ ...target, canonicalRoot }),
        accessMode: activeRunPath ? 'owned-run' : 'own',
      });
    },
  });
}

module.exports = {
  withEphemeralMemorySource,
  createInstalledLocalSourceContext,
};
