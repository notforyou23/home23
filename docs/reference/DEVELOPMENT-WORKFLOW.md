# Home23 development working agreement

Home23 is a product that its owner uses while it is being developed. Codex, Claude, Cursor and Home23 agents contribute to the same product. Tool choice does not change source ownership, completion criteria or authorization already given by the owner.

## Source and runtime

Use the maintained backend repository for backend, engines, web dashboard and substrate source, and the maintained Apple repository for shared Apple clients. The local development workspace README identifies their paths. Task worktrees belong to those repositories; old release candidates and preserved worktrees are historical until explicitly reconciled.

The live installation owns configuration, credentials, resident state and selected release pointers. Managed Core and harnesses execute a verified package; some engine, dashboard and substrate services still execute installation files. A source commit is not evidence of deployment. Never overlay a source checkout onto a live installation.

Read repository AGENTS.md and applicable local instructions before work. Historical handoffs are evidence, not current authority. Check the current branch, changed files, remotes, selected package and relevant app receipts. The source reconciliation baseline may be historical; do not update it just to silence a warning.

## Concurrent work

State the outcome and the files or components you are taking responsibility for. Preserve work already present, including untracked files and work owned by another session. Do not switch branches under another active editor, broadly stash, reset or clean the maintained checkout.

For concurrent assignments that may overlap, create a task worktree from a reviewed current maintained source commit. Keep it associated with its repository and leave a handoff identifying its branch, starting commit, changes, verification and remaining work. An agent receiving delegated work owns its return through integration; a successful dispatch is not completion. Do not launch replacement attempts until existing attempts and their results are reconciled.

Worktree creation does not authorize spawning agents or starting extra tasks. Respect the owner's current pause, scope and communication instructions across background completions.

## Integration and GitHub

Review the actual diff and run checks relevant to the change. Commit only task-owned changes. Integrate reviewed work into the maintained product line; retain original work and receipts until integration is established. Patch equivalence is useful evidence, but does not prove that ignored files, runtime state or uncommitted changes can be deleted.

The intended destination is a reviewed main branch in each repository. Until the current branches are reconciled with GitHub main, use the live workspace status to identify the maintained branch; do not assume a branch named main is the current product. Record which commit has been pushed and which has only been committed locally. Pushing, publishing, production activation and installation require authorization covering those actions; reuse authorization already supplied for the task.

## Release and completion

For backend activation, follow docs/reference/MANAGED-RELEASES.md from the backend repository. Build a candidate on the actual deployed baseline, review differences, verify exact artifacts and prepare the scoped activation/recovery procedure before cutover. For installation-based services, identify exact affected source files and services separately. Never use an incidental backend task to deploy engines, dashboards or substrate changes.

For Apple work, preserve each app's identity and persistence. Select the maintained source and use the current build/install instructions in Apple AGENTS.md. Keep platform-specific receipts; identical build numbers do not establish identical source. Phone, Mac, iPad and TV work share the Apple repository without making every change a release on every platform.

A release record names the source commit and any included working changes, exact package or app artifact, verification, authorization, activation/install receipts, actual runtime readback and unresolved acceptance. A passed test, selected package, running process and physically accepted interface are different facts. Keep private installation paths, state and operational receipts out of public source commits.

At handoff, report what changed, where it is committed, what was verified, what is live, and what remains. Carry unfinished work forward without requiring the owner to reconstruct it from separate tool chats.
