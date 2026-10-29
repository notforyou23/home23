/**
 * Action Dispatcher — autonomous agent action execution
 *
 * When a cognitive cycle emits an ACT: tag with a JSON payload, the dispatcher:
 *   1. Writes an `execute` receipt with the INTENT before running anything
 *   2. Validates against configs/action-allowlist.yaml (enabled + rate limit
 *      + optional allowed_targets + optional dry_run)
 *   3. For classified optional autonomous ACTs, consults target-scoped Seed
 *      execution learning; a deferral records not_attempted, not a failure
 *   4. Loads and runs the allowlisted handler with the supplied context
 *   5. Writes a second `execute` receipt with the OUTCOME
 *
 * Anything not in the allow-list — or anything the handler rejects — is
 * logged to <brainDir>/requested-actions.jsonl so the user can audit.
 *
 * The allow-list yaml hot-reloads on every dispatch (cheap file read), so
 * enabling/disabling actions or flipping dry_run takes effect immediately
 * without a restart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { appendJsonlDurableSync } = require('../utils/durable-write');
const { flushActionFeedback } = require('./action-feedback');
const { readSeedLearning, evaluateLearnedDecision, executionTargetTag, normalizeLearningDecision } = require('../../../shared/seed-learning.cjs');

const ALLOWLIST_PATH_ENV = 'HOME23_ACTION_ALLOWLIST';
const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, '..', '..', '..', 'configs', 'action-allowlist.yaml');

// Rate limit state (in-memory, per-process). Keyed by action name; each value
// is an array of recent execution timestamps. Window is 1 hour.
const rateState = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;

function loadAllowlist() {
  const p = process.env[ALLOWLIST_PATH_ENV] || DEFAULT_ALLOWLIST_PATH;
  try {
    return yaml.load(fs.readFileSync(p, 'utf8')) || {};
  } catch (err) {
    return { _error: err.message };
  }
}

function pruneOldTimestamps(arr, now) {
  const cutoff = now - RATE_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function recordExecution(actionName, now) {
  const arr = rateState.get(actionName) || [];
  pruneOldTimestamps(arr, now);
  arr.push(now);
  rateState.set(actionName, arr);
}

function countRecent(actionName, now) {
  const arr = rateState.get(actionName) || [];
  pruneOldTimestamps(arr, now);
  return arr.length;
}

function countRecentGlobal(now) {
  let total = 0;
  for (const arr of rateState.values()) {
    pruneOldTimestamps(arr, now);
    total += arr.length;
  }
  return total;
}

function appendRequestedAction(brainDir, entry) {
  try {
    const file = path.join(brainDir, 'requested-actions.jsonl');
    appendJsonlDurableSync(file, entry);
  } catch { /* best-effort */ }
}

function appendActionLog(brainDir, entry) {
  // The execution receipt is required. If it cannot be persisted, fail visibly;
  // a handler must never run without its durable intent.
  try { appendJsonlDurableSync(path.join(brainDir, 'actions.jsonl'), entry); }
  catch (error) {
    throw new Error(`Action ${entry.action} ${entry.phase} receipt failed: ${error.message}. ${entry.phase === 'outcome' ? 'Handler already returned; do not infer failure or rerun it from this receipt error.' : 'Handler has not run.'}`);
  }
  try { flushActionFeedback(brainDir); }
  catch (error) {
    // The source receipt remains pending; startup/heartbeat retries projection,
    // not the action. A broken event ledger cannot erase the observed outcome.
    console.warn('[actions] execution feedback pending:', error.message);
  }
}

function loadHandler(handlerName) {
  if (!handlerName) return null;
  try {
    const modPath = path.join(__dirname, 'actions', `${handlerName}.js`);
    if (!fs.existsSync(modPath)) return null;
    // Purge require cache so hot edits to a handler take effect without
    // restarting the engine during development.
    delete require.cache[require.resolve(modPath)];
    return require(modPath);
  } catch (err) {
    return { _loadError: err.message };
  }
}

/**
 * Execute an action proposed by a cognitive cycle.
 *
 * @param {Object} opts
 * @param {Object} opts.action            Parsed ACT payload: { action, target, reason, ... }
 * @param {string} opts.role              Role that emitted it (curiosity/analyst/critic/proposal/curator)
 * @param {number} opts.cycle             Cycle number
 * @param {string} opts.brainDir          instances/<agent>/brain/
 * @param {string} opts.workspaceDir      instances/<agent>/workspace/
 * @param {string} opts.agentName         Name of the agent
 * @param {Object} [opts.logger]
 * @param {Object} [opts.sensors]         Optional sensors module for refresh handlers
 * @param {Object} [opts.memory]          Optional memory graph for promote/prune handlers
 * @param {Object} [opts.goalSystem]      Optional goal system for create/break handlers
 * @param {Function} [opts.writeReceipt]  Optional function to write to evidence-receipts.jsonl
 * @param {string} [opts.runtimeOrigin]  Runtime-only caller classification, not ACT JSON
 * @param {boolean} [opts.ownerRequested] Runtime owner retry; never deferred by optional learning
 * @param {boolean} [opts.criticalRecovery] Runtime recovery; never deferred by optional learning
 * @param {Function} [opts.readLearning] Read-only Seed projection override for isolated callers/tests
 *
 * @returns {Promise<{status: string, detail?: string, memoryDelta?: Object}>}
 */
async function executeAction(opts) {
  const {
    action, role, cycle, brainDir, workspaceDir, agentName, logger,
    sensors, memory, goalSystem, artifactRegistry, writeReceipt,
  } = opts;

  const ts = new Date().toISOString();
  // Keep both fields. Older action-ledger readers use `ts`; live-problem
  // verifiers and newer JSONL utilities standardize on `timestamp`.
  const timestamp = ts;
  const now = Date.now();

  // ── Validate shape ──
  if (!action || typeof action !== 'object' || !action.action) {
    appendRequestedAction(brainDir, {
      ts, timestamp, cycle, role, status: 'rejected', detail: 'malformed_action', action,
    });
    return { status: 'rejected', detail: 'malformed_action' };
  }

  const actionName = String(action.action).trim();
  const target = action.target ? String(action.target).trim() : null;
  const reason = action.reason ? String(action.reason).trim() : null;
  const executionId = crypto.randomUUID();
  const targetTag = executionTargetTag(target);
  // Origin and request/recovery classification come from the caller, never
  // from fields inside generated ACT JSON.
  const executionContext = { targetTag, origin: opts.runtimeOrigin || (opts.agendaId ? 'agenda' : 'direct'),
    optionalAuto: opts.runtimeOrigin === 'autonomous-thought' && !opts.agendaId
      && opts.ownerRequested !== true && opts.criticalRecovery !== true };
  const candidateDecision = executionContext.optionalAuto && targetTag ? normalizeLearningDecision({
    schema: 'home23.learning-decision.v1', decisionId: `action:${executionId}`, scope: `execution:${actionName}`,
    tags: ['execution', 'action', targetTag], criterion: 'execution', sourceRefs: [`action:${executionId}`], observedAt: ts,
  }) : null;
  const learningDecisionEvent = candidateDecision ? {
    event_id: crypto.randomUUID(), event_type: 'LearningDecisionObserved', session_id: `action:${executionId}`,
    object_id: executionId, actor: 'engine-action-dispatcher', timestamp: ts, ts,
    payload: { ...candidateDecision, learningVersion: 2 },
  } : null;

  // ── Provenance: intent receipt BEFORE touching anything ──
  const intentReceipt = {
    stage: 'execute',
    phase: 'intent',
    executionId,
    learningVersion: 2,
    outcomeCriterion: 'execution',
    outcomeTrialId: `action:${executionId}`,
    executionContext,
    executionAttempted: false,
    ...(learningDecisionEvent ? { learningDecisionEvent } : {}),
    agendaId: opts.agendaId || null,
    action: actionName,
    target,
    role,
    cycle,
    reason,
    source: 'brain_decision',
    trust_level: 'high',
    ts,
    timestamp,
  };
  if (typeof writeReceipt === 'function') {
    try { await writeReceipt(intentReceipt); } catch { /* ok */ }
  }
  appendActionLog(brainDir, intentReceipt);

  // ── Load allow-list ──
  const allowlist = loadAllowlist();
  if (allowlist._error) {
    logger?.warn?.('[actions] allow-list load failed', { error: allowlist._error });
    const rejected = finaliseReject(brainDir, intentReceipt, 'allowlist_load_error', allowlist._error, writeReceipt);
    return rejected;
  }

  // ── Global kill switch / global rate limit ──
  const globalCfg = allowlist.global || {};
  if (globalCfg.enabled === false) {
    return finaliseReject(brainDir, intentReceipt, 'global_disabled', null, writeReceipt);
  }
  if (globalCfg.max_per_hour && countRecentGlobal(now) >= globalCfg.max_per_hour) {
    return finaliseReject(brainDir, intentReceipt, 'global_rate_limit', null, writeReceipt);
  }

  // ── Lookup action config ──
  const actionCfg = (allowlist.actions || {})[actionName];
  if (!actionCfg) {
    appendRequestedAction(brainDir, {
      ts, timestamp, cycle, role, status: 'not_in_allowlist', action: actionName, target, reason,
    });
    return finaliseReject(brainDir, intentReceipt, 'not_in_allowlist', null, writeReceipt);
  }
  if (actionCfg.enabled === false) {
    return finaliseReject(brainDir, intentReceipt, 'action_disabled', null, writeReceipt);
  }

  // ── Target allow-list (if the action specifies one) ──
  if (Array.isArray(actionCfg.allowed_targets) && actionCfg.allowed_targets.length > 0) {
    if (!target || !actionCfg.allowed_targets.includes(target)) {
      return finaliseReject(brainDir, intentReceipt, 'target_not_allowed',
        `target '${target}' not in ${JSON.stringify(actionCfg.allowed_targets)}`, writeReceipt);
    }
  }

  // ── Per-action rate limit ──
  if (actionCfg.max_per_hour && countRecent(actionName, now) >= actionCfg.max_per_hour) {
    return finaliseReject(brainDir, intentReceipt, 'rate_limit',
      `exceeded ${actionCfg.max_per_hour}/hour`, writeReceipt);
  }

  // ── Dry-run path ──
  if (actionCfg.dry_run === true) {
    const outcome = {
      ...intentReceipt,
      phase: 'outcome',
      status: 'dry_run',
      detail: 'handler not invoked (dry_run)',
      ts: new Date().toISOString(),
    };
    outcome.timestamp = outcome.ts;
    if (typeof writeReceipt === 'function') {
      try { await writeReceipt(outcome); } catch { /* ok */ }
    }
    appendActionLog(brainDir, outcome);
    recordExecution(actionName, now);
    logger?.info?.('⚡ [DRY-RUN] autonomous action', { action: actionName, target, reason });
    return { status: 'dry_run', detail: 'dry_run' };
  }

  // Optional self-initiated ACTs may defer a repeated unreliable choice, but
  // learning cannot grant authority or alter an owed/critical execution.
  // Unknown action classifications keep the existing dispatcher behavior.
  let learning = null;
  if (executionContext.optionalAuto && actionCfg.learned_admission === 'autonomous_optional' && targetTag) {
    // The original intent retains the exact source witness. A failed source
    // append leaves it in the existing projection cursor for recovery; no
    // optional handler runs until this strict flush has acknowledged it.
    try {
      const projection = flushActionFeedback(brainDir);
      if (projection.pendingBytes > 0) throw new Error('source projection still has pending receipts');
    } catch (error) {
      return finaliseNotAttempted(brainDir, intentReceipt,
        `decision witness unavailable; handler not invoked: ${error.message}`, writeReceipt);
    }
    let snapshot;
    try {
      const stateDir = path.join(workspaceDir || path.join(brainDir, '..', 'workspace'), '..', 'substrate', 'seed-01');
      snapshot = typeof opts.readLearning === 'function' ? opts.readLearning() : readSeedLearning(stateDir);
    } catch { snapshot = null; }
    const decision = candidateDecision;
    if (decision) {
      const evaluated = evaluateLearnedDecision(snapshot, { scope: decision.scope, tags: decision.tags, requiredTags: [targetTag] });
      learning = { ...evaluated, ...(Number.isSafeInteger(snapshot?.seq) ? { seq: snapshot.seq } : {}) };
      if (evaluated.suppress) {
        return finaliseNotAttempted(brainDir, intentReceipt,
          'optional autonomous action deferred by target-specific execution learning; handler not invoked', writeReceipt, learning);
      }
    }
  }

  // ── Load handler ──
  const handler = loadHandler(actionCfg.handler);
  if (!handler || handler._loadError) {
    return finaliseReject(brainDir, intentReceipt, 'handler_load_error',
      handler?._loadError || `handler ${actionCfg.handler} not found`, writeReceipt);
  }
  if (typeof handler.run !== 'function') {
    return finaliseReject(brainDir, intentReceipt, 'handler_invalid',
      `handler ${actionCfg.handler} does not export run()`, writeReceipt);
  }

  // ── Run handler ──
  let result;
  try {
    result = await handler.run({
      action, target, reason, role, cycle,
      brainDir, workspaceDir, agentName,
      integrations: allowlist.integrations || {},
      sensors, memory, goalSystem, artifactRegistry, logger,
    });
  } catch (err) {
    return finaliseReject(brainDir, intentReceipt, 'handler_threw', err.message, writeReceipt, true);
  }

  recordExecution(actionName, now);

  const outcomeReceipt = {
    ...intentReceipt,
    phase: 'outcome',
    executionAttempted: true,
    status: result?.status || 'unknown',
    detail: result?.detail || null,
    memoryDelta: result?.memoryDelta || null,
    ...(learning ? { learning } : {}),
    source: 'execution_outcome',
    ts: new Date().toISOString(),
  };
  outcomeReceipt.timestamp = outcomeReceipt.ts;
  if (typeof writeReceipt === 'function') {
    try { await writeReceipt(outcomeReceipt); } catch { /* ok */ }
  }
  appendActionLog(brainDir, outcomeReceipt);

  logger?.info?.(result?.status === 'success' ? '⚡ ACTION EXECUTED' : '⚡ action result', {
    action: actionName, target, status: result?.status, detail: result?.detail,
  });

  return result ? { ...result, ...(learning ? { learning } : {}) } : { status: 'unknown', ...(learning ? { learning } : {}) };
}

async function finaliseNotAttempted(brainDir, intentReceipt, detail, writeReceipt, learning = null) {
  const outcome = { ...intentReceipt, phase: 'outcome', status: 'not_attempted', executionAttempted: false,
    detail, ...(learning ? { learning } : {}), ts: new Date().toISOString(), source: 'decision_admission' };
  outcome.timestamp = outcome.ts;
  if (typeof writeReceipt === 'function') { try { await writeReceipt(outcome); } catch { /* original source receipt remains required */ } }
  appendActionLog(brainDir, outcome);
  return { status: 'not_attempted', detail, ...(learning ? { learning } : {}) };
}

function finaliseReject(brainDir, intentReceipt, detailCode, extra, writeReceipt, executionAttempted = false) {
  const outcome = {
    ...intentReceipt,
    phase: 'outcome',
    executionAttempted,
    status: 'rejected',
    detail: extra ? `${detailCode}: ${extra}` : detailCode,
    source: 'execution_outcome',
    ts: new Date().toISOString(),
  };
  outcome.timestamp = outcome.ts;
  if (typeof writeReceipt === 'function') {
    try { writeReceipt(outcome); } catch { /* ok */ }
  }
  appendActionLog(brainDir, outcome);
  return { status: 'rejected', detail: outcome.detail };
}

module.exports = { executeAction, loadAllowlist };
