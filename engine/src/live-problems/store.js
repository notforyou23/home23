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

const RESOLVED_KEEP_MS = 24 * 60 * 60 * 1000;   // keep resolved 24h so pulse can mention once
const CHRONIC_AFTER_MS = 6 * 60 * 60 * 1000;    // open >6h with no progress → chronic

function isTransientVerifierFailure(result) {
  if (result?.ok) return false;
  const detail = String(result?.detail || '').toLowerCase();
  return detail.includes('fetch failed')
    || detail.includes('operation was aborted')
    || detail.includes('timeout')
    || detail.includes('econnreset')
    || detail.includes('econnrefused');
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
      this.logger.info?.(`[live-problems] loaded ${this.problems.size} problems`);
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
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ problems: list }, null, 2));
      fs.renameSync(tmp, this.filePath);
      try { this._lastLoadMtimeMs = fs.statSync(this.filePath).mtimeMs; } catch {}
    } catch (err) {
      this.logger.warn?.(`[live-problems] save failed: ${err.message}`);
    }
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
    p.lastResult = { ...result, at: now };
    if (result.ok) {
      delete p.transientFailureCount;
      if (p.state !== 'resolved') {
        resolvedTransition = true;
        p.state = 'resolved';
        p.resolvedAt = now;
        p.stepIndex = 0;
        this.logger.info?.(`[live-problems] resolved: ${id}`);
      }
      p.escalated = false;
      delete p.escalatedAt;
    } else {
      // Do not reopen a resolved problem on a single transient transport
      // failure. jsonpath_http already retries inside one check; this guards
      // the next layer so a momentary localhost fetch failure does not
      // dispatch an agent for a sensor that is otherwise healthy.
      if (p.state === 'resolved' && isTransientVerifierFailure(result)) {
        p.transientFailureCount = (p.transientFailureCount || 0) + 1;
        this.save();
        return;
      }
      delete p.transientFailureCount;
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

module.exports = { LiveProblemStore, RESOLVED_KEEP_MS, CHRONIC_AFTER_MS };
