# Home23 Model & Provider Runtime Audit — 2026-08-21

**Root:** `/Users/jtr/_JTR23_/release/home23` (live installation + public repo, intentionally dirty worktree audited AS-IS on disk, not at git HEAD)
**Agents in scope:** jerry, forrest, grokbot (harness/engine/dash); bobby, clay (seeds); workers; cosmo23 and evobrew at integration boundaries.
**Windows:** primary evidence window **2026-08-08 → 2026-08-21 local (America/New_York, UTC−4)**; durable brain-operation store extends to 2026-07-22 (30-day metadata expiry floor); conversation JSONL extends further back with older schema.
**Mode:** read-only forensic. No process was restarted or signaled, no job triggered, no provider called, no source/config/identity file modified. The only writes produced by this audit are this file, `docs/audits/HOME23-MODEL-SURFACE-INVENTORY-2026-08-21.json`, and `docs/design/HOME23-MODEL-AUTHORITY-TARGET-ARCHITECTURE-2026-08-21.md`.
**Secrets:** no credential value was read out or reproduced. Where a config block contained key-like fields, only the key name is referenced.

---

## 0. Methodology

Four parallel evidence lanes, reconciled against each other and against prior artifacts:

1. **Prior artifacts incorporated** (all read in full or at stated depth):
   - `docs/design/MODEL-PROVIDER-AUDIT-2026-08-11.md` — the tiers/roles audit and its 18-item fix ledger with same-day execution status.
   - `docs/design/STEP3-UNIFIED-PROVIDERS-DESIGN.md` — the 2026-04 provider-unification contract (env-var bridge).
   - `docs/audits/model-provider-audit-2026-07-03/README.md` — the onboarding/model-plan audit and its model-slot-contract recommendation.
   - `docs/audits/{core-components-audit,cosmo23-audit,evobrew-audit}.md`, `docs/audits/2026-07-29-cosmo-autonomous-research-system-forensics.md` — skimmed; ship-hygiene and Cosmo-forensics scope, cited where relevant.
   - `instances/jerry/coding-jobs/cj_20260822T000510Z_646a` (claude-code, runtime/usage reconciliation) and `cj_20260822T000510Z_25ee` (codex, callsite matrix) — full final reports recovered from `events.jsonl` (`type:"result"` / final `agent_message`), not just the truncated `receipt.json` tails.
2. **Source verification at current worktree** — every model/provider-bearing path in `src/` (TS harness), `engine/src/` (JS engine + dashboard), `configs/`, `cli/lib/`, `shared/`, `substrate/`, `workspace/skills/`, and the evobrew/cosmo23 boundaries, re-verified with path:line citations (two read-only explorer passes plus direct reads of the focal synthesis machinery by the coordinating auditor).
3. **Runtime/durable evidence** — quantification over: `instances/<agent>/runtime/brain-operations/operations/brop_*/{status.json,events.jsonl}`, `instances/<agent>/conversations/*.jsonl` (+ per-agent `conversations/cron-jobs.json`, `cron-runs/`, `cron-decisions.jsonl` + gz archives), `instances/workers/*/runs/*/receipt.json`, `instances/<agent>/brain/worker-runs.jsonl`, `coding-jobs/cj_*/`, `async-work/aw_*.json`, surviving engine logs, `workspace/skills/.telemetry/*.jsonl`, media receipts, vibe manifests, `brain/pulse-remarks.jsonl`, seed ledgers, and `pm2 jlist`.
4. **Config authority** — `config/home.yaml` (model-bearing blocks only, key-like values suppressed), `configs/base-engine.yaml`, `instances/{jerry,forrest,grokbot}/config.yaml` (model-bearing blocks only), generated `ecosystem.config.cjs` (env var **names** only), `config/home.yaml.example`.

**Counting semantics used throughout (limitations, stated up front):**

- A conversation "turn" record is a **turn start** (every surviving record has `status:"pending"`), and one turn can fan out to many provider HTTP round-trips via the tool loop → all turn counts are **floors** on provider calls.
- A brain **operation** (`brop_*`) is an accepted durable record; it becomes a **provider call** only if its `events.jsonl` carries `provider_selected` → `provider_call_terminal`; it becomes a **committed product** only on terminal `state=complete` with a matching `synthesis_completion_claimed` event.
- Engine/harness/dashboard logs are rotated: only `__2026-08-19/20/21` + live files survive; **08-08 → 08-17 engine logs are gone** (forrest retains two frozen pre-rotation files covering ≈08-07 and 08-09→08-12). Cron decisions before 08-18 are rotated away. All-time brop counts are floors (30-day metadata expiry, earliest survivor 2026-07-22).
- `exec` cron jobs shell out to scripts; whether any invokes a provider **cannot be confirmed read-only** — marked UNKNOWN except where the script was read (the synthesis refresh scripts were read).
- No token/cost metering exists on most surfaces (see §5.4); cost reconciliation from local receipts is impossible.

---

## 1. Executive findings

1. **There is no single model authority.** At least **five independent selection systems** run concurrently: (a) the harness precedence chain (per-turn override → runtime `setModel` → agent `chat:` → `shared/model-defaults.cjs` floor), (b) the engine `UnifiedClient` + `modelAssignments` slots, (c) the dashboard brain-operations resolvers (`provider-registry.js` for synthesis, `operation-model-resolver.js` for query/PGS), (d) the feeder compiler's own provider resolution (`document-compiler.js:156-165`), and (e) a legacy stratum (dashboard V2 chat/IDE/query/PGS, evobrew internals, skills) with hardcoded models that bypass everything.
2. **The engine's `modelAssignments.default` catch-all silently rewrites nearly every engine call.** `UnifiedClient.getModelAssignment()` falls back to `default` when no `component:` matches (`engine/src/core/unified-client.js:1162-1173`) and the caller's explicit `model:` string is overwritten (`:567-570`, Anthropic-payload `:932-936`). ~30 callsites across coordinator/meta-coordinator/specialist agents/auxiliary cognition pass literals (`'gpt-5.5'`, `'gpt-5.4-mini'`) that are **cosmetic**; log lines naming them (and the `(GPT-5.5)` banners, `orchestrator.js:1518` et al.) do not describe what ran. Live effective slots (newest boot echo): jerry/forrest all-luna (`openai-codex/gpt-5.6-luna`), grokbot mixed minimax/luna (as of its last boot 08-17).
3. **The reported high synthesis counts are real provider calls, mostly wasted, and now fully explained** — see §6. Jerry: 452 operations in-window, 432 with a real provider call, **50 committed**, 217 discarded `source_changed` *after* the paid call, 85 `provider_failed`. Root cause: a since-disabled every-30-minute freshness cron POSTing the bare synthesis endpoint (recorded as trigger `manual`, 327 in-window), amplified by scheduler catch-up/repair re-runs after poll-timeouts (523 runs, 200 errors, peak 185 runs on 08-18) and by the absence of admission-time deduplication (72 overlapping operation pairs) — each loser burning a full provider call before the commit compare-and-swap rejected it. The meta-coordinator is **not** a brain-state synthesis trigger (it spawns a different, same-named specialist mission agent — the naming decoy that broke the Aug-19 audit).
4. **Doctrine and generated topology disagree about Cosmo.** `CLAUDE.local.md`: "Home23 does not host, start, seed, or watchdog Cosmo." Current worktree: `cli/lib/generate-ecosystem.js:638-665` generates PM2 app `home23-cosmo23` (script `cosmo23/server/index.js`), seeds its `ENCRYPTION_KEY`/`DATABASE_URL`/ports/`HOME23_MANAGED`, lists it in `configuredProcessNames` (`:709`); the process is **live** in PM2, and its run DB shows activity through Aug 21 14:57. Durable query/PGS *does* fail closed without it (`cosmo-worker-client.js:236-237`), but a **legacy in-dashboard PGS** (`server.js:8944-9024`) loads the engine in-process from the `cosmo23/` tree, marks any secret-bearing provider enabled, bypasses `modelAssignments`, and works with Cosmo down.
5. **Metering is nearly absent.** Token usage is durably recorded only by: engine document-generation log lines (survived: jerry 2.08M total tokens on `gpt-5.6-luna` across 08-21 files; forrest 4.02M; MiniMax lines carry no usage block), pulse-remarks JSONL (`usage` present), and lobe receipts when the provider branch populates `usageSink` (ollama/openai/xai verified; Anthropic-SDK branch unverified). Coding jobs carry `costUsd` on only 46/129 jerry receipts ($153.77 all-time, $45.46 in-window — floors). Chat turns, cron turns, worker turns, verifier turns, synthesis operations, skills, and media calls record **no tokens or cost**.
6. **Observability gaps hide model identity at the exact surfaces that fire most.** Worker run receipts (1,155 on disk) contain **no model field**; skill telemetry has no model field; seed ledgers record lobe events without the model that served them; `async-work/aw_*.json` records no backend/model; synthesis ops (non-synthesis brain ops too) record model only for provider-bearing types.
7. **Settings are split, mislabeled, or bypassed** (§7): brain-state synthesis has no Settings control (config-only `home.yaml synthesis:` + a hidden env override `SYNTHESIS_LLM_PROVIDER/MODEL`); the "Engine Duties" surface enumerates only `modelAssignments` and masks the dashboard-process surfaces; provider "test" buttons issue real generations (minimax 1-token `MiniMax-M3` hardcoded, `home23-settings-api.js:1038-1050`; anthropic key-test uses 2024-era `claude-3-5-haiku-20241022`, `engine/src/services/encryption.js:151-153`); forrest's live `chat:` block is provider/model mismatched (`minimax` + `gpt-5.6-terra`) with nothing refusing it; jerry's feeder `visionModel: gpt-5.6-luna` is a Codex-OAuth model id handed to an `OPENAI_API_KEY` python client (`convert-file.py:143`) — the same failure class as the previously-fixed glm OCR bug (live failure not directly observed; code path verified).
8. **Fleet reality vs. config drifted repeatedly inside the window**: engine cognition flipped minimax→codex/luna at a ~08-20 restart; synthesis walked MiniMax-M3 → claude-haiku-4-5 (08-16) → gemma4:31b (08-19/20); the feeder compiler historically ran models other than configured (glm-5.2:cloud for jerry per the 08-20 reconciliation). Only receipts, never static config, describe what ran.

---

## 2. Configuration authority chain (verified)

Merge order (FACT):

1. `config/home.yaml` — house defaults. Model-bearing blocks as of this audit: `chat` (openai-codex/gpt-5.6-terra), `query` (terra + PGS pair gpt-5.4-mini, all openai-codex), `models.aliases` (~35 aliases incl. effort-bearing entries), `media.imageGeneration` (openai/gpt-image-2), `embeddings.providers[]` (ollama-local/nomic-embed-text/768 first), **`synthesis` (ollama-cloud/gemma4:31b, intervalHours 3)**, `substrate.brokers[0].model` (claude-haiku-4-5, bobby), `providers.*.defaultModels` (feeds the authority catalog). **No `cosmo23:` block exists in the live home.yaml** — Cosmo port falls back to 43210 in code (`server.js:1084-1086`); the example config carries `cosmo23.ports` only (no `baseUrl` key, contra the CLAUDE.local.md description).
2. `configs/base-engine.yaml` — engine structural config: `modelAssignments` (default minimax/MiniMax-M3 + ~20 slots, fallbacks ollama-cloud/kimi-k3:cloud), `providers.{openai:false, minimax,xai,local,ollama-cloud:true}` (`:357-380`), legacy `models.*` (all MiniMax-M3, display-level), `feeder.compiler.model: MiniMax-M3`, `feeder.converter.visionModel: gpt-4o-mini`.
3. `instances/<agent>/config.yaml` — per-agent overrides win per-slot (`config-loader.js:355-361`; `engine.thought` sweeps all cognitive slots except pulse/chat `:170-177`, then per-slot `modelAssignments` wins `:226-241` with **no provider-enablement validation** at that layer). Live values: jerry chat sol + `reasoningEffort: high`, query terra, ~20 engine slots luna (a few xai/grok-4.5), compiler terra, visionModel luna; forrest chat **mismatched pair** (provider minimax, model gpt-5.6-terra), engine luna incl. `engine.query` (retired key, ignored `config-loader.js:186-188`); grokbot chat sol, engine block MiniMax-M3 but modelAssignments luna, feeder paths on `/Volumes/Casey Jones`.
4. `config/secrets.yaml` — credentials only, via `resolveProviderKey` (`src/agent/provider-credentials.ts:86-102`: pinned static → broker (anthropic) → fresh secrets read (mtime-cached, `HOME23_SECRETS_PATH` override) → configured → env floor). Engine-side rotation-aware equivalents in the compiler (`document-compiler.js:113-141`) and the dashboard brain-provider registry (per the 08-11 audit's Patch 74).
5. **Environment** (injected by `cli/lib/generate-ecosystem.js` into every process): `EMBEDDING_{PROVIDER,BASE_URL,API_KEY,MODEL,DIMENSIONS}` (`:146-150`), `LOCAL_LLM_BASE_URL` (`:151`), provider keys, `SEED_LOBE_MODEL` default claude-haiku-4-5 (`:303-305`), `BROKER_MODEL` (`:539`). Additional env overrides that **change model selection** exist outside ecosystem generation: `SYNTHESIS_LLM_PROVIDER`/`SYNTHESIS_LLM_MODEL` (`provider-registry.js:93-106` — set nowhere in the generated env; a hidden override), `OPENAI_DEFAULT_MODEL` (`gpt5-client.js:35`), `SEED_EMBED_ENDPOINT`/`SEED_EMBED_MODEL` (`embed-at-contact.ts:32-33`, `substrate/src/embed-fetch.ts:20-21`), `MLM_MODEL` (converter child env, `document-converter.js:146-147`), `XAI_BASE_URL`/`OPENAI_BASE_URL` (media), `LLM_BACKEND`/`LOCAL_LLM_API_KEY`/`OLLAMA_URL` (engine).

Floor tables: `shared/model-defaults.cjs:19-31` (harness, one table since the 08-11 fixes); `DEFAULT_SYNTHESIS_SELECTION` minimax/MiniMax-M3 + interval 4h (`provider-registry.js:17-21`); per-provider literal defaults in `image-provider.js:116` (gpt-4o-mini / kimi-k2.6 — the latter a dead model id, retained as a fallback literal only).

---

## 3. Surface inventory (summary)

Full machine-readable inventory with per-surface evidence: `docs/audits/HOME23-MODEL-SURFACE-INVENTORY-2026-08-21.json`. Classification axis used there and here:

- **configured** — a config key names a model for it;
- **source-reachable** — a live entrypoint can execute it at current worktree;
- **process-live** — the owning process is online in PM2 right now;
- **recently exercised** — receipts in the 08-08→08-21 window;
- **historically exercised** — receipts before the window only.

| # | Surface | Process | Selection authority | Recently exercised (window evidence) |
|---|---|---|---|---|
| 1 | Chat turn (dashboard/Telegram/devices/evobrew-bridge) | harness | per-turn override → runtime → agent `chat:` → shared floor (`chat-turn.ts:121-135`, `loop.ts:407-408`, `model-defaults.cjs`) | yes — jerry 457 user-chat turn-starts, forrest 69, grokbot 0 user / 6 total |
| 2 | Compaction + memory extraction | harness | inherits live chat model (`compaction.ts:101-102`, `memory.ts:90,288`) | yes (implied by turns; uncounted separately) |
| 3 | Subagent tool | harness | strict per-call override → parent (`subagent.ts:39-40`) | yes — jerry 34 turn-starts |
| 4 | Cron `agentTurn` | harness | job `model` (strict, loud-fail `home.ts:843`) → agent chat | yes — jerry 423, forrest 183 turn-starts |
| 5 | Cron `query` | harness→dash→cosmo | job model → exact pair to brain ops (`cron-brain-query.ts:99-111,210-213`) | yes (small) |
| 6 | Async-work review turn | harness | agent chat model (`completion.ts` → `workreview:` chat) | yes — jerry 13 |
| 7 | Workers | harness | WorkerConfig.provider/model → parent (`runner.ts:225-232`) | yes — jerry 356 worker turn-starts / 353 receipts |
| 8 | Promoter | harness | **hardcoded** claude-haiku-4-5 (`home.ts:1201`) | yes (runs at startup cadence; unmetered) |
| 9 | Coding jobs (claude-code/codex/grok-build) | external CLIs | per-job → `acp.backends.<id>.model` → CLI default (`bridge.ts:286,310`) | yes — jerry 79 jobs in window |
| 10 | Live-problem verifiers | harness | agent chat model | yes — jerry 81, forrest 201 turn-starts |
| 11 | Engine cognition (thinking machine: deepDive/critique/pgs-adapter; quantum; specialists; auxiliaries; coordinator/meta/executive) | engine | `modelAssignments` slots; **no-component callsites → `default`** (`unified-client.js:1162-1173`) | yes — doc-gen token lines + thought journals; effective all-luna (jerry/forrest) |
| 12 | Pulse remarks | engine | `pulseVoice` slot (`pulse-remarks.js:978-980`) | yes — jerry 140, forrest 113, grokbot 5 receipts (jsonl) |
| 13 | Feeder compiler | engine | instance `feeder.compiler.model` → base → own provider resolution (`document-compiler.js:66,156-165`) | yes — manifest provenance (historical drift: glm-5.2:cloud on jerry per 08-20 reconciliation) |
| 14 | Feeder vision converter | engine→python | `feeder.converter.visionModel` → `MLM_MODEL` → OpenAI-keyed client (`convert-file.py:143`) | unknown (jerry setting likely non-functional — F10) |
| 15 | **Brain-state synthesis** | dashboard | env `SYNTHESIS_LLM_*` → `home.yaml synthesis:` → default minimax (`provider-registry.js:86-169`); callers forbidden to pick (`coordinator.js:569-573`) | yes — 629 ops in window across 3 agents (§6) |
| 16 | Brain query / hosted PGS (durable) | dashboard→cosmo | exact pairs; defaults from model authority queryDefaults (`operation-model-resolver.js:177-211`) | yes (small) — jerry 64 query ops all-time, 1 pgs |
| 17 | Legacy dashboard query (`/api/query`) | dashboard | hardcoded gpt-5.5 + text-embedding-3-small (`query-engine.js:410,810`) | historically (queries.jsonl); reachable now |
| 18 | Legacy dashboard PGS (`/api/pgs`) | dashboard (in-proc cosmo tree) | caller-supplied models, bypasses assignments (`server.js:8953-9024`) | unknown recent; reachable with Cosmo down |
| 19 | Legacy V2 chat + IDE (`/api/chat`, `/api/chat/simple`, IDE) | dashboard | hardcoded gpt-5.5/gpt-4o/claude ids (`ai-handler.js:534,675-677`, `server.js:3697-3698`) | no window evidence; reachable |
| 20 | Intelligence tab synthesis schedule + Run button | dashboard | same durable synthesis path (`server.js:12278-12291`) | yes (trigger `scheduled`) |
| 21 | Vibe commentary/theme/image | dashboard | engine cfg → agent chat → home chat → provider defaults → literals (`image-provider.js:92-116`) | **no** — manifests end 07-28 (dormant); reachable |
| 22 | Agent media tools (image/music/TTS) | harness | per-call → `media.*` config → literals (`media.ts:56-137`) | images: 2 (08-08/09); music/TTS: none; TTS disabled all agents |
| 23 | Skills: xai-search / xai-x-search / minimax-music / contact | harness→skill JS | per-call → skill defaults (grok-4.5; MiniMax literals) — own direct egress | yes — jerry xai-search 97 runs in window (no model in telemetry); contact skill is docs-only, no model |
| 24 | Seed lobes (jerry/forrest local; bobby via broker) | seed/broker | `SEED_LOBE_MODEL`/`BROKER_MODEL` (claude-haiku-4-5) → lenient inference | yes — lobe ledger categories: jerry 512, forrest 435, bobby 524 (no model recorded in ledgers) |
| 25 | Embeddings (engine memory, memory-search, substrate contact/relationship-ledger) | engine/dash/harness/seed | `EMBEDDING_*` env (honored) vs hardcoded text-embedding-3-small strata (bypassed) | yes — continuous; local ollama, unmetered |
| 26 | Provider probes (Settings test, encryption key-test, evobrew probes) | dashboard/evobrew | hardcoded probe models | operator-triggered; reachable |
| 27 | Evobrew internals (chat/query/summary/image/indexer) | evobrew | own config + hardcoded (sonnet-4-5, gpt-5.2 probe, gpt-image-2, text-embedding-3-small) | unknown; process live |
| 28 | Cosmo research (`research_*` ops, compile) | dashboard→cosmo | delegated to Cosmo's authority; fail-closed | yes — jerry 13 research ops in window |
| 29 | brain_synthesize / brain_query agent tools | harness→dash | forwards trigger/pairs; synthesis model server-owned (`brain.ts:772-825`) | yes — trigger `tool` ops present |
| 30 | `/model`, `/models`, `/effort` chat commands | harness | writes agent `config.yaml` chat default (`handler.ts:227-243`); `/models` fetches live ollama catalog | yes |

Non-model-bearing (verified): steer queue, work bus/registry/completion (triggers only), clip-output, harness-bridge-url, retrieval-eval, reasoning-stream, identity-budget, context-assembly (embedding-adjacent only; brain retrieval via HTTP `contextSearch`, `loop.ts:1345-1346`), the entire `src/agent/contact/` stack (HA/macOS/phone/Telegram/browser/files — receipts to `brain/contact-receipts.jsonl`), curator-cycle.js (no LLM calls at all — the "curator" model slot name notwithstanding). `relationship-ledger.ts` is embedding-bearing (`:281-288`).

---

## 4. Process-live picture (PM2, observed 2026-08-21 ~22:20 EDT)

`pm2 jlist`: home23 family online — jerry/forrest/grokbot × {engine, dash, harness, mcp}, jerry+forrest+clay seeds, bobby broker + shippers, evobrew, seed-observatory, **home23-cosmo23** (online), plus non-home23 apps. Restart counters in-window: jerry engine 16, jerry dash 16, jerry harness 12, forrest dash 8. Restarts matter for model truth: engine restarts re-resolve `modelAssignments` (the minimax→luna flip), reset the circulatory trigger's rate limiter, and re-freeze any boot-frozen clients.

**grokbot anomaly (open question §9):** PM2 reports `home23-grokbot` online, but its engine log was last written 08-17 11:18, `brain-state.json` mtime is Aug 18, and its 6 synthesis ops (08-17) all aborted `source_unavailable`. Its feeder watch paths point at `/Volumes/Casey Jones/Home23/...`. Whether this instance semi-migrated to another volume or the engine process is wedged cannot be resolved read-only.

---

## 5. Usage quantification (locally evidenced)

Method per table stated in §0; full per-day grids in the JSON inventory. All counts are **floors** on provider HTTP calls.

### 5.1 Harness turn-starts by class (window 08-08→08-21, conversations JSONL)

| class | jerry | forrest | grokbot | dominant models |
|---|---|---|---|---|
| cron-agent | 423 | 183 | 2 | codex sol/luna (j), terra/luna (f); claude-sonnet-5 17 (j) + 11 (f) — the wired cron `model: sonnet5/sonnet` jobs |
| worker | 356 | 62 | 1 | codex sol/terra |
| user chat (device+dashboard) | 457 | 69 | 0 | sol/terra; manual grok-4.6 55 (j) |
| verifier/diagnose | 81 | 201 | 3 | sol/terra |
| subagent | 34 | 0 | 0 | mixed codex/openai/anthropic |
| async-workreview | 13 | 0 | 0 | sol |
| **total (with model field)** | **1,364** | **515** | **6** | |

### 5.2 Brain operations (durable store, `runtime/brain-operations/`)

All-time survivors (since 07-22): jerry 1,202 ops (72 MB), forrest 437 (37 MB), grokbot 8. By type (jerry): synthesis 565, search 380, status 75, query 64, research_* 110, graph 7, pgs 1. Only synthesis/query/pgs carry provider calls; search/status/graph/research_* ops show zero provider events (research delegates to Cosmo's own runtime).

### 5.3 Other durable receipts (window)

- **Coding jobs:** jerry 79 (codex 44: 33 completed; claude-code 20: 11 completed, 8 of 9 failures on 08-21; grok-build 15: **all interrupted**), forrest 3. `costUsd` present on 46/129 jerry receipts all-time: $153.77 (window $45.46) — floors.
- **Workers:** receipts jerry 353 / forrest 62 / grokbot 17; statuses dominated by `blocked` (jerry 295). **No receipt records a model** (0 of 1,155 all-time).
- **Async work:** jerry 132 (coding 105, subagent 35), forrest 3.
- **Cron:** home file 12 jobs (11 exec + 1 agentTurn); jerry store 60 jobs (46 enabled; agentTurn with model: field-report-cycle + evening-briefing = `sonnet5`), forrest 41 (agentTurn with model: 2× `sonnet`), grokbot 12 all disabled. Window runs: jerry field-report-cycle 240, shakedown-proposer 596 entries; forrest freshness-refresh 74. Exec-job LLM usage: UNKNOWN by design (flagged).
- **Skills telemetry:** jerry 217 events (xai-search 97 runs — each a real xAI Responses call, default grok-4.5, **no model recorded**), grokbot 8, forrest 5.
- **Media:** jerry 2 images (08-08/09, gpt-image-2 receipts); vibe manifests **0 in window** (jerry last 07-28, forrest 07-25); pulse-remarks jsonl: jerry 140 (all gpt-5.6-luna, 08-20/21), forrest 113 (luna, 08-21), grokbot 5 (MiniMax-M3, 08-17). Pulse history before 08-20 absent — UNKNOWN.
- **Seeds:** ledger lobe events jerry 512 / forrest 435 / bobby 524 (window-dominant); **no model field in any seed ledger record** — configured claude-haiku-4-5 via env is the presumption, receipts don't prove it. clay: no lobe events; ledger gap 08-15→08-19 (matches the known dead period).

### 5.4 Token evidence (the only metered lanes)

Surviving engine `Document generation response` lines: jerry `gpt-5.6-luna` 15 calls / 724,786 total tokens (08-21 file) + 16 / 1,360,282 (live file); forrest luna 2/106,313 (08-20) + 41/1,872,747 (08-21) + 44/2,151,443 (live); MiniMax-M3 lines (jerry 15 on 08-19, forrest 47 older) carry **no usage block**. Provider errors: forrest `401` ×14 on 08-20 (`engine-err__2026-08-20` — the minimax-pinned pulse route before its flip to luna); jerry fetch-failed 49+56 / timeouts 17+7 (live + 08-21); no 429s in surviving logs.

---

## 6. The synthesis counts, explained (focal)

### 6.1 What a "count" is

The countable unit is a **durable synthesis operation** in `instances/<agent>/runtime/brain-operations/operations/` (store rooted from the agent runtime dir, `server.js:1037-1041`). Lifecycle: `coordinator.start({operationType:'synthesis', parameters:{trigger}})` accepts and persists the op → the registered local executor (`server.js:1197`) runs `SynthesisAgent.runOperation` (`engine/src/synthesis/synthesis-agent.js:562-807`) which makes **exactly one provider call** per operation (`providerAdapter.generate` `:628-652`, fixed `providerCallId:'synthesis'`, singleton contract `coordinator.js:1750-1752`), bracketed by `provider_selected` and `provider_call_terminal` events → the JSON product is committed by **compare-and-swap against the pinned source revision** with a durable completion claim and readback verification (`:738-804`).

So: **attempts** = accepted ops; **operations with a real provider call** = ops with `provider_call_terminal`; **completed provider calls** = terminal call outcome `complete` (jerry 456 all-time of 542 called); **committed products** = terminal op `state=complete` + `synthesis_completion_claimed` (342 store-wide, exactly matching completes). The reported "high counts" (e.g., the earlier reconciliation's 511 in its window; this audit's 629 in 08-08→08-21) are **operation counts, which for jerry/forrest are ≈1:1 with real provider calls** — they are neither mere attempts nor inflated by per-op retries (streaming retries inside one op excepted).

### 6.2 The numbers (window 08-08→08-21; all-time = 30-day survivors)

| agent | attempts (win/all) | provider-called | committed | source_changed | provider_failed | aborted pre-call | other |
|---|---|---|---|---|---|---|---|
| jerry | 452 / 565 | 432 / 542 | 50 / 151 | 217 / 224 | 85 / 85 | 19 / 21 | operation_not_found 69, source_busy 11, interrupted 14, response_invalid 4 |
| forrest | 171 / 303 | 171 / 281 | 109 / 191 | 39 / 64 | 19 / 19 | 0 / 22 | capability_unavailable 19 (pre-window) |
| grokbot | 6 / 6 | 0 | 0 | 0 | 0 | 6 | all `source_unavailable` (engine/brain absent) |

Per-day (jerry): ~10/day through 08-14, then **37 / 55 / 66 / 88 / 97** on 08-15→08-19, collapsing to 31 (08-20) and 6 (08-21). Models walked MiniMax-M3 (≤08-16) → claude-haiku-4-5 (08-16→08-19) → gemma4:31b (08-19→) — matching `home.yaml synthesis:` edits; the current selection is `ollama-cloud/gemma4:31b @ intervalHours 3`.

### 6.3 Trigger paths — who can start one, and who actually did

Trigger strings are free-form (`parameters.trigger`, mirrored in `requestParameters.trigger`; bounded but unvalidated — forrest shows 24 distinct values all-time). The **five real trigger paths**:

1. **Dashboard interval timer** (`scheduled`) — `SynthesisAgent.startSchedule` `setInterval(intervalHours)` (`synthesis-agent.js:822-833`), started by the dashboard with `runOnStart:false` (`server.js:12286` — the 30s `startup` timer is **not armed**). Interval = home.yaml `synthesis.intervalHours` = 3h → ≈8/day. Window: jerry 70, forrest 76.
2. **Engine circulatory stale guard** (`auto_scheduled`) — `engine/src/circulatory/synthesis-trigger.js`: 30-min check (`:28`), 5h staleness vs `brain-state.json` mtime (`:29`), 4h rate limit (`:30`), ticked each cognitive cycle (`orchestrator.js:1499`); on fire it POSTs the dashboard `/api/synthesis/run` (`orchestrator.js:945-967`). Notes: the ENOENT (`no_brain_state`) path bypasses the rate limit (`:58-61` precede the check at `:69-71`); `lastTriggerAt` is consumed even on failure (`:88`); **the limiter is in-process state, reset by every engine restart** (jerry: 16 restarts in window). Window: jerry 55, forrest 13, grokbot 6.
3. **Meta-coordinator — NOT a path.** `engine/src/coordinator/meta-coordinator.js` has zero references to the synthesis endpoint/brain-state. Its `shouldTriggerSynthesis` (`:3978-3989`, 60%/90% per 3-4 review cycles) spawns a **specialist mission agent** — `engine/src/agents/synthesis-agent.js`, a report-writing agent that shares a basename with the brain-state `engine/src/synthesis/synthesis-agent.js` but routes through `modelAssignments agents.synthesis` and writes mission reports, not `brain-state.json`. This naming collision is the decoy that misled the Aug-19 audit; the circulatory module's docblock referencing "the meta-coordinator's probabilistic synthesis trigger" describes the mission mechanism, not this store.
4. **Agent tool** (`tool` or free-form) — `brain_synthesize` (`src/agent/tools/brain.ts:772-825`, default trigger `tool`); callers cannot pick provider/model (`coordinator.js:569-573`). Window: jerry 2.
5. **Manual/HTTP** (`manual` default) — `POST /api/synthesis/run` (`synthesis-compatibility-routes.js:211-237`; empty body → trigger `manual` `:219`). Callers include the Intelligence-tab Run button, `scripts/refresh-synthesis.cjs` (POSTs with **no body** → `manual`), workers, and operators. **Window: jerry 327 — the flood.**

### 6.4 Root cause of the spike (jerry, 08-15→08-19) — evidence chain

- Jerry's cron store contains **`synthesis-freshness-refresh`** (id `agent-e532ec1c…`), an **exec job scheduled `*/30 * * * *`** — every 30 minutes — now `enabled: false`. Its run history (`instances/jerry/conversations/cron-runs/agent-e532ec1c….jsonl`) shows **523 runs from 08-16T06:15Z to 08-21T01:52Z** — per-day 53 / 120 / 185 / 116 / 49 — i.e., **up to 4× its nominal cadence**, because 200 of the 523 runs ended `status:"error"` and the scheduler's catch-up/repair machinery re-ran them (archived cron-decisions 08-18→08-21: 457 catch_up + 15 repair actions).
- The job's *current* payload names `instances/jerry/bin/refresh-synthesis-verified.cjs`, which sends `trigger: 'synthesis-freshness-refresh'` (`:101`) — but **zero window ops carry that trigger**, and that script's mtime is **Aug 20 21:50**, i.e. it was created at the end of the spike. During the spike the job ran the plain `scripts/refresh-synthesis.cjs` behavior: **POST first with no body (→ `manual`), then poll up to a timeout** (`refresh-synthesis.cjs:83-96`). An errored run is one whose *poll* timed out — **its POST had already been accepted**. (Inference on which script binary ran pre-08-20; every other link is FACT.)
- **No admission-time dedup exists**: coordinator idempotency keys on caller `requestId` (`coordinator.js:1319-1331`), and every trigger source generates a fresh requestId (`server.js:1190`, `synthesis-compatibility-routes.js:136-142`), so concurrent triggers from different sources (or scheduler re-runs) each become a **new operation with its own provider call**. The engine-side single-flight (`synthesis-agent.js:813`) guards only its own process; the 4h/interval rate limits guard only their own timers. Result: **72 overlapping-execution op pairs** (next op accepted before the previous completed) concentrated on 08-15→08-19.
- Overlapping ops race the **commit CAS**: jerry's brain revision advances constantly (feeder compiling, engine writing), so a multi-minute provider call frequently finds `sourceRevision` moved and fails `source_changed` (`synthesis-agent.js:802-804`) — *after* the provider call completed and was paid for. 217 in-window discards. Each failure left `brain-state.json` stale, which kept the freshness loop and the engine stale-guard firing → **self-amplifying**.
- The loop broke ~08-20/21: the cron was disabled and replaced with the verified script (which checks freshness *before* POSTing and sends a typed trigger), and the coordinator does **not** auto-retry failed ops (retryable errors are durable failed records; boot `reconcile()` re-drives only *interrupted* ops, `coordinator.js:2340+`). Jerry: 6 attempts on 08-21.
- **`operation_not_found` (69)** and `source_busy` (11) are secondary artifacts of the same storm (claims/store races under concurrency); `provider_failed` (85) clusters with the haiku/gemma transition days.

Forrest's counterpoint shows the intended shape: her 3-hourly **agentTurn** freshness cron (prompt: POST with `trigger:"scheduled_freshness"`, poll the operation, retry **exactly once** on `source_changed`) produced 59 `scheduled_freshness` ops with a 64% commit rate — same machinery, disciplined caller, no storm.

### 6.5 Duplicate/concurrency/idempotency summary

- Concurrency guard at admission: **none** across sources (requestId-only idempotency). Serialization exists only per-operation (`_enqueue`, `coordinator.js:504-524`), at the singleton providerCallId contract (`:1750-1752`), at the 8h hard deadline (`:74`), and at the commit CAS.
- Retries: **none in the coordinator**; external callers retry (cron loop, forrest's retry-once, timers). `source_changed` is marked retryable to *invite* caller retry — the plain refresh script ignored outcomes entirely and re-POSTed on its own schedule.
- Counts represent **operations ≈ provider calls** (jerry 542 called / 565 ops all-time), **not** completed useful work (151 commits) — i.e., the counts were real spend, ~72% of it (jerry, window) yielding no committed product.

---

## 7. Settings that are hidden, mislabeled, split, or bypassed

| # | Setting/surface | Problem | Evidence |
|---|---|---|---|
| S1 | `home.yaml synthesis:` | **Hidden**: no Settings tab controls it; the runtime migrates it into the settings store (`synthesis-operation-runtime.js:20-53`) but the Models UI doesn't render it; env `SYNTHESIS_LLM_*` overrides it invisibly | provider-registry.js:67,93-106 |
| S2 | "Engine Duties" (Settings → Models advanced) | **Mislabeled boundary**: enumerates engine `modelAssignments` only; dashboard-process surfaces (synthesis, query resolvers) and harness surfaces are absent — the exact blind spot that produced the Aug-19 miss | 646a receipt §5; server.js:1170-1236 |
| S3 | Engine `modelAssignments.default` | **Bypasses explicit code choices silently**; effective models appear only in boot echoes and per-response `model` fields, not in any UI | unified-client.js:567-570,1162-1173 |
| S4 | Provider "Test" buttons | **Undeclared real generations**: minimax test = 1-token MiniMax-M3 call; anthropic key-test = claude-3-5-haiku-20241022 (2024-era id) | home23-settings-api.js:1038-1050; encryption.js:151-153 |
| S5 | forrest `chat:` block | **Invalid pair accepted**: provider minimax + model gpt-5.6-terra; nothing refuses on save/load at this layer | instances/forrest/config.yaml chat block |
| S6 | jerry `feeder.converter.visionModel: gpt-5.6-luna` | **Mislabeled capability**: Feeder settings accept a Codex-OAuth model id for a lane that executes via `OPENAI_API_KEY` python client — repeat of the fixed glm-OCR class | convert-file.py:143; document-converter.js:146-147 |
| S7 | Promoter model | **No setting at all** (hardcoded) | home.ts:1201 |
| S8 | Legacy `/api/query`, `/api/pgs`, `/api/chat`, `/api/chat/simple`, IDE | **Bypass**: no model authority, hardcoded/caller-supplied models, no durable receipts | server.js:3607,3690,8797,8944; ai-handler.js:534 |
| S9 | Cron job `model` fields | **Split UI**: cron jobs live per-agent in `conversations/cron-jobs.json` with no model dropdown/validation surface; exec jobs invisible to any model plan | jerry/forrest cron stores |
| S10 | Embeddings | **Split + bypassed**: `EMBEDDING_*` honored by network-memory/memory-search, ignored by novelty-validator (`:670`), IDE indexer, merge/domain-embeddings, evobrew indexer (all text-embedding-3-small) | novelty-validator.js:670; codebase-indexer.js:157,194; domain-embeddings.js:21 |
| S11 | Skills | **Bypass with own egress**: xai-search/xai-x-search default grok-4.5 with direct secrets access; music skills carry their own MiniMax model literals | workspace/skills/*/index.js |
| S12 | Docs vs code | circulatory DESIGN.md says 6h trigger (code: 5h/30min/4h); STEP11 says 4h schedule (live: intervalHours 3); CLAUDE.local.md says `cosmo23.baseUrl` (key absent; ports-only) | engine/src/circulatory/DESIGN.md:77-81 |

---

## 8. Findings register

Severity: P0 (active harm/exposure) / P1 (bites next) / P2 (debt). Confidence: high = verified at path:line + receipts; med = code-verified, runtime unobserved; low = inference. Disposition vocabulary: retain / expose / consolidate / instrument / deprecate / remove.

| ID | Finding | Sev | Conf | Blast radius | Privacy/egress | Cost | Observability | Correctness | Owner/authority | Evidence | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Synthesis freshness loop: unguarded admission + POST-then-poll cron + scheduler catch-up re-runs burned ~382 wasted provider calls (jerry, window) at ~1:9 commit:attempt | P1 (was P0 while cron enabled) | high | dashboard + provider spend + brain-state freshness | prompt ships SOUL/MISSION/BRAIN_INDEX + pinned nodes to configured provider (currently ollama-cloud) | high (unmetered) | ops store is excellent; nothing aggregates it | products discarded, state stayed stale | split: dashboard coordinator vs engine trigger vs cron owner | §6.4 | **consolidate** (single freshness authority; admission coalescing: return active op), **instrument** (per-op usage) |
| F2 | `modelAssignments.default` silently rewrites ~30 engine callsites; literals + log labels lie | P1 | high | all engine cognition | model choice invisible → egress choice invisible | med | logs misleading | effective ≠ stated | engine config-loader/UnifiedClient | §1.2, unified-client.js:567-570 | **consolidate** (typed roles), **instrument** (log effective slot per call), **remove** dead literals |
| F3 | Cosmo doctrine vs generated topology: PM2 hosts+seeds home23-cosmo23; docs say standalone; durable ops hard-require it | P1 | high | brain query/PGS/research + secrets seeding | Home23 injects DB/encryption env into Cosmo | low | ops fail typed (good) | topology ambiguity | doctrine (CLAUDE.local.md) vs cli/lib/generate-ecosystem.js:638-665 | §1.4 | **expose + decide** (either hosted-and-documented or standalone-and-ungenerated); update doctrine |
| F4 | Legacy dashboard chat/IDE/query/PGS bypass authority w/ hardcoded or caller models, no receipts | P1 | high | dashboard HTTP surface | direct provider egress off-ledger | med | none | stale model ids | dashboard legacy stratum | §3 #17-19 | **deprecate → remove** (or 403-gate behind a legacy flag) |
| F5 | No unified token/cost metering; only doc-gen/pulse/lobe/coding partially metered | P1 | high | economics of whole fleet | — | unknown ≠ small | blind | — | none (that's the finding) | §5.4 | **instrument** (unified invocation receipts; see target arch) |
| F6 | Model identity missing from worker receipts, skills telemetry, seed ledgers, async-work | P2 | high | attribution | — | — | gaps at hottest surfaces | — | receipts writers | §5.3 | **instrument** |
| F7 | Provider tests are real generations with hardcoded/stale models | P2 | high | operator surprise, tiny spend | tiny egress on click | low | unlabeled | claude-3-5-haiku-20241022 anachronism | settings-api/encryption | S4 | **expose** (label + typed probe), retain function |
| F8 | Trigger strings free-form; `manual` conflates UI button and automation | P2 | high | synthesis attribution | — | — | ambiguity proved costly (§6.4) | — | coordinator contract | §6.3 | **consolidate** (typed trigger enum + caller identity) |
| F9 | forrest chat provider/model mismatched pair accepted | P2 | high | forrest chat lane | — | — | — | provider inference saves it at call time (loop infers by model) — accidental correctness | settings validation | S5 | **expose** (validate pair on save/load) |
| F10 | jerry visionModel = codex id into OPENAI_API_KEY client → OCR lane likely broken again | P1 | med (code FACT, live failure unobserved) | jerry scanned-doc ingestion | — | — | refusals leave no manifest entry (known feeder gap) | broken capability | feeder settings ↔ converter | S6 | **expose** (validate vision model against executing provider), fix config |
| F11 | Stale-guard ENOENT bypasses 4h limiter; limiter resets on engine restart (16×/window) | P2 | high | synthesis volume | — | low | — | intended-ish but undocumented | circulatory trigger | synthesis-trigger.js:58-71 | **retain + instrument** (persist lastTriggerAt; document) |
| F12 | Two `synthesis-agent.js` files (mission vs brain-state) — the audit-breaking decoy | P2 | high | comprehension | — | — | misleads every future audit | — | naming | §6.3(3) | **consolidate** (rename one) |
| F13 | Duplicate xai skills + music skills with own egress/model literals | P2 | high | skills lane | direct xAI/MiniMax egress, no model in telemetry | low-med | telemetry lacks model | — | skills | S11 | **consolidate** (route through media/model authority), instrument |
| F14 | grokbot zombie: PM2 online, engine logs dead since 08-17, paths point at external volume | P2 | med | grokbot entirely | — | — | conflicting signals | — | operator | §4 | **expose** (resolve residency; needs operator) |
| F15 | Embedding fragmentation: EMBEDDING_* honored vs 4 hardcoded text-embedding-3-small sites (mixed vector spaces; potential OpenAI egress where keyed) | P2 | high | memory quality + egress | embeddings of brain/code content to OpenAI where those sites run | low | none | mixed spaces | embeddings authority | S10 | **consolidate** (one embed definition; per 08-11 audit partially done) |
| F16 | Evobrew hardcoded models (sonnet-4-5 summary, gpt-5.2 probe, gpt-image-2, indexer embeddings) despite HOME23_MANAGED write-guard | P2 | high | evobrew lane | own egress | low-med | evobrew-local logs only | stale ids | evobrew boundary | §3 #27 | **expose/consolidate** at boundary; accept-and-document if intended |
| F17 | Doc drift: DESIGN.md 6h vs code 5h; STEP11 4h vs live 3h; CLAUDE.local.md cosmo23.baseUrl key doesn't exist | P2 | high | future auditors | — | — | — | docs wrong | docs | S12 | **expose** (doc fixes; not performed by this read-only audit) |
| F18 | Promoter hardcoded claude-haiku-4-5, direct Anthropic client, no receipts in common ledger | P2 | high | promoter lane | anthropic egress | low | notifications jsonl only | — | home.ts | home.ts:1201 | **expose** (config key) + instrument |
| F19 | Legacy `/api/pgs` marks any secret-bearing provider enabled and bypasses assignments; reachable with Cosmo down | P2 | high | PGS lane | caller-directed egress | med | console log only | — | dashboard legacy | server.js:8978-9024 | **deprecate** (durable PGS is the successor) |
| F20 | Free-form cron exec jobs are an unbounded, unverifiable model-call surface (34 jerry exec jobs; scripts can call anything) | P2 | high (as a boundary statement) | whole fleet | arbitrary | unknown | none | — | cron owner | §5.3 | **instrument** (egress policy at receipts level; see target arch) |

---

## 9. Fact vs inference vs unverified reachability

**Facts** — everything cited with path:line above was read this session at the current worktree; every count in §5-6 derives from the stated store with the stated method. **Key inferences (labeled):** (a) which script binary the jerry refresh cron executed before 08-20 (trigger-string + mtime evidence; the payload has since been edited); (b) lobe calls actually served by claude-haiku-4-5 (config + env say so; seed ledgers don't record it); (c) live failure of jerry's vision OCR lane (code path certain, no failure log captured); (d) queryDefaults' exact merge order inside `home23-model-catalog.js` (not read; resolver behavior verified). **Unverified reachability (source-reachable, no window receipts):** legacy V2 chat/IDE routes, legacy `/api/pgs`, Vibe generation (dormant since 07-28), TTS (disabled all agents), music tools/skills, evobrew internal chat/query/summary/image, Thinking Machine *alternate* legacy mode (config currently `thinking_machine`, so it's the legacy rotation that is inert), dynamic-roles (inert under current mode), engine `local` provider (enabled, qwen2.5:7b mapping — no receipts).

---

## 10. Open questions

1. grokbot residency: is `/Volumes/Casey Jones/Home23` a second install, and is the local PM2 `home23-grokbot` engine wedged? (F14)
2. Is hosting `home23-cosmo23` under PM2 the *intended* end-state (doctrine update needed) or a temporary bridge (generation removal needed)? (F3)
3. Should synthesis prompts (identity files + pinned brain nodes) be allowed to leave the house at all now that `reflex`-class local serving is plausible? Current lane: ollama-cloud (rented). Privacy call is the owner's.
4. jerry `operation_not_found` (69) — the exact store race deserves a targeted reproduction before any coordinator change.
5. Anthropic-SDK branch of `generateText`: does it populate `usageSink` for lobe receipts? (unresolved from the harness lane).
6. Who, if anyone, still calls the legacy `/api/query`? `queries.jsonl` shows historical use; no window instrumentation exists to say.

---

## 11. Reproduction appendix (exact methods)

```bash
# PM2 live picture
pm2 jlist | python3 -c "import json,sys;[print(p['name'],p['pm2_env'].get('status'),p['pm2_env'].get('restart_time')) for p in json.load(sys.stdin)]"

# Synthesis ops: attempts/calls/commits/triggers per agent (jerry shown)
python3 - <<'PY'
import json,glob,os
from datetime import datetime,timezone,timedelta
tz=timezone(timedelta(hours=-4))
root='instances/jerry/runtime/brain-operations/operations'
for d in sorted(glob.glob(root+'/brop_*')):
    s=os.path.join(d,'status.json'); e=os.path.join(d,'events.jsonl')
    if not os.path.exists(s): continue
    st=json.load(open(s))
    if st.get('operationType')!='synthesis': continue
    ev=[json.loads(l) for l in open(e)] if os.path.exists(e) else []
    called=any(x.get('type')=='provider_call_terminal' for x in ev)
    print(st.get('acceptedAt'), st.get('parameters',{}).get('trigger'),
          st.get('parameters',{}).get('provider'), st.get('parameters',{}).get('model'),
          st.get('state'), (st.get('error') or {}).get('code'), 'called' if called else 'no-call')
PY

# The jerry refresh-cron run history (the manual flood driver)
python3 - <<'PY'
import json
lines=[json.loads(l) for l in open('instances/jerry/conversations/cron-runs/agent-e532ec1c-12ce-44f4-a5a5-0054dc8deb08.jsonl')]
from collections import Counter
print(len(lines), Counter(r['status'] for r in lines), lines[0]['timestamp'], lines[-1]['timestamp'])
PY

# Conversation turn-starts by model (per agent)
python3 - <<'PY'
import json,glob
from collections import Counter
c=Counter()
for f in glob.glob('instances/jerry/conversations/*.jsonl'):
    seen={}
    for l in open(f):
        try: r=json.loads(l)
        except: continue
        if r.get('type')=='turn' and r.get('model'): seen[r.get('turn_id')]=r
    for r in seen.values(): c[(r.get('provider'),r.get('model'))]+=1
print(c.most_common(20))
PY

# Token-metered engine lines
rg -c "Document generation response" instances/*/logs/engine-out*.log

# Effective engine slots from newest boot echo
rg "Model assignment found" instances/jerry/logs/engine-out.log | tail -20
```

Full per-day grids, per-surface classifications, and evidence pointers: `HOME23-MODEL-SURFACE-INVENTORY-2026-08-21.json` (same directory). Proposed remedy: `docs/design/HOME23-MODEL-AUTHORITY-TARGET-ARCHITECTURE-2026-08-21.md`.
