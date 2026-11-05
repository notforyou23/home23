'use strict';

/**
 * Resurrected Crons
 *
 * Reads cron job state files directly. Finds jobs that were disabled but
 * have recent lastRunAt timestamps — meaning they came back from the dead.
 *
 * Would have caught: field-report-cycle running 86 times after jtr killed it.
 */

const fs = require('fs');
const path = require('path');

const RECENT_RUN_WINDOW_MS = 10 * 60 * 1000; // ran within last 10 min while disabled

async function run(ctx) {
  const cronJobsPath = path.join(ctx.brainDir, 'conversations', 'cron-jobs.json');
  if (!fs.existsSync(cronJobsPath)) {
    return { ok: true, findings: [] };
  }

  let jobs;
  try {
    jobs = JSON.parse(fs.readFileSync(cronJobsPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `failed to read cron-jobs.json: ${err.message}`, findings: [] };
  }

  const findings = [];
  const now = Date.now();

  for (const job of jobs) {
    if (!job) continue;
    const enabled = job.enabled !== false;
    if (enabled) continue;

    const lastRunAt = job.lastRunAt ? Date.parse(job.lastRunAt) : null;
    if (!lastRunAt) continue;

    const ageMs = now - lastRunAt;
    if (ageMs > RECENT_RUN_WINDOW_MS) continue;

    findings.push({
      id: `resurrected_crons:${job.id || job.name}`,
      severity: 'critical',
      code: 'disabled_cron_ran_recently',
      message: `Cron job "${job.name}" is disabled but ran ${Math.round(ageMs / 1000)}s ago`,
      evidence: {
        jobId: job.id,
        jobName: job.name,
        enabled: false,
        lastRunAt: job.lastRunAt,
        ageSec: Math.round(ageMs / 1000),
      },
      autoFixable: true,
      async autoFix() {
        // Re-disable by setting enabled: false (idempotent — it's already false,
        // but this forces the state file to be re-saved with the correct flag)
        job.enabled = false;
        job._diagnosticRedisabledAt = new Date().toISOString();
        job._diagnosticRedisabledReason = 'ran_while_disabled';
        try {
          fs.writeFileSync(cronJobsPath, JSON.stringify(jobs, null, 2));
          return {
            action: 'redisabled_cron',
            result: 'ok',
            evidence: { jobId: job.id, jobName: job.name },
            reversible: true,
          };
        } catch (err) {
          return { action: 'redisabled_cron', result: 'failed', error: err.message, reversible: true };
        }
      },
    });
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'resurrected_crons',
  label: 'Resurrected Crons',
  intervalMs: 5 * 60 * 1000,
  run,
};