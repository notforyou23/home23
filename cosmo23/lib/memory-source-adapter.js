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
  resolveMemorySourceReadLimits,
  resolveMemorySourceSelection,
  throwIfAborted,
} = require('../../shared/memory-source');

function sortedMutationBoundaries(canonicalRoot) {
  return enumerateMemoryMutationBoundaries(canonicalRoot)
    .map((entry) => ({ kind: entry.kind, path: entry.path }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
}

async function createTempOperationRoot() {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-cosmo-memory-source-'));
  return fsp.realpath(created);
}

function sameIdentity(stat, identity) {
  return Boolean(stat && identity && stat.dev === identity.dev && stat.ino === identity.ino);
}

async function removeOwnedOperationRoot(operationRoot, identity) {
  if (typeof operationRoot !== 'string' || !identity) return;
  const stat = await fsp.lstat(operationRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()
      || !sameIdentity(stat, identity)
      || await fsp.realpath(operationRoot) !== operationRoot) {
    throw memorySourceError(
      'invalid_memory_source',
      'owned COSMO operation root identity changed',
      { retryable: false },
    );
  }
  await fsp.rm(operationRoot, { recursive: true, force: false });
}

async function openCosmoMemorySource(brainDir, options = {}) {
  throwIfAborted(options.signal);
  const hooks = options._testHooks || {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)
      || Object.values(hooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid COSMO memory source test hooks');
  }
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
  let operationRoot = options.operationRoot || null;
  let operationRootIdentity = null;
  let scratchQuota = options.scratchQuota || null;
  let projection = null;
  let source = null;
  try {
    if (ownsOperationRoot) {
      operationRoot = await createTempOperationRoot();
      const stat = await fsp.lstat(operationRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()
          || await fsp.realpath(operationRoot) !== operationRoot) {
        throw memorySourceError(
          'invalid_memory_source',
          'owned COSMO operation root is unsafe',
          { retryable: false },
        );
      }
      operationRootIdentity = { dev: stat.dev, ino: stat.ino };
    }
    if (!scratchQuota) {
      scratchQuota = await createOperationScratchQuota({
        operationRoot,
        signal: options.signal,
      });
    }
    const projectionReadLimits = resolveMemorySourceReadLimits({
      quotaMaxBytes: scratchQuota.maxBytes,
    });
    if (selection.authority === 'legacy-resident-sidecars') {
      projection = await projectLegacyResidentSidecars({
        canonicalRoot,
        operationRoot,
        scratchQuota,
        signal: options.signal,
        maxInputBytes: options.maxInputBytes,
        maxDecompressedBytes: options.maxDecompressedBytes,
        maxOverlayMemoryBytes: options.maxOverlayMemoryBytes,
        maxOverlayDiskBytes: options.maxOverlayDiskBytes,
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
        maxInputBytes: options.maxInputBytes,
        maxDecompressedBytes: options.maxDecompressedBytes,
      });
    } else {
      throw memorySourceError('source_unavailable', 'no COSMO memory source available', { retryable: true });
    }

    source = await openMemorySource(projection.projectionRoot, {
      ...options,
      ...projectionReadLimits,
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
    let closePromise = null;
    const closeOwnedSource = () => {
      closePromise ||= (async () => {
        let firstError = null;
        try {
          await closeSource?.();
          await hooks.afterSourceClose?.({ operationRoot });
        } catch (error) {
          firstError = error;
        }
        if (!options.scratchQuota) scratchQuota?.close();
        if (ownsOperationRoot) {
          try {
            await removeOwnedOperationRoot(operationRoot, operationRootIdentity);
          } catch (error) {
            firstError ||= error;
          }
        }
        if (firstError) throw firstError;
      })();
      return closePromise;
    };
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
        await closeOwnedSource();
      },
      async release() {
        await this.close();
      },
    });
  } catch (error) {
    await source?.close?.().catch(() => {});
    if (!options.scratchQuota) scratchQuota?.close();
    if (ownsOperationRoot) {
      await removeOwnedOperationRoot(operationRoot, operationRootIdentity).catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  openCosmoMemorySource,
  sortedMutationBoundaries,
};
