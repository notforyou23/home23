/** Bounded, read-only resolution of quote-gated owner pointers to local language turns. */
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { containsOwnerSecret, normalizeOwnerQuote, ownerSessions, type OwnerContactTurn } from './owner-distill.js';
import type { OwnerConversationEvidence, OwnerConversationQuery } from './owner-conversation-recall.js';

export const OWNER_TRANSCRIPT_LIMITS = Object.freeze({ bytesPerFile: 1_048_576, totalBytes: 8_388_608,
  directoryEntries: 8_192, files: 128, recordsPerFile: 4_000, sessions: 8, turns: 8, excerptChars: 650 });
export interface OwnerTranscriptOptions {
  instanceDir: string;
  agentName: string;
  /** Owner distillation uses 30 minutes unless explicitly configured. */
  sessionGapMs?: number;
  limits?: Partial<typeof OWNER_TRANSCRIPT_LIMITS>;
}
interface RawBlock {
  sourceRef: string; channel: string; ts: string;
  user?: OwnerContactTurn; assistants: OwnerContactTurn[];
}
interface AttributedContact extends OwnerContactTurn { direct: boolean }
interface ParsedFile { contacts: AttributedContact[]; blocks: RawBlock[]; kinds: Record<string, string>; complete: boolean; cost: number }
const cache = new Map<string, { stamp: string; parsed: ParsedFile }>();
let cacheChars = 0;
const CACHE_CHARS = 4_194_304;
const CACHE_FILES = 32;

function plainText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : undefined;
  // Check the whole turn before clipping, so a clip cannot hide a credential's label.
  // The file and whole-search byte budgets bound these strings. Preserve the
  // complete admitted turn until quote matching; distillation can cite its tail.
  return text?.trim() && !containsOwnerSecret(text) ? text : undefined;
}

function canonical(record: Record<string, any>, allowUnkinded: boolean): AttributedContact | undefined {
  const channel = typeof record.session === 'string' && record.session.startsWith('coordination:')
    ? record.session.slice('coordination:'.length) : '';
  const text = plainText(record.content ?? record.text);
  const ref = record.sourceRef;
  if (!channel || !text || (record.channelKind !== 'direct' && !(allowUnkinded && record.channelKind === undefined))
    || record.scheduled || record.runtime || record.worker
    || record.delegation_origin || record.delegatedContext || record.delegatedTurn || record.actor?.kind === 'subagent'
    || (record.channelId && record.channelId !== channel) || typeof record.ts !== 'string'
    || !Number.isFinite(Date.parse(record.ts)) || typeof ref !== 'string' || !ref.startsWith('coordination.message:')
    || record.contactId !== `message:${ref.slice('coordination.message:'.length)}`
    || (record.messageId && record.messageId !== ref.slice('coordination.message:'.length))
    || typeof record.actor?.principalId !== 'string') return undefined;
  const owner = record.role === 'user' && record.voice === 'jtr' && record.actor.kind === 'owner';
  if (!owner && !(record.role === 'assistant' && record.voice === 'self' && record.actor.kind === 'bot'
    && !text.startsWith('[scheduler]'))) return undefined;
  return { role: record.role, text, ts: record.ts, session: record.session, messageRef: ref, owner, canonical: true,
    direct: record.channelKind === 'direct' };
}

function parseFile(source: string, limit: number, clipped: boolean, allowUnkinded: boolean): ParsedFile {
  const contacts: AttributedContact[] = [];
  const blocks: RawBlock[] = [];
  const kinds: Record<string, string> = {};
  let block: RawBlock | undefined;
  let count = 0;
  let complete = !clipped && source.endsWith('\n');
  // Only committed JSONL lines qualify. An appending writer's tail waits.
  for (const line of source.slice(0, source.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.trim()) continue;
    if (++count > limit) { complete = false; break; }
    let record: Record<string, any>;
    try { record = JSON.parse(line); } catch { complete = false; continue; }
    if (!record || typeof record !== 'object') continue;
    if (typeof record.session === 'string' && record.session.startsWith('coordination:')
      && ['direct', 'group'].includes(record.channelKind) && typeof record.sourceRef === 'string'
      && record.sourceRef.startsWith('coordination.message:')
      && record.contactId === `message:${record.sourceRef.slice('coordination.message:'.length)}`
      && (!record.channelId || record.session === `coordination:${record.channelId}`)) {
      kinds[record.session] = kinds[record.session] && kinds[record.session] !== record.channelKind ? 'conflict' : record.channelKind;
    }
    const contact = canonical(record, allowUnkinded);
    if (contact) { contacts.push(contact); continue; }
    if (record.type === 'turn' && record.status === 'pending') {
      block = undefined;
      const origin = record.coordination_origin;
      if (origin?.kind !== 'coordination' || typeof origin.channelId !== 'string' || !/^chn_[\w-]+$/.test(origin.channelId)
        || typeof origin.originMessageId !== 'string' || !/^msg_[\w-]+$/.test(origin.originMessageId)
        || typeof record.started_at !== 'string' || !Number.isFinite(Date.parse(record.started_at))
        || record.context_purpose !== 'conversation' || record.delegation_origin || record.scheduled || record.runtime || record.worker) continue;
      block = { sourceRef: `coordination.message:${origin.originMessageId}`, channel: `coordination:${origin.channelId}`,
        ts: record.started_at, assistants: [] };
      blocks.push(block);
      continue;
    }
    if (record.type === 'turn' && record.status !== 'pending') {
      block = undefined;
      continue;
    }
    if (!block || record.type || record.executionControl || record.scheduled || record.runtime || record.worker
      || record.delegation_origin || record.actor?.kind === 'subagent') continue;
    const text = plainText(record.content);
    const ts = typeof record.ts === 'string' && Number.isFinite(Date.parse(record.ts)) ? record.ts : block.ts;
    if (!text || (record.role !== 'user' && record.role !== 'assistant') || text.startsWith('[scheduler]')) continue;
    const turn: OwnerContactTurn = { role: record.role, text, ts, session: block.channel,
      messageRef: record.role === 'user' ? block.sourceRef : `raw-owner-context:${block.sourceRef}:assistant:${block.assistants.length}`,
      owner: record.role === 'user', canonical: true };
    if (record.role === 'user') {
      // Tool results and runtime follow-ups have no owner attribution.
      if (!block.user) block.user = turn;
    } else if (block.assistants.length < 8) block.assistants.push(turn);
  }
  return { contacts, blocks, kinds, complete, cost: JSON.stringify({ contacts, blocks, kinds }).length };
}

function limits(options: OwnerTranscriptOptions): typeof OWNER_TRANSCRIPT_LIMITS {
  return Object.fromEntries(Object.entries(OWNER_TRANSCRIPT_LIMITS).map(([key, max]) => {
    const given = options.limits?.[key as keyof typeof OWNER_TRANSCRIPT_LIMITS];
    return [key, Number.isFinite(given) ? Math.max(1, Math.min(max, Math.floor(given!))) : max];
  })) as typeof OWNER_TRANSCRIPT_LIMITS;
}

function readBounded(path: string, budget: { bytes: number }, maxBytes: number, maxRecords: number,
  allowUnkinded = false): ParsedFile | undefined {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${maxBytes}:${maxRecords}:${allowUnkinded}`;
    const saved = cache.get(path);
    if (saved?.stamp === stamp) {
      cache.delete(path); cache.set(path, saved);
      return saved.parsed;
    }
    const bytes = Math.min(stat.size, maxBytes, budget.bytes);
    if (bytes <= 0) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return undefined;
    const start = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, start);
    budget.bytes -= read;
    let source = buffer.subarray(0, read).toString('utf8');
    if (start) source = source.slice(source.indexOf('\n') + 1);
    const parsed = parseFile(source, maxRecords, start > 0 || read < stat.size, allowUnkinded);
    // Only a full configured read can be cached; a spent request budget must not
    // poison future reads of the same mtime with a shorter partial result.
    if (bytes === Math.min(stat.size, maxBytes) && parsed.cost <= CACHE_CHARS) {
      if (saved) { cache.delete(path); cacheChars -= saved.parsed.cost; }
      cache.set(path, { stamp, parsed }); cacheChars += parsed.cost;
      while (cache.size > CACHE_FILES || cacheChars > CACHE_CHARS) {
        const key = cache.keys().next().value!;
        cacheChars -= cache.get(key)!.parsed.cost; cache.delete(key);
      }
    }
    return parsed;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function clippedText(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const wanted = new Set(terms);
  const positions = [...lower.matchAll(/[\p{L}\p{N}]+/gu)].filter(match => wanted.has(match[0]));
  let start = 0;
  let best = 0;
  for (const position of positions) {
    const candidate = Math.max(0, position.index - 35);
    const count = new Set(positions.filter(match => match.index >= candidate
      && match.index + match[0].length <= candidate + max - 2).map(match => match[0])).size;
    if (count > best) { start = candidate; best = count; }
  }
  return `${start ? '…' : ''}${text.slice(start, start + max - 2)}…`;
}

interface Snapshot { contacts: AttributedContact[]; blocks: RawBlock[]; kinds: Record<string, string>; complete: boolean; available: boolean }
function loadSnapshot(options: OwnerTranscriptOptions): Snapshot {
  const caps = limits(options);
  const budget = { bytes: caps.totalBytes };
  const contacts: AttributedContact[] = [];
  const blocks: RawBlock[] = [];
  const kinds: Record<string, string> = {};
  const mergeKinds = (incoming: Record<string, string>) => {
    for (const [channel, kind] of Object.entries(incoming)) {
      kinds[channel] = kinds[channel] && kinds[channel] !== kind ? 'conflict' : kind;
    }
  };
  let complete = true;
  let available = false;
  const stream = readBounded(join(options.instanceDir, 'substrate', 'conversation-stream.jsonl'), budget,
    caps.bytesPerFile, caps.recordsPerFile, true);
  if (stream) { available = true; contacts.push(...stream.contacts); mergeKinds(stream.kinds); complete &&= stream.complete; }
  let directory: ReturnType<typeof opendirSync> | undefined;
  const files: Array<{ path: string; mtime: number }> = [];
  try {
    const dir = join(options.instanceDir, 'conversations');
    if (lstatSync(dir).isSymbolicLink()) return { contacts, blocks, kinds, complete: false, available };
    directory = opendirSync(dir);
    let entries = 0;
    let entry;
    while ((entry = directory.readSync())) {
      if (++entries > caps.directoryEntries) { complete = false; break; }
      if (!entry.isFile() || !entry.name.startsWith(`${options.agentName}__coordination_chn_`)
        || !/^[\w-]+\.jsonl$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      try { files.push({ path, mtime: lstatSync(path).mtimeMs }); } catch { complete = false; }
    }
  } catch { /* Missing raw history can still resolve authenticated contact content. */ }
  finally { directory?.closeSync(); }
  if (files.length > caps.files) complete = false;
  for (const file of files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, caps.files)) {
    const parsed = readBounded(file.path, budget, caps.bytesPerFile, caps.recordsPerFile);
    if (!parsed) { complete = false; continue; }
    available = true;
    contacts.push(...parsed.contacts); blocks.push(...parsed.blocks); mergeKinds(parsed.kinds); complete &&= parsed.complete;
  }
  return { contacts, blocks, kinds, complete, available };
}

function enrichFromSnapshot(record: OwnerConversationEvidence, query: OwnerConversationQuery,
  options: OwnerTranscriptOptions, snapshot: Snapshot): OwnerConversationEvidence {
  const caps = limits(options);
  const { contacts, blocks } = snapshot;
  let complete = snapshot.complete;
  const refs = new Set(record.sourceRefs);
  const quote = normalizeOwnerQuote(record.quote);
  // The shipper preserves actor/message provenance but omits channelKind. A
  // quote-gated ledger citation certifies only its matching owner's channel;
  // unknown and explicitly grouped channels never qualify merely by filename.
  const directChannels = new Set(contacts.filter(turn => turn.owner && refs.has(turn.messageRef)
    && quote.length >= 3 && normalizeOwnerQuote(turn.text).includes(quote)).map(turn => turn.session));
  const eligible = contacts.filter(turn => !['group', 'conflict'].includes(snapshot.kinds[turn.session] ?? '')
    && (turn.direct || directChannels.has(turn.session)));
  const sessions = ownerSessions(eligible, options.sessionGapMs ?? 30 * 60_000).filter(session =>
    record.sessionRefs.includes(session.id) || session.turns.some(turn => turn.owner && refs.has(turn.messageRef)));
  if (sessions.length > caps.sessions) complete = false;
  const selectedSessions = sessions.slice(-caps.sessions);
  const chosen = selectedSessions.flatMap(session => session.turns);
  const ownerRefs = new Map(chosen.filter(turn => turn.owner).map(turn => [turn.messageRef, turn]));
  const companionOwnerTimes = new Map<string, number>();
  const occurredAt = Date.parse(record.occurredAt);
  const compatibleSources = new Map<string, number>();
  let rawQuoteAnchors = false;
  for (const block of blocks) {
    const pendingAt = Date.parse(block.ts);
    if (!block.user || ['group', 'conflict'].includes(snapshot.kinds[block.channel] ?? '')
      || !refs.has(block.sourceRef) || quote.length < 3 || !normalizeOwnerQuote(block.user.text).includes(quote)) continue;
    rawQuoteAnchors = true;
    if (pendingAt + 1_000 < occurredAt || pendingAt > query.nowMs) continue;
    // A turn can queue after owner arrival. Pick the closest attributable onset,
    // independent of ref insertion order; a tied distinct source stays unresolved.
    const proximity = Math.abs(pendingAt - occurredAt);
    compatibleSources.set(block.sourceRef, Math.min(compatibleSources.get(block.sourceRef) ?? Infinity, proximity));
  }
  const closestSources = [...compatibleSources].sort((a, b) => a[1] - b[1]);
  const preservedSource = closestSources[0] && closestSources[0][1] !== closestSources[1]?.[1] ? closestSources[0][0] : undefined;
  const unresolvedOccurrence = rawQuoteAnchors && !preservedSource;
  for (const block of blocks) {
    if (!block.user || ['group', 'conflict'].includes(snapshot.kinds[block.channel] ?? '')) continue;
    const contact = ownerRefs.get(block.sourceRef);
    if (contact && block.channel !== contact.session) continue;
    // Existing owner_conversation evidence was admitted only after owner-distill
    // checked the cited owner quote. Exact origin id plus quote checks its raw copy.
    const ledgerAnchor = refs.has(block.sourceRef) && quote.length >= 3
      && normalizeOwnerQuote(block.user.text).includes(quote);
    if (!contact && !ledgerAnchor) continue;
    // Raw message ts is assigned when the harness persists its completed turn.
    // The quote-matching source with compatible onset owns the preserved date;
    // old replay refs can appear last and must retain their independently recorded time.
    const latestSource = ledgerAnchor && block.sourceRef === preservedSource;
    const owner = contact ?? (latestSource ? { ...block.user, ts: record.occurredAt } : block.user);
    // The ledger retains no per-ref occurrence map. A compatible raw onset
    // supports this fallback but cannot independently certify a rewritten time.
    if (!contact && latestSource && Date.parse(block.user.ts) !== occurredAt) complete = false;
    if (!contact) { chosen.push(owner); ownerRefs.set(block.sourceRef, owner); }
    for (const assistant of block.assistants) companionOwnerTimes.set(assistant.messageRef, Date.parse(owner.ts));
    chosen.push(...block.assistants);
  }
  const seen = new Set<string>();
  const available = chosen.filter(turn => {
    const time = Date.parse(turn.ts);
    const windowTime = companionOwnerTimes.get(turn.messageRef) ?? time;
    const key = `${turn.role}\0${time}\0${normalizeOwnerQuote(turn.text)}`;
    // A safe reply is context for its admitted owner turn even when completion
    // crosses noon or midnight. Its actual time still excludes future content.
    if (time > query.nowMs || (query.window && (windowTime < query.window.start || windowTime >= query.window.end)) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (!available.some(turn => turn.owner)) return { ...record,
    transcriptResolution: unresolvedOccurrence || (snapshot.available && !snapshot.complete) ? 'incomplete' : 'unavailable' };
  const relevance = (turn: OwnerContactTurn) => query.terms.filter(term => turn.text.toLowerCase().includes(term)).length
    + (refs.has(turn.messageRef) ? 2 : 0);
  const selected = available.sort((a, b) => Number(b.owner) - Number(a.owner) || relevance(b) - relevance(a)
    || Date.parse(a.ts) - Date.parse(b.ts)).slice(0, caps.turns);
  // Reserve context space for one assistant even when a long session fills the owner cap.
  const assistant = available.find(turn => !turn.owner);
  if (assistant && selected.every(turn => turn.owner) && caps.turns > 1) selected[selected.length - 1] = assistant;
  selected.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const turns = selected.map(turn => {
    const text = clippedText(turn.text, query.terms, turn.owner ? 280 : 160);
    if (text !== turn.text) complete = false;
    return { role: turn.role, text, ts: turn.ts,
      ...(turn.messageRef.startsWith('raw-owner-context:') ? {} : { sourceRef: turn.messageRef }) };
  });
  const mostRelevantOwner = selected.filter(turn => turn.owner).sort((a, b) => relevance(b) - relevance(a))[0]!;
  const ownerDisplay = turns.find(turn => turn.sourceRef === mostRelevantOwner.messageRef)!;
  const assistantDisplay = turns.filter(turn => turn.role === 'assistant').sort((a, b) =>
    Math.abs(Date.parse(a.ts) - Date.parse(mostRelevantOwner.ts)) - Math.abs(Date.parse(b.ts) - Date.parse(mostRelevantOwner.ts)))[0];
  const display = [ownerDisplay, ...(assistantDisplay ? [assistantDisplay] : []),
    ...turns.filter(turn => turn !== ownerDisplay && turn !== assistantDisplay)];
  let excerpt = '';
  for (const turn of display) {
    const label = turn.role === 'user' ? 'owner verbatim' : 'assistant clipped';
    const part = `${excerpt ? '\n' : ''}[${label}] ${turn.text}`;
    const left = caps.excerptChars - excerpt.length;
    if (left < label.length + 8) { complete = false; break; }
    if (part.length > left) complete = false;
    excerpt += part.length <= left ? part : `${part.slice(0, left - 1)}…`;
  }
  const full = complete && available.length <= caps.turns;
  return { ...record, transcriptResolution: full ? 'resolved' : 'incomplete',
    transcript: { excerpt, turns, sourceRefs: [...new Set(turns.map(turn => turn.sourceRef).filter((ref): ref is string => !!ref))],
      sessionIds: selectedSessions.map(session => session.id), complete: full } };
}

/** One read budget and one lazily loaded local snapshot for the whole search.
 * An authenticated ledger quote can anchor its exact source in a raw turn;
 * unattributed neighboring user inputs never inherit that owner attribution. */
export function createOwnerConversationEnricher(options: OwnerTranscriptOptions):
  (record: OwnerConversationEvidence, query: OwnerConversationQuery) => OwnerConversationEvidence {
  let snapshot: Snapshot | undefined;
  return (record, query) => {
    if (!options.instanceDir || !/^[a-z0-9-]+$/.test(options.agentName) || containsOwnerSecret(record.quote)) {
      return { ...record, transcriptResolution: 'unavailable' };
    }
    snapshot ??= loadSnapshot(options);
    return enrichFromSnapshot(record, query, options, snapshot);
  };
}

/** Standalone one-record convenience; use the factory for federation batches. */
export function enrichOwnerConversationEvidence(record: OwnerConversationEvidence, query: OwnerConversationQuery,
  options: OwnerTranscriptOptions): OwnerConversationEvidence {
  return createOwnerConversationEnricher(options)(record, query);
}
