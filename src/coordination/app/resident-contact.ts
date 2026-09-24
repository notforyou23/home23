import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { M11Database } from '../work/types.js';

interface MessageRow {
  id: string; channelId: string; conversationId: string; principalId: string;
  actorKind: 'owner' | 'bot'; displayName: string; content: string; ts: string;
  sourceSequence: number; scheduled: number;
}

/** Core alone projects committed contact. Private model prompts are never a
 * conversation source. The files are replayable input, not another authority. */
export function createResidentContactProjection(database: M11Database, directory: string, residents: readonly string[]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const cursorPath = join(directory, 'cursor.json');
  const saved = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')) : null;
  let cursor = saved?.eventSequence ?? 0;
  let lastCheckAt = 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid resident contact cursor');
  const seen = new Map<string, Map<string, string>>();
  for (const slug of residents) {
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) throw new Error('Invalid contact resident');
    const ids = new Map<string, string>();
    const path = join(directory, `${slug}.jsonl`);
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw && !raw.endsWith('\n')) throw new Error(`Incomplete resident contact record: ${slug}`);
      for (const line of raw.split('\n').filter(Boolean)) {
        const value = JSON.parse(line);
        if (typeof value.contactId !== 'string') throw new Error('Invalid resident contact identity');
        ids.set(value.contactId, createHash('sha256').update(line).digest('hex'));
      }
    }
    seen.set(slug, ids);
    // A missing derived file is recoverable from Core. Replaying all contact
    // events preserves surviving files through their stable message identities.
    if ((saved?.contactCounts?.[slug] ?? 0) > ids.size) cursor = 0;
  }

  function project(messageId: string, slug: string, residentPrincipalId: string) {
    const message = database.readOne<MessageRow>(`SELECT m.id, m.channel_id AS channelId,
      h.id AS conversationId, m.author_principal_id AS principalId, m.author_kind AS actorKind,
      m.author_display_name AS displayName, m.body_text AS content, m.created_at AS ts,
      e.sequence AS sourceSequence, EXISTS(SELECT 1 FROM events s WHERE s.aggregate_kind='scheduled_channel_run'
        AND s.aggregate_version=1 AND json_extract(s.payload_json,'$.messageId')=m.id) AS scheduled
      FROM messages m JOIN conversation_handles h ON h.channel_id=m.channel_id
      JOIN events e ON e.aggregate_kind='message' AND e.aggregate_id=m.id AND e.aggregate_version=1
      WHERE m.id=? AND m.kind IN ('text','result') AND m.stored_visibility='visible'
        AND m.body_text IS NOT NULL`, messageId);
    if (!message || message.scheduled || !message.content.trim()) return;
    const value = { schema: 'home23.resident.contact.v1', contactId: `message:${message.id}`,
      sourceRef: `coordination.message:${message.id}`, sourceSequence: message.sourceSequence,
      channelId: message.channelId, session: `coordination:${message.channelId}`,
      conversationId: message.conversationId, messageId: message.id,
      actor: { principalId: message.principalId, kind: message.actorKind, displayName: message.displayName },
      voice: message.actorKind === 'owner' ? 'jtr' : message.principalId === residentPrincipalId ? 'self' : 'peer',
      role: message.principalId === residentPrincipalId ? 'assistant' : 'user',
      content: message.content, ts: message.ts };
    const line = JSON.stringify(value);
    const digest = createHash('sha256').update(line).digest('hex');
    const ids = seen.get(slug)!;
    if (ids.has(value.contactId)) {
      if (ids.get(value.contactId) !== digest) throw new Error(`Resident contact changed: ${value.contactId}`);
      return;
    }
    const path = join(directory, `${slug}.jsonl`);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    ids.set(value.contactId, digest);
  }

  return {
    /** Replayed events are deduplicated by canonical message identity. An input
     * is delivered only to a resident with an actual Work receiving it; an
     * output only to its author. No cross-resident transcript broadcast. */
    // This runs on Core's two-second timer. Each delivered contact can do a
    // synchronous SQLite lookup and a durable JSONL append, so keep one turn
    // small enough that backlog replay does not hold the HTTP event loop for
    // hundreds of disk operations. The persisted cursor resumes next turn.
    pump(limit = 8) {
      const startedAt = performance.now();
      // Advance through a bounded rowid page, including irrelevant events.
      // Filtering in SQL made SQLite choose a broad scan on large homes even
      // with LIMIT 8. The primary-key seek keeps each timer turn finite while
      // retaining one replay cursor across every historical event type.
      const rows = database.readAll<{ sequence: number; kind: string; id: string; version: number }>(
        "SELECT sequence, aggregate_kind AS kind, aggregate_id AS id, aggregate_version AS version FROM events NOT INDEXED WHERE sequence>? ORDER BY sequence LIMIT ?",
        cursor, Math.max(limit, 256));
      const previousCursor = cursor;
      let scanned = 0;
      for (const row of rows) {
        cursor = row.sequence;
        if (row.kind === 'work' && row.version === 1) {
          const work = database.readOne<{ messageId: string; slug: string; principalId: string }>(`SELECT w.origin_message_id AS messageId,
            b.resident_binding AS slug, b.principal_id AS principalId FROM works w JOIN bots b ON b.principal_id=w.target_principal_id WHERE w.id=?`, row.id);
          if (work?.messageId && seen.has(work.slug)) project(work.messageId, work.slug, work.principalId);
        } else if (row.kind === 'message' && row.version === 1) {
          const author = database.readOne<{ slug: string; principalId: string }>(`SELECT b.resident_binding AS slug,
            b.principal_id AS principalId FROM messages m JOIN bots b ON b.principal_id=m.author_principal_id WHERE m.id=?`, row.id);
          if (author && seen.has(author.slug)) project(row.id, author.slug, author.principalId);
        }
        if ((row.kind === 'work' || row.kind === 'message') && row.version === 1) scanned++;
        // Finish the current durable contact, then yield the event loop. The
        // budget is soft because an individual SQLite/fsync call is synchronous.
        if (scanned >= limit || performance.now() - startedAt >= 100) break;
      }
      if (cursor !== previousCursor || Date.now() - lastCheckAt >= 30_000) {
        const temp = `${cursorPath}.next`;
        const pending = !!database.readOne("SELECT sequence FROM events NOT INDEXED WHERE sequence>? LIMIT 1", cursor);
        writeFileSync(temp, JSON.stringify({ eventSequence: cursor, checkedAt: new Date().toISOString(), caughtUp: !pending,
          contactCounts: Object.fromEntries([...seen].map(([slug, ids]) => [slug, ids.size])) }), { mode: 0o600 });
        const fd = openSync(temp, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temp, cursorPath);
        const parent = openSync(dirname(cursorPath), 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
        lastCheckAt = Date.now();
      }
      return { eventSequence: cursor, scanned };
    },
  };
}
