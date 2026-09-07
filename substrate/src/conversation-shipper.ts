import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalContactTurn, isLegacyConversationSession, shippableTurn } from './conversation-turn.js';

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
  if (existsSync(options.streamPath)) {
    const raw = readFileSync(options.streamPath, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete conversation stream record');
    for (const line of raw.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (typeof record.contactId === 'string') seen.add(record.contactId);
    }
  }
  return {
    pass(now = Date.now()) {
      let shipped = 0;
      const sources = readdirSync(options.conversationsDir).filter(isLegacyConversationSession)
        .map(name => ({ path: join(options.conversationsDir, name), key: name, canonical: false }));
      if (options.coordinationSource && existsSync(options.coordinationSource)) sources.push({
        path: options.coordinationSource, key: `canonical:${options.coordinationSource}`, canonical: true,
      });
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
          if (seen.has(contactId)) continue;
          const vector = options.embed(turn.text);
          const output = { ts: turn.ts, role: turn.role, text: turn.text,
            session: turn.session ?? basename(source.path, '.jsonl'), contactId,
            sourceRef: turn.sourceRef ?? `legacy.conversation:${source.key}`,
            voice: turn.voice ?? (turn.role === 'user' ? 'jtr' : 'self'),
            ...(turn.actor ? { actor: turn.actor } : {}),
            ...(vector !== null ? { semantic_vector: vector } : {}) };
          mkdirSync(dirname(options.streamPath), { recursive: true, mode: 0o700 });
          appendFileSync(options.streamPath, JSON.stringify(output) + '\n', { mode: 0o600 });
          const outputFd = openSync(options.streamPath, 'r');
          try { fsyncSync(outputFd); } finally { closeSync(outputFd); }
          seen.add(contactId);
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
