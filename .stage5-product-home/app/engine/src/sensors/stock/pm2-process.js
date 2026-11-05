/**
 * Stock sensor: system.pm2-process
 * PM2-reported resource footprint for the agent's cognitive engine process.
 *
 * system.process is the dashboard API process because sensors run inside the
 * dashboard server. This sensor looks across to PM2 so live-problems can guard
 * the actual home23-<agent> engine RSS instead of accidentally measuring the
 * dashboard wrapper.
 */

const { execFileSync } = require('child_process');

function getPsRssMB(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    const kb = Number(out);
    return Number.isFinite(kb) && kb > 0 ? +(kb / 1024).toFixed(1) : null;
  } catch {
    return null;
  }
}

function mb(bytes) {
  return +(Number(bytes || 0) / 1024 / 1024).toFixed(1);
}

function normalizePm2RestartCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function formatDuration(ms) {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function poll() {
  try {
    const agent = process.env.HOME23_AGENT || 'jerry';
    const targetName = `home23-${agent}`;
    const raw = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const list = JSON.parse(raw);
    const proc = list.find(p => p?.name === targetName);
    if (!proc) {
      return { ok: false, error: `PM2 process not found: ${targetName}` };
    }

    const pm2RssMB = mb(proc.monit?.memory || 0);
    const psRssMB = getPsRssMB(proc.pid);
    const rssMB = psRssMB ?? pm2RssMB;
    const cpuPercent = +(Number(proc.monit?.cpu || 0)).toFixed(1);
    const uptimeString = formatDuration(proc.pm2_env?.pm_uptime);

    return {
      ok: true,
      value: `${targetName} rss ${rssMB} MB · cpu ${cpuPercent}% · up ${uptimeString}`,
      data: {
        name: targetName,
        pid: proc.pid,
        status: proc.pm2_env?.status,
        rssMB,
        rss_mb: rssMB,
        pm2RssMB,
        psRssMB,
        cpuPercent,
        uptimeMs: proc.pm2_env?.pm_uptime || null,
        uptimeString,
        restartTime: normalizePm2RestartCount(proc.pm2_env?.restart_time),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: 'system.pm2-process',
  label: 'Engine PM2 Process',
  category: 'system',
  poll,
  intervalMs: 30 * 1000,
  _test: { normalizePm2RestartCount },
};
