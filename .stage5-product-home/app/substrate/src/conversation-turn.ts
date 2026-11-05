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
  contactId?: string;
  sourceRef?: string;
  session?: string;
  voice?: 'jtr' | 'self' | 'peer';
  actor?: { principalId: string; kind: 'owner' | 'bot'; displayName: string };
}

/** Harness task files contain private runtime instructions. Current app
 * contact comes from Core's canonical projection, never from those files. */
export function isLegacyConversationSession(name: string): boolean {
  return /^[a-z0-9-]+__(ios_|dashboard-|mac_|tv_|-?\d+\.jsonl$)/.test(name) && name.endsWith('.jsonl');
}

export function canonicalContactTurn(rec: Record<string, unknown>): ShippableTurn | null {
  if (rec.schema !== 'home23.resident.contact.v1') return null;
  const actor = rec.actor as ShippableTurn['actor'];
  if (!actor || typeof actor.principalId !== 'string' || typeof actor.displayName !== 'string'
    || !['owner', 'bot'].includes(actor.kind) || !['jtr', 'self', 'peer'].includes(String(rec.voice))
    || (rec.voice === 'jtr') !== (actor.kind === 'owner')
    || (rec.voice === 'self') !== (rec.role === 'assistant')
    || typeof rec.contactId !== 'string' || rec.contactId !== `message:${rec.messageId}`
    || rec.sourceRef !== `coordination.message:${rec.messageId}`
    || typeof rec.session !== 'string' || rec.session !== `coordination:${rec.channelId}`) return null;
  if ((rec.role !== 'user' && rec.role !== 'assistant') || typeof rec.content !== 'string'
    || !rec.content.trim() || typeof rec.ts !== 'string' || !Number.isFinite(Date.parse(rec.ts))) return null;
  return { role: rec.role, text: rec.content, ts: rec.ts, contactId: rec.contactId, sourceRef: rec.sourceRef as string,
    session: rec.session, voice: rec.voice as ShippableTurn['voice'], actor };
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
