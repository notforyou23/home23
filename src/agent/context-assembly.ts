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
import yaml from 'js-yaml';
import type { AssemblyResult, EventEnvelope } from '../types.js';
import type { EventLedger } from './event-ledger.js';
import type { TriggerIndex } from './trigger-index.js';

// ─── Constants ──────────────────────────────────────────
const CONTEXT_BUDGET = 6000;
const BRAIN_SEARCH_TIMEOUT_MS = 20000;  // 26k+ nodes; during coordinator review (heavy LLM activity)
                                         // searches can easily exceed 5s. Timing out here falsely
                                         // flags the brain DEGRADED in the system prompt, which the
                                         // chat agent then reports as "brain not connected" even
                                         // though it's just temporarily busy.
const BRAIN_SEARCH_LIMIT = 8;
const STALENESS_HOURS = 24;

// ─── Types ──────────────────────────────────────────────
interface BrainSearchResult {
  concept: string;     // brain returns 'concept', not 'content'
  similarity: number;  // brain returns 'similarity', not 'score'
  tag?: string;
  id?: number;
}

interface AssemblyConfig {
  workspacePath: string;
  brainDir: string;
  enginePort: number;
  sessionId: string;
  triggerIndex?: TriggerIndex;
}

// ─── Domain Surfaces ────────────────────────────────────
const DOMAIN_SURFACES = [
  { name: 'TOPOLOGY', file: 'TOPOLOGY.md', budget: 2500, alwaysBoost: false, isFact: true },
  { name: 'PROJECTS', file: 'PROJECTS.md', budget: 3000, alwaysBoost: false, isFact: false },
  { name: 'PERSONAL', file: 'PERSONAL.md', budget: 2500, alwaysBoost: false, isFact: false },
  { name: 'DOCTRINE', file: 'DOCTRINE.md', budget: 2500, alwaysBoost: false, isFact: false },
  { name: 'RECENT',   file: 'RECENT.md',   budget: 3000, alwaysBoost: true,  isFact: false },
] as const;

// ─── Brain Search ───────────────────────────────────────

async function searchBrain(
  query: string,
  enginePort: number,
): Promise<BrainSearchResult[]> {
  const url = `http://localhost:${enginePort}/api/memory/search`;
  const ac = AbortSignal.timeout(BRAIN_SEARCH_TIMEOUT_MS);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: BRAIN_SEARCH_LIMIT }),
    signal: ac,
  });

  if (!res.ok) throw new Error(`Brain search HTTP ${res.status}`);

  const data = await res.json() as { results?: BrainSearchResult[] };
  return data.results ?? [];
}

// ─── Surface Loading ────────────────────────────────────

function loadSurface(workspacePath: string, filename: string, budget: number): string | null {
  const filePath = join(workspacePath, filename);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8').trim();
  return content.slice(0, budget);
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
  const brainPath = join(projectRoot, 'instances', agentName, 'brain', 'worker-runs.jsonl');
  const recent = readJsonlTail(brainPath, 5);
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
  const agencyDir = join(projectRoot, 'instances', agentName, 'brain', 'agency');
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

function projectRootFromWorkspace(workspacePath: string): string {
  return resolve(workspacePath, '..', '..', '..');
}

function agentNameFromWorkspace(workspacePath: string): string {
  return basename(dirname(workspacePath));
}

// ─── Main Assembly Function ─────────────────────────────

export async function assembleContext(
  userText: string,
  chatId: string,
  recentTurns: Array<{ role: string; content: string }>,
  config: AssemblyConfig,
  ledger?: EventLedger,
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

  try {
    const contextSnippet = recentTurns
      .slice(-3)
      .map(t => (t.content ?? '').slice(0, 200))
      .join(' ');
    searchQuery = `${userText} ${contextSnippet}`.trim().slice(0, 500);

    brainCues = await searchBrain(searchQuery, config.enginePort);
  } catch (err) {
    degraded = true;
    events.push({
      event_id: randomUUID(),
      event_type: 'RetrievalDegraded',
      session_id: config.sessionId,
      timestamp: new Date().toISOString(),
      actor: 'assembly',
      payload: {
        reason: err instanceof Error ? err.message : String(err),
        what_unavailable: 'brain_search',
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
      );
    } catch {
      // Never block on trigger evaluation failure
    }
  }

  const activationStatus = degraded
    ? 'degraded'
    : (brainCues.length > 0 || triggerMatches.length > 0 ? 'active' : 'empty');
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
      searchAttempted: true,
      queryPreview: searchQuery.slice(0, 160),
      brainCueCount: brainCues.length,
      triggerCount: triggerMatches.length,
      degraded,
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
    const shouldLoad = surface.alwaysBoost || isFirstTurn || brainCues.length > 0;
    if (!shouldLoad) continue;

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

  const workerSection = buildWorkerContextSection(
    projectRootFromWorkspace(config.workspacePath),
    agentNameFromWorkspace(config.workspacePath),
  );
  if (workerSection) {
    surfacesLoaded.push('WORKERS');
    salienceItems.push({
      text: `\nRelevant context (WORKERS):\n${workerSection}`,
      score: 0.9,
      source: 'surface:WORKERS',
    });
  }

  const agencySection = buildAgencyContextSection(
    projectRootFromWorkspace(config.workspacePath),
    agentNameFromWorkspace(config.workspacePath),
  );
  if (agencySection) {
    surfacesLoaded.push('AGENCY');
    salienceItems.push({
      text: `\nRelevant context (AGENCY):\n${agencySection}`,
      score: 0.98,
      source: 'surface:AGENCY',
    });
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
    },
  });

  // ── Step 3: Assemble with salience ranking ──
  // If the brain probe timed out, DON'T tell the agent the brain is offline —
  // that's false and causes the LLM to report "brain not connected" to the user.
  // Instead: note the probe was skipped, surface the loaded surfaces normally,
  // and remind the agent it can call brain_status / brain_search / brain_query
  // directly if it needs brain data for this turn.
  if (degraded) {
    if (ledger) { ledger.emit(events); }

    // Try to still load domain surfaces — they're cheap local file reads.
    // Only the brain probe timed out; surfaces are unaffected.
    const degradedSurfacePieces: string[] = [];
    const degradedSurfacesLoaded: string[] = [];
    for (const surface of DOMAIN_SURFACES) {
      const content = loadSurface(config.workspacePath, surface.file, surface.budget);
      if (content) {
        degradedSurfacePieces.push(`\nRelevant context (${surface.name}):\n${content}`);
        degradedSurfacesLoaded.push(surface.name);
      }
    }

    const pieces: string[] = [
      '[SITUATIONAL AWARENESS: brain probe skipped this turn (engine busy). ' +
      'Domain surfaces below are current. If you need brain memory for this answer, ' +
      'call brain_status / brain_search / brain_query directly — they have longer ' +
      'per-call timeouts and will succeed.]',
    ];
    if (degradedSurfacePieces.length > 0) {
      pieces.push(degradedSurfacePieces.join('\n\n'));
    }
    const workerSection = buildWorkerContextSection(
      projectRootFromWorkspace(config.workspacePath),
      agentNameFromWorkspace(config.workspacePath),
    );
    if (workerSection) {
      pieces.push(`\nRelevant context (WORKERS):\n${workerSection}`);
      degradedSurfacesLoaded.push('WORKERS');
    }

    return {
      block: pieces.join('\n'),
      degraded: true,
      brainCueCount: 0,
      triggerCount: triggerMatches.length,
      surfacesLoaded: degradedSurfacesLoaded,
      events,
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
    };
  }

  const brainSection = brainCues.length > 0
    ? `Brain cues:\n${rankedParts.filter(p => !p.startsWith('\nRelevant context')).join('\n')}\n`
    : '';

  const surfaceSection = rankedParts
    .filter(p => p.startsWith('\nRelevant context'))
    .join('\n');

  const block = `[SITUATIONAL AWARENESS]\n\n${brainSection}${surfaceSection}\n\n[/SITUATIONAL AWARENESS]`;

  if (ledger) { ledger.emit(events); }
  return {
    block: block.slice(0, CONTEXT_BUDGET),
    degraded: false,
    brainCueCount: brainCues.length,
    triggerCount: triggerMatches.length,
    surfacesLoaded,
    events,
  };
}
