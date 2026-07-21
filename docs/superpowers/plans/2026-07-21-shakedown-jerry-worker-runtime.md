# Home23 Worker Runtime + ShakedownJerry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the generic Home23 Worker runtime completely and deliver ShakedownJerry as Jerry's resident, production-operating worker for the full observe -> discover -> improve -> publish -> distribute -> convert -> learn -> recover loop.

**Architecture:** Jerry's existing Home23 harness owns lightweight per-worker runtimes. A strict manifest and signed standing grant resolve to an immutable execution profile; every request enters one authenticated durable SQLite/WAL queue; every consequential action crosses one `CapabilityExecutor.execute(envelope)` chokepoint; canonical receipts and destination-aware outboxes commit transactionally. ShakedownJerry uses typed deterministic adapters in the Shakedown repository, an independent pinned source clone, immutable code/site/data release journals, the existing Home23 Worker Desk, one Agency pursuit, and no separate engine, brain, dashboard, or PM2 family.

**Tech Stack:** TypeScript/Node.js, Express, `better-sqlite3`, Ajv, YAML, Home23 `AgentLoop`/`ContextManager`/`ConversationHistory`, CommonJS Home23 engine modules, React/Vite, Bun, Supabase Auth/Postgres, Stripe, Matomo, Caddy, PM2, launchd, `node:test`, Playwright/browser acceptance, Ed25519 signatures, RFC 8785 canonical JSON.

**Spec:** `docs/superpowers/specs/2026-07-21-shakedown-jerry-worker-runtime-design.md`

## Global Constraints

- This is one dependency-ordered delivery. A task may be completed and committed separately for review, but no task redefines a required capability as a later product version or optional parking-lot item.
- Use `superpowers:using-git-worktrees` before Home23 implementation. Resolve the commit that contains this plan, verify it descends from approved-spec commit `8050e5d90f56f6d0a21ff47944a2f5e4a5c7507b`, and create the isolated `codex/` worktree at `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime` from that resolved commit. Do not modify the user's dirty `main` worktree.
- Preserve the existing Home23 modifications to `engine/src/realtime/websocket-server.js` and `src/home.ts` plus its untracked backup, verification, and receipt artifacts. Recheck the inventory before every integration.
- The Shakedown checkout at `/Users/jtr/websites/shakedownshuffle.com` is a dirty, 125-commit-ahead `velvet-sunset` worktree at baseline `2f0c8323ab1e1846360b070904f39181da8fe834`. Do not switch its branch, index it, clean it, reset it, build into its shared `shakedown-v2/dist`, or use it as the worker's editing environment.
- Reconcile the clean acquisition/billing-hardening worktree commit `4f0dbb9` and the current live artifact into the worker-owned full clone before making Shakedown changes. Production is currently ahead of the active checkout for acquisition analytics; a build from stale source is forbidden.
- All Shakedown source edits happen in the independent clone at `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`, on a dedicated worker branch. Integration may update only `refs/heads/codex/shakedown-worker/*` and must prove the active checkout's branch, HEAD, index, worktree inventory, and configured remotes are unchanged.
- The canonical mutable Worker root is `/Users/jtr/_JTR23_/release/home23/instances/workers`, independent of immutable Home23 code releases and shared by the existing owner harnesses. Keep its directories mode `0700`, mutable files mode `0600`, snapshot/migrate it transactionally, and prove rollback/redeploy/restart preserve its SQLite, worker state, source clone, sessions, receipts, and activation records. Immutable code releases are read-only.
- The canonical mutable Shakedown data authority is `/Users/jtr/_JTR23_/shakedown-runtime-data`, outside every source checkout and immutable code release. Backend releases, collection, and enrichment must resolve the same hash-pinned root; the current checkout-relative data is copied and hash-verified during migration, never deleted as part of cutover.
- Preservation artifacts live outside both repositories and worktrees at `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime`; public manifests are redacted, and restricted archives/dumps are mode `0600` beneath mode-`0700` directories and never enter Git, model context, or immutable public release artifacts.
- All frontend builds use a run-specific immutable output directory. Never write shared `shakedown-v2/dist`; Caddy serves it publicly as `v2.shakedownshuffle.com`.
- Do not edit `/Users/jtr/websites/shakedownshuffle.com/html` directly. Only the typed site publisher may snapshot, overlay candidate-controlled files, verify, cut over, and roll back. It must preserve and hash-check `html/pro`, `html/env-config.js`, and the complete live-only allowlist.
- Live/public capabilities remain disabled until an authenticated operator activates the exact signed `shakedown-jerry-standing` grant hash. That single activation removes per-action approval inside scope; machine preconditions remain mandatory.
- Tasks before standing-grant activation may use fixtures, isolated clones, ephemeral services, local candidates, and byte-equivalent staged release trees only. Real site cutover, public/channel action, production backend restart, live data promotion, and social-image publication occur only in Task 31 after activation; the payment lifecycle remains separately authorized in Task 32.
- A production signup/payment/entitlement canary requires a separate exact hard-stop authorization naming the owned identity, Supabase/Stripe/site targets, maximum amount, exact lifecycle and cleanup operations, expiry, immutable runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/state-machine hashes, cleanup plan, and redaction policy. Sandbox success is supporting evidence, not production proof.
- Database schema, Auth configuration, billing, entitlement, credential, account-ownership, DNS-account, destructive data, spend, and bulk-message changes remain hard stops. Read-only Supabase/Stripe observation does not grant mutation authority.
- Supabase project `pkbnsqnkuoifudvbbdbe` is the current `shakedown` project. Re-run official changelog/docs checks before implementation because Supabase interfaces change; keep exposed-table grants least-privilege, RLS enabled, and authorization owner-scoped. Never expose a service-role/secret key to a client, prompt, transcript, artifact, or receipt.
- Every worker action, including nested typed actions, re-enters `CapabilityExecutor.execute(envelope)`. Worker code may not call the generic `ToolRegistry.execute`, a deterministic adapter, shell, browser driver, database writer, or network client directly.
- Write `action_started` durably before side effects. Treat an uncertain consequential outcome as `reconciliation_required`; perform authoritative readback and never blindly repeat a post, send, promotion, cutover, or payment-adjacent action.
- The finite safety reserve is non-model, persistent across restart, and usable only for mandatory verifier/rollback steps after cutover. Exhaustion freezes only the affected target and creates an urgent Jerry-visible item.
- Preserve actual failure, denial, verifier, semantic, rollback, and consequence status in every projection. Raw transcripts never auto-promote to memory; only receipt-declared, verified `memoryCandidates` do.
- Keep the existing 120-second watchdog as the deterministic `jerry-api` recovery owner, keep `ops/dynamic-dns` independent and outside the grant, and keep Jerry Collection Manager/action-worker definitions until consequence parity is live-proven.
- Do not pause any current automation before its replacement has produced the required real consequence receipt, survived restart, and has a verified next wake. Pausing is recoverable; definitions and historical receipts are never deleted.
- Commit after each green task with only that task's intended files. Never stage or commit unrelated user-owned changes.
- Every command runs from either `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime` or the absolute Shakedown clone root above. Use `git -C` or an explicit subshell for every cross-repository command; never rely on a previous `cd` carrying into the next step.

---

## File Structure

### Home23 — create

- `src/workers/schema.ts` — strict v1/v2 manifest and receipt validators plus compatibility translation.
- `src/workers/principal.ts` — immutable worker-management principals and operation scopes.
- `src/workers/auth.ts` — fail-closed Express authentication/authorization middleware.
- `src/workers/grants.ts` — Ed25519/RFC-8785 grant verification, precedence, activation-state lookup, and action-time recheck.
- `src/workers/signing-keys.ts` — public-key registry plus Keychain-backed grant/dispatch signing operations.
- `src/workers/hard-stop-authorizations.ts` — exact-hash, expiring, bounded, non-standing authorization validation.
- `src/workers/profile.ts` — immutable `WorkerExecutionProfile` resolution and deep freezing.
- `src/workers/store.ts` — SQLite/WAL migrations and transactional requests, attempts, leases, locks, actions, journals, receipts, activation records, outbox, and event cursors.
- `src/workers/state.ts` — canonical opportunity/campaign/channel/action state APIs and atomic filesystem projections.
- `src/workers/dispatcher.ts` — enqueue, atomic claim, lease heartbeat/reclaim, retry, cancel, capacity, and startup reconciliation.
- `src/workers/runtime.ts` — per-attempt worker-specific loop/context/history/tool/brain construction.
- `src/workers/runtime-factory.ts` — concrete provider/model/credential-authority resolution at claim.
- `src/workers/budget.ts` — cumulative token/tool/runtime/artifact/retry budgets and finite safety reserve.
- `src/workers/brain-delegate.ts` — owner plus worker principal, scoped reads, and verified-candidate promotion.
- `src/workers/capabilities/types.ts` — action envelope, normalized targets, decisions, adapter contracts, and structured events.
- `src/workers/capabilities/executor.ts` — the sole action chokepoint.
- `src/workers/capabilities/registry.ts` — explicit capability definitions and filtered worker tool registry.
- `src/workers/capabilities/shakedown-adapter.ts` — fixed subprocess bridge from `CapabilityExecutor` to an immutable Shakedown runner release.
- `src/workers/adapter-dispatch.ts` — short-lived signed parent-action envelope and cancellation/progress transport.
- `src/workers/outbox.ts` — destination-aware delivery with acknowledgement, retry, and idempotency.
- `src/workers/projections.ts` — atomic filesystem receipt, audit feed, dashboard, and memory projections.
- `src/workers/client.ts` — the single authenticated management/dispatch client used by in-process callers.
- `src/workers/preservation.ts` — content-addressed dirty-worktree capture and verified clean-destination restoration.
- `src/workers/knowledge-import.ts` — provenance-preserving legacy knowledge classification and import.
- `src/workers/triggers/types.ts` — immutable external-event and trigger-mapping contracts.
- `src/workers/triggers/router.ts` — authenticated durable event-to-request routing.
- `src/workers/triggers/mappings.ts` — versioned typed bindings, debounce, cooldown, and loop suppression.
- `src/workers/triggers/replay.ts` — idempotent source-receipt replay.
- `engine/src/workers/dispatch-client.js` — CommonJS transport bridge to the canonical management service.
- `engine/src/workers/trigger-router.js` — engine-event validation and forwarding without a second state store.
- `shared/worker-credential.cjs` — signed scoped local-service credentials following the existing exact-claim credential pattern.
- `config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml` — grant-shaped, deliberately unsigned scope candidate ignored by the runtime authority loader.
- `config/worker-authority-grants/shakedown-jerry-standing.yaml` — populated, signed immutable policy materialized from the candidate only after all bound implementation hashes are final; inactive until exact-hash activation.
- `config/worker-signing-keys/home23-operator-primary.json` — tracked Ed25519 public key and status only; private keys never enter Git.
- `config/worker-channels/shakedown-jerry.yaml` — non-empty Substack, non-Substack, and consented-communications account registry.
- `config/worker-event-bindings/shakedown-jerry.yaml` — initial Shakedown event classes and routing policy.
- `config/worker-pursuits/shakedown-jerry.yaml` — one resident Jerry-owned pursuit definition.
- `config/worker-migrations/shakedown-jerry-automation-matrix.yaml` — versioned inventory and cutover authority.
- `cli/templates/workers/shakedown-jerry/worker.yaml`
- `cli/templates/workers/shakedown-jerry/workspace/IDENTITY.md`
- `cli/templates/workers/shakedown-jerry/workspace/PLAYBOOK.md`
- `cli/templates/workers/shakedown-jerry/workspace/NOW.md`
- `cli/templates/workers/shakedown-jerry/workspace/MEMORY.md`
- `scripts/capture-worker-preservation.mts` — tested one-shot capture wrapper for explicit repository roots.
- `scripts/bootstrap-shakedown-worker-clone.mjs` — isolated full-clone bootstrap and source reconciliation.
- `scripts/import-shakedown-legacy-knowledge.mts` — provenance-preserving legacy knowledge importer.
- `scripts/restore-worker-migration-fixtures.mts` — fixture-only installed-manifest migration rehearsal.
- `scripts/verify-worker-runtime-live.mjs` — generic live request/restart/outbox/consequence verifier.
- `scripts/verify-shakedown-jerry-live.mjs` — Shakedown capability and production-proof orchestrator.
- `scripts/deploy-home23-worker-runtime.mjs` — immutable owner-harness cutover, scoped restart, readback, and predecessor rollback.
- `tests/workers/preservation.test.ts`
- `tests/workers/manifest.test.ts`
- `tests/workers/principal.test.ts`
- `tests/workers/grants.test.ts`
- `tests/workers/profile.test.ts`
- `tests/workers/store.test.ts`
- `tests/workers/state.test.ts`
- `tests/workers/signing-keys.test.ts`
- `tests/fixtures/workers/grants/shakedown-jerry-standing.unsigned.yaml`
- `tests/workers/hard-stop-authorizations.test.ts`
- `tests/workers/dispatcher.test.ts`
- `tests/workers/capability-executor.test.ts`
- `tests/workers/runtime.test.ts`
- `tests/workers/budget.test.ts`
- `tests/workers/recovery.test.ts`
- `tests/workers/outbox.test.ts`
- `tests/workers/trigger-router.test.ts`
- `tests/workers/existing-workers-v2.test.ts`
- `tests/workers/concurrency.test.ts`
- `tests/workers/installed-worker-migration.test.ts`
- `tests/workers/shakedown-manifest.test.ts`
- `tests/workers/shakedown-authority.test.ts`
- `tests/workers/shakedown-schedules.test.ts`
- `tests/workers/shakedown-install.test.ts`
- `tests/workers/shakedown-adapter-transport.test.ts`
- `tests/workers/shakedown-capability-registry.test.ts`
- `tests/workers/shakedown-knowledge-import.test.ts`
- `tests/workers/shakedown-automation-absorption.test.ts`
- `tests/workers/shakedown-adapters.test.ts`
- `tests/scheduler/worker-run.test.ts`
- `tests/scheduler/home-scheduler.test.ts`
- `tests/cli/worker-runtime-deploy.test.js`
- `tests/contracts/worker-agents-v2.test.cjs`
- `tests/scripts/verify-worker-runtime-live.test.mjs`
- `tests/scripts/verify-shakedown-jerry-live.test.mjs`
- `tests/scripts/bootstrap-shakedown-worker-clone.test.mjs`
- `tests/engine/agency/authority-policy.test.js`
- `tests/engine/live-problems/remediators.test.js`
- `tests/engine/live-problems/dispatch-closure.test.js`
- `tests/engine/dashboard/worker-desk-api.test.js`
- `tests/engine/dashboard/worker-desk-ui.test.js`
- `tests/engine/workers/dispatch-client.test.js`
- `tests/engine/workers/trigger-router.test.js`

### Home23 — modify

- `src/workers/types.ts`, `src/workers/registry.ts`, `src/workers/runner.ts`, `src/workers/connector.ts`, `src/workers/receipts.ts`, `src/workers/scaffold.ts`, `src/workers/index.ts`
- `src/agent/loop.ts`, `src/agent/types.ts`, `src/agent/history.ts`, `src/agent/context.ts`, `src/agent/context-assembly.ts`, `src/agent/tool-result.ts`
- `src/agent/brain-operations/client.ts`, `src/agent/tools/index.ts`, `src/agent/tools/workers.ts`, `src/agent/tools/agency.ts`
- `src/scheduler/cron.ts`, `src/types.ts`, `src/home.ts`
- `cli/lib/worker-commands.js`, `cli/home23.js`, `cli/lib/generate-ecosystem.js`, `cli/lib/pm2-commands.js`
- `package.json`
- `contracts/schemas/worker-agents.schema.json`, `contracts/manifest.json`, `contracts/worker-agents.md`
- `contracts/fixtures/worker-agents.json`, `contracts/fixtures/worker-runs.json`, `contracts/fixtures/worker-run-receipt.json`
- `config/workers.json`, `config/cron-jobs.json.example`, `cli/templates/workers/systems/worker.yaml`, `cli/templates/workers/freshness/worker.yaml`, `cli/templates/workers/memory/worker.yaml`, `cli/templates/workers/parity/worker.yaml`, `cli/templates/workers/release/worker.yaml`, `cli/templates/workers/feeder/worker.yaml`
- `engine/src/agency/authority-policy.js`, `engine/src/agency/resident-kernel.js`, `engine/src/agency/pursuit-store.js`, `engine/src/agency/consequence-engine.js`
- `engine/src/good-life/regulator.js`
- `engine/src/live-problems/remediators.js`, `engine/src/live-problems/index.js`, `engine/src/live-problems/loop.js`
- `engine/src/realtime/websocket-server.js`
- `engine/src/channels/work/worker-runs-channel.js`, `engine/src/index.js`
- `engine/src/dashboard/server.js`, `engine/src/dashboard/home23-dashboard.html`, `engine/src/dashboard/home23-dashboard.js`, `engine/src/dashboard/home23-dashboard.css`
- `engine/src/dashboard/home23-settings.html`, `engine/src/dashboard/home23-settings.js`, `engine/src/dashboard/home23-settings.css`
- `scripts/guarded-pm2-save.mjs`, `scripts/home23-pm2-watchdog.cjs`, `scripts/home23-pm2-watchdog-daemon.cjs`, `scripts/lib/pm2-agent-identity-guard.cjs`
- `tests/scripts/guarded-pm2-save.test.cjs`, `tests/scripts/home23-pm2-watchdog.test.cjs`, `tests/scripts/home23-pm2-watchdog-daemon.test.cjs`, `tests/scripts/pm2-agent-identity-guard.test.cjs`
- Existing Worker, scheduler, agent-tool, Agency, Good Life, Live Problems, channel, dashboard, contract, and UI tests named in the tasks below.

### Shakedown worker clone — create

- `ops/shakedown-worker/package.json`
- `ops/shakedown-worker/package-lock.json`
- `ops/shakedown-worker/config/capabilities.v1.json`
- `ops/shakedown-worker/config/capability-target-pins.v1.json`
- `ops/shakedown-worker/config/channels.v1.json`
- `ops/shakedown-worker/config/live-only-artifacts.v1.json`
- `ops/shakedown-worker/config/home23-dispatch-keys.v1.json`
- `ops/shakedown-worker/config/task18-source-paths.txt`
- `ops/shakedown-worker/schemas/opportunity.v1.schema.json`
- `ops/shakedown-worker/schemas/campaign.v1.schema.json`
- `ops/shakedown-worker/schemas/channel.v1.schema.json`
- `ops/shakedown-worker/schemas/analytics-snapshot.v1.schema.json`
- `ops/shakedown-worker/lib/contracts.mjs`
- `ops/shakedown-worker/lib/home23-auth.mjs`
- `ops/shakedown-worker/lib/observe.mjs`
- `ops/shakedown-worker/lib/matomo-readback.mjs`
- `ops/shakedown-worker/lib/funnel-readback.mjs`
- `ops/shakedown-worker/lib/search-demand.mjs`
- `ops/shakedown-worker/lib/payment-readback.mjs`
- `ops/shakedown-worker/lib/billing-canary.mjs`
- `ops/shakedown-worker/lib/billing-canary-leaf.mjs`
- `ops/shakedown-worker/lib/operator-readback.mjs`
- `ops/shakedown-worker/lib/opportunity-ledger.mjs`
- `ops/shakedown-worker/lib/content.mjs`
- `ops/shakedown-worker/lib/collection.mjs`
- `ops/shakedown-worker/lib/enrichment.mjs`
- `ops/shakedown-worker/lib/indexing.mjs`
- `ops/shakedown-worker/lib/substack.mjs`
- `ops/shakedown-worker/lib/channel.mjs`
- `ops/shakedown-worker/lib/communications.mjs`
- `ops/shakedown-worker/lib/social-image.mjs`
- `ops/shakedown-worker/lib/campaign-readback.mjs`
- `ops/shakedown-worker/lib/channel-score.mjs`
- `ops/shakedown-worker/lib/site-release.mjs`
- `ops/shakedown-worker/lib/backend-release.mjs`
- `ops/shakedown-worker/lib/code-integration.mjs`
- `ops/shakedown-worker/lib/caddy-runtime.mjs`
- `ops/shakedown-worker/lib/data-authority.mjs`
- `ops/shakedown-worker/lib/runtime.mjs`
- `ops/shakedown-worker/lib/rollback.mjs`
- `ops/shakedown-worker/lib/receipt.mjs`
- `ops/shakedown-worker/scripts/run-capability.mjs`
- `ops/shakedown-worker/scripts/build-site-candidate.mjs`
- `ops/shakedown-worker/scripts/prepare-data-authority.mjs`
- `ops/shakedown-worker/scripts/scan-staged-source.mjs`
- `ops/shakedown-worker/scripts/sync-home23-config.mjs`
- `ops/shakedown-worker/scripts/verify-public-contract.mjs`
- `ops/shakedown-worker/tests/*.test.mjs`
- `ops/shakedown-watchdog/test/check-shakedown-health.test.mjs`
- `ops/shakedown-worker/tests/fixtures/observe-live-safe.json`
- `ops/shakedown-worker/tests/fixtures/configured-channels.json`
- `ops/shakedown-worker/tests/fixtures/live-webroot/env-config.js`
- `ops/shakedown-worker/tests/fixtures/live-webroot/pro/index.html`
- `shakedown-v2/src/pages/VenuePage.jsx`
- `shakedown-v2/src/pages/YearPage.jsx`
- `shakedown-v2/src/pages/DatePage.jsx`
- `shakedown-v2/src/pages/SongPage.jsx`
- `shakedown-v2/src/pages/LineupPage.jsx`
- `shakedown-v2/src/pages/LineagePage.jsx`
- `shakedown-v2/src/utils/discoveryRoutes.js`
- `shakedown-v2/scripts/build-discovery-routes.mjs`
- `shakedown-v2/scripts/matomo-reporting-readback.mjs`
- `shakedown-v2/scripts/search-demand-readback.mjs`
- `shakedown-v2/scripts/campaign-impact-readback.mjs`
- `shakedown-v2/scripts/validate-social-images.mjs`
- `shakedown-v2/test/discovery-route-generator.test.mjs`
- `shakedown-v2/test/discovery-metadata.test.mjs`
- `shakedown-v2/test/generated-route-browser.test.mjs`
- `shakedown-v2/test/sitemap.test.mjs`
- `shakedown-v2/test/matomo-reporting-readback.test.mjs`
- `shakedown-v2/test/search-demand-readback.test.mjs`
- `shakedown-v2/test/campaign-impact-readback.test.mjs`
- `jerry-api/tests/billing-lifecycle-integration.test.ts`
- `jerry-api/tests/data-authority.test.ts`

### Shakedown worker clone — modify and retain

- Reconcile commit `4f0dbb9` so `shakedown-v2/src/services/analytics.js`, `shakedown-v2/src/components/AnalyticsRouteTracker.jsx`, `shakedown-v2/src/context/AuthContext.jsx`, `shakedown-v2/src/context/AudioContext.jsx`, `shakedown-v2/src/pages/BrowsePage.jsx`, `shakedown-v2/src/pages/ShowPage.jsx`, `shakedown-v2/src/pages/SubscribePage.jsx`, `shakedown-v2/src/main.jsx`, `shakedown-v2/public/start/index.html`, `shakedown-v2/scripts/build-newsletter-pages.mjs`, and `shakedown-v2/test/analytics.test.mjs` become canonical source before further edits.
- Modify `shakedown-v2/src/App.jsx`, `shakedown-v2/package.json`, `shakedown-v2/scripts/build-article-pages.mjs`, `shakedown-v2/scripts/build-newsletter-pages.mjs`, `shakedown-v2/scripts/operator-check.mjs`, `shakedown-v2/scripts/shakedown-publish-pipeline.mjs`, `shakedown-v2/scripts/submit-indexnow.mjs`, and the exact tests named by Tasks 19–26.
- Wrap rather than rewrite `shakedown-v2/scripts/subscriber-funnel-readback.mjs`, `shakedown-v2/scripts/subscriber-communications-candidates.mjs`, `shakedown-v2/scripts/subscriber-communications-readback.mjs`, `shakedown-v2/scripts/substack-local-adapter.mjs`, `shakedown-v2/scripts/substack-browser-adapter.mjs`, and `shakedown-v2/scripts/substack-safari-preflight.mjs`.
- Preserve `jerry-api/src/routes/*`, checkout security, pending activation, Stripe webhook/entitlement reconciliation, favorites/history, listener-interest handling, and all show-enrichment source policy and tests.
- Preserve and wrap `ops/jerry-collection` authority reader, daily orchestration lock, non-audio, verification, collection, acquisition, quarantine, enrichment, release candidate/promoter, operator action, and receipt machinery.
- Preserve and wrap `ops/shakedown-watchdog/check-shakedown-health.mjs` and its shared-lock recovery core.

---

## Automation and Runtime Migration Matrix

The implementation must refresh this observed July 21 inventory before cutover and write the final values to `config/worker-migrations/shakedown-jerry-automation-matrix.yaml`. `Replacement proof` means a canonical Home23 receipt with the intended real consequence plus a restart-persistent next wake. `Rollback` means re-enable the exact prior definition or retain its independent executor; no row authorizes deletion.

| ID / runtime | Current state and root | Existing authority / receipt | Target role | Cutover and rollback |
| --- | --- | --- | --- | --- |
| `shakedown-publishing-pipeline-scan` | ACTIVE daily 09:30; project `a6c7749d-58e2-40cb-b8b8-14937c346bf5`; `shakedown-v2` | scan-only `outputs/publishing-pipeline/current.*`, activation/readiness receipts | `shakedown-resident-cycle` plus `shakedown.observe` and `shakedown.content.prepare` | Pause only after replacement scan and next wake; rollback sets this exact ID ACTIVE |
| `shakedown-show-detail-enrichment-ops` | ACTIVE daily 15:00; project `local-d809682e845259fed4906c24871b32a1`; site root | local collection/show-note receipts | `shakedown-daily-collection`, collection and enrichment triggers | Keep until separate collection and enrichment consequence proofs; rollback sets this exact ID ACTIVE |
| `shakedown-publishing-pipeline-unattended` | PAUSED daily 09:45; `shakedown-v2` | unattended readiness/promotion receipts | absorb into typed publication/distribution state machines | Keep paused; definition retained |
| `shakedown-publishing-v3-daily` | PAUSED heartbeat daily 09:05 | thread-local heartbeat history | absorb into resident cycle | Keep paused; definition retained |
| `shakedown-article-curation-pipeline` | PAUSED Monday 11:00; operator project `8b23f328-17b4-469b-8a09-0c608f741fc0` | operator article-curation receipts | content opportunity lane | Keep paused; definition retained |
| `shakedown-article-curation-pipeline-0a419e161e08` | PAUSED Monday 11:00; frontend project `a6c7749d-58e2-40cb-b8b8-14937c346bf5` | duplicate article-curation receipts | same content lane | Keep paused; definition retained |
| `shakedown-article-curation-pipeline-775817ffe366` | PAUSED Monday 11:00; Jerry project `2b937794-6ed9-4db5-9979-da95806c0842` | duplicate Jerry-workspace receipts | same content lane | Keep paused; definition retained |
| `shakedown-newsletter-distribution-ops` | PAUSED Tuesday/Friday 10:00; operator project | distribution receipts | Substack/channel capability | Keep paused; definition retained |
| `shakedown-newsletter-distribution-ops-0a419e161e08` | PAUSED Tuesday/Friday 10:00; frontend project | duplicate distribution receipts | same distribution lane | Keep paused; definition retained |
| `shakedown-owned-site-article-prep` | PAUSED Thursday 10:00; operator project | owned-site prep receipts | content/site-candidate capability | Keep paused; definition retained |
| `shakedown-owned-site-article-prep-0a419e161e08` | PAUSED Thursday 10:00; frontend project | duplicate prep receipts | same content lane | Keep paused; definition retained |
| `shakedown-post-publish-impact-readbacks` | PAUSED Monday/Thursday 12:00; operator project | campaign readback receipts | post-action one-shots | Keep paused; definition retained |
| `shakedown-post-publish-impact-readbacks-0a419e161e08` | PAUSED Monday/Thursday 12:00; frontend project | duplicate readbacks | post-action one-shots | Keep paused; definition retained |
| `shakedown-scheduled-publisher` | PAUSED daily 09:00; operator project | scheduled-publisher receipts | typed site/Substack dispatch | Keep paused; definition retained |
| `shakedown-scheduled-publisher-0a419e161e08` | PAUSED daily 09:00; frontend project | duplicate publisher receipts | same publication lane | Keep paused; definition retained |
| `shakedown-shuffle-operator-upkeep` | PAUSED daily; frontend project | operator-check/dashboard receipts | daily trust plus Live Problems | Keep paused; definition retained |
| `shakedown-shuffle-operator-upkeep-b0cf94a58745` | PAUSED daily; project `81409629-06ad-4031-9889-c0dec862ebda` | duplicate legacy operator receipts | same trust lane | Keep paused; definition retained |
| `shakedown-weekly-editorial-calendar` | PAUSED Sunday 18:00; operator project | editorial-control receipts | weekly strategy | Keep paused; definition retained |
| `shakedown-weekly-editorial-calendar-0a419e161e08` | PAUSED Sunday 18:00; frontend project | duplicate calendar receipts | weekly strategy | Keep paused; definition retained |
| `shakedown-weekly-editorial-calendar-7958a91b9879` | PAUSED Sunday 18:00; backend project `7a55c0cf-50b9-441f-a3d8-b53822b8f693` | duplicate backend-root receipts | weekly strategy | Keep paused; definition retained |
| `check-money-path-reviews` | PAUSED independent heartbeat | consumes only redacted money-relevant Shakedown summaries | retained independent money workflow | Never subsume; no Shakedown execution authority |
| `com.jtr.shakedown-watchdog` | loaded, 120-second launchd interval; site root | watchdog logs and recovery receipts | retained deterministic `jerry-api` recovery owner | Never pause for worker cutover; worker calls typed core under same lock |
| `com.jtr.shakedown-publishing-v3-chrome` | loaded, 60-second launchd interval | Chrome supervisor logs | retained browser-session supervisor | Keep while Substack browser adapter is configured; no reasoning role |
| `com.jtr.matomo` | loaded; `localhost:8081` | Matomo authority | retained analytics service | Never subsume; worker gets minimum read authority |
| `com.jtr.dynamic-dns` | loaded, 300-second launchd interval | DNS receipts | retained independent DNS operator | Explicitly outside standing grant |
| `homebrew.mxcl.caddy` | loaded system LaunchDaemon; `/opt/homebrew/etc/Caddyfile` | Caddy process/config hash and public route readback | retained primary web/proxy owner; worker may call fixed validate/reload only | Never replace; reload only after valid exact config and retain prior config/process readback |
| `com.jtr.caddy-static` | loaded LaunchAgent supervising Docker `caddy-static` on `18089` | LaunchAgent/container/audio HTTP readback | retained audio-static supervisor | Health/readback only; no runtime-strategy switch; exact prior definition is rollback |
| PM2 `home23-jerry-harness` | online owner harness | Jerry turns, worker claims, PM2/runtime receipts | hosts Jerry-owned worker runtimes in-process | Scoped rolling restart from immutable Home23 release; predecessor release/dump rollback |
| PM2 `home23-forrest-harness` | online owner harness | Forrest turns and owner-scoped claim denial receipts | retains Forrest and proves owner isolation; loads generic runtime library | Scoped rolling restart only when shared harness code changes; predecessor release/dump rollback |
| Home23 engine/dashboard processes | online under current PM2 topology | Agency, Good Life, Live Problems, Worker Desk routes | reload only the exact processes whose code changed | No new Worker process; predecessor release/dump rollback |
| PM2 `jerry-api` | online | API/health/runtime logs | retained backend service; immutable releases only | Typed scoped restart/rollback; never add competing backend daemon |
| audio static on port `18089` | Docker `caddy-static` observed online | audio HTTP readback | retained audio owner | Health/readback only; no runtime-strategy switch |
| Jerry Collection Manager/action worker | implementation retained; dashboard port `7777` not listening at observation | collection state, queue, action, and receipt files | retained until Home23 consequence and visibility parity | Pause duplicate scheduling only after separate parity proof; never delete |
| Home23 Shakedown crons | none currently installed in `config/cron-jobs.json` or resident Jerry/Forrest stores | no existing Shakedown cron authority | install four `workerRun` jobs and one-shots | rollback disables new jobs and restores prior automation states |

---

## Task 1: Isolate Home23 work and preserve both systems before mutation

**Working directory:** Begin in `/Users/jtr/_JTR23_/release/home23`; after Step 1, run all implementation commands in `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime` and address the original repositories only by absolute path.

**Interfaces:**
- Consumes: approved spec commit `8050e5d90f56f6d0a21ff47944a2f5e4a5c7507b`, this plan commit, and explicit Home23/Shakedown repository roots.
- Produces: `captureRepositoryState()`, `restoreCaptureToCleanDestination()`, content-addressed capture manifests, restricted restore metadata, and preserved Home23 patch identities for later release reconciliation.

**Files:**
- Create: `src/workers/preservation.ts`
- Create: `tests/workers/preservation.test.ts`
- Create: `scripts/capture-worker-preservation.mts`
- Modify by importing the preserved patch identity: `src/home.ts`
- Modify by importing the preserved patch identity: `engine/src/realtime/websocket-server.js`
- Create at runtime only: timestamped, content-addressed capture directories beneath `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime`, each containing `manifest.json`, `committed.bundle`, `source/`, and `restricted/`
- Create at runtime only: `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json`, an atomic redacted index of the latest fully restored-and-verified capture for each explicit repository root

- [ ] **Step 1: Create the isolated Home23 implementation worktree**

Invoke `superpowers:using-git-worktrees`, then resolve the commit containing this plan and use the exact branch/directory below after the skill's safety checks:

```bash
plan_commit=$(git log -1 --format=%H -- docs/superpowers/plans/2026-07-21-shakedown-jerry-worker-runtime.md)
git merge-base --is-ancestor 8050e5d90f56f6d0a21ff47944a2f5e4a5c7507b "$plan_commit"
git worktree add /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  -b codex/shakedown-jerry-runtime \
  "$plan_commit"
```

Run `git status --short --branch` in both Home23 worktrees. Expected: the new worktree is clean; the original dirty inventory is byte-for-byte unchanged.

- [ ] **Step 2: Write the failing preservation tests**

```ts
test('capture preserves local-only source and restores by hash without exposing secrets', async () => {
  const fixture = await makeDirtyRepositoryFixture();
  await writeFile(join(fixture.root, '.env'), 'SECRET=value\n');
  await writeFile(join(fixture.root, 'ops', 'local-tool.mjs'), 'export const ok = true;\n');

  const capture = await captureRepositoryState({
    repositoryRoot: fixture.root,
    destinationRoot: fixture.capture,
    sourceAllowlist: ['ops/**', 'src/**', 'tests/**'],
    restrictedAllowlist: ['private/**', 'runtime/**'],
    secretPatterns: ['**/.env', '**/*.key'],
  });

  assert.equal(capture.publicManifest.some((row) => row.path === '.env'), false);
  assert.equal(capture.restrictedArchive.mode, 0o600);
  const restored = await restoreCaptureToCleanDestination(capture, fixture.restore);
  assert.deepEqual(restored.sourceHashes, capture.sourceHashes);
  assert.equal(await readFile(join(fixture.root, 'ops', 'local-tool.mjs'), 'utf8'),
    'export const ok = true;\n');
});

test('capture rejects symlink escapes and never mutates the source repository', async () => {
  const fixture = await makeDirtyRepositoryFixture();
  await symlink('/etc/passwd', join(fixture.root, 'ops', 'escape'));
  const before = await repositoryFingerprint(fixture.root);
  await assert.rejects(() => captureRepositoryState(fixture.options), /symlink|escape/i);
  assert.deepEqual(await repositoryFingerprint(fixture.root), before);
});
```

- [ ] **Step 3: Run the test — expect FAIL because the preservation module is absent**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/preservation.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/workers/preservation.ts` or an equivalent missing-export error for `captureRepositoryState`.

- [ ] **Step 4: Implement content-addressed preservation and clean-destination restore**

`src/workers/preservation.ts` must:

- capture branch, HEAD, remotes, tracked diff hash, untracked and ignored inventories without changing index/worktree state;
- create a full local `git bundle` of committed refs;
- archive allowlisted local-only source/config by real path and SHA-256;
- keep private/runtime material in a mode-`0600` restricted archive under a mode-`0700` directory;
- exclude `.env`, keys, tokens, cookies, browser profiles, raw recipient records, and private listener content from the public manifest/model-visible receipt;
- scan file contents as well as names for credentials, session material, direct recipient identifiers, private payloads, and high-entropy secrets before admitting any public/source artifact;
- record whether FileVault or equivalent encryption at rest is available for the restricted root, without claiming encryption when the authoritative system readback cannot prove it;
- record a redacted restricted restoration order, file hashes, permissions, and required service dependencies without exposing contents;
- refuse symlinks, special files, path escapes, duplicate normalized paths, changed-during-capture files, and oversized unexpected inputs;
- restore source into a new clean destination, verify every hash, and prove the source repository fingerprint is unchanged.
- update `latest-public-manifest.json` only after capture plus clean-destination restoration passes, binding each repository root to its immutable content-addressed `manifest.json`; never point it at a partial or failed capture.

Implement and export these exact entrypoints, with destination confinement and post-copy hash verification in the restore path:

```ts
export interface CaptureRepositoryStateInput {
  repositoryRoot: string;
  destinationRoot: string;
  sourceAllowlist: string[];
  restrictedAllowlist: string[];
  secretPatterns: string[];
}

export interface RepositoryCapture {
  captureId: string;
  repositoryRoot: string;
  manifestPath: string;
  sourceHashes: Record<string, string>;
  publicManifest: Array<{ path: string; sha256: string; size: number }>;
  restrictedArchive: { path: string; sha256: string; mode: number };
  sourceFingerprintBefore: string;
  sourceFingerprintAfter: string;
}

export async function restoreCaptureToCleanDestination(
  capture: RepositoryCapture,
  destinationRoot: string,
): Promise<{ sourceHashes: Record<string, string>; destinationRoot: string }> {
  const confinedRoot = `${resolve(destinationRoot)}${sep}`;
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const [relativePath, expectedHash] of Object.entries(capture.sourceHashes)) {
    const target = resolve(destinationRoot, relativePath);
    if (!target.startsWith(confinedRoot)) throw new Error(`restore path escape: ${relativePath}`);
    const source = resolve(dirname(capture.manifestPath), 'source', relativePath);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`unsafe source: ${relativePath}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    if (await sha256File(target) !== expectedHash) throw new Error(`restore hash mismatch: ${relativePath}`);
  }
  return { sourceHashes: { ...capture.sourceHashes }, destinationRoot: resolve(destinationRoot) };
}

export async function captureRepositoryState(
  input: CaptureRepositoryStateInput,
): Promise<RepositoryCapture> {
  const sourceFingerprintBefore = await repositoryFingerprint(input.repositoryRoot);
  const capture = await writeContentAddressedCapture(input, sourceFingerprintBefore);
  const sourceFingerprintAfter = await repositoryFingerprint(input.repositoryRoot);
  if (sourceFingerprintAfter !== sourceFingerprintBefore) {
    throw new Error('source repository changed during capture');
  }
  return { ...capture, sourceFingerprintBefore, sourceFingerprintAfter };
}
```

- [ ] **Step 5: Run the preservation tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/preservation.test.ts
```

Expected: PASS with both preservation tests green and no files added to either source repository.

- [ ] **Step 6: Capture Home23 and Shakedown state and exercise restoration**

Use the tested API through a one-shot `tsx` invocation with these explicit roots:

```bash
node --import tsx scripts/capture-worker-preservation.mts \
  --repository /Users/jtr/_JTR23_/release/home23 \
  --repository /Users/jtr/websites/shakedownshuffle.com \
  --destination /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime
```

The script must include the active source/config areas `shakedown-v2`, `jerry-api`, `jerry-api/show-enrichment`, `ops/jerry-collection`, `ops/shakedown-watchdog`, and non-secret `ops/dynamic-dns` configuration. It must capture untracked local-only checkout/Stripe services, publishing/Substack/funnel/communications scripts, watchdog code, enrichment source, tests, and configuration by path/hash while rejecting secrets, generated outputs, receipts, screenshots, raw data, and caches. Restore public/source content first and restricted mutable state second into separate `mktemp -d` clean destinations; compare every hash and permission. Record capture IDs, manifest hashes, encryption-at-rest readback, and restoration order; do not print restricted contents.

- [ ] **Step 7: Prove representative restored source starts and reads authoritative fixtures**

From the clean restored Home23 tree, run `npm ci`, `npm run build`, `npm run test:contracts`, and the Worker preservation/registry tests. From the clean restored Shakedown tree, run the frontend generator/operator tests and `bun --cwd jerry-api test`; start the backend on an isolated test port against a restored fixture copy and prove `/health` plus one show readback. These checks must use no production ports or public paths.

```bash
home_restore=$(mktemp -d /tmp/home23-preservation-verify.XXXXXX)
shakedown_restore=$(mktemp -d /tmp/shakedown-preservation-verify.XXXXXX)
node --import tsx scripts/capture-worker-preservation.mts --restore-latest \
  --repository /Users/jtr/_JTR23_/release/home23 \
  --destination "$home_restore" \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime
node --import tsx scripts/capture-worker-preservation.mts --restore-latest \
  --repository /Users/jtr/websites/shakedownshuffle.com \
  --destination "$shakedown_restore" \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime
npm --prefix "$home_restore" ci
npm --prefix "$home_restore" run build
npm --prefix "$home_restore" run test:contracts
node --import tsx --test --test-concurrency=1 \
  "$home_restore/tests/workers/preservation.test.ts" \
  "$home_restore/tests/workers/registry.test.ts"
npm --prefix "$shakedown_restore/shakedown-v2" ci
npm --prefix "$shakedown_restore/shakedown-v2" run test:newsletter
npm --prefix "$shakedown_restore/shakedown-v2" run check:operator
bun --cwd "$shakedown_restore/jerry-api" test
NODE_ENV=development PORT=3105 \
  bun --cwd "$shakedown_restore/jerry-api" run src/server.ts >"$shakedown_restore/jerry-api-isolated.log" 2>&1 &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT
curl --fail --silent --show-error http://127.0.0.1:3105/health
curl --fail --silent --show-error 'http://127.0.0.1:3105/api/v1/shows?limit=1'
kill "$api_pid"
wait "$api_pid" || true
trap - EXIT
```

Expected: dependency installation, builds, contract/Worker/frontend/backend tests, `/health`, and the one-show readback all succeed; neither port `3005` nor a public URL is contacted.

- [ ] **Step 8: Prove both original worktrees remain unchanged**

Run `git status --porcelain=v2`, `git branch --show-current`, and `git rev-parse HEAD` before and after capture in both original repositories. Expected: exact equality. Confirm the live `html`, shared `shakedown-v2/dist`, PM2 table, launchd definitions, and automations were not changed.

```bash
node --import tsx scripts/capture-worker-preservation.mts --verify-source-unchanged \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --repository /Users/jtr/_JTR23_/release/home23
node --import tsx scripts/capture-worker-preservation.mts --verify-source-unchanged \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --repository /Users/jtr/websites/shakedownshuffle.com
node --import tsx scripts/capture-worker-preservation.mts --verify-runtime-inventory \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --live-root /Users/jtr/websites/shakedownshuffle.com/html \
  --shared-dist /Users/jtr/websites/shakedownshuffle.com/shakedown-v2/dist \
  --automation-root /Users/jtr/.codex/automations
git -C /Users/jtr/_JTR23_/release/home23 status --porcelain=v2
git -C /Users/jtr/_JTR23_/release/home23 branch --show-current
git -C /Users/jtr/_JTR23_/release/home23 rev-parse HEAD
git -C /Users/jtr/websites/shakedownshuffle.com status --porcelain=v2
git -C /Users/jtr/websites/shakedownshuffle.com branch --show-current
git -C /Users/jtr/websites/shakedownshuffle.com rev-parse HEAD
```

Expected: both source comparisons and the live-artifact/PM2/launchd/automation inventory comparison exit zero against the pre-capture hashes stored in the restricted receipt; the final Git reads match the capture manifest exactly.

- [ ] **Step 9: Commit the preservation primitive**

```bash
git add src/workers/preservation.ts tests/workers/preservation.test.ts scripts/capture-worker-preservation.mts
git commit -m "feat(workers): preserve dirty source before runtime migration"
```

- [ ] **Step 10: Reconcile the two live Home23 source changes into the isolated branch**

Use the capture manifest's exact tracked diffs for `src/home.ts` and `engine/src/realtime/websocket-server.js`. Verify the source hashes still match capture time, apply the binary/three-way patches only inside the isolated worktree, reject unresolved/conflict-marker output, and prove patch identity. Run the focused Home/Realtime tests, `npm run build`, and `git diff --check`. Commit those preserved changes separately with capture ID and source hashes in the commit body; never stage the original backup/verification/receipt artifacts or modify the dirty source worktree.

```bash
git add src/home.ts engine/src/realtime/websocket-server.js
git diff --cached --check
git commit -m "chore(runtime): preserve live Home23 source changes"
```

- [ ] **Step 11: Bind final deployment verification to the preserved changes**

Write expected content/patch hashes for both imported files into the restricted preservation receipt. Task 28 and Task 29 must reject a tested build or immutable release whose composed source tree lacks either preserved patch identity.

```bash
node --import tsx scripts/capture-worker-preservation.mts --bind-required-patch \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --repository /Users/jtr/_JTR23_/release/home23 \
  --path src/home.ts \
  --path engine/src/realtime/websocket-server.js
node --import tsx scripts/capture-worker-preservation.mts --verify-required-patches \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --source-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime
```

Expected: the restricted receipt records two SHA-256 content hashes and two patch IDs, and verification exits zero only when both identities are present.

---

## Task 2: Define strict Worker v2 contracts while keeping v1 readable

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: existing v1 manifest/receipt contracts and preserved compatibility fixtures from Task 1.
- Produces: `parseWorkerManifest()`, `decodeWorkerReceipt()`, `TrustedWorkerRunEnvelope`, `WorkerReceiptV2`, and `HardStopAuthorizationDocument` as the canonical validated boundary types.

**Files:**
- Modify: `src/workers/types.ts`
- Create: `src/workers/schema.ts`
- Create: `tests/workers/manifest.test.ts`
- Create: `tests/contracts/worker-agents-v2.test.cjs`
- Modify: `contracts/schemas/worker-agents.schema.json`
- Modify: `contracts/manifest.json`
- Modify: `contracts/worker-agents.md`
- Modify: `contracts/fixtures/worker-agents.json`
- Modify: `contracts/fixtures/worker-runs.json`
- Modify: `contracts/fixtures/worker-run-receipt.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add failing strict-schema and compatibility tests**

```ts
test('worker v2 rejects unknown fields and write capabilities with empty effective scope', () => {
  assert.throws(() => parseWorkerManifest({ ...validV2, surprise: true }), /unknown/i);
  assert.throws(() => parseWorkerManifest({
    ...validV2,
    capabilities: ['shakedown.site.publish'],
    paths: { ...validV2.paths, liveWebroot: [] },
  }), /effective.*scope/i);
});

test('legacy tools translate only through the documented fail-closed intersection', () => {
  const translated = parseWorkerManifest(validSystemsV1);
  assert.deepEqual(translated.compatibility.capabilities,
    ['home23.observe', 'home23.verify']);
  assert.throws(() => parseWorkerManifest(ambiguousLegacyShellV1), /ambiguous/i);
});

test('v1 filesystem receipts remain readable without becoming v2 evidence', () => {
  const receipt = decodeWorkerReceipt(existingV1Fixture);
  assert.equal(receipt.schema, 'home23.worker-run.v1');
  assert.equal(receipt.compatibilityEvidenceOnly, true);
  assert.equal(receipt.authorityGrantHash, expectedSystemsCompatibilityAuthorityHash);
});

test('v2 receipts require every minimum field and reject success without consequence evidence', () => {
  for (const field of minimumWorkerReceiptV2Fields) {
    assert.throws(() => decodeWorkerReceipt(without(validReceiptV2, field)), new RegExp(field));
  }
  assert.throws(() => decodeWorkerReceipt({
    ...validReceiptV2,
    status: 'succeeded',
    expectedConsequence: 'public route changed',
    evidence: [],
  }), /consequence evidence/i);
});

test('hard-stop authorization is a separate exact non-standing contract', () => {
  assert.throws(() => parseHardStopAuthorization({
    ...validBillingCanaryAuthorization,
    standing: true,
  }), /non-standing/i);
});

test('manifest keeps standing and exact hard-stop capability ceilings disjoint', () => {
  const parsed = parseWorkerManifest(validShakedownManifestV2);
  assert.deepEqual(parsed.hardStopCapabilities, ['shakedown.billing.production-canary']);
  assert.equal(parsed.capabilities.includes('shakedown.billing.production-canary'), false);
  assert.throws(() => parseWorkerManifest({
    ...validShakedownManifestV2,
    capabilities: [...validShakedownManifestV2.capabilities, 'shakedown.billing.production-canary'],
  }), /standing.*hard-stop|disjoint/i);
});

test('billing hard-stop schema uses one closed lifecycle vocabulary', () => {
  const parsed = parseHardStopAuthorization(validBillingCanaryAuthorization);
  assert.deepEqual(parsed.allowedOperations, BILLING_CANARY_OPERATIONS);
  assert.deepEqual(parsed.cleanupOperations, BILLING_CANARY_CLEANUP_OPERATIONS);
  assert.throws(() => parseHardStopAuthorization({
    ...validBillingCanaryAuthorization,
    allowedOperations: [...validBillingCanaryAuthorization.allowedOperations, 'arbitrary-write'],
  }), /operation/i);
});
```

- [ ] **Step 2: Run focused tests — expect FAIL on missing strict parser/types**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/manifest.test.ts
```

Expected: FAIL because `parseWorkerManifest`, `decodeWorkerReceipt`, or their strict v2 schemas are not defined yet.

- [ ] **Step 3: Implement the v2 type model**

The core status and request boundary must use these exact semantics:

```ts
export type WorkerRunStatus =
  | 'queued' | 'running' | 'verifying' | 'succeeded' | 'no_change'
  | 'denied' | 'blocked' | 'reconciliation_required'
  | 'failed_after_bounded_retry' | 'timed_out' | 'budget_exhausted'
  | 'cancelled' | 'rolled_back' | 'rollback_failed';

export interface TrustedWorkerRunEnvelope {
  requestId: string;
  worker: string;
  principal: WorkerPrincipal;
  trigger: WorkerTrigger;
  mission?: string;
  missionPath?: ConfinedPromptReference;
  idempotencyKey: string;
  occurrenceKey?: string;
  pursuitId?: string;
  jobId?: string;
  eventId?: string;
  correlationId: string;
  causationId?: string;
  requestedNarrowings?: WorkerLimitNarrowings;
  hardStopAuthorization?: TrustedHardStopBinding;
}

export interface TrustedHardStopBinding {
  capabilityId: 'shakedown.billing.production-canary';
  authorizationHash: string;
  approvalReceiptHash: string;
}

export interface WorkerReceiptV2 {
  schema: 'home23.worker-run.v2';
  runId: string;
  requestId: string;
  idempotencyKey: string;
  occurrenceKey?: string;
  worker: string;
  ownerAgent: string;
  trigger: WorkerTrigger;
  requester: string;
  authenticatedSourceRef: string;
  pursuitId?: string;
  jobId?: string;
  eventId?: string;
  originRunId?: string;
  correlationId: string;
  causationId?: string;
  manifestHash: string;
  authorityGrantHash: string;
  hardStopAuthorizationHash?: string;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  limits: WorkerLimits;
  resourceUse: WorkerResourceUse;
  status: WorkerRunStatus;
  semanticStatus: WorkerSemanticStatus;
  verifierStatus: WorkerVerifierStatus;
  mission: string;
  expectedConsequence: string;
  actions: WorkerReceiptAction[];
  evidence: WorkerReceiptEvidence[];
  artifacts: WorkerReceiptArtifact[];
  stateDelta: WorkerStateDelta;
  campaignDeltas: CampaignDelta[];
  channelScoreDeltas: ChannelScoreDelta[];
  memoryCandidates: WorkerMemoryCandidate[];
  delivery: WorkerDeliverySummary;
  recovery: WorkerRecoveryState;
  nextEligibleAction?: WorkerNextAction;
}

export const BILLING_CANARY_OPERATIONS = Object.freeze([
  'signup', 'checkout', 'charge', 'webhook', 'entitlement',
  'cancel', 'refund', 'pending-state-reconcile', 'cleanup',
] as const);
export type BillingCanaryOperation = typeof BILLING_CANARY_OPERATIONS[number];

export const BILLING_CANARY_CLEANUP_OPERATIONS = Object.freeze([
  'cancel', 'refund', 'pending-state-reconcile', 'cleanup',
] as const);
export type BillingCanaryCleanupOperation = typeof BILLING_CANARY_CLEANUP_OPERATIONS[number];

export interface HardStopAuthorizationDocument {
  schema: 'home23.worker-hard-stop-authorization.v1';
  authorizationId: string;
  principal: 'worker:shakedown-jerry';
  capabilityId: 'shakedown.billing.production-canary';
  ownedIdentityAlias: string;
  accountTargets: string[];
  supabaseProjectRef: string;
  stripeAccountAlias: string;
  siteAccountAlias: string;
  allowedOperations: BillingCanaryOperation[];
  cleanupOperations: BillingCanaryCleanupOperation[];
  orchestrationPlanHash: string;
  stateMachineHash: string;
  immutableRunnerReleaseHash: string;
  capabilityCatalogHash: string;
  billingRootModuleHash: string;
  billingLeafRouterHash: string;
  operationVocabularyHash: string;
  routeLockPolicyHash: string;
  cleanupPlanHash: string;
  redactionPolicyHash: string;
  maximumAmountMinor: number;
  currency: string;
  notBefore: string;
  expiresAt: string;
  nonce: string;
  singleUse: true;
  signingKeyId: string;
  signatureAlgorithm: 'Ed25519';
  signature: string;
}

export type UnsignedHardStopAuthorizationRequest = Omit<
  HardStopAuthorizationDocument,
  'signature'
> & { signature?: never };
```

Remove caller-owned `ownerAgent`, `requestedBy`, `requester`, visibility, grant identity, source identity, authorization hash, authority source, and authorization summary from the public run body. An authenticated operator endpoint may accept a selected hash only to resolve an already registered authorization; it verifies the exact document and approval receipt, then persists the resulting `TrustedHardStopBinding` inside the trusted request. `authorityGrantHash` is mandatory in every decoded receipt: v2 uses the exact signed standing-grant hash, while a decoded legacy receipt uses the SHA-256 hash of the effective compatibility/authority policy produced by the named legacy translation map. A hard-stop run additionally records `hardStopAuthorizationHash` in its receipt and every consequential action evidence row. Define each nested v2 receipt type with `additionalProperties: false`, including exact action target/policy/redacted-input/result/rollback fields; evidence source/freshness/hash/verifier fields; artifact URI/hash/media-type/role fields; and provenance/confidence/destination for every memory candidate. A hard-stop authorization is signed, exact, expiring, non-standing, bounded to one canonical orchestration plan, capability/state machine, immutable runner/catalog, root module, internal leaf-router definition, operation vocabulary, disjoint route-lock policy, exact Supabase/Stripe/site targets, cleanup plan, and redaction policy, and never represented as a standing-grant capability. `BILLING_CANARY_OPERATIONS` and `BILLING_CANARY_CLEANUP_OPERATIONS` are the sole TypeScript and Ajv enum sources used by preparation, signing, verification, reservation, routing, CLI validation, and tests; the cleanup list is a strict subset of the full operation list and includes the terminal `cleanup` transition.

- [ ] **Step 4: Implement Ajv strict schemas and the explicit legacy compatibility map**

`src/workers/schema.ts` must reject unknown v2 fields, invalid limits, unknown capabilities, contradictory policies, invalid history/concurrency combinations, empty write scopes, and invalid relative prompt references. Legacy tools become the intersection of manifest intent and a named compatibility map; current accidental full-registry authority is never preserved.

```ts
const LEGACY_TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  worker_status: ['home23.observe'],
  worker_verify: ['home23.verify'],
});

const workerManifestV2Schema = {
  $id: 'home23.worker.v2',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema', 'kind', 'name', 'displayName', 'ownerAgent', 'class', 'purpose',
    'provider', 'model', 'context', 'capabilities', 'hardStopCapabilities', 'authorityGrant', 'paths',
    'limits', 'safetyReserve', 'retry', 'feedsBrains', 'visibleTo',
  ],
  properties: {
    schema: { const: 'home23.worker.v2' },
    kind: { const: 'worker' },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
    displayName: { type: 'string', minLength: 1 },
    ownerAgent: { type: 'string', minLength: 1 },
    class: { type: 'string', minLength: 1 },
    purpose: { type: 'string', minLength: 1 },
    provider: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
    context: {
      type: 'object',
      additionalProperties: false,
      required: ['promptRoots', 'identityFiles', 'sessionHistory', 'ownerBrainRead'],
      properties: {
        promptRoots: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        identityFiles: { type: 'array', minItems: 4, maxItems: 4, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        sessionHistory: { enum: ['fresh', 'persistent'] },
        ownerBrainRead: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['agent', 'scopes'],
            properties: {
              agent: { type: 'string', minLength: 1 },
              scopes: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
    },
    capabilities: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    hardStopCapabilities: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    authorityGrant: { type: 'string', minLength: 1 },
    paths: { $ref: '#/$defs/paths' },
    limits: { $ref: '#/$defs/limits' },
    safetyReserve: {
      type: 'object',
      additionalProperties: false,
      required: ['maxRuntimeMinutes', 'maxToolCalls', 'maxArtifactBytes', 'retryAttempts'],
      properties: {
        maxRuntimeMinutes: { type: 'integer', minimum: 0 },
        maxToolCalls: { type: 'integer', minimum: 0 },
        maxArtifactBytes: { type: 'integer', minimum: 0 },
        retryAttempts: { type: 'integer', minimum: 0 },
      },
    },
    retry: {
      type: 'object',
      additionalProperties: false,
      required: ['transientAttempts', 'initialBackoffSeconds', 'maxBackoffSeconds'],
      properties: {
        transientAttempts: { type: 'integer', minimum: 0 },
        initialBackoffSeconds: { type: 'integer', minimum: 1 },
        maxBackoffSeconds: { type: 'integer', minimum: 1 },
      },
    },
    feedsBrains: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    visibleTo: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  },
  $defs: {
    pathList: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    paths: {
      type: 'object',
      additionalProperties: false,
      required: ['read', 'write', 'artifact'],
      properties: {
        read: { $ref: '#/$defs/pathList' },
        write: { $ref: '#/$defs/pathList' },
        sourceClone: { $ref: '#/$defs/pathList' },
        gitMetadata: { $ref: '#/$defs/pathList' },
        codeRelease: { $ref: '#/$defs/pathList' },
        runtimeWrite: { $ref: '#/$defs/pathList' },
        dataWrite: { $ref: '#/$defs/pathList' },
        quarantine: { $ref: '#/$defs/pathList' },
        collectionCandidate: { $ref: '#/$defs/pathList' },
        collectionStash: { $ref: '#/$defs/pathList' },
        artifact: { $ref: '#/$defs/pathList' },
        privateRead: { $ref: '#/$defs/pathList' },
        receipt: { $ref: '#/$defs/pathList' },
        releaseCandidate: { $ref: '#/$defs/pathList' },
        liveWebroot: { $ref: '#/$defs/pathList' },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxRuntimeMinutes', 'maxToolCalls', 'maxTokens', 'maxArtifactBytes', 'maxConcurrentRuns'],
      properties: {
        maxRuntimeMinutes: { type: 'integer', minimum: 1 },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxConcurrentRuns: { type: 'integer', minimum: 1, maximum: 8 },
        maxTokens: { type: 'integer', minimum: 1 },
        maxArtifactBytes: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

export function parseWorkerManifest(input: unknown): WorkerManifestV2 {
  const candidate = translateLegacyManifest(input, LEGACY_TOOL_CAPABILITIES);
  if (!validateWorkerManifestV2(candidate)) {
    throw new WorkerSchemaError(validateWorkerManifestV2.errors ?? []);
  }
  assertKnownCapabilities(candidate.capabilities);
  assertKnownHardStopCapabilities(candidate.hardStopCapabilities);
  assertDisjointCapabilityLanes(candidate.capabilities, candidate.hardStopCapabilities);
  assertEffectiveWriteScopes(candidate);
  assertConfinedPromptReferences(candidate);
  return structuredClone(candidate);
}
```

The legacy translator always materializes `hardStopCapabilities: []`; compatibility input can never acquire a hard-stop ceiling. Ajv builds the hard-stop authorization operation enums directly from the two frozen constants above, rejects duplicates and unknown operations, requires every cleanup operation to be present in `allowedOperations`, and requires the full authorized operation sequence to satisfy the fixed billing state machine.

Move `ajv` from `devDependencies` to `dependencies` and update `package-lock.json`; strict manifest/action/receipt parsing is production runtime code. Add a production-install test that runs `npm ci --omit=dev` in an isolated copy and boots the schema parser without ancestor dependency resolution.

- [ ] **Step 5: Lock the HTTP/native contract and fixtures**

Set Worker routes to authenticated in `contracts/manifest.json`; make `additionalProperties: false` throughout v2 shapes; document server-derived ownership and owner/`visibleTo` filtering; preserve explicit v1 fixture decoding.

Append these entries to the existing `contracts/manifest.json.entries` array; do not replace the manifest object:

```json
[
  {
    "id": "worker-list",
    "method": "GET",
    "base": "bridge",
    "route": "/api/workers",
    "schema": "schemas/worker-agents.schema.json",
    "definition": "workerListResponseV2",
    "fixture": "fixtures/worker-agents.json",
    "auth": "required",
    "liveValidation": "safe",
    "consumers": ["home", "dashboard", "cli"]
  },
  {
    "id": "worker-run-create",
    "method": "POST",
    "base": "bridge",
    "route": "/api/workers/:worker/runs",
    "schema": "schemas/worker-agents.schema.json",
    "definition": "acceptedWorkerRequestV2",
    "fixture": "fixtures/worker-runs.json",
    "auth": "required",
    "liveValidation": "requires-action",
    "consumers": ["home", "scheduler", "agency", "cli"]
  },
  {
    "id": "worker-run-status",
    "method": "GET",
    "base": "bridge",
    "route": "/api/workers/requests/:requestId",
    "schema": "schemas/worker-agents.schema.json",
    "definition": "workerRequestProjectionV2",
    "fixture": "fixtures/worker-run-receipt.json",
    "auth": "required",
    "liveValidation": "safe",
    "consumers": ["home", "dashboard", "cli"]
  }
]
```

```json
{
  "schema": "home23.worker-run.v1",
  "compatibilityEvidenceOnly": true,
  "worker": "systems",
  "status": "completed"
}
```

- [ ] **Step 6: Run focused and contract suites — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/manifest.test.ts
node --test tests/contracts/worker-agents-v2.test.cjs
npm run test:contracts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/workers/types.ts src/workers/schema.ts tests/workers/manifest.test.ts \
  tests/contracts/worker-agents-v2.test.cjs \
  contracts/schemas/worker-agents.schema.json contracts/manifest.json \
  contracts/worker-agents.md contracts/fixtures/worker-agents.json \
  contracts/fixtures/worker-runs.json contracts/fixtures/worker-run-receipt.json
git commit -m "feat(workers): define strict v2 contracts"
```

---

## Task 3: Resolve manifests, prompts, grants, and concrete immutable execution profiles

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 2 validators and normalized v1/v2 contracts.
- Produces: `resolveWorkerExecutionProfile()`, `verifyWorkerGrant()`, immutable `WorkerExecutionProfile`, tracked Ed25519 public-key authority, Keychain-backed grant/dispatch signing operations, and tested CLI command `home23 worker grant finalize <grant> --write` for recomputing bound hashes before signing.

**Files:**
- Create: `src/workers/grants.ts`
- Create: `src/workers/signing-keys.ts`
- Create: `src/workers/profile.ts`
- Create: `config/worker-signing-keys/home23-operator-primary.json`
- Modify: `cli/lib/worker-commands.js`
- Modify: `cli/home23.js`
- Modify: `src/workers/registry.ts`
- Modify: `src/workers/scaffold.ts`
- Modify: `cli/templates/workers/systems/worker.yaml`
- Modify: `cli/templates/workers/freshness/worker.yaml`
- Modify: `cli/templates/workers/memory/worker.yaml`
- Modify: `cli/templates/workers/parity/worker.yaml`
- Modify: `cli/templates/workers/release/worker.yaml`
- Modify: `cli/templates/workers/feeder/worker.yaml`
- Modify: `config/workers.json`
- Create: `scripts/restore-worker-migration-fixtures.mts`
- Create: `tests/workers/grants.test.ts`
- Create: `tests/workers/signing-keys.test.ts`
- Create: `tests/workers/profile.test.ts`
- Create: `tests/fixtures/workers/grants/shakedown-jerry-standing.unsigned.yaml`
- Modify: `tests/workers/registry.test.ts`
- Modify: `tests/workers/scaffold.test.ts`

- [ ] **Step 1: Add failing profile, prompt-confinement, and signature tests**

```ts
test('profile pins prompt hashes and concrete provider tuple at claim', async () => {
  const profile = await resolveWorkerExecutionProfile({
    manifestPath, grantPath, ownerDefaults, credentialAuthorityId: 'home23-owner-jerry-v1',
  });
  assert.equal(profile.provider, 'openai');
  assert.match(profile.model, /\S/);
  assert.equal(profile.credentialAuthorityId, 'home23-owner-jerry-v1');
  assert.equal(profile.promptDocuments.length, 4);
  assert.ok(profile.promptDocuments.every((doc) => /^[a-f0-9]{64}$/.test(doc.sha256)));
  assert.equal(Object.isFrozen(profile), true);
});

test('prompt roots reject absolute paths, traversal, symlink escape, and hash drift', async () => {
  await assert.rejects(() => resolveFixture({ identityFiles: ['/tmp/IDENTITY.md'] }), /relative/i);
  await assert.rejects(() => resolveFixture({ identityFiles: ['../IDENTITY.md'] }), /escape/i);
  await assert.rejects(() => resolveSymlinkFixture(), /symlink/i);
  await assert.rejects(() => resumeAfterPromptMutation(), /hash/i);
});

test('edited grant is inactive until its exact new hash is signed and activated', async () => {
  const original = await activeGrantFixture();
  const edited = await writeEditedPolicy(original);
  assert.equal((await evaluateGrant(edited)).decision, 'require-human-authorization');
});

test('private signing material is Keychain-backed and never written to repository config', async () => {
  const keys = createSigningKeyAuthority({ keychain: fakeKeychain });
  const publicRecord = await keys.generate('home23-operator-primary');
  assert.equal(publicRecord.algorithm, 'Ed25519');
  assert.equal(await fakeKeychain.hasPrivateKey('home23-operator-primary'), true);
  assert.equal(JSON.stringify(publicRecord).includes('private'), false);
});

test('collection config hash and every derived target are pinned in the profile', async () => {
  const profile = await resolveFixture({ collectionConfigPath });
  assert.equal(profile.collectionConfigHash, sha256(collectionConfigBytes));
  assert.deepEqual(profile.collectionTargets, expectedResolvedTargets);
  await assert.rejects(() => resolveFixture({ collectionConfig: unknownKeyConfig }), /unknown key/i);
  await assert.rejects(() => resolveFixture({ collectionConfig: driftedTargetConfig }), /new signed grant/i);
  await assert.rejects(() => resolveFixture({ collectionConfig: missingVolumeConfig }), /target.*unavailable/i);
});

test('collection parser accepts the exact canonical 23-key contract and rejects drift', async () => {
  const canonical = await readJson('/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/config.json');
  assert.deepEqual(Object.keys(canonical).sort(), EXPECTED_COLLECTION_CONFIG_KEYS);
  assert.equal((await parseAndResolveCollectionConfig(canonical)).targetKeys.length, 18);
  for (const invalid of [missingKeyConfig, unknownKeyConfig, wrongNestedTypeConfig, relativePathConfig, symlinkEscapeConfig]) {
    await assert.rejects(() => parseAndResolveCollectionConfig(invalid), /config|path|symlink/i);
  }
});

test('grant finalize recomputes every bound hash before signing and writes only with --write', async () => {
  const dryRun = await runWorkerCli(['grant', 'finalize', grantPath]);
  assert.equal(dryRun.exitCode, 0);
  assert.deepEqual(await readFile(grantPath), originalGrantBytes);
  const write = await runWorkerCli(['grant', 'finalize', grantPath, '--write']);
  assert.equal(write.exitCode, 0);
  const finalized = await readYaml(grantPath);
  assert.equal(finalized.manifestHash, await sha256CanonicalFile(workerManifestPath));
  assert.equal(finalized.collectionConfigHash, await sha256File(collectionConfigPath));
  assert.deepEqual(finalized.promptHashes, await hashPromptDocuments(promptPaths));
  assert.equal(finalized.signature, undefined);
});

test('grant finalize turns only an ignored grant-shaped candidate into a concrete non-broadened policy', async () => {
  const finalized = await finalizeCandidateFixture();
  assert.equal(finalized.schema, 'home23.worker-authority-grant.v1');
  assert.deepEqual(finalized.capabilities, exactManifestCapabilityIntersection);
  assert.deepEqual(finalized.pathScopes, exactResolvedPathScopes);
  assert.deepEqual(finalized.serviceTargets, ['caddy', 'jerry-api', 'shakedown-audio-static']);
  assert.equal(scopeBroadensCandidate(finalized, unsignedCandidate), false);
  assert.equal(finalized.signature, undefined);
});

test('in-place finalization preserves a valid signature when no bound input changed', async () => {
  const before = await readFile(signedCurrentGrantPath);
  const result = await finalizeCurrentSignedGrant();
  assert.equal(result.changed, false);
  assert.deepEqual(await readFile(signedCurrentGrantPath), before);
  assert.equal((await verifyWorkerGrant(signedCurrentGrantPath)).valid, true);
});

test('profile preserves a hard-stop ceiling without granting standing authority', async () => {
  const profile = await resolveShakedownFixture();
  assert.deepEqual(profile.hardStopCapabilities, ['shakedown.billing.production-canary']);
  assert.equal(profile.capabilities.includes('shakedown.billing.production-canary'), false);
  await assert.rejects(
    () => resolveShakedownFixture({ standingGrantAdds: ['shakedown.billing.production-canary'] }),
    /hard-stop.*standing|grant.*ceiling/i,
  );
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/grants.test.ts tests/workers/signing-keys.test.ts \
  tests/workers/profile.test.ts tests/workers/registry.test.ts tests/workers/scaffold.test.ts
```

Expected: FAIL on the missing grant verifier, signing authority, and immutable profile resolver.

- [ ] **Step 3: Implement grant verification and immutable profile resolution**

Use Node's Ed25519 verifier over the RFC 8785 canonical JSON projection excluding only `signature`. Validate identity, validity window, key ID, capabilities as a subset of `manifest.capabilities` only, zero intersection with `manifest.hardStopCapabilities`, narrower path/account/host/action scopes, hard denies, and the separate exact-hash activation record. Deep-freeze the resolved profile.

Resolve `owner-default` to the concrete provider, model, and credential-authority ID at claim. Persist that tuple on the attempt; retry/resumption reuses it. Resolve every prompt file by real path inside declared roots, reject symlinks, and pin SHA-256. A manifest/grant reload applies only between runs; action-time policy can narrow but never broaden an in-flight profile.

```ts
export interface WorkerExecutionProfile {
  worker: string;
  ownerAgent: string;
  manifestHash: string;
  authorityGrantHash: string;
  provider: string;
  model: string;
  credentialAuthorityId: string;
  workspaceRoot: string;
  history: 'fresh' | 'persistent';
  brainReadScopes: readonly string[];
  capabilities: readonly string[];
  hardStopCapabilities: readonly string[];
  promptDocuments: readonly Array<{ path: string; sha256: string }>;
  collectionConfigHash?: string;
  collectionTargets: Readonly<Record<string, string>>;
  limits: Readonly<WorkerLimits>;
}

export async function resolveWorkerExecutionProfile(
  input: ResolveWorkerExecutionProfileInput,
): Promise<Readonly<WorkerExecutionProfile>> {
  const manifest = parseWorkerManifest(await readYaml(input.manifestPath));
  const verifiedGrant = await verifyWorkerGrant(await readYaml(input.grantPath), input.publicKeys);
  assertGrantIsManifestSubset(verifiedGrant, manifest);
  assertStandingGrantExcludesHardStopCapabilities(verifiedGrant, manifest.hardStopCapabilities);
  const promptDocuments = await Promise.all(
    manifest.context.identityFiles.map((path) => resolveConfinedPrompt(input.workerRoot, path)),
  );
  const concreteProvider = resolveOwnerProviderTuple(manifest, input.ownerDefaults);
  const collection = await resolvePinnedCollectionConfig(input.collectionConfigPath, verifiedGrant);
  return deepFreeze({
    worker: manifest.name,
    ownerAgent: manifest.ownerAgent,
    manifestHash: sha256Canonical(manifest),
    authorityGrantHash: verifiedGrant.documentHash,
    provider: concreteProvider.provider,
    model: concreteProvider.model,
    credentialAuthorityId: input.credentialAuthorityId,
    workspaceRoot: await realpath(input.workerRoot),
    history: manifest.context.sessionHistory,
    brainReadScopes: intersectBrainReadScopes(
      manifest.context.ownerBrainRead.flatMap((read) => read.scopes),
      verifiedGrant.brainReadScopes,
    ),
    capabilities: intersectCapabilities(manifest.capabilities, verifiedGrant.capabilities),
    hardStopCapabilities: resolveRegisteredHardStopCapabilities(manifest.hardStopCapabilities),
    promptDocuments,
    collectionConfigHash: collection?.configHash,
    collectionTargets: collection?.targets ?? {},
    limits: narrowLimits(manifest.limits, verifiedGrant.limits),
  });
}
```

`hardStopCapabilities` is a declaration ceiling, not effective standing authority. It is hash-bound into the profile and immutable runner catalog, but it is excluded from `capabilities`, excluded from every standing-grant intersection, and absent from the normal model tool registry. Task 6 may expose one of these definitions for a run only when the trusted stored request carries a server-resolved active exact hard-stop authorization hash for that same principal/capability; every action-time check can only narrow or revoke it. The six built-in v2 templates and every legacy translation explicitly set `hardStopCapabilities: []`.

- [ ] **Step 4: Implement the real Ed25519 key authority and CLI**

`src/workers/signing-keys.ts` loads only tracked public-key records during verification. `home23 worker key init`, `key import`, `key rotate`, and `grant sign` use macOS Keychain service `com.jtr.home23.worker-grants`; a permissioned-file import is accepted only from an explicit mode-`0600` path and is immediately moved into Keychain. Signing canonicalizes the document, refuses an already-active or target-drifted policy, writes no private material, and emits a hash-only receipt. Tests inject an ephemeral key store and scan Git/config/artifacts for private-key material.

`home23 worker grant finalize <grant> --write` is the only mutating hash-finalization command. It loads the named grant-shaped document, resolves its worker manifest, prompt files, collection configuration, target map, channel registry, event bindings, immutable adapter-runner release, exact path/service/host/account targets, policies, and hard denies. It intersects capabilities with the manifest, rejects any broadening beyond the ignored candidate scope or manifest ceilings, populates missing initial timestamps only once, recomputes every bound SHA-256 value, removes any now-invalid signature, writes atomically only when `--write` is supplied, and prints the canonical unsigned grant hash. `--output <final-grant>` is permitted only when the input resolves beneath `config/worker-authority-grants/candidates/` and the output is the exact sibling authority root; it writes the complete finalized policy atomically, so an incomplete document never appears at a loadable path. Without `--write` it is a byte-preserving dry run. `grant validate-candidate` accepts an incomplete unsigned document only beneath the ignored `candidates/` directory; `grant verify --scope-ceiling <candidate>` is read-only and rejects missing final fields, scope broadening, a bad signature, or a mutable activation field. Task 29 calls the same finalizer in place before `grant sign`.

```ts
export interface WorkerSigningKeyAuthority {
  generate(keyId: string): Promise<WorkerPublicKeyRecord>;
  importPrivateKey(keyId: string, sourcePath: string): Promise<WorkerPublicKeyRecord>;
  rotate(currentKeyId: string, nextKeyId: string): Promise<WorkerPublicKeyRecord>;
  signDocument<T extends Record<string, unknown>>(keyId: string, document: T): Promise<T & SignedFields>;
}

export function createSigningKeyAuthority(input: {
  keychain: KeychainPrivateKeyStore;
  publicKeyDirectory: string;
}): WorkerSigningKeyAuthority {
  const canonicalUnsignedBytes = (document: Record<string, unknown>) =>
    Buffer.from(canonicalize(withoutSignature(document)), 'utf8');
  return {
    generate: (keyId) => input.keychain.generateEd25519(keyId, input.publicKeyDirectory),
    importPrivateKey: (keyId, sourcePath) => importMode0600Key(input, keyId, sourcePath),
    rotate: (currentKeyId, nextKeyId) => rotateEd25519Key(input, currentKeyId, nextKeyId),
    async signDocument(keyId, document) {
      const signature = await input.keychain.signEd25519(keyId, canonicalUnsignedBytes(document));
      return { ...document, signingKeyId: keyId, signatureAlgorithm: 'Ed25519', signature: signature.toString('base64') };
    },
  };
}

export async function finalizeWorkerGrant(
  grantPath: string,
  options: { write: boolean; outputPath?: string; resolver: WorkerGrantBindingResolver; now: () => Date },
): Promise<{ grantHash: string; changed: boolean; document: WorkerGrantDocument }> {
  const originalBytes = await readFile(grantPath);
  const candidateInput = isConfinedGrantCandidatePath(grantPath);
  const original = parseGrantCandidateOrFinalYaml(originalBytes, { allowIncomplete: candidateInput });
  const destinationPath = resolveFinalizedGrantDestination(grantPath, options.outputPath, candidateInput);
  const bindings = await options.resolver.resolveAll(workerNameFromPrincipal(original.principal));
  const finalizedAt = original.issuedAt ?? options.now().toISOString();
  const document = withoutSignature({
    schema: 'home23.worker-authority-grant.v1',
    id: original.id,
    version: original.version,
    principal: original.principal,
    ownerAgent: original.ownerAgent,
    issuedAt: finalizedAt,
    notBefore: original.notBefore ?? finalizedAt,
    expiresAt: original.expiresAt ?? null,
    signatureAlgorithm: 'Ed25519',
    signingKeyId: original.signingKeyId,
    capabilities: intersectAndRequireCandidateCapabilities(original.capabilities, bindings.manifestCapabilities),
    pathScopes: bindings.pathScopes,
    serviceTargets: bindings.serviceTargets,
    hostTargets: bindings.hostTargets,
    accountTargets: bindings.accountTargets,
    actionClasses: original.actionClasses,
    ratePolicy: bindings.ratePolicy,
    communicationPolicy: bindings.communicationPolicy,
    hardDenies: requireNonOverridableHardDenies(original.hardDenies),
    manifestHash: bindings.manifestHash,
    promptHashes: bindings.promptHashes,
    collectionConfigHash: bindings.collectionConfigHash,
    collectionTargetHash: bindings.collectionTargetHash,
    channelRegistryHash: bindings.channelRegistryHash,
    eventBindingsHash: bindings.eventBindingsHash,
    adapterRunnerReleaseHash: bindings.adapterRunnerReleaseHash,
  });
  assertNoScopeBroadening({ candidate: original, manifest: bindings.manifest, finalized: document });
  const unsignedPayloadChanged = sha256Canonical(withoutSignature(original)) !== sha256Canonical(document);
  const signatureStillValid = Boolean(original.signature) && await verifyGrantDocumentSignature(original);
  const outputDocument = !unsignedPayloadChanged && signatureStillValid
    ? { ...document, signature: original.signature }
    : document;
  const serialized = serializeCanonicalYaml(outputDocument);
  const currentDestinationBytes = await readFileIfExists(destinationPath);
  const changed = !currentDestinationBytes?.equals(Buffer.from(serialized, 'utf8'));
  if (options.write && changed) await writeFileAtomic(destinationPath, serialized, 0o600);
  return { grantHash: sha256Canonical(outputDocument), changed, document: outputDocument };
}
```

```bash
node cli/home23.js worker key init --key-id home23-operator-primary
worker_grant_tmp=$(mktemp -d /tmp/home23-worker-grant.XXXXXX)
mkdir -p "$worker_grant_tmp/config/worker-authority-grants/candidates"
cp tests/fixtures/workers/grants/shakedown-jerry-standing.unsigned.yaml \
  "$worker_grant_tmp/config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml"
node cli/home23.js worker grant finalize \
  "$worker_grant_tmp/config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml" \
  --output "$worker_grant_tmp/config/worker-authority-grants/shakedown-jerry-standing.yaml" \
  --binding-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime --write
node cli/home23.js worker grant sign \
  --key-id home23-operator-primary \
  --input "$worker_grant_tmp/config/worker-authority-grants/shakedown-jerry-standing.yaml"
```

Expected: Keychain contains the private Ed25519 key, tracked config contains only the public record, and the signing command emits only the signed document hash and receipt path.

- [ ] **Step 5: Pin Jerry Collection configuration and derived targets**

Strictly parse the known `ops/jerry-collection/config.json` keys, resolve every path/volume by real path, record the config hash and target map in `WorkerExecutionProfile`, and require the standing grant to name that exact hash. Unknown keys, target drift, missing target volume, or a changed hash return `require-human-authorization` for collection writes until a newly signed grant is activated. Read-only diagnosis remains available.

```ts
const COLLECTION_PATH_KEYS = Object.freeze([
  'catalogPath', 'inventoryPath', 'sourceIndexPath', 'apiProjectionPath',
  'enrichmentRoot', 'normalizedDetailsPath', 'validationReportPath', 'unresolvedGapsPath',
  'reviewQueuePath', 'qualityReviewPath', 'sourceManifestPath', 'readableGuidePath',
  'newsletterIndexPath', 'runtimeDir', 'acquisitionQuarantineDir', 'releaseCandidateRoot',
  'stashRoot', 'collectionStatePath',
] as const);

const validateJerryCollectionConfig = new Ajv({ allErrors: true, strict: true }).compile({
  type: 'object',
  additionalProperties: false,
  required: [
    ...COLLECTION_PATH_KEYS, 'searchTargetVersion', 'enrichmentCommandIds',
    'playableValidation', 'operatorProductionActionsEnabled', 'timezone',
  ],
  properties: {
    ...Object.fromEntries(COLLECTION_PATH_KEYS.map((key) => [key, { type: 'string', minLength: 1 }])),
    searchTargetVersion: { type: 'integer', minimum: 1 },
    enrichmentCommandIds: {
      type: 'array', minItems: 1, uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z0-9_]+$' },
    },
    playableValidation: {
      type: 'object', additionalProperties: false,
      required: ['minimumAudioFileCount', 'acceptedEvidence'],
      properties: {
        minimumAudioFileCount: { type: 'integer', minimum: 1 },
        acceptedEvidence: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    operatorProductionActionsEnabled: { type: 'boolean' },
    timezone: { const: 'America/New_York' },
  },
});

export async function resolvePinnedCollectionConfig(
  configPath: string | undefined,
  grant: VerifiedWorkerGrant,
): Promise<ResolvedCollectionConfig | undefined> {
  if (!configPath) return undefined;
  const bytes = await readFile(configPath);
  const config: unknown = JSON.parse(bytes.toString('utf8'));
  if (!validateJerryCollectionConfig(config)) {
    throw new Error(`invalid Jerry Collection config: ${JSON.stringify(validateJerryCollectionConfig.errors)}`);
  }
  const configHash = createHash('sha256').update(bytes).digest('hex');
  if (grant.collectionConfigHash !== configHash) throw new AuthorizationRequiredError('collection config hash drift');
  const parsed = config as JerryCollectionConfig;
  const targets = Object.freeze(Object.fromEntries(await Promise.all(
    COLLECTION_PATH_KEYS.map(async (key) => [key, await resolveDeclaredPathSafely(parsed[key], {
      allowMissingLeaf: true, rejectSymlinkComponents: true, requireAbsolute: true,
    })]),
  )));
  return { configHash, targets };
}
```

This schema is the complete contract for the current canonical `/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/config.json`, not a parallel four-field approximation. A fixture test loads that exact file and asserts all 23 keys/types, then rejects each missing key, an unknown key, wrong scalar/nested type, relative path, unresolved volume, symlink component, and path escape. Task 22 may change only the intended path-key values and must pass this same validator before hashing; non-path policy fields remain byte-equivalent unless separately implemented and tested.

- [ ] **Step 6: Make registry loading isolated and visible**

One malformed worker must become a visible worker error without making every other worker disappear. `listWorkers()` returns valid entries plus validation errors; `loadWorker()` fails the named invalid worker. Scaffold full v2 directories including `state`, `sessions`, `artifacts`, `runs`, `logs`, and `locks` while leaving existing directories readable in place.

```ts
export async function listWorkers(root: string): Promise<WorkerRegistryResult> {
  const entries = await readdir(root, { withFileTypes: true });
  const workers: WorkerRegistryEntry[] = [];
  const errors: WorkerRegistryError[] = [];
  for (const entry of entries.filter((row) => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      workers.push(await loadWorker(join(root, entry.name)));
    } catch (error) {
      errors.push({ worker: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { workers, errors };
}

export async function scaffoldWorker(root: string, worker: string): Promise<void> {
  for (const directory of ['state', 'sessions', 'artifacts', 'runs', 'logs', 'locks']) {
    await mkdir(join(root, worker, directory), { recursive: true, mode: 0o700 });
  }
}
```

- [ ] **Step 7: Migrate built-in templates through tested compatibility**

Keep the six installed/templates (`systems`, `freshness`, `memory`, `parity`, `release`, `feeder`) readable. New resident workers use explicit capabilities. Verify migration is idempotent and writes a recovery copy against restored temporary copies only; canonical ignored installed manifests remain byte-unchanged until the journaled post-deploy migration in Task 29.

```bash
fixture_runtime=$(mktemp -d /tmp/home23-worker-migration-fixture.XXXXXXXX)
node --import tsx scripts/restore-worker-migration-fixtures.mts \
  --output-root "$fixture_runtime" --from-built-in-templates
for worker in systems freshness memory parity release feeder
do
  node cli/home23.js worker validate "$worker" --runtime-root "$fixture_runtime"
  node cli/home23.js worker migrate "$worker" --runtime-root "$fixture_runtime" --write-recovery-copy
  node cli/home23.js worker migrate "$worker" --runtime-root "$fixture_runtime" --write-recovery-copy --expect-no-change
done
node --import tsx --test --test-concurrency=1 tests/workers/registry.test.ts tests/workers/scaffold.test.ts
```

Expected: all six restored fixtures validate, the second migration reports `no_change`, each first mutation has one hash-addressed recovery copy, and a hash check proves `/Users/jtr/_JTR23_/release/home23/instances/workers/*/worker.yaml` was never read as a mutation target or changed.

- [ ] **Step 8: Run focused tests and build — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/grants.test.ts tests/workers/profile.test.ts \
  tests/workers/signing-keys.test.ts \
  tests/workers/registry.test.ts tests/workers/scaffold.test.ts
npm run build
```

- [ ] **Step 9: Commit**

```bash
git add src/workers/grants.ts src/workers/signing-keys.ts src/workers/profile.ts src/workers/registry.ts \
  src/workers/scaffold.ts scripts/restore-worker-migration-fixtures.mts \
  tests/workers/grants.test.ts tests/workers/profile.test.ts \
  tests/workers/signing-keys.test.ts tests/workers/registry.test.ts tests/workers/scaffold.test.ts \
  tests/fixtures/workers/grants/shakedown-jerry-standing.unsigned.yaml \
  cli/templates/workers/systems/worker.yaml cli/templates/workers/freshness/worker.yaml \
  cli/templates/workers/memory/worker.yaml cli/templates/workers/parity/worker.yaml \
  cli/templates/workers/release/worker.yaml cli/templates/workers/feeder/worker.yaml \
  config/workers.json config/worker-signing-keys/home23-operator-primary.json \
  cli/lib/worker-commands.js cli/home23.js
git commit -m "feat(workers): resolve immutable execution profiles"
```

---

## Task 4: Add fail-closed scoped principals and standing-grant activation

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 2 authorization documents and Task 3 public-key registry/signature verification.
- Produces: `authenticateWorkerPrincipal()`, `verifyHardStopAuthorization()`, and body-spoof-resistant scoped local-service credentials; durable activation persistence remains owned by Task 5.

**Files:**
- Create: `shared/worker-credential.cjs`
- Create: `src/workers/principal.ts`
- Create: `src/workers/auth.ts`
- Create: `src/workers/hard-stop-authorizations.ts`
- Create: `tests/workers/principal.test.ts`
- Create: `tests/workers/hard-stop-authorizations.test.ts`
- Modify: `src/workers/connector.ts`
- Modify: `tests/workers/connector.test.ts`
- Modify: `src/home.ts`
- Modify: `cli/lib/generate-ecosystem.js`

- [ ] **Step 1: Write failing exact-claim and body-spoof tests**

```ts
test('credential authority fails closed and binds subject, owner, scopes, and expiry', () => {
  assert.throws(() => createWorkerCredentialAuthority({ signingKey: '' }), /configuration/i);
  const token = authority.issue({
    subject: 'service:cron:jerry', ownerAgent: 'jerry',
    scopes: ['worker:run', 'worker:read'], credentialId: 'wkcred_test', expiresAt,
  });
  assert.throws(() => authority.verify(token, {
    subject: 'service:event-router:jerry', ownerAgent: 'jerry', scope: 'worker:run',
  }), /credential/i);
});

test('connector identity ignores body spoofing and denies wrong owner harness', async () => {
  const response = await postRun({
    credential: forrestHarnessCredential,
    worker: 'shakedown-jerry',
    body: { mission: 'run', ownerAgent: 'forrest', requestedBy: 'human' },
  });
  assert.equal(response.status, 403);
  assert.equal(await store.countRequests(), 0);
});

test('hard-stop document is exact, expiring, signed, and cannot be treated as standing authority', async () => {
  const verified = await verifyHardStopAuthorization(validBillingAuthorization, publicKeys, expectedHardStopBindings);
  assert.equal(verified.documentHash, expectedAuthorizationHash);
  await assert.rejects(() => verifyHardStopAuthorization(expiredAuthorization, publicKeys, expectedHardStopBindings), /expired/i);
  await assert.rejects(() => verifyHardStopAuthorization(widenedAmountAuthorization, publicKeys, expectedHardStopBindings), /signature/i);
  await assert.rejects(() => verifyHardStopAuthorization(driftedRunnerAuthorization, publicKeys, expectedHardStopBindings), /runner|hash/i);
  await assert.rejects(() => verifyHardStopAuthorization(unknownOperationAuthorization, publicKeys, expectedHardStopBindings), /operation/i);
  assert.equal(verified.standing, false);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/principal.test.ts tests/workers/hard-stop-authorizations.test.ts \
  tests/workers/connector.test.ts
```

Expected: FAIL because the scoped credential authority and exact hard-stop verifier do not exist.

- [ ] **Step 3: Implement scoped signed local credentials**

Follow `shared/query-notebook-credential.cjs` for exact keys, canonical payloads, bounded sizes/TTL, timing-safe verification, and fail-closed configuration. Admit distinct principals for operator, owner harness, Jerry tool, Forrest tool, scheduler, event router, Agency, Good Life, Live Problems, dashboard, CLI, and API. Credentials carry immutable subject, owner scope, operation scopes, credential ID/generation, issued/expiry times, and audience.

```js
const MAX_CREDENTIAL_BYTES = 4096;
const MAX_TTL_SECONDS = 300;

function issueWorkerCredential(claims, authority) {
  if (!authority?.signingKey) throw new Error('worker credential authority configuration missing');
  if (claims.expiresAt - claims.issuedAt > MAX_TTL_SECONDS) throw new Error('credential TTL exceeds 300 seconds');
  const payload = canonicalize({
    aud: 'home23.worker-management.v1',
    sub: claims.subject,
    ownerAgent: claims.ownerAgent,
    scopes: [...new Set(claims.scopes)].sort(),
    credentialId: claims.credentialId,
    generation: claims.generation,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
  const signature = createHmac('sha256', authority.signingKey).update(payload).digest('base64url');
  const token = `${Buffer.from(payload).toString('base64url')}.${signature}`;
  if (Buffer.byteLength(token) > MAX_CREDENTIAL_BYTES) throw new Error('credential exceeds size limit');
  return token;
}

function verifyWorkerCredential(token, expected, authority, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!authority?.signingKey) throw new Error('worker credential authority configuration missing');
  if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_CREDENTIAL_BYTES) throw new Error('invalid credential');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('invalid credential');
  const payloadBytes = Buffer.from(parts[0], 'base64url');
  const supplied = Buffer.from(parts[1], 'base64url');
  const calculated = createHmac('sha256', authority.signingKey).update(payloadBytes).digest();
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) throw new Error('invalid credential');
  const claims = JSON.parse(payloadBytes.toString('utf8'));
  if (claims.aud !== 'home23.worker-management.v1' || claims.expiresAt <= nowSeconds || claims.issuedAt > nowSeconds) {
    throw new Error('expired or invalid credential');
  }
  if (claims.sub !== expected.subject || claims.ownerAgent !== expected.ownerAgent || !claims.scopes.includes(expected.scope)) {
    throw new Error('credential claim mismatch');
  }
  return Object.freeze(claims);
}

module.exports = { issueWorkerCredential, verifyWorkerCredential };
```

- [ ] **Step 4: Derive trigger and owner server-side**

`src/workers/auth.ts` resolves the authenticated principal, strips/ignores client identity fields, maps principal kind to trigger class, and resolves `ownerAgent` from the registered manifest. A harness can claim only its authenticated owner. Every missing/corrupt authority returns `503`; bad credentials return `401`; wrong operation/owner returns `403`.

```ts
export async function authenticateWorkerPrincipal(
  request: Request,
  requiredScope: WorkerOperationScope,
  dependencies: WorkerAuthDependencies,
): Promise<AuthenticatedWorkerRequest> {
  if (!dependencies.credentialAuthority.available) throw new WorkerAuthError(503, 'credential authority unavailable');
  const token = readBearerToken(request.headers.authorization);
  const principal = dependencies.credentialAuthority.verify(token, requiredScope);
  const worker = dependencies.registry.loadWorker(String(request.params.worker));
  if (!principal.scopes.includes(requiredScope)) throw new WorkerAuthError(403, 'operation scope denied');
  if (principal.kind === 'owner-harness' && principal.ownerAgent !== worker.ownerAgent) {
    throw new WorkerAuthError(403, 'owner harness mismatch');
  }
  return {
    principal,
    ownerAgent: worker.ownerAgent,
    trigger: triggerForPrincipal(principal.kind),
    body: stripIdentityFields(request.body),
  };
}
```

- [ ] **Step 5: Implement exact non-standing hard-stop document verification**

Verify the Ed25519 signature and canonical hash; exact principal, capability, Supabase project, Stripe/site account aliases, owned-identity alias, allowed operation set, cleanup set, maximum amount in minor units, currency, validity window, nonce, orchestration-plan/state-machine/runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/cleanup/redaction hashes, and `singleUse: true`. Require every operation to come from `BILLING_CANARY_OPERATIONS`, every cleanup operation to come from `BILLING_CANARY_CLEANUP_OPERATIONS` and also appear in `allowedOperations`, and the ordered authorized sequence to be valid under the shared billing transition table. Reject generic spend, wildcard targets/operations, absent cleanup bounds, standing use, hash drift, and browser/body-supplied operator identity. This task produces a verified immutable value only; Task 5 owns transactional activation/reservation/consumption after the store exists.

```ts
export async function verifyHardStopAuthorization(
  document: HardStopAuthorizationDocument,
  publicKeys: WorkerPublicKeyRegistry,
  expected: HardStopVerificationBindings,
  now = new Date(),
): Promise<Readonly<VerifiedHardStopAuthorization>> {
  if (document.singleUse !== true) throw new Error('hard-stop authorization must be single-use');
  if (document.capabilityId !== 'shakedown.billing.production-canary') throw new Error('capability mismatch');
  if (document.accountTargets.length === 0 || document.accountTargets.some((target) => target.includes('*'))) {
    throw new Error('wildcard or empty account target');
  }
  assertExactBillingTargets(document, expected.billingTargets);
  assertPinnedHardStopArtifacts(document, expected.immutableRunnerManifest);
  assertExactOperationVocabulary(document.allowedOperations, BILLING_CANARY_OPERATIONS);
  assertCleanupSubset(document.cleanupOperations, document.allowedOperations, BILLING_CANARY_CLEANUP_OPERATIONS);
  assertValidBillingCanarySequence(document.allowedOperations);
  if (document.maximumAmountMinor < 0 || !Number.isSafeInteger(document.maximumAmountMinor)) {
    throw new Error('invalid maximum amount');
  }
  if (now < new Date(document.notBefore) || now >= new Date(document.expiresAt)) throw new Error('authorization expired or inactive');
  const documentHash = sha256Canonical(withoutSignature(document));
  await publicKeys.verify(document.signingKeyId, canonicalBytes(withoutSignature(document)), document.signature);
  return deepFreeze({ document, documentHash, standing: false });
}
```

- [ ] **Step 6: Run focused tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/principal.test.ts tests/workers/grants.test.ts tests/workers/connector.test.ts
node --import tsx --test --test-concurrency=1 tests/workers/hard-stop-authorizations.test.ts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add shared/worker-credential.cjs src/workers/principal.ts src/workers/auth.ts \
  src/workers/hard-stop-authorizations.ts src/workers/connector.ts \
  tests/workers/principal.test.ts tests/workers/hard-stop-authorizations.test.ts \
  tests/workers/connector.test.ts src/home.ts cli/lib/generate-ecosystem.js
git commit -m "feat(workers): authenticate scoped worker principals"
```

---

## Task 5: Build the canonical SQLite/WAL control plane

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: verified principals, grants, and hard-stop documents from Tasks 3–4.
- Produces: `WorkerRuntimeStore`, `WorkerStateService`, the canonical WAL schema, exact-grant activation/revocation records, single-use hard-stop operations, trigger inbox, automation-cutover journal records, and opportunity/campaign/channel/action state APIs.

**Files:**
- Create: `src/workers/store.ts`
- Create: `src/workers/state.ts`
- Create: `tests/workers/store.test.ts`
- Create: `tests/workers/state.test.ts`
- Modify: `src/workers/types.ts`

- [ ] **Step 1: Write failing transaction, restart, lease, journal, and idempotency tests**

```ts
test('terminal receipt and all initial outbox rows commit atomically', () => {
  const store = createTestStore();
  const lease = store.claim(enqueueFixture());
  store.failpoint('after_receipt_before_outbox');
  assert.throws(() => store.complete(lease, terminalReceiptFixture()), /failpoint/);
  assert.equal(store.getReceipt(lease.runId), null);
  assert.deepEqual(store.listOutbox(lease.runId), []);
});

test('expired lease is reclaimed once and completed action idempotency survives restart', () => {
  const first = createTestStore(databasePath);
  const run = first.enqueue(envelopeFixture());
  const lease = first.claimNext({ ownerAgent: 'jerry', claimant: 'harness-a', now: t0 });
  first.recordActionResult(lease, actionFixture('action-1'));
  first.close();
  const second = createTestStore(databasePath);
  const reclaimed = second.reconcileExpiredLeases(t1);
  assert.equal(reclaimed.length, 1);
  assert.equal(second.lookupActionResult('action-1')?.status, 'succeeded');
});

test('32 equivalent enqueues reserve one idempotency result', async () => {
  const results = await Promise.all(Array.from({ length: 32 }, () => enqueueSameOccurrence()));
  assert.equal(new Set(results.map((row) => row.requestId)).size, 1);
});

test('exact grant activation and hard-stop operation consumption survive restart', async () => {
  const first = createTestStore(databasePath);
  first.activateGrant(validGrantActivation);
  first.registerHardStopAuthorization(validVerifiedHardStopAuthorization);
  const orchestration = first.beginHardStopOrchestration({
    authorizationHash, actionId: 'action-billing-root', orchestrationPlanHash,
  });
  first.consumeHardStopOperation(first.reserveHardStopOperation({
    authorizationHash, orchestrationId: orchestration.orchestrationId,
    operation: 'signup', sequence: 0, fromState: 'initialized', expectedToState: 'signed_up',
    amountMinor: 0, currency: 'usd', actionId: 'action-signup',
  }), authoritativeSignupReadback);
  first.consumeHardStopOperation(first.reserveHardStopOperation({
    authorizationHash, orchestrationId: orchestration.orchestrationId,
    operation: 'checkout', sequence: 1, fromState: 'signed_up', expectedToState: 'checkout_created',
    amountMinor: 0, currency: 'usd', actionId: 'action-checkout',
  }), authoritativeCheckoutReadback);
  const reservation = first.reserveHardStopOperation({
    authorizationHash, orchestrationId: orchestration.orchestrationId,
    operation: 'charge', sequence: 2, fromState: 'checkout_created', expectedToState: 'charged',
    amountMinor: 500, currency: 'usd', actionId: 'action-charge',
  });
  first.consumeHardStopOperation(reservation, authoritativeStripeResult);
  first.close();
  const second = createTestStore(databasePath);
  assert.equal(second.getActiveGrant(grantHash)?.grantHash, grantHash);
  assert.equal(second.getHardStopOrchestration(orchestration.orchestrationId)?.status, 'running');
  assert.throws(() => second.reserveHardStopOperation({
    authorizationHash, orchestrationId: orchestration.orchestrationId,
    operation: 'charge', sequence: 2, fromState: 'checkout_created', expectedToState: 'charged',
    amountMinor: 500, currency: 'usd', actionId: 'action-charge-2',
  }), /already consumed/i);
});

test('hard-stop root lease consumes no lifecycle operation and children advance exactly in order', () => {
  const store = registeredHardStopStore();
  const root = store.beginHardStopOrchestration(validRootOrchestration);
  assert.deepEqual(store.listHardStopOperations(root.orchestrationId), []);
  assert.throws(() => store.reserveHardStopOperation(outOfOrderWebhookReservation), /transition|sequence/i);
  const signup = store.reserveHardStopOperation(validSignupReservation);
  store.consumeHardStopOperation(signup, authoritativeSignupReadback);
  assert.equal(store.listHardStopOperations(root.orchestrationId).length, 1);
});

test('hard-stop close requires terminal evidence for every operation and survives restart', () => {
  const store = completedHardStopFixture(databasePath);
  assert.throws(() => store.closeHardStopAuthorization({ authorizationHash, approval: operatorApproval }), /missing|uncertain/i);
  store.reconcileHardStopOperation(reconciledPendingOperationWithAuthoritativeEvidence);
  store.skipHardStopOperation(skippedOptionalOperationWithAuthoritativeEvidence);
  const closed = store.closeHardStopAuthorization({ authorizationHash, approval: operatorApproval });
  assert.equal(closed.status, 'closed');
  store.close();
  const reopened = createTestStore(databasePath);
  assert.throws(() => reopened.beginHardStopOrchestration({
    authorizationHash, actionId: 'replay-root', orchestrationPlanHash,
  }), /closed|replay/i);
});

test('worker state is transactional and filesystem ledgers are append-only projections', async () => {
  const store = createTestStore(databasePath);
  const first = store.appendOpportunity(opportunityCreated);
  const correction = store.appendOpportunity({ ...opportunityCorrected, supersedes: first.recordId });
  await stateProjector.flush();
  assert.equal(await jsonlContainsBothRecords(opportunitiesPath, first, correction), true);
  assert.equal(await projectionHashMatchesStore(), true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/store.test.ts tests/workers/state.test.ts
```

Expected: FAIL because `WorkerRuntimeStore`, its migrations, and the canonical state service are absent.

- [ ] **Step 3: Implement idempotent SQLite migrations and durability settings**

Open `/Users/jtr/_JTR23_/release/home23/instances/workers/runtime/worker-runtime.sqlite` with mode `0600`, WAL, `foreign_keys=ON`, bounded `busy_timeout`, explicit schema versioning, and transactional migrations. Tables must cover request envelopes, attempts, leases, resource locks, action events/results, idempotency results, receipts, outbox deliveries, trigger inbox/cursors/mapping versions, standing-grant activations, exact hard-stop authorizations and per-operation reservations/consumption, opportunities, campaign events, channel-score versions, action-ledger events, publication journals, collection journals, enrichment journals, code/backend release journals, automation-cutover prior/replacement state plus rollback operations, and frozen-target incidents.

```ts
const WORKER_DATABASE_PATH = '/Users/jtr/_JTR23_/release/home23/instances/workers/runtime/worker-runtime.sqlite';

export function openWorkerRuntimeStore(databasePath = WORKER_DATABASE_PATH): WorkerRuntimeStore {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applyMigration = database.transaction((migration: WorkerStoreMigration) => {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      migration.version,
      new Date().toISOString(),
    );
  });
  const applied = new Set<number>(
    database.prepare('SELECT version FROM schema_migrations').all().map((row: { version: number }) => row.version),
  );
  for (const migration of WORKER_STORE_MIGRATIONS) if (!applied.has(migration.version)) applyMigration(migration);
  return new SqliteWorkerRuntimeStore(database);
}
```

The first migration must use uniqueness and foreign keys at the data boundary, including these exact key constraints:

```sql
CREATE TABLE worker_requests (
  request_id TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  owner_agent TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  occurrence_key TEXT UNIQUE,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE worker_actions (
  action_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES worker_requests(request_id),
  action_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  started_json TEXT NOT NULL,
  terminal_json TEXT
);
CREATE TABLE worker_grant_activations (
  grant_hash TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  approval_receipt_hash TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE worker_hard_stop_authorizations (
  authorization_hash TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  approval_receipt_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  closed_at TEXT,
  close_receipt_hash TEXT
);
CREATE TABLE worker_hard_stop_orchestrations (
  orchestration_id TEXT PRIMARY KEY,
  authorization_hash TEXT NOT NULL UNIQUE REFERENCES worker_hard_stop_authorizations(authorization_hash),
  root_action_id TEXT NOT NULL UNIQUE,
  orchestration_plan_hash TEXT NOT NULL,
  current_state TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE worker_hard_stop_operations (
  authorization_hash TEXT NOT NULL REFERENCES worker_hard_stop_authorizations(authorization_hash),
  orchestration_id TEXT NOT NULL REFERENCES worker_hard_stop_orchestrations(orchestration_id),
  operation TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  expected_to_state TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  terminal_json TEXT,
  PRIMARY KEY (authorization_hash, sequence),
  UNIQUE (authorization_hash, operation)
);
CREATE TABLE worker_automation_cutovers (
  cutover_id TEXT PRIMARY KEY,
  worker TEXT NOT NULL,
  prior_state_json TEXT NOT NULL,
  replacement_state_json TEXT NOT NULL,
  rollback_operations_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement transactional APIs**

```ts
interface WorkerRuntimeStore {
  enqueue(envelope: TrustedWorkerRunEnvelope): WorkerRunRecord;
  claimNext(input: WorkerClaimInput): WorkerLease | null;
  renewLease(input: WorkerLeaseHeartbeat): boolean;
  reconcileExpiredLeases(now: string): WorkerRunRecord[];
  recordActionStarted(input: ActionStarted): void;
  recordActionTerminal(input: ActionTerminal): void;
  complete(input: CompleteRunInput): CanonicalReceiptRecord;
  cancel(input: CancelRunInput): WorkerRunRecord;
  activateGrant(input: GrantActivationInput): GrantActivationRecord;
  revokeGrant(input: GrantRevocationInput): GrantActivationRecord;
  registerHardStopAuthorization(input: VerifiedHardStopAuthorization): HardStopAuthorizationRecord;
  beginHardStopOrchestration(input: HardStopOrchestrationInput): HardStopOrchestrationRecord;
  getHardStopOrchestration(orchestrationId: string): HardStopOrchestrationRecord | null;
  reserveHardStopOperation(input: HardStopOperationReservationInput): HardStopOperationReservation;
  consumeHardStopOperation(input: HardStopOperationTerminalInput): HardStopOperationRecord;
  reconcileHardStopOperation(input: HardStopOperationReconciliationInput): HardStopOperationRecord;
  skipHardStopOperation(input: HardStopOperationSkipInput): HardStopOperationRecord;
  closeHardStopAuthorization(input: CloseHardStopAuthorizationInput): HardStopAuthorizationRecord;
  assertHardStopReplayDenied(authorizationHash: string): void;
  appendOpportunity(input: OpportunityEvent): WorkerStateRecord;
  appendCampaignEvent(input: CampaignEvent): WorkerStateRecord;
  updateChannelScore(input: ChannelScoreUpdate): WorkerStateRecord;
  appendActionLedger(input: WorkerActionLedgerEvent): WorkerStateRecord;
  updateCurrentState(input: WorkerCurrentState): WorkerStateRecord;
  recordAutomationCutover(input: RecordAutomationCutoverInput): AutomationCutoverRecord;
  appendAutomationCutoverTransition(cutoverId: string, transition: AutomationCutoverTransition): AutomationCutoverRecord;
  setAutomationCutoverStatus(cutoverId: string, status: AutomationCutoverRecord['status']): AutomationCutoverRecord;
  getAutomationCutover(cutoverId: string): AutomationCutoverRecord | null;
}
```

Persist requests before execution. Claim atomically records attempt, claimant, lease token/expiry, heartbeat, concrete provider/model/credential-authority tuple, and resolved hashes. Derive deterministic action keys from request, capability, normalized target, and logical operation. Grant activation/revocation verifies the signed repository policy and authenticated approval receipt inside the transaction. Hard-stop registration binds the signed document to the authenticated operator approval receipt. `worker_hard_stop_orchestrations` stores one root lease keyed by authorization hash plus canonical orchestration-plan hash; starting that root consumes no lifecycle operation. Each leaf reservation transactionally rechecks expiry, identity/account, immutable runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/state-machine hashes, ordered transition, amount/currency, cleanup bounds, nonce, parent orchestration, and single-use rules before any effect, and advances state only after authoritative terminal evidence. An uncertain leaf retains its reservation and blocks later transitions until reconciliation. Reconcile and skip transitions require authoritative evidence hashes and preserve prior uncertainty; close is operator-authenticated, refuses any missing/reserved/uncertain required operation, stores the close receipt atomically, and makes the authorization hash permanently replay-denied across restart.

- [ ] **Step 5: Implement canonical worker-state records and repairable filesystem projections**

`src/workers/state.ts` validates schemas and exposes `current.json`, `opportunities.jsonl`, `campaigns.jsonl`, `channel-scores.json`, and `action-ledger.jsonl` beneath each worker's `workspace/state`. SQLite is canonical. `current.json` and `channel-scores.json` use temp-file/fsync/atomic rename; JSONL projections preserve the canonical hash-chained event order and corrections append a new `supersedes` record. Startup compares projection hashes/cursors and regenerates missing/mismatched files from SQLite after creating a recovery copy. Clone-side adapters return typed state events and never own a second canonical ledger.

```ts
export class WorkerStateService {
  constructor(private readonly store: WorkerRuntimeStore, private readonly workerRoot: string) {}

  async project(worker: string): Promise<WorkerStateProjectionReceipt> {
    const stateRoot = resolve(this.workerRoot, worker, 'workspace', 'state');
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const current = this.store.getCurrentState(worker);
    const channelScores = this.store.getChannelScores(worker);
    await writeJsonAtomic(join(stateRoot, 'current.json'), current, 0o600);
    await writeJsonAtomic(join(stateRoot, 'channel-scores.json'), channelScores, 0o600);
    await writeHashChainedJsonl(join(stateRoot, 'opportunities.jsonl'), this.store.listOpportunityEvents(worker));
    await writeHashChainedJsonl(join(stateRoot, 'campaigns.jsonl'), this.store.listCampaignEvents(worker));
    await writeHashChainedJsonl(join(stateRoot, 'action-ledger.jsonl'), this.store.listActionLedgerEvents(worker));
    return this.store.recordProjection(worker, await hashProjectionDirectory(stateRoot));
  }
}
```

- [ ] **Step 6: Implement restart-safe typed transaction journals**

Persist every state transition and predecessor/candidate hash for site publication, collection promotion, enrichment promotion, code integration, and backend deployment. Do not infer completion from wrapper exit or missing output.

```ts
export type WorkerJournalKind =
  | 'site_publication' | 'collection_promotion' | 'enrichment_promotion'
  | 'code_integration' | 'backend_deployment';

export interface WorkerJournalTransition {
  journalId: string;
  kind: WorkerJournalKind;
  fromState: string;
  toState: string;
  predecessorHash: string;
  candidateHash: string;
  authoritativeReadbackHash?: string;
  occurredAt: string;
}

export function appendJournalTransition(
  database: Database.Database,
  transition: WorkerJournalTransition,
): void {
  database.prepare(`
    INSERT INTO worker_journal_events
      (journal_id, kind, from_state, to_state, predecessor_hash, candidate_hash, readback_hash, occurred_at)
    VALUES
      (@journalId, @kind, @fromState, @toState, @predecessorHash, @candidateHash, @authoritativeReadbackHash, @occurredAt)
  `).run(transition);
}
```

- [ ] **Step 7: Run tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/store.test.ts tests/workers/state.test.ts
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/workers/store.ts src/workers/state.ts src/workers/types.ts \
  tests/workers/store.test.ts tests/workers/state.test.ts
git commit -m "feat(workers): add durable runtime control plane"
```

---

## Task 6: Make `CapabilityExecutor` the non-bypassable action boundary

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: immutable execution profiles from Task 3 and action-time authorization/state lookups from Task 5.
- Produces: `CapabilityExecutor.execute(envelope: WorkerActionEnvelope): Promise<WorkerActionResult>`, normalized target locking, authorization decisions, action journals, and reconciliation-required outcomes.

**Files:**
- Create: `src/workers/capabilities/types.ts`
- Create: `src/workers/capabilities/executor.ts`
- Create: `src/workers/capabilities/registry.ts`
- Create: `tests/workers/capability-executor.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tool-result.ts`
- Modify: `tests/agent/tools/workers.test.ts`

- [ ] **Step 1: Write failing pre-side-effect, bypass, scope, redaction, and reconciliation tests**

```ts
test('executor journals action_started before invoking the adapter', async () => {
  const order: string[] = [];
  const executor = fixtureExecutor({
    onJournal: (event) => order.push(event.type),
    adapter: async () => { order.push('side_effect'); return successResult(); },
  });
  await executor.execute(allowedEnvelope());
  assert.deepEqual(order, ['action_started', 'side_effect', 'action_succeeded']);
});

test('worker registry exposes no direct generic execute or nested adapter bypass', async () => {
  const registry = buildWorkerCapabilityRegistry(profileFixture(), executor);
  assert.equal('execute' in registry, false);
  await assert.rejects(() => invokeNestedAdapterDirectly(registry), /capability executor/i);
});

test('path, symlink, shell, host, account, and secret violations deny before effects', async () => {
  for (const envelope of deniedEscapeFixtures()) {
    const result = await executor.execute(envelope);
    assert.equal(result.decision, 'deny');
    assert.equal(adapterCallCount(envelope.actionId), 0);
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
  }
});

test('uncertain consequential result becomes reconciliation_required', async () => {
  const result = await executor.execute(uncertainPublishEnvelope());
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(retryQueue.count(result.actionId), 0);
});

test('action provenance is server-derived and spoofed trigger/source/idempotency is rejected', async () => {
  const result = await executor.execute(spoofedActionProvenanceFixture());
  assert.equal(result.decision, 'deny');
  assert.equal(adapterCallCount(result.actionId), 0);
});

test('production billing canary requires the declared exact hard-stop lane', async () => {
  assert.equal((await executor.execute(billingWithStandingGrantOnly)).decision, 'require-human-authorization');
  assert.equal((await executor.execute(billingWithExpiredAuthorization)).decision, 'require-human-authorization');
  assert.equal((await executor.execute(exactAuthorizationForUndeclaredCapability)).decision, 'deny');
  const root = await executor.execute(billingRootWithExactAuthorization);
  assert.equal(root.decision, 'allow');
  assert.equal(hardStopStore.operations(root.actionId).length, 0);
  const result = await executor.execute(firstTrustedBillingLeaf);
  assert.equal(result.decision, 'allow');
  assert.equal(hardStopStore.operation(result.actionId).status, 'consumed');
  assert.equal((await executor.execute(billingReplayFixture)).decision, 'deny');
});

test('hard-stop hash and internal leaf dispatch are server-derived and non-spoofable', async () => {
  assert.equal((await executor.execute(callerSuppliedAuthorizationHashFixture)).decision, 'deny');
  assert.equal((await executor.execute(publicSpoofedBillingLeafFixture)).decision, 'deny');
  assert.equal((await executor.execute(childReplacingParentAuthorizationHash)).decision, 'deny');
  assert.equal(billingLeafAdapterCalls(), 0);
});

test('billing adapter routing is server-derived, exhaustive, and fails closed', async () => {
  const root = await executor.execute(validBillingRoot);
  assert.equal(root.adapterInvocation.route.kind, 'billing-orchestrator-root');
  const leaf = await executor.execute(validTrustedBillingLeaf);
  assert.equal(leaf.adapterInvocation.route.kind, 'billing-authorized-leaf');
  for (const envelope of [
    strippedLeafMarker, billingRootWithParent, leafWithoutParent,
    childOfLeaf, nondeterministicChildId, unknownBillingRoute,
  ]) {
    assert.equal((await executor.execute(envelope)).decision, 'deny');
  }
  assert.equal(adapterCallsForMalformedBillingRoutes(), 0);
});

test('billing root and leaf locks are disjoint and the full nested run cannot self-deadlock', async () => {
  assert.deepEqual(intersectLocks(BILLING_ROOT_LOCKS, BILLING_LEAF_LOCKS), []);
  const result = await withTimeout(executor.execute(validCompleteBillingCanary), 2_000);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.trace.rootOperationReservations, 0);
  assert.equal(result.trace.leafReservations, BILLING_CANARY_OPERATIONS.length);
});

test('a billing leaf advances only when authoritative evidence matches its reserved transition', async () => {
  const result = await executor.execute(leafWithMismatchedAuthoritativeState);
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(hardStopStore.currentState(result.authorizationHash), result.reservedFromState);
  assert.equal((await executor.execute(replayAfterStateMismatch)).decision, 'deny');
  assert.equal(billingLeafAdapterCallsFor(result.actionId), 1);
});

test('normal registry excludes hard stops until a trusted exact binding is attached', () => {
  assert.equal(buildWorkerCapabilityRegistry(shakedownProfile, executor).has('shakedown.billing.production-canary'), false);
  assert.equal(buildWorkerCapabilityRegistry(shakedownProfile, executor, trustedBillingRunContext)
    .has('shakedown.billing.production-canary'), true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/capability-executor.test.ts tests/agent/tools/workers.test.ts
```

Expected: FAIL because the executor, normalized target policy, and filtered worker registry are missing.

- [ ] **Step 3: Implement the exact chokepoint interface**

```ts
export interface CapabilityExecutor {
  execute(envelope: WorkerActionEnvelope): Promise<WorkerActionResult>;
}

export interface BillingCanaryLeafDispatch {
  kind: 'billing-canary-leaf';
  operation: BillingCanaryOperation;
  sequence: number;
}

export interface WorkerActionEnvelope {
  actionId: string;
  parentActionId?: string;
  requestId: string;
  runId: string;
  idempotencyKey: string;
  occurrenceKey?: string;
  pursuitId?: string;
  jobId?: string;
  eventId?: string;
  originWorker?: string;
  originRunId?: string;
  originActionId?: string;
  trigger: WorkerTrigger;
  authenticatedSourceRef: string;
  workerPrincipal: string;
  ownerPrincipal: string;
  manifestHash: string;
  authorityGrantHash: string;
  capabilityId: string;
  actionClass: WorkerActionClass;
  hardStopAuthorizationHash?: string;
  internalDispatch?: BillingCanaryLeafDispatch;
  arguments: unknown;
  correlationId: string;
  causationId?: string;
}

export type AuthorizedAdapterInvocation =
  | {
      route: { kind: 'standard' };
      action: WorkerActionEnvelope;
    }
  | {
      route: { kind: 'billing-orchestrator-root'; orchestrationId: string };
      action: WorkerActionEnvelope;
    }
  | {
      route: {
        kind: 'billing-authorized-leaf';
        orchestrationId: string;
        reservationId: string;
        parentActionId: string;
        operation: BillingCanaryOperation;
        sequence: number;
        fromState: BillingState;
        expectedToState: BillingState;
      };
      action: WorkerActionEnvelope;
    };
```

Normalize arguments and resolve every filesystem/process/URL/account/data target before policy evaluation. Re-evaluate current grant activation, revocation, expiry, hard denies, and machine gates immediately before every consequential action. Only `allow` invokes the adapter. `hardStopAuthorizationHash` and `internalDispatch` are trusted-envelope fields, never public/model arguments. The connector copies the hash only from the persisted `TrustedHardStopBinding`; only the Task 18 Home23 `adapter-dispatch.ts` may derive an internal leaf dispatch, and it must inherit the exact parent hash, principal, correlation, identity, account, amount, currency, runner hash, and catalog hash. A public/spoofed internal dispatch or a child that replaces the parent hash is denied before adapter invocation.

Adapters never infer billing role from optional envelope fields. After authorization, `CapabilityExecutor.execute()` constructs the required `AuthorizedAdapterInvocation` discriminated union from persisted provenance. A billing root requires stored `worker-tool-root` provenance, no parent, and no internal marker; a billing leaf requires stored `billing-router-child` provenance, the exact root journal, deterministic child ID, inherited authorization hash, and the reserved transition. Missing/stripped markers, a root with a parent, a leaf without a parent, a child of a leaf, an unknown route, or any lineage mismatch is denied rather than falling back to the outer orchestrator.

The executor obtains trigger/source/idempotency/event/occurrence/origin and hard-stop binding fields from the trusted stored request and action journal, never from model arguments. Authorization precedence is explicit: enforce non-overridable repository/data invariants first; classify the capability lane; for the normal lane require the active standing grant and its hard denies; for the hard-stop lane require a manifest hard-stop declaration plus the exact active authorization and ignore standing-grant authority; then enforce machine preconditions and invoke the adapter. The hard-stop lane cannot override destructive-data prohibitions, target confinement, consent/privacy, mandatory readback, reconciliation, rollback, or immutable-release checks. An inactive, expired, revoked, or hash-mismatched live/public grant returns `require-human-authorization`; an invalid target, undeclared hard-stop capability, caller-supplied authorization field, hard deny, replay, bypass, or malformed provenance returns `deny`.

- [ ] **Step 4: Enforce filesystem, shell, network, browser, account, and secret boundaries**

- realpath and lstat every filesystem target; reject traversal, symlinks, unresolved variables, home/root/workspace destructive targets, and scope-class mismatch;
- expose fixed typed commands only; any legacy shell compatibility adapter is command-policy and path confined;
- enforce declared hosts/accounts/action types, classify browser preflights that create state as writes, and redact credentials/session material before persistence;
- require nested operations to call `execute()` with parent/correlation/causation IDs.
- acquire locks only after the authorized adapter route is known; billing roots use `shakedown-billing-orchestration` plus the durable authorization-hash lease, while leaves use `shakedown-billing-provider-effects`, and validation rejects any root/leaf lock intersection.

```ts
export async function normalizeFilesystemTarget(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<NormalizedFilesystemTarget> {
  if (!isAbsolute(requestedPath) || requestedPath.includes('$')) throw new Error('filesystem target must be resolved and absolute');
  const stat = await lstat(requestedPath);
  if (stat.isSymbolicLink()) throw new Error('symlink targets are denied');
  const target = await realpath(requestedPath);
  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  if (!roots.some((root) => target === root || target.startsWith(`${root}${sep}`))) throw new Error('filesystem target outside capability scope');
  if (target === parse(target).root || target === homedir()) throw new Error('broad destructive target denied');
  return Object.freeze({ kind: 'filesystem', path: target });
}

export function normalizeNetworkTarget(urlText: string, allowedHosts: readonly string[]): NormalizedNetworkTarget {
  const url = new URL(urlText);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('insecure network target');
  if (!allowedHosts.includes(url.hostname)) throw new Error('network host outside capability scope');
  url.username = '';
  url.password = '';
  return Object.freeze({ kind: 'network', origin: url.origin, pathname: url.pathname });
}
```

- [ ] **Step 5: Enforce the non-standing hard-stop operation state machine**

For `shakedown.billing.production-canary`, ignore standing-grant authority and require the ID in `profile.hardStopCapabilities`. Resolve the authorization hash only from the trusted action envelope, load the exact activated document, and recheck signature/expiry/principal/capability/identity/accounts/amount/currency plus orchestration-plan/state-machine/runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/cleanup/redaction hashes. The outer action is orchestration-only: validate its canonical ordered plan against `orchestrationPlanHash`, obtain one root lease, and consume no lifecycle operation. Every operation in `BILLING_CANARY_OPERATIONS` re-enters `execute()` as a server-derived internal leaf, inherits the same exact hash, and reserves its single transition before the leaf adapter runs. Mark a leaf consumed only with authoritative result evidence; an uncertain result enters reconciliation, retains a non-repeatable reservation, and blocks later transitions until authoritative readback.

```ts
async function authorizeBillingCanary(
  envelope: WorkerActionEnvelope,
  input: BillingCanaryOrchestrationArguments | BillingCanaryLeafArguments,
  dependencies: CapabilityExecutorDependencies,
): Promise<HardStopAuthorizationDecision> {
  const authorizationHash = requireTrustedHardStopHash(envelope);
  const verified = await dependencies.hardStopAuthorizations.verifyActivated(authorizationHash);
  assertManifestHardStopDeclaration(envelope, verified.document.capabilityId);
  assertExactBillingPrincipalTargetsAndBounds(verified.document, envelope, input);
  assertPinnedBillingArtifacts(verified.document, dependencies.immutableRunnerManifest);

  if (!envelope.internalDispatch) {
    assertBillingOrchestrationArguments(input);
    assert.equal(sha256Canonical(normalizeBillingPlan(input)), verified.document.orchestrationPlanHash);
    const lease = await dependencies.store.beginHardStopOrchestration({
      authorizationHash,
      actionId: envelope.actionId,
      orchestrationPlanHash: verified.document.orchestrationPlanHash,
    });
    return {
      kind: 'billing-orchestrator-root',
      orchestrationId: lease.orchestrationId,
    };
  }

  assertTrustedBillingChildProvenance(envelope);
  assertBillingLeafArguments(input);
  const { operation, sequence } = envelope.internalDispatch;
  assert.equal(operation, input.operation);
  assertBillingOperationAuthorized(verified.document, operation, sequence);
  const reservation = await dependencies.store.reserveHardStopOperation({
    authorizationHash,
    orchestrationId: input.orchestrationId,
    operation,
    sequence,
    fromState: input.transition.from,
    expectedToState: input.transition.expectedTo,
    amountMinor: input.amountMinor,
    currency: input.currency,
    actionId: envelope.actionId,
  });
  return {
    kind: 'billing-authorized-leaf',
    orchestrationId: reservation.orchestrationId,
    reservationId: reservation.reservationId,
    parentActionId: envelope.parentActionId!,
    operation,
    sequence,
    fromState: reservation.fromState,
    expectedToState: reservation.expectedToState,
  };
}
```

The executor wraps that decision and the normalized envelope into `AuthorizedAdapterInvocation`, then chooses the route-specific lock set. The store, not the runner result, owns `fromState` and `expectedToState`; it advances only after authoritative evidence agrees with the reservation. A mismatch becomes `reconciliation_required`, retains the reservation, and cannot emit or replay another leaf.

- [ ] **Step 6: Prevent direct worker access to the generic tool registry**

Keep generic `ToolRegistry.execute` available for existing Jerry behavior, but never pass that object to worker runtimes. A worker registry is a set of `ToolDefinition`s whose handlers are closures over `CapabilityExecutor`; adapter modules do not export model-callable entrypoints.

```ts
export function buildWorkerCapabilityRegistry(
  profile: Readonly<WorkerExecutionProfile>,
  executor: CapabilityExecutor,
  runContext?: TrustedWorkerRunContext,
): ReadonlyMap<string, ToolDefinition> {
  const exactHardStop = resolveRunHardStopCapability(profile, runContext?.hardStopAuthorization);
  const availableCapabilities = [...profile.capabilities, ...(exactHardStop ? [exactHardStop] : [])];
  return new Map(availableCapabilities.map((capabilityId) => {
    const definition = getCapabilityDefinition(capabilityId);
    return [capabilityId, {
      name: capabilityId,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (argumentsValue, context) => executor.execute(
        context.createActionEnvelope(capabilityId, definition.actionClass, argumentsValue),
      ),
    } satisfies ToolDefinition];
  }));
}
```

`resolveRunHardStopCapability()` returns nothing without a server-persisted exact binding, rejects a capability absent from `profile.hardStopCapabilities`, and never consults or expands the standing-grant set. The billing definition appears for that run only; all internal leaf dispatches remain executor/adapter-only and never become model-visible tools.

- [ ] **Step 7: Run focused tests and build — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/capability-executor.test.ts tests/agent/tools/workers.test.ts
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/workers/capabilities/types.ts src/workers/capabilities/executor.ts \
  src/workers/capabilities/registry.ts src/agent/tools/index.ts src/agent/tool-result.ts \
  tests/workers/capability-executor.test.ts tests/agent/tools/workers.test.ts
git commit -m "feat(workers): enforce typed capability actions"
```

---

## Task 7: Construct a real worker-specific AgentLoop with cumulative budgets

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 3 execution profiles, Task 5 runtime store, and Task 6 filtered capability executor.
- Produces: `WorkerRuntimeFactory.create()`, `WorkerBudget`, owner/worker brain delegation, per-attempt loop/context/history construction, and persistent finite safety-reserve accounting.

**Files:**
- Create: `src/workers/budget.ts`
- Create: `src/workers/brain-delegate.ts`
- Create: `src/workers/runtime-factory.ts`
- Create: `src/workers/runtime.ts`
- Modify: `src/workers/runner.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/context.ts`
- Modify: `src/agent/history.ts`
- Modify: `src/agent/brain-operations/client.ts`
- Create: `tests/workers/runtime.test.ts`
- Create: `tests/workers/budget.test.ts`
- Modify: `tests/workers/runner.test.ts`
- Modify: `tests/agent/turn-entrypoint-callers.test.ts`

- [ ] **Step 1: Replace the old source-shape expectation with failing runtime-isolation tests**

```ts
test('worker runtime honors its own prompt, registry, provider, model, workspace, and history', async () => {
  const runtime = await factory.create(attemptFixture('shakedown-jerry'));
  assert.notEqual(runtime.agentLoop, jerryAgentLoop);
  assert.equal(runtime.context.workspacePath, workerWorkspace);
  assert.equal(runtime.history.namespace, attemptId);
  assert.equal(runtime.provider, pinnedProvider);
  assert.equal(runtime.model, pinnedModel);
  assert.deepEqual(runtime.registry.names(), profile.capabilities);
  assert.match(runtime.systemPrompt, /ShakedownJerry/);
});

test('Jerry chat and two Jerry-owned workers run concurrently unless sharing a resource lock', async () => {
  const [chat, first, second] = await runConcurrentFixtures();
  assert.equal(chat.status, 'complete');
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.ok(sharedCutoverMaxObserved <= 1);
});

test('token budget is cumulative across prompts, completions, retries, and secondary model calls', async () => {
  const budget = workerBudget({ maxTokens: 100 });
  budget.recordUsage({ promptTokens: 30, completionTokens: 20 });
  budget.recordUsage({ promptTokens: 40, completionTokens: 11 });
  assert.throws(() => budget.assertMayContinue(), /budget/i);
});

test('runtime, tool-call, artifact-byte, retry, and deadline ceilings stop optional work', async () => {
  for (const fixture of [runtimeLimit(), toolCallLimit(), artifactLimit(), retryLimit(), expiredDeadline()]) {
    const result = await executeWithLimit(fixture);
    assert.equal(result.optionalWorkStopped, true);
    assert.match(result.status, /budget_exhausted|timed_out|failed_after_bounded_retry/);
  }
});

test('trigger limits may narrow but never widen the frozen profile', async () => {
  assert.deepEqual(resolveTriggerLimits(profileLimits, narrowerTrigger), narrowerExpected);
  assert.throws(() => resolveTriggerLimits(profileLimits, widerTrigger), /cannot widen/i);
});

test('missing provider usage uses a conservative estimate and records estimation', async () => {
  const usage = normalizeUsage(providerResultWithoutUsage, tokenizerFixture);
  assert.equal(usage.estimated, true);
  assert.equal(usage.totalTokens >= conservativeExpectedMinimum, true);
});

test('persistent history requires one durable lease while fresh histories do not collide', async () => {
  assert.equal((await claimTwoPersistentRuns()).second.status, 'waiting_for_history_lease');
  const fresh = await claimTwoFreshRuns();
  assert.notEqual(fresh.first.historyNamespace, fresh.second.historyNamespace);
});

test('finite reserve permits verifier and rollback only, then freezes the affected target', async () => {
  const budget = exhaustedOrdinaryBudgetWithReserve(2);
  assert.equal(budget.authorize('verify').allowed, true);
  assert.equal(budget.authorize('rollback').allowed, true);
  assert.equal(budget.authorize('publish').allowed, false);
  assert.equal(budget.authorize('verify').status, 'reserve_exhausted_target_frozen');
});
```

- [ ] **Step 2: Run — expect FAIL because production still reuses Jerry's loop**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/runtime.test.ts tests/workers/budget.test.ts \
  tests/workers/runner.test.ts tests/agent/turn-entrypoint-callers.test.ts
```

Expected: FAIL on loop identity, history namespace, or cumulative budget assertions, proving production still reuses Jerry's runtime objects.

- [ ] **Step 3: Implement per-attempt runtime construction**

Build a new `AgentLoop`, `ContextManager`, `ConversationHistory`, worker `ToolContext`, filtered capability registry, event ledger, owner-brain delegate, deadline signal, and budget from the frozen profile. Share only stateless provider/config clients. Assemble the authoritative system prompt from all four pinned files: `IDENTITY.md`, `PLAYBOOK.md`, `NOW.md`, `MEMORY.md`.

For `fresh` history, use an attempt-specific namespace and rebuild context from explicit worker state/receipts/brain retrieval. For `persistent`, use a stable worker history key guarded by a durable history lease; reject `maxConcurrentRuns > 1` without that serialization.

```ts
export class WorkerRuntimeFactory {
  constructor(private readonly dependencies: WorkerRuntimeDependencies) {}

  async create(attempt: WorkerAttemptRecord): Promise<WorkerAttemptRuntime> {
    const profile = await this.dependencies.profiles.resolvePinned(attempt);
    const historyNamespace = profile.history === 'fresh' ? attempt.attemptId : `worker:${profile.worker}`;
    if (profile.history === 'persistent' && profile.limits.maxConcurrentRuns > 1) {
      throw new Error('persistent history requires serialized concurrency');
    }
    const historyLease = profile.history === 'persistent'
      ? this.dependencies.store.claimHistoryLease(profile.worker, attempt.attemptId)
      : undefined;
    const budget = new WorkerBudget(profile.limits, this.dependencies.store, attempt.attemptId);
    const capabilityRegistry = buildWorkerCapabilityRegistry(profile, this.dependencies.capabilityExecutor);
    const context = new ContextManager({ workspacePath: profile.workspaceRoot, namespace: historyNamespace });
    const history = new ConversationHistory({ namespace: historyNamespace, storage: this.dependencies.historyStorage });
    const systemPrompt = await assemblePinnedPrompt(profile.promptDocuments);
    const agentLoop = new AgentLoop({
      provider: profile.provider,
      model: profile.model,
      tools: capabilityRegistry,
      context,
      history,
      systemPrompt,
      usageObserver: (usage) => budget.recordUsage(usage),
    });
    return { agentLoop, context, history, budget, historyLease, provider: profile.provider, model: profile.model, systemPrompt };
  }
}
```

- [ ] **Step 4: Add optional normalized usage and cancellation hooks without changing Jerry defaults**

Normalize prompt/completion/cache usage from every provider branch in `src/agent/loop.ts`; fall back to a conservative tokenizer estimate when provider usage is absent. Add injected budget/usage/abort hooks with current Jerry behavior as the default. Count secondary model-backed capabilities too.

```ts
export function normalizeUsage(
  response: ProviderResponse,
  tokenizer: TokenEstimator,
): NormalizedModelUsage {
  if (response.usage) {
    const promptTokens = response.usage.promptTokens ?? response.usage.inputTokens ?? 0;
    const completionTokens = response.usage.completionTokens ?? response.usage.outputTokens ?? 0;
    const cacheTokens = response.usage.cacheTokens ?? 0;
    return { promptTokens, completionTokens, cacheTokens, totalTokens: promptTokens + completionTokens + cacheTokens, estimated: false };
  }
  const promptTokens = Math.ceil(tokenizer.estimate(response.serializedInput) * 1.15);
  const completionTokens = Math.ceil(tokenizer.estimate(response.outputText) * 1.15);
  return { promptTokens, completionTokens, cacheTokens: 0, totalTokens: promptTokens + completionTokens, estimated: true };
}
```

- [ ] **Step 5: Implement finite post-cutover safety reserve**

Persist ordinary and reserve runtime/tool/artifact/retry consumption in SQLite. After cutover, optional/model work stops on cancel/deadline/budget exhaustion, while named deterministic verification/rollback may consume only the finite reserve. It cannot call a model or publish new material.

```ts
export class WorkerBudget {
  constructor(
    private readonly limits: WorkerLimits,
    private readonly store: WorkerRuntimeStore,
    private readonly attemptId: string,
  ) {}

  recordUsage(usage: NormalizedModelUsage): void {
    const total = this.store.incrementBudgetCounter(this.attemptId, 'tokens', usage.totalTokens, usage.estimated);
    if (total > this.limits.maxTokens) throw new BudgetExceededError('token budget exhausted');
  }

  authorize(kind: WorkerBudgetOperation): WorkerBudgetDecision {
    const counters = this.store.getBudgetCounters(this.attemptId);
    if (!counters.ordinaryExhausted) return { allowed: true, source: 'ordinary' };
    if (kind !== 'verify' && kind !== 'rollback') return { allowed: false, status: 'budget_exhausted' };
    const reserve = this.store.consumeSafetyReserve(this.attemptId, kind);
    return reserve.remaining >= 0
      ? { allowed: true, source: 'safety_reserve' }
      : { allowed: false, status: 'reserve_exhausted_target_frozen' };
  }
}
```

- [ ] **Step 6: Implement scoped owner-brain delegation**

Carry both `ownerPrincipal` and `workerPrincipal`; enforce declared public-safe read scopes and `feedsBrains`; redact personal, health, credential, private, and unrelated context. A retrieval failure degrades only that step. Promotion accepts only verified receipt candidates with source/receipt provenance.

```ts
export async function readThroughOwnerBrain(
  input: WorkerBrainRead,
  dependencies: WorkerBrainDependencies,
): Promise<WorkerBrainReadResult> {
  const allowedScopes = dependencies.profile.brainReadScopes.filter((scope) => PUBLIC_SAFE_BRAIN_SCOPES.has(scope));
  try {
    const result = await dependencies.client.read({
      ownerPrincipal: input.ownerPrincipal,
      workerPrincipal: input.workerPrincipal,
      query: input.query,
      scopes: allowedScopes,
    });
    return { status: 'available', records: result.records.map(redactWorkerBrainRecord) };
  } catch (error) {
    return { status: 'degraded', records: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function promoteWorkerMemoryCandidate(candidate: WorkerMemoryCandidate): Promise<void> {
  if (!candidate.verified || !candidate.receiptId || !candidate.sourceUri) {
    throw new Error('memory promotion requires verified receipt provenance');
  }
  await semanticMemoryOutbox.enqueue(candidate.destination, candidate);
}
```

- [ ] **Step 7: Run focused tests and build — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/runtime.test.ts tests/workers/budget.test.ts tests/workers/runner.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/workers/budget.ts src/workers/brain-delegate.ts src/workers/runtime-factory.ts \
  src/workers/runtime.ts src/workers/runner.ts src/agent/loop.ts src/agent/types.ts \
  src/agent/context.ts src/agent/history.ts src/agent/brain-operations/client.ts \
  tests/workers/runtime.test.ts tests/workers/budget.test.ts tests/workers/runner.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts
git commit -m "feat(workers): run isolated bounded worker loops"
```

---

## Task 8: Add durable dispatch, leases, cancellation, retry, and recovery

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 5 transactional store and Task 7 runtime factory/budget enforcement.
- Produces: `WorkerDispatcher.enqueue()`, `claim()`, `cancel()`, and `recover()` plus owner-harness broker lifecycle, leases, retries, capacity isolation, and restart reconciliation.

**Files:**
- Create: `src/workers/dispatcher.ts`
- Create: `tests/workers/dispatcher.test.ts`
- Create: `tests/workers/recovery.test.ts`
- Modify: `src/workers/runner.ts`
- Modify: `src/home.ts`

- [ ] **Step 1: Write failing persistence, concurrency, cancellation, and recovery tests**

```ts
test('request persists before broker execution and survives harness restart', async () => {
  const accepted = await dispatcher.enqueue(envelopeFixture());
  assert.equal(store.getRequest(accepted.requestId)?.status, 'queued');
  await stopHarness();
  await startHarness();
  const receipt = await waitForTerminal(accepted.requestId);
  assert.equal(receipt.attemptCount, 1);
});

test('model and tool cancellation stops optional work but not mandatory rollback', async () => {
  const run = await startPostCutoverFixture();
  await dispatcher.cancel(run.requestId, operatorPrincipal);
  assert.equal(modelAbortObserved, true);
  assert.equal(adapterAbortObserved, true);
  assert.equal((await waitForTerminal(run.requestId)).status, 'rolled_back');
});

test('policy denial and evidence conflict do not consume transient retry budget', async () => {
  for (const failure of [policyDenied(), watermarkConflict()]) {
    const receipt = await executeFailure(failure);
    assert.equal(receipt.attemptCount, 1);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/dispatcher.test.ts tests/workers/recovery.test.ts
```

Expected: FAIL because durable dispatch, lease recovery, and cancellation propagation are not implemented.

- [ ] **Step 3: Implement the owner broker and bounded worker capacity**

Start one lightweight broker inside each owner harness after providers/tools initialize and before connector traffic is accepted. Claim only manifests whose owner matches authenticated `AGENT_NAME`; use `INSTANCE_ID` as claimant. Replace `activeOwners` with per-worker capacity plus named shared-resource leases such as `shakedown:site-build`, `shakedown:public-cutover`, `shakedown:collection-promotion`, and `shakedown:enrichment-promotion`.

```ts
export async function startOwnerWorkerBroker(input: {
  agentName: string;
  instanceId: string;
  dispatcher: WorkerDispatcher;
  abortSignal: AbortSignal;
}): Promise<WorkerBroker> {
  const broker = new WorkerBroker({
    ownerAgent: input.agentName,
    claimant: input.instanceId,
    dispatcher: input.dispatcher,
    resourceLocks: [
      'shakedown:site-build',
      'shakedown:public-cutover',
      'shakedown:collection-promotion',
      'shakedown:enrichment-promotion',
    ],
  });
  await broker.recover();
  broker.run(input.abortSignal);
  return broker;
}
```

- [ ] **Step 4: Implement lifecycle, heartbeat, retry, cancellation, and circuits**

Use the exact v2 lifecycle. Renew leases durably. Reconcile stale attempts by journal plus authoritative readback. Retry only classified transient failures with bounded exponential backoff. Open circuits per capability/account/target, not per worker. Before cutover, cancellation propagates to model and active tools and records completed work. After cutover, resume mandatory verification/rollback from the journal.

```ts
export class WorkerDispatcher {
  async enqueue(envelope: TrustedWorkerRunEnvelope): Promise<AcceptedWorkerRequest> {
    return this.store.enqueue(envelope);
  }

  async claim(ownerAgent: string, claimant: string): Promise<WorkerLease | null> {
    return this.store.claimNext({ ownerAgent, claimant, now: new Date().toISOString() });
  }

  async cancel(requestId: string, principal: WorkerPrincipal): Promise<WorkerRunRecord> {
    const run = this.store.cancel({ requestId, principal, cancelledAt: new Date().toISOString() });
    this.abortControllers.get(requestId)?.abort(new Error('worker run cancelled'));
    if (run.cutoverState === 'post_cutover') await this.enqueueMandatoryRecovery(run);
    return run;
  }

  async recover(): Promise<WorkerRunRecord[]> {
    const stale = this.store.reconcileExpiredLeases(new Date().toISOString());
    for (const run of stale) {
      const readback = await this.reconciler.readAuthoritativeState(run);
      if (readback.status === 'uncertain') this.store.requireReconciliation(run.requestId, readback);
      else if (readback.retryClass === 'transient') this.store.scheduleRetry(run.requestId, boundedBackoff(run.attemptCount));
      else this.store.recordRecoveredTerminal(run.requestId, readback);
    }
    return stale;
  }
}
```

- [ ] **Step 5: Run focused tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/store.test.ts tests/workers/dispatcher.test.ts tests/workers/recovery.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/workers/dispatcher.ts src/workers/runner.ts src/home.ts \
  tests/workers/dispatcher.test.ts tests/workers/recovery.test.ts
git commit -m "feat(workers): dispatch and recover durable runs"
```

---

## Task 9: Commit canonical v2 receipts and destination-aware outboxes

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 5 transactions and Task 7–8 attempt/action lifecycle events.
- Produces: canonical `WorkerReceiptV2` commits, destination-aware outbox rows, acknowledgement/retry semantics, and atomic filesystem/dashboard/memory projections.

**Files:**
- Create: `src/workers/outbox.ts`
- Create: `src/workers/projections.ts`
- Modify: `src/workers/receipts.ts`
- Modify: `src/agent/context-assembly.ts`
- Modify: `engine/src/channels/work/worker-runs-channel.js`
- Modify: `engine/src/index.js`
- Create: `tests/workers/outbox.test.ts`
- Modify: `tests/workers/receipts.test.ts`
- Modify: `tests/agent/context-worker-runs.test.ts`
- Modify: `tests/engine/channels/work/worker-runs-channel.test.js`

- [ ] **Step 1: Write failing atomic-projection and status-preservation tests**

```ts
test('filesystem receipt is regenerated from canonical SQLite blob and hash', async () => {
  const canonical = store.getCanonicalReceipt(runId);
  await writeFile(receiptPath, '{"corrupt":true}\n');
  await reconcileReceiptProjection(runId);
  assert.equal(await sha256File(receiptPath), canonical.sha256);
});

test('feed projection preserves denial, failure, verifier, semantic, and rollback status', async () => {
  const projected = projectWorkerReceipt(deniedReceiptFixture());
  assert.equal(projected.status, 'denied');
  assert.equal(projected.semanticStatus, 'no_consequence');
  assert.equal(projected.verifierStatus, 'not_run');
  assert.equal(projected.flags.includes('COLLECTED'), false);
});

test('semantic promotion accepts verified candidates only and retries independently', async () => {
  const result = await deliverOutbox(mixedCandidateReceipt());
  assert.equal(result.memory.promoted, 1);
  assert.equal(result.auditFeed.delivered, true);
  assert.equal(result.memory.retryPending, true);
});

test('canonical receipt persists every required v2 identity, provenance, outcome, and recovery field', async () => {
  const receipt = await buildReceipt(completeStructuredEventFixture());
  assert.deepEqual(Object.keys(receipt).sort(), minimumWorkerReceiptV2Fields.sort());
  assert.equal(receipt.actions.every(hasCapabilityTargetPolicyInputResultRollback), true);
  assert.equal(receipt.evidence.every(hasSourceFreshnessHashVerifier), true);
  assert.equal(receipt.artifacts.every(hasUriHashMediaTypeRole), true);
  assert.equal(receipt.memoryCandidates.every(hasProvenanceConfidenceDestination), true);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/receipts.test.ts tests/workers/outbox.test.ts \
  tests/agent/context-worker-runs.test.ts
```

Expected: FAIL because receipt canonicalization, destination outboxes, and projection repair are absent.

- [ ] **Step 3: Implement canonical receipts and atomic projections**

Build v2 receipts from structured runtime events, never solely model prose. In one transaction write terminal state, canonical blob/hash, and initial destination rows. Write each run's `receipt.json` beneath its canonical run directory by temp file plus atomic rename. Startup repairs missing or mismatched projections from SQLite.

```ts
export function commitCanonicalReceipt(
  store: WorkerRuntimeStore,
  events: readonly StructuredWorkerEvent[],
  profile: Readonly<WorkerExecutionProfile>,
): CanonicalReceiptRecord {
  const receipt = decodeWorkerReceipt(buildWorkerReceiptV2(events, profile));
  const canonicalJson = canonicalize(receipt);
  const sha256 = createHash('sha256').update(canonicalJson).digest('hex');
  return store.complete({
    requestId: receipt.requestId,
    runId: receipt.runId,
    receipt,
    canonicalJson,
    sha256,
    destinations: deriveReceiptDestinations(profile, receipt),
  });
}

export async function writeReceiptProjection(record: CanonicalReceiptRecord): Promise<void> {
  const receiptPath = join(record.runDirectory, 'receipt.json');
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(receiptPath, record.receipt, 0o600);
  if (await sha256File(receiptPath) !== record.sha256) throw new Error('receipt projection hash mismatch');
}
```

- [ ] **Step 4: Implement destination-aware outboxes**

Separate audit feed, dashboard, owner workspace, Jerry/Forrest feeds, and semantic-memory promotion. Each has its own acknowledgement, retry state, and idempotency key. Derive destinations from resolved owner, `feedsBrains`, and `visibleTo`; remove hard-coded Jerry paths. Redact secrets/PII before committing any blob.

```ts
export class WorkerOutbox {
  constructor(private readonly store: WorkerRuntimeStore, private readonly adapters: WorkerDestinationAdapters) {}

  async deliver(row: WorkerOutboxRow): Promise<WorkerOutboxDelivery> {
    const payload = redactWorkerProjection(row.payload);
    const adapter = this.adapters.forDestination(row.destination);
    try {
      const acknowledgement = await adapter.deliver(payload, row.idempotencyKey);
      return this.store.acknowledgeOutbox({ rowId: row.rowId, acknowledgement, deliveredAt: new Date().toISOString() });
    } catch (error) {
      return this.store.retryOutbox({
        rowId: row.rowId,
        error: error instanceof Error ? error.message : String(error),
        nextAttemptAt: nextBoundedOutboxAttempt(row.attemptCount),
      });
    }
  }
}
```

- [ ] **Step 5: Fix engine ingestion and Jerry pre-turn context**

Preserve actual status in `worker-runs-channel.js`; remove unconditional `COLLECTED`. Read validated status-preserving projections in context assembly, include recent meaningful receipt summaries and current worker state, and never include raw transcripts.

```js
function projectWorkerRun(receipt) {
  return Object.freeze({
    runId: receipt.runId,
    worker: receipt.worker,
    status: receipt.status,
    semanticStatus: receipt.semanticStatus,
    verifierStatus: receipt.verifierStatus,
    expectedConsequence: receipt.expectedConsequence,
    evidenceCount: receipt.evidence.length,
    rollbackStatus: receipt.recovery?.rollbackStatus ?? 'not_required',
  });
}

module.exports = { projectWorkerRun };
```

- [ ] **Step 6: Run focused tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/receipts.test.ts tests/workers/outbox.test.ts \
  tests/agent/context-worker-runs.test.ts
node --test tests/engine/channels/work/worker-runs-channel.test.js
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/workers/outbox.ts src/workers/projections.ts src/workers/receipts.ts \
  src/agent/context-assembly.ts engine/src/channels/work/worker-runs-channel.js \
  engine/src/index.js tests/workers/outbox.test.ts tests/workers/receipts.test.ts \
  tests/agent/context-worker-runs.test.ts tests/engine/channels/work/worker-runs-channel.test.js
git commit -m "feat(workers): deliver canonical status-preserving receipts"
```

---

## Task 10: Converge API, Jerry tools, CLI, and dashboard proxy on one management service

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 4 authentication, Task 5 store, Task 8 dispatcher, and Task 9 receipts/projections.
- Produces: `WorkerManagementClient` run/status/cancel/schedule/pursuit/hard-stop methods, `recordAutomationCutover(input: RecordAutomationCutoverInput): Promise<AutomationCutoverRecord>`, and one canonical authenticated HTTP contract used by CLI, Jerry tools, and dashboard proxy.

**Files:**
- Create: `src/workers/client.ts`
- Modify: `src/workers/connector.ts`
- Modify: `src/home.ts`
- Modify: `src/agent/tools/workers.ts`
- Modify: `cli/lib/worker-commands.js`
- Modify: `cli/home23.js`
- Modify: `engine/src/dashboard/server.js`
- Modify: `tests/workers/connector.test.ts`
- Modify: `tests/agent/tools/workers.test.ts`
- Modify: `tests/engine/dashboard/worker-fallback.test.js`

- [ ] **Step 1: Write failing real-HTTP authorization and async-management tests**

```ts
test('POST run returns 202 after durable enqueue and strips identity fields', async () => {
  const response = await request(app)
    .post('/api/workers/shakedown-jerry/runs')
    .set('authorization', `Bearer ${jerryToolToken}`)
    .send({ mission: 'observe', ownerAgent: 'forrest', requestedBy: 'human' });
  assert.equal(response.status, 202);
  const stored = store.getRequest(response.body.requestId);
  assert.equal(stored.ownerAgent, 'jerry');
  assert.equal(stored.trigger, 'house-agent');
});

test('list, receipt, artifact, cancel, and retry enforce owner and visibleTo', async () => {
  for (const path of protectedRunPaths(runId)) {
    assert.equal((await getAs(forrestCredential, path)).status, 403);
  }
});

test('credential authority unavailable fails closed before route handler', async () => {
  assert.equal((await postWithoutConfiguredAuthority()).status, 503);
  assert.equal(store.requestCount(), 0);
});

test('Jerry can redirect the shared pursuit without editing worker authority', async () => {
  const response = await client.redirectPursuit({
    worker: 'shakedown-jerry', pursuitId, focus: 'repair the broken subscribe destination', expectedVersion,
  });
  assert.equal(response.status, 'accepted');
  assert.equal(store.getPursuit(pursuitId).focus, 'repair the broken subscribe destination');
  assert.equal(store.getPursuit(pursuitId).authorityGrantHash, originalGrantHash);
});

test('only the authenticated operator can register an exact hard-stop authorization', async () => {
  assert.equal((await registerHardStopAs(jerryCredential, signedDocument)).status, 403);
  assert.equal((await registerHardStopAs(operatorCredential, signedDocument)).status, 403);
  const approval = await recordExactHardStopApprovalAs(operatorCredential, canonicalRequestHash);
  assert.equal((await registerHardStopAs(operatorCredential, signedDocument, approval)).status, 201);
});

test('operator-only hard-stop reconcile, skip, close, status, and replay denial are restart-safe', async () => {
  await assert.rejects(() => jerryClient.closeHardStopAuthorization(authorizationHash), /403|operator/i);
  await operatorClient.reconcileHardStopOperation(reconciliationWithAuthoritativeEvidence);
  await operatorClient.skipHardStopOperation(skipWithAuthoritativeEvidence);
  const closed = await operatorClient.closeHardStopAuthorization(authorizationHash);
  assert.equal(closed.status, 'closed');
  assert.equal((await operatorClient.getHardStopAuthorization(authorizationHash)).status, 'closed');
  assert.equal((await operatorClient.testHardStopReplay(authorizationHash)).decision, 'deny');
  store.close();
  assert.equal((await restartedOperatorClient.testHardStopReplay(authorizationHash)).decision, 'deny');
});

test('automation cutover stores prior state and rollback operations atomically', async () => {
  const input = automationCutoverFixture();
  await assert.rejects(() => jerryClient.recordAutomationCutover(input), /403|operator/i);
  const record = await operatorClient.recordAutomationCutover(input);
  assert.deepEqual(record.priorState, input.priorState);
  assert.deepEqual(record.rollbackOperations, input.rollbackOperations);
  store.close();
  const reopened = createTestStore(databasePath);
  assert.deepEqual(reopened.getAutomationCutover(input.cutoverId), record);
  reopened.failpoint('after_cutover_state_before_rollback_operations');
  const reopenedClient = createTestManagementClient({ store: reopened, principal: operatorPrincipal });
  await assert.rejects(() => reopenedClient.recordAutomationCutover(anotherCutoverFixture()), /failpoint/);
  assert.equal(reopened.getAutomationCutover(anotherCutoverId), null);
});

test('prepared automation cutover reconciles a crash between external mutation and transition append', async () => {
  const prepared = await operatorClient.recordAutomationCutover(automationCutoverFixture());
  assert.equal(prepared.status, 'prepared');
  await externalFixture.applyOnlyFirstChange();
  store.close();
  const restarted = createTestManagementClient({ store: createTestStore(databasePath), principal: operatorPrincipal });
  const reconciliation = await restarted.reconcileAutomationCutover(
    prepared.cutoverId,
    await externalFixture.authoritativeState(),
  );
  assert.equal(reconciliation.status, 'reconciliation_required');
  assert.deepEqual(reconciliation.requiredRollbackOperations, prepared.rollbackOperations.slice(0, 1));
  const rolledBack = await restarted.rollbackAutomationCutover(prepared.cutoverId);
  assert.equal(rolledBack.status, 'rolled_back');
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/connector.test.ts tests/agent/tools/workers.test.ts
```

Expected: FAIL because the canonical management client and route-level scope enforcement are incomplete.

- [ ] **Step 3: Implement the asynchronous authenticated management contract**

Support list/inspect/create/validate/reload, effective profiles, run-now, queued/active/stale/completed runs, progress streaming, receipt/artifact read, cancel, retry, shared-pursuit redirect/focus, schedules, event bindings, verified memory promotion, standing-grant activate/revoke, exact hard-stop authorization register/revoke/status, transactional automation-cutover recording, disable, and recoverable archive. There is no normal hard-delete. `POST /api/workers/:worker/runs` returns `202` only after durable enqueue/idempotency reservation; status is `GET /api/workers/requests/:requestId`.

The tested CLI grammar is closed and consistent: worker-scoped commands use the worker name as the first positional argument (`worker validate <worker>`, `worker migrate <worker>`, `worker run <worker>`, `worker install <worker>`); `grant finalize`, `grant validate-candidate`, and `grant verify` take the document positionally, while `grant sign` always uses explicit `--input` plus `--key-id`; worker grant state uses `worker grant <activate|revoke|show|preflight> <worker>`; and hard-stop commands use `worker hard-stop <verb> <worker>` plus explicit document/hash/receipt flags. Aliases that alternate `--worker`, `authority validate-candidate`, or multiple forms for the same verb are not implemented. Contract tests enumerate every later plan invocation and reject grammar drift.

```ts
export const WORKER_CLI_GRAMMAR = Object.freeze({
  workerPositionals: ['install', 'migrate', 'run', 'validate'],
  grantDocumentPositionals: ['finalize', 'validate-candidate', 'verify'],
  grantSignRequiredFlags: ['--input', '--key-id'],
  grantWorkerVerbs: ['activate', 'preflight', 'revoke', 'show', 'test-mismatch'],
  hardStopWorkerVerbs: ['approve', 'close', 'prepare', 'reconcile', 'register', 'replay-test', 'show', 'sign', 'skip', 'status'],
  automationCutoverVerbs: ['append', 'complete', 'prepare', 'reconcile', 'rollback', 'show'],
  nestedWorkerVerbs: Object.freeze({
    action: ['test-denial'],
    automation: ['inventory'],
    channels: ['inventory', 'validate'],
    migrations: ['verify'],
    pursuit: ['upsert'],
    schedules: ['install', 'status'],
  }),
  keyVerbs: ['import', 'init', 'rotate'],
});
```

```ts
export interface RecordAutomationCutoverInput {
  cutoverId: string;
  worker: string;
  priorState: {
    automations: Array<{ id: string; enabled: boolean; schedule: string; definitionHash: string; projectRoot: string; version: string }>;
    workerSchedules: Array<{ jobId: string; enabled: boolean; nextRunAt: string | null; profileHash: string; version: string }>;
  };
  replacementState: {
    automations: Array<{ id: string; enabled: boolean; schedule: string; definitionHash: string; projectRoot: string; version: string }>;
    workerSchedules: Array<{ jobId: string; enabled: boolean; nextRunAt: string | null; profileHash: string; version: string }>;
  };
  rollbackOperations: Array<{
    operation: 'set-automation-enabled' | 'restore-worker-schedule';
    targetId: string;
    expectedVersion: string;
    value: boolean | string;
  }>;
}

export interface AutomationCutoverRecord extends RecordAutomationCutoverInput {
  status: 'prepared' | 'applying' | 'applied' | 'rolling_back' | 'rolled_back' | 'reconciliation_required';
  transitions: AutomationCutoverTransition[];
  createdAt: string;
}

export interface AutomationCutoverTransition {
  targetId: string;
  fromVersion: string;
  toVersion: string;
  intendedStateHash: string;
  authoritativeReadbackHash: string;
  receiptId: string;
  occurredAt: string;
}

export interface WorkerManagementClient {
  enqueueRun(worker: string, input: PublicWorkerRunInput): Promise<AcceptedWorkerRequest>;
  getRequest(requestId: string): Promise<WorkerRequestProjection>;
  redirectPursuit(input: RedirectPursuitInput): Promise<AcceptedManagementAction>;
  recordHardStopApproval(requestHash: string): Promise<HardStopApprovalReceipt>;
  registerHardStopAuthorization(document: SignedHardStopAuthorization, approvalReceipt: HardStopApprovalReceipt): Promise<HardStopAuthorizationRecord>;
  revokeHardStopAuthorization(authorizationHash: string, reason: string): Promise<HardStopAuthorizationRecord>;
  getHardStopAuthorization(authorizationHash: string): Promise<HardStopAuthorizationRecord>;
  reconcileHardStopOperation(input: HardStopOperationReconciliationInput): Promise<HardStopOperationRecord>;
  skipHardStopOperation(input: HardStopOperationSkipInput): Promise<HardStopOperationRecord>;
  closeHardStopAuthorization(authorizationHash: string): Promise<HardStopAuthorizationRecord>;
  testHardStopReplay(authorizationHash: string): Promise<{ decision: 'deny' }>;
  recordAutomationCutover(input: RecordAutomationCutoverInput): Promise<AutomationCutoverRecord>;
  appendAutomationCutoverTransition(cutoverId: string, transition: AutomationCutoverTransition): Promise<AutomationCutoverRecord>;
  completeAutomationCutover(cutoverId: string): Promise<AutomationCutoverRecord>;
  reconcileAutomationCutover(cutoverId: string, authoritativeState: AutomationCutoverAuthoritativeState): Promise<AutomationCutoverReconciliation>;
  rollbackAutomationCutover(cutoverId: string): Promise<AutomationCutoverRecord>;
}
```

- [ ] **Step 4: Enforce operation, owner, visibility, and harness claim scopes on every query**

Do not scan globally and filter in the browser. Apply authenticated owner and `visibleTo` in store queries. Claim/heartbeat endpoints are owner-harness-only. Create/install/archive/grant operations are operator-only.

```ts
export function listAuthorizedWorkerRuns(
  store: WorkerRuntimeStore,
  principal: WorkerPrincipal,
  query: WorkerRunQuery,
): WorkerRunProjection[] {
  if (!principal.scopes.includes('worker:read')) throw new WorkerAuthError(403, 'worker:read required');
  return store.listRuns({
    ...query,
    ownerAgent: principal.kind === 'operator' ? query.ownerAgent : principal.ownerAgent,
    visibleTo: principal.subject,
  });
}

export function assertManagementOperation(principal: WorkerPrincipal, operation: WorkerManagementOperation): void {
  const operatorOnly = new Set([
    'create', 'install', 'archive', 'grant:activate', 'grant:revoke',
    'hard-stop:approve', 'hard-stop:register', 'hard-stop:reconcile', 'hard-stop:skip',
    'hard-stop:close', 'hard-stop:replay-test',
    'automation-cutover:record', 'automation-cutover:append', 'automation-cutover:complete',
    'automation-cutover:reconcile', 'automation-cutover:rollback',
  ]);
  if (operatorOnly.has(operation) && principal.kind !== 'operator') throw new WorkerAuthError(403, 'operator required');
  if ((operation === 'claim' || operation === 'heartbeat') && principal.kind !== 'owner-harness') {
    throw new WorkerAuthError(403, 'owner harness required');
  }
}
```

- [ ] **Step 5: Make all Home23 clients use `WorkerManagementClient`**

Jerry/Forrest tools, CLI, scheduler, event router, Agency, Good Life, Live Problems, and dashboard proxy use the same typed client. The dashboard injects an agent-scoped credential and removes browser-supplied identity. Its disk fallback is authenticated, owner-filtered degraded read-only data only.

```ts
export function createWorkerManagementClient(input: {
  baseUrl: URL;
  credentialProvider: WorkerCredentialProvider;
  fetch: typeof fetch;
}): WorkerManagementClient {
  const request = async <T>(path: string, init: RequestInit): Promise<T> => {
    const credential = await input.credentialProvider.issue();
    const response = await input.fetch(new URL(path, input.baseUrl), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    });
    if (!response.ok) throw new WorkerManagementError(response.status, await response.text());
    return response.json() as Promise<T>;
  };
  return {
    enqueueRun: (worker, body) => request(`/api/workers/${encodeURIComponent(worker)}/runs`, { method: 'POST', body: JSON.stringify(stripIdentityFields(body)) }),
    getRequest: (requestId) => request(`/api/workers/requests/${encodeURIComponent(requestId)}`, { method: 'GET' }),
    redirectPursuit: (body) => request('/api/workers/pursuits/redirect', { method: 'POST', body: JSON.stringify(body) }),
    recordHardStopApproval: (requestHash) => request('/api/workers/hard-stops/approvals', { method: 'POST', body: JSON.stringify({ requestHash }) }),
    registerHardStopAuthorization: (document, approvalReceipt) => request('/api/workers/hard-stops', {
      method: 'POST', body: JSON.stringify({ document, approvalReceipt }),
    }),
    revokeHardStopAuthorization: (authorizationHash, reason) => request(`/api/workers/hard-stops/${authorizationHash}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) }),
    getHardStopAuthorization: (authorizationHash) => request(`/api/workers/hard-stops/${authorizationHash}`, { method: 'GET' }),
    reconcileHardStopOperation: (body) => request(`/api/workers/hard-stops/${body.authorizationHash}/operations/${body.operation}/reconcile`, { method: 'POST', body: JSON.stringify(body) }),
    skipHardStopOperation: (body) => request(`/api/workers/hard-stops/${body.authorizationHash}/operations/${body.operation}/skip`, { method: 'POST', body: JSON.stringify(body) }),
    closeHardStopAuthorization: (authorizationHash) => request(`/api/workers/hard-stops/${authorizationHash}/close`, { method: 'POST', body: '{}' }),
    testHardStopReplay: (authorizationHash) => request(`/api/workers/hard-stops/${authorizationHash}/replay-test`, { method: 'POST', body: '{}' }),
    recordAutomationCutover: (body) => request('/api/workers/automation-cutovers', { method: 'POST', body: JSON.stringify(body) }),
    appendAutomationCutoverTransition: (cutoverId, body) => request(`/api/workers/automation-cutovers/${cutoverId}/transitions`, { method: 'POST', body: JSON.stringify(body) }),
    completeAutomationCutover: (cutoverId) => request(`/api/workers/automation-cutovers/${cutoverId}/complete`, { method: 'POST', body: '{}' }),
    reconcileAutomationCutover: (cutoverId, body) => request(`/api/workers/automation-cutovers/${cutoverId}/reconcile`, { method: 'POST', body: JSON.stringify(body) }),
    rollbackAutomationCutover: (cutoverId) => request(`/api/workers/automation-cutovers/${cutoverId}/rollback`, { method: 'POST', body: '{}' }),
  };
}
```

- [ ] **Step 6: Run focused tests — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/connector.test.ts tests/agent/tools/workers.test.ts
node --test tests/engine/dashboard/worker-fallback.test.js
npm run test:contracts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/workers/client.ts src/workers/connector.ts src/home.ts \
  src/agent/tools/workers.ts cli/lib/worker-commands.js cli/home23.js \
  engine/src/dashboard/server.js tests/workers/connector.test.ts \
  tests/agent/tools/workers.test.ts tests/engine/dashboard/worker-fallback.test.js
git commit -m "feat(workers): converge authenticated management clients"
```

---

## Task 11: Dispatch immutable scheduled worker occurrences without stealing Jerry capacity

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 5 occurrence journal, Task 8 capacity-aware dispatcher, Task 9 consequence receipts, and Task 10 management client.
- Produces: immutable `WorkerRunPayload`, `SchedulerDispatchContext`, two-phase idempotent occurrence dispatch, useful/no-change/failed consequence projection, and bounded schedule-adjustment operations.

**Files:**
- Modify: `src/scheduler/cron.ts`
- Modify: `src/types.ts`
- Modify: `src/home.ts`
- Modify: `config/cron-jobs.json.example`
- Create: `tests/scheduler/worker-run.test.ts`
- Modify: `tests/scheduler/cron.test.ts`
- Create: `tests/scheduler/home-scheduler.test.ts`

- [ ] **Step 1: Write failing scheduler-context, occurrence, recovery, and capacity tests**

```ts
test('a due workerRun captures due time before advancing the schedule', async () => {
  await scheduler.tick(now);
  assert.deepEqual(dispatches[0].context, {
    schedulerRunId: dispatches[0].context.schedulerRunId,
    dueAt: expectedDueAt,
    occurrenceKey: `shakedown-resident-cycle:${expectedDueAt}`,
  });
  assert.equal(store.getJob('shakedown-resident-cycle').nextRun > expectedDueAt, true);
});

test('restart between enqueue and schedule advance cannot lose or duplicate an occurrence', async () => {
  await crashAtEachSchedulerCommitBoundary(fixture);
  assert.equal(queue.countByOccurrenceKey(expectedOccurrenceKey), 1);
});

test('worker dispatch uses a separate capacity pool from Jerry turns', async () => {
  occupyAllJerryTurnSlots();
  await scheduler.tick(now);
  assert.equal(workerQueue.countReady(), 1);
});

test('scheduler tracks the canonical receipt and does not call green no-consequence useful', async () => {
  await scheduler.tick(now);
  await deliverReceipt(noChangeWithoutExpectedConsequenceFixture);
  const occurrence = scheduler.getOccurrence(expectedOccurrenceKey);
  assert.equal(occurrence.deliveryStatus, 'delivered');
  assert.equal(occurrence.semanticStatus, 'no_consequence');
  assert.equal(occurrence.useful, false);
});

test('worker timing adjustment preserves trust, collection, strategy, and readback obligations', async () => {
  const accepted = await scheduler.adjustWorkerTiming(validLowRiskShift);
  assert.equal(accepted.receiptId.length > 0, true);
  for (const shift of [disableTrust, skipCollection, removeWeeklyStrategy, dropPostActionReadback, widenBeyondGrant]) {
    await assert.rejects(() => scheduler.adjustWorkerTiming(shift), /mandatory obligation|authority/i);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/scheduler/worker-run.test.ts tests/scheduler/cron.test.ts \
  tests/scheduler/home-scheduler.test.ts
```

Expected: FAIL because immutable occurrence preparation, two-phase recovery, and separate worker capacity are missing.

- [ ] **Step 3: Add the explicit payload and immutable dispatch context**

```ts
export interface WorkerRunPayload {
  kind: 'workerRun';
  worker: string;
  mission?: string;
  missionPath?: string;
  sessionHistory: 'fresh' | 'persistent';
  timeoutSeconds: number;
  idempotencyKeyTemplate?: string;
}

export interface SchedulerDispatchContext {
  schedulerRunId: string;
  dueAt: number;
  occurrenceKey: string;
  pursuitId?: string;
}
```

Change `JobHandler` so `workerRun` handlers receive the immutable context. Capture `dueAt`, derive `schedulerRunId` and `occurrenceKey`, and write an `occurrence_prepared` row in SQLite. Enqueue the request and bind its ID in the same SQLite transaction, then compare-and-set the ignored local scheduler definition's `nextRun` using the occurrence version. On crash, startup completes the missing JSON advance or reuses the unique occurrence/request; it never pretends SQLite and JSON share one transaction.

- [ ] **Step 4: Define overdue and capacity behavior explicitly**

- recover every missed occurrence inside the configured catch-up window, newest first, with a bounded maximum;
- record older occurrences as `schedule_missed_outside_window` instead of silently skipping them;
- use `maxConcurrentWorkerAttempts` independently from `maxConcurrentAgentTurns`;
- leave a queued worker request ready when worker capacity is exhausted; do not advance it to running;
- persist the resolved timezone and due instant with each occurrence.
- track the canonical receipt, verifier result, expected consequence, semantic status, delivery evidence, and pursuit consequence before declaring the occurrence useful.

```ts
export async function recoverDueWorkerOccurrences(
  job: WorkerRunJob,
  now: number,
  options: { catchUpWindowMs: number; maxCatchUp: number },
): Promise<SchedulerOccurrence[]> {
  const due = enumerateDueInstants(job, now)
    .filter((instant) => now - instant <= options.catchUpWindowMs)
    .sort((left, right) => right - left)
    .slice(0, options.maxCatchUp);
  const recovered: SchedulerOccurrence[] = [];
  for (const dueAt of due) {
    recovered.push(await prepareAndEnqueueOccurrence({
      schedulerRunId: randomUUID(),
      dueAt,
      occurrenceKey: `${job.id}:${dueAt}`,
      job,
    }));
  }
  await recordMissedOutsideWindow(job, now, options.catchUpWindowMs);
  return recovered;
}
```

- [ ] **Step 5: Add the tracked portable schedule definitions without mutating local installation state**

Add disabled `America/New_York` jobs with these exact expressions:

- `shakedown-resident-cycle`: `23 */2 * * *` — refresh evidence, choose and complete the best useful campaign step, verify, learn, and record the next move;
- `shakedown-daily-trust`: `47 6 * * *` — verify site, API, audio, analytics, signup/payment/entitlement evidence, jobs, and channel authentication;
- `shakedown-daily-collection`: `0 15 * * *` — run the exact non-audio -> verification -> collection sequence and emit opportunities from receipts;
- `shakedown-weekly-strategy`: `19 8 * * 1` — re-score channels/campaigns, retire weak work, identify missing product value, and set the week's emphasis.

Commit these as disabled portable examples/template inputs only. `config/cron-jobs.json` remains ignored local installation state and is changed only through the authenticated management service in Task 33. Post-action readbacks are durable one-shot jobs created from consequence receipts, not recurring cron rows. Enrichment and distribution occur through resident/event work, not by repurposing the collection job.

```json
[
  {
    "id": "shakedown-resident-cycle",
    "name": "ShakedownJerry resident cycle",
    "enabled": false,
    "queueClass": "background",
    "schedule": { "kind": "cron", "expr": "23 */2 * * *", "tz": "America/New_York" },
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": { "kind": "workerRun", "worker": "shakedown-jerry", "mission": "Refresh evidence, choose and complete the best useful campaign step, verify the consequence, learn from it, and record the next move.", "sessionHistory": "fresh", "timeoutSeconds": 5400, "idempotencyKeyTemplate": "shakedown-resident-cycle:{dueAt}" },
    "delivery": { "mode": "failures" },
    "state": { "nextRunAtMs": 0, "consecutiveErrors": 0 }
  },
  {
    "id": "shakedown-daily-trust",
    "name": "ShakedownJerry daily trust",
    "enabled": false,
    "queueClass": "scheduled",
    "schedule": { "kind": "cron", "expr": "47 6 * * *", "tz": "America/New_York" },
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": { "kind": "workerRun", "worker": "shakedown-jerry", "mission": "Verify site, API, audio, analytics, signup, payment, entitlement, jobs, and channel authentication evidence; record every actual failure or uncertainty.", "sessionHistory": "fresh", "timeoutSeconds": 3600, "idempotencyKeyTemplate": "shakedown-daily-trust:{dueAt}" },
    "delivery": { "mode": "failures" },
    "state": { "nextRunAtMs": 0, "consecutiveErrors": 0 }
  },
  {
    "id": "shakedown-daily-collection",
    "name": "ShakedownJerry daily collection",
    "enabled": false,
    "queueClass": "scheduled",
    "schedule": { "kind": "cron", "expr": "0 15 * * *", "tz": "America/New_York" },
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": { "kind": "workerRun", "worker": "shakedown-jerry", "mission": "Run non-audio daily local, verify non-audio, then run collection daily local in that exact order and emit opportunities only from their receipts.", "sessionHistory": "fresh", "timeoutSeconds": 10800, "idempotencyKeyTemplate": "shakedown-daily-collection:{dueAt}" },
    "delivery": { "mode": "failures" },
    "state": { "nextRunAtMs": 0, "consecutiveErrors": 0 }
  },
  {
    "id": "shakedown-weekly-strategy",
    "name": "ShakedownJerry weekly strategy",
    "enabled": false,
    "queueClass": "background",
    "schedule": { "kind": "cron", "expr": "19 8 * * 1", "tz": "America/New_York" },
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": { "kind": "workerRun", "worker": "shakedown-jerry", "mission": "Re-score channels and campaigns, retire weak work, identify missing product value, and set the week's emphasis with evidence.", "sessionHistory": "fresh", "timeoutSeconds": 7200, "idempotencyKeyTemplate": "shakedown-weekly-strategy:{dueAt}" },
    "delivery": { "mode": "failures" },
    "state": { "nextRunAtMs": 0, "consecutiveErrors": 0 }
  }
]
```

- [ ] **Step 6: Implement bounded worker-authorized timing adjustment**

Add `adjustWorkerTiming({ jobId, expectedVersion, requestedNextRunAt, reasonReceiptId })`. It is available only under the signed scheduling capability, may move a next run only within the grant's configured window, emits a receipt, and cannot disable or rewrite a mission/timezone/cron definition, skip a daily/weekly obligation, or remove a post-action readback.

```ts
export async function adjustWorkerTiming(
  input: AdjustWorkerTimingInput,
  dependencies: SchedulerDependencies,
): Promise<AcceptedScheduleAdjustment> {
  const job = dependencies.store.getJob(input.jobId);
  dependencies.policy.assertCapability('home23.schedule.adjust');
  if (job.version !== input.expectedVersion) throw new Error('schedule version conflict');
  if (!dependencies.policy.withinAdjustmentWindow(job, input.requestedNextRunAt)) throw new Error('requested time outside authority window');
  dependencies.policy.assertMandatoryOccurrencePreserved(job, input.requestedNextRunAt);
  const updated = dependencies.store.compareAndSetNextRun({
    jobId: input.jobId,
    expectedVersion: input.expectedVersion,
    nextRunAt: input.requestedNextRunAt,
  });
  const receipt = dependencies.store.recordScheduleAdjustment({ ...input, updatedVersion: updated.version });
  return { status: 'accepted', receiptId: receipt.receiptId, version: updated.version };
}
```

- [ ] **Step 7: Run focused tests and build — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/scheduler/worker-run.test.ts tests/scheduler/cron.test.ts tests/scheduler/home-scheduler.test.ts
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/cron.ts src/types.ts src/home.ts config/cron-jobs.json.example \
  tests/scheduler/worker-run.test.ts tests/scheduler/cron.test.ts tests/scheduler/home-scheduler.test.ts
git commit -m "feat(workers): dispatch durable scheduled occurrences"
```

---

## Task 12: Route external events through a durable correlated trigger inbox

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 5 trigger/state tables, Task 8 dispatcher, and Task 10 authenticated management boundary.
- Produces: `WorkerTriggerRouter.accept()` and `replay()`, versioned event mappings, correlation/origin metadata, deduplication, debounce/cooldown, and reflexive-loop suppression.

**Files:**
- Create: `src/workers/triggers/types.ts`
- Create: `src/workers/triggers/router.ts`
- Create: `src/workers/triggers/mappings.ts`
- Create: `src/workers/triggers/replay.ts`
- Create: `tests/workers/trigger-router.test.ts`
- Modify: `src/workers/store.ts`
- Modify: `tests/workers/store.test.ts`
- Modify: `src/workers/connector.ts`
- Modify: `src/workers/client.ts`
- Modify: `src/workers/index.ts`

- [ ] **Step 1: Write failing correlation, deduplication, replay, and denial tests**

```ts
test('a verified source receipt creates one correlated worker request', async () => {
  const result = await router.accept(sourceReceiptFixture());
  assert.equal(result.created, true);
  assert.equal(requestStore.get(result.requestId)?.correlationId, sourceReceipt.correlationId);
  assert.equal(requestStore.get(result.requestId)?.causationId, sourceReceipt.receiptId);
});

test('duplicate delivery and replay do not duplicate the worker request', async () => {
  await router.accept(sourceReceiptFixture());
  await router.accept(sourceReceiptFixture());
  await router.replay(sourceReceipt.receiptId);
  assert.equal(requestStore.countBySourceReceipt(sourceReceipt.receiptId), 1);
});

test('unmapped, invalid, or untrusted events are durably denied', async () => {
  const result = await router.accept(untrustedEventFixture());
  assert.equal(result.status, 'denied');
  assert.equal(requestStore.count(), 0);
});

test('origin worker/run/action plus correlation/causation suppress reflexive loops', async () => {
  const result = await router.accept(workerReadingOwnPublicationFixture);
  assert.equal(result.status, 'suppressed_reflexive_loop');
  assert.equal(requestStore.count(), 0);
});

test('debounce and cooldown survive restart without losing the newest meaningful event', async () => {
  await router.accept(trafficChangeFixture('event-1'));
  await router.accept(trafficChangeFixture('event-2'));
  await restartRouter();
  await advanceToDebounceBoundary();
  assert.equal(requestStore.count(), 1);
  assert.equal(requestStore.latest().eventId, 'event-2');
  assert.equal((await router.accept(trafficChangeFixture('event-3'))).status, 'cooldown_active');
});

test('every initial Shakedown event class resolves to one versioned mapping', () => {
  assert.deepEqual(mappedEventClasses().sort(), [
    'anniversary-or-editorial-opportunity', 'collection-release-or-new-show',
    'meaningful-campaign-change', 'meaningful-conversion-change', 'meaningful-listening-change',
    'meaningful-traffic-change', 'owned-site-publication', 'payment-failure', 'playback-failure',
    'route-failure', 'service-health-failure', 'show-enrichment-ready-or-promoted',
    'signup-failure', 'substack-publication', 'entitlement-failure',
  ].sort());
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/trigger-router.test.ts
```

Expected: FAIL because `WorkerTriggerRouter`, durable mapping/deduplication state, and replay are not implemented.

- [ ] **Step 3: Implement one canonical event-to-request router**

Validate a signed or locally authenticated source envelope, normalize it, store it in the Task 5 `trigger_inbox`, resolve an allowlisted mapping, and transactionally create a worker request with source, origin worker/run/action, correlation, causation, pursuit, job, and occurrence identifiers. Put a unique constraint on source receipt plus mapping version and test its migration/restart behavior in `tests/workers/store.test.ts`.

```ts
export interface VerifiedTriggerEvent {
  eventId: string;
  eventClass: ShakedownEventClass;
  sourceReceiptId: string;
  authenticatedSourceRef: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  originWorker?: string;
  originRunId?: string;
  originActionId?: string;
  occurrenceKey?: string;
  pursuitId?: string;
  payloadSha256: string;
}

export interface TriggerAcceptResult {
  status: 'accepted' | 'reused' | 'denied' | 'suppressed_reflexive_loop' | 'cooldown_active';
  created: boolean;
  requestId?: string;
}

export class WorkerTriggerRouter {
  constructor(
    private readonly store: WorkerRuntimeStore,
    private readonly dispatcher: WorkerDispatcher,
    private readonly sourceVerifier: WorkerTriggerSourceVerifier,
    private readonly clock: () => Date,
  ) {}

  async accept(input: SignedWorkerEvent): Promise<TriggerAcceptResult> {
    const event = await this.sourceVerifier.verify(input);
    const mapping = resolveTriggerMapping(event.eventClass);
    if (!mapping) return this.store.denyTrigger(event, 'unmapped_event_class');
    return this.store.acceptMappedTrigger(event, mapping, this.clock(), (envelope) =>
      this.dispatcher.enqueue(envelope));
  }

  async replay(sourceReceiptId: string): Promise<TriggerAcceptResult> {
    const immutable = this.store.getImmutableTriggerSource(sourceReceiptId);
    if (!immutable) throw new Error(`Unknown source receipt: ${sourceReceiptId}`);
    return this.accept(immutable.signedEnvelope);
  }
}
```

- [ ] **Step 4: Support only typed trigger mappings**

Start with mappings for scheduler occurrences, Agency next actions, Good Life violations, Live Problems remediation outcomes, collection release/new-show receipts, enrichment readiness/promotion, owned-site/Substack publication, route/playback/signup/payment/entitlement/service failures, meaningful traffic/listening/conversion/campaign changes, configured anniversary/editorial opportunities, campaign readback due events, and operator requests. A mapping selects a manifest-declared mission and priority; it never embeds arbitrary prompt text or invokes a capability directly.

```ts
export const SHAKEDOWN_TRIGGER_MAPPINGS: Readonly<Record<ShakedownEventClass, TriggerMapping>> = Object.freeze({
  'anniversary-or-editorial-opportunity': { version: 1, mission: 'discover', priority: 45 },
  'collection-release-or-new-show': { version: 1, mission: 'collection-readback', priority: 65 },
  'meaningful-campaign-change': { version: 1, mission: 'campaign-readback', priority: 55 },
  'meaningful-conversion-change': { version: 1, mission: 'funnel-readback', priority: 75 },
  'meaningful-listening-change': { version: 1, mission: 'listener-readback', priority: 50 },
  'meaningful-traffic-change': { version: 1, mission: 'traffic-readback', priority: 50 },
  'owned-site-publication': { version: 1, mission: 'publication-readback', priority: 65 },
  'payment-failure': { version: 1, mission: 'funnel-repair', priority: 95 },
  'playback-failure': { version: 1, mission: 'playback-repair', priority: 90 },
  'route-failure': { version: 1, mission: 'route-repair', priority: 90 },
  'service-health-failure': { version: 1, mission: 'runtime-recovery', priority: 95 },
  'show-enrichment-ready-or-promoted': { version: 1, mission: 'enrichment-readback', priority: 60 },
  'signup-failure': { version: 1, mission: 'funnel-repair', priority: 95 },
  'substack-publication': { version: 1, mission: 'distribution-readback', priority: 60 },
  'entitlement-failure': { version: 1, mission: 'funnel-repair', priority: 100 },
});
```

- [ ] **Step 5: Enforce durable debounce, cooldown, and reflexive-loop suppression**

Persist origin worker/run/action, correlation, causation, source cursor, debounce key/deadline, cooldown key/deadline, selected event, and mapping version. Prefer the newest meaningful event within a debounce window, preserve it across restart, and reject any event derived from the same worker action/causal chain unless the mapping explicitly names a bounded verifier follow-up.

```sql
CREATE UNIQUE INDEX trigger_inbox_source_mapping_uq
  ON trigger_inbox(source_receipt_id, mapping_version);
CREATE INDEX trigger_inbox_debounce_due_idx
  ON trigger_inbox(debounce_key, debounce_deadline)
  WHERE terminal_status IS NULL;
CREATE TABLE trigger_cooldowns (
  cooldown_key TEXT PRIMARY KEY NOT NULL,
  source_event_id TEXT NOT NULL,
  cooldown_deadline TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

```ts
function isReflexive(event: VerifiedTriggerEvent, mapping: TriggerMapping): boolean {
  if (mapping.allowVerifierFollowUp !== true) {
    return event.originWorker === 'shakedown-jerry'
      && Boolean(event.originActionId)
      && event.correlationId === event.causationId;
  }
  return false;
}
```

- [ ] **Step 6: Implement operator-visible replay**

Replay re-validates the original immutable source, uses the same idempotency identity, and records whether it reused, repaired, or denied the existing request. It cannot alter the original event or bypass a revoked grant.

```ts
const replayIdentity = (event: VerifiedTriggerEvent, mapping: TriggerMapping): string =>
  `trigger:${event.sourceReceiptId}:mapping:${mapping.version}`;

const replay = await router.replay(sourceReceiptId);
assert.equal(replay.requestId, original.requestId);
assert.equal(store.getRequest(original.requestId).idempotencyKey,
  replayIdentity(sourceEvent, resolveTriggerMapping(sourceEvent.eventClass)!));
assert.equal(store.getActiveGrant(originalGrantHash)?.status, 'revoked');
assert.equal((await router.replay(revokedSourceReceiptId)).status, 'denied');
```

- [ ] **Step 7: Run focused tests and build — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 tests/workers/trigger-router.test.ts
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/workers/triggers/types.ts src/workers/triggers/router.ts \
  src/workers/triggers/mappings.ts src/workers/triggers/replay.ts \
  src/workers/store.ts src/workers/connector.ts src/workers/client.ts src/workers/index.ts \
  tests/workers/trigger-router.test.ts \
  tests/workers/store.test.ts
git commit -m "feat(workers): add correlated event triggers"
```

---

## Task 13: Make Agency, Good Life, and Live Problems dispatch executable worker consequences

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 10 management client, Task 12 trigger router, and Task 9 canonical receipts.
- Produces: engine-side authenticated dispatch/trigger clients, active-grant Agency passage to `CapabilityExecutor`, and `recordConsequence()` closure for Agency, Good Life, and Live Problems.

**Files:**
- Create: `engine/src/workers/dispatch-client.js`
- Create: `engine/src/workers/trigger-router.js`
- Create: `tests/engine/workers/dispatch-client.test.js`
- Create: `tests/engine/workers/trigger-router.test.js`
- Modify: `engine/src/agency/authority-policy.js`
- Modify: `engine/src/agency/resident-kernel.js`
- Modify: `engine/src/agency/pursuit-store.js`
- Modify: `engine/src/agency/consequence-engine.js`
- Modify: `engine/src/good-life/regulator.js`
- Modify: `engine/src/live-problems/remediators.js`
- Modify: `engine/src/live-problems/loop.js`
- Modify: `engine/src/live-problems/index.js`
- Modify: `tests/engine/agency/kernel.test.js`
- Create: `tests/engine/agency/authority-policy.test.js`
- Modify: `tests/engine/agency/tick-receipts.test.js`
- Modify: `tests/engine/good-life/regulator.test.js`
- Create: `tests/engine/live-problems/remediators.test.js`
- Create: `tests/engine/live-problems/dispatch-closure.test.js`

- [ ] **Step 1: Write failing logger, dispatch, consequence, and restart tests**

```js
test('kernel supports the installed SimpleLogger contract', async () => {
  const kernel = makeKernel({ logger: { info() {}, warn() {}, error() {} } });
  await assert.doesNotReject(() => kernel.tick());
});

test('an Agency nextAction is durably dispatched and receives a consequence', async () => {
  const tick = await kernel.tick();
  assert.equal(tick.dispatch.status, 'accepted');
  await deliverWorkerReceipt(tick.dispatch.requestId);
  assert.equal(pursuitStore.get(pursuitId).lastConsequence.receiptId, workerReceiptId);
});

test('Good Life and Live Problems share the canonical worker client', async () => {
  await regulator.evaluate(violationFixture());
  await remediationLoop.tick(problemFixture());
  assert.equal(fakeClient.accepted.length, 2);
  assert.equal(directEngineExecutionCount(), 0);
});

test('active exact standing grant removes the obsolete per-action Agency gate only inside scope', async () => {
  assert.equal((await authorityPolicy.route(activeCoveredAgencyAction)).decision, 'dispatch');
  for (const action of [inactiveGrantAction, revokedGrantAction, mismatchedGrantAction]) {
    assert.equal((await authorityPolicy.route(action)).decision, 'require-human-authorization');
  }
  assert.equal((await authorityPolicy.route(hardDeniedAction)).decision, 'deny');
  assert.equal(finalTargetAuthorizationOwner, 'CapabilityExecutor');
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 \
  tests/engine/agency/kernel.test.js \
  tests/engine/agency/authority-policy.test.js \
  tests/engine/agency/tick-receipts.test.js \
  tests/engine/good-life/regulator.test.js \
  tests/engine/live-problems/remediators.test.js \
  tests/engine/live-problems/dispatch-closure.test.js \
  tests/engine/workers/dispatch-client.test.js \
  tests/engine/workers/trigger-router.test.js
```

- [ ] **Step 3: Repair the logger boundary and separate engine bridge from canonical storage**

Use `logger.info` when present and fall back compatibly without assuming `.logger.log`. The CommonJS `dispatch-client` is a transport adapter to the canonical TypeScript management service. The engine-side trigger router validates and forwards; it never becomes a second request store or policy evaluator.

```js
function logInfo(logger, message, fields = {}) {
  if (typeof logger?.info === 'function') return logger.info(message, fields);
  if (typeof logger?.log === 'function') return logger.log(message, fields);
  return undefined;
}

export class WorkerDispatchClient {
  constructor({ managementClient, ownerAgent }) {
    this.managementClient = managementClient;
    this.ownerAgent = ownerAgent;
  }

  enqueue(worker, input) {
    return this.managementClient.enqueueRun(worker, {
      mission: input.mission,
      pursuitId: input.pursuitId,
      eventId: input.eventId,
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }
}
```

- [ ] **Step 4: Dispatch Agency actions and record verified consequences**

After Agency persists `nextAction`, submit it through the authenticated worker client and persist the returned request identifier. Add `recordConsequence()` so terminal canonical worker receipts update the pursuit ledger with outcome, semantic status, artifacts, verifier result, and follow-up. A dispatch failure remains a visible pending/failed consequence and never masquerades as action completion.

```js
export async function dispatchPersistedNextAction({ pursuitStore, dispatchClient, pursuitId, nextAction }) {
  const accepted = await dispatchClient.enqueue(nextAction.worker, {
    mission: nextAction.mission,
    pursuitId,
    correlationId: nextAction.correlationId,
    causationId: nextAction.actionId,
  });
  pursuitStore.linkWorkerRequest(pursuitId, nextAction.actionId, accepted.requestId);
  return { status: 'accepted', requestId: accepted.requestId };
}

export function recordConsequence(pursuitStore, receipt) {
  return pursuitStore.appendConsequence(receipt.pursuitId, {
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    outcome: receipt.status,
    semanticStatus: receipt.semanticStatus,
    verifierStatus: receipt.verifierStatus,
    artifacts: receipt.artifacts.map(({ uri, sha256, role }) => ({ uri, sha256, role })),
    nextEligibleAction: receipt.nextEligibleAction ?? null,
  });
}
```

- [ ] **Step 5: Reconcile Agency authority with the exact standing grant**

Replace the old blanket L3/L4 per-action stop for Worker actions with an authenticated dispatch decision that recognizes only an active exact-hash worker grant and its coarse action class. Inactive/revoked/expired/mismatched scope returns `require-human-authorization`; hard-denied classes return `deny`. Agency never widens targets or becomes the final policy engine: normalized path/host/account/service/data authorization remains exclusively in `CapabilityExecutor` at action time.

```js
export async function routeWorkerAction({ action, grantStore, hardDeniedActionClasses }) {
  if (hardDeniedActionClasses.has(action.actionClass)) {
    return { decision: 'deny', reason: 'repository_hard_deny' };
  }
  const activation = grantStore.getActiveGrant(action.authorityGrantHash);
  if (!activation || activation.status !== 'active' || activation.expiresAt <= new Date().toISOString()) {
    return { decision: 'require-human-authorization', reason: 'inactive_exact_worker_grant' };
  }
  if (!activation.actionClasses.includes(action.actionClass)) {
    return { decision: 'require-human-authorization', reason: 'grant_action_class_mismatch' };
  }
  return { decision: 'dispatch', finalTargetAuthorizationOwner: 'CapabilityExecutor' };
}
```

- [ ] **Step 6: Route Good Life and Live Problems through the same seam**

Convert Good Life corrective suggestions and Live Problems remediator decisions into typed source envelopes. Close a Live Problem only after a verified worker consequence or a deterministic local remediator receipt proves resolution; transport acceptance alone is insufficient.

```js
export function correctiveSuggestionEnvelope(violation) {
  return {
    schema: 'home23.worker-event.v1',
    eventClass: 'service-health-failure',
    eventId: violation.id,
    sourceReceiptId: violation.receiptId,
    correlationId: violation.correlationId,
    causationId: violation.receiptId,
    occurredAt: violation.observedAt,
    payloadSha256: violation.payloadSha256,
  };
}

export function canCloseLiveProblem({ workerReceipt, deterministicReceipt }) {
  return workerReceipt?.verifierStatus === 'passed'
    || deterministicReceipt?.semanticStatus === 'resolved_verified';
}
```

- [ ] **Step 7: Prove restart recovery and idempotence**

Crash after Agency next-action persistence, after dispatch acceptance, and after consequence delivery. Restart must recover each state without a duplicate request or lost pursuit link.

```js
for (const failpoint of ['after_next_action', 'after_dispatch_acceptance', 'after_consequence_delivery']) {
  const fixture = await crashAt(failpoint);
  const recovered = await restartAgency(fixture.root);
  assert.equal(recovered.requestsForAction(fixture.actionId).length, 1);
  assert.equal(recovered.pursuit.workerRequestId, fixture.requestId);
  assert.equal(recovered.pursuit.lastConsequence?.receiptId, fixture.expectedReceiptId);
}
```

- [ ] **Step 8: Run engine tests — expect PASS**

```bash
node --test --test-concurrency=1 \
  tests/engine/agency/kernel.test.js \
  tests/engine/agency/authority-policy.test.js \
  tests/engine/agency/tick-receipts.test.js \
  tests/engine/good-life/regulator.test.js \
  tests/engine/live-problems/remediators.test.js \
  tests/engine/live-problems/dispatch-closure.test.js \
  tests/engine/workers/dispatch-client.test.js \
  tests/engine/workers/trigger-router.test.js
```

- [ ] **Step 9: Commit**

```bash
git add engine/src/workers/dispatch-client.js engine/src/workers/trigger-router.js \
  engine/src/agency/authority-policy.js engine/src/agency/resident-kernel.js \
  engine/src/agency/pursuit-store.js engine/src/agency/consequence-engine.js \
  engine/src/good-life/regulator.js engine/src/live-problems/remediators.js \
  engine/src/live-problems/loop.js engine/src/live-problems/index.js \
  tests/engine/agency/kernel.test.js tests/engine/agency/authority-policy.test.js \
  tests/engine/agency/tick-receipts.test.js tests/engine/good-life/regulator.test.js \
  tests/engine/live-problems/remediators.test.js \
  tests/engine/live-problems/dispatch-closure.test.js \
  tests/engine/workers/dispatch-client.test.js tests/engine/workers/trigger-router.test.js
git commit -m "feat(engine): execute and reconcile worker consequences"
```

---

## Task 14: Give Jerry and the Worker Desk one truthful async control surface

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 9 truthful receipt/state projections and Task 10 canonical management operations.
- Produces: authenticated dashboard proxy routes, Worker Desk views, and Jerry tools for async run, cancel, pursuit redirect, authority, hard-stop, schedule, recovery, and consequence inspection.

**Files:**
- Modify: `engine/src/dashboard/server.js`
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.js`
- Modify: `engine/src/dashboard/home23-dashboard.css`
- Modify: `engine/src/dashboard/home23-settings.html`
- Modify: `engine/src/dashboard/home23-settings.js`
- Modify: `engine/src/dashboard/home23-settings.css`
- Modify: `src/agent/tools/workers.ts`
- Modify: `src/agent/tools/agency.ts`
- Create: `tests/engine/dashboard/worker-desk-api.test.js`
- Create: `tests/engine/dashboard/worker-desk-ui.test.js`
- Modify: `tests/agent/tools/workers.test.ts`

- [ ] **Step 1: Write failing async API, projection, authorization, and Jerry-tool tests**

```js
test('run returns 202 and the UI polls canonical request state', async () => {
  const response = await post('/api/workers/shakedown-jerry/runs', missionFixture());
  assert.equal(response.status, 202);
  assert.match(response.body.statusUrl, /\/api\/workers\/requests\//);
  assert.equal((await get(response.body.statusUrl)).body.requestId, response.body.requestId);
});

test('roster and detail expose truthful current, last, next, health, and authority', async () => {
  const roster = await get('/api/workers');
  assert.deepEqual(keys(roster.body[0]), expectedRosterProjectionKeys);
  assert.equal(roster.body[0].semanticStatus, 'reconciliation_required');
});

test('dangerous controls require exact authenticated authority', async () => {
  for (const route of protectedRoutes) {
    assert.equal((await post(route, unsignedBody)).status, 403);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 \
  tests/engine/dashboard/worker-desk-api.test.js \
  tests/engine/dashboard/worker-desk-ui.test.js
node --import tsx --test --test-concurrency=1 tests/agent/tools/workers.test.ts
```

- [ ] **Step 3: Proxy the canonical management API; do not duplicate runtime truth**

Implement authenticated routes for roster, worker detail, request/run/attempt detail, artifacts, receipts, health, authority, schedules, pursuit focus/redirect, and actions. `run`, `stop`, `retry`, pursuit redirect, artifact promotion, rollback, revoke, and hard-stop authorization return `202` with a canonical `/api/workers/requests/:requestId` status URL and are observed by polling or server events.

```js
function workerStatusUrl(requestId) {
  return `/api/workers/requests/${encodeURIComponent(requestId)}`;
}

app.post('/api/workers/:worker/runs', requireDashboardAgent, async (req, res) => {
  const accepted = await workerManagementClient.enqueueRun(req.params.worker, req.body);
  res.status(202).json({
    requestId: accepted.requestId,
    statusUrl: workerStatusUrl(accepted.requestId),
  });
});

app.get('/api/workers/requests/:requestId', requireDashboardAgent, async (req, res) => {
  res.json(await workerManagementClient.getRequest(req.params.requestId));
});
```

- [ ] **Step 4: Build the Worker Desk and Shakedown card**

Show authority state, manifest/profile/grant hashes, last/current/next work, queue depth, semantic status, health, active pursuit, budgets, recent consequences, one-shot readbacks, and rollback readiness. The Shakedown card separates observe, content, site, code, collection, enrichment, distribution, conversion, and recovery lanes instead of flattening them into one green badge.

```js
const SHAKEDOWN_LANES = Object.freeze([
  'observe', 'content', 'site', 'code', 'collection',
  'enrichment', 'distribution', 'conversion', 'recovery',
]);

export function renderShakedownCard(worker) {
  return `<section class="worker-card" data-worker="shakedown-jerry">
    <h2>ShakedownJerry</h2>
    <dl><dt>Authority</dt><dd>${escapeHtml(worker.authority.status)}</dd>
      <dt>Semantic status</dt><dd>${escapeHtml(worker.semanticStatus)}</dd>
      <dt>Queue</dt><dd>${Number(worker.queueDepth)}</dd></dl>
    <div class="worker-lanes">${SHAKEDOWN_LANES.map((lane) =>
      `<article data-lane="${lane}">${renderLane(worker.lanes[lane])}</article>`).join('')}</div>
  </section>`;
}
```

- [ ] **Step 5: Make Jerry the conversational front door**

The existing worker and Agency tools translate natural requests into the same management service calls. Jerry can explain what ShakedownJerry is doing, why, under what authority, what changed, what was learned, what failed, and what can be rolled back. Tool responses return request identifiers immediately and retrieve canonical results; they never wait inside the Jerry turn for a long worker run.

```ts
export async function runWorkerTool(
  client: WorkerManagementClient,
  input: { worker: string; mission: string; pursuitId?: string },
): Promise<{ requestId: string; statusUrl: string }> {
  const accepted = await client.enqueueRun(input.worker, {
    mission: input.mission,
    pursuitId: input.pursuitId,
  });
  return {
    requestId: accepted.requestId,
    statusUrl: `/api/workers/requests/${encodeURIComponent(accepted.requestId)}`,
  };
}
```

- [ ] **Step 6: Add accessible failure and mobile states**

Render explicit queued/running/verification/rollback/reconciliation/denied/cancelled states; retain the last known truth during transient API failures; make controls keyboard usable and require typed confirmation only for the separate hard-stop flows.

```js
const TERMINAL_LABELS = Object.freeze({
  queued: 'Queued', running: 'Running', verifying: 'Verifying',
  rolled_back: 'Rolled back', reconciliation_required: 'Needs reconciliation',
  denied: 'Denied', cancelled: 'Cancelled',
});

async function refreshWorkerDesk() {
  try {
    const projection = await workerDeskApi.list();
    localStorage.setItem('home23.worker-desk.last-known', JSON.stringify(projection));
    renderWorkerDesk(projection, { degraded: false });
  } catch {
    const cached = JSON.parse(localStorage.getItem('home23.worker-desk.last-known') || '[]');
    renderWorkerDesk(cached, { degraded: true });
  }
}
```

- [ ] **Step 7: Run focused tests and both builds — expect PASS**

```bash
node --test --test-concurrency=1 \
  tests/engine/dashboard/worker-desk-api.test.js tests/engine/dashboard/worker-desk-ui.test.js
node --import tsx --test --test-concurrency=1 tests/agent/tools/workers.test.ts
npm run build
npm --prefix engine test
```

- [ ] **Step 8: Commit**

```bash
git add engine/src/dashboard/server.js engine/src/dashboard/home23-dashboard.html \
  engine/src/dashboard/home23-dashboard.js engine/src/dashboard/home23-dashboard.css \
  engine/src/dashboard/home23-settings.html engine/src/dashboard/home23-settings.js \
  engine/src/dashboard/home23-settings.css src/agent/tools/workers.ts src/agent/tools/agency.ts \
  tests/engine/dashboard/worker-desk-api.test.js \
  tests/engine/dashboard/worker-desk-ui.test.js tests/agent/tools/workers.test.ts
git commit -m "feat(dashboard): expose the canonical Worker Desk"
```

---

## Task 15: Migrate every existing worker and lock generic runtime compatibility

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Tasks 2–14 v2 runtime, compatibility decoder, management surface, and recovery model.
- Produces: migrated built-in and installed worker manifests, per-instance migration/recovery receipts, and a regression lock proving all legacy Worker families use the repaired generic runtime.

**Files:**
- Modify: `config/workers.json`
- Modify: `cli/templates/workers/freshness/worker.yaml`
- Modify: `cli/templates/workers/memory/worker.yaml`
- Modify: `cli/templates/workers/parity/worker.yaml`
- Modify: `cli/templates/workers/release/worker.yaml`
- Modify: `cli/templates/workers/feeder/worker.yaml`
- Modify: `cli/templates/workers/systems/worker.yaml`
- Create: `tests/workers/existing-workers-v2.test.ts`
- Create: `tests/workers/concurrency.test.ts`
- Create: `tests/workers/installed-worker-migration.test.ts`
- Modify: `tests/workers/registry.test.ts`
- Modify: `tests/workers/scaffold.test.ts`
- Modify: `tests/workers/connector.test.ts`
- Modify: `tests/workers/runner.test.ts`
- Modify: `tests/workers/receipts.test.ts`
- Modify: `tests/agent/tools/workers.test.ts`
- Modify: `tests/agent/context-worker-runs.test.ts`
- Modify: `tests/agent/turn-entrypoint-callers.test.ts`
- Modify: `tests/scheduler/cron.test.ts`

- [ ] **Step 1: Capture the existing-worker fixture matrix and write failing parity tests**

For systems, freshness, memory, parity, release, and feeder, assert identity, prompt, workspace, allowed tools, denied tools, limits, provider/model, history policy, receipt shape, cancellation, and v1-read compatibility. Add a test that runs two Jerry-owned workers concurrently while a third contends for one shared resource lock.

```ts
test('installed manifest migration is idempotent and preserves worker-owned state', async () => {
  const before = await fingerprintInstalledWorkerFixture();
  const first = await migrateInstalledWorkers(fixtureRoot);
  const second = await migrateInstalledWorkers(fixtureRoot);
  assert.equal(first.every((row) => row.recoveryCopyHash), true);
  assert.equal(second.changed.length, 0);
  assert.deepEqual(await nonManifestFingerprint(fixtureRoot), before.nonManifest);
});
```

- [ ] **Step 2: Run the focused generic suite — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/*.test.ts \
  tests/agent/tools/workers.test.ts \
  tests/agent/context-worker-runs.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  tests/scheduler/cron.test.ts
```

- [ ] **Step 3: Migrate manifests without widening authority**

Convert every existing worker to strict v2 fields while preserving its actual prior workspace, prompt, tool grants, limits, history, and provider/model semantics. Resolve any implicit legacy default into an explicit least-privilege value. Keep v1 parsing only as an input compatibility path; all newly written manifests and receipts are v2.

```yaml
schema: home23.worker.v2
name: systems
ownerAgent: primary
capabilities:
  - home23.observe
  - home23.verify
hardStopCapabilities: []
paths:
  workspaceRoots:
    - workspace
  liveWebroot: []
limits:
  maxConcurrentRuns: 1
  maxTokens: 120000
  timeoutSeconds: 2700
history: fresh
```

The snippet highlights the migrated values; every installed document also contains all other Task 2 required v2 keys (`kind`, display/class/purpose, provider/model, strict `context`, `authorityGrant`, complete typed `paths`, `safetyReserve`, `retry`, `feedsBrains`, and `visibleTo`) and passes `parseWorkerManifest()` before write. Apply the same explicit field set to `freshness`, `memory`, `parity`, `release`, and `feeder`, retaining each template's existing token/runtime ceiling, setting `hardStopCapabilities: []`, and translating only capabilities allowed by Task 2's `LEGACY_TOOL_CAPABILITIES` map.

- [ ] **Step 4: Prove real isolation and shared-lock behavior**

Run at least one harmless real mission for each existing worker. Run two workers simultaneously and verify distinct attempts, histories, budgets, workspaces, and receipts. Force both to request the same named lock and prove only one adapter enters the protected critical section.

```bash
for worker in systems freshness memory parity release feeder; do
  node cli/home23.js worker run "$worker" --mission verify-profile --dry-run
done
node --import tsx --test --test-concurrency=1 \
  tests/workers/existing-workers-v2.test.ts \
  tests/workers/concurrency.test.ts
```

- [ ] **Step 5: Rehearse all six installed-manifest migrations on capture-restored copies**

Restore exact captured copies of the real ignored `instances/workers/*/worker.yaml` trees for systems, freshness, memory, parity, release, and feeder beneath a temporary root. Use the tested CLI only on those copies. Before each write, create a content-addressed mode-`0600` recovery copy; after each write, re-read/validate the effective profile and prove every non-manifest worker file is unchanged. Run migration twice and require the second pass to report no changes. Hash the canonical installed trees before/after and require equality. Task 29 performs the real migration only after the v1-compatible new runtime is live, under the code+state+manifest deployment journal.

```bash
canonical_runtime_root=/Users/jtr/_JTR23_/release/home23/instances/workers
runtime_root=$(mktemp -d /tmp/home23-installed-worker-migration.XXXXXXXX)
recovery_root=/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/installed-worker-migrations
mkdir -p "$recovery_root"
chmod 0700 "$recovery_root"
node --import tsx scripts/restore-worker-migration-fixtures.mts \
  --capture-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --output-root "$runtime_root" --workers systems,freshness,memory,parity,release,feeder
canonical_before=$(node --import tsx scripts/restore-worker-migration-fixtures.mts \
  --hash-only --runtime-root "$canonical_runtime_root" \
  --workers systems,freshness,memory,parity,release,feeder)
for worker in systems freshness memory parity release feeder; do
  node cli/home23.js worker migrate "$worker" \
    --runtime-root "$runtime_root" \
    --recovery-root "$recovery_root" \
    --format v2
  node cli/home23.js worker validate "$worker" --runtime-root "$runtime_root"
done
for worker in systems freshness memory parity release feeder; do
  node cli/home23.js worker migrate "$worker" \
    --runtime-root "$runtime_root" \
    --recovery-root "$recovery_root" \
    --format v2 --expect-no-change
done
canonical_after=$(node --import tsx scripts/restore-worker-migration-fixtures.mts \
  --hash-only --runtime-root "$canonical_runtime_root" \
  --workers systems,freshness,memory,parity,release,feeder)
test "$canonical_before" = "$canonical_after"
```

- [ ] **Step 6: Run all Worker, agent-call-entrypoint, scheduler, engine bridge, contract, and build gates — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/*.test.ts \
  tests/agent/tools/workers.test.ts \
  tests/agent/context-worker-runs.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts \
  tests/scheduler/cron.test.ts
node --test --test-concurrency=1 tests/engine/workers/*.test.js
npm run test:contracts
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add config/workers.json \
  cli/templates/workers/systems/worker.yaml cli/templates/workers/freshness/worker.yaml \
  cli/templates/workers/memory/worker.yaml cli/templates/workers/parity/worker.yaml \
  cli/templates/workers/release/worker.yaml cli/templates/workers/feeder/worker.yaml \
  tests/workers/existing-workers-v2.test.ts tests/workers/concurrency.test.ts \
  tests/workers/installed-worker-migration.test.ts \
  tests/workers/registry.test.ts tests/workers/scaffold.test.ts \
  tests/workers/connector.test.ts tests/workers/runner.test.ts tests/workers/receipts.test.ts \
  tests/agent/tools/workers.test.ts tests/agent/context-worker-runs.test.ts \
  tests/agent/turn-entrypoint-callers.test.ts tests/scheduler/cron.test.ts
git commit -m "refactor(workers): migrate existing workers to v2"
```

---

## Task 16: Bootstrap the independent Shakedown source clone and reconcile production-ahead source

**Working directory:** Orchestrate from `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`; address `/Users/jtr/websites/shakedownshuffle.com` and the worker clone only through absolute paths or `git -C`.

**Interfaces:**
- Consumes: Task 1 preservation manifests/restoration functions, committed Shakedown baseline `2f0c8323ab1e1846360b070904f39181da8fe834`, acquisition hardening commit `4f0dbb9`, and the observed live artifact.
- Produces: independent full Shakedown clone, hash-admitted local-only source/config import, reconciled canonical source baseline, and an invariant proving the operator checkout was untouched.

**Files:**
- Create: `scripts/bootstrap-shakedown-worker-clone.mjs`
- Create: `tests/scripts/bootstrap-shakedown-worker-clone.test.mjs`
- Create at runtime: `instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/`
- Create at runtime: `instances/workers/shakedown-jerry/state/source-baseline.json`
- Create at runtime: `instances/workers/shakedown-jerry/state/operator-checkout-invariant.json`
- Create at runtime: `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/source-import-paths.txt`
- Create at runtime: `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/analytics-reconciliation-paths.txt`

- [ ] **Step 1: Write failing source-selection and operator-checkout invariance tests**

```js
test('bootstrap selects the source containing the acquisition hardening patch', async () => {
  const result = await bootstrap(fixture);
  assert.equal(result.reconciledPatchIds.includes(acquisitionPatchId), true);
  assert.equal(result.analyticsContractTestsPassed, true);
});

test('bootstrap and integration leave the operator checkout byte-for-byte unchanged', async () => {
  const before = await captureOperatorCheckoutInvariant(operatorRoot);
  await bootstrap(fixture);
  const after = await captureOperatorCheckoutInvariant(operatorRoot);
  assert.deepEqual(after, before);
});

test('the worker clone never builds into the shared dist directory', async () => {
  await assert.rejects(() => bootstrap(sharedDistFixture), /shared public dist/i);
});

test('approved local-only source is imported by capture hash while secrets and generated output are rejected', async () => {
  const result = await bootstrap(localOnlyCaptureFixture);
  assert.deepEqual(result.importedPaths.sort(), expectedApprovedLocalOnlyPaths.sort());
  assert.equal(result.importedPaths.includes('ops/shakedown-watchdog/lib/watchdog-core.mjs'), true);
  assert.equal(result.importedPaths.some(isSecretGeneratedReceiptScreenshotOrRawData), false);
  assert.equal(result.importManifest.every((row) => row.captureHash && row.currentStateStatus), true);
});

test('hash-only mode is read-only and fingerprints clone HEAD, index, tracked, and untracked state', async () => {
  const before = await captureCloneInvariant(workerClone);
  const first = await bootstrapCli(['--hash-only', '--clone', workerClone]);
  const second = await bootstrapCli(['--hash-only', '--clone', workerClone]);
  assert.match(first.stdout.trim(), /^[a-f0-9]{64}$/);
  assert.equal(second.stdout.trim(), first.stdout.trim());
  assert.deepEqual(await captureCloneInvariant(workerClone), before);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 tests/scripts/bootstrap-shakedown-worker-clone.test.mjs
```

Expected: FAIL because the clone bootstrap, exact path admission, reconciliation, and checkout-invariant implementation do not exist.

- [ ] **Step 3: Capture the live source inventory before cloning**

Record, hash, and retain:

- active checkout branch, HEAD, status porcelain v2, index tree, configured worktrees, remotes, and submodules;
- clean acquisition/billing-hardening worktree HEAD and patch identity for commit `4f0dbb9`;
- live `html` asset manifest and acquisition-analytics symbols absent from active source;
- `v2.shakedownshuffle.com` serving relationship to `shakedown-v2/dist`;
- `html/pro`, `html/env-config.js`, and all live-only entries.

Abort on an unresolved baseline or a changed operator checkout.

```bash
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --capture-inventory \
  --operator-root /Users/jtr/websites/shakedownshuffle.com \
  --acquisition-commit 4f0dbb9 \
  --live-root /Users/jtr/websites/shakedownshuffle.com/html \
  --state-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/state
```

- [ ] **Step 4: Create a full independent clone and dedicated branch**

Clone the repository metadata and objects into the worker workspace, fetch only configured trusted local/remote refs, create a branch under `codex/shakedown-worker/`, and prohibit alternate worktree paths. The clone owns its index, build caches, dependencies, and output roots. The script's read-only `--hash-only --clone <path>` mode emits one canonical SHA-256 over clone HEAD, index tree, tracked worktree bytes/modes, and sorted untracked path/content hashes while excluding only declared build/dependency caches; it performs no fetch, checkout, write, or metadata mutation and is used by Task 29 to prove installation preservation.

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
test ! -e "$clone_root"
git clone --no-hardlinks /Users/jtr/websites/shakedownshuffle.com "$clone_root"
git -C "$clone_root" config remote.origin.pushurl no-push://shakedown-worker
git -C "$clone_root" switch --create codex/shakedown-worker/runtime-v1 \
  2f0c8323ab1e1846360b070904f39181da8fe834
test "$(git -C "$clone_root" rev-parse --git-dir)" = "$clone_root/.git"
```

- [ ] **Step 5: Import the approved local-only preservation set by content hash**

Read `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json`, resolve the immutable Task 1 Shakedown capture it names, re-run the content secret/generated-output scan, and classify every candidate path as required source, non-secret config, test/fixture, historical-only, generated/private, or rejected. Materialize only approved required source/config/tests into the independent clone; verify every hash; preserve original path/provenance/current-state status; and commit the admitted set before adapter work. This must include the current local-only watchdog core/wrapper, show-enrichment source, checkout/Stripe/pending-activation services, publishing pipeline, Substack adapters, funnel/communications readers, and relevant tests. Preserve non-secret dynamic-DNS config for provenance only; never import its executor into standing authority.

The bootstrap script must write this exact sorted newline-delimited admitted list atomically to mode `0600` at `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/source-import-paths.txt` and reject any capture manifest that lacks a listed path/hash:

```text
jerry-api/bun.lock
jerry-api/package.json
jerry-api/show-enrichment/scripts/build-archive-bill-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-audio-footprint-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-baseline.ts
jerry-api/show-enrichment/scripts/build-chronology-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-curation-run-packets.ts
jerry-api/show-enrichment/scripts/build-forum-context-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-lineup-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-official-fact-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-setlist-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-short-appearance-curation-receipts.ts
jerry-api/show-enrichment/scripts/build-show-color-notes.ts
jerry-api/show-enrichment/scripts/crawl-archive.ts
jerry-api/show-enrichment/scripts/crawl-cosmo-research.ts
jerry-api/show-enrichment/scripts/crawl-forum-fansite.ts
jerry-api/show-enrichment/scripts/crawl-official.ts
jerry-api/show-enrichment/scripts/import-curation-receipts.ts
jerry-api/src/database/shows.repository.ts
jerry-api/src/middleware/auth.middleware.ts
jerry-api/src/routes/billing.routes.ts
jerry-api/src/routes/listener.routes.ts
jerry-api/src/routes/shows.routes.ts
jerry-api/src/routes/user.routes.ts
jerry-api/src/routes/webhooks.routes.ts
jerry-api/src/server.ts
jerry-api/src/services/checkoutSecurity.service.ts
jerry-api/src/services/checkoutStatus.service.ts
jerry-api/src/services/pendingActivation.service.ts
jerry-api/src/services/stripe.service.ts
jerry-api/src/services/stripeEntitlement.service.ts
jerry-api/src/services/stripeWebhook.service.ts
jerry-api/src/types/show.types.ts
jerry-api/tests/show-enrichment-archive-bill-curation.test.ts
jerry-api/tests/show-enrichment-archive-crawl.test.ts
jerry-api/tests/show-enrichment-audio-footprint-curation.test.ts
jerry-api/tests/show-enrichment-baseline.test.ts
jerry-api/tests/show-enrichment-chronology-curation.test.ts
jerry-api/tests/show-enrichment-color-notes.test.ts
jerry-api/tests/show-enrichment-cosmo-research.test.ts
jerry-api/tests/show-enrichment-curation-packets.test.ts
jerry-api/tests/show-enrichment-curation-receipts.test.ts
jerry-api/tests/show-enrichment-forum-context-curation.test.ts
jerry-api/tests/show-enrichment-forum-fansite.test.ts
jerry-api/tests/show-enrichment-lineup-curation.test.ts
jerry-api/tests/show-enrichment-official-crawl.test.ts
jerry-api/tests/show-enrichment-official-fact-curation.test.ts
jerry-api/tests/show-enrichment-setlist-curation.test.ts
jerry-api/tests/show-enrichment-short-appearance-curation.test.ts
jerry-api/tests/shows-repository-enrichment.test.ts
jerry-api/tests/stripe-entitlement.test.ts
ops/shakedown-watchdog/README.md
ops/shakedown-watchdog/check-shakedown-health.mjs
ops/shakedown-watchdog/com.jtr.shakedown-watchdog.example.plist
ops/shakedown-watchdog/lib/watchdog-core.mjs
ops/shakedown-watchdog/test/watchdog-core.test.mjs
shakedown-v2/package-lock.json
shakedown-v2/package.json
shakedown-v2/scripts/operator-check.mjs
shakedown-v2/scripts/shakedown-publish-pipeline.mjs
shakedown-v2/scripts/subscriber-communications-candidates.mjs
shakedown-v2/scripts/subscriber-communications-readback.mjs
shakedown-v2/scripts/subscriber-funnel-readback.mjs
shakedown-v2/scripts/substack-browser-adapter.mjs
shakedown-v2/scripts/substack-local-adapter.mjs
shakedown-v2/scripts/substack-safari-preflight.mjs
shakedown-v2/src/services/api.js
shakedown-v2/test/newsletter-generator.test.mjs
shakedown-v2/test/shakedown-publish-pipeline.test.mjs
shakedown-v2/test/subscriber-communications-candidates.test.mjs
shakedown-v2/test/subscriber-communications-readback.test.mjs
shakedown-v2/test/subscriber-funnel-readback.test.mjs
shakedown-v2/test/substack-browser-adapter.test.mjs
shakedown-v2/test/substack-local-adapter.test.mjs
shakedown-v2/test/substack-safari-preflight.test.mjs
```

```js
await writeMode0600Atomic(
  '/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/source-import-paths.txt',
  `${approvedSourcePaths.slice().sort().join('\n')}\n`,
);
await importCapturedPathsByHash({
  captureManifest,
  destinationRoot: cloneRoot,
  exactPaths: approvedSourcePaths,
  rejectedClasses: ['secret', 'generated', 'receipt', 'screenshot', 'raw-data', 'cache'],
});
```

```bash
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --import-captured-source \
  --capture-index /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --captured-repository /Users/jtr/websites/shakedownshuffle.com \
  --clone /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  --pathspec-output /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/source-import-paths.txt \
  --deny-secrets --deny-pii --deny-generated --deny-raw-data --no-commit
```

Record only the hashes and provenance classification of `ops/dynamic-dns/README.md`, `ops/dynamic-dns/com.jtr.dynamic-dns.example.plist`, and `ops/dynamic-dns/managed-records.example.json` in `source-baseline.json`; do not materialize `update-godaddy-dns.mjs`, `lib/dynamic-dns-core.mjs`, or live `managed-records.json` into the admitted commit.

- [ ] **Step 6: Reconcile commit `4f0dbb9` by ancestry and patch identity**

Prove whether the patch is an ancestor, patch-equivalent, or missing. Import only missing changes and resolve them against the clone's selected canonical baseline. Require `src/services/analytics.js`, `src/components/AnalyticsRouteTracker.jsx`, Auth/Audio/Browse/Show/Subscribe/start/newsletter call sites, and `test/analytics.test.mjs` to be present and green. Do not copy minified live assets back into source.

Write this exact sorted reconciliation list to mode `0600` at `/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/analytics-reconciliation-paths.txt`:

```text
shakedown-v2/public/start/index.html
shakedown-v2/scripts/build-newsletter-pages.mjs
shakedown-v2/src/components/AnalyticsRouteTracker.jsx
shakedown-v2/src/context/AudioContext.jsx
shakedown-v2/src/context/AuthContext.jsx
shakedown-v2/src/main.jsx
shakedown-v2/src/pages/BrowsePage.jsx
shakedown-v2/src/pages/ShowPage.jsx
shakedown-v2/src/pages/SubscribePage.jsx
shakedown-v2/src/services/analytics.js
shakedown-v2/test/analytics.test.mjs
```

```bash
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --reconcile-commit 4f0dbb9 \
  --clone /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  --pathspec-file /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/analytics-reconciliation-paths.txt \
  --no-commit
```

- [ ] **Step 7: Write baseline and invariance receipts**

The source baseline records selected commit, imported patch IDs, reconciliation decisions, dependency locks, live drift inventory, and exact operator-checkout invariant. Every later integration rechecks the same invariant before and after touching the dedicated ref.

```js
await writeJsonAtomic(sourceBaselinePath, {
  schema: 'home23.shakedown-source-baseline.v1',
  selectedCommit: await revParse(cloneRoot, 'HEAD'),
  acquisitionCommit: '4f0dbb9',
  acquisitionPatchId: await stablePatchId(operatorRoot, '4f0dbb9^', '4f0dbb9'),
  importedPaths: await hashExactPaths(cloneRoot, approvedSourcePaths),
  dependencyLocks: await hashExactPaths(cloneRoot, ['shakedown-v2/package-lock.json', 'jerry-api/bun.lock']),
  liveDriftManifestSha256: sha256(canonicalJson(liveDriftInventory)),
  operatorCheckoutInvariantSha256: sha256(canonicalJson(operatorInvariant)),
});
```

- [ ] **Step 8: Run clone tests and source gates — expect PASS**

```bash
node --test --test-concurrency=1 tests/scripts/bootstrap-shakedown-worker-clone.test.mjs
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/shakedown-v2 && npm ci)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/shakedown-v2 && node --test --test-concurrency=1 test/*.test.mjs)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/shakedown-v2 && npm run lint)
mkdir -p /Users/jtr/_JTR23_/worker-artifacts
build_dir=$(mktemp -d /Users/jtr/_JTR23_/worker-artifacts/shakedown-bootstrap.XXXXXXXX)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/shakedown-v2 && npm run build -- --outDir "$build_dir")
chmod -R a-w "$build_dir"
```

The bootstrap test rejects any pre-existing output directory, and the receipt binds the new immutable directory and manifest hash.

- [ ] **Step 9: Commit Home23 bootstrap support**

```bash
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime add scripts/bootstrap-shakedown-worker-clone.mjs \
  tests/scripts/bootstrap-shakedown-worker-clone.test.mjs
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime commit -m "feat(shakedown): isolate and reconcile worker source"
```

- [ ] **Step 10: Commit imported and reconciled Shakedown source in the worker clone**

Stage, scan, and commit the admitted local-only set by itself:

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
source_paths=/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/source-import-paths.txt
git -C "$clone_root" add --pathspec-from-file="$source_paths"
git -C "$clone_root" diff --cached --check
git -C "$clone_root" diff --cached --name-only | LC_ALL=C sort | diff -u "$source_paths" -
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --verify-staged-import \
  --clone "$clone_root" \
  --pathspec-file "$source_paths" \
  --deny-secrets --deny-pii --deny-generated --deny-raw-data
git -C "$clone_root" commit -m "chore(source): import verified local Shakedown machinery"
```

Then stage, scan, and commit only the `4f0dbb9` reconciliation. If the patch is already an ancestor or patch-equivalent, the verifier must emit that immutable decision and the cached diff must be empty; otherwise the exact list is committed separately:

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
analytics_paths=/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/analytics-reconciliation-paths.txt
git -C "$clone_root" add --pathspec-from-file="$analytics_paths"
git -C "$clone_root" diff --cached --check
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --verify-staged-reconciliation 4f0dbb9 \
  --clone "$clone_root" \
  --pathspec-file "$analytics_paths" \
  --deny-secrets --deny-pii --deny-generated
if git -C "$clone_root" diff --cached --quiet; then
  node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
    --record-patch-equivalent 4f0dbb9 --clone "$clone_root"
else
  git -C "$clone_root" diff --cached --name-only | LC_ALL=C sort | diff -u "$analytics_paths" -
  git -C "$clone_root" commit -m "fix(acquisition): reconcile analytics hardening 4f0dbb9"
fi
```

---

## Task 17: Define ShakedownJerry identity, knowledge, pursuit, schedules, channels, and inactive authority

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: repaired generic runtime from Tasks 2–15 and the independent clone/config facts from Task 16.
- Produces: installable `shakedown-jerry` template, fresh-history identity/workspace definitions, one resident pursuit definition, portable schedules, a concrete non-empty channel registry, inactive grant candidate, and a preservation-backed migration matrix. Canonical runtime installation and live management readback occur only after Task 29 deploys the repaired service.

**Files:**
- Create: `cli/templates/workers/shakedown-jerry/worker.yaml`
- Create: `cli/templates/workers/shakedown-jerry/workspace/IDENTITY.md`
- Create: `cli/templates/workers/shakedown-jerry/workspace/PLAYBOOK.md`
- Create: `cli/templates/workers/shakedown-jerry/workspace/NOW.md`
- Create: `cli/templates/workers/shakedown-jerry/workspace/MEMORY.md`
- Create: `config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml`
- Create: `config/worker-channels/shakedown-jerry.yaml`
- Create: `config/worker-event-bindings/shakedown-jerry.yaml`
- Create: `config/worker-pursuits/shakedown-jerry.yaml`
- Create: `config/worker-migrations/shakedown-jerry-automation-matrix.yaml`
- Modify: `config/workers.json`
- Create: `tests/workers/shakedown-manifest.test.ts`
- Create: `tests/workers/shakedown-authority.test.ts`
- Create: `tests/workers/shakedown-schedules.test.ts`
- Create: `tests/workers/shakedown-install.test.ts`

- [ ] **Step 1: Write failing identity, authority, schedule, channel, and migration tests**

```ts
test('ShakedownJerry is Jerry-owned and has no independent brain or engine', async () => {
  const profile = resolveFixture('shakedown-jerry');
  assert.equal(profile.ownerAgent, 'jerry');
  assert.deepEqual(profile.brainReadScopes, ['jerry-garcia', 'public-research', 'shakedownshuffle']);
  assert.equal(independentWorkerEngineDefinitions('shakedown-jerry').length, 0);
});

test('live capabilities are unavailable before exact grant activation', async () => {
  const capabilityRegistry = stubCapabilityRegistry({
    'shakedown.site.publish': async () => {
      throw new Error('inactive-authority test must not invoke the capability');
    },
  });
  const executor = makeCapabilityExecutor({
    capabilityRegistry,
    grantStore: emptyGrantActivationStore(),
    requestStore: storedRequestFor(livePublicationFixture()),
  });
  const result = await executor.execute(livePublicationFixture());
  assert.equal(result.decision, 'require-human-authorization');
  assert.match(result.reason, /inactive.*authority grant/i);
  assert.equal(capabilityRegistry.invocationCount('shakedown.site.publish'), 0);
});

test('billing is declared only in the exact hard-stop lane', async () => {
  const manifest = parseWorkerManifest(shakedownManifestFixture);
  const candidate = parseGrantCandidate(shakedownStandingCandidateFixture);
  assert.deepEqual(manifest.hardStopCapabilities, ['shakedown.billing.production-canary']);
  assert.equal(manifest.capabilities.includes('shakedown.billing.production-canary'), false);
  assert.equal(candidate.capabilities.includes('shakedown.billing.production-canary'), false);
  assert.equal(buildWorkerCapabilityRegistry(await resolveFixture('shakedown-jerry'), executor)
    .has('shakedown.billing.production-canary'), false);
});

test('every stable Task 22 mutable target is inside the strict manifest ceiling', () => {
  const manifest = parseWorkerManifest(shakedownManifestFixture);
  assertManifestCoversTargetMap(manifest.paths, stableCollectionTargetsFixture, {
    apiProjectionPath: 'dataWrite',
    enrichmentRoot: 'dataWrite',
    normalizedDetailsPath: 'dataWrite',
    validationReportPath: 'receipt',
    unresolvedGapsPath: 'receipt',
    reviewQueuePath: 'receipt',
    qualityReviewPath: 'receipt',
    sourceManifestPath: 'receipt',
    readableGuidePath: 'receipt',
    runtimeDir: 'runtimeWrite',
    locksRoot: 'runtimeWrite',
  });
});

test('ShakedownJerry always uses fresh attempt history and reconstructs durable state', async () => {
  const profile = resolveFixture('shakedown-jerry');
  assert.equal(profile.history, 'fresh');
  const [first, second] = await createTwoAttempts(profile);
  assert.notEqual(first.historyNamespace, second.historyNamespace);
  assert.deepEqual(second.initialState, canonicalStateAfter(first.receipt));
});

test('channel registry is non-empty and spans all required lanes', () => {
  assert.deepEqual(channelKinds(config), ['consented-communications', 'public-non-substack', 'substack']);
});

test('every observed automation has an explicit disposition and rollback', () => {
  assert.deepEqual(migrationIds(matrix).sort(), observedAutomationIds.sort());
  assert.equal(matrix.every((row) => row.rollback && row.deletionAuthorized === false), true);
});

test('isolated template install and pursuit upsert are idempotent and preserve the source clone', async () => {
  const before = await sha256Tree(sourceCloneRoot);
  const fixtureRuntimeRoot = await makeIsolatedRuntimeFixture();
  await installShakedownWorker({ runtimeRoot: fixtureRuntimeRoot });
  await installShakedownWorker({ runtimeRoot: fixtureRuntimeRoot });
  assert.equal(await sha256Tree(sourceCloneRoot), before);
  assert.equal((await listPursuits(fixtureRuntimeRoot))
    .filter((row) => row.id === 'shakedown-growth').length, 1);
  assert.deepEqual(touchedRuntimeRoots(), [fixtureRuntimeRoot]);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-manifest.test.ts \
  tests/workers/shakedown-authority.test.ts \
  tests/workers/shakedown-schedules.test.ts \
  tests/workers/shakedown-install.test.ts
```

- [ ] **Step 3: Write the durable identity and operating playbook**

Identity makes ShakedownJerry a resident Jerry-owned worker focused on Shakedown Shuffle and Jerry Collection. The playbook encodes the complete observe, discover, improve, publish, distribute, convert, learn, and recover loop; Jerry/Dead ethos; evidence thresholds; source policy; public-contract preservation; non-spam rules; campaign retirement; and escalation/hard-stop rules. `NOW.md` and `MEMORY.md` are projections generated from canonical receipts, not hand-maintained runtime truth.

```markdown
# ShakedownJerry

I am Jerry's resident Shakedown Shuffle worker. I use Jerry's brain through the owner-delegation boundary; I do not run an independent brain, engine, dashboard, or conversation surface.

My loop is observe -> discover -> improve -> publish -> distribute -> convert -> learn -> recover. I prefer useful, source-backed Jerry Garcia listening and discovery value over activity volume. I preserve the public route, player, tracking, Auth, entitlement, collection, and data contracts. I do not invent music history, spam audiences, expose private records, spend money, alter credentials or DNS, or treat wrapper success as consequence proof.

Every consequential action names its evidence, expected consequence, machine gates, exact standing authority, verifier, readback, rollback, and next eligible action. Payment-canary work always requires a separate exact hard-stop authorization.
```

`NOW.md` begins with `schema: home23.worker-now-projection.v1` and `MEMORY.md` begins with `schema: home23.worker-memory-projection.v1`; both files state that SQLite plus canonical receipts are authoritative and are regenerated rather than edited.

- [ ] **Step 4: Define one strict manifest and immutable execution profile inputs**

Pin provider/model selection policy, prompt roots, workspace clone, `sessionHistory: fresh`, cumulative budgets, retry class, safety reserve, both capability lanes, visible principals, and artifact ceilings in the strict manifest. Hash-bind schedule references, event bindings, account aliases, resource locks, channel registry, and immutable runner target data in the standing grant/profile authorities that own those fields. Jerry's brain delegation is scoped and receipt-backed; Forrest awareness is read-only unless explicitly granted.

```yaml
schema: home23.worker.v2
kind: worker
name: shakedown-jerry
displayName: ShakedownJerry
ownerAgent: jerry
class: growth-operator
purpose: Grow qualified Shakedown listeners and members by improving, publishing, distributing, and learning from the site.
provider: owner-default
model: owner-default
context:
  promptRoots: [worker-workspace]
  identityFiles: [IDENTITY.md, PLAYBOOK.md, NOW.md, MEMORY.md]
  sessionHistory: fresh
  ownerBrainRead:
    - agent: jerry
      scopes: [shakedownshuffle, jerry-garcia, public-research]
capabilities:
  - shakedown.observe
  - shakedown.content.prepare
  - shakedown.site.publish
  - shakedown.code.integrate
  - shakedown.backend.deploy
  - shakedown.distribute.substack
  - shakedown.distribute.channel
  - shakedown.communications.consented
  - shakedown.collection.local
  - shakedown.collection.promote-additive
  - shakedown.enrichment
  - shakedown.runtime.reload-scoped
  - shakedown.indexing
  - shakedown.rollback
hardStopCapabilities:
  - shakedown.billing.production-canary
authorityGrant: shakedown-jerry-standing
paths:
  read:
    - /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle
    - /Users/jtr/websites/shakedownshuffle.com/shakedown-v2
    - /Users/jtr/websites/shakedownshuffle.com/jerry-api
    - /Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection
    - /Users/jtr/websites/shakedownshuffle.com/ops/shakedown-watchdog
    - /Users/jtr/websites/shakedownshuffle.com/releases
    - /Users/jtr/websites/shakedownshuffle.com/html
    - /Users/jtr/server/config/Caddyfile
    - /Users/jtr/_JTR23_/jerry-collection
    - /Users/jtr/_JTR23_/shakedown-runtime-data
  write:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry
    - /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle
  sourceClone:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones
  gitMetadata:
    - /Users/jtr/websites/shakedownshuffle.com/.git
  codeRelease:
    - /Users/jtr/websites/shakedownshuffle.com/releases/code
  runtimeWrite:
    - /Users/jtr/_JTR23_/shakedown-runtime-data/jerry-collection-runtime
    - /Users/jtr/_JTR23_/shakedown-runtime-data/locks
  dataWrite:
    - /Users/jtr/_JTR23_/shakedown-runtime-data/api
    - /Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment
  quarantine:
    - /Volumes/Althea/Jerry/audio/quarantine
  collectionCandidate:
    - /Volumes/Althea/Jerry/audio/release-candidates
  collectionStash:
    - /Volumes/Althea/Jerry/audio/stash
  artifact:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/artifacts
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/runs
  privateRead:
    - /Users/jtr/websites/shakedownshuffle.com/private
  receipt:
    - /Users/jtr/_JTR23_/shakedown-runtime-data/jerry-collection-runtime/receipts
    - /Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports
  releaseCandidate:
    - /Users/jtr/websites/shakedownshuffle.com/releases
  liveWebroot:
    - /Users/jtr/websites/shakedownshuffle.com/html
limits:
  maxRuntimeMinutes: 180
  maxToolCalls: 160
  maxConcurrentRuns: 1
  maxTokens: 140000
  maxArtifactBytes: 2147483648
safetyReserve:
  maxRuntimeMinutes: 30
  maxToolCalls: 24
  maxArtifactBytes: 268435456
  retryAttempts: 2
retry:
  transientAttempts: 3
  initialBackoffSeconds: 15
  maxBackoffSeconds: 300
feedsBrains: [jerry]
visibleTo: [jerry]
```

The installable template manifest contains the stable logical authority ID `shakedown-jerry-standing`, but no grant path, grant hash, signature, or implicit activation field. The candidate remains ignored and inactive until Tasks 28–30 finalize, sign, verify, and explicitly activate its exact hash.

- [ ] **Step 5: Populate the inactive standing-grant candidate without signing it yet**

The candidate allows the low-risk production operating classes approved by the spec only: read-only observation; deterministic content candidates; verified site/code/data promotion with rollback; collection/enrichment additive promotion; configured channel distribution; consented one-to-one communications; scoped runtime recovery; schedule timing adjustment; and post-action readbacks. Explicit denies cover schema/Auth/billing/entitlement/credential/account ownership/DNS/destructive data/spend/bulk messaging and the production payment canary. Leave `signature` absent and activation impossible in this task. Task 28 regenerates exact capability/channel/target/config hashes from the completed green implementation and signs that final immutable document; signing now would authorize unimplemented or drifting targets.

Store the document only at `config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml`; the authority loader ignores `candidates/`, and the template manifest does not reference it.

```yaml
schema: home23.worker-authority-grant.v1
id: shakedown-jerry-standing
version: 1
principal: worker:shakedown-jerry
ownerAgent: jerry
signatureAlgorithm: Ed25519
signingKeyId: home23-operator-primary
capabilities:
  - shakedown.observe
  - shakedown.content.prepare
  - shakedown.site.publish
  - shakedown.code.integrate
  - shakedown.backend.deploy
  - shakedown.distribute.substack
  - shakedown.distribute.channel
  - shakedown.communications.consented
  - shakedown.collection.local
  - shakedown.collection.promote-additive
  - shakedown.enrichment
  - shakedown.indexing
  - shakedown.runtime.reload-scoped
  - shakedown.rollback
actionClasses:
  - read-only-observation
  - deterministic-content-candidate
  - verified-site-code-data-promotion
  - additive-collection-enrichment-promotion
  - configured-channel-distribution
  - consented-one-to-one-communications
  - scoped-runtime-recovery
  - schedule-timing-adjustment
  - post-action-readback
hardDenies:
  - schema-mutation
  - auth-mutation
  - billing-or-entitlement-mutation
  - credential-or-account-ownership-change
  - dns-change
  - destructive-data-operation
  - spend
  - bulk-messaging
  - shakedown.billing.production-canary
```

The candidate deliberately omits `issuedAt`, `notBefore`, resolved targets/bindings, and `signature`; candidate validation accepts that incomplete grant-shaped document only beneath the ignored `candidates/` directory. It is never copied to the loadable authority root until Task 28 supplies every concrete field, verifies no scope broadening, and signs it.

- [ ] **Step 6: Create the Shakedown Agency pursuit and event bindings**

Define one resident pursuit visible to Jerry, with success defined by verified useful consequences and measurable visitor/listener growth rather than activity volume. Bind schedule, analytics, content, collection, enrichment, publication, distribution, campaign, and problem events with explicit debounce/cooldown/loop-suppression rules.

```yaml
schema: home23.worker-pursuit.v1
id: shakedown-growth
worker: shakedown-jerry
ownerAgent: jerry
resident: true
focus: Increase useful visits, listening, return behavior, and trustworthy conversion through verified Shakedown consequences.
successEvidence:
  - verified-public-readback
  - comparable-traffic-or-listening-window
  - authoritative-conversion-readback
activityVolumeIsSuccess: false
```

```yaml
schema: home23.worker-event-bindings.v1
worker: shakedown-jerry
bindings:
  - eventClass: meaningful-traffic-change
    mission: traffic-readback
    debounceSeconds: 900
    cooldownSeconds: 7200
    suppressSameCausalChain: true
  - eventClass: collection-release-or-new-show
    mission: collection-readback
    debounceSeconds: 300
    cooldownSeconds: 1800
    suppressSameCausalChain: true
  - eventClass: service-health-failure
    mission: runtime-recovery
    debounceSeconds: 30
    cooldownSeconds: 600
    suppressSameCausalChain: true
```

- [ ] **Step 7: Populate tracked channel and migration authorities from preserved read-only truth**

Resolve concrete account aliases for Substack, at least one non-Substack public channel, and consented communications without recording secrets. Use Task 1's restricted preservation inventory plus direct read-only inspection of the existing Shakedown account/config authorities; do not call the not-yet-deployed Worker management routes. This Home23 YAML is the sole editable channel authority. Task 18 generates the clone-side JSON projection and pins its source hash; equality tests reject independent edits. Populate every migration-matrix row from the preserved live definition hashes/states and exact rollback operations. Task 29 refreshes those facts through the deployed authenticated service and requires exact equality before installation; drift returns here (or Task 27 for absorption logic) and repeats Tasks 28–29.

```bash
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='channel registry|every observed automation' \
  tests/workers/shakedown-schedules.test.ts tests/workers/shakedown-install.test.ts
```

- [ ] **Step 8: Exercise installation and pursuit upsert only in an isolated fixture**

Use the in-process installer test fixture to materialize the template twice beneath a temporary runtime root, upsert `shakedown-growth`, and prove recovery-copy/idempotency behavior without touching canonical runtime state or the existing source clone. The production install is intentionally deferred until Task 29's deployed management service is healthy.

```bash
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='isolated template install and pursuit upsert' \
  tests/workers/shakedown-install.test.ts
```

- [ ] **Step 9: Run tests and local contract/candidate validation — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-manifest.test.ts \
  tests/workers/shakedown-authority.test.ts \
  tests/workers/shakedown-schedules.test.ts \
  tests/workers/shakedown-install.test.ts
npm run test:contracts
node cli/home23.js worker grant validate-candidate \
  config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml \
  --require-inactive --require-unsigned
```

- [ ] **Step 10: Commit**

```bash
git add cli/templates/workers/shakedown-jerry/worker.yaml \
  cli/templates/workers/shakedown-jerry/workspace/IDENTITY.md \
  cli/templates/workers/shakedown-jerry/workspace/PLAYBOOK.md \
  cli/templates/workers/shakedown-jerry/workspace/NOW.md \
  cli/templates/workers/shakedown-jerry/workspace/MEMORY.md \
  config/workers.json \
  config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml \
  config/worker-channels/shakedown-jerry.yaml \
  config/worker-event-bindings/shakedown-jerry.yaml \
  config/worker-pursuits/shakedown-jerry.yaml \
  config/worker-migrations/shakedown-jerry-automation-matrix.yaml \
  tests/workers/shakedown-manifest.test.ts tests/workers/shakedown-authority.test.ts \
  tests/workers/shakedown-schedules.test.ts tests/workers/shakedown-install.test.ts
git commit -m "feat(shakedown): define resident worker policy"
```

---

## Task 18: Build the typed deterministic Shakedown capability runner

**Working directory:** Use `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime` for Home23 files and `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle` for Shakedown files; every command names its root explicitly.

**Interfaces:**
- Consumes: Task 3 signing/profile authority, Task 6 capability executor, Task 16 independent clone, and Task 17 channel/authority definitions.
- Produces: signed short-lived site-runner envelopes, `ShakedownCapabilityAdapter`, immutable-runner subprocess protocol, pinned config projection, typed capability registry, validated receipts, and sandbox billing canary adapter.

**Files:**
- Create in Home23: `src/workers/adapter-dispatch.ts`
- Create in Home23: `src/workers/capabilities/shakedown-adapter.ts`
- Modify in Home23: `src/workers/capabilities/registry.ts`
- Create in Home23: `tests/workers/shakedown-adapter-transport.test.ts`
- Create in Home23: `tests/workers/shakedown-capability-registry.test.ts`
- Create: `ops/shakedown-worker/package.json`
- Create: `ops/shakedown-worker/package-lock.json`
- Create: `ops/shakedown-worker/config/capabilities.v1.json`
- Create: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/config/channels.v1.json`
- Create: `ops/shakedown-worker/config/live-only-artifacts.v1.json`
- Create: `ops/shakedown-worker/config/home23-dispatch-keys.v1.json`
- Create: `ops/shakedown-worker/config/task18-source-paths.txt`
- Create: `ops/shakedown-worker/lib/contracts.mjs`
- Create: `ops/shakedown-worker/lib/home23-auth.mjs`
- Create: `ops/shakedown-worker/lib/runtime.mjs`
- Create: `ops/shakedown-worker/lib/receipt.mjs`
- Create: `ops/shakedown-worker/lib/billing-canary.mjs`
- Create: `ops/shakedown-worker/lib/billing-canary-leaf.mjs`
- Create: `ops/shakedown-worker/scripts/run-capability.mjs`
- Create: `ops/shakedown-worker/scripts/sync-home23-config.mjs`
- Create: `ops/shakedown-worker/scripts/scan-staged-source.mjs`
- Create: `ops/shakedown-worker/tests/contracts.test.mjs`
- Create: `ops/shakedown-worker/tests/runtime-boundary.test.mjs`
- Create: `ops/shakedown-worker/tests/receipt.test.mjs`
- Create: `ops/shakedown-worker/tests/home23-auth.test.mjs`
- Create: `ops/shakedown-worker/tests/billing-canary.test.mjs`
- Create: `ops/shakedown-worker/tests/staged-source-scan.test.mjs`
- Create: `jerry-api/tests/billing-lifecycle-integration.test.ts`

- [ ] **Step 1: Write failing schema, authentication, allowlist, output, and receipt tests**

```js
test('runner accepts only authenticated versioned capability envelopes', async () => {
  assert.equal((await run(unsignedEnvelope)).status, 'denied');
  assert.equal((await run(unknownCapabilityEnvelope)).status, 'denied');
  assert.equal(adapterInvocations(), 0);
});

test('arguments cannot introduce commands, paths, services, hosts, accounts, or recipients', async () => {
  for (const envelope of escapeFixtures()) {
    assert.equal((await run(envelope)).status, 'denied');
  }
});

test('build output is run-scoped and cannot resolve to shared dist', async () => {
  await assert.rejects(() => run(sharedDistEnvelope), /immutable run output/i);
});

test('receipt preserves verifier, rollback, semantic, and uncertainty status', async () => {
  const receipt = await run(uncertainFixture);
  assert.equal(receipt.semanticStatus, 'reconciliation_required');
  assert.equal(receipt.retryable, false);
});

test('signed parent action is exact, short-lived, replay-safe, and cancellation-aware', async () => {
  assert.equal((await siteRunner.verify(tamperedParentEnvelope)).status, 'denied');
  const running = home23Adapter.execute(validSignedParentEnvelope);
  await home23Adapter.cancel(validSignedParentEnvelope.invocation.action.actionId);
  assert.equal((await running).status, 'cancelled');
  assert.equal((await siteRunner.verify(validSignedParentEnvelope)).status, 'replay_denied');
});

test('clone channel projection equals the canonical Home23 registry hash', async () => {
  const projection = await syncHome23Config(home23ChannelYaml);
  assert.equal(projection.sourceSha256, sha256(home23ChannelYaml));
  assert.deepEqual(projection.channels, normalizedHome23Channels);
  assert.throws(() => loadProjection(independentlyEditedProjection), /source hash|projection mismatch/i);
});

test('target pins derive only from tracked or preserved authorities before runtime install', async () => {
  const projection = await syncHome23Config(sourceAuthorityFixture);
  assert.deepEqual(projection.targetPins.targetHashes, expectedCatalogTargetHashes);
  assert.deepEqual(projection.targetPins.targetAuthoritySourceHashes, expectedAuthoritySourceHashes);
  assert.equal(runtimeStateReads(), 0);
  await assert.rejects(() => syncHome23Config(missingOrOutOfCeilingAuthority), /target authority|path ceiling/i);
});

test('billing orchestration invokes exactly one authorized leaf per operation without recursion', async () => {
  const expected = [
    'signup', 'checkout', 'charge', 'webhook', 'entitlement',
    'cancel', 'refund', 'pending-state-reconcile', 'cleanup',
  ];
  const trace = await executeBillingCanaryFixture(exactHardStopFixture);
  assert.equal(trace.outerModuleCalls, 1);
  assert.deepEqual(trace.childExecutorCalls.map((row) => row.operation), expected);
  assert.deepEqual(trace.leafModuleCalls.map((row) => row.operation), expected);
  assert.equal(trace.childExecutorCalls.length, expected.length);
  assert.equal(trace.leafModuleCalls.length, expected.length);
  assert.equal(trace.recursiveOuterModuleCalls, 0);
  assert.equal(trace.maxOuterDepth, 1);
  assert.equal(trace.rootOperationReservations, 0);
  assert.equal(trace.leafAuthorizationChecks, expected.length);
  assert.equal(trace.authoritativeReadbacks.every(Boolean), true);
  for (const operation of expected) {
    assert.equal(trace.leafModuleCalls.filter((row) => row.operation === operation).length, 1);
    assert.equal(trace.hardStopReservations.filter((row) => row.operation === operation).length, 1);
  }
});

test('billing leaf routing rejects standing, spoofed, replaced, and replayed authority', async () => {
  assert.equal((await executor.execute(standingBillingRoot)).decision, 'require-human-authorization');
  assert.equal((await executor.execute(spoofedPublicLeafEnvelope)).decision, 'deny');
  assert.equal((await executor.execute(childReplacingTrustedParentHash)).decision, 'deny');
  await executor.execute(validChargeChild);
  assert.equal((await executor.execute(validChargeChild)).decision, 'deny');
  assert.equal(leafInvocationCount('charge'), 1);
});

test('billing entrypoint resolution is exhaustive and cannot downgrade a malformed leaf to root', async () => {
  assert.equal(resolveBillingEntrypoint(validAuthorizedRoot, billingDefinition).contextKind, 'orchestrator');
  assert.equal(resolveBillingEntrypoint(validAuthorizedLeaf, billingDefinition).contextKind, 'leaf');
  for (const invocation of [
    billingWithStandardRoute, strippedLeafRoute, rootWithParent,
    leafWithoutReservation, childOfLeaf, unknownBillingRoute,
  ]) {
    assert.throws(() => resolveBillingEntrypoint(invocation, billingDefinition), /exact authorized adapter route|lineage/i);
  }
  assert.equal(outerModuleCallsForMalformedRoutes(), 0);
  assert.equal(leafModuleCallsForMalformedRoutes(), 0);
});

test('billing route locks are disjoint and nested execution completes without self-deadlock', async () => {
  assert.deepEqual(intersectLocks(
    billingDefinition.resourceLocks,
    billingDefinition.internalLeafRouter.resourceLocks,
  ), []);
  assert.equal((await withTimeout(run(validCompleteBillingInvocation), 2_000)).status, 'succeeded');
});

test('billing child exchange uses ordered bounded duplex frames and closes on cancel', async () => {
  const session = await startRunner(validAuthorizedRoot);
  await session.receive(childRequestFrame({ operation: 'signup', sequence: 0 }));
  assert.deepEqual(session.framesWrittenToRunner(), [authorizedLeafResultFrame({ sequence: 0 })]);
  await assert.rejects(() => session.receive(outOfOrderOrOversizedFrame), /frame.*order|bounded/i);
  await session.cancel();
  assert.equal(session.stdinClosed, true);
  assert.equal(session.processTerminated, true);
});

test('billing leaf context cannot request another child or advance a mismatched state', async () => {
  assert.equal('requestAuthorizedLeaf' in billingLeafContext, false);
  assert.equal((await run(leafAttemptingRecursion)).status, 'denied');
  const mismatch = await run(leafReturningWrongNextState);
  assert.equal(mismatch.status, 'reconciliation_required');
  assert.equal(operationStateAdvanced(mismatch), false);
});

test('billing root resumes after every consumed leaf without a second provider effect', async () => {
  for (const crashAfterSequence of BILLING_CANARY_OPERATIONS.keys()) {
    const first = await executeBillingUntilCrash(exactHardStopFixture, crashAfterSequence);
    const resumed = await resumeSameRootFromDurablePrefix(first.rootActionId);
    assert.deepEqual(resumed.operations, BILLING_CANARY_OPERATIONS);
    assert.equal(resumed.providerEffectsByOperation.every((count) => count === 1), true);
    assert.equal(resumed.leafInvocationsByOperation.every((count) => count === 1), true);
    assert.equal(resumed.authorizationStatus, 'closed');
  }
  assert.equal((await resumeWithDifferentRootActionId()).decision, 'deny');
});
```

```ts
test('Home23 registers every exact Shakedown capability from the hash-pinned immutable catalog', async () => {
  const registered = await registerShakedownCapabilityCatalog({
    registry,
    manifest: shakedownManifest,
    releaseManifest: completePinnedRunnerManifest,
    adapter: shakedownAdapter,
  });
  assert.deepEqual(registered.map((row) => row.capabilityId).sort(), SHAKEDOWN_CAPABILITY_IDS);
  assert.equal(registered.every((row) => row.catalogHash === completePinnedRunnerManifest.capabilityCatalogHash), true);
  assert.equal(registered.every((row) => row.adapter === shakedownAdapter), true);
  assert.deepEqual(SHAKEDOWN_CAPABILITY_IDS,
    [...shakedownManifest.capabilities, ...shakedownManifest.hardStopCapabilities].sort());
  assert.equal(buildWorkerCapabilityRegistry(standingOnlyProfile, executor)
    .has('shakedown.billing.production-canary'), false);
  await assert.rejects(
    () => registerShakedownCapabilityCatalog({
      registry, manifest: shakedownManifest,
      releaseManifest: incompleteOrDriftedCatalog, adapter: shakedownAdapter,
    }),
    /catalog.*missing|hash mismatch/i,
  );
});
```

- [ ] **Step 2: Run Home23 transport and worker-clone tests — expect FAIL**

```bash
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  bun --cwd jerry-api install --frozen-lockfile)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  npm --prefix ops/shakedown-worker ci --ignore-scripts --no-audit --no-fund)
(cd /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime && \
  node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-adapter-transport.test.ts \
  tests/workers/shakedown-capability-registry.test.ts)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  node --test --test-concurrency=1 ops/shakedown-worker/tests/contracts.test.mjs \
  ops/shakedown-worker/tests/runtime-boundary.test.mjs \
  ops/shakedown-worker/tests/receipt.test.mjs \
  ops/shakedown-worker/tests/home23-auth.test.mjs \
  ops/shakedown-worker/tests/billing-canary.test.mjs \
  ops/shakedown-worker/tests/staged-source-scan.test.mjs)
```

`ops/shakedown-worker/package.json` declares every runtime parser/client dependency and commits `package-lock.json`; implicit Bun/npm auto-install is disabled in tests. Record the Jerry API and runner lock/install-tree hashes so all later tests and immutable releases can prove the same dependency inputs.

- [ ] **Step 3: Define the site-side versioned contract**

Validate the authenticated post-authorization adapter invocation, capability ID/version, normalized typed arguments, run-scoped input/output roots, declared account aliases, correlation/causation IDs, deadline, and idempotency key. Return structured progress and a terminal receipt whose identity is bound to the Home23 action. Reject unknown fields. The signature covers the complete discriminated route, orchestration/reservation identity, transition, and action. Billing rejects `route.kind: standard`, a root route with parent/internal fields, and a leaf route without the exact parent/reservation fields.

```js
export const siteActionSchema = {
  $id: 'home23.shakedown-action.v1',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'invocation', 'issuedAt', 'expiresAt', 'nonce', 'signingKeyId', 'signature'],
  properties: {
    schema: { const: 'home23.shakedown-action.v1' },
    invocation: { $ref: 'home23.authorized-adapter-invocation.v1' },
    issuedAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{32,128}$' },
    signingKeyId: { type: 'string', minLength: 1, maxLength: 128 },
    signature: { type: 'string', pattern: '^[A-Za-z0-9_-]{86}$' },
  },
};

export function parseSiteActionEnvelope(input, { validate, runRoot }) {
  if (!validate(input)) throw new SiteContractError(validate.errors);
  const invocation = normalizeAuthorizedAdapterInvocation(input.invocation);
  assertExactRouteLineage(invocation);
  assertDeclaredRunScopedPaths(invocation.action.arguments, runRoot);
  assertIsoDeadline(invocation.action.arguments.deadline);
  return structuredClone({ ...input, invocation });
}
```

- [ ] **Step 4: Make the capability catalog closed and data-driven**

The catalog maps each capability ID to one module, argument schema, fixed commands, allowed paths, hosts, identities, accounts, service names, locks, preflight, verifier, rollback, and consequence class. There is no arbitrary shell, browser instruction, filesystem target, URL, PM2 service, recipient, or credential field. Billing keeps one public hard-stop capability ID but defines a signed, catalog-bound internal leaf router. That router is not a tool or capability and never enters the manifest/grant ID sets; catalog validation requires its module/export and exact shared operation vocabulary.

```json
{
  "schema": "home23.shakedown-capability-catalog.v1",
  "capabilities": {
    "shakedown.billing.production-canary": {
      "version": 1,
      "module": "../lib/billing-canary.mjs",
      "argumentSchema": "home23.shakedown-billing-orchestration-input.v1",
      "internalLeafRouter": {
        "module": "../lib/billing-canary-leaf.mjs",
        "exportName": "runBillingCanaryLeaf",
        "argumentSchema": "home23.shakedown-billing-leaf-input.v1",
        "operations": ["signup", "checkout", "charge", "webhook", "entitlement", "cancel", "refund", "pending-state-reconcile", "cleanup"],
        "resourceLocks": ["shakedown-billing-provider-effects"]
      },
      "fixedCommands": [],
      "allowedPathClasses": ["privateRead", "runtimeWrite"],
      "allowedHosts": ["www.shakedownshuffle.com", "api.shakedownshuffle.com", "api.stripe.com", "pkbnsqnkuoifudvbbdbe.supabase.co"],
      "allowedIdentityAliases": ["owned-production-canary"],
      "allowedAccountAliases": ["shakedown-production", "shakedown-stripe-live"],
      "allowedServices": ["jerry-api"],
      "resourceLocks": ["shakedown-billing-orchestration"],
      "preflight": "billingHardStopPreflight",
      "verifier": "billingAuthoritativeReadback",
      "rollback": "billingAuthorizedCleanup",
      "consequenceClass": "conversion-authority"
    }
  }
}
```

Tasks 19–26 add their completed module entry and tests to this same catalog in the commit that creates the module; validation rejects a catalog entry whose module, preflight, verifier, or rollback export is absent.

- [ ] **Step 5: Keep secrets and policy out of the model boundary**

Resolve credentials only inside the deterministic adapter from configured aliases. Redact command output and receipts before return. Treat Home23's decision as necessary but still enforce site-local schema and target invariants; the site runner never activates or expands the standing grant.

```js
const CREDENTIAL_ALIASES = Object.freeze({
  'shakedown-production': { service: 'shakedownshuffle.production', account: 'runtime' },
  'shakedown-stripe-live': { service: 'shakedownshuffle.stripe-live', account: 'runtime' },
});

const IDENTITY_ALIASES = Object.freeze({
  'owned-production-canary': { credentialAlias: 'shakedown-production', privateRecord: 'owned-canary-v1' },
});

export async function resolveCredentialAlias(alias, keychain) {
  const target = CREDENTIAL_ALIASES[alias];
  if (!target) throw new Error(`Unknown credential alias: ${alias}`);
  const secret = await keychain.read(target.service, target.account);
  if (!secret) throw new Error(`Credential unavailable: ${alias}`);
  return Object.freeze({ alias, secret });
}

export function redactSiteResult(value) {
  return deepRedact(value, {
    keys: ['authorization', 'cookie', 'email', 'payment_method', 'service_role', 'session', 'token'],
    replacement: '[REDACTED]',
  });
}
```

- [ ] **Step 6: Implement the authenticated Home23-to-runner bridge**

`CapabilityExecutor` calls only `ShakedownCapabilityAdapter.execute(invocation)` after constructing the required Task 6 `AuthorizedAdapterInvocation`. The adapter resolves a hash-pinned immutable runner release under `/Users/jtr/websites/shakedownshuffle.com/releases/code/shakedown-worker`, never the mutable clone; signs the complete short-lived canonical invocation, including route and reservation fields, with the Keychain-backed dispatch key; launches the fixed Node entrypoint with a minimal environment; and uses a bounded framed NDJSON duplex protocol over that process's stdin/stdout. It sends the initial invocation frame while keeping stdin open, reads authenticated progress/child-request/terminal frames, executes an accepted child through `adapter-dispatch.ts`, writes the bounded leaf-result frame back to the waiting root process, and closes only at terminal/cancel/deadline. Every frame is schema/version/action/correlation/sequence bound; stderr is bounded and redacted. The adapter propagates abort/deadline and validates action/run/correlation/receipt hashes before return. The clone-side `home23-auth.mjs` verifies the pinned public dispatch-key registry, expiry, nonce, invocation digest, frame ordering, and replay state. No port, MCP server, or long-running process is added.

`src/workers/capabilities/registry.ts` owns the Home23 side of the integration. At profile resolution it loads the immutable runner manifest, verifies its signature/tree/catalog hashes, requires the catalog keys to equal the disjoint union of `manifest.capabilities` and `manifest.hardStopCapabilities`, and registers each definition with its catalog-entry hash and the single `ShakedownCapabilityAdapter`. Normal model-visible tools remain exactly `profile.capabilities`; a declared hard-stop definition becomes root-callable only for a run with the trusted exact binding described in Task 6. An incomplete catalog remains unavailable rather than silently installing partial capability definitions; Task 28 proves the finished catalog is complete. Bounded billing child messages from the runner carry only operation and sequence. They are not executed by the runner: `adapter-dispatch.ts` derives identity, exact parent hash, targets, bounds, transition, and fixed arguments into a trusted child envelope and calls the same Home23 `CapabilityExecutor.execute()` before returning the leaf result.

```ts
export interface ShakedownCapabilityAdapter {
  execute(invocation: AuthorizedAdapterInvocation, signal: AbortSignal): Promise<WorkerActionResult>;
}

export interface SignedSiteActionEnvelope {
  schema: 'home23.shakedown-action.v1';
  invocation: AuthorizedAdapterInvocation;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signingKeyId: string;
  signature: string;
}

export const SHAKEDOWN_STANDING_CAPABILITY_IDS = Object.freeze([
  'shakedown.backend.deploy', 'shakedown.code.integrate',
  'shakedown.collection.local', 'shakedown.collection.promote-additive',
  'shakedown.communications.consented', 'shakedown.content.prepare',
  'shakedown.distribute.channel', 'shakedown.distribute.substack',
  'shakedown.enrichment', 'shakedown.indexing', 'shakedown.observe',
  'shakedown.rollback', 'shakedown.runtime.reload-scoped', 'shakedown.site.publish',
].sort());
export const SHAKEDOWN_HARD_STOP_CAPABILITY_IDS = Object.freeze([
  'shakedown.billing.production-canary',
]);
export const SHAKEDOWN_CAPABILITY_IDS = Object.freeze([
  ...SHAKEDOWN_STANDING_CAPABILITY_IDS,
  ...SHAKEDOWN_HARD_STOP_CAPABILITY_IDS,
].sort());

export async function registerShakedownCapabilityCatalog(input: {
  registry: WorkerCapabilityRegistry;
  manifest: WorkerManifestV2;
  releaseManifest: ImmutableShakedownRunnerManifest;
  adapter: ShakedownCapabilityAdapter;
}): Promise<RegisteredWorkerCapability[]> {
  const catalog = await verifyImmutableRunnerAndReadCatalog(input.releaseManifest);
  assertExactStringSet(input.manifest.capabilities, SHAKEDOWN_STANDING_CAPABILITY_IDS);
  assertExactStringSet(input.manifest.hardStopCapabilities, SHAKEDOWN_HARD_STOP_CAPABILITY_IDS);
  assertDisjointCapabilityLanes(input.manifest.capabilities, input.manifest.hardStopCapabilities);
  assertExactStringSet(Object.keys(catalog.capabilities), SHAKEDOWN_CAPABILITY_IDS);
  return SHAKEDOWN_CAPABILITY_IDS.map((capabilityId) => input.registry.register({
    capabilityId,
    catalogHash: input.releaseManifest.capabilityCatalogHash,
    definitionHash: sha256Canonical(catalog.capabilities[capabilityId]),
    adapter: input.adapter,
  }));
}

export interface BillingLeafRequest {
  schema: 'home23.shakedown-billing-child.v1';
  kind: 'billing-canary-leaf';
  operation: BillingCanaryOperation;
  sequence: number;
}

export async function dispatchRunnerChild(
  parent: Extract<AuthorizedAdapterInvocation, { route: { kind: 'billing-orchestrator-root' } }>,
  request: BillingLeafRequest,
  executor: CapabilityExecutor,
): Promise<WorkerActionResult> {
  assertBillingLeafRequest(request);
  assert.equal(parent.route.kind, 'billing-orchestrator-root');
  assert.equal(parent.action.capabilityId, 'shakedown.billing.production-canary');
  assert.equal(request.operation, parent.action.arguments.operations[request.sequence]);
  const child = deriveTrustedChildEnvelope(parent, {
    actionId: sha256Canonical({
      parentActionId: parent.action.actionId, operation: request.operation, sequence: request.sequence,
    }),
    parentActionId: parent.action.actionId,
    causationId: parent.action.actionId,
    capabilityId: 'shakedown.billing.production-canary',
    hardStopAuthorizationHash: parent.action.hardStopAuthorizationHash,
    internalDispatch: { kind: 'billing-canary-leaf', operation: request.operation, sequence: request.sequence },
    arguments: deriveBillingLeafArguments(parent, request.operation, request.sequence),
  });
  await persistTrustedBillingChildProvenance(child, 'billing-router-child');
  return executor.execute(child);
}
```

The runner entrypoint selects the catalog-bound leaf without invoking the outer module again:

```js
export function resolveBillingEntrypoint(invocation, definition) {
  switch (invocation.route.kind) {
    case 'billing-orchestrator-root':
      assertBillingRootLineage(invocation);
      return {
        module: definition.module,
        exportName: 'runBillingCanary',
        contextKind: 'orchestrator',
      };
    case 'billing-authorized-leaf': {
      assertBillingLeafLineage(invocation);
      const route = definition.internalLeafRouter;
      if (!route || !route.operations.includes(invocation.route.operation)) {
        throw new Error('invalid internal billing leaf route');
      }
      assert.equal(invocation.route.operation, invocation.action.internalDispatch.operation);
      return { module: route.module, exportName: route.exportName, contextKind: 'leaf' };
    }
    default:
      throw new Error('billing action missing exact authorized adapter route');
  }
}
```

The non-billing resolver accepts only `route.kind: standard`; billing never uses that branch. The runner child request schema rejects authorization hash, capability ID, principal, account, amount, identity, transition, and arbitrary fixed arguments. Home23 derives all of those from the authenticated root, exact signed document, and durable state machine, then authorizes the child afresh. The root receives only a frozen `requestAuthorizedLeaf` function. The leaf router receives only frozen provider/readback functions and has no `requestAuthorizedLeaf`, `executeChild`, orchestration, standing-grant, or generic-tool access.

- [ ] **Step 7: Generate clone config from Home23 authorities**

`sync-home23-config.mjs` accepts the canonical Home23 channel registry, public dispatch-key registry, disjoint manifest standing/hard-stop capability sets, typed manifest path ceilings, and explicit tracked/preserved target-authority documents. It derives target hashes itself from only the authorities referenced by the current catalog, writes deterministic JSON projections, and records every authority source SHA-256. It never reads canonical runtime state during build. The projected catalog ceiling is the capability-set union, while the standing-grant/model ceiling is the standing set only; every clone-side stable target map must remain a typed subset of the projected path ceilings. Equality tests fail independent clone edits. Secrets/account credentials are resolved at execution by alias and never projected.

```js
export async function syncHome23Config({
  channelYaml, dispatchKeysJson, standingCapabilityIds, hardStopCapabilityIds,
  billingCanaryOperations, billingCanaryCleanupOperations, manifestPathCeilings,
  capabilityCatalog, targetAuthorityDocuments, outputRoot,
}) {
  const channels = normalizeChannelRegistry(parseYaml(channelYaml));
  const resolvedTargets = deriveCatalogTargetHashes({
    capabilityCatalog,
    manifestPathCeilings,
    targetAuthorityDocuments,
  });
  const projection = {
    schema: 'home23.shakedown-channel-projection.v1',
    sourceSha256: sha256(channelYaml),
    channels,
  };
  await writeJsonAtomic(join(outputRoot, 'channels.v1.json'), projection);
  await writeJsonAtomic(join(outputRoot, 'home23-dispatch-keys.v1.json'), {
    schema: 'home23.dispatch-public-keys.v1',
    sourceSha256: sha256(dispatchKeysJson),
    keys: parseDispatchPublicKeys(dispatchKeysJson),
  });
  const targetPins = {
    schema: 'home23.shakedown-target-pins.v1',
    standingCapabilityIds: [...standingCapabilityIds].sort(),
    hardStopCapabilityIds: [...hardStopCapabilityIds].sort(),
    capabilityIds: [...standingCapabilityIds, ...hardStopCapabilityIds].sort(),
    billingCanaryOperations: [...billingCanaryOperations],
    billingCanaryCleanupOperations: [...billingCanaryCleanupOperations],
    manifestPathCeilings: normalizeTypedPathCeilings(manifestPathCeilings),
    targetAuthoritySourceHashes: sortRecord(resolvedTargets.sourceHashes),
    targetHashes: sortRecord(resolvedTargets.targetHashes),
  };
  await writeJsonAtomic(join(outputRoot, 'capability-target-pins.v1.json'), targetPins);
  return { ...projection, targetPins };
}
```

The Home23 caller supplies the two operation arrays directly from Task 2's frozen constants. Clone validation requires the target-pin projection, catalog `internalLeafRouter.operations`, orchestration parser, leaf parser, and transition tests to agree byte-for-byte; no clone-local list can expand the vocabulary. Every later task that changes `capabilities.v1.json` or a referenced target authority must regenerate and stage `capability-target-pins.v1.json` in the same commit. Tasks 19–26 own those updates for their entries; Task 22 specifically owns the stable data/config target transition; Task 28 performs one final derivation from the complete source and refuses drift. The tested `--target-pins-only --home-root <root> --clone-root <root> --preservation-manifest <file> --write` form expands only the exact manifest, catalog, collection config, Caddy config, and preservation inputs shown below, then atomically rewrites only `capability-target-pins.v1.json`; it never consults runtime state.

Generate the committed clone projections only through this authority bridge, run it twice, and require byte-identical output before any Task 18 test or staging commit:

```bash
home_root=/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
projection_root="$clone_root/ops/shakedown-worker/config"
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" \
  --manifest "$home_root/cli/templates/workers/shakedown-jerry/worker.yaml" \
  --channel-registry "$home_root/config/worker-channels/shakedown-jerry.yaml" \
  --dispatch-public-key "$home_root/config/worker-signing-keys/home23-operator-primary.json" \
  --capability-catalog "$projection_root/capabilities.v1.json" \
  --collection-config "$clone_root/ops/jerry-collection/config.json" \
  --caddy-config /Users/jtr/server/config/Caddyfile \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --derive-target-hashes-for-current-catalog \
  --output-root "$projection_root" --require-operation-constants-from-home23
projection_before=$(shasum -a 256 \
  "$projection_root/channels.v1.json" \
  "$projection_root/home23-dispatch-keys.v1.json" \
  "$projection_root/capability-target-pins.v1.json")
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" \
  --manifest "$home_root/cli/templates/workers/shakedown-jerry/worker.yaml" \
  --channel-registry "$home_root/config/worker-channels/shakedown-jerry.yaml" \
  --dispatch-public-key "$home_root/config/worker-signing-keys/home23-operator-primary.json" \
  --capability-catalog "$projection_root/capabilities.v1.json" \
  --collection-config "$clone_root/ops/jerry-collection/config.json" \
  --caddy-config /Users/jtr/server/config/Caddyfile \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --derive-target-hashes-for-current-catalog \
  --output-root "$projection_root" --require-operation-constants-from-home23
projection_after=$(shasum -a 256 \
  "$projection_root/channels.v1.json" \
  "$projection_root/home23-dispatch-keys.v1.json" \
  "$projection_root/capability-target-pins.v1.json")
test "$projection_before" = "$projection_after"
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" \
  --validate-only --output-root "$projection_root" \
  --require-source-hashes --require-path-ceiling-subsets --require-operation-equality
```

- [ ] **Step 8: Implement the non-standing billing canary adapter and sandbox lifecycle coverage**

`billing-canary.mjs` is an orchestrator only. It exposes the fixed production-canary state machine, accepts only the canonical ordered operation plan already authorized by Home23, and receives no authorization summary/hash, provider adapter, hard-stop store, or generic tool registry. For every transition it emits only `{ kind, operation, sequence }` through its frozen `requestAuthorizedLeaf` transport. Home23 derives the trusted child action, freshly re-verifies the exact hard-stop hash, reserves the server-owned transition, and calls `CapabilityExecutor.execute()` again; the signed runner then dispatches that child to `billing-canary-leaf.mjs`, never back to the orchestrator. The leaf module contains one fixed handler per shared operation, no child-request function, and no standing-grant path. Root and leaf use disjoint route locks so the waiting orchestrator cannot deadlock its own nested leaf. The backend integration test covers signup/session, checkout validation/replay/redirects, pending activation, webhook signature/idempotency/out-of-order/duplicate delivery, failed/expired/cancelled/refunded state, entitlement reconciliation, restart recovery, and frontend status polling against fixtures/sandbox. No live-mode call occurs in this task.

```js
const BILLING_TRANSITIONS = Object.freeze({
  initialized: ['signup'],
  signed_up: ['checkout'],
  checkout_created: ['charge'],
  charged: ['webhook'],
  webhook_verified: ['entitlement'],
  entitlement_active: ['cancel', 'refund'],
  cancelled: ['refund', 'pending-state-reconcile'],
  refunded: ['pending-state-reconcile'],
  reconciled: ['cleanup'],
  cleaned: [],
});

export async function runBillingCanary(input, context) {
  const plan = parseBillingOrchestrationInput(input);
  const resume = await context.loadAuthorizedBillingResume({
    orchestrationPlanHash: sha256Canonical(plan),
    rootActionId: context.rootActionId,
  });
  assertConsumedPrefixMatchesPlanAndAuthoritativeEvidence(resume, plan);
  let state = resume.currentState;
  const transitions = [...resume.consumedOperations];
  const childActions = [...resume.authoritativePriorResults];
  for (let sequence = resume.nextSequence; sequence < plan.operations.length; sequence += 1) {
    const operation = plan.operations[sequence];
    if (!BILLING_TRANSITIONS[state].includes(operation)) throw new Error(`Invalid billing transition: ${state} -> ${operation}`);
    const result = await context.requestAuthorizedLeaf({
      schema: 'home23.shakedown-billing-child.v1',
      kind: 'billing-canary-leaf',
      operation,
      sequence,
    });
    if (result.executedBy !== 'CapabilityExecutor.execute' || result.adapterRoute !== 'billing-canary-leaf') {
      throw new Error('billing child bypassed the authorized leaf route');
    }
    childActions.push(result);
    transitions.push(operation);
    state = result.nextState;
  }
  return {
    status: 'succeeded', transitions, childActions,
    authoritativeReadbacks: childActions.map((row) => row.authoritativeReadback === true),
  };
}

const BILLING_LEAF_HANDLERS = Object.freeze({
  signup: performOwnedSignup,
  checkout: performCheckout,
  charge: performCharge,
  webhook: performWebhookReadback,
  entitlement: performEntitlementReadback,
  cancel: performCancellation,
  refund: performRefund,
  'pending-state-reconcile': performPendingStateReconciliation,
  cleanup: performAuthorizedCleanup,
});

export async function runBillingCanaryLeaf(input, context) {
  if ('requestAuthorizedLeaf' in context || 'executeChild' in context) {
    throw new Error('billing leaf context cannot recurse');
  }
  const leaf = parseBillingLeafInput(input);
  const handler = BILLING_LEAF_HANDLERS[leaf.operation];
  if (!handler) throw new Error(`unsupported billing leaf: ${leaf.operation}`);
  const result = await handler(leaf.fixedArguments, context.billingProviders);
  return assertAuthoritativeBillingLeafResult({
    ...result, operation: leaf.operation, adapterRoute: 'billing-canary-leaf',
  });
}
```

`loadAuthorizedBillingResume()` comes only from the Home23 executor/store boundary and returns the hash-verified consumed prefix, current state, next sequence, and redacted authoritative result hashes for the same root action. The runner never infers state from its prior stdout. A same-root recovery idempotently returns stored results for consumed leaves without invoking the leaf module/provider again; a different root/action, altered plan, gap, uncertain transition, or mismatched result hash is external replay and is denied or held in reconciliation. Crash tests cover every leaf boundary and terminal authorization close.

The catalog schema asserts that `internalLeafRouter.operations` equals `BILLING_CANARY_OPERATIONS` exactly, every named leaf handler exists, the root/leaf module and export hashes are immutable-runner bound, and the root/leaf lock sets are disjoint. The site action parser rejects billing on the standard route, a root action carrying parent/internal fields, and any leaf whose route, parent, reservation, operation, sequence, or signed trusted fields disagree. The resolver has no billing fallback branch. Tests prove one outer call at maximum depth one, `N` fresh child executor authorizations, `N` transition reservations, `N` single leaf calls, zero recursive outer calls, exact deterministic child IDs and parent-hash inheritance, no self-deadlock, no leaf-context recursion, no state advance on authoritative mismatch, and no second leaf call on replay.

- [ ] **Step 9: Implement immutable artifact and receipt roots**

Every capability writes beneath its run directory, fsyncs structured journal events, hashes artifacts, and commits a terminal receipt atomically. No adapter writes a public or shared target except through its dedicated release/promoter module. `scan-staged-source.mjs` reads the exact Git index entries, enforces a task allowlist, and rejects secrets, credentials, direct PII, raw data, generated outputs, receipts, screenshots, caches, and unexpected binaries before commit. Write the sorted newline-delimited exact Task 18 clone-side `Files` list, including the path-list file itself and `jerry-api/tests/billing-lifecycle-integration.test.ts`, to `ops/shakedown-worker/config/task18-source-paths.txt`; the cached name set must equal it byte-for-byte.

```text
jerry-api/tests/billing-lifecycle-integration.test.ts
ops/shakedown-worker/config/capabilities.v1.json
ops/shakedown-worker/config/capability-target-pins.v1.json
ops/shakedown-worker/config/channels.v1.json
ops/shakedown-worker/config/home23-dispatch-keys.v1.json
ops/shakedown-worker/config/live-only-artifacts.v1.json
ops/shakedown-worker/config/task18-source-paths.txt
ops/shakedown-worker/lib/billing-canary-leaf.mjs
ops/shakedown-worker/lib/billing-canary.mjs
ops/shakedown-worker/lib/contracts.mjs
ops/shakedown-worker/lib/home23-auth.mjs
ops/shakedown-worker/lib/receipt.mjs
ops/shakedown-worker/lib/runtime.mjs
ops/shakedown-worker/package.json
ops/shakedown-worker/scripts/run-capability.mjs
ops/shakedown-worker/scripts/scan-staged-source.mjs
ops/shakedown-worker/scripts/sync-home23-config.mjs
ops/shakedown-worker/tests/billing-canary.test.mjs
ops/shakedown-worker/tests/contracts.test.mjs
ops/shakedown-worker/tests/home23-auth.test.mjs
ops/shakedown-worker/tests/receipt.test.mjs
ops/shakedown-worker/tests/runtime-boundary.test.mjs
ops/shakedown-worker/tests/staged-source-scan.test.mjs
```

```js
export async function commitTerminalReceipt({ runRoot, receipt }) {
  const canonical = `${canonicalJson(receipt)}\n`;
  const temporary = join(runRoot, `.${receipt.actionId}.terminal.tmp`);
  const destination = join(runRoot, `${receipt.actionId}.terminal.json`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(canonical, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await fsyncDirectory(runRoot);
  return { uri: destination, sha256: sha256(canonical) };
}
```

- [ ] **Step 10: Run tests — expect PASS**

```bash
(cd /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime && \
  node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-adapter-transport.test.ts \
  tests/workers/shakedown-capability-registry.test.ts)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  node --test --test-concurrency=1 ops/shakedown-worker/tests/contracts.test.mjs \
  ops/shakedown-worker/tests/runtime-boundary.test.mjs \
  ops/shakedown-worker/tests/receipt.test.mjs \
  ops/shakedown-worker/tests/home23-auth.test.mjs \
  ops/shakedown-worker/tests/billing-canary.test.mjs \
  ops/shakedown-worker/tests/staged-source-scan.test.mjs)
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  bun --cwd jerry-api test)
```

- [ ] **Step 11: Commit Home23 transport support**

```bash
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime add \
  src/workers/adapter-dispatch.ts src/workers/capabilities/shakedown-adapter.ts \
  src/workers/capabilities/registry.ts \
  tests/workers/shakedown-adapter-transport.test.ts \
  tests/workers/shakedown-capability-registry.test.ts
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  commit -m "feat(workers): bridge immutable Shakedown capabilities"
```

- [ ] **Step 12: Commit in the worker clone**

```bash
git -C /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle add \
  ops/shakedown-worker/config/task18-source-paths.txt
git -C /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle add \
  --pathspec-from-file=ops/shakedown-worker/config/task18-source-paths.txt
git -C /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  diff --cached --check
git -C /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  diff --cached --name-only | diff -u \
  /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle/ops/shakedown-worker/config/task18-source-paths.txt -
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  node ops/shakedown-worker/scripts/scan-staged-source.mjs \
  --deny-secrets --deny-pii --deny-generated)
git -C /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  commit -m "feat(worker): add authenticated typed capability runner"
```

---

## Task 19: Build a redacted observation plane and canonical opportunity ledger

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 18 runner/auth/receipt contracts and Task 5 canonical state-event ingestion contract.
- Produces: redacted analytics snapshots, funnel-state classification, opportunity/campaign state events, payment/operator readbacks, and destination-shift signals without creating a second authority.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/schemas/opportunity.v1.schema.json`
- Create: `ops/shakedown-worker/schemas/analytics-snapshot.v1.schema.json`
- Create: `ops/shakedown-worker/lib/observe.mjs`
- Create: `ops/shakedown-worker/lib/matomo-readback.mjs`
- Create: `ops/shakedown-worker/lib/funnel-readback.mjs`
- Create: `ops/shakedown-worker/lib/search-demand.mjs`
- Create: `ops/shakedown-worker/lib/payment-readback.mjs`
- Create: `ops/shakedown-worker/lib/operator-readback.mjs`
- Create: `ops/shakedown-worker/lib/opportunity-ledger.mjs`
- Create: `ops/shakedown-worker/tests/observe.test.mjs`
- Create: `ops/shakedown-worker/tests/opportunity-ledger.test.mjs`
- Create: `ops/shakedown-worker/tests/fixtures/observe-live-safe.json`
- Create: `shakedown-v2/scripts/matomo-reporting-readback.mjs`
- Create: `shakedown-v2/scripts/search-demand-readback.mjs`
- Create: `shakedown-v2/test/matomo-reporting-readback.test.mjs`
- Create: `shakedown-v2/test/search-demand-readback.test.mjs`
- Modify: `shakedown-v2/scripts/subscriber-funnel-readback.mjs`
- Modify: `shakedown-v2/scripts/subscriber-communications-candidates.mjs`
- Modify: `shakedown-v2/scripts/subscriber-communications-readback.mjs`
- Modify: `shakedown-v2/test/subscriber-funnel-readback.test.mjs`
- Modify: `shakedown-v2/test/subscriber-communications-candidates.test.mjs`
- Modify: `shakedown-v2/test/subscriber-communications-readback.test.mjs`

- [ ] **Step 1: Write failing source-authority, redaction, watermark, and deduplication tests**

```js
test('analytics snapshot distinguishes collection reachability from route metrics', async () => {
  const snapshot = await observe(matomoReachableWithoutReportingDataFixture);
  assert.equal(snapshot.sources.matomo.reachable, true);
  assert.equal(snapshot.sources.matomo.routeMetricsIntegrated, false);
  assert.equal(snapshot.claims.some((claim) => claim.kind === 'traffic_change'), false);
});

test('zero is scoped to the proven route, watermark, filters, and crossing', async () => {
  const result = await funnelReadback(emptyFixture);
  assert.deepEqual(keys(result.evidence), ['canary', 'crossing', 'filters', 'route', 'watermark']);
  assert.equal(result.globalAbsenceClaim, false);
});

test('snapshots and opportunities never contain credentials or direct identifiers', async () => {
  const output = await observe(secretAndIdentityFixture);
  assert.equal(redactionScan(output).length, 0);
});

test('one underlying signal updates one opportunity instead of multiplying it', async () => {
  await ledger.ingest(signalFixture);
  await ledger.ingest(signalFixture);
  assert.equal(ledger.openCount(), 1);
});

test('funnel contradiction circuits only the broken destination and shifts active campaigns', async () => {
  const result = await classifyFunnelContradiction(brokenSubscribePaidEntitlementFixture);
  assert.equal(result.destinationCircuit.target, '/subscribe');
  assert.equal(result.destinationCircuit.status, 'open_for_repair');
  assert.equal(result.campaignEvents.every((event) => event.type === 'destination_shifted'), true);
  assert.equal(result.unaffectedLanes.includes('collection'), true);
  assert.equal(result.unaffectedLanes.includes('observation'), true);
});
```

- [ ] **Step 2: Run in the worker clone — expect FAIL**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/observe.test.mjs \
  ops/shakedown-worker/tests/opportunity-ledger.test.mjs \
  shakedown-v2/test/matomo-reporting-readback.test.mjs \
  shakedown-v2/test/search-demand-readback.test.mjs \
  shakedown-v2/test/subscriber-funnel-readback.test.mjs \
  shakedown-v2/test/subscriber-communications-candidates.test.mjs \
  shakedown-v2/test/subscriber-communications-readback.test.mjs
```

- [ ] **Step 3: Re-verify external authorities read-only before implementing adapters**

Using the official Supabase connection, re-run project/table inventory, exact table grants and RLS policies, and security/performance advisors for project `pkbnsqnkuoifudvbbdbe`. Confirm the current Stripe mode/account alias and Matomo site identity through authenticated readbacks. Compare current Supabase documentation/changelog with the pinned client behavior. Record metadata and redacted counts only; perform no schema, policy, Auth, entitlement, customer, subscription, or payment mutation.

Use the Supabase connector's project-scoped read methods for `pkbnsqnkuoifudvbbdbe`; run `get_advisors` for both `security` and `performance`, and execute only these inventory queries:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema in ('public', 'auth')
order by table_schema, table_name;

select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;

select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

```bash
mkdir -p /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/runs
evidence_root=$(mktemp -d /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/runs/authority-preflight.XXXXXXXX)
chmod 0700 "$evidence_root"
curl -fsS https://supabase.com/changelog.md -o "$evidence_root/supabase-changelog.md"
curl -fsS https://supabase.com/docs/guides/api/securing-your-api.md -o "$evidence_root/supabase-data-api-security.md"
shasum -a 256 "$evidence_root/supabase-changelog.md" "$evidence_root/supabase-data-api-security.md"
```

The adapter must also assert that authorization policies do not rely on `raw_user_meta_data`/`user_metadata`, public views are `security_invoker` or revoked from exposed roles, `UPDATE` policies have ownership-scoped `USING` and `WITH CHECK`, and no service-role credential reaches frontend or model context.

- [ ] **Step 4: Wrap each authority behind fixed read contracts**

- Matomo: Reporting API route/referrer/campaign/event/conversion data with collection and reporting proven separately;
- listener interest: existing API/database-derived aggregate reader, watermark, filter set, and canary crossing;
- Supabase: existing fixed server-side readback paths only, never arbitrary SQL or a model-visible service credential;
- Stripe: restricted read-only customer/subscription/payment-state lookups by opaque internal correlation identifier;
- funnel/communications: wrap current scripts and preserve consent/suppression semantics;
- search/indexing: sitemap, Search Console or configured source, IndexNow receipts, and public index probes;
- operator: public contract checks, API/PM2/watchdog/audio/Caddy state, release journal, and automation inventory.

If a least-privilege runtime read path does not exist, mark the source `unavailable_least_privilege` and create a Jerry-visible setup action; never fall back to a broader credential inside the model runtime.

```js
export const OBSERVATION_READERS = Object.freeze({
  matomo: { reader: readMatomoReport, credentialAlias: 'matomo-reporting-readonly' },
  listenerInterest: { reader: readListenerInterestAggregates, credentialAlias: 'shakedown-api-readonly' },
  supabase: { reader: readSupabaseServerProjection, credentialAlias: 'shakedown-supabase-readonly' },
  stripe: { reader: readStripeCorrelationState, credentialAlias: 'shakedown-stripe-restricted-read' },
  funnel: { reader: readSubscriberFunnel, credentialAlias: 'shakedown-api-readonly' },
  communications: { reader: readCommunicationsSuppression, credentialAlias: 'shakedown-communications-readonly' },
  search: { reader: readSearchDemand, credentialAlias: 'shakedown-search-readonly' },
  operator: { reader: readOperatorState, credentialAlias: 'shakedown-operator-readonly' },
});

export async function readObservationSource(name, input, credentials) {
  const contract = OBSERVATION_READERS[name];
  if (!contract) throw new Error(`Unknown observation source: ${name}`);
  const credential = await credentials.resolveLeastPrivilege(contract.credentialAlias);
  if (!credential) return { status: 'unavailable_least_privilege', source: name };
  return redactObservation(await contract.reader(input, credential));
}
```

- [ ] **Step 5: Make snapshots point-in-time and comparable**

Every source includes authority, retrieved-at time, reporting window, timezone, route, watermark, filters, pagination/crossing proof, freshness, uncertainty, and artifact hash. Calculate derived metrics only from compatible windows and identities. Preserve raw redacted source artifacts for audit.

```js
export function snapshotSource(input) {
  return Object.freeze({
    authority: input.authority,
    retrievedAt: new Date(input.retrievedAt).toISOString(),
    window: { start: input.window.start, end: input.window.end },
    timezone: input.timezone,
    route: input.route,
    watermark: input.watermark,
    filters: [...input.filters].sort(),
    pagination: { pages: input.pagination.pages, crossingProof: input.pagination.crossingProof },
    freshnessSeconds: input.freshnessSeconds,
    uncertainty: input.uncertainty,
    artifactSha256: input.artifactSha256,
  });
}

export function comparable(left, right) {
  return left.authority === right.authority
    && left.timezone === right.timezone
    && left.window.start === right.window.start
    && left.window.end === right.window.end
    && canonicalJson(left.filters) === canonicalJson(right.filters);
}
```

- [ ] **Step 6: Implement the durable opportunity ledger**

Normalize signals into typed opportunity/campaign state events with stable identity, evidence links, audience need, proposed lane, expected consequence, confidence, effort, reversibility, authority requirement, cooldown, status, owner, and retirement reason. The adapter does not own a mutable canonical ledger: Home23 Task 5 transactionally appends these events and projects worker state. Score source-backed visitor/listener usefulness above output volume. Merge correlated signals and prevent a worker-generated artifact from recursively becoming a new opportunity without external evidence.

```js
export function toOpportunityEvent(signal) {
  if (signal.originWorker === 'shakedown-jerry' && signal.externalEvidence.length === 0) {
    throw new Error('worker artifact cannot self-create an opportunity');
  }
  return {
    schema: 'home23.worker-opportunity-event.v1',
    type: 'opportunity_observed',
    opportunityId: sha256(canonicalJson({ audienceNeed: signal.audienceNeed, lane: signal.lane, target: signal.target })),
    evidence: signal.externalEvidence.map(({ uri, sha256: hash }) => ({ uri, sha256: hash })),
    audienceNeed: signal.audienceNeed,
    lane: signal.lane,
    expectedConsequence: signal.expectedConsequence,
    confidence: signal.confidence,
    effort: signal.effort,
    reversible: signal.reversible,
    authorityRequirement: signal.authorityRequirement,
    cooldownUntil: signal.cooldownUntil,
    status: 'open',
    owner: 'shakedown-jerry',
    retirementReason: null,
  };
}

await home23StateEvents.appendOpportunity(toOpportunityEvent(signal));
```

- [ ] **Step 7: Detect funnel contradictions and shift campaigns away from broken destinations**

Compare Matomo journey evidence with Supabase/Stripe/entitlement authority. When route reachability, checkout, webhook, pending activation, paid access, or entitlement disagree, emit a lane-local destination circuit and repair opportunity; move active campaigns to a verified alternate destination or pause that destination while repair proceeds. Preserve unaffected content, collection, enrichment, and observation lanes. Record old/new destinations, evidence, uncertainty, and readback obligation.

```js
export function classifyFunnelContradiction(funnel) {
  const inconsistent = funnel.route.reachable
    && (funnel.checkout.completed !== funnel.stripe.paymentSucceeded
      || funnel.stripe.paymentSucceeded !== funnel.entitlement.active
      || funnel.webhook.accepted !== funnel.pendingActivation.resolved);
  if (!inconsistent) return { status: 'consistent', campaignEvents: [] };
  const alternate = funnel.verifiedAlternateDestinations.find((target) => target.readback === 'verified');
  return {
    status: 'contradiction',
    destinationCircuit: { target: funnel.destination, status: 'open_for_repair' },
    repairOpportunity: toOpportunityEvent(funnel.repairSignal),
    campaignEvents: funnel.activeCampaignIds.map((campaignId) => ({
      schema: 'home23.worker-campaign-event.v1',
      type: 'destination_shifted',
      campaignId,
      oldDestination: funnel.destination,
      newDestination: alternate?.target ?? null,
      status: alternate ? 'active' : 'paused_destination_repair',
      evidence: funnel.evidence,
      uncertainty: funnel.uncertainty,
      readbackDueAt: funnel.readbackDueAt,
    })),
    unaffectedLanes: ['content', 'collection', 'enrichment', 'observation'],
  };
}
```

- [ ] **Step 8: Run tests and a real read-only snapshot — expect PASS**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/observe.test.mjs \
  ops/shakedown-worker/tests/opportunity-ledger.test.mjs \
  shakedown-v2/test/matomo-reporting-readback.test.mjs \
  shakedown-v2/test/search-demand-readback.test.mjs \
  shakedown-v2/test/subscriber-funnel-readback.test.mjs \
  shakedown-v2/test/subscriber-communications-candidates.test.mjs \
  shakedown-v2/test/subscriber-communications-readback.test.mjs
node ops/shakedown-worker/scripts/run-capability.mjs shakedown.observe \
  --input ops/shakedown-worker/tests/fixtures/observe-live-safe.json
```

- [ ] **Step 9: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/schemas/opportunity.v1.schema.json \
  ops/shakedown-worker/schemas/analytics-snapshot.v1.schema.json \
  ops/shakedown-worker/lib/observe.mjs ops/shakedown-worker/lib/matomo-readback.mjs \
  ops/shakedown-worker/lib/funnel-readback.mjs ops/shakedown-worker/lib/search-demand.mjs \
  ops/shakedown-worker/lib/payment-readback.mjs ops/shakedown-worker/lib/operator-readback.mjs \
  ops/shakedown-worker/lib/opportunity-ledger.mjs \
  ops/shakedown-worker/tests/observe.test.mjs \
  ops/shakedown-worker/tests/opportunity-ledger.test.mjs \
  ops/shakedown-worker/tests/fixtures/observe-live-safe.json \
  shakedown-v2/scripts/matomo-reporting-readback.mjs \
  shakedown-v2/scripts/search-demand-readback.mjs \
  shakedown-v2/test/matomo-reporting-readback.test.mjs \
  shakedown-v2/test/search-demand-readback.test.mjs \
  shakedown-v2/scripts/subscriber-funnel-readback.mjs \
  shakedown-v2/scripts/subscriber-communications-candidates.mjs \
  shakedown-v2/scripts/subscriber-communications-readback.mjs \
  shakedown-v2/test/subscriber-funnel-readback.test.mjs \
  shakedown-v2/test/subscriber-communications-candidates.test.mjs \
  shakedown-v2/test/subscriber-communications-readback.test.mjs
git commit -m "feat(worker): observe growth and trust signals"
```

---

## Task 20: Reconcile acquisition analytics and build source-backed discovery surfaces

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 19 observations/opportunities, canonical catalog data, and Task 18 runner/receipt boundary.
- Produces: reconciled funnel instrumentation, source-backed show/venue/year/date/song/lineup/lineage routes, JSON-LD/frontmatter/RSS/sitemap artifacts, and typed idempotent `shakedown.indexing` receipts.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Modify: `shakedown-v2/src/services/analytics.js`
- Modify: `shakedown-v2/src/components/AnalyticsRouteTracker.jsx`
- Modify: `shakedown-v2/public/start/index.html`
- Modify: `shakedown-v2/src/main.jsx`
- Modify: `shakedown-v2/src/context/AudioContext.jsx`
- Modify: `shakedown-v2/src/context/AuthContext.jsx`
- Modify: `shakedown-v2/src/pages/BrowsePage.jsx`
- Modify: `shakedown-v2/src/pages/ShowPage.jsx`
- Modify: `shakedown-v2/src/pages/SubscribePage.jsx`
- Modify: `shakedown-v2/src/App.jsx`
- Create: `shakedown-v2/src/pages/VenuePage.jsx`
- Create: `shakedown-v2/src/pages/YearPage.jsx`
- Create: `shakedown-v2/src/pages/DatePage.jsx`
- Create: `shakedown-v2/src/pages/SongPage.jsx`
- Create: `shakedown-v2/src/pages/LineupPage.jsx`
- Create: `shakedown-v2/src/pages/LineagePage.jsx`
- Create: `shakedown-v2/src/utils/discoveryRoutes.js`
- Create: `shakedown-v2/scripts/build-discovery-routes.mjs`
- Create: `ops/shakedown-worker/lib/indexing.mjs`
- Create: `ops/shakedown-worker/tests/indexing.test.mjs`
- Modify: `shakedown-v2/scripts/build-article-pages.mjs`
- Modify: `shakedown-v2/scripts/build-newsletter-pages.mjs`
- Modify: `shakedown-v2/scripts/submit-indexnow.mjs`
- Modify: `shakedown-v2/package.json`
- Modify: `shakedown-v2/test/analytics.test.mjs`
- Create: `shakedown-v2/test/discovery-route-generator.test.mjs`
- Create: `shakedown-v2/test/generated-route-browser.test.mjs`
- Create: `shakedown-v2/test/sitemap.test.mjs`
- Create: `shakedown-v2/test/discovery-metadata.test.mjs`

- [ ] **Step 1: Write failing analytics, route parity, quality, and sitemap tests**

```js
test('all root routes emit exactly one normalized page view', async () => {
  for (const route of publicRouteFixtures) {
    const events = await renderAndNavigate(route);
    assert.equal(events.filter(isPageView).length, 1, route);
  }
});

test('tracking failures cannot block load, navigation, signup, or playback', async () => {
  injectThrowingTrackers();
  await assert.doesNotReject(() => completeCoreJourney());
});

test('every indexed generated route has unique source-backed value and a working app route', async () => {
  for (const route of await indexedGeneratedRoutes()) {
    assert.equal(route.canonicalIdentityVerified, true);
    assert.equal(route.uniqueEvidence.length > 0, true);
    assert.equal((await browserStatus(route.url)), 200);
  }
});

test('sitemap entries equal the complete eligible generated route set', async () => {
  assert.deepEqual(await sitemapUrls(), await eligibleCanonicalUrls());
});

test('show, venue, year, date, song, lineup, and lineage classes use representative catalog evidence', async () => {
  const routes = await buildDiscoveryRoutes(representativeJerryCatalog);
  assert.deepEqual(new Set(routes.map((route) => route.kind)),
    new Set(['show', 'venue', 'year', 'date', 'song', 'lineup', 'lineage']));
  assert.equal(routes.every(hasCanonicalUniqueValueInternalLinksAndVerifiedDestination), true);
});

test('generated metadata has canonical, frontmatter provenance, JSON-LD, Open Graph, and RSS parity', async () => {
  const artifact = await renderRepresentativeDiscoveryArtifact();
  assert.equal(artifact.frontmatter.sourceHashes.length > 0, true);
  assert.equal(artifact.html.canonical, artifact.route.canonicalUrl);
  assert.equal(artifact.html.jsonLd.url, artifact.route.canonicalUrl);
  assert.equal(artifact.rss.guid, artifact.route.canonicalUrl);
});

test('typed indexing adapter batches complete changed URLs idempotently and requires readback', async () => {
  const first = await indexing.submit(indexingFixture);
  const second = await indexing.submit(indexingFixture);
  assert.equal(first.batches.every((batch) => batch.urls.length <= configuredBatchLimit), true);
  assert.equal(second.status, 'reused_idempotent_submission');
  assert.equal(first.semanticStatus, 'readback_pending');
  assert.equal(indexingCallsOutsideCapabilityExecutor, 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 shakedown-v2/test/*.test.mjs
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/indexing.test.mjs \
  shakedown-v2/test/analytics.test.mjs \
  shakedown-v2/test/discovery-route-generator.test.mjs \
  shakedown-v2/test/generated-route-browser.test.mjs \
  shakedown-v2/test/sitemap.test.mjs \
  shakedown-v2/test/discovery-metadata.test.mjs
```

- [ ] **Step 3: Make acquisition analytics canonical in source**

Finish the commit `4f0dbb9` reconciliation, preserve the public globals `trackPageView`, `trackShowView`, `trackEvent`, `trackEmailSignup`, `trackUTMParameters`, and `trackTwitterEvent`, and normalize route, show, play-intent, successful-play, signup-start, signup-complete, checkout-start, checkout-return, entitlement-active, campaign, referrer, and UTM events. Track only after authoritative outcomes; strip direct identifiers; fail open for the product and fail visibly in diagnostics.

```js
const NORMALIZED_EVENTS = Object.freeze(new Set([
  'page_view', 'show_view', 'play_intent', 'successful_play',
  'signup_start', 'signup_complete', 'checkout_start', 'checkout_return',
  'entitlement_active', 'campaign_touch', 'referrer_touch', 'utm_touch',
]));

function safeTrack(event, properties = {}) {
  try {
    if (!NORMALIZED_EVENTS.has(event)) throw new Error(`Unknown analytics event: ${event}`);
    const payload = stripDirectIdentifiers(properties);
    window._paq?.push(['trackEvent', 'Shakedown', event, JSON.stringify(payload)]);
  } catch (error) {
    window.dispatchEvent(new CustomEvent('shakedown:analytics-error', {
      detail: { event, message: String(error?.message || error) },
    }));
  }
}

export function installTrackingGlobals(target = window) {
  target.trackPageView = (title, path) => safeTrack('page_view', { title, path });
  target.trackShowView = (showId, date, venue) => safeTrack('show_view', { showId, date, venue });
  target.trackEvent = (category, action, label, value) => safeTrack(normalizeLegacyEvent(category, action), { label, value });
  target.trackEmailSignup = (source) => safeTrack('signup_complete', { source });
  target.trackUTMParameters = () => safeTrack('utm_touch', readAllowedUtmParameters(location.href));
  target.trackTwitterEvent = (event, properties) => safelyTrackTwitter(event, stripDirectIdentifiers(properties));
}
```

- [ ] **Step 4: Implement all evidence-backed discovery route classes**

Reuse the existing `/show/:id` route and add `/venue/:venue`, `/year/:year`, `/date/:monthDay`, `/song/:song`, `/lineup/:lineup`, and `/lineage/:lineage`. Use the canonical Jerry dataset and API response contracts, not invented copy. Each page provides a stable canonical identity, accurate counts, internally linked playable show cards, useful context derived from source records, empty/error states, and mobile behavior. Lineup and lineage identities come only from source-backed normalized relationships; they are not model-invented groupings. Preserve all existing root routes and fallback behavior.

```js
export const DISCOVERY_ROUTE_DEFINITIONS = Object.freeze([
  { kind: 'show', path: '/show/:id', identity: (show) => show.show_id },
  { kind: 'venue', path: '/venue/:venue', identity: (show) => normalizeVenue(show.venue) },
  { kind: 'year', path: '/year/:year', identity: (show) => show.date.slice(0, 4) },
  { kind: 'date', path: '/date/:monthDay', identity: (show) => show.date.slice(5) },
  { kind: 'song', path: '/song/:song', identity: (_show, song) => normalizeSong(song) },
  { kind: 'lineup', path: '/lineup/:lineup', identity: (show) => normalizedSourceLineup(show) },
  { kind: 'lineage', path: '/lineage/:lineage', identity: (show) => normalizedSourceLineage(show) },
]);

export function buildDiscoveryRoutes(catalog) {
  return DISCOVERY_ROUTE_DEFINITIONS.flatMap((definition) =>
    groupSourceRecords(catalog, definition).map((group) => ({
      kind: definition.kind,
      identity: group.identity,
      canonicalUrl: canonicalDiscoveryUrl(definition.kind, group.identity),
      sourceHashes: group.records.map((record) => record.sourceSha256).sort(),
      shows: group.records.map(toPlayableShowCard),
      internalLinks: sourceBackedInternalLinks(group.records),
      uniqueEvidence: uniqueSourceEvidence(group.records),
    })));
}
```

- [ ] **Step 5: Gate generated discovery content by evidence quality**

Build a route only when canonical identity, unique source-backed value beyond a catalog row, verified destination, and internal links all pass. Emit `noindex` or omit candidates that fail. Article/newsletter/discovery builders consume the same eligibility function and add validated frontmatter provenance, canonical URL, JSON-LD, Open Graph/Twitter metadata, RSS entry, freshness, and source links without fabricated claims.

```js
export function discoveryEligibility(route) {
  const failures = [];
  if (!route.identity || !route.canonicalUrl) failures.push('canonical_identity');
  if (!Array.isArray(route.uniqueEvidence) || route.uniqueEvidence.length === 0) failures.push('unique_source_value');
  if (route.destinationReadback !== 'verified') failures.push('verified_destination');
  if (!Array.isArray(route.internalLinks) || route.internalLinks.length === 0) failures.push('internal_links');
  return Object.freeze({ eligible: failures.length === 0, failures });
}

export function discoveryMetadata(route) {
  const eligibility = discoveryEligibility(route);
  return {
    robots: eligibility.eligible ? 'index,follow' : 'noindex,follow',
    canonical: route.canonicalUrl,
    frontmatter: { sourceHashes: route.sourceHashes, generatedAt: route.generatedAt },
    jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', url: route.canonicalUrl, name: route.title },
    openGraph: { url: route.canonicalUrl, title: route.title, description: route.sourceBackedSummary },
    twitter: { card: 'summary_large_image', title: route.title, description: route.sourceBackedSummary },
    rss: { guid: route.canonicalUrl, link: route.canonicalUrl, pubDate: route.generatedAt },
  };
}
```

- [ ] **Step 6: Rebuild sitemap and IndexNow inputs from the complete canonical set**

Replace stale hard-coded dates and advertised-but-unroutable pages. Generate sitemap index/parts and RSS deterministically. `shakedown.indexing` accepts only the generated complete changed canonical URL manifest, batches it to the configured fixed limit, submits through the declared IndexNow host/account, persists idempotency/request/response hashes, and schedules index-state readbacks. No model or script calls `submit-indexnow.mjs` directly, and submission acceptance never becomes an indexing claim.

```js
export async function submitIndexingManifest(input, context) {
  assert.equal(input.schema, 'home23.shakedown-indexing-manifest.v1');
  assert.equal(input.completeCanonicalSetSha256, sha256(canonicalJson(input.completeCanonicalUrls)));
  const changed = input.changedCanonicalUrls.filter((url) => input.completeCanonicalUrls.includes(url));
  if (changed.length !== input.changedCanonicalUrls.length) throw new Error('changed URL outside complete canonical set');
  const batches = chunk(changed.slice().sort(), context.fixedBatchLimit);
  const results = [];
  for (const urls of batches) {
    const requestSha256 = sha256(canonicalJson({ host: 'www.shakedownshuffle.com', urls }));
    results.push(await context.indexNowAdapter.submitFixedBatch({
      host: 'www.shakedownshuffle.com', accountAlias: 'shakedown-indexnow', urls, requestSha256,
    }));
  }
  return {
    status: 'accepted',
    semanticStatus: 'readback_pending',
    batches: results,
    readbackDueAt: input.readbackDueAt,
  };
}
```

- [ ] **Step 7: Run frontend, browser, and build gates with an isolated output — expect PASS**

```bash
node --test --test-concurrency=1 shakedown-v2/test/*.test.mjs
npm --prefix shakedown-v2 run lint
mkdir -p /Users/jtr/_JTR23_/worker-artifacts
build_dir=$(mktemp -d /Users/jtr/_JTR23_/worker-artifacts/shakedown-discovery.XXXXXXXX)
npm --prefix shakedown-v2 run build -- --outDir "$build_dir"
chmod -R a-w "$build_dir"
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/indexing.test.mjs \
  shakedown-v2/test/analytics.test.mjs \
  shakedown-v2/test/discovery-route-generator.test.mjs \
  shakedown-v2/test/generated-route-browser.test.mjs \
  shakedown-v2/test/sitemap.test.mjs \
  shakedown-v2/test/discovery-metadata.test.mjs
```

- [ ] **Step 8: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  shakedown-v2/public/start/index.html shakedown-v2/package.json \
  shakedown-v2/src/App.jsx shakedown-v2/src/main.jsx \
  shakedown-v2/src/components/AnalyticsRouteTracker.jsx \
  shakedown-v2/src/context/AudioContext.jsx shakedown-v2/src/context/AuthContext.jsx \
  shakedown-v2/src/pages/BrowsePage.jsx shakedown-v2/src/pages/ShowPage.jsx \
  shakedown-v2/src/pages/SubscribePage.jsx shakedown-v2/src/pages/VenuePage.jsx \
  shakedown-v2/src/pages/YearPage.jsx shakedown-v2/src/pages/DatePage.jsx \
  shakedown-v2/src/pages/SongPage.jsx shakedown-v2/src/pages/LineupPage.jsx \
  shakedown-v2/src/pages/LineagePage.jsx shakedown-v2/src/services/analytics.js \
  shakedown-v2/src/utils/discoveryRoutes.js \
  shakedown-v2/scripts/build-discovery-routes.mjs \
  shakedown-v2/scripts/build-article-pages.mjs \
  shakedown-v2/scripts/build-newsletter-pages.mjs shakedown-v2/scripts/submit-indexnow.mjs \
  shakedown-v2/test/analytics.test.mjs shakedown-v2/test/discovery-route-generator.test.mjs \
  shakedown-v2/test/generated-route-browser.test.mjs shakedown-v2/test/sitemap.test.mjs \
  shakedown-v2/test/discovery-metadata.test.mjs \
  ops/shakedown-worker/lib/indexing.mjs ops/shakedown-worker/tests/indexing.test.mjs
git diff --cached --check
node ops/shakedown-worker/scripts/scan-staged-source.mjs --deny-secrets --deny-pii --deny-generated
git commit -m "feat(acquisition): add truthful discovery and analytics"
```

---

## Task 21: Implement immutable site candidates, full public-contract verification, and automatic rollback

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 18 authenticated runner and Task 20 tested build/indexing manifest.
- Produces: immutable site-release candidates, preservation/overlay journal, complete public-contract verifier, rollback implementation, and preactivation staged-only release receipts.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/lib/site-release.mjs`
- Create: `ops/shakedown-worker/lib/rollback.mjs`
- Create: `ops/shakedown-worker/scripts/build-site-candidate.mjs`
- Create: `ops/shakedown-worker/scripts/verify-public-contract.mjs`
- Create: `ops/shakedown-worker/tests/site-release.test.mjs`
- Create: `ops/shakedown-worker/tests/public-contract.test.mjs`
- Create: `ops/shakedown-worker/tests/fixtures/live-webroot/env-config.js`
- Create: `ops/shakedown-worker/tests/fixtures/live-webroot/pro/index.html`
- Modify: `ops/shakedown-worker/config/live-only-artifacts.v1.json`
- Modify: `shakedown-v2/scripts/operator-check.mjs`

- [ ] **Step 1: Write failing preserve, contract, cutover, crash, and rollback tests**

```js
test('candidate overlays controlled assets and preserves every live-only artifact', async () => {
  const result = await buildCandidate(releaseFixture);
  assert.deepEqual(result.preservedHashes, baselineLiveOnlyHashes);
  assert.equal(result.sharedDistTouched, false);
});

test('any public contract failure blocks or rolls back cutover', async () => {
  const result = await publish(injectedRouteFailureFixture);
  assert.equal(result.status, 'rolled_back');
  assert.equal(await liveTreeHash(), preCutoverTreeHash);
});

test('restart at every journal transition recovers to known live truth', async () => {
  for (const transition of siteReleaseTransitions) {
    await assertCrashRecovery(transition);
  }
});

test('production outputs allow only new release descendants, never live or source descendants', async () => {
  await assert.doesNotReject(() => assertNewConfinedOutput(newReleaseCandidate, productionReleasePolicy));
  for (const target of [liveHtmlTarget, sharedDistTarget, frontendSourceTarget, backendSourceTarget, existingReleaseTarget]) {
    await assert.rejects(() => assertNewConfinedOutput(target, productionReleasePolicy), /protected|existing|outside/i);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/site-release.test.mjs \
  ops/shakedown-worker/tests/public-contract.test.mjs
```

- [ ] **Step 3: Build immutable candidates without touching public build roots**

Build to a run-specific directory, start candidate materialization from the current live tree, overlay only candidate-controlled files, and verify the complete live-only allowlist. Create immutable pre-cutover and candidate directories beneath the executor-resolved output authority—exactly `/Users/jtr/websites/shakedownshuffle.com/releases` for production or the test runner's fresh fixture root—hash manifests, and fsync journals. Reject `html`, `html/pro`, shared `shakedown-v2/dist`, source trees, existing targets, or any path outside that exact resolved output authority. The operator checkout is not blanket-denied because its `releases` subtree is the required release authority; every other source/live subtree remains denied.

```js
export async function buildCandidate({ allowedOutputRoot, liveRoot, buildRoot, preCutoverRoot, candidateRoot, liveOnlyPaths }) {
  await assertExistingImmutableBuildOutsideProtectedRoots(buildRoot, [
    '/Users/jtr/websites/shakedownshuffle.com/html',
    '/Users/jtr/websites/shakedownshuffle.com/html/pro',
    '/Users/jtr/websites/shakedownshuffle.com/shakedown-v2/dist',
    '/Users/jtr/websites/shakedownshuffle.com',
  ]);
  const deniedOutputRoots = [
    '/Users/jtr/websites/shakedownshuffle.com/html',
    '/Users/jtr/websites/shakedownshuffle.com/shakedown-v2',
    '/Users/jtr/websites/shakedownshuffle.com/jerry-api',
    '/Users/jtr/websites/shakedownshuffle.com/ops',
  ];
  for (const output of [preCutoverRoot, candidateRoot]) {
    await assertNewConfinedOutput(output, {
      allowedOutputRoot,
      deniedRoots: deniedOutputRoots,
      requireNonexistent: true,
      forbidSymlinkComponents: true,
    });
  }
  const liveOnlyBefore = await hashExactPaths(liveRoot, liveOnlyPaths);
  await copyTreeFsync(liveRoot, preCutoverRoot);
  await copyTreeFsync(liveRoot, candidateRoot);
  await overlayTreeFsync(buildRoot, candidateRoot, { denyOverwrite: new Set(liveOnlyPaths) });
  const liveOnlyAfter = await hashExactPaths(candidateRoot, liveOnlyPaths);
  if (canonicalJson(liveOnlyAfter) !== canonicalJson(liveOnlyBefore)) {
    throw new Error('live-only artifact changed during candidate overlay');
  }
  const manifest = await hashTree(candidateRoot);
  await chmodTreeReadOnly(candidateRoot);
  return { manifest, preservedHashes: liveOnlyAfter, sharedDistTouched: false };
}
```

Use these exact live-only fixture artifacts so the staged exercise proves preservation rather than verifying an empty candidate:

```js
window.ENV_CONFIG = Object.freeze({
  API_URL: 'http://127.0.0.1:3005/api/v1',
  AUDIO_URL: 'http://127.0.0.1:18089',
  ENVIRONMENT: 'staged-fixture',
});
```

```html
<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Preserved Pro Fixture</title></head>
<body><main data-live-only="pro">Preserved Pro fixture</main></body></html>
```

- [ ] **Step 4: Verify the full public contract matrix before cutover**

Check `/`, `/today`, `/favorites`, `/recent`, `/now`, `/account`, a real `/show/:id`, a real `/venue/:venue`, a real `/year/:year`, `/stats`, `/about`, `/auth/forgot-password`, `/auth/reset-password`, `/start`, and `/newsletter`; `/api/v1/shows`, `/api/v1/search`, `/api/v1/audio/{showId}/{trackIndex}`, `/api/v1/user/favorites`, and `/api/v1/user/history`; mapped JSON, peaks, branding, and icons; `window.ENV_CONFIG`; all tracking globals; `window.jerryPlayer`, `window.ensureJerryPlayer`, and `jerry:player`. Absence of the owned signed-in entitlement fixture is a cutover blocker. Browser acceptance must prove signed-out playback denial, signed-in audio delivery and play/pause/seek, duration/remaining display, now-playing behavior, navigation during playback, mobile layout, no uncaught console errors, and continued load/navigation/signup/playback when every tracker throws. Verify canonical-host redirect and prove `v2.shakedownshuffle.com` remains byte-identical.

```js
export const PUBLIC_CONTRACT = Object.freeze({
  routes: ['/', '/today', '/favorites', '/recent', '/now', '/account', '/stats', '/about',
    '/auth/forgot-password', '/auth/reset-password', '/start', '/newsletter'],
  parameterizedRoutes: ['/show/:id', '/venue/:venue', '/year/:year'],
  api: ['/api/v1/shows', '/api/v1/search', '/api/v1/audio/:showId/:trackIndex',
    '/api/v1/user/favorites', '/api/v1/user/history'],
  assets: ['/jerrydatabasemaster_mapped.json', '/peaks/', '/branding/', '/icons/'],
  globals: ['ENV_CONFIG', 'trackPageView', 'trackShowView', 'trackEvent', 'trackEmailSignup',
    'trackUTMParameters', 'trackTwitterEvent', 'jerryPlayer', 'ensureJerryPlayer'],
  event: 'jerry:player',
});

export async function verifySignedInPlayback(page, entitlementFixture) {
  if (!entitlementFixture?.owned || entitlementFixture.status !== 'active') {
    throw new Error('owned signed-in entitlement fixture required');
  }
  await page.addInitScript(entitlementFixture.browserSessionScript);
  await page.goto(entitlementFixture.showUrl);
  await page.getByRole('button', { name: 'Listen Now' }).click();
  await expect.poll(() => page.evaluate(() => window.jerryPlayer?.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('slider').fill('15');
  await assertDurationRemainingAndNowPlaying(page);
}
```

- [ ] **Step 5: Cut over with an explicit journal and verifier reserve**

Journal `prepared -> snapshotted -> built -> tested -> cutover -> verifying -> committed`, fsyncing every state. Only the dedicated publisher can write the live tree. Reserve finite non-model budget for verifier and rollback. A failed or uncertain verifier immediately enters rollback; no model decision is needed.

```js
const SITE_RELEASE_TRANSITIONS = Object.freeze({
  prepared: 'snapshotted',
  snapshotted: 'built',
  built: 'tested',
  tested: 'cutover',
  cutover: 'verifying',
  verifying: 'committed',
});

export async function advanceSiteRelease(journal, expected, next, evidence) {
  if (SITE_RELEASE_TRANSITIONS[expected] !== next) throw new Error(`Invalid site release transition: ${expected} -> ${next}`);
  await journal.compareAndAppend({ expected, next, evidenceSha256: sha256(canonicalJson(evidence)) });
  await journal.fsync();
}

export async function finishVerification(context) {
  const verification = await withDeadline(context.verifier(), context.verifierBudgetMs);
  if (verification.status !== 'passed') return context.rollback.restorePredecessor(verification);
  return advanceSiteRelease(context.journal, 'verifying', 'committed', verification);
}
```

- [ ] **Step 6: Exercise the publisher and rollback only against an isolated staged webroot**

Point the publisher at a temporary fixture webroot with the same tree/layout/permissions contract as production. Cut over a byte-equivalent known-good candidate, inject a verifier failure, and prove automatic restoration to the fixture predecessor. Repeat with process restart during the journal. Do not write `/Users/jtr/websites/shakedownshuffle.com/html`; the real byte-equivalent rollback exercise occurs under standing authority in Task 31.

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='byte-equivalent|verifier failure|restart during journal' \
  ops/shakedown-worker/tests/site-release.test.mjs
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --verify-operator-invariant \
  --operator-root /Users/jtr/websites/shakedownshuffle.com \
  --state-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/state
```

- [ ] **Step 7: Run tests and staged acceptance — expect PASS**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/site-release.test.mjs \
  ops/shakedown-worker/tests/public-contract.test.mjs
mkdir -p /Users/jtr/_JTR23_/worker-artifacts
artifact_parent=$(mktemp -d /Users/jtr/_JTR23_/worker-artifacts/shakedown-site-staged.XXXXXXXX)
build_root="$artifact_parent/frontend-build"
fixture_live="$artifact_parent/live-fixture"
site_candidate="$artifact_parent/candidate"
precutover="$artifact_parent/pre-cutover"
test ! -e "$build_root" && test ! -e "$fixture_live" && test ! -e "$site_candidate" && test ! -e "$precutover"
mkdir "$fixture_live"
rsync -a ops/shakedown-worker/tests/fixtures/live-webroot/ "$fixture_live/"
npm --prefix shakedown-v2 run build -- --outDir "$build_root"
node ops/shakedown-worker/scripts/build-site-candidate.mjs \
  --allowed-output-root "$artifact_parent" \
  --build-root "$build_root" \
  --live-root "$fixture_live" \
  --pre-cutover-root "$precutover" \
  --candidate-root "$site_candidate" \
  --live-only-config ops/shakedown-worker/config/live-only-artifacts.v1.json
cmp "$fixture_live/env-config.js" "$site_candidate/env-config.js"
cmp "$fixture_live/pro/index.html" "$site_candidate/pro/index.html"
node ops/shakedown-worker/scripts/verify-public-contract.mjs \
  --target "$site_candidate"
npm --prefix shakedown-v2 run check:operator -- \
  --artifact-root "$site_candidate" --no-live-mutation
```

- [ ] **Step 8: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/lib/site-release.mjs \
  ops/shakedown-worker/lib/rollback.mjs \
  ops/shakedown-worker/scripts/build-site-candidate.mjs \
  ops/shakedown-worker/scripts/verify-public-contract.mjs \
  ops/shakedown-worker/tests/site-release.test.mjs \
  ops/shakedown-worker/tests/public-contract.test.mjs \
  ops/shakedown-worker/tests/fixtures/live-webroot/env-config.js \
  ops/shakedown-worker/tests/fixtures/live-webroot/pro/index.html \
  ops/shakedown-worker/config/live-only-artifacts.v1.json \
  shakedown-v2/scripts/operator-check.mjs
git diff --cached --check
git commit -m "feat(release): make site publication recoverable"
```

---

## Task 22: Implement safe source integration, backend releases, scoped restart, and predecessor rollback

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 18 runner, Task 21 release journal, Task 5 action/lock state, and Task 16 reconciled source authority.
- Produces: dedicated-ref source integration, immutable backend releases, fixed-target PM2/Caddy/audio-static controls, stable data-authority migration, shared watchdog/audio recovery locks, and predecessor rollback/readback.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/lib/code-integration.mjs`
- Create: `ops/shakedown-worker/lib/backend-release.mjs`
- Modify: `ops/shakedown-worker/lib/runtime.mjs`
- Create: `ops/shakedown-worker/lib/caddy-runtime.mjs`
- Create: `ops/shakedown-worker/lib/data-authority.mjs`
- Create: `ops/shakedown-worker/scripts/prepare-data-authority.mjs`
- Create: `ops/shakedown-worker/tests/code-integration.test.mjs`
- Create: `ops/shakedown-worker/tests/backend-release.test.mjs`
- Create: `ops/shakedown-worker/tests/runtime.test.mjs`
- Create: `ops/shakedown-worker/tests/caddy-runtime.test.mjs`
- Create: `ops/shakedown-worker/tests/data-authority-integration.test.mjs`
- Modify: `ops/shakedown-watchdog/lib/watchdog-core.mjs`
- Modify: `ops/shakedown-watchdog/check-shakedown-health.mjs`
- Modify: `ops/shakedown-watchdog/test/watchdog-core.test.mjs`
- Create: `ops/shakedown-watchdog/test/check-shakedown-health.test.mjs`
- Modify: `ops/jerry-collection/config.json`
- Modify: `jerry-api/src/database/shows.repository.ts`
- Create: `jerry-api/tests/data-authority.test.ts`

- [ ] **Step 1: Write failing ref-scope, operator-invariance, release, restart, and rollback tests**

```js
test('integration updates only the dedicated canonical ref', async () => {
  const before = await captureAllRefsAndOperatorState();
  await integrate(candidateCommit);
  const after = await captureAllRefsAndOperatorState();
  assert.deepEqual(changedRefs(before, after), [dedicatedCanonicalRef]);
  assert.deepEqual(after.operatorCheckout, before.operatorCheckout);
  assert.equal(after.remotePushes.length, 0);
});

test('first integration imports an unreachable clone commit before creating the dedicated ref', async () => {
  assert.equal(await commitReachable(operatorRepository, candidateCommit), false);
  assert.equal(await resolveRefOrNull(operatorRepository, dedicatedCanonicalRef), null);
  const result = await integrate(candidateCommit);
  assert.equal(result.previous, null);
  assert.equal(result.current, candidateCommit);
  assert.equal(await commitReachable(operatorRepository, candidateCommit), true);
  assert.deepEqual(await refsUnder(operatorRepository, 'refs/codex-import/'), []);
});

test('bundle hash, imported tip, ancestry, and patch identity all precede ref update', async () => {
  for (const fixture of [tamperedBundle, wrongTipBundle, wrongBaseBundle, wrongPatchIdentityBundle]) {
    await assert.rejects(() => integrate(fixture), /bundle|commit|ancestor|patch identity/i);
  }
  assert.equal(await resolveRefOrNull(operatorRepository, dedicatedCanonicalRef), null);
});

test('backend release uses immutable directories and restores predecessor on failed canary', async () => {
  const result = await deployBackend(injectedCanaryFailureFixture);
  assert.equal(result.status, 'rolled_back');
  assert.equal(await activeBackendRelease(), predecessorRelease);
});

test('backend materialization is atomic, convergent, and self-contained', async () => {
  for (const failpoint of backendMaterializationFailpoints) {
    await assert.rejects(() => materializeBackendRelease({ ...fixture, failpoint }), /injected/i);
    assert.equal(await finalReleasePathExists(fixture.sourceCommit), false);
  }
  const first = await materializeBackendRelease(fixture);
  const second = await materializeBackendRelease(fixture);
  assert.equal(second.status, 'reused');
  assert.equal(second.treeSha256, first.treeSha256);
  await assert.rejects(() => bootWithMissingOrTamperedDependency(first), /dependency|integrity/i);
});

test('worker and watchdog serialize jerry-api recovery under one lock', async () => {
  const results = await Promise.all([workerRecover(), watchdogRecover()]);
  assert.equal(results.filter((result) => result.restarted).length, 1);
});

test('audio-static recovery uses only the retained launchd owner and fixed canary', async () => {
  const result = await runtime.recover({
    service: 'shakedown-audio-static',
    canaryPath: pinnedAudioCanaryPath,
  });
  assert.equal(result.owner, 'com.jtr.caddy-static');
  assert.equal(result.lock, 'shakedown-audio-static-recovery');
  assert.equal(result.port, 18089);
  assert.equal(result.readback.status, 206);
  assert.deepEqual(recordedProcessTargets(), ['com.jtr.caddy-static']);
});

test('Caddy reload validates the exact config first and restores prior state on failed readback', async () => {
  const result = await caddyRuntime.reload(injectedPostReloadFailureFixture);
  assert.deepEqual(result.transitions, ['validate', 'snapshot', 'reload', 'readback', 'rollback', 'restored']);
  assert.equal(result.configPath, '/Users/jtr/server/config/Caddyfile');
});

test('immutable backend, collection, and enrichment resolve the same stable data authority', async () => {
  const result = await deployPromoteReadbackRollback(fixture);
  assert.equal(result.backendDataRoot, '/Users/jtr/_JTR23_/shakedown-runtime-data');
  assert.equal(result.collectionDataRoot, result.backendDataRoot);
  assert.equal(result.enrichmentDataRoot, result.backendDataRoot);
  assert.equal(result.apiReadback, 'verified');
  assert.equal(result.publicReadback, 'verified');
  assert.equal(result.rollback, 'verified');
});

test('every stable mutable target remains inside the hash-pinned manifest path ceiling', async () => {
  const targets = stableCollectionTargetsFixture();
  const ceiling = await loadProjectedManifestPathCeiling();
  assert.equal(everyTargetWithinTypedCeiling(targets, ceiling), true);
  assert.throws(() => assertTargetMapWithinTypedCeiling({
    ...targets, runtimeDir: '/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/runtime',
  }, ceiling), /outside.*ceiling/i);
});

test('stable data preparation is convergent after exact live pointer cutover', async () => {
  const first = await prepareStableDataAuthority(firstInstallFixture);
  pointAllExactLiveReadersAndWritersAt(first.destinationRoot, first.manifest.treeSha256);
  const second = await prepareStableDataAuthority(firstInstallFixture);
  assert.equal(second.status, 'no_change');
  assert.equal(second.manifest.treeSha256, first.manifest.treeSha256);
  await assert.rejects(() => prepareStableDataAuthority(divergentLivePointerFixture), /divergent|partial/i);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/code-integration.test.mjs \
  ops/shakedown-worker/tests/backend-release.test.mjs \
  ops/shakedown-worker/tests/runtime.test.mjs \
  ops/shakedown-worker/tests/caddy-runtime.test.mjs \
  ops/shakedown-worker/tests/data-authority-integration.test.mjs
```

- [ ] **Step 3: Implement verified object import plus patch-identity-aware code integration**

Accept only a tested commit at an exact dedicated ref in the independent worker clone. Export that ref as a run-scoped Git bundle, bind its SHA-256 into the normalized action and receipt, verify the bundle, and fetch it into a unique temporary `refs/codex-import/*` namespace in the operator repository. Only then prove the imported tip, expected baseline, ancestry, and patch identities; re-run the operator-checkout invariant; atomically create/update one configured `refs/heads/codex/shakedown-worker/*` ref; delete the temporary ref; and recheck the invariant. A missing prior canonical ref uses Git's zero object ID for compare-and-swap. No branch switch, worktree edit, index change, merge into the user's branch, hardlink/object sharing, or remote push is allowed.

```js
const ZERO_OID = '0'.repeat(40);

export async function integrateTestedCommit({
  repository, cloneRepository, candidateRef, candidateCommit, expectedBase,
  expectedPatchIds, canonicalRef, actionId, bundlePath,
}) {
  if (!canonicalRef.startsWith('refs/heads/codex/shakedown-worker/')) throw new Error('invalid canonical ref');
  if (!candidateRef.startsWith('refs/heads/codex/shakedown-worker/')) throw new Error('invalid candidate ref');
  await assertRefEquals(cloneRepository, candidateRef, candidateCommit);
  const importRef = `refs/codex-import/${actionId}`;
  await createGitBundle(cloneRepository, bundlePath, candidateRef);
  let canonicalUpdated = false;
  let previous: string | null = null;
  try {
    const bundleSha256 = await sha256File(bundlePath);
    await bindActionInputBeforeImport({ actionId, candidateCommit, candidateRef, bundleSha256 });
    await git(repository, ['bundle', 'verify', bundlePath]);
    const before = await captureOperatorCheckoutInvariant('/Users/jtr/websites/shakedownshuffle.com');
    previous = await resolveRefOrNull(repository, canonicalRef);
    await assertRefAbsent(repository, importRef);
    await git(repository, ['fetch', '--no-tags', bundlePath, `${candidateRef}:${importRef}`]);
    await assertRefEquals(repository, importRef, candidateCommit);
    await assertAncestor(repository, expectedBase, candidateCommit);
    await assertPatchIdentities(repository, candidateCommit, expectedPatchIds);
    await git(repository, ['update-ref', canonicalRef, candidateCommit, previous ?? ZERO_OID]);
    canonicalUpdated = true;
    const after = await captureOperatorCheckoutInvariant('/Users/jtr/websites/shakedownshuffle.com');
    if (canonicalJson(after) !== canonicalJson(before)) {
      throw new Error('operator checkout invariant changed');
    }
    return {
      canonicalRef, previous, current: candidateCommit, bundleSha256,
      operatorInvariantSha256: sha256(canonicalJson(after)),
    };
  } catch (error) {
    if (canonicalUpdated) {
      if (previous) await git(repository, ['update-ref', canonicalRef, previous, candidateCommit]);
      else await git(repository, ['update-ref', '-d', canonicalRef, candidateCommit]);
    }
    throw error;
  } finally {
    await deleteRefIfExact(repository, importRef, candidateCommit);
    await removeRunScopedBundle(bundlePath);
  }
}
```

- [ ] **Step 4: Implement immutable backend release journals**

Materialize versioned source/builds beneath `releases/code`, record predecessor, dependency lock, build/test receipts, config fingerprint, and target PM2 process. Journal `prepared -> snapshotted -> built -> tested -> cutover -> restarted -> verifying -> committed`; every uncertain post-restart state enters readback and then rollback or reconciliation.

```js
const BACKEND_RELEASE_TRANSITIONS = Object.freeze({
  prepared: 'snapshotted', snapshotted: 'built', built: 'tested', tested: 'cutover',
  cutover: 'restarted', restarted: 'verifying', verifying: 'committed',
});

export async function materializeBackendRelease(input) {
  const releaseParent = '/Users/jtr/websites/shakedownshuffle.com/releases/code';
  const releaseRoot = join(releaseParent, input.sourceCommit);
  if (await pathExists(releaseRoot)) {
    return verifyAndReuseExactBackendRelease(releaseRoot, input);
  }
  const stage = await mkdtemp(join(releaseParent, `.prepare-backend-${input.sourceCommit}.`));
  const journal = await input.journal.prepareAndFsync({ stage, releaseRoot, sourceCommit: input.sourceCommit });
  try {
    await exportCommit(input.repository, input.sourceCommit, stage);
    await runFixed(['bun', 'install', '--frozen-lockfile', '--production'], {
      cwd: join(stage, 'jerry-api'), env: minimalDependencyInstallEnvironment(),
    });
    await runFixed(['bun', 'run', 'build'], {
      cwd: join(stage, 'jerry-api'), env: isolatedReleaseEnvironment({ NODE_PATH: '' }),
    });
    const dependencyClosureSha256 = await hashProductionDependencyClosure(join(stage, 'jerry-api'));
    await smokeRelocatedJerryApi(join(stage, 'jerry-api'), {
      hideExternalNodeModules: true, forbidAncestorResolution: true, minimalEnvironment: true,
    });
    const manifest = {
      schema: 'home23.shakedown-backend-release.v1',
      sourceCommit: input.sourceCommit,
      predecessor: input.predecessor,
      dependencyLockSha256: await sha256File(join(stage, 'jerry-api/bun.lock')),
      dependencyClosureSha256,
      configFingerprint: input.configFingerprint,
      processName: 'jerry-api',
      payloadTreeSha256: await sha256Tree(stage),
    };
    await writeJsonAtomicFsync(join(stage, 'release-manifest.json'), manifest, 0o600);
    await fsyncTreeAndDirectory(stage);
    await chmodTreeReadOnly(stage);
    await rename(stage, releaseRoot);
    await fsyncDirectory(releaseParent);
    return { ...manifest, status: 'created', releaseRoot };
  } catch (error) {
    await quarantineJournalOwnedStage(stage, journal, error);
    throw error;
  }
}
```

`verifyAndReuseExactBackendRelease()` checks commit, lock, production dependency closure, payload tree, modes, manifest signature, and relocated minimal-environment boot; it never overwrites a mismatch. Failpoints cover export, dependency install, build, smoke, manifest, chmod, and pre/post rename. A journal-owned partial stage may be quarantined, but an existing final path is immutable and is either byte-identically reused or rejected.

- [ ] **Step 5: Reuse the watchdog recovery owner and one shared lock**

Add the missing shared recovery lock to `ops/shakedown-watchdog/lib/watchdog-core.mjs`; make both worker and launchd wrapper acquire it before any `jerry-api` start/restart. Replace the wrapper's hard-coded dirty-checkout script with the immutable active-backend-release pointer and validate its manifest before start. Worker runtime capabilities may invoke only `jerry-api`, the retained `com.jtr.caddy-static` owner for fixed `shakedown-audio-static` recovery, and the fixed Caddy action below. Audio recovery acquires its dedicated lock, retains the current runtime strategy, and verifies a catalog-pinned byte-range canary at port `18089`; it never treats a root `404` as failure or changes the service owner. Dynamic DNS and runtime-strategy changes are denied.

```js
export const RUNTIME_TARGETS = Object.freeze({
  'jerry-api': {
    owner: 'com.jtr.shakedown-watchdog',
    lock: 'shakedown-jerry-api-recovery',
    processName: 'jerry-api',
    healthUrl: 'http://127.0.0.1:3005/health',
  },
  'shakedown-audio-static': {
    owner: 'com.jtr.caddy-static',
    lock: 'shakedown-audio-static-recovery',
    processName: 'com.jtr.caddy-static',
    port: 18089,
    probeMethod: 'GET',
    probeHeaders: { Range: 'bytes=0-1023' },
    acceptedStatuses: [200, 206],
  },
});

export async function withRecoveryLock(lockName, action) {
  const lock = await acquireExclusiveFileLock(
    `/Users/jtr/_JTR23_/shakedown-runtime-data/locks/${lockName}.lock`,
    { mode: 0o600, staleAfterMs: 180000 },
  );
  try { return await action(); } finally { await lock.release(); }
}
```

- [ ] **Step 6: Add fixed-target Caddy validate/reload/readback/rollback**

`shakedown.runtime.reload-scoped` accepts only `service: caddy`, `service: jerry-api`, or `service: shakedown-audio-static`. For Caddy it always runs `caddy validate --config /Users/jtr/server/config/Caddyfile`, hashes/snapshots the exact current config and process state, reloads via the retained `homebrew.mxcl.caddy` owner only when a candidate requires it, verifies canonical redirect/static/API/audio routes, and restores/reloads the predecessor on failure. The Caddy path cannot edit the Caddyfile or touch `com.jtr.caddy-static`. The audio-static path can only reacquire the `shakedown-audio-static-recovery` lock, invoke the retained `com.jtr.caddy-static` owner, and verify the pinned byte-range canary; it cannot switch the audio runtime strategy, process label, port, root, or Caddy route.

```js
export const SCOPED_RELOAD_SERVICES = Object.freeze(new Set([
  'caddy', 'jerry-api', 'shakedown-audio-static',
]));

export async function reloadCaddy(context) {
  const configPath = '/Users/jtr/server/config/Caddyfile';
  await context.command.runFixed(['caddy', 'validate', '--config', configPath]);
  const predecessor = await context.snapshot.captureCaddy(configPath, 'homebrew.mxcl.caddy');
  await context.command.runFixed(['caddy', 'reload', '--config', configPath]);
  const readback = await context.verify.routes([
    'https://shakedownshuffle.com/', 'https://www.shakedownshuffle.com/',
    'https://api.shakedownshuffle.com/health', context.pinnedPublicAudioCanaryUrl,
  ]);
  if (readback.status !== 'passed') await context.snapshot.restoreAndReloadCaddy(predecessor);
  return { configPath, owner: 'homebrew.mxcl.caddy', readback };
}

export async function recoverAudioStatic(context, pinnedCanaryPath) {
  assertPinnedCatalogAudioPath(pinnedCanaryPath);
  return withRecoveryLock('shakedown-audio-static-recovery', async () => {
    await context.launchd.kickstartFixed('com.jtr.caddy-static');
    const readback = await context.http.get(`http://127.0.0.1:18089${pinnedCanaryPath}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    if (![200, 206].includes(readback.status)) throw new Error(`audio canary failed: ${readback.status}`);
    return { owner: 'com.jtr.caddy-static', lock: 'shakedown-audio-static-recovery', port: 18089, readback };
  });
}
```

- [ ] **Step 7: Migrate backend and promoters to one stable mutable data authority**

Create `/Users/jtr/_JTR23_/shakedown-runtime-data` as a mode-`0700` stable root with versioned snapshots. Copy the current API projection/enrichment data from the active checkout, verify hashes/schema/counts, and keep the originals. In the worker clone, set `ops/jerry-collection/config.json` targets to the stable root and make `shows.repository.ts` resolve an allowlisted `SHAKEDOWN_DATA_ROOT` rather than release-relative data. Every immutable backend release and collection/enrichment promoter pins the same config/root hash. The integration test runs immutable backend -> additive collection/enrichment fixture promotion -> API/public fixture readback -> rollback and rejects any divergent root.

```js
const STABLE_COLLECTION_TARGETS = Object.freeze({
  apiProjectionPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/api/jerrydatabasemaster_v2.json',
  enrichmentRoot: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment',
  normalizedDetailsPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/normalized/normalized-show-details.json',
  validationReportPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/validation-report.json',
  unresolvedGapsPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/unresolved-gaps.json',
  reviewQueuePath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/review-queue-report.json',
  qualityReviewPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/quality-review-report.json',
  sourceManifestPath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/source-manifest.json',
  readableGuidePath: '/Users/jtr/_JTR23_/shakedown-runtime-data/show-enrichment/artifacts/reports/readable-guide.md',
  runtimeDir: '/Users/jtr/_JTR23_/shakedown-runtime-data/jerry-collection-runtime',
});

const STABLE_RUNTIME_TARGETS = Object.freeze({
  locksRoot: '/Users/jtr/_JTR23_/shakedown-runtime-data/locks',
});

const migratedCollectionConfig = Object.freeze({
  ...parseAndValidateKnownCollectionConfig(currentCollectionConfig),
  ...STABLE_COLLECTION_TARGETS,
});

export async function prepareStableDataAuthority(input) {
  await assertExactDestination(input.destinationRoot, '/Users/jtr/_JTR23_/shakedown-runtime-data');
  const sourceManifest = await hashAndValidateApprovedDataSources(input.sourceRoot, input.captureManifest);
  if (await pathExists(input.destinationRoot)) {
    const current = await readAndVerifyMigrationManifest(input.destinationRoot);
    if (current.sourceManifestSha256 !== sourceManifest.sha256) throw new Error('stable data authority already exists with different source');
    await verifyStableDataTreeSchemaCountsAndModes(input.destinationRoot, current);
    await assertNoDivergentOrPartialLivePointers({
      destinationRoot: input.destinationRoot,
      expectedTreeSha256: current.treeSha256,
      allowExactHashPinnedLivePointers: true,
    });
    return { status: 'no_change', destinationRoot: input.destinationRoot, manifest: current };
  }
  await assertNoLiveServiceOrConfigResolvesTo(input.destinationRoot);
  const stagingRoot = await mkdtemp(join(dirname(input.destinationRoot), '.shakedown-runtime-data.prepare.'));
  await chmod(stagingRoot, 0o700);
  await copyApprovedDataSourcesFsync(input.sourceRoot, stagingRoot, sourceManifest, { fileMode: 0o600 });
  const validation = await validateSchemaCountsAndHashes(stagingRoot, sourceManifest);
  if (validation.status !== 'passed') throw new Error('stable data authority validation failed');
  const manifest = await writeMigrationManifestFsync(stagingRoot, { sourceManifest, validation, livePointerChanged: false });
  await rename(stagingRoot, input.destinationRoot);
  return { status: 'prepared', destinationRoot: input.destinationRoot, manifest };
}
```

```ts
const ALLOWED_DATA_ROOT = '/Users/jtr/_JTR23_/shakedown-runtime-data';

export function resolveShakedownDataRoot(environment: NodeJS.ProcessEnv): string {
  const configured = environment.SHAKEDOWN_DATA_ROOT ?? ALLOWED_DATA_ROOT;
  const resolved = realpathSync(configured);
  if (resolved !== ALLOWED_DATA_ROOT) throw new Error(`Unapproved SHAKEDOWN_DATA_ROOT: ${resolved}`);
  return resolved;
}
```

```bash
node ops/shakedown-worker/scripts/prepare-data-authority.mjs \
  --source-root /Users/jtr/websites/shakedownshuffle.com \
  --capture-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --destination-root /Users/jtr/_JTR23_/shakedown-runtime-data \
  --prepare-only --retain-source --require-no-divergent-live-pointer
node --test --test-concurrency=1 \
  --test-name-pattern='copy hash schema count rollback divergent root' \
  ops/shakedown-worker/tests/data-authority-integration.test.mjs
```

- [ ] **Step 8: Prove deployment and runtime recovery against ephemeral fixture processes only**

Launch the relocated backend release under a test-only process name and port against a copied data fixture, with clone/operator `node_modules` hidden, `NODE_PATH` empty, and only its hashed production Bun dependency closure available. Use `/health`, a read-only show/search request, and a non-mutating entitlement-status fixture. Force a canary failure, restore the predecessor release, restart under the shared lock, and prove the fixture API recovered. Restart during each journal transition and reconcile. Do not restart production `jerry-api`, reload production Caddy, or change the guarded PM2 dump before Task 31.

Store raw PM2 dumps/environment/config backups only beneath a restricted mode-`0700` non-Git root with mode-`0600` files; receipts/model context carry hash-only redacted manifests. Run content secret/PII scans before any immutable release or source commit and exercise restricted restore.

```js
for (const failpoint of ['prepared', 'snapshotted', 'built', 'tested', 'cutover', 'restarted', 'verifying']) {
  const fixture = await launchEphemeralBackend({ port: 0, dataRoot: copiedDataFixture, failpoint });
  const health = await fixture.get('/health');
  const shows = await fixture.get('/api/v1/shows?limit=1');
  const search = await fixture.get('/api/v1/search?q=garcia&limit=1');
  const entitlement = await fixture.get('/api/v1/user/entitlement-status', ownedFixtureSession);
  assert.equal(health.status, 200);
  assert.equal(shows.status, 200);
  assert.equal(search.status, 200);
  assert.equal(entitlement.mutated, false);
  const recovered = await restartFixtureRuntime(fixture);
  assert.equal(recovered.activeRelease, fixture.predecessorRelease);
}

const audio = await runAudioFixtureRecovery({
  owner: 'com.jtr.caddy-static', port: 18089, canaryPath: pinnedAudioCanaryPath,
});
assert.equal(audio.readback.status, 206);
```

```bash
restricted_root=/Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/runtime-fixtures
install -d -m 0700 "$restricted_root"
node --test --test-concurrency=1 \
  --test-name-pattern='ephemeral|journal transition|audio-static|restricted restore' \
  ops/shakedown-worker/tests/backend-release.test.mjs \
  ops/shakedown-worker/tests/runtime.test.mjs
node ops/shakedown-worker/scripts/scan-staged-source.mjs \
  --deny-secrets --deny-pii --deny-generated
```

- [ ] **Step 9: Run tests — expect PASS**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/code-integration.test.mjs \
  ops/shakedown-worker/tests/backend-release.test.mjs \
  ops/shakedown-worker/tests/runtime.test.mjs \
  ops/shakedown-worker/tests/caddy-runtime.test.mjs \
  ops/shakedown-worker/tests/data-authority-integration.test.mjs
bun --cwd jerry-api test
```

- [ ] **Step 10: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/lib/code-integration.mjs \
  ops/shakedown-worker/lib/backend-release.mjs ops/shakedown-worker/lib/runtime.mjs \
  ops/shakedown-worker/lib/caddy-runtime.mjs ops/shakedown-worker/lib/data-authority.mjs \
  ops/shakedown-worker/scripts/prepare-data-authority.mjs \
  ops/shakedown-worker/tests/code-integration.test.mjs \
  ops/shakedown-worker/tests/backend-release.test.mjs ops/shakedown-worker/tests/runtime.test.mjs \
  ops/shakedown-worker/tests/caddy-runtime.test.mjs \
  ops/shakedown-worker/tests/data-authority-integration.test.mjs \
  ops/shakedown-watchdog/lib/watchdog-core.mjs \
  ops/shakedown-watchdog/check-shakedown-health.mjs \
  ops/shakedown-watchdog/test/watchdog-core.test.mjs \
  ops/shakedown-watchdog/test/check-shakedown-health.test.mjs \
  ops/jerry-collection/config.json \
  jerry-api/src/database/shows.repository.ts jerry-api/tests/data-authority.test.ts
git diff --cached --check
git commit -m "feat(release): integrate and recover scoped Shakedown code"
```

---

## Task 23: Wrap Jerry Collection as a no-overwrite additive promotion capability

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 18 action boundary, Task 22 stable data root/config pin, and preserved Jerry Collection machinery.
- Produces: additive collection candidates, target-drift/unknown-key/volume guards, shared orchestration locking, promotion verifier, and canonical collection consequence receipts.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/lib/collection.mjs`
- Create: `ops/shakedown-worker/tests/collection.test.mjs`
- Reuse without modification: `ops/jerry-collection/lib/authority-reader.mjs`, `ops/jerry-collection/lib/daily-orchestration-lock.mjs`, `ops/jerry-collection/lib/daily-collection.mjs`, `ops/jerry-collection/lib/release-candidate.mjs`, `ops/jerry-collection/lib/release-promoter.mjs`, `ops/jerry-collection/lib/release-runtime.mjs`, and `ops/jerry-collection/lib/atomic-json.mjs`
- Reuse without modification: `ops/jerry-collection/scripts/run-daily-collection.mjs`, `ops/jerry-collection/scripts/build-release-candidate.mjs`, and `ops/jerry-collection/scripts/promote-release-candidate.mjs`
- Preserve: all `ops/jerry-collection` discovery, acquisition, quarantine, batch-pair, watermark, and source-family machinery

- [ ] **Step 1: Write failing ordering, waiting, additive, lock, and rollback tests**

```js
test('daily collection invokes the exact local maintenance order', async () => {
  await collection.runDaily(fixture);
  assert.deepEqual(invocations, [
    'non-audio:daily:local',
    'non-audio:verify',
    'collection:daily:local',
  ]);
});

test('waiting_for_batch_pair is a successful wait and never forces acquisition', async () => {
  const result = await collection.runDaily(waitingFixture);
  assert.equal(result.semanticStatus, 'waiting_for_batch_pair');
  assert.equal(acquisitionCalls, 0);
});

test('promotion is additive, hash-verified, atomic, and rollbackable', async () => {
  const result = await collection.promote(candidateFixture);
  assert.equal(result.overwrittenRecords, 0);
  assert.equal(result.snapshotVerified, true);
  await collection.rollback(result.releaseId);
  assert.equal(await authorityHash(), result.predecessorHash);
});

test('action-time collection target drift or missing volume requires a newly signed grant', async () => {
  for (const fixture of [changedConfigHashFixture, driftedTargetFixture, missingVolumeFixture]) {
    const result = await collection.preflight(fixture);
    assert.equal(result.status, 'require-human-authorization');
    assert.equal(promotionCalls, 0);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 ops/shakedown-worker/tests/collection.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/collection.mjs`.

- [ ] **Step 3: Implement the wrapper around existing authority and lock seams**

Read the current collection authority receipt before action. Re-parse the strict config, verify its profile/grant-pinned hash, resolve every stable-data/audio/quarantine/candidate/stash target, and prove required volumes are present. Acquire the existing daily orchestration/shared promotion lock. Invoke only fixed repository commands with `./config.json`, capture each native receipt, and synthesize one parent capability receipt without hiding child semantic state.

```js
export function createCollectionCapability({ authority, config, lock, commands, receipts }) {
  return {
    async runDaily(input) {
      const current = await authority.read();
      const resolved = await config.verifyPinnedTargets(input.profile, input.grant);
      return lock.withLock('jerry-collection:daily', async () => {
        const children = [];
        for (const name of ['non-audio:daily:local', 'non-audio:verify', 'collection:daily:local']) {
          const child = await commands.runNpmScript(name, ['--config', './config.json'], resolved);
          children.push(child);
          if (child.semanticStatus === 'waiting_for_batch_pair') break;
          if (!['completed', 'no_change'].includes(child.semanticStatus)) throw new Error(`collection child failed: ${name}`);
        }
        return receipts.commitParent({ capability: 'shakedown.collection.local', authority: current, children });
      });
    },
  };
}
```

- [ ] **Step 4: Preserve the exact local daily sequence**

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='exact local maintenance order against copied fixture' \
  ops/shakedown-worker/tests/collection.test.mjs
```

The test materializes its config and all writable targets under a fresh temporary root, then asserts the wrapper invoked these exact native command tuples in order:

```js
export const DAILY_COLLECTION_COMMANDS = Object.freeze([
  ['npm', ['--prefix', 'ops/jerry-collection', 'run', 'non-audio:daily:local', '--', '--config']],
  ['npm', ['--prefix', 'ops/jerry-collection', 'run', 'non-audio:verify', '--', '--config']],
  ['npm', ['--prefix', 'ops/jerry-collection', 'run', 'collection:daily:local', '--', '--config']],
]);

export function commandForFixture([command, args], fixtureConfigPath) {
  if (!fixtureConfigPath.startsWith(`${process.env.SHAKEDOWN_TEST_ROOT}/`)) {
    throw new Error('preactivation collection requires copied fixture config');
  }
  return { command, args: [...args, fixtureConfigPath] };
}
```

Do not force acquisition from `waiting_for_batch_pair`. Preserve paired-batch readiness, source-family separation, quarantine, no-overwrite, checksum, cursor, watermark, and acquisition-policy decisions exactly. The production stable-authority config is not invoked until Task 31.

- [ ] **Step 5: Add promotion preflight and consequence proof**

Before promotion, validate candidate schema, hashes, source provenance, non-regression counts, overwrite set, public/API compatibility, stable data-authority hash, and rollback snapshot. In this task, exercise promotion only against a copied fixture authority/API/public root. The real additive promotion and readback occur in Task 31 after activation. Promote with an atomic pointer or existing promoter; verify the fixture authority, API route, and page; otherwise roll back and quarantine the candidate.

```js
export async function promoteCollectionCandidate(input, deps) {
  const checked = await deps.preflight.verify({
    capability: 'shakedown.collection.promote-additive',
    candidate: input.candidate,
    expectedDataRootHash: input.profile.dataRootHash,
    expectedConfigHash: input.profile.collectionConfigHash,
    requireNoOverwrite: true,
  });
  const snapshot = await deps.promoter.snapshot(checked.target);
  try {
    const promoted = await deps.promoter.promoteAdditive(checked);
    const readback = await deps.verifier.verifyApiAndPublic(promoted);
    if (readback.status !== 'verified') throw new Error('collection readback failed');
    return deps.receipts.commit({ status: 'completed', snapshot, promoted, readback });
  } catch (error) {
    await deps.promoter.rollback(snapshot);
    await deps.quarantine.write({ candidateHash: checked.candidateHash, reason: String(error) });
    throw error;
  }
}
```

- [ ] **Step 6: Run unit tests and one local maintenance cycle — expect PASS**

```bash
node --test --test-concurrency=1 ops/shakedown-worker/tests/collection.test.mjs
```

Expected: PASS; the receipt records only temporary fixture targets and the production authority hash is unchanged.

- [ ] **Step 7: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/lib/collection.mjs \
  ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/tests/collection.test.mjs
git commit -m "feat(collection): wrap additive Jerry promotion"
```

---

## Task 24: Keep show enrichment a separate validated live-promotion lane

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 18 action boundary, Task 22 stable data authority, and preserved enrichment source policy/candidate machinery.
- Produces: distinct enrichment candidates, validation/promotion/rollback flow, and canonical enrichment consequence receipts that cannot masquerade as collection work.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/lib/enrichment.mjs`
- Create: `ops/shakedown-worker/tests/enrichment.test.mjs`
- Reuse without modification: `ops/jerry-collection/lib/enrichment-authority.mjs`, `ops/jerry-collection/lib/enrichment-plan.mjs`, `ops/jerry-collection/lib/enrichment-runner.mjs`, and `ops/jerry-collection/scripts/enrich-daily.mjs`
- Reuse without modification: `jerry-api/show-enrichment/scripts/import-curation-receipts.ts` and `jerry-api/tests/show-enrichment-curation-receipts.test.ts`
- Preserve: existing source policy, schemas, normalization, curation, note generation, and live promotion rules

- [ ] **Step 1: Write failing source, non-overwrite, separation, readback, and rollback tests**

```js
test('enrichment accepts only source-policy-compliant evidence', async () => {
  const result = await enrichment.prepare(untrustedSourceFixture);
  assert.equal(result.status, 'quarantined');
  assert.equal(promotionCalls, 0);
});

test('enrichment cannot satisfy or consume a collection promotion receipt', async () => {
  await assert.rejects(() => enrichment.promote(collectionReceiptFixture), /enrichment receipt/i);
});

test('promotion preserves protected fields and proves API plus public readback', async () => {
  const result = await enrichment.promote(validCandidateFixture);
  assert.equal(result.protectedFieldChanges.length, 0);
  assert.equal(result.readback.api, 'verified');
  assert.equal(result.readback.public, 'verified');
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 ops/shakedown-worker/tests/enrichment.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/enrichment.mjs`.

- [ ] **Step 3: Wrap the existing enrichment pipeline as typed prepare, validate, promote, verify, and rollback operations**

Carry canonical show identity, source family, citations, normalization decisions, curator status, old/new hashes, protected-field diff, and candidate schema through every stage. No generated narrative may overwrite audio identity, date, venue, track, or source metadata.

```js
const PROTECTED_SHOW_FIELDS = Object.freeze(['id', 'date', 'venue', 'tracks', 'audioSources']);

export function createEnrichmentCapability({ authority, planner, runner, verifier, receipts }) {
  const capability = 'shakedown.enrichment';
  return {
    async prepare(input) {
      const source = await authority.verifySourcePolicy(input.sourceBundle);
      if (!source.accepted) return receipts.quarantined(source);
      const candidate = await planner.build({ ...input, source, protectedFields: PROTECTED_SHOW_FIELDS });
      return receipts.prepared(candidate);
    },
    async promote(input) {
      if (input.receiptType !== 'shakedown.enrichment.candidate.v1') throw new TypeError('enrichment receipt required');
      const result = await runner.promote(input);
      const readback = await verifier.verifyApiAndPublic(result);
      return readback.status === 'verified'
        ? receipts.completed({ capability, result, readback })
        : runner.rollback({ capability, result });
    },
  };
}
```

- [ ] **Step 4: Make promotion independent from collection**

Use a separate release journal, lock class, snapshots, verifier, receipt type, and automation replacement proof. A collection success cannot mark enrichment complete, and enrichment failure cannot freeze the collection lane.

```js
export const ENRICHMENT_LANE = Object.freeze({
  lock: 'shakedown:enrichment:promotion',
  journal: 'shakedown.enrichment.release.v1',
  candidate: 'shakedown.enrichment.candidate.v1',
  consequence: 'shakedown.enrichment.consequence.v1',
});

export function assertEnrichmentLane(receipt) {
  if (receipt.schema !== ENRICHMENT_LANE.candidate) throw new TypeError('enrichment receipt required');
  return receipt;
}
```

- [ ] **Step 5: Verify a bounded candidate against copied fixture authorities**

Use one source-backed show candidate, validate the release diff, take a rollback snapshot, and promote only into copied stable-data/API/public fixtures. Verify the fixture authority, `/api/v1/shows` or exact show API output, and matching staged show page; exercise rollback with a byte-equivalent candidate. Do not promote production enrichment until Task 31 after grant activation.

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='copied fixture authorities|byte-equivalent rollback' \
  ops/shakedown-worker/tests/enrichment.test.mjs
```

Expected: PASS with every resolved target beneath the test runner's temporary fixture root.

- [ ] **Step 6: Run tests — expect PASS**

```bash
node --test --test-concurrency=1 ops/shakedown-worker/tests/enrichment.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/lib/enrichment.mjs \
  ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/tests/enrichment.test.mjs
git commit -m "feat(enrichment): add separate verified promotion lane"
```

---

## Task 25: Prepare and distribute useful work through Substack, a non-Substack channel, and consented communications

**Working directory:** `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`

**Interfaces:**
- Consumes: Task 19 canonical opportunities/campaign state, Task 17 channel registry, and Task 18 authenticated runner.
- Produces: source-backed content packages, Substack and non-Substack adapters, consented recipient-set communications, idempotent distribution receipts, and scheduled consequence readbacks.

**Files:**
- Modify: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/schemas/campaign.v1.schema.json`
- Create: `ops/shakedown-worker/schemas/channel.v1.schema.json`
- Create: `ops/shakedown-worker/lib/content.mjs`
- Create: `ops/shakedown-worker/lib/substack.mjs`
- Create: `ops/shakedown-worker/lib/channel.mjs`
- Create: `ops/shakedown-worker/lib/communications.mjs`
- Create: `ops/shakedown-worker/tests/content.test.mjs`
- Create: `ops/shakedown-worker/tests/distribution.test.mjs`
- Create: `ops/shakedown-worker/tests/communications.test.mjs`
- Create: `ops/shakedown-worker/tests/fixtures/configured-channels.json`
- Modify: `shakedown-v2/scripts/shakedown-publish-pipeline.mjs`
- Modify: `shakedown-v2/scripts/substack-local-adapter.mjs`
- Modify: `shakedown-v2/scripts/substack-browser-adapter.mjs`
- Modify: `shakedown-v2/scripts/substack-safari-preflight.mjs`
- Modify: `shakedown-v2/scripts/subscriber-communications-candidates.mjs`
- Modify: `shakedown-v2/scripts/subscriber-communications-readback.mjs`
- Modify: `shakedown-v2/test/shakedown-publish-pipeline.test.mjs`
- Modify: `shakedown-v2/test/substack-local-adapter.test.mjs`
- Modify: `shakedown-v2/test/substack-browser-adapter.test.mjs`
- Modify: `shakedown-v2/test/substack-safari-preflight.test.mjs`
- Modify: `shakedown-v2/test/subscriber-communications-candidates.test.mjs`
- Modify: `shakedown-v2/test/subscriber-communications-readback.test.mjs`

- [ ] **Step 1: Write failing evidence, registry, idempotency, consent, suppression, and uncertainty tests**

```js
test('content cannot be prepared without a supported opportunity and source bundle', async () => {
  const result = await content.prepare(unsupportedFixture);
  assert.equal(result.status, 'denied');
  assert.equal(generatedArtifacts.length, 0);
});

test('all configured channel adapters implement preflight, publish, readback, and correction', () => {
  for (const channel of registry.channels) {
    assert.deepEqual(adapterMethods(channel), ['correct', 'preflight', 'publish', 'readback']);
  }
});

test('duplicate or uncertain publication is read back and never blindly repeated', async () => {
  const result = await channel.publish(uncertainFixture);
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(retryCalls, 0);
});

test('unconsented, suppressed, unsubscribed, bounced, cooled-down, or quiet-hour recipients never send', async () => {
  for (const recipient of deniedRecipientFixtures) {
    const result = await communications.send(recipient);
    assert.equal(result.status, 'denied');
    assert.equal(providerSendCount(recipient), 0);
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/content.test.mjs \
  ops/shakedown-worker/tests/distribution.test.mjs \
  ops/shakedown-worker/tests/communications.test.mjs \
  shakedown-v2/test/shakedown-publish-pipeline.test.mjs \
  shakedown-v2/test/substack-local-adapter.test.mjs \
  shakedown-v2/test/substack-browser-adapter.test.mjs \
  shakedown-v2/test/substack-safari-preflight.test.mjs \
  shakedown-v2/test/subscriber-communications-candidates.test.mjs \
  shakedown-v2/test/subscriber-communications-readback.test.mjs
```

- [ ] **Step 3: Turn opportunities into evidence-bound content packages**

Require opportunity identity, audience need, cited source bundle, canonical target, claim inventory, UTM campaign, intended consequence, channel fit, expiry/freshness, and correction plan. Generate owned-site, Substack, and channel variants from one factual package while respecting each channel's format. Reject unsupported claims, repetitive thin content, and output created only to satisfy a cadence.

```js
export function prepareContentPackage({ opportunity, sources, campaign, renderers, now }) {
  if (opportunity.status !== 'selected' || !opportunity.evidenceHashes?.length) throw new Error('supported opportunity required');
  if (sources.some((source) => !opportunity.evidenceHashes.includes(source.sha256))) throw new Error('uncited source');
  if (Date.parse(opportunity.expiresAt) <= now.getTime()) throw new Error('stale opportunity');
  const base = Object.freeze({
    opportunityId: opportunity.id,
    canonicalUrl: opportunity.canonicalUrl,
    claims: opportunity.claims,
    sourceHashes: sources.map((source) => source.sha256),
    utmCampaign: campaign.utmCampaign,
    intendedConsequence: campaign.intendedConsequence,
    correctionPlan: campaign.correctionPlan,
  });
  return Object.fromEntries(Object.entries(renderers).map(([channel, render]) => [channel, render(base)]));
}
```

- [ ] **Step 4: Reconcile and wrap deterministic Substack adapters**

Choose local, Chrome, or Safari only from configured current capability/readiness receipts. Preflight authenticated account identity and destination, create or update exactly one idempotent draft/publication, perform authoritative URL/account readback, and record correction/unpublish capability. Browser navigation that creates state is classified as a write and stays behind the standing grant.

```js
export function createSubstackAdapter({ readiness, local, chrome, safari, idempotency }) {
  const adapters = Object.freeze({ local, chrome, safari });
  return {
    async publish(input) {
      const current = await readiness.resolve(input.accountAlias);
      const adapter = adapters[current.adapter];
      if (!adapter || current.accountHash !== input.expectedAccountHash) throw new Error('Substack preflight mismatch');
      const prior = await idempotency.lookup(input.actionKey);
      if (prior) return adapter.readback(prior);
      const published = await adapter.publish(input);
      const readback = await adapter.readback(published);
      if (readback.status !== 'verified') return { status: 'reconciliation_required', published };
      await idempotency.commit(input.actionKey, readback);
      return readback;
    },
  };
}
```

- [ ] **Step 5: Implement at least one real non-Substack public adapter**

Resolve the first enabled `public-non-substack` registry entry to a typed module with fixed account, host, content class, rate limit, cooldown, URL rules, preflight, publish, authoritative readback, and correction. A missing or unauthenticated configured account is a lane-local failure, not permission to substitute an arbitrary platform.

```js
export function resolvePublicChannel(registry, adapters) {
  const entry = registry.channels.find((channel) => channel.kind === 'public-non-substack' && channel.enabled);
  if (!entry) return { status: 'unavailable', lane: 'public-non-substack' };
  const adapter = adapters[entry.adapterId];
  if (!adapter) throw new Error(`unregistered channel adapter: ${entry.adapterId}`);
  return Object.freeze({
    entry,
    preflight: (input) => adapter.preflight({ ...input, host: entry.host, accountAlias: entry.accountAlias }),
    publish: (input) => adapter.publish({ ...input, rateLimit: entry.rateLimit, cooldown: entry.cooldown }),
    readback: adapter.readback.bind(adapter),
    correct: adapter.correct.bind(adapter),
  });
}
```

- [ ] **Step 6: Implement consented one-to-one communications safely**

Consume only the existing eligible-candidate contract with documented consent basis. Use opaque recipient IDs until the provider boundary; enforce suppression, unsubscribe, bounce, prior-contact, quiet hours, per-recipient and global rate limits, cooldown, content hash idempotency, and a correction/escalation procedure. No bulk-send or purchased/scraped-contact path exists.

```js
export async function sendConsentedCommunication(candidate, deps) {
  const eligibility = await deps.eligibility.verify(candidate.opaqueRecipientId);
  const denied = !eligibility.consentBasis || eligibility.suppressed || eligibility.unsubscribed ||
    eligibility.bounced || eligibility.inQuietHours || eligibility.cooldownActive;
  if (denied) return deps.receipts.denied({ recipient: candidate.opaqueRecipientId, reason: eligibility.reason });
  const key = `${candidate.opaqueRecipientId}:${candidate.contentHash}`;
  if (await deps.idempotency.has(key)) return deps.receipts.reused(key);
  await deps.rateLimits.reserve({ recipient: candidate.opaqueRecipientId, global: true });
  const providerResult = await deps.provider.send(await deps.recipientBoundary.resolve(candidate), candidate.content);
  const readback = await deps.provider.readback(providerResult.id);
  if (readback.status !== 'verified') return deps.receipts.reconciliationRequired({ key, providerResult });
  await deps.idempotency.commit(key, readback);
  return deps.receipts.completed({ key, readback });
}
```

- [ ] **Step 7: Reconcile current pipeline promotion gates**

Preserve readiness and `automationPromotionPlan.applyAllowed` as distinct facts. A green scan alone never authorizes unattended application. Replace free-form browser/manual steps with typed state transitions and native child receipts.

```js
export function decidePipelineTransition({ readiness, automationPromotionPlan, authority }) {
  if (readiness.status !== 'green') return { status: 'blocked_readiness' };
  if (automationPromotionPlan.applyAllowed !== true) return { status: 'prepared_not_authorized' };
  if (authority.decision !== 'allow') return { status: authority.decision };
  return {
    status: 'dispatch_typed_action',
    capability: authority.channelKind === 'substack'
      ? 'shakedown.distribute.substack'
      : 'shakedown.distribute.channel',
    operation: 'publish',
    evidenceHashes: [readiness.sha256, automationPromotionPlan.sha256, authority.grantHash],
  };
}
```

- [ ] **Step 8: Run tests and safe preflights — expect PASS**

```bash
node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/content.test.mjs \
  ops/shakedown-worker/tests/distribution.test.mjs \
  ops/shakedown-worker/tests/communications.test.mjs
node ops/shakedown-worker/scripts/run-capability.mjs shakedown.distribute.channel \
  --operation preflight \
  --input ops/shakedown-worker/tests/fixtures/configured-channels.json
```

- [ ] **Step 9: Commit in the worker clone**

```bash
node ops/shakedown-worker/scripts/sync-home23-config.mjs --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$PWD" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git add ops/shakedown-worker/schemas/campaign.v1.schema.json \
  ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/schemas/channel.v1.schema.json \
  ops/shakedown-worker/lib/content.mjs ops/shakedown-worker/lib/substack.mjs \
  ops/shakedown-worker/lib/channel.mjs ops/shakedown-worker/lib/communications.mjs \
  ops/shakedown-worker/tests/content.test.mjs \
  ops/shakedown-worker/tests/distribution.test.mjs \
  ops/shakedown-worker/tests/communications.test.mjs \
  ops/shakedown-worker/tests/fixtures/configured-channels.json \
  shakedown-v2/scripts/shakedown-publish-pipeline.mjs \
  shakedown-v2/scripts/substack-local-adapter.mjs \
  shakedown-v2/scripts/substack-browser-adapter.mjs \
  shakedown-v2/scripts/substack-safari-preflight.mjs \
  shakedown-v2/scripts/subscriber-communications-candidates.mjs \
  shakedown-v2/scripts/subscriber-communications-readback.mjs \
  shakedown-v2/test/shakedown-publish-pipeline.test.mjs \
  shakedown-v2/test/substack-local-adapter.test.mjs \
  shakedown-v2/test/substack-browser-adapter.test.mjs \
  shakedown-v2/test/substack-safari-preflight.test.mjs \
  shakedown-v2/test/subscriber-communications-candidates.test.mjs \
  shakedown-v2/test/subscriber-communications-readback.test.mjs
git diff --cached --check
node ops/shakedown-worker/scripts/scan-staged-source.mjs --deny-secrets --deny-pii --deny-generated
git commit -m "feat(distribution): add typed growth channels"
```

---

## Task 26: Measure campaign consequences, repair social images, learn channel scores, and retire weak work

**Working directory:** Use the Shakedown clone for capability/site code and `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime` for canonical Worker state/dashboard code; every cross-repository command uses `git -C`.

**Interfaces:**
- Consumes: Task 25 campaign/channel receipts, Task 19 observation readbacks, and Task 5 canonical state APIs.
- Produces: validated social-image candidates, mature campaign consequence readbacks, channel-score state events, campaign retire/redirect decisions, and truthful Worker Desk projections.

**Files:**
- Modify in worker clone: `ops/shakedown-worker/config/capabilities.v1.json`
- Modify in worker clone: `ops/shakedown-worker/config/capability-target-pins.v1.json`
- Create: `ops/shakedown-worker/lib/social-image.mjs`
- Create: `ops/shakedown-worker/lib/campaign-readback.mjs`
- Create: `ops/shakedown-worker/lib/channel-score.mjs`
- Create: `ops/shakedown-worker/tests/social-image.test.mjs`
- Create: `ops/shakedown-worker/tests/campaign-readback.test.mjs`
- Create: `ops/shakedown-worker/tests/channel-score.test.mjs`
- Create: `shakedown-v2/scripts/campaign-impact-readback.mjs`
- Create: `shakedown-v2/scripts/validate-social-images.mjs`
- Create: `shakedown-v2/test/campaign-impact-readback.test.mjs`
- Modify: `engine/src/dashboard/home23-dashboard.js`
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.css`
- Modify: `src/workers/triggers/mappings.ts`
- Create: `tests/workers/shakedown-adapters.test.ts`
- Modify: `tests/engine/dashboard/worker-desk-ui.test.js`

- [ ] **Step 1: Write failing image, attribution, timing, scoring, and retirement tests**

```js
test('every promoted public artifact has a fetchable correctly sized social image', async () => {
  for (const artifact of promotedArtifacts) {
    const result = await socialImage.verify(artifact);
    assert.equal(result.status, 'verified');
  }
});

test('campaign readback joins UTM, behavior, and authoritative conversion without leaking identities', async () => {
  const result = await readCampaign(campaignFixture);
  assert.equal(result.evidence.utm, 'verified');
  assert.equal(result.evidence.behavior, 'verified');
  assert.equal(result.evidence.conversionAuthority, 'verified');
  assert.equal(redactionScan(result).length, 0);
});

test('score updates wait for the configured maturity window', async () => {
  assert.equal((await scorer.update(immatureCampaign)).status, 'readback_pending');
  assert.equal((await scorer.update(matureWeakCampaign)).decision, 'retire_or_change');
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/social-image.test.mjs \
  ops/shakedown-worker/tests/campaign-readback.test.mjs \
  ops/shakedown-worker/tests/channel-score.test.mjs \
  shakedown-v2/test/campaign-impact-readback.test.mjs)
(cd /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime && \
  node --import tsx --test --test-concurrency=1 tests/workers/shakedown-adapters.test.ts)
```

- [ ] **Step 3: Add deterministic social-image validation and bounded repair**

Validate canonical URL, Open Graph/Twitter tags, image fetch, MIME, dimensions, byte size, content hash, alt text, and cache visibility. Generate or select a source-relevant image only through the configured asset path; publish it through the site release capability into the Task 21 staged fixture and verify crawler-visible staged output. Never silently reuse a broken or unrelated image. Task 31 performs the required real repair/validation consequence after standing-grant activation.

```js
export async function verifyOrRepairSocialImage(artifact, deps) {
  const metadata = await deps.metadata.read(artifact.canonicalUrl);
  const image = await deps.fetchImage(metadata.ogImage);
  const valid = metadata.twitterImage === metadata.ogImage && image.mime.startsWith('image/') &&
    image.width >= 1200 && image.height >= 630 && image.bytes <= deps.maxBytes && metadata.alt?.trim();
  if (valid) return { status: 'verified', imageHash: image.sha256 };
  const selected = await deps.assets.selectSourceRelevant({ sourceHashes: artifact.sourceHashes, canonicalUrl: artifact.canonicalUrl });
  const candidate = await deps.siteRelease.stageSocialImage({ artifact, selected });
  const readback = await deps.metadata.read(candidate.stagedUrl);
  if (readback.ogImageHash !== candidate.imageHash) throw new Error('staged social image readback failed');
  return { status: 'repair_candidate', candidate };
}
```

- [ ] **Step 4: Schedule timed one-shot readbacks from action receipts**

Every publication/distribution receipt creates configured short, medium, and mature readback due events using the scheduler occurrence contract. Readbacks join the campaign's immutable UTM/canonical identity to Matomo behavior and authoritative aggregate conversion state. Missing evidence remains missing; it is not scored as zero unless route/watermark/filter/crossing proof supports zero.

```js
export function campaignReadbackOccurrences(receipt, windows) {
  return ['short', 'medium', 'mature'].map((windowName) => ({
    kind: 'workerRun',
    worker: 'shakedown-jerry',
    mission: 'campaign-readback',
    dueAt: new Date(Date.parse(receipt.committedAt) + windows[windowName]).toISOString(),
    idempotencyKey: `${receipt.campaignId}:${receipt.actionId}:${windowName}`,
    input: { campaignId: receipt.campaignId, utm: receipt.utm, canonicalUrl: receipt.canonicalUrl, windowName },
  }));
}
```

- [ ] **Step 5: Update channel and content scores transparently**

Use reach quality, listening depth, return behavior, signup/entitlement conversion, correction/failure cost, and confidence. Apply sample-size floors and uncertainty. Store the old score, evidence, rule version, new score, and next decision. Retire, revise, or cool down weak recurring work; do not optimize for posting volume.

```js
export function scoreMatureCampaign({ priorScore, evidence, ruleVersion, minimumSample }) {
  if (evidence.sampleSize < minimumSample || evidence.maturity !== 'mature') return { status: 'readback_pending' };
  const quality = 0.2 * evidence.reachQuality + 0.2 * evidence.listeningDepth +
    0.15 * evidence.returnRate + 0.3 * evidence.verifiedConversionRate -
    0.15 * evidence.correctionFailureCost;
  const confidence = Math.min(1, evidence.sampleSize / (minimumSample * 4));
  const newScore = priorScore * (1 - confidence) + quality * confidence;
  return {
    status: 'scored', priorScore, newScore, confidence, ruleVersion,
    decision: newScore < evidence.retirementFloor ? 'retire_or_change' : 'continue',
    evidenceHashes: evidence.hashes,
  };
}
```

- [ ] **Step 6: Complete the Shakedown Worker Desk projection**

Show open opportunities, campaigns by lane, pending/mature readbacks, channel scores, generated-route/indexing coverage, social-image health, funnel status, conversion authority freshness, collection/enrichment states, recent rollbacks, and retired work. Link every number to a canonical snapshot or receipt.

```js
export function projectShakedownWorkerDesk(state) {
  const link = (row) => ({ ...row, evidenceUrl: `/api/workers/receipts/${row.receiptId}` });
  const campaignsByLane = state.campaigns.map(link).reduce((groups, row) => {
    (groups[row.lane] ??= []).push(row);
    return groups;
  }, {});
  return Object.freeze({
    opportunities: state.opportunities.filter((row) => row.status === 'open').map(link),
    campaignsByLane,
    readbacks: state.readbacks.map(link),
    channelScores: state.channelScores.map(link),
    discovery: link(state.discovery), socialImages: link(state.socialImages), funnel: link(state.funnel),
    conversionAuthority: link(state.conversionAuthority), collection: link(state.collection),
    enrichment: link(state.enrichment), rollbacks: state.rollbacks.map(link), retired: state.retired.map(link),
  });
}
```

- [ ] **Step 7: Run site-side and Home23 tests — expect PASS**

```bash
(cd /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle && \
  node --test --test-concurrency=1 \
  ops/shakedown-worker/tests/social-image.test.mjs \
  ops/shakedown-worker/tests/campaign-readback.test.mjs \
  ops/shakedown-worker/tests/channel-score.test.mjs \
  shakedown-v2/test/campaign-impact-readback.test.mjs)
(cd /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime && \
  node --import tsx --test --test-concurrency=1 tests/workers/shakedown-adapters.test.ts)
(cd /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime && \
  node --test --test-concurrency=1 tests/engine/dashboard/worker-desk-ui.test.js)
```

- [ ] **Step 8: Commit site-side changes**

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" --target-pins-only \
  --home-root /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --clone-root "$clone_root" \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --write
git -C "$clone_root" add \
  ops/shakedown-worker/config/capabilities.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json \
  ops/shakedown-worker/lib/social-image.mjs \
  ops/shakedown-worker/lib/campaign-readback.mjs \
  ops/shakedown-worker/lib/channel-score.mjs \
  ops/shakedown-worker/tests/social-image.test.mjs \
  ops/shakedown-worker/tests/campaign-readback.test.mjs \
  ops/shakedown-worker/tests/channel-score.test.mjs \
  shakedown-v2/scripts/campaign-impact-readback.mjs \
  shakedown-v2/scripts/validate-social-images.mjs \
  shakedown-v2/test/campaign-impact-readback.test.mjs
git -C "$clone_root" diff --cached --check
git -C "$clone_root" \
  commit -m "feat(growth): measure and retire campaign work"
```

- [ ] **Step 9: Commit Home23 projection changes**

```bash
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime add \
  engine/src/dashboard/home23-dashboard.js \
  engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-dashboard.css \
  src/workers/triggers/mappings.ts \
  tests/workers/shakedown-adapters.test.ts tests/engine/dashboard/worker-desk-ui.test.js
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  commit -m "feat(dashboard): project Shakedown growth evidence"
```

---

## Task 27: Absorb legacy Shakedown knowledge and automation judgment without reviving old runtimes

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 1 preservation artifacts, Task 17 identity/playbook, and refreshed legacy automation matrix.
- Produces: provenance-preserving `importLegacyKnowledge()`, signed import manifest, receipt-derived memory candidates/state events, and explicit retained/replaced/independent automation decisions.

**Files:**
- Create: `src/workers/knowledge-import.ts`
- Create: `scripts/import-shakedown-legacy-knowledge.mts`
- Modify: `cli/templates/workers/shakedown-jerry/workspace/PLAYBOOK.md`
- Modify: `config/worker-migrations/shakedown-jerry-automation-matrix.yaml`
- Create at runtime: `instances/workers/shakedown-jerry/knowledge/import-manifest.json`
- Create at runtime: `instances/workers/shakedown-jerry/knowledge/imported/`
- Create: `tests/workers/shakedown-knowledge-import.test.ts`
- Create: `tests/workers/shakedown-automation-absorption.test.ts`

- [ ] **Step 1: Write failing provenance, staleness, executable-separation, and completeness tests**

```ts
test('every imported assertion retains source hash and current-state status', async () => {
  const imported = await importLegacyKnowledge(fixtures);
  assert.equal(imported.every((item) => item.sourcePath && item.sourceHash && item.status), true);
});

test('stale operational claims cannot enter active playbook truth', async () => {
  const result = await importLegacyKnowledge(stalePricingAndPathFixtures);
  assert.equal(result.activeFacts.length, 0);
  assert.equal(result.quarantined.length, stalePricingAndPathFixtures.length);
});

test('automation absorption preserves deterministic executors and removes parallel judgment', async () => {
  assert.equal(matrix.every(hasTargetTriggerCapabilityAndRollback), true);
  assert.equal(revivedOpenClawProcesses(), 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-knowledge-import.test.ts \
  tests/workers/shakedown-automation-absorption.test.ts
```

- [ ] **Step 3: Inventory and hash legacy materials read-only**

Locate Shakedown `SOUL.md`, `AGENTS.md`, draft template, `THE_NORTH_STAR.md`, launch playbook, research, reviews, drafts, issue versions, contacts, image-prompt banks, and relevant Codex automation prompts/receipts. Treat any operator Documents location as provenance/templates only. Record missing expected items explicitly; do not synthesize their content.

```ts
export const LEGACY_MATERIALS = Object.freeze([
  'SOUL.md', 'AGENTS.md', 'THE_NORTH_STAR.md', '**/draft-template*', '**/launch-playbook*',
  '**/research/**', '**/reviews/**', '**/drafts/**', '**/issues/**', '**/contacts/**', '**/image-prompt*',
]);

export async function inventoryLegacyMaterials(roots: string[]): Promise<LegacySourceRecord[]> {
  const records = await discoverReadOnly(roots, LEGACY_MATERIALS);
  return records.map((record) => ({
    sourcePath: record.realPath,
    sourceHash: sha256(record.bytes),
    size: record.bytes.length,
    provenanceClass: record.realPath.includes('/Documents/') ? 'template_only' : 'operational_source',
  }));
}
```

- [ ] **Step 4: Reconcile every imported item against current authority**

`src/workers/knowledge-import.ts` and its CLI classify each factual assertion as verified-current, durable principle, historical-only, superseded, conflicted, or unverified. Promote only durable ethos/process principles to the tracked playbook. Emit verified-current operational facts as provenance-bound state/memory-candidate events so canonical receipts/outboxes generate `MEMORY.md`; do not hand-edit that projection. Quarantine stale pricing, paths, metrics, publishing assumptions, runtime claims, credentials, direct contact identifiers, and account state.

```ts
export type KnowledgeStatus = 'verified-current' | 'durable-principle' | 'historical-only' |
  'superseded' | 'conflicted' | 'unverified';

export function classifyLegacyAssertion(assertion: LegacyAssertion, authority: CurrentAuthority): ClassifiedAssertion {
  const forbidden = assertion.tags.some((tag) => ['credential', 'direct-contact', 'account-state'].includes(tag));
  if (forbidden) return { ...assertion, status: 'unverified', destination: 'quarantine' };
  const match = authority.lookup(assertion.subject);
  if (assertion.kind === 'principle' && !match?.conflict) return { ...assertion, status: 'durable-principle', destination: 'playbook' };
  if (!match) return { ...assertion, status: 'unverified', destination: 'quarantine' };
  if (match.sha256 === assertion.valueHash) return { ...assertion, status: 'verified-current', destination: 'state-event' };
  return { ...assertion, status: match.supersedes(assertion) ? 'superseded' : 'conflicted', destination: 'quarantine' };
}
```

- [ ] **Step 5: Absorb automation judgment and keep typed machinery**

For every matrix row, extract durable selection logic, failure lessons, and evidence expectations into the playbook/state schemas; map deterministic behavior to a retained or repaired typed capability; map schedules/events to Home23; retain definition and receipt provenance; and prohibit an old prompt/loop from remaining an active parallel operator.

```ts
export function absorbAutomation(row: LegacyAutomationRow): AutomationDisposition {
  if (!row.definitionHash || !row.rollbackOperation) throw new Error(`incomplete automation row: ${row.id}`);
  return {
    id: row.id,
    deterministicExecutor: row.deterministicExecutor,
    targetCapability: requireKnownCapability(row.targetCapability),
    targetTrigger: requireKnownTrigger(row.targetTrigger),
    selectionRule: row.selectionRule,
    failureLessons: row.failureLessons,
    requiredEvidence: row.requiredEvidence,
    legacyJudgmentLoopEnabled: false,
    definitionHash: row.definitionHash,
    receiptRoots: row.receiptRoots,
    rollbackOperation: row.rollbackOperation,
  };
}
```

- [ ] **Step 6: Run tests and a complete matrix comparison — expect PASS**

```bash
node --import tsx --test --test-concurrency=1 \
  tests/workers/shakedown-knowledge-import.test.ts \
  tests/workers/shakedown-automation-absorption.test.ts
node cli/home23.js worker migrations verify shakedown-jerry
```

- [ ] **Step 7: Commit**

```bash
git add src/workers/knowledge-import.ts scripts/import-shakedown-legacy-knowledge.mts \
  cli/templates/workers/shakedown-jerry/workspace/PLAYBOOK.md \
  config/worker-migrations/shakedown-jerry-automation-matrix.yaml \
  tests/workers/shakedown-knowledge-import.test.ts \
  tests/workers/shakedown-automation-absorption.test.ts
git commit -m "docs(shakedown): absorb legacy operating knowledge"
```

---

## Task 28: Run the complete automated contract, security, crash, and regression matrix

**Working directory:** Orchestrate from `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`; invoke Shakedown tests with `npm --prefix` or an absolute clone path.

**Interfaces:**
- Consumes: all implementation/test surfaces from Tasks 2–27 and Task 1 preservation invariants.
- Produces: strict automated verification scripts, immutable runner release, an initial full green proof bundle, finalized target/config hashes, and a signed grant that is inactive when newly changed or may retain the same exact active hash on a convergent rerun; Task 29 must re-finalize and rerun this complete matrix after its deployment-code commit before any deployment.

**Files:**
- Create: `scripts/verify-worker-runtime-live.mjs`
- Create: `scripts/verify-shakedown-jerry-live.mjs`
- Create: `tests/scripts/verify-worker-runtime-live.test.mjs`
- Create: `tests/scripts/verify-shakedown-jerry-live.test.mjs`
- Modify: `package.json` only to register deterministic test groups if the existing full suite does not discover them
- Create: `config/worker-authority-grants/shakedown-jerry-standing.yaml` by finalizing and signing the ignored Task 17 candidate against the final tested hashes
- Modify in worker clone: `ops/shakedown-worker/package.json` only to register its deterministic test groups
- Regenerate and modify in worker clone: `ops/shakedown-worker/config/channels.v1.json`, `ops/shakedown-worker/config/home23-dispatch-keys.v1.json`, and `ops/shakedown-worker/config/capability-target-pins.v1.json` from the final complete source authorities

- [ ] **Step 1: Write failing verifier-honesty and failure-propagation tests**

```js
test('live verifier cannot report pass when a required receipt is absent or stale', async () => {
  const result = await verify(missingReceiptFixture);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.missing, ['scheduled-worker-restart-proof']);
});

test('interrupted wrapper remains interrupted even when protected readback passed', async () => {
  const result = await verify(interruptedWrapperFixture);
  assert.equal(result.protectedReadback, 'passed');
  assert.equal(result.wrapperStatus, 'interrupted');
  assert.equal(result.status, 'failed');
});

test('verifier binds every artifact to commit, manifest, grant, request, run, and attempt', async () => {
  assert.deepEqual(await verifyBinding(validFixture), expectedBinding);
});

test('authority verifier binds catalog union while excluding hard stops from standing authority', async () => {
  const result = await verifyAuthorityLanes(validShakedownAuthorityFixture);
  assert.deepEqual(result.catalogIds, union(result.standingManifestIds, result.hardStopManifestIds));
  assert.deepEqual(result.finalizedGrantIds, result.standingManifestIds);
  assert.deepEqual(result.modelRegistryIds, result.finalizedGrantIds);
  assert.deepEqual(intersection(result.finalizedGrantIds, result.hardStopManifestIds), []);
  await assert.rejects(() => verifyAuthorityLanes(catalogWidenedGrantFixture), /hard-stop|standing/i);
});

test('billing verifier binds one public hard stop to a non-recursive internal leaf topology', async () => {
  const result = await verifyBillingTopology(validBillingTopologyFixture);
  assert.deepEqual(result.topLevelCapabilityIds, ['shakedown.billing.production-canary']);
  assert.deepEqual(result.internalLeafOperations, BILLING_CANARY_OPERATIONS);
  assert.equal(result.rootModuleHash, expectedRootModuleHash);
  assert.equal(result.leafModuleHash, expectedLeafModuleHash);
  assert.deepEqual(intersection(result.rootLocks, result.leafLocks), []);
  assert.equal(result.rootAuthorizationCount, 1);
  assert.equal(result.rootOperationReservations, 0);
  assert.equal(result.leafAuthorizationCount, BILLING_CANARY_OPERATIONS.length);
  assert.equal(result.leafReservationCount, BILLING_CANARY_OPERATIONS.length);
  assert.equal(result.recursiveOuterModuleCalls, 0);
});

test('closed verifier registry admits every mode invoked by the execution plan', async () => {
  const markdown = await readFile(planPath, 'utf8');
  const executionSection = markdown.slice(markdown.indexOf('## Task 28:'));
  const invoked = [...executionSection.matchAll(
    /verify-shakedown-jerry-live\.mjs(?:\s|\\\n)+--mode\s+([a-z0-9-]+)/g,
  )].map((match) => match[1]);
  assert.ok(invoked.length > 0);
  for (const mode of invoked) assert.equal(SHAKEDOWN_VERIFIER_MODES.has(mode), true, mode);
});
```

- [ ] **Step 2: Run verifier tests — expect FAIL**

```bash
node --test --test-concurrency=1 \
  tests/scripts/verify-worker-runtime-live.test.mjs \
  tests/scripts/verify-shakedown-jerry-live.test.mjs
```

- [ ] **Step 3: Implement strict proof orchestrators**

The generic verifier gathers build/test output, request/attempt journals, queue/lease recovery, scheduler/event exact-once behavior, existing-worker parity, concurrent-worker isolation, resource-lock behavior, Agency consequence attachment, outbox acknowledgements, cancellation, retry, revocation, and restart persistence. The Shakedown verifier consumes site-side receipts and the live-proof matrix. Both reject stale evidence, incomplete wrappers, missing bindings, synthetic live claims, unverified rollback, and status flattening.

```js
export async function verifyProofBundle(bundle, { now, maxAgeMs, requiredRows }) {
  const missing = requiredRows.filter((row) => !bundle.receipts[row]);
  const stale = Object.entries(bundle.receipts)
    .filter(([, receipt]) => now - Date.parse(receipt.committedAt) > maxAgeMs)
    .map(([row]) => row);
  const invalid = [];
  for (const [row, receipt] of Object.entries(bundle.receipts)) {
    const bound = ['commitHash', 'manifestHash', 'grantHash', 'requestId', 'runId', 'attemptId']
      .every((key) => typeof receipt[key] === 'string' && receipt[key].length > 0);
    if (!bound || receipt.wrapperStatus === 'interrupted' || receipt.rollback?.status === 'unverified' ||
        receipt.syntheticLiveClaim === true || receipt.flattenedStatus === true) invalid.push(row);
  }
  return { status: missing.length || stale.length || invalid.length ? 'failed' : 'passed', missing, stale, invalid };
}

export const GENERIC_VERIFIER_MODES = new Set([
  'adversarial', 'authority-activation', 'crash-matrix', 'deployed', 'restart-continuity',
  'restart-during-occurrence', 'resurrection', 'wait-next-scheduled-occurrence',
]);

export const SHAKEDOWN_VERIFIER_MODES = new Set([
  'acquisition-learning-production-proof', 'adversarial', 'automation-overlap-safety',
  'automation-replacement-consequences', 'backend-runtime-production-proof',
  'authority-lane-consistency', 'billing-production-cleanup-readback',
  'billing-production-lifecycle', 'billing-production-preflight', 'capture-production-baseline',
  'complete-predeploy', 'data-promotion-production-proof',
  'distribution-production-proof', 'event-and-isolation-production-proof',
  'integrate-production-source', 'production', 'resident-pursuit', 'runner-release',
  'site-production-proof', 'write-billing-failure-handoff', 'write-completion-receipt',
  'write-failed-boundary-handoff',
]);

export function requireVerifierMode(mode, allowedModes) {
  if (!allowedModes.has(mode)) throw new TypeError(`unsupported verifier mode: ${mode}`);
  return mode;
}
```

- [ ] **Step 4: Run the full Home23 suite from the isolated worktree — expect PASS**

```bash
npm ci
npm run test:contracts
npm test
npm run build
node --test --test-concurrency=1 \
  tests/scripts/verify-worker-runtime-live.test.mjs \
  tests/scripts/verify-shakedown-jerry-live.test.mjs
```

- [ ] **Step 5: Commit clone test registration, then run the full Shakedown suite — expect PASS**

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
home_root=/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" \
  --manifest "$home_root/cli/templates/workers/shakedown-jerry/worker.yaml" \
  --channel-registry "$home_root/config/worker-channels/shakedown-jerry.yaml" \
  --dispatch-public-key "$home_root/config/worker-signing-keys/home23-operator-primary.json" \
  --capability-catalog "$clone_root/ops/shakedown-worker/config/capabilities.v1.json" \
  --collection-config "$clone_root/ops/jerry-collection/config.json" \
  --caddy-config /Users/jtr/server/config/Caddyfile \
  --preservation-manifest /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime/latest-public-manifest.json \
  --derive-target-hashes-for-current-catalog \
  --output-root "$clone_root/ops/shakedown-worker/config" \
  --require-operation-constants-from-home23 --write
node "$clone_root/ops/shakedown-worker/scripts/sync-home23-config.mjs" \
  --validate-only --output-root "$clone_root/ops/shakedown-worker/config" \
  --require-source-hashes --require-path-ceiling-subsets \
  --require-operation-equality --require-complete-catalog-targets
git -C "$clone_root" add ops/shakedown-worker/package.json \
  ops/shakedown-worker/config/channels.v1.json \
  ops/shakedown-worker/config/home23-dispatch-keys.v1.json \
  ops/shakedown-worker/config/capability-target-pins.v1.json
git -C "$clone_root" diff --cached --quiet || git -C "$clone_root" \
  commit -m "test(worker): bind final target pins and proof matrix"
matrix_clone_commit=$(git -C "$clone_root" rev-parse HEAD)
(cd "$clone_root" && npm --prefix shakedown-v2 ci)
(cd "$clone_root" && node --test --test-concurrency=1 shakedown-v2/test/*.test.mjs)
(cd "$clone_root" && npm --prefix shakedown-v2 run lint)
mkdir -p /Users/jtr/_JTR23_/worker-artifacts
build_dir=$(mktemp -d /Users/jtr/_JTR23_/worker-artifacts/shakedown-full-matrix.XXXXXXXX)
(cd "$clone_root" && npm --prefix shakedown-v2 run build -- --outDir "$build_dir")
chmod -R a-w "$build_dir"
(cd "$clone_root" && bun --cwd jerry-api install --frozen-lockfile)
(cd "$clone_root" && bun --cwd jerry-api test)
(cd "$clone_root" && bun --cwd jerry-api run type-check)
(cd "$clone_root" && bun --cwd jerry-api run build)
(cd "$clone_root" && node --test --test-concurrency=1 ops/shakedown-worker/tests/*.test.mjs)
```

Require `tests/workers/capability-executor.test.ts`, `tests/workers/shakedown-adapter-transport.test.ts`, `tests/workers/shakedown-capability-registry.test.ts`, `jerry-api/tests/billing-lifecycle-integration.test.ts`, and `ops/shakedown-worker/tests/billing-canary.test.mjs` to execute in this matrix. Their fixtures/sandbox coverage must prove one top-level billing capability, exact root/leaf module and export hashes, the shared operation set, one root authorization with zero operation reservations, fresh authorization plus one reservation per leaf, disjoint route locks, maximum outer depth one, and zero recursive outer calls before deployment; Task 32 contains no first-time automated billing implementation.

- [ ] **Step 6: Run explicit adversarial and crash matrices — expect PASS**

Exercise malformed manifests and grants, signature mismatch, revoked/expired authority, forged identity fields, generic registry bypass, nested adapter bypass, billing route stripping, billing root/child confusion, child-of-child dispatch, leaf-context recursion, root/leaf lock self-deadlock, authoritative leaf-state mismatch, traversal, symlink swap, shell/host/account/recipient injection, secret egress, budget overrun, lost lease, cancellation races, duplicate schedule/event delivery, uncertain publication/send/promotion, journal crash at every transition, rollback exhaustion, direct destructive site/data request, and unavailable credential authority. Each must fail closed or reconcile exactly as specified without side effects.

```bash
node scripts/verify-worker-runtime-live.mjs --mode adversarial --fixture-root tests/fixtures/workers
node scripts/verify-worker-runtime-live.mjs --mode crash-matrix --fixture-root tests/fixtures/workers
node scripts/verify-shakedown-jerry-live.mjs --mode adversarial \
  --clone-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
```

Expected: PASS with every case carrying either a fail-closed decision or an authoritative reconciliation receipt and zero unauthorized side effects.

- [ ] **Step 7: Materialize and verify the non-live immutable Shakedown runner release**

Materialize the exact tested worker-clone commit directly from the isolated clone beneath `/Users/jtr/websites/shakedownshuffle.com/releases/code/shakedown-worker` in a commit/hash-addressed read-only candidate directory. Export the full tracked repository tree, not only `ops/shakedown-worker`, so every fixed frontend/backend/collection/watchdog command resolves inside the same immutable commit. Install the runner from its committed npm lock, the frontend build closure from its lock, and Jerry API from its Bun lock inside the staged release; disable implicit install and ancestor resolution, keep caches outside the release, and hash each closure. Write a signed manifest with source/dependency trees, Node/Bun versions, entrypoint hash, capability catalog hash, channel projection hash, dispatch public-key hash, billing root module hash, leaf-router module/export hash, operation-vocabulary hash, disjoint route-lock hashes, tests, and predecessor. Smoke every catalog entry from the relocated staging root with a minimal environment and fixture adapters before chmod/atomic rename. Do not update any canonical Shakedown Git ref in this task; `shakedown.code.integrate` remains exclusively Task 31 Step 3 after grant activation. Point no live/public service at the runner yet. Prove the Home23 adapter rejects the mutable clone and accepts only this exact self-contained immutable release manifest. Reruns reuse an existing release only when its read-only source/dependency trees and manifest are byte-identical; any mismatch is fatal and is never overwritten.

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
runner_commit=$(git -C "$clone_root" rev-parse HEAD)
runner_root=/Users/jtr/websites/shakedownshuffle.com/releases/code/shakedown-worker
runner_release="$runner_root/$runner_commit"
if test ! -e "$runner_root"; then
  install -d -m 0700 "$runner_root"
fi
test -d "$runner_root" && test -w "$runner_root"
if test -e "$runner_release"; then
  node scripts/verify-shakedown-jerry-live.mjs --mode runner-release \
    --runner-release "$runner_release" --expected-commit "$runner_commit" \
    --require-read-only --require-byte-identical-tree \
    --require-dependency-closures --forbid-ancestor-resolution \
    --smoke-every-catalog-entry --minimal-environment --fixture-adapters-only
else
  runner_stage=$(mktemp -d "$runner_root/.prepare-$runner_commit.XXXXXXXX")
  git -C "$clone_root" archive "$runner_commit" | tar -x -C "$runner_stage"
  npm --prefix "$runner_stage/ops/shakedown-worker" ci --omit=dev \
    --ignore-scripts --no-audit --no-fund
  npm --prefix "$runner_stage/shakedown-v2" ci --ignore-scripts --no-audit --no-fund
  bun --cwd "$runner_stage/jerry-api" install --frozen-lockfile
  node scripts/verify-shakedown-jerry-live.mjs --mode runner-release \
    --runner-release "$runner_stage" --expected-commit "$runner_commit" \
    --hash-dependency-closures --forbid-ancestor-resolution \
    --smoke-every-catalog-entry --minimal-environment --fixture-adapters-only
  node scripts/verify-shakedown-jerry-live.mjs --mode runner-release \
    --runner-release "$runner_stage" --expected-commit "$runner_commit" \
    --require-source-and-dependency-tree-manifest
  chmod -R u+rwX,go-rwx "$runner_stage"
  chmod -R a-w "$runner_stage"
  mv "$runner_stage" "$runner_release"
fi
node /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime/scripts/bootstrap-shakedown-worker-clone.mjs \
  --verify-operator-invariant --operator-root /Users/jtr/websites/shakedownshuffle.com \
  --state-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/state
```

Expected: the verifier emits the immutable manifest and rejects a control invocation addressed to the mutable clone.

- [ ] **Step 8: Finalize, sign, and re-test the exact standing grant**

Regenerate the grant candidate from the green manifest, immutable runner release, capability catalog, canonical channel registry/projection hash, collection config/target hash, stable data root, service/host/account targets, rate/budget limits, machine gates, and explicit denies. The catalog is only an implementation-completeness input: finalization must assert the manifest lanes are disjoint, catalog keys equal their union, finalized standing capabilities equal the candidate/manifest standing intersection, no finalized standing capability appears in `hardStopCapabilities`, and the normal model registry equals the finalized standing set. Run a semantic diff against the unsigned Task 17 candidate, then sign with `home23-operator-primary` through the Keychain-backed CLI. The private key never enters environment output or Git. Verify signature/hash, confirm newly changed hashes are inactive or the unchanged exact hash retains its valid existing activation, run authority/manifest/adapter tests and `npm run test:contracts`, then commit the exact signed document before Task 29.

```bash
candidate_grant=config/worker-authority-grants/candidates/shakedown-jerry-standing.unsigned.yaml
final_grant=config/worker-authority-grants/shakedown-jerry-standing.yaml
if test -e "$final_grant"; then
  node cli/home23.js worker grant finalize "$final_grant" --write
else
  node cli/home23.js worker grant finalize "$candidate_grant" \
    --output "$final_grant" --write
fi
if ! node cli/home23.js worker grant verify "$final_grant" \
  --require-signed --require-inactive-or-exact-current-active \
  --scope-ceiling "$candidate_grant"
then
  node cli/home23.js worker grant verify "$final_grant" \
    --require-unsigned --scope-ceiling "$candidate_grant"
  node cli/home23.js worker grant sign \
    --key-id home23-operator-primary --input "$final_grant"
fi
node cli/home23.js worker grant verify "$final_grant" \
  --require-signed --require-inactive-or-exact-current-active \
  --scope-ceiling "$candidate_grant"
node scripts/verify-shakedown-jerry-live.mjs --mode authority-lane-consistency \
  --manifest cli/templates/workers/shakedown-jerry/worker.yaml \
  --grant "$final_grant" --require-disjoint-lanes \
  --require-catalog-equals-manifest-union \
  --require-standing-grant-and-model-registry-exclude-hard-stops
node --import tsx --test --test-concurrency=1 \
  tests/workers/grants.test.ts tests/workers/shakedown-authority.test.ts \
  tests/workers/shakedown-adapter-transport.test.ts
npm run test:contracts
if ! git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
    ls-files --error-unmatch "$final_grant" >/dev/null 2>&1 || \
   ! git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
    diff --quiet -- "$final_grant"
then
  git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime add "$final_grant"
  git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime diff --cached --check
  git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
    commit -m "chore(shakedown): sign exact standing authority"
fi
```

- [ ] **Step 9: Commit verifier registration**

```bash
git add scripts/verify-worker-runtime-live.mjs scripts/verify-shakedown-jerry-live.mjs \
  tests/scripts/verify-worker-runtime-live.test.mjs \
  tests/scripts/verify-shakedown-jerry-live.test.mjs package.json
git commit -m "test(workers): enforce complete runtime proof"
```

- [ ] **Step 10: Prove clone HEAD, immutable runner, grant, and future canonical import remain identical**

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
final_clone_commit=$(git -C "$clone_root" rev-parse HEAD)
runner_release=/Users/jtr/websites/shakedownshuffle.com/releases/code/shakedown-worker/$final_clone_commit
final_grant=config/worker-authority-grants/shakedown-jerry-standing.yaml
git -C "$clone_root" diff --quiet
git -C "$clone_root" diff --cached --quiet
node scripts/verify-shakedown-jerry-live.mjs --mode runner-release \
  --runner-release "$runner_release" --expected-commit "$final_clone_commit" \
  --require-read-only --require-byte-identical-tree
node cli/home23.js worker grant verify "$final_grant" \
  --require-runner-commit "$final_clone_commit" \
  --require-future-canonical-import-commit "$final_clone_commit"
```

Expected: no clone commit follows runner materialization; clone `HEAD`, immutable runner manifest, signed standing-grant binding, and the commit Task 31 will import to the dedicated canonical ref are the same exact hash. Any clone change restarts Task 28 at Step 5 and repeats Steps 6–10 before Task 29.

---

## Task 29: Deploy the repaired Home23 runtime with scoped restart and resurrection proof

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 28 committed/tested Home23 release, stable Worker state root, and predecessor PM2 dump/release inventory.
- Produces: final-`HEAD` complete-matrix proof, re-finalized exact grant, deployed owner-harness runtime with zero new Worker processes/ports, canonically installed ShakedownJerry plus its resident pursuit, authenticated channel/automation equality readbacks, scoped restart receipt, state-continuity proof, and guarded predecessor resurrection path.

**Files:**
- Modify: `cli/lib/generate-ecosystem.js`
- Modify: `cli/lib/pm2-commands.js`
- Modify: `cli/home23.js`
- Create: `scripts/deploy-home23-worker-runtime.mjs`
- Create: `tests/cli/worker-runtime-deploy.test.js`
- Modify: `scripts/guarded-pm2-save.mjs`
- Modify: `scripts/home23-pm2-watchdog.cjs`
- Modify: `scripts/home23-pm2-watchdog-daemon.cjs`
- Modify: `scripts/lib/pm2-agent-identity-guard.cjs`
- Modify: `tests/scripts/guarded-pm2-save.test.cjs`
- Modify: `tests/scripts/home23-pm2-watchdog.test.cjs`
- Modify: `tests/scripts/home23-pm2-watchdog-daemon.test.cjs`
- Modify: `tests/scripts/pm2-agent-identity-guard.test.cjs`
- Re-finalize and verify: `config/worker-authority-grants/shakedown-jerry-standing.yaml`
- Create at runtime: immutable Home23 Worker release directory and deployment receipt beneath the existing release/verification authority
- Create at runtime after deploy: canonical ShakedownJerry install/upgrade, pursuit-upsert, definition-readback, and inactive-authority dry-run receipts

- [ ] **Step 1: Write failing ecosystem, scoped-restart, predecessor, and resurrection tests**

```js
test('generated ecosystem hosts workers in owner harnesses and adds zero processes or ports', async () => {
  const ecosystem = await generate(fixture);
  assert.equal(processNames(ecosystem).filter((name) => /worker|shakedown/i.test(name)).length, 0);
  assert.equal(newPortsComparedWithBaseline(ecosystem).length, 0);
  assert.equal(ownerHarnessEnv(ecosystem, 'home23-jerry-harness').workerRuntimeEnabled, true);
  assert.equal(ownerHarnessEnv(ecosystem, 'home23-forrest-harness').workerRuntimeEnabled, true);
});

test('worker deployment restarts only affected Home23 processes', async () => {
  const result = await deploy(fixture);
  assert.deepEqual(result.restarted.sort(), [
    'home23-forrest', 'home23-forrest-dash', 'home23-forrest-harness',
    'home23-jerry', 'home23-jerry-dash', 'home23-jerry-harness',
  ]);
  assert.equal(result.unrelatedProcessChanges.length, 0);
});

test('failed live verifier restores the predecessor runtime', async () => {
  const result = await deploy(injectedFailureFixture);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.activeRelease, predecessorRelease);
});

test('deployment reconciles process death at every pointer and restart boundary', async () => {
  for (const failpoint of deploymentCrashBoundaries) {
    await crashDeploymentAt(failpoint, databasePath);
    const result = await reconcileDeployment(databasePath, authoritativePointerAndPm2Readback());
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.activeRelease, predecessorRelease);
    assert.deepEqual(result.processes, predecessorProcessStates);
  }
});

test('rollback failure freezes the target and emits an urgent canonical receipt', async () => {
  const result = await reconcileDeploymentWithRollbackFailure();
  assert.equal(result.status, 'frozen');
  assert.equal(result.newDeploymentsDenied, true);
  assert.equal(result.urgentReceipt.destination, 'jerry');
});

test('prepared Home23 release boots all six entrypoints from its own dependency closure', async () => {
  const release = await prepareRelease(fixture);
  assert.match(release.dependencyClosureSha256, /^[a-f0-9]{64}$/);
  assert.equal((await smokeAllSixEntrypoints(release, { NODE_PATH: '', hideAncestorNodeModules: true })).status, 'passed');
  await assert.rejects(() => smokeTamperedOrMissingDependency(release), /dependency|integrity/i);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
node --test --test-concurrency=1 tests/cli/worker-runtime-deploy.test.js
```

Expected: FAIL because `scripts/deploy-home23-worker-runtime.mjs` is absent.

- [ ] **Step 3: Implement in-process owner-harness deployment support**

Keep the broker/runtime construction in the existing `home23-jerry-harness` and `home23-forrest-harness`; no Worker process, port, socket server, Shakedown daemon, engine, brain, MCP, or scheduler is generated. `scripts/deploy-home23-worker-runtime.mjs` accepts one tested immutable release manifest, stable mutable-state root, exact affected PM2 names, predecessor release/dump, verifier command, and rollback command. It refuses a release missing the Task 1 preserved `src/home.ts` or `engine/src/realtime/websocket-server.js` patch identities. Before any pointer or PM2 effect it creates and fsyncs a mode-`0600` deployment journal beneath `/Users/jtr/_JTR23_/release/home23/instances/workers/runtime/deployments`; each pointer/readback/process transition is appended and fsynced before the next effect.

```js
export const WORKER_RUNTIME_PROCESSES = Object.freeze([
  'home23-jerry-harness', 'home23-forrest-harness',
  'home23-jerry', 'home23-forrest', 'home23-jerry-dash', 'home23-forrest-dash',
]);

export const DEPLOYMENT_STATES = Object.freeze([
  'prepared', 'snapshotted', 'switched', 'restarting', 'verifying', 'committed',
  'rolling_back', 'rolled_back', 'frozen',
]);

export async function deployHome23WorkerRuntime(input, deps) {
  if (input.processes.some((name) => !WORKER_RUNTIME_PROCESSES.includes(name))) throw new Error('unscoped PM2 target');
  if (input.addedProcesses.length || input.addedPorts.length) throw new Error('worker runtime must remain in owner harnesses');
  await deps.release.verifyManifest(input.releaseManifest, {
    requiredPatchIds: [input.homePatchId, input.websocketPatchId],
    stableStateRoot: '/Users/jtr/_JTR23_/release/home23/instances/workers',
  });
  const predecessor = await deps.runtime.snapshot(input.processes);
  const deployment = await deps.journal.prepareAndFsync({
    deploymentId: input.deploymentId,
    candidate: input.releaseManifest,
    predecessor,
    orderedProcesses: input.processes,
    verifierCommand: input.verifierCommand,
    state: 'prepared',
  });
  try {
    await deps.journal.transitionAndFsync(deployment, 'snapshotted', { predecessor });
    await deps.runtime.switchRelease(input.releaseManifest);
    await deps.journal.transitionAndFsync(deployment, 'switched', await deps.runtime.readPointer());
    for (const process of input.processes) {
      await deps.journal.transitionAndFsync(deployment, 'restarting', { process, phase: 'before' });
      await deps.runtime.restartOne(process);
      await deps.journal.transitionAndFsync(deployment, 'restarting', {
        process, phase: 'after', readback: await deps.runtime.readProcess(process),
      });
    }
    await deps.journal.transitionAndFsync(deployment, 'verifying', await deps.runtime.readAll(input.processes));
    const verified = await deps.verifier.run(input.verifierCommand);
    if (verified.status !== 'passed') throw new Error('live runtime verification failed');
    await deps.journal.transitionAndFsync(deployment, 'committed', { verified });
    return { status: 'committed', predecessor, verified, deploymentId: deployment.id };
  } catch (error) {
    return rollbackDeploymentFromJournal(deployment, error, deps);
  }
}

export async function reconcileOpenWorkerDeployments(deps) {
  for (const deployment of await deps.journal.listNonterminal()) {
    const observed = await deps.runtime.readPointerAndProcesses(deployment.orderedProcesses);
    if (observed.matchesCommittedCandidate && await deps.verifier.recheck(deployment)) {
      await deps.journal.transitionAndFsync(deployment, 'committed', { observed, reconciled: true });
      continue;
    }
    await rollbackDeploymentFromJournal(deployment, new Error('interrupted deployment'), deps, observed);
  }
}
```

`rollbackDeploymentFromJournal()` first fsyncs `rolling_back`, restores the exact predecessor pointer and each recorded predecessor process state, performs authoritative health/readback, then fsyncs `rolled_back`. If restoration or readback fails, it fsyncs `frozen`, denies subsequent deployment for the affected target set, and writes an urgent Jerry-visible canonical receipt with the exact manual recovery address. The deploy CLI and owner-harness startup both call `reconcileOpenWorkerDeployments()` before accepting new work; reconciliation is idempotent and uses the pointer plus PM2 truth rather than assuming the last wrapper exited normally.

- [ ] **Step 4: Run deployment tests, full tests, and commit machinery before live use — expect PASS**

```bash
node --test --test-concurrency=1 tests/cli/worker-runtime-deploy.test.js
node --test --test-concurrency=1 \
  tests/scripts/guarded-pm2-save.test.cjs \
  tests/scripts/home23-pm2-watchdog.test.cjs \
  tests/scripts/home23-pm2-watchdog-daemon.test.cjs \
  tests/scripts/pm2-agent-identity-guard.test.cjs
npm run build
npm run test:contracts
git add cli/lib/generate-ecosystem.js cli/lib/pm2-commands.js cli/home23.js \
  scripts/deploy-home23-worker-runtime.mjs scripts/guarded-pm2-save.mjs \
  scripts/home23-pm2-watchdog.cjs scripts/home23-pm2-watchdog-daemon.cjs \
  scripts/lib/pm2-agent-identity-guard.cjs tests/cli/worker-runtime-deploy.test.js \
  tests/scripts/guarded-pm2-save.test.cjs \
  tests/scripts/home23-pm2-watchdog.test.cjs \
  tests/scripts/home23-pm2-watchdog-daemon.test.cjs \
  tests/scripts/pm2-agent-identity-guard.test.cjs
git diff --cached --check
git commit -m "feat(runtime): deploy workers inside owner harnesses"
```

- [ ] **Step 5: Re-finalize bound authority inputs and rerun the complete Task 28 matrix at the deployment HEAD**

Recompute the grant candidate after the deployment/PM2 code commit. If any bound capability, target, service, config, profile, or runner hash changes, sign and commit the regenerated document first. Then run the complete Home23, Shakedown, adversarial, crash, billing-sandbox, and immutable-runner verification at the resulting final `HEAD`; deployment is forbidden unless this exact commit is the one named by the green proof bundle.

```bash
node cli/home23.js worker grant finalize \
  config/worker-authority-grants/shakedown-jerry-standing.yaml --write
if ! git diff --quiet -- config/worker-authority-grants/shakedown-jerry-standing.yaml; then
  node cli/home23.js worker grant sign \
    --key-id home23-operator-primary \
    --input config/worker-authority-grants/shakedown-jerry-standing.yaml
  git add config/worker-authority-grants/shakedown-jerry-standing.yaml
  git diff --cached --check
  git commit -m "chore(shakedown): rebind final deployed authority"
fi
final_home_commit=$(git rev-parse HEAD)
npm ci
npm run test:contracts
npm test
npm run build
node --test --test-concurrency=1 \
  tests/scripts/verify-worker-runtime-live.test.mjs \
  tests/scripts/verify-shakedown-jerry-live.test.mjs \
  tests/cli/worker-runtime-deploy.test.js
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
final_clone_commit=$(git -C "$clone_root" rev-parse HEAD)
node scripts/verify-shakedown-jerry-live.mjs --mode runner-release \
  --runner-release "/Users/jtr/websites/shakedownshuffle.com/releases/code/shakedown-worker/$final_clone_commit" \
  --expected-commit "$final_clone_commit" --require-read-only --require-byte-identical-tree
node cli/home23.js worker grant verify \
  config/worker-authority-grants/shakedown-jerry-standing.yaml \
  --require-runner-commit "$final_clone_commit" \
  --require-future-canonical-import-commit "$final_clone_commit"
(cd "$clone_root" && npm --prefix shakedown-v2 ci)
(cd "$clone_root" && node --test --test-concurrency=1 shakedown-v2/test/*.test.mjs)
(cd "$clone_root" && npm --prefix shakedown-v2 run lint)
(cd "$clone_root" && mkdir -p /Users/jtr/_JTR23_/worker-artifacts)
final_site_build=$(mktemp -d /Users/jtr/_JTR23_/worker-artifacts/shakedown-final-head.XXXXXXXX)
(cd "$clone_root" && npm --prefix shakedown-v2 run build -- --outDir "$final_site_build")
chmod -R a-w "$final_site_build"
(cd "$clone_root" && bun --cwd jerry-api install --frozen-lockfile)
(cd "$clone_root" && bun --cwd jerry-api test)
(cd "$clone_root" && bun --cwd jerry-api run type-check)
(cd "$clone_root" && bun --cwd jerry-api run build)
(cd "$clone_root" && node --test --test-concurrency=1 ops/shakedown-worker/tests/*.test.mjs)
node scripts/verify-worker-runtime-live.mjs --mode adversarial --expected-home-commit "$final_home_commit"
node scripts/verify-worker-runtime-live.mjs --mode crash-matrix --expected-home-commit "$final_home_commit"
node scripts/verify-shakedown-jerry-live.mjs --mode complete-predeploy \
  --expected-home-commit "$final_home_commit"
```

Expected: PASS, a clean tracked worktree, a valid exact grant that is either newly inactive or the unchanged exact currently active hash, and a proof bundle naming `final_home_commit`. A changed hash can never inherit the prior activation. This Step supersedes Task 28's earlier bundle for deployment authority.

- [ ] **Step 6: Capture fresh runtime truth and materialize an immutable release**

Record PM2 process names, IDs, scripts, cwd values, uptime, launchd/resurrection owners, listening routes, current dump, and predecessor hashes. Store the raw PM2 dump/environment/config backup only in the restricted preservation root with mode `0600`; the release/receipt gets a hash-only redacted manifest after secret/PII scan. Snapshot `/Users/jtr/_JTR23_/release/home23/instances/workers`, verify SQLite backup/recovery, and keep it outside the code release. Build from the tested committed isolated branch into a same-filesystem staging directory: install from `package-lock.json`, build, prune to a frozen production dependency closure, hash the closure, unset `NODE_PATH`, and prohibit resolution outside the staged root. Boot-smoke the six exact PM2 entrypoints from the relocated staging root with ancestor `node_modules` hidden, then fsync/chmod and atomically rename to the read-only versioned release. Bind release to implementation commit, preserved patch identities, tests, dependency lock/closure, Node/runtime versions, state schema, and rollback command without changing the user's dirty `main` worktree or index.

```bash
final_home_commit=$(git rev-parse HEAD)
node scripts/deploy-home23-worker-runtime.mjs prepare \
  --source /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime \
  --expected-commit "$final_home_commit" \
  --state-root /Users/jtr/_JTR23_/release/home23/instances/workers \
  --preservation-root /Users/jtr/_JTR23_/preservation/shakedown-jerry-runtime \
  --require-proof-bundle /Users/jtr/_JTR23_/release/home23/instances/workers/verification/final-predeploy.json \
  --install-from-lock --prune-production-dependencies \
  --forbid-ancestor-dependency-resolution --smoke-all-six-entrypoints
```

Expected: a read-only immutable release manifest with production dependency-closure hash and six relocated-entrypoint smoke receipts, a verified SQLite/state backup outside it, and a redacted receipt that names the restricted predecessor snapshot without exposing its contents.

- [ ] **Step 7: Wire the existing owner harnesses to the stable state and immutable code release**

Configure both existing owner harnesses with the same absolute stable Worker root, SQLite path, credential authority, lease timing, owner-scoped broker capacity, and health/management contract used by tests. Point Home23 engine/dashboard processes at the same immutable code release. Do not create any process or port and do not relocate mutable worker state into the release.

```js
export function ownerHarnessWorkerEnv(owner, release) {
  if (!['jerry', 'forrest'].includes(owner)) throw new Error('unknown worker owner');
  return Object.freeze({
    HOME23_RELEASE_ROOT: release.path,
    HOME23_WORKER_ROOT: '/Users/jtr/_JTR23_/release/home23/instances/workers',
    HOME23_WORKER_DB: '/Users/jtr/_JTR23_/release/home23/instances/workers/runtime/worker-runtime.sqlite',
    HOME23_WORKER_OWNER: owner,
    HOME23_WORKER_RUNTIME_ENABLED: 'true',
    HOME23_WORKER_MANAGEMENT_MODE: 'authenticated-in-process',
  });
}
```

- [ ] **Step 8: Deploy with predecessor ready and rolling-restart the exact affected processes**

Validate generated configuration, snapshot restricted current PM2 state, switch the immutable runtime pointer, and rolling-restart exactly `home23-jerry-harness`, `home23-forrest-harness`, `home23-jerry`, `home23-forrest`, `home23-jerry-dash`, and `home23-forrest-dash`, because `src/home.ts`, shared engine/Agency code, and Worker Desk code changed. Keep one owner path healthy while its peer restarts. Prove `home23-jerry-mcp`, `home23-forrest-mcp`, Query/PGS, memory, Cosmo, unrelated PM2 services, ports, and process definitions are unchanged.

```bash
node scripts/deploy-home23-worker-runtime.mjs reconcile \
  --require-no-open-deployment --fail-on-frozen-target
node scripts/deploy-home23-worker-runtime.mjs deploy \
  --manifest /Users/jtr/_JTR23_/release/home23/instances/workers/verification/prepared-home23-release.json \
  --process home23-jerry-harness --process home23-forrest-harness \
  --process home23-jerry --process home23-forrest \
  --process home23-jerry-dash --process home23-forrest-dash \
  --verifier "node scripts/verify-worker-runtime-live.mjs --mode deployed"
```

Expected: exactly the six named processes roll, no process definition or port is added, and failure restores the predecessor pointer/process state automatically.

- [ ] **Step 9: Install ShakedownJerry through the deployed authenticated management plane**

Before any canonical Worker-state write, use the newly deployed service to refresh channels and automation/runtime inventory and require exact equality with the tracked Task 17 authorities; these commands are read-only and use `--no-write`. Any drift stops here and returns to Task 17 or Task 27, followed by a fresh Task 28/29 build and deployment. On equality, install the exact template from `final_home_commit` idempotently into the stable Worker root while preserving the Task 16 source clone, state, runs, receipts, and activation records. Upsert the one resident pursuit, validate the installed profile, and run a no-authority observe dry run. Write canonical install/upgrade, pursuit, inventory-readback, validation, and dry-run receipts. Live/public capabilities must remain inactive.

```bash
service_url=http://127.0.0.1:5004
canonical_runtime_root=/Users/jtr/_JTR23_/release/home23/instances/workers
clone_root="$canonical_runtime_root/shakedown-jerry/workspace/source-clones/shakedownshuffle"
final_home_commit=$(git rev-parse HEAD)
prepared_release=/Users/jtr/_JTR23_/release/home23/instances/workers/verification/prepared-home23-release.json
target_pin_projection="$clone_root/ops/shakedown-worker/config/capability-target-pins.v1.json"
node scripts/deploy-home23-worker-runtime.mjs verify-active \
  --manifest "$prepared_release" --expected-commit "$final_home_commit" \
  --require-active-pointer --read-only
clone_hash_before=$(node scripts/bootstrap-shakedown-worker-clone.mjs \
  --hash-only --clone "$clone_root")
node cli/home23.js worker channels inventory shakedown-jerry \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --require-kind substack --require-kind public-non-substack \
  --require-kind consented-communications \
  --compare-definition config/worker-channels/shakedown-jerry.yaml --no-write
node cli/home23.js worker automation inventory shakedown-jerry \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --compare-matrix config/worker-migrations/shakedown-jerry-automation-matrix.yaml \
  --require-definition-hashes --no-write
node cli/home23.js worker install shakedown-jerry \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --runtime-root "$canonical_runtime_root" \
  --require-release-commit "$final_home_commit" \
  --target-pin-projection "$target_pin_projection" --preserve-workspace
node cli/home23.js worker pursuit upsert shakedown-jerry \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --runtime-root "$canonical_runtime_root" \
  --definition config/worker-pursuits/shakedown-jerry.yaml
node cli/home23.js worker validate shakedown-jerry \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --runtime-root "$canonical_runtime_root" \
  --require-release-commit "$final_home_commit" \
  --require-target-pin-projection "$target_pin_projection" \
  --require-runtime-target-hashes-equal-projection \
  --require-live-capabilities-inactive
node cli/home23.js worker run shakedown-jerry --mission observe --dry-run \
  --service-url "$service_url" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator \
  --runtime-root "$canonical_runtime_root" \
  --expect-live-capabilities-inactive
test "$(node scripts/bootstrap-shakedown-worker-clone.mjs --hash-only --clone "$clone_root")" = "$clone_hash_before"
```

Expected: the active immutable release is exactly `final_home_commit`; tracked/live channel and automation authorities compare exactly; installation and pursuit upsert each produce a canonical idempotent receipt; the installer creates canonical `state/resolved-target-hashes.json` from the committed final target-pin projection and validation proves exact semantic equality; the source clone hash is unchanged; validation and dry run pass through the deployed authenticated route; and no live/public capability, schedule, event binding, standing grant, or hard-stop authorization is activated.

- [ ] **Step 10: Prove repository, stable-state, and live/runtime truth separately**

Record the implementation branch/commit and confirm the dirty `main` inventory remains unchanged. Verify both preserved local patch identities are in the running release. Then prove both owner-harness health routes, authenticated worker management, one existing worker real run, Jerry and Forrest turns, Worker Desk load, receipt/outbox delivery, SQLite/state/source-clone/activation continuity, and zero duplicate/new daemons. A static 200 or green build is not live runtime proof.

```bash
node scripts/verify-worker-runtime-live.mjs --mode deployed \
  --require-owner jerry --require-owner forrest \
  --require-existing-worker-run --require-worker-desk \
  --require-worker shakedown-jerry --require-resident-pursuit shakedown-growth \
  --require-live-capabilities-inactive --require-definition-readbacks \
  --require-outbox-ack --require-state-continuity --require-zero-new-processes
git -C /Users/jtr/_JTR23_/release/home23 status --short --branch
git -C /Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime rev-parse HEAD
```

Expected: PASS and the original main-worktree inventory matches the Task 1 capture exactly.

- [ ] **Step 11: Prove guarded resurrection and rollback**

Save only the verified PM2 topology through the existing guarded procedure, retaining the predecessor restricted dump. Restart each owner harness during a queued scheduled occurrence and prove exactly-once completion through the shared SQLite queue. Exercise predecessor code/state-schema rollback and restricted dump restore, verify Jerry/Forrest/current workers, then re-deploy the verified release. Confirm resurrection restores the same existing process topology and immutable paths, with zero Worker process.

```bash
node scripts/guarded-pm2-save.mjs --require-verification \
  /Users/jtr/_JTR23_/release/home23/instances/workers/verification/deployed-worker-runtime.json
node scripts/verify-worker-runtime-live.mjs --mode restart-during-occurrence \
  --process home23-jerry-harness --process home23-forrest-harness
node scripts/deploy-home23-worker-runtime.mjs exercise-rollback \
  --manifest /Users/jtr/_JTR23_/release/home23/instances/workers/verification/prepared-home23-release.json \
  --restore-verified-release --crash-at-every-deployment-boundary \
  --require-journal-reconciliation --require-no-frozen-target
node scripts/verify-worker-runtime-live.mjs --mode resurrection \
  --require-zero-new-processes --require-exactly-once-occurrence \
  --require-worker shakedown-jerry --require-resident-pursuit shakedown-growth
```

Expected: PASS with predecessor restoration and subsequent verified redeploy both proven; the guarded dump retains exactly the pre-existing PM2 topology.

- [ ] **Step 12: Run deployment tests and live generic verifier — expect PASS**

```bash
node --test --test-concurrency=1 tests/cli/worker-runtime-deploy.test.js
node --test --test-concurrency=1 \
  tests/scripts/guarded-pm2-save.test.cjs \
  tests/scripts/home23-pm2-watchdog.test.cjs \
  tests/scripts/home23-pm2-watchdog-daemon.test.cjs \
  tests/scripts/pm2-agent-identity-guard.test.cjs
node scripts/verify-worker-runtime-live.mjs --mode deployed \
  --require-worker shakedown-jerry --require-resident-pursuit shakedown-growth \
  --require-live-capabilities-inactive --require-definition-readbacks
```

---

## Task 30: Present and activate the exact tested Shakedown standing-grant hash

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: Task 29's re-finalized exact grant, complete-matrix proof bound to the deployed `HEAD`, and deployed runtime/preflight readbacks.
- Produces: operator-visible authority preflight and, only after exact authorization, the durable exact-hash activation/revocation receipts consumed at every action boundary.

**Files:**
- No source changes expected
- Create at runtime: canonical authority preflight receipt
- Create at runtime after authorization: exact-hash activation record

- [ ] **Step 1: Generate the final authority preflight from deployed truth**

Verify signature, canonical hash, signer, expiry/renewal behavior, manifest/profile binding, channel registry, account preflights, schedule/event bindings, machine gates, release snapshots, rollback commands, finite safety reserve, current automation matrix, and every explicit deny. Re-run the destructive-denial test against the deployed executor.

```bash
node cli/home23.js worker grant preflight shakedown-jerry \
  --grant config/worker-authority-grants/shakedown-jerry-standing.yaml \
  --require-deployed-proof /Users/jtr/_JTR23_/release/home23/instances/workers/verification/deployed-worker-runtime.json \
  --write-receipt
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='destructive target remains denied' \
  tests/workers/shakedown-authority.test.ts
```

Expected: a signed exact-grant preflight receipt reporting either `inactive_new_hash` or `exact_current_hash_already_active`, plus PASS for the destructive denial; a changed hash is always inactive.

- [ ] **Step 2: Present the exact grant summary and hash to the user**

Show allowed action classes and exact live targets, hard stops, configured accounts, budgets/rates, expiry/revocation behavior, rollback readiness, canonical grant hash, and current exact-hash activation status. If this is an inactive new hash, ask the user to activate that exact hash; prior general approval of the design or plan is not substituted. If a convergent rerun retained the already-active exact same hash, present the existing activation receipt and continue without manufacturing a second approval.

```bash
node cli/home23.js worker grant show shakedown-jerry \
  --preflight-summary --show-canonical-hash --show-activation-status
```

Expected: human-readable scope plus one canonical hash. Pause only for `inactive_new_hash`; `exact_current_hash_already_active` must link the still-valid prior activation receipt.

- [ ] **Step 3: Authenticate and record exact-hash activation**

Use the operator-authenticated Worker Desk or CLI activation endpoint. The server ignores any browser-supplied principal, rehashes the stored signed grant, validates signer and preflight receipt, and atomically records grant hash, authenticated operator principal, timestamp, expiry, and preflight binding.

```bash
shakedown_grant_hash=$(node cli/home23.js worker grant show shakedown-jerry --canonical-hash-only)
grant_activation_status=$(node cli/home23.js worker grant show shakedown-jerry --activation-status-only)
if test "$grant_activation_status" = inactive_new_hash; then
  node cli/home23.js worker grant activate shakedown-jerry \
    --grant-hash "$shakedown_grant_hash" \
    --preflight-receipt /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/receipts/authority-preflight.json
elif test "$grant_activation_status" = exact_current_hash_already_active; then
  node cli/home23.js worker grant show shakedown-jerry \
    --require-active-hash "$shakedown_grant_hash" --show-activation-receipt
else
  exit 1
fi
```

Expected: either a new `activated` record after explicit exact-hash authorization, or verified reuse of the existing exact-hash activation; a changed/mismatched hash never inherits authority and no unapproved activation row is written.

- [ ] **Step 4: Prove activation, mismatch, revocation, and reactivation behavior**

Run one harmless covered read action without per-action approval. Attempt a modified-hash action and prove `require-human-authorization`. Revoke the grant and prove new live actions stop immediately with the same authorization-required state while a mandatory verifier/rollback can finish. Reactivate only the original exact tested hash and confirm the audit chain. Separately prove a hard-denied target remains `deny`.

```bash
shakedown_grant_hash=$(node cli/home23.js worker grant show shakedown-jerry --canonical-hash-only)
node cli/home23.js worker run shakedown-jerry --mission observe --wait-for-receipt
node cli/home23.js worker grant test-mismatch shakedown-jerry --expect require-human-authorization
node cli/home23.js worker grant revoke shakedown-jerry --grant-hash "$shakedown_grant_hash"
node cli/home23.js worker run shakedown-jerry --mission observe --expect require-human-authorization
node cli/home23.js worker grant activate shakedown-jerry \
  --grant-hash "$shakedown_grant_hash" \
  --preflight-receipt /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/receipts/authority-preflight.json
node cli/home23.js worker action test-denial shakedown-jerry --fixture destructive-target --expect deny
```

Expected: the harmless read succeeds, mismatch/revocation require authorization, original-hash reactivation succeeds, and the destructive target remains denied.

- [ ] **Step 5: Store the activation proof as a canonical receipt**

No credential, signature private material, session cookie, or direct account identifier may appear in the receipt.

```bash
node scripts/verify-worker-runtime-live.mjs --mode authority-activation \
  --worker shakedown-jerry --require-redaction --require-revocation-chain
```

Expected: PASS and one canonical activation proof bound to the exact deployed grant/preflight hashes.

---

## Task 31: Execute the complete Shakedown live-proof matrix under standing authority

**Working directory:** Orchestrate from `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`; all Shakedown actions cross the immutable Task 28 runner and exact Task 30 active grant.

**Interfaces:**
- Consumes: Task 30 active grant, immutable Home23/Shakedown releases, Task 22 rollback controls, and all typed capabilities from Tasks 18–26.
- Produces: live proof bundle for source integration, site/backend/Caddy/PM2 recovery, collection, enrichment, indexing, distribution, social image, mature campaign learning/retirement, and exact-once event consequence; payment remains excluded.

**Files:**
- No source changes are allowed inside the live-proof run; a defect returns execution to its owning implementation task, failing test, commit, full Task 28 matrix, deployment, and exact-grant preflight before this task restarts
- Create at runtime: immutable Shakedown live-proof receipt bundle

- [ ] **Step 1: Refresh all live baselines and rollback addresses**

Capture Home23/worker authority, Shakedown operator-checkout invariant, live and `v2` tree hashes, Caddy config hash, PM2/API/audio/watchdog state, Matomo/Supabase/Stripe read authorities, collection/enrichment authority, channel account preflights, automation states, current sitemap/indexing state, and exact predecessor release paths. Abort on unexplained drift.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode capture-production-baseline \
  --worker shakedown-jerry --require-active-grant --write-receipt
```

Expected: PASS and a fresh baseline receipt containing hashes/addresses only; any unexplained drift exits non-zero before a side effect.

- [ ] **Step 2: Prove observe, select, act, and learn through Jerry's resident pursuit**

Trigger a real read-only cycle. Require ShakedownJerry to read current traffic/listening/funnel/search/operator evidence, write one supported opportunity, select a bounded useful action, attach it to the Shakedown pursuit, and explain the evidence and intended consequence to Jerry.

```bash
node cli/home23.js worker run shakedown-jerry \
  --mission observe-select-explain --pursuit shakedown-growth --wait-for-receipt
node scripts/verify-shakedown-jerry-live.mjs --mode resident-pursuit \
  --require-supported-opportunity --require-jerry-explanation
```

Expected: one read-only attempt, one evidence-bound opportunity, and one pursuit attachment; no public action occurs in this step.

- [ ] **Step 3: Integrate the exact tested source commit before any production cutover**

Invoke `shakedown.code.integrate` for the exact Task 28 clone ref/commit. It creates a hash-bound run-scoped Git bundle, verifies and imports the previously independent objects through a temporary namespace, proves base/ancestry/patch identities, then atomically creates or updates only the dedicated canonical `refs/heads/codex/shakedown-worker/*` ref and removes the temporary ref. Prove the active operator checkout/remotes/index/worktree are unchanged and require the site/backend build commit to be reachable from that canonical ref. Materialize the exact immutable runner, frontend, backend, and operational release manifests from the canonical commit. A production cutover is blocked if its source is reachable only from the mutable worker clone or if any required object appeared without the verified import receipt.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode integrate-production-source \
  --canonical-ref refs/heads/codex/shakedown-worker/production \
  --clone-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle \
  --require-verified-bundle-import --require-object-import-before-ref \
  --require-base-ancestry-and-patch-identities --require-temp-ref-cleanup \
  --require-operator-checkout-invariant --require-no-remote-push \
  --materialize-release-manifests
```

Expected: the receipt binds bundle hash, imported commit, base, patch IDs, previous ref or zero OID, and atomic update; the temporary ref is absent; only the dedicated local ref changes; every release commit is reachable from it; and the operator checkout fingerprint is unchanged.

- [ ] **Step 4: Publish one bounded owned-site improvement and exercise real rollback**

Build to a newly allocated non-existing immutable output directory, create candidate and pre-cutover snapshot, run `npm --prefix shakedown-v2 run check:operator`, verify the complete public contract including mandatory owned signed-in playback, and cut over through the typed capability. Run the operator check and browser/public readback again post-cutover. Prove `html/pro`, `env-config.js`, shared `shakedown-v2/dist`, active operator checkout, and `v2.shakedownshuffle.com` are unchanged. Then cut over a byte-equivalent known-good candidate, inject a verifier failure, restart during rollback, prove automatic predecessor restoration, and rerun operator/public checks.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode site-production-proof \
  --worker shakedown-jerry --require-owned-signed-in-session \
  --release-root /Users/jtr/websites/shakedownshuffle.com/releases \
  --require-operator-check --exercise-rollback --require-live-only-preservation
```

Expected: a successful bounded cutover receipt plus an injected-failure rollback receipt; protected live-only artifacts, shared `dist`, operator checkout, and `v2` hashes remain unchanged.

- [ ] **Step 5: Deploy one harmless backend canary and prove Caddy/runtime resurrection**

Deploy the immutable backend release against `/Users/jtr/_JTR23_/shakedown-runtime-data`, restart only `jerry-api` under the real shared watchdog/worker lock, and verify health plus read-only show/search/entitlement status. Exercise predecessor code/data-pointer rollback, then restore the verified release. Validate and perform one byte-equivalent fixed-target Caddy reload through `homebrew.mxcl.caddy`, prove routes and rollback. Separately exercise the fixed `shakedown-audio-static` recovery path through the retained `com.jtr.caddy-static` owner while holding `shakedown-audio-static-recovery`; require the catalog-pinned byte-range canary at port `18089`, unchanged owner/port/root/route hashes, and no runtime-strategy switch. Guarded-save the verified PM2 topology with `jerry-api` on the immutable release, retain the predecessor restricted dump, and prove resurrection returns exactly one `jerry-api` with watchdog using the same active pointer and lock.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode backend-runtime-production-proof \
  --data-root /Users/jtr/_JTR23_/shakedown-runtime-data \
  --service jerry-api --service caddy --service shakedown-audio-static \
  --exercise-rollback --exercise-resurrection --require-single-recovery-lock \
  --exercise-audio-static-recovery --require-audio-byte-range-canary
```

Expected: all named fixed targets pass readback/rollback under retained owners, the audio-static receipt names `com.jtr.caddy-static`, lock `shakedown-audio-static-recovery`, and port `18089`, PM2 resurrection is guarded, and no audio runtime-strategy change occurs.

- [ ] **Step 6: Prove every configured distribution lane and one actual correction**

For Substack and each configured non-Substack public adapter, execute the smallest safe live canary and perform authoritative account/URL readback. Then exercise one safe update/correction on a canary artifact and obtain a distinct correction-handling/readback receipt. For consented communications, use one owned consented test recipient, prove suppression first with a suppressed fixture, send one bounded test communication, and obtain authoritative provider delivery/readback. Record that email is irreversible and never infer success from browser state alone.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode distribution-production-proof \
  --all-configured-public-channels --require-correction-readback \
  --owned-consented-test-recipient --require-suppression-denial-first
```

Expected: one canonical receipt per configured lane, authoritative URL/provider readback, and no send outside the owned consented canary.

- [ ] **Step 7: Promote one additive collection candidate and one separate enrichment candidate**

For each lane separately, prove config/target/grant hash, stable data root, source, watermark, hashes, validation, snapshot, promotion authority, backend reload, API/runtime readback, public readback, and rollback. A `waiting_for_batch_pair` result remains a valid wait and does not satisfy the promotion proof; use only a naturally ready additive candidate. Re-run the immutable-backend -> promotion -> API/public readback -> rollback integration against production authority.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode data-promotion-production-proof \
  --lane collection --lane enrichment \
  --data-root /Users/jtr/_JTR23_/shakedown-runtime-data \
  --require-naturally-ready-candidate --exercise-rollback
```

Expected: two distinct consequence/rollback chains; `waiting_for_batch_pair` cannot satisfy the collection promotion row.

- [ ] **Step 8: Prove acquisition, indexing, social-image, mature campaign, and retirement consequences**

Ingest real search demand; verify show/venue/year/date/song/lineup/lineage eligibility and generated-route coverage; complete one source-backed social-image repair or compliant asset improvement and verify live crawler-visible metadata/image; submit the complete changed canonical URL set through `shakedown.indexing`; and read back submission/index state without claiming indexing prematurely. Use an already mature attributable UTM campaign or wait through the actual configured maturity window. Completion requires joined UTM, behavior, and authoritative aggregate conversion evidence, a channel-score update, and retirement/revision of one weak recurring item. A future one-shot alone cannot pass this row.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode acquisition-learning-production-proof \
  --require-route-kind show --require-route-kind venue --require-route-kind year \
  --require-route-kind date --require-route-kind song --require-route-kind lineup \
  --require-route-kind lineage --require-social-image-consequence \
  --require-indexing-readback --require-mature-campaign --require-retirement-consequence
```

Expected: PASS only with completed live consequences and mature joined evidence; a scheduled future readback is insufficient.

- [ ] **Step 9: Prove event exact-once, denial, rollback, restart, and lane isolation**

Deliver one safe live event twice and replay it, then prove exactly one request, one attempt, one canonical receipt, and one attached Shakedown pursuit consequence. Attempt one destructive website/data action and prove denial before effects. Force one channel adapter failure and prove observation, collection, and other lanes continue. Revoke the standing grant and prove new live work becomes authorization-required, then restore the exact grant activation. Bind every restart/rollback receipt to the canonical source/release hashes.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode event-and-isolation-production-proof \
  --deliver-safe-event-count 2 --replay-safe-event \
  --require-exactly-one-consequence --require-destructive-denial \
  --inject-channel-failure --exercise-grant-revocation-reactivation
```

Expected: exactly one request/attempt/receipt/consequence, a pre-effect denial, unaffected independent lanes, and restored original-hash activation.

- [ ] **Step 10: Run the strict live verifier — expect PASS except the separately authorized payment row**

```bash
node scripts/verify-shakedown-jerry-live.mjs \
  --mode production \
  --exclude-separately-authorized-payment-canary
```

The verifier must enumerate every row and label only the payment canary `awaiting_separate_authorization`; it may not flatten that row into a full-system pass.

- [ ] **Step 11: Route any defect back through its owning implementation task**

Abort the live-proof run at the failed boundary and preserve its evidence. Resume the exact earlier task that owns that module, add the failing regression, implement and commit the root-cause repair there, rerun Task 28, redeploy Task 29 as needed, regenerate/reactivate the exact Task 30 grant hash if any bound hash changed, and restart Task 31 from Step 1. Do not patch live artifacts or create an ad hoc live-test commit.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode write-failed-boundary-handoff \
  --require-owner-task --require-failing-reproduction --forbid-live-patch
```

Expected: a non-passing handoff receipt naming the owning task and reproduction; execution stops before any further live action.

---

## Task 32: Execute the separately authorized production signup, payment, webhook, and entitlement canary

**Working directory:** Orchestrate from `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`; invoke every Shakedown frontend/backend/runner command through the absolute clone root `/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle`, and invoke production actions only through the immutable runner plus Home23 action boundary.

**Interfaces:**
- Consumes: Task 18 billing adapter, Task 28 automated/sandbox lifecycle proof, and a Task 5 durable single-use exact hard-stop authorization.
- Produces: redacted production signup/charge/webhook/entitlement/refund/cancel/cleanup receipt bundle with authoritative readback and consumed-authorization proof.

**Files:**
- No source changes are allowed inside the production-canary run; any defect returns to Task 18's billing lifecycle implementation and tests, then repeats Tasks 28–32 with a newly valid exact authorization if its hash or expiry changed
- Create at runtime: exact production-canary authorization and redacted lifecycle receipt bundle

- [ ] **Step 1: Re-run the already committed automated and sandbox lifecycle coverage**

Re-run the Task 18/28 committed tests for signup/session creation, checkout request validation, replay protection, redirect validation, pending activation, Stripe signature and event idempotency, out-of-order and duplicate webhooks, failed/expired/cancelled/refunded states, entitlement reconciliation, recovery after restart, frontend status polling, exact hard-stop bounds, and standing-grant rejection. Use Supabase/Stripe current official contracts and local fixtures/sandbox; no production mutation occurs.

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
bun --cwd "$clone_root/jerry-api" test tests/billing-lifecycle-integration.test.ts
node --test --test-concurrency=1 "$clone_root/ops/shakedown-worker/tests/billing-canary.test.mjs"
node --import tsx --test --test-concurrency=1 tests/workers/hard-stop-authorizations.test.ts
```

Expected: PASS using fixtures/sandbox only and zero live-mode network operations.

- [ ] **Step 2: Run billing/Auth tests — expect PASS**

```bash
clone_root=/Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones/shakedownshuffle
bun --cwd "$clone_root/jerry-api" test
bun --cwd "$clone_root/jerry-api" run type-check
node --test --test-concurrency=1 "$clone_root"/shakedown-v2/test/*.test.mjs
```

- [ ] **Step 3: Present a separate exact hard-stop canary request to the user**

Name the owned controlled identity alias, exact Supabase project, production site and Stripe accounts, maximum charge in minor units, currency, the complete shared signup/checkout/charge/webhook/entitlement/cancel/refund/pending-state-reconcile/cleanup sequence, expiry, nonce, expected transitions, rollback/cleanup limits, and redaction policy. Bind the canonical orchestration plan plus immutable runner release, capability catalog, root module, internal leaf-router module/export, operation vocabulary, disjoint route-lock policy, state machine, cleanup plan, and redaction-policy hashes. Generate the exact unsigned non-standing request and present its canonical request hash. The standing grant and design approval do not authorize this canary; pause before signing or registration until the user explicitly approves that exact identity, targets, maximum, operations, expiry, and hash-bound cleanup plan.

```bash
node cli/home23.js worker hard-stop prepare shakedown-jerry \
  --capability shakedown.billing.production-canary \
  --identity-alias owned-production-canary \
  --site-account-alias shakedown-production \
  --stripe-account-alias shakedown-stripe-live \
  --supabase-project-ref pkbnsqnkuoifudvbbdbe \
  --prompt-max-amount-minor --currency usd --prompt-expiry \
  --operation signup --operation checkout --operation charge \
  --operation webhook --operation entitlement --operation cancel \
  --operation refund --operation pending-state-reconcile --operation cleanup \
  --bind-orchestration-plan --bind-state-machine-from-immutable-runner \
  --bind-runner-release --bind-capability-catalog \
  --bind-billing-root-module --bind-billing-leaf-router \
  --bind-operation-vocabulary --bind-route-lock-policy \
  --bind-cleanup-plan --bind-redaction-policy \
  --output-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/authorizations/candidates \
  --new-nonce --write-unsigned-request
node cli/home23.js worker hard-stop show shakedown-jerry \
  --document-status latest-awaiting-approval \
  --show-canonical-request-hash
```

Expected: the CLI derives operation validation from `BILLING_CANARY_OPERATIONS`, prompts for and records the user's explicit maximum amount and expiry, resolves all ten immutable binding hashes, then emits an unsigned exact request summary and hash; pause until the user authorizes the identity, project/accounts, amount, operations, expiry, orchestration/runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/state-machine, and cleanup/redaction hashes encoded by that exact hash.

- [ ] **Step 4: Sign, authenticate, register, and verify the exact approved hard-stop authorization**

Resume only after the user approves the exact canonical request hash shown in Step 3. Sign the document with the operator Keychain key, then call the authenticated operator-only registration endpoint with that same approved request hash and an immutable approval receipt. The server rehashes both unsigned scope and signed document, verifies signature/principal/expiry/bounds, records one active single-use authorization transactionally, and emits a redacted registration receipt. A different hash, stale expiry, absent authenticated approval receipt, non-operator credential, or standing-grant substitution writes no authorization row.

```bash
unsigned_billing_request=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --latest-awaiting-approval-path-only)
approved_request_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --document "$unsigned_billing_request" --canonical-request-hash-only)
approval_receipt=$(node cli/home23.js worker hard-stop approve shakedown-jerry \
  --document "$unsigned_billing_request" \
  --prompt-exact-hash --require-interactive-operator --receipt-path-only)
signed_billing_request=$(node cli/home23.js worker hard-stop sign shakedown-jerry \
  --input "$unsigned_billing_request" \
  --output-root /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/authorizations/signed \
  --key-id home23-operator-primary --output-path-only)
node cli/home23.js worker hard-stop register shakedown-jerry \
  --document "$signed_billing_request" \
  --approved-request-hash "$approved_request_hash" \
  --approval-receipt "$approval_receipt" \
  --credential-keychain-service home23.worker-management \
  --credential-account operator
node cli/home23.js worker hard-stop status shakedown-jerry \
  --capability shakedown.billing.production-canary \
  --require-active --require-single-use --require-approval-binding
```

Expected: one active signed authorization record whose approved request hash, signed document hash, authenticated operator receipt, identity/project/accounts, amount, operations, expiry, orchestration plan, runner/catalog/root-module/leaf-router/operation-vocabulary/route-lock/state-machine, cleanup, and redaction bounds all match; no billing operation is consumed yet.

- [ ] **Step 5: Re-run production preflight immediately before action**

Verify owned email/browser session access, Supabase project identity, Stripe live-mode account/product/price, HTTPS callback/redirect allowlist, webhook endpoint and signing-secret presence, event-store idempotency, pending-subscription cleanup, current entitlement baseline, maximum amount, authoritative readback routes, exact root and leaf-router module/export hashes, shared operation-vocabulary hash, disjoint root/leaf route-lock hash, and state-machine hash. Abort without mutation on any mismatch.

```bash
billing_canary_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --capability shakedown.billing.production-canary --authorized-hash-only)
node scripts/verify-shakedown-jerry-live.mjs --mode billing-production-preflight \
  --authorization-hash "$billing_canary_hash" \
  --require-owned-session --require-supabase-project pkbnsqnkuoifudvbbdbe \
  --require-stripe-live-account-alias shakedown-stripe-live \
  --require-bound-billing-root-module --require-bound-billing-leaf-router \
  --require-bound-operation-vocabulary --require-disjoint-route-locks \
  --require-bound-state-machine --forbid-mutation
```

Expected: PASS with a redacted preflight receipt; mismatch exits before checkout/session/account mutation.

- [ ] **Step 6: Execute one controlled production lifecycle**

Create one trusted root orchestration action from the persisted exact hard-stop binding; it acquires the root lease and root-only route lock but consumes no lifecycle operation. In that same bounded run, create the owned signup if needed, establish the authenticated session, initiate checkout exactly once with the authorized canary idempotency identity, and execute the complete nine-operation lifecycle through `CapabilityExecutor` as one deterministic server-derived internal leaf per transition with the inherited authorization hash, a fresh authorization check, and one hard-stop reservation. The immutable runner must report exactly one outer module call at maximum depth one, nine leaf authorization checks/reservations/module calls, zero recursive outer calls, exact child IDs, and no root-held leaf lock. Complete the bounded payment, capture Stripe event identifiers, prove webhook acceptance/idempotency, prove pending activation and entitlement transitions, then perform the authorized cancel/refund/reconciliation/cleanup suffix. Browser analytics are supporting evidence only. Uncertain state freezes replay and later transitions until Stripe/Supabase authoritative reconciliation.

```bash
billing_canary_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --capability shakedown.billing.production-canary --authorized-hash-only)
node scripts/verify-shakedown-jerry-live.mjs --mode billing-production-lifecycle \
  --authorization-hash "$billing_canary_hash" \
  --identity-alias owned-production-canary --require-single-checkout \
  --require-webhook-idempotency --require-entitlement-readback \
  --require-complete-authorized-sequence --require-cleanup \
  --require-root-module-calls 1 --require-root-operation-reservations 0 \
  --require-leaf-authorization-checks 9 --require-leaf-reservations 9 \
  --require-leaf-module-calls 9 --require-recursive-outer-module-calls 0 \
  --require-max-outer-depth 1 --require-deterministic-child-ids \
  --require-no-root-held-leaf-lock
```

Expected: one bounded lifecycle-and-cleanup receipt covering the exact shared sequence and all root/leaf topology counts; any uncertain state becomes `reconciliation_required`, the reservation cannot be replayed, and no later transition begins.

- [ ] **Step 7: Verify the exact authorized cleanup and denial boundary**

Perform no new provider mutation and emit no new leaf request. Read back the cancel/refund/cleanup suffix already executed by the single Step 6 orchestration, verify Stripe authoritative state, webhook consequences, entitlement removal/reconciliation, and pending-state cleanup, and prove an unlisted cleanup action is denied before effects. Confirm no Auth/profile record or data was deleted unless separately named in the exact document. Preserve audit events in redacted form.

```bash
billing_canary_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --capability shakedown.billing.production-canary --authorized-hash-only)
node scripts/verify-shakedown-jerry-live.mjs --mode billing-production-cleanup-readback \
  --authorization-hash "$billing_canary_hash" \
  --require-authorized-refund --require-authorized-cancel \
  --require-entitlement-removal --require-pending-state-cleanup \
  --forbid-new-actions --forbid-new-leaf-requests --require-unlisted-cleanup-denial
```

Expected: authoritative cleanup PASS from the Step 6 action journal, zero new side-effecting actions, and pre-effect denial for an operation absent from the exact authorization.

- [ ] **Step 8: Route any root-caused defect back through the tested billing implementation**

Stop the canary at the failed boundary and preserve evidence. Return to Task 18, add the failing regression to the exact frontend/backend ownership surface, fix both sides of any paired contract, stage only the declared source/tests, scan the cached diff, commit, and repeat Tasks 28, 29, 30, and 31 in order. Restart Task 32 only when authoritative idempotency/readback proves repetition safe and a still-valid or newly authorized exact hard-stop hash covers it. Never repair production data around a code defect.

```bash
billing_canary_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --capability shakedown.billing.production-canary --authorized-hash-only)
node scripts/verify-shakedown-jerry-live.mjs --mode write-billing-failure-handoff \
  --authorization-hash "$billing_canary_hash" \
  --require-authoritative-reconciliation --forbid-production-data-shortcut
```

Expected: a failed-boundary receipt and no retry; code execution resumes only at Task 18 and subsequently traverses Tasks 28–31.

- [ ] **Step 9: Run the full Shakedown live verifier — expect PASS**

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode production --require-payment-canary
```

Expected: PASS with the canary and cleanup rows bound to the consumed exact authorization.

- [ ] **Step 10: Close and archive the single-use authorization**

Mark every permitted operation consumed/skipped with authoritative evidence, close the exact state machine, and prove the hash cannot authorize a second checkout/charge or an unlisted cleanup action. Preserve the redacted receipt and expiry/revocation state; private browser/session/payment material remains in the restricted root only.

```bash
billing_canary_hash=$(node cli/home23.js worker hard-stop show shakedown-jerry \
  --capability shakedown.billing.production-canary --authorized-hash-only)
node cli/home23.js worker hard-stop close shakedown-jerry \
  --authorization-hash "$billing_canary_hash" --require-operation-evidence
node cli/home23.js worker hard-stop replay-test shakedown-jerry \
  --authorization-hash "$billing_canary_hash" --expect deny
```

Expected: `closed` followed by replay denial; no credential, payment method, direct email, or session value appears in the canonical receipt.

---

## Task 33: Cut over schedules, pause replaced automations, prove restart persistence, and hand control to Jerry

**Working directory:** `/Users/jtr/_JTR23_/release/home23-worktrees/shakedown-jerry-runtime`

**Interfaces:**
- Consumes: complete Task 29–32 live receipts, Task 27 migration matrix, and Task 11 portable schedule definitions.
- Produces: exact installed schedule state, receipt-gated legacy automation pauses, restart/reconstruction proof, verified next wakes, final completion receipt, and Jerry-visible operational handoff.

**Files:**
- Modify at runtime only: Home23 Shakedown schedule activation states
- Modify at runtime only: exact mapped Codex automation states after replacement proof
- Create at runtime: final automation-cutover and completion receipts
- No source changes are allowed during cutover; a mapping defect returns to Task 27 before any automation state change

- [ ] **Step 1: Refresh the automation/runtime matrix one final time**

Compare every known Codex automation ID and duplicate, Home23 cron, launchd job, PM2 executor, Jerry Collection loop, and deterministic service with its recorded definition hash, status, schedule, project root, authority, shared lock, target lane, live consequence receipt, next wake, and rollback action. Any unmapped or drifted row blocks cutover.

```bash
node cli/home23.js worker migrations verify shakedown-jerry \
  --fresh-runtime-inventory --require-definition-hashes \
  --require-live-consequence-receipts --require-next-wakes --block-on-drift
```

Expected: PASS before any schedule or automation mutation; otherwise follow Step 10.

- [ ] **Step 2: Prepare the complete crash-recoverable cutover before any state change**

Resolve exact prior and intended state for the four Home23 schedules and two active Codex automations, including definition/profile hashes, project roots, schedules, next wakes, versions, replacement receipts, and inverse operations. Persist one `prepared` `RecordAutomationCutoverInput` transaction before enabling or pausing anything. The payload uses the Task 10 contract exactly; failure to persist the full prior/replacement/rollback set leaves every external state unchanged.

```ts
const prepared = await workerManagement.recordAutomationCutover({
  cutoverId: deterministicCutoverId('shakedown-jerry', finalInventory.hash, liveProofBundle.hash),
  worker: 'shakedown-jerry',
  priorState: {
    automations: finalInventory.automations.select([
      'shakedown-publishing-pipeline-scan',
      'shakedown-show-detail-enrichment-ops',
    ]),
    workerSchedules: finalInventory.workerSchedules.select([
      'shakedown-resident-cycle', 'shakedown-daily-trust',
      'shakedown-daily-collection', 'shakedown-weekly-strategy',
    ]),
  },
  replacementState: exactReplacementStateFromMatrix(finalInventory, liveProofBundle),
  rollbackOperations: exactVersionBoundInverseOperations(finalInventory),
});
assert.equal(prepared.status, 'prepared');
```

```bash
cutover_id=$(node cli/home23.js worker automation-cutover prepare shakedown-jerry \
  --matrix config/worker-migrations/shakedown-jerry-automation-matrix.yaml \
  --require-live-proof-bundle --require-exact-prior-state \
  --require-version-bound-rollback --id-only)
node cli/home23.js worker automation-cutover show shakedown-jerry \
  --cutover-id "$cutover_id" --require-status prepared --require-zero-applied-changes
```

- [ ] **Step 3: Apply and journal the four Home23 schedule activations**

Enable exactly `shakedown-resident-cycle`, `shakedown-daily-trust`, `shakedown-daily-collection`, and `shakedown-weekly-strategy` only after their grant/profile hashes match deployed truth. Confirm the approved `America/New_York` expressions/missions and next-run instants; enrichment/distribution remain resident/event work. Each local schedule mutation and authoritative readback appends a transition to the prepared cutover in the same management transaction. Install into ignored local scheduler state and create no Shakedown-specific scheduler daemon.

```bash
cutover_id=$(node cli/home23.js worker automation-cutover show shakedown-jerry --prepared-id-only)
node cli/home23.js worker schedules install shakedown-jerry \
  --job shakedown-resident-cycle --job shakedown-daily-trust \
  --job shakedown-daily-collection --job shakedown-weekly-strategy \
  --require-active-grant --require-deployed-profile --enable \
  --cutover-id "$cutover_id" --transition-cutover-status applying \
  --append-authoritative-transition
node cli/home23.js worker schedules status shakedown-jerry \
  --require-next-run --cutover-id "$cutover_id" --require-transition-readbacks 4
```

Expected: exactly four enabled jobs in ignored local state, four version-bound transition/readback rows, the Task 11 expressions/timezone, and no new daemon/process.

- [ ] **Step 4: Prove the temporary dual-enabled overlap cannot duplicate consequences**

Keep both mapped Codex automations active while the four replacement schedules are enabled. Reconcile the cutover as `applying`, then deliver one safe overlap-eligible scan occurrence and one safe collection/enrichment occurrence through both legacy and replacement ingress paths with the same canonical source/occurrence identities. Require the shared idempotency ledger and resource locks to admit exactly one consequential action, one receipt, and one pursuit consequence per occurrence. No publish, send, data promotion, or public cutover may execute twice; disagreement returns `reconciliation_required` and rolls the schedule activations back through the prepared inverse operations before any automation is paused.

```bash
cutover_id=$(node cli/home23.js worker automation-cutover show shakedown-jerry --current-id-only)
node cli/home23.js worker automation-cutover reconcile shakedown-jerry \
  --cutover-id "$cutover_id" --fresh-authoritative-state --require-status applying \
  --require-legacy-automations-active --require-four-schedules-enabled
node scripts/verify-shakedown-jerry-live.mjs --mode automation-overlap-safety \
  --cutover-id "$cutover_id" --deliver-safe-scan-overlap \
  --deliver-safe-collection-enrichment-overlap \
  --require-shared-occurrence-dedupe --require-shared-resource-locks \
  --require-one-action-receipt-consequence --forbid-duplicate-public-effect
```

Expected: both legacy definitions remain `ACTIVE`, the four schedules remain enabled, and each dual-delivered safe occurrence yields exactly one consequential chain with no duplicate publish/promote/send/cutover.

- [ ] **Step 5: Restart the existing owner harnesses while legacy replacements remain active**

Rolling-restart the scoped existing owner harness/engine/dashboard paths before pausing any legacy automation, reload canonical state, and prove one queued request, ShakedownJerry's fresh attempt history plus durable state reconstruction, one one-shot campaign readback, all four schedule next wakes, activation/revocation state, pursuit consequence history, overlap-dedupe state, and outbox acknowledgements survive. Confirm both mapped legacy automations remain active, PM2 topology has zero Worker/Shakedown process additions, and there is no duplicate consequential operator.

```bash
cutover_id=$(node cli/home23.js worker automation-cutover show shakedown-jerry --current-id-only)
node cli/home23.js worker automation-cutover reconcile shakedown-jerry \
  --cutover-id "$cutover_id" --fresh-authoritative-state --require-status applying \
  --require-legacy-automations-active
node scripts/deploy-home23-worker-runtime.mjs restart-continuity \
  --process home23-jerry-harness --process home23-forrest-harness \
  --process home23-jerry --process home23-forrest \
  --process home23-jerry-dash --process home23-forrest-dash \
  --require-queued-request --require-campaign-readback --require-four-next-wakes
node scripts/verify-worker-runtime-live.mjs --mode restart-continuity \
  --require-zero-new-processes --require-state-reconstruction
```

Expected: PASS with the same process topology, both legacy mappings still active, and durable queue/state/authority/dedupe/outbox identities plus four reconstructed next wakes.

- [ ] **Step 6: Prove each replacement consequence, then pause exact legacy IDs**

While both legacy automations remain active, observe the next naturally due replacement occurrence for each mapped lane through enqueue, claim, attempt, receipt, real scan/collection/enrichment consequence, pursuit consequence, dashboard projection, Jerry context, and next-run advance. Do not force a synthetic time jump in production. Only after both mapping-specific receipts prove restart-persistent execution, authoritative consequence, shared-overlap dedupe, and an advanced next wake may the execution agent pause the two exact Codex automation IDs.

```bash
node scripts/verify-worker-runtime-live.mjs --mode wait-next-scheduled-occurrence \
  --worker shakedown-jerry \
  --job shakedown-resident-cycle --job shakedown-daily-collection \
  --require-each --require-exactly-once \
  --require-pursuit-consequence --require-dashboard-and-jerry-projection
node scripts/verify-shakedown-jerry-live.mjs --mode automation-replacement-consequences \
  --require-mapping shakedown-publishing-pipeline-scan:shakedown-resident-cycle \
  --require-mapping shakedown-show-detail-enrichment-ops:shakedown-daily-collection \
  --require-real-consequence --require-restart-proof \
  --require-overlap-dedupe --require-advanced-next-wake
```

Expected before pause: both exact legacy IDs still read `ACTIVE`; each mapped replacement has a distinct real consequence receipt produced after Step 5, executed exactly once, and advances its next wake.

Use the Codex product's `automation_update` operation for each exact ID, immediately read back status/definition version, and append the returned product receipt/hash to the prepared cutover. In this orchestration sketch, `codexAutomationManagement` is the execution agent's adapter over that product tool, not a Home23 module or new committed runtime. Keep all definitions and historical receipts. Never alter `check-money-path-reviews`, watchdog, Chrome supervisor while needed, Matomo, dynamic DNS, PM2 `jerry-api`, audio, or Jerry Collection definitions outside their recorded disposition.

```json
[
  {
    "automationId": "shakedown-publishing-pipeline-scan",
    "desiredStatus": "PAUSED",
    "requiredReplacement": "shakedown-resident-cycle:post-restart-scan-consequence-and-advanced-next-wake",
    "rollbackStatus": "ACTIVE"
  },
  {
    "automationId": "shakedown-show-detail-enrichment-ops",
    "desiredStatus": "PAUSED",
    "requiredReplacement": "shakedown-daily-collection:post-restart-collection-and-enrichment-consequences-and-advanced-next-wake",
    "rollbackStatus": "ACTIVE"
  }
]
```

```ts
for (const change of exactAutomationChanges) {
  const state = await readAllAuthoritativeCutoverState();
  await workerManagement.reconcileAutomationCutover(cutoverId, state);
  assertReplacementProofIsPostRestartAndComplete(change, state.replacementReceipts);
  const toolReceipt = await codexAutomationManagement.updateExactVersion(change);
  const readback = await codexAutomationManagement.readExact(change.automationId);
  await workerManagement.appendAutomationCutoverTransition(cutoverId, {
    targetId: change.automationId,
    fromVersion: change.expectedVersion,
    toVersion: readback.version,
    intendedStateHash: change.intendedStateHash,
    authoritativeReadbackHash: readback.sha256,
    receiptId: toolReceipt.receiptId,
    occurredAt: readback.observedAt,
  });
}
await workerManagement.completeAutomationCutover(cutoverId);
```

On interruption, reconcile first. A partially changed external state returns `reconciliation_required`; apply the recorded exact version-bound inverses through the same product tool, append readbacks, and mark `rolled_back` before restarting at Step 1. No definition or receipt is deleted.

```bash
cutover_id=$(node cli/home23.js worker automation-cutover show shakedown-jerry --current-id-only)
node cli/home23.js worker automation-cutover reconcile shakedown-jerry \
  --cutover-id "$cutover_id" --fresh-authoritative-state \
  --rollback-on-partial --require-exact-version-readbacks
node cli/home23.js worker automation-cutover complete shakedown-jerry \
  --cutover-id "$cutover_id" --require-all-intended-readbacks \
  --require-post-restart-replacement-consequences
```

Expected after pause: cutover status `applied`, both exact automation IDs read back `PAUSED`, all four schedules read back enabled with verified next wakes, every other definition/status matches Step 1, and every change has a durable inverse plus authoritative transition receipt.

- [ ] **Step 7: Ask Jerry for the operational explanation**

Through the normal Jerry interface, request what ShakedownJerry did, why it chose it, authority used, evidence/readbacks, what changed on the site/channels/data, what it learned, failures/rollbacks, next scheduled work, and how to revoke or roll back. Compare the answer with canonical receipts and fail completion if it invents or flattens state.

```bash
node cli/home23.js agent ask jerry \
  "Explain ShakedownJerry's latest choice, authority, evidence, verified changes, consequences, learning, failures or rollbacks, next work, and exact revoke/rollback controls." \
  --verify-against-worker-receipts shakedown-jerry
```

Expected: a receipt-linked answer whose claims match canonical state; mismatch fails the handoff.

- [ ] **Step 8: Write the final completion receipt and operator handoff**

Include Home23 and worker-clone branch/commit, deployed release, exact standing-grant hash/activation, Shakedown dedicated ref, site/code/data predecessor and rollback addresses, full acceptance matrix, payment-canary authorization/cleanup receipt, automation state before/after, next wakes, live service readbacks, known residual risks, and the exact rollback sequence. Link every claim to a fresh artifact.

```bash
node scripts/verify-shakedown-jerry-live.mjs --mode write-completion-receipt \
  --require-payment-canary --require-automation-cutover \
  --require-next-wakes --require-jerry-explanation --require-rollback-addresses
```

Expected: one immutable completion receipt with fresh evidence links and no unsupported success row.

- [ ] **Step 9: Run the final strict verifiers — expect PASS**

```bash
node scripts/verify-worker-runtime-live.mjs --mode deployed --require-restart-proof
node scripts/verify-shakedown-jerry-live.mjs --mode production \
  --require-payment-canary --require-automation-cutover --require-jerry-explanation
```

- [ ] **Step 10: Route any matrix drift back through Task 27**

If Step 1 finds an unmapped or changed definition, make no schedule or automation mutation. Return to Task 27, update the exact matrix row with a failing completeness fixture, commit it there, then repeat Tasks 28, 29, 30, and 31 in order before restarting Task 33 at Step 1.

```bash
node cli/home23.js worker migrations verify shakedown-jerry \
  --write-drift-handoff --forbid-runtime-mutation
```

Expected: a non-passing Task 27 handoff receipt; no automation or scheduler status changes occur until the full 28→29→30→31 sequence is green again.

---

## Completion Gate

- [ ] Every Worker manifest field has tested runtime meaning, every dispatch surface uses the canonical queue/client, and existing workers remain live-proven.
- [ ] ShakedownJerry is one Jerry-owned lightweight worker with no separate engine, brain, dashboard, scheduler daemon, or PM2 family.
- [ ] The exact signed standing grant is active, revocable, enforced at the action boundary, and no alternate tool/shell/browser/file path bypasses it.
- [ ] Site, code, collection, enrichment, distribution, communications, campaign, indexing, social-image, recovery, and conversion lanes each have fresh consequence and rollback/readback receipts.
- [ ] The production signup/payment/webhook/entitlement canary completed under its separate exact authorization and its authorized cleanup is verified.
- [ ] The operator checkout, shared `dist`, `html/pro`, `env-config.js`, `v2.shakedownshuffle.com`, user data, billing state outside the canary, and unrelated runtimes are unchanged except where a receipt explicitly proves an authorized mutation.
- [ ] Replacement schedules survived restart and executed exactly once; only then were mapped Codex automations paused, with exact re-enable operations retained.
- [ ] Jerry can truthfully explain the current worker, evidence, actions, consequences, learning, next work, and rollback/revocation controls.
