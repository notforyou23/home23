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

const STREAM_FILE = 'stream.jsonl';

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

  let brain = 'journaled';
  if (memory && typeof memory.addNode === 'function') {
    try {
      await memory.addNode(content, entry.tag || `drill_${kind}`, null, {
        source: 'drill_stream',
        kind,
        ...provenance
      });
      brain = 'live';
    } catch (err) {
      logger?.warn?.('Brain stream write failed — entry stays on the tape', {
        kind,
        error: err.message
      });
    }
  }

  try {
    const dir = path.join(runtimePath, 'outputs');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, STREAM_FILE),
      `${JSON.stringify({ at: Date.now(), kind, content, brain, ...provenance })}\n`
    );
  } catch (err) {
    logger?.warn?.('Stream tape write failed', { kind, error: err.message });
    if (brain !== 'live') return { streamed: false, brain: 'lost' };
  }

  return { streamed: true, brain };
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

module.exports = { writeBrainStream, bumpStreamEvidence, STREAM_FILE };
