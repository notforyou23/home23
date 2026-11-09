# Lifecycles

<!-- Generated from shared/lifecycles.cjs by `node cli/home23.js lifecycles --markdown`. Do not edit by hand. -->

Each lifecycle below is declared once, in `shared/lifecycles.cjs`. The store named as its authority
refuses any move the table does not list, and readers ask the catalog which states are final.
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
