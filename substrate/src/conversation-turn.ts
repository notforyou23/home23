/**
 * THE definition of a conversation turn — one copy, no side effects.
 *
 * A conversation file holds far more than turns: stream events
 * ({data,kind,seq,ts,turn_id,type}), turn-completion markers
 * ({chat_id,ended_at,status,…}), tool-use placeholders, attachment markers.
 * Only language between jtr and the individual is life; the rest is plumbing
 * residue that must never reach the seed's diet.
 *
 * This lived inline in conversation-shipper.ts while the shipper-flow PROBE
 * separately approximated it by comparing a conversation file's MTIME against
 * the stream's last content timestamp. Those are different quantities:
 * trailing non-turn records bump mtime without producing a shippable turn, so
 * a perfectly healthy shipper read as "61min behind" with nothing actually
 * unshipped (jerry, 2026-08-13). Two definitions of "a turn" drifted apart, as
 * two definitions always do.
 *
 * It lives HERE, in src/ rather than in the shipper binary, because the
 * shipper validates its env at module scope and calls main() — importing it
 * from the probe exited the probe process. A shared predicate must be
 * importable without starting anything.
 */

export interface ShippableTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export function shippableTurn(rec: Record<string, unknown>): ShippableTurn | null {
  const role = rec['role'];
  if (role !== 'user' && role !== 'assistant') return null;
  const text = rec['content'];
  if (typeof text !== 'string' || text.trim().length < 3) return null;
  // Language only — tool-use placeholders and attachment markers are plumbing
  // residue, not the life. ("[Used tools: shell]", "[image]" …)
  if (/^\[[^\]]{1,200}\]$/.test(text.trim())) return null;
  const ts = rec['ts'];
  if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) return null;
  return { role, text, ts };
}
