/**
 * Stock sensor: system.disk
 * Free / used / total on the partition containing the Home23 install.
 * Portable: uses `df -k .` which works on macOS and Linux.
 */

const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

async function poll() {
  try {
    const { stdout } = await execFileP('df', ['-k', process.cwd()]);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) return { ok: false, error: 'unexpected df output' };
    // Last line is the mount we care about (handle multi-line BSD filesystems
    // that occasionally wrap).
    const parts = lines[lines.length - 1].trim().split(/\s+/);
    // Columns: Filesystem 1K-blocks Used Available Capacity Mounted on
    if (parts.length < 5) return { ok: false, error: 'malformed df output' };
    const totalKB = parseInt(parts[1], 10);
    const usedKB = parseInt(parts[2], 10);
    const availKB = parseInt(parts[3], 10);
    const cap = parts[4];
    const gb = (kb) => +(kb / 1024 / 1024).toFixed(1);
    const pct = totalKB ? Math.round(100 - (availKB / totalKB) * 100) : 0;
    return {
      ok: true,
      value: `${gb(availKB)} GB free (${100 - pct}% of ${gb(totalKB)})`,
      data: {
        totalGB: gb(totalKB),
        usedGB: gb(usedKB),
        freeGB: gb(availKB),
        usedPercent: pct,
        capacityString: cap,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { id: 'system.disk', label: 'Disk', category: 'system', poll, intervalMs: 60 * 1000 };
