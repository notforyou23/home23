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
  const resolvedRows = [];
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
      resolvedRows.push({
        id: problem.id || '',
        claim: problem.claim || '',
        resolvedAt: problem.resolvedAt || null,
        ageMin: resolvedMs ? Math.max(0, Math.round((nowMs - resolvedMs) / 60000)) : null,
        fixRecipe: problem.fixRecipe || null,
        lastResult: problem.lastResult || null,
        evidence: problem.evidence || null,
      });
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
    resolved: resolvedRows.sort((a, b) => toTimeMs(b.resolvedAt) - toTimeMs(a.resolvedAt)),
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

function buildGoodLifeObligationSnapshot({ agendaRows = [], goals = null, now = new Date() } = {}) {
  const nowMs = toNowMs(now);
  const agenda = new Map();
  for (const row of Array.isArray(agendaRows) ? agendaRows : []) {
    if (row?.type === 'add' && row.id) {
      const record = row.record || {};
      agenda.set(row.id, {
        id: row.id,
        status: record.status || row.status || 'candidate',
        content: record.content || row.content || '',
        sourceSignal: record.sourceSignal || row.sourceSignal || null,
        topicTags: Array.isArray(record.topicTags) ? record.topicTags : [],
        createdAt: record.createdAt || row.createdAt || row.at || null,
        updatedAt: record.updatedAt || row.updatedAt || row.at || null,
        temporalContext: record.temporalContext || row.temporalContext || null,
      });
    } else if (row?.type === 'status' && row.id) {
      const rec = agenda.get(row.id) || { id: row.id, content: '' };
      rec.status = row.status || rec.status || 'candidate';
      rec.updatedAt = row.at || rec.updatedAt || null;
      rec.statusNote = row.note || rec.statusNote || null;
      agenda.set(row.id, rec);
    }
  }

  const activeAgendaStatuses = new Set(['candidate', 'surfaced', 'acknowledged']);
  const activeAgenda = [...agenda.values()]
    .filter((row) => activeAgendaStatuses.has(row.status || 'candidate'))
    .sort((a, b) => toTimeMs(b.updatedAt || b.createdAt) - toTimeMs(a.updatedAt || a.createdAt))
    .slice(0, 12)
    .map((row) => ({
      ...row,
      ageMin: ageMinutes(row.updatedAt || row.createdAt, nowMs),
    }));

  const activeGoals = normalizeActiveGoals(goals)
    .sort((a, b) => toTimeMs(b.createdAt || b.created) - toTimeMs(a.createdAt || a.created))
    .slice(0, 12)
    .map((goal) => ({
      id: goal.id || '',
      description: goal.description || goal.title || goal.goal || '',
      status: goal.status || 'active',
      source: goal.source?.label || goal.source?.origin || goal.source || null,
      priority: goal.priority ?? null,
      progress: goal.progress ?? null,
      createdAt: goal.createdAt || goal.created_at || goal.created || null,
      ageMin: ageMinutes(goal.createdAt || goal.created_at || goal.created, nowMs),
    }));

  return {
    activeAgenda,
    activeGoals,
    counts: {
      activeAgenda: activeAgenda.length,
      activeGoals: activeGoals.length,
    },
  };
}

function normalizeActiveGoals(goals) {
  const active = Array.isArray(goals?.active) ? goals.active : [];
  return active.map((entry) => {
    if (Array.isArray(entry)) return entry[1] || { id: entry[0] };
    return entry || {};
  }).filter(Boolean);
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

function buildConsistency({ state, projection, liveProblems, freshness, runtime }) {
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

  for (const service of runtime?.services || []) {
    if (service?.ok === false) {
      warnings.push({
        code: `runtime_${service.id || 'service'}_unavailable`,
        severity: 'critical',
        message: `${service.label || service.id || 'Runtime service'} is unavailable: ${service.error || 'ping failed'}`,
      });
    }
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

function buildDetailSections({ commitments, trends, regulator, liveProblems, ledgerTail, obligations }) {
  const activeRows = [
    ...(Array.isArray(liveProblems.open) ? liveProblems.open : []),
    ...(Array.isArray(liveProblems.chronic) ? liveProblems.chronic : []),
  ];
  const unverifiableCount = finiteCount(liveProblems.counts?.unverifiable) || 0;
  const dailyActions = Array.isArray(regulator?.daily?.actions)
    ? regulator.daily.actions
      .slice()
      .sort((a, b) => toTimeMs(b.at) - toTimeMs(a.at))
      .slice(0, 12)
    : [];
  const commitmentsList = Array.isArray(commitments?.commitments) ? commitments.commitments : [];

  return {
    issues: {
      activeCount: activeRows.length + unverifiableCount,
      rows: activeRows,
      unverifiableCount,
    },
    work: {
      dailyActions,
      daily: regulator?.daily || null,
      obligations: obligations || { activeAgenda: [], activeGoals: [], counts: { activeAgenda: 0, activeGoals: 0 } },
    },
    resolutions: {
      recent: (Array.isArray(liveProblems.resolved) ? liveProblems.resolved : []).slice(0, 12),
      resolvedJustNow: Array.isArray(liveProblems.resolvedJustNow) ? liveProblems.resolvedJustNow : [],
      totalResolved: finiteCount(liveProblems.counts?.resolved) || 0,
    },
    insights: {
      activeCommitments: commitmentsList.filter((item) => item?.active),
      commitments: commitmentsList,
      trendMetrics: trends?.latest?.metrics || null,
      trend: trends?.latest || null,
      ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-12).reverse() : [],
    },
  };
}

function buildGoodLifeOperatorModel({
  state = null,
  commitments = null,
  trends = null,
  regulator = null,
  liveProblems = [],
  ledgerTail = [],
  obligations = null,
  runtime = null,
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
    runtime,
  });

  let status = 'current';
  if (!state) status = 'unknown';
  else if (consistency.warnings.some((warning) => warning.severity === 'critical')) status = 'critical';
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
    runtime,
    consistency,
    latestRegulatorAction: latestAction,
    trends: trends?.latest || null,
    ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-5) : [],
  };
  model.detail = buildDetailSections({
    commitments: commitments || {},
    trends: trends || {},
    regulator: regulator || {},
    liveProblems: directLiveProblems,
    ledgerTail,
    obligations,
  });
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
  buildGoodLifeObligationSnapshot,
};
