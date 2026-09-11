# Owned embedder — work record

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Plan commit verified: `3c7495d6dd5b424a7e17307364b1b5a26586e49a`

**Stages 1–5 are not established as complete.** This record must not be read as a milestone receipt.

## Isolation

| Item | Value |
|---|---|
| Worktree | `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify` |
| Branch | `home23-agent/owned-embedder-stage5-verify` |
| Shared `home23` | `codex/jerry-continuity-20260907` — not switched, not this work |
| Shared `home23-apple` | `codex/mac-dashboard2-20260908` — not the Host Stage 4 commit |
| Apple Host edits | `home23-apple-agent/owned-embedder-host-stage4` @ `88123ded` (separate worktree) |
| Live homes / `../release/home23` | not used as source; not altered |

## What is established

| Fact | Evidence | Limit |
|---|---|---|
| Official nomic ONNX is not a drop-in for lived Ollama `nomic-embed-text` | Stage 1 JSON (mean cosine 0.900851, 0/25 projections) | Public corpus only; one Mac arm64 |
| Product default flip is **NO-GO** | Same | Do not flip existing or shared default |
| v1 Host homes do not gain `home23-embedder` | Unit tests on `ownedProcessNames` / `PORT_KEYS` | No live v1 product-home receipt |
| Shared birth stays embedder-free | `seed-birth` `modelInvocations: 0` | Harness birth, not packaged Host create |
| New JSONL writer stamps are additive | `a58e5c61` | Historical JSONL stays unknown |
| Real ONNX `/ready` + paraphrase rank (0.711 vs 0.555) | Isolated TEST cache-copy harness | Not product import-folder; not packaged Node |
| Chat URL decoupled from encoder on Host create | `product-host` create unit test | — |

## What is not established

| Claim previously overstated | Actual |
|---|---|
| Stage 5 restart / ingestion | `verify-embedder-stage5.mjs` is a stub home (`bin/node` = four bytes `node`, fake PM2). Only ambient `process.execPath` runs source `serve.mjs`. Restart did not start Seed/engine/coordination or re-query after a full Host restart. |
| Chat e2e as Host conversation | `chat-e2e-probe.mjs` was retrieve-then-answer via ambient Ollama `llama3.2:1b` (later deleted). Not Host GUI. Not “no ambient Ollama” for chat. |
| Host Stop remains stopped | Committed `3cfdea94` Stop did not probe `/ready`. Evidence-5 recorded a leftover warm pid. |
| Live attention is null-cal on owned homes | Production callers did not receive a recipe id; `resolveAttentionPolicy(undefined)` is lived 0.60/0.12. |
| Brain retrieval is recipe-guarded on HEAD `3cfdea94` | Evidence-5 nodes were `recipeId: null`. Dirty/now-landed `addNode` stamps were not in that commit. |
| Interrupted download resume | `artifacts.mjs` has no Range/cancel/atomic-after-verify. Stage 4/5 receipts used `cache-copied`. |

## This slice (after the review)

Landed on this branch (local commit after this file):

- Fail-closed Host Stop: SIGTERM leftover `/ready` pid; **throw** `host_encoder_still_warm` if still warm. No `acceptedAbort: true`.
- Host create writes `recipeId` on `home.embeddings.providers[0]` and `home.substrate.embedding`.
- `resolveSeedEmbeddingEnv` exports `SEED_EMBED_RECIPE_ID`. `generate-ecosystem` exports `EMBEDDING_RECIPE_ID` when the provider row has `recipeId`.
- `context-assembly` / `trigger-index` pass `activeAttentionRecipeId()` (from `SEED_EMBED_RECIPE_ID`).
- `NetworkMemory.addNode` stamps new vectors; query and `findInitialConnections` refuse unstamped/cross-recipe compares when the active recipe is owned.

**Still missing for a Stage 5 / Host-recovery verdict:** real `host.mjs` create + download interrupt/resume; packaged `Home/bin/node` ORT load; product import-folder + full allowlisted PM2 restart; live v1 receipt; `/ready` finite re-encode; fetch Range/cancel.

## Lane status

| Lane | Status | Next |
|---|---|---|
| Encoder | Stage 1 measurements + Stage 3 serve exist | Interrupt/resume fetch; `/ready` re-encode; packaged Node/ORT |
| Memory | Guards + JSONL stamps + (this slice) brain stamps | Unknown-alias must not map to frozen legacy hash |
| Host | v2 admission + (this slice) fail-closed Stop + recipe env | Real create/download; source `setup.js` prep; do not create a real home with this Host yet |
| Apple | `88123ded` polls semantic-prepare | Interrupt tests; structured error.code |
| Lead | Overclaim corrected | Keep off shared main. Do not treat Stages 1–5 as complete. |

## Go / no-go

| Item | Ruling |
|---|---|
| Product default flip | **NO-GO** |
| Existing-home switch (Stage 6) | **NO-GO** |
| Integrate to shared main | **NO-GO** |
| Create a real home with this Host | **NO-GO** until fail-closed Stop + recipe-env are in a reviewed commit **and** Host create/download evidence exists |
| Stages 1–5 milestone | **not complete** |

## Handoff

```text
Worktree: home23/.home23-worktrees/owned-embedder-stage5-verify
Branch:   home23-agent/owned-embedder-stage5-verify
Shared:   home23 remains codex/jerry-continuity-20260907
Apple:    Host Stage 4 is 88123ded on home23-apple-agent/owned-embedder-host-stage4
          Shared Apple remains codex/mac-dashboard2-20260908
Do not:   push, flip defaults, migrate existing homes, delete TEST homes
Next:     real host.mjs create + download interrupt/resume; packaged Node/ORT;
          product import-folder + full Host restart. Not another cache-copy harness.
```
