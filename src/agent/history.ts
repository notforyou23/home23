import { estimateContextChars } from './context-pressure.js';
/**
 * COSMO Home 2.3 — Conversation History
 *
 * Per-chat message history persisted as JSONL.
 * Handles context window truncation with atomic tool-pair handling.
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { open, readdir } from 'node:fs/promises';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { atomicContextWrite, digest, TaskContextStore } from './task-context.js';

// Anthropic message types (simplified for storage)
export interface StoredMessage {
  role: 'user' | 'assistant';
  attachments?: import('../types.js').MediaAttachment[];
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
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; path?: string; fileName?: string }
  | { type: 'image_ref'; path: string; mimeType: string; fileName?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

// Thinking blocks are intra-turn only: their signatures are valid for the
// current tool-use loop but become invalid across separate turns (and across
// providers — MiniMax and Anthropic use different signature formats). Strip
// them when persisting and when loading so history replay is always safe.
function stripThinking(msg: StoredMessage): StoredMessage {
  if (!Array.isArray(msg.content)) return msg;
  const filtered = msg.content.filter(
    b => b.type !== 'thinking' && b.type !== 'redacted_thinking',
  );
  if (filtered.length === msg.content.length) return msg;
  // If stripping left nothing (e.g., thinking-only assistant message with no
  // text or tool_use), keep a text placeholder so the API doesn't reject an
  // empty content array.
  const content = filtered.length > 0 ? filtered : [{ type: 'text' as const, text: '' }];
  return { ...msg, content };
}

// Replace base64 image blocks with image_ref pointers (path + mime). The
// bytes already live on disk under instances/<agent>/uploads/chat/ or the
// channel-specific download dir, so we don't need to keep them in JSONL —
// we re-read on load(). Falls back to a text placeholder when no path is
// available (legacy in-memory image without source path).
function stripImageData(msg: StoredMessage): StoredMessage {
  if (!Array.isArray(msg.content)) return msg;
  let changed = false;
  const replaced = msg.content.map(b => {
    if (b.type === 'image' && 'source' in b && b.source?.type === 'base64') {
      changed = true;
      if (b.path) {
        return { type: 'image_ref' as const, path: b.path, mimeType: b.source.media_type, fileName: b.fileName };
      }
      return { type: 'text' as const, text: `[image: ${b.source.media_type}]` };
    }
    return b;
  });
  return changed ? { ...msg, content: replaced } : msg;
}

// Re-read image_ref blocks from disk into full base64 image blocks so the
// model can see the bytes on subsequent turns. Files that no longer exist
// fall back to a text placeholder with a "(file unavailable)" note.
function hydrateImageRefs(msg: StoredMessage): StoredMessage {
  if (!Array.isArray(msg.content)) return msg;
  let changed = false;
  const hydrated = msg.content.map(b => {
    if (b.type === 'image_ref') {
      changed = true;
      try {
        if (existsSync(b.path)) {
          const data = readFileSync(b.path).toString('base64');
          return {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: b.mimeType, data },
            path: b.path,
            fileName: b.fileName,
          };
        }
      } catch {
        // fall through to placeholder
      }
      return { type: 'text' as const, text: `[image: ${b.mimeType} (file unavailable)]` };
    }
    return b;
  });
  return changed ? { ...msg, content: hydrated } : msg;
}

export class ConversationHistory {
  private dir: string;
  private maxChars: number;
  private namespace: string;
  readonly taskContext: TaskContextStore;

  constructor(dir: string, maxChars: number = 400_000, namespace: string = 'default') {
    this.dir = dir;
    this.maxChars = maxChars;
    this.namespace = namespace;
    mkdirSync(dir, { recursive: true });
    this.taskContext = new TaskContextStore(join(dir, 'task-context', digest(namespace)));
  }

  /** Load all stored records for a chat (messages + session boundaries). */
  load(chatId: string): HistoryRecord[] {
    const filePath = this.filePath(chatId);
    if (!existsSync(filePath)) return [];

    try {
      const source = readFileSync(filePath, 'utf-8');
      const checkpoint = this.contextCheckpoint(chatId, source);
      const raw = (checkpoint ? checkpoint.records.map(r => JSON.stringify(r)).join('\n') + '\n' + source.slice(checkpoint.sourceChars) : source).trim();
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
              ((rec as { type: string }).type === 'turn' || (rec as { type: string }).type === 'event'
                || (rec as { type: string }).type === 'execution_control')) {
            continue;
          }
          // Exact-turn operator instructions are replay evidence, not input for sibling/successor turns.
          if (rec && typeof rec === 'object' && 'executionControl' in rec) continue;
          if (rec && typeof rec === 'object' && !('type' in rec && (rec as { type: string }).type === 'session_boundary')) {
            records.push(hydrateImageRefs(stripThinking(rec as StoredMessage)));
          } else {
            records.push(rec);
          }
        } catch {
          badLines++;
        }
      }
      if (badLines > 0) {
        console.warn(`[history] Skipped ${badLines} corrupted line(s) in ${chatId}`);
      }
      return records;
    } catch (error) {
      throw new Error(`History unavailable for ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Append records to a chat's history. Adds timestamps to messages. Strips base64 image data (replaced by image_ref pointing at the on-disk file) to prevent context bloat. */
  append(chatId: string, records: HistoryRecord[]): void {
    const filePath = this.filePath(chatId);
    const now = new Date().toISOString();
    const timestamped = records.map(r => {
      if ('type' in r && r.type === 'session_boundary') return r;
      const msg = r as StoredMessage;
      const withTs = msg.ts ? msg : { ...msg, ts: now };
      // Strip thinking blocks — they're intra-turn only; storing them leads
      // to "Invalid signature in thinking block" on replay when the signature
      // format no longer matches the current provider (e.g., MiniMax → Anthropic).
      // Then strip base64 image data — keep the disk path via image_ref so a
      // future load() can rehydrate the bytes back into a full image block.
      return stripImageData(stripThinking(withTs));
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

  /** Bounded janitor-only scan. Oversized/incomplete snapshots never authorize recovery. */
  async scanForRecovery(chatId: string, consume: (record: unknown) => void, onDeferred: (reason: string) => void = () => {}): Promise<((commit: () => void) => boolean) | null> {
    const path = this.filePath(chatId);
    const defer = (reason: string): null => { onDeferred(reason); return null; };
    const handle = await open(path, 'r').catch(() => null);
    if (!handle) return defer('open_failed');
    try {
      const before = await handle.stat();
      const same = (s: typeof before): boolean => s.dev === before.dev && s.ino === before.ino
        && s.size === before.size && s.mtimeMs === before.mtimeMs && s.ctimeMs === before.ctimeMs;
      const buffer = Buffer.alloc(64 * 1024);
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let position = 0;
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) return defer('short_read');
        position += bytesRead;
        carry += decoder.write(buffer.subarray(0, bytesRead));
        let newline: number;
        while ((newline = carry.indexOf('\n')) !== -1) {
          const line = carry.slice(0, newline);
          carry = carry.slice(newline + 1);
          if (line.length > 1024 * 1024) return defer('record_too_large');
          let record: unknown;
          if (!line.trim()) continue;
          try { record = JSON.parse(line); } catch { return defer('malformed_record'); }
          try { consume(record); } catch (error) {
            return defer(error instanceof Error && error.message === 'invalid_turn_metadata' ? 'invalid_turn_metadata' : 'metadata_limit');
          }
        }
        if (carry.length > 1024 * 1024) return defer('record_too_large');
        await yieldToIo();
      }
      carry += decoder.end();
      // A partial final record may be an in-progress append: defer the entire journal.
      if (carry.trim()) return defer('incomplete_record');
      if (!same(await handle.stat())) return defer('journal_changed');
      return (commit) => {
        // No yield between this fresh path check and terminal appends. Renames,
        // completions and new starts during the scan invalidate its authority.
        try {
          if (!same(statSync(path))) { defer('journal_changed'); return false; }
        } catch { defer('stat_failed'); return false; }
        commit();
        return true;
      };
    } catch {
      return defer('read_failed');
    } finally { await handle.close(); }
  }

  async listChatIdsForRecovery(): Promise<string[]> {
    const prefix = `${this.namespace.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    return (await readdir(this.dir).catch(() => []))
      .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .map(f => f.slice(prefix.length, -'.jsonl'.length))
      // Rotated archives contain dots and cannot round-trip through filePath().
      // The legacy reader already skipped these nonexistent sanitized aliases.
      .filter(chatId => chatId === chatId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  /** List all chatIds stored for this namespace. */
  listChatIds(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      const safeNs = this.namespace.replace(/[^a-zA-Z0-9_-]/g, '_');
      const prefix = `${safeNs}__`;
      return readdirSync(this.dir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.jsonl'))
        .map(f => f.slice(prefix.length, -'.jsonl'.length));
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

          rest.shift();

          const receipts: string[] = [];
          while (rest.length > 0) {
            const next = rest[0]!;
            if (typeof next.content !== 'string' && Array.isArray(next.content)) {
              const matching = next.content.filter(
                (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
                  b.type === 'tool_result' && toolIds.includes((b as { tool_use_id: string }).tool_use_id),
              );
              if (matching.length > 0) {
                for (const block of matching) {
                  receipts.push(String(block.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 400));
                }
                rest.shift();
                continue;
              }
            }
            break;
          }

          const receiptLines = toolNames.map((name, i) => `${name}: ${receipts[i] ?? ''}`.trim());
          const summary: StoredMessage = {
            role: 'assistant',
            content: `[Used tools: ${toolNames.join(', ')}]\n${receiptLines.join('\n')}`.trim(),
          };

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

  /** Build the active model view without rewriting canonical messages or turn events. */
  compact(chatId: string, records: HistoryRecord[], expectedRevision?: string): void {
    if (expectedRevision !== undefined && this.revision(chatId) !== expectedRevision) throw new Error('History changed during compaction; retry against current history');
    const file = this.filePath(chatId);
    const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
    this.archiveCurrent(chatId);
    const stripped = records.map(r => 'type' in r && r.type === 'session_boundary' ? r : stripImageData(stripThinking(r as StoredMessage)));
    atomicContextWrite(`${file}.context.json`, { version: 1, sourceChars: source.length, sourceHash: digest(source), records: stripped, compactedAt: new Date().toISOString() });
  }

  recordContextStatus(chatId: string, status: unknown): void { atomicContextWrite(`${this.filePath(chatId)}.pressure.json`, status); }
  contextStatus(chatId: string): unknown {
    const file = `${this.filePath(chatId)}.pressure.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  revision(chatId: string): string {
    const file = this.filePath(chatId);
    return digest((existsSync(file) ? readFileSync(file, 'utf8') : '') + '\0' + (existsSync(`${file}.context.json`) ? readFileSync(`${file}.context.json`, 'utf8') : ''));
  }

  archiveCurrent(chatId: string): string[] {
    const file = this.filePath(chatId);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const ids: string[] = [];
    for (let offset = 0; offset < raw.length; offset += 31000) ids.push(this.taskContext.save(chatId, 'transcript', raw.slice(offset, offset + 32000)));
    return ids;
  }

  private contextCheckpoint(chatId: string, source: string): { sourceChars: number; records: HistoryRecord[] } | null {
    const file = `${this.filePath(chatId)}.context.json`;
    if (!existsSync(file)) return null;
    const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
    if (checkpoint.version !== 1 || !Number.isSafeInteger(checkpoint.sourceChars) || checkpoint.sourceChars < 0 || checkpoint.sourceChars > source.length || !Array.isArray(checkpoint.records)
      || checkpoint.records.some((record: any) => !record || typeof record !== 'object'
        || (record.type !== 'session_boundary' && (!['user', 'assistant'].includes(record.role)
          || !(typeof record.content === 'string' || (Array.isArray(record.content) && record.content.every((block: any) => block && typeof block.type === 'string'))))))
      || digest(source.slice(0, checkpoint.sourceChars)) !== checkpoint.sourceHash) throw new Error('Context checkpoint does not match canonical history; original transcript retained');
    return checkpoint;
  }

  reset(chatId: string): void { this.rotate(chatId); }

  /** Move canonical history and its active view aside; begin a fresh task scope. */
  rotate(chatId: string): void {
    const filePath = this.filePath(chatId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = filePath.replace(/\.jsonl$/, `.${ts}.jsonl`);
    const moved: Array<[string, string]> = [];
    try {
      for (const suffix of ['', '.context.json', '.pressure.json']) {
        const source = `${filePath}${suffix}`;
        const target = `${archivePath}${suffix}`;
        if (existsSync(source)) { renameSync(source, target); moved.push([source, target]); }
      }
      this.taskContext.reset(chatId);
    } catch (error) {
      for (const [source, target] of moved.reverse()) {
        try { renameSync(target, source); } catch (rollbackError) { console.error('[history] Rotation rollback failed:', rollbackError); }
      }
      throw new Error(`Failed to rotate history safely: ${filePath}`, { cause: error });
    }
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
      return sum + estimateContextChars(m.content);
    }, 0);
  }
}
