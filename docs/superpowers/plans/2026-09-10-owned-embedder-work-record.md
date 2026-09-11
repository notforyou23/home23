# Owned embedder — work record

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Plan commit verified: `3c7495d6dd5b424a7e17307364b1b5a26586e49a`

**Stages 1–5 are not the full milestone.** Chat e2e is blocked. Dashboard `/api/memory/search` was not the retrieve path. Product default flip remains **NO-GO**.

## Isolation

| Item | Value |
|---|---|
| Worktree | `home23/.home23-worktrees/owned-embedder-stage5-verify` |
| Branch | `home23-agent/owned-embedder-stage5-verify` @ `303ff008` (payload packaged at `d8f45ba3`; Encoder `54b0b993`) |
| Shared `home23` | `codex/jerry-continuity-20260907` — not switched, not this work |
| Shared `home23-apple` | `codex/mac-dashboard2-20260908` — not the Host Stage 4 commit |
| Apple Host edits | `home23-apple-agent/owned-embedder-host-stage4` @ `88123ded` (separate worktree) |
| Live homes / `../release/home23` | not used as source; not altered |

## Host worker (this slice)

Owner: Host worker on `home23-agent/owned-embedder-stage5-verify`.  
Source commit used for the payload: `d8f45ba3`. Tip later moved to Encoder `54b0b993` (packaged-transformers load-check in `package.mjs` only). No Host honesty source fix was required; no Host source commit in this slice.

| Item | Value |
|---|---|
| Payload | Sibling `owned-embedder-stage5-host-payload` from `scripts/product/package.mjs` (package.mjs cannot write inside source) |
| `packageId` | `b2bbac7377d83d1688466227fd7185aadb0b0e5a572a4bfd17d0d5057238a501` |
| Packaged Node | official nvm `v22.19.0` arm64 Mach-O, not a stub |
| TEST home | worktree `.stage5-product-home` (`.stage5-host-home` already held a Memory receipt; not reused, not deleted) |
| Machine receipt | untracked `.stage5-product-home/host-receipt.json` and `.stage5-host-home/host-receipt.json` |

`host.mjs` commands actually run:

1. worktree `host.mjs install --home .stage5-product-home --payload <sibling-payload>`
2. installed `bin/node app/scripts/product/host.mjs create` (stdin profile: `ollama-local` / `llama3.2`, `ingestPaths` = `.stage5-host-import`)
3. installed `host.mjs semantic-prepare`
4. installed `host.mjs start`
5. private PM2 `restart --update-env` of `ownedProcessNames('stage5host', { encoderRequired: true })`
6. installed `host.mjs stop`

Resident process names: `home23-coordination`, `home23-stage5host`, `home23-stage5host-dash`, `home23-stage5host-harness`, `home23-stage5host-seed`, `home23-stage5host-shipper`, `home23-seed-observatory`, `home23-evobrew`, `home23-embedder`.

### Receipts (not prose)

| Check | Result |
|---|---|
| 1. Host create `home23.host.v2` + `encoderRequired: true` | **yes** — status `prepared`; embedder port 32591; seed `modelInvocations: 0` |
| 2. `semantic-prepare` fetch/verify/warm | **yes** — one worker; `.part` grew 216MiB→481MiB then published 547310275-byte ONNX; digests match recipe; phase `ready`. Download finished before an interrupt; Range-resume of a killed `.part` was **not** exercised |
| 3. `/ready` warm | **yes** — recipe `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9`, dim 768, `warm: true`; `execPath` = packaged `bin/node` (pid 70693, then 81012) |
| 4. Product import-folder | **yes** — `additionalWatchPaths` includes `.stage5-host-import`; feeder `maintenanceMode: false`; initial scan ingested 2 files / 2 nodes |
| 5. Paraphrase retrieve | **yes on live owned `/v1/embeddings`** — hydro 0.711139 vs granite 0.555544; lexical overlap only `that`/`later`. Dashboard `/api/memory/search` returned `target_not_available` (catalog lifecycle unavailable; no `brain-state.json`) |
| 6. Allowlisted PM2 restart | **yes** — all nine names new pids, `restart_time: 1`; `/ready` still warm; retrieve scores identical |
| 7. Host Stop | **yes** — `status: stopped`; `/ready` connection refused; no verifier-owned kill |
| 8. Chat e2e | **blocked** — this machine’s Ollama has only `nomic-embed-text:latest`. Missing: an ollama-local **chat** model, or a provider API key. None invented; other homes not scraped |

Stamped Seed contact: coordination `POST /api/v1/channels/:id/messages` then conversation-shipper line with `semantic_recipe_id` = owned hash, `semantic_encoder` = `owned-nomic-v1.5-onnx-fp32-mean-noprefix`, 16-d projection. Same line present after restart. Seed id `seed_mtwbundv_e0c0a4b8`, genesis `e533195b…` unchanged.

## Memory worker (live probe)

Owner: Memory worker. No Memory source commit. Probe script untracked: `scripts/product/probe-embedder-stage5-memory.mjs`. Receipt: untracked `.stage5-host-home/memory-receipt.json`. Official `.stage5-host-home/host-receipt.json` was late; the probe used `.stage5-product-home` while `/ready` was warm, then Host Stopped the home.

| Check | Result |
|---|---|
| Stamp | **pass** — in-process addNode + Host brain sidecars **6/6** owned hash `12e9f736…`, including both import-folder docs |
| Query | **pass** — refused unstamped and cross-recipe; owned↔owned compared; paraphrase top hydrologic |
| Contact | **pass on live Host stream** — newest line owned hash + 16-d. Isolated shipper new-line `shipped: 0` (leftover cursor; not re-run after Stop). Old line stayed unknown / byte-identical |
| Attention | **pass** — live harness/seed/shipper `SEED_EMBED_RECIPE_ID` owned hash; `matchFloor`/`matchMargin` null; `canSemanticGate` false; no borrowed 0.60/0.12 |
| Birth | **pass** — `modelInvocations: 0` through semantic-prepare `ready` |

## What is established

| Fact | Evidence | Limit |
|---|---|---|
| Official nomic ONNX is not a drop-in for lived Ollama `nomic-embed-text` | Stage 1 JSON (mean cosine 0.900851, 0/25 projections) | Public corpus only; one Mac arm64 |
| Product default flip is **NO-GO** | Same | Do not flip existing or shared default |
| v1 Host homes do not gain `home23-embedder` | Unit tests on `ownedProcessNames` / `PORT_KEYS` | No live v1 product-home receipt |
| Shared birth stays embedder-free | Host create birth `modelInvocations: 0` | Isolated TEST home, not a product owner home |
| New JSONL writer stamps are additive | `a58e5c61` + live shipper line on this TEST home | Historical JSONL stays unknown |
| Packaged Host create / prepare / start / restart / stop | untracked host-receipt on `.stage5-product-home` | One Mac arm64 TEST home |
| Real ONNX `/ready` + paraphrase rank (0.711 vs 0.555) | Live packaged `bin/node` + owned `/v1/embeddings` after product watch ingest | Not dashboard `/api/memory/search` |
| Chat URL decoupled from encoder on Host create | `product-host` create unit test | — |

## Independent review vs source

Findings from the 2026-09-11 independent review, checked against this branch after `c1b7cad5`, plus this Host slice.

| Finding | Verdict | Action |
|---|---|---|
| B1 Stop can leave `/ready` warm | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`; packaged Stop receipt now exists** | This TEST Host Stop left `/ready` connection-refused without a verifier kill |
| B2 download restarts from scratch | **Source Range-resumes; live fetch completed** | `.part` was observed growing on `host.mjs` semantic-prepare. Interrupt/resume of a truncated `.part` still unverified. `ensureArtifacts` still deletes `.part` on fetch throw |
| B3 live attention borrowed 0.60/0.12 | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`; live Host env null-cal** | Memory probe: live processes carried owned `SEED_EMBED_RECIPE_ID`; pair/pool admit false |
| B4 unstamped brain compare | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`; live sidecars stamped** | 6/6 Host brain nodes owned; query refused unstamped. Dashboard `/api/memory/search` still unavailable |
| B5 Stage 5 harness bypass | **Closed for Host create/prepare/start/import/restart/stop on this TEST home** | Dashboard memory-search and chat e2e remain open |
| Unknown aliases mint the frozen legacy hash | **Confirmed** | Unset / `nomic-embed-text` still lived-legacy |
| Prep worker is pid-liveness only | **Confirmed** | One worker on this prepare |
| `/ready` sticky; no truncation | **Confirmed** | GET `/ready` while warm returned 200 after restart |
| Pair consumers missing margin | **Disagree** | Contracts §7: margin is pool-only |
| `setup.js` must start semantic prep | **Disagree for this slice** | Product default flip **NO-GO** |
| Apple tests decode `phase:ready` only | **Confirmed; not this worktree** | Left on `88123ded` |
| Create-home tests fail here | **Worktree still has no `dist/`** | Installed payload has `dist/`; Host create used that |

## Lane status

| Lane | Status | Next |
|---|---|---|
| Encoder | Packaged Node/ORT `/ready` on a Host-created home | Optional interrupt/resume of a truncated `.part` |
| Memory | Live stamps, query refuse, null-cal attention, birth 0 on the Host TEST home | Dashboard `/api/memory/search` / `brain-state.json`; isolated shipper new-line after Stop |
| Host | Isolated TEST create/prepare/start/restart/stop evidenced | Do not wire source `setup.js`. Do not create a product/owner home |
| Apple | `88123ded` polls semantic-prepare | Interrupt tests; structured `error.code` |
| Lead | Encoder + Host + Memory receipts exist; chat blocked | Keep off shared main. Do not flip defaults |

## Go / no-go

| Item | Ruling |
|---|---|
| Product default flip | **NO-GO** |
| Existing-home switch (Stage 6) | **NO-GO** |
| Integrate to shared main | **NO-GO** |
| Public distribution | **NO-GO** |
| Create a product/owner home with this Host | **NO-GO** — isolated TEST only |
| Isolated Host TEST create | **done** on `.stage5-product-home` |
| Stages 1–5 milestone (including chat e2e answer) | **not complete** — chat blocked; dashboard memory-search unverified |

## Handoff

```text
Worktree: home23/.home23-worktrees/owned-embedder-stage5-verify
Branch:   home23-agent/owned-embedder-stage5-verify @ 303ff008
Payload:  packaged from d8f45ba3 (tip later added package.mjs transformers load-check)
TEST:     .stage5-product-home (Host). .stage5-host-home holds Memory + a copy of host-receipt.json
Shared:   home23 remains codex/jerry-continuity-20260907
Apple:    Host Stage 4 is 88123ded on home23-apple-agent/owned-embedder-host-stage4
          Shared Apple remains codex/mac-dashboard2-20260908
Do not:   push, flip defaults, migrate existing homes, delete TEST homes,
          create a product/owner home, commit scripts/embedder/node_modules
          or the TEST home / payload
Next:     chat e2e only with a real local chat model or supplied key;
          dashboard memory-search / brain-state persistence;
          optional download interrupt/resume; Apple interrupt / error.code
```
