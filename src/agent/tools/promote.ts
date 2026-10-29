/**
 * Home23 — promote_to_memory tool (Step 20)
 *
 * Agent calls this mid-conversation when it recognizes something
 * load-bearing: new convention, topology change, personal context,
 * key decision, correction, procedure.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import type { MemoryObject } from '../../types.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { embedTextSync } from '../../substrate/embed-at-contact.js';
import { buildWriterSemanticStamp } from '../../substrate/semantic-writer-stamp.js';
import { appendSeedProjectionOnce, type SeedSourceProjection } from '../relationship-ledger.js';

type ProjectableMemoryObject = MemoryObject & { seed_projection?: SeedSourceProjection };

/** Retry source projections from the existing memory store. This does not
 * promote candidates, reinterpret facts as feedback, or claim Seed applied
 * anything. A normal turn or a later promotion can finish a failed append. */
export async function flushMemorySeedProjections(ctx: ToolContext): Promise<{ projected: number; pending: number }> {
  const { MemoryObjectStore } = await import('../memory-objects.js');
  const brainDir = (ctx.personalWorkspacePath ?? ctx.workspacePath).replace('/workspace', '/brain');
  const store = ctx.memoryObjectStore ?? new MemoryObjectStore(brainDir);
  let projected = 0;
  for (const obj of store.readPendingSeedProjections() as ProjectableMemoryObject[]) {
    const projection = obj.seed_projection;
    if (!projection || projection.status !== 'pending') continue;
    let next: SeedSourceProjection;
    try {
      appendSeedProjectionOnce(join(brainDir, 'memory-objects.events.jsonl'),
        { ...projection.event, entry_id: obj.memory_id });
      next = { ...projection, status: 'projected' };
      delete next.error;
      projected++;
    } catch (error) {
      next = { ...projection, error: (error instanceof Error ? error.message : String(error)).slice(0, 600) };
    }
    if (!store.acknowledgeSeedProjection(obj.memory_id, projection.event.event_id, next)) {
      throw new Error('Memory source projection identity changed before acknowledgement');
    }
  }
  return { projected, pending: store.readPendingSeedProjections().length };
}

export const promoteToMemoryTool: ToolDefinition = {
  name: 'promote_to_memory',
  description: `Retain important knowledge with explicit triggers, scope, and a source projection. A new entry is a working candidate; do not claim approved durable recall or Seed learning until those stages are confirmed. Use this when:
- A new convention or rule is established
- House topology changes (new port, new service, new URL)
- Important personal context is shared
- A key decision is made
- You are corrected on something (use type: correction)
- A reusable procedure is identified

Each promotion must include: what changed (before/after/why), when it should resurface (triggers), and where it applies (scope).`,

  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['insight', 'observation', 'procedure', 'correction', 'uncertainty_item'],
        description: 'What kind of knowledge this is',
      },
      title: {
        type: 'string',
        description: 'Short title for the memory',
      },
      statement: {
        type: 'string',
        description: 'The knowledge itself — clear, concise, actionable',
      },
      domain: {
        type: 'string',
        enum: ['ops', 'project', 'personal', 'doctrine', 'meta'],
        description: 'Which domain this belongs to',
      },
      before: {
        type: 'string',
        description: 'What was believed/known/assumed BEFORE this change',
      },
      after: {
        type: 'string',
        description: 'What is now true AFTER this change',
      },
      why: {
        type: 'string',
        description: 'Why the change happened',
      },
      trigger_keywords: {
        type: 'string',
        description: 'Keywords that should cause this memory to resurface (comma-separated)',
      },
      applies_to: {
        type: 'string',
        description: 'Where this applies (comma-separated contexts)',
      },
      excludes: {
        type: 'string',
        description: 'Where this does NOT apply (comma-separated, optional)',
      },
      privacy: {
        type: 'string',
        enum: ['internal', 'personal', 'sensitive'],
        description: 'Sensitivity level (default: internal)',
      },
    },
    required: ['type', 'title', 'statement', 'domain', 'before', 'after', 'why', 'trigger_keywords', 'applies_to'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // Lazy-load to avoid circular deps
      const { MemoryObjectStore } = await import('../memory-objects.js');
      const brainDir = (ctx.personalWorkspacePath ?? ctx.workspacePath).replace('/workspace', '/brain');
      const store = ctx.memoryObjectStore ?? new MemoryObjectStore(brainDir);

      const type = input.type as string;
      const title = input.title as string;
      const statement = input.statement as string;
      const domain = input.domain as string;
      const before = input.before as string;
      const after = input.after as string;
      const why = input.why as string;
      const triggerKeywords = (input.trigger_keywords as string).split(',').map(s => s.trim()).filter(Boolean);
      const appliesTo = (input.applies_to as string).split(',').map(s => s.trim()).filter(Boolean);
      const excludes = input.excludes ? (input.excludes as string).split(',').map(s => s.trim()).filter(Boolean) : [];
      const privacy = (input.privacy as string) || 'internal';

      // Find or create a thread for this domain
      let thread = store.getAllThreads().find(t =>
        t.status !== 'archived' && t.status !== 'resolved' &&
        t.context_boundaries.applies_to.some(a => appliesTo.includes(a))
      );

      if (!thread) {
        thread = store.createThread({
          title: `${domain} — ${title}`,
          question: `What should be known about ${title}?`,
          objective: `Track ${domain} knowledge related to ${title}`,
          level: 'immediate',
          status: 'open',
          priority: 'medium',
          owner: 'agent',
          child_threads: [],
          current_state_summary: statement,
          success_criteria: [],
          related_threads: [],
          context_boundaries: {
            applies_to: appliesTo,
            does_not_apply_to: excludes,
          },
        });
      }

      const deltaClass = type === 'correction' ? 'belief_change'
        : type === 'uncertainty_item' ? 'uncertainty_change'
        : type === 'procedure' ? 'action_change'
        : 'belief_change';

      const userMessage = ctx.authenticatedUserMessage;
      const correctionIngress = type === 'correction' && userMessage?.chatId === ctx.chatId
        ? { chatId: userMessage.chatId, messageRef: userMessage.messageRef, userText: userMessage.text }
        : undefined;

      const semanticText = `${title}. ${statement}`;
      const projection: SeedSourceProjection = {
        schema: 'home23.seed-source-projection.v1', status: 'pending',
        event: {
          event_id: randomUUID(), event_type: 'memory_promoted', agent: ctx.agentName ?? 'unknown',
          ts: new Date().toISOString(),
          payload: {
            learningVersion: 2, type: 'memory_promotion', actor: 'agent', head: semanticText.trim(),
            memory_type: type, domain, state_delta: { delta_class: deltaClass,
              before: { state: before }, after: { state: after }, why },
            scope: { applies_to: appliesTo, excludes },
            source_refs: correctionIngress ? [correctionIngress.messageRef] : [],
          },
          ...buildWriterSemanticStamp({ vector: embedTextSync(semanticText), text: semanticText }),
        },
      };
      const objectInput: Omit<ProjectableMemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'> = {
        type: type as any,
        thread_id: thread.thread_id,
        session_id: ctx.chatId,
        lifecycle_layer: 'working',
        status: 'candidate',
        title,
        statement,
        actor: 'agent',
        provenance: {
          source_refs: [],
          session_refs: [ctx.chatId],
          generation_method: 'agent_promote',
        },
        evidence: {
          evidence_links: [],
          grounding_strength: 'medium',
          grounding_note: 'Promoted from active conversation',
        },
        confidence: {
          score: 0.8,
          basis: 'User-established in conversation',
        },
        state_delta: {
          delta_class: deltaClass,
          before: { state: before },
          after: { state: after },
          why,
        },
        triggers: triggerKeywords.map(kw => ({
          trigger_type: 'keyword',
          condition: kw,
        })),
        scope: {
          applies_to: appliesTo,
          excludes,
        },
        review_state: 'self_reviewed',
        staleness_policy: {
          review_after_days: type === 'procedure' ? 60 : 30,
        },
        privacy_class: privacy as any,
        seed_projection: projection,
      };
      const obj = store.createObject(objectInput, correctionIngress);
      let projectionError: string | undefined;
      try { await flushMemorySeedProjections({ ...ctx, memoryObjectStore: store }); }
      catch (error) { projectionError = (error instanceof Error ? error.message : String(error)).slice(0, 600); }
      const projected = (store.getObject(obj.memory_id) as ProjectableMemoryObject | undefined)?.seed_projection;

      return {
        content: `Promoted to memory: "${title}" (${obj.memory_id})\nThread: ${thread.thread_id} — ${thread.title}\nTriggers: ${triggerKeywords.join(', ')}\nState delta: ${before} → ${after} (${why})\nMemory stored; source projection=${projected?.status ?? 'pending'}; Seed application=not yet confirmed${projectionError || projected?.error ? ` (${projectionError || projected?.error})` : ''}`,
      };
    } catch (err) {
      return {
        content: `Failed to promote: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  },
};
