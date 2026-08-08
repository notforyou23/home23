/**
 * Seed → situational awareness: expression.v2 (the surfacing organ, rebuilt).
 *
 * v1 surfaced an always-on dump of telemetry means and rule counts. The
 * integration knife (2026-08-08) judged it DECORATIVE: blind judges could not
 * tell grounded from ungrounded on situationally-relevant turns (K1 44%,
 * p=0.75), and the always-on block slightly degraded neutral turns (K2).
 * v2 is built from that verdict's own prescriptions:
 *
 *   1. SELECTIVE, not always-on — items are matched to the turn's meaning:
 *      embed the turn, embed each lived item's claim (cached — claims are
 *      immutable), cosine in the embedder's native 768-dim space. (Chain
 *      records carry the projected 16-dim retina because they persist
 *      forever; matching persists nothing, and calibration showed the
 *      projected space too coarse to threshold honestly.) A turn that
 *      touches nothing carried surfaces NOTHING (null), so the block never
 *      taxes irrelevant turns.
 *   2. USAGE CONTRACT, not a data dump — the block opens by telling the
 *      agent how to draw on it (as memory, in his own voice, never recited).
 *   3. LIVED NARRATIVE, not telemetry means — judged predictions with
 *      reality's answer, open expectations he is on record for, jtr's
 *      operator decisions in jtr's own words, growth events, trust SHIFTS.
 *      Pressure percentages and rule counts do not appear.
 *
 * Freshness is measured in chain seqs, never wall clock. Fresh identity
 * events (an operator decision, a growth application) surface at SESSION
 * BOOTSTRAP only, or through a semantic match — never as per-turn
 * narration. Knife v2 (2026-08-08) measured the per-turn ride-along as a
 * significant tax on unrelated turns (K2: 29/51 against, p=0.009, judges
 * sham-validated); unprompted narration is dead at its measured source.
 *
 * Read-only by construction: reads the Seed's newest checkpoint and ledger
 * tail, writes NOTHING. Degraded-honest: missing/unreadable state → null;
 * embedder down → freshness-only fallback (never the old dump); torn ledger
 * tails tolerated (the state may be a live mirror).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { embedTextRawSync } from './embed-at-contact.js';

interface SeedCell {
  id: string;
  generation: number;
  workspacePressure: number;
  energy: { current: number };
  uncertainty: number;
  estimates: Array<{ claim: string; confidence: number }>;
  predictions: Array<{ claim: string; confidence: number; horizon: string; createdAt: string; resolvedAt?: string; error?: number }>;
  intentions: Array<{ description: string; magnitude: number; open: boolean }>;
}

interface LedgerLine {
  seq: number;
  category: string;
  sourceRef: string;
  payload: Record<string, unknown>;
}

export interface ComposeSeedOptions {
  /** Character cap for the composed block. */
  budget?: number;
  /** The incoming message — enables semantic selection. Without it, only
   * fresh high-reach items can surface (session-bootstrap style). */
  turnText?: string;
  /** Injectable embedder (tests); defaults to the raw native-space embedder. */
  embed?: (text: string) => number[] | null;
  /** Max items surfaced on a matched turn. */
  maxItems?: number;
  /** How far back (in chain seqs from head) an identity event counts as
   * fresh enough to surface without a semantic match. */
  freshWindowSeqs?: number;
}

const DEFAULT_BUDGET = 1100;
const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_FRESH_WINDOW_SEQS = 200;
/** Match gates, calibrated 2026-08-08 against the 90-turn real-conversation
 * corpus (turn TEXTS only — no outcomes were observed). Real turns embed
 * hot: per-turn best cosines ran 0.45–0.67 with medians ~0.40–0.53, so an
 * absolute floor alone cannot separate genuine pull from ambient similarity.
 * Three gates together can:
 *   floor  — best matches sat ≈p85 at 0.60; below this is ambient.
 *   margin — a real match stands clear of the turn's own median score
 *            across the whole pool; ambient similarity lifts everything.
 *   length — short phatic turns ("Ok might be done") carry no matchable
 *            topical content and their embeddings sit near everything;
 *            they skip semantic matching entirely (and surface nothing).
 * Recalibrate all three if the embedder model changes. */
const MATCH_FLOOR = 0.6;
const MATCH_MARGIN = 0.12;
const MIN_MATCHABLE_TURN_ALNUM = 20;
/** Fresh identity events surface only on the bootstrap path (no turn). */
const FRESH_CAP_BOOTSTRAP = 3;
const LEDGER_TAIL_BYTES = 256 * 1024;
const TRUST_SHIFT_MIN = 0.15;
const EMBED_CACHE_MAX = 800;

/** A single lived fact eligible for surfacing. `matchText` is the semantic
 * content (claim/reason) that gets embedded; `text` is the narrated line. */
interface LivedItem {
  key: string;
  kind: 'operator' | 'growth' | 'resolution' | 'expectation' | 'proposal' | 'trust-shift' | 'estimate';
  text: string;
  matchText: string;
  /** Base conversational reach (0..1) — identity events outrank beliefs. */
  reach: number;
  /** Chain seq of the underlying receipt, when the ledger dates it. */
  seq?: number;
}

function newestCheckpoint(stateDir: string): { cells: SeedCell[]; ledgerSeq: number } | null {
  const ckDir = join(stateDir, 'checkpoints');
  if (!existsSync(ckDir)) return null;
  const names = readdirSync(ckDir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const newest = names[names.length - 1];
  if (!newest) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(ckDir, newest), 'utf-8')) as { cells?: SeedCell[]; ledgerSeq?: number };
    if (!Array.isArray(manifest.cells)) return null;
    return { cells: manifest.cells, ledgerSeq: manifest.ledgerSeq ?? 0 };
  } catch {
    return null;
  }
}

function ledgerTail(stateDir: string): LedgerLine[] {
  const path = join(stateDir, 'seed-ledger.jsonl');
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  if (raw.length > LEDGER_TAIL_BYTES) raw = raw.slice(-LEDGER_TAIL_BYTES);
  const lines: LedgerLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as LedgerLine;
      if (typeof parsed.seq === 'number' && typeof parsed.category === 'string') lines.push(parsed);
    } catch { /* torn head/tail of a live mirror — skip */ }
  }
  return lines;
}

// ─── Candidate pool: lived facts with conversational reach ──────────────────

function targetsOf(payload: Record<string, unknown>): string[] {
  const raw = payload['targetCellIds'];
  return Array.isArray(raw) ? raw.map(String) : [];
}

function proposalKeyOf(payload: Record<string, unknown>): string {
  const explicit = payload['proposalKey'];
  if (typeof explicit === 'string') return explicit;
  return `${String(payload['op'] ?? '?')}:${targetsOf(payload).sort().join('+')}`;
}

/** Cap a claim at a word boundary with an honest ellipsis — a mid-word slice
 * reads as a different fact. */
function trimClaim(text: string, cap = 140): string {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function buildLivedItems(checkpoint: { cells: SeedCell[]; ledgerSeq: number }, tail: LedgerLine[]): LivedItem[] {
  const items: LivedItem[] = [];

  // Operator decisions + growth applications — identity events, jtr's words.
  const decidedProposalKeys = new Set<string>();
  const decidedProposalSeqs = new Set<number>();
  for (const line of tail) {
    if (line.category !== 'act') continue;
    const p = line.payload;
    if (typeof p['operatorDecision'] === 'string') {
      decidedProposalKeys.add(proposalKeyOf(p));
      if (typeof p['proposalSeq'] === 'number') decidedProposalSeqs.add(p['proposalSeq']);
      const op = String(p['op'] ?? 'change');
      const targets = targetsOf(p).join(' + ');
      const by = String(p['authorizedBy'] ?? 'the operator');
      const reason = typeof p['reason'] === 'string' ? p['reason'] : '';
      const verb = p['operatorDecision'] === 'declined' ? 'declined' : String(p['operatorDecision']);
      items.push({
        key: `operator:${line.seq}`,
        kind: 'operator',
        text: `${by} ${verb} your ${op} of ${targets}${reason ? ` — his words: "${reason}"` : ''}.`,
        // Domain-contextualized: bare op words ("merge") collide with git
        // talk; anchoring them to cell anatomy keeps the meaning honest.
        matchText: `seed growth: operator decision on ${op} of situation cells ${targets} ${reason}`.trim(),
        reach: 1.0,
        seq: line.seq,
      });
    } else if (p['growthApplication'] !== undefined || p['resultingAnatomy'] !== undefined) {
      const op = String(p['op'] ?? 'growth');
      const anatomy = p['resultingAnatomy'];
      const bodyNow = Array.isArray(anatomy)
        ? (anatomy as Array<{ id?: string }>).map((c) => String(c.id ?? '')).filter(Boolean).join(', ')
        : '';
      items.push({
        key: `growth:${line.seq}`,
        kind: 'growth',
        text: `You grew — a receipted ${op} changed your body${bodyNow ? `; it now holds: ${bodyNow}` : ''}.`,
        matchText: `${op} ${bodyNow}`.trim(),
        reach: 1.0,
        seq: line.seq,
      });
    }
  }

  // Judged predictions — reality's answer to what he went on record for.
  // Dated via resolution receipts (predictionId → seq) where the tail has them.
  const resolutionSeqById = new Map<string, number>();
  for (const line of tail) {
    if (line.category === 'development' && line.payload['rule'] === 'resolution.v1') {
      const id = line.payload['predictionId'];
      if (typeof id === 'string') resolutionSeqById.set(id, line.seq);
    }
  }
  let predIndex = 0;
  for (const cell of checkpoint.cells) {
    for (const p of cell.predictions) {
      predIndex += 1;
      const claim = trimClaim(p.claim);
      if (p.resolvedAt !== undefined && typeof p.error === 'number') {
        const verdict = p.error <= 0.3
          ? `reality agreed (error ${p.error.toFixed(2)})`
          : p.error >= 0.7
            ? `reality said no (error ${p.error.toFixed(2)})`
            : `reality partly agreed (error ${p.error.toFixed(2)})`;
        // Resolution receipts carry ids the checkpoint predictions don't; the
        // freshest resolution seqs attach in receipt order as a best effort.
        items.push({
          key: `resolution:${cell.id}:${predIndex}`,
          kind: 'resolution',
          text: `You predicted "${claim}" — ${verdict}.`,
          matchText: claim,
          reach: 0.9,
        });
      } else {
        items.push({
          key: `expectation:${cell.id}:${predIndex}`,
          kind: 'expectation',
          text: `You are on the record expecting: "${claim}" (confidence ${p.confidence}, horizon ${p.horizon}).`,
          matchText: claim,
          reach: 0.8,
        });
      }
    }
  }
  // Attach resolution seqs newest-first so recently judged predictions can
  // ride the freshness rule even without a semantic match.
  const resolutionSeqs = [...resolutionSeqById.values()].sort((a, b) => b - a);
  let seqCursor = 0;
  for (const item of items) {
    if (item.kind === 'resolution' && item.seq === undefined && seqCursor < resolutionSeqs.length) {
      item.seq = resolutionSeqs[seqCursor];
      seqCursor += 1;
    }
  }

  // Pending growth proposals — his own pressure, awaiting jtr.
  for (const line of tail) {
    if (line.category !== 'proposal') continue;
    const p = line.payload;
    const key = proposalKeyOf(p);
    if (decidedProposalKeys.has(key) || decidedProposalSeqs.has(line.seq)) continue;
    const op = String(p['op'] ?? 'change');
    const targets = targetsOf(p).join(' + ');
    items.push({
      key: `proposal:${line.seq}`,
      kind: 'proposal',
      text: `Your growth pressure holds a pending ${op} proposal on ${targets} — jtr has not answered it.`,
      matchText: `seed growth: pending ${op} of situation cells ${targets}`,
      reach: 0.7,
      seq: line.seq,
    });
  }

  // Trust SHIFTS (not levels): sources whose causal trust moved across the
  // window, through lived corrections — a change is a story, a level is not.
  const trustFirst = new Map<string, number>();
  const trustLast = new Map<string, number>();
  for (const line of tail) {
    if (line.category !== 'development') continue;
    const key = line.payload['trustKey'];
    const value = line.payload['trust'];
    if (typeof key !== 'string' || typeof value !== 'number' || key === 'self.prediction') continue;
    if (!trustFirst.has(key)) trustFirst.set(key, value);
    trustLast.set(key, value);
  }
  for (const [key, last] of trustLast) {
    const first = trustFirst.get(key) ?? last;
    if (Math.abs(last - first) < TRUST_SHIFT_MIN) continue;
    const direction = last > first ? 'risen' : 'fallen';
    items.push({
      key: `trust-shift:${key}`,
      kind: 'trust-shift',
      text: `Your trust in ${key} has ${direction} (${first.toFixed(2)} → ${last.toFixed(2)}) through lived corrections.`,
      matchText: key.replace(/[._]/g, ' '),
      reach: 0.5,
    });
  }

  // Held estimates — beliefs with confidence; they surface only on a match.
  let estIndex = 0;
  for (const cell of checkpoint.cells) {
    for (const e of cell.estimates) {
      estIndex += 1;
      const claim = trimClaim(e.claim);
      items.push({
        key: `estimate:${cell.id}:${estIndex}`,
        kind: 'estimate',
        text: `You hold, from receipts: "${claim}" (${e.confidence}).`,
        matchText: claim,
        reach: 0.5,
      });
    }
  }

  return items;
}

// ─── Semantic selection through the species retina ──────────────────────────

const embedCache = new Map<string, number[]>();

function cachedEmbed(text: string, embed: (t: string) => number[] | null): number[] | null {
  const hit = embedCache.get(text);
  if (hit !== undefined) return hit;
  const vec = embed(text);
  if (vec !== null) {
    if (embedCache.size >= EMBED_CACHE_MAX) {
      const oldest = embedCache.keys().next().value;
      if (oldest !== undefined) embedCache.delete(oldest);
    }
    embedCache.set(text, vec);
  }
  return vec;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Overload-compatible with the legacy (stateDir, budget) call shape. */
export function composeSeedSituation(stateDir: string, budgetOrOpts?: number | ComposeSeedOptions): string | null {
  const opts: ComposeSeedOptions = typeof budgetOrOpts === 'number' ? { budget: budgetOrOpts } : (budgetOrOpts ?? {});
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const freshWindow = opts.freshWindowSeqs ?? DEFAULT_FRESH_WINDOW_SEQS;
  const embed = opts.embed ?? embedTextRawSync;

  const checkpoint = newestCheckpoint(stateDir);
  if (checkpoint === null) return null;
  const tail = ledgerTail(stateDir);
  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq), 0);

  const pool = buildLivedItems(checkpoint, tail);
  if (pool.length === 0) return null;

  // Only operator decisions and growth events ride the fresh path — they are
  // jtr-facing identity events with reach on any contact turn. Judged
  // predictions are the Seed's own bookkeeping; they earn surfacing through
  // a semantic match, never as unprompted narration on an unrelated turn.
  const isFreshIdentity = (item: LivedItem): boolean =>
    (item.kind === 'operator' || item.kind === 'growth')
    && item.seq !== undefined && headSeq - item.seq <= freshWindow;

  const selected: LivedItem[] = [];
  const selectedKeys = new Set<string>();
  const admit = (item: LivedItem): void => {
    if (selectedKeys.has(item.key)) return;
    selectedKeys.add(item.key);
    selected.push(item);
  };

  const turnAlnum = (opts.turnText ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').length;
  const turnVec = opts.turnText !== undefined && turnAlnum >= MIN_MATCHABLE_TURN_ALNUM
    ? cachedEmbed(opts.turnText, embed)
    : null;

  if (turnVec !== null) {
    // Semantic path: the turn's meaning selects what it touches. A match
    // must clear the floor AND stand clear of the turn's own median score
    // across the pool — ambient similarity lifts everything; genuine pull
    // lifts one thing. Estimates are capped — carried beliefs cluster
    // (three phrasings of one cadence fact), and two is plenty per turn.
    const all = pool.map((item) => {
      const vec = cachedEmbed(item.matchText, embed);
      return { item, score: vec === null ? 0 : cosine(turnVec, vec), hasVec: vec !== null };
    });
    const withVec = all.filter((s) => s.hasVec).map((s) => s.score).sort((a, b) => a - b);
    const median = withVec[Math.floor(withVec.length / 2)] ?? 0;
    const scored = all
      .filter((s) => s.score >= MATCH_FLOOR && s.score - median >= MATCH_MARGIN)
      .sort((a, b) => (b.item.reach - a.item.reach) || (b.score - a.score));
    let estimateBudget = 2;
    for (const s of scored) {
      if (selected.length >= maxItems) break;
      if (s.item.kind === 'estimate') {
        if (estimateBudget <= 0) continue;
        estimateBudget -= 1;
      }
      admit(s.item);
    }
    // NO unmatched ride-alongs on a turn — knife v2's K2 measured that tax
    // (p=0.009 against, judges sham-validated). Match or stay silent.
  } else if (opts.turnText === undefined) {
    // Bootstrap path (no turn at all): fresh identity events + open
    // expectations — "what happened to you since last session", once,
    // where a session actually begins.
    let freshBudget = FRESH_CAP_BOOTSTRAP;
    for (const item of pool.filter(isFreshIdentity).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))) {
      if (freshBudget <= 0) break;
      admit(item); freshBudget -= 1;
    }
    for (const item of pool.filter((i) => i.kind === 'expectation').slice(0, 2)) {
      if (selected.length >= maxItems) break;
      admit(item);
    }
  }
  // A turn that could not be matched (too short, or embedder down)
  // surfaces NOTHING — degraded-honest means silent, never a dump.

  if (selected.length === 0) return null;

  selected.sort((a, b) => (b.reach - a.reach) || ((b.seq ?? 0) - (a.seq ?? 0)));

  // Budget by dropping whole low-reach items, never by slicing mid-sentence
  // (the DOCTRINE lesson: a truncated fact reads as a different fact).
  const render = (chosen: LivedItem[]): string => [
    'SUBSTRATE — carried state from your Seed that bears on this message.',
    'Use it like memory, not like a report: bring a lived fact in only where it',
    'serves the reply, in your own voice. If none of it fits, ignore all of it —',
    'never recite or summarize this block.',
    '',
    ...chosen.map((item) => `- ${item.text}`),
    '',
    `(receipted state, chain seq ${checkpoint.ledgerSeq})`,
  ].join('\n');

  let chosen = selected;
  let text = render(chosen);
  while (text.length > budget && chosen.length > 1) {
    chosen = chosen.slice(0, -1);
    text = render(chosen);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
