# State machine inventory

A survey of every record in Home23 that moves through named states, taken on 2026-11-09 at commit `5224315`.

A state machine is *explicit* when its states and legal moves are written down as data and the writer refuses anything else. It is *implicit* when the states exist only as string literals spread across the code that happens to compare or assign them. Implicit machines are where records get stuck, where two screens disagree about whether something is finished, and where a new state silently falls through every `if`.

How this was produced: a scan of `src/`, `engine/src/`, `substrate/src/`, `cli/`, `shared/` and `scripts/` for string literals compared with or assigned to a `status`, `state`, `phase`, `stage`, `mode`, `outcome` or `verdict` field, followed by reading the writers of the lifecycles in section 1 and 2. For section 3 the state lists come from the scan, not from reading every writer, so treat them as the vocabulary in use rather than a verified transition table.

## 1. Explicit and enforced

| Lifecycle | Declared in | Enforced by |
| --- | --- | --- |
| `chat-turn`, `async-work`, `coding-job`, `work-verification`, `brain-operation` | `shared/lifecycles.cjs` ([reference](LIFECYCLES.md)) | `TurnStore.writeEnd`, `WorkRegistry`, `CodingJobStore.updateJob`; the engine operation store for `brain-operation` |
| Connected Agents: `round`, `work`, `attempt`, `lease`, `outbox`, `delivery`, `attachment`, `botLifecycle`, `botAvailability`, `channel`, `messageVisibility`, `clientSession`, `pairingSession`, `importItem`, `turnProjection`, `activity`, `authorityEpoch` | `src/coordination/contracts/v1/registry.json` | `src/coordination/schema/contract-registry.ts` and SQLite `CHECK` constraints in the schema deltas |
| Brain operation execution and attachment | `engine/src/dashboard/brain-operations/operation-contract.js` | `operation-store.js` (`assertTransition`, versioned writes) |

`work-verification` is declared and typed but its writer (`src/work/completion.ts`) is not guarded at runtime.

## 2. What adopting the catalog changed

Five harness lifecycles were implicit before this survey. They were chosen first because their records cross a process or client boundary: the dashboard, the Apple apps, the coordination service and the engine all read them.

Found while making them explicit:

- **One turn status type described two different things.** `TurnStatus` had twelve members, but the journal only ever stores `pending` and five terminal statuses. The other six are computed at read time from the latest event. The store's end-of-turn method accepted all eleven non-pending values, so a turn could be "ended" as `streaming`. The catalog separates stored states from views and `writeEnd` now takes only terminal statuses.
- **"Which statuses mean done" was written out by hand in more than 30 places.** The copies agreed for the five adopted lifecycles, but consumers elsewhere had already drifted: the dashboard chat script treats `failed` as a turn status (it is not one), and `engine/src/cognition/agenda-learning.js` checks a turn's end status against eight values, three of which a turn can never have. Eleven harness copies now read the catalog; the remaining 21, in 17 engine, script and dashboard files, are counted in `tests/shared/lifecycles.test.cjs` and may only decrease.
- **Finishing work accepted any status.** `WorkRegistry.complete()` was typed to take every work status, including `running`. Passing one would have stamped `finishedAt` on a record that was still active. It now takes terminal statuses only, at compile time and at run time.
- **A finished coding job was mapped to work by an unchecked cast.** `src/home.ts` cast a job status to a work status. `starting` is a job status and not a work status. The cast is replaced by a check.
- **Stores patched status like any other field.** `CodingJobStore.updateJob` and `WorkRegistry.update` would overwrite a terminal status. No caller did, and now none can.
- **Declared but unwritten states.** Async work `queued` and `blocked`, and turn `stopping`, appear in the published types and in client code but nothing in the harness produces them. They are marked `reserved` (or noted) in the catalog rather than removed, because stored records and clients may carry them.

No stored value, wire value or type name changed.

## 3. Still implicit

Ordered by how much a mistake would cost. "Guard" says what currently stops an illegal move.

### Installation, update and recovery (CLI)

These decide whether a home starts after an update. Each persists a phase to disk and resumes from it after a crash, which makes them the highest-value candidates for an explicit table.

| Lifecycle | Where | States in use | Guard |
| --- | --- | --- | --- |
| Update apply | `cli/lib/product-update-apply.js` | `accepted`, `claimed`, `quiesced`, `checkpointed`, `selected`, `applying`, `writers_admitted`, `committed`, `retained`, `rolled_back`, `aborted`, `recovery_required` | Ordered code path; resume branches on the stored phase |
| Home update operation | `cli/lib/product-home-update.js` | `queued`, `checking`, `downloading`, `preparing`, `updating`, `reconnecting`, `completed`, `failed`, `interrupted`, `aborted` | Local `TERMINAL` set |
| Update feed / staged release | `cli/lib/product-update-feed.js`, `product-release-channel.js` | `absent`, `available`, `copying`, `staged`, `verified`, `current`, `damaged`, `incompatible`, `unavailable` | None |
| Host lifecycle | `cli/lib/product-host.js` | `absent`, `creating`, `prepared`, `registered`, `starting`, `installed`, `stopped`, `busy`, `degraded`, `move_fenced`, `supervisor_locked`, `recovery_required`, `unavailable` | None; status is partly derived from PM2 |
| Backup / restore | `cli/lib/product-backup.js` | `claimed`, `fenced`, `stopped`, `backed_up`, `restored`, `runtime_installed`, `rebound`, `committed` | Ordered code path |
| Semantic memory enablement | `cli/lib/product-semantic-enable.js`, `product-memory.js` | `planned`, `preparing`, `creating`, `configuring`, `warming`, `ready`, `enabled`, `disabling`, `disabled`, `rollback_required` | None |
| Embedder download | `cli/lib/product-embedder.js` | `downloading`, `ready`, `failed`, `interrupted` | None |
| App replacement | `cli/lib/product-app-update.js` | `prepared`, `terminating`, `previousMoved`, `installedReplaced`, `reopened` | Ordered code path |
| Brain re-embed | `cli/lib/brain-reembed.js` | `dry-run`, `running`, `publishing`, `completed`, `swapped` | None |
| Maintenance and release supervisors | `scripts/product/maintenance.mjs`, `scripts/release/supervisor.mjs` | `queued`, `waiting`, `starting`, `running`, `draining`, `succeeded`, `failed`, `cancelled`, `interrupted`, `done` | None; two near-identical vocabularies |
| PM2 save guard | `scripts/guarded-pm2-save.mjs` | `reserved`, `active`, `publishing`, `committed`, `failing`, `publication-failed` | None |

### Harness (`src/`)

| Lifecycle | Where | States in use | Guard |
| --- | --- | --- | --- |
| Worker run | `src/workers/types.ts`, `runner.ts` | `queued`, `running`, `fixed`, `no_change`, `blocked`, `failed`, `cancelled` | None; the receipt is written once with a parsed outcome |
| Scheduled job outcome | `src/scheduler/cron.ts`, `channel-run.ts` | run `ok` / `error`; semantic `satisfied`, `failed`, `unknown`, `withheld`; layers `success`, `failed`, `skipped`, `unknown`, `not_applicable` | None; three overlapping result vocabularies on one job |
| Scheduled delivery | `src/scheduler/delivery.ts` | `queued`, `delivered`, `failed`, `suppressed`, `skipped_by_policy`, `no_adapter`, `no_target` | None |
| Push delivery receipt | `src/push/connected-agents-delivery-store.ts`, `apns-pusher.ts` | `pending`, `retryable`, `delivered`, `invalid`, `failed` | Field-consistency check on read. `failed` is treated as final when a delivery begins but not when a result is recorded |
| Execution control / steer | `src/agent/execution-control.ts` | `queued`, `applied`, `not_applied`; receipts `cancellation_requested`, `already_terminal`, `stale_target` | None |
| Channel router run | `src/channels/router.ts` | `running`, `completed`, `delivered`, `failed` | None |
| Operator outreach | `src/substrate/operator-outreach.ts` | `pending`, `queued`, `committed`, `expired`, `invalid` | None |
| Seed source projection | `src/agent/relationship-ledger.ts`, `memory-objects.ts`, `tools/promote.ts` | `pending`, `projected` | None; the same two-state record is declared in three files |
| Relationship entry | `src/agent/relationship-ledger.ts` | `active`, `superseded`, `resolved`, `removed` | None |
| Memory object review | `src/types.ts` | status `candidate`, `approved`, `challenged`, `superseded`, `expired`, `rejected`; review `unreviewed`, `self_reviewed`, `peer_reviewed`, `approved`, `challenged`, `rejected`, `expired` | None; two parallel vocabularies on one object |
| Conversation feedback | `src/agent/conversation-feedback.ts` | `pending`, `observed`, `projected`, `source_recorded`, `no_feedback`, `refused` | None |
| Cron bootcamp proposal | `src/agency/cron-bootcamp.ts` | `proposed`, `applied`, `closed`, `discarded` | None |
| Live voice session | `src/coordination/app/live-voice.ts` | `pending`, `starting`, `active`, `committed`, `closed` | None; not in the coordination registry |
| Resident initiation | `src/coordination/app/resident-initiations.ts`, `engine/src/agency/resident-initiation.js` | `idle`, `pending`, `ready`, `deferred`, `declined`, `withdrawn`, `not_admitted`, `already_considered`, `baseline_recorded`, `inactive` | None; split across harness and engine |
| Resident assignment | `src/coordination/app/resident-assignments.ts` | `active`, `blocked`, `complete`, `cancelled` | None; not in the coordination registry |
| Chess game | `src/coordination/chess/service.ts` | `active`, `paused`, `finished`; move `queued`, `dispatched`, `failed`, `cancelled` | None |
| Inspector console source | `src/coordination/console/types.ts` | `queued`, `starting`, `running`, `blocked`, `stopping`, `completed`, `failed`, `cancelled`, `interrupted`, `unknown` | Read-side projection of jobs, work and turns; mapping is an inline object in `catalog.ts` |
| Coordination HTTP listener | `src/coordination/http/listener.ts` | `idle`, `starting`, `listening`, `draining`, `stopped` | In-process only |

### Engine (`engine/src/`)

| Lifecycle | Where | States in use | Guard |
| --- | --- | --- | --- |
| Pursuit | `agency/pursuit-store.js`, `resident-kernel.js` | `candidate`, `open`, `active`, `watch`, `blocked`, `deferred`, `provisional`, `fanout`, `applied`, `claim_recorded`, `stale`, `superseded`, `discarded`, `closed` | `transition()` records any status it is given |
| Sub-agent run | `agents/base-agent.js`, `agent-registry.js`, `agent-executor.js` | `created`, `initialized`, `running`, `completed`, `completed_unproductive`, `failed`, `timeout` | None; one reader also checks `complete` |
| Cluster task | `cluster/backends/*-state-store.js` | `PENDING`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `DONE`, `FAILED`, `CANCELLED` | None; `BLOCKED` and `CANCELLED` exist only in the filesystem backend |
| Goal | `goals/intrinsic-goals.js`, `goal-curator.js` | `nascent`, `maturing`, `active`, `completed`, `archived` | None |
| Strategic goal | `coordinator/strategic-goals-tracker.js` | `pending`, `in_progress`, `completed`, `stale`, `escalated` | None |
| Wake / sleep mode | `core/orchestrator.js`, `cognition/state-modulator.js`, `temporal/rhythms.js` | orchestrator `active`, `sleeping`, `reflecting`; rhythms `normal`, `active`, `resting`, `contemplative`, `dreaming` | `transitionToMode()` accepts any mode; two overlapping mode vocabularies |
| Orchestrator action / agenda item | `core/orchestrator.js` | `pending`, `started`, `recorded`, `complete`, `completed`, `success`, `ok`, `failed`, `error`, `timeout`, `not_attempted`; also `ACTIVE`, `COMPLETED`, `ARCHIVED` | None. Several records share the file; between them it writes sixteen status literals, including three spellings of success |
| Live problem | `live-problems/store.js`, `loop.js`, `remediators.js` | outcomes `dispatched`, `in_progress`, `success`, `failed`, `rejected`, `skipped`, `budget_exhausted`, `accepted`, `dispatch_failed`, `dispatch_rejected`, `legacy_resolved` | None |
| Good-life regulator | `good-life/regulator.js`, `dashboard/good-life-operator.js` | `candidate`, `queued`, `queued_no_motor`, `acted`, `ignored`, `rejected`, `stale`, `throttled`, `blocked_*`; operator `clear`, `working`, `resting`, `paused`, `review`, `needs-user`, also capitalized `Clear`, `Working`, `Resting`, `Paused` | None; the same states are written in two letter cases |
| Motor action | `cognition/motor-cortex.js`, `action-dispatcher.js` | `no_action`, `not_attempted`, `dry_run`, `dispatched`, `acted`, `success`, `rejected`, `not_in_allowlist`, `unknown` | None |
| Brain sidecar backup | `core/brain-sidecar-backups.js` | `intent`, `pending`, `copying`, `complete`, `succeeded`, `failed`, `removed` | None |
| Document feeder / converter | `ingestion/document-feeder.js`, `document-converter.js` | feeder `pending`, `attached`, `ready`, `missing`, `error`; converter `checking`, `disabled`, `no_credentials`, `unavailable`, `misconfigured` | None |
| Code / document creation agents | `agents/code-creation-agent.js`, `document-creation-agent.js` | `pending`, `in_progress`, `partial`, `complete`, `failed`; `needs_intake`, `needs_evidence`, `deferred` | None |
| Evaluation run | `evaluation/evaluation-framework.js` | `active`, `running`, `completed`, `synthesized`, `failed` | None |
| Query notebook subscription delivery | `dashboard/query-notebook-subscriptions.js` | `pending`, `delivered`, `failed` | None |
| Dashboard attachment upload | `dashboard/connected-agents.js` | `queued`, `uploading`, `ready`, `complete`, `failed` | None |
| Dashboard health state | `dashboard/home23-dashboard.js` | `awake`, `sleeping`, `working`, `resting`, `paused`, `review`, `repairing`, `attention`, `needs-user`, `clear`, `offline`, `unavailable`, `in-sync`, `mismatch`, `unknown` | Display only; eighteen literals in one file |

### Shared and substrate

| Lifecycle | Where | States in use | Guard |
| --- | --- | --- | --- |
| Memory source writer | `shared/memory-source/jsonl.cjs` | `initializing`, `open`, `finished`, `cleaned`, `failed` | Inline checks before operations |
| Reseal | `shared/memory-source/reseal.cjs` | `absent`, `unsealed`, `resealed`, `stale`, `changed` | None |
| Situation cell | `substrate/src/types.ts`, `cells.ts` | `forming`, `living`, `quiet`, `dormant`, `dissolving` | Development rules decide moves; typed deltas only |
| Commitment | `substrate/src/concern.ts` | `open`, `satisfied`, `contradicted`, `expired`, `abandoned` | Typed union; replay-determined |

The substrate lifecycles are deliberately driven by replay of the hash chain. Any table for them belongs in `substrate/` under the substrate law and must not introduce a second writer.

## 4. Recurring patterns worth fixing as these are adopted

- **Several words for one outcome.** `complete` / `completed` / `succeeded` / `success` / `ok` / `done` all mean a successful end somewhere. Readers defend by checking several. Each lifecycle should pick one and translate at its boundary.
- **Outcome stored as lifecycle.** Worker runs, live problems and motor actions put a result classification (`fixed`, `no_change`, `budget_exhausted`) in the same field as progress (`queued`, `running`). A terminal state plus a separate outcome field is easier to extend.
- **Projection confused with storage.** The turn type was one case. Host status and dashboard health are others: part of the value is stored and part is derived from PM2 or event age, in the same field.
- **Mapping between lifecycles by coincidence of names.** Coding job to async work, turn to console state, and turn to scheduled-work receipt are each an inline object or a cast at the call site.
- **Resumable multi-step procedures without a table.** Update apply, backup and app replacement each persist a phase and branch on it after a crash. They are correct by careful ordering today; nothing would catch a new phase that recovery does not handle.

## 5. Adding or adopting a lifecycle

1. Add a `defineLifecycle({...})` entry to `shared/lifecycles.cjs` and the matching unions to `shared/lifecycles.d.cts`. The table is validated when the module loads.
2. Derive the existing type and any terminal set from the catalog instead of restating them. Do not rename stored values.
3. Guard the single writer with `assertTransition` or `assertTerminal`. Read the writer's callers first: an existing path that makes a move the table forbids is a finding to resolve, not something to discover in production.
4. Regenerate the reference: `node cli/home23.js lifecycles --markdown > docs/reference/LIFECYCLES.md`.
5. Lower the matching counts in `HAND_WRITTEN_COPIES` in `tests/shared/lifecycles.test.cjs`, and move the row from section 3 to section 1 here.

Suggested order: update apply and home update (crash-resumable, user-visible), then pursuit and sub-agent run (highest write volume in the engine), then the engine brain-operation readers that still carry their own copy of the terminal set.
