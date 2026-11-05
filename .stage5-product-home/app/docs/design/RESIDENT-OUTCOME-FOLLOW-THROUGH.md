# Resident follow-through after work outcomes

Connected Agents must distinguish an execution result from the accountable resident reviewing it. Core now keeps a durable outcome inbox in schema 14. Terminal Working Threads and authenticated detached-specialist terminal evidence each have one stable outcome key. The original result remains evidence; a separate canonical resident turn evaluates it against the owner request and current channel conversation.

## Execution and recovery

Core discovers terminal Work after the migration enable time; it does not wake on unrelated historical jobs. Failed/cancelled Work does not require a successful result Message to trigger follow-through. Successful Work waits for its durable result. Detached-specialist discovery reads bounded event-sequence pages, with checkpointed progress and idempotent replay; it never rescans the entire communication journal on each tick. Working Thread evidence scans start at that Work's indexed creation event rather than parsing older communication history.

The queue persists the prepared context before creating a review Work with an outcome-derived idempotency key. A crash between Work creation and linking reuses the same Work. Reviews use normal signed resident transport, Work/Attempt/Lease fencing, persisted model selection, completion delivery and reattachment. Failed or cancelled reviews produce one honest interruption notice instead of an unbounded retry or silent disappearance. Foreground work takes priority; reviews for a channel are serialized. Context includes the original owner message even when it is outside the recent message page, plus a bounded recent transcript. The original request remains in the review instruction and manifest but is excluded from historical backfill, as required by the resident transport. Recovery normalizes already-saved review snapshots at that boundary. Dispatch failures are logged. Once execution is admitted, its snapshot remains stable during reattachment.

The review receives worker evidence as quoted data. It must verify relevant outcomes, finish remaining authorized work, respect later corrections, and never restart an intentional Stop. A worker response is not new authority. The model still decides what verification and continuation are appropriate; a recorded review is not proof of correctness. Tools, source-write restrictions and coding-backend permissions remain in force.

## Coding capability selection

Specialists can declare analysis, local-state changes or source changes through `task_kind`. Declared source changes are refused before detachment/allocation with a concrete route to `coding_run`; local-state changes require a files or shell grant. Resident instructions require selecting the coding route for tracked source. This validates declared needs, not arbitrary natural-language task understanding, and does not expand specialist privileges.

## Provider deadlines

Tracked Codex requests now share the turn's renewable inactivity deadline and fixed hard deadline. Meaningful streamed deltas and completed output items renew inactivity; empty keepalives do not. The existing turn defaults remain 15 minutes inactivity and eight hours maximum, with per-turn overrides. Streaming never extends the hard ceiling. Raw untracked calls retain a bounded hard deadline. Timeout and cancellation causes are preserved instead of being indiscriminately wrapped as provider failures. Shutdown explicitly records `harness_shutdown` before transports close.

## Acceptance

`npm run test:resident-outcomes` covers real AgentLoop streaming past two minutes, inactivity, hard ceiling, Stop, shutdown, capability refusal before allocation, durable success/failure/cancellation review, foreground priority, late corrections, lost result delivery, and failed review reporting. Coordination database tests validate forward migration, catalog checksums and reopen. Existing separate-process tests protect Working Thread execution and signed transport. Live acceptance must demonstrate a distinct resident follow-through turn without another owner message; result delivery alone is insufficient.

Schema 14 is additive but older binaries refuse newer schema. Preserve a consistent pre-cutover backup and use a reviewed forward repair after new writes; do not restore stale state simply to switch packages.
