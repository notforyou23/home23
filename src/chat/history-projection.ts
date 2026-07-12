import { isTurnEnvelope, isTurnEvent, type TurnEnvelope, type TurnEvent } from './turn-types.js';

type JsonRecord = Record<string, unknown>;

interface CanonicalAssistant {
  index: number;
  content: string;
  startIndex: number;
  endIndex: number;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? value as JsonRecord : null;
}

function storedAssistantText(record: unknown): string | null {
  const value = asRecord(record);
  if (!value || value.type === 'turn' || value.type === 'event' || value.role !== 'assistant') return null;
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return null;
  const text = value.content
    .map((block) => {
      const item = asRecord(block);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
  return text || null;
}

/**
 * Locate the durable assistant message written immediately before each
 * completed turn envelope. Older JSONL records do not carry turn_id on stored
 * messages, so the enclosing pending/end envelope pair is the authority.
 */
export function canonicalAssistantsForCompletedTurns(records: unknown[]): Map<string, CanonicalAssistant> {
  const starts = new Map<string, number>();
  const canonical = new Map<string, CanonicalAssistant>();

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isTurnEnvelope(record)) continue;
    if (record.status === 'pending') {
      starts.set(record.turn_id, index);
      continue;
    }
    if (record.status !== 'complete') continue;

    const start = starts.get(record.turn_id);
    if (start === undefined) continue;
    for (let candidate = index - 1; candidate > start; candidate--) {
      const content = storedAssistantText(records[candidate]);
      if (content !== null) {
        canonical.set(record.turn_id, {
          index: candidate,
          content,
          startIndex: start,
          endIndex: index,
        });
        break;
      }
    }
  }

  return canonical;
}

export function enrichTerminalEnvelope(
  records: unknown[],
  envelope: TurnEnvelope,
): TurnEnvelope {
  if (envelope.status !== 'complete' || envelope.assistant_content) return envelope;
  const canonical = canonicalAssistantsForCompletedTurns(records).get(envelope.turn_id);
  return canonical ? { ...envelope, assistant_content: canonical.content } : envelope;
}

function coalesceEvent(previous: unknown, current: TurnEvent): TurnEvent | null {
  if (!isTurnEvent(previous) || previous.turn_id !== current.turn_id || previous.kind !== current.kind) return null;
  if (current.kind !== 'response_chunk' && current.kind !== 'thinking') return null;

  const field = current.kind === 'thinking' ? 'content' : 'chunk';
  const before = typeof previous.data[field] === 'string' ? previous.data[field] as string : '';
  const after = typeof current.data[field] === 'string' ? current.data[field] as string : '';
  return {
    ...current,
    data: { ...previous.data, ...current.data, [field]: before + after },
  };
}

/**
 * Project mixed persistence/transport JSONL into a bounded display history.
 * Completed response deltas are replaced by the one durable assistant message;
 * pending deltas are coalesced before limiting so their prefix is not lost.
 */
export function projectChatHistoryRecords(records: unknown[], limit: number): unknown[] {
  const canonical = canonicalAssistantsForCompletedTurns(records);
  const canonicalIndex = new Map<number, { turnId: string; content: string }>();
  const supersededAssistantIndexes = new Set<number>();
  for (const [turnId, value] of canonical) {
    canonicalIndex.set(value.index, { turnId, content: value.content });
    for (let index = value.startIndex + 1; index < value.endIndex; index++) {
      if (index !== value.index && storedAssistantText(records[index]) !== null) {
        supersededAssistantIndexes.add(index);
      }
    }
  }

  const projected: unknown[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (supersededAssistantIndexes.has(index)) continue;
    if (isTurnEvent(record)
        && record.kind === 'response_chunk'
        && canonical.has(record.turn_id)) {
      continue;
    }

    const canonicalAtIndex = canonicalIndex.get(index);
    if (canonicalAtIndex) {
      projected.push({
        ...(asRecord(record) ?? {}),
        turn_id: canonicalAtIndex.turnId,
        canonical: true,
      });
      continue;
    }

    if (isTurnEnvelope(record) && record.status === 'complete') {
      const durable = canonical.get(record.turn_id);
      projected.push(durable && !record.assistant_content
        ? { ...record, assistant_content: durable.content }
        : record);
      continue;
    }

    if (isTurnEvent(record)) {
      const merged = coalesceEvent(projected[projected.length - 1], record);
      if (merged) {
        projected[projected.length - 1] = merged;
        continue;
      }
    }
    projected.push(record);
  }

  const bounded = Math.max(1, Math.floor(Number(limit) || 1));
  return projected.length > bounded ? projected.slice(-bounded) : projected;
}
