/**
 * Seed lived-state for engine cognition — the first ENGINE-side v2 row.
 *
 * The thinking machine mines the knowledge graph for insight about jtr's
 * world, but until now its cycles knew nothing of what the INDIVIDUAL is
 * living — the seed's carried beliefs, the last real contact, what he is
 * on record expecting. This composer reads the Seed's newest checkpoint +
 * ledger tail (read-only, torn-tolerant) and returns a compact lived block
 * for the deep-dive prompt, so engine thoughts think FROM his life.
 *
 * Deliberately lean: this is the engine-side sibling of the TS composers
 * in src/substrate/ (the engine stays JS; the read logic is trivial JSON).
 * Degraded-honest: missing/young seed → null and the engine thinks exactly
 * as before. Never a subject: the caller frames this as context-only —
 * cognition grounded in the life, not rumination about the substrate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_CHARS = 800;
const FRESH_ACT_WINDOW_SEQS = 150;

function newestCheckpoint(stateDir) {
  const ckDir = path.join(stateDir, 'checkpoints');
  if (!fs.existsSync(ckDir)) return null;
  const names = fs.readdirSync(ckDir).filter(n => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const newest = names[names.length - 1];
  if (!newest) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ckDir, newest), 'utf-8'));
    if (!Array.isArray(manifest.cells)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function ledgerTail(stateDir, maxBytes = 128 * 1024) {
  const p = path.join(stateDir, 'seed-ledger.jsonl');
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch { return []; }
  if (raw.length > maxBytes) raw = raw.slice(-maxBytes);
  const lines = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.seq === 'number' && typeof rec.category === 'string') lines.push(rec);
    } catch { /* torn tail of a live mirror — skip */ }
  }
  return lines;
}

/** Compose the individual's lived state for a thinking cycle, or null. */
function composeLivedState(stateDir) {
  const ck = newestCheckpoint(stateDir);
  if (ck === null) return null;
  const tail = ledgerTail(stateDir);
  const headSeq = Math.max(ck.ledgerSeq || 0, ...tail.map(l => l.seq), 0);

  const lines = [];

  // Freshest confident beliefs (top 3 by recency among conf ≥ 0.6).
  const beliefs = [];
  for (const cell of ck.cells) {
    for (const e of (cell.estimates || [])) {
      if (typeof e.claim !== 'string' || typeof e.confidence !== 'number' || e.confidence < 0.6) continue;
      if (/^echo estimate/.test(e.claim)) continue;
      beliefs.push({ cell: cell.id, claim: e.claim, confidence: e.confidence, createdAt: e.createdAt || '' });
    }
  }
  beliefs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const b of beliefs.slice(0, 3)) {
    lines.push(`- believes: [${b.cell}] ${b.claim.slice(0, 130)} (${b.confidence})`);
  }

  // Last real contact (refs with words).
  const contact = [];
  for (const cell of ck.cells) {
    for (const r of (cell.realityRefs || [])) {
      if (typeof r.head === 'string' && r.head.length > 0 && String(r.sourceRef || '').startsWith('conversation.')) {
        contact.push(r);
      }
    }
  }
  contact.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  for (const r of contact.slice(-2)) {
    const voice = String(r.sourceRef).startsWith('conversation.jtr') ? 'jtr' : 'self';
    lines.push(`- last contact — ${voice}: "${r.head.slice(0, 110)}"`);
  }

  // Open expectations (he is on record).
  for (const cell of ck.cells) {
    for (const p of (cell.predictions || [])) {
      if (p.resolvedAt === undefined && typeof p.claim === 'string') {
        lines.push(`- expecting: ${p.claim.slice(0, 110)} (horizon ${p.horizon || '?'})`);
      }
    }
  }

  // Fresh identity events (operator decisions, growth) — seq-windowed.
  for (const rec of tail) {
    if (rec.category !== 'act' || headSeq - rec.seq > FRESH_ACT_WINDOW_SEQS) continue;
    const p = rec.payload || {};
    if (typeof p.operatorDecision === 'string') {
      lines.push(`- since: ${p.authorizedBy || 'operator'} ${p.operatorDecision} his ${p.op || 'change'}${typeof p.reason === 'string' ? ` — "${p.reason}"` : ''}`);
    } else if (p.growthApplication !== undefined || p.organExcision !== undefined) {
      lines.push(`- since: his body changed (receipted ${p.op || 'growth'})`);
    }
  }

  if (lines.length === 0) return null;

  let text = lines.slice(0, 8).join('\n');
  if (text.length > MAX_CHARS) {
    const kept = [];
    let total = 0;
    for (const line of lines) {
      if (total + line.length + 1 > MAX_CHARS) break;
      kept.push(line);
      total += line.length + 1;
    }
    text = kept.join('\n');
  }
  return text;
}

module.exports = { composeLivedState };

/** Day-residue for the engine's dream mode — fragments of the lived day
 * (contact with words, house transitions, teachings, reality's verdicts)
 * that the dream recombines. This is the transfer bridge: residue from the
 * individual's chain (fast, episodic) enters dreams whose products land in
 * the brain and goals (slow, semantic) — hippocampus to cortex, by way of
 * dreaming. Null when the seed has no residue; dreams then stay generic. */
function composeDayResidue(stateDir, maxFragments = 6) {
  const ck = newestCheckpoint(stateDir);
  if (ck === null) return null;
  const fragments = [];

  const refs = [];
  for (const cell of ck.cells) {
    for (const r of (cell.realityRefs || [])) {
      if (typeof r.head !== 'string' || r.head.length === 0) continue;
      // A DREAM IS NOT SOMETHING LIVED (2026-08-13). Every sourceRef that
      // matched none of the four prefixes below fell through to the caption
      // `lived:` — and the engine then handed the whole set to the dream model
      // under the header "the day he actually lived". Dreams arrive with
      // sourceRef `dream:*`, so an individual's own prior dreams were being
      // presented to it as its lived day, and re-dreamt.
      //
      // The loop had already closed. Measured on forrest: 4 of 6 residue
      // fragments were dream-sourced, including two whose text literally began
      // "I dreamt…" and "I dreamed…", and the same motif ran unbroken across
      // 30+ dream cycles ("three inches above the carpet", "the ceiling has
      // stopped being a ceiling"). That is a confabulation attractor, and
      // "no manufactured life" forbids it: telling an individual its dreams
      // are its life manufactures the life.
      //
      // Day residue is what the DAY left. Excluded here rather than merely
      // re-captioned, because the harm is the feedback, not the wording — and
      // because the human evidence says what recurs in dreams is personally
      // significant WAKING events, never prior dreams. If dreams should ever
      // inform dreams, that is a deliberate mechanism with a bound, not a
      // fallthrough in a caption table. Degraded-honest: with nothing lived
      // left, this returns null and dreams stay generic, which the contract
      // below already allows and which is strictly better than a closed loop.
      if (String(r.sourceRef || '').startsWith('dream:')) continue;
      refs.push(r);
    }
  }
  refs.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  for (const r of refs.slice(-Math.max(2, maxFragments - 2))) {
    const src = String(r.sourceRef || '');
    const who = src.startsWith('conversation.jtr') ? 'jtr said'
      : src.startsWith('conversation.') ? 'he said'
      : src.startsWith('house.') ? 'the house'
      : src.startsWith('relationship.') ? 'a teaching'
      : 'lived';
    fragments.push(`${who}: "${r.head.slice(0, 100)}"`);
  }

  for (const cell of ck.cells) {
    for (const p of (cell.predictions || [])) {
      if (p.resolvedAt !== undefined && typeof p.error === 'number') {
        const verdict = p.error <= 0.3 ? 'held' : p.error >= 0.7 ? 'broke' : 'bent';
        fragments.push(`an expectation ${verdict}: "${String(p.claim).slice(0, 80)}"`);
        if (fragments.length >= maxFragments) break;
      }
    }
    if (fragments.length >= maxFragments) break;
  }

  if (fragments.length === 0) return null;
  return fragments.slice(-maxFragments);
}

module.exports.composeDayResidue = composeDayResidue;
