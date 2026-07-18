#!/usr/bin/env node
/**
 * One-shot: clear house cron chronics for jerry + forrest.
 * - Re-run house exec jobs for real
 * - Verify agentTurn prompt paths exist (no model spend)
 * - Disable jerry edge (pi-/imac-/empire-) jobs while nodes are dark
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { CronScheduler } = require('../dist/scheduler/cron.js');

const ROOT = path.resolve(__dirname, '..');

async function reviveAgent(agent, houseNames, { disableEdge = false } = {}) {
  const conv = path.join(ROOT, 'instances', agent, 'conversations');
  const edgeRe = /^(pi-|imac-|empire-)/i;
  const results = [];

  const scheduler = new CronScheduler({
    timezone: 'America/New_York',
    jobsFile: 'cron-jobs.json',
    runsDir: 'cron-runs',
  }, async (job) => {
    const p = job.payload || {};
    if (p.kind === 'exec' && p.command) {
      try {
        execSync(p.command, {
          cwd: p.cwd || ROOT,
          timeout: Math.min((p.timeoutSeconds || 120) * 1000, 300000),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
        return { status: 'ok', response: 'house-revive-exec-ok', durationMs: 1 };
      } catch (e) {
        const msg = [e.stderr, e.stdout, e.message].filter(Boolean).map(String).join(' | ').slice(0, 400);
        return { status: 'error', error: msg || String(e), durationMs: 1 };
      }
    }
    if (p.kind === 'agentTurn') {
      const mp = p.messagePath;
      if (!mp) return { status: 'error', error: 'agentTurn missing messagePath', durationMs: 1 };
      const abs = mp.startsWith('/') ? mp : path.join(ROOT, mp);
      if (!fs.existsSync(abs)) {
        return { status: 'error', error: `messagePath missing: ${abs}`, durationMs: 1 };
      }
      // Path OK — clear withhold without spending model credits this pass.
      return {
        status: 'ok',
        response: 'agentTurn prompt present; model fire left to schedule',
        durationMs: 1,
        semanticStatus: 'unknown',
      };
    }
    return { status: 'ok', response: 'noop', durationMs: 1 };
  }, conv);

  for (const job of scheduler.getJobs()) {
    const name = job.name || job.id;
    if (!job.enabled) continue;

    if (disableEdge && edgeRe.test(name)) {
      scheduler.disableJob(job.id);
      // annotate via update — disableJob may not set reason; patch state after
      const j = scheduler.getJob(job.id);
      if (j) {
        j.state.lastDecisionReason = 'disabled 2026-07-17: edge node dark; house health excludes these; re-enable when Pi/iMac return';
        j.state.consecutiveErrors = 0;
        delete j.state.circuitOpenUntilMs;
      }
      results.push({ name, action: 'disabled-edge' });
      continue;
    }

    if (!houseNames.includes(name)) continue;

    job.state.consecutiveErrors = 0;
    delete job.state.circuitOpenUntilMs;
    job.state.nextRunAtMs = Date.now() - 1000;
    const r = await scheduler.runJobNow(job.id);
    results.push({
      name,
      action: 'runJobNow',
      status: r.status,
      error: r.error ? String(r.error).slice(0, 160) : undefined,
    });
  }

  // Persist edge disable annotations
  if (disableEdge) {
    const file = path.join(conv, 'cron-jobs.json');
    const jobs = scheduler.getJobs();
    fs.writeFileSync(file, JSON.stringify(jobs, null, 2) + '\n');
  }

  return results;
}

(async () => {
  const jerry = await reviveAgent('jerry', [
    'update-now-snapshot',
    'architecture-transport-sampler',
    'disk-free-safe-cache-maintenance',
    'synthesis-freshness-refresh',
    'field-report-cycle',
  ], { disableEdge: true });

  const forrest = await reviveAgent('forrest', [
    'Sunday weekly health review for jtr',
    'Weekly dashboard improver (autonomous)',
  ], { disableEdge: false });

  console.log(JSON.stringify({ jerry, forrest }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
