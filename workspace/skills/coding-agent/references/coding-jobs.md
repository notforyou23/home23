# Coding jobs

## Backend and context

`coding_backends` reports installed binaries and configured default models, not authentication or service health. An omitted backend uses `acp.defaultAgent`; an omitted model uses the backend configuration. The chat model is not automatically the coding model. Choose overrides only for a concrete need or explicit request; do not invent model names.

The child receives its coding task and the backend's session/repository context, not the parent conversation or Jerry's full assembled identity. Put relevant decisions and already-granted authority in the task. Do not copy private unrelated context.

Backend options are not portable: Claude Code maps effort, appended instructions and budget; Grok Build maps some of these; Codex and Cursor do not implement all fields exposed by `coding_run`. Unsupported nonempty controls are rejected before launch; tool allow/deny lists require allowlist permission mode. Consult `src/acp/backends.ts` before relying on a tool restriction, budget, or appended instruction as an enforced boundary. Put essential task limits in the task itself and use only a backend whose execution controls meet the job's requirements.

## Workspace selection

Home23 jobs default to a worktree from the current committed HEAD. Uncommitted edits, new files, dependencies, and local configuration are not copied. A worktree is file separation, not a machine sandbox: a child with shell access can reach other paths. Explicitly bound ownership and authorized side effects.

Inspect the target and current jobs first. If the task depends on uncommitted work, transfer only the necessary reviewed changes into the worktree or use an explicitly appropriate existing workspace. Do not assume a fresh worktree represents the live implementation. Never reset, broadly stash/pop, or discard existing changes to make integration easier.

Checkpoint mode edits the same checkout. Its `git stash create` object captures tracked changes only; untracked/ignored files are not backed up. Do not run simultaneous writers there. A checkpoint is not a full rollback facility.

## Lifecycle and completion

Start with `coding_run`; keep its `cj_...` ID and any `aw_...` tracking ID. Use `coding_jobs` to recover a lost job, `coding_status` for progress, and `coding_result` for the terminal receipt. Poll sparingly and do independent useful work while waiting.

`coding_continue` resumes a terminal job's backend session in the same directory; it creates a new job ID. It must not run beside the original process. Preserve the original workspace/authority in the follow-up. New job records retain the effective backend options and workspace provenance on continuation. If the configured permission mode, sandbox, or extra CLI arguments changed, continuation refuses to restore stale settings; review the current policy before starting a new job. Legacy jobs without that snapshot cannot continue; inspect the original invocation and start a fresh job with explicit supported settings. Budget flags remain backend-specific and may apply per invocation rather than cumulatively.

`coding_cancel` targets the coding job; `work_cancel` targets an async-work record. Confirm terminal status rather than treating a cancellation request as a completed kill. Detached coding processes can survive a harness restart. A success event is provisional until the process group exits; a captured nonzero exit overrides success. Home23 reserves the canonical checkout/directory across its coding bridges until then. This does not lock out direct shell writers, general subagents, or other tools; maintain disjoint ownership.

Inspect both committed and uncommitted changes in the job workspace. A branch merge alone will not capture uncommitted edits. Integrate only the authorized result against the current destination state, then check the affected behavior. Leave failed or partially integrated work recoverable; do not automatically force-remove worktrees.

The completion pipeline may deliver a review and receipt to the origin chat. Avoid repeating that as a second final result. A build or child receipt is evidence of that step, not proof of deployment, integration, or a physical outcome.

For enforced guarantees, the regression command, and remaining limits, see `docs/reference/CODING-HARNESS.md`.
