'use strict';

/**
 * Crash-Loop Detection
 *
 * Reads PM2 process list directly. Flags any home23-* process with excessive
 * restart counts or very recent restarts.
 *
 * Would have caught: 116 dashboard restarts that stayed "online" because
 * nobody checked restart_time.
 */

const { execFileSync } = require('child_process');

const RESTART_COUNT_THRESHOLD = 5;      // > 5 restarts total → warning
const RECENT_RESTART_WINDOW_MS = 60 * 60 * 1000;  // restarted within 1h → warning
const UPTIME_THRESHOLD_MS = 5 * 60 * 1000;         // uptime < 5 min → warning

function normalizeRestartCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

async function run(ctx) {
  let pm2List;
  try {
    const raw = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024 * 4,
    });
    pm2List = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `pm2 jlist failed: ${err.message}`, findings: [] };
  }

  const findings = [];
  const now = Date.now();

  for (const proc of pm2List) {
    const name = proc?.name || '';
    if (!name.startsWith('home23-')) continue;

    const restartCount = normalizeRestartCount(proc.pm2_env?.restart_time);
    const uptimeMs = proc.pm2_env?.pm_uptime ? Date.parse(proc.pm2_env.pm_uptime) : null;
    const uptimeSec = uptimeMs ? (now - uptimeMs) / 1000 : null;

    // Critical: high restart count
    if (restartCount > RESTART_COUNT_THRESHOLD) {
      findings.push({
        id: `crash_loops:${name}`,
        severity: restartCount > 20 ? 'critical' : 'warning',
        code: 'pm2_restart_count_exceeded',
        message: `${name} has ${restartCount} restarts (threshold: ${RESTART_COUNT_THRESHOLD})`,
        evidence: { process: name, restartCount, threshold: RESTART_COUNT_THRESHOLD, uptimeSec },
        autoFixable: false,
      });
    }

    // Warning: just restarted (uptime < 5 min) with prior restarts
    if (restartCount > 0 && uptimeSec !== null && uptimeSec < 300) {
      findings.push({
        id: `crash_loops:${name}:recent_restart`,
        severity: 'info',
        code: 'pm2_recent_restart',
        message: `${name} restarted ${uptimeSec.toFixed(0)}s ago (restart #${restartCount})`,
        evidence: { process: name, restartCount, uptimeSec },
        autoFixable: false,
      });
    }
  }

  return { ok: true, findings };
}

module.exports = {
  id: 'crash_loops',
  label: 'Crash-Loop Detection',
  intervalMs: 5 * 60 * 1000,
  run,
};