'use strict';

const DEFAULT_THRESHOLDS = Object.freeze({
  receiptStaleMinutes: 20,
  publishStaleMinutes: 360,
  noUsefulOutputHours: 24,
  liveProblemsCritical: 1,
  openGoalsHigh: 12,
  frictionFailuresHigh: 3,
  maintenanceRatioHigh: 0.3,
  hostLoadRatioHigh: 1,
  hostSwapPressureHigh: 85,
  hostSwapPressureCritical: 95,
  hostDiskUsageCritical: 95,
});

const LANE_ORDER = Object.freeze([
  'viability',
  'continuity',
  'usefulness',
  'development',
  'coherence',
  'friction',
  'recovery',
]);

const POLICY_PRIORITY = Object.freeze([
  'repair',
  'recover',
  'help',
  'learn',
  'play',
  'rest',
  'ask',
  'observe',
]);

class GoodLifeObjective {
  constructor(opts = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
    this.version = opts.version || 1;
  }

  evaluate(snapshot = {}) {
    const now = snapshot.now || new Date().toISOString();
    const lanes = {
      viability: this._viability(snapshot),
      continuity: this._continuity(snapshot),
      usefulness: this._usefulness(snapshot),
      development: this._development(snapshot),
      coherence: this._coherence(snapshot),
      friction: this._friction(snapshot),
      recovery: this._recovery(snapshot),
    };
    const policy = this._choosePolicy(lanes, snapshot);
    return {
      schema: 'home23.good-life.v1',
      version: this.version,
      evaluatedAt: now,
      lanes,
      policy,
      summary: summarize(lanes, policy),
      evidence: this._evidence(snapshot),
    };
  }

  _viability(s) {
    const problems = Number(s.liveProblems?.open || 0) + Number(s.liveProblems?.chronic || 0);
    const receiptsAgeMin = ageMinutes(s.crystallization?.lastReceiptAt, s.now);
    const pm2Offline = Number(s.pm2?.offline || 0);
    const staleReceipt = receiptsAgeMin != null && receiptsAgeMin > this.thresholds.receiptStaleMinutes;
    const diskUsagePct = Number(s.host?.disk?.usagePct);
    const swapUsedPct = Number(s.host?.swap?.usedPct);
    const diskCritical = Number.isFinite(diskUsagePct) && diskUsagePct >= this.thresholds.hostDiskUsageCritical;
    const swapCritical = Number.isFinite(swapUsedPct) && swapUsedPct >= this.thresholds.hostSwapPressureCritical;

    if (pm2Offline > 0 || problems >= this.thresholds.liveProblemsCritical || staleReceipt || diskCritical || swapCritical) {
      return lane('critical', [
        pm2Offline > 0 ? `${pm2Offline} home23 process(es) offline` : null,
        problems > 0 ? `${problems} unresolved live problem(s)` : null,
        staleReceipt ? `no crystallization receipt for ${Math.round(receiptsAgeMin)}m` : null,
        diskCritical ? `host disk ${Math.round(diskUsagePct)}% used` : null,
        swapCritical ? `host swap ${Math.round(swapUsedPct)}% used` : null,
      ]);
    }
    return lane('healthy', ['core engine evidence is flowing']);
  }

  _continuity(s) {
    const goals = Number(s.goals?.open || 0);
    const agenda = Number(s.agenda?.pending || 0);
    const nowAgeMin = ageMinutes(s.surfaces?.nowUpdatedAt, s.now);
    const staleNow = nowAgeMin != null && nowAgeMin > 60;
    if (staleNow || goals >= this.thresholds.openGoalsHigh || agenda > 20) {
      return lane('strained', [
        staleNow ? `NOW.md stale for ${Math.round(nowAgeMin)}m` : null,
        goals >= this.thresholds.openGoalsHigh ? `${goals} open goals` : null,
        agenda > 20 ? `${agenda} pending agenda item(s)` : null,
      ]);
    }
    return lane('healthy', ['session surfaces and obligations are in bounds']);
  }

  _usefulness(s) {
    const usefulAgeHr = ageHours(s.publish?.lastUsefulOutputAt, s.now);
    if (usefulAgeHr != null && usefulAgeHr > this.thresholds.noUsefulOutputHours) {
      return lane('strained', [`no jtr-visible useful output for ${Math.round(usefulAgeHr)}h`]);
    }
    if (s.recentUserRequest) return lane('watch', ['recent user request should outrank self-maintenance']);
    return lane('watch', ['usefulness must be proven by visible progress, not engine activity']);
  }

  _development(s) {
    const kept = Number(s.thinkingMachine?.cyclesKept || 0);
    const discarded = Number(s.thinkingMachine?.cyclesDiscarded || 0);
    const total = kept + discarded;
    if (total >= 5 && kept === 0) return lane('strained', ['recent thinking produced no kept thoughts']);
    if (s.discovery?.queueDepth > 0) return lane('healthy', [`${s.discovery.queueDepth} discovery candidate(s) available`]);
    return lane('watch', ['development signal exists but needs fresh learning-progress evidence']);
  }

  _coherence(s) {
    const nodes = Number(s.memory?.nodes || 0);
    const edges = Number(s.memory?.edges || 0);
    if (nodes > 0 && edges === 0) return lane('critical', ['memory has nodes but no edges']);
    if (nodes > 0 && edges / nodes < 0.2) return lane('watch', ['memory graph is sparse relative to node count']);
    return lane('healthy', ['memory graph has usable structure']);
  }

  _friction(s) {
    const failures = Number(s.actions?.recentFailures || 0);
    const maintenanceRatio = Number(s.actions?.maintenanceRatio || 0);
    const loadRatio = Number(s.host?.cpu?.loadRatio);
    const swapUsedPct = Number(s.host?.swap?.usedPct);
    const hostLoadHigh = Number.isFinite(loadRatio) && loadRatio >= this.thresholds.hostLoadRatioHigh;
    const hostSwapHigh = Number.isFinite(swapUsedPct) && swapUsedPct >= this.thresholds.hostSwapPressureHigh;
    if (failures >= this.thresholds.frictionFailuresHigh
      || maintenanceRatio > this.thresholds.maintenanceRatioHigh
      || hostLoadHigh
      || hostSwapHigh) {
      return lane('strained', [
        failures >= this.thresholds.frictionFailuresHigh ? `${failures} recent action failure(s)` : null,
        maintenanceRatio > this.thresholds.maintenanceRatioHigh ? `maintenance ratio ${(maintenanceRatio * 100).toFixed(0)}%` : null,
        hostLoadHigh ? `host load ${(loadRatio * 100).toFixed(0)}% of cores` : null,
        hostSwapHigh ? `host swap ${Math.round(swapUsedPct)}% used` : null,
      ]);
    }
    return lane('healthy', ['friction is not dominating the loop']);
  }

  _recovery(s) {
    if (s.sleep?.active) return lane('healthy', ['engine is in a recovery/consolidation phase']);
    if (s.crashRecovery?.crashDetected) return lane('critical', ['crash recovery is active']);
    return lane('watch', ['recovery is available but not currently needed']);
  }

  _choosePolicy(lanes, snapshot) {
    const candidates = [];
    for (const [name, detail] of Object.entries(lanes)) {
      if (detail.status === 'critical') candidates.push(policyForLane(name, 'critical'));
      if (detail.status === 'strained') candidates.push(policyForLane(name, 'strained'));
    }

    if (candidates.length === 0) {
      candidates.push(snapshot.recentUserRequest
        ? makePolicy('help', 'recent user intent outranks autonomous drift')
        : makePolicy('learn', 'no critical drift; pursue learning progress while staying useful'));
    }

    candidates.sort((a, b) => POLICY_PRIORITY.indexOf(a.mode) - POLICY_PRIORITY.indexOf(b.mode));
    const selected = candidates[0] || makePolicy('observe', 'no policy candidate');
    return {
      ...selected,
      actionCard: buildActionCard(selected, lanes),
    };
  }

  _evidence(s) {
    return {
      memory: s.memory || null,
      liveProblems: s.liveProblems || null,
      goals: s.goals || null,
      agenda: s.agenda || null,
      crystallization: s.crystallization || null,
      discovery: s.discovery || null,
      thinkingMachine: s.thinkingMachine || null,
      publish: s.publish || null,
      actions: s.actions || null,
      host: s.host || null,
      goodLife: s.goodLife || null,
    };
  }
}

function lane(status, reasons) {
  return {
    status,
    reasons: reasons.filter(Boolean),
  };
}

function policyForLane(name, status) {
  if (name === 'viability') return makePolicy('repair', `${status} viability drift`);
  if (name === 'recovery') return makePolicy('recover', `${status} recovery drift`);
  if (name === 'continuity') return makePolicy('help', `${status} continuity drift`);
  if (name === 'usefulness') return makePolicy('help', `${status} usefulness drift`);
  if (name === 'development') return makePolicy('learn', `${status} development drift`);
  if (name === 'coherence') return makePolicy('learn', `${status} coherence drift`);
  if (name === 'friction') return makePolicy('rest', `${status} friction drift`);
  return makePolicy('observe', `${status} ${name} drift`);
}

function makePolicy(mode, reason) {
  return { mode, reason };
}

function buildActionCard(policy, lanes) {
  const affected = LANE_ORDER.filter((name) => lanes[name]?.status !== 'healthy');
  const riskTier = ['repair', 'recover'].includes(policy.mode) ? 1 : 0;
  return {
    intent: policy.mode,
    goodLifeLanes: affected.length ? affected : ['development', 'usefulness'],
    evidenceRequired: true,
    riskTier,
    reversible: true,
    expectedOutcome: expectedOutcome(policy.mode),
    stopCondition: stopCondition(policy.mode),
  };
}

function expectedOutcome(mode) {
  if (mode === 'repair') return 'verified system evidence returns to healthy bounds';
  if (mode === 'recover') return 'engine reduces strain and preserves continuity';
  if (mode === 'help') return 'jtr-visible work advances or a blocked decision is surfaced';
  if (mode === 'learn') return 'new learning-progress evidence is produced and grounded';
  if (mode === 'play') return 'creative exploration produces a useful or memorable artifact';
  if (mode === 'rest') return 'loop pressure drops without losing obligations';
  if (mode === 'ask') return 'one concrete missing preference or fact is resolved';
  return 'state remains observable without adding churn';
}

function stopCondition(mode) {
  if (mode === 'repair') return 'verifier passes or repair path escalates';
  if (mode === 'recover') return 'critical recovery signal clears';
  if (mode === 'help') return 'action is completed, refused, or converted into a bounded goal';
  if (mode === 'learn') return 'finding is crystallized or discarded with evidence';
  if (mode === 'rest') return 'next observation cycle shows lower friction';
  if (mode === 'ask') return 'question is answered or expires';
  return 'next Good Life evaluation';
}

function summarize(lanes, policy) {
  const strained = LANE_ORDER
    .filter((name) => lanes[name]?.status !== 'healthy')
    .map((name) => `${name}:${lanes[name].status}`);
  return `${policy.mode} - ${policy.reason}${strained.length ? ` (${strained.join(', ')})` : ''}`;
}

function ageMinutes(iso, nowIso) {
  if (!iso) return null;
  const t = parseTime(iso);
  const now = parseTime(nowIso || new Date().toISOString());
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return Math.max(0, (now - t) / 60000);
}

function ageHours(iso, nowIso) {
  const min = ageMinutes(iso, nowIso);
  return min == null ? null : min / 60;
}

function parseTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

module.exports = {
  GoodLifeObjective,
  DEFAULT_THRESHOLDS,
  LANE_ORDER,
};
