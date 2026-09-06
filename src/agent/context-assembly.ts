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
import type { AssemblyResult, EventEnvelope } from '../types.js';
import type { EventLedger } from './event-ledger.js';
import type { TriggerIndex } from './trigger-index.js';
import { budgetIdentityContent } from './identity-budget.js';
import { composeSeedSituation } from '../substrate/seed-context.js';
import { composeLivedRecent } from '../substrate/lived-recent.js';
import { composeLivedFacts } from '../substrate/lived-facts.js';
import { semanticMatchScore, SEMANTIC_MATCH_FLOOR } from '../substrate/semantic-match.js';

const require = createRequire(import.meta.url);
const { resolveAgentInstancePaths } = require('../../shared/agent-instance-paths.cjs');

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
  /** When true, skip automatic pre-turn brain retrieval (retrieval-eval isolation). */
  skipBrainEnrichment?: boolean;
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
}

/**
 * Gate for AGENCY / WORKERS — mirrors non-alwaysBoost DOMAIN_SURFACES for the
 * wake/cue path, then admits mid-session turns only when their meaning pulls
 * on the surface's anchors (triggered-surface pattern).
 */
export function shouldLoadOperationalSurface(input: OperationalSurfaceGateInput): boolean {
  // Same load conditions as DOMAIN_SURFACES / FACTS@seed (first-turn wake-up,
  // brain/trigger cues, or degraded retrieval that must not starve the turn).
  if (input.isFirstTurn || input.degraded || input.brainCueCount > 0 || input.triggerCount > 0) {
    return true;
  }

  const anchorText = `${input.label}: ${input.anchors.join(', ')}`;
  const score = semanticMatchScore(input.turnText, anchorText, input.semanticEmbed);
  if (score !== null) return score >= SEMANTIC_MATCH_FLOOR;

  const hay = input.matchText.toLowerCase();
  return input.anchors.some(anchor => hay.includes(anchor.toLowerCase()));
}

// ─── Surface Loading ────────────────────────────────────

function loadSurface(workspacePath: string, filename: string, budget: number): string | null {
  const filePath = join(workspacePath, filename);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return null;
  // Section-aware budgeting (Step 30): never a blind mid-sentence slice. Before,
  // this did content.slice(0, budget), so a 10k DOCTRINE.md was silently cut to
  // 2.5k mid-content — the same bug fixed for SOUL in the identity path.
  return budgetIdentityContent(basename(filename), content, budget, 'head').text;
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
): Array<{ label: string; text: string }> {
  if (!surfaces || surfaces.length === 0) return [];
  const hay = matchText.toLowerCase();
  const out: Array<{ label: string; text: string }> = [];
  for (const surface of surfaces) {
    const cues = [...(surface.keywords ?? []), ...(surface.domains ?? [])]
      .map(c => c.toLowerCase().trim())
      .filter(Boolean);
    if (cues.length === 0) continue;
    const label = surface.label
      ?? basename(surface.file).replace(/\.md$/i, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

    let fired: boolean;
    const score = turnText !== undefined
      ? semanticMatchScore(turnText, `${label}: ${cues.join(', ')}`, embed)
      : null;
    if (score !== null) {
      fired = score >= SEMANTIC_MATCH_FLOOR;
    } else {
      fired = cues.some(cue => hay.includes(cue));
    }
    if (!fired) continue;

    const content = loadSurface(workspacePath, surface.file, surface.budget ?? 2500);
    if (!content) continue;
    out.push({ label, text: content });
  }
  return out;
}

// ─── Salience Ranking ───────────────────────────────────

interface SalienceItem {
  text: string;
  score: number;
  source: string;
}

function rankBySalience(items: SalienceItem[], budget: number): string[] {
  items.sort((a, b) => {
    if (a.source === 'trigger' && b.source !== 'trigger') return -1;
    if (b.source === 'trigger' && a.source !== 'trigger') return 1;
    return b.score - a.score;
  });

  const selected: string[] = [];
  let totalChars = 0;

  for (const item of items) {
    if (totalChars + item.text.length > budget) continue;
    selected.push(item.text);
    totalChars += item.text.length;
  }

  return selected;
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

export function buildAgencyContextSection(projectRoot: string, agentName: string): string {
  let agencyDir: string;
  try {
    agencyDir = join(
      resolveAgentInstancePaths(projectRoot, agentName, { requireConfig: false }).brainDir,
      'agency',
    );
  } catch {
    return '';
  }
  const statePath = join(agencyDir, 'state.json');
  const pursuitsPath = join(agencyDir, 'pursuits.jsonl');
  if (!existsSync(statePath) && !existsSync(pursuitsPath)) return '';

  let state: Record<string, unknown> = {};
  try {
    state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown> : {};
  } catch {
    state = {};
  }

  const latest = new Map<string, Record<string, unknown>>();
  for (const row of readJsonlTail(pursuitsPath, 300)) {
    const pursuit = row.pursuit && typeof row.pursuit === 'object'
      ? row.pursuit as Record<string, unknown>
      : null;
    if (pursuit?.id && typeof pursuit.id === 'string') latest.set(pursuit.id, pursuit);
  }
  const active = Array.from(latest.values())
    .filter((pursuit) => ['active', 'watch'].includes(String(pursuit.status || '')))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 5);

  if (active.length === 0 && Object.keys(state).length === 0) return '';

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
  const lines = active.length > 0
    ? active.map((pursuit) => [
        `- ${pursuit.id}: ${pursuit.title || pursuit.summary || 'Untitled pursuit'}`,
        `status=${pursuit.status || 'unknown'}`,
        `authority=${pursuit.authorityLevel || 'L1'}`,
        pursuit.nextMove ? `next_move=${pursuit.nextMove}` : null,
        pursuit.desiredChangedFuture ? `changed_future=${pursuit.desiredChangedFuture}` : null,
        pursuit.nextCheckAt ? `next=${pursuit.nextCheckAt}` : null,
      ].filter(Boolean).join(' | '))
    : ['- none'];

  return [
    '## Resident Agency',
    '',
    `Mode: ${state.mode || 'unknown'}`,
    `Current pursuit: ${attention.currentPursuitId || 'none'}`,
    `Queue depth: ${attention.queueDepth ?? 'unknown'}`,
    `Attention: active ${attention.activePursuits ?? 'unknown'}/${attention.maxActivePursuits ?? 'unknown'}, watch ${attention.watchItems ?? 'unknown'}/${attention.maxWatchItems ?? 'unknown'}`,
    `Next autonomous action: ${nextAction ? [nextAction.kind, nextAction.pursuitId, nextAction.reason].filter(Boolean).join(' | ') : 'none'}`,
    `Open contradictions: ${truth.unresolvedContradictions ?? 0}`,
    ...(organLines.length > 0 ? ['', 'Body organs:', ...organLines] : []),
    ...(promptContractLines.length > 0 ? ['', 'Prompt contracts:', ...promptContractLines] : []),
    '',
    'Active pursuits:',
    ...lines,
  ].join('\n');
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
  const isFirstTurn = recentTurns.length === 0;

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
    const retrievalSignal = AbortSignal.any([
      config.signal,
      AbortSignal.timeout(config.brainSearchTimeoutMs ?? BRAIN_SEARCH_TIMEOUT_MS),
    ]);
    const retrieval = await config.contextSearch(
      { query: searchQuery, topK: BRAIN_SEARCH_LIMIT }, retrievalSignal,
    );
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
    degraded = sourceHealth !== 'healthy' && !successfulHybridRetrieval && !successfulFastRetrieval;
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
      stage: 'fast',
    },
  });

  // ── Step 2: Score surfaces based on brain cues ──
  const surfacesLoaded: string[] = [];
  const salienceItems: SalienceItem[] = [];

  for (const cue of brainCues) {
    salienceItems.push({
      text: `- ${(cue.concept ?? '').slice(0, 300)}${cue.tag ? ` [${cue.tag}]` : ''}`,
      score: cue.similarity,
      source: 'brain',
    });
  }

  // Add triggered memories to salience items (they outrank brain similarity)
  for (const match of triggerMatches) {
    salienceItems.push({
      text: `- [trigger: ${match.trigger.trigger_type}] ${match.memory.title}: ${match.memory.statement.slice(0, 250)}`,
      score: match.memory.confidence.score + 0.1, // boost triggered memories
      source: 'trigger',
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
    if (surface.name === 'RECENT' && config.substrateStateDir) {
      const lived = composeLivedRecent(config.substrateStateDir, surface.budget);
      if (lived) {
        surfacesLoaded.push('RECENT@seed');
        salienceItems.push({
          text: `\nRelevant context (RECENT — lived, from your Seed's chain):\n${lived}`,
          score: 0.7,
          source: 'surface:RECENT@seed',
        });
        continue;
      }
    }

    const content = loadSurface(config.workspacePath, surface.file, surface.budget);
    if (!content) continue;

    const verified = verifyFreshness(surface.name, content, surface.isFact);
    surfacesLoaded.push(surface.name);
    salienceItems.push({
      text: `\nRelevant context (${surface.name}):\n${verified}`,
      score: surface.alwaysBoost ? 0.95 : 0.7,
      source: `surface:${surface.name}`,
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
  if (config.substrateStateDir && factsShouldLoad) {
    const livedFacts = composeLivedFacts(config.substrateStateDir);
    if (livedFacts) {
      surfacesLoaded.push('FACTS@seed');
      salienceItems.push({
        text: `\nRelevant context (FACTS — lived, from your Seed's chain):\n${livedFacts}`,
        score: 0.7,
        source: 'surface:FACTS@seed',
      });
    }
  }

  // Triggered surfaces (Step 30 cleanup #4): keyword-gated doctrine that loads
  // only when the turn is about it — attention allocation, social maintenance,
  // carry-forward — so it reaches the agent when relevant without bloating turns.
  const triggerMatchText = `${userText} ${recentTurns.slice(-3).map(t => t.content ?? '').join(' ')}`;
  for (const ts of loadTriggeredSurfaces(config.workspacePath, config.triggeredSurfaces, triggerMatchText, userText, config.semanticEmbed)) {
    surfacesLoaded.push(ts.label);
    salienceItems.push({
      text: `\nRelevant context (${ts.label}):\n${ts.text}`,
      score: 0.92, // deliberately requested by the turn's cues → high salience
      source: `trigger-surface:${ts.label}`,
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
    matchText: triggerMatchText,
    semanticEmbed: config.semanticEmbed,
  };
  const projectRoot = projectRootFromWorkspace(config.workspacePath);
  const agentName = agentNameFromWorkspace(config.workspacePath);

  if (shouldLoadOperationalSurface({
    ...opsGateBase,
    label: 'WORKERS',
    anchors: WORKER_MEANING_ANCHORS,
  })) {
    try {
      const workerSection = buildWorkerContextSection(projectRoot, agentName);
      if (workerSection) {
        surfacesLoaded.push('WORKERS');
        salienceItems.push({
          text: `\nRelevant context (WORKERS):\n${workerSection}`,
          score: 0.9,
          source: 'surface:WORKERS',
        });
      }
    } catch {
      // Invalid agent path or missing roster must not fail the turn.
    }
  }

  if (shouldLoadOperationalSurface({
    ...opsGateBase,
    label: 'AGENCY',
    anchors: AGENCY_MEANING_ANCHORS,
  })) {
    try {
      const agencySection = buildAgencyContextSection(projectRoot, agentName);
      if (agencySection) {
        surfacesLoaded.push('AGENCY');
        salienceItems.push({
          text: `\nRelevant context (AGENCY):\n${agencySection}`,
          score: 0.98,
          source: 'surface:AGENCY',
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
  if (config.substrateStateDir) {
    const seedSection = composeSeedSituation(config.substrateStateDir, {
      budget: config.substrateBudget,
      turnText: userText,
    });
    if (seedSection) {
      surfacesLoaded.push('SUBSTRATE');
      salienceItems.push({
        text: `\n${seedSection}`,
        score: 0.96,
        source: 'surface:SUBSTRATE',
      });
    }
  }

  events.push({
    event_id: randomUUID(),
    event_type: 'RetrievalExecuted',
    session_id: config.sessionId,
    timestamp: new Date().toISOString(),
    actor: 'assembly',
    payload: {
      brain_cue_count: brainCues.length,
      surfaces_loaded: surfacesLoaded,
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
      stage: 'fast',
    },
  });

  // ── Step 3: Assemble with salience ranking ──
  if (degraded) {
    if (ledger) { ledger.emit(events); }
    const localEvidence = rankBySalience(salienceItems, CONTEXT_BUDGET - 700);
    const pieces: string[] = contextRetrievalTimedOut
      ? [
          '[SITUATIONAL AWARENESS: automatic brain context enrichment skipped for latency this turn]',
          'This automatic deadline is not a brain health result. Do not claim that the brain is offline, ' +
            'unavailable, or degraded from this skipped lookup.',
          'If the user asks about current brain health or memory, use brain_status or brain_search and report that result.',
        ]
      : [
          '[SITUATIONAL AWARENESS: brain retrieval degraded]',
          `sourceHealth=${sourceHealth} matchOutcome=${matchOutcome}`,
          `route=requester_dashboard_brain_search error=${retrievalError || `source reported ${sourceHealth}`}`,
          'Returned cues (if any), local trigger matches, and domain surfaces below remain available. ' +
            'Retry the operation or inspect brain_status; success is not yet established.',
        ];
    if (localEvidence.length > 0) pieces.push(localEvidence.join('\n'));
    pieces.push('[/SITUATIONAL AWARENESS]');

    return {
      block: pieces.join('\n').slice(0, CONTEXT_BUDGET),
      degraded: true,
      brainCueCount: brainCues.length,
      triggerCount: triggerMatches.length,
      surfacesLoaded,
      events,
      sourceHealth,
      matchOutcome,
      retrievalError,
    };
  }

  const rankedParts = rankBySalience(salienceItems, CONTEXT_BUDGET);

  if (rankedParts.length === 0) {
    if (ledger) { ledger.emit(events); }
    return {
      block: '',
      degraded: false,
      brainCueCount: brainCues.length,
      triggerCount: triggerMatches.length,
      surfacesLoaded,
      events,
      sourceHealth,
      matchOutcome,
      retrievalError,
    };
  }

  const brainSection = brainCues.length > 0
    ? `Brain cues:\n${rankedParts.filter(p => !p.startsWith('\nRelevant context')).join('\n')}\n`
    : '';

  const hybridRetrievalSection = successfulHybridRetrieval
    ? '[RETRIEVAL NOTE: successful hybrid brain retrieval]\n' +
      `sourceHealth=${sourceHealth} matchOutcome=${matchOutcome}\n` +
      `fallback=${String(retrievalFallback?.route)} reason=${String(retrievalFallback?.reason)} ` +
      `completeness=${String(retrievalFallback?.completeness)}\n` +
      'The preferred ANN route missed an exact canary; the complete logical keyword supplement ' +
      'returned matching cues. Preserve the degraded source-health evidence, but treat these matches as usable.\n' +
      '[/RETRIEVAL NOTE]\n\n'
    : successfulFastRetrieval
      ? '[RETRIEVAL NOTE: successful fast brain retrieval]\n' +
        `sourceHealth=${sourceHealth} matchOutcome=${matchOutcome}\n` +
        `fallback=${String(retrievalFallback?.route)} reason=${String(retrievalFallback?.reason)} ` +
        `completeness=${String(retrievalFallback?.completeness)} retrievalMs=${retrievalMs}\n` +
        'Turn enrichment used the fast index and skipped the full-brain scan. Coverage is incomplete; treat these matches as usable and do not claim the index is fully current.\n' +
        '[/RETRIEVAL NOTE]\n\n'
      : '';

  const surfaceSection = rankedParts
    .filter(p => p.startsWith('\nRelevant context'))
    .join('\n');

  const block = `[SITUATIONAL AWARENESS]\n\n${
    brainCues.length > 0
      ? '[CONTINUITY ENRICHMENT] This block includes automatic pre-turn brain cues. Do not treat them as brain_search results.\n\n'
      : ''
  }${hybridRetrievalSection}${brainSection}${surfaceSection}\n\n[/SITUATIONAL AWARENESS]`;

  if (ledger) { ledger.emit(events); }
  return {
    block: block.slice(0, CONTEXT_BUDGET),
    degraded: false,
    brainCueCount: brainCues.length,
    triggerCount: triggerMatches.length,
    surfacesLoaded,
    events,
    sourceHealth,
    matchOutcome,
    retrievalError,
  };
}
