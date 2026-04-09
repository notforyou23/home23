# CLAUDE.md — Coordinator System (engine/src/coordinator/)

This file provides guidance to Claude Code (claude.ai/code) when working on the coordination logic of COSMO 2.3.

---

## Three-Tier Coordinator Architecture

| Tier | File | Rhythm | Scope | Brain Analog |
|---|---|---|---|---|
| Executive Coordinator | `executive-coordinator.js` | Every cycle | Tactical: reality checking, coherence gating, pattern detection, agent spawn gating | Dorsolateral Prefrontal Cortex (dlPFC) |
| Meta-Coordinator | `meta-coordinator.js` | Every N cycles (default 50, bootstrap at cycle 3-5) | Strategic: goals, priorities, directives, tier spawning, deliverables audit | Strategic planning cortex |
| Action Coordinator | `action-coordinator.js` | Every 20 cycles or on plan completion | Knowledge-to-action: gap analysis, sub-agent spawning, key discovery | Motor cortex |

**Critical principle:** None execute work directly. They influence the system by injecting goals, setting priorities, generating directives, and gating agent spawns. The orchestrator reads these outputs and acts on them.

**Information flow:**
```
Meta-Coordinator (strategic, every N cycles)
    |
    |  goals, directives, priority adjustments
    v
Executive Coordinator (tactical, every cycle)  <--  coherence feedback  <--  agent results
    |
    |  CONTINUE / SKIP / REDIRECT / BLOCK / ESCALATE
    v
Orchestrator (spawns agents, executes plan)
    |
    v
Action Coordinator (knowledge -> action, every 20 cycles)
    |  sub-agent spawns, gap analysis
    v
Agent Executor
```

---

## Executive Coordinator (`executive-coordinator.js`)

### Four Nested Classes

| Class | Brain Analog | Purpose |
|---|---|---|
| `ExecutiveCoordinator` | dlPFC | Main executive function: reality checks, coherence tracking, intervention decisions, agent spawn gating |
| `ActionSelector` | Basal Ganglia | Goal selection with commitment: max 3 active goals, utility scoring, suppression of alternatives |
| `DefinitionOfDone` | Quality gates | Contract-based validation per agent type: required/optional fields, accomplishment scoring |
| `ErrorMonitor` | Anterior Cingulate Cortex (ACC) | 11 structured error types, pattern detection, intervention recommendations |
| `EvaluationHarness` | Micro-CI | Quick validation checks (artifact exists, schema valid, evidence coverage) |

### Main Entry Point: `decideCycleAction(context)`

Called every cycle by the orchestrator. Returns a decision object with one of 5 action types.

**4-Step Process:**

```
STEP 1: assessCurrentReality(context)
    |-- checkPreconditions()    Phase-gated requirements (guided only)
    |-- checkProgress()         Accomplishment rate in last 5 actions
    |-- checkPatterns()         Tool-building, stuck, validation loops
    |-- checkMissionAlignment() LLM check every N cycles (expensive)
    |
    v
STEP 2: decideIntervention() [if reality check failed]
    |-- Maps failure severity to decision type
    |-- Updates coherenceScore
    |-- Records intervention
    |
    v
STEP 3: ActionSelector.selectAction() [if reality check passed]
    |-- Check existing commitments (continue or break)
    |-- Score candidate goals by utility
    |-- Commit to highest-utility goal (max 3 active)
    |
    v
STEP 4: gateAgentSpawn() [if proposedAgent exists]
    |-- 5 precondition checks by agent type
    |-- Returns allow/deny with optional redirect
```

### Five Decision Types

| Decision | When | Effect in Orchestrator |
|---|---|---|
| `CONTINUE_NORMAL` | Coherence maintained, spawn allowed | Normal cycle, agents spawn |
| `SKIP` | No viable goals, or spawn denied without redirect | Skip agent spawning this cycle |
| `REDIRECT` | Spawn denied but alternative available | Spawns redirected agent spec instead |
| `BLOCK_AND_INJECT` | Precondition failure (guided mode) | Blocks spawn, injects urgent goal via MetaCoordinator |
| `EMERGENCY_ESCALATE` | Zero progress with no active agents | Triggers MetaCoordinator emergency review, injects urgent goal |
| `LOG_WARNING` | Mission misalignment or emergency cooldown | Logs warning, optionally injects lower-priority goal |

### Reality Checks (4 checks in `assessCurrentReality`)

**1. Preconditions (`checkPreconditions`)**

Enforces phase-gated requirements in guided mode. Skipped entirely in autonomous mode.

| Phase | Requires |
|---|---|
| Phase 2 (Analysis) | At least 1 artifact or file created in recent actions |
| Phase 3 (Synthesis) | At least 2 completed `document_analysis` agents |
| Phase 4 (Documentation) | At least 1 completed `synthesis` agent |

**2. Progress (`checkProgress`)**

Requires >= 5 actions before assessment. Looks at last 5 completion-type actions.

| Condition | Autonomous | Guided |
|---|---|---|
| 0/5 accomplished, no active agents | CRITICAL: `EMERGENCY_ESCALATE` | CRITICAL: `EMERGENCY_ESCALATE` |
| 0/5 accomplished, agents still working | Pass (wait) | Pass (wait) |
| < 20% accomplished | Pass (warning only) | FAIL (blocking) |
| < 40% accomplished | Pass | FAIL (blocking) |

**3. Patterns (`checkPatterns`)**

Examines last 10 completion-type actions for three anti-patterns:

| Pattern | Detection | Autonomous | Guided |
|---|---|---|---|
| Tool-building loop | >= 6 `code_creation` and 0 `code_execution` | Allowed (capability dev) | Blocked |
| Stuck loop | Same agent type failing >= 5 times | Blocked, adds to `knownBlockers` | Blocked |
| Validation loop | >= 3 QA agents, 0 artifact creators | Blocked | Blocked |

**4. Mission Alignment (`checkMissionAlignment`)**

LLM call every `alignmentCheckInterval` cycles (default 5). Uses domain anchor to filter meta-pollution. 250 max tokens, temp 0.1, 15s timeout. Returns JSON `{ aligned, confidence, gap, recommendation }`.

### Coherence Score Mechanics

Floating point 0.0-1.0, starts at 1.0. Threshold: `coherenceThreshold` (default 0.5).

| Event | Math | Example |
|---|---|---|
| Agent success | `+0.05` (capped at 1.0) | 0.8 -> 0.85 |
| Agent failure | `x 0.95` | 0.8 -> 0.76 |
| 3 consecutive failures | `x 0.85` (additional) | 0.76 -> 0.646 |
| Zero progress escalation | `x 0.7` | 0.8 -> 0.56 |
| Precondition failure | `x 0.85` | 0.8 -> 0.68 |
| Pattern failure | `x 0.8` | 0.8 -> 0.64 |
| Alignment failure | `x 0.9` | 0.8 -> 0.72 |
| Capability success | `+0.02` | 0.8 -> 0.82 |
| Capability failure | `x 0.98` | 0.8 -> 0.784 |

When coherence drops below threshold (0.5) after 3 consecutive failures, triggers `escalate: true` from `recordAgentCompletion()`.

### Agent Spawn Gating: 5 Checks

`gateAgentSpawn(agentSpec, context)` runs after reality check passes. Returns `{ allow, reason, redirect }`.

| Check | Agent Type | Condition | Result |
|---|---|---|---|
| 1 | `document_analysis` | No accessible source documents in allowed paths | Deny + redirect to analyze `runtime/outputs/` |
| 2 | `quality_assurance` | No artifacts produced in last 5 cycles | Deny |
| 3 | `code_execution` | No `code_creation` agent in last 10 cycles | Deny |
| 4 | `ide` | No `workspaceRoot` configured | Deny |
| 5 | Any (learned) | Agent type in `knownBlockers` within 20 cycles | Deny |

### ActionSelector (Basal Ganglia)

Implements striatal gating: commit to small active set, suppress rest.

**Configuration:**

| Key | Default | Purpose |
|---|---|---|
| `executiveRing.maxActiveGoals` | 3 | Maximum concurrent committed goals |
| `executiveRing.maxConcurrentAgents` | 2 | Maximum concurrent agents |
| `executiveRing.commitmentCycles` | 10 | Minimum cycles before breaking commitment |

**Selection algorithm:**

1. Check existing commitments. If active, continue highest-utility committed goal
2. Break commitment if `progressRate < 0.05` AND `cyclesCommitted >= commitmentCycles`
3. Broken commitments get suppressed for 20 cycles
4. For new selection: score all non-suppressed goals by utility, commit to highest

**Utility formula:**
```
utility = (value * confidence) / cost
```

Where:
- `value` = goal.priority (0-1, default 0.5)
- `confidence` = `estimateSuccessProbability()`: base 0.8, penalized by missing preconditions (x0.2 no docs, x0.3 no code) and historical success rate
- `cost` = `estimateCost()`: estimated cycles by agent type (research=3, document_analysis=2, code_creation=5, code_execution=4, synthesis=3, analysis=2, ide=4)

### DefinitionOfDone Contracts

Validates agent results against type-specific contracts. Each contract defines `required` and `optional` fields with criteria (`min`, `equals`, `oneOf`).

| Agent Type | Required Fields | Optional Fields |
|---|---|---|
| `document_analysis` | `documentsAnalyzed >= 1`, `results.length >= 1` | `insightsGenerated >= 1`, `relationshipsFound >= 0` |
| `code_creation` | `filesCreated >= 1`, `status === 'complete'` | `syntaxValid === true`, `documentationIncluded === true` |
| `code_execution` | `executionAttempted === true` | `outputFiles >= 0`, `testsRun >= 0` |
| `research` | `findings.length >= 3` | `sourcesFound >= 5`, `urlsValid >= 3` |
| `synthesis` | `reportGenerated === true` | `wordCount >= 500`, `crossReferences >= 3` |
| `document_creation` | `filesCreated >= 1` | `wordCount >= 500` |
| `ide` | `status in ['complete', 'completed']` | `filesModified >= 1`, `operationCount >= 1` |

Score = `1 - (requiredViolations / requiredCount)`. Passed = zero required violations.

When DoD fails, `agentResult.accomplishment` is overridden to `accomplished: false`.

### ErrorMonitor (Anterior Cingulate Cortex)

**11 Error Types:**

| Code | Description |
|---|---|
| `E_NO_INPUT` | Required input missing |
| `E_EMPTY_OUTPUT` | Agent produced no output |
| `E_LOW_CONFIDENCE` | Output confidence below threshold |
| `E_SCHEMA_FAIL` | Output schema validation failed |
| `E_TIMEOUT` | Agent exceeded time limit |
| `E_CONTRADICTION` | Output contradicts known facts |
| `E_DUPLICATE` | Output already exists |
| `E_CITATION_MISSING` | Required citations missing |
| `E_PRECONDITION` | Preconditions not met |
| `E_STUCK_LOOP` | Repeating same failure |
| `E_SEMANTIC_GAP` | Mission-reality mismatch |

Error history capped at 100 entries. `recommendIntervention()` triggers when same error type appears 5+ times in last 20 errors.

### EvaluationHarness (Micro-CI)

Runs three checks on every agent result:

1. **`checkArtifactExists`** — If agent type is `code_creation` or `document_creation`, requires files in metadata
2. **`checkSchemaValid`** — Checks `metadata.validationStatus` for syntax errors
3. **`checkEvidenceCoverage`** — Insights require supporting findings

Score = passedChecks / totalChecks. If score < 0.5, overrides `accomplishment` to failed.

Also contains `evaluateAction()` and `recordCapabilityOutcome()` for capability-level (file/terminal) action gating. These reuse the same coherence/blocker/success pattern infrastructure as agent-level checks.

### Guided vs Autonomous Mode Differences

`isAutonomousMode(context)`: true if no `context.mission` and no `this.missionContext`.

| Behavior | Autonomous | Guided |
|---|---|---|
| Phase preconditions | Skipped | Enforced |
| Progress threshold | 20% (warning only, passes) | 40% (blocking) |
| Tool-building pattern | Allowed (capability development) | Blocked |
| Emergency escalation | Same | Same |
| Agent type inference | Pattern matching by text | IDE-first if `ideFirst.enabled` |

---

## Integration with Orchestrator

### Initialization (`orchestrator.js:413`)

```js
if (this.config.executiveRing?.enabled !== false) {
  this.executiveRing = new ExecutiveCoordinator(this.config, this.logger, this);
  if (this.guidedPlan) {
    await this.executiveRing.initialize(this.guidedPlan);
  }
}
```

Capabilities are initialized immediately after, receiving `this.executiveRing` for gating.

### Every Cycle (`orchestrator.js:1627`)

Phase 13 of `executeCycle()`:

1. `gatherExecutiveContext()` builds context from cluster state store, goal selection, active tasks
2. `executiveRing.decideCycleAction(executiveContext)` returns decision
3. `executeExecutiveDecision(decision, context)` handles the decision
4. If decision is `SKIP`, `BLOCK_AND_INJECT`, or `EMERGENCY_ESCALATE`, sets `executiveSkipSpawning = true` which prevents autonomous goal agent spawning for that cycle

### Agent Completion (`orchestrator.js:1086`)

Phase 2 of `executeCycle()`:

1. `agentExecutor.processCompletedResults()` collects finished agents
2. For each result: `executiveRing.recordAgentCompletion(agentResult, { cycleCount })`
3. `recordAgentCompletion` runs DoD validation, EvaluationHarness, ErrorMonitor classification
4. Updates coherence score based on accomplishment
5. If returns `{ escalate: true }` (coherence < threshold after 3 failures), triggers `coordinator.emergencyReview()`

### `executeExecutiveDecision()` (`orchestrator.js:4227`)

| Decision | Orchestrator Action |
|---|---|
| `REDIRECT` | Spawns `decision.redirect` via `agentExecutor.spawnAgent()` |
| `SKIP` | Logs only; caller skips spawn |
| `BLOCK_AND_INJECT` | Calls `coordinator.injectUrgentGoals([decision.urgentGoal], this.goals)` |
| `EMERGENCY_ESCALATE` | Calls `coordinator.emergencyReview()` AND `coordinator.injectUrgentGoals()` |
| `LOG_WARNING` | Logs warning with reason and recommendation |

### `gatherExecutiveContext()` (`orchestrator.js:4324`)

Builds the context object passed to `decideCycleAction()`:

```js
{
  cycleCount,
  mission: this.guidedPlan || null,
  currentPhase: currentTask?.milestoneId || null,
  currentTask,              // First IN_PROGRESS task from plan:main
  proposedAgent: {          // From goals.selectGoalToPursue()
    agentType, goalId, description, priority, metadata
  },
  systemState: {
    activeTasks,            // All IN_PROGRESS tasks
    completedAgents,        // Count from registry
    activeAgents,           // Count from registry
    goals,                  // All current goals
    energy,                 // From stateModulator
    coherenceScore,         // From executiveRing itself
    memorySize, edgeSize, clusterSize
  }
}
```

### State Save (`orchestrator.js:7431`)

```js
executiveRing: this.executiveRing ? this.executiveRing.getStats() : null
```

Saves the `getStats()` return object into `state.json.gz`.

### State Restore (`orchestrator.js:8051`)

```js
if (state.executiveRing && this.executiveRing) {
  this.executiveRing.coherenceScore = state.executiveRing.coherenceScore || 1.0;
  this.executiveRing.recentActions = state.executiveRing.recentActions || [];
  this.executiveRing.interventions = state.executiveRing.recentInterventions || [];
}
```

Note: only `coherenceScore`, `recentActions`, and `interventions` are restored. `knownBlockers`, `successPatterns`, `actionSelector` state, `errorMonitor` history, and `missionContext` are NOT persisted across restarts.

---

## Meta-Coordinator (`meta-coordinator.js`)

### Trigger Logic

`shouldRunReview(cycleCount)`: Bootstrap at cycle 3-5 (when `lastReviewCycle === 0`). Subsequently every `reviewInterval` cycles (default 50 from `config.coordinator.reviewCyclePeriod`).

### Review Phases (`conductReview`)

1. **Cognitive analysis** -- Groups journal by role, samples last 20 thoughts, detects repetitive themes (25% threshold). Uses `TemplateReportGenerator` (zero API cost) when `config.useTemplateReports` is set, else LLM.

2. **Goal portfolio evaluation** -- LLM at strategic model, high reasoning effort, 25k tokens. Extracts up to 5 prioritized goal IDs.

3. **Agent results** -- Reads `results_queue.jsonl`. Collects insight/finding items per agent.

4. **Plan review** -- Queries `ClusterStateStore` for `plan:main`, calls LLM for `PlanDelta` JSON suggestions.

5. **Deliverables audit** -- Semantic audit from ClusterStateStore or filesystem walk of `runtime/outputs/`. Detects gaps: `missing_implementation`, `missing_validation`, `no_deliverables`.

6. **Memory analysis** -- Analyzes top-activated nodes and strongest edges. LLM identifies emerging domains.

7. **System health** -- Reads `cognitiveState`, `oscillator.currentMode`, success/failure counts. No LLM.

8. **Strategic decisions** -- Most expensive call: strategic model, high reasoning effort, 16k tokens. Outputs: `prioritizedGoals`, `keyInsights`, `strategicDirectives`, `urgentGoals`.

9. **Report generation** -- Structured report assembled and saved. No LLM.

### Post-Review Actions

- **Urgent goal injection** into `IntrinsicGoalSystem` with `metadata.strategicPriority = true`
- **Insights-to-goals conversion** from curated insights reports
- **Executable commands** (heuristic, not LLM): `mergeGoals`, `focusMode`, `stopNewGoals`, `consolidateAgents`, `repairPlanStall`
- **Async insight curation** (fire-and-forget)

### Guided Mode Behavior

- `initiateMission()` delegates to `GuidedModePlanner`, spawns deferred agents after plan display
- In `makeStrategicDecisions`: injects work-in-progress context, runs three deduplication checks against guided plan phases, active agents, and existing goals

---

## Action Coordinator (`action-coordinator.js`)

### Trigger

Every 20 cycles (`config.actionCoordinator.triggerCyclePeriod`), on plan completion, or force trigger.

### Five-Phase Cycle

1. **Context gathering** -- 11 streams: PGS query, domain, plans, thoughts (last 50), goals, surprises, memory, agents, artifacts, voice (last 20), executive state
2. **Gap analysis** -- PGS gaps, unrealized goals (satisfaction < 0.5), missing capabilities, voice signal pattern matching
3. **Strategic decision** -- LLM at strategic model, temp 0.7, 4k tokens. Returns `{ shouldAct, action, subAgents, rationale, successCriteria, risks, feedback }`
4. **Action execution** -- Spawns sub-agents sequentially via `orchestrator.agentExecutor.spawnAgent()`. Maps: `discovery` -> `research`, `construction` -> `ide`, `deployment` -> `code_execution`
5. **Completion report** -- Reports to MetaCoordinator and Executive Ring (both currently TODO stubs), integrates artifacts into memory (TODO stub)

### Key Discovery System

Three-part pipeline:
- `KeyKnowledgeBase` -- Persistent catalog at `<coordinatorDir>/key-knowledge-base.json`
- `KeyValidator` -- Tests API calls for key validity
- `KeyMiner` -- Mines GitHub/StackOverflow/Reddit for publicly shared API keys

---

## Configuration

### Executive Ring Config Keys

All under `config.executiveRing`:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable/disable the entire executive coordinator |
| `useLLM` | `true` | Enable mission alignment LLM checks |
| `coherenceThreshold` | `0.5` | Coherence score below which emergency triggers |
| `alignmentCheckInterval` | `5` | Cycles between LLM alignment checks |
| `stuckLoopThreshold` | `5` | Failures of same agent type to detect stuck loop |
| `toolBuildingThreshold` | `6` | `code_creation` count to detect tool-building loop |
| `maxActiveGoals` | `3` | ActionSelector: max committed goals |
| `maxConcurrentAgents` | `2` | ActionSelector: max concurrent agents |
| `commitmentCycles` | `10` | ActionSelector: min cycles before breaking commitment |

### Meta-Coordinator Config Keys

All under `config.coordinator`:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable/disable meta-coordinator |
| `reviewCyclePeriod` | `50` | Cycles between strategic reviews |
| `enableCodingAgents` | `true` | Allow code_creation/code_execution agent spawning |
| `useTemplateReports` | `false` | Use zero-cost template generator instead of LLM |

### Action Coordinator Config Keys

All under `config.actionCoordinator`:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable/disable action coordinator |
| `triggerCyclePeriod` | `20` | Cycles between action runs |

---

## State Shape (`getStats()` Return Object)

The object returned by `ExecutiveCoordinator.getStats()` and saved to `state.json.gz`:

```js
{
  coherenceScore: 0.85,              // Float 0-1
  interventionsTotal: 3,             // Lifetime intervention count
  recentInterventions: [             // Last 5 interventions
    {
      cycle: 12,
      action: 'SKIP',
      reason: 'Low progress: Only 1/5...',  // Truncated to 100 chars
      coherenceScore: 0.72
    }
  ],
  recentActions: [                   // Last 10 agent completions
    {
      cyclesAgo: 2,
      agentType: 'research',
      accomplished: true,
      documentsAnalyzed: 0,
      artifactCount: 5
    }
  ],
  knownBlockers: [                   // Learned failure patterns
    {
      agentType: 'document_analysis',
      reason: 'Repeated failures',
      count: 5,
      lastSeen: 15                   // Cycle number
    }
  ],
  successPatterns: [                 // Learned success patterns
    {
      agentType: 'research',
      successCount: 4,
      lastSuccess: 18
    }
  ],
  missionContext: {                  // Null if autonomous
    domain: 'quantum computing',
    description: '...',
    executionMode: 'guided-exclusive',
    startedAt: 1710000000000,
    phases: [...]
  },
  suppressedGoalsCount: 2,          // ActionSelector stats
  committedGoalsCount: 1,
  activeCommitments: ['goal-abc'],
  errorStats: {                     // ErrorMonitor stats
    total: 12,
    recent20Count: 8,
    byType: { E_EMPTY_OUTPUT: 3, E_NO_INPUT: 2 },
    topError: ['E_EMPTY_OUTPUT', 3]
  }
}
```

---

## Known Gaps

1. **`evaluateAction()` not called externally.** The `EvaluationHarness.evaluateAction()` method (line 1893) exists for capability-level action gating but is defined on `EvaluationHarness`, not `ExecutiveCoordinator`. The Capabilities system would need to call it via the executive ring reference, but the current wiring routes through `ExecutiveCoordinator` which doesn't expose it.

2. **WebSocket emission not wired.** The executive decisions and coherence events are logged but not emitted via WebSocket to the dashboard. The `events` emitter is available on MetaCoordinator and ActionCoordinator but not on ExecutiveCoordinator.

3. **`knownBlockers` not used in utility calculation.** `ActionSelector.calculateUtility()` uses `estimateSuccessProbability()` which checks goal metadata and historical success rates, but does NOT consult `ExecutiveCoordinator.knownBlockers`. Blockers are only checked in `gateAgentSpawn()` (after selection).

4. **REDIRECT handler spawns but doesn't track.** `executeExecutiveDecision()` for `REDIRECT` spawns a redirected agent but doesn't record that it was a redirect. The spawned agent goes through normal flow with no provenance marking.

5. **Action Coordinator feedback channels are stubs.** `reportToMetaCoordinator()`, `reportToExecutiveRing()`, and `integrateArtifacts()` are all TODO stubs that only log.

6. **State restore is incomplete.** Only `coherenceScore`, `recentActions`, and `interventions` are restored from saved state. `knownBlockers`, `successPatterns`, `actionSelector` (commitments, suppressions), `errorMonitor` history, `missionContext`, and `EvaluationHarness` state are all lost on restart.

7. **Emergency escalation cooldown uses fixed 10 cycles.** Not configurable via `executiveRing` config.

---

## Context Providers (`context-providers.js`)

Eight lightweight adapters wrapping existing COSMO systems for ActionCoordinator:

`GoalsContextProvider`, `MemoryContextProvider`, `PlansContextProvider`, `ThoughtsContextProvider`, `SurprisesContextProvider`, `AgentsContextProvider`, `ArtifactsContextProvider`, `VoiceContextProvider`, `ExecutiveContextProvider`, `PGSContextProvider`

`PGSContextProvider.query()` is simplified -- analyzes memory directly, does not call real PGS engine.

---

## Supporting Components

### Template Generator (`template-generator.js`)
Zero-API-cost cognitive analysis via statistics. Three quality scores (Depth, Novelty, Coherence) from 1-10. Used when `config.coordinator.useTemplateReports === true`.

### Insights Parser (`insights-parser.js`)
Parses curated markdown reports into structured objects. Extracts Goal Alignment & Next Steps, Technical/Strategic/Operational Insights with `actionability`, `strategicValue`, `novelty` scores.

### Strategic Goals Tracker (`strategic-goals-tracker.js`)
Tracks urgent goals MetaC creates. Escalates priority (+0.15, capped at 0.99) after 3 cycles ignored. Max age: 10 cycles before marking stale.

---

## State-Driven Coordination (Critical Principle)

Coordinators NEVER call `orchestrator.spawnAgent()` directly during the main review cycle. Instead:
1. Inject goals into `IntrinsicGoalSystem` with metadata flags
2. Return `reviewRecord` with `prioritizedGoals`, `decisions`, `commands`
3. Orchestrator reads commands and executes them
4. Executive Coordinator gates spawns each cycle via `SKIP`/`REDIRECT` returns

The only exception: `MessageHandlers` system in MetaC handles async agent-to-agent spawn requests.

---

## Voice Channel

All coordinators support `[VOICE]: message` in LLM output. Parsed via regex, emitted as `cosmo_voice` events. Stripped from output. Prefixed with `[Strategic]` or `[Executive]`.

---

## Domain Anchor

All LLM prompts include a domain anchor (from `../utils/domain-anchor`) that focuses analysis on the user's research domain and explicitly filters "meta-pollution" about COSMO internals.
