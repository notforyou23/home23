/**
 * COSMO Home 2.3 — Conversation History
 *
 * Per-chat message history persisted as JSONL.
 * Handles context window truncation with atomic tool-pair handling.
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Anthropic message types (simplified for storage)
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  ts?: string;  // ISO timestamp — absent on pre-2026-03-22 messages
}

export interface SessionBoundary {
  type: 'session_boundary';
  ts: string;
  trigger: string;  // 'telegram' | 'cron-heartbeat-pulse' | etc.
}

export type HistoryRecord = StoredMessage | SessionBoundary;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export class ConversationHistory {
  private dir: string;
  private maxChars: number;
  private namespace: string;

  constructor(dir: string, maxChars: number = 400_000, namespace: string = 'default') {
    this.dir = dir;
    this.maxChars = maxChars;
    this.namespace = namespace;
    mkdirSync(dir, { recursive: true });
  }

  /** Load all stored records for a chat (messages + session boundaries). */
  load(chatId: string): HistoryRecord[] {
    const filePath = this.filePath(chatId);
    if (!existsSync(filePath)) return [];

    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];

      // Per-line parse — skip bad lines instead of losing all history
      const records: HistoryRecord[] = [];
      let badLines = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as HistoryRecord;
          // Skip turn envelopes and events — those are for turn endpoints, not message history
          if (rec && typeof rec === 'object' && ('type' in rec) &&
              ((rec as { type: string }).type === 'turn' || (rec as { type: string }).type === 'event')) {
            continue;
          }
          records.push(rec);
        } catch {
          badLines++;
        }
      }
      if (badLines > 0) {
        console.warn(`[history] Skipped ${badLines} corrupted line(s) in ${chatId}`);
      }
      return records;
    } catch {
      console.warn(`[history] Failed to load history for ${chatId}`);
      return [];
    }
  }

  /** Append records to a chat's history. Adds timestamps to messages. Strips base64 image data to prevent context bloat. */
  append(chatId: string, records: HistoryRecord[]): void {
    const filePath = this.filePath(chatId);
    const now = new Date().toISOString();
    const timestamped = records.map(r => {
      // Session boundaries already have ts
      if ('type' in r && r.type === 'session_boundary') return r;
      // Add ts to messages that don't have one
      const msg = r as StoredMessage;
      const withTs = msg.ts ? msg : { ...msg, ts: now };
      // Strip base64 image data — store a placeholder instead
      if (Array.isArray(withTs.content)) {
        withTs.content = withTs.content.map(b => {
          if (b.type === 'image' && 'source' in b && b.source?.type === 'base64') {
            return { type: 'text' as const, text: `[image: ${b.source.media_type}]` };
          }
          return b;
        });
      }
      return withTs;
    });
    const lines = timestamped.map(r => JSON.stringify(r)).join('\n') + '\n';
    appendFileSync(filePath, lines);
  }

  /** Load ALL records including turn envelopes and events. Use for turn endpoints, not message-building. */
  loadRaw(chatId: string): unknown[] {
    const filePath = this.filePath(chatId);
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const records: unknown[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // skip bad line
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /** Append a single arbitrary record as JSONL. No transformation. */
  appendRecord(chatId: string, record: unknown): void {
    const filePath = this.filePath(chatId);
    const line = JSON.stringify(record) + '\n';
    appendFileSync(filePath, line);
  }

  /** Truncate history to fit within maxChars budget. Filters out session boundaries — returns only StoredMessages for the API. */
  truncate(records: HistoryRecord[]): StoredMessage[] {
    // Filter to only StoredMessages for the Anthropic API
    const messages = records.filter((r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'));
    if (this.estimateChars(messages) <= this.maxChars) return messages;

    // Find a safe anchor: first user message and its assistant reply
    let anchorStart = 0;
    while (anchorStart < messages.length && messages[anchorStart]!.role !== 'user') {
      anchorStart++;
    }
    if (anchorStart >= messages.length) return messages.slice(-4); // fallback: keep last 4

    // Anchor is the first user message + next assistant message
    const anchorEnd = Math.min(anchorStart + 2, messages.length);
    const keep = messages.slice(anchorStart, anchorEnd);

    // Validate anchor: if the assistant message has tool_use blocks without matching results, skip it
    if (keep.length === 2) {
      const assistantMsg = keep[1]!;
      if (Array.isArray(assistantMsg.content) && assistantMsg.content.some(b => b.type === 'tool_use')) {
        // Tool_use in anchor without results — just keep the user message as anchor
        keep.length = 1;
      }
    }

    let rest = messages.slice(anchorEnd);

    // Remove messages from the front of `rest` until under budget
    while (rest.length > 2 && this.estimateChars([...keep, ...rest]) > this.maxChars) {
      // Check if the next message to remove is part of a tool-use/tool-result pair
      const msg = rest[0]!;
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(b => b.type === 'tool_use');
        if (hasToolUse) {
          const toolIds = msg.content
            .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
            .map(b => b.id);

          const toolNames = msg.content
            .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
            .map(b => b.name);

          const summary: StoredMessage = {
            role: 'assistant',
            content: `[Used tools: ${toolNames.join(', ')}]`,
          };

          rest.shift();

          while (rest.length > 0) {
            const next = rest[0]!;
            if (typeof next.content !== 'string' && Array.isArray(next.content)) {
              const hasMatchingResult = next.content.some(
                b => b.type === 'tool_result' && toolIds.includes((b as { tool_use_id: string }).tool_use_id)
              );
              if (hasMatchingResult) {
                rest.shift();
                continue;
              }
            }
            break;
          }

          rest.unshift(summary);
          continue;
        }
      }

      rest.shift();
    }

    const result = [...keep, ...rest];

    // Final safety: ensure first message is role=user (Anthropic API requirement)
    while (result.length > 0 && result[0]!.role !== 'user') {
      result.shift();
    }

    return result;
  }

  /** Rewrite the history file with provided records. */
  compact(chatId: string, records: HistoryRecord[]): void {
    const filePath = this.filePath(chatId);
    const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(filePath, content);
  }

  private filePath(chatId: string): string {
    const safeNamespace = this.namespace.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safeNamespace}__${safeChatId}.jsonl`);
  }

  get budget(): number {
    return this.maxChars;
  }

  estimateChars(records: HistoryRecord[]): number {
    return records.reduce((sum, r) => {
      if ('type' in r && r.type === 'session_boundary') return sum + 50;
      const m = r as StoredMessage;
      if (typeof m.content === 'string') return sum + m.content.length;
      return sum + JSON.stringify(m.content).length;
    }, 0);
  }
}
