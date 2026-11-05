# Owned embedder — Stage 2 authorization

Date: 2026-09-10  
From: Lead  
Contracts: `2026-09-10-owned-embedder-contracts.md`  
Plan: `2026-09-10-owned-embedder-host-integration.md` @ `3c7495d6`

Stage 2 is **GO**. No default flip. No Seed rewrite. No existing-home change. No index replacement generation.

## Sequencing

1. **Memory** implements the first slice below on a **new isolated worktree** (do not switch shared `jerry-continuity`; do not clobber Encoder/Host/keyword-runaway trees).
2. **Encoder** may add contract-test seams now (no `serve.mjs`). Stage 3 service starts only after the Memory first slice is committed in source.
3. **Host** stays investigation-only for product/Apple files until Stage 3 exists. Process / health / port / recipe fields are frozen in the contracts.

## Memory — Stage 2 first slice (authorized now)

Additive parse-through provenance, shared attention policy, dimension/recipe reject, recipe-keyed cache, ANN reuse identity.

### Files Memory may edit

| Path | Allowed work |
|---|---|
| `src/substrate/semantic-match.ts` | Reject unequal lengths; recipe-keyed cache; consume shared policy (null-cal ⇒ no semantic gate). |
| `src/substrate/seed-context.ts` | Same shared policy (floor + margin + short-turn + null-cal). Do not change published projection. |
| `src/agent/context-assembly.ts` | Switch from floor-only to shared policy. |
| `src/agent/trigger-index.ts` | Switch from floor-only to shared policy. |
| `substrate/src/adapters/event-ledger-tail.ts` | Parse-through optional `semantic_recipe_id` / `semantic_encoder` / absent reason. Old lines unchanged; event ids stable. |
| `substrate/src/types.ts` | Additive optional provenance on `SourceEvent`. |
| New small Memory-owned helper(s) | Shared attention-policy helper and provenance sanitize/compare. Paths chosen by Memory; do not put them under `scripts/embedder/` or Host trees. |
| Boundary before `encodeEvent` | Compatibility guard if needed so `substrate/src/metabolism.ts` can stay unchanged. Edit `metabolism.ts` only if the boundary cannot enforce. |
| `engine/src/memory/network-memory.js` | Refuse length/recipe mismatch (no `min(length)` compare). Carry recipe on query path. Keep keyword fallback. Do not re-embed or change missing-vector repair. |
| `engine/src/merge/build-ann-index.js` | Reuse identity: recipe id required to reuse against **owned** / mismatched recipes. Legacy indexes without recipe id keep provider+model reuse. Do not rebuild or re-embed. |

### Tests Memory may add or extend

`tests/agent/semantic-projection-parity.test.ts` (must still pass unchanged math) · new focused `semantic-match` unit test (dimension reject + recipe-keyed cache + null-cal) · `tests/agent/seed-context.test.ts` · `substrate/tests/adapter-runner.test.ts` · `substrate/tests/semantic-encoder.test.ts` (replay / absent vector) · `tests/engine/memory/network-memory-embedding-batch.test.js` · `tests/engine/merge/build-ann-index.test.js` · `tests/cli/seed-birth.test.js` (byte-identical; no encoder side effects).

Public synthetic fixtures only. No personal ledger text.

### Not in this slice

Ledger writer stamps (`src/agent/relationship-ledger.ts`, `src/workers/receipts.ts`, `src/agent/tools/promote.ts`, `substrate/bin/conversation-shipper.ts`, `substrate/bin/house-sense.ts`) — later Memory slice after parse-through lands.

Do not edit: `src/substrate/embed-at-contact.ts`, `substrate/src/embed-fetch.ts`, `engine/src/core/openai-client.js`, `shared/seed-embedding-config.cjs`, `cli/lib/generate-ecosystem.js`, Host/product files, Apple, `scripts/embedder/serve.mjs`, notification attention (`src/agent/attention/attention-gate.ts`, `engine/src/attention/attention-policy.cjs`).

Do not replace `home23-agent/fix-memory-keyword-cpu-runaway`.

Legacy active recipe keeps floor `0.60` / margin `0.12` / min-alnum `20`. Owned recipe stays `matchFloor: null`.

## Encoder — now vs Stage 3

### May touch now (no service)

| Path | Allowed work |
|---|---|
| `scripts/embedder-experiment/**` | Already theirs; may add schema/fixture checks. Do not point product defaults at it. |
| New contract-test seams only | Recipe-id canonical JSON + hash helper tests; request/response fixtures for both HTTP shapes; health **field** schema tests (path still unknown). Prefer `scripts/embedder-experiment/` or a new `scripts/embedder/README` + schema file **without** `serve.mjs`. |
| Docs already on Encoder branch | Do not rewrite Lead contracts. |

### Stage 3 only after Memory first slice is in source

| Path | Allowed work |
|---|---|
| `scripts/embedder/serve.mjs` and siblings | New distinct recipe; both HTTP shapes; warm health; fetch/verify/atomic publish/cancel/offline pre-seed; bind/Origin/Host; no user text in logs; bounded queue. |
| Recipe/profile modules next to that service | Pin `owned-nomic-v1.5-onnx-fp32-mean-noprefix`. |
| `shared/seed-embedding-config.cjs` | Validation / credential-free rules only. **No default endpoint flip.** |
| `src/substrate/embed-at-contact.ts`, `substrate/src/embed-fetch.ts` | Strict model/recipe validation; typed absence. Preserve preprocess/projection/deadlines. |
| `engine/src/core/openai-client.js` | Protocol seam only; no default flip. |
| Dependency manifests/locks for the service | Load-check story for Host comes later. |

Do not edit Host/Apple/Memory attention files. Do not change existing homes.

## Host — frozen fields; still investigation-only

Do not implement Stage 4 product files yet.

Frozen for Stage 3/4 (see contracts §6):

- Process name `home23-embedder`
- Admission `encoderRequired` / versioned requirement
- Port key `embedder` on a versioned port plan (not `11435`; do not expand `PORT_KEYS` / `ownedProcessNames()` unversioned)
- Health fields: `recipeId`, `dimension`, artifact digests, `warm` (real inference)
- Recipes: `legacy-ollama-nomic-unprefixed` vs `owned-nomic-v1.5-onnx-fp32-mean-noprefix`
- Birth remains `createHome` / `prepareSeedBirth`
- Cache: Host-selected explicit path (env **name** still unknown)
- Chat URL ≠ encoder URL

Still **unknown** (Encoder Stage 3 must measure): argv, HTTP health path, cache env name, structured error enum beyond typed absences, native-module/codesign needs.

Later Host files (not now): `cli/lib/product-host.js`, `product-environment.js`, `product-memory.js`, `scripts/product/host.mjs`, `cli/lib/setup.js`, `cli/lib/init.js`, packaging, Apple `Home23Host/*`.

## Stage 5 if default flip stays NO-GO

Create a **new isolated TEST home** (new payload output dir, or Host `--home-root` / `--payload`). Never `../release/home23` or `~/Library/Application Support/Home23 Host/Home`.

That home **explicitly** selects the owned recipe (`encoderRequired` + owned profile). Shared product defaults stay legacy/Ollama.

Prove, with **real** owned inference (not `verify-install.mjs` fixture embeddings):

- Model fetch/verify/warm
- Stamped Seed contact on **new** lines
- Import a nonpersonal document and retrieve it by paraphrase (ranking / Memory path)
- Restart preserves identity, history, and that home’s encoder selection
- Real configured chat provider for the end-to-end **answer** claim

“Working attention” as semantic gating waits for an owned-recipe calibration receipt (floor + margin + min-alnum + `calibratedAt` + receipt). Until then the TEST home uses honest null-cal lexical / no-gate behavior. Do not borrow `0.60` / `0.12`.

Ordinary CI may keep protocol/policy fixtures. The Stage 5 semantic milestone may not.

## Out of scope

Stage 6 existing-home switch. Production activation. Push. Default flip. Seed rewrite. Live installation edits.
