# Lifecycles

<!-- Generated from shared/lifecycles.cjs by `node cli/home23.js lifecycles --markdown`. Do not edit by hand. -->

Each lifecycle below is declared once, in `shared/lifecycles.cjs`. The store named as its authority
refuses any move the table does not list (an entry's notes say so where it only reports one), and readers
ask the catalog which states are final.
To change a lifecycle, edit the table, regenerate this page, and update the matching union in
`shared/lifecycles.d.cts`. For lifecycles that are not in the catalog yet, see
[the state machine inventory](STATE-MACHINE-INVENTORY.md).

## chat-turn

One assistant turn in a conversation journal.

- Record: TurnEnvelope (type "turn") in the conversation JSONL
- Authority: `src/chat/turn-store.ts`
- Starts as: `pending`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `pending` | Started | active | `complete`, `stopped`, `error`, `timeout`, `orphaned` |
| `complete` | Complete | final | — |
| `stopped` | Stopped | final | — |
| `error` | Failed | final | — |
| `timeout` | Timed out | final | — |
| `orphaned` | Interrupted | final | — |

Reported while still active, never stored:

| View | Shown as |
| --- | --- |
| `accepted` | Accepted |
| `running` | Working |
| `awaiting_model` | Thinking |
| `streaming` | Responding |
| `tool_running` | Using a tool |
| `stopping` | Stopping |

- The journal only ever stores "pending" (the start record) and one terminal status (the end record).
- The views are what a still-pending turn is reported as, derived at read time from its latest event. They are never written and must never be treated as stored states.
- "stopping" is declared for clients but no harness code currently reports it.

## async-work

Detached or inline work a turn launched: a coding job, a sub-agent, or a scheduled agent turn.

- Record: AsyncWorkRecord (home23.async-work.v1)
- Authority: `src/work/registry.ts`
- Starts as: `running`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `queued` | Queued | reserved | `running`, `completed`, `failed`, `cancelled`, `interrupted` |
| `running` | Working | active | `blocked`, `completed`, `failed`, `cancelled`, `interrupted` |
| `blocked` | Waiting | reserved | `running`, `completed`, `failed`, `cancelled`, `interrupted` |
| `completed` | Complete | final | — |
| `failed` | Failed | final | — |
| `cancelled` | Cancelled | final | — |
| `interrupted` | Interrupted | final | — |

- Work is created "running". "queued" and "blocked" are part of the published type and readers accept them, but nothing writes them today.
- The terminal move happens exactly once; a second attempt returns the record unchanged.
- Delivery (deliveredAt) and review (work-verification) are separate facts recorded after the terminal move, not states of this lifecycle.

## coding-job

One run of an external coding backend (Codex, Cursor) as a child process.

- Record: CodingJobRecord (home23.coding-job.v1), coding-jobs/<jobId>/job.json
- Authority: `src/acp/bridge.ts through src/acp/job-store.ts`
- Starts as: `starting`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `starting` | Starting | active | `running`, `completed`, `failed`, `cancelled`, `interrupted` |
| `running` | Working | active | `completed`, `failed`, `cancelled`, `interrupted` |
| `completed` | Complete | final | — |
| `failed` | Failed | final | — |
| `cancelled` | Cancelled | final | — |
| `interrupted` | Interrupted | final | — |

- A job can end straight from "starting" when the child never spawns or is finalized during recovery.
- A finished coding job maps onto async-work by name: the four terminal statuses are identical.

## work-verification

Whether a finished piece of async work was reviewed before its result was delivered.

- Record: AsyncWorkRecord.verification
- Authority: `src/work/completion.ts`
- Starts as: `none`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `none` | Not reviewed | active | `pending` |
| `pending` | Review in progress | active | `reviewed`, `skipped` |
| `reviewed` | Reviewed | final | — |
| `skipped` | Review skipped | final | — |

- "none" is where most work stays: review does not apply to failures, disabled kinds, or non-human origins.
- "reviewed" attests that the review turn ran and its report was delivered, not that the work is correct.

## brain-operation

A long-running brain query, synthesis or research operation.

- Record: Brain operation record (engine operation store)
- Authority: `engine/src/dashboard/brain-operations/operation-contract.js`
- Starts as: `queued`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `queued` | Queued | active | `running`, `complete`, `partial`, `failed`, `cancelled`, `interrupted` |
| `running` | Working | active | `complete`, `partial`, `failed`, `cancelled`, `interrupted` |
| `complete` | Complete | final | — |
| `partial` | Partly complete | final | — |
| `failed` | Failed | final | — |
| `cancelled` | Cancelled | final | — |
| `interrupted` | Interrupted | final | — |

- The engine operation store is the writer and enforces these moves itself; this entry mirrors it so the harness and tools share one vocabulary. A test keeps the two tables identical.
- "partial" is a successful terminal result with incomplete coverage, not a failure.

## home-update

One owner-requested check, update, resume or recovery of the whole product.

- Record: Home update operation (home23.home-update.v1), one JSON file per operation
- Authority: `cli/lib/product-home-update.js`
- Starts as: `queued`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `queued` | Queued | active | `checking`, `downloading`, `updating`, `reconnecting`, `failed` |
| `checking` | Checking for updates | active | `completed`, `failed`, `queued` |
| `downloading` | Downloading | active | `preparing`, `failed`, `queued` |
| `preparing` | Preparing | active | `updating`, `failed`, `queued` |
| `updating` | Updating | active | `reconnecting`, `failed`, `queued` |
| `reconnecting` | Reconnecting | active | `completed`, `failed`, `queued` |
| `failed` | Needs attention | resting | `queued` |
| `completed` | Complete | final | — |

Reported while still active, never stored:

| View | Shown as |
| --- | --- |
| `interrupted` | Interrupted |

- Only "completed" is final. "failed" rests until the owner resumes or recovers, which moves the same record back to "queued" with its attempt count raised.
- "interrupted" is never stored: it is what a record still in a working state is reported as once its worker process is gone. Resuming it also returns the record to "queued".
- A resumed worker skips the stages the record shows are done, which is why "queued" can lead straight to "updating" or "reconnecting".
- Flags such as runtimeCompleted, applicationCompleted and requiresLocalRecovery are facts on the record, not states.
- An unlisted move between two known, non-final states is reported rather than refused outside tests, for the same reason as update-journal.
- The updater carries its own copy of this table in cli/lib/product-update-lifecycles.js, because the update worker and the recovery controller run from retained copies of cli/lib that cannot import shared/. A test keeps the two identical.

## update-journal

The crash-resumable cutover of an installed home from one software package to the next.

- Record: Update journal (journal.json in the home's update directory)
- Authority: `cli/lib/product-update-apply.js`
- Starts as: `claimed`

| State | Shown as | Kind | Can become |
| --- | --- | --- | --- |
| `claimed` | Claimed | active | `quiesced`, `aborted`, `recovery_required` |
| `quiesced` | Home stopped for update | active | `checkpointed`, `aborted`, `recovery_required` |
| `checkpointed` | State checkpointed | active | `retained`, `aborted`, `recovery_required` |
| `retained` | Previous software retained | active | `applying`, `aborted`, `recovery_required` |
| `applying` | Switching software | active | `selected`, `aborted`, `recovery_required`, `writers_admitted`, `accepted`, `rolled_back` |
| `selected` | New software selected | active | `verifying`, `writers_admitted`, `accepted`, `rolled_back`, `recovery_required` |
| `verifying` | Verifying | reserved | `writers_admitted`, `accepted`, `rolled_back`, `recovery_required` |
| `writers_admitted` | Home restarted | active | `accepted`, `rolled_back`, `recovery_required` |
| `accepted` | Accepted | active | `committed`, `recovery_required` |
| `recovery_required` | Needs recovery | resting | `claimed`, `selected`, `verifying`, `writers_admitted`, `accepted`, `committed`, `rolled_back`, `aborted` |
| `committed` | Updated | final | — |
| `rolled_back` | Rolled back | final | — |
| `aborted` | Not updated | final | — |

- A final journal is archived and a new update starts a new journal; a final journal is never written again.
- "recovery_required" records the state it was fenced from in recoveryFrom. It rests until a resume, an owner recovery or a workspace reconciliation moves it on.
- "verifying" is accepted from journals written by earlier builds; the current updater never writes it.
- Unlike the other lifecycles, an unlisted move between two known, non-final states is reported rather than refused outside tests: refusing a durable write in the middle of a cutover could strand a home. Unknown states and moves out of a final state are always refused.
- The updater carries its own copy of this table in cli/lib/product-update-lifecycles.js, because the update worker and the recovery controller run from retained copies of cli/lib that cannot import shared/. A test keeps the two identical.
