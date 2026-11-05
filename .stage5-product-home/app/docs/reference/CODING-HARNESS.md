# Coding and delegation harness

The default workflow stays small: complete a local task directly when practical. Bring in coding jobs or subagents when isolation, concurrency, specialist context, or sustained execution justifies them. These mechanisms support execution; their successful exit does not establish that the user's outcome is complete.

## Enforced boundaries

- A tracked delegation carries its parent work ID, effective tool registry, and scoped worker prompt/workspace through the production runner. Resident children inherit the resident's effective tool registry. A nested child resolves delivery through the recorded parent to the original conversation.
- Delegated stopped/error/timeout outcomes cannot become successful child receipts. General subagents run in process; restart reconciliation marks unfinished work interrupted. Connected Agents also supports joined specialists with explicit capability grants and inline result delivery; those results must not be replayed through detached delivery.
- Selectable coding backends are Codex and Cursor. Legacy Claude Code and Grok adapters remain readable for old receipts, but new launches are rejected before creating a job or worktree. Coding adapters reject unsupported controls and tool lists before creating a job or worktree. Prompts beyond the supported length are rejected rather than silently truncated. The adapter code is the authority for supported controls.
- Continuation requires a terminal source, matching backend/workspace/session, and saved execution settings. Changed permission mode, sandbox, or extra arguments requires a new invocation after review. Legacy jobs without saved settings cannot resume.
- Coding bridges sharing a Home23 project root reserve the canonical Git checkout or exact non-Git working directory. Symlinks and Git subdirectories cannot bypass the reservation. Distinct Git worktrees remain independent. Ownership is serialized and token checked; uncertain ownership fails closed, and leases do not expire merely with age.
- A success stream event remains provisional until the process group exits and remaining output is drained. A captured nonzero exit takes precedence. Ordinary subprocesses in the same group retain the reservation after their leader exits. Cancellation intent is persisted and reapplied on recovery.
- Job IDs cannot traverse out of their storage directory; duplicate creation refuses overwrite. Terminal records and receipts remain available for inspection.
- Completion review receives the saved delegation brief separately from child claims. It must finish integration and verification included in that authority, without inferring permission to commit, deploy, or publish. Review is model-driven and still needs concrete evidence.

## Verification

Run `npm run test:harness` for the focused regression suite, and `npx tsc --noEmit` for TypeScript checking. The suite exercises the actual tracked AgentLoop and tool execution using scripted provider replies, plus real detached disposable CLI processes, process groups, filesystem leases, cancellation, recovery, completion delivery, and job storage. It does not need live model credentials or restart resident services.

For a live acceptance check after activation, use a disposable repository and a bounded coding task with an observable result. Verify the changed files and relevant test, a child tool's actual grants/workspace, the root conversation receipt, and a separate cancelled job. Record the selected backend/model and actual result. Scripted tests do not establish installed CLI authentication, model quality, or end-to-end production acceptance.

## Limits

A worktree or lease is not a machine sandbox. Direct shell tools, general subagents, other Home23 roots, overlapping non-Git directories, and processes that deliberately detach into another process group are outside the reservation boundary. Use disjoint ownership and backend sandbox controls appropriate to the task.

Restart recovery cannot reconstruct an exit code the old harness never persisted. Missing process identity or unreadable lease records require inspection rather than automatic cleanup. The store's atomic rename behavior is not a claim of power-loss-proof transactions.

The completion pipeline prevents overlapping deliveries within one process and remembers delivered receipts. External notification delivery is not a transactional exactly-once guarantee across a crash. A worker receipt, a reviewed report, and an integrated user outcome are separate evidence.

Codex/Cursor launches do not enforce `effort`, appended-system-prompt, tool allow/deny, or budget fields. Model capability and tool permissions are separate: a more capable model does not gain broader authority automatically.

Codex coding models are restricted to `gpt-5.6-sol` (default minimum) and
`gpt-6-astra`. Older or unknown configured models, overrides and continuation
settings fail before launch, with no downgrade. Extra CLI arguments cannot
override model, profile or provider selection; config arguments support only
quoted reasoning effort/summary values.

A detached coding CLI can still be killed by PM2 descendant-tree termination.
Never restart its managed host from a coding child; prepare the cutover and
run it from an independent operator terminal after active work drains.
