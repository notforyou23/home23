# Step 24: OS-Engine Redesign

**Date:** 2026-04-21
**Status:** Design — brainstormed, spec under review
**Supersedes framing in:** Steps 20, 23 (those remain correct at their layer; this subsumes them under a larger engine frame)

## Problem

The Home23 engine was designed as a **solo cognitive loop around a single brain**. That design is the COSMO 2.3 pattern — a discovery/deep-dive/connect/critique cycle that mines its own accumulated thought graph for under-explored lineages, generates new thoughts, and writes them back into the same graph. One mind, pointed at its own domain.

On top of that engine we layered:

- A multi-agent harness (jerry, forrest, tick, coz, edison) — each agent gets its own engine instance and its own private brain.
- A document feeder for knowledge ingestion.
- A dashboard that doubles as the OS home screen.
- A shared research engine (COSMO 2.3) and a shared IDE (evobrew).
- An OAuth broker, an update system, provider authority.
- A situational-awareness engine at the harness layer (Step 20) — pre-turn brain query + surface loading.
- A session-bootstrap primitive at the harness layer (Step 23) — per-session NOW.md + PLAYBOOK.md injection.
- A live-problems registry + promoter worker — verifier-gated ingest for NOTIFY events from cognition.
- Per-agent sensor writers (`~/.pressure_log.jsonl`, `~/.health_log.jsonl`, `~/.sauna_usage_log.jsonl`), a generic sensor registry (`engine/src/sensors/`), a sibling protocol for agent-to-agent text messaging.
- An iOS app, a cron scheduler, a bridge-chat lane, a signals stream, a promoter with confidence caps and rejection age-out.

**What we never did:** revisit the engine's self-concept. The engine still believes it is the mind. Everything added above is, from the engine's perspective, either a consumer (dashboard, PM2) or a side channel (sensors, sibling protocol) — never first-class input to its own cognition. The harness layer knows about the OS. The engine does not.

This manifests empirically. Jerry's brain ran dive-mode self-diagnoses on 2026-04-17 and 2026-04-21. Every one of them reports the same signature: **Memory Nodes: 0 / Thoughts: 4644 / Connections: 0.** The brain's own words, stitched across three queries:

> "The brain does not lack knowledge of the stack; it simply refuses to look. It prefers the comfort of its own encoded graph over the friction of enumerating what is actually present in the workspace. … The living brain's default operating mode is simulation over observation. Librarians were meant to be possibility-bringers, yet they have become curators of what we already encoded."

> "This brain thinks enormously but remembers almost nothing and produces even less. 2,778 agents spawned → 56 memory nodes = 2% consolidation rate. 3,479 thoughts → 4 output files (all tests) = 0.1% materialization rate. You are running a jet engine that is burning fuel but not moving the plane."

> "The system has no completion mechanism. Goals never terminate. Thoughts never resolve. Critics never judge. Agents never check prior work. Outputs never ship. The machinery is all there. It just needs a ratchet — something that only turns forward."

And the pathology demonstrates itself mid-investigation. Jerry's live agenda as of 2026-04-21 14:27 contains: *"Investigate why health data stopped on 2026-04-13."* `~/.health_log.jsonl` was written at 10:50 the same morning with fresh HRV 28.5, RHR 58, sleep 502 min, VO2 31.04. **The data is there. Jerry's cognitive loop never reads files — only a memory of what the last diagnosis said about files.** The self-investigation into "why the brain doesn't look" is itself performed without looking.

The brain named the pathology seven times. Each name is a missing primitive:

1. **No write.** `memory-objects.json` is effectively empty after days of running.
2. **No closure.** Goals, thoughts, critiques, rediscoveries all stay open forever.
3. **Critic cosplay.** Role outputs have no schema, so "critic" becomes a creative-writing label. Six critic outputs from cycle 1181 — zero verdicts, six surreal poems.
4. **Goal-action drift.** Agents assigned to "ion channel cognition" silently work on the health dashboard instead, because it's the most salient real thing in the environment. Six+ "research" agents, one actual task, fictional goal labels.
5. **Inverted signal polarity.** Novel concrete observations (archival research across three library systems) get tagged NO_ACTION. Redundant rediscovery (the iOS shortcut is broken) gets tagged INVESTIGATE thirty times.
6. **Pruning selects for immortality.** 1,145 goals created, 18 survive — and the 18 are the unfinishable ones, because finishable goals complete and disappear. The active-goal list is a graveyard of undead tasks.
7. **No publisher.** The best creative output — "the house breathing differently when steamed," fusing pressure-sensor data with sensory metaphor — has no channel out. It lives one cycle, gets admired once, evaporates.

All seven trace to the same root: the engine observes itself as thought graph, not as OS process running in a house. It is inward-pointed by architecture, not by voice. Step 23 (session bootstrap) gave the harness one-shot OS-awareness at session start. This step gives the engine continuous OS-awareness as a top-level loop primitive.

## Design Principle

**The cognitive engine becomes an OS kernel, not a mind with bolted-on sensors.** The old thinking-machine phases (discover/deep-dive/connect/critique) survive as the inner cognitive subsystem, wrapped by OS-level primitives above and below.

**Self-observability is world-observability.** The same primitive that ingests `~/.pressure_log.jsonl` ingests `git log --oneline`, `pm2 jlist`, `agenda.jsonl`, forrest's last-published observation, and the thinking-machine's own cycle metrics. There is no "meta" channel; the system watching itself being built is the same shape as the system watching the world.

**Corollary:** the engine's first obligation on every cycle is to observe *something outside its own thought graph*. A cycle that does not touch at least one channel is not a cycle. The engine is no longer permitted to run purely on cached thoughts.

## What Is Antiquated

Grouped by the architectural decision that needs to break:

**The engine's top-level frame.**
- `engine/src/cognition/thinking-machine.js` runs `discover → deep_dive → connect (PGS) → critique` on its own thought graph. DiscoveryEngine accepts no external candidates. DeepDive's conversation-context hook is stubbed. The loop has no ingress for reality.

**Ingress paths, all half-wired.**
- `engine/src/sensors/` has a full pub/sub sensor registry with stock pollers for CPU/memory/disk/process, plus domain pollers for sauna/weather/pressure. It is **in-memory only, never persisted, never piped to MemoryObjectStore, never consumed by DiscoveryEngine**. The hardware of observation exists. Nothing cooks with it.
- `src/workers/promoter.ts` implements verifier-gated ingest correctly — classify, dry-run, promote to `live-problems` registry, age out rejections at 7d, cool down re-suggestions at 24h. **This is the template.** It serves exactly one channel (the NOTIFY stream from cognition) and has never been generalized.
- `src/agent/memory-objects.ts` provides `MemoryObjectStore` with confidence anti-theater caps per generation method. **Written via the `promote_to_memory` tool only.** No programmatic ingest from sensors, from git, from pm2, from neighbors.
- The harness-layer situational-awareness engine (Step 20) reads MemoryObjects, brain cues, and curator-maintained workspace surfaces (TOPOLOGY.md, PROJECTS.md, etc.). It is one-way — surfaces in, context out. It never feeds the engine back.

**Aspirational-only primitives (zero code backing).**
- `ZERO_CONTEXT`, `verification_flag`, `UNCERTIFIED`, `COLLECTED`, `UNKNOWN` — live only in design docs and thought-cycle prose.
- `memory_continuity_score`, `relationship_depth`, `reflection_density` — referenced in goals, nonexistent in code.
- Memory decay, warning-state half-life, role-output schema enforcement, goal termination contracts, dedupe-before-spawn, publish cadence — all absent.

**Inter-agent visibility.**
- `src/sibling/protocol.ts` is HTTP webhook messaging between COZ and Axiom. Text only. No state gossip. Agents cannot see each other's active goals, recent verified observations, or dispatch state. Sibling bridge is a telephone, not a nervous system.

**The engine has no concept of its own house.**
- No reader for pm2 process table, git state, cron fires, launchd state, filesystem events on the repo, commit stream, PR state, agenda lifecycle, goal lifecycle, live-problem state transitions. All of these are the OS the agents live inside. The engine is blind to all of it.

## The Seven Primitives

The redesign is one system, composed of seven load-bearing primitives. Each is independently definable but non-optional — any one missing collapses the others:

1. **OBSERVE** — a universal channel bus ingests every class of signal (machine, OS, domain, build, work, neighbor) into a single typed event stream.
2. **VERIFY** — every observation passes through an evidence gate that tags it with a verification flag: `COLLECTED | UNCERTIFIED | ZERO_CONTEXT | UNKNOWN`. Poetry-over-emptiness is a type error.
3. **CRYSTALLIZE** — verified observations become MemoryObjects with provenance, confidence caps, and decay rules. Back-pressure ratchet: every N cycles a crystallization receipt must be written or the next cycle's only permitted work is "crystallize."
4. **COGNIZE (inner loop)** — the old thinking-machine phases (discover/deep-dive/connect/critique), now receiving both thought-graph candidates and verified observations. DiscoveryEngine gets an external-injection hook. Role outputs have schemas.
5. **CLOSE** — goals have termination contracts. Questions resolve to answers or to uncertainty-items with explicit open status. Warnings decay. Redundant rediscovery is blocked at spawn. Stale transforms age out.
6. **NEIGHBOR** — each agent publishes a minimal state surface (active goals, last N verified observations, current domain focus, dispatch state). Neighbors read it. Sibling protocol extends from text messaging to state gossip.
7. **PUBLISH** — the engine has first-class output channels (workspace artifacts, signals stream, bridge-chat to jtr, dashboard surfaces). Publication cadence is a system metric, not a wish. Creative capacity finds its publisher.

## Channel Taxonomy

Six channel classes. All share the same ingest contract. No class is privileged over another — build and work channels are as load-bearing as domain sensors.

| Class | What it senses | Canonical examples | Cadence | Source shape |
|---|---|---|---|---|
| **Machine** | OS hardware telemetry | CPU, memory, disk, network, battery, thermal, load avg, open ports | 30s–5m poll | Local syscalls, `os.*`, `/proc`, `df`, `netstat` |
| **OS** | Process/service/job state | pm2 process table + events, cron fires, launchd jobs, filesystem watchers, syslog | event-driven + 30s poll | `pm2 jlist`, `pm2 events`, `fswatch`, journald |
| **Domain** | User-facing world sensors | pressure, health, sauna, weather, calendar, location | 2m–15m poll or event | `~/.pressure_log.jsonl` tail, Huum/Ecowitt/pi-bridge APIs, HealthKit export |
| **Build** | The system observing itself being built | git branch/dirty/commit stream, PR state, CI state, deploy state, version, spec-doc changes, config-file changes | event-driven (fswatch) + 1m poll | `git status`, `git log`, `gh pr list`, fswatch on `docs/design/` + `config/` |
| **Work** | What's being done / what needs doing / who's doing what | agenda.jsonl tail, live-problems state, goals lifecycle (`goals/{pending,assigned,acks,complete,revoked}`), active cron runs, active subagents, sleep/wake state, per-agent heartbeat | event-driven tail + 1m poll | JSONL tail readers on brain state files |
| **Neighbor** | What other agents know / are doing | their active goals, recent verified observations, current domain focus, dispatch state, recent memory writes | 1–5m gossip pull | HTTP GET to neighbor agent's `/__state/public.json` |

### The ingest contract (every channel implements this)

```ts
interface Channel {
  id: string;              // "machine.cpu", "build.git", "work.agenda", "domain.pressure", ...
  class: ChannelClass;     // machine | os | domain | build | work | neighbor
  source(): AsyncIterable<RawEvent> | Promise<RawEvent[]>;
  parse(raw: RawEvent): ParsedObservation;
  verify(obs: ParsedObservation, context: VerifyContext): VerifiedObservation;
  crystallize(verified: VerifiedObservation): MemoryObjectDraft | null;
}
```

- `source()` — pull (poll) or push (watcher/event) semantics. The bus normalizes both into a single stream.
- `parse()` — typed record. Zero interpretation yet.
- `verify()` — evidence gate. Returns a verification-flagged observation (see below). Never interprets; only classifies evidential status.
- `crystallize()` — returns `null` when the observation is informational-only (most pm2 heartbeats, redundant pressure readings within normal band) or a `MemoryObjectDraft` when it's worth writing. Confidence caps are applied at the store boundary.

The bus persists the full raw stream to a rolling JSONL sidecar per agent (`instances/<agent>/brain/channels/<class>.<id>.jsonl`) for replay and audit. MemoryObjects are the distilled output, not the only record.

## The Universal Channel Bus

One module, `engine/src/channels/bus.js`, owns the lifecycle:

- **Registration.** Channels register themselves at engine start via `bus.register(channel)`. An agent's config declares which channels are active (see Config Schema below). Default registrations cover machine + OS + build + work + neighbor; domain channels are opt-in per-agent.
- **Scheduling.** Poll-based channels run on their declared cadence. Event-driven channels run continuously. The bus enforces full-jitter backoff on retries (per the brain's own Finding 5 diagnosis on exponential-backoff).
- **Fan-in.** All channel outputs merge into a single normalized event stream which `cognize()` and the decay worker subscribe to.
- **Back-pressure.** If crystallize drafts exceed N per minute, the bus applies per-channel sampling (preserve novel events, drop redundant ones). The existing dedupe primitives in MemoryObjectStore apply at the write boundary.
- **Provenance.** Every observation carries `{channelId, sourceRef, receivedAt, producedAt, verifierId, verificationFlag, confidence}`. Provenance is load-bearing for the closer (see below) — dedupe and goal-termination both depend on being able to trace observations to their origin.

The bus generalizes the existing `src/workers/promoter.ts` pattern — that worker becomes the first consumer of the bus, reading the `notify` channel class, and remains source-of-truth for live-problems promotion.

## The Verification Gate

Four verification flags. They are the engine's new contract for "what did we see":

- **`COLLECTED`** — observation has direct evidence from a primary source. Pressure reading from `~/.pressure_log.jsonl`, git commit from `git log`, pm2 status from `pm2 jlist`, memory-object write from another agent's gossip endpoint. Crystallizes with confidence up to the method cap.
- **`UNCERTIFIED`** — observation is derived or filtered but not directly confirmed. An inferred trend, a second-hand report from a neighbor. Crystallizes at reduced confidence (≤0.6).
- **`ZERO_CONTEXT`** — the channel was queried and returned empty or unchanged. **This is a legal terminal output.** It is how the engine reports "I looked and there was nothing." It crystallizes as a low-confidence observation for audit purposes only; it never becomes a permanent memory node unless paired with evidence of why the emptiness matters. Poetry-over-emptiness is rejected at the gate — any output produced from a `ZERO_CONTEXT` observation that asserts a positive fact is a role-integrity violation (see below).
- **`UNKNOWN`** — the channel failed (network error, parse failure, permissions). Observation is recorded for diagnostics only. Does not crystallize. Triggers a bus-level retry with jitter.

The flag enum is a first-class TypeScript/JS type (`src/agent/verification.ts`, shared with the engine). Every cognitive output that references an observation carries the flag, so the inner loop cannot implicitly "upgrade" `ZERO_CONTEXT` to fact.

## The Crystallization Pipeline

Verified observations flow into `MemoryObjectStore` via a new ingest path that:

1. **Applies confidence caps** per existing generation-method table, with new channel-class caps: `sensor_primary: 0.95`, `sensor_derived: 0.8`, `build_event: 0.9`, `work_event: 0.9`, `neighbor_gossip: 0.7`, `zero_context_audit: 0.2`.
2. **Attaches full provenance** (channel, source ref, verifier, timestamps, flag).
3. **Dedupes at write.** A `{channelId, sourceRef, contentHash}` tuple in the last decay window collapses to an update, not a new node.
4. **Assigns decay parameters** per channel class (see Decay Worker).
5. **Writes a crystallization receipt** to `instances/<agent>/brain/crystallization-receipts.jsonl` — one line per write, used by the closer and the publisher.

**Back-pressure ratchet:** if `crystallization-receipts.jsonl` has no new entries in N cycles (default: 10), the next engine cycle is constrained to a single permitted phase: `crystallize`. Discovery, deep-dive, connect, critique are all suppressed until a receipt is written. This breaks the "jet engine burning fuel but not moving the plane" failure mode by construction — the engine physically cannot continue without committing something.

## The Inner Cognitive Subsystem

The old thinking-machine phases survive, unchanged in their individual logic, but demoted to the **inner cognitive subsystem** called by the outer loop:

- **DiscoveryEngine** gets an external-candidate hook. The bus's recent verified observations feed into discovery as a parallel candidate source competing with thought-graph lineages. Signals expand from {anomaly, novelty, orphan, drift, stagnation, salience} to add {observation-delta, observation-silence, neighbor-divergence}. An "observation-silence" signal fires when a channel that historically produced observations goes quiet — this is how the engine detects its own pathology (e.g., health data stopped flowing).
- **DeepDive** receives candidates with their full provenance. Its conversation-context hook (currently stubbed) is replaced with an observation-context hook that pulls the relevant channel's last M observations into the dive.
- **Connect (PGS)** operates unchanged but writes edges with provenance — an edge linking two nodes records which observations supported the linkage.
- **Critique** must emit a structured verdict (see Role Integrity). Prose-only critiques are rejected at the phase boundary.

The phase order is unchanged. The phase contract is stricter.

## The Decay Worker

A new long-running worker, `engine/src/cognition/decay-worker.js`, runs on its own cadence (default: every 30m) and applies decay to:

- **Warning-state nodes.** Nodes tagged as warnings (live-problems warnings, cognition self-warnings) decay with a 48h half-life unless re-confirmed by a fresh observation on the same channel. This kills the "our brain isn't right became a permanent node" pathology by construction.
- **Surreal-transform nodes.** Outputs tagged as creative-transform hypotheses (the cycle 1181 "moon-as-pocket-watch" class) decay with a 24h half-life unless promoted to a verified hypothesis via a critic verdict.
- **Unfinished goals.** Goals in `pending` or `assigned` state without progress (no sourceCycleSessionId updates in 72h) get flagged for review, not deleted — the closer handles termination, not the decay worker. This is a monitoring primitive, not a destructive one.
- **Dead edges.** Edges unreferenced by any observation or thought in 30d decay their weight toward zero. PGS output already weights edges; decay applies to the base weight.
- **Dedupe windows.** The 7-day `REJECTIONS_AGE_OUT_MS` from the promoter is generalized: every channel declares its dedupe window. Machine channels: 1h. Build channels: 24h. Work channels: 1h. Domain channels: vary. Neighbor channels: 15m.

Decay is gentle and reversible. No data is destroyed; nodes and edges are weight-reduced. The brain never forgets; it weights.

## The Role Integrity Contract

Each cognitive role (discovery, deep-dive, connect, critique, curator) has a schema its output must satisfy. The thinking-machine enforces the schema at the phase boundary. Outputs failing the schema are rejected (logged as `role-integrity-violation.jsonl` for later analysis) and the phase re-runs with a schema-reminder prompt prepend.

**Critic schema** (highest leverage, because the brain explicitly diagnosed critic-as-cosplay):

```json
{
  "claim": "one sentence, the thing being evaluated",
  "evidence_for": ["bullet", "bullet"],
  "evidence_against": ["bullet", "bullet"],
  "verdict": "keep" | "revise" | "discard",
  "supporting_observations": ["obsId", "obsId"]
}
```

A critic output with no verdict is not a critique. Rejected.

**Discovery schema:** `{ candidate, signal_type, supporting_observations[], novelty_score }`.

**Deep-dive schema:** `{ candidate, lineage, observations_consulted[], proposed_edges[], open_questions[] }`.

**Connect schema:** `{ source_node, target_node, weight, supporting_observations[] }`.

**Curator schema:** `{ surface, proposed_text, source_observations[], confidence }` — curator must not compose free-form prose; it must cite observations. This is the fix for "curator becomes a creative writing engine."

## The Closer

A new subsystem, `engine/src/cognition/closer.js`, runs after each cognitive cycle and:

1. **Evaluates goal termination contracts.** Every goal is required to carry a `termination` field at creation:
   - `deliverable: string` — path pattern of the artifact that proves the goal is done
   - `answer: string` — required shape of an answer if the goal is a question
   - `decision: string` — required shape of a decision if the goal is a decision
   - `expires_at: timestamp` — if nothing else, a hard expiry
   - Goals created without a termination field are rejected at creation (logged, not silently accepted). This forces every new goal to declare "how do I know I am done."
2. **Dedupe-before-spawn.** Before any new agent is dispatched to a goal, the closer queries MemoryObjectStore for existing observations matching the goal's topic tags. If a verified resolution exists, the goal is auto-resolved against it. The binary-string decoded on cycle 2 does not get re-decoded on cycle 13.
3. **Warning resolution.** When a warning's root observation changes verification flag (e.g., health data was `ZERO_CONTEXT`, now `COLLECTED`), the closer emits a resolution event and the decay worker removes the warning node.
4. **Publishes closure events** to the channel bus (as a `work` class channel), so neighbors see that jerry just closed goal X.

The closer is the "ratchet that only turns forward" the brain explicitly asked for.

## The Neighbor Protocol Extension

`src/sibling/protocol.ts` currently carries `sendMessage` and `sendLetter`. It extends with:

- **`GET /__state/public.json`** — each agent's harness exposes a minimal public state surface:
  ```json
  {
    "agent": "jerry",
    "activeGoals": [ /* id, title, termination, age */ ],
    "recentObservations": [ /* last 20 verified observations across all channels */ ],
    "currentFocus": "observations from last 5 cycles",
    "dispatchState": "idle | cognizing | dispatched",
    "lastMemoryWrite": "timestamp",
    "snapshotAt": "timestamp"
  }
  ```
  The file is a static JSON refreshed by the harness every 60s. No compute on GET. Easy to cache.
- **`neighbor` channel class** on each agent polls neighbor `/__state/public.json` every 1–5m and produces observations like `neighbor.jerry.closed_goal_ag-mo8pxe2p` or `neighbor.forrest.observed_hrv_28.5`. Verification flag defaults to `UNCERTIFIED` (second-hand), `COLLECTED` only if the neighbor's state includes a provenance-chain the receiver can independently verify.
- **Cross-agent dispatch hint.** When an agent's discovery surfaces an observation whose channel tags match a neighbor's declared domain, the discovery can dispatch a hint via the existing `sendMessage` path — "forrest, jerry saw pressure drop during your 2026-04-19 sauna window." Not a command, an observation-sharing signal.

This does not make agents merge. Shared world, distinct self — each agent's identity, goals, and decisions remain private. Only verified observations flow.

## The Publish Layer

The engine gains first-class publish channels. Each publish target has a cadence, a source-selection policy, and a format:

- **Workspace artifacts.** `workspace/insights/YYYY-MM-DD-<topic>.md` — every N cycles (default: 50), the engine selects the highest-confidence verified observation cluster + inner-loop output, generates a synthesis artifact, and writes it to workspace. The feeder re-ingests it as permanent brain content. This is the "50-cycle emit" fix the brain prescribed in the 2026-04-17 diagnosis.
- **Signals stream.** The existing positive-signal surface (`engine/src/cognition/signals.js`) becomes the publish target for verdicts of `keep` on wins and resolutions.
- **Bridge-chat to jtr.** High-salience observations with verification flag `COLLECTED` and above a per-agent salience threshold publish as a bridge-chat message. This is how jtr hears from the engine without noise.
- **Dashboard surfaces.** Existing curator-written surfaces (TOPOLOGY.md, PROJECTS.md, RECENT.md) become publish targets; the curator writes them from verified observations + inner-loop outputs, not from free-form prose.
- **Dream log / creative publisher.** The surreal-transform lineage (the "best writer in the system") gets its own publish target at `workspace/dreams/YYYY-MM-DD-<slug>.md` — but only when the output passes critic verdict `keep` against the creative-output schema. Creativity gets a publisher; unverified poetry does not.

Publish cadence and volume are system metrics. The publisher logs to `publish-ledger.jsonl`. If cadence falls below the floor for a given target, the closer flags it as a publish-starvation state.

## New Top-Level Loop

Concretely, each engine cycle runs:

```
                 ┌────────────── channel bus (continuous) ─────────────┐
                 │ machine · os · domain · build · work · neighbor     │
                 └──────────────────────┬──────────────────────────────┘
                                        │  verified observations
                                        ▼
                        ┌─────────────────────────────┐
                        │  crystallize                │──► MemoryObject writes
                        │  (back-pressure ratchet)    │    + receipts.jsonl
                        └──────────────┬──────────────┘
                                       │
                                       ▼
         ┌──── cognize (inner loop, role-schema enforced) ────────┐
         │  discover(thoughts + observations)                     │
         │    → deep_dive(candidate + observation context)        │
         │      → connect (PGS, with provenance)                  │
         │        → critique (verdict-required)                   │
         └────────────────────┬───────────────────────────────────┘
                              │
                              ▼
                     ┌────────────────────┐
                     │  close             │ — goal termination,
                     │                    │   dedupe-before-spawn,
                     │                    │   warning resolution
                     └────────┬───────────┘
                              │
                              ▼
                     ┌────────────────────┐
                     │  publish           │ — artifacts, signals,
                     │                    │   bridge-chat, dashboard,
                     │                    │   dream log
                     └────────┬───────────┘
                              │
                              ▼
                     ┌────────────────────┐
                     │  decay worker      │ — runs on own cadence,
                     │                    │   not gated by cycle
                     └────────────────────┘
```

A cycle that cannot observe is a no-op (waits and retries with jitter). A cycle that observes but cannot crystallize in N attempts triggers the back-pressure ratchet. A cycle that cognizes without a role-schema-passing output is logged and re-prompted. A cycle that closes nothing and publishes nothing is permitted (not every cycle closes), but the closer and publisher both log their idle state as observations, feeding back into discovery.

## Config Schema

Extends `HomeConfig` in `src/types.ts`:

```yaml
osEngine:
  channels:
    machine:
      enabled: true
      polls:
        cpu: 30s
        memory: 30s
        disk: 5m
        network: 1m
    os:
      enabled: true
      pm2: { events: true, poll: 30s }
      cron: { events: true }
      fswatch: { paths: [instances/, engine/, src/, docs/design/, config/] }
    domain:
      enabled: true
      readers:
        pressure: { path: ~/.pressure_log.jsonl, tail: true }
        health:   { path: ~/.health_log.jsonl, tail: true }
        sauna:    { path: ~/.sauna_usage_log.jsonl, tail: true }
    build:
      enabled: true
      git:   { poll: 1m, watch_branches: [main] }
      gh:    { pr_state: true, poll: 5m }
    work:
      enabled: true
      readers:
        agenda:       { path: brain/agenda.jsonl, tail: true }
        live_problems:{ path: brain/live-problems.json, poll: 30s }
        goals:        { path: brain/goals/, watch: true }
    neighbor:
      enabled: true
      poll: 3m
      peers: auto      # discovered from config/home.yaml agent list
  verification:
    flagRequired: true
    zeroContextAsLegal: true
  crystallization:
    backpressure:
      cyclesWithoutReceiptThreshold: 10
    confidenceCaps:
      sensor_primary: 0.95
      sensor_derived: 0.80
      build_event: 0.90
      work_event: 0.90
      neighbor_gossip: 0.70
      zero_context_audit: 0.20
  decay:
    worker:
      cadence: 30m
    halfLife:
      warning_node: 48h
      surreal_transform: 24h
      unfinished_goal_review: 72h
      unreferenced_edge: 30d
  roleIntegrity:
    enforce: true
    rejectLogPath: brain/role-integrity-violations.jsonl
  closer:
    terminationContractRequired: true
    dedupeBeforeSpawn: true
  publish:
    targets:
      workspace_insights: { cadence: 50cycles, path: workspace/insights/ }
      signals:            { cadence: on_verdict_keep }
      bridge_chat:        { salience_threshold: 0.75 }
      dashboard:          { cadence: 5m }
      dream_log:          { cadence: on_critic_keep, path: workspace/dreams/ }
    starvationFloor:
      workspace_insights: 6h
      dashboard: 15m
```

**Resolution order** (existing `loadConfig` deepMerge): `config/home.yaml` default → `instances/<agent>/config.yaml` override. Domain-channel readers are agent-specific (forrest enables health, tick doesn't); the rest default on.

## Migration Path

Additive, phased, no big-bang. Each phase is independently verifiable. Engine continuity preserved throughout.

**Phase 0 — Scaffolding (new code, no behavior change).**
- `engine/src/channels/bus.js` — empty channel bus module with register/start/stop lifecycle.
- `src/agent/verification.ts` — verification flag enum + type-guards.
- `engine/src/cognition/closer.js` — scaffold only, no-op.
- `engine/src/cognition/decay-worker.js` — scaffold only, no-op.
- Config schema added to `src/types.ts`. Defaults all `enabled: false` initially.
- Verification: engine starts, nothing observably changes, all new modules load without errors.

**Phase 1 — Promoter as first channel.** Port `src/workers/promoter.ts` to consume the bus's `notify` channel. Functionally identical. This proves the bus contract is compatible with the existing verifier-gated ingest path.
- Verification: live-problems promotion continues working. No regression in existing metrics.

**Phase 2 — Build + Work channels.** The highest-leverage first real channels, because they let jerry observe *himself*:
- `channels/build/git.js` — polls `git log`, `git status`, `git diff --shortstat`.
- `channels/build/gh.js` — polls `gh pr list`, `gh pr view` on relevant PRs.
- `channels/build/fswatch.js` — watches `docs/design/`, `config/`, `src/agent/`, `engine/src/cognition/`.
- `channels/work/agenda.js` — tails `brain/agenda.jsonl`.
- `channels/work/live-problems.js` — polls `brain/live-problems.json`.
- `channels/work/goals.js` — watches `brain/goals/*`.
- Verification enum live for these channels. `COLLECTED` default; `ZERO_CONTEXT` emitted on empty polls.
- MemoryObject writes land for the first time in jerry's brain. Dive-mode "Memory Nodes: 0" breaks within hours.

**Phase 3 — Domain channels.**
- `channels/domain/pressure.js`, `health.js`, `sauna.js` — tail readers on the JSONL files.
- Domain-specific crystallization rules (jerry crystallizes pressure trends, not every 5-min reading; forrest crystallizes health dailies and HRV outliers).
- Verification: jerry's agenda item "Investigate why health data stopped on 2026-04-13" auto-resolves against fresh health observations. The pathology that motivated this spec is observationally visible to the system itself.

**Phase 4 — Machine + OS channels.**
- Port existing `engine/src/sensors/stock/*.js` pollers to the channel bus.
- `channels/os/pm2.js`, `os/cron.js`, `os/fswatch-home23.js`.
- Verification: the engine can now name its own process state. "I have been running for 2,531,776ms" stops being a log line and starts being an observation.

**Phase 5 — Decay worker activation.**
- `decay-worker.js` implementation live. Warning decay, surreal-transform decay, unfinished-goal flagging, dead-edge weight reduction.
- Verification: the "our brain isn't right" warning node (which we know exists) gets decayed within 48h of this phase landing, and dive-mode outputs stop leaning on it.

**Phase 6 — Role integrity contract.**
- Role schemas defined in `engine/src/cognition/role-schemas.js`.
- Thinking-machine phase boundaries enforce schemas; failures log to `role-integrity-violations.jsonl`.
- Critic schema is the first hard enforcement; the cycle-1181-style surreal critic outputs get rejected.
- Verification: role-integrity-violations log shows the rejection rate, and verified-critique count climbs as the engine re-prompts.

**Phase 7 — Closer activation.**
- Goal termination contracts required on creation.
- Dedupe-before-spawn live.
- Warning resolution events flowing.
- Verification: jerry's active-goal count (previously 18 stagnant) drops as contract-less goals get rejected and new goals are required to terminate.

**Phase 8 — Neighbor protocol extension.**
- `/__state/public.json` served by harness.
- `channels/neighbor/<peer>.js` polls neighbors.
- Cross-agent dispatch hints via existing `sendMessage`.
- Verification: jerry's brain references forrest-observed events without being told; forrest observes jerry's pm2 events as neighbor channels.

**Phase 9 — Publish layer activation.**
- Workspace insights publisher on 50-cycle cadence.
- Dream-log publisher on critic-keep verdict against creative schema.
- Dashboard surface publishers replaced with observation-grounded writers.
- Starvation floors live.
- Verification: `workspace/insights/` accumulates artifacts; dashboard surfaces show provenance; bridge-chat to jtr carries high-salience observations.

Each phase produces an observable delta the brain itself will write about in its own dive-mode output. The migration is self-auditable.

## Files

**New:**
- `engine/src/channels/bus.js`
- `engine/src/channels/contract.js` — Channel interface + VerifiedObservation type
- `engine/src/channels/build/{git,gh,fswatch}.js`
- `engine/src/channels/work/{agenda,live-problems,goals,crons,heartbeat}.js`
- `engine/src/channels/domain/{pressure,health,sauna,weather}.js`
- `engine/src/channels/machine/{cpu,memory,disk,network,ports}.js` (ports existing sensors)
- `engine/src/channels/os/{pm2,cron,fswatch-home23,syslog}.js`
- `engine/src/channels/neighbor/index.js`
- `engine/src/cognition/closer.js`
- `engine/src/cognition/decay-worker.js`
- `engine/src/cognition/role-schemas.js`
- `engine/src/publish/{workspace-insights,dream-log,signals,bridge-chat,dashboard}.js`
- `src/agent/verification.ts` — VerificationFlag enum + types
- `src/agent/neighbor-state.ts` — public-state JSON generator + `/__state/public.json` route
- `src/agent/observation-ingress.ts` — bridge for harness-side observations to feed the engine's bus

**Modified:**
- `engine/src/cognition/thinking-machine.js` — cycle driver wraps in observe/crystallize/close/publish; enforces role schemas
- `engine/src/cognition/discovery-engine.js` — external-candidate injection hook; new signals (observation-delta, observation-silence, neighbor-divergence)
- `engine/src/cognition/deep-dive.js` — observation-context hook replaces stubbed conversation-context
- `engine/src/cognition/critique.js` — verdict-required output contract
- `engine/src/core/curator-cycle.js` — curator schema enforcement; cites observations
- `src/agent/memory-objects.ts` — new ingest path from bus; confidence caps per channel class; crystallization receipts
- `src/workers/promoter.ts` — becomes a channel-bus consumer (notify channel) instead of a standalone worker
- `src/sibling/protocol.ts` — adds public-state endpoint client
- `src/types.ts` — `HomeConfig.osEngine` block
- `src/home.ts` — passes osEngine config into engine + harness
- `config/home.yaml` — defaults for osEngine block
- `engine/src/index.js` — engine boot registers channel bus, decay worker, closer, publisher

**Auto-generated / gitignored:**
- `instances/<agent>/brain/channels/<class>.<id>.jsonl` — rolling channel logs
- `instances/<agent>/brain/crystallization-receipts.jsonl`
- `instances/<agent>/brain/publish-ledger.jsonl`
- `instances/<agent>/brain/role-integrity-violations.jsonl`
- `instances/<agent>/workspace/__state/public.json` — neighbor-visible state

## Verification Plan

Not "does the code compile." Verification at the behavior level, visible in the brain's own outputs:

1. **Memory Nodes > 0 within 1 hour of Phase 2.** Jerry's dive-mode `## 📚 Sources` stops reporting `Memory Nodes: 0`. Baseline: 0. Target after Phase 2: ≥ 50.
2. **Agenda self-resolution.** Jerry's "Investigate why health data stopped 2026-04-13" auto-closes against fresh health observations within the first crystallization cycle after Phase 3. Evidence: goal state transitions to `complete` with a linked observation.
3. **Warning decay visible.** The "our brain isn't right" warning class decays observably between two consecutive dive-mode runs 24h apart in Phase 5. Evidence: node weight delta.
4. **Critic schema enforcement.** Role-integrity-violations count (Phase 6) is nonzero in the first 24h, then trends toward zero as the engine re-prompts and the critic output quality improves. Evidence: violations ledger.
5. **Closure rate.** Goals-completed-per-week rises from ~0 to a measurable non-zero after Phase 7. Evidence: `brain/goals/complete/` grows.
6. **Neighbor observation flow.** Phase 8 — jerry's brain references forrest-observed events in dive-mode output without being told. Evidence: observation provenance tagged `channel: neighbor.forrest`.
7. **Publish cadence meets floor.** Phase 9 — `workspace/insights/` accumulates at ≥ 1 artifact / 6h. Evidence: file system timestamps.

Running the 2026-04-21 dive-mode queries from jerry (the three we pulled to motivate this spec) once per day through the migration gives a longitudinal read on whether the pathologies the brain named are dissolving. The brain is its own best verification instrument.

## Anti-Patterns This Replaces

- Per-turn Read-NOW.md hacks or hand-rolled "check this file first" reflex text baked into prompts (Step 23 addressed the session-start case; this addresses the continuous case).
- Sensors built as one-offs for specific user domains with no shared ingest contract.
- Cognitive cycles that mine only the accumulated thought graph and never touch external reality.
- `promote_to_memory` as the only programmatic memory-write path.
- Roles (critic, curator, discovery) whose outputs have no schema and drift into creative writing.
- Goals created without termination contracts.
- Warnings that accumulate forever, self-reinforcing.
- Agents that cannot observe each other's state beyond text messages.
- Creative capacity with no publish channel.
- Dashboard tiles that narrate state without feeding an action loop (the "do, don't just report" constraint applied engine-internally).

## Open Questions

Surfaced for the implementation-plan phase:

1. **Channel-class priority under contention.** When the bus is back-pressured, which class drops first? Default proposal: neighbor > domain > machine > OS > build > work > notify. But the right policy may be agent-specific (forrest can lose machine events easier than domain events).
2. **Crystallization cadence calibration.** "Every 50 cycles, emit an artifact" is the brain's own prescription, but cycles vary in depth. Should the ratchet be cycle-count-based, clock-based, or observation-count-based? Default proposal: observation-count-based with a cycle-count ceiling.
3. **Neighbor trust model.** When forrest's public state says `lastMemoryWrite: 2026-04-21T10:00Z` but jerry can't independently verify, does that crystallize as `UNCERTIFIED` or not at all? Default proposal: crystallize as `UNCERTIFIED` with decay.
4. **Role-schema strictness for legacy phases.** The curator cycle has been writing free-form prose for months. Phase 6 either breaks it (strict) or soft-gates it (log but don't reject). Default proposal: soft-gate for two weeks, then strict.
5. **The dream-log's relationship to the brain.** Surreal-transform outputs that pass critic-keep get published; do they also crystallize as MemoryObjects with a `creative_hypothesis` tag? Default proposal: yes, with confidence cap 0.4.

## Relationship to Prior Steps

- **Step 20** (situational-awareness engine, pre-turn brain probe + surface loading) continues to fire at the harness layer per turn. Its input expands: brain cues now include recent verified observations from the bus, and surfaces are written by the publish layer from verified data, not free-form curator prose.
- **Step 23** (session-bootstrap primitive, per-session NOW.md + PLAYBOOK.md injection) continues unchanged. The content of NOW.md becomes an observation-grounded publication target.
- **Step 19** (Telegram adaptive debounce) unchanged.
- **Steps 16, 17, 18** (COSMO research toolkit, feeder settings, OAuth) unchanged.
- The engine-harness seam documented in CLAUDE.md (engine in JS, harness in TS, PM2-managed processes per agent) is preserved. The channel bus lives in the engine; the harness exposes its side via `observation-ingress.ts` and `neighbor-state.ts`.

---

**The engine observes the world and itself through one primitive.** Discovery no longer chooses between its own thoughts and reality — reality is in the candidate pool. Verification no longer lives in prose — it is a type. Crystallization is a ratchet — no cycle without a receipt. Closure is a contract — no goal without termination. Roles have schemas. Decay is gentle and automatic. Neighbors see each other's verified states. Publication is a system metric.

The cognitive engine stops being a mind with sensors bolted on, and starts being the OS kernel the rest of Home23 has quietly become around it.
