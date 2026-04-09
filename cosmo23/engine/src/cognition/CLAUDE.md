# CLAUDE.md — Cognitive Brain Layers (engine/src/cognition/, goals/, planning/, coordinator/)

This file provides guidance to Claude Code (claude.ai/code) when working on COSMO 2.3's higher-level cognitive architecture — the brain-mapped layers from specialist execution through metacognition.

---

## The Brain-Layer Model

COSMO's architecture maps onto three concentric rings, explicitly named in `executive-coordinator.js` line 17: "OUTER RING: Dashboard (human consciousness)", "MIDDLE RING: Executive Coordinator + Meta-Coordinator", "INNER RING: Specialist agents (narrow cognition)."

---

## Inner Ring — Specialist Execution (Worker Neurons)

**Files:** `engine/src/agents/base-agent.js`, `agent-executor.js`, and all agent types

Agents are narrow specialists receiving mission specs, executing, and writing results. They do NOT decide what to do — that authority lives in the middle ring.

**Lifecycle:** `initialized → running → completed | failed | timeout`

**Communication:** Receives mission specs from `AgentExecutor.spawnAgent()`. Sends results upward via `AgentResultsQueue`, findings directly to `NetworkMemory`, events to dashboard.

---

## Middle Ring — Executive Function

### ExecutiveCoordinator — Tactical Gate, Every Cycle

**File:** `engine/src/coordinator/executive-coordinator.js`

**Brain mapping:** dlPFC (dorsolateral prefrontal cortex). Works with `ActionSelector` (basal ganglia) and `errorMonitor` (anterior cingulate cortex).

**`decideCycleAction(context)`** — every cycle:
1. `assessCurrentReality()` — precondition checks, progress checks, pattern detection
2. If incoherent → `decideIntervention()` → `SKIP`, `REDIRECT`, or directive
3. `ActionSelector.selectAction(goals)` — selects which goal to pursue
4. `gateAgentSpawn(proposedAgent)` — may block or redirect

**State:** `missionContext`, `recentActions[]` (last 10), `coherenceScore` (0-1), `knownBlockers` Map, `emergencyEscalationCooldown` (10 cycles).

**Mode detection:** `isAutonomousMode()` = true when no `context.mission`. Guided mode adjusts thresholds (40% progress required vs 20% autonomous).

### MetaCoordinator — Strategic, Every 50 Cycles

**File:** `engine/src/coordinator/meta-coordinator.js`

Reviews accumulated thoughts, goals, memory patterns. Prioritizes goals. Generates strategic directives. Does NOT spawn agents directly — signals intent through the goal system.

**Sub-components:** `TemplateReportGenerator`, `StrategicGoalsTracker` (escalates ignored goals after 3 cycles), `InsightsParser`.

**Cluster-awareness:** Each instance has a `specializationProfile` keyed to `INSTANCE_ID` for domain-biased goal routing.

### ActionCoordinator — Knowledge-to-Action, Every 20 Cycles

**File:** `engine/src/coordinator/action-coordinator.js`

Self-described as "Giving hands to the brain." The ONE coordinator that directly spawns agents. Gathers 11 context streams, makes `claude-opus-4` decision, spawns sub-agents if `shouldAct: true`.

**Key Discovery System:** Owns `KeyKnowledgeBase`, `KeyValidator`, `KeyMiner` for autonomously acquiring API credentials.

### GuidedModePlanner — Run Once at Startup

**File:** `engine/src/core/guided-mode-planner.js`

Creates structured plan with milestones and tasks in `ClusterStateStore`. Tier system: Tier 0 (collectors) → Tier 1 (processors) → Tier 2 (creators) → Tier 3 (validators).

**Resume logic:** Existing active plan with any PENDING/CLAIMED/IN_PROGRESS/FAILED/BLOCKED tasks → resume with state audit. Only generates new plan when no active work exists.

---

## Middle Ring — Goal and Motivation System (Drive)

### IntrinsicGoalSystem (`engine/src/goals/intrinsic-goals.js`)

Autonomous drive system. Goals emerge from the system's own thinking via `discoverGoals(journal, memory)`. Lifecycle: nascent → active → maturing → completed | archived. Cluster-aware priority with specialization multipliers (default 2x boost, 0.1x penalty).

### GoalCaptureSystem (`engine/src/goals/goal-capture.js`)

Two-pass goal extraction: pattern matching (curiosity markers, TODO/GOAL, question sentences, uncertainty phrases) + GPT-5-mini AI analysis for outputs > 100 chars.

**Surprise detection:** `detectSurprise(output)` returns 0-1 score from: surprise keywords, output length, question marks, conditionals, vocabulary richness. Feeds `ThermodynamicController` and `TrajectoryForkSystem`.

### GoalCurator (`engine/src/goals/goal-curator.js`)

Higher-order goal organization. Every `curationInterval` (20) cycles:
1. Campaign creation from stagnant goals (5+, never pursued, 5min+ old)
2. Goal merging (Jaccard ≥ 0.75, max 5 per cycle)
3. Goal synthesis (3+ mature goals → higher-level objective)
4. Memory bridging for orphaned goals
5. Campaign progress updates

Tracks goal narratives: birth, events, deliverables, completion summaries.

### TopicQueueSystem (`engine/src/goals/topic-queue.js`)

File polling **disabled** ("use guided mode instead"). Programmatic `injectTopic()` still works.

### PlanScheduler (`engine/src/planning/plan-scheduler.js`)

Guided mode task selection. Priority scoring: `basePriority * specializationWeight * urgencyMultiplier`. Atomic claim with 10-min TTL. Work-stealing for expiring claims. Retries FAILED/BLOCKED tasks.

### AcceptanceValidator (`engine/src/planning/acceptance-validator.js`)

Three validation types: `literal` (pattern match), `tool` (command execution), `qa` (spawn QA agent with real file evidence up to 200KB).

---

## Outer Ring — Metacognition and Self-Awareness

### CognitiveStateModulator (`engine/src/cognition/state-modulator.js`)

**Brain mapping:** "Emotional and Neuromodulatory Influences."

**Four state variables:**
- `curiosity` (0-1): rises with surprise, controls exploration bias
- `mood` (0-1): +0.1 per success, -0.15 per failure, biases memory recall
- `energy` (0-1): drains 0.02/cycle active, recovers 0.05/cycle sleeping
- `mode`: `active | wandering | sleeping | reflecting`

**Mode transitions:**
- energy < 0.2 → sleeping
- energy > 0.8 while sleeping → active (0.5 = safety net force-wake)
- surpriseAccumulator > 5.0 → reflecting
- curiosity < 0.3 && energy > 0.5 for 5+ min → wandering

**Per-mode thinking parameters:**

| Mode | Temperature | ExplorationBias | MemoryDepth | ShouldThink |
|---|---|---|---|---|
| active | 0.7 + curiosity*0.4 | curiosity | 5 | true |
| wandering | 1.0 + curiosity*0.3 | 0.8 | 3 | true |
| reflecting | 0.6 | 0.3 | 10 | true |
| sleeping | 1.2 | 1.0 | 8 | false |

**Memory recall bias:** `biasMemoryRecall()` multiplies weights by `1 + (mood - 0.5) * 0.5`. Positive mood amplifies positive memories.

### DynamicRoleSystem (`engine/src/cognition/dynamic-roles.js`)

Roles are persistent prompt configurations for thought generation — NOT agents. Each role has `prompt` (autonomous), `promptGuided` (domain-anchored), `promptPure` (minimal "You are thinking.").

**Three exploration modes:** `autonomous` (full instructional), `guided` (domain-anchored), `pure` (minimal prompting).

**`getRole(roleId, executionContext)`:** `independent` returns clean `basePrompt` (prevents guided contamination for intrinsic goals).

**Role evolution:** When `successRate < successThreshold` after 5+ uses and 1+ hour since last evolution, GPT-5.2 rewrites the prompt. Meta-cognition about cognition.

### QuantumReasoner (`engine/src/cognition/quantum-reasoner.js`)

Parallel hypothesis generation. `Promise.all()` generates N hypotheses concurrently with different epistemic perspectives (analytical, creative, practical, critical, synthetic). Domain anchor mandatory on every branch.

**Collapse strategies:** `best` (GPT-5-mini selection), `weighted` (score-based probabilistic), `voting` (heuristic sort).

**BranchPolicyController integration:** Epsilon-greedy bandit (ε=0.2) learns which reasoning effort levels produce higher rewards. Winner branch gets 70% of reward. Persists to `runtime/policies/branch-policy.json`.

**LatentProjector integration:** Compresses memory embeddings + goal descriptions into compact hint injected into branch prompts. Auto-trains from `runtime/training/latent-dataset.jsonl` after 100 samples.

**Quantum tunneling:** 2% chance per cycle. GPT-5.2 + web search generates creative conceptual leap unrelated to current context.

### TrajectoryForkSystem (`engine/src/cognition/trajectory-fork.js`)

Background sub-trajectory exploration. Spawns when `surprise ≥ 0.35` or `uncertainty ≥ 0.6` or explicit fork intent in text.

**Limits:** Max 3 concurrent, max depth 2, 5-cycle limit per fork.

**Lifecycle:** spawn → explore (query memory, quantum reason, store `[FORK:{id}]` tagged thoughts) → complete (2+ insights or 3+ converging thoughts) → consolidate (GPT-5.2 synthesis → `[FORK_RESULT:{id}]` memory node).

### ThermodynamicController (`engine/src/cognition/thermodynamic.js`)

Free energy principle. `freeEnergy` (0-1) tracks prediction error.
- `freeEnergy < target * 0.7` → `shouldSeekNovelty()` (too predictable)
- `freeEnergy > target * 1.3` → `shouldReduceUncertainty()` (too surprising)
- Low entropy (variance < 0.1) → `inject_chaos`

Annealing cycle: linear decay from hot→cold temperature over N steps, then reset.

### IntrospectionModule (`engine/src/system/introspection.js`)

Scans `outputs/` for new files, writes previews to memory as `[INTROSPECTION]` nodes. Zero GPT calls — pure file I/O. Content density gate (< 0.3 score = skip). Deduplicates by filename. Checkpoint-based (survives restarts).

---

## Temporal System

### FocusExplorationOscillator (`engine/src/temporal/oscillator.js`)

Pomodoro-style pacing. Focus (5 min, temp 0.7, priority goals) ↔ Explore (1 min, temp 1.1, random goals). Execute mode entered externally for productive bursts.

Adaptive: high fatigue shortens focus; stagnation forces exploration; strong progress extends focus.

### TemporalRhythms (`engine/src/temporal/rhythms.js`)

Sleep/wake at hour scale. States: `awake | sleeping | dreaming`.

**Sleep triggers:** Every 100 cycles (guaranteed) OR energy < 0.15 / fatigue > 0.7 (emergency). 10-min minimum awake debounce.

**Dream mode:** `temperature: 1.3`, adds `associate` operations (random cross-concept bridges) to normal `strengthen`/`prune` consolidation.

**Awake oscillation:** Fast phase (5 min, active, temp 0.9) ↔ Slow phase (2 min, contemplative, temp 0.7).

---

## The Core Invariant: Influence via State, Not Commands

Coordinators do NOT call `agentExecutor.spawnAgent()` directly (except ActionCoordinator). The flow:

1. **MetaCoordinator** → creates/modifies goals, adjusts priorities
2. **Goal state changes** → orchestrator reads high-priority goals
3. **ExecutiveCoordinator** → gates proposed spawn (allow/skip/redirect)
4. **Orchestrator** → calls `agentExecutor.spawnAgent()`

**If you're adding coordination logic:** inject goals or modify priorities. Do NOT reach across layers to call spawning APIs.

---

## Information Flow

### Upward (execution → cognition)
```
Agent completes → outputs/ files + memory nodes + ResultsQueue
  → IntrospectionModule scans outputs → [INTROSPECTION] memory nodes
  → AgentExecutor.processCompletedResults() → goals + memory integration
  → GoalCaptureSystem.detectSurprise() → score
    → ThermodynamicController updates freeEnergy
    → CognitiveStateModulator updates mood/energy/curiosity
    → TrajectoryForkSystem may spawn fork if surprise ≥ 0.35
  → MetaCoordinator review (every 50 cycles) → reprioritize goals
```

### Downward (cognition → execution)
```
CognitiveStateModulator → thinking parameters (temp, bias, depth)
Oscillator → focus/explore mode
DynamicRoleSystem.executeRole() → GPT-5.2 thought generation
QuantumReasoner.generateSuperposition() → parallel hypotheses
GoalCaptureSystem → new goals in IntrinsicGoalSystem
MetaCoordinator → goal priorities + strategic directives
ExecutiveCoordinator.decideCycleAction() → allow/skip/redirect
Orchestrator → agentExecutor.spawnAgent(mission)
```

---

## How Guided Mode Changes the Stack

### Activates
- GuidedModePlanner creates plan at startup
- PlanScheduler drives task selection
- AcceptanceValidator validates completions
- ExecutiveCoordinator receives mission context, enters guided mode

### Changes behavior
- All roles use `promptGuided` with domain anchor
- QuantumReasoner always domain-anchors branches
- GoalCurator filters "meta-pollution" (QA gates, probes, CLI tools)
- TopicQueue polling disabled

### Stays active unchanged
- CognitiveStateModulator, TrajectoryForkSystem, ThermodynamicController
- TemporalRhythms, Oscillator, IntrospectionModule
- MetaCoordinator (with mission context), ExecutiveCoordinator (more active)

### Context isolation
`getRole(roleId, 'independent')` returns clean `basePrompt` — allows intrinsic exploration without guided contamination. Both streams (guided tasks + autonomous curiosity) coexist intentionally.

---

## Common Pitfalls

1. **Never add direct spawning calls in coordinator code.** Use goal injection. The executive gate is the coherence-checking layer.
2. **`pure` mode strips ALL instructional framing.** Check `explorationMode === 'pure'` before injecting instructions.
3. **`independent` execution context prevents guided contamination.** Do not override with guided prompt.
4. **Domain anchor is mandatory** for all LLM calls in goal-curator, goal-capture, quantum-reasoner that involve selection/synthesis. Missing it causes "meta-pollution."
5. **Sleep recovery needs both CognitiveStateModulator AND TemporalRhythms.** `skipModeCheck: true` prevents premature waking during sleep cycles.
6. **BranchPolicyController state persists across sessions.** Reset if you change reward semantics.
7. **GuidedModePlanner resume includes FAILED/BLOCKED tasks as "active work."** Intentional — PlanScheduler retries them.
8. **BranchPolicyController and LatentProjector are feature-gated.** Check `config.reasoning.features.*.enabled` before use.
