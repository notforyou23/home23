'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { createMemoryTools } = require('./mcp-tools.cjs');

const MAX_SCALAR_SNAPSHOT_BYTES = 1024 * 1024;

async function readBoundedJson(file, maxBytes = MAX_SCALAR_SNAPSHOT_BYTES) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > maxBytes) {
    throw Object.assign(new Error('scalar snapshot exceeds bounded read budget'), {
      code: 'scalar_snapshot_unavailable',
    });
  }
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function unsupportedSnapshotCapability(capability) {
  return Object.freeze({
    status: 'unsupported',
    error: Object.freeze({
      code: 'snapshot_capability_unsupported',
      message: `${capability} is not projected by brain-snapshot`,
      retryable: false,
    }),
  });
}

function snapshotCapabilities(snapshot) {
  const availableGoals = [];
  if (Array.isArray(snapshot?.activeGoalSummaries)) availableGoals.push('activeSummaries');
  if (snapshot?.goalCounts && typeof snapshot.goalCounts === 'object') {
    availableGoals.push('counts');
  }
  return Object.freeze({
    goals: availableGoals.length > 0 ? Object.freeze({
      status: 'degraded',
      available: Object.freeze(availableGoals),
      unavailable: Object.freeze(['completedEntries', 'archivedEntries']),
      error: Object.freeze({
        code: 'snapshot_capability_degraded',
        message: 'brain-snapshot projects bounded active goal summaries and counts only',
        retryable: false,
      }),
    }) : unsupportedSnapshotCapability('goals'),
    agentActivity: unsupportedSnapshotCapability('agent activity'),
    journal: unsupportedSnapshotCapability('journal'),
    dreams: unsupportedSnapshotCapability('dreams'),
    oscillator: unsupportedSnapshotCapability('oscillator'),
  });
}

function createSnapshotScalarStateReader({ brainDir } = {}) {
  if (typeof brainDir !== 'string' || !path.isAbsolute(brainDir)) {
    throw Object.assign(new Error('absolute brainDir required'), {
      code: 'mcp_source_context_required',
    });
  }
  return async function readScalarState() {
    const snapshot = await readBoundedJson(path.join(brainDir, 'brain-snapshot.json'));
    if (!snapshot) {
      return {
        cycleCount: null,
        currentMode: null,
        cognitiveState: null,
        goals: {
          active: null, completed: null, archived: null,
          counts: { active: null, completed: null, archived: null },
        },
        scalarProjection: {
          source: 'brain-snapshot',
          sourceHealth: 'unavailable',
          updatedAt: null,
          capabilities: snapshotCapabilities(null),
        },
      };
    }
    const activeGoalSummaries = Array.isArray(snapshot.activeGoalSummaries)
      ? snapshot.activeGoalSummaries.slice(0, 100)
      : null;
    const counts = snapshot.goalCounts && typeof snapshot.goalCounts === 'object'
      ? snapshot.goalCounts
      : {};
    return {
      cycleCount: Number.isSafeInteger(snapshot.cycle) ? snapshot.cycle : null,
      currentMode: null,
      cognitiveState: null,
      goals: {
        active: activeGoalSummaries?.map((goal) => [goal.id, goal]) ?? null,
        completed: null,
        archived: null,
        counts: {
          active: optionalCount(counts.active),
          completed: optionalCount(counts.completed),
          archived: optionalCount(counts.archived),
        },
      },
      scalarProjection: {
        source: 'brain-snapshot',
        sourceHealth: 'degraded',
        updatedAt: snapshot.savedAt || null,
        activeGoalsReturned: activeGoalSummaries?.length ?? null,
        capabilities: snapshotCapabilities(snapshot),
      },
    };
  };
}

function createDefaultMcpMemoryTools({
  brainDir = process.env.COSMO_RUNTIME_DIR || process.env.COSMO_RUNTIME_PATH,
  home23Root = process.env.HOME23_ROOT,
  requesterAgent = process.env.HOME23_AGENT,
  logger = console,
  resolveTargetContext = null,
  searchMemory = null,
  nodeOverlayProvider = null,
} = {}) {
  if (typeof brainDir !== 'string' || !path.isAbsolute(brainDir)
      || typeof home23Root !== 'string' || !path.isAbsolute(home23Root)
      || typeof requesterAgent !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(requesterAgent)) {
    throw Object.assign(new Error('trusted MCP source environment required'), {
      code: 'mcp_source_context_required',
    });
  }
  const readScalarState = createSnapshotScalarStateReader({ brainDir });
  const resolveLocalTarget = resolveTargetContext || (async () => {
    const canonicalRoot = await fsp.realpath(brainDir);
    return Object.freeze({
      catalogRevision: 'local-self',
      accessMode: 'own',
      target: Object.freeze({
        id: `resident-${requesterAgent}`,
        brainId: `resident-${requesterAgent}`,
        ownerAgent: requesterAgent,
        requesterAgent,
        canonicalRoot,
        kind: 'resident',
        sourceType: 'resident-brain',
      }),
    });
  });
  return createMemoryTools({
    brainDir,
    home23Root,
    requesterAgent,
    readScalarState,
    logger,
    resolveTargetContext: resolveLocalTarget,
    searchMemory,
    nodeOverlayProvider,
  });
}

function publicReadinessError(error) {
  return {
    code: error?.code || 'source_unavailable',
    message: error?.message || 'canonical source unavailable',
    retryable: error?.retryable !== false,
  };
}

function createMcpReadinessController({
  memoryTools,
  retryMs = 30_000,
  now = Date.now,
  refreshIntervalMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = console,
} = {}) {
  if (!memoryTools || typeof memoryTools.checkReadiness !== 'function') {
    throw Object.assign(new Error('memory readiness tool required'), {
      code: 'mcp_source_context_required',
    });
  }
  const proactiveRefreshMs = refreshIntervalMs === undefined
    ? Math.max(1, Math.floor(retryMs / 2))
    : refreshIntervalMs;
  if (!Number.isSafeInteger(retryMs) || retryMs < 1
      || !Number.isSafeInteger(proactiveRefreshMs) || proactiveRefreshMs < 1
      || proactiveRefreshMs > retryMs
      || typeof now !== 'function' || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') {
    throw Object.assign(new Error('memory readiness timing is invalid'), {
      code: 'mcp_source_context_required',
    });
  }
  const abortController = new AbortController();
  let lastHealthyAt = null;
  let inFlight = null;
  let refreshTimer = null;
  let closed = false;
  let current = Object.freeze({
    ok: false,
    protocolVersion: '2025-03-26',
    sourceHealth: 'starting',
  });
  const refreshPendingStatus = () => Object.freeze({
    ok: false,
    protocolVersion: '2025-03-26',
    sourceHealth: 'unavailable',
    error: Object.freeze({
      code: 'source_refresh_pending',
      message: 'canonical source readiness refresh is pending',
      retryable: true,
    }),
  });
  const clearScheduledRefresh = () => {
    if (refreshTimer === null) return;
    clearTimeoutImpl(refreshTimer);
    refreshTimer = null;
  };
  const scheduleRefresh = (delayMs = proactiveRefreshMs) => {
    clearScheduledRefresh();
    if (closed) return;
    refreshTimer = setTimeoutImpl(() => {
      refreshTimer = null;
      void refresh();
    }, delayMs);
    refreshTimer?.unref?.();
  };
  const transientSourceCodes = new Set(['source_busy', 'source_refresh_pending']);
  const retainHealthyProofFor = (error, observedAt) => {
    if (current.ok !== true || lastHealthyAt === null
        || !transientSourceCodes.has(error?.code) || error?.retryable !== true) return null;
    const remainingMs = retryMs - (observedAt - lastHealthyAt);
    if (remainingMs <= 0) return null;
    return Math.max(1, Math.min(proactiveRefreshMs, Math.floor(remainingMs / 2)));
  };

  const refresh = () => {
    if (closed || inFlight) return inFlight;
    clearScheduledRefresh();
    if (current.ok === true && lastHealthyAt !== null
        && now() - lastHealthyAt >= retryMs) {
      current = refreshPendingStatus();
    }
    let nextRefreshMs = proactiveRefreshMs;
    inFlight = Promise.resolve()
      .then(() => memoryTools.checkReadiness({ signal: abortController.signal }))
      .then((result) => {
        if (closed) return;
        const observedAt = now();
        const healthy = result?.ok === true && result?.sourceHealth !== 'unavailable';
        if (healthy) {
          lastHealthyAt = observedAt;
          current = Object.freeze({
            ok: true,
            protocolVersion: '2025-03-26',
            sourceHealth: result.sourceHealth || 'healthy',
            ...(result.revision !== undefined ? { revision: result.revision } : {}),
            ...(result.totals !== undefined ? { totals: result.totals } : {}),
          });
          return;
        }
        const retainedRetryMs = retainHealthyProofFor(result?.error, observedAt);
        if (retainedRetryMs !== null) {
          nextRefreshMs = retainedRetryMs;
          return;
        }
        current = Object.freeze({
          ok: false,
          protocolVersion: '2025-03-26',
          sourceHealth: 'unavailable',
          error: publicReadinessError(result?.error),
        });
      })
      .catch((error) => {
        if (closed) return;
        const retainedRetryMs = retainHealthyProofFor(error, now());
        if (retainedRetryMs !== null) {
          nextRefreshMs = retainedRetryMs;
          return;
        }
        logger.warn?.('[MCP] canonical source readiness failed', { error: error.message });
        current = Object.freeze({
          ok: false,
          protocolVersion: '2025-03-26',
          sourceHealth: 'unavailable',
          error: publicReadinessError(error),
        });
      })
      .finally(() => {
        if (!closed) {
          scheduleRefresh(nextRefreshMs);
        }
        inFlight = null;
      });
    return inFlight;
  };

  refresh();
  return Object.freeze({
    status() {
      if (!closed && lastHealthyAt !== null && now() - lastHealthyAt >= retryMs) {
        if (current.ok === true) current = refreshPendingStatus();
        if (!inFlight) refresh();
      }
      return current;
    },
    refresh,
    close() {
      if (closed) return;
      closed = true;
      clearScheduledRefresh();
      abortController.abort(Object.assign(new Error('MCP server closed'), {
        name: 'AbortError',
        code: 'cancelled',
      }));
    },
  });
}

module.exports = {
  MAX_SCALAR_SNAPSHOT_BYTES,
  createDefaultMcpMemoryTools,
  createMcpReadinessController,
  createSnapshotScalarStateReader,
  readBoundedJson,
};
