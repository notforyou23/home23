# Engine Door Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Home23 engine writing records of non-events, so the brain stops growing ~1,090 diary nodes/day and a later rebuild cannot re-fill with the same material.

**Architecture:** Every change is a *deletion* or a *gate* at an existing `memory.addNode()` call site, plus two config corrections. No new abstractions, no new governance layer — the spec is explicit that governance produces receipts and receipts are the disease. Nothing touches save/load, the graph, decay's mechanism, embeddings, or retrieval.

**Tech Stack:** Node.js ESM (`engine/src/`), `node:test`, existing `tests/engine/**`.

**Spec:** `docs/superpowers/specs/2026-07-15-brain-vault-decontamination-design.md` (§4.1a, §4.3, §4.3a, §4.4)

**Plan 1 (vault consolidation) is COMPLETE.** `/Users/jtr/vault/` holds 33,129 of jtr's documents; coverage `missing: 0`; every origin durable. **Plan 3 (archive + rebuild) MUST NOT start until this plan lands** — rebuilding before the doors shut just re-fills the brain with diary.

---

## ⚠ This plan edits a LIVE system

- `home23-jerry` and `home23-forrest` are **running under PM2 right now**. The brain is **143,479 nodes / 471,118 edges**.
- **Brain persistence is sacred and this system has already lost it once** (a `saveState` with 0 nodes; a V8 heap limit incident). Standing rule: **run a standalone load test before ANY engine restart**, and verify node counts after.
- **Do not `pm2 kill`, `pm2 delete all`, or `pm2 restart all`.** jtr has 50+ PM2 processes. Scope every action to one named app.
- **No change in this plan touches `saveState`/`loadState`, the memory store, decay's mechanism, the ANN index, or retrieval.** If a task tempts you toward any of those, stop and report.
- Work in a git worktree (`codex/engine-door-fixes`), never directly in `/Users/jtr/_JTR23_/release/home23`.

## Measured baseline (2026-07-15)

```
brain            143,479 nodes / 471,118 edges     (65,100 on May 7 -> +1,135/day)
                 of which ~45/day are about jtr and ~1,090/day about itself
composition      ~71% machine narrative, ~9-13% jtr's world
biggest tags     workspace 29,298 · consolidated 19,033 · reasoning 8,524 ·
                 curator 5,617 · analysis_insight 5,616 · critic 4,158 ·
                 curiosity 4,131 · analyst 4,120 · novel_implication 4,536 ·
                 synthesis_report 3,674 · proposal 3,549
recent growth    state_snapshot = 30.2% of it
```

## The rule every task serves

> **Something happened** → artifact, worth keeping, any volume.
> **A loop ticked** → not an event. No record.

`"Thoughts Analyzed: 0"`, `"documentCount: 0"`, `"reflection not found in memory"`, `"restraint: throttled"`, `resident_tick selected a pursuit` — all records that **nothing happened**.

## File Structure

| File | Change |
|---|---|
| `engine/src/core/orchestrator.js` | Task 1 (thought persistence), Task 2 (`state_snapshot`), Task 5 (dream dice), Task 6 (`recordGoodLifeAgendaAction`) |
| `engine/src/agents/base-agent.js` | Task 3 (`[AGENT:]` / `[AGENT INSIGHT:]` on non-events) |
| `engine/src/circulatory/composter.js` | Task 3 (`compost_receipt`) |
| `configs/base-engine.yaml` | Task 4 (`decay.exemptTags`) |
| `engine/src/good-life/regulator.js` (+ callers) | Task 6 (restraint receipts) |
| `engine/src/agency/resident-kernel.js` | Task 6 (`resident_tick` scratch/receipt) |

---

### Task 1: A thought is working memory, not knowledge

**This is the largest single source in the brain (~45,000 nodes) and the one that makes Jerry quiet.**

**jtr's decision (2026-07-15):** *"No — a thought is working memory."* Thinking, dreaming, consolidation, the graph and decay all stay. A thought becomes permanent **only if it produced something**.

**Files:**
- Modify: `engine/src/core/orchestrator.js:2851` (thought → node), `:2933` (`[REASONING]` → node)
- Test: `tests/engine/core/thought-persistence.test.js` (create)

**The signal already exists, 120 lines above the write:**

```js
// :2727
const capturedGoals = shouldSkipGoalCapture ? [] : await this.goalCapture.captureGoalsFromOutput(thought.hypothesis);
for (const captured of capturedGoals) { ... this.goals.addGoal(...) ... }   // :2731-2777
// ...
memoryNode = await this.memory.addNode(thoughtValidation.content, role.id);  // :2851 — unconditional
```

**⚠ The trap — do not walk into it.** `shouldSkipGoalCapture` is true in strict/guided mode, with an active plan, or while executing. Then `capturedGoals === []` **because we never looked**, not because the thought was barren. Treating that as "unproductive" is *absence of evidence read as evidence of absence* — the exact bug class that produced ten defects in plan 1. **The gate must distinguish "capture ran and found nothing" from "capture was skipped."**

- [ ] **Step 1: Read the real code first.** `sed -n '2700,2870p' engine/src/core/orchestrator.js`. Line numbers in this plan are from 2026-07-15 and may drift. **Do not trust them; locate by content.** Confirm: where `capturedGoals` is computed, where `shouldSkipGoalCapture` is set, whether any goal was actually *created* (the loop has `if (this.goals.getGoals().length < maxGoals)` — a captured goal can be **dropped at the cap**, so `capturedGoals.length > 0` does NOT mean a goal exists). **Report what you find before implementing.**

- [ ] **Step 2: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// A thought that produced a goal is an EVENT -- something happened.
// A thought that produced nothing is a loop ticking. It must leave no trace.
// A thought whose productivity was never MEASURED (goal capture skipped) is
// unknown -- and unknown must not be silently read as unproductive.
test('a thought that created a goal persists', async () => { /* assert addNode called */ });
test('a thought that created no goal leaves no node', async () => { /* assert addNode NOT called */ });
test('a thought whose goal-capture was SKIPPED is not silently dropped', async () => {
  // shouldSkipGoalCapture === true -> capturedGoals === [] -> must NOT be treated as unproductive
});
test('[REASONING] follows the same rule as the thought it belongs to', async () => {});
```

Use the harness style in `tests/engine/core/orchestrator-consolidation.test.js`. **Read that file first** and match it; do not invent a new harness.

- [ ] **Step 3: Run it, confirm the productive/unproductive tests FAIL** (today every thought persists unconditionally).

- [ ] **Step 4: Implement the gate.** Persist the thought iff a goal was **actually created** from it. When goal capture was **skipped**, do **not** infer unproductive — report your chosen behaviour and why. `:2933`'s `[REASONING]` node follows the same verdict as its parent thought.

- [ ] **Step 5: Confirm tests pass, and `npm run --silent test:engine-core` (or the narrowest existing engine suite) is green.**

- [ ] **Step 6: Commit** — `git commit -m "fix(engine): a thought persists only if it produced a goal"`

---

### Task 2: Stop re-ingesting RECENT.md — the ouroboros

**30.2% of recent brain growth.** `RECENT.md` is a curator-generated *summary of the brain*, re-ingested **into the brain** as permanent nodes.

**Files:**
- Modify: `engine/src/core/orchestrator.js` (~`:7505`, the `state_snapshot` writer)
- Test: `tests/engine/core/state-snapshot.test.js` (create)

**Three compounding defects, all measured:**

```js
content = await fs.readFile(path.join(workspacePath, 'RECENT.md'), 'utf8');   // direct read, NOT the feeder
const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
if (hash === this.lastStateSnapshotHash) return;        // dedup gate...
await this.memory.addNode({
  concept: `[STATE_SNAPSHOT] RECENT.md as of cycle ${this.cycleCount}.\n\n${body}`,
  tag: 'state_snapshot',
  confidence_decay: 1,        // ...never decays
  status: 'current',
});
```

1. It reads `RECENT.md` **directly off disk**, so no watch-path change can stop it.
2. **The dedup gate is defeated by RECENT.md's own timestamp** (`_Generated: 2026-07-09T07:15:17.722Z_`) — new stamp → new hash → gate always passes → a new node every regeneration. The intent was right; the cadence beat it.
3. `confidence_decay: 1` — exempt from decay, on top of the `exemptTags` immunity.

- [ ] **Step 1: Locate by content** (`grep -n "STATE_SNAPSHOT" engine/src/core/orchestrator.js`), read the whole function, and **find every caller.**
- [ ] **Step 2: Write a failing test** asserting the engine adds no `state_snapshot` node when `RECENT.md` changes.
- [ ] **Step 3: Remove the writer.** `RECENT.md` is a **derived surface**, already loaded into the system prompt by `src/agent/context-assembly.ts` — that is its designed role (STEP20/STEP23). It does not need to be a node.
- [ ] **Step 4: Verify the surface still loads.** Confirm `context-assembly` still reads `RECENT.md` as a surface. **The agent must not lose situational awareness — only the brain-node copy goes.** Report how you verified.
- [ ] **Step 5: Also check `findRelevantStateSnapshots`** in `engine/src/memory/network-memory.js`. It **force-injects** `state_snapshot` nodes into query results even when spreading activation never reached them. With the writer gone it becomes inert — **report whether it should be removed too, do not remove it unilaterally** (retrieval is a separate spec).
- [ ] **Step 6: Commit** — `git commit -m "fix(engine): stop re-ingesting RECENT.md into the brain it summarises"`

---

### Task 3: The agent and the composter stop filing non-events

**Files:**
- Modify: `engine/src/agents/base-agent.js` (2 `addNode` sites), `engine/src/circulatory/composter.js`
- Test: `tests/engine/agents/base-agent-events.test.js` (create)

**Measured, verbatim from the live brain:**
```
[AGENT INSIGHT: agent_1783691902660] Total content analyzed: 0 words across 0 documents
[AGENT: agent_1783710665719] {"documentCount":0,"documents":[]}
```

```js
// base-agent.js — a finding/insight is written regardless of whether anything was found
addNode(`[AGENT: ${this.agentId}] ${finding}`, tag)
addNode(`[AGENT INSIGHT: ${this.agentId}] ${insight}`, tag)

// composter.js — the janitor files a receipt INTO the thing it cleans
const node = await this.memory.addNode(summary, 'compost_receipt');
```

- [ ] **Step 1: Read both files.** Determine what "found nothing" actually looks like at each site (`documentCount: 0`, `0 words`, empty findings array — **check the real shapes, don't assume**).
- [ ] **Step 2: Write failing tests** — an agent analysing 0 documents writes no node; an agent with a real finding still does; the composter writes no node at all.
- [ ] **Step 3: Implement.** Gate `base-agent`'s two sites on the event rule. **Remove `composter`'s `addNode` entirely** — a janitor does not file receipts into what it cleans. Keep its logging.
- [ ] **Step 4: Tests green.**
- [ ] **Step 5: Commit** — `git commit -m "fix(engine): agents and the composter stop filing records of nothing"`

---

### Task 4: Un-exempt the garbage from decay

**Files:**
- Modify: `configs/base-engine.yaml`
- Test: `tests/engine/config/decay-exemptions.test.js` (create)

```yaml
decay:
  exemptTags: [agent_insight, agent_finding, mission_plan, cross_agent_pattern]
```

**`[AGENT INSIGHT] Total content analyzed: 0 words` is tagged `agent_insight` and is therefore immune to decay by configuration.** jtr's real notes decay. "I analyzed zero documents" is protected.

- [ ] **Step 1: Failing test** — assert `agent_insight` and `agent_finding` are not in `exemptTags`.
- [ ] **Step 2: Remove `agent_insight` and `agent_finding`.** **Leave `mission_plan` and `cross_agent_pattern`** — not measured, not in scope, and this project has mistaken real material for garbage four times.
- [ ] **Step 3: Check every consumer of `exemptTags`** (`grep -rn "exemptTags" engine/`) and confirm nothing else depends on those two.
- [ ] **Step 4: Commit** — `git commit -m "fix(engine): stop exempting the machine's own prose from decay"`

---

### Task 5: Keep only productive dreams

**jtr's decision:** *"keep productive dreams."*

**Files:**
- Modify: `engine/src/core/orchestrator.js` (~`:4227` goal dice, `~:4266` prose dice)
- Test: `tests/engine/core/dream-persistence.test.js` (create)

**Two dice rolls, and the first randomises productivity itself:**

```js
const dreamGoals = await this.goalCapture.captureGoalsFromOutput(dreamThought.hypothesis, {...});
if (Math.random() < 0.3) { const newGoal = this.goals.addGoal({...}); }   // whether the goal EXISTS
...
if (Math.random() < 0.2) { await this.memory.addNode(`[DREAM] ${hypothesis}`, 'dream'); }  // whether it's REMEMBERED
```

**A dream that captured a real goal has a 70% chance of that goal being discarded by a coin flip**, and the two dice are unrelated — so the remembered dreams are **not** the productive ones. "Keep productive dreams" is currently unimplementable.

`memory.rewire()` is **phase-level** (runs once per dream phase regardless), so **the only per-dream product is a goal.**

- [ ] **Step 1: Locate both by content.** Confirm the rewire call is phase-level, not per-dream.
- [ ] **Step 2: Failing tests** — a dream that captures a goal creates it and earns a note; one that captures nothing leaves no trace; **no `Math.random` in either path.**
- [ ] **Step 3: Remove both dice.** A captured goal becomes a goal on merit. `if (goalWasCreated)` replaces the prose dice.
- [ ] **Step 4:** Keep dreaming, goal capture, and Watts-Strogatz rewiring **untouched** — that is the real consolidation.
- [ ] **Step 5: Commit** — `git commit -m "fix(engine): dreams persist on merit, not on a coin flip"`

---

### Task 6: Stop the receipts

**Files:**
- Modify: `engine/src/agency/resident-kernel.js` (`tick()`), `engine/src/core/orchestrator.js` (`recordGoodLifeAgendaAction`), the restraint-receipt writer (locate it), `pulse-remarks` writer (locate it)
- Test: `tests/engine/agency/tick-receipts.test.js` (create)

**Measured:**
- `good-life-restraint-receipts.jsonl` — **12.3 MB, 14,448 records, 144/day.** Every line says the system decided **not** to act. Its own `doctrine` field states the law: *"Restraint needs receipts when an autonomous gate prevents work."*
- `resident-kernel.tick()` writes `appendScratch` + `appendReceipt` **unconditionally on selection**, before any branch on what the action was: `note: "Resident tick selected one pursuit and chose ${editor.action}."`
- `recordGoodLifeAgendaAction()` returns `directAction: true` having only written a JSONL line, with `verifier: 'next domain.good-life evaluation'` — **a string naming the loop that authored the work.**
- `pulse-remarks.jsonl` — a paid LLM call per cycle narrating internals; the real world (weather, sauna) gets 8 words at the end.

- [ ] **Step 1: Locate each writer by content and read it.** Report what you find — line numbers here are stale.
- [ ] **Step 2: Failing tests** — a tick that takes no action writes no scratch and no receipt; a tick that *does* act still records it.
- [ ] **Step 3: Implement**, in this order, committing separately so each is revertible:
  - `resident_tick`: write **only** when an action actually occurred or pursuit state changed.
  - **Restraint receipts: stop writing.** A gate does not need a receipt. *(The existing 12.3 MB file stays on disk — this plan deletes nothing.)*
  - `recordGoodLifeAgendaAction`: remove. A receipt whose verifier is the loop that authored it is not an action.
  - `pulse-remarks`: keep real-world content, drop the self-report. **Report what remains** — if nothing does, say so rather than keeping an empty call.
- [ ] **Step 4: Commit each separately.**

---

### Task 7: Verify on the live system — the acceptance gate

**No code changes. This is measurement.**

- [ ] **Step 1: Before restarting anything — standalone load test.** Per the standing rule after ANY persistence-adjacent change. Load the brain outside the engine, confirm node/edge counts match `/api/brain/storage`. **If this fails, STOP and report.**
- [ ] **Step 2: Record the baseline** from the live engine: `curl -s localhost:5002/api/brain/storage` → nodes, edges, cycle.
- [ ] **Step 3: Restart ONE app only** — `pm2 restart home23-jerry`. **Never `restart all`.** Leave forrest running as a control.
- [ ] **Step 4: Verify the brain survived** — node/edge counts within expected drift. **A drop is a persistence incident: stop, report, do not proceed.**
- [ ] **Step 5: Watch for 30+ minutes.** Re-read `/api/brain/storage`.
  - **Baseline growth was ~1,135 nodes/day (~24/30min), ~96% of it diary.**
  - **Success: growth is dominated by real material, and `state_snapshot` / `agent_insight` / `reasoning` / `compost_receipt` nodes are ~0.**
  - Sample the new nodes by tag and report the actual composition.
- [ ] **Step 6: Confirm the receipts stopped** — `wc -l instances/jerry/brain/good-life-restraint-receipts.jsonl` before and after. It should stop growing. **Compare against forrest, still unpatched — it should still be growing.** That is the controlled proof.
- [ ] **Step 7: Report to jtr.** Node growth rate before/after, tag composition of new nodes, receipt file deltas for both agents, and anything surprising. **Then stop.** Forrest gets patched only on jtr's say-so.

---

## What this plan does NOT do

- **Does not delete a single existing node.** The 143,479 stay. This only stops the inflow. Removal is plan 3.
- **Does not touch** `saveState`/`loadState`, the memory store, the graph, decay's mechanism, embeddings, the ANN index, or retrieval.
- **Does not re-enable the garbage collector** or fix `prune_stale_cluster`. The GC is disabled by the `brain_node_count_stable` verifier, and its access-age heuristics would delete jtr's MRI (never accessed, months old) while sparing fresh receipts. **That needs a provenance-keyed rewrite — plan 3, with a dry-run.**
- **Does not point the feeder at `/Users/jtr/vault/`.** Plan 3. Doing it now would ingest 33,129 documents into a brain still writing diary.
- **Does not touch retrieval** — `context-assembly`'s single-seed walk, the ANN index, partition quality. Separate spec (§8).
- **Does not add a governance layer.** Every fix is a deletion or a gate at an existing call site. The spec is explicit: gates produce receipts, and receipts are the disease. `editor.js` is 59 lines out of 8,869 and defaults to `allow` — **do not add to it.**

## After this plan

`engine/src/agency/` (4,087 lines) and Good Life + its operator (4,782 lines) will be writing to files nobody ingests and nobody reads. **Inert, not removed.** Delete them at leisure, on evidence, once the vault is the brain's only input — not before.
