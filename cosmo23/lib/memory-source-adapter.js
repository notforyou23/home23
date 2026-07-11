'use strict';

const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  createOperationScratchQuota,
  enumerateMemoryMutationBoundaries,
  memorySourceError,
  openMemorySource,
  projectLegacyResidentSidecars,
  projectLegacyResearchSnapshot,
  resolveMemorySourceSelection,
  throwIfAborted,
} = require('../../shared/memory-source');

function sortedMutationBoundaries(canonicalRoot) {
  return enumerateMemoryMutationBoundaries(canonicalRoot)
    .map((entry) => ({ kind: entry.kind, path: entry.path }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
}

async function createTempOperationRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-cosmo-memory-source-'));
}

async function openCosmoMemorySource(brainDir, options = {}) {
  throwIfAborted(options.signal);
  const selection = await resolveMemorySourceSelection(brainDir);
  const canonicalRoot = selection.canonicalRoot;
  const mutationBoundaries = sortedMutationBoundaries(canonicalRoot);

  if (selection.authority === 'manifest-v1') {
    const source = await openMemorySource(canonicalRoot, {
      ...options,
      identity: {
        ...(options.identity || {}),
        canonicalRoot,
        mutationBoundaries,
      },
    });
    const originalBoundaries = source.getMutationBoundaries?.bind(source);
    return Object.assign(source, {
      getMutationBoundaries() {
        return originalBoundaries ? originalBoundaries() : mutationBoundaries;
      },
    });
  }

  const ownsOperationRoot = !options.operationRoot;
  const operationRoot = options.operationRoot || await createTempOperationRoot();
  const scratchQuota = options.scratchQuota || await createOperationScratchQuota({ operationRoot });
  let projection = null;
  let source = null;
  try {
    if (selection.authority === 'legacy-resident-sidecars') {
      projection = await projectLegacyResidentSidecars({
        canonicalRoot,
        operationRoot,
        scratchQuota,
        signal: options.signal,
      });
    } else if (selection.authority === 'legacy-research-snapshot') {
      const stateFile = selection.targetFiles.find((file) => file.role === 'legacy-state')?.path;
      projection = await projectLegacyResearchSnapshot({
        canonicalRoot,
        stateFile,
        operationRoot,
        operationId: options.operationId || path.basename(operationRoot),
        requesterAgent: options.requesterAgent || 'cosmo',
        scratchQuota,
        signal: options.signal,
      });
    } else {
      throw memorySourceError('source_unavailable', 'no COSMO memory source available', { retryable: true });
    }

    source = await openMemorySource(projection.projectionRoot, {
      ...options,
      operationRoot,
      scratchQuota,
      pinnedManifest: projection.manifest,
      logicalCanonicalRoot: canonicalRoot,
      ...(selection.authority === 'legacy-resident-sidecars'
        ? { legacySourceFingerprint: projection.sourceFingerprint }
        : {}),
      identity: {
        ...(options.identity || {}),
        canonicalRoot,
        mutationBoundaries,
      },
    });
    const closeSource = source.close?.bind(source);
    return Object.assign(source, {
      descriptor: projection.descriptor || source.descriptor,
      projectionRoot: projection.projectionRoot,
      getMutationBoundaries() {
        return mutationBoundaries;
      },
      getEvidence(extra = {}) {
        return Object.freeze({
          ...(source.getEvidence ? source.getEvidence(extra) : {}),
          ...(projection.evidence || {}),
          identity: {
            ...(source.getEvidence ? source.getEvidence(extra).identity || {} : {}),
            canonicalRoot,
          },
          mutationBoundaries,
        });
      },
      async close() {
        await closeSource?.();
        if (!options.scratchQuota) scratchQuota.close();
        if (ownsOperationRoot) {
          await fsp.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
        }
      },
      async release() {
        await this.close();
      },
    });
  } catch (error) {
    await source?.close?.().catch(() => {});
    if (!options.scratchQuota) scratchQuota.close();
    if (ownsOperationRoot) {
      await fsp.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  openCosmoMemorySource,
  sortedMutationBoundaries,
};
