'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { createMemoryTools } = require('./mcp-tools.cjs');
const {
  createEvidence,
  memorySourceError,
  throwIfAborted,
} = require('./contracts.cjs');

const gunzip = promisify(zlib.gunzip);
const MAX_STATE_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_STATE_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

function unavailableEvidence() {
  return createEvidence({
    sourceHealth: 'unavailable',
    matchOutcome: 'unknown',
    authoritativeTotals: { nodes: null, edges: null },
  });
}

function unavailableError() {
  return {
    code: 'mcp_source_context_required',
    message: 'trusted MCP source context required',
    status: null,
    retryable: false,
  };
}

function assertServerDerivedIdentity(identity) {
  if (identity !== undefined) {
    throw memorySourceError('invalid_request', 'MCP source identity is server-derived', {
      status: 400,
    });
  }
}

function createUnavailableMemoryTools() {
  return Object.freeze({
    async checkReadiness({ signal, identity } = {}) {
      throwIfAborted(signal);
      assertServerDerivedIdentity(identity);
      return {
        ok: false,
        sourceHealth: 'unavailable',
        revision: null,
        totals: { nodes: null, edges: null },
        evidence: unavailableEvidence(),
        error: unavailableError(),
      };
    },
    async queryMemory({ query, signal, identity } = {}) {
      throwIfAborted(signal);
      assertServerDerivedIdentity(identity);
      return {
        ok: false,
        query,
        resultsFound: null,
        totalNodes: null,
        results: null,
        evidence: unavailableEvidence(),
        error: unavailableError(),
      };
    },
    async getMemoryStatistics({ signal, identity } = {}) {
      throwIfAborted(signal);
      assertServerDerivedIdentity(identity);
      return {
        ok: false,
        totalNodes: null,
        totalEdges: null,
        clusters: null,
        nodesByTag: null,
        clusterTotals: null,
        breakdownsOmitted: true,
        averageActivation: null,
        averageWeight: null,
        mostAccessedNodes: null,
        highestActivationNodes: null,
        evidence: unavailableEvidence(),
        error: unavailableError(),
      };
    },
    async getMemoryGraph({ signal, identity } = {}) {
      throwIfAborted(signal);
      assertServerDerivedIdentity(identity);
      return {
        success: false,
        nodes: null,
        edges: null,
        clusters: null,
        meta: {
          revision: null,
          authoritativeNodeCount: null,
          authoritativeEdgeCount: null,
          returnedNodeCount: null,
          returnedEdgeCount: null,
          clusterCount: null,
          limited: null,
        },
        evidence: unavailableEvidence(),
        error: unavailableError(),
      };
    },
  });
}

function assertBrainSourceContext(context, logsDir) {
  if (!context || typeof context !== 'object'
      || !path.isAbsolute(context.home23Root || '')
      || !path.isAbsolute(context.brainDir || '')
      || !/^[A-Za-z0-9_.-]+$/.test(context.requesterAgent || '')
      || typeof context.resolveTargetContext !== 'function'
      || path.resolve(context.brainDir) !== path.resolve(logsDir)) {
    throw Object.assign(new Error('trusted MCP source context required'), {
      code: 'mcp_source_context_required',
    });
  }
  return Object.freeze({
    home23Root: context.home23Root,
    requesterAgent: context.requesterAgent,
    brainDir: context.brainDir,
    resolveTargetContext: context.resolveTargetContext,
  });
}

async function readBoundedGzipJson(file, { signal } = {}) {
  throwIfAborted(signal);
  const handle = await fsp.open(file, 'r');
  let compressed;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_COMPRESSED_BYTES) {
      throw Object.assign(new Error('compressed system state exceeds bounded MCP read'), {
        code: 'state_too_large',
        status: 413,
      });
    }
    const allocated = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < allocated.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        allocated,
        offset,
        Math.min(64 * 1024, allocated.length - offset),
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(probe, 0, 1, offset);
    if (trailingBytes) {
      throw Object.assign(new Error('compressed system state changed during bounded MCP read'), {
        code: 'state_changed',
        status: 409,
      });
    }
    compressed = allocated.subarray(0, offset);
  } finally {
    await handle.close();
  }
  throwIfAborted(signal);
  const decompressed = await gunzip(compressed, {
    maxOutputLength: MAX_STATE_DECOMPRESSED_BYTES,
  });
  throwIfAborted(signal);
  return JSON.parse(decompressed.toString('utf8'));
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function projectScalarSystemState(state) {
  if (!state || typeof state !== 'object') {
    return {
      stateAvailable: false,
      cycle: null,
      cognitiveState: null,
      mode: null,
      goals: { active: null, completed: null, archived: null },
      journal: { totalEntries: null },
      agents: null,
    };
  }
  return {
    stateAvailable: true,
    cycle: Number.isFinite(Number(state.cycleCount)) ? Number(state.cycleCount) : 0,
    cognitiveState: state.cognitiveState || {},
    mode: state.currentMode || 'focus',
    goals: {
      active: countArray(state.goals?.active),
      completed: countArray(state.goals?.completed),
      archived: countArray(state.goals?.archived),
    },
    journal: { totalEntries: countArray(state.journal) },
    agents: Array.isArray(state.activeAgents) ? state.activeAgents : [],
  };
}

function withGraphCompatibility(result) {
  if (!result?.success) {
    return {
      ...result,
      stats: {
        totalNodes: null,
        returnedNodes: null,
        totalEdges: null,
        returnedEdges: null,
        totalClusters: null,
      },
    };
  }
  return {
    ...result,
    stats: {
      totalNodes: result.meta?.authoritativeNodeCount ?? null,
      returnedNodes: result.meta?.returnedNodeCount ?? result.nodes?.length ?? null,
      totalEdges: result.meta?.authoritativeEdgeCount ?? null,
      returnedEdges: result.meta?.returnedEdgeCount ?? result.edges?.length ?? null,
      totalClusters: result.meta?.clusterCount ?? null,
    },
  };
}

function normalizeQueryResult(result, query) {
  if (result?.ok !== false) return result;
  return {
    query,
    resultsFound: null,
    totalNodes: null,
    results: null,
    ...result,
  };
}

function normalizeStatisticsResult(result) {
  if (result?.ok !== false) {
    if (result?.breakdownsOmitted === true) {
      return {
        ...result,
        averageActivation: null,
        averageWeight: null,
      };
    }
    return result;
  }
  return {
    totalNodes: null,
    totalEdges: null,
    clusters: null,
    nodesByTag: null,
    clusterTotals: null,
    breakdownsOmitted: true,
    averageActivation: null,
    averageWeight: null,
    mostAccessedNodes: null,
    highestActivationNodes: null,
    ...result,
  };
}

function normalizeGraphResult(result) {
  if (result?.success === true) return result;
  return {
    success: false,
    nodes: null,
    edges: null,
    clusters: null,
    meta: {
      revision: null,
      authoritativeNodeCount: null,
      authoritativeEdgeCount: null,
      returnedNodeCount: null,
      returnedEdgeCount: null,
      clusterCount: null,
      limited: null,
    },
    ...result,
  };
}

function createMcpBridgeMemoryAdapter({
  logsDir,
  logger = console,
  brainSourceContext = null,
  memoryTools = null,
  readScalarState,
} = {}) {
  if (!path.isAbsolute(logsDir || '') || typeof readScalarState !== 'function') {
    throw Object.assign(new Error('bounded MCP bridge context required'), {
      code: 'mcp_source_context_required',
    });
  }
  const trustedContext = brainSourceContext
    ? assertBrainSourceContext(brainSourceContext, logsDir)
    : null;
  const tools = memoryTools || (trustedContext
    ? createMemoryTools({
      ...trustedContext,
      readScalarState,
      logger,
    })
    : createUnavailableMemoryTools());

  return Object.freeze({
    trustedContext,
    tools,
    async getSystemState({ signal, identity } = {}) {
      assertServerDerivedIdentity(identity);
      throwIfAborted(signal);
      const [scalar, memoryResult] = await Promise.all([
        readScalarState({ signal }),
        tools.getMemoryStatistics({ signal }),
      ]);
      throwIfAborted(signal);
      return { ...scalar, memory: normalizeStatisticsResult(memoryResult) };
    },
    async queryMemory({ query, limit = 10, tag = null, signal, identity } = {}) {
      assertServerDerivedIdentity(identity);
      return normalizeQueryResult(
        await tools.queryMemory({ query, limit, tag, signal }),
        query,
      );
    },
    async getMemoryStatistics({ signal, identity } = {}) {
      assertServerDerivedIdentity(identity);
      return normalizeStatisticsResult(await tools.getMemoryStatistics({ signal }));
    },
    async getMemoryGraph({
      nodeLimit = 200,
      edgeLimit,
      clusterId = null,
      full = false,
      signal,
      identity,
    } = {}) {
      assertServerDerivedIdentity(identity);
      if (full === true || full === 'true' || full === '1') {
        throw memorySourceError('result_too_large', 'full graph reads are not supported', {
          status: 413,
        });
      }
      const numericNodeLimit = Number(nodeLimit);
      const effectiveEdgeLimit = edgeLimit === undefined
        && Number.isSafeInteger(numericNodeLimit) && numericNodeLimit > 0
        ? Math.min(numericNodeLimit * 4, 8000)
        : edgeLimit;
      const result = await tools.getMemoryGraph({
        nodeLimit,
        edgeLimit: effectiveEdgeLimit,
        clusterId,
        signal,
      });
      return withGraphCompatibility(normalizeGraphResult(result));
    },
  });
}

module.exports = {
  MAX_STATE_COMPRESSED_BYTES,
  MAX_STATE_DECOMPRESSED_BYTES,
  assertBrainSourceContext,
  createMcpBridgeMemoryAdapter,
  projectScalarSystemState,
  readBoundedGzipJson,
};
