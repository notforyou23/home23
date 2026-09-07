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
 *   SHIPPER_COORDINATION_SOURCE — Core-owned canonical contact projection
 *   SHIPPER_CURSOR_PATH       — cursor JSON (default: <stream>.cursor.json)
 *   SHIPPER_POLL_MS           — poll interval (default 30000)
 *   SHIPPER_BACKFILL_BYTES    — per-file first-pass backfill (default 4096)
 *   SHIPPER_MAX_AGE_DAYS      — ignore files older than this (default 14)
 */

import { appendFileSync, existsSync } from 'node:fs';
import { fetchRawEmbedding } from '../src/embed-fetch.js';
import { createConversationShipper } from '../src/conversation-shipper.js';
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

function embedTurn(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  // Bounded synchronous call to the local embedder (writer-side perception)
  // — single fetch implementation in substrate/src/embed-fetch.ts.
  const raw = fetchRawEmbedding(trimmed, EMBED_DIM);
  return raw === null ? null : projectEmbedding(raw);
}

function main(): void {
  console.log(`[conversation-shipper] dir=${conversationsDir} → ${streamPath} poll=${pollMs}ms backfill=${backfillBytes}B maxAge=${maxAgeDays}d`);
  if (!existsSync(streamPath as string)) appendFileSync(streamPath as string, '');
  const shipper = createConversationShipper({
    conversationsDir: conversationsDir as string, streamPath: streamPath as string, cursorPath,
    coordinationSource: process.env['SHIPPER_COORDINATION_SOURCE'], backfillBytes, maxAgeDays, embed: embedTurn,
  });
  const tick = (): void => {
    try {
      const n = shipper.pass();
      if (n > 0) console.log(`[conversation-shipper] shipped ${n} turn(s)`);
    } catch (err) {
      console.error('[conversation-shipper] pass failed:', err);
    }
  };
  tick();
  // Keep-alive poll: NEVER unref this timer (the resident-exit lesson).
  setInterval(tick, pollMs);
}

/**
 * Run ONLY when invoked as the process, never on import — an import must not
 * become a SECOND writer appending to one stream, the fork this house forbids
 * everywhere else.
 *
 * Ask the question in a way a SUPERVISED process can answer. Under PM2 fork
 * mode argv[1] is PM2's own `ProcessContainerFork.js` and the real entry point
 * is named in `pm_exec_path`; an argv[1]-only check therefore reads the live
 * shipper as an import, main() never runs, and the process exits 0 in seconds
 * with its banner unprinted — `pm2 list` says "online" while the life-feed is
 * gone. That cost 3,939 restarts and ~3.2h of unshipped conversation on
 * 2026-08-13. Either name being this file means we ARE the shipper.
 */
const SELF = /conversation-shipper\.(ts|js)$/;
const invokedDirectly = SELF.test(process.argv[1] ?? '')
  || SELF.test(process.env['pm_exec_path'] ?? '');
if (invokedDirectly) main();
