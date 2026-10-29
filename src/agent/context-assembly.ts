/**
 * Home23 — Context Assembly Layer (Step 20)
 *
 * Pre-turn intelligence: queries the brain, loads domain surfaces,
 * applies salience ranking and staleness verification, returns a
 * [SITUATIONAL AWARENESS] block for injection into the system prompt.
 *
 * Replaces: semanticRecall, hardcoded evobrew/cosmo situational checks.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import type { AssemblyResult, EventEnvelope, MemoryObject, OwnerDistillConfig } from '../types.js';
import type { EventLedger } from './event-ledger.js';
import type { TriggerIndex } from './trigger-index.js';
import { pendingAutomaticContextDisclosure, type TurnContextEnrichment } from './context-enrichment.js';
import { budgetIdentityContent, boundaryTruncate } from './identity-budget.js';
import { composeSeedSituation } from '../substrate/seed-context.js';
import { composeLivedRecent } from '../substrate/lived-recent.js';
import { composeLivedFacts } from '../substrate/lived-facts.js';
import { semanticMatchScore } from '../substrate/semantic-match.js';
import { activeAttentionRecipeId, admitsPairScore, resolveAttentionPolicy } from '../substrate/encoder-attention-policy.js';
import { resolveSubstrateStateDir } from './session-bootstrap.js';
import { currentTurnSubject } from '../substrate/turn-relevance.js';
import { readSeedLearning, evaluateLearnedDecision } from '../substrate/learning-state.js';
import type { LearningSnapshot } from '../../shared/seed-learning.cjs';
import { classifyOwnerConversation, hasConversationTimeIntent } from '../../shared/owner-conversation-policy.cjs';

const require = createRequire(import.meta.url);
const { resolveAgentInstancePaths } = require('../../shared/agent-instance-paths.cjs');
const { readResidentInitiationContext } = require('../../engine/src/agency/resident-initiation.js');

/**
 * A workspace file that loads into situational awareness ONLY when its keyword
 * cues fire (Step 30 cleanup #4). This is how large, intermittently-relevant
 * doctrine (attention-allocation, social maintenance, carry-forward) reaches the
 * agent exactly when it matters instead of bloating every turn.
 */
export interface TriggeredSurfaceConfig {
  file: string;
  label?: string;
  keywords?: string[];
  domains?: string[];
  budget?: number;
}

// ─── Constants ──────────────────────────────────────────
const CONTEXT_BUDGET = 6000;
export const AUTHORED_SURFACE_MAX_CHARS = 16_000;
export const SITUATIONAL_AWARENESS_MAX_CHARS = 40_000;
const BRAIN_SEARCH_LIMIT = 8;
const BRAIN_SEARCH_TIMEOUT_MS = 8_000;
const STALENESS_HOURS = 24;

// ─── Types ──────────────────────────────────────────────
interface BrainSearchResult {
  concept: string;     // brain returns 'concept', not 'content'
  similarity: number;  // brain returns 'similarity', not 'score'
  tag?: string;
  id?: string | number;
}

interface AssemblyConfig {
  workspacePath: string;
  brainDir: string;
  enginePort: number;
  sessionId: string;
  signal: AbortSignal;
  brainSearchTimeoutMs?: number;
  /** Responsive conversations own a background lookup; work keeps the blocking route. */
  contextEnrichment?: TurnContextEnrichment;
  contextSearch: (
    request: { query: string; topK: number },
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  triggerIndex?: TriggerIndex;
  /** Meaning-gated workspace files (Step 30 keywords became meaning-anchors
   * in v2 cut 3; substring match remains the degraded fallback). */
  triggeredSurfaces?: TriggeredSurfaceConfig[];
  /** Injectable embedder for the semantic gates (tests); defaults to the
   * shared retina embedder. */
  semanticEmbed?: (text: string) => number[] | null;
  /** Seed substrate state dir (may be a live mirror) — loads the SUBSTRATE
   * carried-state block every turn when set. */
  substrateStateDir?: string;
  substrateBudget?: number;
  /** Read-only dependency for deterministic decision comparisons. */
  readLearning?: typeof readSeedLearning;
  /** Rendering policy is independent of whether background distillation is enabled. */
  ownerDistill?: OwnerDistillConfig;
  /** When true, skip automatic pre-turn brain retrieval (retrieval-eval isolation). */
  skipBrainEnrichment?: boolean;
}

interface AgencyContextSnapshot {
  agentName: string;
  agencyDir: string;
  statePath: string;
  state: Record<string, unknown>;
  stateReadable: boolean;
}

// ─── Domain Surfaces ────────────────────────────────────
const DOMAIN_SURFACES = [
  { name: 'TOPOLOGY', file: 'TOPOLOGY.md', budget: 2500, alwaysBoost: false, isFact: true },
  { name: 'PROJECTS', file: 'PROJECTS.md', budget: 3000, alwaysBoost: false, isFact: false },
  // PERSONAL is alwaysBoost: who jtr is loads every turn, unconditionally.
  // It used to be false ("surface only on direct relevance") while RECENT was
  // true -- so the machine's own heartbeats reached the agent every turn and
  // jtr's life was a conditional lookup. That is why jerry greeted jtr with
  // cron errors. Two booleans, not a personality.
  { name: 'PERSONAL', file: 'PERSONAL.md', budget: 2500, alwaysBoost: true,  isFact: false },
  { name: 'DOCTRINE', file: 'DOCTRINE.md', budget: 2500, alwaysBoost: false, isFact: false },
  // RECENT is NOT alwaysBoost. curator-llm-tools builds it from the event
  // ledger and the machine's own cycle thoughts, so it is structurally
  // incapable of describing jtr's world -- loading it every turn could only
  // ever tell the agent about itself.
  { name: 'RECENT',   file: 'RECENT.md',   budget: 3000, alwaysBoost: false, isFact: false },
] as const;

/**
 * Meaning anchors for the operational AGENCY / WORKERS surfaces.
 * Same shape as triggered surfaces (v2 cut 3): the labels are anchors for
 * semantic match; substring match is the degraded-honest fallback when the
 * embedder is down or the turn is too short to carry topic.
 *
 * These used to ride every turn at 0.98/0.9 salience. On 2026-08-11 that
 * always-on operational briefing steered a simple greeting (Chronesthesia /
 * pursuits into "what's good"). K2 is law: nothing new rides every turn —
 * first-turn wake-up stays, later turns must earn admission.
 */
export const AGENCY_MEANING_ANCHORS = [
  'agency',
  'pursuit',
  'pursuits',
  'next move',
  'autonomous',
  'resident agency',
  'what are you working on',
  'open contradiction',
  'authority',
  'agenda',
] as const;

export const WORKER_MEANING_ANCHORS = [
  'worker',
  'workers',
  'worker run',
  'worker receipt',
  'dispatch worker',
  'verifier',
  'reusable worker',
] as const;

export interface OperationalSurfaceGateInput {
  isFirstTurn: boolean;
  degraded: boolean;
  brainCueCount: number;
  triggerCount: number;
  turnText: string;
  /** Turn + recent context for substring fallback (same haystack as triggered surfaces). */
  matchText: string;
  label: string;
  anchors: readonly string[];
  semanticEmbed?: (t: string) => number[] | null;
  recipeId?: string | null;
  learning?: LearningSnapshot;
}

/**
 * Gate for AGENCY / WORKERS — mirrors non-alwaysBoost DOMAIN_SURFACES for the
 * wake/cue path, then admits mid-session turns only when their meaning pulls
 * on the surface's anchors (triggered-surface pattern).
 */
export function shouldLoadOperationalSurface(input: OperationalSurfaceGateInput): boolean {
  return operationalSurfaceDecision(input).allow;
}

export function operationalSurfaceDecision(input: OperationalSurfaceGateInput) {
  const anchorText = `${input.label}: ${input.anchors.join(', ')}`;
  const policy = resolveAttentionPolicy(input.recipeId);
  const subject = currentTurnSubject(input.turnText, [{ role: 'user', content: input.matchText }]);
  const score = semanticMatchScore(subject, anchorText, input.semanticEmbed, {
    recipeId: input.recipeId,
  });
  const relevant = score !== null ? admitsPairScore(score, policy)
    : input.anchors.some(anchor => subject.toLowerCase().includes(anchor.toLowerCase()));
  const current = input.turnText.toLowerCase();
  const asksForResult = /\b(?:finish\w*|complet\w*|deliver\w*|results?|outputs?|status|progress|receipts?|reports?|done|succeed\w*|fail\w*)\b/i.test(input.turnText);
  const requestVerb = /\b(?:show|list|read|check|summari[sz]e|brief|describe|explain|review|outline|report)\b/i.test(input.turnText);
  const explicit = input.anchors.some(anchor => current.includes(anchor.toLowerCase()))
    || (relevant && (asksForResult || requestVerb));
  const tags = ['operational', input.label.toLowerCase(), explicit ? 'requested' : 'automatic'];
  const learned = evaluateLearnedDecision(input.learning, { scope: 'foreground.context', tags });
  return { allow: relevant && (explicit || !learned.suppress), relevant, explicit, tags, learned };
}

// ─── Surface Loading ────────────────────────────────────

interface AwarenessCap {
  source: string; rawChars: number; loadedChars: number; ceiling: number;
  reason: 'file_ceiling' | 'file_budget' | 'evidence_budget' | 'total_ceiling';
}
type OnAwarenessCap = (cap: AwarenessCap) => void;

interface LoadedSurface { text: string; contentChars: number; complete: boolean }

function loadSurface(workspacePath: string, filename: string, budget: number, authored = false,
  onCap?: OnAwarenessCap,
): LoadedSurface | null {
  const filePath = join(workspacePath, filename);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const content = raw.trim();
  if (!content) return null;
  // Section-aware budgeting (Step 30): never a blind mid-sentence slice. Before,
  // this did content.slice(0, budget), so a 10k DOCTRINE.md was silently cut to
  // 2.5k mid-content — the same bug fixed for SOUL in the identity path.
  if (authored || ['PERSONAL.md', 'DOCTRINE.md'].includes(basename(filename))) {
    // Triggered files have a configured prompt allowance. This bounds only
    // their automatic preview; the complete original remains readable.
    // PERSONAL/DOCTRINE identity delivery retains its existing larger ceiling.
    const ceiling = authored && Number.isFinite(budget)
      ? Math.min(AUTHORED_SURFACE_MAX_CHARS, Math.max(0, Math.floor(budget)))
      : AUTHORED_SURFACE_MAX_CHARS;
    if (raw.length <= ceiling) return { text: content, contentChars: content.length, complete: true };
    const marker = (offset: number) => `[context-cap: ${filename} is ${raw.length} chars; loaded first ${offset} chars; continue with self_read file=${JSON.stringify(filename)} offset=${offset}]`;
    // Work in the original JS string, so offset is exact even with leading
    // whitespace or Unicode; self_read uses the same character offsets.
    const head = boundaryTruncate(raw, Math.max(0, ceiling - marker(ceiling).length - 1));
    // A tiny/zero allowance still earns a recovery pointer, not source text.
    // The pointer itself is charged to the aggregate prompt ceiling.
    const capped = `${head}${head ? '\n' : ''}${marker(head.length)}`;
    onCap?.({ source: filename, rawChars: raw.length, loadedChars: head.length,
      ceiling, reason: ceiling < AUTHORED_SURFACE_MAX_CHARS ? 'file_budget' : 'file_ceiling' });
    return { text: capped, contentChars: head.length, complete: false };
  }
  const budgeted = budgetIdentityContent(basename(filename), content, budget, 'head');
  if (budgeted.truncated) {
    onCap?.({ source: filename, rawChars: content.length, loadedChars: budgeted.includedBytes,
      ceiling: budget, reason: 'file_budget' });
  }
  return { text: budgeted.truncated
    ? `${budgeted.text}\n[context-recovery: self_read file=${JSON.stringify(filename)} offset=0 for the complete source]`
    : budgeted.text, contentChars: budgeted.includedBytes, complete: !budgeted.truncated };
}

/** Read the shared store fresh without mutating it or trusting a stale process cache. */
export function composeLearnedOwnerFacts(
  brainDir: string,
  turnText: string,
  config?: OwnerDistillConfig,
  nowMs = Date.now(),
): string | null {
  try {
    const document: unknown = JSON.parse(readFileSync(join(brainDir, 'memory-objects.json'), 'utf8'));
    const rawObjects = (document as { objects?: unknown } | null)?.objects;
    if (!Array.isArray(rawObjects)) return null;
    const budget = Number.isFinite(config?.personalBudgetChars)
      ? Math.max(0, Math.floor(config!.personalBudgetChars!)) : 2000;
    const header = 'Learned from conversations';
    if (budget <= header.length) return null;
    const tokens = [...new Set(turnText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
    const timeIntent = hasConversationTimeIntent(turnText);
    const facts = rawObjects.filter((value): value is MemoryObject => {
      if (!value || typeof value !== 'object') return false;
      const object = value as Partial<MemoryObject>;
      return object.lifecycle_layer === 'durable' && object.status === 'approved'
        && object.provenance?.generation_method === 'owner_conversation'
        && typeof object.statement === 'string' && object.statement.trim().length > 0
        && typeof object.title === 'string' && typeof object.updated_at === 'string'
        && Number.isFinite(Date.parse(object.updated_at))
        && Boolean(object.evidence?.grounding_note?.trim())
        && Array.isArray(object.evidence?.evidence_links) && object.evidence.evidence_links.length > 0
        && !(object.superseded_by?.length)
        && (config?.renderSensitive !== false || object.privacy_class !== 'sensitive');
    }).map(object => {
      // Legacy prompt facts can lack source/session refs. Classify their
      // original quote and available provenance without changing that contract.
      const raw = object as unknown as Record<string, unknown>;
      const metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? raw.metadata as Record<string, unknown> : {};
      const classification = classifyOwnerConversation({
        ...object, metadata, provenance: object.provenance,
        chatId: raw.chatId ?? raw.chat_id ?? metadata.chatId ?? metadata.chat_id,
        sessionId: raw.sessionId ?? object.session_id ?? metadata.sessionId ?? metadata.session_id,
        sessionRefs: object.provenance.session_refs,
        sourceRefs: [...(object.provenance.source_refs ?? []), ...object.evidence.evidence_links],
        text: `${object.evidence.grounding_note}\n${object.statement}`,
      });
      const statement = object.statement.replace(/\s+/g, ' ').trim();
      const title = object.title.toLowerCase();
      const scope = Array.isArray(object.scope?.applies_to) ? object.scope.applies_to : [];
      let relevance = 0;
      for (const token of tokens) {
        if (scope.some(value => typeof value === 'string' && value.toLowerCase().includes(token))) relevance += 2;
        else if (title.includes(token)) relevance += 1.5;
        else if (statement.toLowerCase().includes(token)) relevance += 1;
      }
      const ageDays = Math.max(0, nowMs - Date.parse(object.updated_at)) / 86_400_000;
      const recency = timeIntent ? 2 / (1 + ageDays / 14) : 0;
      const weight = { substantive: 1, recap: 0.5, mention: 0.35, verification: 0.05 }[classification.kind];
      const qualityTier = { substantive: 0, recap: 1, mention: 1, verification: 2 }[classification.kind];
      return { object, statement, classification, qualityTier, score: (relevance + recency) * weight };
    }).filter(fact => fact.classification.ownerEvidence)
      .sort((a, b) => a.qualityTier - b.qualityTier || b.score - a.score
      || (timeIntent ? Date.parse(b.object.updated_at) - Date.parse(a.object.updated_at) : 0)
      || a.object.memory_id.localeCompare(b.object.memory_id));

    const lines: string[] = [];
    let chars = header.length;
    for (const fact of facts) {
      const date = new Date(fact.object.updated_at).toISOString().slice(0, 10);
      const line = `- You told me on ${date}: ${fact.statement}`;
      if (chars + 1 + line.length > budget) continue;
      lines.push(line);
      chars += 1 + line.length;
    }
    return lines.length ? [header, ...lines].join('\n') : null;
  } catch {
    // Torn, malformed or unreadable shared state must not delay or fail a reply.
    return null;
  }
}

/**
 * Load the triggered surfaces the turn's MEANING selects (v2 cut 3).
 * The configured keywords/domains are no longer substring tripwires — they
 * are the surface's meaning-anchor, embedded once and matched against the
 * turn in the retina's native space at the calibrated floor. Degraded-
 * honest: when meaning-matching is unavailable (embedder down, or a turn
 * too short to carry topic), the file-era substring match serves — the
 * organ owns the gate only while it is alive.
 */
function loadTriggeredSurfaces(
  workspacePath: string,
  surfaces: TriggeredSurfaceConfig[] | undefined,
  matchText: string,
  turnText?: string,
  embed?: (t: string) => number[] | null,
  onCap?: OnAwarenessCap,
): Array<{ label: string; text: string; file: string; contentChars: number; complete: boolean }> {
  if (!surfaces || surfaces.length === 0) return [];
  const hay = matchText.toLowerCase();
  const out: Array<{ label: string; text: string; file: string; contentChars: number; complete: boolean }> = [];
  for (const surface of surfaces) {
    const cues = [...(surface.keywords ?? []), ...(surface.domains ?? [])]
      .map(c => c.toLowerCase().trim())
      .filter(Boolean);
    if (cues.length === 0) continue;
    const label = surface.label
      ?? basename(surface.file).replace(/\.md$/i, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

    let fired: boolean;
    const recipeId = activeAttentionRecipeId();
    const policy = resolveAttentionPolicy(recipeId);
    const score = turnText !== undefined
      ? semanticMatchScore(turnText, `${label}: ${cues.join(', ')}`, embed, { recipeId })
      : null;
    if (score !== null) {
      fired = admitsPairScore(score, policy);
    } else {
      fired = cues.some(cue => hay.includes(cue));
    }
    if (!fired) continue;

    const content = loadSurface(workspacePath, surface.file, surface.budget ?? 2500, true, onCap);
    if (!content) continue;
    out.push({ label, ...content, file: surface.file });
  }
  return out;
}

// ─── Salience Ranking ───────────────────────────────────

interface SalienceItem {
  text: string;
  score: number;
  source: string;
  file?: string;
  /** Presence identifies a surface; text formatting never decides delivery. */
  surface?: string;
  contentChars?: number;
  complete?: boolean;
  recovery?: string;
}

interface ContextOmission { item: SalienceItem; reason: 'evidence_budget' | 'total_ceiling' }

function rankBySalience(items: SalienceItem[], budget: number, totalBudget: number, onCap: OnAwarenessCap,
  omissionIndexRecovery: string,
): { selected: SalienceItem[]; omitted: ContextOmission[]; notice: string } {
  items.sort((a, b) => {
    if (a.source === 'trigger' && b.source !== 'trigger') return -1;
    if (b.source === 'trigger' && a.source !== 'trigger') return 1;
    return b.score - a.score;
  });

  const selected: SalienceItem[] = [];
  const omitted: ContextOmission[] = [];
  let evidenceChars = 0;
  const joinedLength = () => selected.reduce((sum, item) => sum + item.text.length, Math.max(0, selected.length - 1));

  for (const item of items) {
    const authored = item.source.startsWith('trigger-surface:') || ['surface:PERSONAL', 'surface:DOCTRINE', 'surface:SUBSTRATE', 'surface:RECENT@seed', 'surface:FACTS@seed'].includes(item.source);
    if (!authored && evidenceChars + item.text.length > budget) {
      omitted.push({ item, reason: 'evidence_budget' });
      continue;
    }
    if (joinedLength() + (selected.length ? 1 : 0) + item.text.length > totalBudget) {
      omitted.push({ item, reason: 'total_ceiling' });
      continue;
    }
    selected.push(item);
    if (!authored) evidenceChars += item.text.length;
  }

  const renderNotice = () => {
    if (!omitted.length) return '';
    const heading = `[CONTEXT OMISSIONS: ${omitted.length} selected item(s) did not reach this prompt; not loaded knowledge.]`;
    const lines = omitted.map(({ item, reason }) =>
      `- ${item.surface ?? item.source} (${reason}): ${item.recovery ?? `self_read file=${JSON.stringify(item.file)} offset=0`}`);
    const full = [heading, ...lines, '[/CONTEXT OMISSIONS]'].join('\n');
    if (full.length <= totalBudget) return full;
    // An unusually large index must not hide the fact that it too is partial.
    // The structured receipt retains every path; never truncate a path/call.
    const tail = `Additional source pointers omitted from this index. ${omissionIndexRecovery}\n[/CONTEXT OMISSIONS]`;
    const shown = [heading];
    for (const line of lines) {
      if (shown.join('\n').length + line.length + tail.length + 2 > totalBudget) break;
      shown.push(line);
    }
    return [...shown, tail].join('\n');
  };
  let notice = renderNotice();
  // Reserve the omission notice before the final model block is constructed.
  // Whole lower-salience items yield space; the notice is never a sliced tail.
  while (selected.length && joinedLength() + notice.length + (notice ? 1 : 0) > totalBudget) {
    omitted.push({ item: selected.pop()!, reason: 'total_ceiling' });
    notice = renderNotice();
  }
  for (const { item, reason } of omitted) {
    onCap({ source: item.file ?? item.source, rawChars: item.text.length, loadedChars: 0,
      ceiling: reason === 'evidence_budget' ? budget : SITUATIONAL_AWARENESS_MAX_CHARS, reason });
  }
  return { selected, omitted, notice };
}

// ─── Staleness Verification ─────────────────────────────

function verifyFreshness(surfaceName: string, content: string, isFact: boolean): string {
  if (!isFact) return content;

  const now = Date.now();
  const lastVerifiedMatch = content.match(/Last verified:\s*(\d{4}-\d{2}-\d{2})/);

  if (lastVerifiedMatch) {
    const verifiedDate = new Date(lastVerifiedMatch[1]!).getTime();
    const ageHours = (now - verifiedDate) / (1000 * 60 * 60);
    if (ageHours > STALENESS_HOURS) {
      return `[UNVERIFIED — last verified ${lastVerifiedMatch[1]}, ${Math.floor(ageHours)}h ago]\n${content}`;
    }
  }

  return content;
}

// ─── Worker Context ─────────────────────────────────────

function readJsonlTail(filePath: string, limit: number): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export function buildWorkerContextSection(projectRoot: string, agentName: string): string {
  const workersRoot = join(projectRoot, 'instances', 'workers');
  const workers = existsSync(workersRoot)
    ? readdirSync(workersRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const configPath = join(workersRoot, entry.name, 'worker.yaml');
          if (!existsSync(configPath)) return null;
          const config = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown> | null;
          if (!config || config.kind !== 'worker') return null;
          const ownerAgent = typeof config.ownerAgent === 'string' ? config.ownerAgent : 'jerry';
          const visibleTo = Array.isArray(config.visibleTo) ? config.visibleTo.filter((item): item is string => typeof item === 'string') : [ownerAgent];
          return {
            name: typeof config.name === 'string' ? config.name : entry.name,
            ownerAgent,
            class: typeof config.class === 'string' ? config.class : 'worker',
            purpose: typeof config.purpose === 'string' ? config.purpose : 'Reusable Home23 worker.',
            visibleTo,
          };
        })
        .filter((item): item is { name: string; ownerAgent: string; class: string; purpose: string; visibleTo: string[] } => Boolean(item))
    : [];

  const visibleWorkers = workers.filter(worker => worker.ownerAgent === agentName || worker.visibleTo.includes(agentName));
  let recent: Array<Record<string, unknown>> = [];
  try {
    const brainPath = join(
      resolveAgentInstancePaths(projectRoot, agentName, { requireConfig: false }).brainDir,
      'worker-runs.jsonl',
    );
    recent = readJsonlTail(brainPath, 5);
  } catch {
    recent = [];
  }
  if (visibleWorkers.length === 0 && recent.length === 0) return '';

  const roster = visibleWorkers.length > 0
    ? visibleWorkers.map(worker => `- ${worker.name} (${worker.class}, owner ${worker.ownerAgent}): ${worker.purpose}`)
    : ['- none'];
  const receipts = recent.length > 0
    ? recent.map(record => `- ${record.runId || 'unknown'} ${record.worker || 'worker'}: ${record.status || 'unknown'}, verifier ${record.verifierStatus || 'unknown'}. ${record.summary || ''}`.trim())
    : ['- none'];

  return [
    '## Worker Agents',
    '',
    'Available reusable workers:',
    ...roster,
    '',
    'Recent worker receipts:',
    ...receipts,
  ].join('\n');
}

function loadAgencyContextSnapshot(projectRoot: string, agentName: string): AgencyContextSnapshot | null {
  let agencyDir: string;
  try {
    agencyDir = join(
      resolveAgentInstancePaths(projectRoot, agentName, { requireConfig: false }).brainDir,
      'agency',
    );
  } catch {
    return null;
  }
  const statePath = join(agencyDir, 'state.json');
  let state: Record<string, unknown> = {};
  let stateReadable = false;
  try {
    const parsed = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      state = parsed as Record<string, unknown>;
      stateReadable = true;
    }
  } catch {
    state = {};
  }
  return { agentName, agencyDir, statePath, state, stateReadable };
}

function oneLine(value: unknown, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function renderOperatorObligationContextSection(snapshot: AgencyContextSnapshot, now: number): string {
  if (!snapshot.stateReadable) return '';
  const obligations = Array.isArray(snapshot.state.obligations)
    ? snapshot.state.obligations.filter((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      ))
    : [];
  const pending = obligations
    .map((item, index) => {
      const parsedAt = Date.parse(String(item.at || ''));
      return { item, index, at: Number.isFinite(parsedAt) ? parsedAt : null };
    })
    .filter(({ item }) => (
      String(item.status || 'open') === 'open'
      && item.audience === 'operator'
      && !item.surfacedAt
    ))
    .sort((left, right) => {
      if (left.at !== null && right.at !== null) return left.at - right.at;
      if (left.at !== null) return -1;
      if (right.at !== null) return 1;
      return left.index - right.index;
    });
  if (pending.length === 0) return '';

  const shown = pending.slice(0, 5).map(({ item, at }) => {
    const age = at === null
      ? 'age=unknown'
      : `age=${Math.max(0, Math.floor((now - at) / 86_400_000))}d`;
    const reason = oneLine(item.reason || 'no reason recorded', 140);
    const id = typeof item.obligationId === 'string' && item.obligationId
      ? ` | obligationId=${item.obligationId}`
      : '';
    return `- ${item.kind || 'operator_obligation'} | ${age} | ${reason}${id}`;
  });
  const overflow = pending.length - shown.length;

  // Displayed is not handled: merely injecting this block must never write an
  // obligation_surfaced_to_jtr receipt or create the same false-green state.
  return [
    '## OWED TO JTR — surface these in conversation, do not let them sit.',
    'Raise stale operator obligations in your own voice during this conversation, not by silently re-queuing them; after voicing one, record its obligationId with agency_brief.',
    ...shown,
    ...(overflow > 0 ? [`Overflow: ${overflow} more operator obligation${overflow === 1 ? '' : 's'}.`] : []),
  ].join('\n');
}

export function buildOperatorObligationContextSection(
  projectRoot: string,
  agentName: string,
  now = Date.now(),
): string {
  const snapshot = loadAgencyContextSnapshot(projectRoot, agentName);
  return snapshot ? renderOperatorObligationContextSection(snapshot, now) : '';
}

function renderAgencyContextSection(snapshot: AgencyContextSnapshot): string {
  const { state } = snapshot;
  const pursuitsPath = join(snapshot.agencyDir, 'pursuits.jsonl');
  if (!snapshot.stateReadable && !existsSync(pursuitsPath)) return '';

  const latest = new Map<string, Record<string, unknown>>();
  for (const row of readJsonlTail(pursuitsPath, 300)) {
    const pursuit = row.pursuit && typeof row.pursuit === 'object'
      ? row.pursuit as Record<string, unknown>
      : null;
    if (pursuit?.id && typeof pursuit.id === 'string') latest.set(pursuit.id, pursuit);
  }
  const stored = Array.from(latest.values())
    .filter((pursuit) => ['active', 'watch'].includes(String(pursuit.status || '')))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const initiation = readResidentInitiationContext(join(snapshot.agencyDir, 'resident-initiation.json'), snapshot.agentName);
  const projected = stored.map(pursuit => ({ pursuit, execution: initiation.project(pursuit) }));
  const active = projected.filter(row => !row.execution.dormant);
  const dormant = projected.filter(row => row.execution.dormant);

  if (stored.length === 0 && Object.keys(state).length === 0) return '';

  const attention = state.attention && typeof state.attention === 'object'
    ? state.attention as Record<string, unknown>
    : {};
  const nextAction = state.nextAction && typeof state.nextAction === 'object'
    ? state.nextAction as Record<string, unknown>
    : null;
  const truth = state.truth && typeof state.truth === 'object'
    ? state.truth as Record<string, unknown>
    : {};
  const organs = state.organs && typeof state.organs === 'object'
    ? Object.entries(state.organs as Record<string, Record<string, unknown>>).slice(0, 6)
    : [];
  const governance = state.governance && typeof state.governance === 'object'
    ? state.governance as Record<string, unknown>
    : {};
  const promptContracts = governance.promptContracts && typeof governance.promptContracts === 'object'
    ? Object.entries(governance.promptContracts as Record<string, Record<string, unknown>>).slice(0, 5)
    : [];
  const promptContractLines = promptContracts.map(([scope, contract]) => {
    const target = contract.target ? ` | target=${contract.target}` : '';
    const reason = contract.reason ? ` | reason=${contract.reason}` : '';
    return `- ${scope}${target}${reason}: ${contract.promptText || contract.contractText || 'no prompt contract text recorded'}`;
  });
  const organLines = organs.length > 0
    ? organs.map(([name, organ]) => {
        const senses = Array.isArray(organ.canSense) ? organ.canSense.slice(0, 2).join(', ') : '';
        const changes = Array.isArray(organ.canChange) ? organ.canChange.slice(0, 2).join(', ') : '';
        return `- ${name}: kind=${organ.kind || 'organ'} | senses=${senses || 'unknown'} | changes=${changes || 'unknown'} | command=${organ.commandSurface || 'unknown'}`;
      })
    : [];
  const executionSummary = (execution: { executionState: string; workId?: string | null; dormancyReason?: string | null }) => {
    const clarification = execution.executionState === 'succeeded' ? 'executor finished; objective verification is not established'
      : ['failed', 'cancelled'].includes(execution.executionState) ? 'executor settled; objective verification is not established'
        : execution.executionState === 'withdrawn' ? 'withdrawn locally after Core confirmed no admission'
          : execution.executionState === 'not_admitted' ? 'no matching resident initiation admission'
            : execution.executionState === 'unknown' ? `resident initiation state ${initiation.availability}` : null;
    return `execution=${execution.executionState}${clarification ? ` (${clarification})` : ''}${execution.workId ? ` | Work=${execution.workId}` : ''}`;
  };
  const lines = active.length > 0
    ? active.slice(0, 5).map(({ pursuit, execution }) => [
        `- ${pursuit.id}: ${pursuit.title || pursuit.summary || 'Untitled pursuit'}`,
        `stored_status=${pursuit.status || 'unknown'}`,
        executionSummary(execution),
        `authority=${pursuit.authorityLevel || 'L1'}`,
        pursuit.nextMove ? `next_move=${pursuit.nextMove}` : null,
        pursuit.desiredChangedFuture ? `changed_future=${pursuit.desiredChangedFuture}` : null,
        pursuit.nextCheckAt ? `next=${pursuit.nextCheckAt}` : null,
      ].filter(Boolean).join(' | '))
    : ['- none'];
  const dormantLines = dormant.slice(0, 5).map(({ pursuit, execution }) =>
    `- ${pursuit.id}: ${pursuit.title || pursuit.summary || 'Untitled pursuit'} | initiative=dormant (${execution.dormancyReason}) | ${executionSummary(execution)}; stored pursuit retained, not a completion claim.`);
  const current = projected.find(row => row.pursuit.id === attention.currentPursuitId);
  const next = projected.find(row => row.pursuit.id === nextAction?.pursuitId);
  const currentFocus = current?.execution.dormant
    ? `none executing from stored focus ${current.pursuit.id} (${current.execution.dormancyReason})`
    : `${attention.currentPursuitId || 'none'}${current ? ` | ${executionSummary(current.execution)}` : attention.currentPursuitId ? ' | execution=unknown (stored focus only)' : ''}`;
  const nextMove = next?.execution.dormant
    ? `none; stored action for ${next.pursuit.id} is dormant (${next.execution.dormancyReason})`
    : nextAction ? `${[nextAction.kind, nextAction.pursuitId, nextAction.reason].filter(Boolean).join(' | ')} (planning record, not an execution receipt)` : 'none';

  return [
    '## Resident Agency',
    '',
    `Mode: ${state.mode || 'unknown'}`,
    `Current pursuit: ${currentFocus}`,
    `Stored planning queue depth: ${attention.queueDepth ?? 'unknown'} (not an execution count)`,
    `Pursuit snapshot: ${active.length} stored active/watch plan(s), ${dormant.length} dormant initiative(s). A plan is not evidence of running work.`,
    `Next autonomous action: ${nextMove}`,
    `Open contradictions: ${truth.unresolvedContradictions ?? 0}`,
    ...(organLines.length > 0 ? ['', 'Body organs:', ...organLines] : []),
    ...(promptContractLines.length > 0 ? ['', 'Prompt contracts:', ...promptContractLines] : []),
    '',
    'Pursuit plans (execution shown separately):',
    ...lines,
    ...(active.length > lines.length ? [`${active.length - lines.length} additional stored plans omitted; read ${JSON.stringify(pursuitsPath)} for the full snapshot.`] : []),
    ...(dormantLines.length ? ['', 'Dormant initiatives (not currently executing):', ...dormantLines] : []),
    ...(dormant.length > dormantLines.length ? [`${dormant.length - dormantLines.length} additional dormant initiatives omitted; read ${JSON.stringify(pursuitsPath)} and resident-initiation.json for details.`] : []),
  ].join('\n');
}

export function buildAgencyContextSection(projectRoot: string, agentName: string): string {
  const snapshot = loadAgencyContextSnapshot(projectRoot, agentName);
  return snapshot ? renderAgencyContextSection(snapshot) : '';
}

function managedWorkspaceContext(
  workspacePath: string,
): { home23Root: string; agentName: string } | null {
  const normalizedWorkspace = resolve(workspacePath);
  const envRoot = typeof process.env.HOME23_ROOT === 'string'
      && process.env.HOME23_ROOT.trim() !== ''
    ? resolve(process.env.HOME23_ROOT)
    : null;
  const envAgent = typeof process.env.HOME23_AGENT === 'string'
      && process.env.HOME23_AGENT.trim() !== ''
    ? process.env.HOME23_AGENT.trim()
    : null;
  const envInstanceDir = typeof process.env.HOME23_INSTANCE_DIR === 'string'
      && process.env.HOME23_INSTANCE_DIR.trim() !== ''
    ? resolve(process.env.HOME23_INSTANCE_DIR)
    : null;

  if (envRoot && envAgent) {
    const localWorkspace = join(envRoot, 'instances', envAgent, 'workspace');
    if (normalizedWorkspace === localWorkspace) {
      return { home23Root: envRoot, agentName: envAgent };
    }
  }

  if (envRoot && envAgent && envInstanceDir) {
    const managedWorkspace = join(envInstanceDir, 'workspace');
    if (normalizedWorkspace === managedWorkspace) {
      return { home23Root: envRoot, agentName: envAgent };
    }
  }

  return null;
}

function projectRootFromWorkspace(workspacePath: string): string {
  return managedWorkspaceContext(workspacePath)?.home23Root
    ?? resolve(workspacePath, '..', '..', '..');
}

function agentNameFromWorkspace(workspacePath: string): string {
  return managedWorkspaceContext(workspacePath)?.agentName
    ?? basename(dirname(workspacePath));
}

// ─── Main Assembly Function ─────────────────────────────

export async function assembleContext(
  userText: string,
  chatId: string,
  recentTurns: Array<{ role: string; content: string }>,
  config: AssemblyConfig,
  ledger?: EventLedger,
  signal?: AbortSignal,
): Promise<AssemblyResult> {
  const events: EventEnvelope[] = [];
  const durablyRecorded = new Set<string>();
  const onCap: OnAwarenessCap = cap => {
    events.push({ event_id: randomUUID(), event_type: 'SituationalAwarenessCapped', session_id: config.sessionId,
      timestamp: new Date().toISOString(), actor: 'assembly', payload: {
        ...cap, stage: cap.reason === 'file_budget' || cap.reason === 'file_ceiling' ? 'preview' : 'delivery',
      } });
    console.warn(`[context-assembly] context-cap: ${cap.source} ${cap.rawChars} -> ${cap.loadedChars} chars (${cap.reason})`);
  };
  const isFirstTurn = recentTurns.length === 0;
  const substrateStateDir = config.substrateStateDir ?? resolveSubstrateStateDir(config.workspacePath);

  if (isFirstTurn) {
    events.push({
      event_id: randomUUID(),
      event_type: 'SessionStarted',
      session_id: config.sessionId,
      timestamp: new Date().toISOString(),
      actor: 'assembly',
      payload: { chatId, query_preview: userText.slice(0, 100) },
    });
  }

  // ── Step 1: Brain similarity search ──
  let brainCues: BrainSearchResult[] = [];
  let degraded = false;
  let searchQuery = '';
  let sourceHealth = 'unknown';
  let matchOutcome = 'unknown';
  let retrievalPending = false;
  let retrievalError: string | null = null;
  let contextRetrievalTimedOut = false;
  let successfulHybridRetrieval = false;
  let successfulFastRetrieval = false;
  let retrievalFallback: Record<string, unknown> | null = null;
  const retrievalStartedAt = performance.now();
  let retrievalMs = 0;

  try {
    if (config.skipBrainEnrichment) {
      retrievalMs = 0;
    } else {
    const contextSnippet = recentTurns
      .slice(-3)
      .map(t => (t.content ?? '').slice(0, 200))
      .join(' ');
    searchQuery = `${userText} ${contextSnippet}`.trim().slice(0, 500);

    config.signal.throwIfAborted();
    const request = { query: searchQuery, topK: BRAIN_SEARCH_LIMIT };
    const retrieval = config.contextEnrichment
      ? await config.contextEnrichment.initial(request)
      : await config.contextSearch(request, AbortSignal.any([
          config.signal, AbortSignal.timeout(config.brainSearchTimeoutMs ?? BRAIN_SEARCH_TIMEOUT_MS),
        ]));
    config.signal.throwIfAborted();
    brainCues = Array.isArray(retrieval.results)
      ? retrieval.results as BrainSearchResult[]
      : [];
    const evidence = retrieval.sourceEvidence && typeof retrieval.sourceEvidence === 'object'
      ? retrieval.sourceEvidence as Record<string, unknown>
      : {};
    sourceHealth = typeof evidence.sourceHealth === 'string'
      ? evidence.sourceHealth
      : 'unknown';
    matchOutcome = typeof evidence.matchOutcome === 'string'
      ? evidence.matchOutcome
      : 'unknown';
    retrievalFallback = evidence.fallback
      && typeof evidence.fallback === 'object'
      && !Array.isArray(evidence.fallback)
      ? evidence.fallback as Record<string, unknown>
      : null;
    successfulHybridRetrieval = sourceHealth === 'degraded'
      && matchOutcome === 'matches'
      && evidence.completeCoverage === true
      && brainCues.length > 0
      && retrievalFallback?.route === 'logical-keyword-supplement'
      && retrievalFallback.reason === 'exact_canary_missing'
      && retrievalFallback.completeness === 'complete';
    successfulFastRetrieval = sourceHealth === 'degraded'
      && matchOutcome === 'matches'
      && brainCues.length > 0
      && retrievalFallback?.completeness === 'incomplete';
    retrievalPending = Boolean(config.contextEnrichment) && matchOutcome === 'pending';
    degraded = !retrievalPending && sourceHealth !== 'healthy' && !successfulHybridRetrieval && !successfulFastRetrieval;
    retrievalMs = Math.round(performance.now() - retrievalStartedAt);
    }
  } catch (err) {
    retrievalMs = Math.round(performance.now() - retrievalStartedAt);
    if (config.signal.aborted) config.signal.throwIfAborted();
    degraded = true;
    contextRetrievalTimedOut = typeof err === 'object'
      && err !== null
      && 'name' in err
      && String((err as { name: unknown }).name) === 'TimeoutError';
    sourceHealth = contextRetrievalTimedOut ? 'unknown' : 'unavailable';
    matchOutcome = 'unknown';
    const code = typeof err === 'object' && err && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'brain_search_failed';
    const message = err instanceof Error ? err.message : String(err);
    retrievalError = contextRetrievalTimedOut
      ? `context_enrichment_timeout: ${message}`
      : `${code}: ${message}`;
    events.push({
      event_id: randomUUID(),
      event_type: 'RetrievalDegraded',
      session_id: config.sessionId,
      timestamp: new Date().toISOString(),
      actor: 'assembly',
      payload: {
        reason: retrievalError,
        what_unavailable: contextRetrievalTimedOut
          ? 'automatic_context_enrichment'
          : 'requester_dashboard_brain_search',
        retrievalMs,
        stage: 'fast',
      },
    });
  }
  if (degraded && !events.some((event) => event.event_type === 'RetrievalDegraded')) {
    retrievalError = retrievalError || `source reported ${sourceHealth}`;
    events.push({
      event_id: randomUUID(),
      event_type: 'RetrievalDegraded',
      session_id: config.sessionId,
      timestamp: new Date().toISOString(),
      actor: 'assembly',
      payload: {
        reason: retrievalError,
        what_unavailable: 'requester_dashboard_brain_search',
        retrievalMs,
        stage: 'fast',
      },
    });
  }

  // ── Step 1b: Trigger evaluation ──
  let triggerMatches: Array<{ memoryId: string; memory: { title: string; statement: string; confidence: { score: number } }; trigger: { trigger_type: string; condition: string } }> = [];

  if (config.triggerIndex) {
    try {
      const isFirstTurn = recentTurns.length === 0;
      triggerMatches = config.triggerIndex.evaluate(
        userText,
        { isFirstTurn },
        ledger,
        config.sessionId,
        config.semanticEmbed,
      );
    } catch {
      // Never block on trigger evaluation failure
    }
  }

  const activationStatus = degraded
    ? 'degraded'
    : brainCues.length > 0 || triggerMatches.length > 0
      ? 'active'
      : ['no_match', 'filtered', 'corpus_empty'].includes(matchOutcome)
        ? matchOutcome
        : 'unknown';
  events.push({
    event_id: randomUUID(),
    event_type: 'MemoryActivationPosture',
    session_id: config.sessionId,
    timestamp: new Date().toISOString(),
    actor: 'assembly',
    payload: {
      schema: 'home23.memory-activation-posture.v1',
      sourceIssues: [69],
      activationStatus,
      searchAttempted: !config.skipBrainEnrichment,
      queryPreview: searchQuery.slice(0, 160),
      brainCueCount: brainCues.length,
      triggerCount: triggerMatches.length,
      degraded,
      sourceHealth,
      matchOutcome,
      retrievalError,
      fallback: retrievalFallback,
      retrievalInterpretation: successfulHybridRetrieval
        ? 'successful_hybrid'
        : successfulFastRetrieval
          ? 'successful_fast'
          : null,
      retrievalMs,
      retrievalPending,
      stage: 'fast',
    },
  });

  // ── Step 2: Score surfaces based on brain cues ──
  const surfacesSelected: string[] = [];
  const salienceItems: SalienceItem[] = [];
  const readSources = (paths: string[]) => paths.map(path => `read_file path=${JSON.stringify(path)} offset_chars=0`).join('; ');
  const seedSourcePaths = substrateStateDir
    ? [join(substrateStateDir, 'seed-ledger.jsonl'), join(substrateStateDir, 'checkpoints')]
    : [];
  const seedRecovery = substrateStateDir
    ? `${readSources(seedSourcePaths.slice(0, 1))}; list_files cwd=${JSON.stringify(seedSourcePaths[1])} pattern="ckpt_*.json", then read the newest checkpoint`
    : '';

  for (const cue of brainCues) {
    salienceItems.push({
      text: `- ${cue.concept ?? ''}${cue.tag ? ` [${cue.tag}]` : ''}`,
      score: cue.similarity,
      source: 'brain',
      recovery: `brain_search query=${JSON.stringify(searchQuery)}${cue.id !== undefined ? `; locate returned record ${JSON.stringify(cue.id)}` : ''}`,
    });
  }

  // Add triggered memories to salience items (they outrank brain similarity)
  for (const match of triggerMatches) {
    salienceItems.push({
      text: `- [trigger: ${match.trigger.trigger_type}] ${match.memory.title}: ${match.memory.statement}`,
      score: match.memory.confidence.score + 0.1, // boost triggered memories
      source: 'trigger',
      recovery: `${readSources([join(config.brainDir, 'memory-objects.json')])}; locate memoryId=${JSON.stringify(match.memoryId)}`,
    });
  }

  for (const surface of DOMAIN_SURFACES) {
    const shouldLoad = surface.alwaysBoost || isFirstTurn || brainCues.length > 0
      || triggerMatches.length > 0 || degraded;
    if (!shouldLoad) continue;

    // Home23 v2 cutover, function 1: RECENT is owned by the Seed when the
    // individual's chain has lived material — composed at read time from
    // his own record (conversations, teachings, thoughts, judged
    // predictions), never a curator-written file that can rot silently
    // (jerry's RECENT.md sat two weeks stale with nobody noticing). The
    // file remains only as degraded-honest fallback while the seed is
    // young or absent.
    if (surface.name === 'RECENT' && substrateStateDir) {
      const lived = composeLivedRecent(substrateStateDir, surface.budget);
      if (lived) {
        surfacesSelected.push('RECENT@seed');
        salienceItems.push({
          text: `\nRelevant context (RECENT — lived, from your Seed's chain):\n${lived}`,
          score: 0.7,
          source: 'surface:RECENT@seed',
          surface: 'RECENT@seed',
          recovery: seedRecovery,
        });
        continue;
      }
    }

    const loaded = loadSurface(config.workspacePath, surface.file, surface.budget, false, onCap);
    let content = loaded?.text ?? null;
    let contentChars = loaded?.contentChars ?? 0;
    if (surface.name === 'PERSONAL') {
      const learned = composeLearnedOwnerFacts(config.brainDir, userText, config.ownerDistill);
      content = [content, learned].filter(Boolean).join('\n\n') || null;
      contentChars += learned?.length ?? 0;
    }
    if (!content) continue;

    const verified = verifyFreshness(surface.name, content, surface.isFact);
    surfacesSelected.push(surface.name);
    salienceItems.push({
      text: `\nRelevant context (${surface.name}):\n${verified}`,
      score: surface.alwaysBoost ? 0.95 : 0.7,
      source: `surface:${surface.name}`,
      file: surface.file,
      surface: surface.name,
      contentChars,
      complete: loaded?.complete ?? true,
    });
  }

  // Home23 v2 cutover, function 4 — FACTS from lived estimates: the
  // individual's own conclusions that earned fact-grade (confidence +
  // evidence + they stood through lived time) load as a fact surface with
  // provenance. This is the cut where his beliefs go load-bearing; the
  // gates are the honesty machinery, and too few gate-passers → no facts
  // surface is claimed at all. TOPOLOGY.md keeps infrastructure facts
  // (ports, URLs) until his estimates carry that domain at parity.
  // Same load conditions as the other non-alwaysBoost surfaces (K2 is law:
  // nothing new rides every turn).
  const factsShouldLoad = isFirstTurn || brainCues.length > 0 || triggerMatches.length > 0 || degraded;
  if (substrateStateDir && factsShouldLoad) {
    const livedFacts = composeLivedFacts(substrateStateDir);
    if (livedFacts) {
      surfacesSelected.push('FACTS@seed');
      salienceItems.push({
        text: `\nRelevant context (FACTS — lived, from your Seed's chain):\n${livedFacts}`,
        score: 0.7,
        source: 'surface:FACTS@seed',
        surface: 'FACTS@seed',
        recovery: seedRecovery,
      });
    }
  }

  // Triggered surfaces (Step 30 cleanup #4): keyword-gated doctrine that loads
  // only when the turn is about it — attention allocation, social maintenance,
  // carry-forward — so it reaches the agent when relevant without bloating turns.
  const triggerMatchText = `${userText} ${recentTurns.slice(-3).map(t => t.content ?? '').join(' ')}`;
  for (const ts of loadTriggeredSurfaces(config.workspacePath, config.triggeredSurfaces, triggerMatchText, userText, config.semanticEmbed, onCap)) {
    surfacesSelected.push(ts.label);
    salienceItems.push({
      text: `\nRelevant context (${ts.label}):\n${ts.text}`,
      score: 0.92, // deliberately requested by the turn's cues → high salience
      source: `trigger-surface:${ts.label}`,
      file: ts.file,
      surface: ts.label,
      contentChars: ts.contentChars,
      complete: ts.complete,
    });
  }

  // AGENCY / WORKERS — operational spine, not always-on narration.
  // First turn keeps the wake-up brief; later turns earn admission the same
  // way triggered surfaces do (cues, or meaning against the anchors above).
  const opsGateBase = {
    isFirstTurn,
    degraded,
    brainCueCount: brainCues.length,
    triggerCount: triggerMatches.length,
    turnText: userText,
    matchText: recentTurns.filter(turn => turn.role === 'user').slice(-2).map(turn => turn.content).join('\n'),
    semanticEmbed: config.semanticEmbed,
    learning: substrateStateDir ? (config.readLearning ?? readSeedLearning)(substrateStateDir) : undefined,
  };
  const projectRoot = projectRootFromWorkspace(config.workspacePath);
  const agentName = agentNameFromWorkspace(config.workspacePath);
  const agencySnapshot = loadAgencyContextSnapshot(projectRoot, agentName);
  const operatorObligationSection = agencySnapshot
    ? renderOperatorObligationContextSection(agencySnapshot, Date.now())
    : '';
  if (operatorObligationSection) {
    surfacesSelected.push('OWED_TO_JTR');
    salienceItems.push({
      text: operatorObligationSection, score: 1.2, source: 'surface:OWED_TO_JTR', surface: 'OWED_TO_JTR',
      recovery: readSources([agencySnapshot!.statePath]),
    });
  }

  const opsDecision = (label: string, anchors: readonly string[]) => {
    const decision = operationalSurfaceDecision({ ...opsGateBase, label, anchors });
    const decisionId = `context:${randomUUID()}`;
    const event: EventEnvelope = { event_id: decisionId, event_type: 'LearningDecisionObserved', session_id: config.sessionId,
      timestamp: new Date().toISOString(), actor: 'assembly', payload: {
        schema: 'home23.learning-decision.v1', decisionId, scope: 'foreground.context',
        tags: decision.tags, criterion: 'owner-value', sourceRefs: [`surface:${label}`],
        choice: decision.allow ? 'admit' : 'omit', relevant: decision.relevant, explicit: decision.explicit,
        learning: decision.learned,
      } };
    if (decision.relevant) {
      if (ledger) {
        try {
          ledger.emitDurable(event, { newUnique: true });
          durablyRecorded.add(event.event_id);
        } catch (error) {
          // Keep directly requested information available. Discretionary
          // operational context waits rather than making an unrecorded choice.
          decision.allow = decision.explicit && decision.relevant;
          decision.learned.adjustment = 0;
          events.push({ ...event, event_type: 'LearningDecisionProjectionDeferred', payload: {
            decisionId, scope: 'foreground.context', requested: decision.explicit,
            reason: error instanceof Error ? error.message : String(error),
          } });
          return decision;
        }
      }
      events.push(event);
    }
    return decision;
  };
  const workerDecision = opsDecision('WORKERS', WORKER_MEANING_ANCHORS);
  if (workerDecision.allow) {
    try {
      const workerSection = buildWorkerContextSection(projectRoot, agentName);
      if (workerSection) {
        surfacesSelected.push('WORKERS');
        salienceItems.push({
          text: `\nRelevant context (WORKERS):\n${workerSection}`,
          score: Math.min(1, Math.max(0, 0.9 + workerDecision.learned.adjustment * 0.2)),
          source: 'surface:WORKERS',
          surface: 'WORKERS',
          recovery: `${readSources([join(config.brainDir, 'worker-runs.jsonl')])}; list_files cwd=${JSON.stringify(join(projectRoot, 'instances', 'workers'))} pattern="*/worker.yaml"`,
        });
      }
    } catch {
      // Invalid agent path or missing roster must not fail the turn.
    }
  }

  const agencyDecision = opsDecision('AGENCY', AGENCY_MEANING_ANCHORS);
  if (agencyDecision.allow) {
    try {
      const agencySection = agencySnapshot ? renderAgencyContextSection(agencySnapshot) : '';
      if (agencySection) {
        surfacesSelected.push('AGENCY');
        salienceItems.push({
          text: `\nRelevant context (AGENCY):\n${agencySection}`,
          score: Math.min(1, Math.max(0, 0.98 + agencyDecision.learned.adjustment * 0.2)),
          source: 'surface:AGENCY',
          surface: 'AGENCY',
          recovery: readSources([agencySnapshot!.statePath, join(agencySnapshot!.agencyDir, 'pursuits.jsonl')]),
        });
      }
    } catch {
      // Same fail-open as trigger evaluation.
    }
  }

  // SUBSTRATE (Seed → situational awareness): lived, receipted facts from
  // the Seed that metabolizes his real life — surfaced SELECTIVELY, matched
  // to this turn's meaning through the published semantic projection
  // (expression.v2, rebuilt after the 2026-08-08 integration knife judged
  // the always-on v1 block decorative). Most turns surface nothing; a turn
  // that touches carried state gets the lived facts it touches, under a
  // usage contract. Read-only; degraded-honest (missing/unreadable state or
  // a down embedder contributes nothing rather than something fake).
  if (substrateStateDir) {
    const seedSection = composeSeedSituation(substrateStateDir, {
      budget: config.substrateBudget,
      turnText: userText,
      recipeId: activeAttentionRecipeId(),
      embed: config.semanticEmbed,
    });
    if (seedSection) {
      surfacesSelected.push('SUBSTRATE');
      salienceItems.push({
        text: `\n${seedSection}`,
        score: 0.96,
        source: 'surface:SUBSTRATE',
        surface: 'SUBSTRATE',
        recovery: seedRecovery,
      });
    }
  }

  // Selection is not delivery. Publish final delivery metadata only after
  // ranking, including every budget omission and the recovery information.
  const finish = (prefix: string, footer: string, evidenceBudget: number, keepEmpty = false): AssemblyResult => {
    const omissionIndexRecovery = ledger
      ? `Search RetrievalExecuted for session ${JSON.stringify(config.sessionId)} in ${JSON.stringify(join(config.brainDir, 'event-ledger.jsonl'))} for the complete delivery_omissions index.`
      : 'The returned RetrievalExecuted delivery_omissions metadata contains the complete source index.';
    const ranked = rankBySalience(salienceItems, evidenceBudget,
      Math.max(0, SITUATIONAL_AWARENESS_MAX_CHARS - prefix.length - footer.length - 1), onCap,
      omissionIndexRecovery);
    const body = [...ranked.selected.map(item => item.text), ...(ranked.notice ? [ranked.notice] : [])].join('\n');
    const block = body || keepEmpty ? `${prefix}${body}${footer}` : '';
    const surfacesLoaded = [...new Set(ranked.selected
      .filter(item => item.surface && (item.contentChars ?? item.text.length) > 0)
      .map(item => item.surface!))];
    const surfacesOmitted = [...new Set(surfacesSelected.filter(surface => !surfacesLoaded.includes(surface)))];
    events.push({
      event_id: randomUUID(), event_type: 'RetrievalExecuted', session_id: config.sessionId,
      timestamp: new Date().toISOString(), actor: 'assembly', payload: {
        brain_cue_count: brainCues.length,
        surfaces_selected: surfacesSelected,
        surfaces_loaded: surfacesLoaded,
        surfaces_omitted: surfacesOmitted,
        delivery_omissions: ranked.omitted.map(({ item, reason }) => ({
          source: item.source, surface: item.surface ?? null, file: item.file ?? null,
          reason, recovery: item.recovery ?? `self_read file=${JSON.stringify(item.file)} offset=0`,
          delivered_chars: 0,
        })),
        surface_delivery: ranked.selected.filter(item => item.surface).map(item => ({
          surface: item.surface, source: item.source, file: item.file ?? null,
          delivered_chars: item.contentChars ?? item.text.length,
          pointer_only: item.contentChars === 0,
          complete: item.complete ?? true,
        })),
        degraded, sourceHealth, matchOutcome, retrievalError, fallback: retrievalFallback,
        retrievalInterpretation: successfulHybridRetrieval ? 'successful_hybrid' : successfulFastRetrieval ? 'successful_fast' : null,
        retrievalMs, retrievalPending, stage: 'fast',
      },
    });
    if (ledger) ledger.emit(events.filter(event => !durablyRecorded.has(event.event_id)));
    return { block, degraded, brainCueCount: brainCues.length, triggerCount: triggerMatches.length,
      surfacesLoaded, events, sourceHealth, matchOutcome, retrievalError };
  };

  // ── Step 3: Assemble with salience ranking ──
  // Provider diagnostics are a preview, not authored continuity. Preserve the
  // full values in RetrievalExecuted while preventing a malformed error from
  // consuming the entire model block and its omission/recovery index.
  const diagnostic = (value: unknown) => {
    const text = String(value ?? '');
    return text.length <= 600 ? text : `${oneLine(text, 600)} [diagnostic preview; full value recorded in RetrievalExecuted]`;
  };
  if (degraded) {
    const pieces: string[] = contextRetrievalTimedOut
      ? [
          '[SITUATIONAL AWARENESS: automatic brain context enrichment skipped for latency this turn]',
          'This automatic deadline is not a brain health result. Do not claim that the brain is offline, ' +
            'unavailable, or degraded from this skipped lookup.',
          'If the user asks about current brain health or memory, use brain_status or brain_search and report that result.',
        ]
      : [
          '[SITUATIONAL AWARENESS: brain retrieval degraded]',
          `sourceHealth=${diagnostic(sourceHealth)} matchOutcome=${diagnostic(matchOutcome)}`,
          `route=requester_dashboard_brain_search error=${diagnostic(retrievalError || `source reported ${sourceHealth}`)}`,
          'Returned cues (if any), local trigger matches, and domain surfaces below remain available. ' +
            'Retry the operation or inspect brain_status; success is not yet established.',
        ];
    return finish(`${pieces.join('\n')}\n`, '\n[/SITUATIONAL AWARENESS]', CONTEXT_BUDGET - 700, true);
  }

  const hybridRetrievalSection = successfulHybridRetrieval
    ? '[RETRIEVAL NOTE: successful hybrid brain retrieval]\n' +
      `sourceHealth=${diagnostic(sourceHealth)} matchOutcome=${diagnostic(matchOutcome)}\n` +
      `fallback=${diagnostic(retrievalFallback?.route)} reason=${diagnostic(retrievalFallback?.reason)} ` +
      `completeness=${diagnostic(retrievalFallback?.completeness)}\n` +
      'The preferred ANN route missed an exact canary; the complete logical keyword supplement ' +
      'returned matching cues. Preserve the degraded source-health evidence, but treat these matches as usable.\n' +
      '[/RETRIEVAL NOTE]\n\n'
    : successfulFastRetrieval
      ? '[RETRIEVAL NOTE: successful fast brain retrieval]\n' +
        `sourceHealth=${diagnostic(sourceHealth)} matchOutcome=${diagnostic(matchOutcome)}\n` +
        `fallback=${diagnostic(retrievalFallback?.route)} reason=${diagnostic(retrievalFallback?.reason)} ` +
        `completeness=${diagnostic(retrievalFallback?.completeness)} retrievalMs=${retrievalMs}\n` +
        'Turn enrichment used the fast index and skipped the full-brain scan. Coverage is incomplete; treat these matches as usable and do not claim the index is fully current.\n' +
        '[/RETRIEVAL NOTE]\n\n'
      : '';

  const prefix = `[SITUATIONAL AWARENESS]\n\n${retrievalPending ? `${pendingAutomaticContextDisclosure()}\n\n` : ''}${
    brainCues.length > 0
      ? '[CONTINUITY ENRICHMENT] This block includes automatic pre-turn brain cues. Do not treat them as brain_search results.\n\n'
      : ''
  }${hybridRetrievalSection}`;
  // Every selected item reaches the model regardless of which lookup admitted
  // it. In particular, Seed context and local trigger memories are independent
  // of remote brain cues, and are never classified by a rendered text prefix.
  return finish(prefix, '\n\n[/SITUATIONAL AWARENESS]', CONTEXT_BUDGET, retrievalPending);
}
