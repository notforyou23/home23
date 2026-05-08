const GOOD_LIFE_STALE_MS = 10 * 60 * 1000;
const RECENT_RESOLUTION_MS = 30 * 60 * 1000;

function toTimeMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function toNowMs(now = new Date()) {
  if (now instanceof Date) return now.getTime();
  const parsed = Date.parse(now || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function ageMinutes(fromIso, nowMs) {
  const fromMs = toTimeMs(fromIso);
  if (!fromMs) return null;
  return Math.max(0, Math.round((nowMs - fromMs) / 60000));
}

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function buildLiveProblemSnapshot(problems = [], now = new Date()) {
  const nowMs = toNowMs(now);
  const open = [];
  const chronic = [];
  const resolvedJustNow = [];
  let resolved = 0;
  let unverifiable = 0;

  for (const problem of Array.isArray(problems) ? problems : []) {
    if (problem?.state === 'open' || problem?.state === 'chronic') {
      const row = {
        id: problem.id || '',
        claim: problem.claim || '',
        ageMin: ageMinutes(problem.openedAt || problem.firstSeenAt, nowMs) ?? 0,
        detail: problem.lastResult?.detail || null,
        state: problem.state,
        escalated: !!problem.escalated,
        lastCheckedAt: problem.lastCheckedAt || null,
        lastRemediation: Array.isArray(problem.remediationLog)
          ? problem.remediationLog.slice(-1)[0] || null
          : null,
      };
      if (problem.state === 'chronic') chronic.push(row);
      else open.push(row);
    } else if (problem?.state === 'resolved') {
      resolved += 1;
      const resolvedMs = toTimeMs(problem.resolvedAt);
      if (resolvedMs && nowMs - resolvedMs < RECENT_RESOLUTION_MS) {
        resolvedJustNow.push({
          id: problem.id || '',
          claim: problem.claim || '',
          resolvedAt: problem.resolvedAt,
        });
      }
    } else if (problem?.state === 'unverifiable') {
      unverifiable += 1;
    }
  }

  return {
    open,
    chronic,
    resolvedJustNow,
    counts: {
      open: open.length,
      chronic: chronic.length,
      resolved,
      unverifiable,
    },
  };
}

function normalizeLiveProblems(input, now) {
  if (Array.isArray(input)) return buildLiveProblemSnapshot(input, now);
  if (input?.snapshot?.counts) return input.snapshot;
  return buildLiveProblemSnapshot(input?.problems || [], now);
}

function normalizeProjection(state) {
  const source = state?.evidence?.liveProblems || {};
  const open = finiteCount(source.open);
  const chronic = finiteCount(source.chronic);
  const resolved = finiteCount(source.resolved);
  const unverifiable = finiteCount(source.unverifiable);
  const total = finiteCount(source.total);

  return {
    liveProblems: {
      open,
      chronic,
      resolved,
      unverifiable,
      total: total ?? [open, chronic, resolved, unverifiable]
        .filter((count) => count != null)
        .reduce((sum, count) => sum + count, 0),
    },
    goals: state?.evidence?.goals || null,
    agenda: state?.evidence?.agenda || null,
    memory: state?.evidence?.memory || null,
  };
}

function latestRegulatorAction(regulator = {}) {
  return Object.entries(regulator || {})
    .filter(([key, value]) => key !== 'daily' && value && toTimeMs(value.at))
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => toTimeMs(b.at) - toTimeMs(a.at))[0] || null;
}

function buildLanes(state, commitments = {}) {
  const commitmentByLane = new Map();
  for (const item of commitments?.commitments || []) {
    if (item?.lane) commitmentByLane.set(item.lane, item);
  }

  const actionLanes = new Set(state?.policy?.actionCard?.goodLifeLanes || []);
  const laneNames = new Set([
    ...Object.keys(state?.lanes || {}),
    ...commitmentByLane.keys(),
  ]);

  return [...laneNames].map((name) => {
    const lane = state?.lanes?.[name] || {};
    const commitment = commitmentByLane.get(name) || {};
    return {
      name,
      title: commitment.title || name,
      status: lane.status || commitment.status || 'unknown',
      reasons: Array.isArray(lane.reasons)
        ? lane.reasons
        : Array.isArray(commitment.reasons)
          ? commitment.reasons
          : [],
      active: commitment.active === true || actionLanes.has(name),
      lastEvaluatedAt: commitment.lastEvaluatedAt || state?.evaluatedAt || null,
    };
  });
}

function buildFreshness(state, commitments, nowMs) {
  const evaluatedAt = state?.evaluatedAt || commitments?.updatedAt || null;
  const evaluatedMs = toTimeMs(evaluatedAt);
  if (!evaluatedMs) {
    return {
      status: 'unknown',
      evaluatedAt: null,
      ageMin: null,
      ttlMin: Math.round(GOOD_LIFE_STALE_MS / 60000),
    };
  }

  const ageMs = Math.max(0, nowMs - evaluatedMs);
  return {
    status: ageMs > GOOD_LIFE_STALE_MS ? 'stale' : 'current',
    evaluatedAt,
    ageMin: Math.round(ageMs / 60000),
    ttlMin: Math.round(GOOD_LIFE_STALE_MS / 60000),
  };
}

function buildConsistency({ state, projection, liveProblems, freshness }) {
  const warnings = [];
  if (!state) {
    warnings.push({
      code: 'good_life_state_missing',
      severity: 'warning',
      message: 'Good Life state file is not available',
    });
  }

  if (freshness.status === 'stale') {
    warnings.push({
      code: 'good_life_projection_stale',
      severity: 'warning',
      message: `Good Life was last evaluated ${freshness.ageMin}m ago`,
    });
  } else if (freshness.status === 'unknown') {
    warnings.push({
      code: 'good_life_freshness_unknown',
      severity: 'warning',
      message: 'Good Life evaluation freshness is unknown',
    });
  }

  const mismatchKeys = ['open', 'chronic', 'unverifiable'].filter((key) => {
    const projected = projection.liveProblems[key];
    const direct = finiteCount(liveProblems.counts?.[key]);
    return projected != null && direct != null && projected !== direct;
  });

  if (mismatchKeys.length > 0) {
    warnings.push({
      code: 'good_life_projection_mismatch',
      severity: 'warning',
      message: `Good Life live-problem counts disagree with the live registry: ${mismatchKeys.join(', ')}`,
      fields: mismatchKeys,
    });
  }

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

function buildOperatorAnswer({ state, lanes, liveProblems, consistency }) {
  const lines = [];
  if (state?.summary || state?.policy?.reason) {
    lines.push(state.summary || state.policy.reason);
  }

  const counts = liveProblems.counts || {};
  lines.push(`Live-problem registry: ${counts.open || 0} open, ${counts.chronic || 0} chronic`);

  for (const lane of lanes.filter((candidate) => candidate.active)) {
    const reason = lane.reasons?.[0] || lane.status;
    lines.push(`${lane.name}: ${reason}`);
  }

  for (const warning of consistency.warnings || []) {
    lines.push(warning.message);
  }

  return lines;
}

function buildGoodLifeOperatorModel({
  state = null,
  commitments = null,
  trends = null,
  regulator = null,
  liveProblems = [],
  ledgerTail = [],
  now = new Date(),
} = {}) {
  const nowMs = toNowMs(now);
  const policy = {
    mode: state?.policy?.mode || commitments?.policy?.mode || 'unknown',
    reason: state?.policy?.reason || commitments?.policy?.reason || null,
  };
  const actionCard = state?.policy?.actionCard || commitments?.policy?.actionCard || null;
  const directLiveProblems = normalizeLiveProblems(liveProblems, now);
  const projection = normalizeProjection(state);
  const lanes = buildLanes(state, commitments || {});
  const freshness = buildFreshness(state, commitments || {}, nowMs);
  const latestAction = latestRegulatorAction(regulator || {});
  const consistency = buildConsistency({
    state,
    projection,
    liveProblems: directLiveProblems,
    freshness,
  });

  let status = 'current';
  if (!state) status = 'unknown';
  else if (consistency.warnings.some((warning) => warning.code === 'good_life_projection_mismatch')) status = 'conflicted';
  else if (freshness.status === 'stale') status = 'stale';
  else if (freshness.status === 'unknown') status = 'unknown';

  const model = {
    status,
    safeToInherit: status === 'current' && consistency.ok,
    policy,
    summary: state?.summary || policy.reason || '',
    evaluatedAt: state?.evaluatedAt || null,
    freshness,
    lanes,
    actionCard,
    liveProblems: directLiveProblems,
    projection,
    consistency,
    latestRegulatorAction: latestAction,
    trends: trends?.latest || null,
    ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-5) : [],
  };
  model.operatorAnswer = buildOperatorAnswer({
    state,
    lanes,
    liveProblems: directLiveProblems,
    consistency,
  });
  return model;
}

module.exports = {
  buildGoodLifeOperatorModel,
  buildLiveProblemSnapshot,
};
