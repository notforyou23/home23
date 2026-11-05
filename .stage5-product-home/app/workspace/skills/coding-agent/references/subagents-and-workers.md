# General subagents and configured workers

## spawn_agent

Use for a bounded independent investigation or task when another Home23 run helps. A fresh sub-chat is the default. A resident child gets shared identity/context files but not the parent's conversation. A child of a scoped worker retains that worker's prompt and workspace. Detached children retain the invoking turn's tool grants. Joined specialists receive only explicit `tool_grants`; omission means no tools. Delegation does not expand authority. The task must carry the facts, decisions, ownership, and authority it needs.

`mode: "joined"` returns a bounded synthesis into the current answer. Canonical Working Threads keep nested specialists joined. `mode: "detached"` returns later and requires its canonical completion bridge. Read the registered schema for the current default. `isolated` means conversation separation only; joined mode requires true or omission. Detached mode outside a Working Thread may allow false, which shares parent history and can contend with an active parent turn. Both modes share the machine and files. Use a coding worktree for separate code-writing ownership.

Omitted model/effort use the harness defaults, not necessarily the parent turn's override. Model aliases and supported raw model names are resolved by Home23; invalid overrides fail before dispatch. Don't choose a weaker model just because the work is delegated, or a stronger one without a task reason.

For detached work, the returned async `aw_...` ID supports `work_status` and `work_cancel` when tracking is wired. Detached results are delivered to the root origin through the completion pipeline; joined results return inline and must not be replayed through it; a nested child is not a new user conversation. Its durable record survives restart, but its in-process execution does not: recovery marks unfinished runs interrupted. Do not describe these as durable CLI jobs.

There is no general follow-up or messaging tool for a running subagent in this interface. Do not invent one. If the task changes, inspect/cancel the existing work as needed and create a replacement only when duplicate execution is ruled out. Use the tool's reported concurrency limit.

## worker_run

Use `worker_list` to discover configured workers and their contracts. The worker has its own tool grants and verifier; do not assume it uses the same model, authority, or workspace as a chat or coding job.

`worker_run` returns a run ID and receipt summary. Use `worker_status` and `worker_receipt` for evidence. The synchronous first-slice worker connector does not support cancellation; do not promise that a stop killed its work. Memory promotion is a separate action with its own authority.

## Coordination

Parallelize independent work with disjoint ownership. Keep dependent steps in order. Brief children with what to discover rather than a guessed diagnosis. Review concrete outputs and integration points; avoid duplicated exploration, compulsory review chains, and repeated testing with no new evidence.
