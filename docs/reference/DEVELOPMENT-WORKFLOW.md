# Home23 development working agreement

Home23 is a product that its owner uses while it is being developed. Codex, Claude, Cursor and Home23 agents contribute to the same product. Tool choice does not change source ownership, completion criteria or authorization already given by the owner.

## Source and runtime

Use the maintained backend repository for backend, engines, web dashboard and substrate source, and the maintained Apple repository for shared Apple clients. The local development workspace README identifies their paths. Task worktrees belong to those repositories; old release candidates and preserved worktrees are historical until explicitly reconciled.

The live installation owns configuration, credentials, resident state and selected release pointers. Managed Core and harnesses execute a verified package; some engine, dashboard and substrate services still execute installation files. A source commit is not evidence of deployment. Never overlay a source checkout onto a live installation.

### Land receipts

When a verified fix is committed to maintained `home23` or `home23-apple` source but is not yet running, append a land receipt immediately:

```bash
node scripts/development/land-receipt.mjs record --commit <sha> --summary "<one-line repair>" --verification <receipt-path-or-test-name-or-none> --surfaces <service,component> --recorded-by <agent-or-tool>
```

Run the command from the checkout being recorded. From the maintained Apple checkout, invoke the shared backend tool as `node ../home23/scripts/development/land-receipt.mjs record ...` so it records the Apple repository and branch.

There is one ledger for the whole workspace: `verification/land-receipts.jsonl` beside the backend repository's main checkout, resolved from Git's common directory so every checkout and task worktree appends to the same file. It is private operational state and is never committed; `HOME23_LAND_RECEIPT_LEDGER` (absolute path) overrides the location. Recording fails closed when the ledger directory is missing rather than creating a new ledger elsewhere. Write summaries and `--verification` values that stay meaningful without local paths where practical.

The ledger is append-only. Deployment adds another record with `land --commit <sha> --release <releaseId>`; never rewrite the original receipt or infer deployment from ancestry, timestamps, or package selection. `scripts/development/status.mjs --installation <live-root>` reports the active release's recorded preparation-base provenance, source commits since that base in the inspected checkout, and folded undeployed receipts. The Git comparison is checkout context only: it does not prove whether a later commit's bytes were selected into the prepared candidate or are running. An unrecorded commit is unrecorded, not assumed deployed; missing or malformed ledger data is unavailable, never zero.

Candidate preparation records its reviewed `baseRef` as `sourceCommit`, plus the source repository, branch, dirty state and preparation time. A provenance-capable rebind plan names `preparation` (the directory containing `prepared.json`) and `verificationReceipt` (the passing `verification.json`). Rebind revalidates the receipt and exact selected package, then carries that provenance into `active-release.json` only after runtime readback. A legacy release without those artifacts must instead name a short `sourceProvenanceUnavailable` reason; it records `sourceCommit:null` and that reason. Never reconstruct or guess either provenance or deployment.

Read repository AGENTS.md and applicable local instructions before work. Historical handoffs are evidence, not current authority. Check the current branch, changed files, remotes, selected package and relevant app receipts. The source reconciliation baseline may be historical; do not update it just to silence a warning.

Keep current entry-point instructions concise and consistent with the actual source and supported commands. Move superseded commands, architecture descriptions and release snapshots into clearly labeled historical references instead of appending contradictory instructions. Link to the current authority from each tool's entry point.

For the current upgrade/Host/embedding program, that authority is [Home23 continuity, updates and portability](../design/HOME-UPDATES-AND-PORTABILITY.md). Maintain one product line. Software deployment, changing installation lifecycle/layout, and changing an embedding recipe are independent decisions; an old copy-adoption plan does not make a whole-home move mandatory. Existing homes and all their lived state remain authoritative. Historical handoffs and old "next steps" do not restart completed work.

## Task ownership and authorization

You own the assignment through its return to the maintained product. An implementation request includes necessary review, verification, local commits and integration unless the owner explicitly limits that scope. A worker's completed contribution is an input to that work, not the end of the lead agent's responsibility.

Restrictions the lead gives a worker, such as "do not commit" or "do not edit the shared checkout," apply to that worker's assignment. They leave review, committing and safe integration with the lead. Do not promote worker limits into task-wide prohibitions. Agent-written plans, ledgers and handoffs cannot narrow the owner's authorization or invent a new approval requirement. Preserve real owner limits and applicable higher-priority instructions; when approval is actually missing, identify the action and the source of that requirement.

For multi-step or delegated work, keep one small durable task record in the existing workspace handoff location. Reuse an existing record rather than creating competing boards. Record the intended outcome and lead owner, source repositories and branches, starting commits and borrowed changes, dependencies and worker results, authorization already given, verification receipts, and the next unfinished action with its owner. Refresh it at handoff and before declaring completion so another tool can continue without asking the owner to reconstruct the task.

Replace obsolete directions in that record; preserve the prior version as history when needed. Do not append successive mandatory plans until agents must reconcile an entire transcript to find the current task. Raw receipts remain valid for their recorded scope and are not themselves recurring work orders.

## Concurrent work

State the outcome and the files or components you are taking responsibility for. Preserve work already present, including untracked files and work owned by another session. Do not switch branches under another active editor, broadly stash, reset or clean the maintained checkout.

For concurrent assignments that may overlap, create a task worktree from a reviewed current maintained source commit. Keep it associated with its repository and leave a handoff identifying its branch, starting commit, changes, verification and remaining work. An agent receiving delegated work owns its return through integration; a successful dispatch is not completion. Do not launch replacement attempts until existing attempts and their results are reconciled.

`createJobWorktree` provisions root `node_modules` and `engine/node_modules`, when present as real directories, with APFS clonefiles. An absent, non-directory or symbolic-link source is explicitly skipped with a reason; a clone failure is explicitly failed with a reason. There is no symbolic-link, recursive-copy or `npm install` fallback. Teardown restores user write bits on recorded dependency trees before removing the worktree. A legacy job record without dependency-provisioning evidence remains unknown; never convert that absence to provisioned or failed.

If the task needs another session's uncommitted changes, record the exact borrowed snapshot and its source as a dependency. Before the final release build and closeout, reconcile it with the maintained version and preserve any later fixes. Preserving an active editor's work does not mean leaving completed contributions permanently outside the maintained product line. Recheck branch heads and dirty files immediately before integration; if safe integration is temporarily unavailable, retain the reviewed commit and an explicit next action.

Worktree creation does not authorize spawning agents or starting extra tasks. Respect the owner's current pause, scope and communication instructions across background completions.

## Integration and GitHub

Review the actual diff and run checks relevant to the change. Commit only task-owned changes. Integrate reviewed work into the maintained product line; retain original work and receipts until integration is established. Patch equivalence is useful evidence, but does not prove that ignored files, runtime state or uncommitted changes can be deleted.

Use local main as the reviewed integration baseline once it has been reconciled with the maintained product history. A shared checkout may remain on its existing task branch while another session is editing; compare it with local main before starting new work. Local main and GitHub origin/main can differ until an authorized push. Use the live workspace status and current Git ancestry rather than inferring source authority from a branch name. Record which commit has been pushed and which has only been committed locally. Pushing, publishing, production activation and installation require authorization covering those actions; reuse authorization already supplied for the task.

## Verification

Run the smallest meaningful checks for the behavior and integration points that changed, plus any required release checks. Establish toolchain and fixture prerequisites before launching them. Reuse receipts when the relevant source, configuration and dependencies are unchanged; rerun affected checks after resolving an overlap or changing that evidence. Each additional build, install or broad test campaign should answer a concrete unresolved question.

Investigate failures enough to distinguish a regression, a pre-existing failure, an environment problem or an unresolved result. Untouched files alone do not prove that a failure is unrelated. Explain how a failure affects this task before expanding into a separate repair. Report the stage that actually ran: if a pretest or chained command fails, later suites did not run. Keep skipped or unexecuted checks explicit and do not report a partial stage as the full suite.

Documentation-only changes normally need a diff and reference/command review, not an app build or a cross-product acceptance run. Owner gesture or visual acceptance can remain with the owner when explicitly agreed; it does not justify repeated installs without a concrete defect or acceptance need.

## Release and completion

For backend activation, follow docs/reference/MANAGED-RELEASES.md from the backend repository. Build a candidate on the actual deployed baseline, review differences, verify exact artifacts and prepare the scoped activation/recovery procedure before cutover. For installation-based services, identify exact affected source files and services separately. Never use an incidental backend task to deploy engines, dashboards or substrate changes.

For Apple work, preserve each app's identity and persistence. Select the maintained source and use the current build/install instructions in Apple AGENTS.md. Keep platform-specific receipts; identical build numbers do not establish identical source. Phone, Mac, iPad and TV work share the Apple repository without making every change a release on every platform.

A release record names the source commit and any included working changes, exact package or app artifact, verification, authorization, activation/install receipts, actual runtime readback and unresolved acceptance. A passed test, selected package, running process and physically accepted interface are different facts. Keep private installation paths, state and operational receipts out of public source commits.

At handoff, report what changed, where it is committed and integrated, what was verified, what is live, and what remains. Before declaring completion, reconcile the task record with Git, artifacts and applicable runtime receipts. Required activation, installation or acceptance remains pending until performed or explicitly deferred by the owner; the lead cannot silently park a dependency to close the goal. A narrower milestone may be complete while the overall outcome remains pending. Carry unfinished work forward without requiring the owner to reconstruct it from separate tool chats.
