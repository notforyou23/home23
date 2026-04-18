# Thinking Machine Cycle — Design Spec

**Date:** 2026-04-18
**Status:** revised post-review; pre-implementation; shaping with jtr
**Author:** claude + jtr
**Revision history:** v1 drafted and reviewed same day. Review surfaced six critical gaps and seven missing pieces; v2 owns them.

**Scope (honest).** This is a **restructuring** of the engine's cognitive cycle from a serial role-rotation loop to a multi-phase graph-driven pipeline. It is not a cycle-firing swap. It touches:

- `engine/src/core/orchestrator.js` — the main loop becomes multi-cadence (see *Orchestrator Concurrency Model* below)
- `engine/src/cognition/*` — 4+ new modules (discover, deep-dive, connect/PGS adapter, critique), integration with existing `dynamic-roles.js`, `thought-action-parser.js`, `critic-verdict-parser.js`
- `engine/src/core/curator-cycle.js` — explicit interaction with the new critique function (see *Integration with Existing Systems*)
- `engine/src/pulse/pulse-remarks.js` — small adaptation (pulse reads surfaces + role-tags today; contract preserved, role-tag semantics extended)
- New temporal substrate threaded through thought emission + LLM prompt context
- New conversation-salience sidecar pipeline (harness → engine, see *Conversation Salience Plumbing*)
- New agenda store + dashboard agenda surface (fruit layer)
- `configs/base-engine.yaml` — new sections, feature flag, deprecation path for `roleSystem.initialRoles`
- PGS extraction — probably its own sub-spec (see *PGS Extraction*)

**Leaves untouched.**

- Brain persistence (sidecars, snapshots, backups, high-water, fail-loud load)
- Feeder pipeline
- Sleep / dream phase (sleep enters sleep-mode from orchestrator; during sleep, new pipeline is paused; discovery daemon continues in low-priority mode for pure graph math — see *Sleep Interaction*)
- Consolidation, Watts-Strogatz rewiring, graph maintenance
- Channels, harness, dashboard chrome, settings, COSMO integration
- **Harness context-assembly for chat** (`src/agent/context-assembly.ts` — STEP20's surface-loading stays for chat; the new pipeline is engine-side only — see *STEP20 Integration*)
- Existing surface files (SOUL/MISSION/TOPOLOGY/PROJECTS/PERSONAL/DOCTRINE/RECENT) — kept populated because pulse and chat-context still read them; the new pipeline stops reading them at turn-start but doesn't delete them
- STEP11 Intelligence tab (fruit layer extends, doesn't replace — see *STEP11 Integration*)
- Live-problems remediation logic (ages are now fed from the temporal substrate; data flow change, not logic change)
- Closer-primitive `doneWhen` infrastructure (critique may optionally invoke `checkDoneWhen()` — see *Closer-Primitive Integration*)

**Honest scope shape.** Eight phases with architectural dependencies. Logically independent phases are architecturally coupled — Phase 3 (PGS + pipeline skeleton) blocks Phases 4-6. Build fast and right, fix fast. No calendar estimates; each phase ships when it passes its verification gate.

**Related specs.**

- `2026-04-17-jerry-closer-primitive-design.md` — completion mechanism for goals. That spec makes goals terminable; this spec makes thoughts mineable. Coexist.
- `STEP20-SITUATIONAL-AWARENESS-ENGINE-DESIGN.md` — existing surfaces, memory objects, event ledger, curator cycle, trigger index. This spec extends Step 20's situational awareness with the **temporal** dimension, and replaces Step 20's *engine-side* cognition reading-from-surfaces pattern. The *harness-side* context-assembly stays.
- `STEP11-INTELLIGENCE-TAB-DESIGN.md` — existing brain-state synthesis for dashboard. Complementary, not overlapping. Intelligence = retrospective view of what the brain knows. Fruit layer = prospective agenda of what to do next.

---

## Problem

*(Unchanged from v1 — diagnosis stands.)*

Evidence from cycle 3476, 2026-04-18:

- 14 of last 20 autonomous thoughts circle sauna / weather / pressure / health / iOS correlation — not because those topics matter most, but because `RECENT.md` and `PROJECTS.md` still flag them, unchanged since April 14. The context-assembly engine loads those surfaces before every turn; roles obediently respond to what the surfaces say; curator writes back to surfaces; loop closes.
- Graph has 28,001 nodes / 17,090 edges, plus 262 freshly-ingested legacy files from `cosmo-home_2.3/workspace/memory`. Autonomous thinking touches ~0.1% per cycle, drawn entirely from top-loaded surfaces.
- Stagnation detector fires at `count=1` but chaos-mode requires `count=3`. Detection is cosmetic — escape chain never completes.
- iOS health shortcut broke 2026-04-13. Still generating live-problem flags and driving thoughts on 2026-04-18 — no sense of age, no staleness signal, no "we've flagged this 30+ cycles, move on" behavior. Ageless to the system.
- `curiosity / analyst / critic / curator / proposal` roles rotate through variations of "generate about the surfaces we handed you." Surfaces are the anchor, rotation is theater.
- Everything emitted gets written. No verdict with teeth. No discard path. Restatement accumulates as content.

Deeper pattern: **LLM-as-scripted-employee wearing a thinking-machine costume.** The 28k-node brain with real topology, sleep/dream, consolidation, sidecars, ledgers — is downstream of a scripted LLM cron reading 5 static files through 5 personas in a constrained grammar. Manual validation: when jtr queries the brain with "what surprises you / what's novel / what am I missing" → deep dive → PGS, output is rich and actionable. Brain *can* mine itself well. Autonomous cycle doesn't.

---

## Two Foundations

*(Unchanged — they survived review.)*

### Foundation 1 — Continuous Autonomous Cognition

The loop is the mind. Never idles. A cron cannot mine its own graph, swim in it, remember across time, act on accumulated context. Loop exists because thinking requires continuity.

Properties:

- Always running, always processing. No quiet cycles.
- Multi-cadence concurrent streams:
  - **Discovery** — continuous graph-topology probing, cheap local math, non-blocking
  - **Deep thought** — 15 min minimum heartbeat
  - **Sleep / dream / consolidation** — existing, sacred (sleep pauses the new pipeline; see *Sleep Interaction*)
  - **Pulse remarks** — own cadence, sacred
- Fruit accumulates. Volume is a feature; the fruit layer makes it usable.

The 15-min cadence is *minimum*. If critique takes 8 minutes to converge, next cycle starts after current + buffer.

### Foundation 2 — Temporal Awareness as Lived Dimension

Every thought, attention move, verdict grounded in where-we-are-in-time relative to the human world. Felt age, not timestamps.

Properties:

- Every thought born with temporal context (absolute, jtr-time, relative ages of referenced material).
- Loop has felt duration (awake for X, last slept Y, continuous run Z, last conversation W).
- Jtr's time, not server time — his timezone, workweek, phases, rhythms.
- Age changes attention: old unresolved problems flag differently than fresh ones. Stagnant topics deprioritize. Aging hot problems escalate.

Without this, day-0 and day-5 nodes are indistinguishable → obsession.

---

## Orchestrator Concurrency Model

**Honest admission:** the current orchestrator is a single serial `main()` loop that fires roles, handles sleep state, triggers consolidation, runs dream. "Multi-cadence concurrent streams" is a restructure, not a swap.

Design:

- **Main loop stays** as the heartbeat driver. Its responsibilities narrow: schedule phases, handle sleep/wake, fire consolidation on interval, emit state saves.
- **Discovery daemon** runs as a *separate async task* within the same Node process (not a child process, not a worker thread — an async loop with `setInterval` or equivalent running graph-math probes every N seconds, populating an in-memory ranked queue).
- **Deep-thought cycle** fires from main loop on 15-min minimum cadence; reads top candidate from discovery queue; runs the 4-phase pipeline; blocks until critique converges or times out.
- **Sleep mode** pauses deep-thought cycles; discovery daemon continues at reduced frequency (graph math only, no conversation-salience reads, no LLM calls triggered).
- **Consolidation and graph maintenance** unchanged — still fire on existing cadence.

**Why this works:** Node.js async primitives handle this without threading. The orchestrator structural change is: (a) discovery daemon boot + teardown hooks, (b) replace role-fire step with pipeline-fire step, (c) sleep-mode gating on discovery daemon.

**What breaks if we pretend it's cycle-firing-only:** discovery can't be "continuous" inside a serial main loop — it would only probe once per cycle, which is the current pattern restated.

---

## The Four-Phase Pipeline

### Phase 1 — Discover (continuous, topology-driven)

Graph math, no LLM calls. Runs in discovery daemon. Emits ranked candidates to queue.

Signals (each produces scored candidates):

- **Anomaly** — cluster density shifts, unusual growth/shrinkage deltas over N-cycle window. Pure graph topology.
- **Novelty** — recently-ingested nodes with low edge count. Unconnected mountains.
- **Orphan** — high-centrality nodes not re-visited in N cycles. Important but neglected.
- **Drift** — clusters where recent thoughts diverge from established edge structure.
- **Stagnation** — clusters repeatedly thought about *without* producing new edges. Would have caught the sauna loop.
- **Conversation salience** — clusters proximal to recent conversation embeddings (see *Conversation Salience Plumbing*).

**Cost honesty:** discovery is mostly graph math, but conversation-salience requires embedding comparison (fast via pre-computed embeddings + cosine). Anomaly/drift require per-cycle topology snapshots (small memory, fast diff). No LLM inference in this phase.

**Output:** ranked queue, each candidate carrying temporal + structural metadata.

### Phase 2 — Deep Dive

Heartbeat pulls top candidate. This phase loads **broad graph context** via graph query around the candidate's neighborhood:

- N-hop traversal (N tunable, default 2)
- Related cluster summaries (existing brain summaries, not surface files)
- Conversation context if salient (last 24h summary embedding + proximal topic)
- Temporal context of everything pulled (each node carries its age)

LLM call: long tokens (16k max output), reasoning high, no grammar forced. Prompt: "Here's what's weird in the graph, here's the neighborhood, here's what jtr's been engaging with, here's how long this has been the way it is, here's your last thought. Think."

**Model tier:** default MiniMax-M2.7 (fast, cheap, reasoning-capable). Opus escalation optional for high-stakes candidates (flag in candidate metadata).

**Output:** raw thought, as long as needed. Structured metadata attached (referenced node IDs, temporal context, pipeline provenance).

### Phase 3 — Connect (PGS)

Takes deep-dive output. Runs perspective-generating search. See *PGS Extraction* for the dependency.

**Contract:**

```
input:  { thought: string, referencedNodes: NodeId[], graphSnapshot: ... }
output: {
  perspectives: [{ angle: string, searchResult: Node[] }],
  candidateEdges: [{ from: NodeId, to: NodeId, rationale: string }],
  connectionNotes: [{ text: string, nodeIds: NodeId[] }]
}
```

**Caps (failure-mode guards):** max 3 perspectives, max 10 candidate edges per cycle, PGS timeout 90s. If PGS unavailable or times out, critique phase receives a note and proceeds without connections.

### Phase 4 — Critique & Verdict (convergence-based)

LLM-powered function (not persona). Inputs: emergent thought + PGS output + graph context + last 24h conversation + temporal context.

**Convergence algorithm (spelled out):**

```
pass 1: always runs. Critique emits { verdict, confidence, gaps[] }.
  - verdict ∈ {keep, revise, discard}
  - confidence ∈ [0, 1]
  - gaps: [] if verdict in {keep, discard}

if verdict == revise:
  pass 2: deep-dive re-runs with gaps as framing. Critique re-evaluates.
  Repeat until:
    (a) |confidence_n - confidence_{n-1}| < 0.05 AND verdict stable
        → converged, finalize verdict
    (b) cosine_sim(critique_text_n, critique_text_{n-1}) > 0.85
        → plateau, finalize whatever verdict is current
    (c) pass_count >= 5
        → hard ceiling safety, force discard with reason "non-convergence"

if verdict == keep:
  thought written, agenda candidates extracted, edges proposed to graph,
  event ledger emits MemoryCandidateCreated + MemoryPromoted
if verdict == discard:
  silence. Separate discarded.jsonl log with critique reasoning for debugging.
  No thought written. No graph edges.
if verdict == revise → recurse per above.
```

**Why these thresholds:** confidence delta 0.05 = two-decimal precision stable. Cosine 0.85 = empirical threshold for "saying the same thing with different words" (tune later). Hard cap 5 = bounds token spend per cycle.

---

## Honesty as Functions, not Roles

The three mechanisms worth preserving from the old roles:

- **Verdict accountability** (from critic) — built into critique phase's core. Thought must LAND.
- **Novelty gating** (from curator) — critique explicitly checks: does this add a new edge, surface a new pattern, propose a new connection? If no, lean toward discard.
- **Self-critique pressure** (from multi-role contradiction) — critique runs against the thought with access to the full graph and can identify "you're assuming X, but nodes A/B/C contradict that."

These are functions the critique phase calls, grounded in graph and conversation, not persona prompts.

---

## Integration with Existing Systems

### STEP20 Integration (decision: engine-only replacement)

Step 20's situational-awareness scaffolding has two sides:

- **Engine side:** surface files (`SOUL.md`, `MISSION.md`, `TOPOLOGY.md`, `PROJECTS.md`, `PERSONAL.md`, `DOCTRINE.md`, `RECENT.md`) loaded via `context-assembly` before every *cognitive* turn.
- **Harness side:** same surfaces loaded via `src/agent/context-assembly.ts` before every *chat* turn.

**The new pipeline replaces the engine-side pattern. Harness-side stays.**

Rationale: chat context wants stable reference surfaces (who am I, what do I do, what's current). Autonomous cognition wants mining. Two different use cases, two different patterns. The surface files remain populated (curator cycle still writes them) so the harness keeps working, pulse keeps reading, and the dashboard retains its views.

What stays from Step 20:

- Memory objects (working + durable)
- Event ledger (new pipeline emits events — see below)
- Problem threads
- Trigger index
- Curator cycle (writes surfaces + promotes memory)
- Harness context-assembly

What the new pipeline does instead of reading surfaces:

- Discovery queries the graph directly
- Deep-dive loads graph neighborhood + conversation context
- No `SOUL.md`-style files read at turn-start by the autonomous loop

### STEP11 Intelligence Tab (stays, complementary)

Intelligence tab = retrospective brain-state synthesis. "What has the brain learned?"
Fruit layer = prospective agenda. "What should jtr do next?"

Both coexist on the dashboard. Intelligence reads from brain-state.json, synthesis agent, BRAIN_INDEX.md. Fruit layer reads from agenda store.

### Curator-Cycle Integration

`engine/src/core/curator-cycle.js` is the existing brain-node intake governance / surface rewriter / audit-metrics engine.

**Relationship with new critique function:**

- Curator cycle continues unchanged — it runs on its existing cadence, governs brain-node promotion into durable memory, rewrites surface files, logs audit metrics.
- The new critique function (Phase 4) operates on *thoughts*, not brain nodes. Its output feeds into the existing curator cycle via the same code paths the old roles used.
- When critique emits `keep`, a MemoryCandidate is created via the existing promotion pipeline. Curator cycle picks it up on its next tick for surface rewriting, node creation, and promotion.
- Critique and curator don't compete. Critique decides *what gets written*; curator decides *how it lands in durable memory*.

### Event Ledger Integration

Step 20's event ledger (`instances/<agent>/brain/event-ledger.jsonl`, append-only) tracks continuity events. The new pipeline MUST emit through this ledger:

- `ThoughtEmerged` (new event type) — cycle N, pipeline produced raw thought, metadata
- `CritiqueVerdict` (new) — verdict, confidence, pass count, plateau/converged
- `MemoryCandidateCreated` (existing) — on `keep` verdict
- `MemoryPromoted` (existing) — on curator durability upgrade
- `ThoughtDiscarded` (new) — on `discard`, written to separate discarded.jsonl but ledger notes the event

Bypassing the ledger breaks continuity audit — a core Step 20 guarantee. No shortcuts.

### Pulse-Remarks Integration

`engine/src/pulse/pulse-remarks.js` currently reads:

- Surface files (lines 304, 390 — TOPOLOGY/PROJECTS/PERSONAL/DOCTRINE/RECENT mtimes)
- Role-tagged thoughts (line 365)
- Formats output with `t.role` (line 713)

**Change required (small):**

- Surface reads stay. Curator still writes surfaces. Pulse keeps working.
- Role-tagged thought reads: new pipeline emits thoughts with a `provenance` field instead of `role`. Options: (a) set `role: 'deep_thought'` as a backward-compatible tag, or (b) extend pulse to accept either `role` or `provenance`. Prefer (b) — cleaner.

Line count of pulse changes: ~20 lines. Explicitly scoped, not "unchanged."

### Action-Tag Grammar Integration (keep as optional post-hoc)

11 files reference INVESTIGATE/NOTIFY/TRIGGER/OBSERVE/VERDICT. Notable:

- `thought-action-parser.js` (521 lines) — parses action tags from thought text
- `critic-verdict-parser.js` — extracts VERDICT
- `orchestrator.js`, `meta-coordinator.js`, `frontier-gate.js` — downstream execution
- `pulse-remarks.js`, `codebase-exploration-agent.js`, `quantum-reasoner.js` — incidental

**Decision: keep the grammar, make it optional.**

- Pipeline emits free-form thought (no grammar forced in Phase 2-4 prompts).
- `thought-action-parser.js` runs on output as a post-hoc extractor: if the LLM happened to include INVESTIGATE / NOTIFY / TRIGGER / OBSERVE / ACT, parse them out as action candidates; if not, no harm done.
- Downstream ACT spawn, NOTIFY verification, VERDICT state change — unchanged. They still trigger when tags are present.
- Critique function may optionally emit its own structured verdict in addition to the thought; that goes through `critic-verdict-parser.js` which keeps working.

Net effect: action-execution pipeline is untouched. The grammar is no longer a cage; thoughts that don't produce actions are fine, and thoughts that do still get parsed.

### Closer-Primitive Integration

Closer-primitive adds `doneWhen` to goals. The new pipeline interacts as follows:

- On `keep` verdict, if the thought's referenced nodes or PGS-generated connections suggest progress on an active goal with `doneWhen` criteria, critique optionally invokes `checkDoneWhen(goalId)` to re-evaluate termination.
- This is optional, not required. No coupling in either direction.
- Closer-primitive's `doneWhen` infrastructure is sacred (that spec owns it).

---

## PGS Extraction (sub-spec required)

**Current state:** PGS lives in `cosmo23/pgs-engine/`, called lazy-loaded from the dashboard via an opt-in flag (`enablePGSByDefault` in home.yaml; defaults false). Not wired into engine cognition.

**What "always on" requires:**

1. Extract or adapt `PGSEngine` from the cosmo23 lazy-load context
2. Create `engine/src/cognition/pgs-adapter.js` providing the contract above
3. Token budget gating (cap per PGS call: 10k input / 3k output)
4. Timeout handling (90s hard cap, graceful degradation)
5. Availability detection: if cosmo23 is offline or PGS fails, Phase 3 returns empty connections with a note; Phase 4 proceeds without

**Scope of the PGS extraction sub-spec (to be written before Phase 3 implementation):**

- Adapter interface and error modes
- Token budget and caching (PGS over the same candidate within N minutes → cache)
- Graph-access interface (PGS needs the brain graph; how does it query?)
- Fallback behavior
- Observability (PGS call count, latency, timeout rate)

This sub-spec is a Phase 3 prerequisite. If PGS turns out to require significant work, Phase 3 gets blocked until the sub-spec lands.

---

## Temporal Awareness Implementation

**How it's delivered, specifically:**

### Temporal substrate fields

Every thought emission carries:

```js
{
  content: string,
  temporalContext: {
    now: ISO8601,
    jtrTime: {
      phase: 'morning' | 'afternoon' | 'evening' | 'late-night',
      dayType: 'weekday' | 'weekend',
      workweekPhase: string | null  // e.g., 'deep-work' | 'meeting-heavy' | 'vacation'
    },
    relative: {
      topicLastSurfaced: { topic: string, ago: ISO8601_duration } | null,
      jtrLastEngaged: ISO8601_duration,
      problemAges: [{ problemId, ageDays }],
      referencedNodeAges: [{ nodeId, ageDays }]
    },
    loopDuration: {
      awakeFor: ISO8601_duration,
      lastSlept: ISO8601_duration,
      continuousRun: ISO8601_duration,
      lastConversation: ISO8601_duration
    }
  },
  provenance: { phase, passes, model, ... },
  // rest
}
```

### Delivery mechanism

- Every LLM call in Phase 2/3/4 receives the `temporalContext` block as part of the prompt (structured, prepended to user message).
- Every thought written to stream persists the full context in its metadata (for the agenda layer, observability, and future retrospective).
- Discovery uses temporal fields to weight candidate ranking.

### Bootstrap: `TEMPORAL.md` (new workspace surface)

New file at `instances/<agent>/workspace/TEMPORAL.md`, maintained by jtr initially:

```yaml
timezone: America/New_York
workweek:
  pattern: mon-fri
  morningStart: 08:00
  eveningStart: 18:00
  lateNightStart: 23:00
rhythms:
  - name: deep-work
    days: [tue, wed, thu]
    phases: [morning, afternoon]
  - name: family-evening
    days: [*]
    phases: [evening]
  - name: sauna
    days: [mon, wed, fri]
    phases: [evening]
overrides:
  - start: 2026-04-20
    end: 2026-04-27
    workweekPhase: vacation
```

Brain reads on each cycle, computes current phase from `now`.

### Learned refinements

Brain maintains a `LEARNED_TEMPORAL.md` (proposals, not ground truth). It observes patterns (actual engagement times, silence gaps, conversation topics by phase) and proposes refinements jtr can accept or ignore via the dashboard.

### Verification surface

Dashboard shows a small "brain thinks it's ___" text (current jtr-time inference). If wrong, jtr updates `TEMPORAL.md` directly. No magic — manual ground truth + optional learning.

### Age-weighted attention

Discovery ranks candidates with age as a factor:

```
score = importance × recency_factor × salience
where recency_factor depends on signal type:
  - orphan: importance * (age / recency_sweetspot)  # aging HOT orphans escalate
  - stagnation: importance / (age + 1)               # stagnant topics decay
  - novelty: freshness decays quickly                # new matters most when new
  - anomaly: flat                                    # graph weirdness is ageless
```

Tunable per signal. Starts with reasonable defaults; adjusted based on observed output quality.

---

## The Fruit Layer

~60-80 deep thoughts/day × keep-ratio × days = real volume. Needs a home.

### Components

- **Agenda store** (`instances/<agent>/brain/agenda.jsonl`, append-only, with index)
  - Every `keep` verdict contributes 0-N agenda candidates
  - Each candidate: { id, content, sourceThoughtId, topic, createdAt, ageDays, salience, status }
  - Status lifecycle: `candidate` → `surfaced` → `acknowledged` | `acted_on` | `stale` | `discarded`
  - Temporal decay: candidates not surfaced or acted on within M days decay in salience; beyond threshold → auto-stale
- **Dashboard surface** — new top-level tab `/home23/agenda` with a companion tile on Home tab
  - Grouped by topic cluster (via graph neighborhoods)
  - Connection visualization (reuses brain-map components)
  - Age indicators, salience visualization
  - User actions: acknowledge, mark as acted-on, discard
- **Browsable archive** — `/home23/thoughts` view of all kept thoughts beyond current session, with search and graph connections

### Agenda extraction rule

Critique phase emits agenda candidates when:
- The thought surfaces a decision jtr should make, OR
- The thought identifies a question with actionable path, OR
- The thought connects previously unconnected material in a way that implies a next step

Rules-based first pass. Can be upgraded to emergent classifier later if rules miss too much.

---

## Conversation Salience Plumbing

**Where embeddings live:** harness writes conversation-summary embeddings to `instances/<agent>/brain/conversation-salience.jsonl` (append-only).

**When they're written:** on session-gap compile (existing mechanism — harness already compiles sessions to workspace on idle timeout). Sidecar write at compile time.

**What engine reads:** discovery daemon tails the sidecar on each probe tick. Pre-computed cosine similarity between recent conversation summary embeddings and graph-cluster embeddings (cached) feeds the salience signal.

**Latency:** conversation end → salience available within ~60s (compile cadence).

**During live chat:** discovery uses the most recent compiled summary. Live turns don't re-trigger salience computation (too expensive); the next compile picks them up.

**Embedding model:** reuses existing embedding pipeline (`ollama-local/nomic-embed-text` per home.yaml providers block). No new infrastructure.

---

## Cost & Token Budget

**Per cycle estimate:**

| Phase | Input tokens | Output tokens | Notes |
|-------|-------------:|--------------:|-------|
| Discover | 0 | 0 | Graph math only, no LLM |
| Deep-dive | 6-10k | 2-4k | Single call, high reasoning |
| Connect (PGS) | 3-6k × 3 perspectives | 1k × 3 | 3 perspectives, capped |
| Critique (avg 2 passes) | 5-8k × 2 | 1-2k × 2 | Convergence recursion |
| **Per cycle total** | **~30-40k in** | **~10-15k out** | |

**Daily (~60-80 cycles after accounting for critique recursion + sleep gaps):** ~2-3M tokens input, ~800k-1.2M tokens output.

**At MiniMax-M2.7 pricing** (~$0.30/M input, ~$1.20/M output): ~$1-2/day per agent. Monthly: ~$30-60.

**At Opus pricing** (~$15/M input, ~$75/M output): ~$30-60/day. Monthly: ~$900-1800.

**Decision: MiniMax-M2.7 default for all phases.** Opus reserved for explicit escalation via future observability-driven tuning. Document the escalation criteria in a follow-up once we have data.

**Budget target:** $100/month per agent cap as a sanity rail. Observability panel surfaces daily spend; alert if trending over.

---

## Observability

**Metrics panel on dashboard** (new tile on Home tab + detail view in Settings → Observability):

- **Thoughts kept / discarded ratio** — daily and 7-day trend
- **Convergence pass distribution** — histogram; should center on 1-2 passes, tail on 3-4, hard cap at 5
- **Agenda candidates generated / acted_on / stale** — weekly flow
- **Discovery queue depth** — shows starvation vs flood
- **Topic recurrence** — how often the same topic surfaces in thoughts over rolling 7 days (the sauna metric — is the obsession gone?)
- **Graph edge growth rate** — nodes/edges added per day from kept thoughts vs via ingestion vs via curator
- **Token spend** — daily input + output tokens, cost estimate
- **Critique plateau rate** — fraction of cycles hitting plateau vs genuine convergence
- **PGS call stats** — count, latency, timeout rate

**No alerting in v1.** jtr eyeballs. Alerting after we know what normal looks like.

---

## Rollback Plan

**Feature flag:** `engine.architecture.cognitionMode: 'legacy_roles' | 'thinking_machine'`, set in `configs/base-engine.yaml` or per-agent `config.yaml`.

**During parallel period (first 30 days post-cutover):**

- Both code paths live side by side.
- Flip flag, restart engine, switch modes.
- Observability metrics collected under both modes for comparison.

**Rollback triggers (non-exhaustive):**

- Kept ratio < 20% for 3 consecutive days (critique too harsh, probably a bug in the novelty gate)
- Convergence pass median > 3 (too much recursion, token spend blows up)
- Subjective output quality fail for 3+ days (jtr calls it)
- Graph corruption signal (kept thoughts introducing malformed edges)
- Cost exceeds budget target

**Procedure:** flip flag, restart. Legacy roles resume cycling. Investigate under no pressure.

**After 30 days:** if thinking_machine mode is stable and clearly better, legacy_roles code path is removed in a follow-up cleanup. Until then, both stay compiled.

---

## Failure Modes

| Failure | Trigger | Handling |
|---------|---------|----------|
| Discovery queue starvation | Zero candidates scored above threshold for N minutes | Fallback: sample random high-novelty cluster; emit `DiscoveryStarved` event |
| Critique non-convergence | Pass count hits 5 without plateau/convergence | Force discard with reason `non_convergence`; log for tuning |
| PGS flood | Single call produces > 10 candidate edges | Cap at 10, discard rest, note in critique |
| PGS unavailable | Cosmo23 offline or extraction failure | Phase 3 returns empty; Phase 4 notes "no connections"; proceed |
| PGS timeout | > 90s | Abort, proceed without |
| Temporal model wrong | jtr sees "brain thinks it's evening" when it isn't | TEMPORAL.md is manual ground truth; update file; next cycle picks up |
| Event ledger collision | Duplicate event IDs | Reuse Step 20's ID generator (existing, battle-tested) |
| Agenda store corruption | Malformed JSONL | Read-repair on load; fail-loud on bad entries |
| LLM returns empty / malformed | Any phase | Treat as `revise` with synthetic gap "retry with clearer framing"; max 2 retries per phase |
| Conversation salience sidecar missing | File not yet written | Discovery proceeds without conversation signal until sidecar appears |

---

## Implementation Phasing

Each phase ships when it passes its verification gate. Feature flag allows flip-back at any point. Build fast and right, fix fast. No calendar estimates.

| Phase | Work | Depends on | Verification gate |
|-------|------|-----------|-------------------|
| 1 | Temporal substrate: TEMPORAL.md, phase computation, context fields on thought emissions, prompt integration | None | Temporal context appears on every emitted thought; dashboard shows brain's current jtr-time inference; jtr validates the inference matches reality |
| 2 | Discovery engine: graph-math signals, ranked queue, daemon bootstrap, observability hooks | Phase 1 | Queue populates with candidates from all six signals; observability panel shows queue depth, per-signal contribution; ranking is interpretable |
| 3 | PGS extraction sub-spec + implementation; pipeline skeleton (deep-dive + connect phases) | Phase 2 | PGS callable from `engine/src/cognition/pgs-adapter.js` with documented contract; deep-dive reads queue, emits thought; connect returns candidate edges; both run end-to-end under feature flag without affecting legacy cycle |
| 4 | Critique function + convergence detector (similarity + confidence delta + hard cap) | Phase 3 | Critique emits verdicts with confidence; convergence/plateau/hard-cap paths all exercised; discards produce silence; observability shows pass-count distribution |
| 5 | Event ledger integration: new event types, ThoughtEmerged / CritiqueVerdict / ThoughtDiscarded | Phase 4 | Every pipeline cycle emits events; ledger JSONL is readable and contiguous; continuity audit passes |
| 6 | Fruit layer: agenda store, dashboard surface (agenda tab + tile), browsable archive | Phase 5 | Kept thoughts produce agenda candidates; dashboard renders them grouped by topic with connections; jtr can acknowledge/discard via UI |
| 7 | Conversation salience pipeline: harness sidecar write, engine sidecar read, discovery signal wiring | Phase 2 | Chat session → sidecar within ~60s; discovery salience signal weights candidates by conversation proximity; topic recurrence metric responds when jtr shifts focus |
| 8 | Feature flag, cutover, observability panel, rollback drill | All above | Flag flip switches modes cleanly; parallel mode collects comparison metrics; rollback drill proves revert works |

Each phase ends with: observability metrics showing behavior under legacy mode for comparison, verification gate above passed, revert path validated.

---

## Design Decisions (now resolved in v2)

Previously open, now decided:

1. **Discovery ranking weights** — start uniform, tune from observability output.
2. **Temporal resolution** — minute-level for loop duration, hour-level for topic ages, day-level for jtr-time phase.
3. **Jtr-time model** — explicit `TEMPORAL.md` seeded by jtr + learned refinements proposed by brain, never auto-applied.
4. **Convergence plateau detector** — cosine similarity > 0.85 OR confidence delta < 0.05 over 2 passes; hard cap 5.
5. **Agenda extraction** — rules-based first (decision/question/connection criteria), upgrade to classifier later.
6. **Kept vs discarded write path** — kept → thoughts stream + graph + event ledger; discarded → `discarded.jsonl` only, event ledger notes it.
7. **Transition plan** — feature flag, parallel operation for 30 days, cutover + observe + rollback-if-needed.
8. **Conversation salience window** — 24h primary weight, decaying to zero at 72h.
9. **Closer-primitive interaction** — optional; critique may invoke `checkDoneWhen()` on related active goals.
10. **Fruit layer placement** — new top-level tab `/home23/agenda` plus Home tab tile.

---

## Remaining Open Decisions

Still to shape (low-risk; tune during implementation):

- Discovery ranking weight starting values (all currently proposed uniform)
- Opus escalation criteria (defer until data)
- Exact token caps per phase (current numbers are estimates)
- Whether learned-temporal proposals require explicit jtr acceptance or auto-apply after N consistent observations (start manual)
- Alerting thresholds on observability (defer until we know what normal looks like)

---

## Notes

- Spec is engine-side autonomous cognition only. Chat via harness unchanged.
- PGS extraction is a blocker for Phase 3; dedicated sub-spec required before implementation of Phase 3 begins.
- Temporal awareness may deserve its own follow-up spec if the implementation surfaces complexity beyond what's detailed here (especially around live-problems aging integration — currently flagged as "data flow change, not logic change" but may need deeper treatment).
- Feature flag is the rollback — do not cut over without it.
- Event ledger integration is not optional. No pipeline without the ledger.
- v2 addresses the six criticals and seven missing pieces from the v1 review. Further review welcome.
