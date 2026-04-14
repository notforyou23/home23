/**
 * Stock sensor: system.process
 * The engine's own resource footprint. Useful for catching memory leaks /
 * runaway growth in the cognitive loop from the Jerry side.
 */

function poll() {
  try {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const mb = (b) => +(b / 1024 / 1024).toFixed(1);
    return {
      ok: true,
      value: `heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)} MB · rss ${mb(mem.rss)} MB · up ${formatDuration(uptime)}`,
      data: {
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        rssMB: mb(mem.rss),
        externalMB: mb(mem.external),
        uptimeSeconds: Math.floor(uptime),
        uptimeString: formatDuration(uptime),
        pid: process.pid,
        nodeVersion: process.version,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = { id: 'system.process', label: 'Engine Process', category: 'system', poll, intervalMs: 30 * 1000 };
