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
import { learningLessonId, readSeedLearning } from '../../../shared/seed-learning.cjs';
import { resolveSubstrateStateDir } from '../session-bootstrap.js';
import { hasOperationalConductSubject, isExplicitOperationalConductInstruction } from '../relationship-ledger.js';
import type {
  AuthenticatedCorrectionIngress,
  RelationshipEntryType,
  RelationshipLedger,
  RelationshipEntry,
  RelationshipLearningFeedback,
} from '../relationship-ledger.js';

// The orchestrator adds `relationshipLedger` to ToolContext; we read it through
// a widened view so this file never has to edit types.ts.
type RelationshipToolContext = ToolContext & {
  relationshipLedger?: RelationshipLedger | null;
  seedStateDir?: string;
};

const ENTRY_TYPES: RelationshipEntryType[] = [
  'thread', 'promise', 'correction', 'attenuation', 'decision', 'preference',
  'aversion', 'shared_reference', 'miss_repair', 'why_it_mattered',
];

const LEARNING_INPUT_SCHEMA = {
  type: 'object', description: 'Scoped conduct feedback. Never infer owner approval from silence or your own account.',
  properties: {
    schema: { type: 'string', enum: ['home23.learning-feedback.v1'] },
    decisionId: { type: 'string', description: 'Required actual prior decision identity from relationship_recall learning=true. Feedback cannot invent a broader decision scope.' },
    standing: { type: 'boolean', description: 'A linked preference can persist as a standing instruction. This never removes the actual decision witness requirement.' },
    cellId: { type: 'string', description: 'Existing target situation; runtime validates it against the decision.' },
    scope: { type: 'string', maxLength: 120, description: 'Exact decision scope, not all owner contact.' },
    direction: { type: 'string', enum: ['attenuate', 'reinforce'] },
    basis: { type: 'string', enum: ['owner-feedback'] },
    tags: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
    excludes: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
    evidenceRefs: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 }, description: 'Original evidence references. Runtime adds the authenticated current owner message.' },
    supersedes: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 }, description: 'Prior lesson identities explicitly revised by this feedback.' },
    corroborates: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 }, description: 'Prior lessons supported by this same-scope observed result, not unrelated successes.' },
  },
  required: ['schema', 'decisionId', 'scope', 'direction', 'basis', 'evidenceRefs'], additionalProperties: false,
};

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
    ...(entry.seed_projection ? [`source projection=${entry.seed_projection.status}${entry.seed_projection.error ? ` (${entry.seed_projection.error})` : ''}`] : []),
    entry.learning ? 'conduct learning=recorded; Seed application=not yet confirmed' : 'conduct learning=not recorded; this is context only, not an executable conduct lesson',
    ...(entry.learning && entry.seed_projection ? [`learning receipt identity: ${learningLessonId(entry.seed_projection.event.event_id, entry.learning.scope)} (application not yet confirmed)`] : []),
  ].join('\n');
}

export const relationshipNoteTool: ToolDefinition = {
  name: 'relationship_note',
  description: `Record a durable fact about your working relationship with jtr — NOT a world/ops fact (use promote_to_memory for those). Use this for:
- an unfinished thread you should pick back up (thread)
- a commitment either side owes (promise)
- a consequential correction jtr made (correction)
- exact owner feedback that a particular behavior was noise (attenuation)
- a decision reached together (decision)
- a recurring preference or aversion (preference / aversion)
- a shared reference / running joke / touchstone (shared_reference)
- a prior miss and how it was repaired (miss_repair)
- why something mattered, not just what happened (why_it_mattered)

For an instruction to change your behavior (including "keep routine status out of personal conversations"), use conduct learning, not preference/aversion. First call relationship_recall with learning=true and omit scope to discover actual scopes and decision identities. Select the actual matching prior decision; never guess or use an unrelated decision. Use attenuation to reduce a behavior, or correction with direction reinforce for explicit positive feedback. Preserve the owner's exclusions, including direct requests.

For conduct learning, statement must be the ENTIRE exact current authenticated message, including its attribution and surrounding words (at most 2000 characters), not a quotation extracted from it or your paraphrase. Include learning metadata for that actual decision and narrow scope. Only authenticated owner feedback earns owner authority. Facts and ordinary preferences store context only; they do not become conduct teaching. If no matching decision exists, say that no conduct lesson was recorded rather than claiming learning.`,
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ENTRY_TYPES, description: 'Behavior changes require attenuation or correction with learning metadata. Preference/aversion store ordinary context only.' },
      title: { type: 'string', description: 'Short handle (<= 120 chars)' },
      statement: { type: 'string', maxLength: 2000, description: 'Durable content. For conduct learning: the ENTIRE exact current authenticated message, including attribution, not an excerpt or paraphrase (<= 2000 chars).' },
      why: { type: 'string', description: 'Why it mattered — important for decision/correction/miss_repair' },
      applies_to: { type: 'string', description: 'Domain/topic tags (comma-separated or array)' },
      triggers: { type: 'string', description: 'Keyword cues that should resurface this (comma-separated or array)' },
      privacy: { type: 'string', enum: ['internal', 'personal', 'sensitive'], description: 'Sensitivity (default internal)' },
      learning: LEARNING_INPUT_SCHEMA,
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

      const authenticated = correctionIngress(ctx);
      if ((type === 'preference' || type === 'aversion') && input.learning === undefined
          && authenticated && isExplicitOperationalConductInstruction(authenticated.userText)
          && hasOperationalConductSubject(String(input.statement || ''))) {
        return { is_error: true, content: JSON.stringify({ code: 'conduct_feedback_requires_learning', recorded: false,
          instruction: 'This current instruction asks you to change operational conduct. Call relationship_recall with learning=true and omit scope first. Select the actual matching prior decision, then retry as attenuation with learning metadata and the ENTIRE exact current message as statement. Preserve its exclusions. Do not invent a decision; if none matches, report that no conduct teaching was recorded.' }) };
      }
      const ingress = type === 'correction' || type === 'attenuation' ? authenticated : undefined;
      const entry = ledger.addEntry({
        type,
        title: String(input.title || ''),
        statement: String(input.statement || ''),
        why: input.why ? String(input.why) : undefined,
        applies_to: parseList(input.applies_to),
        triggers: parseList(input.triggers),
        privacy_class: (input.privacy as 'internal' | 'personal' | 'sensitive') || 'internal',
        provenance: { session_refs: [ctx.chatId], generation_method: 'agent_note' },
        ...(input.learning !== undefined ? { learning: input.learning as RelationshipLearningFeedback } : {}),
      }, ingress);

      return { content: summarize(entry) };
    } catch (err) {
      return { content: `Failed to record relationship entry: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const relationshipRecallTool: ToolDefinition = {
  name: 'relationship_recall',
  description: 'Deliberately pull active relationship context with jtr. Set learning=true and omit scope first to discover actual runtime scopes, recent decision identities and active lessons before recording feedback or superseding a lesson. Scope is an exact runtime key, not a natural-language topic. Reads only this resident’s configured Seed; never guesses a decision identity.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional keyword filter (matches title, statement, triggers, tags)' },
      type: { type: 'string', enum: ENTRY_TYPES, description: 'Optional: restrict to one entry type' },
      limit: { type: 'number', description: 'Max entries to return (default 10)' },
      learning: { type: 'boolean', description: 'Inspect recent Seed decision identities and active lesson identities, instead of relationship prose.' },
      scope: { type: 'string', description: 'Optional exact runtime scope from availableScopes. Omit this filter first; a topic such as "personal conversations" is not a scope key.' },
    },
    additionalProperties: false,
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (input.learning === true) {
        const stateDir = (ctx as RelationshipToolContext).seedStateDir
          ?? resolveSubstrateStateDir(ctx.personalWorkspacePath ?? ctx.workspacePath);
        if (!stateDir) return { content: 'Seed learning state unavailable for this resident; do not invent a decision identity.', is_error: true };
        const snapshot = readSeedLearning(stateDir);
        if (snapshot.available === false) return { content: 'Seed learning projection unavailable or incomplete; no current decision or lesson is claimed.', is_error: true };
        const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit) || 10)));
        const scope = typeof input.scope === 'string' ? input.scope.trim() : '';
        const availableScopes = [...new Set([...snapshot.decisions.map(decision => decision.scope),
          ...snapshot.lessons.filter(lesson => lesson.active !== false).map(lesson => lesson.scope)])].sort();
        if (scope && !availableScopes.includes(scope)) {
          return { is_error: true, content: JSON.stringify({ seedSequence: snapshot.seq ?? null,
            requestedScope: scope, scopeStatus: 'unknown', availableScopes, decisions: [], lessons: [],
            note: 'This scope does not occur in the retained learning projection. Omit scope to inspect actual decisions and lessons, or choose an exact availableScopes key. Empty results for this filter do not mean the resident has no learning. Do not invent a matching decision.' }, null, 2) };
        }
        const decisions = snapshot.decisions.filter(decision => !scope || decision.scope === scope).slice(-limit).reverse();
        const lessons = snapshot.lessons.filter(lesson => lesson.active !== false && (!scope || lesson.scope === scope)).slice(-limit).reverse();
        return { content: JSON.stringify({ seedSequence: snapshot.seq ?? null,
          requestedScope: scope || null, scopeStatus: scope ? 'matched' : 'all', availableScopes, decisions, lessons,
          note: 'Decision identities are actual runtime witnesses. Choose the matching prior choice; missing or ambiguous identity is not permission to guess. Source projection and Seed application are separate stages.' }, null, 2) };
      }
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

      // Privacy is load-bearing: a tool result becomes conversation history.
      // Match by tokens/phrases, not the whole query as a substring. Withheld
      // counts only sensitive entries that matched — not every sensitive row.
      const found = ledger.searchEntries(query, {
        type: typeArg,
        status: 'active',
        excludePrivacy: ['sensitive'],
      });
      const withheld = found.withheldMatching;
      const entries = found.entries.slice(0, limit);

      const withheldNote = withheld > 0
        ? ` (${withheld} sensitive ${withheld === 1 ? 'entry' : 'entries'} withheld; matched this query)`
        : '';
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
      type: { type: 'string', enum: ENTRY_TYPES, description: 'Optional replacement type when superseding.' },
      learning: LEARNING_INPUT_SCHEMA,
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
        const replacementType = input.type === undefined ? existing.type : String(input.type) as RelationshipEntryType;
        if (!ENTRY_TYPES.includes(replacementType)) return { content: 'Unknown replacement relationship type.', is_error: true };
        const proposedLearning = input.learning === undefined ? existing.learning : input.learning as RelationshipLearningFeedback;
        const learning = proposedLearning && existing.learning && existing.seed_projection
          ? { ...proposedLearning, supersedes: [...new Set([
            ...(proposedLearning.supersedes ?? []),
            learningLessonId(existing.seed_projection.event.event_id, existing.learning.scope),
          ])] } : proposedLearning;
        const ingress = replacementType === 'correction' || replacementType === 'attenuation' ? correctionIngress(ctx) : undefined;
        const created = ledger.supersede(id, {
          type: replacementType,
          title: existing.title,
          statement,
          why: input.why ? String(input.why) : existing.why,
          applies_to: existing.applies_to,
          triggers: existing.triggers,
          privacy_class: existing.privacy_class,
          provenance: { session_refs: [ctx.chatId], generation_method: 'agent_note' },
          ...(learning ? { learning } : {}),
        }, ingress);
        return { content: `Superseded ${id} with ${created.id} (actor=${created.actor}).\n${summarize(created)}` };
      }

      if (existing.learning && (action === 'resolve' || action === 'remove')) {
        return { content: 'This entry carries authenticated conduct learning. Supersede it with the owner’s exact new feedback to revise its active effect; a lifecycle edit cannot silently erase that learning.', is_error: true };
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
