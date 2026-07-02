/**
 * Brain backup rotator — takes coherent snapshots of all 4 brain files
 * (state.json.gz, memory-nodes.jsonl.gz, memory-edges.jsonl.gz,
 * brain-snapshot.json) into a timestamped directory, and rotates old
 * snapshots so only the last N are kept on disk.
 *
 * Why this exists: tonight's incident came within a whisker of losing
 * 30k nodes because there was only one (4-day-old) backup. A minimum
 * rolling window of recent known-good states lets us recover quickly
 * from any future corruption without needing to hand-archaeologize
 * checkpoints.
 *
 * Cadence: once per hour (configurable), triggered from the end of a
 * successful saveState. Cheap enough: 215 MB × 5 = ~1 GB worst case,
 * and only runs after the save safeguards have already verified the
 * current state is sane.
 *
 * Coherence: we copy all 4 files under a single backup directory, so
 * the backup is a complete matched set. If the engine crashes mid-
 * backup, the .tmp directory is dropped on next run and left for
 * manual inspection.
 */

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const BACKUPS_DIR = 'backups';
const BACKUP_FILES = [
  'state.json.gz',
  'memory-nodes.jsonl.gz',
  'memory-edges.jsonl.gz',
  'brain-snapshot.json',
];
const OPTIONAL_BACKUP_FILES = [
  'memory-delta.jsonl',
];
const DEFAULT_RETENTION = 2;
const DEFAULT_INTERVAL_HOURS = 6;

function backupsRoot(brainDir) {
  return path.join(brainDir, BACKUPS_DIR);
}

function listBackups(brainDir) {
  const root = backupsRoot(brainDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => name.startsWith('backup-'))
    .map(name => ({ name, path: path.join(root, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));  // alphabetical = chronological for ISO timestamps
}

function mostRecentBackupTime(brainDir) {
  const list = listBackups(brainDir);
  if (list.length === 0) return 0;
  const last = list[list.length - 1];
  try {
    return fs.statSync(last.path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Create a new backup if enough time has elapsed since the last one.
 *
 * @param {string} brainDir
 * @param {{ intervalHours?: number, retention?: number, logger?: any, force?: boolean }} opts
 * @returns {Promise<{ created: boolean, reason?: string, backupName?: string, pruned?: number }>}
 */
async function maybeBackup(brainDir, opts = {}) {
  const {
    intervalHours = DEFAULT_INTERVAL_HOURS,
    retention = DEFAULT_RETENTION,
    logger,
    force = false,
  } = opts;

  const root = backupsRoot(brainDir);
  fs.mkdirSync(root, { recursive: true });

  // Gate: too soon since last backup?
  if (!force) {
    const lastMs = mostRecentBackupTime(brainDir);
    const sinceMs = Date.now() - lastMs;
    if (lastMs > 0 && sinceMs < intervalHours * 3600 * 1000) {
      return { created: false, reason: 'within-interval' };
    }
  }

  // Verify every source file exists before attempting the backup so we
  // don't persist partial snapshots.
  for (const f of BACKUP_FILES) {
    const full = path.join(brainDir, f);
    if (!fs.existsSync(full)) {
      return { created: false, reason: `missing-source:${f}` };
    }
  }

  // Coherent copy: build tmp dir, copy all files, atomically rename.
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const backupName = `backup-${stamp}`;
  const tmpDir = path.join(root, backupName + '.tmp');
  const finalDir = path.join(root, backupName);

  // Clean any leftover tmp from a previous crashed run.
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
  await fsp.mkdir(tmpDir);

  let bytes = 0;
  try {
    for (const f of [...BACKUP_FILES, ...OPTIONAL_BACKUP_FILES]) {
      const src = path.join(brainDir, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(tmpDir, f);
      await fsp.copyFile(src, dst);
      bytes += (await fsp.stat(dst)).size;
    }
    await fsp.rename(tmpDir, finalDir);
  } catch (err) {
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
    logger?.warn?.('[brain-backup] create failed', { error: err.message });
    return { created: false, reason: `copy-failed:${err.message}` };
  }

  // Rotate: keep last `retention`, drop the rest (oldest first).
  let pruned = 0;
  const all = listBackups(brainDir);
  if (all.length > retention) {
    for (const old of all.slice(0, all.length - retention)) {
      try {
        await fsp.rm(old.path, { recursive: true, force: true });
        pruned++;
      } catch (err) {
        logger?.warn?.('[brain-backup] prune failed', { backup: old.name, error: err.message });
      }
    }
  }

  logger?.info?.('[brain-backup] created', {
    name: backupName,
    sizeMB: +(bytes / 1048576).toFixed(1),
    kept: Math.min(all.length, retention),
    pruned,
  });
  return { created: true, backupName, pruned, sizeMB: +(bytes / 1048576).toFixed(1) };
}

module.exports = { maybeBackup, listBackups, BACKUPS_DIR, BACKUP_FILES, OPTIONAL_BACKUP_FILES };
