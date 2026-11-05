/**
 * Stock sensor: system.cpu
 * Load averages (1/5/15 min) + host uptime + core count.
 */

const os = require('os');

function poll() {
  try {
    const load = os.loadavg();
    const cores = os.cpus().length;
    const uptime = os.uptime();
    const uptimeStr = formatDuration(uptime);
    const load1Pct = Math.round((load[0] / cores) * 100);
    return {
      ok: true,
      value: `load ${load[0].toFixed(2)} (${load1Pct}% of ${cores} cores) · up ${uptimeStr}`,
      data: {
        loadAvg1: +load[0].toFixed(2),
        loadAvg5: +load[1].toFixed(2),
        loadAvg15: +load[2].toFixed(2),
        cores,
        uptimeSeconds: Math.floor(uptime),
        uptimeString: uptimeStr,
        load1Percent: load1Pct,
        arch: os.arch(),
        platform: os.platform(),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = { id: 'system.cpu', label: 'CPU', category: 'system', poll, intervalMs: 15 * 1000 };
