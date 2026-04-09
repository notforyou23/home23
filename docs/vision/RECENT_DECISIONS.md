# RECENT_DECISIONS

Last updated: 2026-04-03
Purpose: recent HOME23 corrections, tranche decisions, and hard-won truth.

## Runtime truth decisions
- Do not describe HOME23 as only an operator shell anymore; it now has a real runtime/session seam.
- Do not describe HOME23 as full harness parity yet; it still lacks a deeper long-lived orchestrator/execution layer.
- Live handoff is now a backend action, not a query-param/UI trick.
- Runtime truth now includes an execution layer: checkpoints, syntheses, and session execution state are durable.
- Security truth now includes live enforcement: remote provider/brain access and disabled channel ingress are no longer just labels.
- The house engine is now a real long-lived backend loop for active instances, not just scheduler and queue helpers floating around it.

## Engine decisions
- The house engine is now the center of active runtime behavior and should remain the center of future work.
- Queued chat and due scheduler work should flow through the engine loop, not through disconnected helper paths.
- Engine-native memory review should happen inside the engine loop after new turns, not as a fake sidecar path.
- Engine review output should be promoted into real artifact/history/workflow surfaces, not left as hidden session metadata.
- Engine review promotion should also synthesize a first-pass objective contract with explicit steps/checkpoints, not just a single focus label.
- The engine should execute the derived objective steps sequentially when the objective contract is ready, not leave them as passive planning.
- Objective-step tool use should run through the same real shell-policy lane as scheduler exec, not a hidden bypass.
- Objective-step tool use should be drawn from a small explicit palette first, so the system stays truthful about what it can currently do.
- The controlled palette should prefer reading real persisted house-history surfaces over vague filesystem theater when possible.
- Blocked objective work should write explicit workflow/runtime evidence and a resolution task, not silently stall.
- Blocked objective evidence should carry reason, required capabilities, and resolution title metadata all the way into runtime/workflow surfaces.
- Engine re-entry after a blocked objective step should key off required capabilities being satisfied, not only a hard-coded shell toggle.
- The control plane should expose one-click posture resolution for blocked objective work instead of making the operator hunt through separate sections.
- Objective-tool selection should respond to current objective/operator content and search the most relevant persisted evidence surfaces, not only fixed default files.
- Shell policy should classify a broader set of direct-write commands honestly under self-modify posture, not treat `sed -i`, `tee`, `install`, or `ln` as opaque failures.
- Scheduler creation should reflect cron posture honestly: cron-off jobs may be persisted for planning, but they should be created disabled and not look runnable.
- The first non-`every` scheduler expansion should be one-shot `at` jobs, because that behavior is already real in the runtime core and maps cleanly to truthful UI/backend support.
- The first write-capable objective expansion should still go through the managed shell lane; checkpoint note writing via `tee` + stdin is acceptable, but hidden write bypasses are not.
- Once the engine writes a local note through that lane, the output file should be promoted into first-class artifact/runtime/workflow evidence with a stable house-relative path.
- Intent should still select the write-capable checkpoint tool even when file-write posture is off; the managed shell policy should be the thing that blocks it honestly and drives operator resolution.
- Once local house notes exist, note-review objectives should prefer reading the latest real note output over generic artifact history.
- The next write-capable checkpoint expansion can be a structured local status file, as long as it still runs through the managed shell lane and later status-review objectives can read it back directly.
- A working brief/checklist file is also a valid write-capable checkpoint output, as long as it runs through the same managed shell lane and later brief-review objectives can read the latest real brief back directly.
- Once multiple engine output file types exist, the artifact surface should classify them explicitly (`note` / `status` / `brief`) instead of burying them in generic artifact lists.
- Once those engine outputs are listed, the control plane should also offer safe read-only content preview so operators can inspect them without leaving the app.
- Generic review intent like “latest output” should be able to resolve to the newest real local engine output, but explicit note/brief/status wording should still win over the generic fallback.
- A local receipt/proof file is also a valid checkpoint output, as long as it stays on the same managed shell lane and receipt-review objectives can read the latest real receipt back directly.
- Do not confuse the current first-pass house engine with full COSMO-class autonomy; deeper objective pursuit is still missing.

## Settings/auth decisions
- Provider execution must go through adapter registry, not raw fetch. Ported from Cosmo 2.3.
- Model catalog is single source of truth (`model-catalog.ts`), derived from Cosmo 2.3's BUILTIN_MODEL_CATALOG.
- Ollama endpoint stored as base URL (`http://127.0.0.1:11434`), not `/v1/chat/completions` path. Adapter handles path construction.
- Model selection in onboarding must be discovery-first, not hardcoded model lists.
- Provider auth truth belongs in the backend credential store, not only in onboarding form state.
- Reuse local auth lineage where it is already real: `.codex`, `.evobrew`, and `.openclaw`.
- Provider readiness and reconcile should surface importable local lineage explicitly instead of hiding it behind a generic missing-credential state.
- Provider sync should seed the broader model-role surface (`fast`, `strategic`, `coding`) from catalog truth and discovered local models, not stop at `chat` and `embedding`.
- OAuth browser start/callback parity is now real alongside the existing credential import/storage seam.
- Do not guess at the working provider/model path when live user evidence exists; copy the proven live setup instead.
- The actual known-good observed path from the user’s machine was `ollama` at `http://127.0.0.1:11434` with cloud-tagged models, not `ollama-cloud`.

## Runtime contract decisions
- Resume is no longer only a boolean. Use `resumeCompatibility` + `resumeReasons`.
- Every run should carry a `sessionId` and a persisted `runSessions` record.
- Session memory should include turn count, last operator/assistant messages, and latest brain query summary.
- Resume compatibility should drive runtime behavior at least at the review/block level, not just metadata.
- Write `run.checkpoint.recorded` and `run.synthesized` receipts as durable execution evidence.
- Session memory should now carry explicit engine-review state so autonomous memory refresh is visible and durable.
- Engine review promotion should create real on-disk artifact files under instance state, not synthetic UI-only entries.
- Workflow/objective truth should be derived from the promoted engine review, not invented separately in the UI.
- Objective execution truth should be tied to durable artifact/timeline/checkpoint outputs, not silent state mutation.
- When shell posture blocks objective-step tool use, the engine must honestly stop progression instead of pretending advancement happened.
- Runtime and workflow surfaces should expose tool IDs/artifact paths for objective execution so operator evidence stays inspectable.
- When the operator resolves shell posture, the engine should re-enter the blocked step honestly instead of requiring hidden state surgery.
- Security posture changes during an active run should write a checkpoint and mark the session for review.
- A transient provider execution error must not make the main chat path behave as if no provider exists at all.

## Product-shape decisions
- The current biggest problem is product shape, not backend seam depth alone.
- Chat must be a first-class front door, not a textarea hidden inside admin/comms surfaces.
- Provider/runtime/admin controls should not dominate the main launch path; advanced controls must be demoted.
- One-house-at-a-time simplicity matters more right now than exposing the full multi-instance/operator surface.

## Truth-cleanup decisions
- Stop seeding fake runtime tool counts.
- Stop seeding fake default cron jobs until a real scheduler loop exists.

## Scheduler decisions
- Scheduled jobs are now real only where behavior is real: `every` cadence plus `agentTurn`, `systemEvent`, `query`, and `exec` payloads.
- Scheduled agent turns must flow through the same runtime/session seam as operator chat.
- Scheduled `query` work must execute as engine-native brain/memory review tied to the active run session.
- `exec` scheduler payloads are now real shell jobs and must be gated by `shellEnabled`.
- When file writes or self-modify are restricted, exec jobs must fall back to simple direct commands with explicit target-path checks, not a full shell free-for-all.

## Next-cut decisions
- The next tranche should deepen executable objective pursuit on top of the new query/memory/artifact/objective engine layer.
- The current truthful floor is now sequential context/attention/checkpoint execution; next cuts should add richer tool-using work, not revert to passive planning.
- Keep mapping every new runtime feature back to the original engine-centric HOME23 intent, not just control-plane completeness.
- Engine-local `note`, `brief`, `receipt`, and `status` outputs should now live at stable working-file paths in the instance root, not only as timestamped write-once files.
- Rewrites of those working files must stay on the same managed shell seam and record truthful `artifact.created` / `artifact.updated` evidence instead of pretending every update is a new file.
- Those living working files should also be searchable/readable through the controlled objective-tool palette, so engine context work can inspect them directly without bypassing the managed shell seam.
- Append/update intent for living markdown working files should reuse the same paths and flow through managed `tee` writes, not a new privileged file-edit lane.
- When a living working brief or note already exists, generic engine context work should prefer that living file over a generic `run-sessions` dump, because the working file is now part of the real execution surface.
- If generic context work has no living brief yet, the engine should seed one through the managed shell seam so there is always a durable narrative/checklist surface for ongoing work.
- Update intent should be reflected truthfully in tool IDs (`update-*` vs `write-*` / `append-*`) so receipts and workflow evidence describe what the engine actually did.
- Once that living brief exists, generic context work should keep updating it instead of treating it as a static read-only artifact.
- The control-plane runtime surface should expose the living working brief and working status directly as primary runtime state, not force the operator to discover them only through the artifact browser.
- With the engine/runtime seam now much stronger, the next 95%-push must pivot hard into provider/settings parity, especially real browser OAuth and live provider-config mutation.
- Browser OAuth, stored OAuth payload handling, and live provider settings mutation are now real: focused provider API tests and both web builds passed.
- Provider import compatibility should accept both the canonical credential-import path and the older OAuth-import route shape, because local-auth lineage still shows up through both mental models.
- HOME23 API test servers should close idle/all connections on shutdown so focused localhost-backed validation does not hang after successful provider-flow checks.
- Live provider settings must support true clearing/removal semantics, not only merge-forward edits, otherwise stale model/endpoint state survives and settings parity stays fake.
- Provider `enabled` state must affect readiness, active-provider counts, resume truth, and runtime provider selection; it cannot be a decorative flag.
- The control plane should use provider-catalog recommendations/reset controls to edit model-role settings more like COSMO/Evobrew, instead of leaving every field as blind free text.
- Provider settings saves must enforce provider-catalog auth-mode truth server-side, so impossible combinations like `openai + oauth` are rejected instead of silently stored.
- Onboarding should consume the same live provider catalog for defaults, recommendations, and allowed auth modes that the control plane/backend use, so setup and later settings management stay in the same truth system.
- Provider settings saves should also reject impossible capability lanes like embeddings on a non-embeddings provider or a local-model lane on a non-local provider, instead of preserving fantasy config.
- The operator should see warning copy before switching into an auth mode without matching stored credentials, so “saved” and “ready” do not get conflated in the UI.
- Readiness truth should be visible where operators act: the provider registry and runtime lifecycle surfaces should show live usable-path status and blocked reasons, not force the operator to infer them from failed activation.
- Once that readiness truth exists, runtime activation and handoff controls should respect it directly, and control-plane action failures should surface the backend’s real error message instead of generic HTTP status text.
- Any “providers ready” summary metric must follow the same enabled/configured truth as readiness/runtime selection; disabled providers cannot still count as ready in the header.
- The onboarding provider stage should also surface whether there is likely any usable provider path yet, so launch blockers are visible before bootstrap completion.
- The final review/create stage should run the same kind of launch-readiness preflight and skip automatic handoff honestly when likely launch blockers still exist, instead of turning every failed handoff into a surprise error after bootstrap.
- Resume compatibility should not stay passive metadata: the operator needs an explicit accept/unblock control when continuing a run across settings changes, so the runtime can move from review-required/blocked back to ready honestly.
- Provider settings should also expose reusable preset bundles across onboarding/control plane, so the system feels more like a real settings architecture than a bag of disconnected fields.
- Provider state also needs a real reconcile/sync lane from live discovery + stored credentials, especially for local/dynamic providers, so the instance view can catch up to reality without hand-editing fields one by one.
- Once that sync lane exists, common control-plane credential/settings mutations should trigger it automatically, and operators should still have a one-click sync-all escape hatch.
- The same living-file preference should extend into generic engine attention/checkpoint work, especially toward the working status surface, so the engine keeps using its real in-house working state instead of defaulting back to generic histories too early.
- If generic checkpoint work has no living checkpoint surface yet, the engine should seed a real working status through the managed shell seam instead of pretending a ledger read is enough working state.
- Once that living checkpoint status exists, generic checkpoint work should keep updating it through the same managed shell seam, not treat it as a static read-only artifact.

## Documentation/testing decisions
- Prefer targeted focused tests over broad slow suites during iterative work.
- Keep `docs/HOME23_RUNTIME_TRANCHE_STATUS.md`, `docs/HOME23_HANDOFF_PLAN.md`, `docs/HOME23_GAP_MAP.md`, and `planning/TRACKER.md` aligned with code truth before compaction/handoff.
- Be explicit that `apps/home-api` still has unrelated baseline TypeScript build errors; do not overclaim full clean builds.

## Checkpoint decision
- Compact/handoff checkpoint is now commit `a6c39eb` `provider: add reconcile sync flow`.
