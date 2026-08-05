/**
 * Home23 — relationship tools (Step 30, Companion Layer piece 2)
 *
 * The agent's hands on the relationship ledger: note a durable relationship
 * fact, deliberately recall relationship context, or update an entry's
 * lifecycle. These operate on the jtr<->agent working relationship, distinct
 * from factual memory (promote_to_memory) and raw chat history.
 *
 * Every tool reads ctx.relationshipLedger (wired by the orchestrator). When it
 * is absent the tool returns a clear error rather than constructing a store of
 * its own — the ledger's correction validator is bound to live recorded turns,
 * and a tool-built store could not authenticate jtr corrections.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import type {
  AuthenticatedCorrectionIngress,
  RelationshipEntryType,
  RelationshipLedger,
  RelationshipEntry,
} from '../relationship-ledger.js';

// The orchestrator adds `relationshipLedger` to ToolContext; we read it through
// a widened view so this file never has to edit types.ts.
type RelationshipToolContext = ToolContext & {
  relationshipLedger?: RelationshipLedger | null;
};

const ENTRY_TYPES: RelationshipEntryType[] = [
  'thread', 'promise', 'correction', 'decision', 'preference',
  'aversion', 'shared_reference', 'miss_repair', 'why_it_mattered',
];

const LEDGER_UNAVAILABLE =
  'Relationship ledger unavailable for this agent — cannot record or recall relationship context.';

function ledgerOf(ctx: ToolContext): RelationshipLedger | null {
  return (ctx as RelationshipToolContext).relationshipLedger ?? null;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

/**
 * Build a correction ingress only from the loop-provided authenticated user
 * message for THIS chat (mirrors promote.ts). Anything else stays agent-owned.
 */
function correctionIngress(ctx: ToolContext): AuthenticatedCorrectionIngress | undefined {
  const msg = ctx.authenticatedUserMessage;
  if (!msg || msg.chatId !== ctx.chatId) return undefined;
  return { chatId: msg.chatId, messageRef: msg.messageRef, userText: msg.text };
}

function summarize(entry: RelationshipEntry): string {
  const why = entry.why ? `\nwhy: ${entry.why}` : '';
  return [
    `Recorded relationship ${entry.type}: "${entry.title}" (${entry.id})`,
    `actor=${entry.actor} status=${entry.status} confidence=${entry.confidence.toFixed(2)} privacy=${entry.privacy_class}`,
    `statement: ${entry.statement}${why}`,
  ].join('\n');
}

export const relationshipNoteTool: ToolDefinition = {
  name: 'relationship_note',
  description: `Record a durable fact about your working relationship with jtr — NOT a world/ops fact (use promote_to_memory for those). Use this for:
- an unfinished thread you should pick back up (thread)
- a commitment either side owes (promise)
- a consequential correction jtr made (correction)
- a decision reached together (decision)
- a recurring preference or aversion (preference / aversion)
- a shared reference / running joke / touchstone (shared_reference)
- a prior miss and how it was repaired (miss_repair)
- why something mattered, not just what happened (why_it_mattered)

Corrections made in a real jtr turn are recorded with jtr authority automatically.`,
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ENTRY_TYPES, description: 'What kind of relationship entry this is' },
      title: { type: 'string', description: 'Short handle (<= 120 chars)' },
      statement: { type: 'string', description: 'The durable content (<= 2000 chars)' },
      why: { type: 'string', description: 'Why it mattered — important for decision/correction/miss_repair' },
      applies_to: { type: 'string', description: 'Domain/topic tags (comma-separated or array)' },
      triggers: { type: 'string', description: 'Keyword cues that should resurface this (comma-separated or array)' },
      privacy: { type: 'string', enum: ['internal', 'personal', 'sensitive'], description: 'Sensitivity (default internal)' },
    },
    required: ['type', 'title', 'statement'],
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const ledger = ledgerOf(ctx);
      if (!ledger) return { content: LEDGER_UNAVAILABLE, is_error: true };

      const type = String(input.type || '') as RelationshipEntryType;
      if (!ENTRY_TYPES.includes(type)) {
        return { content: `Unknown relationship type "${String(input.type)}". Expected one of: ${ENTRY_TYPES.join(', ')}`, is_error: true };
      }

      const ingress = type === 'correction' ? correctionIngress(ctx) : undefined;
      const entry = ledger.addEntry({
        type,
        title: String(input.title || ''),
        statement: String(input.statement || ''),
        why: input.why ? String(input.why) : undefined,
        applies_to: parseList(input.applies_to),
        triggers: parseList(input.triggers),
        privacy_class: (input.privacy as 'internal' | 'personal' | 'sensitive') || 'internal',
        provenance: { session_refs: [ctx.chatId], generation_method: 'agent_note' },
      }, ingress);

      return { content: summarize(entry) };
    } catch (err) {
      return { content: `Failed to record relationship entry: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const relationshipRecallTool: ToolDefinition = {
  name: 'relationship_recall',
  description: 'Deliberately pull active relationship context with jtr (threads, promises, corrections, decisions, preferences, shared references). Returns a compact list — use it to reconnect before responding.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional keyword filter (matches title, statement, triggers, tags)' },
      type: { type: 'string', enum: ENTRY_TYPES, description: 'Optional: restrict to one entry type' },
      limit: { type: 'number', description: 'Max entries to return (default 10)' },
    },
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const ledger = ledgerOf(ctx);
      if (!ledger) return { content: LEDGER_UNAVAILABLE, is_error: true };

      const typeArg = input.type ? (String(input.type) as RelationshipEntryType) : undefined;
      if (typeArg && !ENTRY_TYPES.includes(typeArg)) {
        return { content: `Unknown relationship type "${String(input.type)}".`, is_error: true };
      }
      const limit = Number.isFinite(Number(input.limit)) && Number(input.limit) > 0
        ? Math.floor(Number(input.limit))
        : 10;
      const query = typeof input.query === 'string' ? input.query.toLowerCase().trim() : '';

      let entries = ledger.listEntries({ type: typeArg, status: 'active' });
      // Privacy is load-bearing: a tool result becomes conversation history and
      // re-enters the prompt on later turns, so recall must enforce the same
      // rule as retrieveForContext — 'sensitive' entries never render.
      const totalActive = entries.length;
      entries = entries.filter(e => e.privacy_class !== 'sensitive');
      const withheld = totalActive - entries.length;
      if (query) {
        entries = entries.filter(e =>
          e.title.toLowerCase().includes(query) ||
          e.statement.toLowerCase().includes(query) ||
          e.triggers.some(t => t.includes(query)) ||
          e.applies_to.some(a => a.toLowerCase().includes(query)));
      }
      entries = entries.slice(0, limit);

      const withheldNote = withheld > 0 ? ` (${withheld} sensitive ${withheld === 1 ? 'entry' : 'entries'} withheld)` : '';
      if (!entries.length) {
        const base = query ? `No active relationship entries match "${query}".` : 'No active relationship entries recorded yet.';
        return { content: `${base}${withheldNote}` };
      }
      const lines = entries.map(e => {
        const why = e.why ? ` — why: ${e.why}` : '';
        return `- [${e.type}/${e.actor}] ${e.title}: ${e.statement}${why} (${e.id})`;
      });
      return { content: `${entries.length} relationship ${entries.length === 1 ? 'entry' : 'entries'}${withheldNote}:\n${lines.join('\n')}` };
    } catch (err) {
      return { content: `Failed to recall relationship context: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const relationshipUpdateTool: ToolDefinition = {
  name: 'relationship_update',
  description: 'Update a relationship entry lifecycle: supersede it with a corrected statement, resolve a thread/promise, or remove an entry (soft delete — provenance is kept).',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry id (rel_...)' },
      action: { type: 'string', enum: ['supersede', 'resolve', 'remove'], description: 'What to do' },
      statement: { type: 'string', description: 'New statement (required for supersede)' },
      why: { type: 'string', description: 'Why the change (for supersede)' },
      reason: { type: 'string', description: 'Reason for removal (for remove)' },
    },
    required: ['id', 'action'],
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const ledger = ledgerOf(ctx);
      if (!ledger) return { content: LEDGER_UNAVAILABLE, is_error: true };

      const id = String(input.id || '');
      const action = String(input.action || '');
      if (!id) return { content: 'relationship_update requires an entry id.', is_error: true };

      const existing = ledger.getEntry(id);
      if (!existing) return { content: `No relationship entry with id ${id}.`, is_error: true };

      if (action === 'supersede') {
        const statement = String(input.statement || '');
        if (!statement) return { content: 'supersede requires a new statement.', is_error: true };
        const ingress = existing.type === 'correction' ? correctionIngress(ctx) : undefined;
        const created = ledger.supersede(id, {
          type: existing.type,
          title: existing.title,
          statement,
          why: input.why ? String(input.why) : existing.why,
          applies_to: existing.applies_to,
          triggers: existing.triggers,
          privacy_class: existing.privacy_class,
          provenance: { session_refs: [ctx.chatId], generation_method: 'agent_note' },
        }, ingress);
        return { content: `Superseded ${id} with ${created.id} (actor=${created.actor}).\nnew statement: ${created.statement}` };
      }

      if (action === 'resolve') {
        const resolved = ledger.resolve(id);
        return { content: `Resolved ${id} (${resolved?.type}). status=${resolved?.status}` };
      }

      if (action === 'remove') {
        const reason = input.reason ? String(input.reason) : undefined;
        const removed = ledger.remove(id, reason);
        return { content: `Removed ${id} (soft delete, provenance kept). status=${removed?.status}${reason ? ` reason: ${reason}` : ''}` };
      }

      return { content: `Unknown action "${action}". Expected supersede, resolve, or remove.`, is_error: true };
    } catch (err) {
      return { content: `Failed to update relationship entry: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const relationshipTools: ToolDefinition[] = [
  relationshipNoteTool,
  relationshipRecallTool,
  relationshipUpdateTool,
];
