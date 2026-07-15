'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const {
  createEvidence,
  enrichEvidenceIdentity,
  memorySourceError,
  parseBoundedInteger,
  rethrowAbort,
  summarizeRetrievalAuthority,
  throwIfAborted,
} = require('./contracts.cjs');
const { sampleMemoryGraph } = require('./graph.cjs');
const { withEphemeralMemorySource } = require('./operation-context.cjs');

function assertTrustedContext({ brainDir, home23Root, requesterAgent, resolveTargetContext }) {
  if (!path.isAbsolute(home23Root || '') || !path.isAbsolute(brainDir || '')
      || !/^[A-Za-z0-9_.-]+$/.test(requesterAgent || '')
      || typeof resolveTargetContext !== 'function') {
    throw Object.assign(new Error('trusted MCP source context required'), {
      code: 'mcp_source_context_required',
    });
  }
}

function unavailableResult(error, evidence) {
  return {
    ok: false,
    totalNodes: null,
    evidence: evidence || createEvidence({
      sourceHealth: 'unavailable',
      matchOutcome: 'unknown',
    }),
    error: {
      code: error?.code || 'source_unavailable',
      message: error?.message || 'source unavailable',
      status: error?.status || null,
      retryable: error?.retryable === true,
    },
  };
}

function toFixedNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function enrichIdentity(identity, resolved, canonicalRoot, requesterAgent) {
  const target = resolved.target || {};
  return Object.freeze({
    requesterAgent,
    targetAgent: target.ownerAgent || target.targetAgent || null,
    brainId: target.id || target.brainId || requesterAgent,
    canonicalRoot,
    catalogRevision: resolved.catalogRevision || 'local',
    kind: target.kind || 'resident',
    sourceType: target.sourceType || 'memory-manifest',
    accessMode: resolved.accessMode || 'own',
    ...(identity || {}),
  });
}

function createMemoryTools({
  brainDir,
  home23Root,
  requesterAgent,
  readScalarState = async () => ({}),
  resolveTargetContext,
  logger = console,
  withEphemeralSource = withEphemeralMemorySource,
} = {}) {
  assertTrustedContext({ brainDir, home23Root, requesterAgent, resolveTargetContext });

  async function withSource(fn, { signal, identity } = {}) {
    throwIfAborted(signal);
    if (identity !== undefined) {
      throw memorySourceError('invalid_request', 'MCP source identity is server-derived');
    }
    let sourceEvidence = null;
    try {
      const canonicalBrainDir = await fsp.realpath(brainDir);
      const resolved = await resolveTargetContext({});
      const targetRoot = await fsp.realpath(resolved?.target?.canonicalRoot || '');
      if (targetRoot !== canonicalBrainDir) {
        throw memorySourceError('source_changed', 'MCP catalog target/source mismatch', {
          retryable: true,
        });
      }
      const baseIdentity = enrichIdentity(null, resolved, canonicalBrainDir, requesterAgent);
      return await withEphemeralSource({
        brainDir: canonicalBrainDir,
        home23Root,
        requesterAgent,
        identity: baseIdentity,
        signal,
        prefix: 'mcp',
      }, async (source, operation) => {
        const withIdentity = (evidence) => enrichEvidenceIdentity(evidence, operation.identity);
        sourceEvidence = withIdentity(source.getEvidence?.() || null);
        if (sourceEvidence?.sourceHealth === 'unavailable') {
          return unavailableResult(
            memorySourceError('source_unavailable', 'authoritative source unavailable', {
              retryable: true,
            }),
            withIdentity(source.getEvidence({ matchOutcome: 'unknown' })),
          );
        }
        try {
          const result = await fn(source);
          return result && typeof result === 'object' && result.evidence
            ? { ...result, evidence: withIdentity(result.evidence) }
            : result;
        } catch (error) {
          error.sourceEvidence = withIdentity(
            source.getEvidence?.({ matchOutcome: 'unknown' }) || sourceEvidence,
          );
          throw error;
        }
      });
    } catch (error) {
      rethrowAbort(error, signal);
      logger.warn?.('[MCP memory] source read failed', { error: error.message });
      return unavailableResult(error, error.sourceEvidence || sourceEvidence);
    }
  }

  return Object.freeze({
    async checkReadiness({ signal, identity } = {}) {
      return withSource(async (source) => {
        const summary = await source.summarize({ signal });
        return {
          ok: true,
          sourceHealth: source.getEvidence().sourceHealth,
          revision: source.revision,
          totals: { nodes: summary.nodes, edges: summary.edges },
          evidence: source.getEvidence({
            completeCoverage: true,
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          }),
        };
      }, { signal, identity });
    },

    async queryMemory({ query, limit = 10, tag = null, signal, identity } = {}) {
      const topK = parseBoundedInteger(limit, {
        name: 'limit',
        defaultValue: 10,
        min: 1,
        max: 100,
      });
      return withSource(async (source) => {
        const summary = await source.summarize({ signal });
        const match = await source.searchKeyword({ query, topK, tag, signal });
        const authoritySummary = summarizeRetrievalAuthority(
          match.results.map(result => result.retrievalAuthority || {}),
        );
        return {
          ok: true,
          query,
          resultsFound: match.results.length,
          totalNodes: summary.nodes,
          results: match.results,
          evidence: {
            ...(match.evidence || source.getEvidence()),
            completeCoverage: match.evidence?.completeCoverage
              ?? (match.results.length < topK),
            filters: { tag },
            limits: { topK },
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
            returnedTotals: { nodes: match.results.length, edges: 0 },
            filteredTotal: match.filtered || 0,
            authoritySummary: match.evidence?.authoritySummary || authoritySummary,
          },
        };
      }, { signal, identity });
    },

    async getMemoryStatistics({ signal, identity } = {}) {
      return withSource(async (source) => {
        const summary = await source.summarize({ signal });
        const breakdowns = await source.summarizeBreakdowns({
          signal,
          maxKeys: 10000,
          maxBytes: 1024 * 1024,
        });
        return {
          ok: true,
          totalNodes: summary.nodes,
          totalEdges: summary.edges,
          clusters: summary.clusters,
          nodesByTag: breakdowns.tags,
          clusterTotals: breakdowns.clusterTotals,
          breakdownsOmitted: breakdowns.omitted === true,
          averageActivation: toFixedNumber(breakdowns.averageActivation),
          averageWeight: toFixedNumber(breakdowns.averageWeight),
          mostAccessedNodes: breakdowns.mostAccessedNodes || [],
          highestActivationNodes: breakdowns.highestActivationNodes || [],
          evidence: source.getEvidence({
            completeCoverage: true,
            authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
          }),
        };
      }, { signal, identity });
    },

    async getMemoryGraph({ nodeLimit = 200, edgeLimit = 800, clusterId = null, signal, identity } = {}) {
      const boundedNodeLimit = parseBoundedInteger(nodeLimit, {
        name: 'nodeLimit',
        defaultValue: 200,
        min: 1,
        max: 2000,
      });
      const boundedEdgeLimit = parseBoundedInteger(edgeLimit, {
        name: 'edgeLimit',
        defaultValue: 800,
        min: 0,
        max: 8000,
      });
      return withSource((source) => sampleMemoryGraph(source, {
        nodeLimit: boundedNodeLimit,
        edgeLimit: boundedEdgeLimit,
        clusterId,
        signal,
      }), { signal, identity });
    },

    async getSystemState({ signal, identity } = {}) {
      const scalar = await readScalarState();
      return {
        ...scalar,
        memory: await this.getMemoryStatistics({ signal, identity }),
      };
    },
  });
}

module.exports = {
  createMemoryTools,
};
