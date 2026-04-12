# Step 20: Situational Awareness Engine

## The Problem

Home23 has a 21,048-node brain, 44,649 edges, 1,468 cognitive cycles of autonomous thinking — and the agent didn't know what port 8090 was.

The information existed. The brain had already diagnosed the exact failure pattern. The brain had already coined the solution concept ("reactivation cues"). But none of it made it into the agent's context window before the agent answered.

**Recovery is not continuity.** The agent can dig up facts after it fails. What it can't do is show up already knowing what it needs to know.

The root cause: the agent is reassembled from scratch every turn using the same static identity files regardless of what's being asked. The brain is passive — it has to be explicitly queried. Important knowledge from conversations stays buried in chat history. There is no bridge between data existing and knowledge being active.

### What the brain itself said

From autonomous thinking cycles:

> "The critical vulnerability is contextual amnesia — not forgetting facts, but failing to preserve causal granularity, temporal inertia, and applicability conditions that render knowledge operational."

> "The core challenge is not storing more agent knowledge, but designing reliable reactivation cues so the living brain can recover the right self-state at the right time."

> "Home23's agents rely on seamless memory continuity — but without explicit retrieval cues, the system may lose critical context as data accumulates."

The brain diagnosed itself. This design builds what it asked for.

### What external analysis confirmed

From deep research (GPT-5.4 brain analysis, 2026-04-12):

> "The persistent unit of value is not the document. It is the changed problem-state."

> "Persist what changes the future, not what merely survived the past."

> "Storage is cheap; governed reactivation is the actual hard problem."

> "A persisted thing without provenance, confidence, review-state, and reuse path is just durable residue, not memory."

## Design Principle

> **Home23 should be designed as a system that persistently carries forward changes in understanding — not a warehouse for artifacts.**

Memory is real only when it can answer: what changed, why it changed, what evidence grounded it, how certain it was, where it applies, when it should come back, and what happened downstream.

---

## Architecture Overview

Six interlocking components:

1. **Context Assembly Layer** — pre-turn intelligence that queries the brain and loads the right knowledge before the LLM call
2. **Memory Object Model** — structured, typed, governed knowledge objects with state deltas and trigger conditions
3. **Problem Threads** — the anchor for all memory; evolving questions that persist across sessions
4. **Promotion Pipeline** — three-layer promotion (raw → working → durable) with hard gates
5. **Event Ledger** — immutable proof chain that continuity actually happened
6. **Curator Cycle** — engine cycle that maintains domain surfaces and evaluates promotion gates

### The loop (closed):

```
Brain thinks autonomously → nodes accumulate
Conversation happens → promotion pipeline creates MemoryObjects with state_deltas
Curator cycle fires → evaluates promotion gates, maintains domain surfaces
Next message arrives → assembly layer queries brain + checks triggers + loads surfaces
Agent responds with situational awareness → conversation continues
Session ends → checkpoint saved → event ledger records the chain
Later session → checkpoint loaded → prior memory reactivated → continuity proven
```

---

## 1. Context Assembly Layer

**New module:** `src/agent/context-assembly.ts`

**Called from:** `loop.ts`, right where the system prompt gets built today (replacing the current `semanticRecall` call and hardcoded situational checks).

**What it does on every turn:**

1. **Receive:** userText, chatId, last 3-5 conversation turns
2. **Brain similarity search:** POST to `/api/memory/search` with userText + recent turn context → returns top-N brain nodes with scores, tags, content
3. **Trigger evaluation:** scan durable MemoryObjects for trigger condition matches against the current message + conversation state (see Trigger-Based Retrieval below)
4. **Surface scoring:** for each domain surface, check if returned brain nodes or triggered memories relate to that domain → load relevant surfaces
5. **Assemble:** combine brain cues + triggered memories + loaded surfaces into a `[SITUATIONAL AWARENESS]` block
6. **Emit events:** `SessionStarted` (first turn), `CheckpointLoaded` (if prior checkpoint exists), `RetrievalExecuted` (what was found/discarded)
7. **Return:** the block for injection into the system prompt

**Latency budget:** Brain search endpoint: ~50-100ms. Trigger index scan: ~10ms. Surface file reads: negligible. Total: under 200ms. Replaces the current `semanticRecall` which shells out to Python FAISS with a 500ms timeout — faster while doing more.

**Failure mode:** If brain unreachable or slow, returns nothing. Turn proceeds with static identity files only — exactly how it works today. Never blocks the agent.

**Context budget:** The assembled `[SITUATIONAL AWARENESS]` block has a hard character limit of **6000 chars**. When brain cues + triggered memories + surfaces exceed this, the assembly layer applies salience ranking: triggered memories outrank brain similarity results, higher-confidence items outrank lower, more recent outranks older. Items that don't fit get dropped, not truncated. This prevents the block from bloating as durable memories accumulate — salience control, not unbounded accumulation.

**Resume verification:** After loading checkpoint + surfaces + triggered memories, the assembly layer runs a lightweight verification pass before injection:
- For `TOPOLOGY.md` entries referencing ports/services: tag entries older than 24 hours as `[UNVERIFIED]` unless the curator has refreshed them
- For checkpoint entries: if `context_age` exceeds the checkpoint's `staleness_policy`, flag as `[STALE — verify before acting]` or drop
- For `RECENT.md`: entries older than 48 hours automatically drop from the assembly (they may still exist in the surface for curator reference)
- For triggered memories with `staleness_policy.review_after_days` exceeded: tag `[REVIEW DUE]`

This prevents the most dangerous failure mode: confidently injecting stale context. The brain analysis warns: "stale emotional interpretations masquerade as continuity." The risk is not that the brain is down — it's that the brain is up and returning confidently outdated information. The assembly layer must distinguish between "I found relevant context" and "I found relevant context I can verify is still current."

**What the agent sees:**

```
[SOUL] ... (unchanged)
[MISSION] ... (unchanged)
[HEARTBEAT] ... (unchanged)
[SITUATIONAL AWARENESS]

Brain cues:
- Publication architecture changed from multi-surface to dedicated 8090 server
  because existing dashboard/runtime surfaces were too ambiguous.
  Applies to: all generated docs. Convention established 2026-04-11.
- Agent migration documents published at http://100.72.171.58:8090/
  Canonical shared surface. INDEX.md is source of truth.

Triggered memories:
- [trigger: ops/topology domain entered] House topology loaded
- [trigger: first turn of new session] Recent digest loaded

Relevant context (TOPOLOGY):
  Port 5001: engine WS | 5002: dashboard | 8090: published docs | 3415: evobrew...

Relevant context (RECENT):
  2026-04-12: Shipped adaptive debounce + queue-during-run for Telegram
  2026-04-11 evening: Created published docs server on 8090

[/SITUATIONAL AWARENESS]
[CONTEXT] ... (unchanged)
```

### Trigger-Based Retrieval

The assembly layer has two retrieval paths:

**Path 1 — Embedding similarity (brain search):** Finds "what text looks related." Uses the existing `/api/memory/search` endpoint with cosine similarity over brain embeddings.

**Path 2 — Trigger condition matching:** Finds "what was designed to reappear here." Scans durable MemoryObjects for matching trigger conditions.

Trigger types:

| Type | Example | Matches when |
|------|---------|-------------|
| `keyword` | `"published docs OR 8090"` | Terms appear in message |
| `workflow_stage` | `"asking about house topology"` | Domain classifier detects the stage |
| `temporal` | `"first turn of new session"` | Session boundary detected |
| `domain_entry` | `"conversation enters personal domain"` | Brain cues indicate domain shift |
| `recurrence` | `"similar question asked without resolution"` | Pattern matches prior unresolved thread |

Trigger index lives in `instances/<agent>/brain/trigger-index.json`. Loaded once on startup, checked per-turn. Fast — structured condition evaluation, not embedding math.

**What replaces:**
- `semanticRecall` in `memory.ts` — superseded by brain-driven retrieval + triggers
- Hardcoded evobrew situational check in `loop.ts` — becomes a surface/trigger
- Static loading of `MEMORY.md` as catch-all — domain surfaces take over

---

## 2. Memory Object Model

### Three memory layers

| Layer | What lives here | TTL | Governed? |
|-------|----------------|-----|-----------|
| **Raw trace** | Conversation transcripts, tool outputs, retrieval logs, runtime events | Hours to days, unless referenced | No — cheap capture, substrate |
| **Working synthesis** | Candidate insights, uncertainties, hypotheses, in-progress state changes | Days to weeks, editable | Lightly — thread-attached, review pending |
| **Durable memory** | Promoted, reviewed, triggerable knowledge with full provenance | Weeks to permanent, versioned | Fully — provenance, confidence, review state, triggers |

### MemoryObject envelope

Every object above raw trace carries:

```typescript
interface MemoryObject {
  memory_id: string;
  type: MemoryObjectType;
  thread_id: string;                    // anchor to ProblemThread
  session_id: string;
  lifecycle_layer: 'raw' | 'working' | 'durable';
  status: 'candidate' | 'approved' | 'challenged' | 'superseded' | 'expired' | 'rejected';

  // Content
  title: string;
  statement: string;
  summary?: string;

  // Temporal
  created_at: string;                   // ISO 8601
  updated_at: string;

  // Attribution
  actor: string;                        // 'agent' | 'curator' | 'user' | 'extraction'

  // Provenance
  provenance: {
    source_refs: string[];              // evidence/source IDs
    session_refs: string[];             // conversations this came from
    generation_method: string;          // 'conversation' | 'reflection_synthesis' | 'document_ingestion' | 'agent_promote' | 'curator'
  };

  // Evidence
  evidence: {
    evidence_links: string[];           // evidence object IDs
    grounding_strength: 'strong' | 'medium' | 'weak' | 'none';
    grounding_note?: string;
  };

  // Confidence
  confidence: {
    score: number;                      // 0-1
    basis: string;                      // why this confidence level
  };

  // The critical field — what changed
  state_delta: {
    delta_class: DeltaClass;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    why: string;
  };

  // Reactivation
  triggers: Array<{
    trigger_type: string;
    condition: string;
  }>;

  // Scope
  scope: {
    applies_to: string[];
    excludes: string[];
  };

  // Governance
  review_state: 'unreviewed' | 'self_reviewed' | 'peer_reviewed' | 'approved' | 'challenged' | 'rejected' | 'expired';

  // Lifecycle
  supersedes?: string[];               // memory_ids this replaces
  superseded_by?: string[];
  staleness_policy: {
    review_after_days?: number;
    expire_after_days?: number;
  };

  // Sensitivity
  privacy_class?: 'internal' | 'personal' | 'sensitive';
}

  // Reuse tracking
  reuse_count: number;                   // incremented on each MemoryReactivated event
  last_reactivated?: string;             // ISO 8601 — last time this was surfaced in context
  last_acted_on?: string;                // ISO 8601 — last time this influenced a response
}

type MemoryObjectType =
  | 'observation'            // what was noticed
  | 'evidence_link'          // exact grounding
  | 'insight'                // interpretive movement with state_delta
  | 'uncertainty_item'       // explicit unresolved things
  | 'procedure'              // reusable know-how: playbooks, workflows, recovery steps
  | 'correction'             // explicit error correction with before/after
  | 'breakdown_diagnostic'   // what broke, what assumption failed, what guardrail emerges
  | 'hypothesis'             // proposition under test (future)
  | 'recommendation_state'   // go/no-go/defer/blocked (future)
  | 'checkpoint'             // resumable continuity state
  | 'handoff_receipt';       // proof of downstream consumption

type DeltaClass =
  | 'belief_change'
  | 'priority_change'
  | 'scope_change'
  | 'recommendation_change'
  | 'uncertainty_change'     // includes uncertainty_increased
  | 'action_change'
  | 'measurement_model_change'
  | 'no_change';             // explicitly: nothing moved, and that's legitimate
```

### No-change as first-class state

The system allows and respects these valid states:

- `no_evidence_found` — searched, came up empty, that matters
- `no_state_change` — investigated, nothing shifted, record it so we don't re-investigate
- `uncertainty_increased` — we know less than before, that's real
- `candidate_rejected` — considered for promotion, failed a gate, recorded why
- `retrieval_returned_irrelevant` — brain queried, results didn't apply

Without these, the agent fabricates movement to look productive. Every system that only rewards "something changed" trains its agents to invent change. Home23 rewards honest epistemic accounting.

### Memory object types (v1)

**observation** — what was noticed. Additional: `observation_text`, `source_locator`, `observed_at`

**evidence_link** — exact grounding. Additional: `source_id`, `locator`, `excerpt`, `extraction_method`

**insight** — interpretive movement. Additional: `claim`, `mechanism`, `implication`. Must have state_delta.

**uncertainty_item** — explicit unresolved things. Additional: `unresolved_question`, `blocker`, `evidence_needed`, `review_trigger`. Essential — prevents faking certainty.

**checkpoint** — resumable continuity state. Additional: `goal`, `current_subtask`, `pending_actions[]`, `relevant_entities[]`, `wake_condition`, `resume_priority`. **Working-layer quality floor:** Even at working layer, checkpoints MUST have non-empty `goal`, `confidence.score > 0`, and at least one `provenance.session_ref`. A checkpoint the agent can't trust is worse than no checkpoint — it creates false confidence in resumed state. The promotion gates protect durable layer, but checkpoints specifically need quality enforcement at working layer too.

**handoff_receipt** — proof of downstream consumption. Additional: `recipient`, `contract_id`, `sent_at`, `received_at`, `receipt_status`, `consumption_status`

**procedure** — reusable know-how. Additional: `steps[]`, `preconditions`, `postconditions`, `last_verified`. Procedures don't start "raw" and get promoted — they're recognized as procedures from the start and enter at `working` layer with a clear verification path. Examples: "how to restart the engine process," "how to publish docs to the 8090 server," "how to run a COSMO research session." The brain analysis identifies this as one of four fundamental memory classes (alongside durable, provisional, and episodic). Without it, the agent rediscovers operational patterns every session.

**correction** — explicit error correction. Additional: `original_claim`, `corrected_claim`, `correction_source`, `impact_scope`. When the agent gets corrected ("no, that's port 8090 not 8080"), the correction itself becomes a first-class MemoryObject with a state_delta showing before/after. Corrections are a priority extraction target in the promotion pipeline. The brain analysis warns: "If you don't log corrections as durable memory, the agent repeats old mistakes with increasing confidence." Institutionalized error is the darkest failure mode of persistence.

**breakdown_diagnostic** — what broke and what emerged. Additional: `failed_assumption`, `exposed_dependency`, `proposed_guardrail`, `incident_context`. When something goes wrong — brain returns stale results, a trigger misfires, a surface is loaded but irrelevant, a process crashes — the system emits a structured diagnostic memory. Not an exception to ignore. A revelation. The brain analysis: "When the tool breaks, the hidden structure becomes visible." Every critical failure should produce: what assumption broke, what hidden dependency was exposed, what new guardrail becomes permanent.

**hypothesis** and **recommendation_state** — defined in schema, implemented in a future phase.

---

## 3. Problem Threads

The anchor for all memory. Without threads, memory is a junk drawer.

```typescript
interface ProblemThread {
  thread_id: string;
  title: string;
  question: string;                      // the evolving question this tracks
  objective: string;
  level: 'constitutional' | 'strategic' | 'tactical' | 'immediate';
  status: 'open' | 'progressing' | 'blocked' | 'resolved' | 'archived';
  priority: 'high' | 'medium' | 'low';
  owner: string;
  parent_thread?: string;                // thread_id of parent in goal hierarchy
  child_threads: string[];               // thread_ids of children
  opened_at: string;
  closed_at?: string;
  current_state_summary: string;         // curator maintains this
  success_criteria: string[];
  related_threads: string[];             // thread_ids (lateral, non-hierarchical)
  context_boundaries: {
    applies_to: string[];
    does_not_apply_to: string[];
  };
  version: number;
}
```

**Goal hierarchy:** Threads form a tree from constitutional (identity-level: "Home23 is an AI OS with real continuity") through strategic ("ship Home23 as a product") through tactical ("build the situational awareness engine") to immediate ("fix port 8090 recall"). `parent_thread` and `child_threads` encode the hierarchy. The curator uses this to inherit context: when a tactical thread is active, its strategic parent's context is implicitly relevant. This prevents the flat-thread problem where "how should Telegram work" and "ship Home23" have no structural relationship.

**Design rule:** Every promotable MemoryObject must belong to exactly one primary ProblemThread, even if it links to others. That one rule prevents clutter.

**Examples of threads:**
- Constitutional: "Home23 is a persistent AI operating system" — identity-level, never closes
- Strategic: "Ship Home23 as a product" — long-term goal
- Tactical: "Build the situational awareness engine" — project thread
- Immediate: "How should Home23 publish docs?" — the 8090 topology thread
- Immediate: "What's jtr's health and wellness situation?" — personal continuity thread

**Thread lifecycle:** Threads are created by the promotion pipeline (when an extraction doesn't fit an existing thread), by the agent via `promote_to_memory`, or by the curator when it detects a recurring theme in brain nodes. Threads are resolved when success criteria are met, archived when stale.

---

## 4. Promotion Pipeline

### Three promotion paths

**Path A — Session-end extraction (upgrade existing `extractAndSave`)**

Current: fires on session gap, produces generic bullets into daily file + MEMORY.md.

Upgraded:
- Extraction prompt asks the model to identify structured MemoryObjects: what changed (state_delta), what's uncertain, what convention was established, what should come back later (triggers)
- Each extraction becomes a MemoryObject with `lifecycle_layer: 'working'`, attached to a ProblemThread
- State deltas are explicit — before/after/why
- Trigger conditions are explicit
- Classified by domain for surface placement

**Path B — Mid-conversation promotion (new tool: `promote_to_memory`)**

Agent calls this when it recognizes something load-bearing: new convention, important personal context, topology change, key decision. Creates a MemoryObject with `lifecycle_layer: 'working'` and appropriate domain/thread/triggers. Emits `MemoryCandidateCreated` event.

**Path C — Curator cycle promotion (working → durable)**

The curator evaluates working MemoryObjects against hard gates for durable promotion.

### Hard promotion gates

| # | Gate | Requirement | Rationale |
|---|------|-------------|-----------|
| 1 | **Thread anchoring** | Must belong to a ProblemThread | Prevents orphan notes |
| 2 | **Epistemic movement** | Must represent a real state change: reduced uncertainty, changed belief, changed priority, discovered stable rule, or explicitly `no_change` | Rejects paraphrases of already-known things |
| 3 | **Provenance** | Must have at least one: source evidence, runtime trace, linked prior object, grounded excerpt | "Because the assistant said so" is not provenance |
| 4 | **Reactivation path** | Must answer: when should this come back? What pattern wakes it up? | No trigger = not durable memory, just residue |
| 5 | **Boundary clarity** | Must define where it applies, where it doesn't, validity horizon | Prevents context leakage across domains |
| 6 | **Confidence + review** | Must have confidence score with basis and review state | Ungoverned confidence is not trustworthy |
| 7 | **Dedup / merge** | Check for existing equivalent. Merge, supersede, challenge, or reject | Never let durable memory fork silently |
| 8 | **Demonstrated relevance** | For promotion from working → durable, prefer objects that have been reactivated, cited, or reused at least once | Prevents promoting things that passed structural gates but were never actually useful |

### What never gets promoted

- Unsupported summaries
- Decontextualized preferences
- One-off rhetorical flourishes
- High-confidence statements with no evidence
- Unresolved contradictions disguised as conclusions
- Session artifacts created only to satisfy a metric

### Challenge and decay

Durable memory is never silently overwritten:

- Contradiction → `challenged` event, not silent overwrite
- Stronger replacement → `supersedes` relation
- Stale context → `expired`
- Loss of applicability → `archived`
- Invalid grounding → `rejected`

Memory is an evolving epistemic structure, not a constantly rewritten wiki.

### Usage-based decay

Time-based staleness (`review_after_days`, `expire_after_days`) is necessary but insufficient. The curator also tracks usage-based signals via `reuse_count` and `last_reactivated` on each MemoryObject:

- A durable memory created yesterday but never reactivated should decay faster than one created 6 months ago that fires weekly
- The curator's surface-rewriting pass weights entries by reuse frequency — frequently reactivated entries get priority for limited surface budgets
- Durable memories with `reuse_count: 0` after 30 days get flagged for review — they passed all structural gates but were never actually useful, suggesting the triggers are wrong or the knowledge isn't load-bearing
- The event ledger's `MemoryReactivated` events are the source of truth for reuse tracking

---

## 5. Event Ledger

**Immutable, append-only log proving continuity actually happened.**

**Location:** `instances/<agent>/brain/event-ledger.jsonl`

### Event envelope

```typescript
interface EventEnvelope {
  event_id: string;
  event_type: string;
  thread_id?: string;
  session_id: string;
  object_id?: string;                   // MemoryObject if applicable
  timestamp: string;
  actor: string;
  invocation_id?: string;               // prevents double-counting on retries
  retry_of?: string;
  payload: Record<string, unknown>;
}
```

### Seven stages proving continuity

| Stage | Event(s) | What it proves | Emitted by |
|-------|----------|---------------|------------|
| 1. Session start | `SessionStarted` | A cognitive episode began | Assembly layer |
| 2. Prior state loading | `CheckpointLoaded` | System loaded prior context. **If this didn't happen, continuity didn't happen.** | Assembly layer |
| 3. Retrieval + grounding | `RetrievalExecuted`, `EvidenceLinked` | New work was grounded in existing knowledge, not invented | Assembly layer, agent loop |
| 4. Epistemic movement | `StateDeltaRecorded`, `UncertaintyRecorded` | Something actually changed — or explicitly didn't | Promotion pipeline, promote tool |
| 5. Persistence decision | `MemoryCandidateCreated`, `MemoryPromoted`, `MemoryRejected`, `MemoryChallenged` | Governed memory creation, not residue | Promotion pipeline, curator |
| 6. Checkpoint save | `CheckpointSaved` | Resumable state persisted | Session end handler |
| 7. Reactivation + downstream | `MemoryReactivated`, `MemoryActedOn`, `HandoffReceived`, `OutcomeObserved` | Memory came back later and made a difference | Assembly layer, agent/curator |
| 8. Breakdown diagnosis | `BreakdownDiagnosed` | A failure produced structured learning — what assumption broke, what guardrail emerges | Agent, curator, system monitors |

### The proof chain

Continuity is real when you can link:

```
SessionStarted → CheckpointLoaded → RetrievalExecuted → StateDeltaRecorded
→ CheckpointSaved → [later session] → MemoryReactivated → OutcomeObserved
```

If any link breaks, the curator can identify where continuity failed and surface the gap.

### The completion chain

"Created" is not "used." The event ledger distinguishes the full chain:

1. `MemoryReactivated` — memory was loaded into context (created → delivered)
2. `MemoryActedOn` — the agent's response demonstrably referenced or was shaped by the memory (delivered → understood → acted on). Emitted when the agent cites a reactivated memory or when response analysis shows influence.
3. `OutcomeObserved` — downstream impact observed: decision changed, duplicate work prevented, user didn't have to re-explain (acted on → reused)

The `reuse_count` and `last_acted_on` fields on MemoryObject are updated by these events. The curator reads these to evaluate whether durable memories are actually serving their purpose or just occupying space.

### Breakdown events

When the system fails — brain returns stale results, a trigger misfires, a surface is loaded but irrelevant, a process crashes — a `BreakdownDiagnosed` event fires and a `breakdown_diagnostic` MemoryObject is created:

```
BreakdownDiagnosed payload:
  failed_assumption: string        // what the system expected to be true
  exposed_dependency: string       // what hidden dependency was revealed
  proposed_guardrail: string       // what should become permanent
  incident_context: string         // what was happening when it broke
  severity: 'critical' | 'important' | 'minor'
```

The brain analysis: "When the tool breaks, the hidden structure becomes visible." Breakdowns are not exceptions to ignore — they are diagnostic events that feed back into the system's self-knowledge. The curator can promote recurring breakdown patterns into durable doctrine.

---

## 6. Curator Cycle

**Where it runs:** Inside the cognitive engine (`engine/src/index.js`), as a new cycle type alongside ANALYST, CRITIC, CURIOSITY, SLEEP.

### What it does

1. **Intakes** brain nodes through governed filtering (see Brain-Node Intake below)
2. **Reads** filtered brain nodes, raw extractions, working MemoryObjects, current domain surfaces, event ledger
3. **Evaluates** working MemoryObjects against hard promotion gates
4. **Promotes** objects that pass all gates to `lifecycle_layer: 'durable'`
5. **Rewrites** domain surfaces — compress, prioritize, drop stale. Not append — rewrite. Surfaces are living views, not logs
6. **Detects** continuity gaps from the event ledger (threads with missing checkpoints, reactivation failures)
7. **Surfaces** operationally important brain insights into the appropriate domain surface
8. **Reviews** durable memories with `reuse_count: 0` past their review horizon — flags or demotes

### Brain-node intake governance

The brain has 21,000+ nodes and grows every cycle. The curator cannot and should not process all of them. This is the highest-volume boundary in the system and it must be governed.

**Eligibility filter — what the curator considers:**
- Nodes created since the last curator cycle (recency window)
- Rate limit: max 50 nodes per curator cycle (prevents overwhelm)
- Minimum quality: node must have content length > 100 chars (filters noise fragments)
- Tag filter: nodes tagged `analysis_insight`, `critic_insight`, `curiosity_insight`, or `operational` are eligible; `sleep`, `dream`, pure-creative nodes are not
- Dedup: if a node's content is >90% similar (embedding cosine) to an existing working MemoryObject, skip it

**Disqualification — what the curator ignores:**
- Nodes that are purely self-referential ("Home23 is interesting because...") without operational content
- Nodes that restate without adding — paraphrases of existing durable memories
- Nodes below a confidence/grounding threshold set in `base-engine.yaml`

**Processing budget:** If eligible nodes exceed the rate limit, the curator ranks by: (1) operational relevance (tagged `operational`), (2) convergence (similar content appearing in multiple recent nodes = stronger signal), (3) recency. Top-N get processed, rest wait for next cycle.

**What crosses the boundary:** Eligible brain nodes become working MemoryObjects with `generation_method: 'reflection_synthesis'`. They enter the normal promotion pipeline from there. The brain never directly writes durable memory — it always goes through the curator's gates.

### Cycle parameters

- **Frequency:** Every 30-60 minutes, or triggered after session end
- **Surface budgets:** Each surface has a character limit (2000-3000 chars). Curator enforces it by compressing older entries and dropping stale ones
- **Judgment prompt:** "Write what the agent needs to know to be ready. Not what's interesting — what's load-bearing."

### Domain surfaces (curator-maintained views)

| Surface | Content | Character budget |
|---------|---------|-----------------|
| `TOPOLOGY.md` | Active ports, services, publication surfaces, runtime dirs. The house map. | 2500 |
| `PROJECTS.md` | What's in flight, what was decided, what's next. Active work state. | 3000 |
| `PERSONAL.md` | Ongoing threads about the owner — health, family, finances, interests. The relational layer. Only stores what was shared, doesn't infer. | 2500 |
| `DOCTRINE.md` | How we work together. Conventions, preferences, communication style. **Also: boundaries, operating constraints, approval gates, known non-negotiables, routing rules.** The brain analysis identifies boundaries as a distinct identity concern — not decorative metadata but behavioral control surfaces. | 2500 |
| `RECENT.md` | Last 24-48 hours digest. What happened, what changed, what was established. | 3000 |

Surfaces are loaded selectively by the assembly layer based on brain relevance and trigger matches. `RECENT.md` gets a permanent relevance boost — recency always matters.

---

## 7. Files Changed / Created

### Harness layer (TypeScript, `src/`)

| File | Action | Purpose |
|------|--------|---------|
| `src/agent/context-assembly.ts` | **Create** | Assembly layer — brain query + trigger matching + surface loading |
| `src/agent/memory-objects.ts` | **Create** | MemoryObject, ProblemThread, EventEnvelope types + read/write |
| `src/agent/trigger-index.ts` | **Create** | Trigger index — load durable triggers, evaluate against inbound |
| `src/agent/event-ledger.ts` | **Create** | Append-only event ledger — write events, read for audit |
| `src/agent/memory.ts` | **Modify** | Upgrade `extractAndSave` to produce structured MemoryObjects; remove `semanticRecall` |
| `src/agent/loop.ts` | **Modify** | Replace `semanticRecall` + hardcoded situational checks with `assembleContext()` call; emit session/retrieval events |
| `src/agent/context.ts` | **Minor modify** | Remove `MEMORY.md` from static identity load (domain surfaces replace it) |
| `src/agent/tools/promote.ts` | **Create** | `promote_to_memory` tool — mid-conversation promotion with state_delta |
| `src/agent/tools/index.ts` | **Modify** | Register promote tool |
| `src/types.ts` | **Modify** | Add MemoryObject, ProblemThread, EventEnvelope, curator config types |

### Engine layer (JavaScript, `engine/`)

| File | Action | Purpose |
|------|--------|---------|
| `engine/src/core/curator-cycle.js` | **Create** | Curator cycle — maintain surfaces, evaluate promotion gates, read ledger |
| `engine/src/index.js` | **Modify** | Register curator cycle alongside analyst/critic/curiosity |
| `configs/base-engine.yaml` | **Modify** | Add curator cycle config (frequency, surface budgets, promotion thresholds) |

### Instance data (per-agent, gitignored)

| File | Action | Purpose |
|------|--------|---------|
| `instances/<agent>/workspace/TOPOLOGY.md` | **Create** | Ops surface — curator-maintained |
| `instances/<agent>/workspace/PROJECTS.md` | **Create** | Project state surface |
| `instances/<agent>/workspace/PERSONAL.md` | **Create** | Personal/relational surface |
| `instances/<agent>/workspace/DOCTRINE.md` | **Create** | Working conventions surface |
| `instances/<agent>/workspace/RECENT.md` | **Create** | Last 24-48h digest |
| `instances/<agent>/brain/event-ledger.jsonl` | **Create** | Immutable event log |
| `instances/<agent>/brain/memory-objects.json` | **Create** | Working + durable MemoryObjects store |
| `instances/<agent>/brain/problem-threads.json` | **Create** | ProblemThread registry |
| `instances/<agent>/brain/trigger-index.json` | **Create** | Durable trigger conditions index |

---

## 8. Build Order

The system is interconnected but can be built incrementally, with each phase delivering standalone value:

### Phase 1: Assembly layer + surfaces (biggest bang)
- Create domain surface files (hand-seeded initially)
- Build `context-assembly.ts` with brain similarity search + context budget + salience ranking
- Include resume verification (stale tagging) from day one
- Wire into `loop.ts` replacing `semanticRecall`
- **Value:** Agent immediately starts showing up with relevant context, with staleness protection

### Phase 2: Memory object model + promote tool
- Build `memory-objects.ts` with types and storage (including `procedure`, `correction`, `breakdown_diagnostic` types)
- Build `promote_to_memory` tool
- Build `problem-threads.json` registry with goal hierarchy
- Include working-layer quality floor for checkpoints
- **Value:** Agent can capture important knowledge mid-conversation with structure

### Phase 3: Upgraded promotion pipeline
- Upgrade `extractAndSave` to produce structured MemoryObjects
- Domain-classify extractions into appropriate surfaces
- Corrections as priority extraction target
- **Value:** Session-end extraction becomes meaningful, not generic bullets

### Phase 4: Event ledger + completion chain
- Build `event-ledger.ts`
- Wire events into assembly layer, agent loop, promotion pipeline
- Include `MemoryActedOn` and `BreakdownDiagnosed` events from day one
- Wire reuse tracking (`reuse_count`, `last_reactivated`, `last_acted_on` updates)
- **Value:** Continuity becomes provable and auditable, with full completion chain

### Phase 5: Trigger index
- Build `trigger-index.ts`
- Wire trigger evaluation into assembly layer alongside brain search
- **Value:** Memories resurface by structural relevance, not just text similarity

### Phase 6: Curator cycle
- Build `curator-cycle.js` in engine
- Implement brain-node intake governance (eligibility filter, rate limits, dedup)
- Implement hard promotion gates (including gate 8: demonstrated relevance)
- Implement surface rewriting (compress, prioritize, drop stale, weight by reuse)
- Implement usage-based decay (flag zero-reuse durable memories)
- Wire ledger reading for continuity gap detection
- Compute behavioral audit metrics from event ledger
- **Value:** The loop closes — brain thinks, curator governs intake, surfaces stay current, agent knows

### The continuity proof test

After all phases:

1. Evening session: establish something new ("let's put API docs on port 9090")
2. Promotion captures it as a MemoryObject with state_delta, trigger, thread
3. Curator writes it to TOPOLOGY.md surface
4. Event ledger records: StateDeltaRecorded → MemoryPromoted → CheckpointSaved
5. Next morning, different channel: "where are the API docs?"
6. Assembly layer: brain search returns the node, trigger fires on ops/topology
7. TOPOLOGY.md loads with the entry
8. Agent answers immediately. No archaeology. No blank stare.
9. Event ledger records: CheckpointLoaded → RetrievalExecuted → MemoryReactivated

That chain — from establishment through sleep through reactivation — is the proof that Home23 achieved real continuity.

---

## 9. Behavioral Audit Metrics

The event ledger collects raw data. These metrics tell us if the system is actually working:

| Metric | Source | What it measures |
|--------|--------|-----------------|
| **Memory reactivation rate** | `MemoryReactivated` events / total durable memories | Are durable memories actually being surfaced? |
| **Acted-on rate** | `MemoryActedOn` / `MemoryReactivated` | Of memories loaded, how many influenced responses? |
| **Correct-resume rate** | Sessions where `CheckpointLoaded` led to no user re-explanation | Did resuming actually work? |
| **Stale-context error rate** | `BreakdownDiagnosed` with `failed_assumption` involving stale data | How often does the system inject outdated knowledge? |
| **Time-to-resume** | Time between `SessionStarted` and first substantive response | How fast does continuity kick in? |
| **Re-explanation rate** | User messages that repeat information already in durable memory | The ultimate failure metric — user had to tell the agent something it should have known |
| **Zero-reuse durable count** | Durable memories with `reuse_count: 0` past review horizon | How much durable memory is dead weight? |
| **Promotion gate rejection rate** | `MemoryRejected` / `MemoryCandidateCreated` | Are the gates too strict or too loose? |

The curator reads these periodically and can surface trends into `DOCTRINE.md` ("reactivation rate dropping — trigger conditions may be too narrow") or flag systemic issues.

V1 implementation: compute these from the event ledger on demand (curator cycle or manual query). V2: dashboard visualization.

---

## 10. What This Doesn't Do (Yet)

- **Hypothesis and recommendation_state types** — defined in schema, built when needed
- **Cross-surface deduplication** — curator uses judgment for v1, formal dedup later
- **Confidence scoring automation** — v1 uses curator judgment, formalized scoring later
- **Multi-agent shared memory** — each agent has its own memory objects; cross-agent sharing is a future design
- **The full canonical field dictionary** — the blueprint calls for a formal crosswalk dictionary for every field; v1 uses the TypeScript interfaces as the schema, formal dictionary comes with scale
- **Dashboard visualization of audit metrics** — event ledger is the data layer; UI comes in v2
- **Live environment verification** — the resume verification step tags stale entries but does not actively ping ports or verify service health; active verification is a future enhancement
- **Automated "same thread / new thread" classification** — v1 relies on the extraction prompt and curator to assign threads; automated thread-routing from inbound messages comes later
