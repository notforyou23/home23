import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalContactTurn, isLegacyConversationSession, shippableTurn } from './conversation-turn.js';
import { buildWriterSemanticStamp } from './semantic-provenance.js';

/** Only compare across representations: two Core messages with different
 * message ids remain separate contacts even if their words and time match. */
function turnKey(role: unknown, text: unknown, ts: unknown): string | null {
  if ((role !== 'user' && role !== 'assistant') || typeof text !== 'string' || typeof ts !== 'string'
    || !Number.isFinite(Date.parse(ts))) return null;
  return createHash('sha256').update(JSON.stringify([role, text, Date.parse(ts)])).digest('hex');
}

export interface ConversationShipperOptions {
  conversationsDir: string; streamPath: string; cursorPath: string;
  coordinationSource?: string; backfillBytes: number; maxAgeDays: number;
  embed(text: string): number[] | null;
}

/** The writer perceives each contact once. A committed stream identity wins
 * over a lost cursor after a crash; retries never re-embed existing contact. */
export function createConversationShipper(options: ConversationShipperOptions) {
  let cursor: Record<string, number> = existsSync(options.cursorPath)
    ? JSON.parse(readFileSync(options.cursorPath, 'utf8')) : {};
  if (!cursor || typeof cursor !== 'object' || Object.values(cursor).some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error('Invalid conversation shipper cursor');
  }
  const seen = new Set<string>();
  const canonicalTurns = new Set<string>();
  const legacyTurns = new Set<string>();
  let canonicalIndexed = false;
  if (existsSync(options.streamPath)) {
    const raw = readFileSync(options.streamPath, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete conversation stream record');
    for (const line of raw.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (typeof record.contactId === 'string') seen.add(record.contactId);
      const key = turnKey(record.role, record.text, record.ts);
      if (key !== null) {
        if (typeof record.sourceRef === 'string' && record.sourceRef.startsWith('coordination.message:')) canonicalTurns.add(key);
        else legacyTurns.add(key);
      }
    }
  }
  return {
    pass(now = Date.now()) {
      let shipped = 0;
      if (!canonicalIndexed && options.coordinationSource && existsSync(options.coordinationSource)) {
        // A Core twin can predate its saved cursor without having its own
        // stream line (legacy may already have shipped). Index complete
        // projection records once on startup; never re-embed them.
        const raw = readFileSync(options.coordinationSource, 'utf8');
        const end = raw.lastIndexOf('\n');
        for (const line of raw.slice(0, end + 1).split('\n').filter(Boolean)) {
          const turn = canonicalContactTurn(JSON.parse(line));
          if (!turn) throw new Error('Invalid canonical contact provenance');
          canonicalTurns.add(turnKey(turn.role, turn.text, turn.ts)!);
        }
        canonicalIndexed = true;
      }
      const legacyFiles = existsSync(options.conversationsDir) ? readdirSync(options.conversationsDir) : [];
      const sources = legacyFiles.filter(isLegacyConversationSession)
        .map(name => ({ path: join(options.conversationsDir, name), key: name, canonical: false }));
      if (options.coordinationSource && existsSync(options.coordinationSource)) sources.push({
        path: options.coordinationSource, key: `canonical:${options.coordinationSource}`, canonical: true,
      });
      // Core supplies principal and message attribution. Read it first so a
      // legacy twin cannot win merely because directory iteration came first.
      sources.sort((a, b) => Number(b.canonical) - Number(a.canonical) || a.key.localeCompare(b.key));
      for (const source of sources) {
        const stat = statSync(source.path);
        if (!source.canonical && now - stat.mtimeMs > options.maxAgeDays * 86_400_000) continue;
        let offset = cursor[source.key];
        if (offset === undefined) {
          offset = source.canonical ? 0 : Math.max(0, stat.size - options.backfillBytes);
          if (offset > 0) {
            const fd = openSync(source.path, 'r');
            try {
              const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
              const bytes = readSync(fd, buffer, 0, buffer.length, offset);
              const newline = buffer.subarray(0, bytes).indexOf(10);
              offset = newline < 0 ? stat.size : offset + newline + 1;
            } finally { closeSync(fd); }
          }
        }
        if (offset > stat.size) throw new Error(`Conversation source shrank: ${source.key}`);
        if (offset === stat.size) continue;
        const fd = openSync(source.path, 'r');
        let chunk: Buffer;
        try {
          chunk = Buffer.alloc(stat.size - offset);
          chunk = chunk.subarray(0, readSync(fd, chunk, 0, chunk.length, offset));
        } finally { closeSync(fd); }
        const end = chunk.lastIndexOf(10);
        if (end < 0) continue;
        for (const line of chunk.subarray(0, end + 1).toString('utf8').split('\n').filter(Boolean)) {
          let record: Record<string, unknown>;
          try { record = JSON.parse(line); } catch {
            if (source.canonical) throw new Error('Invalid canonical contact JSON');
            continue;
          }
          const turn = source.canonical ? canonicalContactTurn(record) : shippableTurn(record);
          if (!turn) {
            if (source.canonical) throw new Error('Invalid canonical contact provenance');
            continue;
          }
          const contactId = turn.contactId ?? `legacy:${source.key}:${createHash('sha256').update(line).digest('hex')}`;
          const key = turnKey(turn.role, turn.text, turn.ts)!;
          if (source.canonical) canonicalTurns.add(key);
          if (seen.has(contactId)) continue;
          if (source.canonical ? legacyTurns.has(key) : canonicalTurns.has(key)) {
            // A lost cursor or a later projection must not repeat a contact.
            // Preserve old stream bytes; do not replace legacy provenance.
            seen.add(contactId);
            continue;
          }
          const vector = options.embed(turn.text);
          const output = { ts: turn.ts, role: turn.role, text: turn.text,
            session: turn.session ?? basename(source.path, '.jsonl'), contactId,
            sourceRef: turn.sourceRef ?? `legacy.conversation:${source.key}`,
            voice: turn.voice ?? (turn.role === 'user' ? 'jtr' : 'self'),
            ...(turn.actor ? { actor: turn.actor } : {}),
            ...buildWriterSemanticStamp({ vector, text: turn.text }) };
          mkdirSync(dirname(options.streamPath), { recursive: true, mode: 0o700 });
          appendFileSync(options.streamPath, JSON.stringify(output) + '\n', { mode: 0o600 });
          const outputFd = openSync(options.streamPath, 'r');
          try { fsyncSync(outputFd); } finally { closeSync(outputFd); }
          seen.add(contactId);
          if (!source.canonical) legacyTurns.add(key);
          shipped++;
        }
        cursor[source.key] = offset + end + 1;
      }
      const temp = `${options.cursorPath}.next`;
      mkdirSync(dirname(options.cursorPath), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(cursor), { mode: 0o600 });
      const fd = openSync(temp, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, options.cursorPath);
      const parent = openSync(dirname(options.cursorPath), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
      return shipped;
    },
  };
}
