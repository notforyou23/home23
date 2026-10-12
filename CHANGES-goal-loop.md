# Strategic goal loop repair

The meta-coordinator now gates `meta_coordinator_strategic` goals before calling
`addGoal`. This includes strategic decisions, curated-insight follow-ups, and
emergency injections. Other goal sources retain their existing behavior. The
gate never deletes goals or changes their persisted format.

- Lexical novelty checks compare normalized token Jaccard and containment scores
  against all active goals and recent completed/archived goals. Active goals have
  no age limit. Terminal goals use completion/archive time, then creation time.
  Missing timestamps conservatively keep a goal in the comparison window.
- Archived goals whose reason starts with `owner:` (case-insensitive) block
  similar goals permanently. This also works with ordinary deduplication disabled.
- Configured topic phrases block the Substack canonical-pointer/nine-note
  approval family and approval-request/decision-record/byte-threshold/duplicate
  request consolidation family. Slash-separated phrases are alternatives.
  Topic matches need up to three shared keywords, avoiding generic notes and
  measurement work. Goal containment needs three shared keywords; Jaccard still
  recognizes exact short descriptions.
- Approval/decision-process goals require an existing unanswered operator
  question. The coordinator reads `agencyKernel.deriveObligations()` through
  `fullConfig._osEngine`; it accepts only open `operator_question` objects for the
  operator with a `questionId`. Resolved questions do not qualify. Missing or
  unreadable stores count as no request. Historical `questions()` and
  authority-request receipts cannot reliably prove an unanswered decision and
  therefore do not qualify. Pending questions bypass only the meta-loop guard.
- Limits count successful goal creations, including earlier writes in the same
  batch. Urgent goals and curated insights share one review allowance. Standalone
  injections use a batch allowance. Hourly limits combine retained goal timestamps
  and a bounded in-memory admission cache; restarts reconstruct counts from the
  existing goal history.
- Each gate rejection emits one info line with `duplicate-of <id>/score`,
  `blocked-topic`, `meta-loop`, or `rate-limit`. Each review emits attempted,
  created, suppressed, and per-reason totals.
- Strategic tracking matches the accepted specification's description, agent
  type, and rationale, so a rejected earlier specification cannot shift tracking.

## Configuration

Configure the shared `configs/base-engine.yaml` under `coordinator`. The module
also supplies these defaults when keys are absent. Existing per-agent coordinator
overrides are not loaded by `ConfigLoader`; use the shared engine configuration.
Settings apply when the coordinator is constructed.

| Key under `coordinator.strategicGoalGate` | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable the new admission gate. |
| `dedupeEnabled` | `true` | Compare active and recent terminal goals. |
| `ownerClosedEnabled` | `true` | Honor permanent owner archive closures. |
| `blockedTopicsEnabled` | `true` | Check configured topic phrases. |
| `metaLoopEnabled` | `true` | Require a pending question for process goals. |
| `rateLimitEnabled` | `true` | Enforce both creation limits. |
| `similarityThreshold` | `0.5` | Minimum goal similarity score. |
| `topicSimilarityThreshold` | `0.5` | Minimum topic similarity score. |
| `lookbackDays` | `14` | Terminal-goal comparison window. |
| `maxPerReview` | `2` | Successful creations per review/batch. |
| `maxPerHour` | `4` | Successful creations in the rolling hour. |

`coordinator.blockedGoalTopics` is an array of strings. An explicit `[]` clears
the seeded families. This does not disable owner closures or the meta-loop guard.
The two seeded strings, including phrase alternatives, are:

```yaml
blockedGoalTopics:
  - 'Substack canonical-pointer notes approval template scope / nine notes template / nine-note scope / canonical owner request / authorized pointer text'
  - 'approval request / decision record / byte-count threshold pending owner approval / duplicate request consolidation'
```

To disable all new checks, set:

```yaml
coordinator:
  strategicGoalGate:
    enabled: false
```

Existing goal validation and legacy filters still apply when disabled. Individual
toggles disable only their respective new checks. Numeric limits can be zero to
stop admission; thresholds range from zero to one. Non-numeric or negative
settings use defaults; similarity thresholds are capped at one. Lexical matching
is deterministic and requires no embedding service;
paraphrases without shared keywords can still escape deduplication.

## Verification

Tests use isolated temporary stores and stubbed model responses. The live Home23
Host installation was not accessed or changed.

From the repository root:

```sh
node --test --test-concurrency=1 tests/engine/coordinator/*.test.js tests/engine/coordinator/meta-coordinator-budget.test.cjs tests/engine/goals/*.test.js tests/engine/realtime/goal-admin.test.js tests/engine/channels/work/goals-channel.test.js
```

Result: 75 passed, zero failed, skipped, or cancelled; exit 0. This includes 44 new
gate tests covering every gate, all seven reported examples, ordinary-work
controls, real goal writes, shared review limits, accepted-spec tracking, and real
agency question resolution. Agency file contents and modification timestamps
remain unchanged during pending-request checks and goal injection.

```sh
node --test --test-concurrency=1 tests/engine/agency/kernel.test.js tests/engine/package-test-registration.test.cjs
```

Result: 78 passed, zero failed, skipped, or cancelled; exit 0. The new `.test.js`
suite is included by the existing default engine test glob.

From `engine/`:

```sh
./node_modules/.bin/mocha tests/unit/meta-coordinator-specialization.test.js tests/unit/strategic-goals-escalation.test.js --timeout 10000
```

Result: six passed; exit 0.

From the repository root:

```sh
node --check engine/src/coordinator/strategic-goal-gate.js && node --check engine/src/coordinator/meta-coordinator.js && node --check engine/src/coordinator/strategic-goals-tracker.js && git diff --check
```

Result: all syntax and whitespace checks passed; exit 0.

An isolated `node --input-type=module` probe loaded the baseline coordinator from
commit `0c33b0575c8c28e849c89b7410898240402e4071` and compared current source using
real in-memory goal systems. The baseline minted one near-duplicate of an
owner-archived goal older than 14 days; the fixed coordinator minted zero. Both
expected-result assertions passed. No persisted home data was used.

The full cross-product `npm test`, build, and contract suites were not run. This
change affects the coordinator admission path rather than onboarding or release
behavior; the affected coordinator, goals, archive-admin, agency, and tracker
suites above passed. This branch is committed locally; it is not deployed.
