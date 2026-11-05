/**
 * Brain snapshot sidecar — tiny, always-readable record of the last
 * known-good brain state. Written after every successful save. Read
 * before save (to enforce the 50%-drop safeguard) and after load (to
 * detect silent data loss).
 *
 * Why this exists: the 50%-drop safeguard in saveState relies on
 * reading the existing state.json.gz to know how many nodes were on
 * disk. If state.json.gz is in the wrong format OR decompresses past
 * V8's ~536 MB string limit, loadCompressed returns an empty "fresh
 * brain" object — and the safeguard sees existingNodes=0, lets the
 * save through, and overwrites good data with empty state.
 *
 * The sidecar is a flat JSON object of just counts + size. It is
 * never larger than a few hundred bytes, so its own parse/stringify
 * is immune to the scaling problems that broke state.json.gz.
 *
 * On load, if the sidecar says "last time we had N nodes" and the
 * loader returns 0, we treat that as a definitive signal of silent
 * data loss and halt. Far better to fail loudly than to silently
 * proceed as a fresh brain.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = 'brain-snapshot.json';

/**
 * @typedef {Object} BrainSnapshot
 * @property {string} savedAt    ISO timestamp of the save
 * @property {number} cycle      cycleCount at save time
 * @property {number} nodeCount  memory.nodes length
 * @property {number} edgeCount  memory.edges length
 * @property {number} fileSize   compressed state.json.gz size in bytes
 */

function snapshotPath(brainDir) {
  return path.join(brainDir, SNAPSHOT_FILE);
}

/**
 * Write a snapshot atomically. No-op on filesystem errors — snapshot is
 * advisory, not load-blocking. (We don't want a write failure to prevent
 * the much more important state.json.gz save from completing.)
 *
 * @param {string} brainDir
 * @param {BrainSnapshot} snap
 */
function writeSnapshot(brainDir, snap) {
  try {
    const p = snapshotPath(brainDir);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    // best-effort — sidecar failure should not block save
  }
}

/**
 * Read the last snapshot. Returns null if missing or unparseable.
 *
 * @param {string} brainDir
 * @returns {BrainSnapshot|null}
 */
function readSnapshot(brainDir) {
  try {
    const p = snapshotPath(brainDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { writeSnapshot, readSnapshot, SNAPSHOT_FILE };
