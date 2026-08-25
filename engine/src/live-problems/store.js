/**
 * LiveProblemStore — registry of actively-tracked problems with deterministic
 * verifiers and ordered remediation plans.
 *
 * A live problem is a claim about current world state ("health log silent",
 * "disk free < 10 GiB", "home23-jerry-harness down") that can be checked
 * deterministically without an LLM. The pulse brief reads only CURRENT state
 * from this store rather than letting stale assertions loop forever through
 * thoughts.jsonl.
 *
 * Schema per problem:
 * {
 *   id: string (stable slug),
 *   claim: string (human-readable),
 *   problemKind?: 'agenda_handoff',
 *   handoff?: { status, startedAt, deadlineAt, outcome?, source?, detail?, terminalAt? },
 *   verifier: { type, args },
 *   remediation: [ { type, args, cooldownMin } ],      // ordered plan
 *   state: 'open' | 'resolved' | 'chronic' | 'unverifiable',
 *   seedOrigin: 'system' | 'curator' | 'user',
 *   openedAt, firstSeenAt, resolvedAt,
 *   lastCheckedAt, lastResult: { ok, detail, at },
 *   stepIndex, lastRemediationAt, remediationLog: [ { step, outcome, at } ],
 *   lastMentionedInPulseAt,
 *   escalated: boolean,
 *   escalatedAt,
 * }
 */

const fs = require('fs');
const path = require('path');
const {
  artifactFromPath,
  buildEvidenceReceipt,
  safeReceiptPart,
  writeEvidenceReceipt,
} = require('../evidence/evidence-v1');
const { EventLedger } = require('../core/event-ledger');
const { TrustKernel } = require('../trust/trust-kernel');

const RESOLVED_KEEP_MS = 24 * 60 * 60 * 1000;   // keep resolved 24h so pulse can mention once
const CHRONIC_AFTER_MS = 6 * 60 * 60 * 1000;    // open >6h with no progress → chronic
const AGENDA_HANDOFF_KIND = 'agenda_handoff';

/**
 * Agenda diagnostics are workflow handoffs, not claims that the underlying
 * operational condition is itself a live problem. New records carry an
 * explicit kind; the verifier + origin pair recognizes records written before
 * that field existed without relying on their generated IDs.
 */
function isAgendaHandoffProblem(problem) {
  if (!problem) return false;
  if (problem.problemKind === AGENDA_HANDOFF_KIND) return true;
  return problem.seedOrigin === 'agenda' && problem.verifier?.type === 'fix_recipe_recorded';
}

function latestAgendaFixRecipe(problem) {
  const sinceMs = Date.parse(problem?.verifier?.args?.since || '') || 0;
  return [
    ...(Array.isArray(problem?.fixRecipeHistory) ? problem.fixRecipeHistory : []),
    ...(problem?.fixRecipe ? [problem.fixRecipe] : []),
  ]
    .filter((recipe) => {
      if (!recipe) return false;
      const atMs = Date.parse(recipe.at || '') || 0;
      return !sinceMs || atMs >= sinceMs;
    })
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0] || null;
}

function agendaBudgetHours(problem) {
  const dispatchStep = (problem?.remediation || []).find((step) =>
    step?.type === 'dispatch_to_agent' || step?.type === 'dispatch_to_worker'
  );
  const value = Number(dispatchStep?.args?.budgetHours ?? 4);
  return Number.isFinite(value) && value >= 0 ? value : 4;
}

function agendaStartedAt(problem, fallback) {
  return problem?.handoff?.startedAt
    || problem?.verifier?.args?.since
    || problem?.openedAt
    || problem?.firstSeenAt
    || fallback;
}

function agendaDeadlineAt(problem, startedAt) {
  if (problem?.handoff?.deadlineAt) return problem.handoff.deadlineAt;
  const startedMs = Date.parse(startedAt || '');
  if (!startedMs) return null;
  return new Date(startedMs + agendaBudgetHours(problem) * 60 * 60 * 1000).toISOString();
}

function agendaOutcomeFromRecipe(recipe) {
  const dispatchOutcome = String(recipe?.dispatchOutcome || '').trim().toLowerCase();
  if (dispatchOutcome) return dispatchOutcome;
  return String(recipe?.verifierStatus || '').toLowerCase() === 'pass'
    ? 'fixed'
    : 'recipe_recorded';
}

function agendaOutcomeFromRemediation(problem) {
  const last = Array.isArray(problem?.remediationLog) ? problem.remediationLog.at(-1) : null;
  const detail = String(last?.detail || 'agenda handoff remediation exhausted');
  if (/budget exhausted/i.test(detail)) return { outcome: 'budget_exhausted', detail };
  if (last?.outcome === 'rejected') return { outcome: 'dispatch_rejected', detail };
  return { outcome: 'dispatch_failed', detail };
}

function applyAgendaHandoffTerminal(problem, {
  outcome,
  detail,
  source,
  terminalAt,
} = {}) {
  const at = terminalAt || new Date().toISOString();
  const startedAt = agendaStartedAt(problem, at);
  problem.problemKind = AGENDA_HANDOFF_KIND;
  problem.handoff = {
    ...(problem.handoff || {}),
    status: 'terminal',
    startedAt,
    deadlineAt: agendaDeadlineAt(problem, startedAt),
    outcome: outcome || 'unknown',
    source: source || 'workflow',
    detail: detail || '',
    terminalAt: at,
  };
  problem.state = 'resolved';
  problem.resolvedAt = problem.resolvedAt || at;
  problem.resolutionKind = 'workflow_terminal';
  problem.escalated = false;
  delete problem.escalatedAt;
  delete problem.dispatchedAt;
  delete problem.dispatchedTurnId;
}

/**
 * Operator authority: jtr's decision about a problem, held alongside — never
 * inside — the verifier's result. A closed problem stays resolved while its
 * verifier keeps failing honestly in `lastResult`; a muted problem keeps its
 * real state and only stops consuming remediation budget. Neither one is ever
 * allowed to rewrite what the check actually observed.
 */
function isOperatorSuppressed(problem, nowMs = Date.now()) {
  if (!problem) return false;
  if (problem.operatorDecision?.kind === 'closed') return true;
  const untilMs = problem.mutedUntil ? Date.parse(problem.mutedUntil) : 0;
  return Boolean(untilMs) && untilMs > nowMs;
}

function isTransientVerifierFailure(result) {
  if (result?.ok) return false;
  const detail = String(result?.detail || '').toLowerCase();
  return detail.includes('fetch failed')
    || detail.includes('operation was aborted')
    || detail.includes('timeout')
    || detail.includes('econnreset')
    || detail.includes('econnrefused')
    || detail.includes('missing selected array element');
}

class LiveProblemStore {
  constructor({ brainDir, logger }) {
    this.brainDir = brainDir;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.filePath = path.join(brainDir, 'live-problems.json');
    this.problems = new Map();
    this._lastLoadMtimeMs = 0;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      this._lastLoadMtimeMs = stat.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = raw.problems || [];
      this.problems.clear();
      for (const p of list) this.problems.set(p.id, p);
      const reconciled = this._reconcileAgendaHandoffs();
      this.logger.info?.(`[live-problems] loaded ${this.problems.size} problems`);
      if (reconciled > 0) {
        this.save();
        this.logger.info?.(`[live-problems] reconciled ${reconciled} agenda handoff record(s)`);
      }
    } catch (err) {
      this.logger.warn?.(`[live-problems] load failed: ${err.message}`);
    }
  }

  /**
   * Reload from disk if the file has been modified since the last load.
   * Called at the top of each tick so external edits (dashboard UI, hand-edits
   * to live-problems.json) are picked up without an engine restart.
   */
  reloadIfChanged() {
    try {
      if (!fs.existsSync(this.filePath)) return false;
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs === this._lastLoadMtimeMs) return false;
      this.load();
      return true;
    } catch {
      return false;
    }
  }

  save() {
    try {
      const list = [...this.problems.values()];
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ problems: list }, null, 2));
      fs.renameSync(tmp, this.filePath);
      try { this._lastLoadMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch {}
    } catch (err) {
      this.logger.warn?.(`[live-problems] save failed: ${err.message}`);
    }
  }

  /**
   * Upgrade legacy agenda handoffs and close only those that already have a
   * terminal receipt, exhausted plan, or expired dispatch budget. This runs on
   * load, mutates no remediation/fix-recipe history, and becomes a no-op after
   * the first successful reconciliation.
   */
  _reconcileAgendaHandoffs(nowMs = Date.now()) {
    let reconciled = 0;
    for (const problem of this.problems.values()) {
      if (!isAgendaHandoffProblem(problem)) continue;

      let changed = false;
      if (problem.problemKind !== AGENDA_HANDOFF_KIND) {
        problem.problemKind = AGENDA_HANDOFF_KIND;
        changed = true;
      }

      if (problem.handoff?.status === 'terminal') {
        if (changed) reconciled++;
        continue;
      }

      const now = new Date(nowMs).toISOString();
      const startedAt = agendaStartedAt(problem, now);
      const pending = {
        ...(problem.handoff || {}),
        status: 'pending',
        startedAt,
        deadlineAt: agendaDeadlineAt(problem, startedAt),
      };
      if (JSON.stringify(problem.handoff || null) !== JSON.stringify(pending)) {
        problem.handoff = pending;
        changed = true;
      }

      const recipe = latestAgendaFixRecipe(problem);
      const plan = Array.isArray(problem.remediation) ? problem.remediation : [];
      const stepIndex = Number(problem.stepIndex || 0);
      const exhausted = plan.length > 0 && stepIndex >= plan.length;
      const dispatchedAtMs = Date.parse(problem.dispatchedAt || '') || 0;
      const budgetExpired = dispatchedAtMs > 0
        && nowMs - dispatchedAtMs >= agendaBudgetHours(problem) * 60 * 60 * 1000;

      let terminal = null;
      if (problem.state === 'resolved') {
        terminal = recipe
          ? {
            outcome: agendaOutcomeFromRecipe(recipe),
            detail: recipe.summary || `recipe recorded (${recipe.dispatchOutcome || 'unknown'})`,
          }
          : { outcome: 'legacy_resolved', detail: problem.lastResult?.detail || 'legacy handoff resolved' };
      } else if (budgetExpired) {
        terminal = {
          outcome: 'budget_exhausted',
          detail: `agenda handoff dispatch budget exhausted (${agendaBudgetHours(problem)}h)`,
        };
      } else if (exhausted) {
        terminal = agendaOutcomeFromRemediation(problem);
      }

      if (terminal) {
        applyAgendaHandoffTerminal(problem, {
          ...terminal,
          source: 'legacy_reconciliation',
          terminalAt: problem.resolvedAt || now,
        });
        changed = true;
      }

      if (changed) {
        problem.updatedAt = now;
        reconciled++;
      }
    }
    return reconciled;
  }

  _touch(p, now = new Date().toISOString()) {
    if (p) p.updatedAt = now;
    return now;
  }

  all() {
    return [...this.problems.values()];
  }

  open() {
    return this.all().filter(p => p.state === 'open' || p.state === 'chronic');
  }

  get(id) {
    return this.problems.get(id);
  }

  upsert(problem) {
    if (!problem.id) throw new Error('problem.id required');
    const existing = this.problems.get(problem.id);
    const now = new Date().toISOString();
    if (existing) {
      this._touch(existing, now);
      // Preserve runtime state fields when caller re-declares spec
      this.problems.set(problem.id, {
        ...existing,
        ...problem,
        firstSeenAt: existing.firstSeenAt || now,
        updatedAt: now,
      });
    } else {
      this.problems.set(problem.id, {
        state: problem.verifier ? 'open' : 'unverifiable',
        seedOrigin: problem.seedOrigin || 'system',
        firstSeenAt: now,
        openedAt: now,
        stepIndex: 0,
        remediationLog: [],
        escalated: false,
        updatedAt: now,
        ...problem,
      });
    }
    this.save();
    return this.problems.get(problem.id);
  }

  remove(id) {
    const had = this.problems.delete(id);
    if (had) this.save();
    return had;
  }

  recordVerification(id, result) {
    const p = this.problems.get(id);
    if (!p) return;
    const now = new Date().toISOString();
    const priorState = p.state;
    let resolvedTransition = false;
    this._touch(p, now);
    p.lastCheckedAt = now;
    if (!result.ok && p.state === 'resolved' && isTransientVerifierFailure(result)) {
      // Keep the last successful verifier result authoritative while counting
      // the transient miss separately. Otherwise dashboards/dispatchers that
      // look at lastResult instead of state resurrect already-resolved problems.
      p.transientFailureCount = (p.transientFailureCount || 0) + 1;
      p.lastTransientFailure = { ...result, at: now };
      if (p.lastResult?.ok) p.lastSuccessfulResult = p.lastSuccessfulResult || { ...p.lastResult };
      if (!p.lastResult?.ok && p.lastSuccessfulResult?.ok) p.lastResult = { ...p.lastSuccessfulResult };
      this.save();
      return;
    }
    p.lastResult = { ...result, at: now };
    if (result.ok) {
      p.lastSuccessfulResult = { ...p.lastResult };
      delete p.transientFailureCount;
      delete p.lastTransientFailure;
      if (p.state !== 'resolved') {
        resolvedTransition = true;
        p.state = 'resolved';
        p.resolvedAt = now;
        p.stepIndex = 0;
        this.logger.info?.(`[live-problems] resolved: ${id}`);
      }
      // The condition is genuinely healthy, so the override has nothing left
      // to override — drop it rather than let a stale decision linger.
      delete p.operatorDecision;
      p.escalated = false;
      delete p.escalatedAt;
      if (isAgendaHandoffProblem(p)) {
        applyAgendaHandoffTerminal(p, {
          outcome: String(result.observed?.dispatchOutcome || '').toLowerCase() || 'recipe_recorded',
          detail: result.detail || '',
          source: 'fix_recipe',
          terminalAt: now,
        });
      }
    } else {
      delete p.transientFailureCount;
      delete p.lastTransientFailure;
      // Operator closed this one. lastResult above already recorded the real
      // failure; state stays closed until they reopen it.
      if (p.operatorDecision?.kind === 'closed') {
        this.save();
        return;
      }
      // Re-open if previously resolved
      if (p.state === 'resolved') {
        p.state = 'open';
        p.openedAt = now;
        p.resolvedAt = null;
        p.stepIndex = 0;
        p.escalated = false;
      }
      // Promote to chronic if open too long with no remediation progress
      if (p.state === 'open') {
        const openedMs = Date.parse(p.openedAt || p.firstSeenAt || now);
        if (Date.now() - openedMs > CHRONIC_AFTER_MS) p.state = 'chronic';
      }
    }
    this.save();
    if (resolvedTransition) this._writeResolutionReceipt(p, result, priorState, now);
  }

  _recordOperatorAction(p, kind, { actor, reason } = {}, now) {
    p.remediationLog = (p.remediationLog || []).concat([{
      step: Number(p.stepIndex || 0),
      type: 'operator_action',
      outcome: 'accepted',
      actor: actor || 'operator',
      detail: `${kind}: ${reason || '(no reason given)'}`,
      at: now,
    }]);
    if (p.remediationLog.length > 50) p.remediationLog = p.remediationLog.slice(-50);
  }

  /**
   * Operator closes the problem: their judgment outranks the verifier for
   * state, and only for state. The failing `lastResult` is left untouched so
   * the dashboard can show "closed by jtr — check still failing".
   */
  operatorClose(id, { actor, reason } = {}) {
    const p = this.problems.get(id);
    if (!p) return null;
    const now = this._touch(p);
    p.operatorDecision = { kind: 'closed', at: now, actor: actor || 'operator', reason: reason || '' };
    p.state = 'resolved';
    p.resolvedAt = now;
    p.stepIndex = 0;
    p.escalated = false;
    delete p.escalatedAt;
    delete p.dispatchedAt;
    delete p.dispatchedTurnId;
    this._recordOperatorAction(p, 'close', { actor, reason }, now);
    this.save();
    return p;
  }

  /** Hand the problem back to the verifier. */
  operatorReopen(id, { actor, reason } = {}) {
    const p = this.problems.get(id);
    if (!p) return null;
    const now = this._touch(p);
    delete p.operatorDecision;
    delete p.mutedUntil;
    p.state = 'open';
    p.openedAt = now;
    p.resolvedAt = null;
    p.stepIndex = 0;
    p.escalated = false;
    delete p.escalatedAt;
    this._recordOperatorAction(p, 'reopen', { actor, reason }, now);
    this.save();
    return p;
  }

  /**
   * Stand down remediation until `untilIso` without pretending the problem is
   * gone. State is deliberately left alone — this is a budget control, not a
   * claim about the world.
   */
  operatorMute(id, { actor, reason, untilIso } = {}) {
    const p = this.problems.get(id);
    if (!p) return null;
    const now = this._touch(p);
    p.mutedUntil = untilIso || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    p.operatorDecision = {
      kind: 'muted', at: now, actor: actor || 'operator', reason: reason || '', until: p.mutedUntil,
    };
    // A muted problem must not keep a dispatch open, or it spends the whole
    // wall-clock budget on a turn nobody is waiting for.
    delete p.dispatchedAt;
    delete p.dispatchedTurnId;
    this._recordOperatorAction(p, 'mute', { actor, reason: `${reason || ''} (until ${p.mutedUntil})` }, now);
    this.save();
    return p;
  }

  operatorUnmute(id, { actor, reason } = {}) {
    const p = this.problems.get(id);
    if (!p) return null;
    const now = this._touch(p);
    delete p.mutedUntil;
    if (p.operatorDecision?.kind === 'muted') delete p.operatorDecision;
    this._recordOperatorAction(p, 'unmute', { actor, reason }, now);
    this.save();
    return p;
  }

  recordRemediation(id, entry) {
    const p = this.problems.get(id);
    if (!p) return;
    const now = new Date().toISOString();
    this._touch(p, now);
    p.lastRemediationAt = now;
    p.remediationLog = (p.remediationLog || []).concat([{ ...entry, at: now }]);
    // Keep log bounded
    if (p.remediationLog.length > 50) p.remediationLog = p.remediationLog.slice(-50);
    this.save();
  }

  advanceRemediationStep(id) {
    const p = this.problems.get(id);
    if (!p) return;
    this._touch(p);
    p.stepIndex = (p.stepIndex || 0) + 1;
    // Reset cooldown marker — a fresh step shouldn't inherit the previous
    // step's timestamp. Without this, advancing from step 0 (just tried) to
    // step 1 (never tried) would leave step 1 in cooldown for no reason.
    p.lastRemediationAt = null;
    this.save();
  }

  recordDispatch(id, { turnId } = {}) {
    const p = this.problems.get(id);
    if (!p) return;
    const now = this._touch(p);
    p.dispatchedAt = now;
    p.dispatchedTurnId = turnId || null;
    this.save();
  }

  clearDispatch(id) {
    const p = this.problems.get(id);
    if (!p) return;
    this._touch(p);
    delete p.dispatchedAt;
    delete p.dispatchedTurnId;
    this.save();
  }

  completeAgendaHandoff(id, { outcome, detail, source } = {}) {
    const p = this.problems.get(id);
    if (!p || !isAgendaHandoffProblem(p)) return null;
    const now = this._touch(p);
    applyAgendaHandoffTerminal(p, { outcome, detail, source, terminalAt: now });
    this.save();
    return p;
  }

  markEscalated(id) {
    const p = this.problems.get(id);
    if (!p) return;
    const now = this._touch(p);
    p.escalated = true;
    p.escalatedAt = now;
    this.save();
  }

  markMentionedInPulse(id) {
    const p = this.problems.get(id);
    if (!p) return;
    const now = this._touch(p);
    p.lastMentionedInPulseAt = now;
    this.save();
  }

  _writeResolutionReceipt(problem, verifierResult, priorState, at) {
    try {
      const sourceArtifacts = [];
      const checks = [
        {
          name: 'verifier_pass',
          pass: Boolean(verifierResult?.ok),
          detail: verifierResult?.detail || null,
          observed: verifierResult?.observed || null,
          verifier: problem.verifier || null,
        },
        {
          name: 'state_resolved',
          pass: problem.state === 'resolved',
          detail: `state=${problem.state}`,
          observed: { priorState, resolvedAt: problem.resolvedAt || null },
        },
        {
          name: 'result_recorded',
          pass: problem.lastResult?.at === at && problem.lastResult?.ok === true,
          detail: problem.lastResult?.at || 'missing lastResult.at',
        },
      ];

      try {
        sourceArtifacts.push(artifactFromPath(this.filePath, { role: 'live_problems_store' }));
        checks.push({ name: 'store_hashed', pass: true, detail: this.filePath });
      } catch (err) {
        checks.push({ name: 'store_hashed', pass: false, detail: err.message });
      }

      const receipt = buildEvidenceReceipt({
        actor: 'home23-live-problems',
        action: 'resolve_live_problem',
        subject: `live-problem/${problem.id}`,
        sourceSurface: {
          type: 'live-problems',
          path: this.filePath,
          problemId: problem.id,
        },
        sourceArtifacts,
        derivedArtifacts: [],
        checks,
        createdAt: at,
        metadata: {
          problemId: problem.id,
          claim: problem.claim || null,
          seedOrigin: problem.seedOrigin || null,
          problemKind: problem.problemKind || null,
          handoff: problem.handoff || null,
          verifier: problem.verifier || null,
          priorState,
          resolvedAt: problem.resolvedAt || null,
          fixRecipe: problem.fixRecipe || null,
        },
      });

      const stamp = at.replace(/[^0-9]/g, '').slice(0, 14);
      const safeId = safeReceiptPart(problem.id);
      const receiptPath = path.join(this.brainDir, 'evidence', 'live-problems', `${stamp}-${safeId}.evidence.json`);
      const indexPath = path.join(this.brainDir, 'evidence', 'live-problems.jsonl');
      writeEvidenceReceipt({ receipt, receiptPath, indexPath });
      problem.evidence = {
        receiptId: receipt.receiptId,
        receiptPath,
        result: receipt.result,
        claimLevel: receipt.claimLevel,
        createdAt: receipt.createdAt,
      };
      this.save();
      const ledger = new EventLedger(this.brainDir, { logger: this.logger });
      ledger.recordStateTransition({
        eventType: 'live_problem.fixed',
        subject: `live-problem/${problem.id}`,
        actor: 'home23-live-problems',
        payload: {
          problemId: problem.id,
          claim: problem.claim || null,
          priorState,
          state: problem.state,
          verifier: problem.verifier || null,
          verifierDetail: verifierResult?.detail || null,
        },
        evidence: {
          receiptId: receipt.receiptId,
          receiptPath,
          result: receipt.result,
          claimLevel: receipt.claimLevel,
        },
        sourceSurface: {
          type: 'live-problems',
          path: this.filePath,
          problemId: problem.id,
        },
        occurredAt: at,
      });
      const trust = new TrustKernel({ brainDir: this.brainDir, logger: this.logger });
      trust.recordVerifiedClaim({
        claim: {
          id: `live-problem.${safeId}.fixed`,
          type: 'live_problem.fixed',
          subject: `live-problem/${problem.id}`,
          predicate: 'state',
          value: 'resolved',
          actor: 'home23-live-problems',
          observedAt: at,
          sourceRefs: [{
            type: 'file',
            path: this.filePath,
            problemId: problem.id,
          }],
          confidence: 1,
          scope: 'live_problem',
          privacyClass: 'operational_internal',
          verifier: problem.verifier || null,
        },
        receipt,
        receiptPath,
      });
    } catch (err) {
      this.logger.warn?.(`[live-problems] evidence receipt write failed: ${err.message}`);
    }
  }

  /** Drop resolved problems past the keep window. */
  pruneResolved() {
    const now = Date.now();
    let removed = 0;
    for (const [id, p] of this.problems) {
      if (p.state !== 'resolved') continue;
      if (isAgendaHandoffProblem(p)) continue;
      const at = Date.parse(p.resolvedAt || p.lastCheckedAt || 0);
      if (!at || now - at > RESOLVED_KEEP_MS) {
        this.problems.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }
}

module.exports = {
  LiveProblemStore,
  isAgendaHandoffProblem,
  isOperatorSuppressed,
  RESOLVED_KEEP_MS,
  CHRONIC_AFTER_MS,
  AGENDA_HANDOFF_KIND,
};
