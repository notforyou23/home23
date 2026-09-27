import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../types.js';

export const contactOwnerTool: ToolDefinition = {
  name: 'contact_owner',
  description: 'Initiate a message to your owner in your own Home23 conversation when something happening merits contact: a useful finding, thoughtful connection, question, decision, or result. The owner can reply there. Explain why now and cite relevant evidence when available. Use your own voice, distinguish observation from speculation, and never invent urgency or a task just to speak. Ordinary replies belong in the current conversation. A committed result means saved in the conversation; it does not prove a phone alert or that the owner read it. Reuse delivery_id when retrying the same outreach.',
  input_schema: { type: 'object', required: ['text', 'reason'], additionalProperties: false, properties: {
    text: { type: 'string', maxLength: 4000 },
    reason: { type: 'string', minLength: 10, maxLength: 1000 },
    delivery_id: { type: 'string', maxLength: 256 },
    evidence_refs: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
  } },
  async execute(input, ctx) {
    if (!ctx.contactOwner) return { content: 'Your Home23 owner conversation is unavailable; no message was sent.', is_error: true };
    const text = typeof input.text === 'string' ? input.text : '';
    // The invocation ID persists across tool retries. Without one, use the
    // exact content and turn identity, never a fresh random retry identity.
    const fallback = createHash('sha256').update(JSON.stringify([ctx.agentName, ctx.chatId, ctx.parentToolCallId, text])).digest('hex');
    try {
      const receipt = await ctx.contactOwner({ text, reason: input.reason as string,
        deliveryId: typeof input.delivery_id === 'string' ? input.delivery_id : `tool:${fallback}`,
        ...(input.evidence_refs !== undefined ? { evidenceRefs: input.evidence_refs as string[] } : {}) });
      return { content: JSON.stringify(receipt) };
    } catch (error) {
      return { content: `Owner outreach failed: ${error instanceof Error ? error.message : String(error)}. Retry with the same delivery_id.`, is_error: true };
    }
  },
};
