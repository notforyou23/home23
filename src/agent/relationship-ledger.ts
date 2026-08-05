/**
 * Home23 — Relationship Ledger (Step 30, Companion Layer piece 2)
 *
 * The jtr<->agent WORKING relationship, curated and bounded — deliberately
 * distinct from the three stores it sits beside:
 *
 *   - factual memory (memory-objects.ts) records what is TRUE about the world
 *     and the house (ops, projects, doctrine);
 *   - the event ledger records what HAPPENED, immutably, for continuity proof;
 *   - raw conversation JSONL is the unfiltered transcript.
 *
 * None of those hold the relationship itself: the unfinished threads, the
 * promises owed in each direction, the corrections that reshaped how the agent
 * works, the decisions reached together, the running jokes, the misses and how
 * they were repaired, and — crucially — WHY a thing mattered, not just what it
 * was. That is what this store keeps. It is small, human-inspectable, and
 * jtr-correctable: the JSON file IS the inspection/correction surface.
 *
 * This is the jtr<->agent relationship, NOT a store of jtr's human friendships.
 *
 * Two invariants this file actually enforces (the surrounding codebase records
 * these fields but does not gate on them):
 *   1. Ownership: only an authenticated correction ingress earns actor:'jtr'.
 *      Agent-authored input can never self-declare jtr authority, and no update
 *      path elevates an existing entry's actor after the fact.
 *   2. Privacy: retrieveForContext() is the ONLY path that renders entries into
 *      prompt text, and it honors excludePrivacy — so privacy_class becomes a
 *      real filter here rather than decorative metadata.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────

export type RelationshipEntryType =
  | 'thread'            // unfinished conversational thread
  | 'promise'           // a commitment/expectation (who owes what)
  | 'correction'        // a consequential correction jtr made
  | 'decision'          // a decision reached together
  | 'preference'        // a recurring preference
  | 'aversion'          // a recurring aversion / "don't do X"
  | 'shared_reference'  // a meaningful shared reference / running joke / touchstone
  | 'miss_repair'       // a prior miss and how it was repaired
  | 'why_it_mattered';  // why something mattered, not just what happened

export type RelationshipEntryStatus = 'active' | 'superseded' | 'resolved' | 'removed';

export type PrivacyClass = 'internal' | 'personal' | 'sensitive';

export type RelationshipGenerationMethod =
  | 'agent_note'
  | 'jtr_correction'
  | 'curator'
  | 'manual';

export interface RelationshipEntry {
  id: string;                 // rel_<compact-iso>_<4hex>
  type: RelationshipEntryType;
  title: string;              // short handle
  statement: string;          // the durable content, bounded
  why?: string;               // why it mattered (esp. decision/correction/miss_repair)
  actor: 'jtr' | 'agent';     // who authored/owns this perspective
  agent: string;              // which agent's ledger (jerry/forrest) — distinct perspectives
  status: RelationshipEntryStatus;
  confidence: number;         // 0..1, capped by anti-theater rule (see below)
  privacy_class: PrivacyClass;
  triggers: string[];         // keyword cues for reactivation (lowercased)
  applies_to: string[];       // domain/topic tags
  provenance: {
    session_refs: string[];
    source_refs: string[];
    generation_method: RelationshipGenerationMethod;
  };
  evidence_note?: string;
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];      // ids this entry replaces
  superseded_by?: string[];
  resolved_at?: string;       // for thread/promise when closed
  last_surfaced?: string;
  reuse_count: number;
}

export interface AuthenticatedCorrectionIngress {
  readonly chatId: string;
  readonly messageRef: string;
  readonly userText: string;
}

export interface RelationshipLedgerOptions {
  validateCorrectionIngress?: (ingress: AuthenticatedCorrectionIngress) => boolean;
  maxEntries?: number;
  now?: () => string;
  idSuffix?: () => string;
  agent?: string;
}

/** Input to addEntry: the durable fields; identity/ownership/timestamps are forced. */
export interface RelationshipEntryInput {
  type: RelationshipEntryType;
  title: string;
  statement: string;
  why?: string;
  confidence?: number;
  privacy_class?: PrivacyClass;
  triggers?: string[];
  applies_to?: string[];
  provenance?: {
    session_refs?: string[];
    source_refs?: string[];
    generation_method?: RelationshipGenerationMethod;
  };
  evidence_note?: string;
  status?: RelationshipEntryStatus;
  supersedes?: string[];
}

export interface RelationshipRetrieval {
  text: string;
  entries: RelationshipEntry[];
  omittedCount: number;
}

// ─── Bounds & anti-theater constants ────────────────────────

const MAX_TITLE = 120;
const MAX_STATEMENT = 2000;
const MAX_WHY = 600;
const MAX_EVIDENCE_NOTE = 600;
const MAX_TAG = 120;
const MAX_TAG_ITEMS = 12;
const MAX_REF = 240;
const MAX_REF_ITEMS = 8;
const DEFAULT_MAX_ENTRIES = 500;

// Anti-theater confidence caps by generation method. Generated notes cannot
// claim the certainty an authenticated jtr correction earns.
const CONFIDENCE_CAPS: Record<RelationshipGenerationMethod, number> = {
  agent_note: 0.8,
  curator: 0.7,
  manual: 0.8,
  jtr_correction: 0.95,
};
const DEFAULT_CONFIDENCE = 0.7;

const GENERATION_METHODS = new Set<RelationshipGenerationMethod>([
  'agent_note', 'jtr_correction', 'curator', 'manual',
]);
const PRIVACY_CLASSES = new Set<PrivacyClass>(['internal', 'personal', 'sensitive']);
const ENTRY_TYPES = new Set<RelationshipEntryType>([
  'thread', 'promise', 'correction', 'decision', 'preference',
  'aversion', 'shared_reference', 'miss_repair', 'why_it_mattered',
]);

// Active entries of these types are load-bearing and are never evicted for space.
const PROTECTED_TYPES = new Set<RelationshipEntryType>(['correction', 'promise', 'decision']);

// Retrieval type weights — corrections/promises/decisions outrank touchstones.
const TYPE_WEIGHT: Record<RelationshipEntryType, number> = {
  correction: 3,
  promise: 3,
  decision: 3,
  aversion: 2.2,
  miss_repair: 2,
  why_it_mattered: 2,
  preference: 1.8,
  thread: 1.5,
  shared_reference: 1,
};

const CORRECTION_LANGUAGE_PATTERN =
  /\b(?:correction|incorrect|wrong|not true|actually|you are mistaken|mistaken|misremember|misread)\b/i;

// ─── Bounding helpers ───────────────────────────────────────

function boundedText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen);
}

function boundedList(value: unknown, maxItems: number, maxLen: number, lower = false): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    let item = raw.trim();
    if (lower) item = item.toLowerCase();
    if (!item) continue;
    item = item.length <= maxLen ? item : item.slice(0, maxLen);
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clampConfidence(score: number | undefined, method: RelationshipGenerationMethod): number {
  const raw = typeof score === 'number' && Number.isFinite(score)
    ? Math.max(0, Math.min(1, score))
    : DEFAULT_CONFIDENCE;
  const cap = CONFIDENCE_CAPS[method] ?? DEFAULT_CONFIDENCE;
  return Math.min(raw, cap);
}

function normalizedClaim(value: unknown): string | null {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 16 * 1024) return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

// ─── Store ──────────────────────────────────────────────────

const LEDGER_SCHEMA = 'home23.relationship-ledger.v1';

export class RelationshipLedger {
  private readonly ledgerPath: string;
  private readonly eventsPath: string;
  private readonly validateCorrectionIngress?: (ingress: AuthenticatedCorrectionIngress) => boolean;
  private readonly maxEntries: number;
  private readonly now: () => string;
  private readonly idSuffix: () => string;
  private readonly agent: string;
  private entries: RelationshipEntry[] = [];

  constructor(brainDir: string, opts: RelationshipLedgerOptions = {}) {
    mkdirSync(brainDir, { recursive: true });
    this.ledgerPath = join(brainDir, 'relationship-ledger.json');
    this.eventsPath = join(brainDir, 'relationship-ledger.events.jsonl');
    this.validateCorrectionIngress = opts.validateCorrectionIngress;
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.idSuffix = opts.idSuffix ?? (() => Math.random().toString(16).slice(2, 6).padStart(4, '0'));
    this.agent = opts.agent || basename(dirname(brainDir)) || 'agent';
    this.load();
  }

  // ── persistence ──────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.ledgerPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.ledgerPath, 'utf-8'));
      this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
    } catch {
      this.entries = [];
    }
  }

  // Atomic write: tmp file + rename, unlink-on-error (job-store idiom). The
  // ledger is curated and bounded (<= maxEntries), so pretty JSON is kept —
  // this file is the human inspection/correction surface, not a hot path.
  private persist(): void {
    const tmpPath = `${this.ledgerPath}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      writeFileSync(
        tmpPath,
        JSON.stringify({ schema: LEDGER_SCHEMA, agent: this.agent, entries: this.entries }, null, 2),
        'utf-8',
      );
      renameSync(tmpPath, this.ledgerPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  // Best-effort sibling event log. Never throws — continuity annotation only.
  private emitEvent(eventType: string, entryId: string, payload: Record<string, unknown> = {}): void {
    try {
      const line = JSON.stringify({
        event_id: randomUUID(),
        event_type: eventType,
        entry_id: entryId,
        agent: this.agent,
        ts: this.now(),
        payload,
      }) + '\n';
      appendFileSync(this.eventsPath, line);
    } catch { /* best-effort */ }
  }

  // ── id ───────────────────────────────────────────────────

  private newId(createdAt: string): string {
    const compact = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return `rel_${compact}_${this.idSuffix()}`;
  }

  // ── ownership ────────────────────────────────────────────

  /**
   * Returns a messageRef when the ingress independently earns jtr authority for
   * this entry, else null. Mirrors MemoryObjectStore: the entry must be a
   * correction, the user turn must be a real recorded turn (validator), the
   * user text must read as a correction, and the entry's statement must be the
   * user's own claim (normalized). This is the sole path to actor:'jtr'.
   */
  private earnedCorrectionRef(
    input: RelationshipEntryInput,
    ingress?: AuthenticatedCorrectionIngress,
  ): string | null {
    const validator = this.validateCorrectionIngress;
    if (!ingress || !validator) return null;
    const messageRef = boundedText(ingress.messageRef, MAX_REF);
    const chatId = boundedText(ingress.chatId, MAX_REF);
    if (!messageRef || !chatId) return null;
    if (input.type !== 'correction') return null;
    const sessionRefs = boundedList(input.provenance?.session_refs ?? [], MAX_REF_ITEMS, MAX_REF);
    if (!sessionRefs.includes(chatId)) return null;
    const statementClaim = normalizedClaim(input.statement);
    const userClaim = normalizedClaim(ingress.userText);
    if (!statementClaim || statementClaim !== userClaim) return null;
    if (!CORRECTION_LANGUAGE_PATTERN.test(ingress.userText)) return null;
    if (validator(ingress) !== true) return null;
    return messageRef;
  }

  // ── create ───────────────────────────────────────────────

  addEntry(input: RelationshipEntryInput, ingress?: AuthenticatedCorrectionIngress): RelationshipEntry {
    if (!ENTRY_TYPES.has(input.type)) throw new Error(`Unknown relationship entry type: ${String(input.type)}`);
    const title = boundedText(input.title, MAX_TITLE);
    const statement = boundedText(input.statement, MAX_STATEMENT);
    if (!title) throw new Error('Relationship entry requires a non-empty title');
    if (!statement) throw new Error('Relationship entry requires a non-empty statement');

    const correctionRef = this.earnedCorrectionRef(input, ingress);

    // Method resolution closes the confidence-cap laundering vector: a caller
    // cannot self-declare 'jtr_correction' (0.95 cap) without earning it; an
    // earned correction is always stamped 'jtr_correction'.
    let method: RelationshipGenerationMethod = GENERATION_METHODS.has(
      input.provenance?.generation_method as RelationshipGenerationMethod,
    )
      ? (input.provenance!.generation_method as RelationshipGenerationMethod)
      : 'agent_note';
    if (method === 'jtr_correction' && !correctionRef) method = 'agent_note';
    if (correctionRef) method = 'jtr_correction';

    const createdAt = this.now();
    const sourceRefs = boundedList([
      ...(correctionRef ? [correctionRef] : []),
      ...(input.provenance?.source_refs ?? []),
    ], MAX_REF_ITEMS, MAX_REF);
    const status: RelationshipEntryStatus =
      input.status && ['active', 'superseded', 'resolved', 'removed'].includes(input.status)
        ? input.status
        : 'active';

    const entry: RelationshipEntry = {
      id: this.newId(createdAt),
      type: input.type,
      title,
      statement,
      ...(input.why ? { why: boundedText(input.why, MAX_WHY) } : {}),
      actor: correctionRef ? 'jtr' : 'agent',
      agent: this.agent,
      status,
      confidence: clampConfidence(input.confidence, method),
      privacy_class: PRIVACY_CLASSES.has(input.privacy_class as PrivacyClass)
        ? (input.privacy_class as PrivacyClass)
        : 'internal',
      triggers: boundedList(input.triggers ?? [], MAX_TAG_ITEMS, MAX_TAG, true),
      applies_to: boundedList(input.applies_to ?? [], MAX_TAG_ITEMS, MAX_TAG),
      provenance: {
        session_refs: boundedList(input.provenance?.session_refs ?? [], MAX_REF_ITEMS, MAX_REF),
        source_refs: sourceRefs,
        generation_method: method,
      },
      ...(input.evidence_note ? { evidence_note: boundedText(input.evidence_note, MAX_EVIDENCE_NOTE) } : {}),
      createdAt,
      updatedAt: createdAt,
      ...(input.supersedes && input.supersedes.length
        ? { supersedes: boundedList(input.supersedes, MAX_REF_ITEMS, MAX_REF) }
        : {}),
      reuse_count: 0,
    };

    this.entries.push(entry);
    this.evict();
    this.persist();
    this.emitEvent('entry_added', entry.id, { type: entry.type, actor: entry.actor, method });
    return entry;
  }

  // ── read ─────────────────────────────────────────────────

  getEntry(id: string): RelationshipEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  listEntries(filter: {
    type?: RelationshipEntryType;
    status?: RelationshipEntryStatus;
    includeRemoved?: boolean;
  } = {}): RelationshipEntry[] {
    let list = this.entries.slice();
    if (filter.type) list = list.filter(e => e.type === filter.type);
    if (filter.status) {
      list = list.filter(e => e.status === filter.status);
    } else if (!filter.includeRemoved) {
      list = list.filter(e => e.status !== 'removed');
    }
    return list.sort(byNewestFirst);
  }

  // ── mutate (no path here elevates actor to 'jtr') ────────

  supersede(
    oldId: string,
    newInput: RelationshipEntryInput,
    ingress?: AuthenticatedCorrectionIngress,
  ): RelationshipEntry {
    const old = this.getEntry(oldId);
    if (!old) throw new Error(`Unknown relationship entry: ${oldId}`);
    const created = this.addEntry({
      ...newInput,
      supersedes: [oldId, ...(newInput.supersedes ?? [])],
    }, ingress);
    old.status = 'superseded';
    old.superseded_by = [...(old.superseded_by ?? []), created.id];
    old.updatedAt = this.now();
    this.persist();
    this.emitEvent('entry_superseded', oldId, { by: created.id });
    return created;
  }

  resolve(id: string): RelationshipEntry | undefined {
    const entry = this.getEntry(id);
    if (!entry) return undefined;
    entry.status = 'resolved';
    entry.resolved_at = this.now();
    entry.updatedAt = entry.resolved_at;
    this.persist();
    this.emitEvent('entry_resolved', id, { type: entry.type });
    return entry;
  }

  // Soft delete — provenance is preserved; the entry stays in the file so the
  // removal itself remains inspectable and jtr-reversible.
  remove(id: string, reason?: string): RelationshipEntry | undefined {
    const entry = this.getEntry(id);
    if (!entry) return undefined;
    entry.status = 'removed';
    entry.updatedAt = this.now();
    if (reason) entry.evidence_note = boundedText(
      `${entry.evidence_note ? entry.evidence_note + ' | ' : ''}removed: ${reason}`,
      MAX_EVIDENCE_NOTE,
    );
    this.persist();
    this.emitEvent('entry_removed', id, { reason: reason ? boundedText(reason, MAX_REF) : null });
    return entry;
  }

  /** Convenience: supersede an entry with a jtr_correction-authored replacement. */
  correct(id: string, correctedStatement: string, ingress: AuthenticatedCorrectionIngress): RelationshipEntry {
    const old = this.getEntry(id);
    if (!old) throw new Error(`Unknown relationship entry: ${id}`);
    return this.supersede(id, {
      type: 'correction',
      title: old.title,
      statement: correctedStatement,
      why: old.why,
      applies_to: old.applies_to,
      triggers: old.triggers,
      privacy_class: old.privacy_class,
      provenance: {
        session_refs: [ingress.chatId],
        generation_method: 'jtr_correction',
      },
    }, ingress);
  }

  // ── selective retrieval (the sole render-to-prompt path) ─

  /**
   * Rank active entries by relevance to `query` + recency + type weight, then
   * greedily pack whole entries into budgetChars and render one line each under
   * a `[RELATIONSHIP — <agent>]` header. Privacy is enforced here: status
   * removed/superseded is always excluded, and any privacy_class in
   * excludePrivacy is dropped before ranking.
   *
   * Read-mostly: this does NOT persist. It never mutates reuse_count/last_surfaced.
   * A caller that actually injects the block should call markSurfaced(entries.map(e=>e.id))
   * so surfaced counts reflect real prompt use, not speculative ranking.
   */
  retrieveForContext(query: string, opts: {
    budgetChars: number;
    nowMs?: number;
    excludePrivacy?: PrivacyClass[];
  }): RelationshipRetrieval {
    const budget = Number.isFinite(opts.budgetChars) ? Math.max(0, Math.floor(opts.budgetChars)) : 0;
    const excluded = new Set(opts.excludePrivacy ?? []);
    const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
      ? opts.nowMs
      : Date.parse(this.now());
    const tokens = tokenize(query);

    // "active" here = non-removed, non-superseded (resolved threads/promises
    // still carry relationship context). Privacy exclusions applied up front.
    const candidates = this.entries
      .filter(e => e.status !== 'removed' && e.status !== 'superseded')
      .filter(e => !excluded.has(e.privacy_class));

    const ranked = candidates
      .map(e => ({ e, score: scoreEntry(e, tokens, nowMs) }))
      .sort((a, b) => (b.score - a.score) || byNewestFirst(a.e, b.e));

    const header = renderHeader(this.agent);
    let used = header.length;
    const included: RelationshipEntry[] = [];
    for (const { e } of ranked) {
      const line = renderLine(e);
      const cost = 1 + line.length; // newline + line
      if (used + cost <= budget) {
        used += cost;
        included.push(e);
      }
    }

    return {
      text: included.length ? [header, ...included.map(renderLine)].join('\n') : '',
      entries: included,
      omittedCount: ranked.length - included.length,
    };
  }

  /** Record that these entries were actually surfaced into a prompt. Persists once. */
  markSurfaced(ids: string[]): void {
    if (!ids.length) return;
    const wanted = new Set(ids);
    let touched = false;
    const surfacedAt = this.now();
    for (const entry of this.entries) {
      if (!wanted.has(entry.id)) continue;
      entry.reuse_count += 1;
      entry.last_surfaced = surfacedAt;
      touched = true;
    }
    if (touched) this.persist();
  }

  /** The whole ledger, newest-first — the jtr-correctable inspection surface. */
  toPublicJSON(): {
    schema: string;
    agent: string;
    generatedAt: string;
    count: number;
    entries: RelationshipEntry[];
  } {
    return {
      schema: LEDGER_SCHEMA,
      agent: this.agent,
      generatedAt: this.now(),
      count: this.entries.length,
      entries: this.entries.slice().sort(byNewestFirst),
    };
  }

  // ── capacity ─────────────────────────────────────────────

  private evict(): void {
    while (this.entries.length > this.maxEntries) {
      const closedIdx = oldestIndex(this.entries, e =>
        e.status === 'resolved' || e.status === 'removed' || e.status === 'superseded');
      if (closedIdx >= 0) { this.entries.splice(closedIdx, 1); continue; }
      const droppableIdx = oldestIndex(this.entries, e =>
        e.status === 'active' && !PROTECTED_TYPES.has(e.type));
      if (droppableIdx >= 0) { this.entries.splice(droppableIdx, 1); continue; }
      // Only protected active entries remain — refuse to drop them.
      console.warn(
        `[relationship-ledger] ${this.entries.length} entries exceed maxEntries ${this.maxEntries}, ` +
        `but all overflow candidates are active correction/promise/decision — keeping them.`,
      );
      break;
    }
  }
}

// ─── Module helpers ─────────────────────────────────────────

function byNewestFirst(a: RelationshipEntry, b: RelationshipEntry): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function oldestIndex(entries: RelationshipEntry[], pred: (e: RelationshipEntry) => boolean): number {
  let bestIdx = -1;
  let bestCreated = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!pred(e)) continue;
    if (bestIdx === -1 || e.createdAt < bestCreated) { bestIdx = i; bestCreated = e.createdAt; }
  }
  return bestIdx;
}

function tokenize(query: string): string[] {
  if (typeof query !== 'string' || !query) return [];
  return Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).map(t => t.trim()).filter(t => t.length >= 2),
  ));
}

function scoreEntry(entry: RelationshipEntry, tokens: string[], nowMs: number): number {
  let relevance = 0;
  const title = entry.title.toLowerCase();
  const statement = entry.statement.toLowerCase();
  for (const token of tokens) {
    if (entry.triggers.some(t => t.includes(token))) relevance += 3;
    else if (entry.applies_to.some(a => a.toLowerCase().includes(token))) relevance += 2;
    else if (title.includes(token)) relevance += 1.5;
    else if (statement.includes(token)) relevance += 1;
  }
  const ageMs = Math.max(0, nowMs - Date.parse(entry.updatedAt));
  const ageDays = ageMs / 86_400_000;
  const recency = 1 / (1 + ageDays / 14); // (0,1], ~half-life at 14 days
  return relevance + (TYPE_WEIGHT[entry.type] ?? 1) + recency * 2;
}

function renderHeader(agent: string): string {
  return `[RELATIONSHIP — ${agent}]`;
}

function renderLine(entry: RelationshipEntry): string {
  const why = entry.why ? ` — why: ${entry.why}` : '';
  return `- (${entry.type}) ${entry.title}: ${entry.statement}${why}`;
}
