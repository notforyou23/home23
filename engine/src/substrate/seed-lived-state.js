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
const { projectFeedbackState } = require('../../../shared/seed-feedback-view.cjs');
const { getClaimFeedback } = require('../../../shared/prediction-feedback.cjs');
const { thoughtsFromReceipt } = require('../../../shared/lived-thoughts.cjs');

const MAX_CHARS = 1800;
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
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    raw = buffer.subarray(0, count).toString('utf-8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const lines = [];
  for (const line of raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n')) {
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
  const snapshot = newestCheckpoint(stateDir);
  if (snapshot === null) return null;
  const tail = ledgerTail(stateDir);
  const ck = projectFeedbackState(snapshot, tail);
  const headSeq = Math.max(ck.ledgerSeq || 0, ...tail.map(l => l.seq), 0);

  const lines = [];
  if (!ck.feedbackView.complete) lines.push("- feedback coverage incomplete: active estimates and expectations omitted");

  // Confidence is a selection signal, never evidence that a claim is true.
  const beliefs = [];
  for (const cell of ck.cells) {
    for (const e of (cell.estimates || [])) {
      if (typeof e.claim !== 'string' || typeof e.confidence !== 'number' || e.confidence < 0.6) continue;
      if (/^echo estimate/.test(e.claim)) continue;
      if (getClaimFeedback(cell, e).failedHypothesis) continue;
      beliefs.push({ cell: cell.id, claim: e.claim, confidence: e.confidence, createdAt: e.createdAt || '' });
    }
  }
  beliefs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
    lines.push(`- last contact — ${voice}: "${r.head}"`);
  }

  // Contact and correction precede self-generated hypotheses. Otherwise old,
  // confident prose consumes the budget and crowds out the world again.
  const failures = ck.cells.flatMap(cell => (cell.predictions || [])
    .filter(p => p.resolvedAt !== undefined && typeof p.error === 'number' && p.error >= 0.7))
    .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));
  for (const p of failures.slice(0, 2)) {
    lines.push(`- failed hypothesis: "${p.claim}" (error ${p.error.toFixed(2)}); needs newer evidence and an explicit revision, not repetition.`);
  }
  const reflections = tail.flatMap(thoughtsFromReceipt).filter(thought => thought.kind === 'reflection')
    .filter(thought => {
      const cell = ck.cells.find(cell => cell.id === thought.cellId);
      return cell && !getClaimFeedback(cell, thought.candidate).failedHypothesis;
    });
  for (const thought of reflections.slice(-2)) {
    lines.push(`- earlier reflection (not an observation or obligation): ${thought.text}`);
  }
  for (const b of beliefs.slice(0, 2)) {
    lines.push(`- tentative estimate: [${b.cell}] ${b.claim} (confidence ${b.confidence}; not an established fact)`);
  }

  // Open expectations (he is on record).
  for (const cell of ck.cells) {
    for (const p of (cell.predictions || [])) {
      if (p.resolvedAt === undefined && typeof p.claim === 'string' && !getClaimFeedback(cell, p).failedHypothesis) {
        lines.push(`- expecting (unresolved): ${p.claim} (horizon ${p.horizon || '?'})`);
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

  const kept = [];
  let total = 0;
  for (const line of lines) {
    if (kept.length >= 8) break;
    if (kept.length && total + line.length + 1 > MAX_CHARS) continue;
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join('\n');
}

module.exports = { composeLivedState };

/** Day-residue for the engine's dream mode — fragments of the lived day
 * (contact with words, house transitions, teachings, reality's verdicts)
 * that the dream recombines. This is the transfer bridge: residue from the
 * individual's chain (fast, episodic) enters dreams whose products land in
 * the brain and goals (slow, semantic) — hippocampus to cortex, by way of
 * dreaming. Null when the seed has no residue; dreams then stay generic. */
function composeDayResidue(stateDir, maxFragments = 6) {
  const snapshot = newestCheckpoint(stateDir);
  if (snapshot === null) return null;
  const ck = projectFeedbackState(snapshot, ledgerTail(stateDir));
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
      if (!/^(?:conversation\.|relationship\.|house\.|tool[.:]|external[.:]|observation[.:]|sensor[.:])/.test(String(r.sourceRef || ''))) continue;
      refs.push(r);
    }
  }
  refs.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  for (const r of refs.slice(-Math.max(2, maxFragments - 2))) {
    const src = String(r.sourceRef || '');
    const who = src.startsWith('conversation.jtr') ? 'jtr said'
      : src.startsWith('conversation.self') ? 'resident said (self-report)'
      : src.startsWith('conversation.') ? 'conversation participant said'
      : src.startsWith('house.') ? 'the house'
      : src.startsWith('relationship.') ? 'a teaching'
      : 'recorded observation';
    fragments.push(`${who}: "${r.head}"`);
  }

  for (const cell of ck.cells) {
    for (const p of (cell.predictions || [])) {
      if (p.resolvedAt !== undefined && typeof p.error === 'number') {
        const verdict = p.error <= 0.3 ? 'held' : p.error >= 0.7 ? 'broke' : 'bent';
        fragments.push(`an expectation ${verdict}: "${String(p.claim)}"`);
        if (fragments.length >= maxFragments) break;
      }
    }
    if (fragments.length >= maxFragments) break;
  }

  if (fragments.length === 0) return null;
  return fragments.slice(-maxFragments);
}

module.exports.composeDayResidue = composeDayResidue;
