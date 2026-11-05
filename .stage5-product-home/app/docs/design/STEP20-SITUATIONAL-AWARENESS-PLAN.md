# Situational Awareness Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a brain-driven pre-turn context assembly system that makes the agent show up already knowing what it needs to know — replacing static identity loading with governed, triggerable, state-delta-based memory.

**Architecture:** Six interlocking systems built in 6 phases: (1) context assembly layer + domain surfaces, (2) memory object model + promote tool, (3) event ledger, (4) upgraded promotion pipeline, (5) trigger index, (6) curator cycle. Each phase delivers standalone value. The assembly layer queries the brain and loads domain surfaces before every LLM call. Memory objects carry state deltas (before/after/why) and trigger conditions. An event ledger proves continuity. A curator cycle in the engine maintains surfaces and governs promotion.

**Tech Stack:** TypeScript (harness `src/`), JavaScript (engine `engine/src/`), JSON stores (brain dir), YAML config. No new dependencies.

**Spec:** `docs/design/STEP20-SITUATIONAL-AWARENESS-ENGINE-DESIGN.md`

**Critical context for implementers:**
- The engine is JS (`engine/src/`). The harness is TS (`src/`). Two languages, one system.
- Do NOT rewrite engine files wholesale. Fix/add surgically.
- The brain's `/api/memory/search` endpoint already exists at `http://localhost:<dashboardPort>/api/memory/search` (POST, body: `{ query, limit, tag }`). Returns `{ results: [{ content, score, tag, ... }] }`.
- Identity files live at `instances/<agent>/workspace/`. Brain state at `instances/<agent>/brain/`.
- Config merges: `home.yaml` ← `agent config.yaml` ← `secrets.yaml`.
- PM2 manages all processes. Restart the harness: `pm2 restart home23-jerry-harness`. Restart the engine: `pm2 restart home23-jerry`.
- The current agent is `jerry`. Instance dir: `instances/jerry/`.

---

## File Map

### New files (harness — TypeScript)

| File | Responsibility |
|------|---------------|
| `src/agent/memory-objects.ts` | MemoryObject, ProblemThread, EventEnvelope types. CRUD for memory-objects.json, problem-threads.json. Confidence anti-theater constraints. Checkpoint quality floor. |
| `src/agent/event-ledger.ts` | Append-only JSONL writer/reader for event-ledger.jsonl. All event types. |
| `src/agent/trigger-index.ts` | Load trigger-index.json on startup. Evaluate trigger conditions against inbound messages. |
| `src/agent/context-assembly.ts` | Pre-turn assembly: brain search → trigger eval → surface loading → salience ranking → context budget → resume verification → degraded mode. Returns `[SITUATIONAL AWARENESS]` block. |
| `src/agent/tools/promote.ts` | `promote_to_memory` tool definition + execute function. |

### New files (engine — JavaScript)

| File | Responsibility |
|------|---------------|
| `engine/src/core/curator-cycle.js` | Curator cognitive role: brain-node intake, promotion gates, surface rewriting, usage-based decay, continuity gap detection. |

### Modified files

| File | What changes |
|------|-------------|
| `src/types.ts` | Add MemoryObject, ProblemThread, EventEnvelope, DeltaClass, MemoryObjectType, CuratorConfig interfaces |
| `src/agent/loop.ts` | Replace `semanticRecall` + hardcoded situational checks with `assembleContext()` call |
| `src/agent/context.ts` | Remove `MEMORY.md` from static identity load |
| `src/agent/memory.ts` | Upgrade `extractAndSave` to produce structured MemoryObjects; remove `semanticRecall` method |
| `src/agent/tools/index.ts` | Import + register `promoteToMemoryTool` |
| `configs/base-engine.yaml` | Add `curator` role to `initialRoles` |
| `engine/src/index.js` | Register curator cycle (if needed beyond yaml role config) |

### New instance data (per-agent, gitignored)

| File | Format | Purpose |
|------|--------|---------|
| `instances/jerry/workspace/TOPOLOGY.md` | Markdown | Fact surface — ports, services, URLs |
| `instances/jerry/workspace/PROJECTS.md` | Markdown | Project state surface |
| `instances/jerry/workspace/PERSONAL.md` | Markdown | Personal/relational surface |
| `instances/jerry/workspace/DOCTRINE.md` | Markdown | Conventions, boundaries, constraints |
| `instances/jerry/workspace/RECENT.md` | Markdown | Last 24-48h digest |
| `instances/jerry/brain/memory-objects.json` | JSON | `{ objects: MemoryObject[] }` |
| `instances/jerry/brain/problem-threads.json` | JSON | `{ threads: ProblemThread[] }` |
| `instances/jerry/brain/trigger-index.json` | JSON | `{ triggers: TriggerEntry[] }` |
| `instances/jerry/brain/event-ledger.jsonl` | JSONL | Append-only event log |

---

## Phase 1: Assembly Layer + Surfaces + Degraded Mode

This is the biggest bang — the agent starts showing up with relevant context immediately.

---

### Task 1: Seed domain surfaces for jerry

**Files:**
- Create: `instances/jerry/workspace/TOPOLOGY.md`
- Create: `instances/jerry/workspace/PROJECTS.md`
- Create: `instances/jerry/workspace/PERSONAL.md`
- Create: `instances/jerry/workspace/DOCTRINE.md`
- Create: `instances/jerry/workspace/RECENT.md`

These are hand-seeded initially. The curator cycle (Phase 6) will maintain them later.

- [ ] **Step 1: Create TOPOLOGY.md**

This is a **fact surface** — operational truth, registry-backed. Seed it from current known state.

```markdown
# House Topology

## Services & Ports (jerry)

| Port | Service | Process |
|------|---------|---------|
| 5001 | Engine WebSocket | home23-jerry |
| 5002 | Dashboard HTTP | home23-jerry-dash |
| 5003 | MCP Server | home23-jerry (embedded) |
| 5004 | Evobrew Bridge | home23-jerry-harness |
| 3415 | Evobrew IDE | home23-evobrew (shared) |
| 43210 | COSMO 2.3 Research | home23-cosmo23 (shared) |

## Publication Surfaces

- **Published docs:** http://100.72.171.58:8090/ — python HTTP server serving `/published/` directory. Canonical surface for shared/published docs. Created 2026-04-11.
- **Dashboard:** http://localhost:5002/home23 — AI OS home screen
- **Evobrew:** http://localhost:3415 — AI IDE

## Runtime Directories

- Instance: `instances/jerry/`
- Workspace: `instances/jerry/workspace/`
- Brain: `instances/jerry/brain/`
- Conversations: `instances/jerry/conversations/`

_Last verified: 2026-04-12. Source: config.yaml + PM2 process list._
```

Write this to `instances/jerry/workspace/TOPOLOGY.md`.

- [ ] **Step 2: Create PROJECTS.md**

```markdown
# Active Projects

## In Flight

### Situational Awareness Engine (Step 20)
- **Status:** Design complete, implementation starting
- **Goal:** Brain-driven pre-turn context assembly so the agent shows up already knowing what it needs to know
- **Key decision:** Memory objects carry state_deltas (before/after/why), not just facts
- **Thread:** tactical — child of "Ship Home23 as a product"

### Telegram Message Handling (Step 19) — SHIPPED
- Adaptive debounce (1.5s-6s based on message content)
- Queue-during-run (buffer messages while agent processes)
- Shipped 2026-04-12

## Recent Completions

- Step 16: COSMO research toolkit (11 research_* tools)
- Step 15: Design language overhaul (ReginaCosmo)
- Step 14: Vibe tile + CHAOS MODE image flow

_Curator-maintained. Last updated: 2026-04-12._
```

Write to `instances/jerry/workspace/PROJECTS.md`.

- [ ] **Step 3: Create PERSONAL.md**

```markdown
# Personal Context — jtr

## Profile
- Architect and product owner of Home23
- Doesn't code — works through agents
- Direct communication style, values conciseness
- Based in New Jersey

## Interests & Life
- Grateful Dead — runs a Grateful Dead-themed newsletter
- CrossFit
- Family: involved parent, pizza nights, field hockey outings

## Working Style
- Prefers inline execution over subagent-driven for mechanical tasks
- Wants agents to be ready and contextually aware, not reactive
- Gets frustrated when agents don't know things they should know

_Personal memory. Surface only on direct relevance. Curator-maintained._
```

Write to `instances/jerry/workspace/PERSONAL.md`.

- [ ] **Step 4: Create DOCTRINE.md**

```markdown
# Doctrine — How We Work

## Conventions
- Engine is JS. Harness is TS. Two languages, one system.
- Do NOT rewrite engine/ wholesale. Fix root-cause bugs directly.
- Do NOT rewrite engine/src/ingestion/. Legacy feeder/ is gone.
- ecosystem.config.cjs is auto-generated — never edit manually.
- NEVER pm2 delete/stop all — jtr has 50+ processes, global commands destroy everything.

## Boundaries
- cosmo23/ has vendored patches — read COSMO23-VENDORED-PATCHES.md before any edits.
- All URLs use window.location.hostname, not hardcoded localhost.
- Config single source of truth: home.yaml ← agent config.yaml ← secrets.yaml.

## Communication
- jtr prefers short, direct responses
- Don't summarize what you just did — jtr can read the diff
- Verify subagent findings before presenting — they conflate similar codebases

_Curator-maintained. Includes boundaries and operating constraints._
```

Write to `instances/jerry/workspace/DOCTRINE.md`.

- [ ] **Step 5: Create RECENT.md**

```markdown
# Recent Activity (Last 48 Hours)

## 2026-04-12

### Shipped: Telegram Adaptive Debounce + Queue-During-Run (Step 19)
- Messages < 15 chars wait 6s, > 80 chars wait 1.5s, commands bypass instantly
- Messages during active agent processing buffer and drain as next turn
- 4 commits on main, harness restarted and live

### Designed: Situational Awareness Engine (Step 20)
- Full spec written with input from brain's own self-analysis
- GPT-5.4 deep research produced canonical memory object schema
- Opus reviews caught 11 gaps, all folded in
- Jerry's self-review validated architecture, added 7 tightenings
- Implementation plan in progress

### Key Conversation: Brain Continuity Problem
- Jerry failed to recall port 8090 despite it being in the brain
- Led to deep analysis of "contextual amnesia" — data exists but isn't active
- Brain's own insight: "reactivation cues" are the missing mechanism
- This conversation produced the Step 20 design

## 2026-04-11
- Created published docs server on port 8090 (python HTTP, /published/ dir)
- Established as canonical surface for shared/published documents

_Auto-generated. Entries older than 48h drop from assembly loading._
```

Write to `instances/jerry/workspace/RECENT.md`.

- [ ] **Step 6: Commit**

```bash
git add instances/jerry/workspace/TOPOLOGY.md instances/jerry/workspace/PROJECTS.md instances/jerry/workspace/PERSONAL.md instances/jerry/workspace/DOCTRINE.md instances/jerry/workspace/RECENT.md
git commit -m "feat(step20): seed domain surfaces for jerry — topology, projects, personal, doctrine, recent"
```

Note: instances/ is gitignored per CLAUDE.md. If these files don't commit, that's expected — they live on disk for the agent, not in the repo. Skip the commit step if git ignores them.

---

### Task 2: Add types to src/types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the MemoryObject and related types**

At the end of `src/types.ts`, add:

```typescript
// ─── Situational Awareness Engine Types ─────────────────

export type MemoryObjectType =
  | 'observation'
  | 'evidence_link'
  | 'insight'
  | 'uncertainty_item'
  | 'procedure'
  | 'correction'
  | 'breakdown_diagnostic'
  | 'hypothesis'
  | 'recommendation_state'
  | 'checkpoint'
  | 'handoff_receipt';

export type DeltaClass =
  | 'belief_change'
  | 'priority_change'
  | 'scope_change'
  | 'recommendation_change'
  | 'uncertainty_change'
  | 'action_change'
  | 'measurement_model_change'
  | 'no_change';

export type LifecycleLayer = 'raw' | 'working' | 'durable';

export type MemoryStatus = 'candidate' | 'approved' | 'challenged' | 'superseded' | 'expired' | 'rejected';

export type ReviewState = 'unreviewed' | 'self_reviewed' | 'peer_reviewed' | 'approved' | 'challenged' | 'rejected' | 'expired';

export type ThreadLevel = 'constitutional' | 'strategic' | 'tactical' | 'immediate';

export interface StateDelta {
  delta_class: DeltaClass;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  why: string;
}

export interface TriggerCondition {
  trigger_type: string;
  condition: string;
}

export interface MemoryObject {
  memory_id: string;
  type: MemoryObjectType;
  thread_id: string;
  session_id: string;
  lifecycle_layer: LifecycleLayer;
  status: MemoryStatus;
  title: string;
  statement: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  actor: string;
  provenance: {
    source_refs: string[];
    session_refs: string[];
    generation_method: string;
  };
  evidence: {
    evidence_links: string[];
    grounding_strength: 'strong' | 'medium' | 'weak' | 'none';
    grounding_note?: string;
  };
  confidence: {
    score: number;
    basis: string;
  };
  state_delta: StateDelta;
  triggers: TriggerCondition[];
  scope: {
    applies_to: string[];
    excludes: string[];
  };
  review_state: ReviewState;
  supersedes?: string[];
  superseded_by?: string[];
  staleness_policy: {
    review_after_days?: number;
    expire_after_days?: number;
  };
  privacy_class?: 'internal' | 'personal' | 'sensitive';
  consent?: {
    consent_scope: 'this_session' | 'ongoing' | 'until_revoked';
    retention_basis: string;
    do_not_surface_without_trigger: boolean;
    user_confirmed?: boolean;
  };
  reuse_count: number;
  last_reactivated?: string;
  last_acted_on?: string;
}

export interface ProblemThread {
  thread_id: string;
  title: string;
  question: string;
  objective: string;
  level: ThreadLevel;
  status: 'open' | 'progressing' | 'blocked' | 'resolved' | 'archived';
  priority: 'high' | 'medium' | 'low';
  owner: string;
  parent_thread?: string;
  child_threads: string[];
  opened_at: string;
  closed_at?: string;
  current_state_summary: string;
  success_criteria: string[];
  related_threads: string[];
  context_boundaries: {
    applies_to: string[];
    does_not_apply_to: string[];
  };
  version: number;
}

export interface EventEnvelope {
  event_id: string;
  event_type: string;
  thread_id?: string;
  session_id: string;
  object_id?: string;
  timestamp: string;
  actor: string;
  invocation_id?: string;
  retry_of?: string;
  payload: Record<string, unknown>;
}

export interface AssemblyResult {
  block: string;           // the [SITUATIONAL AWARENESS] text to inject
  degraded: boolean;       // true if brain was unreachable
  brainCueCount: number;
  triggerCount: number;
  surfacesLoaded: string[];
  events: EventEnvelope[]; // events to emit after assembly
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(step20): add MemoryObject, ProblemThread, EventEnvelope types"
```

---

### Task 3: Build the context assembly layer

**Files:**
- Create: `src/agent/context-assembly.ts`

This is the core of Phase 1 — the pre-turn intelligence that queries the brain and loads the right knowledge.

- [ ] **Step 1: Create context-assembly.ts**

```typescript
/**
 * Home23 — Context Assembly Layer (Step 20)
 *
 * Pre-turn intelligence: queries the brain, loads domain surfaces,
 * applies salience ranking and staleness verification, returns a
 * [SITUATIONAL AWARENESS] block for injection into the system prompt.
 *
 * Replaces: semanticRecall, hardcoded evobrew/cosmo situational checks.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssemblyResult, EventEnvelope } from '../types.js';

// ─── Constants ──────────────────────────────────────────
const CONTEXT_BUDGET = 6000;           // max chars for [SITUATIONAL AWARENESS] block
const BRAIN_SEARCH_TIMEOUT_MS = 150;   // hard timeout for brain query
const BRAIN_SEARCH_LIMIT = 8;          // max brain nodes to request
const STALENESS_HOURS = 24;            // tag TOPOLOGY entries older than this as [UNVERIFIED]
const RECENT_MAX_AGE_HOURS = 48;       // drop RECENT.md entries older than this

// ─── Types ──────────────────────────────────────────────
interface BrainSearchResult {
  content: string;
  score: number;
  tag?: string;
  id?: string;
}

interface AssemblyConfig {
  workspacePath: string;
  brainDir: string;
  enginePort: number;
  sessionId: string;
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
  score: number;    // 0-1, higher = more salient
  source: string;   // 'brain' | 'trigger' | 'surface:<name>'
}

function rankBySalience(items: SalienceItem[], budget: number): string[] {
  // Sort: triggers first, then by score descending
  items.sort((a, b) => {
    if (a.source === 'trigger' && b.source !== 'trigger') return -1;
    if (b.source === 'trigger' && a.source !== 'trigger') return 1;
    return b.score - a.score;
  });

  const selected: string[] = [];
  let totalChars = 0;

  for (const item of items) {
    if (totalChars + item.text.length > budget) continue; // drop, don't truncate
    selected.push(item.text);
    totalChars += item.text.length;
  }

  return selected;
}

// ─── Staleness Verification ─────────────────────────────

function verifyFreshness(surfaceName: string, content: string, isFact: boolean): string {
  if (!isFact) return content;

  // For fact surfaces (TOPOLOGY), tag entries without recent verification
  const lines = content.split('\n');
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

// ─── Main Assembly Function ─────────────────────────────

export async function assembleContext(
  userText: string,
  chatId: string,
  recentTurns: Array<{ role: string; content: string }>,
  config: AssemblyConfig,
): Promise<AssemblyResult> {
  const events: EventEnvelope[] = [];
  const isFirstTurn = recentTurns.length === 0;

  // Emit SessionStarted on first turn
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

  try {
    // Build query from user text + recent context
    const contextSnippet = recentTurns
      .slice(-3)
      .map(t => t.content.slice(0, 200))
      .join(' ');
    const searchQuery = `${userText} ${contextSnippet}`.trim().slice(0, 500);

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

  // ── Step 2: Score surfaces based on brain cues ──
  // For now, load RECENT always (alwaysBoost), and load others if brain cues mention related terms
  const surfacesLoaded: string[] = [];
  const salienceItems: SalienceItem[] = [];

  // Add brain cues
  for (const cue of brainCues) {
    salienceItems.push({
      text: `- ${cue.content.slice(0, 300)}${cue.tag ? ` [${cue.tag}]` : ''}`,
      score: cue.score,
      source: 'brain',
    });
  }

  // Load surfaces
  for (const surface of DOMAIN_SURFACES) {
    // Always load RECENT; load others if brain cues suggest relevance or if first turn
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

  // Emit RetrievalExecuted
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
  if (degraded) {
    return {
      block: '[SITUATIONAL AWARENESS: DEGRADED — operating without continuity layer. Brain unreachable. Treat prior context as unverified.]',
      degraded: true,
      brainCueCount: 0,
      triggerCount: 0,
      surfacesLoaded: [],
      events,
    };
  }

  const rankedParts = rankBySalience(salienceItems, CONTEXT_BUDGET);

  if (rankedParts.length === 0) {
    return {
      block: '',
      degraded: false,
      brainCueCount: brainCues.length,
      triggerCount: 0,
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

  return {
    block: block.slice(0, CONTEXT_BUDGET),
    degraded: false,
    brainCueCount: brainCues.length,
    triggerCount: 0,    // triggers added in Phase 5
    surfacesLoaded,
    events,
  };
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 3: Commit**

```bash
git add src/agent/context-assembly.ts
git commit -m "feat(step20): context assembly layer — brain search, surface loading, salience ranking, degraded mode"
```

---

### Task 4: Wire assembly layer into the agent loop

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Add import for assembleContext**

At the top of `src/agent/loop.ts`, with the other imports, add:

```typescript
import { assembleContext } from './context-assembly.js';
```

- [ ] **Step 2: Replace the situational awareness + semanticRecall block**

In the `run()` method of AgentLoop, find the block that starts at approximately:

```typescript
      // Get system prompt — provider-aware (overlay + voice + core)
      let rawSystemPrompt = this.contextManager.getSystemPrompt(this.provider);

      // ── Situational awareness: inject channel context ──
```

and ends at approximately:

```typescript
      // ── Memory: Recovery Bundle (after truncation/compaction) ───────
```

Replace everything between the `getSystemPrompt` call and the Recovery Bundle section with:

```typescript
      // Get system prompt — provider-aware (overlay + voice + core)
      let rawSystemPrompt = this.contextManager.getSystemPrompt(this.provider);

      // ── Situational Awareness: Context Assembly (Step 20) ──
      // Replaces: hardcoded evobrew/cosmo checks + semanticRecall
      try {
        const recentTurns = truncated
          .filter((m): m is StoredMessage => 'role' in m)
          .slice(-5)
          .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : stringifyContent(m.content as ContentBlock[]),
          }));

        const assembly = await assembleContext(
          userText,
          chatId,
          recentTurns,
          {
            workspacePath: this.workspacePath,
            brainDir: join(this.workspacePath, '..', 'brain'),
            enginePort: this.toolContext.enginePort,
            sessionId: chatId,
          },
        );

        if (assembly.block) {
          rawSystemPrompt += `\n\n${assembly.block}`;
        }

        // Log assembly result
        if (assembly.degraded) {
          console.warn('[agent] Situational awareness: DEGRADED — brain unreachable');
        } else if (assembly.brainCueCount > 0 || assembly.surfacesLoaded.length > 0) {
          console.log(`[agent] Situational awareness: ${assembly.brainCueCount} brain cues, ${assembly.surfacesLoaded.length} surfaces (${assembly.surfacesLoaded.join(', ')})`);
        }
      } catch (err) {
        // Never block on assembly failure — proceed with static identity only
        console.warn('[agent] Context assembly failed, proceeding without situational awareness:', err instanceof Error ? err.message : err);
      }

      // ── Situational awareness: COSMO 2.3 active-run check ──
      // Keep this — it's a real-time probe, not a surface/memory concern
      if (this.registry.get('research_launch')) {
        try {
          const { checkCosmoActiveRun } = await import('./tools/research.js');
          const active = await checkCosmoActiveRun();
          if (active) {
            rawSystemPrompt += `\n\n[COSMO ACTIVE RUN]
A research run is currently in flight — do not launch another.
- runName: ${active.runName}
- topic: ${active.topic || '(unknown)'}
- started: ${active.startedAt || '(unknown)'}
- processes: ${active.processCount}
Use research_watch_run to check progress. Use research_stop to cancel. You can still query completed brains while this runs.`;
          }
        } catch {
          // Never block on situational awareness failure
        }
      }
```

This removes:
- The hardcoded evobrew channel check (surfaces will handle this)
- The `semanticRecall` call (replaced by brain search in assembly)
- Keeps the COSMO active-run check (it's a real-time probe, not a memory concern)

- [ ] **Step 3: Add join import if not already present**

Check if `join` from `node:path` is already imported at the top of loop.ts. If not, add it to the existing path import.

- [ ] **Step 4: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(step20): wire context assembly into agent loop, replacing semanticRecall"
```

---

### Task 5: Remove MEMORY.md from static identity load

**Files:**
- Modify: `instances/jerry/config.yaml`

- [ ] **Step 1: Remove MEMORY.md from identityFiles**

In `instances/jerry/config.yaml`, find the `identityFiles` list under `chat:`:

```yaml
  identityFiles:
    - SOUL.md
    - MISSION.md
    - HEARTBEAT.md
    - MEMORY.md
    - LEARNINGS.md
    - COSMO_RESEARCH.md
```

Remove `MEMORY.md` from this list (domain surfaces replace it):

```yaml
  identityFiles:
    - SOUL.md
    - MISSION.md
    - HEARTBEAT.md
    - LEARNINGS.md
    - COSMO_RESEARCH.md
```

- [ ] **Step 2: Verify — no commit needed (instances/ is gitignored)**

The change is live on disk. Restart the harness to pick it up.

---

### Task 6: Build, restart, and verify Phase 1

- [ ] **Step 1: Full build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 2: Restart harness**

Run: `pm2 restart home23-jerry-harness`

- [ ] **Step 3: Verify in logs**

Run: `pm2 logs home23-jerry-harness --lines 30 --nostream`

Look for:
- Normal startup banner ("Jerry is LIVE")
- On first Telegram message, look for `[agent] Situational awareness: N brain cues, M surfaces`
- If brain is unreachable, look for `[agent] Situational awareness: DEGRADED`

- [ ] **Step 4: Send a test message via Telegram**

Send "what port is the published docs server on?" and verify the agent answers correctly from the TOPOLOGY surface.

- [ ] **Step 5: Commit all Phase 1 work if not already committed**

```bash
git add -A && git status
git commit -m "feat(step20): Phase 1 complete — context assembly layer + domain surfaces + degraded mode"
```

---

## Phase 2: Memory Object Model + Promote Tool

---

### Task 7: Build memory-objects.ts — types, CRUD, stores

**Files:**
- Create: `src/agent/memory-objects.ts`

- [ ] **Step 1: Create the memory object store**

```typescript
/**
 * Home23 — Memory Object Store (Step 20)
 *
 * CRUD for MemoryObjects and ProblemThreads.
 * Stored as JSON files in the brain directory.
 * Includes confidence anti-theater constraints and checkpoint quality floor.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryObject, ProblemThread, LifecycleLayer } from '../types.js';

// ─── Confidence Anti-Theater Constraints ────────────────
// Confidence must be downstream of provenance, not parallel to it.
const CONFIDENCE_CAPS: Record<string, number> = {
  reflection_synthesis: 0.6,    // brain-generated insight, no independent evidence
  document_ingestion: 0.7,      // from a document, not verified
  conversation: 0.8,            // user-stated in conversation
  agent_promote: 0.8,           // agent promoted mid-conversation
  curator: 0.7,                 // curator synthesized
  runtime_verified: 0.95,       // verified from live system state
};

export function constrainConfidence(score: number, generationMethod: string): number {
  const cap = CONFIDENCE_CAPS[generationMethod] ?? 0.7;
  return Math.min(score, cap);
}

// ─── Store ──────────────────────────────────────────────

export class MemoryObjectStore {
  private objectsPath: string;
  private threadsPath: string;
  private objects: MemoryObject[] = [];
  private threads: ProblemThread[] = [];

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.objectsPath = join(brainDir, 'memory-objects.json');
    this.threadsPath = join(brainDir, 'problem-threads.json');
    this.load();
  }

  // ── Load / Save ──

  private load(): void {
    if (existsSync(this.objectsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.objectsPath, 'utf-8'));
        this.objects = raw.objects ?? [];
      } catch { this.objects = []; }
    }
    if (existsSync(this.threadsPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.threadsPath, 'utf-8'));
        this.threads = raw.threads ?? [];
      } catch { this.threads = []; }
    }
    console.log(`[memory-objects] Loaded ${this.objects.length} objects, ${this.threads.length} threads`);
  }

  private saveObjects(): void {
    writeFileSync(this.objectsPath, JSON.stringify({ objects: this.objects }, null, 2));
  }

  private saveThreads(): void {
    writeFileSync(this.threadsPath, JSON.stringify({ threads: this.threads }, null, 2));
  }

  // ── Memory Object CRUD ──

  createObject(partial: Omit<MemoryObject, 'memory_id' | 'created_at' | 'updated_at' | 'reuse_count'>): MemoryObject {
    const now = new Date().toISOString();

    // Apply confidence constraint
    const constrainedConfidence = constrainConfidence(
      partial.confidence.score,
      partial.provenance.generation_method,
    );

    // Checkpoint quality floor
    if (partial.type === 'checkpoint') {
      if (!partial.statement || partial.confidence.score <= 0 || partial.provenance.session_refs.length === 0) {
        throw new Error('Checkpoint requires non-empty statement, confidence > 0, and at least one session_ref');
      }
    }

    const obj: MemoryObject = {
      ...partial,
      memory_id: `mo_${randomUUID().slice(0, 12)}`,
      created_at: now,
      updated_at: now,
      confidence: {
        score: constrainedConfidence,
        basis: partial.confidence.basis,
      },
      reuse_count: 0,
    };

    this.objects.push(obj);
    this.saveObjects();
    return obj;
  }

  getObject(memoryId: string): MemoryObject | undefined {
    return this.objects.find(o => o.memory_id === memoryId);
  }

  updateObject(memoryId: string, updates: Partial<MemoryObject>): MemoryObject | undefined {
    const idx = this.objects.findIndex(o => o.memory_id === memoryId);
    if (idx === -1) return undefined;
    this.objects[idx] = { ...this.objects[idx]!, ...updates, updated_at: new Date().toISOString() };
    this.saveObjects();
    return this.objects[idx];
  }

  getObjectsByThread(threadId: string): MemoryObject[] {
    return this.objects.filter(o => o.thread_id === threadId);
  }

  getObjectsByLayer(layer: LifecycleLayer): MemoryObject[] {
    return this.objects.filter(o => o.lifecycle_layer === layer);
  }

  getDurableWithTriggers(): MemoryObject[] {
    return this.objects.filter(o => o.lifecycle_layer === 'durable' && o.triggers.length > 0);
  }

  incrementReuse(memoryId: string): void {
    const obj = this.objects.find(o => o.memory_id === memoryId);
    if (obj) {
      obj.reuse_count++;
      obj.last_reactivated = new Date().toISOString();
      this.saveObjects();
    }
  }

  markActedOn(memoryId: string): void {
    const obj = this.objects.find(o => o.memory_id === memoryId);
    if (obj) {
      obj.last_acted_on = new Date().toISOString();
      this.saveObjects();
    }
  }

  // ── Problem Thread CRUD ──

  createThread(partial: Omit<ProblemThread, 'thread_id' | 'opened_at' | 'version'>): ProblemThread {
    const thread: ProblemThread = {
      ...partial,
      thread_id: `pt_${randomUUID().slice(0, 12)}`,
      opened_at: new Date().toISOString(),
      version: 1,
    };
    this.threads.push(thread);
    this.saveThreads();
    return thread;
  }

  getThread(threadId: string): ProblemThread | undefined {
    return this.threads.find(t => t.thread_id === threadId);
  }

  updateThread(threadId: string, updates: Partial<ProblemThread>): ProblemThread | undefined {
    const idx = this.threads.findIndex(t => t.thread_id === threadId);
    if (idx === -1) return undefined;
    const current = this.threads[idx]!;
    this.threads[idx] = { ...current, ...updates, version: current.version + 1 };
    this.saveThreads();
    return this.threads[idx];
  }

  getAllThreads(): ProblemThread[] {
    return [...this.threads];
  }

  getOpenThreads(): ProblemThread[] {
    return this.threads.filter(t => t.status === 'open' || t.status === 'progressing');
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 3: Commit**

```bash
git add src/agent/memory-objects.ts
git commit -m "feat(step20): memory object store — CRUD, confidence constraints, checkpoint quality floor"
```

---

### Task 8: Build the promote_to_memory tool

**Files:**
- Create: `src/agent/tools/promote.ts`
- Modify: `src/agent/tools/index.ts`

- [ ] **Step 1: Create promote.ts**

```typescript
/**
 * Home23 — promote_to_memory tool (Step 20)
 *
 * Agent calls this mid-conversation when it recognizes something
 * load-bearing: new convention, topology change, personal context,
 * key decision, correction, procedure.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const promoteToMemoryTool: ToolDefinition = {
  name: 'promote_to_memory',
  description: `Promote important knowledge to durable memory. Use this when:
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
      const brainDir = ctx.workspacePath.replace('/workspace', '/brain');
      const store = new MemoryObjectStore(brainDir);

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

      const obj = store.createObject({
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
      });

      return {
        content: `Promoted to memory: "${title}" (${obj.memory_id})\nThread: ${thread.thread_id} — ${thread.title}\nTriggers: ${triggerKeywords.join(', ')}\nState delta: ${before} → ${after} (${why})`,
      };
    } catch (err) {
      return {
        content: `Failed to promote: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  },
};
```

- [ ] **Step 2: Register the tool in index.ts**

In `src/agent/tools/index.ts`, add the import at the top with the others:

```typescript
import { promoteToMemoryTool } from './promote.js';
```

And add the registration in `createToolRegistry()`:

```typescript
  registry.register(promoteToMemoryTool);
```

Add it after the last `registry.register` call (after `compileSectionTool`).

- [ ] **Step 3: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 4: Commit**

```bash
git add src/agent/tools/promote.ts src/agent/tools/index.ts
git commit -m "feat(step20): promote_to_memory tool — mid-conversation memory promotion with state_delta"
```

---

### Task 9: Seed initial problem threads for jerry

**Files:**
- Create: `instances/jerry/brain/problem-threads.json`
- Create: `instances/jerry/brain/memory-objects.json`

- [ ] **Step 1: Create initial problem threads**

Write to `instances/jerry/brain/problem-threads.json`:

```json
{
  "threads": [
    {
      "thread_id": "pt_constitutional_01",
      "title": "Home23 is a persistent AI operating system",
      "question": "What does it mean for Home23 to provide real continuity?",
      "objective": "Home23 preserves and actively uses knowledge across sessions",
      "level": "constitutional",
      "status": "open",
      "priority": "high",
      "owner": "jtr",
      "child_threads": ["pt_strategic_01"],
      "opened_at": "2026-04-07T00:00:00Z",
      "current_state_summary": "Core build complete. Situational awareness engine designed. The gap between data existing and knowledge being active is the next frontier.",
      "success_criteria": ["Agent shows up already knowing what it needs to know", "No 8090-class failures"],
      "related_threads": [],
      "context_boundaries": {
        "applies_to": ["all Home23 systems"],
        "does_not_apply_to": []
      },
      "version": 1
    },
    {
      "thread_id": "pt_strategic_01",
      "title": "Ship Home23 as a product",
      "question": "What needs to happen for Home23 to be installable and useful?",
      "objective": "Home23 is installable, portable, and demonstrates real continuity",
      "level": "strategic",
      "status": "progressing",
      "priority": "high",
      "owner": "jtr",
      "parent_thread": "pt_constitutional_01",
      "child_threads": ["pt_tactical_step20"],
      "opened_at": "2026-04-07T00:00:00Z",
      "current_state_summary": "Steps 1-19 complete. Step 20 (situational awareness) in implementation.",
      "success_criteria": ["All steps complete", "Public release on GitHub", "Agent demonstrates continuity"],
      "related_threads": [],
      "context_boundaries": {
        "applies_to": ["Home23 development"],
        "does_not_apply_to": []
      },
      "version": 1
    },
    {
      "thread_id": "pt_tactical_step20",
      "title": "Build the Situational Awareness Engine",
      "question": "How should the agent achieve pre-turn contextual awareness?",
      "objective": "Brain-driven context assembly before every LLM call",
      "level": "tactical",
      "status": "progressing",
      "priority": "high",
      "owner": "jtr",
      "parent_thread": "pt_strategic_01",
      "child_threads": [],
      "opened_at": "2026-04-12T00:00:00Z",
      "current_state_summary": "Phase 1 (assembly + surfaces) complete. Phase 2 (memory objects + promote tool) in progress.",
      "success_criteria": ["Assembly layer queries brain before every turn", "Memory objects carry state_deltas", "Event ledger proves continuity", "Curator maintains surfaces"],
      "related_threads": [],
      "context_boundaries": {
        "applies_to": ["Step 20 implementation"],
        "does_not_apply_to": []
      },
      "version": 1
    },
    {
      "thread_id": "pt_ops_topology",
      "title": "House topology and services",
      "question": "What services are running, on what ports, serving what purpose?",
      "objective": "Agent always knows the current house topology",
      "level": "immediate",
      "status": "open",
      "priority": "medium",
      "owner": "system",
      "parent_thread": "pt_strategic_01",
      "child_threads": [],
      "opened_at": "2026-04-11T00:00:00Z",
      "current_state_summary": "TOPOLOGY.md surface seeded. Published docs on 8090 established as convention.",
      "success_criteria": ["Agent correctly answers port/service questions without searching"],
      "related_threads": [],
      "context_boundaries": {
        "applies_to": ["ops", "topology", "services", "ports"],
        "does_not_apply_to": []
      },
      "version": 1
    },
    {
      "thread_id": "pt_personal_jtr",
      "title": "jtr's personal context",
      "question": "What ongoing personal threads should the agent carry?",
      "objective": "Maintain relational continuity with the owner",
      "level": "immediate",
      "status": "open",
      "priority": "medium",
      "owner": "jtr",
      "child_threads": [],
      "opened_at": "2026-04-12T00:00:00Z",
      "current_state_summary": "PERSONAL.md surface seeded with known profile. Consent-gated — only stores what was shared.",
      "success_criteria": ["Agent carries personal context without being prompted", "No inappropriate surfacing"],
      "related_threads": [],
      "context_boundaries": {
        "applies_to": ["personal", "health", "family", "interests"],
        "does_not_apply_to": ["technical implementation"]
      },
      "version": 1
    }
  ]
}
```

- [ ] **Step 2: Create empty memory-objects.json**

Write to `instances/jerry/brain/memory-objects.json`:

```json
{
  "objects": []
}
```

- [ ] **Step 3: Build and restart**

Run:
```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc && pm2 restart home23-jerry-harness
```

- [ ] **Step 4: Verify — send a test message and use promote_to_memory**

Send via Telegram: "Let's test the promote tool. Remember that the published docs are on port 8090."

The agent should use `promote_to_memory` to capture this. Check `instances/jerry/brain/memory-objects.json` afterwards to verify an object was created.

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory-objects.ts src/agent/tools/promote.ts src/agent/tools/index.ts
git commit -m "feat(step20): Phase 2 complete — memory object model + promote tool + problem threads"
```

---

## Phase 3: Event Ledger + Completion Chain

---

### Task 10: Build the event ledger

**Files:**
- Create: `src/agent/event-ledger.ts`

- [ ] **Step 1: Create event-ledger.ts**

```typescript
/**
 * Home23 — Event Ledger (Step 20)
 *
 * Immutable, append-only log proving continuity actually happened.
 * JSONL format — one event per line.
 *
 * Event types:
 *   SessionStarted, CheckpointLoaded, RetrievalExecuted, RetrievalDegraded,
 *   EvidenceLinked, StateDeltaRecorded, UncertaintyRecorded,
 *   MemoryCandidateCreated, MemoryPromoted, MemoryRejected, MemoryChallenged,
 *   CheckpointSaved, MemoryReactivated, MemoryActedOn, HandoffReceived,
 *   OutcomeObserved, BreakdownDiagnosed,
 *   TriggerFired, TriggerAccepted, TriggerRejected, TriggerMissed
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../types.js';

export class EventLedger {
  private ledgerPath: string;

  constructor(brainDir: string) {
    mkdirSync(brainDir, { recursive: true });
    this.ledgerPath = join(brainDir, 'event-ledger.jsonl');
  }

  /**
   * Append one or more events to the ledger.
   * Never throws — event logging is best-effort.
   */
  emit(events: EventEnvelope | EventEnvelope[]): void {
    const arr = Array.isArray(events) ? events : [events];
    try {
      const lines = arr.map(e => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(this.ledgerPath, lines);
    } catch (err) {
      console.warn('[event-ledger] Failed to write:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Create and emit a single event.
   */
  record(
    eventType: string,
    sessionId: string,
    payload: Record<string, unknown>,
    opts?: { threadId?: string; objectId?: string; actor?: string },
  ): EventEnvelope {
    const event: EventEnvelope = {
      event_id: randomUUID(),
      event_type: eventType,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      actor: opts?.actor ?? 'system',
      thread_id: opts?.threadId,
      object_id: opts?.objectId,
      payload,
    };
    this.emit(event);
    return event;
  }

  /**
   * Read all events (for curator analysis).
   * Returns in chronological order.
   */
  readAll(): EventEnvelope[] {
    if (!existsSync(this.ledgerPath)) return [];
    try {
      return readFileSync(this.ledgerPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as EventEnvelope);
    } catch {
      return [];
    }
  }

  /**
   * Read events since a given timestamp.
   */
  readSince(since: string): EventEnvelope[] {
    const sinceMs = new Date(since).getTime();
    return this.readAll().filter(e => new Date(e.timestamp).getTime() >= sinceMs);
  }

  /**
   * Read events of a specific type.
   */
  readByType(eventType: string): EventEnvelope[] {
    return this.readAll().filter(e => e.event_type === eventType);
  }

  /**
   * Read events for a specific session.
   */
  readBySession(sessionId: string): EventEnvelope[] {
    return this.readAll().filter(e => e.session_id === sessionId);
  }

  /**
   * Count events by type (for audit metrics).
   */
  countByType(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.readAll()) {
      counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    }
    return counts;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 3: Commit**

```bash
git add src/agent/event-ledger.ts
git commit -m "feat(step20): event ledger — append-only JSONL log for continuity proof chain"
```

---

### Task 11: Wire event ledger into context assembly and agent loop

**Files:**
- Modify: `src/agent/context-assembly.ts`
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Update context-assembly.ts to accept and use an EventLedger**

The assembly layer already produces EventEnvelope objects in the `events` array. Now we need the caller to pass in an EventLedger instance and emit the events. Update the `assembleContext` function signature to accept an optional `ledger` parameter:

At the top of `context-assembly.ts`, add:

```typescript
import type { EventLedger } from './event-ledger.js';
```

Update the `assembleContext` function signature — add `ledger?: EventLedger` as the last parameter:

```typescript
export async function assembleContext(
  userText: string,
  chatId: string,
  recentTurns: Array<{ role: string; content: string }>,
  config: AssemblyConfig,
  ledger?: EventLedger,
): Promise<AssemblyResult> {
```

At the end of `assembleContext`, before the return statements, add:

```typescript
  // Emit events to ledger if available
  if (ledger) {
    ledger.emit(events);
  }
```

Add this before each `return` in the function (there are two return paths — degraded and normal).

- [ ] **Step 2: Update loop.ts to create and pass EventLedger**

In `src/agent/loop.ts`, add the import:

```typescript
import { EventLedger } from './event-ledger.js';
```

In the `AgentLoop` constructor or early in the class, create the ledger instance. Add it as a class field:

Find the class field declarations and add:

```typescript
  private eventLedger: EventLedger;
```

In the constructor, after `this.workspacePath` is set, initialize:

```typescript
    this.eventLedger = new EventLedger(join(this.workspacePath, '..', 'brain'));
```

Then in the `run()` method, pass the ledger to `assembleContext`:

Update the `assembleContext` call to include the ledger:

```typescript
        const assembly = await assembleContext(
          userText,
          chatId,
          recentTurns,
          {
            workspacePath: this.workspacePath,
            brainDir: join(this.workspacePath, '..', 'brain'),
            enginePort: this.toolContext.enginePort,
            sessionId: chatId,
          },
          this.eventLedger,
        );
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 4: Build, restart, and verify events**

```bash
npx tsc && pm2 restart home23-jerry-harness
```

Send a test message via Telegram. Then check:

```bash
cat instances/jerry/brain/event-ledger.jsonl
```

Expected: You should see `SessionStarted` and `RetrievalExecuted` events (or `RetrievalDegraded` if the engine isn't running).

- [ ] **Step 5: Commit**

```bash
git add src/agent/context-assembly.ts src/agent/loop.ts src/agent/event-ledger.ts
git commit -m "feat(step20): Phase 3 complete — event ledger wired into assembly layer and agent loop"
```

---

## Phase 4: Upgraded Promotion Pipeline

---

### Task 12: Upgrade extractAndSave to produce structured MemoryObjects

**Files:**
- Modify: `src/agent/memory.ts`

- [ ] **Step 1: Update the extraction prompt to produce structured output**

In `src/agent/memory.ts`, find the `extractAndSave` method. Replace the existing extraction prompt (the `system` and `messages` in the `client.messages.create` call) with a structured extraction prompt.

Find the `system` line that reads:
```typescript
        system: 'You are a memory extraction assistant. Extract only concrete facts, decisions, and context worth remembering. Be terse. No fluff.',
```

Replace the entire `client.messages.create` call (system + messages) with:

```typescript
        system: `You are a memory extraction assistant for a persistent AI agent. Extract structured memory objects from conversations.

For each important item, output a JSON object on its own line with these fields:
- type: "insight" | "observation" | "correction" | "procedure" | "uncertainty_item"
- title: short title
- statement: the knowledge itself
- domain: "ops" | "project" | "personal" | "doctrine"
- before: what was true/believed before (empty string if new knowledge)
- after: what is now true
- why: why this changed or matters
- trigger_keywords: comma-separated keywords that should resurface this
- applies_to: comma-separated contexts where this applies
- priority: "high" | "medium" | "low"

Prioritize: corrections (agent was wrong about something), new conventions, topology changes, personal context shared, key decisions.
Skip: pleasantries, repetitive questions, implementation details already in code.
Output ONLY the JSON objects, one per line. No prose.`,
        messages: [
          {
            role: 'user',
            content: `Extract structured memory objects from this conversation:\n\n${transcript}`,
          },
        ],
```

- [ ] **Step 2: Parse the structured output and create MemoryObjects**

After the extraction response is received and `extracted` is set, replace the existing daily-file + MEMORY.md writing logic with:

```typescript
      if (!extracted) return;

      // Parse structured output into MemoryObjects
      const lines = extracted.split('\n').filter(l => l.trim().startsWith('{'));

      if (lines.length === 0) {
        // Fallback: write raw extraction to daily file (backwards compat)
        const dateStr = new Date().toISOString().split('T')[0]!;
        const timeStr = new Date().toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
        });
        const dailyPath = join(this.memoryDir, `${dateStr}.md`);
        const dailyEntry = `\n## Session ${timeStr} ET — chat:${chatId}\n\n${extracted}\n`;
        appendFileSync(dailyPath, dailyEntry, 'utf-8');
        return;
      }

      // Create MemoryObjects from parsed lines
      try {
        const { MemoryObjectStore } = await import('./memory-objects.js');
        const brainDir = join(this.workspacePath, '..', 'brain');
        const store = new MemoryObjectStore(brainDir);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              type: string; title: string; statement: string; domain: string;
              before: string; after: string; why: string;
              trigger_keywords: string; applies_to: string; priority: string;
            };

            // Find or create thread
            const threads = store.getOpenThreads();
            let thread = threads.find(t =>
              t.context_boundaries.applies_to.some(a =>
                parsed.applies_to.split(',').map(s => s.trim()).includes(a)
              )
            );

            if (!thread) {
              thread = store.createThread({
                title: `${parsed.domain} — ${parsed.title}`,
                question: `What should be known about ${parsed.title}?`,
                objective: parsed.statement.slice(0, 100),
                level: 'immediate',
                status: 'open',
                priority: parsed.priority === 'high' ? 'high' : 'medium',
                owner: 'extraction',
                child_threads: [],
                current_state_summary: parsed.statement,
                success_criteria: [],
                related_threads: [],
                context_boundaries: {
                  applies_to: parsed.applies_to.split(',').map(s => s.trim()),
                  does_not_apply_to: [],
                },
              });
            }

            const deltaClass = parsed.type === 'correction' ? 'belief_change'
              : parsed.type === 'uncertainty_item' ? 'uncertainty_change'
              : parsed.type === 'procedure' ? 'action_change'
              : 'belief_change';

            store.createObject({
              type: parsed.type as any,
              thread_id: thread.thread_id,
              session_id: chatId,
              lifecycle_layer: 'working',
              status: 'candidate',
              title: parsed.title,
              statement: parsed.statement,
              actor: 'extraction',
              provenance: {
                source_refs: [],
                session_refs: [chatId],
                generation_method: 'conversation',
              },
              evidence: {
                evidence_links: [],
                grounding_strength: 'medium',
                grounding_note: 'Extracted from conversation by Haiku',
              },
              confidence: {
                score: 0.75,
                basis: 'Conversation extraction',
              },
              state_delta: {
                delta_class: deltaClass,
                before: { state: parsed.before || '(unknown prior state)' },
                after: { state: parsed.after },
                why: parsed.why,
              },
              triggers: parsed.trigger_keywords.split(',').map(kw => ({
                trigger_type: 'keyword',
                condition: kw.trim(),
              })).filter(t => t.condition),
              scope: {
                applies_to: parsed.applies_to.split(',').map(s => s.trim()),
                excludes: [],
              },
              review_state: 'unreviewed',
              staleness_policy: {
                review_after_days: 30,
              },
            });

            console.log(`[memory] Extracted MemoryObject: "${parsed.title}" (${parsed.type})`);
          } catch (parseErr) {
            // Skip malformed lines
            console.warn('[memory] Failed to parse extraction line:', line.slice(0, 80));
          }
        }
      } catch (storeErr) {
        console.warn('[memory] Failed to create MemoryObjects from extraction:', storeErr);
      }
```

- [ ] **Step 3: Remove the semanticRecall method**

In `memory.ts`, find the `semanticRecall` method (the entire `async semanticRecall(query: string): Promise<string | null>` method). Delete it entirely — it's been replaced by the context assembly layer's brain search.

- [ ] **Step 4: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`

If there are compilation errors from other files still referencing `semanticRecall`, those references were already removed in Task 4 (the loop.ts wiring). If any remain, find and remove them.

- [ ] **Step 5: Commit**

```bash
git add src/agent/memory.ts
git commit -m "feat(step20): Phase 4 — upgraded extraction pipeline producing structured MemoryObjects"
```

---

## Phase 5: Trigger Index + Trigger Audit

---

### Task 13: Build the trigger index

**Files:**
- Create: `src/agent/trigger-index.ts`

- [ ] **Step 1: Create trigger-index.ts**

```typescript
/**
 * Home23 — Trigger Index (Step 20)
 *
 * Loads durable MemoryObject triggers on startup.
 * Evaluates trigger conditions against inbound messages per-turn.
 * Records trigger audit events.
 */

import type { MemoryObject, TriggerCondition, EventEnvelope } from '../types.js';
import type { MemoryObjectStore } from './memory-objects.js';
import type { EventLedger } from './event-ledger.js';

interface TriggerMatch {
  memoryId: string;
  trigger: TriggerCondition;
  memory: MemoryObject;
}

export class TriggerIndex {
  private entries: Array<{ memory: MemoryObject; trigger: TriggerCondition }> = [];

  /**
   * Load all durable memories with triggers.
   */
  loadFrom(store: MemoryObjectStore): void {
    const durable = store.getDurableWithTriggers();
    this.entries = [];
    for (const obj of durable) {
      for (const trigger of obj.triggers) {
        this.entries.push({ memory: obj, trigger });
      }
    }
    console.log(`[trigger-index] Loaded ${this.entries.length} trigger(s) from ${durable.length} durable memories`);
  }

  /**
   * Evaluate all triggers against the current message + context.
   * Returns matching memories.
   */
  evaluate(
    userText: string,
    context: { isFirstTurn: boolean; recentDomains?: string[] },
    ledger?: EventLedger,
    sessionId?: string,
  ): TriggerMatch[] {
    const matches: TriggerMatch[] = [];
    const textLower = userText.toLowerCase();

    for (const entry of this.entries) {
      let fired = false;

      switch (entry.trigger.trigger_type) {
        case 'keyword': {
          // OR-separated keywords
          const keywords = entry.trigger.condition.split(/\s+OR\s+/i).map(k => k.trim().toLowerCase());
          fired = keywords.some(kw => textLower.includes(kw));
          break;
        }
        case 'temporal': {
          if (entry.trigger.condition === 'first turn of new session') {
            fired = context.isFirstTurn;
          }
          break;
        }
        case 'domain_entry': {
          // Check if recent domains include the specified domain
          const domain = entry.trigger.condition.replace(/conversation enters\s+/i, '').replace(/\s+domain$/i, '').trim().toLowerCase();
          fired = context.recentDomains?.includes(domain) ?? false;
          break;
        }
        case 'workflow_stage': {
          // Simple keyword check for workflow stage
          const stage = entry.trigger.condition.toLowerCase();
          fired = textLower.includes(stage);
          break;
        }
        case 'recurrence': {
          // Recurrence matching is complex — defer to curator cycle
          fired = false;
          break;
        }
      }

      if (fired) {
        matches.push({
          memoryId: entry.memory.memory_id,
          trigger: entry.trigger,
          memory: entry.memory,
        });

        // Emit TriggerFired event
        if (ledger && sessionId) {
          ledger.record('TriggerFired', sessionId, {
            memory_id: entry.memory.memory_id,
            trigger_type: entry.trigger.trigger_type,
            trigger_condition: entry.trigger.condition,
            memory_title: entry.memory.title,
          }, { objectId: entry.memory.memory_id, actor: 'trigger-index' });
        }
      }
    }

    return matches;
  }
}
```

- [ ] **Step 2: Wire trigger index into context-assembly.ts**

In `src/agent/context-assembly.ts`, add the import:

```typescript
import { TriggerIndex } from './trigger-index.js';
import { MemoryObjectStore } from './memory-objects.js';
```

Update `AssemblyConfig` to include an optional trigger index:

```typescript
interface AssemblyConfig {
  workspacePath: string;
  brainDir: string;
  enginePort: number;
  sessionId: string;
  triggerIndex?: TriggerIndex;
}
```

After the brain search section and before surface scoring, add trigger evaluation:

```typescript
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

  // Add triggered memories to salience items (they outrank brain similarity)
  for (const match of triggerMatches) {
    salienceItems.push({
      text: `- [trigger: ${match.trigger.trigger_type}] ${match.memory.title}: ${match.memory.statement.slice(0, 250)}`,
      score: match.memory.confidence.score + 0.1, // boost triggered memories
      source: 'trigger',
    });
  }
```

Update the return values to include `triggerCount`:

```typescript
    triggerCount: triggerMatches.length,
```

(Replace the existing `triggerCount: 0` in both return statements.)

- [ ] **Step 3: Initialize trigger index in loop.ts**

In `src/agent/loop.ts`, add the import:

```typescript
import { TriggerIndex } from './trigger-index.js';
import { MemoryObjectStore } from './memory-objects.js';
```

Add class fields:

```typescript
  private triggerIndex: TriggerIndex;
  private memoryStore: MemoryObjectStore;
```

In the constructor, after `this.eventLedger` initialization:

```typescript
    const brainDir = join(this.workspacePath, '..', 'brain');
    this.memoryStore = new MemoryObjectStore(brainDir);
    this.triggerIndex = new TriggerIndex();
    this.triggerIndex.loadFrom(this.memoryStore);
```

Then pass the trigger index to `assembleContext`:

```typescript
        const assembly = await assembleContext(
          userText,
          chatId,
          recentTurns,
          {
            workspacePath: this.workspacePath,
            brainDir: join(this.workspacePath, '..', 'brain'),
            enginePort: this.toolContext.enginePort,
            sessionId: chatId,
            triggerIndex: this.triggerIndex,
          },
          this.eventLedger,
        );
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit 2>&1; echo "EXIT: $?"`
Expected: EXIT: 0

- [ ] **Step 5: Commit**

```bash
git add src/agent/trigger-index.ts src/agent/context-assembly.ts src/agent/loop.ts
git commit -m "feat(step20): Phase 5 complete — trigger index with keyword/temporal/domain matching + audit events"
```

---

## Phase 6: Curator Cycle

---

### Task 14: Add curator role to engine config

**Files:**
- Modify: `configs/base-engine.yaml`

- [ ] **Step 1: Add curator to initialRoles**

In `configs/base-engine.yaml`, find the `initialRoles` list (around line 35). Add the curator role after the existing `critic` role:

```yaml
      - id: curator
        prompt: "You are the memory curator for a persistent AI agent. Review the latest brain insights and working memory objects. For each, decide: Is this operationally important? Should it be promoted to a domain surface (TOPOLOGY, PROJECTS, PERSONAL, DOCTRINE, RECENT)? Write a brief, load-bearing summary for any surface updates. Skip anything that is just restating known information. Focus on: what changed, what's new, what the agent needs to know to be ready."
        promptGuided: "Curate memory for {domain}. Review recent brain insights about {context}. What is load-bearing? What should the agent know?"
        temperature: 0.3
        max_completion_tokens: 1000
        successThreshold: 0.5
        enableMCPTools: false
```

Note the lower temperature (0.3) — the curator should be precise, not creative.

- [ ] **Step 2: Update maxRoles**

Change `maxRoles: 4` to `maxRoles: 5` to accommodate the new curator role.

- [ ] **Step 3: Commit**

```bash
git add configs/base-engine.yaml
git commit -m "feat(step20): add curator role to engine cognitive cycle config"
```

---

### Task 15: Build the curator cycle module

**Files:**
- Create: `engine/src/core/curator-cycle.js`

- [ ] **Step 1: Create curator-cycle.js**

```javascript
/**
 * Home23 — Curator Cycle (Step 20)
 *
 * Runs as part of the engine's cognitive cycle (alongside analyst, critic, curiosity).
 * Responsibilities:
 *   1. Brain-node intake governance (filter, rate-limit, dedup)
 *   2. Surface rewriting (compress, prioritize, drop stale)
 *   3. Usage-based decay (flag zero-reuse durable memories)
 *   4. Continuity gap detection (read event ledger)
 *
 * This module provides utility functions called from the orchestrator
 * when the curator role is active.
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────
const MAX_NODES_PER_CYCLE = 50;
const MIN_NODE_LENGTH = 100;
const ELIGIBLE_TAGS = ['analysis_insight', 'critic_insight', 'curiosity_insight', 'operational', 'insight', 'agent_finding'];
const SURFACE_BUDGETS = {
  'TOPOLOGY.md': 2500,
  'PROJECTS.md': 3000,
  'PERSONAL.md': 2500,
  'DOCTRINE.md': 2500,
  'RECENT.md': 3000,
};

/**
 * Filter brain nodes eligible for curator consideration.
 * @param {Array} nodes - Recent brain nodes
 * @param {Array} existingObjects - Current working MemoryObjects (for dedup)
 * @returns {Array} Eligible nodes, rate-limited
 */
function filterEligibleNodes(nodes, existingObjects = []) {
  const eligible = nodes.filter(node => {
    // Minimum content length
    if (!node.content || node.content.length < MIN_NODE_LENGTH) return false;

    // Tag filter
    const tag = (node.tag || node.role || '').toLowerCase();
    if (!ELIGIBLE_TAGS.some(t => tag.includes(t))) return false;

    // Skip pure self-referential nodes
    if (node.content.match(/^home23.*(is|seems|appears).*(interesting|notable|significant)/i)) return false;

    return true;
  });

  // Rate limit
  return eligible.slice(0, MAX_NODES_PER_CYCLE);
}

/**
 * Check if a surface needs updating based on working memory objects.
 * @param {string} surfacePath - Path to the surface markdown file
 * @param {Array} relevantObjects - MemoryObjects relevant to this surface's domain
 * @param {number} budget - Character budget for this surface
 * @returns {{ needsUpdate: boolean, suggestions: string[] }}
 */
function checkSurfaceFreshness(surfacePath, relevantObjects, budget) {
  if (!fs.existsSync(surfacePath)) {
    return { needsUpdate: relevantObjects.length > 0, suggestions: relevantObjects.map(o => o.statement) };
  }

  const content = fs.readFileSync(surfacePath, 'utf-8');

  // Check if any working objects mention things not in the surface
  const suggestions = [];
  for (const obj of relevantObjects) {
    // Simple check: is the title or key terms mentioned in the surface?
    const terms = obj.title.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const inSurface = terms.some(t => content.toLowerCase().includes(t));
    if (!inSurface) {
      suggestions.push(obj.statement);
    }
  }

  return {
    needsUpdate: suggestions.length > 0,
    suggestions,
  };
}

/**
 * Read the event ledger and detect continuity gaps.
 * @param {string} ledgerPath - Path to event-ledger.jsonl
 * @returns {{ gaps: string[] }} List of detected gap descriptions
 */
function detectContinuityGaps(ledgerPath) {
  const gaps = [];

  if (!fs.existsSync(ledgerPath)) {
    gaps.push('No event ledger found — continuity tracking not active');
    return { gaps };
  }

  try {
    const events = fs.readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    // Check for sessions without CheckpointLoaded
    const sessions = new Map();
    for (const e of events) {
      if (!sessions.has(e.session_id)) sessions.set(e.session_id, new Set());
      sessions.get(e.session_id).add(e.event_type);
    }

    for (const [sessionId, types] of sessions) {
      if (types.has('SessionStarted') && !types.has('CheckpointLoaded')) {
        gaps.push(`Session ${sessionId}: started without loading checkpoint`);
      }
      if (types.has('RetrievalDegraded')) {
        gaps.push(`Session ${sessionId}: operated in degraded mode`);
      }
    }

    // Check for zero-reuse durable memories (from MemoryReactivated events)
    // This is tracked on the MemoryObject itself, not computed here

  } catch (err) {
    gaps.push(`Failed to read event ledger: ${err.message}`);
  }

  return { gaps };
}

/**
 * Get behavioral audit metrics from the event ledger.
 * @param {string} ledgerPath
 * @returns {Object} Metrics summary
 */
function computeAuditMetrics(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { error: 'No ledger' };

  try {
    const events = fs.readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    const counts = {};
    for (const e of events) {
      counts[e.event_type] = (counts[e.event_type] || 0) + 1;
    }

    const reactivated = counts['MemoryReactivated'] || 0;
    const actedOn = counts['MemoryActedOn'] || 0;
    const degraded = counts['RetrievalDegraded'] || 0;
    const breakdowns = counts['BreakdownDiagnosed'] || 0;
    const triggersFired = counts['TriggerFired'] || 0;
    const triggersAccepted = counts['TriggerAccepted'] || 0;
    const triggersRejected = counts['TriggerRejected'] || 0;

    return {
      total_events: events.length,
      reactivation_count: reactivated,
      acted_on_count: actedOn,
      acted_on_rate: reactivated > 0 ? (actedOn / reactivated).toFixed(2) : 'N/A',
      degraded_sessions: degraded,
      breakdowns: breakdowns,
      trigger_precision: triggersFired > 0 ? (triggersAccepted / triggersFired).toFixed(2) : 'N/A',
      trigger_nuisance_rate: triggersFired > 0 ? (triggersRejected / triggersFired).toFixed(2) : 'N/A',
    };
  } catch {
    return { error: 'Failed to compute' };
  }
}

module.exports = {
  filterEligibleNodes,
  checkSurfaceFreshness,
  detectContinuityGaps,
  computeAuditMetrics,
  SURFACE_BUDGETS,
  MAX_NODES_PER_CYCLE,
  ELIGIBLE_TAGS,
};
```

- [ ] **Step 2: Commit**

```bash
git add engine/src/core/curator-cycle.js configs/base-engine.yaml
git commit -m "feat(step20): Phase 6 — curator cycle module + engine role config"
```

---

### Task 16: Final build, restart, and end-to-end verification

- [ ] **Step 1: Full build**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc 2>&1; echo "EXIT: $?"
```
Expected: EXIT: 0

- [ ] **Step 2: Restart harness and engine**

```bash
pm2 restart home23-jerry-harness
pm2 restart home23-jerry
```

- [ ] **Step 3: Verify assembly layer works**

Send via Telegram: "what port is the published docs server on?"

Expected: Agent answers correctly from TOPOLOGY surface without having to search the brain tool.

Check logs:
```bash
pm2 logs home23-jerry-harness --lines 20 --nostream
```

Look for: `[agent] Situational awareness: N brain cues, M surfaces (TOPOLOGY, RECENT, ...)`

- [ ] **Step 4: Verify promote_to_memory works**

Send via Telegram: "Remember that we now have adaptive debounce on Telegram — short messages wait longer, long messages fire fast."

Agent should use `promote_to_memory`. Verify:
```bash
cat instances/jerry/brain/memory-objects.json | python3 -m json.tool | head -30
```

- [ ] **Step 5: Verify event ledger captures events**

```bash
cat instances/jerry/brain/event-ledger.jsonl | tail -10
```

Expected: `SessionStarted`, `RetrievalExecuted`, and possibly `TriggerFired` events.

- [ ] **Step 6: Verify degraded mode**

If the engine process is not running (or stop it temporarily), send a message and verify logs show:
`[agent] Situational awareness: DEGRADED — brain unreachable`

- [ ] **Step 7: Commit design docs and plan**

```bash
git add docs/design/STEP20-SITUATIONAL-AWARENESS-ENGINE-DESIGN.md docs/design/STEP20-SITUATIONAL-AWARENESS-PLAN.md
git commit -m "docs: Step 20 — Situational Awareness Engine design spec + implementation plan"
```

- [ ] **Step 8: Final commit summarizing all Phase work**

```bash
git log --oneline -15
```

Verify all Phase 1-6 commits are present. If any files are uncommitted:

```bash
git add -A && git status
git commit -m "feat(step20): Situational Awareness Engine — all 6 phases complete"
```

---

## The Continuity Proof Test

After all tasks are complete, run this test:

1. **Evening session via dashboard chat:** Establish something new — "Let's put the API reference docs on port 9191"
2. **Verify promotion:** Check `memory-objects.json` for a new MemoryObject with state_delta showing the before/after
3. **Verify event ledger:** Check `event-ledger.jsonl` for `StateDeltaRecorded` or `MemoryCandidateCreated`
4. **Wait.** Let the curator cycle run (or trigger it manually by restarting the engine).
5. **Next morning via Telegram:** Ask "where are the API reference docs?"
6. **Expected:** Agent answers "Port 9191" immediately from brain cues or TOPOLOGY surface. No searching. No blank stare.
7. **Verify event chain:** Check `event-ledger.jsonl` for `SessionStarted` → `RetrievalExecuted` → `MemoryReactivated`

That chain — from establishment through sleep through reactivation — is the proof that Home23 achieved real continuity.

---

## Summary: What Gets Built

| Phase | Tasks | Key deliverable |
|-------|-------|----------------|
| 1 | Tasks 1-6 | Assembly layer + domain surfaces + degraded mode |
| 2 | Tasks 7-9 | Memory object model + promote tool + problem threads |
| 3 | Tasks 10-11 | Event ledger wired into assembly + loop |
| 4 | Task 12 | Structured extraction pipeline |
| 5 | Task 13 | Trigger index + audit events |
| 6 | Tasks 14-16 | Curator cycle + final integration |

16 tasks. ~20 files. 6 phases. Each phase delivers standalone value.
