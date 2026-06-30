const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { buildStatusContract } = require('./status-contract');
const { summarizeRunArtifacts } = require('./run-artifact-inventory');

function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

function shouldReuseInteractiveSession(session, targetRunPath) {
  if (!session?.active || !targetRunPath) return false;
  const sessionPath = session.runtimePath || session.orchestrator?.runtimePath || session.orchestrator?.config?.logsDir;
  return sameResolvedPath(sessionPath, targetRunPath);
}

function isInteractiveSessionRequestValid(session, sessionId) {
  if (!session?.active) return false;
  if (!sessionId) return true;
  return String(sessionId) === String(session.sessionId);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readStateIfExists(runPath) {
  const candidates = [
    path.join(runPath, 'state.json.gz'),
    path.join(runPath, 'coordinator', 'state.json.gz'),
    path.join(runPath, 'state.json'),
    path.join(runPath, 'coordinator', 'state.json')
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      if (candidate.endsWith('.gz')) {
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(candidate)).toString('utf8'));
      }
      return readJsonIfExists(candidate);
    } catch {
      // try next candidate
    }
  }

  return null;
}

function collectionSize(value) {
  if (!value) return null;
  if (typeof value.size === 'number') return value.size;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return null;
}

function readStateSummary(runPath) {
  const state = runPath ? readStateIfExists(runPath) : null;
  if (!state) return {};

  return {
    cycle: Number.isFinite(Number(state.cycleCount)) ? Number(state.cycleCount) : null,
    memoryNodes: collectionSize(state.memory?.nodes),
    memoryEdges: collectionSize(state.memory?.edges),
    energy: typeof state.stateModulator?.cognitiveState?.energy === 'number'
      ? state.stateModulator.cognitiveState.energy
      : undefined,
    sleeping: Boolean(state.sleepSession?.active)
  };
}

function readLatestCycleFromMetrics(runPath) {
  const metrics = runPath ? readJsonIfExists(path.join(runPath, 'metrics.json')) : null;
  const cycleMetric = metrics?.metrics?.['cycle.time'];
  const candidates = [
    cycleMetric?.tags?.cycle,
    cycleMetric?.count,
    ...(Array.isArray(cycleMetric?.values)
      ? cycleMetric.values.map(item => item?.tags?.cycle)
      : [])
  ]
    .map(value => Number(value))
    .filter(value => Number.isFinite(value));

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function readMetadataSummary(runPath) {
  const metadata = runPath ? readJsonIfExists(path.join(runPath, 'metadata.json')) : null;
  const runMetadata = runPath ? readJsonIfExists(path.join(runPath, 'run-metadata.json')) : null;
  return {
    runName: metadata?.runName || runMetadata?.runName || (runPath ? path.basename(runPath) : null),
    domain: runMetadata?.researchDomain || metadata?.topic || null,
    topic: runMetadata?.researchContext || metadata?.context || metadata?.topic || null
  };
}

function roundMaybe(value) {
  return typeof value === 'number' ? Number(value.toFixed(3)) : value;
}

function buildInteractiveLiveStatus({
  runPath,
  activeContext = null,
  processStatus = { running: [], count: 0 },
  isLaunching = false,
  ports = {},
  now = new Date()
} = {}) {
  const attachedToActiveRun = sameResolvedPath(runPath, activeContext?.runPath);
  const statusContext = attachedToActiveRun ? activeContext : null;
  const health = buildStatusContract({
    activeContext: statusContext,
    processStatus,
    isLaunching: Boolean(isLaunching && attachedToActiveRun),
    ports,
    now
  });
  const state = readStateSummary(runPath);
  const metadata = readMetadataSummary(runPath);
  const metricsCycle = readLatestCycleFromMetrics(runPath);
  const artifactInventory = summarizeRunArtifacts(runPath);
  const cycle = Number.isFinite(metricsCycle)
    ? metricsCycle
    : (Number.isFinite(state.cycle) ? state.cycle : 0);

  return {
    source: 'live_status',
    generatedAt: health.generatedAt,
    running: health.activeRun,
    activeRun: health.activeRun,
    lifecycle: health.lifecycle,
    processOnline: health.processOnline,
    hasActiveContext: health.hasActiveContext,
    runName: statusContext?.runName || metadata.runName || null,
    runPath: runPath || statusContext?.runPath || null,
    domain: statusContext?.topic || metadata.domain || 'general',
    topic: statusContext?.topic || metadata.topic || '',
    cycle,
    memoryNodes: Number.isFinite(Number(state.memoryNodes)) ? Number(state.memoryNodes) : 0,
    memoryEdges: Number.isFinite(Number(state.memoryEdges)) ? Number(state.memoryEdges) : 0,
    activeAgents: null,
    energy: roundMaybe(state.energy),
    coherence: null,
    sleeping: Boolean(state.sleeping),
    artifactInventory,
    artifactStatus: artifactInventory.answerSubstrate
  };
}

module.exports = {
  buildInteractiveLiveStatus,
  isInteractiveSessionRequestValid,
  shouldReuseInteractiveSession
};
