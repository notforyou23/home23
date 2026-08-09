/**
 * Conversation shipper — the life-feed.
 *
 * Tails an agent's REAL conversation files (iOS / dashboard / telegram
 * sessions) and appends normalized turns to one stream the Seed eats:
 *   { ts, role, text, session, semantic_vector }
 *
 * Perception happens HERE, at the writer, once: each turn is embedded on the
 * local embedder and projected through the published species retina; the
 * vector rides the stream record forever (replay never re-perceives).
 * Degraded-honest: embedder down → the line ships without a vector.
 *
 * Read-only over the conversation files; append-only to the stream. Polls —
 * no watchers, no daemons beyond itself. Cursor survives restarts.
 *
 * Env:
 *   SHIPPER_CONVERSATIONS_DIR — instances/<agent>/conversations (required)
 *   SHIPPER_STREAM_PATH       — output stream JSONL (required)
 *   SHIPPER_CURSOR_PATH       — cursor JSON (default: <stream>.cursor.json)
 *   SHIPPER_POLL_MS           — poll interval (default 30000)
 *   SHIPPER_BACKFILL_BYTES    — per-file first-pass backfill (default 4096)
 *   SHIPPER_MAX_AGE_DAYS      — ignore files older than this (default 14)
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { projectEmbedding, EMBED_DIM } from '../src/semantic-projection.js';

const conversationsDir = process.env['SHIPPER_CONVERSATIONS_DIR'];
const streamPath = process.env['SHIPPER_STREAM_PATH'];
if (!conversationsDir || !streamPath) {
  console.error('SHIPPER_CONVERSATIONS_DIR and SHIPPER_STREAM_PATH are required');
  process.exit(1);
}
const cursorPath = process.env['SHIPPER_CURSOR_PATH'] ?? `${streamPath}.cursor.json`;
const pollMs = Number(process.env['SHIPPER_POLL_MS'] ?? 30_000);
const backfillBytes = Number(process.env['SHIPPER_BACKFILL_BYTES'] ?? 4096);
const maxAgeDays = Number(process.env['SHIPPER_MAX_AGE_DAYS'] ?? 14);

/** Real-session files only: iOS, dashboard, and numeric (telegram) chats.
 * Test/bootstrap/acceptance harness sessions are not the agent's life. */
const REAL_SESSION = /^[a-z0-9-]+__(ios_|dashboard-|-?\d+\.jsonl$)/;

function loadCursor(): Record<string, number> {
  try { return JSON.parse(readFileSync(cursorPath, 'utf-8')) as Record<string, number>; } catch { return {}; }
}
function saveCursor(cursor: Record<string, number>): void {
  writeFileSync(cursorPath, JSON.stringify(cursor, null, 1), 'utf-8');
}

function embedTurn(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  try {
    const body = JSON.stringify({ model: 'nomic-embed-text', prompt: trimmed.slice(0, 1000) });
    // Bounded synchronous call to the local embedder (writer-side perception).
    const raw = execFileSync('curl', ['-s', '-m', '2', 'http://127.0.0.1:11434/api/embeddings', '-d', body], { encoding: 'utf-8', timeout: 2500 });
    const parsed = JSON.parse(raw) as { embedding?: number[] };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIM) return null;
    return projectEmbedding(parsed.embedding);
  } catch {
    return null;
  }
}

function pass(cursor: Record<string, number>): number {
  let shipped = 0;
  const now = Date.now();
  let names: string[];
  try { names = readdirSync(conversationsDir as string); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !REAL_SESSION.test(name)) continue;
    const path = join(conversationsDir as string, name);
    let size: number, mtimeMs: number;
    try { const st = statSync(path); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    if (now - mtimeMs > maxAgeDays * 86_400_000) continue;
    let offset = cursor[name];
    if (offset === undefined) {
      // First contact with this file: modest backfill, aligned to a line start.
      offset = Math.max(0, size - backfillBytes);
      if (offset > 0) {
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(64 * 1024, size - offset));
          const read = readSync(fd, buf, 0, buf.length, offset);
          const nl = buf.subarray(0, read).indexOf(0x0a);
          offset = nl < 0 ? size : offset + nl + 1;
        } finally { closeSync(fd); }
      }
    }
    if (offset >= size) { cursor[name] = size; continue; }
    let chunk: string;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      chunk = buf.subarray(0, read).toString('utf-8');
    } finally { closeSync(fd); }
    // Only complete lines; a torn tail stays for the next pass.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) { continue; }
    const complete = chunk.slice(0, lastNl + 1);
    cursor[name] = offset + Buffer.byteLength(complete, 'utf-8');
    for (const line of complete.split('\n')) {
      if (line.trim() === '') continue;
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const role = rec['role'];
      if (role !== 'user' && role !== 'assistant') continue;
      const text = rec['content'];
      if (typeof text !== 'string' || text.trim().length < 3) continue;
      // Language only — tool-use placeholders and attachment markers are
      // plumbing residue, not the life. ("[Used tools: shell]", "[image]" …)
      if (/^\[[^\]]{1,200}\]$/.test(text.trim())) continue;
      const ts = typeof rec['ts'] === 'string' ? rec['ts'] : null;
      if (ts === null || !Number.isFinite(Date.parse(ts))) continue;
      const vector = embedTurn(text);
      const out = {
        ts,
        role,
        text: text.slice(0, 2000),
        session: basename(name, '.jsonl'),
        ...(vector !== null ? { semantic_vector: vector } : {}),
      };
      appendFileSync(streamPath as string, JSON.stringify(out) + '\n');
      shipped += 1;
    }
  }
  saveCursor(cursor);
  return shipped;
}

function main(): void {
  console.log(`[conversation-shipper] dir=${conversationsDir} → ${streamPath} poll=${pollMs}ms backfill=${backfillBytes}B maxAge=${maxAgeDays}d`);
  if (!existsSync(streamPath as string)) appendFileSync(streamPath as string, '');
  const cursor = loadCursor();
  const tick = (): void => {
    try {
      const n = pass(cursor);
      if (n > 0) console.log(`[conversation-shipper] shipped ${n} turn(s)`);
    } catch (err) {
      console.error('[conversation-shipper] pass failed:', err);
    }
  };
  tick();
  // Keep-alive poll: NEVER unref this timer (the resident-exit lesson).
  setInterval(tick, pollMs);
}

main();
