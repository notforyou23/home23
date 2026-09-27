'use strict';

const fs = require('node:fs');

/** Read the existing resident-scoped Seed contact stream. No ingestion, cursor,
 * or synthesized user speech: this is a view of the shipper's committed turns.
 * The stream is post canonicalContactTurn validation; check its retained
 * provenance here rather than treating arbitrary JSONL as conversation. */
function readRecentConversationEntries(streamPath, options = {}) {
  if (!streamPath) return [];
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const maxAgeMs = options.maxAgeMs ?? 72 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 24;
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  let fd;
  let raw;
  try {
    fd = fs.openSync(streamPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxReadBytes);
    const buffer = Buffer.alloc(size - start);
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    raw = buffer.subarray(0, count).toString('utf8');
    if (start > 0) {
      const newline = raw.indexOf('\n');
      if (newline < 0) return [];
      raw = raw.slice(newline + 1);
    }
    // A writer's unfinished last line is not yet a committed contact.
    raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }

  const entries = new Map();
  for (const line of raw.split('\n')) {
    let turn;
    try { turn = JSON.parse(line); } catch { continue; }
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || !turn.text.trim()) continue;
    const at = Date.parse(turn.ts);
    if (!Number.isFinite(at) || at > now || now - at > maxAgeMs) continue;
    if (typeof turn.session !== 'string' || typeof turn.sourceRef !== 'string') continue;
    let label;
    if (turn.sourceRef.startsWith('coordination.message:')) {
      const messageId = turn.sourceRef.slice('coordination.message:'.length);
      const actor = turn.actor;
      if (!messageId || turn.contactId !== `message:${messageId}` || !turn.session.startsWith('coordination:')
          || !actor || typeof actor.principalId !== 'string' || typeof actor.displayName !== 'string'
          || !['owner', 'bot'].includes(actor.kind) || !['jtr', 'self', 'peer'].includes(turn.voice)
          || (turn.voice === 'jtr') !== (actor.kind === 'owner')
          || (turn.voice === 'self') !== (turn.role === 'assistant')) continue;
      label = `${turn.voice === 'jtr' ? 'Owner' : turn.voice === 'self' ? 'Resident' : 'Peer'} ${actor.displayName}`;
    } else if (turn.sourceRef.startsWith('legacy.conversation:')
        && turn.voice === (turn.role === 'user' ? 'jtr' : 'self')) {
      label = turn.role === 'user' ? 'Owner (legacy conversation)' : 'Resident (legacy conversation)';
    } else continue;
    const eventId = turn.contactId || `${turn.sourceRef}:${turn.ts}:${turn.role}`;
    entries.set(eventId, { ts: turn.ts, chatId: turn.session, eventId, source: 'seed_contact',
      summary: `[${label}; ${turn.ts}]\n${turn.text}` });
  }
  return [...entries.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-maxEntries);
}

module.exports = { readRecentConversationEntries };
