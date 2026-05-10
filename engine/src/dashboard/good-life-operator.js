const GOOD_LIFE_STALE_MS = 10 * 60 * 1000;
const RECENT_RESOLUTION_MS = 30 * 60 * 1000;
const GOOD_LIFE_AGENDA_REVIEW_MIN = 60;
const ACTIVE_AGENDA_REVIEW_MIN = 24 * 60;
const USER_INTERVENTION_REMEDIATORS = new Set([
  'notify_jtr',
  'request_user_input',
  'manual',
  'manual_intervention',
  'user_action',
]);
const WORK_REVIEW_GOAL_AGE_MIN = 12 * 60;
const fs = require('fs');
const path = require('path');

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

function summarizeNextRemediation(problem = {}) {
  const plan = Array.isArray(problem.remediation) ? problem.remediation : [];
  const index = Math.max(0, Number(problem.stepIndex || 0));
  const step = plan[index] || null;
  if (!step) {
    return {
      index,
      total: plan.length,
      type: null,
      requiresUser: false,
      text: plan.length ? 'remediation plan exhausted' : 'no remediation plan recorded',
    };
  }

  const type = String(step.type || '').trim();
  const requiresUser = USER_INTERVENTION_REMEDIATORS.has(type);
  const text = step.args?.text || step.args?.message || step.args?.name || step.args?.target || type;
  return {
    index,
    total: plan.length,
    type,
    requiresUser,
    text,
    cooldownMin: step.cooldownMin ?? null,
  };
}

function buildLiveProblemSnapshot(problems = [], now = new Date()) {
  const nowMs = toNowMs(now);
  const open = [];
  const chronic = [];
  const resolvedRows = [];
  const resolvedJustNow = [];
  let resolved = 0;
  let unverifiable = 0;
  let interventionRequired = 0;

  for (const problem of Array.isArray(problems) ? problems : []) {
    if (problem?.state === 'open' || problem?.state === 'chronic') {
      const nextRemediation = summarizeNextRemediation(problem);
      if (nextRemediation.requiresUser) interventionRequired += 1;
      const row = {
        id: problem.id || '',
        claim: problem.claim || '',
        ageMin: ageMinutes(problem.openedAt || problem.firstSeenAt, nowMs) ?? 0,
        detail: problem.lastResult?.detail || null,
        state: problem.state,
        escalated: !!problem.escalated,
        stepIndex: Number(problem.stepIndex || 0),
        remediationTotal: Array.isArray(problem.remediation) ? problem.remediation.length : 0,
        nextRemediation,
        intervention: {
          required: nextRemediation.requiresUser,
          reason: nextRemediation.requiresUser ? nextRemediation.text : null,
        },
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
      interventionRequired,
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

function buildGoodLifeObligationSnapshot({ agendaRows = [], goals = null, outputRoots = [], now = new Date() } = {}) {
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
        workerRoute: record.temporalContext?.workerRoute || row.temporalContext?.workerRoute || null,
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
    .map((row) => {
      const ageMin = ageMinutes(row.updatedAt || row.createdAt, nowMs);
      const annotated = { ...row, ageMin };
      return {
        ...annotated,
        review: classifyAgendaReview(annotated),
      };
    });

  const allActiveGoals = normalizeActiveGoals(goals);
  const activeGoals = allActiveGoals
    .sort((a, b) => toTimeMs(b.createdAt || b.created) - toTimeMs(a.createdAt || a.created))
    .slice(0, 12)
    .map((goal) => {
      const createdAt = goal.createdAt || goal.created_at || goal.created || null;
      const ageMin = ageMinutes(createdAt, nowMs);
      const source = goal.source?.label || goal.source?.origin || goal.source || null;
      const rawDescription = goal.description || goal.title || goal.goal || '';
      const description = summarizeGoalDescription(rawDescription);
      const artifact = resolveGoalArtifact(rawDescription, outputRoots);
      const row = {
        id: goal.id || '',
        description,
        rawDescription,
        artifact,
        status: goal.status || 'active',
        source,
        priority: goal.priority ?? null,
        progress: goal.progress ?? null,
        createdAt,
        ageMin,
      };
      const artifactStatus = goalArtifactText(row);
      return {
        ...row,
        artifactStatus,
        review: classifyGoalReview(row),
      };
    });

  const latestAgendaById = Object.fromEntries([...agenda.values()].map((row) => [row.id, {
    status: row.status || 'candidate',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || row.createdAt || null,
    statusNote: row.statusNote || null,
  }]));

  return {
    activeAgenda,
    activeGoals,
    latestAgendaById,
    counts: {
      activeAgenda: activeAgenda.length,
      activeGoals: Number.isFinite(goals?.counts?.active) ? goals.counts.active : allActiveGoals.length,
      activeGoalsShown: activeGoals.length,
      activeGoalsTrusted: Number.isFinite(goals?.counts?.active),
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

function summarizeGoalDescription(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^Produce\s+/i.test(text)) {
    const firstToken = text.replace(/^Produce\s+/i, '').split(/\s+/)[0]?.replace(/[.,;:]+$/, '');
    if (firstToken && firstToken.includes('/')) return `Produce ${firstToken}`;
  }
  const sentenceMatch = text.match(/^(.+?[.!?])(?:\s|$)/);
  return compactText(sentenceMatch?.[1] || text, 180);
}

function extractGoalArtifactPath(description) {
  const text = String(description || '');
  const match = text.match(/\b(outputs\/[^\s]+)/);
  if (!match?.[1]) return null;
  return match[1].replace(/[)\],;:]+$/g, '').replace(/\.$/, '');
}

function resolveGoalArtifact(description, outputRoots = []) {
  const relativePath = extractGoalArtifactPath(description);
  if (!relativePath) return null;
  const roots = Array.isArray(outputRoots) ? outputRoots.filter(Boolean) : [];
  const checkedPaths = [];
  for (const root of roots) {
    const absolutePath = path.resolve(root, relativePath);
    checkedPaths.push(absolutePath);
    try {
      if (fs.existsSync(absolutePath)) {
        const stat = fs.statSync(absolutePath);
        return {
          relativePath,
          exists: true,
          path: absolutePath,
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
          checkedPaths,
        };
      }
    } catch {
      // Keep checking the remaining roots.
    }
  }
  return {
    relativePath,
    exists: false,
    path: checkedPaths[0] || null,
    checkedPaths,
  };
}

function topGoalText(goal = {}) {
  if (!goal?.id) return null;
  const description = summarizeGoalDescription(goal.description || goal.rawDescription || '');
  return description ? `Top goal: ${goal.id} - ${description}` : `Top goal: ${goal.id}`;
}

function goalArtifactText(goal = {}) {
  if (!goal?.artifact?.relativePath) return null;
  if (goal.artifact.exists) return `artifact ready: ${goal.artifact.relativePath}`;
  const ageMin = finiteCount(goal.ageMin);
  const source = String(goal.source || '').toLowerCase();
  if (source === 'force-output' && ageMin != null && ageMin < WORK_REVIEW_GOAL_AGE_MIN) {
    return `artifact pending: ${goal.artifact.relativePath}; review in ${formatMinutes(WORK_REVIEW_GOAL_AGE_MIN - ageMin)}`;
  }
  return `artifact pending: ${goal.artifact.relativePath}`;
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value >= 120) return `${Math.round(value / 60)}h`;
  if (value >= 60) return '1h';
  return `${value}m`;
}

function classifyAgendaReview(row = {}) {
  const ageMin = finiteCount(row.ageMin);
  const status = String(row.status || 'candidate').toLowerCase();
  const sourceSignal = String(row.sourceSignal || '').toLowerCase();
  const tags = Array.isArray(row.topicTags) ? row.topicTags.map((tag) => String(tag || '').toLowerCase()) : [];
  const isGoodLife = sourceSignal === 'good-life' || tags.some((tag) => tag === 'good-life' || tag.startsWith('good-life:'));
  const suggestedWorker = row.workerRoute || suggestAgendaWorker(row, { isGoodLife, tags, sourceSignal });

  if (isGoodLife && !row.workerRoute && ageMin != null && ageMin >= GOOD_LIFE_AGENDA_REVIEW_MIN) {
    return {
      recommended: true,
      required: false,
      severity: 'watch',
      reason: `Good Life agenda row is ${Math.round(ageMin / 60)}h old and has no worker route`,
      next: 'dismiss it if live Good Life state has moved on; otherwise route it through a worker with fresh evidence',
      suggestedWorker,
    };
  }

  if (status === 'acknowledged' && ageMin != null && ageMin >= ACTIVE_AGENDA_REVIEW_MIN) {
    return {
      recommended: true,
      required: false,
      severity: 'watch',
      reason: `acknowledged agenda row is still active after ${Math.round(ageMin / 60)}h`,
      next: 'dismiss it if it no longer represents current work',
      suggestedWorker,
    };
  }

  if (ageMin != null && ageMin >= ACTIVE_AGENDA_REVIEW_MIN) {
    return {
      recommended: true,
      required: false,
      severity: 'watch',
      reason: `agenda row has stayed active for ${Math.round(ageMin / 60)}h`,
      next: 'run the routed worker if still current; dismiss it if stale',
      suggestedWorker,
    };
  }

  return {
    recommended: false,
    required: false,
    severity: 'ok',
    reason: null,
    next: null,
    suggestedWorker: row.workerRoute || null,
  };
}

function suggestAgendaWorker(row = {}, context = {}) {
  const text = `${row.content || ''} ${(row.topicTags || []).join(' ')}`.toLowerCase();
  if (row.workerRoute?.worker) return row.workerRoute;
  if (context.isGoodLife && /repair|recover|viability|friction|engine|process|pm2|host|cpu|memory pressure/.test(text)) {
    return {
      worker: 'systems',
      reason: 'legacy Good Life repair/recovery row needs current host and process evidence',
      inferred: true,
    };
  }
  if (/memory|context|handoff|canonical|consolidat|coherence|brain/.test(text)) {
    return {
      worker: 'memory',
      reason: 'stale agenda row needs memory, context, or handoff inspection',
      inferred: true,
    };
  }
  if (/cron|fresh|stale|ingest|pipeline|health|api|sensor|data|dashboard|output/.test(text)) {
    return {
      worker: 'freshness',
      reason: 'stale agenda row needs freshness and visible-output evidence',
      inferred: true,
    };
  }
  if (context.isGoodLife) {
    return {
      worker: 'freshness',
      reason: 'legacy Good Life row needs a bounded evidence check before further action',
      inferred: true,
    };
  }
  return null;
}

function latestRegulatorAction(regulator = {}) {
  return Object.entries(regulator || {})
    .filter(([key, value]) => key !== 'daily' && value && toTimeMs(value.at))
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => toTimeMs(b.at) - toTimeMs(a.at))[0] || null;
}

function classifyGoalReview(goal = {}) {
  const ageMin = finiteCount(goal.ageMin);
  const progress = Number(goal.progress || 0);
  const source = String(goal.source || '').toLowerCase();
  if (source === 'force-output' && ageMin != null && ageMin >= WORK_REVIEW_GOAL_AGE_MIN && progress <= 0) {
    return {
      recommended: true,
      required: false,
      severity: 'watch',
      reason: `force-output goal has no observable progress after ${Math.round(ageMin / 60)}h`,
      next: 'keep it if the digest is still useful; dismiss or archive it if it is stale back-pressure',
    };
  }
  if (ageMin != null && ageMin >= 24 * 60 && progress <= 0) {
    return {
      recommended: true,
      required: false,
      severity: 'watch',
      reason: `active goal has no observable progress after ${Math.round(ageMin / 60)}h`,
      next: 'review whether the goal still represents useful work',
    };
  }
  return {
    recommended: false,
    required: false,
    severity: 'ok',
    reason: null,
    next: null,
  };
}

function summarizeWork(obligations = {}) {
  const activeAgenda = Array.isArray(obligations.activeAgenda) ? obligations.activeAgenda : [];
  const activeGoals = Array.isArray(obligations.activeGoals)
    ? obligations.activeGoals.map((goal) => ({
      ...goal,
      artifactStatus: goal.artifactStatus || goalArtifactText(goal),
    }))
    : [];
  const activeGoalTotal = finiteCount(obligations.counts?.activeGoals) ?? activeGoals.length;
  const activeGoalShown = finiteCount(obligations.counts?.activeGoalsShown) ?? activeGoals.length;
  const goalsNeedingReview = activeGoals.filter((goal) => goal.review?.recommended);
  const agendaNeedingReview = activeAgenda.filter((row) => row.review?.recommended);
  const agendaNeedingUser = activeAgenda.filter((row) => row.intervention?.required);
  const topAgenda = activeAgenda[0] || null;
  const topGoal = activeGoals[0] || null;
  const topReviewGoal = goalsNeedingReview[0] || null;
  const workStatus = summarizeWorkStatus({
    activeAgenda,
    activeGoals,
    agendaNeedingReview,
    goalsNeedingReview,
    agendaNeedingUser,
    topAgenda,
    topGoal,
    topReviewGoal,
  });
  return {
    activeAgenda: activeAgenda.length,
    activeGoals: activeGoalTotal,
    activeGoalsShown: activeGoalShown,
    activeTotal: activeAgenda.length + activeGoalTotal,
    agendaNeedingReview: agendaNeedingReview.length,
    goalsNeedingReview: goalsNeedingReview.length,
    interventionRequired: agendaNeedingUser.length,
    status: workStatus.status,
    statusText: workStatus.text,
    needsUser: workStatus.needsUser,
    topAgenda,
    topGoal,
    topReviewGoal,
    agendaReviewRows: agendaNeedingReview.slice(0, 5),
    reviewRows: goalsNeedingReview.slice(0, 5),
  };
}

function summarizeWorkStatus({
  activeAgenda = [],
  activeGoals = [],
  agendaNeedingReview = [],
  goalsNeedingReview = [],
  agendaNeedingUser = [],
  topAgenda = null,
  topGoal = null,
  topReviewGoal = null,
} = {}) {
  if (agendaNeedingUser.length > 0) {
    const row = agendaNeedingUser[0];
    return {
      status: 'needs-user',
      needsUser: true,
      text: row.intervention?.reason
        ? `user intervention needed: ${compactText(row.intervention.reason, 120)}`
        : 'user intervention needed for active work',
    };
  }
  if (agendaNeedingReview.length > 0) {
    const row = agendaNeedingReview[0];
    return {
      status: 'review',
      needsUser: false,
      text: row.review?.reason
        ? `review recommended: ${compactText(row.review.reason, 120)}`
        : 'operator review recommended for active agenda',
    };
  }
  if (goalsNeedingReview.length > 0) {
    const goal = topReviewGoal || goalsNeedingReview[0];
    return {
      status: 'review',
      needsUser: false,
      text: goal.review?.reason
        ? `review recommended: ${compactText(goal.review.reason, 120)}`
        : 'operator review recommended for active goal',
    };
  }
  const topGoalArtifactStatus = topGoal?.artifactStatus || goalArtifactText(topGoal);
  if (topGoalArtifactStatus) {
    return {
      status: 'working',
      needsUser: false,
      text: topGoalArtifactStatus,
    };
  }
  if (topAgenda?.id) {
    return {
      status: 'working',
      needsUser: false,
      text: `autonomous work active: ${topAgenda.id}`,
    };
  }
  if (activeAgenda.length + activeGoals.length > 0) {
    return {
      status: 'working',
      needsUser: false,
      text: 'autonomous work active; no user intervention needed yet',
    };
  }
  return {
    status: 'clear',
    needsUser: false,
    text: 'no active routed work',
  };
}

function isGoodLifeAgendaRow(row = {}) {
  const tags = Array.isArray(row.topicTags) ? row.topicTags.map((tag) => String(tag || '').toLowerCase()) : [];
  return String(row.sourceSignal || '').toLowerCase() === 'good-life'
    || tags.some((tag) => tag === 'good-life' || tag.startsWith('good-life:'));
}

function agendaPolicy(row = {}) {
  return String(row.temporalContext?.policy || row.policy || '').toLowerCase();
}

function annotateObligationsForCurrentGoodLife(obligations = {}, { policy, liveProblems } = {}) {
  const activeAgenda = Array.isArray(obligations.activeAgenda) ? obligations.activeAgenda : [];
  const activeProblems = Number(liveProblems?.counts?.open || 0) + Number(liveProblems?.counts?.chronic || 0);
  const currentMode = String(policy?.mode || '').toLowerCase();
  const annotatedAgenda = activeAgenda.map((row) => {
    const rowPolicy = agendaPolicy(row);
    const isSupersededRepair = isGoodLifeAgendaRow(row)
      && activeProblems === 0
      && ['repair', 'recover'].includes(rowPolicy)
      && !['repair', 'recover'].includes(currentMode);
    if (!isSupersededRepair || row.review?.recommended) return row;
    return {
      ...row,
      review: {
        recommended: true,
        required: false,
        severity: 'watch',
        reason: `Good Life ${rowPolicy} row is superseded by current ${currentMode || 'non-repair'} mode with no open live problems`,
        next: 'dismiss it if the live registry is still clear; run the worker only if fresh evidence says repair is still needed',
        suggestedWorker: row.workerRoute || null,
      },
    };
  });

  return {
    ...obligations,
    activeAgenda: annotatedAgenda,
    counts: {
      ...(obligations.counts || {}),
      activeAgenda: annotatedAgenda.length,
      activeGoalsShown: Array.isArray(obligations.activeGoals)
        ? obligations.activeGoals.length
        : finiteCount(obligations.counts?.activeGoalsShown),
      activeGoals: obligations.counts?.activeGoalsTrusted
        ? Number(obligations.counts?.activeGoals || 0)
        : (Array.isArray(obligations.activeGoals)
          ? obligations.activeGoals.length
          : Number(obligations.counts?.activeGoals || 0)),
    },
  };
}

function annotateLatestRegulatorAction(action, obligations) {
  if (!action?.agendaId) return action || null;
  const latestAgenda = obligations?.latestAgendaById?.[action.agendaId] || null;
  if (!latestAgenda) return action;
  return {
    ...action,
    agendaStatus: latestAgenda.status || null,
    agendaUpdatedAt: latestAgenda.updatedAt || latestAgenda.createdAt || null,
    agendaStatusNote: latestAgenda.statusNote || null,
  };
}

function isActiveAgendaStatus(status) {
  return ['candidate', 'surfaced', 'acknowledged'].includes(String(status || '').toLowerCase());
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

function buildConsistency({ state, projection, liveProblems, obligations, hasObligationEvidence = false, freshness, runtime }) {
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

  const projectedOpenGoals = finiteCount(projection.goals?.open);
  const activeGoalRows = finiteCount(obligations?.counts?.activeGoals);
  if (
    hasObligationEvidence
    && obligations?.counts?.activeGoalsTrusted
    && projectedOpenGoals != null
    && activeGoalRows != null
    && projectedOpenGoals !== activeGoalRows
  ) {
    warnings.push({
      code: 'good_life_goal_projection_mismatch',
      severity: 'warning',
      message: `Good Life goal count disagrees with active goals: projected ${projectedOpenGoals}, active list ${activeGoalRows}`,
      fields: ['goals.open'],
    });
  }

  for (const service of runtime?.services || []) {
    if (service?.ok === false) {
      const isEngineTimeout = service.id === 'engine' && /timeout|aborted/i.test(String(service.error || ''));
      warnings.push({
        code: `runtime_${service.id || 'service'}_unavailable`,
        severity: isEngineTimeout ? 'warning' : 'critical',
        message: `${service.label || service.id || 'Runtime service'} is unavailable: ${service.error || 'ping failed'}`,
      });
    } else if (service?.slow === true) {
      const degradedText = service.degraded
        ? `${service.label || service.id || 'Runtime service'} health endpoint is slow or not answering, but ${service.pm2?.name || 'the PM2 process'} is ${service.pm2?.status || 'present'}: ${service.error || 'fallback health used'}`
        : `${service.label || service.id || 'Runtime service'} is slow: ${service.latencyMs}ms health check exceeds ${service.slowThresholdMs || 5000}ms`;
      warnings.push({
        code: `runtime_${service.id || 'service'}_slow`,
        severity: 'warning',
        message: degradedText,
      });
    }
  }

  return {
    ok: warnings.length === 0,
    warnings,
  };
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function compactLedgerEntry(entry = {}) {
  const isGoodLifeEvaluation = entry.schema === 'home23.good-life.v1'
    || entry.state?.schema === 'home23.good-life.v1';
  return {
    at: entry.at || entry.timestamp || entry.evaluatedAt || entry.state?.evaluatedAt || null,
    event: entry.event || entry.type || (isGoodLifeEvaluation ? 'good_life.evaluated' : null),
    mode: entry.mode || entry.policy?.mode || null,
    summary: compactText(entry.summary || entry.message || entry.policy?.reason || entry.state?.summary || '', 220),
    problemId: entry.problemId || entry.evidence?.problemId || null,
    agendaId: entry.agendaId || entry.evidence?.agendaId || null,
  };
}

function summarizeTopLiveProblem(liveProblems = {}) {
  const rows = [
    ...(Array.isArray(liveProblems.open) ? liveProblems.open : []),
    ...(Array.isArray(liveProblems.chronic) ? liveProblems.chronic : []),
  ];
  if (rows.length === 0) return [];

  const problem = rows[0];
  const lines = [];
  const label = problem.state === 'chronic' ? 'Top chronic problem' : 'Top live problem';
  const headline = [
    `${label}: ${problem.id || 'unknown'}`,
    problem.claim ? compactText(problem.claim, 120) : null,
  ].filter(Boolean).join(' - ');
  lines.push(headline);

  if (problem.detail) {
    lines.push(`Verifier: ${compactText(problem.detail, 140)}`);
  }

  if (problem.lastRemediation) {
    const rem = problem.lastRemediation;
    const status = [rem.type, rem.outcome].filter(Boolean).join(' ');
    const detail = rem.detail ? ` - ${compactText(rem.detail, 140)}` : '';
    lines.push(`Latest fix attempt: ${status || 'recorded'}${detail}`);
  }

  const next = problem.nextRemediation || {};
  if (next.type) {
    const prefix = next.requiresUser ? 'Next user action' : 'Next autonomous step';
    lines.push(`${prefix}: ${next.type}${next.text && next.text !== next.type ? ` - ${compactText(next.text, 120)}` : ''}`);
  } else if (next.text) {
    lines.push(`Next step: ${compactText(next.text, 140)}`);
  }

  return lines;
}

function firstActiveLiveProblem(liveProblems = {}) {
  const rows = [
    ...(Array.isArray(liveProblems.open) ? liveProblems.open : []),
    ...(Array.isArray(liveProblems.chronic) ? liveProblems.chronic : []),
  ];
  return rows.find((row) => row.nextRemediation?.requiresUser)
    || rows.find((row) => row.state === 'chronic')
    || rows[0]
    || null;
}

function formatRemediationLine(prefix, next = {}) {
  if (!next?.type && !next?.text) return null;
  const text = next.text && next.text !== next.type
    ? ` - ${compactText(next.text, 140)}`
    : '';
  return `${prefix}: ${next.type || 'next step'}${text}`;
}

function buildProjectionMismatchText(projection = {}, liveProblems = {}) {
  const fields = ['open', 'chronic', 'unverifiable']
    .map((key) => {
      const projected = finiteCount(projection.liveProblems?.[key]);
      const direct = finiteCount(liveProblems.counts?.[key]);
      if (projected == null || direct == null || projected === direct) return null;
      return `${key} projected ${projected}, registry ${direct}`;
    })
    .filter(Boolean);
  return fields.length ? fields.join('; ') : null;
}

function buildOperatorBrief({ policy, liveProblems, consistency, work, latestAction, projection, freshness }) {
  const counts = liveProblems.counts || {};
  const activeCount = Number(counts.open || 0) + Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const activeProblem = firstActiveLiveProblem(liveProblems);
  const warnings = consistency?.warnings || [];
  const projectionMismatch = buildProjectionMismatchText(projection, liveProblems);
  const latestResolution = Array.isArray(liveProblems.resolved) ? liveProblems.resolved[0] || null : null;
  const latestActionAgendaActive = latestAction?.workerRoute?.worker
    && isActiveAgendaStatus(latestAction.agendaStatus || 'candidate');

  let severity = 'clear';
  let status = 'Clear';
  let headline = 'No active Good Life issues';
  let why = policy?.reason || 'Live-problem registry is clear.';
  let next = 'Continue monitoring current engine evidence.';
  let target = {
    tab: 'issues',
    id: null,
    label: 'Open Details',
    worker: null,
  };

  if (interventionCount > 0) {
    severity = 'needs-user';
    status = 'Needs jtr';
    headline = `${interventionCount} live problem${interventionCount === 1 ? '' : 's'} need user intervention`;
    why = activeProblem?.claim || activeProblem?.detail || 'Good Life reached a manual remediation step.';
    next = formatRemediationLine('User action', activeProblem?.nextRemediation)
      || 'User decision is required before autonomous repair can continue.';
    target = {
      tab: 'issues',
      id: activeProblem?.id || null,
      label: 'Review Issue',
      worker: null,
    };
  } else if (activeCount > 0) {
    severity = 'repairing';
    status = 'Repairing';
    headline = `${activeCount} active live problem${activeCount === 1 ? '' : 's'}`;
    why = activeProblem?.claim || activeProblem?.detail || policy?.reason || 'Good Life is repairing verified drift.';
    next = formatRemediationLine('Home23 next', activeProblem?.nextRemediation)
      || 'Autonomous remediation can continue.';
    target = {
      tab: 'issues',
      id: activeProblem?.id || null,
      label: 'Review Repair',
      worker: null,
    };
  } else if (projectionMismatch) {
    severity = 'attention';
    status = 'Reconciling';
    headline = 'Registry is clear; Good Life projection disagrees';
    why = projectionMismatch;
    next = 'Next engine evaluation should reconcile the projection with the live registry.';
    target = {
      tab: 'insights',
      id: null,
      label: 'Review Signals',
      worker: null,
    };
  } else if (warnings.length > 0) {
    severity = warnings.some((warning) => warning.severity === 'critical') ? 'critical' : 'attention';
    status = severity === 'critical' ? 'Critical' : 'Attention';
    headline = warnings[0].message || 'Good Life has an operator warning';
    why = policy?.reason || warnings[0].code || 'Operator consistency warning is present.';
    next = freshness?.status === 'stale'
      ? 'Good Life needs a fresh evaluation before its projection is safe to inherit.'
      : 'Review the warning before treating the projection as current.';
    target = {
      tab: 'insights',
      id: null,
      label: 'Review Warning',
      worker: null,
    };
  } else if (work?.activeTotal > 0) {
    severity = 'working';
    status = 'Working';
    headline = `${work.activeTotal} active Good Life work item${work.activeTotal === 1 ? '' : 's'}`;
    why = policy?.reason || 'Good Life has routed work but no active live problem.';
    if (work.topAgenda?.review?.recommended) {
      next = `Review: ${compactText(work.topAgenda.review.reason || 'operator review recommended', 140)}`;
    } else if (latestActionAgendaActive) {
      next = `Worker route: ${latestAction.workerRoute.worker}${latestAction.workerRoute.reason ? ` - ${compactText(latestAction.workerRoute.reason, 140)}` : ''}`;
    } else if (work.topAgenda?.id) {
      next = `Top agenda: ${work.topAgenda.id}`;
    } else if (work.topGoal?.id) {
      const artifactText = goalArtifactText(work.topGoal);
      next = `${topGoalText(work.topGoal)}${artifactText ? `; ${artifactText}` : ''}`;
    }
    target = {
      tab: 'work',
      id: work.topAgenda?.id || work.topGoal?.id || null,
      label: work.topAgenda?.review?.recommended
        ? 'Review Work'
        : (latestActionAgendaActive ? `Open ${latestAction.workerRoute.worker}` : 'Review Work'),
      worker: work.topAgenda?.review?.recommended ? null : (latestActionAgendaActive ? latestAction.workerRoute.worker : null),
    };
  } else if (latestResolution) {
    headline = 'No active issues after recent repairs';
    why = latestResolution.claim || latestResolution.id || policy?.reason || why;
    next = latestResolution.lastResult?.detail
      ? `Last verifier: ${compactText(latestResolution.lastResult.detail, 140)}`
      : 'Recent resolution is available in the receipts list.';
    target = {
      tab: 'resolutions',
      id: latestResolution.id || null,
      label: 'View Resolution',
      worker: null,
    };
  }

  return {
    severity,
    status,
    headline,
    why: compactText(why, 220),
    next: compactText(next, 220),
    needsUser: interventionCount > 0,
    activeProblemId: activeProblem?.id || null,
    target,
    latestResolution: latestResolution ? {
      id: latestResolution.id || '',
      claim: compactText(latestResolution.claim || '', 180),
      resolvedAt: latestResolution.resolvedAt || null,
      verifier: compactText(latestResolution.lastResult?.detail || latestResolution.fixRecipe?.verifierStatus || '', 180),
      receiptPath: latestResolution.evidence?.receiptPath || null,
    } : null,
  };
}

function buildOperatorAnswer({ state, lanes, liveProblems, consistency, work, latestAction }) {
  const lines = [];
  if (state?.summary || state?.policy?.reason) {
    lines.push(state.summary || state.policy.reason);
  }

  const counts = liveProblems.counts || {};
  const openCount = Number(counts.open || 0);
  const chronicCount = Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  lines.push(`Live-problem registry: ${openCount} open, ${chronicCount} chronic`);
  if (interventionCount > 0) {
    lines.push(`${counts.interventionRequired} live problem(s) need user intervention`);
  }
  lines.push(...summarizeTopLiveProblem(liveProblems));

  if (openCount === 0 && chronicCount === 0 && interventionCount === 0) {
    const latestResolution = Array.isArray(liveProblems.resolved) ? liveProblems.resolved[0] || null : null;
    if (latestResolution) {
      const fixed = latestResolution.fixRecipe?.summary
        || latestResolution.claim
        || latestResolution.id
        || 'recent repair';
      lines.push(`Latest verified resolution: ${compactText(fixed, 180)}`);
      const verifier = latestResolution.lastResult?.detail
        || latestResolution.fixRecipe?.verifierStatus
        || latestResolution.evidence?.result
        || null;
      if (verifier) {
        lines.push(`Resolution verifier: ${compactText(verifier, 180)}`);
      }
      if (latestResolution.evidence?.receiptId || latestResolution.evidence?.receiptPath) {
        lines.push(`Resolution receipt: ${latestResolution.evidence.receiptId || latestResolution.evidence.receiptPath}`);
      }
    }
  }

  if (work?.activeTotal > 0) {
    const reviewParts = [];
    if (work.agendaNeedingReview > 0) reviewParts.push(`${work.agendaNeedingReview} agenda row(s) need review`);
    if (work.goalsNeedingReview > 0) reviewParts.push(`${work.goalsNeedingReview} goal(s) need operator review`);
    const reviewText = reviewParts.length ? `; ${reviewParts.join('; ')}` : '';
    const agendaText = work.topAgenda?.id ? `; top agenda ${work.topAgenda.id}` : '';
    const goalText = work.topReviewGoal?.id
      ? `; ${topGoalText(work.topReviewGoal).replace(/^Top goal:/, 'top review goal:')}`
      : (work.topGoal?.id ? `; ${topGoalText(work.topGoal).replace(/^Top goal:/, 'top goal:')}` : '');
    const artifactText = goalArtifactText(work.topReviewGoal || work.topGoal);
    lines.push(`Active work: ${work.activeTotal}${reviewText}${agendaText}${goalText}${artifactText ? `; ${artifactText}` : ''}`);
  }

  if (latestAction?.workerRoute?.worker && isActiveAgendaStatus(latestAction.agendaStatus || 'candidate')) {
    const route = latestAction.workerRoute;
    lines.push(`Worker route: ${route.worker}${route.reason ? ` - ${route.reason}` : ''}`);
  }

  for (const lane of lanes.filter((candidate) => candidate.active)) {
    const reason = lane.reasons?.[0] || lane.status;
    lines.push(`${lane.name}: ${reason}`);
  }

  for (const warning of consistency.warnings || []) {
    lines.push(warning.message);
  }

  return lines;
}

function buildOperatorDigest({ brief, liveProblems, work }) {
  const counts = liveProblems?.counts || {};
  const activeCount = Number(counts.open || 0) + Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const latestResolution = Array.isArray(liveProblems?.resolved) ? liveProblems.resolved[0] || null : null;
  const activeProblem = firstActiveLiveProblem(liveProblems || {});
  const workStatus = work?.statusText || 'no active routed work';

  let userAction = 'No user action needed right now.';
  if (interventionCount > 0) {
    userAction = formatRemediationLine('User action', activeProblem?.nextRemediation)
      || 'User decision is required before autonomous repair can continue.';
  } else if (work?.agendaNeedingReview > 0 || work?.goalsNeedingReview > 0) {
    userAction = workStatus || 'Operator review is recommended for active work.';
  } else if (brief?.severity === 'critical') {
    userAction = brief.next || 'Review the warning before treating the projection as current.';
  } else if (brief?.severity === 'attention') {
    userAction = brief.headline
      ? `No user action needed; Home23 is watching: ${brief.headline}`
      : 'No user action needed; Home23 is watching the warning.';
  }

  return {
    issue: activeCount > 0
      ? `${activeCount} active live problem${activeCount === 1 ? '' : 's'}`
      : 'No active live problems',
    currentWork: work?.activeTotal > 0 ? workStatus : 'No active routed work',
    latestFix: latestResolution
      ? compactText(latestResolution.fixRecipe?.summary || latestResolution.claim || latestResolution.id || 'recent verified resolution', 220)
      : 'No recent verified repair receipt',
    userAction: compactText(userAction, 220),
    evidence: {
      open: Number(counts.open || 0),
      chronic: Number(counts.chronic || 0),
      interventionRequired: interventionCount,
      activeWork: Number(work?.activeTotal || 0),
      latestResolutionId: latestResolution?.id || null,
      targetTab: brief?.target?.tab || null,
    },
  };
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
  const compactObligations = obligations ? {
    activeAgenda: Array.isArray(obligations.activeAgenda) ? obligations.activeAgenda : [],
    activeGoals: Array.isArray(obligations.activeGoals) ? obligations.activeGoals : [],
    counts: obligations.counts || { activeAgenda: 0, activeGoals: 0 },
  } : { activeAgenda: [], activeGoals: [], counts: { activeAgenda: 0, activeGoals: 0 } };

  return {
    issues: {
      activeCount: activeRows.length + unverifiableCount,
      rows: activeRows,
      unverifiableCount,
    },
    work: {
      dailyActions,
      daily: regulator?.daily ? {
        date: regulator.daily.date || null,
        selfMaintenanceActions: regulator.daily.selfMaintenanceActions || 0,
      } : null,
      obligations: compactObligations,
      summary: summarizeWork(obligations || {}),
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
      ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-12).reverse().map(compactLedgerEntry) : [],
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
  const currentObligations = annotateObligationsForCurrentGoodLife(obligations || {}, {
    policy,
    liveProblems: directLiveProblems,
  });
  const latestAction = annotateLatestRegulatorAction(latestRegulatorAction(regulator || {}), currentObligations);
  const work = summarizeWork(currentObligations || {});
  const consistency = buildConsistency({
    state,
    projection,
    liveProblems: directLiveProblems,
    obligations: currentObligations,
    hasObligationEvidence: !!obligations,
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
    work,
    projection,
    runtime,
    consistency,
    latestRegulatorAction: latestAction,
    trends: trends?.latest || null,
    ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-5).map(compactLedgerEntry) : [],
  };
  model.detail = buildDetailSections({
    commitments: commitments || {},
    trends: trends || {},
    regulator: regulator || {},
    liveProblems: directLiveProblems,
    ledgerTail,
    obligations: currentObligations,
  });
  model.work = work;
  model.operatorAnswer = buildOperatorAnswer({
    state,
    lanes,
    liveProblems: directLiveProblems,
    consistency,
    work,
    latestAction,
  });
  model.operatorBrief = buildOperatorBrief({
    policy,
    liveProblems: directLiveProblems,
    consistency,
    work,
    latestAction,
    projection,
    freshness,
  });
  model.operatorDigest = buildOperatorDigest({
    brief: model.operatorBrief,
    liveProblems: directLiveProblems,
    work,
  });
  return model;
}

module.exports = {
  buildGoodLifeOperatorModel,
  buildLiveProblemSnapshot,
  buildGoodLifeObligationSnapshot,
};
