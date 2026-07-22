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
// A kill -9 mid-copy orphans the backup-*.tmp staging dir forever (rotation
// only sees finished backups). Sweep tmp dirs older than this — generous
// against copy durations, safe against a concurrent in-flight copy.
const TMP_SWEEP_AGE_MS = 60 * 60 * 1000;

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
    const accept = (file) => {
      if (typeof file !== 'string' || !file) return;
      // Canonical manifests only ever carry bare basenames
      // (shared/memory-source/manifest.cjs assertRelativeBasename), so
      // reject anything else — this read skips validateManifest, and a
      // corrupt manifest entry must not traverse out of logsDir.
      if (path.isAbsolute(file) || file !== path.basename(file)
          || file === '.' || file === '..') return;
      files.push(file);
    };
    for (const side of ['nodes', 'edges']) {
      accept(manifest?.activeBase?.[side]?.file);
    }
    // The canonical manifest schema has no `deltas` array — only activeDelta
    // exists (shared/memory-source/manifest.cjs exact-keys validation).
    accept(manifest?.activeDelta?.file);
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

// Test seam: freeBytesOverride stands in for statfs when finite, so the
// size-aware floor can be exercised deterministically. Production callers
// never set it.
async function resolveFreeBytes(logsDir, options) {
  if (Number.isFinite(options.freeBytesOverride)) return options.freeBytesOverride;
  return freeBytes(logsDir);
}

/**
 * Remove backup-*.tmp staging dirs orphaned by a hard kill mid-copy.
 * Fresh tmp dirs (younger than TMP_SWEEP_AGE_MS) are left alone — they may
 * belong to a concurrent in-flight copy. Never throws.
 */
async function sweepStaleTmpDirs(logsDir, now, logger) {
  let swept = 0;
  try {
    const root = backupsRoot(logsDir);
    const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
    for (const name of entries) {
      if (!name.startsWith('backup-') || !name.endsWith('.tmp')) continue;
      const full = path.join(root, name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs < TMP_SWEEP_AGE_MS) continue;
        await fsp.rm(full, { recursive: true, force: true });
        swept += 1;
      } catch {
        // Non-fatal: a vanished or unreadable entry is not our problem here.
      }
    }
    if (swept > 0) {
      logger?.info?.('🧹 Swept stale backup tmp staging dirs', { count: swept, logsDir });
    }
  } catch {
    // Non-fatal by contract.
  }
  return swept;
}

/**
 * Create a backup if one is due. Never throws — returns a structured result.
 * Every shape carries sweptTmp (count of stale backup-*.tmp staging dirs
 * removed this call):
 *   { created: true, path, rotated, sweptTmp }
 *   { created: false, skipped: 'interval', lastBackupAt, sweptTmp }
 *   { created: false, skipped: 'low_disk', freeBytes, sweptTmp }                  // pre-lock bare floor
 *   { created: false, skipped: 'low_disk', freeBytes, projectedBytes, sweptTmp }  // in-lock: floor + copy-set size
 *   { created: false, error, sweptTmp }
 */
async function maybeBackupBrain(logsDir, options = {}) {
  const logger = options.logger || console;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retention = options.retention ?? DEFAULT_RETENTION;
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const now = options.now ?? Date.now();
  const lockRoot = options.lockRoot || DEFAULT_LOCK_ROOT;

  let sweptTmp = 0;
  try {
    await fsp.mkdir(backupsRoot(logsDir), { recursive: true });
    sweptTmp = await sweepStaleTmpDirs(logsDir, now, logger);

    const last = mostRecentBackupTime(logsDir);
    if (last && now - last < intervalMs) {
      return { created: false, skipped: 'interval', lastBackupAt: last, sweptTmp };
    }

    // Cheap fast path: don't even take the lock when the bare floor is
    // already breached. The authoritative size-aware check runs in the lock.
    const free = await resolveFreeBytes(logsDir, options);
    if (free !== null && free < minFreeBytes) {
      logger.warn?.('⚠️ Skipping brain backup — free disk below floor', {
        freeBytes: free,
        minFreeBytes,
        logsDir,
      });
      return { created: false, skipped: 'low_disk', freeBytes: free, sweptTmp };
    }

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupsRoot(logsDir), `backup-${stamp}`);
    const tmp = `${dest}.tmp`;

    let lowDisk = null;
    try {
      await withMemorySourceLock(logsDir, { lockRoot }, async () => {
        const files = new Set([...CANDIDATE_FILES, ...readManifestFiles(logsDir)]);

        // Resolve the copy set and its projected size before staging anything
        // (donor parity: the floor must hold the copy set too, not just the
        // fixed reserve).
        const sources = [];
        let projectedBytes = 0;
        for (const name of files) {
          try {
            const stat = await fsp.stat(path.join(logsDir, name));
            if (!stat.isFile()) continue;
            projectedBytes += stat.size;
            sources.push(name);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        if (sources.length === 0) {
          throw new Error(`no state artifacts found to back up in ${logsDir}`);
        }

        const freeInLock = await resolveFreeBytes(logsDir, options);
        if (freeInLock !== null && freeInLock < projectedBytes + minFreeBytes) {
          logger.warn?.('⚠️ Skipping brain backup — free disk cannot hold the copy set', {
            freeBytes: freeInLock,
            projectedBytes,
            minFreeBytes,
            logsDir,
          });
          lowDisk = {
            created: false, skipped: 'low_disk', freeBytes: freeInLock, projectedBytes, sweptTmp,
          };
          return;
        }

        await fsp.mkdir(tmp, { recursive: true });
        for (const name of sources) {
          const src = path.join(logsDir, name);
          const target = path.join(tmp, name);
          try {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(src, target);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        await fsp.rename(tmp, dest);
      });
    } catch (error) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      const message = error?.message || String(error);
      logger.warn?.('⚠️ Brain backup failed (non-fatal)', { error: message, logsDir });
      return { created: false, error: message, sweptTmp };
    }
    if (lowDisk) return lowDisk;

    const all = listBackups(logsDir);
    const excess = all.slice(0, Math.max(0, all.length - retention));
    for (const old of excess) {
      await fsp.rm(old.path, { recursive: true, force: true }).catch(() => {});
    }

    return { created: true, path: dest, rotated: excess.length, sweptTmp };
  } catch (error) {
    const message = error?.message || String(error);
    logger.warn?.('⚠️ Brain backup errored (non-fatal)', { error: message, logsDir });
    return { created: false, error: message, sweptTmp };
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
