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
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import type { OwnerConversationInput } from '../types.js';
import { embedTextSync } from '../substrate/embed-at-contact.js';
import { buildWriterSemanticStamp } from '../substrate/semantic-writer-stamp.js';
import { ownerConversationQuery, ownerConversationMatch, relationshipOwnerEvidence } from './owner-conversation-recall.js';
import { classifyOwnerConversation, hasConversationTimeIntent } from '../../shared/owner-conversation-policy.cjs';
import { normalizeLearningFeedback } from '../../shared/seed-learning.cjs';
import { appendSeedProjectionOnce as appendSourceProjection } from '../../shared/seed-source-projection.cjs';

// ─── Types ──────────────────────────────────────────────────

export type RelationshipEntryType =
  | 'thread'            // unfinished conversational thread
  | 'promise'           // a commitment/expectation (who owes what)
  | 'correction'        // a consequential correction jtr made
  | 'attenuation'       // authenticated feedback to give a scoped behavior less weight
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
  | 'owner_conversation'
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
    conversation_kind?: 'substantive' | 'verification' | 'recap' | 'mention';
    verification?: boolean;
    source_class?: string;
  };
  evidence_note?: string;
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];      // ids this entry replaces
  superseded_by?: string[];
  resolved_at?: string;       // for thread/promise when closed
  last_surfaced?: string;
  reuse_count: number;
  learning?: RelationshipLearningFeedback;
  /** Pending projections live with their source entry, so a failed append is
   * retryable without creating another store or inventing another experience. */
  seed_projection?: SeedSourceProjection;
}

export interface RelationshipLearningFeedback {
  schema: 'home23.learning-feedback.v1';
  decisionId?: string;
  cellId?: string;
  scope: string;
  direction: 'attenuate' | 'reinforce';
  tags?: string[];
  excludes?: string[];
  evidenceRefs: string[];
  basis: 'owner-feedback' | 'verified-outcome';
  supersedes?: string[];
  standing?: boolean;
  corroborates?: string[];
}

export interface SeedSourceProjection {
  schema: 'home23.seed-source-projection.v1';
  status: 'pending' | 'projected';
  event: Record<string, unknown> & { event_id: string };
  error?: string;
}

/** Compatibility export for existing relationship/memory writers. */
export function appendSeedProjectionOnce(eventsPath: string, event: SeedSourceProjection['event']): void {
  appendSourceProjection(eventsPath, event);
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
    conversation_kind?: 'substantive' | 'verification' | 'recap' | 'mention';
    verification?: boolean;
    source_class?: string;
  };
  evidence_note?: string;
  status?: RelationshipEntryStatus;
  supersedes?: string[];
  learning?: RelationshipLearningFeedback;
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
  owner_conversation: 0.8,
  curator: 0.7,
  manual: 0.8,
  jtr_correction: 0.95,
};
const DEFAULT_CONFIDENCE = 0.7;

const GENERATION_METHODS = new Set<RelationshipGenerationMethod>([
  'agent_note', 'owner_conversation', 'jtr_correction', 'curator', 'manual',
]);
const PRIVACY_CLASSES = new Set<PrivacyClass>(['internal', 'personal', 'sensitive']);
const ENTRY_TYPES = new Set<RelationshipEntryType>([
  'thread', 'promise', 'correction', 'attenuation', 'decision', 'preference',
  'aversion', 'shared_reference', 'miss_repair', 'why_it_mattered',
]);

// Active entries of these types are load-bearing and are never evicted for space.
const PROTECTED_TYPES = new Set<RelationshipEntryType>(['correction', 'attenuation', 'promise', 'decision']);

// Retrieval type weights — corrections/promises/decisions outrank touchstones.
const TYPE_WEIGHT: Record<RelationshipEntryType, number> = {
  correction: 3,
  attenuation: 3,
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
const ATTENUATION_LANGUAGE_PATTERN =
  /\b(?:noise|too (?:much|many)|stop|less|unnecessary|irrelevant|not (?:useful|helpful)|don't|do not|crowd(?:s|ing)?)\b/i;
const REINFORCEMENT_LANGUAGE_PATTERN =
  /\b(?:that (?:was|is) (?:useful|helpful)|that helped|that worked|keep (?:doing|noticing)|more (?:of|like) that|thank you|thanks)\b/i;
const STANDING_LANGUAGE_PATTERN =
  /\b(?:always|never|going forward|from now on|stop|don't|do not|remember to|please (?:keep|avoid))\b/i;

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

  /** Refresh long-lived readers after a background distiller writes. */
  reload(): void {
    if (!existsSync(this.ledgerPath)) { this.entries = []; return; }
    let raw: { entries?: RelationshipEntry[] };
    try { raw = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as { entries?: RelationshipEntry[] }; }
    catch { throw new Error('Unreadable relationship-ledger.json'); }
    if (!Array.isArray(raw.entries)) throw new Error('Invalid relationship-ledger.json: entries must be an array');
    this.entries = raw.entries;
  }

  private mutateEntries<T>(mutation: () => T, nonBlocking = false): T {
    if (!existsSync(this.ledgerPath)) {
      try { writeFileSync(this.ledgerPath, JSON.stringify({ schema: LEDGER_SCHEMA, agent: this.agent, entries: [] }), { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { release = lockfile.lockSync(this.ledgerPath, { stale: 30_000, update: 5_000 }); break; }
      catch (error) {
        if (nonBlocking || (error as NodeJS.ErrnoException).code !== 'ELOCKED' || attempt === 3) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    if (!release) throw new Error('Could not lock relationship-ledger.json');
    try { this.reload(); return mutation(); }
    finally { release(); }
  }

  // Atomic write: tmp file + rename, unlink-on-error (job-store idiom). The
  // ledger is curated and bounded (<= maxEntries), so pretty JSON is kept —
  // this file is the human inspection/correction surface, not a hot path.
  private persist(): void {
    const tmpPath = `${this.ledgerPath}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      const fd = openSync(tmpPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ schema: LEDGER_SCHEMA, agent: this.agent, entries: this.entries }, null, 2), 'utf-8');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmpPath, this.ledgerPath);
      const directory = openSync(dirname(this.ledgerPath), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Retry pending source projections at a normal turn boundary or restart.
   * "projected" establishes a durable input line, not Seed application. */
  flushSeedTeaching(): { projected: number; pending: number } {
    return this.mutateEntries(() => this.flushSeedTeachingUnlocked());
  }

  private flushSeedTeachingUnlocked(): { projected: number; pending: number } {
    let projected = 0;
    let changed = false;
    for (const entry of this.entries) {
      const projection = entry.seed_projection;
      if (!projection || projection.status !== 'pending') continue;
      try {
        appendSeedProjectionOnce(this.eventsPath, projection.event);
        projection.status = 'projected';
        delete projection.error;
        projected++;
      } catch (error) {
        projection.error = boundedText(error instanceof Error ? error.message : String(error), MAX_EVIDENCE_NOTE);
      }
      changed = true;
    }
    if (changed) this.persist();
    return { projected, pending: this.entries.filter(entry => entry.seed_projection?.status === 'pending').length };
  }

  // Best-effort sibling event log. Never throws — continuity annotation only.
  // When the event carries real language (semanticText), it is perceived at
  // contact (encoder stage 2): embedded locally, projected through the
  // published semantic projection, and the vector rides the line — Seeds
  // eating this stream eat meaning. Degraded-honest: no embedder, no vector.
  private emitEvent(eventType: string, entryId: string, payload: Record<string, unknown> = {}, semanticText?: string): void {
    try {
      const stamp = semanticText !== undefined
        ? buildWriterSemanticStamp({ vector: embedTextSync(semanticText), text: semanticText })
        : {};
      const line = JSON.stringify({
        event_id: randomUUID(),
        event_type: eventType,
        entry_id: entryId,
        agent: this.agent,
        ts: this.now(),
        // The words ride the event line too (complete text), not only the
        // vector: a Seed's recruited lobe can only reason about a teaching
        // it can read. The full entry stays in the ledger proper — this is
        // a bounded projection, a complete text projection.
        payload: semanticText !== undefined
          ? { learningVersion: 2, ...payload, head: semanticText.trim() }
          : { learningVersion: 2, ...payload },
        ...stamp,
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
   * teaching, the user turn must be a real recorded turn (validator), the
   * user text must express that feedback direction, and the entry's statement
   * must be the user's own claim (normalized). This is the sole path to actor:'jtr'.
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
    if (input.type !== 'correction' && input.type !== 'attenuation') return null;
    const sessionRefs = boundedList(input.provenance?.session_refs ?? [], MAX_REF_ITEMS, MAX_REF);
    if (!sessionRefs.includes(chatId)) return null;
    const statementClaim = normalizedClaim(input.statement);
    const userClaim = normalizedClaim(ingress.userText);
    if (!statementClaim || statementClaim !== userClaim) return null;
    const language = input.type === 'attenuation' ? ATTENUATION_LANGUAGE_PATTERN
      : input.learning?.direction === 'reinforce' ? REINFORCEMENT_LANGUAGE_PATTERN : CORRECTION_LANGUAGE_PATTERN;
    if (!language.test(ingress.userText)) return null;
    if (validator(ingress) !== true) return null;
    return messageRef;
  }

  // ── create ───────────────────────────────────────────────

  addEntry(input: RelationshipEntryInput, ingress?: AuthenticatedCorrectionIngress): RelationshipEntry {
    return this.mutateEntries(() => this.addEntryUnlocked(input, ingress));
  }

  private addEntryUnlocked(input: RelationshipEntryInput, ingress?: AuthenticatedCorrectionIngress): RelationshipEntry {
    if (!ENTRY_TYPES.has(input.type)) throw new Error(`Unknown relationship entry type: ${String(input.type)}`);
    const title = boundedText(input.title, MAX_TITLE);
    const statement = boundedText(input.statement, MAX_STATEMENT);
    if (!title) throw new Error('Relationship entry requires a non-empty title');
    if (!statement) throw new Error('Relationship entry requires a non-empty statement');

    let learning: RelationshipLearningFeedback | undefined;
    if (input.learning !== undefined) {
      const normalized = normalizeLearningFeedback({ ...input.learning,
        evidenceRefs: Array.isArray(input.learning.evidenceRefs)
          ? [...new Set([ingress?.messageRef, ...input.learning.evidenceRefs])]
          : input.learning.evidenceRefs,
      }) as RelationshipLearningFeedback | null;
      if (!normalized || normalized.basis !== 'owner-feedback'
          || !['correction', 'attenuation'].includes(input.type)
          || (input.type === 'attenuation') !== (normalized.direction === 'attenuate')
          || input.statement.trim().length > MAX_STATEMENT
          || !normalized.decisionId) {
        throw new Error('Conduct teaching requires a valid scoped owner-feedback record and the exact authenticated owner claim');
      }
      learning = normalized;
      // Retrying a stored authenticated entry does not mint authority again or
      // consume a second one-shot ingress token. It only retries its source
      // projection. No changed statement, target or scope can take this path.
      const previous = this.entries.find(entry => entry.actor === 'jtr' && entry.type === input.type
        && ingress && entry.provenance.source_refs.includes(ingress.messageRef)
        && normalizedClaim(ingress.userText) === normalizedClaim(statement)
        && normalizedClaim(entry.statement) === normalizedClaim(statement)
        && JSON.stringify(entry.learning) === JSON.stringify(learning));
      if (previous) { this.flushSeedTeachingUnlocked(); return previous; }
    }
    if (input.type === 'attenuation' && !learning) {
      throw new Error('Attenuation requires authenticated, scoped conduct feedback');
    }
    const correctionRef = this.earnedCorrectionRef(input, ingress);
    if (learning && !correctionRef) {
      throw new Error('Conduct teaching requires the exact authenticated owner claim');
    }

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
    const classification = method === 'owner_conversation' ? classifyOwnerConversation({
      sessionRefs: input.provenance?.session_refs, sourceRefs: input.provenance?.source_refs,
      provenance: input.provenance, text: [input.evidence_note, statement].filter(Boolean).join('\n'),
    }) : undefined;
    if (classification?.ownerEvidence === false) method = 'agent_note';

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
        ...(classification ? { conversation_kind: classification.kind } : {}),
        ...(classification?.verification ? { verification: true, source_class: 'verification' } : {}),
      },
      ...(input.evidence_note ? { evidence_note: boundedText(input.evidence_note, MAX_EVIDENCE_NOTE) } : {}),
      createdAt,
      updatedAt: createdAt,
      ...(input.supersedes && input.supersedes.length
        ? { supersedes: boundedList(input.supersedes, MAX_REF_ITEMS, MAX_REF) }
        : {}),
      reuse_count: 0,
      ...(learning ? { learning } : {}),
    };

    const semanticText = `${entry.title}. ${entry.statement}${entry.why ? `. ${entry.why}` : ''}`;
    entry.seed_projection = {
      schema: 'home23.seed-source-projection.v1', status: 'pending',
      event: {
        event_id: randomUUID(), event_type: 'entry_added', entry_id: entry.id,
        agent: this.agent, ts: createdAt,
        payload: { learningVersion: 2, type: entry.type, actor: entry.actor, method, head: semanticText,
          ...(learning ? { learning, owner_quote: ingress!.userText, owner_message_ref: correctionRef,
            source_refs: entry.provenance.source_refs, applies_to: entry.applies_to } : {}) },
        ...buildWriterSemanticStamp({ vector: embedTextSync(semanticText), text: semanticText }),
      },
    };

    this.entries.push(entry);
    this.evict();
    this.persist();
    this.flushSeedTeachingUnlocked();
    return entry;
  }

  /** Persist quote-gated owner evidence as an agent inference, never a correction. */
  upsertOwnerConversation(input: OwnerConversationInput & {
    type: 'decision' | 'preference' | 'aversion';
  }): RelationshipEntry {
    const statement = input.statement.trim();
    const quote = input.quote.trim();
    const classification = classifyOwnerConversation({ chatId: input.chatId, sessionId: input.sessionId,
      sessionRefs: [input.sourceSessionId], metadata: input.metadata,
      text: [input.conversationText, quote, statement].filter(Boolean).join('\n') });
    if (!classification.ownerEvidence) throw new Error('Verification conversations are not owner evidence');
    if (!['decision', 'preference', 'aversion'].includes(input.type)
        || !statement || statement.length > MAX_STATEMENT || !quote || quote.length > 2000
        || !input.messageRef || input.messageRef.length > MAX_REF
        || !input.sessionId || input.sessionId.length > MAX_REF
        || !Number.isFinite(Date.parse(input.occurredAt))) {
      throw new Error('Invalid owner conversation evidence');
    }
    const occurredAt = new Date(input.occurredAt).toISOString();
    const privacy = input.privacy === 'sensitive' || input.privacy === 'internal' ? input.privacy : 'personal';
    const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
    const conversationKind = (entry: RelationshipEntry) => classifyOwnerConversation({
      sessionRefs: entry.provenance.session_refs, sourceRefs: entry.provenance.source_refs, provenance: entry.provenance,
      text: [entry.evidence_note, entry.statement].filter(Boolean).join('\n'),
    }).kind;
    return this.mutateEntries(() => {
      const matches = this.entries.filter(entry => entry.type === input.type
        && entry.provenance.generation_method === 'owner_conversation'
        && normalize(entry.statement) === normalize(statement)
        && conversationKind(entry) === classification.kind);
      const existing = matches.find(entry => entry.status === 'active' && !entry.superseded_by?.length)
        ?? matches.find(entry => entry.status === 'superseded' && entry.updatedAt >= occurredAt);
      const replacementIds = boundedList(input.supersedes, MAX_REF_ITEMS, MAX_REF)
        .filter(id => id !== existing?.id && this.entries.some(entry => entry.id === id
          && entry.provenance.generation_method === 'owner_conversation'
          && (classification.kind === 'substantive' || conversationKind(entry) === classification.kind)
          && entry.updatedAt <= occurredAt));
      const recentRefs = (refs: string[], ref: string) => boundedList([
        ...refs.filter(value => value !== ref).slice(-7), ref,
      ], MAX_REF_ITEMS, MAX_REF);
      const hasNewEvidence = !existing?.provenance.source_refs.includes(input.messageRef);
      let entry: RelationshipEntry;
      if (existing) {
        entry = existing;
        entry.provenance.source_refs = recentRefs(entry.provenance.source_refs, input.messageRef);
        for (const ref of [input.sessionId, input.sourceSessionId, input.chatId]) {
          if (ref) entry.provenance.session_refs = recentRefs(entry.provenance.session_refs, ref);
        }
        if (occurredAt >= entry.updatedAt) { entry.updatedAt = occurredAt; entry.evidence_note = quote; }
        if (privacy === 'sensitive') entry.privacy_class = privacy;
        entry.supersedes = boundedList([...(entry.supersedes ?? []), ...replacementIds], MAX_REF_ITEMS, MAX_REF);
      } else {
        entry = {
          id: this.newId(occurredAt), type: input.type, title: statement.slice(0, MAX_TITLE), statement,
          actor: 'agent', agent: this.agent, status: 'active', confidence: 0.8, privacy_class: privacy,
          triggers: [], applies_to: ['owner'],
          provenance: { source_refs: [input.messageRef],
            session_refs: boundedList([input.sessionId, input.sourceSessionId, input.chatId].filter((ref): ref is string => Boolean(ref)), MAX_REF_ITEMS, MAX_REF),
            generation_method: 'owner_conversation', conversation_kind: classification.kind },
          evidence_note: quote, createdAt: occurredAt, updatedAt: occurredAt, reuse_count: 0,
          ...(replacementIds.length ? { supersedes: replacementIds } : {}),
        };
        this.entries.push(entry);
      }
      for (const id of replacementIds) {
        const previous = this.entries.find(candidate => candidate.id === id)!;
        previous.status = 'superseded';
        previous.superseded_by = boundedList([...(previous.superseded_by ?? []), entry.id], MAX_REF_ITEMS, MAX_REF);
        previous.updatedAt = occurredAt > previous.updatedAt ? occurredAt : previous.updatedAt;
      }
      this.evict();
      this.persist();
      // Preserve the existing observation format without invoking an embedder
      // from this background path. The durable ledger keeps the full evidence.
      if (hasNewEvidence) this.emitEvent(existing ? 'entry_evidence_added' : 'entry_added', entry.id, {
        type: entry.type, actor: entry.actor, method: 'owner_conversation', head: entry.statement,
      });
      for (const id of replacementIds) this.emitEvent('entry_superseded', id, { by: entry.id });
      return entry;
    }, true);
  }

  // ── read ─────────────────────────────────────────────────

  getEntry(id: string): RelationshipEntry | undefined {
    this.reload();
    return this.entries.find(e => e.id === id);
  }

  listEntries(filter: {
    type?: RelationshipEntryType;
    status?: RelationshipEntryStatus;
    includeRemoved?: boolean;
  } = {}): RelationshipEntry[] {
    this.reload();
    let list = this.entries.slice();
    if (filter.type) list = list.filter(e => e.type === filter.type);
    if (filter.status) {
      list = list.filter(e => e.status === filter.status);
    } else if (!filter.includeRemoved) {
      list = list.filter(e => e.status !== 'removed');
    }
    return list.sort(byNewestFirst);
  }

  /**
   * Query-aware recall: token/phrase match, not full-string substring.
   * withheldMatching counts only sensitive entries that matched the query.
   */
  searchEntries(query: string, opts: {
    type?: RelationshipEntryType;
    status?: RelationshipEntryStatus;
    excludePrivacy?: PrivacyClass[];
    generationMethod?: RelationshipGenerationMethod;
    nowMs?: number;
  } = {}): { entries: RelationshipEntry[]; withheldMatching: number } {
    this.reload();
    const exclude = new Set(opts.excludePrivacy ?? []);
    const all = this.entries.filter(e => e.status === (opts.status ?? 'active') && (!opts.type || e.type === opts.type))
      .filter(e => !opts.generationMethod || e.provenance.generation_method === opts.generationMethod);
    const nowMs = opts.nowMs ?? Date.parse(this.now());
    const ownerQuery = ownerConversationQuery(query, nowMs);
    const matching = all.filter(e => {
      if (e.provenance.generation_method !== 'owner_conversation') return !query.trim() || entryMatchesQuery(e, query);
      const record = relationshipOwnerEvidence(e);
      return record !== null && (!query.trim() || ownerConversationMatch(record, ownerQuery) !== null);
    });
    const withheldMatching = matching.filter(e => exclude.has(e.privacy_class)).length;
    const visible = matching.filter(e => !exclude.has(e.privacy_class));
    const tokens = relationshipQueryTerms(query);
    return { entries: rankRelationshipEntries(visible, tokens, nowMs, ownerQuery.timeIntent, Boolean(ownerQuery.window)), withheldMatching };
  }

  // ── mutate (no path here elevates actor to 'jtr') ────────

  supersede(
    oldId: string,
    newInput: RelationshipEntryInput,
    ingress?: AuthenticatedCorrectionIngress,
  ): RelationshipEntry {
    return this.mutateEntries(() => {
      const old = this.entries.find(entry => entry.id === oldId);
      if (!old) throw new Error(`Unknown relationship entry: ${oldId}`);
      const created = this.addEntryUnlocked({
        ...newInput,
        supersedes: [oldId, ...(newInput.supersedes ?? [])],
      }, ingress);
      old.status = 'superseded';
      old.superseded_by = [...(old.superseded_by ?? []), created.id];
      old.updatedAt = this.now();
      this.persist();
      this.emitEvent('entry_superseded', oldId, { by: created.id });
      return created;
    });
  }

  resolve(id: string): RelationshipEntry | undefined {
    return this.mutateEntries(() => {
      const entry = this.entries.find(candidate => candidate.id === id);
      if (!entry) return undefined;
      entry.status = 'resolved';
      entry.resolved_at = this.now();
      entry.updatedAt = entry.resolved_at;
      this.persist();
      this.emitEvent('entry_resolved', id, { type: entry.type });
      return entry;
    });
  }

  // Soft delete — provenance is preserved; the entry stays in the file so the
  // removal itself remains inspectable and jtr-reversible.
  remove(id: string, reason?: string): RelationshipEntry | undefined {
    return this.mutateEntries(() => {
      const entry = this.entries.find(candidate => candidate.id === id);
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
    });
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
   * Rank active entries by evidence quality, relevance and type weight, then
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
    /** Runtime-resolved subject for an elliptical follow-up such as "do it".
     * The caller supplies the actual conversation subject, not all history. */
    recentSubject?: string;
  }): RelationshipRetrieval {
    this.reload();
    const budget = Number.isFinite(opts.budgetChars) ? Math.max(0, Math.floor(opts.budgetChars)) : 0;
    const excluded = new Set(opts.excludePrivacy ?? []);
    const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
      ? opts.nowMs
      : Date.parse(this.now());
    const subject = opts.recentSubject?.trim() || query;
    const tokens = relationshipQueryTerms(subject);

    // "active" here = non-removed, non-superseded (resolved threads/promises
    // still carry relationship context). Privacy exclusions applied up front.
    const candidates = this.entries
      .filter(e => e.status !== 'removed' && e.status !== 'superseded')
      .filter(e => !excluded.has(e.privacy_class))
      .filter(e => isAuthenticatedGlobalInstruction(e)
        || (tokens.length > 0 && entryMatchesQuery(e, subject)));

    const ranked = rankRelationshipEntries(candidates, tokens, nowMs, hasConversationTimeIntent(query));

    const header = renderHeader(this.agent);
    let used = header.length;
    const included: RelationshipEntry[] = [];
    for (const e of ranked) {
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
    this.mutateEntries(() => {
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
    });
  }

  /** The whole ledger, newest-first — the jtr-correctable inspection surface. */
  toPublicJSON(): {
    schema: string;
    agent: string;
    generatedAt: string;
    count: number;
    entries: RelationshipEntry[];
  } {
    this.reload();
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
        e.seed_projection?.status !== 'pending' && e.provenance.generation_method !== 'owner_conversation'
        && (e.status === 'resolved' || e.status === 'removed' || e.status === 'superseded'));
      if (closedIdx >= 0) { this.entries.splice(closedIdx, 1); continue; }
      const droppableIdx = oldestIndex(this.entries, e =>
        e.seed_projection?.status !== 'pending' && e.provenance.generation_method !== 'owner_conversation'
        && e.status === 'active' && !PROTECTED_TYPES.has(e.type));
      if (droppableIdx >= 0) { this.entries.splice(droppableIdx, 1); continue; }
      // Only protected active entries remain — refuse to drop them.
      console.warn(
        `[relationship-ledger] ${this.entries.length} entries exceed maxEntries ${this.maxEntries}, ` +
        `but all overflow candidates are protected — keeping them.`,
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

// These identify a recall request, not the subject of a durable correction.
// A date narrows owner conversation evidence; it does not establish overlap
// with an old relationship note that happens to contain the same numbers.
const RELATIONSHIP_GENERIC_TERMS = new Set(('a about an and are as at be been by can could did do does for from '
  + 'had has have how i in is it me my of on or our please recall remember said say show tell that the their '
  + 'them there these they this those to told us was we were what when where which who why will with would '
  + 'you your am he she no owner conversation conversations morning afternoon evening today yesterday '
  + 'brain talk talked discuss discussed re').split(' '));

function relationshipQueryTerms(query: string): string[] {
  const withoutDates = query
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi, ' ');
  return tokenize(withoutDates).filter(term => !RELATIONSHIP_GENERIC_TERMS.has(term));
}

export function normalizeRelationshipText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function relationshipSearchText(entry: RelationshipEntry): string {
  return normalizeRelationshipText([
    entry.title,
    entry.statement,
    entry.why ?? '',
    entry.evidence_note ?? '',
    ...entry.triggers,
    ...entry.applies_to,
  ].join(' '));
}

/** A high entry-type weight is not topical relevance. Only an authenticated
 * explicit global instruction can accompany an otherwise unrelated turn.
 * A standing telemetry preference remains scoped; standing alone is not global. */
function isAuthenticatedGlobalInstruction(entry: RelationshipEntry): boolean {
  if (entry.actor !== 'jtr' || entry.provenance.generation_method !== 'jtr_correction'
      || !entry.provenance.source_refs.length || !STANDING_LANGUAGE_PATTERN.test(entry.statement)) return false;
  return entry.applies_to.some(scope => scope.toLowerCase() === 'global')
    || (entry.learning?.standing === true && entry.learning.basis === 'owner-feedback'
      && (entry.learning.tags ?? []).some(tag => tag.toLowerCase() === 'global'));
}

/** Real meaningful term overlap, independent of entry kind and recency. */
export function relationshipLexicalScore(entry: RelationshipEntry, query: string): number {
  const tokens = relationshipQueryTerms(query);
  if (!tokens.length) return 0;
  const words = new Set(relationshipSearchText(entry).split(' '));
  return tokens.filter(token => words.has(token)).length / tokens.length;
}

/** Token/phrase match for recall — a quoted identity sentence must still hit. */
export function entryMatchesQuery(entry: RelationshipEntry, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const tokens = relationshipQueryTerms(q);
  if (tokens.length === 0) return false;
  const hay = relationshipSearchText(entry);
  const needle = normalizeRelationshipText(q);
  if (needle.length >= 8 && ` ${hay} `.includes(` ${needle} `)) return true;
  const words = new Set(hay.split(' '));
  const hits = tokens.filter(token => words.has(token)).length;
  return hits >= Math.min(3, Math.ceil(tokens.length * 0.4));
}

function rankRelationshipEntries(entries: RelationshipEntry[], tokens: string[], nowMs: number,
  timeIntent: boolean, preferOwnerWindow = false): RelationshipEntry[] {
  return entries.map(entry => {
    const classification = classifyOwnerConversation({ ...entry, provenance: entry.provenance,
      sessionRefs: entry.provenance.session_refs, sourceRefs: entry.provenance.source_refs,
      text: [entry.evidence_note, entry.statement].filter(Boolean).join('\n') });
    return { entry, classification,
      tier: { substantive: 3, recap: 2, mention: 1, verification: 0 }[classification.kind],
      score: scoreEntry(entry, tokens, nowMs, timeIntent)
        * { substantive: 1, recap: 0.5, mention: 0.35, verification: 0.05 }[classification.kind] };
  }).filter(({ entry, classification }) => entry.provenance.generation_method !== 'owner_conversation'
    || classification.ownerEvidence)
    .sort((a, b) => (preferOwnerWindow
      ? Number(b.entry.provenance.generation_method === 'owner_conversation') - Number(a.entry.provenance.generation_method === 'owner_conversation') : 0)
      || b.tier - a.tier || b.score - a.score || (timeIntent ? byNewestFirst(a.entry, b.entry) : 0))
    .map(({ entry }) => entry);
}

function scoreEntry(entry: RelationshipEntry, tokens: string[], nowMs: number, timeIntent: boolean): number {
  let relevance = 0;
  const title = new Set(tokenize(entry.title));
  const statement = new Set(tokenize(`${entry.statement} ${entry.why ?? ''} ${entry.evidence_note ?? ''}`));
  const triggers = new Set(entry.triggers.flatMap(tokenize));
  const appliesTo = new Set(entry.applies_to.flatMap(tokenize));
  for (const token of tokens) {
    if (triggers.has(token)) relevance += 3;
    else if (appliesTo.has(token)) relevance += 2;
    else if (title.has(token)) relevance += 1.5;
    else if (statement.has(token)) relevance += 1;
  }
  const ageMs = Math.max(0, nowMs - Date.parse(entry.updatedAt));
  const ageDays = ageMs / 86_400_000;
  const recency = timeIntent ? 1 / (1 + ageDays / 14) : 0; // ~half-life at 14 days for explicit time intent
  return relevance + (TYPE_WEIGHT[entry.type] ?? 1) + recency * 2;
}

function renderHeader(agent: string): string {
  return `[RELATIONSHIP — ${agent}]`;
}

function renderLine(entry: RelationshipEntry): string {
  const why = entry.why ? ` — why: ${entry.why}` : '';
  return `- (${entry.type}) ${entry.title}: ${entry.statement}${why}`;
}
