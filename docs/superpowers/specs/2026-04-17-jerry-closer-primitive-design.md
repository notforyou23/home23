# Jerry Closer Primitive — Design Spec

**Date:** 2026-04-17
**Status:** approved, pending implementation plan
**Author:** claude + jtr
**Scope:** engine/src/goals/\*, engine/src/core/orchestrator.js, one migration, one config touch
**Reference:** jerry's self-diagnosis triad at `instances/jerry/brain/exports/markdown/query_2026-04-17T20-*.md`

## Problem

Jerry's own diagnosis, delivered across three COSMO queries on 2026-04-17, identified a meta-pattern underneath every observed pathology:

> Every pathology traces to the same root cause: **the system has no completion mechanism.** Goals never terminate → they accumulate forever. Thoughts never resolve → they repeat forever. Critics never judge → nothing gets pruned. Agents never check prior work → they rediscover forever. Outputs never ship → the engine runs idle forever.

Concrete manifestation at the time of this spec:
- 18 active goals on jerry, of which 11 are audit-infrastructure "design a schema, never implement" goals.
- 6 goals are open-ended philosophical contemplation with no termination condition.
- 1 goal (CRDT unification) has genuine substance but a sequencing dependency that rarely fires.
- 1,145 goals created lifetime, 0 completed deliverables, 4 output files (all tests).
- ~2.2% memory crystallization rate (thoughts → memory nodes).
- Health-pipeline "standing wave" — the same broken iOS Shortcut rediscovered across 30+ agent cycles.

Code-level root cause (verified against `engine/src/goals/intrinsic-goals.js`):
- No goal-schema field represents a termination condition. `goalData` passed to `addGoal()` accepts `description`, `reason`, `uncertainty`, `source`, `metadata`, `executionContext` — nothing more.
- Completion is determined by `goal.progress >= satisfactionThreshold (0.7)` where `progress` is a self-reported float incremented by the pursuing agent. An audit-infrastructure goal can always claim "I designed more of the schema" and satisfy this heuristic.
- Sticky-goal mechanism: `🚨 Escalated ignored strategic goals - boosted priorities` runs against goals that aren't being pursued, raising their priority and protecting them from low-priority auto-archive. The immortal 18 are the survivors of this escalation ratchet.
- `addGoal()` has no gate beyond `validateGoalData()` which only checks for a non-empty description.

## Non-goals

Flagged for later, separate PRs:
- Critic role repair (its forbidden-topics list structurally prevents self-critique of the cognitive loop — a separate architectural decision).
- Dedup-before-spawn on agent creation.
- Force-output-every-N-cycles.
- Identity-settling canonical memory node.
- Rethink of the ignored-goal escalation loop.

This spec lands **one** closer primitive that proves the pattern. The rest follow once it works.

## Design

### Schema change: `doneWhen`

Every goal now carries a `doneWhen` block. Structure:

```js
{
  // existing fields unchanged...
  doneWhen: {
    version: 1,
    criteria: [                             // AND semantics: all must pass
      { type: 'file_exists', path: 'outputs/correlation-view.md' },
      { type: 'memory_node_tagged', tag: 'resolved:dashboard-pipeline' },
      {
        type: 'judged',
        criterion: 'An analysis with at least 3 concrete examples exists in outputs/...',
        judgeModel: 'gpt-5-mini',
        judgedAt: null,
        judgedVerdict: null                  // 'pass' | 'fail' | null
      }
    ]
  },
  progress: 0.0                              // now computed: satisfiedCount / criteria.length
}
```

`progress` is no longer a free-form self-reported float. It is derived from the verifier's output: `satisfiedCount / criteria.length`. Agents may still record pursuit activity (via `pursuitCount`, `lastPursued`), but they no longer write `progress`.

### Primitive verifier types (v1)

All primitives live in `engine/src/goals/done-when.js` as a dispatch table. Adding a new primitive is a new case in `checkCriterion()`.

| Type | Shape | Semantics |
|------|-------|-----------|
| `file_exists` | `{ path }` | Path resolves under `outputs/` or `brain/`. Exists on disk. |
| `file_created_after` | `{ path, since }` | File exists AND `mtime > since` (epoch ms or ISO). Usually `since = goal.created`. |
| `memory_node_tagged` | `{ tag }` | At least one node in the in-memory graph has the given tag. Matched case-insensitive. |
| `memory_node_matches` | `{ regex }` | At least one node's `concept` field matches the regex. Compile once, reuse. |
| `output_count_since` | `{ dir, since, gte }` | Count of files in `dir` with `mtime > since` is ≥ `gte`. |
| `judged` | `{ criterion, judgeModel, judgedAt, judgedVerdict }` | LLM judge call. Free-text `criterion`. Result cached on the criterion itself. |

Path inputs are resolved via the existing `PathResolver` to prevent escape outside the brain/outputs tree.

### Verifier module

`engine/src/goals/done-when.js` exports:

```js
async function checkDoneWhen(goal, env): {
  satisfied: number,             // count of criteria that passed
  total: number,                 // total criteria
  details: Array<{
    type: string,
    passed: boolean,
    note?: string,                // human-readable why (for logs)
    judgedAt?: number             // when judged criterion was last run
  }>
}
```

`env` carries dependencies: `{ memory, logger, pathResolver, llmClient, outputsDir, brainDir }`.

Rules:
- Non-`judged` primitives are evaluated every call — they're cheap (stat, regex, count).
- `judged` primitives are evaluated only when (a) `judgedVerdict === null`, or (b) `Date.now() - judgedAt > JUDGE_TTL_MS` (default 24h), or (c) forced via `{ forceRejudge: true }`.
- The verifier mutates the criterion's `judgedAt` / `judgedVerdict` in place so the goal carries its own judge cache.
- Judge prompt is fixed: a constrained JSON schema asking `{verdict: 'pass'|'fail', reason: string}`. No free-form output.

### Gate at `addGoal()`

New rejection path added to `intrinsic-goals.js::addGoal()`:

```
1. If goalData.doneWhen missing OR criteria array empty → reject, return null, log at WARN.
2. If any criterion fails schema check (unknown type, missing required field) → reject.
3. If any `judged.criterion` fails the vagueness filter (see below) → reject.
4. Otherwise, proceed with existing logic.
```

Vagueness filter for `judged.criterion`: rejects if the string is under N chars (default 40) OR contains none of the concreteness anchors: `file`, `output`, `memory`, `node`, `count`, `exists`, `at least`, `contains`, `written`, `published`, `produced`, `delivered`, `ships`, `emits`. Crude heuristic, catches the bulk. Configurable via `goals.doneWhen.vaguenessAnchors` / `goals.doneWhen.minCriterionLength`.

The prompts used by goal-capture and goal-curator to generate goals via LLM must be updated to include the `doneWhen` schema as a required output. Without this, the LLM keeps generating goal objects without `doneWhen` and everything gets rejected.

### Progress computation

Replace the self-reported `progress` path everywhere an agent currently writes to it:

```js
// old: goal.progress = agent.reportedProgress;
// new: goal.progress is computed by the goal rotation loop
```

Goal rotation loop (already running periodically in `intrinsic-goals.js`) now calls `checkDoneWhen()` for each active goal and updates `progress`. When `progress === 1.0`, status flips to `completed` with reason `'doneWhen satisfied'`. Latching: once `completed`, verifier does not flip it back (prevents race where a deleted output reverts a completed goal).

Agents may continue to call `incrementPursuitCount()` and `markPursuitActive()` etc. — those are unchanged. They just can't touch `progress` anymore.

### One-shot migration

New file `engine/src/goals/migrations/2026-04-17-done-when.js`. Runs at engine startup if `goals.schemaVersion < 1`. Behavior:

1. **Dry-run mode (default first pass):** logs the proposed actions for every existing goal without applying. Output goes to `brain/migrations/2026-04-17-done-when-dryrun.json` and to stdout.
2. **Apply mode (second pass, when `HOME23_APPLY_MIGRATION=1`):** performs the actions, writes a receipt to `brain/migrations/2026-04-17-done-when-applied.json`, bumps `goals.schemaVersion` to 1.

Per-goal action rules (applied in order):

| Match | Action |
|-------|--------|
| Goal ID in the audit-tumor set (see below) | `archiveGoal(id, 'audit-tumor-purge-2026-04-17')` |
| Goal description matches "what strange loop", "liminal pauses", "metaphysics of", "spoon that remembers", "strange loops", "named days" | `archiveGoal(id, 'no-concrete-done-when')` unless the LLM can synthesize a concrete `doneWhen` |
| Goal 6 (CRDT unification) | Retrofit with `doneWhen: [{ type: 'file_exists', path: 'outputs/crdt-unification-sketch.md' }, { type: 'judged', criterion: 'Document includes sections for protocol predicates, version history, and belief revision, with at least one worked example.' }]` |
| Any other active goal | Attempt LLM-authored `doneWhen` (single call, `gpt-5-mini`, JSON schema). If the output passes the gate, attach it and reset `progress` to 0. If it doesn't, archive with `'no-concrete-done-when'`. |
| Archived / completed goals | Untouched. |

Audit-tumor set (identified from jerry's self-diagnosis; verified against current `goals.json` at migration time — IDs resolved by description match, not hardcoded numbers, since goal IDs are instance-specific):

- "verified output evidence schema" → archive
- "state snapshot capture at handoff" → archive
- "modify audit script to enumerate workspace" → archive
- "four-column evidence table" → archive
- "map agent internal state variables" → archive
- "data integrity feedback loop" → archive
- "checkpoint receipt schema" → archive
- "canonical taxonomy schema" → archive
- "enforcement boundary for incomplete cycles" → archive
- "audit schema with four parallel count columns" → archive
- "audit conclusions treating zero as negative evidence" → archive

Pre-migration: a coherent brain backup is triggered explicitly (reusing existing `brain-backups.js::maybeBackup` with `force: true`), and the migration receipt records which backup directory it corresponds to. Rollback = restore that backup + revert `goals.schemaVersion`.

### Observability

One new dashboard tile data provider: `goals-closer-status`. Returns:

```json
{
  "activeTotal": 7,
  "withDoneWhen": 7,
  "dueForJudgeRecheck": 2,
  "stalled": 1,
  "rejectedAtGateLast24h": 4,
  "completedViaDoneWhenLast24h": 1,
  "archivedViaMigration": 11
}
```

A tile on the home tab displays the top-line counts. Engine logs the same block once per cycle at INFO. This is how we watch the closer actually close.

### Source attribution

New field `goal.source.origin` on every goal, one of: `goal-capture | goal-curator | manual | synthesis | escalation | migration-retrofit`. Set wherever `addGoal()` is called. We don't act on origin in this PR, but recording it lets a future PR gate differently per-source if the audit-tumor regrows from one specific path.

## Failure modes & mitigations

| Mode | Mitigation |
|------|-----------|
| LLM produces vague `judged.criterion` | Vagueness filter in the gate: min length, concreteness anchors. |
| Judge token cost explosion | Result cached per-criterion; TTL 24h; judge uses `gpt-5-mini`. |
| File-existence race (file deleted after completion) | Completion is latching — `completed` status doesn't flip back. |
| Migration destroys goal 6's work | Dry-run first, logged plan, jtr review, explicit `HOME23_APPLY_MIGRATION=1` for apply pass. |
| Audit-tumor regrowth after purge | Gate rejection stops new audit-style goals at creation. Source blocklist is **not** implemented in this PR; re-evaluate after 7 days of observation. |
| Existing escalation loop keeps immortal goals alive | Explicitly out of scope. Flagged for follow-up PR. Closer alone doesn't remove escalation — but completed/archived goals exit the escalation pool. |
| `progress` field read by other subsystems (dashboard, etc.) | Audit: grep for `.progress =` writes during implementation. Convert any remaining self-report writes to `updateProgressFromDoneWhen()` calls. Read-only access is unchanged. |

## Testing

Unit tests (new file `engine/tests/done-when.test.js`):
- Each primitive type: happy path + negative path + edge case (missing input).
- `checkDoneWhen()` aggregate: N-of-M math, latching behavior, judged-cache honored.
- Vagueness filter: anchor keywords trigger pass, short strings fail.
- Gate rejection: `addGoal` without `doneWhen` returns `null` and logs WARN.

Integration tests:
- Create goal with `file_exists` criterion. Drop file. Run rotation. Assert `progress === 1`, `status === 'completed'`.
- Create goal with `judged` criterion. Mock LLM. Run rotation. Assert judge called exactly once, result cached, second rotation doesn't re-call.
- Migration dry-run against fixture `goals.json` containing the jerry-18 signature. Assert printed plan matches the per-goal action table.

Regression: existing `intrinsic-goals.test.js` continues to pass — any test asserting `goal.progress = N` gets updated or wrapped with a feature-flag path.

## Rollout

1. Branch + implement schema + verifier + gate + tests.
2. Unit tests pass. Integration tests pass.
3. Dry-run migration against a copy of jerry's `goals.json`. Jtr reviews the plan.
4. Defensive brain backup (same pattern as the 2026-04-17 checkpoint-bug recovery — explicit `cp` of the four brain files to `/tmp/jerry-preflight-<ts>/`).
5. Apply migration with `HOME23_APPLY_MIGRATION=1`. Engine restart. Watch logs for expected counts.
6. Observe 24h. Watch the observability tile. Expected: `rejectedAtGateLast24h` > 0 (audit-goal regeneration attempts blocked), `archivedViaMigration = 11`, `withDoneWhen === activeTotal`.
7. If audit-tumor regrows via a non-audit-named concept (e.g. the curator starts inventing "evidence pipelines"), add the optional source blocklist as a follow-up PR.

## Open questions

- None as of spec approval. Implementation plan will surface any remaining decisions.
