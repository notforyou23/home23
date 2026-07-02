/**
 * Action Dispatcher — autonomous agent action execution
 *
 * When a cognitive cycle emits an ACT: tag with a JSON payload, the dispatcher:
 *   1. Writes an `execute` receipt with the INTENT before running anything
 *   2. Validates against configs/action-allowlist.yaml (enabled + rate limit
 *      + optional allowed_targets + optional dry_run)
 *   3. Loads the handler module from engine/src/cognition/actions/<name>.js
 *   4. Runs the handler with a provided context object
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
const yaml = require('js-yaml');
const { appendJsonlDurableSync } = require('../utils/durable-write');

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
  try {
    const file = path.join(brainDir, 'actions.jsonl');
    appendJsonlDurableSync(file, entry);
  } catch { /* best-effort */ }
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

  // ── Provenance: intent receipt BEFORE touching anything ──
  const intentReceipt = {
    stage: 'execute',
    phase: 'intent',
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
    return finaliseReject(brainDir, intentReceipt, 'handler_threw', err.message, writeReceipt);
  }

  recordExecution(actionName, now);

  const outcomeReceipt = {
    ...intentReceipt,
    phase: 'outcome',
    status: result?.status || 'unknown',
    detail: result?.detail || null,
    memoryDelta: result?.memoryDelta || null,
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

  return result || { status: 'unknown' };
}

function finaliseReject(brainDir, intentReceipt, detailCode, extra, writeReceipt) {
  const outcome = {
    ...intentReceipt,
    phase: 'outcome',
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
