import { timingSafeEqual } from 'node:crypto';
import type { ChannelAdapter } from './router.js';

export interface OwnerOutreachInput {
  text: string;
  reason: string;
  deliveryId: string;
  evidenceRefs?: string[];
}

export interface OwnerOutreachReceipt {
  status: 'committed' | 'queued';
  notification: 'not_confirmed';
  messageIds?: string[];
  channelId?: string;
}

export function validateOwnerOutreach(raw: unknown): OwnerOutreachInput {
  const input = raw as OwnerOutreachInput;
  if (!input || typeof input !== 'object'
      || Object.keys(input).some(key => !['text', 'reason', 'deliveryId', 'evidenceRefs'].includes(key))
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || input.text.includes('\0')
      || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 1000
      || typeof input.deliveryId !== 'string' || !input.deliveryId.trim() || input.deliveryId.length > 256
      || (input.evidenceRefs !== undefined && (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 16
        || input.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 512)))) {
    throw new TypeError('Owner outreach requires a bounded message, reason and stable delivery identity');
  }
  return { text: input.text.trim(), reason: input.reason.trim(), deliveryId: input.deliveryId,
    ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}) };
}

/** Initiate contact through the resident's existing durable Home23 outbox.
 * Canonical publication is not evidence of APNs acceptance or human reading. */
export function createOwnerOutreachSender(adapter: Pick<ChannelAdapter, 'send'>) {
  return async (raw: OwnerOutreachInput): Promise<OwnerOutreachReceipt> => {
    const input = validateOwnerOutreach(raw);
    const receipt = await adapter.send({ channel: 'home23', chatId: 'owner', text: input.text,
      deliveryId: `owner-outreach:${input.deliveryId}` });
    if (receipt?.status !== 'delivered' && receipt?.status !== 'queued') {
      throw new Error('Home23 owner outreach returned no durable delivery receipt');
    }
    return { status: receipt.status === 'delivered' ? 'committed' : 'queued', notification: 'not_confirmed',
      ...('messageIds' in receipt ? { messageIds: receipt.messageIds as string[] } : {}) };
  };
}

export function createOwnerOutreachHandler(options: {
  token: string;
  send: (input: OwnerOutreachInput) => Promise<OwnerOutreachReceipt>;
}) {
  return async (req: { headers: { authorization?: string }; body?: unknown }, res: {
    status(code: number): { json(body: unknown): void }; json(body: unknown): void;
  }) => {
    const expected = Buffer.from(`Bearer ${options.token}`);
    const provided = Buffer.from(req.headers.authorization || '');
    if (!options.token || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    let input: OwnerOutreachInput;
    try { input = validateOwnerOutreach(req.body); }
    catch { res.status(400).json({ error: 'invalid_owner_outreach' }); return; }
    try { res.json(await options.send(input)); }
    catch { res.status(503).json({ error: 'owner_conversation_unavailable' }); }
  };
}
