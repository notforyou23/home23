'use strict';

/**
 * Theatre Crons
 *
 * Reads cron run logs / receipts. Finds enabled cron jobs where the last N
 * runs all produced no consequences (discard/no_change only) — these are
 * theatre loops that consume resources without producing value.
 *
 * Would have caught: field-report-cycle's 86 no-consequence runs.
 */

const fs = require('fs');
const path = require('path');

const MIN_RUNS_TO_FLAG = 5;          // need at least this many recent runs
const NO_CONSEQUENCE_RATIO = 0.95;   // 95%+ of runs are no-consequence

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

  for (const job of jobs) {
    if (!job || job.enabled === false) continue;
    const runLog = job.runLog || job.runHistory || [];
    if (runLog.length < MIN_RUNS_TO_FLAG) continue;

    // Check last N runs
    const recentRuns = runLog.slice(-Math.max(MIN_RUNS_TO_FLAG * 2, 10));
    let noConsequenceCount = 0;
    let totalRuns = 0;

    for (const run of recentRuns) {
      totalRuns++;
      const outcome = run.outcome || run.status || run.result || '';
      const hasConsequence = run.pursuitId || run.taskId || run.claimId || run.findingId;
      const isNoChange = outcome === 'discard' || outcome === 'no_change' || outcome === 'no_action' || outcome === 'ignored';
      if (isNoChange && !hasConsequence) {
        noConsequenceCount++;
      }
    }

    if (totalRuns >= MIN_RUNS_TO_FLAG) {
      const ratio = noConsequenceCount / totalRuns;
      if (ratio >= NO_CONSEQUENCE_RATIO) {
        findings.push({
          id: `theatre_crons:${job.id || job.name}`,
          severity: 'warning',
          code: 'cron_theatre_loop',
          message: `Cron "${job.name}" has ${noConsequenceCount}/${totalRuns} recent runs with no consequences (ratio: ${ratio.toFixed(2)})`,
          evidence: {
            jobId: job.id,
            jobName: job.name,
            enabled: true,
            totalRuns,
            noConsequenceCount,
            ratio: +ratio.toFixed(3),
          },
          autoFixable: false, // disabling a cron is jtr's call
        });
      }
    }
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'theatre_crons',
  label: 'Theatre Crons',
  intervalMs: 30 * 60 * 1000, // 30 min
  run,
};