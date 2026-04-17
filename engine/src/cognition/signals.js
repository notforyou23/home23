/**
 * signals — positive-signal append-only stream.
 *
 * Separate from notifications.jsonl (the unverified-concerns queue). Signals
 * are evidence-backed "good stuff": resolved problems, successful autonomous
 * fixes, positive pattern observations from cognition. Dashboard "Signals"
 * tile reads from this file.
 *
 * File: instances/<agent>/brain/signals.jsonl
 *
 * Entry shape:
 *   {
 *     id: 'sig-<ts>-<rand>',
 *     type: 'resolved' | 'autonomous_fix' | 'observation' | 'action_success',
 *     source: <role or subsystem>,
 *     title: <short headline>,
 *     message: <longer explanation>,
 *     evidence?: {
 *       problemId?, verifierDetail?, fixRecipe?, toolCalls?, pattern?
 *     },
 *     ts: ISO8601,
 *     cycle?: number,
 *   }
 */

const fs = require('fs');
const path = require('path');

const SIGNALS_FILE = 'signals.jsonl';
// Keep file bounded. Anything older than this is dropped on append.
const KEEP_MAX = 500;

function appendSignal(brainDir, { type, source, title, message, evidence, cycle }) {
  if (!type || !source) throw new Error('signal.type and signal.source required');
  const file = path.join(brainDir, SIGNALS_FILE);
  const entry = {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    source,
    title: title || '',
    message: message || '',
    evidence: evidence || null,
    ts: new Date().toISOString(),
    ...(typeof cycle === 'number' ? { cycle } : {}),
  };
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Best-effort — signals are observational; losing one shouldn't break anything.
    return null;
  }
  // Opportunistic tail-trim: keep only last KEEP_MAX entries.
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > KEEP_MAX + 100) {
      const trimmed = lines.slice(-KEEP_MAX);
      fs.writeFileSync(file, trimmed.join('\n') + '\n');
    }
  } catch { /* best-effort */ }
  return entry;
}

function readSignals(brainDir, { limit = 100, sinceMs = 0, types = null } = {}) {
  const file = path.join(brainDir, SIGNALS_FILE);
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const out = [];
    // Walk newest → oldest
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (sinceMs) {
        const tsMs = Date.parse(e.ts || 0);
        if (tsMs && tsMs < sinceMs) break;
      }
      if (types && Array.isArray(types) && !types.includes(e.type)) continue;
      out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = { appendSignal, readSignals, SIGNALS_FILE };
