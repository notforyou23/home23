/**
 * Stock sensor: system.memory
 * Total / free / used RAM on the host. Uses os.totalmem/freemem which are
 * portable across macOS, Linux, Windows.
 */

const os = require('os');

function poll() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const gb = (b) => +(b / 1024 / 1024 / 1024).toFixed(1);
    const pct = total ? Math.round((used / total) * 100) : 0;
    return {
      ok: true,
      value: `${gb(free)} GB free (${100 - pct}% of ${gb(total)})`,
      data: {
        totalGB: gb(total),
        usedGB: gb(used),
        freeGB: gb(free),
        usedPercent: pct,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { id: 'system.memory', label: 'Memory', category: 'system', poll, intervalMs: 30 * 1000 };
