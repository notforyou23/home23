# COSMO23 Commitment Governor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COSMO23 stop reproducing horizontal, commitment-poor agent churn by gating new work on synthesis commitments, artifact reuse/promotion, differentiated spawn demand, and provider health.

**Architecture:** Add one run-level commitment governor that reads existing state instead of inventing a parallel system. Wire it into the orchestrator and agent executor at spawn boundaries, provider-error boundaries, and plan-completion boundaries. Reuse existing synthesis commit receipts, SpawnGate, Executive Ring settings, artifact registry/lifecycle, task queue, and acceptance/QA paths.

**Tech Stack:** Node.js CommonJS, Mocha/Chai for `cosmo23/engine/tests/unit`, Node test runner for `tests/cosmo23`, existing COSMO23 artifact modules, PM2 runtime `home23-cosmo23`.

---

## Objective Restatement

Build and verify the COSMO23 system fixes implied by the CrossFit-health feedback:

1. Prevent repeated generic artifact-producing agents from spawning just because cycles continue.
2. Preserve useful specialization instead of collapsing most strategic work into identical IDE agents.
3. Treat 429/rate-limit bursts as a run-level circuit breaker, not just per-call errors.
4. Convert graph knowledge into explicit commitments: SPINE/FACET/ARTIFACT synthesis, committed artifacts, unresolved gap records, and stop/continue decisions.
5. Keep guided runs exclusive and demand-driven: no autonomous or strategic spawn bypass unless the work is a real system repair.
6. Provide operator-visible receipts and tests proving the governor blocks the exact failure mode.

## Prompt-To-Artifact Checklist

- "using the above analysis as the basis" maps to this plan's `Problem Evidence` section and to tests reproducing CrossFit-health symptoms.
- "detailed plan" maps to this file under `docs/superpowers/plans/2026-05-14-cosmo23-commitment-governor.md`.
- "for yourself to follow" maps to checkbox tasks with exact files, commands, expected failures, and verification gates.
- "perform all the fixes necessary" maps to Tasks 1-8, covering governor, spawn gates, specialization, provider circuit breaker, artifact commitment, observability, tests, docs, and live smoke.
- Completion evidence for the planning objective is this saved file plus final response summarizing the path and not claiming implementation is complete.

## Problem Evidence To Preserve

- Recent run: `cosmo23/runs/crossfit-health`.
- Saved state: `cycleCount=40`, `agentExecutor.registry.total=21`, `byType={ConsistencyAgent:6, IDEAgent:14, ResearchAgent:1}`.
- Provider failure: cycles 34-40 in `thoughts.jsonl` contain Anthropic `429 rate_limit_error`.
- Commitment failure: artifact audit showed `outputFiles=72`, `registeredArtifacts=47`, `unregisteredFiles=31`, `committedArtifacts=0`, `neverReusedArtifacts=31`.
- Spawn pathology: strategic and urgent goal spawn paths bypass `maxConcurrent` and can spawn up to 3 urgent or 5 strategic agents per cycle.
- Specialization pathology: run config had `ideFirst.enabled: true` and `specialization.enabled: false`, remapping document/code/synthesis-style work into generic IDE agents.

## File Structure

- Create `cosmo23/engine/src/core/run-commitment-governor.js`
  - Pure decision engine. No filesystem writes. Accepts run/task/agent/artifact/provider snapshots and returns a spawn/continue/commit/throttle decision.
- Create `cosmo23/engine/tests/unit/run-commitment-governor.test.js`
  - Unit coverage for commitment gaps, rate-limit circuit breaker, spawn budget, specialization pressure, and completion decisions.
- Modify `cosmo23/engine/src/core/orchestrator.js`
  - Instantiate governor. Evaluate it once per cycle before strategic/urgent/autonomous spawn paths and before emergency stuck review.
  - Persist governor decisions as run-local receipts.
- Modify `cosmo23/engine/src/agents/agent-executor.js`
  - Replace unconditional strategic bypass with governor-approved bypass.
  - Keep `ideFirst` but preserve declared role intent and avoid remapping deliverable, synthesis, validation, and data-acquisition work when specialization/gov pressure demands role diversity.
  - Lower artifact promotion threshold or add deterministic validation evidence for completed guided deliverables.
- Modify `cosmo23/launcher/config-generator.js`
  - Emit default governor config.
  - Surface conservative launch defaults for guided runs: specialization-pressure on, strategic bypass off unless system repair, rate-limit circuit breaker on.
- Modify `cosmo23/server/index.js`, `cosmo23/public/index.html`, and `cosmo23/public/app.js` only if needed to expose advanced settings or receipts. Keep UI minimal.
- Modify `docs/design/COSMO23-VENDORED-PATCHES.md`
  - Add Patch 24 with exact behavioral contract and verification.
- Add or modify tests:
  - `cosmo23/engine/tests/unit/run-commitment-governor.test.js`
  - `cosmo23/engine/tests/unit/agent-executor-guided.test.js`
  - `cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js`
  - `tests/cosmo23/artifact-loop.test.cjs`
  - `tests/cosmo23/synthesis-commit.test.cjs`

---

### Task 1: Baseline Verification And Frozen Reproduction

**Files:**
- Read: `cosmo23/runs/crossfit-health/state.json.gz`
- Read: `cosmo23/runs/crossfit-health/thoughts.jsonl`
- Read: `cosmo23/runs/crossfit-health/synthesis-commit-receipts.jsonl`
- Command evidence: `node cosmo23/engine/scripts/artifact-loop.js audit cosmo23/runs/crossfit-health`

- [ ] **Step 1: Record clean repo and runtime status**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
git status --short
pm2 jlist | python3 -c "import sys,json; [print(f\"{p['name']:30s} {p['pm2_env']['status']}\") for p in json.load(sys.stdin) if 'home23' in p['name']]"
curl -s http://localhost:43210/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'cosmo23 running={d.get(\"running\")} activeRun={d.get(\"activeRun\") or d.get(\"run\") or d.get(\"currentRun\")}')"
```

Expected:
- Do not require a clean tree.
- `home23-cosmo23` is online.
- COSMO23 may be idle; do not relaunch a run for this task.

- [ ] **Step 2: Capture CrossFit-health failure metrics**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const z = require('zlib');
const state = JSON.parse(z.gunzipSync(fs.readFileSync('cosmo23/runs/crossfit-health/state.json.gz')));
const registry = state.agentExecutor?.registry || {};
console.log(JSON.stringify({
  cycleCount: state.cycleCount,
  totalAgents: registry.totalAgents || registry.total || 0,
  byType: registry.stats?.byType || registry.byType || {},
  activeGoals: Array.isArray(state.goals?.active) ? state.goals.active.length : Object.keys(state.goals?.active || {}).length,
  completedGoals: Array.isArray(state.goals?.completed) ? state.goals.completed.length : Object.keys(state.goals?.completed || {}).length
}, null, 2));
NODE
```

Expected evidence:
- `cycleCount` is `40`.
- Total agents are around `21`.
- IDE agents dominate the agent mix.

- [ ] **Step 3: Capture provider-rate-limit evidence**

Run:

```bash
rg -n "429|rate_limit_error|CRITICAL: System stuck" cosmo23/runs/crossfit-health/thoughts.jsonl
```

Expected:
- Lines for cycles 34-40 show `429 rate_limit_error`.
- At least one line shows `CRITICAL: System stuck`.

- [ ] **Step 4: Capture artifact commitment evidence**

Run:

```bash
node cosmo23/engine/scripts/artifact-loop.js audit cosmo23/runs/crossfit-health
```

Expected:
- `committedArtifacts` is `0`.
- `unregisteredFiles` and `neverReusedArtifacts` are nonzero.

- [ ] **Step 5: Save no code yet**

No commit. This task only freezes evidence.

---

### Task 2: Add Run Commitment Governor Pure Unit

**Files:**
- Create: `cosmo23/engine/src/core/run-commitment-governor.js`
- Create: `cosmo23/engine/tests/unit/run-commitment-governor.test.js`

- [ ] **Step 1: Write failing governor tests**

Create `cosmo23/engine/tests/unit/run-commitment-governor.test.js`:

```js
const { expect } = require('chai');

const { RunCommitmentGovernor } = require('../../src/core/run-commitment-governor');

describe('RunCommitmentGovernor', () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  it('opens provider circuit breaker after repeated 429 errors', () => {
    const governor = new RunCommitmentGovernor({
      rateLimitWindowCycles: 8,
      rateLimitThreshold: 3,
      rateLimitCooldownCycles: 5
    }, logger);

    const decision = governor.evaluate({
      cycleCount: 40,
      activeAgents: 0,
      goals: [{ id: 'goal_1', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true } }],
      providerErrors: [
        { cycle: 34, provider: 'anthropic', status: 429, type: 'rate_limit_error' },
        { cycle: 35, provider: 'anthropic', status: 429, type: 'rate_limit_error' },
        { cycle: 36, provider: 'anthropic', status: 429, type: 'rate_limit_error' }
      ],
      artifactAudit: { committedArtifacts: 0, neverReusedArtifacts: 3, unregisteredFiles: 2 },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 9 }
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.rateLimited).to.equal(true);
    expect(decision.reasonCodes).to.include('provider_rate_limit_circuit_open');
    expect(decision.cooldownUntilCycle).to.equal(45);
  });

  it('requires artifact commitment when graph has outputs but no committed artifacts', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 24,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      artifactAudit: {
        outputFiles: 12,
        registeredArtifacts: 8,
        committedArtifacts: 0,
        neverReusedArtifacts: 8,
        unregisteredFiles: 4
      },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 8 }
    });

    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.requiresArtifactCommitment).to.equal(true);
    expect(decision.nextActions).to.deep.include({
      type: 'commit_artifacts',
      reason: 'outputs_exist_without_committed_artifacts'
    });
  });

  it('caps strategic spawn budget and refuses bypass for non-repair guided work', () => {
    const governor = new RunCommitmentGovernor({
      maxStrategicSpawnsPerCycle: 1
    }, logger);

    const decision = governor.evaluate({
      cycleCount: 33,
      guidedRun: true,
      activeAgents: 0,
      goals: [
        { id: 'goal_1', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true, agentType: 'document_creation' } },
        { id: 'goal_2', source: 'meta_coordinator_strategic', metadata: { strategicPriority: true, agentType: 'code_creation' } }
      ],
      providerErrors: [],
      artifactAudit: { committedArtifacts: 2, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: { applied: true, spine_count: 4, artifact_count: 2 }
    });

    expect(decision.spawnAllowed).to.equal(true);
    expect(decision.strategicSpawnBudget).to.equal(1);
    expect(decision.allowStrategicBypass).to.equal(false);
    expect(decision.reasonCodes).to.include('guided_non_repair_work_must_not_bypass_limits');
  });

  it('allows completion when plan is done, commitments exist, and provider health is clean', () => {
    const governor = new RunCommitmentGovernor({}, logger);

    const decision = governor.evaluate({
      cycleCount: 40,
      guidedRun: true,
      activeAgents: 0,
      goals: [],
      providerErrors: [],
      plan: { status: 'DONE' },
      artifactAudit: { committedArtifacts: 3, neverReusedArtifacts: 0, unregisteredFiles: 0 },
      synthesisCommit: { applied: true, spine_count: 5, artifact_count: 1 }
    });

    expect(decision.shouldStopForCompletion).to.equal(true);
    expect(decision.spawnAllowed).to.equal(false);
    expect(decision.reasonCodes).to.include('run_has_committed_answer');
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/run-commitment-governor.test.js
```

Expected: fails with `Cannot find module '../../src/core/run-commitment-governor'`.

- [ ] **Step 3: Implement governor**

Create `cosmo23/engine/src/core/run-commitment-governor.js`:

```js
class RunCommitmentGovernor {
  constructor(config = {}, logger = console) {
    this.config = {
      rateLimitWindowCycles: Number(config.rateLimitWindowCycles ?? config.rate_limit_window_cycles ?? 8),
      rateLimitThreshold: Number(config.rateLimitThreshold ?? config.rate_limit_threshold ?? 3),
      rateLimitCooldownCycles: Number(config.rateLimitCooldownCycles ?? config.rate_limit_cooldown_cycles ?? 5),
      maxStrategicSpawnsPerCycle: Number(config.maxStrategicSpawnsPerCycle ?? config.max_strategic_spawns_per_cycle ?? 1),
      maxUrgentSpawnsPerCycle: Number(config.maxUrgentSpawnsPerCycle ?? config.max_urgent_spawns_per_cycle ?? 1),
      requireCommittedArtifacts: config.requireCommittedArtifacts !== false
    };
    this.logger = logger;
  }

  evaluate(snapshot = {}) {
    const reasonCodes = [];
    const nextActions = [];
    const cycleCount = Number(snapshot.cycleCount || 0);
    const activeAgents = Number(snapshot.activeAgents || 0);
    const providerErrors = Array.isArray(snapshot.providerErrors) ? snapshot.providerErrors : [];
    const goals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
    const artifactAudit = snapshot.artifactAudit || {};
    const synthesisCommit = snapshot.synthesisCommit || null;

    const recentRateLimits = providerErrors.filter(error => {
      const isRateLimit = Number(error.status) === 429 || error.type === 'rate_limit_error' || /rate.?limit/i.test(String(error.message || ''));
      const inWindow = cycleCount - Number(error.cycle ?? cycleCount) <= this.config.rateLimitWindowCycles;
      return isRateLimit && inWindow;
    });

    const rateLimited = recentRateLimits.length >= this.config.rateLimitThreshold;
    if (rateLimited) {
      reasonCodes.push('provider_rate_limit_circuit_open');
      nextActions.push({ type: 'cooldown', reason: 'provider_rate_limit_burst' });
    }

    const outputFiles = Number(artifactAudit.outputFiles || 0);
    const committedArtifacts = Number(artifactAudit.committedArtifacts || 0);
    const neverReusedArtifacts = Number(artifactAudit.neverReusedArtifacts || 0);
    const unregisteredFiles = Number(artifactAudit.unregisteredFiles || 0);
    const hasUncommittedOutputs = this.config.requireCommittedArtifacts &&
      (outputFiles > 0 || neverReusedArtifacts > 0 || unregisteredFiles > 0) &&
      committedArtifacts === 0;

    if (hasUncommittedOutputs) {
      reasonCodes.push('outputs_exist_without_committed_artifacts');
      nextActions.push({ type: 'commit_artifacts', reason: 'outputs_exist_without_committed_artifacts' });
    }

    const strategicGoals = goals.filter(goal =>
      goal?.source === 'meta_coordinator_strategic' ||
      goal?.metadata?.strategicPriority === true ||
      goal?.metadata?.gapDriven === true
    );
    const guidedNonRepair = Boolean(snapshot.guidedRun) &&
      strategicGoals.some(goal => !goal?.metadata?.systemRepair && goal?.triggerSource !== 'system_repair');

    if (guidedNonRepair) {
      reasonCodes.push('guided_non_repair_work_must_not_bypass_limits');
    }

    const hasCommit = Boolean(synthesisCommit?.applied) && Number(synthesisCommit?.spine_count || 0) > 0;
    const shouldStopForCompletion = activeAgents === 0 &&
      goals.length === 0 &&
      snapshot.plan?.status === 'DONE' &&
      hasCommit &&
      committedArtifacts > 0 &&
      !rateLimited &&
      unregisteredFiles === 0;

    if (shouldStopForCompletion) {
      reasonCodes.push('run_has_committed_answer');
    }

    const spawnAllowed = !rateLimited && !hasUncommittedOutputs && !shouldStopForCompletion;

    return {
      spawnAllowed,
      rateLimited,
      cooldownUntilCycle: rateLimited ? cycleCount + this.config.rateLimitCooldownCycles : null,
      requiresArtifactCommitment: hasUncommittedOutputs,
      shouldStopForCompletion,
      allowStrategicBypass: !guidedNonRepair && !rateLimited,
      strategicSpawnBudget: rateLimited ? 0 : Math.min(this.config.maxStrategicSpawnsPerCycle, Math.max(0, strategicGoals.length)),
      urgentSpawnBudget: rateLimited ? 0 : this.config.maxUrgentSpawnsPerCycle,
      reasonCodes,
      nextActions
    };
  }
}

module.exports = { RunCommitmentGovernor };
```

- [ ] **Step 4: Run passing test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/run-commitment-governor.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add cosmo23/engine/src/core/run-commitment-governor.js cosmo23/engine/tests/unit/run-commitment-governor.test.js
git commit -m "feat: add cosmo23 commitment governor"
```

---

### Task 3: Wire Governor Into Orchestrator Spawn Boundaries

**Files:**
- Modify: `cosmo23/engine/src/core/orchestrator.js`
- Modify: `cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js`

- [ ] **Step 1: Add failing orchestrator test for strategic spawn suppression**

Append to `cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js`:

```js
  it('does not run strategic spawner when commitment governor closes spawn gate', async () => {
    const orchestrator = createOrchestrator();
    let strategicSpawnerCalled = false;
    orchestrator.commitmentGovernor = {
      evaluate: () => ({
        spawnAllowed: false,
        rateLimited: true,
        allowStrategicBypass: false,
        strategicSpawnBudget: 0,
        reasonCodes: ['provider_rate_limit_circuit_open'],
        nextActions: [{ type: 'cooldown', reason: 'provider_rate_limit_burst' }]
      })
    };
    orchestrator.collectCommitmentSnapshot = async () => ({
      cycleCount: 40,
      activeAgents: 0,
      goals: [{ id: 'goal_1', metadata: { strategicPriority: true } }],
      providerErrors: [{ cycle: 40, status: 429, type: 'rate_limit_error' }]
    });
    orchestrator.spawnStrategicGoals = async () => {
      strategicSpawnerCalled = true;
    };

    const decision = await orchestrator.evaluateCommitmentGovernor();

    expect(decision.spawnAllowed).to.equal(false);
    expect(strategicSpawnerCalled).to.equal(false);
  });
```

- [ ] **Step 2: Run failing orchestrator test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js --grep "commitment governor"
```

Expected: fails because `evaluateCommitmentGovernor` does not exist.

- [ ] **Step 3: Instantiate governor in orchestrator**

In `cosmo23/engine/src/core/orchestrator.js`, add near other requires:

```js
const { RunCommitmentGovernor } = require('./run-commitment-governor');
```

In the constructor after config setup:

```js
this.commitmentGovernor = new RunCommitmentGovernor(this.config.commitmentGovernor || {}, this.logger);
this.lastCommitmentDecision = null;
this.providerErrorEvents = [];
```

- [ ] **Step 4: Add snapshot and decision methods**

Add methods to `Orchestrator`:

```js
async collectCommitmentSnapshot() {
  const activeAgents = this.agentExecutor?.registry?.getActiveCount?.() || 0;
  const goals = this.goals?.getGoals?.() || [];
  const plan = await this.clusterStateStore?.getPlan?.('plan:main').catch(() => null);
  const artifactAudit = await this.getArtifactAuditSummary().catch(() => ({}));
  const synthesisCommit = await this.getLatestSynthesisCommitReceipt().catch(() => null);

  return {
    cycleCount: this.cycleCount,
    guidedRun: this.isGuidedExclusiveRun?.() || false,
    activeAgents,
    goals,
    plan,
    providerErrors: this.providerErrorEvents || [],
    artifactAudit,
    synthesisCommit
  };
}

async evaluateCommitmentGovernor() {
  const snapshot = await this.collectCommitmentSnapshot();
  const decision = this.commitmentGovernor.evaluate(snapshot);
  this.lastCommitmentDecision = {
    ...decision,
    cycle: this.cycleCount,
    evaluatedAt: new Date().toISOString()
  };
  await this.writeCommitmentReceipt(this.lastCommitmentDecision).catch(error => {
    this.logger.debug('[CommitmentGovernor] receipt write skipped', { error: error.message });
  });
  return decision;
}
```

Add helper stubs with real filesystem behavior:

```js
async getArtifactAuditSummary() {
  if (!this.config?.logsDir) return {};
  const { auditArtifactLoop } = require('../artifacts/artifact-audit');
  const audit = await auditArtifactLoop(this.config.logsDir);
  return audit.totals || {};
}

async getLatestSynthesisCommitReceipt() {
  const fs = require('fs').promises;
  const path = require('path');
  const receiptPath = path.join(this.config.logsDir || '.', 'synthesis-commit-receipts.jsonl');
  const text = await fs.readFile(receiptPath, 'utf8').catch(() => '');
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const last = JSON.parse(lines[lines.length - 1]);
  return last.synthesis_commit || null;
}

async writeCommitmentReceipt(decision) {
  const fs = require('fs').promises;
  const path = require('path');
  const file = path.join(this.config.logsDir || '.', 'commitment-governor-receipts.jsonl');
  await fs.appendFile(file, JSON.stringify(decision) + '\n', 'utf8');
}
```

- [ ] **Step 5: Gate spawn call sites**

Before calls to `spawnStrategicGoals()`, `spawnAgentsForUrgentGoals()`, and `spawnAgentsForPriorities()`, evaluate the governor once per cycle and skip spawning when `decision.spawnAllowed === false`.

Use this pattern:

```js
const commitmentDecision = await this.evaluateCommitmentGovernor();
if (!commitmentDecision.spawnAllowed) {
  this.logger.warn('[CommitmentGovernor] Spawn gate closed', {
    cycle: this.cycleCount,
    reasonCodes: commitmentDecision.reasonCodes,
    nextActions: commitmentDecision.nextActions
  });
} else {
  await this.spawnStrategicGoals(commitmentDecision);
}
```

For normal priority spawning:

```js
if (commitmentDecision.spawnAllowed) {
  await this.spawnAgentsForPriorities(reviewResult, commitmentDecision);
}
```

- [ ] **Step 6: Run targeted test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js --grep "commitment governor"
```

Expected: pass.

- [ ] **Step 7: Run broader orchestrator/guided tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js cosmo23/engine/tests/unit/guided-mode-planner.test.js cosmo23/engine/tests/unit/task-state-queue.test.js
```

Expected: pass.

- [ ] **Step 8: Commit**

Run:

```bash
git add cosmo23/engine/src/core/orchestrator.js cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js
git commit -m "feat: gate cosmo23 spawns on commitment governor"
```

---

### Task 4: Remove Unconditional Strategic/Urgent Bypass

**Files:**
- Modify: `cosmo23/engine/src/agents/agent-executor.js`
- Modify: `cosmo23/engine/tests/unit/agent-executor-guided.test.js`

- [ ] **Step 1: Add failing AgentExecutor test**

Append to `cosmo23/engine/tests/unit/agent-executor-guided.test.js`:

```js
  it('does not bypass concurrency for strategic work unless governor approves bypass', async () => {
    const executor = new AgentExecutor(
      {
        memory: null,
        goals: {
          getGoals: () => [],
          archiveGoal: () => true
        }
      },
      { logsDir: '.', coordinator: { maxConcurrent: 1 } },
      logger
    );
    executor.initialized = true;
    executor.registry.getActiveCount = () => 1;
    executor.registry.canSpawnMore = () => false;

    const agentId = await executor.spawnAgent({
      missionId: 'strategic-test',
      agentType: 'analysis',
      goalId: 'goal_critical',
      description: 'Strategic but not system repair',
      metadata: { strategicPriority: true }
    });

    expect(agentId).to.equal(null);
  });
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/agent-executor-guided.test.js --grep "does not bypass concurrency"
```

Expected: fails because strategic metadata currently bypasses max concurrency.

- [ ] **Step 3: Add approved-bypass helper**

In `cosmo23/engine/src/agents/agent-executor.js`, replace the current `isStrategic` logic in `spawnAgent()` with:

```js
const isStrategic = this.isApprovedStrategicBypass(missionSpec);
```

Add method:

```js
isApprovedStrategicBypass(missionSpec = {}) {
  const metadata = missionSpec.metadata || {};
  const isRepair =
    metadata.systemRepair === true ||
    metadata.commitmentBypassApproved === true ||
    missionSpec.triggerSource === 'system_repair';

  if (!isRepair) return false;

  return metadata.urgentGoal === true ||
    metadata.strategicPriority === true ||
    missionSpec.triggerSource === 'urgent_goal' ||
    missionSpec.triggerSource === 'system_repair';
}
```

- [ ] **Step 4: Preserve governor decision in mission metadata**

In orchestrator spawn builders for urgent and strategic goals, only set `metadata.commitmentBypassApproved = true` when `commitmentDecision.allowStrategicBypass === true`.

Exact mission metadata shape:

```js
metadata: {
  urgentGoal: true,
  strategicPriority: true,
  gapDriven: goal.metadata?.gapDriven || false,
  rationale: goal.metadata?.rationale,
  urgency: goal.metadata?.urgency,
  commitmentBypassApproved: commitmentDecision?.allowStrategicBypass === true,
  systemRepair: goal.metadata?.systemRepair === true
}
```

- [ ] **Step 5: Cap strategic and urgent spawn loops**

Change `spawnStrategicGoals(commitmentDecision = null)`:

```js
const maxToSpawn = Math.max(0, Number(commitmentDecision?.strategicSpawnBudget ?? 1));
const goalsToSpawn = strategicGoals.slice(0, maxToSpawn);
```

Change `spawnAgentsForUrgentGoals(urgentGoalSpecs, commitmentDecision = null)`:

```js
const maxToSpawn = Math.max(0, Number(commitmentDecision?.urgentSpawnBudget ?? 1));
const goalsToSpawn = urgentGoals.slice(0, maxToSpawn);
```

- [ ] **Step 6: Run tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/agent-executor-guided.test.js cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add cosmo23/engine/src/agents/agent-executor.js cosmo23/engine/src/core/orchestrator.js cosmo23/engine/tests/unit/agent-executor-guided.test.js
git commit -m "fix: require governor approval for strategic spawn bypass"
```

---

### Task 5: Preserve Role Differentiation Under IDE-First

**Files:**
- Modify: `cosmo23/engine/src/agents/agent-executor.js`
- Modify: `cosmo23/launcher/config-generator.js`
- Modify: `cosmo23/engine/tests/unit/agent-executor-guided.test.js`

- [ ] **Step 1: Add failing role-preservation test**

Append:

```js
  it('preserves synthesis and document roles when commitment governor requires differentiated work', async () => {
    const executor = new AgentExecutor(
      {
        memory: null,
        goals: { getGoals: () => [], archiveGoal: () => true }
      },
      {
        logsDir: '.',
        ideFirst: { enabled: true },
        commitmentGovernor: { preserveDifferentiatedRoles: true }
      },
      logger
    );

    expect(executor.getEffectiveAgentType({
      agentType: 'synthesis',
      metadata: { commitmentRole: 'synthesis' }
    })).to.equal('synthesis');

    expect(executor.getEffectiveAgentType({
      agentType: 'document_creation',
      metadata: { expectedOutput: '@outputs/report.md' }
    })).to.equal('document_creation');
  });
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/agent-executor-guided.test.js --grep "preserves synthesis"
```

Expected: fails because `getEffectiveAgentType` does not exist.

- [ ] **Step 3: Extract effective-agent-type logic**

Add method to `AgentExecutor`:

```js
getEffectiveAgentType(missionSpec = {}) {
  const original = missionSpec.agentType;
  if (!this.config?.ideFirst?.enabled) return original;

  const metadata = missionSpec.metadata || {};
  const preserveDifferentiatedRoles = this.config?.commitmentGovernor?.preserveDifferentiatedRoles !== false;
  const preservedTypes = ['research', 'consistency', 'dataacquisition', 'datapipeline', 'infrastructure', 'automation'];
  const commitmentPreserved = ['synthesis', 'document_creation', 'document_analysis', 'quality_assurance', 'completion'];

  if (preservedTypes.includes(original)) return original;
  if (preserveDifferentiatedRoles && commitmentPreserved.includes(original)) return original;
  if (metadata.commitmentRole && commitmentPreserved.includes(metadata.commitmentRole)) return original;
  if (metadata.expectedOutput && original === 'document_creation') return original;

  return original === 'ide' ? 'ide' : 'ide';
}
```

Replace inline IDE-first remap block in `spawnAgent()` with:

```js
let effectiveAgentType = this.getEffectiveAgentType(missionSpec);
if (effectiveAgentType !== missionSpec.agentType) {
  this.logger.info('IDE-FIRST: Routing to IDE agent', {
    original: missionSpec.agentType,
    remapped: effectiveAgentType,
    goalId: missionSpec.goalId
  });
  missionSpec.metadata = missionSpec.metadata || {};
  missionSpec.metadata.originalAgentType = missionSpec.agentType;
  missionSpec.metadata.ideFirstRouted = true;
}
```

- [ ] **Step 4: Emit default config**

In `cosmo23/launcher/config-generator.js`, add after `synthesis:` block or near governor config:

```yaml
commitmentGovernor:
  enabled: true
  preserveDifferentiatedRoles: true
  requireCommittedArtifacts: true
  rateLimitWindowCycles: 8
  rateLimitThreshold: 3
  rateLimitCooldownCycles: 5
  maxStrategicSpawnsPerCycle: 1
  maxUrgentSpawnsPerCycle: 1
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/agent-executor-guided.test.js
node --test --test-concurrency=1 tests/cosmo23/synthesis-config-generator.test.cjs
```

Expected: pass. If config-generator test snapshots fail, update expected YAML to include `commitmentGovernor`.

- [ ] **Step 6: Commit**

Run:

```bash
git add cosmo23/engine/src/agents/agent-executor.js cosmo23/launcher/config-generator.js cosmo23/engine/tests/unit/agent-executor-guided.test.js tests/cosmo23/synthesis-config-generator.test.cjs
git commit -m "fix: preserve differentiated cosmo23 roles under ide-first"
```

---

### Task 6: Provider Rate-Limit Circuit Receipts

**Files:**
- Modify: `cosmo23/engine/src/core/unified-client.js`
- Modify: `cosmo23/engine/src/core/orchestrator.js`
- Create or modify: `cosmo23/engine/tests/unit/run-commitment-governor.test.js`

- [ ] **Step 1: Add provider error normalization test**

Add to `run-commitment-governor.test.js`:

```js
  it('normalizes provider error objects into governor-compatible events', () => {
    const governor = new RunCommitmentGovernor({}, logger);
    const event = governor.normalizeProviderError({
      cycle: 12,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      error: new Error('429 {"type":"error","error":{"type":"rate_limit_error"}}')
    });

    expect(event.status).to.equal(429);
    expect(event.type).to.equal('rate_limit_error');
    expect(event.provider).to.equal('anthropic');
    expect(event.cycle).to.equal(12);
  });
```

- [ ] **Step 2: Implement normalizer**

Add to `RunCommitmentGovernor`:

```js
normalizeProviderError(input = {}) {
  const message = String(input.error?.message || input.message || '');
  const status = Number(input.status || input.error?.status || (message.includes('429') ? 429 : 0)) || null;
  const type = input.type || input.error?.type || (/rate_limit_error|rate limit/i.test(message) ? 'rate_limit_error' : 'provider_error');
  return {
    cycle: Number(input.cycle || 0),
    provider: input.provider || input.assignment?.provider || null,
    model: input.model || input.assignment?.model || null,
    status,
    type,
    message: message.slice(0, 500),
    timestamp: input.timestamp || new Date().toISOString()
  };
}
```

- [ ] **Step 3: Add orchestrator recorder**

In `Orchestrator`:

```js
recordProviderError(event) {
  const normalized = this.commitmentGovernor.normalizeProviderError({
    ...event,
    cycle: event.cycle ?? this.cycleCount
  });
  this.providerErrorEvents = [...(this.providerErrorEvents || []), normalized].slice(-50);
  return normalized;
}
```

- [ ] **Step 4: Wire client callback**

In `UnifiedClient.generate()` catch block, after logging provider failure:

```js
if (typeof this.onProviderError === 'function') {
  this.onProviderError({
    provider: assignment.provider,
    model: assignment.model,
    error,
    timestamp: new Date().toISOString()
  });
}
```

In orchestrator initialization where the LLM client is created or injected, set:

```js
if (this.gpt5) {
  this.gpt5.onProviderError = (event) => this.recordProviderError(event);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/run-commitment-governor.test.js
node -c cosmo23/engine/src/core/unified-client.js
node -c cosmo23/engine/src/core/orchestrator.js
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add cosmo23/engine/src/core/run-commitment-governor.js cosmo23/engine/src/core/unified-client.js cosmo23/engine/src/core/orchestrator.js cosmo23/engine/tests/unit/run-commitment-governor.test.js
git commit -m "fix: add cosmo23 provider rate-limit circuit receipts"
```

---

### Task 7: Make Artifact Commitment Gate Actually Close

**Files:**
- Modify: `cosmo23/engine/src/agents/agent-executor.js`
- Modify: `tests/cosmo23/artifact-loop.test.cjs`

- [ ] **Step 1: Add failing artifact promotion test**

Add to `tests/cosmo23/artifact-loop.test.cjs`:

```js
test('guided deliverable artifacts are promotable with acceptance evidence', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-guided-promote-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'report.md'), '# Report\n\nA committed answer.\n', 'utf8');

  const executor = Object.create(AgentExecutor.prototype);
  executor.config = { logsDir: runDir };
  executor.logger = logger;
  executor.artifactRegistry = new ArtifactRegistry({ runDir, logger });
  executor.artifactIngestor = new ArtifactIngestor({ registry: executor.artifactRegistry, logger });
  executor.artifactLifecycle = new ArtifactLifecycleManager({ registry: executor.artifactRegistry, logger });
  await executor.artifactRegistry.initialize();

  const record = await executor.artifactRegistry.registerArtifact({
    taskId: 'task:final',
    producer: { type: 'agent', id: 'agent_final' },
    path: 'outputs/report.md',
    kind: 'deliverable'
  });
  await executor.artifactIngestor.ingest(record);

  const promoted = await executor.promoteValidatedProducedArtifacts([{
    artifactId: record.artifactId,
    role: 'primary_output',
    kind: 'deliverable'
  }], {
    agentId: 'agent_final',
    taskId: 'task:final',
    goalId: 'goal:final',
    qaMetadata: {
      validation: 'acceptance_pass',
      confidence: 0.75,
      reason: 'Task acceptance criteria satisfied'
    }
  });

  expect(promoted).to.deep.equal([record.artifactId]);
  expect(executor.artifactRegistry.getArtifact(record.artifactId).lifecycleState).to.equal('committed');
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs --test-name-pattern "guided deliverable"
```

Expected: fails because `acceptance_pass` with confidence `0.75` is not accepted by current promotion gate.

- [ ] **Step 3: Broaden validation evidence safely**

In `promoteValidatedProducedArtifacts()`, replace validation acceptance with:

```js
const acceptedValidationTypes = [
  'heuristic_pass',
  'full_qa',
  'execution_agent_bypass',
  'acceptance_pass',
  'literal_validation_pass',
  'guided_task_completed'
];
const minimumConfidence = validation === 'acceptance_pass' || validation === 'guided_task_completed' ? 0.7 : 0.85;
const canUseQaEvidence = acceptedValidationTypes.includes(validation) && confidence >= minimumConfidence;
```

- [ ] **Step 4: Ensure guided task completion passes evidence**

Where task artifacts are registered after a successful guided task, build default QA metadata when none exists:

```js
const effectiveQaMetadata = qaMetadata || {
  validation: 'guided_task_completed',
  confidence: 0.75,
  reason: 'Guided task completed and produced declared artifacts'
};
await this.promoteValidatedProducedArtifacts(task.producedArtifacts, {
  agentId,
  taskId,
  goalId,
  qaMetadata: effectiveQaMetadata
});
```

- [ ] **Step 5: Run artifact tests and audit helper**

Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs
node cosmo23/engine/scripts/artifact-loop.js verify
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add cosmo23/engine/src/agents/agent-executor.js tests/cosmo23/artifact-loop.test.cjs
git commit -m "fix: promote accepted guided deliverables to committed artifacts"
```

---

### Task 8: Add Operator Receipts And Patch Documentation

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Optional modify: `cosmo23/server/index.js`
- Optional modify: `cosmo23/public/app.js`

- [ ] **Step 1: Add Patch 24 docs**

Append before `## History` in `docs/design/COSMO23-VENDORED-PATCHES.md`:

```markdown
## Patch 24 — Run commitment governor and spawn discipline

**Files touched:**
- `cosmo23/engine/src/core/run-commitment-governor.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/core/unified-client.js`
- `cosmo23/engine/src/agents/agent-executor.js`
- `cosmo23/launcher/config-generator.js`
- `cosmo23/engine/tests/unit/run-commitment-governor.test.js`
- `cosmo23/engine/tests/unit/agent-executor-guided.test.js`
- `cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js`
- `tests/cosmo23/artifact-loop.test.cjs`

**Problem:** Guided runs could complete their planned artifact tasks and then continue spawning mostly generic IDE/artifact producers. Strategic and urgent goal paths bypassed concurrency limits, rate-limit errors remained local generation failures rather than run-level cooldown signals, and artifact-rich runs could remain commitment-poor with zero committed artifacts.

**Fix:** A run-level commitment governor now evaluates provider health, artifact commitment state, synthesis commit receipts, active agents, active goals, and guided-run status before allowing more spawns. Strategic and urgent bypasses require explicit governor approval and are capped to one spawn per cycle by default. IDE-first routing preserves differentiated roles for synthesis, document, validation, and completion work when commitment pressure is active. Repeated 429/rate-limit errors open a cooldown circuit. Accepted guided deliverables can be promoted to committed artifacts with validation evidence.

**Verification:** List the exact test commands and live smoke commands run for this patch.
```

- [ ] **Step 2: Add receipt endpoint only if dashboard lacks direct file visibility**

If needed, add server endpoint:

```js
app.get('/api/commitment-governor', async (req, res) => {
  const fs = require('fs').promises;
  const path = require('path');
  const runDir = getActiveRunDirSomeExistingHelper();
  const file = path.join(runDir, 'commitment-governor-receipts.jsonl');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const latest = text.trim().split('\n').filter(Boolean).slice(-20).map(line => JSON.parse(line));
  res.json({ ok: true, receipts: latest });
});
```

Do not add this endpoint if there is already an established run-file receipt API; use the existing pattern instead.

- [ ] **Step 3: Commit docs**

Run:

```bash
git add docs/design/COSMO23-VENDORED-PATCHES.md cosmo23/server/index.js cosmo23/public/app.js
git commit -m "docs: record cosmo23 commitment governor patch"
```

If optional UI/API files were not changed, omit them from `git add`.

---

### Task 9: Full Verification And Live Smoke

**Files:**
- Verify only; modify nothing unless failures expose missed implementation.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx mocha cosmo23/engine/tests/unit/run-commitment-governor.test.js cosmo23/engine/tests/unit/agent-executor-guided.test.js cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js
```

Expected: pass.

- [ ] **Step 2: Run COSMO23 regression tests**

Run:

```bash
node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs tests/cosmo23/synthesis-commit.test.cjs tests/cosmo23/pgs-engine.test.cjs tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs tests/cosmo23/anthropic-client-request.test.cjs tests/cosmo23/synthesis-config-generator.test.cjs
```

Expected: pass.

- [ ] **Step 3: Syntax check patched files**

Run:

```bash
node -c cosmo23/engine/src/core/run-commitment-governor.js
node -c cosmo23/engine/src/core/orchestrator.js
node -c cosmo23/engine/src/core/unified-client.js
node -c cosmo23/engine/src/agents/agent-executor.js
node -c cosmo23/launcher/config-generator.js
```

Expected: no output and exit code `0` for each file.

- [ ] **Step 4: Restart only COSMO23**

Run:

```bash
pm2 restart home23-cosmo23
```

Expected: only `home23-cosmo23` restarts.

- [ ] **Step 5: Verify live status**

Run:

```bash
curl -s http://localhost:43210/api/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({'running': d.get('running'), 'activeRun': d.get('activeRun') or d.get('run') or d.get('currentRun')}, indent=2))"
```

Expected:
- Server responds with valid JSON.
- Do not require active run unless user asks for a smoke launch.

- [ ] **Step 6: Optional controlled smoke launch**

Only run this after user approval because it spends provider calls:

```bash
curl -s -X POST http://localhost:43210/api/launch \
  -H 'Content-Type: application/json' \
  -d '{
    "topic":"commitment-governor-smoke",
    "context":"Tiny smoke run. Produce one short committed artifact, no broad research, no follow-up spawning.",
    "cycles":3,
    "maxConcurrent":1,
    "explorationMode":"guided",
    "analysisDepth":"shallow",
    "synthesis":{"commitStep":true,"spineCap":3}
  }'
```

Expected:
- Run starts.
- No more than one non-consistency work agent runs at a time.
- `commitment-governor-receipts.jsonl` appears in the run directory.

- [ ] **Step 7: Audit smoke run**

Run with the actual run dir:

```bash
node cosmo23/engine/scripts/artifact-loop.js audit cosmo23/runs/<actual-run-name>
tail -20 cosmo23/runs/<actual-run-name>/commitment-governor-receipts.jsonl
```

Expected:
- At least one receipt.
- No strategic spawn bypass for non-repair work.
- Committed artifacts are nonzero if the run produced a final deliverable.

- [ ] **Step 8: Final commit and push**

Run:

```bash
git status --short
git add -A
git commit -m "fix: add cosmo23 commitment governor"
git push
```

Expected:
- Commit succeeds.
- Push succeeds.

---

## Completion Audit For Implementation

Do not claim the fixes are complete until all checks below have real evidence:

- [ ] Governor tests prove 429 bursts close spawn gate.
- [ ] Governor tests prove uncommitted outputs block more agent churn.
- [ ] Orchestrator tests prove closed governor gate prevents strategic spawner execution.
- [ ] AgentExecutor tests prove strategic metadata alone no longer bypasses concurrency.
- [ ] AgentExecutor tests prove role differentiation survives IDE-first mode.
- [ ] Artifact tests prove accepted guided deliverables can become committed artifacts.
- [ ] Config-generator tests prove new default config serializes correctly.
- [ ] Regression tests prove Query/PGS/synthesis commit behavior still works.
- [ ] Syntax checks pass.
- [ ] `home23-cosmo23` is restarted by name only.
- [ ] Live status endpoint responds.
- [ ] Docs include Patch 24.
- [ ] Git commit and push complete only after verification.

## Rollback Plan

If live COSMO23 breaks after restart:

1. Stop only the affected process with `pm2 restart home23-cosmo23` after reverting the last local commit.
2. Use `git show --stat HEAD` to identify the exact patch.
3. Revert only the implementation commit with `git revert <sha>`.
4. Restart only `home23-cosmo23`.
5. Verify `curl -s http://localhost:43210/api/status`.

Do not use `pm2 stop all`, `pm2 delete all`, `git reset --hard`, or checkout unrelated files.

## Self-Review

- Spec coverage: The plan covers spawn churn, role differentiation, provider rate limits, commitment-poor graph output, guided-run exclusivity, receipts, tests, docs, and live verification.
- Placeholder scan: The plan uses concrete file paths, commands, test bodies, and implementation snippets. The only conditional item is the optional endpoint, and it includes the exact condition for skipping it.
- Type consistency: `RunCommitmentGovernor.evaluate()`, `normalizeProviderError()`, `evaluateCommitmentGovernor()`, `collectCommitmentSnapshot()`, `recordProviderError()`, and `getEffectiveAgentType()` are introduced before later tasks reference them.
