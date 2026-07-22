/**
 * Routine interval-gated brain backups for cosmo23 research runs.
 *
 * cosmo23 rotated backups after every save but never created one — rotation
 * governed files that did not exist. This module owns the whole lifecycle:
 * an interval-gated (default 6h) copy of the coherent brain artifact set
 * into <logsDir>/backups/backup-<stamp>/, with retention rotation and a
 * free-disk floor (disk exhaustion is lived Home23 history).
 *
 * Consistency: the copy runs under the SAME memory-source write lock the
 * save path uses (persistResearchState), so a backup can never observe a
 * half-rewritten base. Deliberate deviation from the Home23 donor: no
 * coordinator pins (their orphan-pin leak is a known open incident, and
 * cosmo23 full-rewrites its base every save, so the lock suffices).
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { withMemorySourceLock } = require('../../../../shared/memory-source');

const BACKUPS_DIR = 'backups';
const DEFAULT_RETENTION = 2;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_FREE_BYTES = 4 * 1024 ** 3;

// Same default lock root the save path applies (cosmo23/lib/memory-sidecar.js
// DEFAULT_LOCK_ROOT — resolves to <home23>/runtime/brain-source-locks). The
// backup must contend on the SAME lock root as persistResearchState or the
// lock gives no coherence; config.memorySource.lockRoot is unset in default
// deployments, so without this fallback backups would never run.
const DEFAULT_LOCK_ROOT = path.resolve(
  __dirname, '..', '..', '..', '..', 'runtime', 'brain-source-locks',
);

// Fixed-name artifacts; manifest-referenced base/delta files are added
// per-backup by readManifestFiles(). Legacy sidecar names included for
// pre-manifest run dirs; ENOENT on any individual file is fine.
const CANDIDATE_FILES = [
  'state.json.gz',
  'state.json',
  'brain-snapshot.json',
  'memory-manifest.json',
  'memory-nodes.jsonl.gz',
  'memory-edges.jsonl.gz',
  'memory-delta.jsonl',
];

function backupsRoot(logsDir) {
  return path.join(logsDir, BACKUPS_DIR);
}

function listBackups(logsDir) {
  const root = backupsRoot(logsDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => name.startsWith('backup-') && !name.endsWith('.tmp'))
    .map((name) => ({ name, path: path.join(root, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mostRecentBackupTime(logsDir) {
  const list = listBackups(logsDir);
  if (list.length === 0) return 0;
  try {
    return fs.statSync(list[list.length - 1].path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Files the current manifest generation references (relative to logsDir).
 * Read fresh inside the lock so the set matches the bases being copied.
 */
function readManifestFiles(logsDir) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(logsDir, 'memory-manifest.json'), 'utf8'),
    );
    const files = [];
    for (const side of ['nodes', 'edges']) {
      const file = manifest?.activeBase?.[side]?.file;
      if (typeof file === 'string' && file) files.push(file);
    }
    const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
    for (const delta of deltas) {
      if (typeof delta?.file === 'string' && delta.file) files.push(delta.file);
    }
    if (typeof manifest?.activeDelta?.file === 'string' && manifest.activeDelta.file) {
      files.push(manifest.activeDelta.file);
    }
    return files;
  } catch {
    return [];
  }
}

async function freeBytes(logsDir) {
  try {
    const stat = await fsp.statfs(logsDir);
    return stat.bavail * stat.bsize;
  } catch {
    return null; // statfs unavailable — do not block backups on it
  }
}

/**
 * Create a backup if one is due. Never throws — returns a structured result:
 *   { created: true, path, rotated }
 *   { created: false, skipped: 'interval' | 'low_disk', ... }
 *   { created: false, error }
 */
async function maybeBackupBrain(logsDir, options = {}) {
  const logger = options.logger || console;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retention = options.retention ?? DEFAULT_RETENTION;
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const now = options.now ?? Date.now();
  const lockRoot = options.lockRoot || DEFAULT_LOCK_ROOT;

  try {
    const last = mostRecentBackupTime(logsDir);
    if (last && now - last < intervalMs) {
      return { created: false, skipped: 'interval', lastBackupAt: last };
    }

    const free = await freeBytes(logsDir);
    if (free !== null && free < minFreeBytes) {
      logger.warn?.('⚠️ Skipping brain backup — free disk below floor', {
        freeBytes: free,
        minFreeBytes,
        logsDir,
      });
      return { created: false, skipped: 'low_disk', freeBytes: free };
    }

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsRoot(logsDir), `backup-${stamp}`);
    const tmp = `${dest}.tmp`;

    try {
      await withMemorySourceLock(logsDir, { lockRoot }, async () => {
        const files = new Set([...CANDIDATE_FILES, ...readManifestFiles(logsDir)]);
        await fsp.mkdir(tmp, { recursive: true });
        let copied = 0;
        for (const name of files) {
          const src = path.join(logsDir, name);
          const target = path.join(tmp, name);
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(src, target);
            copied += 1;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        if (copied === 0) {
          throw new Error(`no state artifacts found to back up in ${logsDir}`);
        }
        await fsp.rename(tmp, dest);
      });
    } catch (error) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      logger.warn?.('⚠️ Brain backup failed (non-fatal)', { error: error.message, logsDir });
      return { created: false, error: error.message };
    }

    const all = listBackups(logsDir);
    const excess = all.slice(0, Math.max(0, all.length - retention));
    for (const old of excess) {
      await fsp.rm(old.path, { recursive: true, force: true }).catch(() => {});
    }

    return { created: true, path: dest, rotated: excess.length };
  } catch (error) {
    logger.warn?.('⚠️ Brain backup errored (non-fatal)', { error: error.message, logsDir });
    return { created: false, error: error.message };
  }
}

module.exports = {
  BACKUPS_DIR,
  DEFAULT_RETENTION,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MIN_FREE_BYTES,
  backupsRoot,
  listBackups,
  mostRecentBackupTime,
  maybeBackupBrain,
};
