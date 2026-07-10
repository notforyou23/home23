/**
 * Remediator catalog — bounded autonomous fix attempts for live problems.
 *
 * Every remediator is allowlist-governed. `pm2_restart` only targets the
 * agent's own home23-* processes; it can never touch jtr's other PM2 apps
 * (cosmo23-*, jerry-api, jerry-tool, etc.). `exec_command` takes a named
 * snippet from a small internal catalog — no raw shell injection.
 *
 * Remediators return { outcome: 'success'|'rejected'|'failed', detail }.
 * The loop advances stepIndex on rejected/failed. 'success' means the fix
 * was applied; the next verify tick decides whether it actually worked.
 */

const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * PM2 processes we are willing to autonomously restart.
 * Pattern: `home23-<anything>` for engine-managed processes only.
 * Everything else (cosmo23-*, jerry-api, tick-orb-bot) is jtr's domain.
 */
function isRestartableProcess(name) {
  if (!name || typeof name !== 'string') return false;
  if (!/^home23-[a-z0-9._-]+$/i.test(name)) return false;
  if (!name.startsWith('home23-')) return false;
  return true;
}

function currentProcessName() {
  if (process.env.INSTANCE_ID) return process.env.INSTANCE_ID;
  if (process.env.HOME23_AGENT) return `home23-${process.env.HOME23_AGENT}`;
  return null;
}

function isSelfProcess(name) {
  return Boolean(name && currentProcessName() && name === currentProcessName());
}

function scheduleSelfRestart(name) {
  const child = spawn('sh', [
    '-c',
    'sleep 1; exec pm2 restart "$1" --update-env',
    'home23-self-restart',
    name,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * EXEC_CATALOG entries are either:
 *   - static:   { cmd, args, timeoutMs, description }
 *   - dynamic:  { resolve: () => {cmd, args, timeoutMs, description}, description? }
 *
 * Dynamic entries let a remediator compute paths from runtime state (HOME23_AGENT,
 * instance dir, etc.) without allowing free-form shell. The resolve() function
 * must return a static shape before exec.
 */
function home23RootFromEnv() {
  // engine/src/live-problems/remediators.js → engine/src → engine → home23/
  return path.resolve(__dirname, '..', '..', '..');
}
function agentBrainDir() {
  const agent = process.env.HOME23_AGENT;
  if (!agent) return null;
  return path.join(home23RootFromEnv(), 'instances', agent);
}

const EXEC_CATALOG = {
  clean_pm2_logs: {
    cmd: 'pm2',
    args: ['flush'],
    timeoutMs: 10000,
    description: 'pm2 flush — truncate all PM2 log files',
  },
  reload_pm2_logs: {
    cmd: 'pm2',
    args: ['reloadLogs'],
    timeoutMs: 10000,
    description: 'pm2 reloadLogs — reopen log file handles (safe for rotation tools)',
  },
  clean_npm_cache: {
    cmd: 'npm',
    args: ['cache', 'clean', '--force'],
    timeoutMs: 30000,
    description: 'npm cache clean --force',
  },
  clean_docker_build_cache: {
    cmd: 'docker',
    args: ['builder', 'prune', '-f'],
    timeoutMs: 60000,
    description: 'docker builder prune -f — remove unused build layers',
  },
  clean_docker_dangling_images: {
    cmd: 'docker',
    args: ['image', 'prune', '-f'],
    timeoutMs: 60000,
    description: 'docker image prune -f — remove dangling (untagged) images',
  },
  clean_conv_tmp: {
    // Per-agent temp dir under conversations/. Files older than 3 days.
    resolve: () => {
      const base = agentBrainDir();
      if (!base) throw new Error('HOME23_AGENT not set');
      const tmp = path.join(base, 'conversations', 'tmp');
      return {
        cmd: 'find',
        args: [tmp, '-mindepth', '1', '-mtime', '+3', '-delete'],
        timeoutMs: 20000,
        description: `clean conversations/tmp files older than 3d in ${path.relative(home23RootFromEnv(), tmp)}`,
      };
    },
    description: 'clean agent conv tmp older than 3d',
  },
  clean_old_engine_logs: {
    // Engine/harness/dashboard log files older than 30 days. Engine keeps live
    // logs via pm2-logrotate on its own cadence; this is for straggler archives.
    resolve: () => {
      const base = agentBrainDir();
      if (!base) throw new Error('HOME23_AGENT not set');
      const logs = path.join(base, 'logs');
      return {
        cmd: 'find',
        args: [logs, '-mindepth', '1', '-type', 'f', '-mtime', '+30', '-delete'],
        timeoutMs: 20000,
        description: `clean agent logs older than 30d in ${path.relative(home23RootFromEnv(), logs)}`,
      };
    },
    description: 'clean agent logs older than 30d',
  },
  // Add more named snippets here. Never allow free-form shell.
};

const remediators = {
  /**
   * Restart a PM2 process (only home23-* names). Uses --update-env so fresh
   * secrets/env are loaded. Fire-and-forget — the verifier re-checks next tick.
   * args: { name }
   */
  pm2_restart({ name }) {
    if (!isRestartableProcess(name)) {
      return { outcome: 'rejected', detail: `not restartable: ${name}` };
    }
    if (isSelfProcess(name)) {
      try {
        scheduleSelfRestart(name);
        return { outcome: 'success', detail: `scheduled self restart for ${name}` };
      } catch (err) {
        return { outcome: 'failed', detail: `self restart schedule failed: ${err.message}` };
      }
    }
    try {
      execFileSync('pm2', ['restart', name, '--update-env'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: 'pipe',
      });
      return { outcome: 'success', detail: `restarted ${name}` };
    } catch (err) {
      return { outcome: 'failed', detail: `pm2 restart failed: ${err.message}` };
    }
  },

  /**
   * Invoke an iOS Shortcut via the existing shortcut-bridge integration.
   * Re-uses configs/action-allowlist.yaml integrations.shortcut_bridge.
   * args: { target }   (e.g. "Health")
   */
  async run_shortcut({ target }, ctx = {}) {
    const bridge = ctx.integrations?.shortcut_bridge || {};
    if (!bridge.enabled || !bridge.url) {
      return { outcome: 'rejected', detail: 'shortcut_bridge not configured' };
    }
    if (!target) return { outcome: 'rejected', detail: 'target required' };
    try {
      const url = `${bridge.url.replace(/\/$/, '')}/${encodeURIComponent(target)}`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { outcome: 'failed', detail: `${res.status}: ${body.slice(0, 120)}` };
      }
      return { outcome: 'success', detail: `triggered shortcut ${target}` };
    } catch (err) {
      return { outcome: 'failed', detail: `bridge call failed: ${err.message}` };
    }
  },

  /**
   * GET a URL — useful as a nudge for flaky services that wake up on poll.
   * args: { url, timeoutMs }
   */
  async fetch_url({ url, timeoutMs = 5000 }) {
    if (!url) return { outcome: 'rejected', detail: 'url required' };
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return {
        outcome: res.ok ? 'success' : 'failed',
        detail: `${res.status}`,
      };
    } catch (err) {
      return { outcome: 'failed', detail: err.message };
    } finally {
      clearTimeout(to);
    }
  },

  /**
   * Run a named command from the internal catalog. No raw shell.
   * Supports both static and dynamic (resolve-fn) catalog entries.
   * args: { name }
   */
  exec_command({ name }) {
    const entry = EXEC_CATALOG[name];
    if (!entry) return { outcome: 'rejected', detail: `unknown command: ${name}` };
    let resolved;
    try {
      resolved = typeof entry.resolve === 'function'
        ? entry.resolve()
        : entry;
    } catch (err) {
      return { outcome: 'rejected', detail: `resolve failed: ${err.message}` };
    }
    const { cmd, args, timeoutMs, description } = resolved;
    if (!cmd || !Array.isArray(args)) {
      return { outcome: 'rejected', detail: `invalid catalog entry: ${name}` };
    }
    try {
      execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: timeoutMs || 10000,
        stdio: 'pipe',
      });
      return { outcome: 'success', detail: description || `${cmd} ok` };
    } catch (err) {
      return { outcome: 'failed', detail: `${cmd} failed: ${err.message}` };
    }
  },

  /**
   * Tier 3: hand the problem to the agent (Jerry) with its full toolbox.
   * Rigid remediators ran first and didn't fix it; the agent gets a budget
   * (default 12h) to diagnose + attempt real fixes using shell/files/cron/brain.
   *
   * Semantics: on first call, POSTs to harness /api/diagnose. Returns
   * outcome='in_progress' — loop treats this as "do not advance, do not rerun,
   * just wait". On subsequent calls (while dispatched), no-ops with
   * outcome='in_progress'. The loop checks elapsed time separately and
   * advances once budget is exceeded, treating the result as failed.
   *
   * args: { budgetHours }
   * ctx: { harnessDiagnoseUrl, harnessNotifyToken, problem (the full problem obj) }
   *      The ctx passes the full problem so the harness can see the verifier
   *      spec, claim, and prior remediation attempts.
   */
  async dispatch_to_agent({ budgetHours = 12 } = {}, ctx = {}) {
    const { problem } = ctx;
    if (!problem) return { outcome: 'rejected', detail: 'no problem in context' };

    // Already dispatched? No-op until budget elapsed — the agent is working.
    if (problem.dispatchedAt) {
      const elapsedHours = (Date.now() - Date.parse(problem.dispatchedAt)) / 3600000;
      if (elapsedHours < budgetHours) {
        return {
          outcome: 'in_progress',
          detail: `agent working (${elapsedHours.toFixed(1)}h / ${budgetHours}h) turnId=${problem.dispatchedTurnId || '?'}`,
        };
      }
      // Budget exceeded — treat as failed so the loop advances to the next step.
      return {
        outcome: 'failed',
        detail: `agent budget exhausted (${elapsedHours.toFixed(1)}h ≥ ${budgetHours}h)`,
      };
    }

    const url = ctx.harnessDiagnoseUrl;
    if (!url) return { outcome: 'rejected', detail: 'harness diagnose url unset' };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.harnessNotifyToken ? { 'Authorization': `Bearer ${ctx.harnessNotifyToken}` } : {}),
        },
        body: JSON.stringify({ problem, budgetHours }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { outcome: 'failed', detail: `dispatch ${res.status}: ${body.slice(0, 160)}` };
      }
      const data = await res.json().catch(() => ({}));
      return {
        outcome: 'dispatched',  // new outcome — loop will record dispatch metadata
        detail: `agent dispatched, turnId=${data.turnId || '?'}`,
        turnId: data.turnId || null,
      };
    } catch (err) {
      return { outcome: 'failed', detail: `dispatch call failed: ${err.message}` };
    }
  },

  /**
   * Tier 3 typed dispatch: hand a live problem to a reusable worker through
   * the worker connector. Workers are not engines; they run through the
   * existing harness and leave receipts for the owner brain.
   *
   * args: { worker, budgetHours }
   * ctx: { workerConnectorBaseUrl, harnessDiagnoseUrl, harnessNotifyToken, problem }
   */
  async dispatch_to_worker({ worker = 'systems', budgetHours = 4 } = {}, ctx = {}) {
    const { problem } = ctx;
    if (!problem) return { outcome: 'rejected', detail: 'no problem in context' };

    if (problem.dispatchedAt) {
      const elapsedHours = (Date.now() - Date.parse(problem.dispatchedAt)) / 3600000;
      if (elapsedHours < budgetHours) {
        return {
          outcome: 'in_progress',
          detail: `worker working (${elapsedHours.toFixed(1)}h / ${budgetHours}h) runId=${problem.dispatchedTurnId || '?'}`,
        };
      }
      return {
        outcome: 'failed',
        detail: `worker budget exhausted (${elapsedHours.toFixed(1)}h >= ${budgetHours}h)`,
      };
    }

    const baseUrl = ctx.workerConnectorBaseUrl
      || (ctx.harnessDiagnoseUrl ? ctx.harnessDiagnoseUrl.replace(/\/api\/diagnose$/, '') : '')
      || process.env.HOME23_WORKER_CONNECTOR_URL;
    if (!baseUrl) return { outcome: 'rejected', detail: 'worker connector url unset' };

    const prompt = [
      `Live Problem: ${problem.title || problem.claim || problem.id}`,
      `Problem ID: ${problem.id}`,
      `Severity: ${problem.severity || 'unknown'}`,
      '',
      problem.description || problem.claim || '',
      '',
      'Diagnose with evidence. If you act, use scoped Home23 operations only. Re-run the verifier or record the concrete check used.',
      '',
      'End with VERIFIER_STATUS, DISPATCH_OUTCOME, and SUMMARY lines.'
    ].join('\n');
    const collaborationHandoff = {
      schema: 'home23.worker-collaboration-handoff.v1',
      sourceIssues: [78],
      whyThisMatters: `Live problem ${problem.id || '(unknown)'} needs delegated judgment without losing the operational reason it matters to ${ctx.agentName || process.env.HOME23_AGENT || 'the owner agent'}.`,
      constraints: [
        'Preserve the live-problem claim and verifier as the center of the task; do not broaden into unrelated system cleanup.',
        'Separate observed evidence from inferred causes before claiming a fix.',
        'Use scoped Home23 operations only and name the concrete verifier or equivalent check.'
      ],
      reviewLens: [
        'Would this diagnosis still look right after the urgency of the alert has passed?',
        'Did the worker filter its own generated fix rather than only executing the literal dispatch prompt?',
        'What technically correct action would still violate this Home23 operational context?'
      ],
      handoffTaxMitigation: 'The worker must return verifier status, dispatch outcome, summary, and any uncertainty so the owner agent can catch context drift before accepting the repair.'
    };

    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/workers/${encodeURIComponent(worker)}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.harnessNotifyToken ? { 'Authorization': `Bearer ${ctx.harnessNotifyToken}` } : {}),
        },
        body: JSON.stringify({
          prompt,
          ownerAgent: ctx.agentName || process.env.HOME23_AGENT || undefined,
          requestedBy: 'live-problems',
          requester: 'engine',
          collaborationHandoff,
          source: { type: 'live-problem', id: problem.id },
          metadata: { budgetHours },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { outcome: 'failed', detail: data.error || `worker connector HTTP ${res.status}` };
      return {
        outcome: 'dispatched',
        turnId: data.runId || null,
        detail: data.receipt?.summary || `worker ${worker} dispatched`,
      };
    } catch (err) {
      return { outcome: 'failed', detail: `worker dispatch call failed: ${err.message}` };
    }
  },

  /**
   * Escalate to jtr via the harness notify endpoint.
   * Only called as a last resort; gated by the loop so it fires once per problem
   * per escalation window.
   * args: { text, severity }
   * ctx: { harnessNotifyUrl, harnessNotifyToken }
   */
  async notify_jtr({ text, severity = 'normal' }, ctx = {}) {
    const url = ctx.harnessNotifyUrl;
    if (!url) return { outcome: 'rejected', detail: 'harness notify url unset' };
    if (!text) return { outcome: 'rejected', detail: 'text required' };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.harnessNotifyToken ? { 'Authorization': `Bearer ${ctx.harnessNotifyToken}` } : {}),
        },
        body: JSON.stringify({ text, severity, source: 'live-problems' }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { outcome: 'failed', detail: `${res.status}: ${body.slice(0, 120)}` };
      }
      return { outcome: 'success', detail: 'jtr notified' };
    } catch (err) {
      return { outcome: 'failed', detail: `notify failed: ${err.message}` };
    }
  },
};

function listRemediatorTypes() {
  return Object.keys(remediators);
}

async function runRemediator(spec, ctx = {}) {
  if (!spec || !spec.type) return { outcome: 'rejected', detail: 'missing spec' };
  const fn = remediators[spec.type];
  if (!fn) return { outcome: 'rejected', detail: `unknown remediator: ${spec.type}` };
  try {
    const out = await fn(spec.args || {}, ctx);
    return out || { outcome: 'failed', detail: 'remediator returned nothing' };
  } catch (err) {
    return { outcome: 'failed', detail: `remediator threw: ${err.message}` };
  }
}

module.exports = {
  runRemediator,
  listRemediatorTypes,
  remediators,
  EXEC_CATALOG,
  isRestartableProcess,
  isSelfProcess,
};
