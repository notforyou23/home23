/**
 * Stock sensor: system.memory
 * Total / free / used RAM on the host. Uses os.totalmem/freemem which are
 * portable across macOS, Linux, Windows.
 */

const os = require('os');
const { execFileSync } = require('child_process');

function readDarwinSwap() {
  if (os.platform() !== 'darwin') return null;
  try {
    const raw = execFileSync('sysctl', ['vm.swapusage'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
    }).trim();
    const match = /total = ([0-9.]+)M\s+used = ([0-9.]+)M\s+free = ([0-9.]+)M/i.exec(raw);
    if (!match) return { raw };
    const totalMB = Number(match[1]);
    const usedMB = Number(match[2]);
    const freeMB = Number(match[3]);
    return {
      raw,
      totalMB,
      usedMB,
      freeMB,
      usedPercent: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : null,
    };
  } catch {
    return null;
  }
}

function formatValue({ freeGB, totalGB, freePercent, swap }) {
  if (swap && Number.isFinite(swap.usedPercent)) {
    return `raw free ${freeGB} GB (${freePercent}% of ${totalGB}) · swap ${swap.usedPercent}% used`;
  }
  return `${freeGB} GB free (${freePercent}% of ${totalGB})`;
}

function poll() {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const gb = (b) => +(b / 1024 / 1024 / 1024).toFixed(1);
    const pct = total ? Math.round((used / total) * 100) : 0;
    const swap = readDarwinSwap();
    const freePercent = 100 - pct;
    return {
      ok: true,
      value: formatValue({ freeGB: gb(free), totalGB: gb(total), freePercent, swap }),
      data: {
        totalGB: gb(total),
        usedGB: gb(used),
        freeGB: gb(free),
        usedPercent: pct,
        freePercent,
        swap,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  id: 'system.memory',
  label: 'Memory',
  category: 'system',
  poll,
  intervalMs: 30 * 1000,
  _test: { formatValue },
};
