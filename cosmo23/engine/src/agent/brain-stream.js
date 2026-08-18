'use strict';

/**
 * The working stream — disk is the tape, the Brain reads the tape.
 *
 * Nothing stays boxed in an LLM turn, the console, or a chat bubble. If a
 * worker thinks it, fetches it, goals it, or branches an offshoot, a file
 * gets written: every stream entry is appended to outputs/stream.jsonl AND
 * written into the run's Brain as it happens. Hidden work is waste.
 *
 * Degraded-honest: when the Brain write fails (or no memory is attached),
 * the entry stays on the tape marked brain:'journaled' — the desk still
 * shows it, and findings journaled this way are promoted by the drill at
 * settle time. Nothing is fabricated and nothing is silently dropped.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const STREAM_FILE = 'stream.jsonl';
const STREAM_BRAIN_ACK_FILE = 'stream-brain.jsonl';

function stableStreamId(entry) {
  if (entry?.id) return String(entry.id);
  return `stream_${crypto.createHash('sha256').update(JSON.stringify(entry || {})).digest('hex').slice(0, 20)}`;
}

async function appendJsonl(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

/**
 * Write one entry of the working stream: kind is one of goal | phase |
 * thought | harvest | offshoot | finding. Returns { streamed, brain } where
 * brain is 'live' (reached the Brain now), 'journaled' (on the tape only),
 * 'skipped' (nothing to write), or 'lost' (tape write failed too).
 */
async function writeBrainStream(target = {}, entry = {}) {
  const runtimePath = target.runtimePath || null;
  const memory = target.memory || null;
  const logger = target.logger || null;

  const kind = String(entry.kind || '').trim();
  const content = String(entry.content || '').trim();
  if (!runtimePath || !kind || !content) return { streamed: false, brain: 'skipped' };

  const provenance = {
    cycle: entry.cycle ?? null,
    workerId: entry.workerId ?? null,
    goalNumber: entry.goalNumber ?? null,
    phaseNumber: entry.phaseNumber ?? null
  };
  const at = Date.now();
  const id = entry.id || `stream_${at.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  const dir = path.join(runtimePath, 'outputs');
  try {
    await fs.mkdir(dir, { recursive: true });
    // Disk first. A process death after this point leaves replayable truth.
    await appendJsonl(
      path.join(dir, STREAM_FILE),
      { id, at, kind, content, brain: 'journaled', ...provenance }
    );
  } catch (err) {
    logger?.warn?.('Stream tape write failed', { kind, error: err.message });
    return { streamed: false, brain: 'lost' };
  }

  let brain = 'journaled';
  if (memory && typeof memory.addNode === 'function') {
    try {
      await memory.addNode(content, entry.tag || `drill_${kind}`, null, {
        source: 'drill_stream',
        streamId: id,
        kind,
        ...provenance
      });
      brain = 'live';
      await appendJsonl(path.join(dir, STREAM_BRAIN_ACK_FILE), {
        id,
        at: Date.now(),
        brain: 'live'
      });
    } catch (err) {
      logger?.warn?.('Brain stream write failed — entry stays replayable on the tape', {
        kind,
        streamId: id,
        error: err.message
      });
    }
  }

  return { streamed: true, brain, id };
}

async function replayJournaledBrainStream(target = {}) {
  const runtimePath = target.runtimePath || null;
  const memory = target.memory || null;
  const logger = target.logger || null;
  if (!runtimePath || !memory || typeof memory.addNode !== 'function') {
    return { replayed: 0, skipped: 0 };
  }
  const dir = path.join(runtimePath, 'outputs');
  let rows;
  try {
    rows = (await fs.readFile(path.join(dir, STREAM_FILE), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return { replayed: 0, skipped: 0 };
  }
  let acknowledgements = [];
  try {
    acknowledgements = (await fs.readFile(path.join(dir, STREAM_BRAIN_ACK_FILE), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch { /* no acknowledgements yet */ }
  const live = new Set(acknowledgements.filter(row => row.brain === 'live').map(row => row.id));
  let replayed = 0;
  let skipped = 0;
  for (const row of rows) {
    const id = stableStreamId(row);
    if (row.brain === 'live' || live.has(id) || !row.content || !row.kind) {
      skipped += 1;
      continue;
    }
    try {
      await memory.addNode(row.content, row.tag || `drill_${row.kind}`, null, {
        source: 'drill_stream_replay',
        streamId: id,
        kind: row.kind,
        cycle: row.cycle ?? null,
        workerId: row.workerId ?? null,
        goalNumber: row.goalNumber ?? null,
        phaseNumber: row.phaseNumber ?? null
      });
      await appendJsonl(path.join(dir, STREAM_BRAIN_ACK_FILE), {
        id,
        at: Date.now(),
        brain: 'live',
        replayed: true
      });
      live.add(id);
      replayed += 1;
    } catch (error) {
      logger?.warn?.('Brain stream replay paused; tape remains authoritative', {
        streamId: id,
        error: error.message
      });
      break;
    }
  }
  return { replayed, skipped };
}

/**
 * Count one entry that reached the record against the worker's evidence.
 * The phase gate reads this: a worker whose whole descent left nothing on
 * the tape cannot close its phase.
 */
function bumpStreamEvidence(loop) {
  if (!loop || typeof loop !== 'object') return;
  if (!loop.evidence || typeof loop.evidence !== 'object') {
    loop.evidence = { streamed: 0 };
  }
  loop.evidence.streamed = (Number(loop.evidence.streamed) || 0) + 1;
}

module.exports = {
  writeBrainStream,
  replayJournaledBrainStream,
  stableStreamId,
  bumpStreamEvidence,
  STREAM_FILE,
  STREAM_BRAIN_ACK_FILE
};
