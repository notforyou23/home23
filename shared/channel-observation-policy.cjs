'use strict';

const DEFAULT_LIVE_PROBLEMS_HEARTBEAT_MS = 30 * 60 * 1000;
const DEFAULT_LIVE_PROBLEMS_MAX_ENTRIES = 10_000;

function normalizeLiveProblemPolicy(policy = {}) {
  const heartbeat = policy.liveProblemsHeartbeatMs;
  const maxEntries = Number(policy.liveProblemsMaxEntries);
  return {
    heartbeatMs: heartbeat === false || heartbeat === 0
      ? 0
      : Number.isFinite(Number(heartbeat)) && Number(heartbeat) > 0
        ? Number(heartbeat)
        : DEFAULT_LIVE_PROBLEMS_HEARTBEAT_MS,
    maxEntries: Number.isFinite(maxEntries) && maxEntries >= 1
      ? Math.floor(maxEntries)
      : DEFAULT_LIVE_PROBLEMS_MAX_ENTRIES,
  };
}

function shouldWriteLiveProblem(states, state, policy, now = Date.now()) {
  const previous = states.get(state.key);
  if (!previous) return true;
  // A suppressed observation still makes this key recently used. Keep the
  // successful-write timestamp so repeated polls cannot postpone a heartbeat.
  states.delete(state.key);
  states.set(state.key, previous);
  return previous.signature !== state.signature
    || (policy.heartbeatMs > 0 && now - previous.persistedAt >= policy.heartbeatMs);
}

function rememberLiveProblem(states, state, policy, now = Date.now()) {
  states.delete(state.key);
  states.set(state.key, { signature: state.signature, persistedAt: now });
  while (states.size > policy.maxEntries) states.delete(states.keys().next().value);
}

function liveProblemObservedAt(observation) {
  // Producer and writers share this locally generated timestamp so queued
  // writes cannot shift their heartbeat deadlines apart.
  const receivedAt = observation.verifierId === 'live-problems:poll'
    ? Date.parse(observation.receivedAt)
    : NaN;
  return Number.isFinite(receivedAt) ? receivedAt : Date.now();
}

// Verifier timestamps and check evidence change on every poll. The producer's
// lifecycle fields describe the changes worth retaining for a problem.
function liveProblemState(observation = {}) {
  if (observation.channelId !== 'work.live-problems') return null;
  const payload = observation.payload && typeof observation.payload === 'object'
    ? observation.payload
    : {};
  const problemKey = [payload.id, payload.problemKey, payload.key]
    .find(value => value !== undefined && value !== null && String(value));
  const sourceKey = String(observation.sourceRef || '')
    .replace(/:\d{4}-\d{2}-\d{2}T.*$/, '');
  const key = problemKey !== undefined && problemKey !== null && String(problemKey)
    ? String(problemKey)
    : sourceKey;
  if (!key) return null;
  return {
    key,
    signature: JSON.stringify([
      payload.state ?? null,
      payload.stepIndex ?? null,
      Boolean(payload.escalated),
      observation.flag ?? null,
      payload.error ?? null,
    ]),
  };
}

module.exports = {
  liveProblemState,
  normalizeLiveProblemPolicy,
  shouldWriteLiveProblem,
  rememberLiveProblem,
  liveProblemObservedAt,
};
