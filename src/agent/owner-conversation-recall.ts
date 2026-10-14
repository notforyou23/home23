/** Read-only recall of quote-gated owner knowledge, without copying it into the graph. */
import type { MemoryObject } from '../types.js';
import type { RelationshipEntry } from './relationship-ledger.js';
import { classifyOwnerConversation, hasConversationTimeIntent } from '../../shared/owner-conversation-policy.cjs';
export { createOwnerConversationEnricher, enrichOwnerConversationEvidence, OWNER_TRANSCRIPT_LIMITS,
  type OwnerTranscriptOptions } from './owner-conversation-transcripts.js';

export interface OwnerConversationEvidence {
  id: string;
  kind: string;
  statement: string;
  quote: string;
  createdAt: string;
  occurredAt: string;
  sourceRefs: string[];
  sessionRefs: string[];
  privacyClass: 'internal' | 'personal' | 'sensitive';
  status: 'active' | 'approved';
  conversationKind?: 'substantive' | 'verification' | 'recap' | 'mention';
  transcript?: OwnerConversationTranscript;
  transcriptResolution?: 'resolved' | 'incomplete' | 'unavailable';
}

export interface OwnerConversationTranscript {
  excerpt: string;
  turns: Array<{ role: 'user' | 'assistant'; text: string; ts: string; sourceRef?: string }>;
  sourceRefs: string[];
  sessionIds: string[];
  complete: boolean;
}

export interface OwnerConversationQuery {
  terms: string[];
  phrase: string;
  recap: boolean;
  window: { start: number; end: number } | null;
  valid: boolean;
  nowMs: number;
  timeIntent: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const OWNER_CONVERSATION_TIMEZONE = 'America/New_York';
const OWNER_CALENDAR = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_CONVERSATION_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const STOP_WORDS = new Set(('a an and are as at be been by can could did do does for from had has have how i in is it '
  + 'me my of on or our please recall remember said say show tell that the their them there these they this those '
  + 'to told us was we were what when where which who why will with would you your owner conversation conversations '
  + 'talk talked discuss discussed recap summarize summarise about morning afternoon evening today yesterday').split(' '));

function ownerCalendar(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = Object.fromEntries(OWNER_CALENDAR.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** Convert a New York wall-clock boundary to UTC without depending on process TZ or a fixed UTC offset. */
function ownerBoundary(year: number, month: number, date: number, hour: number): number {
  const wall = Date.UTC(year, month, date, hour);
  let candidate = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = ownerCalendar(candidate);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const correction = wall - actual;
    candidate += correction;
    if (!correction) break;
  }
  return candidate;
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Owner date intent always uses the owner's New York calendar, including DST. */
export function ownerConversationQuery(query: string, nowMs = Date.now()): OwnerConversationQuery {
  const validNow = Number.isFinite(nowMs);
  const now = ownerCalendar(validNow ? nowMs : 0);
  let text = query.toLowerCase();
  const recap = /\b(?:talk(?:ed)?|discuss(?:ed)?|conversations?|recap|summari[sz]e)\b/.test(text);
  let day: Date | null = null;
  let valid = validNow;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const named = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/.exec(text);
  if (iso || named) {
    const match = (iso ?? named)!;
    const year = iso ? Number(match[1]) : Number(match[3] ?? now.year);
    const month = iso ? Number(match[2]) - 1 : MONTHS.indexOf(match[1]!.slice(0, 3));
    const date = Number(iso ? match[3] : match[2]);
    day = new Date(Date.UTC(year, month, date));
    valid = valid && day.getUTCFullYear() === year && day.getUTCMonth() === month && day.getUTCDate() === date;
    text = text.replace(match[0], ' ');
  } else if (/\b(?:today|yesterday|this morning|this afternoon|this evening|tonight|last night)\b/.test(text)) {
    const yesterday = /\b(?:yesterday|last night)\b/.test(text);
    day = new Date(Date.UTC(now.year, now.month - 1, now.day - (yesterday ? 1 : 0)));
  }
  let window: OwnerConversationQuery['window'] = null;
  if (day && valid) {
    const startHour = /\b(?:afternoon)\b/.test(text) ? 12
      : /\b(?:evening|tonight|last night)\b/.test(text) ? 18 : 0;
    const endHour = /\bmorning\b/.test(text) ? 12 : /\bafternoon\b/.test(text) ? 18 : 24;
    window = {
      start: ownerBoundary(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), startHour),
      end: ownerBoundary(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), endHour),
    };
  }
  text = text.replace(/\b(?:today|yesterday|this morning|this afternoon|this evening|tonight|last night)\b/g, ' ');
  if (window) text = text.replace(/\b(?:morning|afternoon|evening)\b/g, ' ');
  // Resolve dates first, then remove the participants in a generic recap.
  // "On Oct 14, what did Jason and I discuss?" must retain its day constraint.
  text = text.replace(/\bwhat\s+(?:did|have)\b.*?\b(?:talk(?:ed)?|discuss(?:ed)?)\b(?:\s+about)?/, ' ');
  const phrase = normalized(text);
  const terms = [...new Set(phrase.split(' ').filter(term => term.length >= 2 && !STOP_WORDS.has(term)))];
  return { terms, phrase, recap, window, valid, nowMs, timeIntent: Boolean(window) || hasConversationTimeIntent(query) };
}

function evidence(input: OwnerConversationEvidence): OwnerConversationEvidence | null {
  if (!input.id || !input.statement?.trim() || !input.quote?.trim()
      || !Number.isFinite(Date.parse(input.occurredAt)) || !Number.isFinite(Date.parse(input.createdAt))
      || !Array.isArray(input.sourceRefs) || !input.sourceRefs.some(ref => typeof ref === 'string' && ref.trim())
      || !Array.isArray(input.sessionRefs) || !input.sessionRefs.some(ref => typeof ref === 'string' && ref.trim())
      || !['internal', 'personal', 'sensitive'].includes(input.privacyClass)) return null;
  return input;
}

export function relationshipOwnerEvidence(entry: RelationshipEntry): OwnerConversationEvidence | null {
  if (entry.provenance?.generation_method !== 'owner_conversation' || entry.status !== 'active'
      || entry.superseded_by?.length) return null;
  const classification = classifyOwnerConversation({ ...entry,
    provenance: entry.provenance, sessionRefs: entry.provenance.session_refs,
    sourceRefs: entry.provenance.source_refs, text: `${entry.evidence_note ?? ''}\n${entry.statement}` });
  if (!classification.ownerEvidence) return null;
  return evidence({
    id: entry.id, kind: entry.type, statement: entry.statement, quote: entry.evidence_note ?? '',
    createdAt: entry.createdAt, occurredAt: entry.updatedAt,
    sourceRefs: entry.provenance.source_refs, sessionRefs: entry.provenance.session_refs,
    privacyClass: entry.privacy_class, status: 'active', conversationKind: classification.kind,
  });
}

export function factOwnerEvidence(object: MemoryObject): OwnerConversationEvidence | null {
  if (object.provenance?.generation_method !== 'owner_conversation' || object.lifecycle_layer !== 'durable'
      || object.status !== 'approved' || object.superseded_by?.length
      || !object.evidence?.evidence_links?.length
      || !object.privacy_class || !['internal', 'personal', 'sensitive'].includes(object.privacy_class)) return null;
  const classification = classifyOwnerConversation({ ...object,
    provenance: object.provenance, sessionRefs: object.provenance.session_refs,
    sourceRefs: object.provenance.source_refs, text: `${object.evidence.grounding_note ?? ''}\n${object.statement}` });
  if (!classification.ownerEvidence) return null;
  return evidence({
    id: object.memory_id, kind: 'fact', statement: object.statement, quote: object.evidence.grounding_note ?? '',
    createdAt: object.created_at, occurredAt: object.updated_at,
    sourceRefs: [...new Set([...(object.provenance.source_refs ?? []), ...object.evidence.evidence_links])],
    sessionRefs: object.provenance.session_refs, privacyClass: object.privacy_class, status: 'approved',
    conversationKind: classification.kind,
  });
}

/** Only the latest quote has a preserved evidence timestamp; never infer intermediate occurrence dates. */
export function ownerConversationMatch(record: OwnerConversationEvidence, query: OwnerConversationQuery): number | null {
  const occurredAt = Date.parse(record.occurredAt);
  if (!query.valid || occurredAt > query.nowMs
      || (query.window && (occurredAt < query.window.start || occurredAt >= query.window.end))) return null;
  // Assistant replies can quote previous brain_search results. They provide
  // context for a morning recap, but cannot create a new owner topic observation.
  const ownerText = record.transcript?.turns.filter(turn => turn.role === 'user').map(turn => turn.text).join('\n') ?? '';
  const hay = normalized(`${record.statement} ${record.quote} ${ownerText}`);
  const words = new Set(hay.split(' '));
  const matches = query.terms.filter(term => words.has(term)).length;
  const phraseMatch = query.phrase.length >= 8 && hay.includes(query.phrase);
  // Ledger heads are quote-gated pointers, not the transcript. Date intent must
  // reach those pointers even when their thin quote omits the requested topic.
  if (!query.window && (query.terms.length ? !phraseMatch && matches < Math.min(3, Math.ceil(query.terms.length * 0.4))
    : !query.recap)) return null;
  const recency = query.timeIntent ? 1 / (1 + Math.max(0, query.nowMs - occurredAt) / (14 * 86_400_000)) : 0;
  // Classify the cited owner quote first. A summary or assistant response can
  // repeat a real fact without becoming another substantive owner observation.
  const classification = classifyOwnerConversation({ text: `${record.quote}\n${record.statement}`,
    sessionRefs: record.sessionRefs, sourceRefs: record.sourceRefs,
    metadata: { conversationKind: record.conversationKind } });
  if (!classification.ownerEvidence) return null;
  const weight = { substantive: 1, recap: 0.5, mention: 0.35, verification: 0.05 }[classification.kind];
  return ((query.terms.length ? matches / query.terms.length : 0) + recency) * weight;
}

function excerpt(text: string, terms: string[], max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const wanted = new Set(terms);
  const positions = [...lower.matchAll(/[\p{L}\p{N}]+/gu)]
    .filter(match => wanted.has(match[0])).map(match => ({ term: match[0], index: match.index }));
  let start = 0;
  let best = 0;
  for (const match of positions) {
    const candidate = Math.max(0, match.index - 25);
    const count = new Set(positions.filter(position => position.index >= candidate
      && position.index + position.term.length <= candidate + max - 2).map(position => position.term)).size;
    if (count > best) { start = candidate; best = count; }
  }
  return `${start ? '…' : ''}${flat.slice(start, start + max - 2).trim()}…`;
}

/** Keep matching quote text visible even when a long summary uses the snippet budget. */
export function ownerConversationSnippet(record: OwnerConversationEvidence, query: OwnerConversationQuery): string {
  if (record.transcript?.excerpt) return record.transcript.excerpt;
  return `${excerpt(record.statement, query.terms, 65)} — owner quote: ${excerpt(record.quote, query.terms, 90)}`;
}
