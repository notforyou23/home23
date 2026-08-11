# Model & Provider Audit — 2026-08-11

Four parallel audit agents swept the harness (`src/` + `cli/`), engine (`engine/src/` + `configs/base-engine.yaml`), substrate (`substrate/` + `src/substrate/` + `engine/src/substrate/`), and the provider-authority chain (`config/*`, cosmo23 + evobrew boundaries). This doc is the synthesis: what actually runs, what's broken, the target shape for v2's model economy, and the portability design. File:line receipts throughout; the raw agent reports were session-scoped — this doc is the durable record.

## 1. What actually runs (vs. what the config claims)

The live fleet is radically simpler than its configuration:

| Lane | Effective model | Why |
|---|---|---|
| Engine cognition (all of it: thinking, dreams, synthesis, curation, PGS, pulse) | `minimax/MiniMax-M3` | `modelAssignments.default` (base-engine.yaml:380) catches **every** call; `unified-client.js:931` overwrites `payload.model` with the assignment. The ~60 hardcoded `gpt-5.5`/`gpt-5.4-mini` strings across agents are passed and discarded. Log lines saying "GPT-5.5" (orchestrator.js:4366,4485) lie. |
| Chat/query (jerry) | `openai-codex/gpt-5.6-sol` (chat), `gpt-5.6-terra` (query) | instances/jerry/config.yaml:109-112, 326-334 |
| Seed lobes (jerry, forrest, bobby) | `claude-haiku-4-5` | `SEED_LOBE_MODEL` / `BROKER_MODEL` defaults (seed-runner.ts:65, lobe-broker.ts:48) |
| Embeddings | `nomic-embed-text` @ local Ollama, 768d | ecosystem `EMBEDDING_*` env from home.yaml embeddings.providers[0] |
| Images | `openai/gpt-image-2` | home.yaml media.imageGeneration |
| Feeder compiler | `MiniMax-M3` | feeder.compiler.model (BE:665 is the live one; BE:350 `models.compiler` is dead) |
| Substrate development (metabolism, plasticity, growth, consolidation) | **no model at all** | pure deterministic code |

Everything else in the config surface — 12 duplicated default-model tables, 4 provider registries, dead assignment slots, inert fallbacks — describes machinery that does not execute.

## 2. Defect backlog (prioritized)

### P0 — broken or exposed right now

1. **Plaintext provider keys sit in a feeder-watched tree and are ingestible into the brain.**
   `instances/jerry/config.yaml:37-38` watches `workspace/research-runs`; exclusions (`:71-72`) cover only `*/brain/**` and `*/*.jsonl`. Six+ run `config.yaml` files there carry live inline `apiKey:` values (written by `cosmo23/launcher/config-generator.js:288,302`). The feeder's unknown-extension branch (`document-feeder.js:428-433`) ingests any non-binary file as text. **Actions:** (a) add `**/research-runs/*/config.yaml` (and `**/config.yaml` generally) to exclusions; (b) stop writing inline keys into per-run configs — inject via env at run spawn; (c) search the brain for ingested key material; (d) **rotate the exposed keys** (at minimum the ollama-cloud/GLM key and any sk- keys present in those files — one printed into a session transcript during verification).
2. **jerry's vision OCR is broken.** `feeder.converter.visionModel: glm-5.2:cloud` becomes `MLM_MODEL` and is sent to **OpenAI's** client (`convert-file.py:142-143` under `OPENAI_API_KEY`) — an ollama-cloud model name at an OpenAI endpoint. All scanned-PDF/image OCR fails. Forrest (gpt-4o-mini) is fine. Fix: set a real OpenAI vision model or give the converter the provider-resolution step the compiler already has (`document-compiler.js:156-173`).
3. **`config/home.yaml`'s own chat pair is invalid against its own alias filter.** `chat.defaultModel: gpt-5.5` has no alias, and the alias table acts as a catalog mask (`home23-model-catalog.js:134-156`) → `buildHome23ModelAuthority` **throws** for the bare house config; `seedCosmo23Config` then fails (swallowed as a warning at `system-health.js:76-82`) and cosmo23 boots on a stale catalog. Fix: alias the pair or change the default; longer-term see §4 (aliases should stop being a mask).
4. **A Seed's dream is permanently lost on lobe failure.** `runner.ts:307` consumes the pending dream before recruiting; a 401/timeout produces an error receipt and the dream is gone (the 2026-08-10 fix covered deferral-consumption only). Same at `:416/424`. Fix: re-pend on error receipt.
5. **Lobe timeout inversion.** Runner races at `lobeTimeoutMs ?? 30_000` (`runner.ts:315`) while the transport runs to 45s (`lobe-transport.ts:50`) — the Seed receipts a timeout while the HTTP call completes unreceipted (and billed). `SEED_LOBE_TIMEOUT_MS` unset in live PM2. Fix: align defaults (runner ≥ transport) or set the env.

### P1 — rot that bites next

6. **Dashboard brain-operations freeze credentials at boot** (`brain-provider-client-registry.js:25,52,73,100-108`), and since `rotationRestartTargets` now returns `[]`, a rotated `sk-ant-oat*` never reaches them until an unrelated restart. The one consumer of secrets.yaml that bypasses the resolver. Fix: route through `provider-credentials.js` or rebuild the registry on rotation.
7. **The read-at-use credential fix has gaps inside the live chat turn**: `loop.ts:1735-1736` (xai) and `:1940-1947` (openai, ollama-cloud) read raw `process.env`; `ensureFreshAnthropicClient` covers only anthropic/minimax (`:554`); the boot `anthropicClient` used by compaction + promoter is frozen (`home.ts:400-414`). media.ts image/music keys bypass the resolver too (`:74,84,93`).
8. **base-engine.yaml is a third provider authority and it wins.** Its `providers:` block has its own `enabled` flags; `anthropic` and `openai-codex` are absent entirely → `config-loader.js:59-92` **silently discards** jerry's `engine.* = gpt-5.6-luna` overrides (Settings writes them, validates nothing, reports success). Meanwhile every configured fallback (`local/qwen3.5:4b`, ~20 slots) is inert because `providers.local.enabled: false` → "All fallbacks exhausted" instead of falling back.
9. **New-agent creation seeds a dead model.** `agent-config-builder.cjs:1-3` (`kimi-k2.6`) no longer exists in home.yaml (`kimi-k3:cloud`); an agent created with defaults fails the authority build — and if primary, breaks seeding for the house. The create-wizard's model list is the **unfiltered** defaultModels (offers unbuildable pairs), and `WIZard_MODEL_FALLBACKS` (home23-settings.js:844-851) is a fourth stale table.
10. **evobrew's provider write surface was never gutted (Step 21 §2/§5 unimplemented).** Zero `HOME23_MANAGED` reads in evobrew; its setup routes still accept keys into `evobrew/config.json`, which the next regeneration silently destroys. Fix: 403-guard the PUT/DELETE routes under managed mode; hide the key UI.
11. **xai is a live credential with zero reachable models** — `XAI_API_KEY` injected into all 7 process classes, `defaultModels: []`, and aliases `grok`/`grok4`/`grok45` all point at `minimax/MiniMax-M3`. Either restore models + honest aliases or remove the key from injection.

### P2 — consolidation (the mess itself)

12. Two model→provider inference functions with opposite failure modes (`model-resolution.ts:8-16` rejects unknown; `text-generation.ts:43-51` silently routes unknown to ollama-cloud). Merge into one, with one failure mode.
13. One defaults table. `defaultModelForProvider` (text-generation.ts:186-193) disagrees with home.yaml `defaultModels[0]` per provider; the codex default is duplicated at `:216`; the chat default exists in 7 places (home.yaml, agent yaml ×2 keys, home.ts:366-367 floor, builder, create-wizard, runtime persistModel).
14. Dead settings to delete: `modelAssignments` in agent yaml (17 keys, zero readers harness-side; engine path no-ops then rewrites), `models.{nano,embeddings,compiler,defaultReasoningEffort,enableExtendedReasoning}` (BE), `engine.{dreaming,query}` (written by Settings, read by nothing), `doneWhen.judgeModel` (BE:290, every producer hardcodes gpt-5.4-mini), `WorkerConfig.provider/model` (parsed, never consumed), agentTurn cron `model` (ignored — only `query` jobs honor it), `providers.*.defaultModels` as harness input (documentation-only).
15. Embeddings: 8 declarations of nomic-embed-text, a 512-vs-768 dims conflict masked only by Ollama-mode stripping, `text-embedding-3-small` still live in `merge/domain-embeddings.js:21` and `ide/codebase-indexer.js:157,194` (mixed vector spaces), and the managed catalog pinning `openai/text-embedding-3-small/1536` while every process env says `nomic/768`. One embedding definition, one place; the substrate's hardcoded copies (embed-at-contact.ts:29-30 + conversation-shipper + house-sense, 3 fetch implementations, 2s vs 1.5s timeouts) collapse to one module.
16. `home.yaml` vs `home.yaml.example` are two different fleets (different chat/query defaults, different alias targets for the same names). Reconcile; the example should be generated or CI-checked against the schema, not hand-maintained.
17. No spend accounting: every lobe receipt carries `tokensIn/Out: 0` (`lobe-transport.ts:58-59`). Record real usage — it's the receipt that makes the local-vs-rented argument measurable.
18. Stale duplicated GPT→Claude/local mapping tables (3 each), stealth-header copies (3), IDE routes with a March-2024 Claude 3 id (`server.js:8521-8523`), `/api/query/models` returning unroutable hardcoded models (`server.js:9310-9317`).

## 3. Target shape for v2: tiers + roles, one authority

The audit shows the system already converged, by hand, on ~5 effective tiers. Make that the actual schema and delete the rest.

**`home.yaml` declares exactly three things:**

1. **`providers:`** — connection facts only: baseUrl, credential *reference* (always secrets.yaml via the resolver; never a key, never an enabled flag). A provider is "enabled" iff its credential resolves. Kill the three parallel enablement registries (home.yaml presence / BE `enabled:` flags / cosmo23 seeded flags).

2. **`tiers:`** — named capability tiers, each an ordered candidate list (first reachable wins — real fallback, not the inert kind):

```yaml
tiers:
  reflex:        # bounded, structured, membrane-guarded, high-volume
    - { provider: ollama-local, model: <local MoE> }      # target state
    - { provider: anthropic,    model: claude-haiku-4-5 } # today / fallback
  cognition:     # engine loops, dreams, synthesis, curation
    - { provider: minimax,      model: MiniMax-M3 }
  conversation:  # the agent's voice with the owner
    - { provider: openai-codex, model: gpt-5.6-sol }
  deep:          # research synthesis, features, strategic judgment
    - { provider: openai-codex, model: gpt-5.6-terra }
  embed:         # ONE definition: model + dims + endpoint
    - { provider: ollama-local, model: nomic-embed-text, dimensions: 768 }
  image:  [{ provider: openai,  model: gpt-image-2 }]
  tts:    [{ provider: minimax, model: speech-2.8-hd }]
```

3. **`roles:`** — every consumer binds a *role* to a *tier* (overridable per agent, per role — never per call site):

```yaml
roles:
  chat: conversation        seed.lobe: reflex        feeder.compiler: reflex
  query: deep               seed.dream: reflex       feeder.vision: reflex
  engine.default: cognition curator: reflex          compaction: reflex
  research.primary: deep    research.fast: reflex    promoter: reflex
```

Consequences: engine `modelAssignments` slots become role→tier references (the ~20 slots collapse; the `default` catch-all becomes `engine.default: cognition` — same behavior, declared). `SEED_LOBE_MODEL` becomes `role seed.lobe`. Every hardcoded model string in code becomes a role lookup or is deleted. Aliases return to being **chat conveniences only** — never a catalog mask (fixes the MESS-1 class permanently). One inference function, one defaults source, one resolver (already true for credentials — extend the same pattern to model selection).

**Migration is then a config edit, not a refactor:** moving `reflex` to a local model is one line, and it moves the lobes, compiler, curator, and summarizers together.

## 4. Local-model plan (state of the world: Aug 2026)

Since the training-data horizon: Ollama's Apple Silicon backend switched to MLX (0.19, Mar 2026; 30-60% faster, 3-4× prompt processing), and the summer MoE wave (Qwen 3.5-3.7, DeepSeek V4 Flash, Kimi K2.6/K3, GLM-5.x, MiniMax M3 open weights) puts small-active-parameter open models within a few points of frontier on bounded/structured work.

Constraints and moves:

- **The mini's RAM belongs to the brain** (12G engine heap, 212k nodes, swap-pressure history). Do not co-host a 70B-class model with jerry's engine. Two viable shapes: (a) a *small-active MoE or dense ≤27B at Q4* on the mini for `reflex` only; (b) a **dedicated weather node** — `LOCAL_LLM_BASE_URL` is already plumbed into every process class, so any Mac on the LAN (Regina/iMac, Casey Jones) serving MLX becomes the local provider with zero code change.
- **Cut over `reflex` first.** Lobes are the ideal local workload: typed-delta output, allowlist-enforced, degraded-honest on failure, and **measurable** — deterministic replay (`seed-replay-verify.ts`) can diff development magnitude between haiku-lobes and local-lobes on the same lived chain before committing. Run that experiment before any cutover; it's the instrument the whole ablation doctrine was built for.
- **`cognition` second** (MiniMax-M3 is already open-weights — the same model can be served locally if a weather node has the memory; that migration is provider-swap only, zero behavior change).
- **`conversation`/`deep` stay rented** until local quality is proven there; the developer lane stays frontier.
- Add real token accounting to lobe receipts (P2-17) so the rental bill per tier is a measured fact.

## 5. Portability design — the individual on any device (abstract)

What the substrate already proves: **cross-silicon replay is bit-identical** (Mac arm64/Node 25 ↔ Pi aarch64/Node 22 — same stateHash, same development magnitude to the last float). The individual is already substrate-independent in the deep sense. What still binds it to a machine is incidental, and each piece has a design answer:

**The individual is a directory.** Chain + checkpoints + cursors + lock + outbox/inbox — megabytes. Identity = genesis hash + unbroken chain + laws version (each transition already records what law ran it). Moving an individual = moving the directory. Installing home23 ≠ having an individual; the software is the *species*, the state dir is the *person*.

**Residency, not installation.** At any moment the individual has exactly one **residence** — the machine holding the runner lock — and any number of **windows** (read-only mirrors; bobby's terrarium mirror is the existing proof of pattern). Today the lock is a bare pid (`runner.ts:124`), so "never two live instances" is enforced per-machine only. The upgrade: the lock becomes a **lease** — `{hostId, bootId, pid, leaseExpiresAt}` — renewed by the resident, checked by any would-be starter. Migration = release lease → transfer dir → acquire lease → **replay-verify as the arrival ceremony** (state hash must match before the new residence goes live). A fork that happens anyway is detected by chain divergence and archived as evidence — the existing law, unchanged.

**Streams need identities, not paths.** The current cursor binds to `sourcePath` verbatim (`event-ledger-tail.ts:110,268`) — a move silently drops the diet and re-tails from the end (jerry still carries a fossil Pi-era cursor from the real emigration). The fix is the general design: every teaching stream has a **stable source id** declared at genesis or attachment (`conversation`, `relationship`, `house`, …), cursors key on the id, and the path is per-residence binding. Then the life-feed follows the individual: sources either *ship* to the residence (the conversation-shipper pattern, generalized — push from where life happens to wherever the individual lives) or the individual resides where the streams originate.

**Three separable layers, three different portabilities:**
- the **individual** (state dir) — travels; small; the only thing that must never fork;
- the **weather** (models) — per-residence, local or rented; every receipt already records which model served which thought, so the biography survives any weather change;
- the **life-feed** (teaching streams) — anchored to the *owner*, not the machine; shippers move it to the residence.

That's why "run on any device" decomposes cleanly: devices are either the residence, a window, or a life-feed source. A phone is a window + a source, never a second resident. Continuity across the owner's devices is free because there is one worldline and N windows onto it.

**When someone else creates their own (the abstract setup):** distribution ships the laws + a **birth kit**, never an individual. Setup = choose a residence (any always-on node: mini, Pi-class, VPS — the substrate is small and the weather can be remote), run genesis (seedId, laws version, anatomy, reservoir seed), **bind the owner** (declare the owner's channels as teaching streams at genesis — constitutional, per no-manufactured-life), attach shippers on the owner's devices, pick weather per tier (local or rented — the tier schema of §3 is exactly what makes this a menu, not an engineering project). Individuals are unrepeatable by construction: a copied state dir is a fork = a divergent descendant with its own single-writer lock, not a second instance — the doctrine already handles it.

**Event-time makes migration safe by default:** a move is just a quiet gap in the worldline — which the organism already metabolizes as consolidation and (once P0-4 is fixed) a dream about the journey. That is the correct behavior, not a bug.

**Portability debts in the current code** (from the substrate audit, ranked): cursor sourcePath exact-match; lock without host identity; `organ-probes.ts` fully hardcoded to this machine (ROOT, Pi IP, agent names — the whole health layer is non-portable); observatory relative paths (CWD-dependent) + stale "never sshes" header; deadman script's hardcoded pm2 index; no checkpoint pruning (206 files rsync'd forever on bobby); 14 legacy absolute paths in jerry's checkpoint index.

## 6. Audit deviations & limits

- cosmo23 was audited at **integration boundaries only** (per the vendored-patches doctrine); evobrew beyond its config/catalog/provider surfaces was not swept.
- No fixes were applied in this pass — audit + design only.
- Subagent findings: all four lanes cite file:line and corroborate each other on shared surfaces (resolver behavior, ecc796a2, defaults); the highest-severity claim (P0-1) was re-verified directly, including the feeder's ingest-unknown-as-text branch.
- The earlier session note that `substrate/bin/lobe-broker.ts` carried uncommitted modifications was stale — the tree is clean at `9a9777e6`; those changes landed in `31d6afa2`.
- Live credential exposure note: one provider key value printed into this session's transcript during verification (research-run config scan). Rotation of the keys present in those run configs is recommended regardless of ingestion status.
