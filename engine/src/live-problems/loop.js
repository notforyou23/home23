/**
 * LiveProblemsLoop — verify → remediate → re-verify → escalate cadence.
 *
 * Ticks every VERIFY_INTERVAL_MS. For each tracked problem:
 *   1. Run the verifier. Update lastResult.
 *   2. If ok → mark resolved (if not already), stop.
 *   3. If not ok → look at current remediation step:
 *        - If step exists and cooldown elapsed, run it.
 *        - If step succeeds, next tick will re-verify.
 *        - If step is rejected or fails, advance stepIndex.
 *   4. When stepIndex >= plan.length, the final remediation (usually
 *      notify_jtr) has run and failed or was exhausted; mark escalated so we
 *      don't loop the same plan.
 *
 * Escalation is opt-in per problem: the plan's last step is typically a
 * `notify_jtr` remediator. If a problem has no plan, the loop just tracks
 * state — jtr sees it in the dashboard but nothing else happens.
 */

const { runVerifier } = require('./verifiers');
const { runRemediator } = require('./remediators');
const { appendSignal } = require('../cognition/signals');

const DEFAULT_INTERVAL_MS = 90 * 1000;          // 1.5 min between ticks
const DEFAULT_STEP_COOLDOWN_MIN = 10;           // cooldown per step if not specified
const WARMUP_DELAY_MS = 20 * 1000;              // wait 20s after start before first tick

class LiveProblemsLoop {
  constructor({ store, logger, ctxProvider, intervalMs }) {
    this.store = store;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.ctxProvider = ctxProvider || (() => ({}));
    this.intervalMs = intervalMs || DEFAULT_INTERVAL_MS;
    this.running = false;
    this.timer = null;
    this._ticking = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setTimeout(() => this.tick(), WARMUP_DELAY_MS);
    this.logger.info?.('[live-problems] loop started');
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  async tick() {
    if (this._ticking) { this._schedule(); return; }
    this._ticking = true;
    try {
      // Pick up external edits (dashboard UI writes the JSON directly from a
      // separate process). If the file changed since our last load, refresh.
      this.store.reloadIfChanged();
      this.store.pruneResolved();
      const all = this.store.all();
      const RESOLVED_REVERIFY_MS = 10 * 60 * 1000;  // re-verify resolved every 10 min
      for (const p of all) {
        if (p.state === 'unverifiable') continue;
        if (p.state === 'resolved') {
          // Re-verify periodically to catch regressions + keep timestamps fresh
          const lastMs = p.lastCheckedAt ? Date.parse(p.lastCheckedAt) : 0;
          if (Date.now() - lastMs < RESOLVED_REVERIFY_MS) continue;
        }
        await this._processOne(p);
      }
    } catch (err) {
      this.logger.warn?.(`[live-problems] tick error: ${err.message}`);
    } finally {
      this._ticking = false;
      this._schedule();
    }
  }

  async _processOne(p) {
    const ctx = this.ctxProvider();
    const priorState = p.state;
    const priorRemediation = Array.isArray(p.remediationLog) ? p.remediationLog.slice(-5) : [];
    // 1. Verify
    const result = await runVerifier(p.verifier, ctx);
    this.store.recordVerification(p.id, result);
    if (result.ok) {
      // Emit a resolved-signal on the edge transition open/chronic → resolved.
      if (priorState === 'open' || priorState === 'chronic') {
        try {
          const fixRecipe = summarizeRemediation(priorRemediation);
          appendSignal(ctx.brainDir || this.store.brainDir, {
            type: 'resolved',
            source: 'live-problems',
            title: `resolved: ${p.claim || p.id}`,
            message: fixRecipe
              ? `${p.claim || p.id} — ${fixRecipe}`
              : p.claim || p.id,
            evidence: {
              problemId: p.id,
              verifierDetail: result.detail || null,
              fixRecipe: fixRecipe || null,
              priorState,
            },
          });
        } catch (err) {
          this.logger.warn?.(`[live-problems] signal emit failed: ${err.message}`);
        }
      }
      // If an agent was dispatched, clear dispatch state so a future re-opening
      // starts fresh.
      if (p.dispatchedAt) this.store.clearDispatch(p.id);
      return;
    }

    // 2. Remediate if plan + cooldown allows
    const plan = Array.isArray(p.remediation) ? p.remediation : [];
    const step = plan[p.stepIndex || 0];
    if (!step) {
      // Plan exhausted. If the last step was notify_jtr, it has already fired.
      // Mark escalated once so we don't keep trying.
      if (!p.escalated && plan.length > 0) this.store.markEscalated(p.id);
      return;
    }

    // ── Serial Tier-3 lock: at most one dispatch_to_agent in flight across
    //    the whole store. If this problem is waiting to dispatch but another
    //    is already in progress, skip this tick. (Keeps it simple; agent can
    //    only diagnose one thing at a time without risking collisions.)
    if (step.type === 'dispatch_to_agent' && !p.dispatchedAt) {
      const otherDispatched = this.store.all().find(q => q.id !== p.id && q.dispatchedAt);
      if (otherDispatched) {
        this.logger.info?.(`[live-problems] ${p.id}: waiting — ${otherDispatched.id} holds Tier-3 lock`);
        return;
      }
    }

    // For dispatch_to_agent, skip the remediator call entirely when already
    // dispatched — avoids 480 unnecessary HTTP calls + log entries + file
    // writes over a 12h budget window. Just check budget expiry directly.
    if (step.type === 'dispatch_to_agent' && p.dispatchedAt) {
      const budgetHours = step.args?.budgetHours ?? 12;
      const elapsedHours = (Date.now() - Date.parse(p.dispatchedAt)) / 3600000;
      if (elapsedHours < budgetHours) return;  // agent still working
      // Budget exceeded — advance past this step
      this.logger.info?.(`[live-problems] ${p.id}: agent budget exhausted (${elapsedHours.toFixed(1)}h ≥ ${budgetHours}h)`);
      this.store.recordRemediation(p.id, {
        step: p.stepIndex, type: step.type,
        outcome: 'failed', detail: `agent budget exhausted (${elapsedHours.toFixed(1)}h)`,
      });
      this.store.clearDispatch(p.id);
      this.store.advanceRemediationStep(p.id);
      return;
    }

    const cooldownMin = step.cooldownMin ?? DEFAULT_STEP_COOLDOWN_MIN;
    const lastAt = p.lastRemediationAt ? Date.parse(p.lastRemediationAt) : 0;
    const sinceMin = lastAt ? (Date.now() - lastAt) / 60000 : Infinity;
    if (sinceMin < cooldownMin) {
      return;   // in cooldown — let the next tick handle it
    }

    // 3. Run the remediator
    this.logger.info?.(`[live-problems] ${p.id}: step ${p.stepIndex} → ${step.type}`);
    // Pass the full problem record so dispatch_to_agent has verifier spec etc.
    const out = await runRemediator(step, { ...ctx, problem: p });
    this.store.recordRemediation(p.id, {
      step: p.stepIndex,
      type: step.type,
      outcome: out.outcome,
      detail: out.detail,
    });

    if (out.outcome === 'dispatched') {
      // Agent accepted the job. Record dispatch metadata; loop will wait out
      // the budget without re-running the step.
      this.store.recordDispatch(p.id, { turnId: out.turnId || null });
    } else if (out.outcome === 'in_progress') {
      // Agent is working; nothing to do. Cooldown marker already written via
      // lastRemediationAt so the next tick won't spam the call.
    } else if (out.outcome === 'success' && step.type === 'notify_jtr') {
      // Escalation step succeeded — don't keep paging jtr.
      this.store.markEscalated(p.id);
      this.store.advanceRemediationStep(p.id);
    } else if (out.outcome === 'rejected' || out.outcome === 'failed') {
      // Clear dispatch state if this was the agent step failing past budget.
      if (step.type === 'dispatch_to_agent') this.store.clearDispatch(p.id);
      this.store.advanceRemediationStep(p.id);
    }
    // On 'success' for non-notify steps, leave stepIndex where it is. Next tick
    // re-verifies; if the fix worked → resolved. If not, cooldown expires and
    // we try the same step again until it rolls to the next one via failure.
  }
}

function summarizeRemediation(entries) {
  if (!entries || entries.length === 0) return '';
  const useful = entries.filter(e => e && e.outcome && e.outcome !== 'rejected');
  if (useful.length === 0) return '';
  const parts = useful.slice(-3).map(e => {
    const head = `${e.type}${e.outcome === 'success' ? ' ✓' : ` (${e.outcome})`}`;
    const detail = e.detail ? ` — ${String(e.detail).slice(0, 120)}` : '';
    return `${head}${detail}`;
  });
  return parts.join(' · ');
}

module.exports = { LiveProblemsLoop, DEFAULT_INTERVAL_MS };
