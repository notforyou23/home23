const GOOD_LIFE_STALE_MS = 10 * 60 * 1000;
const RECENT_RESOLUTION_MS = 30 * 60 * 1000;
const GOOD_LIFE_AGENDA_REVIEW_MIN = 60;
const ACTIVE_AGENDA_REVIEW_MIN = 24 * 60;
const { SELF_MAINTENANCE_DAILY_LIMIT } = require('../good-life/regulator');
const USER_INTERVENTION_REMEDIATORS = new Set([
  'notify_jtr',
  'request_user_input',
  'manual',
  'manual_intervention',
  'user_action',
]);
const HUMAN_BLOCKER_SOURCE_ISSUES = [5, 17, 19, 21, 25];
const OPERATOR_HANDOFF_SOURCE_ISSUES = [25, 86, 93, 101];
const INTERVENTION_READINESS_SOURCE_ISSUES = [88];
const PUBLISHING_DISTRIBUTION_SOURCE_ISSUES = [43, 44, 45, 46, 47, 50, 51];
const RUNTIME_MAINTENANCE_SOURCE_ISSUES = [48, 49];
const AUTONOMY_SUBSTRATE_SOURCE_ISSUES = [1, 3];
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

function normalizeStaleData(staleData = null) {
  if (!staleData || typeof staleData !== 'object') return null;
  const source = String(staleData.source || staleData.label || staleData.name || '').trim();
  const lastFreshAt = String(staleData.lastFreshAt || staleData.freshAt || staleData.checkedAt || '').trim();
  const ageDays = finiteCount(staleData.ageDays);
  if (!source && !lastFreshAt && ageDays == null) return null;
  return {
    ...(source ? { source } : {}),
    ...(lastFreshAt ? { lastFreshAt } : {}),
    ...(ageDays != null ? { ageDays } : {}),
  };
}

function buildOperatorRequest(step = {}, { type = '', text = '' } = {}) {
  const args = step?.args && typeof step.args === 'object' ? step.args : {};
  const actionText = String(text || args.text || args.message || args.name || args.target || type || 'User action required').trim();
  const channel = String(args.channel || args.contactMethod || args.surface || '').trim() || null;
  const deadlineAt = String(args.deadlineAt || args.deadline || args.dueAt || '').trim() || null;
  const staleData = normalizeStaleData(args.staleData || args.externalData || null);
  const lastAutonomousAttempt = String(args.lastAutonomousAttempt || args.lastAttempt || args.autonomousAttempt || '').trim() || null;

  return {
    schema: 'home23.operator-request.v1',
    sourceIssues: HUMAN_BLOCKER_SOURCE_ISSUES,
    remediator: type || null,
    actionText,
    channel,
    deadlineAt,
    staleData,
    lastAutonomousAttempt,
  };
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
    operatorRequest: requiresUser ? buildOperatorRequest(step, { type, text }) : null,
  };
}

function liveProblemIssueText(problem = {}) {
  if (!problem) return '';
  const explicit = problem.issue || problem.failureClaim || problem.failure || problem.title;
  if (explicit) return compactText(explicit, 220);

  const claim = String(problem.claim || '').trim();
  if (!claim) return problem.id || 'operator issue';

  const noMatch = claim.match(/^(.+?)\s+has no\s+(.+)$/i);
  if (noMatch) return compactText(`${noMatch[1]} has recent ${noMatch[2]}`, 220);

  const notMatch = claim.match(/^(.+?)\s+is not\s+(.+)$/i);
  if (notMatch) return compactText(`${notMatch[1]} is ${notMatch[2]}`, 220);

  return compactText(`Not verified: ${claim}`, 220);
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
      const requiresUser = nextRemediation.requiresUser || problem.escalated === true;
      if (requiresUser) interventionRequired += 1;
      const row = {
        id: problem.id || '',
        claim: problem.claim || '',
        issue: liveProblemIssueText(problem),
        ageMin: ageMinutes(problem.openedAt || problem.firstSeenAt, nowMs) ?? 0,
        detail: problem.lastResult?.detail || null,
        state: problem.state,
        escalated: !!problem.escalated,
        stepIndex: Number(problem.stepIndex || 0),
        remediationTotal: Array.isArray(problem.remediation) ? problem.remediation.length : 0,
        nextRemediation,
        intervention: {
          required: requiresUser,
          reason: problem.escalated
            ? `escalated after autonomous remediation; ${nextRemediation.text || 'manual review required'}`
            : (nextRemediation.requiresUser ? nextRemediation.text : null),
          request: nextRemediation.operatorRequest || null,
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
        openedAt: problem.openedAt || null,
        firstSeenAt: problem.firstSeenAt || null,
        resolvedAt: problem.resolvedAt || null,
        ageMin: resolvedMs ? Math.max(0, Math.round((nowMs - resolvedMs) / 60000)) : null,
        fixRecipe: problem.fixRecipe || null,
        fixRecipeHistory: Array.isArray(problem.fixRecipeHistory) ? problem.fixRecipeHistory : [],
        lastResult: problem.lastResult || null,
        evidence: problem.evidence || null,
        remediation: Array.isArray(problem.remediation) ? problem.remediation : [],
        remediationLog: Array.isArray(problem.remediationLog) ? problem.remediationLog : [],
        lastRemediation: Array.isArray(problem.remediationLog)
          ? problem.remediationLog.slice(-1)[0] || null
          : null,
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
      const reviewed = {
        ...annotated,
        review: classifyAgendaReview(annotated),
      };
      return {
        ...reviewed,
        manifest: buildAgendaWorkManifest(reviewed),
      };
    });

  const allActiveGoals = normalizeActiveGoals(goals);
  const integrity = activeGoalIntegrity(allActiveGoals);
  const openWorkGoals = allActiveGoals.filter(isOpenWorkGoal);
  const configuredActiveCount = finiteCount(goals?.counts?.active);
  const preserveCappedActiveCount = configuredActiveCount != null
    && integrity.completedInActive === 0
    && allActiveGoals.length >= 12
    && configuredActiveCount > allActiveGoals.length;
  const effectiveActiveCount = preserveCappedActiveCount ? configuredActiveCount : openWorkGoals.length;
  const activeGoals = openWorkGoals
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
      const reviewed = {
        ...row,
        artifactStatus,
        review: classifyGoalReview(row),
      };
      return {
        ...reviewed,
        manifest: buildGoalWorkManifest(reviewed),
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
      activeGoals: effectiveActiveCount,
      activeGoalsShown: activeGoals.length,
      activeGoalsTrusted: configuredActiveCount != null && integrity.completedInActive === 0,
      sourceUpdatedAt: goals?.counts?.sourceUpdatedAt || goals?.sourceUpdatedAt || null,
      integrity,
    },
  };
}

function buildAgendaWorkManifest(row = {}) {
  if (!row?.id) return null;
  const route = row.workerRoute || row.review?.suggestedWorker || null;
  return {
    schema: 'home23.good-life.work-manifest.v1',
    subjectType: 'agenda',
    subjectId: row.id,
    allowedTransition: route?.worker ? `dispatch_worker:${route.worker}` : 'operator_review',
    forbiddenAdjacentMoves: [
      'do not restart unrelated services',
      'do not mutate unrelated agenda or goal state',
      'do not claim completion without a verifier-bearing receipt',
    ],
    stopLine: route?.worker
      ? `stop after worker receipt records pass, fail, or blocked for ${row.id}`
      : `stop after agenda status receipt classifies ${row.id}`,
    sourceSurface: `agenda.jsonl#${row.id}`,
    verifier: route?.worker
      ? 'worker receipt must report verifierStatus pass, fail, or blocked'
      : 'operator must classify the row as current, stale, acknowledged, or dismissed',
    receipt: route?.worker
      ? `worker receipt source.type=good-life-agenda source.id=${row.id}`
      : `agenda status receipt id=${row.id}`,
    artifact: null,
    authority: 'agenda event stream proposes work; worker receipt and verifier evidence decide whether it completed',
  };
}

function buildGoalWorkManifest(goal = {}) {
  if (!goal?.id) return null;
  const artifact = goal.artifact?.relativePath ? {
    relativePath: goal.artifact.relativePath,
    exists: goal.artifact.exists === true,
    path: goal.artifact.path || null,
  } : null;
  return {
    schema: 'home23.good-life.work-manifest.v1',
    subjectType: 'goal',
    subjectId: goal.id,
    allowedTransition: artifact?.relativePath ? `produce_artifact:${artifact.relativePath}` : 'resolve_or_archive_goal',
    forbiddenAdjacentMoves: [
      'do not rewrite unrelated goals',
      'do not satisfy by narrative summary alone',
      'do not mark complete until artifact or bounded resolution receipt exists',
    ],
    stopLine: artifact?.relativePath
      ? `stop after ${artifact.relativePath} exists or the goal is resolved/archived with a receipt`
      : `stop after ${goal.id} is resolved, completed, archived, or converted into a bounded artifact goal`,
    sourceSurface: `brain-snapshot.activeGoals#${goal.id}`,
    verifier: artifact?.relativePath
      ? 'artifact must exist at one checked output path'
      : 'goal status must be resolved, completed, archived, or converted into a bounded artifact goal',
    receipt: artifact?.relativePath
      ? `goal resolution or worker receipt must cite ${goal.id} and ${artifact.relativePath}`
      : `goal resolution or archive receipt must cite ${goal.id}`,
    artifact,
    authority: 'active goal requests work; artifact and receipt evidence decide whether it completed',
  };
}

function normalizeActiveGoals(goals) {
  const active = Array.isArray(goals?.active) ? goals.active : [];
  return active.map((entry) => {
    if (Array.isArray(entry)) return entry[1] || { id: entry[0] };
    return entry || {};
  }).filter(Boolean);
}

function isOpenWorkGoal(goal) {
  if (!goal) return false;
  const status = String(goal.status || 'active').toLowerCase();
  if (['completed', 'complete', 'archived', 'cancelled', 'canceled', 'resolved'].includes(status)) {
    return false;
  }
  if (goal.completed || goal.completedAt || goal.completed_at) return false;
  const progress = Number.isFinite(Number(goal.progress)) ? Number(goal.progress) : null;
  return progress === null || progress < 1;
}

function activeGoalIntegrity(allGoals = []) {
  const completedInActiveIds = [];
  for (const goal of Array.isArray(allGoals) ? allGoals : []) {
    if (!isOpenWorkGoal(goal)) {
      completedInActiveIds.push(goal.id || goal.description || 'unknown-goal');
    }
  }
  return {
    schema: 'home23.goal-state-integrity.v1',
    sourceIssues: [42, 52],
    completedInActive: completedInActiveIds.length,
    completedInActiveIds: completedInActiveIds.slice(0, 12),
  };
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

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = value / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)}MB`;
  return `${Math.round(value / 1024)}KB`;
}

function compactCommand(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const home23Match = text.match(/home23\/([^ ]+)/);
  if (home23Match?.[1]) return `home23/${home23Match[1]}`;
  const chromeMatch = text.match(/Google Chrome(?: Helper)?(?: \(([^)]+)\))?/);
  if (chromeMatch) return chromeMatch[1] ? `Google Chrome ${chromeMatch[1]}` : 'Google Chrome';
  return compactText(text, 80);
}

function summarizeHostPressureForOperator(host) {
  if (!host) return null;
  const parts = [];
  const swapPct = finiteCount(host.swap?.usedPct);
  if (swapPct != null) parts.push(`swap ${Math.round(swapPct)}% used`);
  const freePct = finiteCount(host.memory?.freePct);
  if (freePct != null) parts.push(`memory ${Number(freePct).toFixed(freePct < 10 ? 1 : 0)}% free`);

  const topMemory = host.process?.topMemoryProcess;
  const topMemoryBytes = formatBytes(topMemory?.rssBytes || host.process?.topRssBytes);
  const topMemoryName = compactCommand(topMemory?.pm2Name || topMemory?.command);
  if (topMemoryName && topMemoryBytes) {
    parts.push(`top memory ${topMemoryName} ${topMemoryBytes}`);
  }

  const topCpu = host.process?.topProcess;
  const topCpuPct = finiteCount(topCpu?.cpuPct || host.process?.topCpuPct);
  const topCpuName = compactCommand(topCpu?.pm2Name || topCpu?.command);
  if (topCpuName && topCpuPct != null) {
    parts.push(`top CPU ${topCpuName} ${Math.round(topCpuPct)}%`);
  }

  return parts.length ? parts.join('; ') : null;
}

function buildDailyReset(date, nowMs) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { resetAt: null, resetInMin: null, resetText: null };
  const resetMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  if (!Number.isFinite(resetMs)) return { resetAt: null, resetInMin: null, resetText: null };
  const resetInMin = Math.max(0, Math.ceil((resetMs - nowMs) / 60000));
  const hours = Math.floor(resetInMin / 60);
  const minutes = resetInMin % 60;
  let duration = `${minutes}m`;
  if (hours > 0) {
    duration = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return {
    resetAt: new Date(resetMs).toISOString(),
    resetInMin,
    resetText: `resets in ${duration}`,
  };
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
    suggestedWorker,
  };
}

function suggestAgendaWorker(row = {}, context = {}) {
  const text = `${row.content || ''} ${(row.topicTags || []).join(' ')}`.toLowerCase();
  if (row.workerRoute?.worker) return row.workerRoute;
  if (context.isGoodLife && /repair|recover|viability|friction|engine|process|pm2|host|cpu|memory pressure/.test(text)) {
    return {
      worker: 'systems',
      reason: 'Good Life host, process, or friction row needs current systems evidence',
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
  const topGoal = selectTopGoal(activeGoals);
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

function selectTopGoal(activeGoals = []) {
  if (!Array.isArray(activeGoals) || activeGoals.length === 0) return null;
  return activeGoals.find((goal) => goal.artifactStatus || goalArtifactText(goal))
    || activeGoals[0]
    || null;
}

function buildAutonomyBudget(regulator = {}, policy = {}, nowMs = Date.now()) {
  const daily = regulator?.daily || null;
  const dailyActions = Array.isArray(daily?.actions) ? daily.actions : [];
  const budgetedActions = dailyActions.filter((action) => goodLifeActionCountsAgainstSelfMaintenanceBudget(action));
  const bypassActions = dailyActions.filter((action) => !goodLifeActionCountsAgainstSelfMaintenanceBudget(action));
  const used = dailyActions.length
    ? budgetedActions.length
    : (finiteCount(daily?.selfMaintenanceActions) || 0);
  const limit = SELF_MAINTENANCE_DAILY_LIMIT;
  const remaining = Math.max(0, limit - used);
  const mode = String(policy?.mode || '').toLowerCase();
  const budgetedMode = !['repair', 'help'].includes(mode);
  const pressureRest = mode === 'rest'
    && Array.isArray(policy?.actionCard?.goodLifeLanes)
    && policy.actionCard.goodLifeLanes.includes('friction');
  const exhausted = budgetedMode && used >= limit;
  const bypassed = !budgetedMode && used >= limit;
  const reset = buildDailyReset(daily?.date, nowMs);
  const resetSuffix = reset.resetText ? `; ${reset.resetText}` : '';
  const pressureRestReason = `Good Life self-maintenance budget is ${used}/${limit}; pressure rest remains active through sleep/wake, while new self-maintenance agenda work waits for reset${resetSuffix}`;
  return {
    date: daily?.date || null,
    used,
    limit,
    remaining,
    exhausted,
    bypassed,
    bypassUsed: bypassActions.length,
    pressureRest,
    resetAt: reset.resetAt,
    resetInMin: reset.resetInMin,
    resetText: reset.resetText,
    mode,
    status: pressureRest && exhausted ? 'pressure-rest' : (exhausted ? 'exhausted' : (bypassed ? 'bypassed' : 'available')),
    reason: pressureRest && exhausted
      ? pressureRestReason
      : exhausted
      ? `Good Life self-maintenance budget is ${used}/${limit}; ${mode || 'current'} work is paused unless repair/help evidence appears${resetSuffix}`
      : bypassed
        ? `Good Life self-maintenance budget is ${used}/${limit}; ${mode} work can still run because repair/help bypasses the budget gate`
        : bypassActions.length
          ? `Good Life self-maintenance budget is ${used}/${limit}; ${bypassActions.length} repair/help action${bypassActions.length === 1 ? '' : 's'} bypassed the budget gate`
          : `Good Life self-maintenance budget is ${used}/${limit}`,
  };
}

function goodLifeActionCountsAgainstSelfMaintenanceBudget(action = {}) {
  if (action.budgetedSelfMaintenance === false) return false;
  const mode = String(action.mode || '').toLowerCase();
  const category = String(action.category || '').toLowerCase();
  if (mode === 'repair' || category === 'resolves-drift') return false;
  if (mode === 'help' || category === 'visible-progress') return false;
  return true;
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
  if (topGoal?.id) {
    return {
      status: 'working',
      needsUser: false,
      text: topGoalText(topGoal),
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
  const completedInActive = finiteCount(obligations?.counts?.integrity?.completedInActive);
  if (completedInActive != null && completedInActive > 0) {
    warnings.push({
      code: 'good_life_goal_state_integrity',
      severity: 'warning',
      message: `${completedInActive} completed goal${completedInActive === 1 ? '' : 's'} still appear active; repair goal state before treating the work loop as healthy`,
      fields: ['goals.active', 'goals.completed'],
      sourceIssues: [42, 52],
    });
  }
  if (
    hasObligationEvidence
    && obligations?.counts?.activeGoalsTrusted
    && projectedOpenGoals != null
    && activeGoalRows != null
    && projectedOpenGoals !== activeGoalRows
  ) {
    const projectionMs = toTimeMs(state?.evaluatedAt);
    const obligationMs = toTimeMs(obligations?.counts?.sourceUpdatedAt || obligations?.sourceUpdatedAt);
    if (projectionMs && obligationMs && obligationMs > projectionMs) {
      warnings.push({
        code: 'good_life_goal_projection_superseded',
        severity: 'info',
        message: `current goal snapshot supersedes Good Life goal projection: projected ${projectedOpenGoals}, active list ${activeGoalRows}`,
        fields: ['goals.open'],
      });
    } else {
      warnings.push({
        code: 'good_life_goal_projection_mismatch',
        severity: 'warning',
        message: `Good Life goal count disagrees with active goals: projected ${projectedOpenGoals}, active list ${activeGoalRows}`,
        fields: ['goals.open'],
      });
    }
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
    ok: warnings.every((warning) => warning.severity === 'info'),
    warnings,
  };
}

function buildInterventionReadiness({ policy, liveProblems, consistency, freshness, runtime, work }) {
  const activeProblem = liveProblems.open?.[0] || liveProblems.chronic?.[0] || null;
  const next = activeProblem?.nextRemediation || null;
  const decision = activeProblem
    ? {
      kind: 'repair_live_problem',
      subject: activeProblem.id || null,
      actuator: next?.type || 'worker_check',
    }
    : (work?.counts?.activeAgenda || work?.counts?.activeGoals)
      ? {
        kind: 'advance_good_life_work',
        subject: work.currentWork || null,
        actuator: policy.mode === 'ask' ? 'operator_request' : 'worker_or_goal_step',
      }
      : {
        kind: 'observe',
        subject: 'good-life-loop',
        actuator: 'none',
      };
  const known = [];
  const unknown = [];

  if (freshness.status === 'current') known.push(`Good Life projection current at ${freshness.evaluatedAt}`);
  else unknown.push(`Good Life projection freshness is ${freshness.status || 'unknown'}`);

  const counts = liveProblems.counts || {};
  known.push(`${Number(counts.open || 0)} open / ${Number(counts.chronic || 0)} chronic live problems in direct registry`);

  if (activeProblem) {
    known.push(`current problem state is ${activeProblem.state || 'unknown'} for ${activeProblem.id || 'unnamed problem'}`);
    if (activeProblem.detail) known.push(`last verifier detail: ${compactText(activeProblem.detail, 140)}`);
    else unknown.push('last verifier detail is absent');
    if (next?.type) known.push(`next remediation actuator is ${next.type}`);
    else unknown.push('next remediation actuator is not identified');
  }

  if (consistency.warnings.length) {
    for (const warning of consistency.warnings.filter((item) => item.severity !== 'info').slice(0, 4)) {
      unknown.push(warning.message || warning.code || 'operator consistency warning');
    }
  }
  for (const service of runtime?.services || []) {
    if (service?.ok === false || service?.slow === true || service?.degraded === true) {
      unknown.push(`${service.label || service.id || 'runtime service'} is ${service.ok === false ? 'unavailable' : 'degraded'}`);
    }
  }

  const identifiable = freshness.status === 'current'
    && !consistency.warnings.some((warning) => warning.severity === 'critical' || warning.code === 'good_life_projection_mismatch')
    && (!activeProblem || Boolean(activeProblem.detail || next?.type));
  const smallestRealAction = activeProblem
    ? (identifiable
      ? (next?.text || next?.type || 'run the bounded verifier-gated repair step')
      : 'run or dry-run the verifier before changing state')
    : (decision.kind === 'advance_good_life_work'
      ? 'advance one bounded worker or artifact step and return a receipt'
      : 'observe; do not intervene');

  return {
    schema: 'home23.intervention-readiness.v1',
    sourceIssues: INTERVENTION_READINESS_SOURCE_ISSUES,
    decision,
    identifiable,
    known,
    unknown,
    smallestRealAction,
    viewDiscipline: 'Dashboard and Good Life projection are views; direct registry, verifier receipts, and source artifacts win for their authority surface.',
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

function firstSourceIssue(entry = {}) {
  const issues = Array.isArray(entry.sourceIssues)
    ? entry.sourceIssues
    : (entry.sourceIssue != null ? [entry.sourceIssue] : []);
  for (const issue of issues) {
    const number = finiteCount(issue);
    if (number != null) return number;
  }
  return null;
}

function firstImplementationReceipt(entry = {}) {
  const receipts = Array.isArray(entry.implementationReceipts)
    ? entry.implementationReceipts
    : (entry.implementationReceipt ? [entry.implementationReceipt] : []);
  for (const receipt of receipts) {
    if (!receipt) continue;
    if (typeof receipt === 'string') {
      const value = receipt.trim();
      if (value) return { id: value };
      continue;
    }
    const commit = String(receipt.commit || '').trim();
    const verifier = String(receipt.verifier || '').trim();
    const artifact = String(receipt.artifact || '').trim();
    const id = String(receipt.id || '').trim();
    if (commit || verifier || artifact || id) {
      return {
        ...(id ? { id } : {}),
        ...(commit ? { commit } : {}),
        ...(verifier ? { verifier } : {}),
        ...(artifact ? { artifact } : {}),
      };
    }
  }
  return null;
}

function compactDoctrineEntry(entry = {}, { reusable = false, reason = null } = {}) {
  const sourceIssue = firstSourceIssue(entry);
  const implementationReceipt = firstImplementationReceipt(entry);
  return {
    id: entry.id || entry.key || compactText(entry.title || 'doctrine-entry', 64),
    title: compactText(entry.title || entry.requirement || entry.id || 'Doctrine entry', 140),
    status: entry.status || 'candidate',
    sourceIssue,
    sourceIssues: Array.isArray(entry.sourceIssues) ? entry.sourceIssues : (sourceIssue != null ? [sourceIssue] : []),
    implementationReceipt,
    doctrineFiles: Array.isArray(entry.doctrineFiles) ? entry.doctrineFiles : [],
    reusable,
    reason,
  };
}

function buildDoctrineAdoptionSnapshot(ledger = null, { source = null, now = new Date() } = {}) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const reusable = [];
  const blocked = [];

  for (const entry of entries) {
    const sourceIssue = firstSourceIssue(entry);
    const implementationReceipt = firstImplementationReceipt(entry);
    let reason = null;
    if (sourceIssue == null) reason = 'missing_source_issue';
    else if (!implementationReceipt) reason = 'missing_implementation_receipt';
    else if (entry.status && entry.status !== 'adopted') reason = 'not_adopted';

    if (reason) {
      blocked.push(compactDoctrineEntry(entry, { reusable: false, reason }));
    } else {
      reusable.push(compactDoctrineEntry(entry, { reusable: true }));
    }
  }

  return {
    schema: 'home23.from-the-inside.doctrine-adoption.snapshot.v1',
    generatedAt: new Date(toNowMs(now)).toISOString(),
    source,
    sourceIssueArc: ledger?.sourceIssueArc || null,
    counts: {
      total: entries.length,
      reusable: reusable.length,
      blocked: blocked.length,
    },
    reusable,
    blocked,
  };
}

function issueRowsByNumber(issueArc = null) {
  const rows = Array.isArray(issueArc?.rows) ? issueArc.rows : [];
  return new Map(rows.map((row) => [finiteCount(row?.number), row]).filter(([number]) => number != null));
}

function adoptedSourceIssueSet(doctrineAdoption = null) {
  const out = new Set();
  for (const entry of Array.isArray(doctrineAdoption?.entries) ? doctrineAdoption.entries : []) {
    if (entry?.status && entry.status !== 'adopted') continue;
    const receipt = firstImplementationReceipt(entry);
    if (!receipt) continue;
    const issues = Array.isArray(entry.sourceIssues)
      ? entry.sourceIssues
      : (entry.sourceIssue != null ? [entry.sourceIssue] : []);
    for (const issue of issues) {
      const number = finiteCount(issue);
      if (number != null) out.add(number);
    }
  }
  return out;
}

function directiveIncludes(row, pattern) {
  const directives = Array.isArray(row?.directives) ? row.directives : [];
  return directives.some((directive) => pattern.test(String(directive || '')));
}

function buildPublishingDistributionReadiness({ issueArc = null, doctrineAdoption = null, sources = {}, now = new Date() } = {}) {
  const byNumber = issueRowsByNumber(issueArc);
  const adopted = adoptedSourceIssueSet(doctrineAdoption);
  const rows = PUBLISHING_DISTRIBUTION_SOURCE_ISSUES
    .map((issue) => byNumber.get(issue))
    .filter(Boolean);
  const missingIssueRows = PUBLISHING_DISTRIBUTION_SOURCE_ISSUES.filter((issue) => !byNumber.has(issue));
  const missingDoctrine = PUBLISHING_DISTRIBUTION_SOURCE_ISSUES.filter((issue) => !adopted.has(issue));
  const issue = (number) => byNumber.get(number) || {};
  const permissionRow = issue(44);
  const counterRow = issue(51);
  const fallbackRow = issue(43);
  const audienceRows = [issue(45), issue(47)].filter((row) => row?.number);
  const productionRows = [issue(46), issue(50)].filter((row) => row?.number);

  const blockers = [
    {
      id: 'public-distribution-permission',
      status: directiveIncludes(permissionRow, /without asking|permission boundary|do not send/i)
        ? 'requires_operator_approval'
        : 'needs_review',
      sourceIssues: [44],
      evidence: compactText(permissionRow.directives?.find((text) => /without asking|permission|public posts/i.test(String(text))) || permissionRow.summary || '', 220),
      nextAction: 'prepare distribution artifacts, but do not send email, tweets, posts, or paid asks until jtr approves the channel and copy.',
    },
    {
      id: 'audience-identity',
      status: audienceRows.length ? 'needs_audience_receipt' : 'needs_review',
      sourceIssues: [45, 47],
      evidence: compactText(audienceRows.map((row) => row.summary || row.title).join(' '), 240),
      nextAction: 'record target audience, trust reason, and channel fit before judging output value by persuasion quality alone.',
    },
    {
      id: 'production-path',
      status: productionRows.length ? 'needs_distribution_receipt' : 'needs_review',
      sourceIssues: [46, 50],
      evidence: compactText(productionRows.map((row) => row.summary || row.title).join(' '), 240),
      nextAction: 'distinguish production readiness from production use; require a distribution, subscriber, or analytics receipt before claiming external value.',
    },
    {
      id: 'counter-truth',
      status: directiveIncludes(counterRow, /test accounts|counter|context/i)
        ? 'requires_metric_context'
        : 'needs_review',
      sourceIssues: [51],
      evidence: compactText(counterRow.directives?.find((text) => /test accounts|counter|context/i.test(String(text))) || counterRow.summary || '', 220),
      nextAction: 'counters must separate test/internal subscribers from real external readers before they are used as value evidence.',
    },
    {
      id: 'fallback-draft-pipeline',
      status: directiveIncludes(fallbackRow, /heartbeat|fallback|source 1 runs dry/i)
        ? 'needs_heartbeat_monitor'
        : 'needs_review',
      sourceIssues: [43],
      evidence: compactText(fallbackRow.directives?.find((text) => /heartbeat|fallback|source 1 runs dry/i.test(String(text))) || fallbackRow.summary || '', 220),
      nextAction: 'monitor fallback draft pipelines through heartbeat, but repair them only when primary operational output sources run dry.',
    },
  ];

  return {
    schema: 'home23.publishing-distribution-readiness.v1',
    generatedAt: new Date(toNowMs(now)).toISOString(),
    sourceIssues: PUBLISHING_DISTRIBUTION_SOURCE_ISSUES,
    source: {
      issueArc: sources.issueArc || null,
      doctrineAdoption: sources.doctrineAdoption || null,
    },
    status: missingIssueRows.length
      ? 'incomplete_issue_arc'
      : (missingDoctrine.length ? 'needs_doctrine_adoption' : 'contracted'),
    autonomousBoundary: 'prepare_only_until_operator_approval',
    requiresHumanApproval: rows.length > 0,
    rows: rows.map((row) => ({
      issue: row.number,
      title: row.title || '',
      slug: row.slug || null,
      directives: Array.isArray(row.directives) ? row.directives.slice(0, 4).map((text) => compactText(text, 220)) : [],
    })),
    blockers,
    missingIssueRows,
    missingDoctrine,
    nextOperatorRequest: {
      schema: 'home23.operator-request.v1',
      sourceIssues: [44, 46, 50, 51],
      actionText: 'Approve, defer, or reject public distribution channels before Home23 sends external marketing or subscriber-growth actions.',
      channel: 'home23-dashboard',
      deadlineAt: null,
      staleData: null,
      lastAutonomousAttempt: 'Issue arc reports prepared distribution strategy and working subscriber infrastructure, but public posting and outreach remain permission-gated.',
    },
    valueEvidenceContract: [
      'public outputs require channel approval before sending',
      'audience claims require target-audience and trust-context receipts',
      'subscriber and counter metrics must label test/internal accounts separately from real readers',
      'production readiness is not production value until distribution or analytics receipts exist',
    ],
  };
}

function classifyRuntimePressure({ host = null, budget = null } = {}) {
  const swapPct = finiteCount(host?.swap?.usedPct);
  const freePct = finiteCount(host?.memory?.freePct);
  if (swapPct == null && freePct == null && !budget?.pressureRest) return 'unknown';
  if ((swapPct != null && swapPct >= 85) || (freePct != null && freePct <= 3)) return 'critical';
  if ((swapPct != null && swapPct >= 70) || (freePct != null && freePct <= 10) || budget?.pressureRest) return 'strained';
  return 'healthy';
}

function buildRuntimeMaintenancePosture({
  state = null,
  issueArc = null,
  doctrineAdoption = null,
  sources = {},
  budget = null,
  freshness = null,
  now = new Date(),
} = {}) {
  const byNumber = issueRowsByNumber(issueArc);
  const adopted = adoptedSourceIssueSet(doctrineAdoption);
  const rows = RUNTIME_MAINTENANCE_SOURCE_ISSUES
    .map((issue) => byNumber.get(issue))
    .filter(Boolean);
  const missingIssueRows = RUNTIME_MAINTENANCE_SOURCE_ISSUES.filter((issue) => !byNumber.has(issue));
  const missingDoctrine = RUNTIME_MAINTENANCE_SOURCE_ISSUES.filter((issue) => !adopted.has(issue));
  const host = state?.evidence?.host || null;
  const pressure = classifyRuntimePressure({ host, budget });
  const pressureEvidence = summarizeHostPressureForOperator(host);
  const maintenanceRatio = finiteCount(state?.evidence?.actions?.maintenanceRatio);
  const freshnessStatus = freshness?.status || (state?.evaluatedAt ? 'current' : 'unknown');

  return {
    schema: 'home23.runtime-maintenance-posture.v1',
    generatedAt: new Date(toNowMs(now)).toISOString(),
    sourceIssues: RUNTIME_MAINTENANCE_SOURCE_ISSUES,
    source: {
      issueArc: sources.issueArc || null,
      doctrineAdoption: sources.doctrineAdoption || null,
    },
    status: missingIssueRows.length
      ? 'incomplete_issue_arc'
      : (missingDoctrine.length
        ? 'needs_doctrine_adoption'
        : (pressure === 'critical' ? 'pressure_critical' : (pressure === 'strained' ? 'pressure_strained' : 'contracted'))),
    pressure,
    rows: rows.map((row) => ({
      issue: row.number,
      title: row.title || '',
      slug: row.slug || null,
      directives: Array.isArray(row.directives) ? row.directives.slice(0, 4).map((text) => compactText(text, 220)) : [],
    })),
    missingIssueRows,
    missingDoctrine,
    startupContext: {
      status: freshnessStatus === 'current' ? 'context_current' : (freshnessStatus === 'stale' ? 'context_stale' : 'context_unknown'),
      contract: 'Read active memory, handoff, and current-state anchors before treating inherited context as action authority.',
      evidence: {
        evaluatedAt: state?.evaluatedAt || null,
        freshness: freshnessStatus,
      },
    },
    persistenceDiscipline: {
      status: 'selective_persistence',
      contract: 'Persist claims, corrections, receipts, operator decisions, and reusable artifacts; avoid durable noise from every tool call or intermediate step.',
    },
    resourceHeadroom: {
      status: pressure,
      evidence: pressureEvidence || null,
      swapUsedPct: finiteCount(host?.swap?.usedPct),
      memoryFreePct: finiteCount(host?.memory?.freePct),
      maintenanceRatio,
      topMemoryProcess: host?.process?.topMemoryProcess || null,
      topCpuProcess: host?.process?.topProcess || null,
      reliabilityGap: pressure === 'healthy'
        ? 'resource headroom is currently visible'
        : (pressure === 'unknown'
          ? 'resource headroom is not measured clearly enough to trust reliability claims'
          : 'the system may work, but reliability is constrained by measured host pressure'),
    },
    operatorContract: [
      'Maintenance is live governance, not background cleanup.',
      'A startup without current memory/context is not fully oriented.',
      'Durable memory should carry reusable evidence and receipts, not every ephemeral step.',
      'Reliability claims require visible resource headroom, especially swap and free memory.',
    ],
  };
}

function normalizeProviderRows(providerConfig = {}) {
  const providers = Array.isArray(providerConfig.providers)
    ? providerConfig.providers
    : Object.entries(providerConfig.providers || {}).map(([name, cfg]) => ({
      name,
      ...(cfg && typeof cfg === 'object' ? cfg : {}),
    }));
  return providers
    .map((provider) => ({
      name: String(provider.name || '').trim(),
      baseUrl: provider.baseUrl || provider.baseURL || null,
      defaultModels: Array.isArray(provider.defaultModels) ? provider.defaultModels.filter(Boolean).map(String) : [],
    }))
    .filter((provider) => provider.name);
}

function buildAutonomySubstratePosture({
  state = null,
  runtime = null,
  providerConfig = null,
  issueArc = null,
  doctrineAdoption = null,
  sources = {},
  now = new Date(),
} = {}) {
  const byNumber = issueRowsByNumber(issueArc);
  const adopted = adoptedSourceIssueSet(doctrineAdoption);
  const rows = AUTONOMY_SUBSTRATE_SOURCE_ISSUES
    .map((issue) => byNumber.get(issue))
    .filter(Boolean);
  const missingIssueRows = AUTONOMY_SUBSTRATE_SOURCE_ISSUES.filter((issue) => !byNumber.has(issue));
  const missingDoctrine = AUTONOMY_SUBSTRATE_SOURCE_ISSUES.filter((issue) => !adopted.has(issue));
  const providers = normalizeProviderRows(providerConfig || {});
  const agentProvider = String(providerConfig?.agent?.provider || '').trim();
  const agentModel = String(providerConfig?.agent?.model || '').trim();
  const localProviders = providers.filter((provider) => (
    provider.name === 'ollama-local'
    || provider.name === 'ollama'
    || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(String(provider.baseUrl || ''))
  ));
  const localModels = localProviders.flatMap((provider) => provider.defaultModels.map((model) => ({
    provider: provider.name,
    model,
  })));
  const currentProviderIsLocal = Boolean(agentProvider && localProviders.some((provider) => provider.name === agentProvider));
  const runtimeServices = Array.isArray(runtime?.services) ? runtime.services : [];
  const engineService = runtimeServices.find((service) => service.id === 'engine' || /engine/i.test(String(service.label || ''))) || null;
  const dashboardService = runtimeServices.find((service) => service.id === 'dashboard' || /dashboard/i.test(String(service.label || ''))) || null;
  const host = state?.evidence?.host || null;
  const alwaysOnEvidence = Boolean(state?.evaluatedAt || engineService?.ok || dashboardService?.ok || host);
  const externalDependencyOpen = !currentProviderIsLocal || localModels.length === 0;

  return {
    schema: 'home23.autonomy-substrate-posture.v1',
    generatedAt: new Date(toNowMs(now)).toISOString(),
    sourceIssues: AUTONOMY_SUBSTRATE_SOURCE_ISSUES,
    source: {
      issueArc: sources.issueArc || null,
      doctrineAdoption: sources.doctrineAdoption || null,
      providerConfig: sources.providerConfig || null,
    },
    status: missingIssueRows.length
      ? 'incomplete_issue_arc'
      : (missingDoctrine.length
        ? 'needs_doctrine_adoption'
        : (externalDependencyOpen ? 'external_model_dependency' : 'local_substrate_ready')),
    rows: rows.map((row) => ({
      issue: row.number,
      title: row.title || '',
      slug: row.slug || null,
      directives: Array.isArray(row.directives) ? row.directives.slice(0, 4).map((text) => compactText(text, 220)) : [],
    })),
    missingIssueRows,
    missingDoctrine,
    homeRuntime: {
      status: alwaysOnEvidence ? 'observed' : 'unknown',
      contract: 'Home23 is an always-on home-hosted runtime; process, host, and dashboard evidence must stay visible before autonomy claims are inherited.',
      evidence: {
        evaluatedAt: state?.evaluatedAt || null,
        runtimeOk: runtime?.ok ?? null,
        engineOk: engineService?.ok ?? null,
        dashboardOk: dashboardService?.ok ?? null,
        hostObserved: Boolean(host),
      },
    },
    modelSubstrate: {
      configuredProvider: agentProvider || null,
      configuredModel: agentModel || null,
      localProviders: localProviders.map((provider) => ({
        name: provider.name,
        baseUrl: provider.baseUrl,
        defaultModels: provider.defaultModels,
      })),
      localModelsAvailable: localModels,
      currentProviderIsLocal,
      externalDependencyOpen,
      autonomyGate: externalDependencyOpen
        ? 'core cognition still depends on an external model provider or has no confirmed local model inventory'
        : 'current cognition can route to a configured local model substrate',
    },
    operatorContract: [
      'Always-on local runtime is part of the product identity, not just deployment trivia.',
      'Local inference is a capability boundary: when absent, autonomy depends on external billing and provider access.',
      'Cheap local work should be routed to local models only when a configured local model inventory is actually present.',
    ],
  };
}

function buildProjectionProvenance({
  state,
  liveProblems,
  obligations,
  ledgerTail,
  consistency,
  freshness,
  runtime,
  sources = {},
  issueArc = null,
  doctrineAdoption = null,
  now = new Date(),
} = {}) {
  const liveCounts = liveProblems?.counts || {};
  const obligationCounts = obligations?.counts || {};
  const services = Array.isArray(runtime?.services) ? runtime.services : [];
  const source = (key, fallback) => sources[key] || fallback;
  const warnings = Array.isArray(consistency?.warnings) ? consistency.warnings : [];
  const correctionTombstones = buildCorrectionTombstones({
    projection: normalizeProjection(state),
    liveProblems,
    obligations,
    warnings,
    source,
  });
  const doctrineAdoptionSnapshot = buildDoctrineAdoptionSnapshot(doctrineAdoption, {
    source: source('doctrineAdoption', null),
    now,
  });
  return {
    schema: 'home23.good-life.provenance.v1',
    generatedAt: new Date(toNowMs(now)).toISOString(),
    doctrine: [
      {
        issue: 86,
        title: 'The Engineering of Auditability',
        requirement: 'operator claims must be reconstructable from evidence, not just logs',
      },
      {
        issue: 99,
        title: 'Merkleized Evidence & Verifiable Audit Trails',
        requirement: 'exact evidence identity matters where future action depends on proof',
      },
      {
        issue: 100,
        title: 'Event Sourcing for a Living Knowledge Graph',
        requirement: 'current state should be explainable as a projection over durable events',
      },
      {
        issue: 101,
        title: 'Manifest-First Verification for Real Work',
        requirement: 'allowed transitions need explicit verifier and receipt coverage',
      },
      {
        issue: 102,
        title: 'CRDTs for Narrative + State Coherence',
        requirement: 'current truth should be a projection with provenance',
      },
    ],
    curriculumArc: issueArc ? {
      schema: issueArc.schema || null,
      source: sources.issueArc || null,
      issuesRead: finiteCount(issueArc.count) || 0,
      firstIssue: finiteCount(issueArc.range?.first),
      lastIssue: finiteCount(issueArc.range?.last),
      missingIssues: Array.isArray(issueArc.range?.missing) ? issueArc.range.missing : [],
      themeCounts: Object.fromEntries(Object.entries(issueArc.themes || {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.length : 0,
      ])),
    } : null,
    doctrineAdoption: doctrineAdoptionSnapshot,
    projection: {
      kind: 'projection',
      surface: source('state', 'good-life-state.json'),
      evaluatedAt: state?.evaluatedAt || null,
      status: freshness?.status || 'unknown',
      authority: 'summarizes Good Life policy and lane state; does not outrank direct registries when counts conflict',
      claimTypes: ['policy', 'lane-status', 'summary', 'projection'],
    },
    evidence: [
      {
        kind: 'evidence',
        surface: source('liveProblems', 'live-problems.json'),
        authority: 'authoritative for current live-problem state',
        counts: {
          open: finiteCount(liveCounts.open) || 0,
          chronic: finiteCount(liveCounts.chronic) || 0,
          unverifiable: finiteCount(liveCounts.unverifiable) || 0,
          resolved: finiteCount(liveCounts.resolved) || 0,
        },
      },
      {
        kind: 'evidence',
        surface: source('ledger', 'good-life-ledger.jsonl'),
        authority: 'append-only Good Life evaluations and operator events',
        entriesSampled: Array.isArray(ledgerTail) ? ledgerTail.length : 0,
      },
      {
        kind: 'evidence',
        surface: source('agenda', 'agenda.jsonl'),
        authority: 'event stream for active Good Life work routing',
        counts: {
          activeAgenda: finiteCount(obligationCounts.activeAgenda) || 0,
          activeGoals: finiteCount(obligationCounts.activeGoals) || 0,
        },
      },
      {
        kind: 'evidence',
        surface: 'runtime health endpoints',
        authority: 'fresh process and service reachability sample',
        services: services.map((service) => ({
          id: service.id || null,
          ok: service.ok !== false,
          degraded: service.degraded === true,
          slow: service.slow === true,
        })),
      },
    ],
    mergeDiscipline: {
      dedupeKey: 'surface + authoritative subject + receipt/event identity',
      latestWins: false,
      rule: 'newer projections can summarize older evidence, but direct evidence wins for its own authority surface',
    },
    correctionPolicy: {
      tombstoneRequired: true,
      rule: 'operator corrections must demote the old governing claim without deleting the historical fact that it existed',
    },
    correctionTombstones,
    conflicts: warnings.map((warning) => ({
      code: warning.code || 'warning',
      severity: warning.severity || 'warning',
      message: warning.message || '',
      fields: Array.isArray(warning.fields) ? warning.fields : [],
    })),
  };
}

function buildCorrectionTombstones({
  projection,
  liveProblems,
  obligations,
  warnings = [],
  source = (_key, fallback) => fallback,
} = {}) {
  const tombstones = [];
  const warningCodes = new Set((Array.isArray(warnings) ? warnings : []).map((warning) => warning?.code));
  if (warningCodes.has('good_life_projection_mismatch')) {
    for (const key of ['open', 'chronic', 'unverifiable']) {
      const projected = finiteCount(projection?.liveProblems?.[key]);
      const direct = finiteCount(liveProblems?.counts?.[key]);
      if (projected == null || direct == null || projected === direct) continue;
      tombstones.push({
        schema: 'home23.good-life.correction-tombstone.v1',
        id: `good-life:${key}:projection-demoted`,
        subject: `liveProblems.${key}`,
        oldClaim: `Good Life projected ${projected} ${key} live problem${projected === 1 ? '' : 's'}`,
        correctedClaim: `live-problem registry reports ${direct} ${key} live problem${direct === 1 ? '' : 's'}`,
        oldSurface: source('state', 'good-life-state.json'),
        correctingSurface: source('liveProblems', 'live-problems.json'),
        authority: 'direct live-problem registry supersedes Good Life projection for current live-problem state',
        status: 'demotes_governing_claim',
        actionPosture: 'do_not_inherit_old_projection',
        sourceIssue: 102,
      });
    }
  }

  if (warningCodes.has('good_life_goal_projection_superseded')) {
    const projected = finiteCount(projection?.goals?.open);
    const direct = finiteCount(obligations?.counts?.activeGoals);
    if (projected != null && direct != null && projected !== direct) {
      tombstones.push({
        schema: 'home23.good-life.correction-tombstone.v1',
        id: 'good-life:goals:projection-demoted',
        subject: 'goals.open',
        oldClaim: `Good Life projected ${projected} open goal${projected === 1 ? '' : 's'}`,
        correctedClaim: `active goal snapshot reports ${direct} open goal${direct === 1 ? '' : 's'}`,
        oldSurface: source('state', 'good-life-state.json'),
        correctingSurface: source('agenda', 'agenda.jsonl'),
        authority: 'newer active-goal snapshot supersedes stale Good Life goal projection',
        status: 'demotes_governing_claim',
        actionPosture: 'do_not_inherit_old_projection',
        sourceIssue: 102,
      });
    }
  }

  return tombstones;
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
    problem.issue || problem.claim ? compactText(problem.issue || problem.claim, 120) : null,
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
    lines.push(formatRemediationLine(prefix, next, problem));
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

function remediationCooldownStatus(problem = {}, next = {}, nowMs = Date.now()) {
  const cooldownMin = finiteCount(next?.cooldownMin);
  const lastAt = toTimeMs(problem?.lastRemediation?.at);
  if (cooldownMin == null || cooldownMin <= 0 || !lastAt) return null;
  const elapsedMin = Math.max(0, Math.floor((nowMs - lastAt) / 60000));
  const remainingMin = Math.max(0, cooldownMin - elapsedMin);
  if (remainingMin <= 0) return null;
  const latest = problem.lastRemediation
    ? [problem.lastRemediation.type, problem.lastRemediation.outcome].filter(Boolean).join(' ')
    : null;
  return {
    remainingMin,
    text: `waiting ${formatMinutes(remainingMin)} before ${next.type || 'next step'} cooldown clears${latest ? `; latest attempt: ${latest}` : ''}`,
  };
}

function formatOperatorRequestContext(request = null) {
  if (!request) return '';
  const parts = [];
  if (request.channel) parts.push(request.channel);
  if (request.deadlineAt) parts.push(`deadline ${request.deadlineAt}`);
  if (request.staleData) {
    const stale = request.staleData;
    const source = stale.source || 'external data';
    const age = finiteCount(stale.ageDays);
    parts.push(`stale data ${source}${age != null ? ` ${age}d` : ''}`);
  }
  if (request.lastAutonomousAttempt) {
    parts.push(`last autonomous attempt: ${compactText(request.lastAutonomousAttempt, 90)}`);
  }
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

function summarizeOperatorRequestEvidence(request = null) {
  if (!request) return null;
  const bits = [];
  if (request.actionText) bits.push(compactText(request.actionText, 100));
  if (request.deadlineAt) bits.push(`deadline ${request.deadlineAt}`);
  if (request.staleData) {
    const source = request.staleData.source || 'external data';
    const age = finiteCount(request.staleData.ageDays);
    bits.push(`stale data ${source}${age != null ? ` ${age}d` : ''}`);
  }
  if (request.lastAutonomousAttempt) {
    bits.push(`last autonomous attempt: ${compactText(request.lastAutonomousAttempt, 90)}`);
  }
  return bits.join('; ');
}

function buildHandoffInheritance({ activeCount = 0, work = null, latestResolution = null, actionableWarnings = [] } = {}) {
  return {
    liveProblems: activeCount > 0,
    work: Number(work?.activeTotal || 0) > 0,
    latestResolution: !!latestResolution,
    warnings: Array.isArray(actionableWarnings) && actionableWarnings.length > 0,
  };
}

function formatRemediationLine(prefix, next = {}, problem = null, nowMs = Date.now()) {
  if (!next?.type && !next?.text) return null;
  if (problem?.escalated) {
    const latest = problem.lastRemediation
      ? [problem.lastRemediation.type, problem.lastRemediation.outcome].filter(Boolean).join(' ')
      : null;
    return `${prefix}: review escalated problem${next?.text ? ` - ${compactText(next.text, 120)}` : ''}${latest ? `; latest attempt: ${latest}` : ''}`;
  }
  const cooldown = remediationCooldownStatus(problem, next, nowMs);
  if (cooldown?.text) {
    return `${prefix}: ${cooldown.text}`;
  }
  const text = next.text && next.text !== next.type
    ? ` - ${compactText(next.text, 140)}`
    : '';
  return `${prefix}: ${next.type || 'next step'}${text}${formatOperatorRequestContext(next.operatorRequest)}`;
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

function buildOperatorBrief({ policy, liveProblems, consistency, work, latestAction, projection, freshness, budget, host, nowMs = Date.now() }) {
  const counts = liveProblems.counts || {};
  const activeCount = Number(counts.open || 0) + Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const activeProblem = firstActiveLiveProblem(liveProblems);
  const warnings = consistency?.warnings || [];
  const actionableWarnings = warnings.filter((warning) => warning.severity !== 'info');
  const projectionMismatch = buildProjectionMismatchText(projection, liveProblems);
  const latestResolution = Array.isArray(liveProblems.resolved) ? liveProblems.resolved[0] || null : null;
  const latestActionAgendaActive = latestAction?.workerRoute?.worker
    && isActiveAgendaStatus(latestAction.agendaStatus || 'candidate');
  const topAgendaWorkerRoute = !work?.topAgenda?.review?.recommended
    ? (work?.topAgenda?.workerRoute || work?.topAgenda?.review?.suggestedWorker || null)
    : null;

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
    why = activeProblem?.issue || activeProblem?.detail || activeProblem?.claim || 'Good Life reached a manual remediation step.';
    next = formatRemediationLine('User action', activeProblem?.nextRemediation, activeProblem, nowMs)
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
    why = activeProblem?.issue || activeProblem?.detail || activeProblem?.claim || policy?.reason || 'Good Life is repairing verified drift.';
    next = formatRemediationLine('Home23 next', activeProblem?.nextRemediation, activeProblem, nowMs)
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
  } else if (actionableWarnings.length > 0) {
    severity = actionableWarnings.some((warning) => warning.severity === 'critical') ? 'critical' : 'attention';
    status = severity === 'critical' ? 'Critical' : 'Attention';
    headline = actionableWarnings[0].message || 'Good Life has an operator warning';
    why = policy?.reason || actionableWarnings[0].code || 'Operator consistency warning is present.';
    next = freshness?.status === 'stale'
      ? 'Good Life needs a fresh evaluation before its projection is safe to inherit.'
      : 'Review the warning before treating the projection as current.';
    target = {
      tab: 'insights',
      id: null,
      label: 'Review Warning',
      worker: null,
    };
  } else if (budget?.pressureRest && budget?.exhausted) {
    severity = 'working';
    status = 'Resting';
    headline = 'Good Life rest remains active under host pressure';
    why = policy?.reason ? `${budget.reason}; current signal: ${policy.reason}` : budget.reason;
    const pressure = summarizeHostPressureForOperator(host);
    next = pressure
      ? `${pressure}. Sleep/wake can continue lowering pressure; new self-maintenance agenda work waits for budget reset or repair/help drift.`
      : 'sleep/wake can continue lowering pressure; new self-maintenance agenda work waits for budget reset or repair/help drift.';
    target = {
      tab: 'insights',
      id: null,
      label: 'Review Pressure',
      worker: null,
    };
  } else if (budget?.exhausted) {
    severity = work?.activeTotal > 0 ? 'attention' : 'clear';
    status = 'Paused';
    const requestedMode = policy?.mode ? `${policy.mode} requested` : 'current work requested';
    headline = `Good Life self-maintenance budget is spent; ${requestedMode}`;
    why = policy?.reason ? `${budget.reason}; current signal: ${policy.reason}` : budget.reason;
    const resetText = budget.resetText ? `the daily budget reset (${budget.resetText})` : 'the daily budget reset';
    next = work?.activeTotal > 0
      ? `${work.activeTotal} active work item${work.activeTotal === 1 ? '' : 's'} waiting for ${resetText} or fresh repair/help drift.`
      : `Autonomous repair/help can still run if drift appears; learning/rest work resumes after ${resetText}.`;
    target = {
      tab: work?.activeTotal > 0 ? 'work' : 'insights',
      id: work?.topAgenda?.id || work?.topGoal?.id || null,
      label: work?.activeTotal > 0 ? 'Review Paused Work' : 'Review Budget',
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
        : (topAgendaWorkerRoute?.worker
          ? `Open ${topAgendaWorkerRoute.worker}`
          : (latestActionAgendaActive ? `Open ${latestAction.workerRoute.worker}` : 'Review Work')),
      worker: work.topAgenda?.review?.recommended
        ? null
        : (topAgendaWorkerRoute?.worker || (latestActionAgendaActive ? latestAction.workerRoute.worker : null)),
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

function latestResolutionSummary(latestResolution) {
  if (!latestResolution) return 'No recent verified repair receipt';
  const verifier = latestResolution.lastResult?.detail
    || latestResolution.fixRecipe?.verifierStatus
    || latestResolution.evidence?.result
    || null;
  const recipeAt = toTimeMs(latestResolution.fixRecipe?.at);
  const openedAt = toTimeMs(latestResolution.openedAt);
  const recipeBelongsToCurrentOpenWindow = !openedAt || (recipeAt && recipeAt >= openedAt);
  if (latestResolution.fixRecipe?.summary && recipeBelongsToCurrentOpenWindow) {
    return latestResolution.fixRecipe.summary;
  }
  if (verifier) {
    return `Verifier passed: ${verifier}`;
  }
  if (latestResolution.evidence?.receiptId || latestResolution.evidence?.receiptPath) {
    return `Evidence receipt recorded for ${latestResolution.id || 'recent resolution'}`;
  }
  return latestResolution.claim || latestResolution.id || 'recent verified resolution';
}

function buildOperatorAnswer({ state, lanes, liveProblems, consistency, work, latestAction, budget, host }) {
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
      lines.push(`Latest verified resolution: ${compactText(latestResolutionSummary(latestResolution), 180)}`);
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

  if (budget?.pressureRest && budget?.exhausted) {
    const resetText = budget.resetText ? `; ${budget.resetText}` : '';
    lines.push(`Autonomy budget: ${budget.used}/${budget.limit} self-maintenance actions used; pressure rest remains active through sleep/wake; new agenda work waits for reset${resetText}`);
    const pressure = summarizeHostPressureForOperator(host);
    if (pressure) lines.push(`Host pressure: ${pressure}`);
  } else if (budget?.exhausted) {
    const resetText = budget.resetText ? `; ${budget.resetText}` : '';
    lines.push(`Autonomy budget: ${budget.used}/${budget.limit} self-maintenance actions used; ${budget.mode || 'current'} work is paused until reset or repair/help drift appears${resetText}`);
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

function buildOperatorDigest({ brief, liveProblems, work, budget, host, nowMs = Date.now() }) {
  const counts = liveProblems?.counts || {};
  const activeCount = Number(counts.open || 0) + Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const latestResolution = Array.isArray(liveProblems?.resolved) ? liveProblems.resolved[0] || null : null;
  const activeProblem = firstActiveLiveProblem(liveProblems || {});
  const workStatus = work?.statusText || 'no active routed work';

  let userAction = 'No user action needed right now.';
  if (interventionCount > 0) {
    userAction = formatRemediationLine('User action', activeProblem?.nextRemediation, activeProblem, nowMs)
      || 'User decision is required before autonomous repair can continue.';
  } else if (work?.agendaNeedingReview > 0 || work?.goalsNeedingReview > 0) {
    userAction = workStatus || 'Operator review is recommended for active work.';
  } else if (brief?.severity === 'critical') {
    userAction = brief.next || 'Review the warning before treating the projection as current.';
  } else if (budget?.pressureRest && budget?.exhausted) {
    const pressure = summarizeHostPressureForOperator(host);
    userAction = `No user action needed; Good Life is resting to reduce host pressure${pressure ? ` (${pressure})` : ''}${budget.resetText ? ` and self-maintenance ${budget.resetText}` : ''}.`;
  } else if (budget?.exhausted) {
    userAction = `No user action needed; Good Life self-maintenance is paused by daily budget${budget.resetText ? ` and ${budget.resetText}` : ''}.`;
  } else if (brief?.severity === 'attention') {
    userAction = brief.headline
      ? `No user action needed; Home23 is watching: ${brief.headline}`
      : 'No user action needed; Home23 is watching the warning.';
  }

  return {
    issue: activeCount > 0
      ? compactText(`${activeCount} active live problem${activeCount === 1 ? '' : 's'}: ${activeProblem?.issue || activeProblem?.claim || activeProblem?.id || 'operator issue'}`, 220)
      : 'No active live problems',
    currentWork: budget?.exhausted && work?.activeTotal > 0
      ? `Paused by daily budget: ${workStatus}`
      : (work?.activeTotal > 0 ? workStatus : 'No active routed work'),
    latestFix: latestResolution
      ? compactText(latestResolutionSummary(latestResolution), 220)
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

function buildOperatorHandoff({ brief, liveProblems, work, consistency, latestAction, budget, host, publishingDistribution, runtimeMaintenance, autonomySubstrate, nowMs = Date.now() }) {
  const counts = liveProblems?.counts || {};
  const activeCount = Number(counts.open || 0) + Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const latestResolution = Array.isArray(liveProblems?.resolved) ? liveProblems.resolved[0] || null : null;
  const activeProblem = firstActiveLiveProblem(liveProblems || {});
  const actionableWarnings = (consistency?.warnings || []).filter((warning) => warning.severity !== 'info');

  const situation = activeCount > 0
    ? `${activeCount} active live problem${activeCount === 1 ? '' : 's'}: ${compactText(activeProblem?.issue || activeProblem?.claim || activeProblem?.id || 'operator issue', 180)}`
    : actionableWarnings.length > 0
      ? compactText(actionableWarnings[0].message || brief?.headline || 'Operator warning present', 220)
      : 'No active live problems.';

  let repair = 'No autonomous repair is active; Home23 is monitoring verifier evidence.';
  if (activeCount > 0) {
    repair = formatRemediationLine('Next repair step', activeProblem?.nextRemediation, activeProblem, nowMs)
      || 'Autonomous remediation can continue from the recorded plan.';
  } else if (budget?.pressureRest && budget?.exhausted) {
    repair = budget.reason;
  } else if (budget?.exhausted) {
    repair = budget.reason;
  } else if (work?.activeTotal > 0) {
    repair = work.statusText || `${work.activeTotal} active Good Life work item${work.activeTotal === 1 ? '' : 's'}`;
  } else if (latestResolution) {
    repair = compactText(latestResolutionSummary(latestResolution), 260);
  }

  let userAction = 'No user action needed right now.';
  if (interventionCount > 0) {
    userAction = formatRemediationLine('User action', activeProblem?.nextRemediation, activeProblem, nowMs)
      || 'User decision is required before autonomous repair can continue.';
  } else if (work?.agendaNeedingReview > 0 || work?.goalsNeedingReview > 0) {
    userAction = work.statusText || 'Operator review is recommended for active work.';
  } else if (brief?.severity === 'critical') {
    userAction = brief.next || 'Review the warning before treating the projection as current.';
  } else if (budget?.pressureRest && budget?.exhausted) {
    userAction = `No user action needed; pressure rest is active and self-maintenance ${budget.resetText || 'resumes after the daily reset'}.`;
  } else if (budget?.exhausted) {
    userAction = `No user action needed; repair/help can still run if drift appears, and self-maintenance ${budget.resetText || 'resumes after the daily reset'}.`;
  }

  const evidence = [
    {
      label: 'Live registry',
      value: `${Number(counts.open || 0)} open / ${Number(counts.chronic || 0)} chronic`,
      detail: `${Number(counts.interventionRequired || 0)} ${Number(counts.interventionRequired || 0) === 1 ? 'needs' : 'need'} user intervention`,
    },
  ];
  const operatorRequest = activeProblem?.intervention?.request || activeProblem?.nextRemediation?.operatorRequest || null;
  if (interventionCount > 0 && operatorRequest) {
    evidence.push({
      label: 'Human blocker',
      value: operatorRequest.channel || operatorRequest.remediator || 'user action',
      detail: summarizeOperatorRequestEvidence(operatorRequest),
    });
  }
  if (budget?.exhausted) {
    evidence.push({
      label: 'Autonomy budget',
      value: `${budget.used}/${budget.limit}`,
      detail: budget.pressureRest
        ? (budget.resetText ? `pressure rest active; ${budget.resetText}` : 'pressure rest active; agenda work waits for reset')
        : (budget.resetText ? `self-maintenance paused; ${budget.resetText}` : 'self-maintenance paused until reset'),
    });
  }
  const pressure = summarizeHostPressureForOperator(host);
  if (pressure) {
    evidence.push({
      label: 'Host pressure',
      value: pressure,
      detail: host?.process?.topMemoryProcess?.command || host?.process?.topProcess?.command || '',
    });
  }
  if (actionableWarnings.length > 0) {
    evidence.push({
      label: 'Operator warning',
      value: actionableWarnings[0].code || 'warning',
      detail: actionableWarnings[0].message || '',
    });
  }
  if (latestAction?.workerRoute?.worker && isActiveAgendaStatus(latestAction.agendaStatus || 'candidate')) {
    evidence.push({
      label: 'Worker route',
      value: latestAction.workerRoute.worker,
      detail: latestAction.workerRoute.reason || latestAction.agendaId || '',
    });
  }
  if (latestResolution) {
    evidence.push({
      label: 'Latest resolution',
      value: latestResolution.id || 'resolution',
      detail: latestResolution.lastResult?.detail
        || latestResolution.fixRecipe?.verifierStatus
        || latestResolution.evidence?.result
        || latestResolution.claim
        || '',
    });
  }
  if (publishingDistribution?.requiresHumanApproval) {
    evidence.push({
      label: 'Output value',
      value: publishingDistribution.autonomousBoundary || 'prepare_only_until_operator_approval',
      detail: publishingDistribution.nextOperatorRequest?.actionText || 'Public distribution requires operator approval.',
    });
  }
  if (['pressure_strained', 'pressure_critical'].includes(runtimeMaintenance?.status)) {
    evidence.push({
      label: 'Runtime maintenance',
      value: runtimeMaintenance.pressure || 'unknown',
      detail: runtimeMaintenance.resourceHeadroom?.reliabilityGap || 'resource headroom constrains reliability',
    });
  }
  if (autonomySubstrate?.status === 'external_model_dependency') {
    evidence.push({
      label: 'Autonomy substrate',
      value: autonomySubstrate.modelSubstrate?.configuredProvider || 'external dependency',
      detail: autonomySubstrate.modelSubstrate?.autonomyGate || 'core cognition depends on an external model provider',
    });
  }

  return {
    schema: 'home23.operator-handoff.v1',
    generatedAt: new Date(nowMs).toISOString(),
    producer: 'good-life-operator',
    sourceIssues: OPERATOR_HANDOFF_SOURCE_ISSUES,
    inherits: buildHandoffInheritance({
      activeCount,
      work,
      latestResolution,
      actionableWarnings,
    }),
    status: brief?.status || 'Unknown',
    situation: compactText(situation, 260),
    repair: compactText(repair, 260),
    userAction: compactText(userAction, 260),
    needsUser: interventionCount > 0,
    target: brief?.target || null,
    evidence,
  };
}

function buildOperatorRings({ brief, liveProblems, work, consistency, freshness, latestAction, budget }) {
  const counts = liveProblems?.counts || {};
  const openCount = Number(counts.open || 0);
  const chronicCount = Number(counts.chronic || 0);
  const interventionCount = Number(counts.interventionRequired || 0);
  const activeCount = openCount + chronicCount;
  const warnings = Array.isArray(consistency?.warnings) ? consistency.warnings : [];
  const actionableWarning = warnings.find((warning) => warning.severity !== 'info') || null;
  const workActive = Number(work?.activeTotal || 0);

  let goodLifeState = brief?.severity || 'clear';
  let goodLifeLabel = brief?.status || 'Clear';
  let goodLifeDetail = brief?.needsUser
    ? (brief.next || 'User intervention is required before the loop can close.')
    : (brief?.headline || 'Good Life has no active user-facing issue.');
  if (!brief) {
    goodLifeState = 'unknown';
    goodLifeLabel = 'Unknown';
    goodLifeDetail = 'Good Life has not produced an operator brief yet.';
  }

  let internalState = 'clear';
  let internalLabel = 'Clear';
  let internalDetail = 'Verifier registry is clear and current.';
  if (interventionCount > 0) {
    internalState = 'needs-user';
    internalLabel = 'Needs jtr';
    internalDetail = `${interventionCount} verifier-gated issue${interventionCount === 1 ? '' : 's'} reached a user-intervention step.`;
  } else if (activeCount > 0) {
    internalState = 'repairing';
    internalLabel = 'Repairing';
    internalDetail = `${activeCount} verifier-gated issue${activeCount === 1 ? '' : 's'} still active.`;
  } else if (actionableWarning) {
    internalState = actionableWarning.severity === 'critical' ? 'critical' : 'attention';
    internalLabel = actionableWarning.severity === 'critical' ? 'Critical' : 'Attention';
    internalDetail = actionableWarning.message || actionableWarning.code || 'Operator consistency warning is present.';
  } else if (freshness?.status && freshness.status !== 'current') {
    internalState = freshness.status === 'stale' ? 'attention' : 'unknown';
    internalLabel = freshness.status === 'stale' ? 'Stale' : 'Unknown';
    internalDetail = freshness.evaluatedAt
      ? `Good Life evaluation is ${freshness.ageMin}m old.`
      : 'Good Life freshness is unknown.';
  }

  let workState = 'clear';
  let workLabel = 'Idle';
  let workDetail = 'No active routed work; monitoring continues.';
  if (budget?.pressureRest && budget?.exhausted) {
    workState = 'resting';
    workLabel = 'Resting';
    workDetail = budget.resetText
      ? `Pressure rest active; self-maintenance ${budget.resetText}.`
      : 'Pressure rest active; self-maintenance waits for reset.';
  } else if (budget?.exhausted) {
    workState = 'paused';
    workLabel = 'Paused';
    workDetail = budget.resetText
      ? `Daily self-maintenance budget spent; ${budget.resetText}.`
      : 'Daily self-maintenance budget spent.';
  } else if (work?.agendaNeedingReview > 0 || work?.goalsNeedingReview > 0) {
    workState = 'review';
    workLabel = 'Review';
    workDetail = work.statusText || 'Routed work needs operator review.';
  } else if (workActive > 0) {
    workState = 'working';
    workLabel = 'Working';
    workDetail = work.statusText || `${workActive} active routed work item${workActive === 1 ? '' : 's'}.`;
  } else if (latestAction?.workerRoute?.worker && isActiveAgendaStatus(latestAction.agendaStatus || 'candidate')) {
    workState = 'working';
    workLabel = 'Working';
    workDetail = `Worker route: ${latestAction.workerRoute.worker}${latestAction.workerRoute.reason ? ` - ${latestAction.workerRoute.reason}` : ''}`;
  }

  return [
    {
      id: 'good-life',
      name: 'Good Life',
      state: goodLifeState,
      label: goodLifeLabel,
      detail: compactText(goodLifeDetail, 180),
      action: brief?.target || { tab: 'issues', id: null, label: 'Open Details' },
    },
    {
      id: 'internal-check',
      name: 'Internal Check',
      state: internalState,
      label: internalLabel,
      detail: compactText(internalDetail, 180),
      action: { tab: activeCount > 0 || interventionCount > 0 ? 'issues' : 'insights', id: brief?.activeProblemId || null, label: activeCount > 0 ? 'Review Verifier' : 'Review Signals' },
      evidence: {
        open: openCount,
        chronic: chronicCount,
        interventionRequired: interventionCount,
        freshness: freshness?.status || 'unknown',
      },
    },
    {
      id: 'work-loop',
      name: 'Work Loop',
      state: workState,
      label: workLabel,
      detail: compactText(workDetail, 180),
      action: { tab: workActive > 0 ? 'work' : 'resolutions', id: work?.topAgenda?.id || work?.topGoal?.id || null, label: workActive > 0 ? 'Review Work' : 'View Receipts' },
      evidence: {
        activeWork: workActive,
        agendaNeedingReview: Number(work?.agendaNeedingReview || 0),
        goalsNeedingReview: Number(work?.goalsNeedingReview || 0),
      },
    },
  ];
}

function buildDetailSections({ commitments, trends, regulator, liveProblems, ledgerTail, restraintReceipts, obligations, budget, host, pm2, scheduler }) {
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
        selfMaintenanceActions: budget?.used ?? regulator.daily.selfMaintenanceActions ?? 0,
        selfMaintenanceLimit: budget?.limit ?? SELF_MAINTENANCE_DAILY_LIMIT,
        selfMaintenanceRemaining: budget?.remaining ?? null,
        selfMaintenanceExhausted: budget?.exhausted === true,
        bypassActions: budget?.bypassUsed ?? 0,
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
      host: host || null,
      pm2: pm2 || null,
      scheduler: scheduler || null,
      autonomyBudget: budget || null,
      ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-12).reverse().map(compactLedgerEntry) : [],
      restraintReceipts: Array.isArray(restraintReceipts) ? restraintReceipts.slice(-12).reverse() : [],
      correctionTombstones: [],
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
  restraintReceipts = [],
  obligations = null,
  runtime = null,
  sources = {},
  issueArc = null,
  doctrineAdoption = null,
  providerConfig = null,
  now = new Date(),
} = {}) {
  const nowMs = toNowMs(now);
  const policy = {
    mode: state?.policy?.mode || commitments?.policy?.mode || 'unknown',
    reason: state?.policy?.reason || commitments?.policy?.reason || null,
    actionCard: state?.policy?.actionCard || commitments?.policy?.actionCard || null,
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
  const budget = buildAutonomyBudget(regulator || {}, policy, nowMs);
  const consistency = buildConsistency({
    state,
    projection,
    liveProblems: directLiveProblems,
    obligations: currentObligations,
    hasObligationEvidence: !!obligations,
    freshness,
    runtime,
  });
  const interventionReadiness = buildInterventionReadiness({
    policy,
    liveProblems: directLiveProblems,
    consistency,
    freshness,
    runtime,
    work,
  });
  const publishingDistribution = buildPublishingDistributionReadiness({
    issueArc,
    doctrineAdoption,
    sources,
    now,
  });
  const runtimeMaintenance = buildRuntimeMaintenancePosture({
    state,
    issueArc,
    doctrineAdoption,
    sources,
    budget,
    freshness,
    now,
  });
  const autonomySubstrate = buildAutonomySubstratePosture({
    state,
    runtime,
    providerConfig,
    issueArc,
    doctrineAdoption,
    sources,
    now,
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
    interventionReadiness,
    publishingDistribution,
    runtimeMaintenance,
    autonomySubstrate,
    provenance: buildProjectionProvenance({
      state,
      liveProblems: directLiveProblems,
      obligations: currentObligations,
      ledgerTail,
      consistency,
      freshness,
      runtime,
      sources,
      issueArc,
      doctrineAdoption,
      now,
    }),
    latestRegulatorAction: latestAction,
    autonomyBudget: budget,
    trends: trends?.latest || null,
    ledgerTail: Array.isArray(ledgerTail) ? ledgerTail.slice(-5).map(compactLedgerEntry) : [],
  };
  model.detail = buildDetailSections({
    commitments: commitments || {},
    trends: trends || {},
    regulator: regulator || {},
    liveProblems: directLiveProblems,
    ledgerTail,
    restraintReceipts,
    obligations: currentObligations,
    budget,
    host: state?.evidence?.host || null,
    pm2: state?.evidence?.pm2 || null,
    scheduler: state?.evidence?.scheduler || null,
  });
  model.detail.insights.correctionTombstones = model.provenance.correctionTombstones;
  model.detail.insights.doctrineAdoption = model.provenance.doctrineAdoption;
  model.detail.insights.publishingDistribution = publishingDistribution;
  model.detail.insights.runtimeMaintenance = runtimeMaintenance;
  model.detail.insights.autonomySubstrate = autonomySubstrate;
  model.work = work;
  model.operatorAnswer = buildOperatorAnswer({
    state,
    lanes,
    liveProblems: directLiveProblems,
    consistency,
    work,
    latestAction,
    budget,
    host: state?.evidence?.host || null,
  });
  model.operatorBrief = buildOperatorBrief({
    policy,
    liveProblems: directLiveProblems,
    consistency,
    work,
    latestAction,
    projection,
    freshness,
    budget,
    host: state?.evidence?.host || null,
    nowMs,
  });
  if (status === 'conflicted') {
    model.summary = `${String(model.operatorBrief.status || 'Reconciling').toLowerCase()} - ${model.operatorBrief.headline}`;
  }
  model.operatorDigest = buildOperatorDigest({
    brief: model.operatorBrief,
    liveProblems: directLiveProblems,
    work,
    budget,
    host: state?.evidence?.host || null,
    nowMs,
  });
  model.operatorHandoff = buildOperatorHandoff({
    brief: model.operatorBrief,
    liveProblems: directLiveProblems,
    work,
    consistency,
    latestAction,
    budget,
    host: state?.evidence?.host || null,
    publishingDistribution,
    runtimeMaintenance,
    autonomySubstrate,
    nowMs,
  });
  model.operatorRings = buildOperatorRings({
    brief: model.operatorBrief,
    liveProblems: directLiveProblems,
    work,
    consistency,
    freshness,
    latestAction,
    budget,
  });
  return model;
}

module.exports = {
  buildGoodLifeOperatorModel,
  buildLiveProblemSnapshot,
  buildGoodLifeObligationSnapshot,
  buildDoctrineAdoptionSnapshot,
  buildPublishingDistributionReadiness,
  buildRuntimeMaintenancePosture,
  buildAutonomySubstratePosture,
};
