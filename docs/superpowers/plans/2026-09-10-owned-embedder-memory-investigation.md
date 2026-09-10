# Owned embedder — Memory investigation

Date: 2026-09-10  
Worker: Memory  
Status: investigation and contract draft only — no product/runtime Memory changes  
Plan (source of truth): [2026-09-10-owned-embedder-host-integration.md](./2026-09-10-owned-embedder-host-integration.md) at `3c7495d6dd5b424a7e17307364b1b5a26586e49a`  
This file supersedes conflicting Memory statements in [the original embedder spec](../specs/2026-09-10-owned-embedder-design.md).

This document does not implement Stage 2. Shared contracts are not established. Encoder is running the Stage 1 compatibility experiment. Dependent Memory implementation waits for the lead after experiment evidence.

Written in an isolated worktree (`home23-agent/owned-embedder-memory-investigation-20260910`) so it does not collide with Encoder’s Stage 1 work-record or contracts files.

## 1. Plan stages and files Memory will own

Memory ownership from the plan: provenance, attention policy, retrieval/index compatibility, and Seed-preservation checks. Stages 1–5 are the first semantic new-home milestone; Stage 6 is existing-home transition and does not block that milestone.

| Stage | Memory work | Plan paths Memory will own later | Completion evidence Memory must supply |
|---|---|---|---|
| 1. Compatibility experiment | Consume Encoder inventory/measurements; do not change defaults or live state | None (read-only). Memory’s caller notes below are provisional until Encoder’s inventory lands. | Confirm Memory consumers and gates against the measured recipe. |
| 2. Encoder-aware contracts | Additive provenance/profile handling, complete attention policy, cache and dimension guards | See ownership map in §6. | Existing history still parses/replays; null calibration cannot gate semantically; mismatched vectors cannot compare. |
| 3. Owned inference service | No Encoder service work. Memory consumes request-shape, identity, and failure contracts. | Attention/retrieval callers stay on current seams until Host admits writers. | Contact and retrieval callers honor bounded deadlines and vector-absent fallback. |
| 4. Host and native setup | Preserve birth; do not start writers during preparation. | Seed-preservation tests around birth/replay. Do not own Host files. | Preparation-only Seed genesis remains free of embedding; first meaningful writer activity is after encoder warm-up. |
| 5. New-home semantic milestone | Document ingestion and retrieval integration on the home’s encoder; stamped Seed contact; working attention | Brain retrieval + attention + writer/adapter provenance | Isolated new home: import a nonpersonal document, retrieve it by paraphrase, observe stamped Seed contact and working attention. Restart preserves identity, history, and encoder selection. Memory scopes stay unmerged. |
| 6. Existing-home transition | Per-home provenance inventory, continuity decision, derived-index migration. Not a Seed rewrite. | Retrieval/index migration, provenance inventory, Seed-preservation proofs | Preserve Seed lineage and source history. Incompatible Seed transition stays blocked on explicit design. |
| 7. Release delivery | Focused Memory contract tests in ordinary CI | Tests listed in §8 | Lightweight policy/provenance tests in CI; do not substitute synthetic vectors for the real semantic milestone. |

Exact plan paths Memory will own (from the Integration map and Encoder/continuity contracts):

- Attention: `src/substrate/semantic-match.ts`, `src/substrate/seed-context.ts`, `src/agent/context-assembly.ts`, `src/agent/trigger-index.ts`
- Seed input/replay: `substrate/src/adapters/event-ledger-tail.ts`, `substrate/src/types.ts`, consumption boundary before `encodeEvent` (audit `substrate/src/metabolism.ts`; leaving it unchanged requires enforcement at its boundary)
- Brain retrieval / index: `engine/src/memory/network-memory.js`, `engine/src/merge/build-ann-index.js`
- Ledger writers that already persist `semantic_vector` (provenance stamp only; not fetch/protocol): `src/agent/relationship-ledger.ts`, `src/workers/receipts.ts`, `src/agent/tools/promote.ts`, `substrate/src/conversation-shipper.ts`, `substrate/bin/conversation-shipper.ts`, `substrate/bin/house-sense.ts`

Memory will **not** own Encoder/Host paths listed in §6.

## 2. Current architecture

Two embedding knobs already exist and can diverge:

| Knob | Config / env | Protocol | Default | Consumers |
|---|---|---|---|---|
| Seed / contact | `shared/seed-embedding-config.cjs` → `SEED_EMBED_ENDPOINT`, `SEED_EMBED_MODEL` | Ollama-native `POST /api/embeddings` → `{embedding}` | `http://127.0.0.1:11434/api/embeddings`, `nomic-embed-text`, 768 | `substrate/src/embed-fetch.ts` (conversation-shipper, house-sense); harness mirror `src/substrate/embed-at-contact.ts` |
| Brain / retrieval | `cli/lib/generate-ecosystem.js` `resolveEmbeddingConfig()` → `EMBEDDING_*` | OpenAI-compatible `POST /v1/embeddings` → `{data:[{embedding}]}` | `http://127.0.0.1:11434/v1`, `nomic-embed-text`, 768 | `engine/src/core/openai-client.js` `getEmbeddingClient()` → `engine/src/memory/network-memory.js` |

### Embeddings (write paths)

Perception is once-at-contact. Projected 16-dim vectors ride records forever. Native 768-dim vectors are for live matching only and are not persisted on Seed lines.

- Substrate writers (`substrate/bin/conversation-shipper.ts`, `substrate/bin/house-sense.ts`): `fetchRawEmbedding` (trim, slice 0..1000, expected 768, default timeout 2s) then `projectEmbedding` (`SEMANTIC_PROJECTION_SEED = 20260808`, `SEM_DIM = 16`, `EMBED_DIM = 768`, L2-normalize, clamp, quantize to 4dp).
- Harness writers (`src/agent/relationship-ledger.ts`, `src/workers/receipts.ts`, `src/agent/tools/promote.ts`): `embedTextSync` in `src/substrate/embed-at-contact.ts` (min text length 8, slice 0..1000, timeout 1500ms, same projection). `embedTextRawSync` is native 768 for matching only.
- Conversation shipper does not re-embed committed contacts: stream identity wins over a lost cursor.
- Brain nodes: `NetworkMemory.embed` / `embedBatch` on `node.concept` (Ollama path: tokenizer 512 tokens or 2000 chars; otherwise 8000 tokens / 30000 chars; batch 2048). Stored as `node.embedding` plus `embedding_status` (`embedded` / `missing`). `regenerateMissingEmbeddings()` skips nodes that already have embeddings.
- No writer today persists encoder recipe identity. Lines carry `semantic_vector` only.

### Indexes

- ANN builder (`engine/src/merge/build-ann-index.js`) indexes existing `node.embedding`. It does not regenerate from `node.concept`.
- HNSW space is `'cosine'`. First usable vector sets `dimension`; later length mismatches are skipped, not rejected as a fleet error.
- Reuse metadata stores `provider` + `model` from `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` (defaults `local` / `nomic-embed-text`), plus generation, revision, authority projection schema, and attestation key. Alias-equal model names are treated as the same identity.
- Rebuild tooling: `scripts/rebuild-ann-indexes.sh`, `scripts/lib/ann-index-health.cjs`. Dashboard search consumes the published index (`engine/src/dashboard/memory-search.js`).

### Retrieval

- `NetworkMemory.query`: embed query → cosine against stored node embeddings → spreading activation. Failed query embed or no vector match falls back to `queryByKeyword`.
- Brain `cosineSimilarity` returns `0` on missing or length-mismatched vectors (warns; does not throw).
- Keyword fallback is the lexical path the plan requires when semantic comparison is unavailable. Concurrent work on `home23-agent/fix-memory-keyword-cpu-runaway` (`eda7a46c`) bounds keyword scans; Memory embedder work must not replace that branch.

### Attention

Two different “attention” systems exist. Memory’s embedder work is the **semantic** gate, not the operator-notification gate.

- Shared matcher: `src/substrate/semantic-match.ts` — `SEMANTIC_MATCH_FLOOR = 0.6`, `MIN_MATCHABLE_ALNUM = 20`, process cache keyed by raw text only (`CACHE_MAX = 800`). `cosine()` compares `Math.min(a.length, b.length)` (does not reject dimension mismatch). Null score means “use lexical fallback,” never “no match.”
- Seed expression: `src/substrate/seed-context.ts` is **not** an unchanged consumer of the shared matcher. It has its own `MATCH_FLOOR = 0.6`, `MATCH_MARGIN = 0.12`, `MIN_MATCHABLE_TURN_ALNUM = 20`. It uses `cachedEmbedRaw` + `cosine` and additionally requires `score - median >= MATCH_MARGIN`. Short or unembeddable turns surface nothing (not the lexical dump).
- Triggered surfaces and operational load: `src/agent/context-assembly.ts` uses `semanticMatchScore` + floor only (no margin).
- Durable memory triggers: `src/agent/trigger-index.ts` same floor-only gate for `keyword` and `workflow_stage`.
- Not in this ownership: `src/agent/attention/attention-gate.ts` and `engine/src/attention/attention-policy.cjs` (interrupt vs ambient notifications). Do not conflate them with encoder calibration.

### Provenance (today)

- Seed `SourceEvent` (`substrate/src/types.ts`) has optional `semanticVector?: number[]` only. No encoder id, dimension, projection seed, or absent-vector reason.
- Adapter parse sites in `event-ledger-tail.ts` (house ~316, conversation ~381, relationship ~420, worker-runs ~460) call `sanitizeSemanticVector` and drop unknown fields. Dream and harness lines do not carry vectors.
- Event ids for house / non-canonical conversation / fallback relationship / worker-runs hash the **source line**. Editing an existing JSONL line changes event identity and can move byte-offset cursors.
- Brain provenance (`engine/src/memory/provenance-salience.js`, `shared/memory-authority.cjs`) classifies claim authority and domain. It is not embedder identity.
- Memory objects (`src/agent/memory-objects.ts`) carry source/session provenance, not encoder recipe.

### Seed history

- Developmental ledger is append-only chain-hashed state. Replay consumes recorded `semanticVector`; `encodeEvent` overlays the leading content channels when a vector is present, otherwise `sha256(sourceRef:producedAt:category:sourceAuthority)`.
- `INPUT_DIM = 32` (28 content + 4 control). Projected semantics occupy the leading 16 of those content channels.
- Birth: `cli/lib/seed-birth.js` / `cli/lib/create-home.js` prepare an independent Seed with no model invocation and no service start. Retry must preserve exact lineage bytes, including life added after preparation (`tests/cli/seed-birth.test.js`).
- Conversation shipper: committed contacts are never re-embedded.

### Memory scopes and resident authority

- ANN default target must be the canonical nonsymlink own-brain path; access mode is `own` / `owned-run` (`shared/memory-source`).
- Residents, helpers, and channels may reuse one home encoder service. Their memory sources and authority projections stay separate. Do not merge scopes.
- Resident authority stays in `shared/memory-authority.cjs` and attestation. Encoder identity is a new, separate stamp.

## 3. Compatibility constraints

| Constraint | Current fact | Plan rule Memory must enforce |
|---|---|---|
| Native dimension | Seed fetch requires exactly 768. Projection throws otherwise. Brain default 768; `EMBEDDING_DIMENSIONS` can differ. | A different dimension is a separate design change. Reject mismatches; do not compare the shorter length. |
| Projected dimension | 16 floats, seed `20260808`, 4dp quantization. Dual copies (harness + substrate) pinned by parity test. | Do not change `SEMANTIC_PROJECTION_SEED` or `SEM_DIM`. |
| Distance / metric | Attention and brain retrieval use cosine. ANN is HNSW `'cosine'`. | Keep cosine. Do not mix spaces. |
| Index format | Persistent HNSW + JSON metadata (`version: 1`, `provider`, `model`, revision, authority schema). Indexes stored embeddings only. | Rebuild vs reuse: reuse only when recipe identity, dimension, revision, and authority context match. Alias or equal dimension is not compatibility. |
| Missing-vector repair | `regenerateMissingEmbeddings()` and ANN skip nodes that already have embeddings. | Must not silently re-perceive. Replacement generation is a separate resumable derived index, preserving original records. |
| Preprocessing | Seed: trim + `slice(0, 1000)` (harness also min length 8). Brain: tokenizer/char caps, optional extractive summary retry. | Live query and stored vectors must use the same recipe, including prefix/truncation. Persist or fingerprint the exact embedded text rules in the recipe id. |
| Cache | Attention cache keyed by text only. | Key caches by recipe. |
| Seed immutability | Line-hash event ids; chain cursor; shipper “never re-embed existing contact.” | Additive provenance on **new** lines only. Do not rewrite source contacts or developmental ledgers. Unstamped old records parse; they do **not** automatically acquire a known Nomic identity (plan supersedes the original spec). |
| Calibration | Floor 0.60 / margin 0.12 / min alnum 20, calibrated 2026-08-08. Uncalibrated policy must not semantic-gate. | seed-context’s three-gate policy is the complete attention policy. Floor-only consumers are incomplete. |
| Existing homes | Live installation retains selected encoder and lived state. | Installing a newer companion must not silently change an installed home. Stage 6 is a later continuity decision. |

## 4. Required Seed-preservation checks

What must remain immutable:

1. Genesis record: `seedId`, name, `selfFormation`, anatomy, `genesisHash` / cursor at seq 1.
2. Developmental ledger bytes already written: event ids, payloads, recorded `semantic_vector` values, chain hashes, checkpoint state hashes.
3. Source contact streams already shipped: conversation/house/relationship/worker-run JSONL lines. No in-place stamp, re-embed, or field injection on old lines.
4. Shipper cursors and “do not re-embed committed contact” behavior.
5. Reservoir / learned state: not translated by rebuilding vectors on disk.
6. Published projection: seed `20260808`, 16-dim, 4dp.
7. Shared home-birth operation: no model download, no encoder start, no contact writers during `prepareSeedBirth` / `createHome`.
8. Resident authority and memory scopes: own-brain binding, unmerged helper/channel sources.
9. Replay of unstamped history: still parses; still encodes by identity hash when vector absent; does not gain a fabricated encoder id.

How Memory will prove it (after contracts; not implemented now):

| Check | Method | Fixture rule |
|---|---|---|
| Birth bytes | Extend `tests/cli/seed-birth.test.js` “retry preserves the exact lineage and all bytes.” Snapshot stateDir before/after any encoder-aware code path. | No personal text. |
| Single genesis | Existing seed-birth assertion: one genesis after retry; changed inputs cannot rewrite a birth. | Keep. |
| Historical parse | Fixture JSONL lines **without** encoder fields, including pre-2026-08-09 `jerry` self-voice and line-hashed ids. Adapter must emit the same `eventId`, `semanticVector`, and payload. | Public synthetic lines only. |
| Replay identity | Restore a frozen Seed stateDir; replay the same ledger; `stateHash` / `transitionCount` / cell ids unchanged. | Synthetic reservoir, not live homes. |
| No source rewrite | Conversation-shipper / house-sense tests: existing stream lines and cursors unchanged when encoder identity is added to the writer. New lines may carry stamps. | |
| Projection lock | Existing `tests/agent/semantic-projection-parity.test.ts` plus `substrate/tests/semantic-encoder.test.ts` still pass with unchanged seed/dim. | Synthetic 768-vectors. |
| Absent vector | Embedder-down write still ships a line without a vector; `encodeEvent` uses identity hash. | |
| Scope isolation | Ingestion/retrieval tests keep resident vs helper vs channel sources unmerged. | |
| Existing-home freeze | Stage 5 proof uses an isolated new home only. No write into `../release/home23` or an adopted product home. | |

Do not borrow legacy calibration or relabel old history from a finite corpus.

## 5. Proposed Memory-side contract needs

These are Memory requirements for Encoder/Host. They are not a shared contract until the lead publishes one. Memory will not edit Encoder’s work-record or contracts files.

### From Encoder (inputs Memory needs)

- Recipe identity that fingerprints the actual computation: model/tokenizer artifacts, precision, prefix/truncation, pooling, normalization, projection version (`20260808` / 16). A requested model alias or equal dimension is not this id.
- Native output dimension (expected 768 unless experiment says otherwise — that would be a separate design change).
- Single- and batch-request shapes for both existing protocols, plus the exact text transform (Seed `slice(0,1000)` vs brain tokenizer caps).
- Structured result: vector **or** typed absence (`too_short`, `timeout`, `unavailable`, `dimension_mismatch`, `bad_artifact`, `cancelled`) — never a fabricated vector.
- Health: recipe id actually loaded, warm-up proof (finite output + dimension), not merely PM2 `online` or `/api/tags`.
- Calibration object, separately versioned from the recipe: `matchFloor`, `matchMargin`, `minMatchableAlnum`, `calibratedAt`, receipt. `null` floor/margin means “do not semantic-gate.”
- Cache key material: recipe id must be part of any embed cache key Memory or Encoder shares.
- Deadline behavior: contact/interactive priority vs ingestion batch; expired requests cancel; Seed contact currently 1.5–2s synchronous.

### Events Memory must see (Host + Encoder)

- Semantic-preparation states: downloading, verifying, warming, ready, interrupted, failed — distinct from home prepared, resident ready, and document-ingestion complete.
- Writer-admission barrier: contact writers remain stopped until encoder warm-up succeeds (or Host explicitly runs degraded).
- Encoder outage on a running home: nonblocking vector-absent writes; attention falls back honestly; capability reported degraded. Restoring the encoder must not backfill immutable contact history.
- Query-time recipe, stored vectors, ANN index, and caches activate together. No mixed live encoder fleet.

### Provenance fields Memory will persist (additive, optional)

On **new** Seed source lines and adapted `SourceEvent`s:

- `semantic_vector` — unchanged recorded projected vector (16-dim when present).
- Encoder identity (name TBD by shared contract; original spec’s `semantic_encoder` string is a candidate, not authority).
- Optional: native dim, projection seed, absent-vector reason. Missing old stamps stay missing / unknown.

On **new** brain nodes and ANN metadata:

- Recipe id (not only `provider`+`model` env strings).
- Dimension and metric (`cosine`).
- Generation / revision already present; add recipe so reuse cannot treat alias-equal models as compatible.

### Failure behavior Memory will implement against

| Condition | Memory behavior |
|---|---|
| Encoder down / timeout / cancelled | Write without vector; attention lexical/no-match path; retrieval keyword fallback. Do not invent ids or vectors. |
| Dimension or recipe mismatch | Refuse semantic compare. Do not slice to min length. Do not index into an incompatible ANN. |
| Uncalibrated policy (`matchFloor: null`) | No semantic gating in **any** consumer, including seed-context. |
| Unknown historical provenance | Parse and replay. Do not compare against a live recipe. Do not auto-label as Nomic. |
| Incompatible ANN | Do not reuse. Build a separate derived index from canonical retrieval text; keep original embeddings. |
| Preparation incomplete | No contact writers. Birth/retry still byte-identical. |

## 6. File ownership map (future stages)

Claimed later by Memory. Not claimed now; no production edits in this assignment.

| Path | Why |
|---|---|
| `src/substrate/semantic-match.ts` | Shared matcher, cache key, dimension reject, policy consumption. |
| `src/substrate/seed-context.ts` | Complete attention policy (floor + margin + short-turn). |
| `src/agent/context-assembly.ts` | Triggered surfaces / operational gate must use the same policy. |
| `src/agent/trigger-index.ts` | Keyword / workflow_stage gates. |
| `substrate/src/adapters/event-ledger-tail.ts` | Carry optional provenance; preserve old parse and event ids. |
| `substrate/src/types.ts` | Additive optional provenance on `SourceEvent`. |
| Boundary before `encodeEvent` (new small module or adapter-side guard; `substrate/src/metabolism.ts` only if enforcement cannot live at the boundary) | Compatibility before consumption; metabolism may stay unchanged. |
| `engine/src/memory/network-memory.js` | Stored/query recipe, batching, missing-vector policy, keyword fallback. |
| `engine/src/merge/build-ann-index.js` | Index metadata recipe, reuse guards, no silent re-embed. |
| Ledger writers listed in §1 | Additive stamp on new lines only. |
| Tests in §8 | Extensions, not replacements of Host/Encoder suites. |

Possible new Memory-owned modules (paths TBD with lead; not created now): a shared attention-policy helper and a provenance sanitize/compare helper so seed-context and the matcher cannot drift again.

**Not claimed (Encoder / Host / shared birth):**

- `scripts/embedder/` and recipe/profile modules, dependency manifests
- `shared/seed-embedding-config.cjs`, `cli/lib/generate-ecosystem.js`
- `src/substrate/embed-at-contact.ts` fetch/protocol, `substrate/src/embed-fetch.ts` (Encoder). Memory consumes their projection contract; Encoder owns request shape and model validation. Projection constants stay locked by the parity test.
- `engine/src/core/openai-client.js` (Encoder protocol seam for brain embeddings)
- `cli/lib/product-host.js`, `cli/lib/product-environment.js`, `cli/lib/product-memory.js`, `scripts/product/host.mjs`
- `cli/lib/create-home.js`, `cli/lib/seed-birth.js`, `cli/lib/setup.js`, `cli/lib/init.js`
- Packaging and Apple `Home23Host/*`
- `src/agent/attention/attention-gate.ts`, `engine/src/attention/attention-policy.cjs` (notification attention)

## 7. Risks if implementation starts before experiment results

1. **Dimension / metric mismatch.** Shipping a default or comparing live queries to stored 768-cosine indexes before measuring native agreement can silently retune attention (floor 0.60) and retrieval rank. `semantic-match` already compares the shorter length; that would hide a dim change.
2. **Index rebuild as if it were migration.** ANN and `regenerateMissingEmbeddings` skip existing embeddings. Flipping the live recipe without a replacement generation leaves old vectors in a new query space, or rebuilds in place and destroys the prior usable generation.
3. **Seed rewrite.** Stamping or re-embedding historical JSONL changes line-hashed event ids and byte-offset cursors. Re-perceiving developmental ledgers changes reservoir input forever. The original spec’s “missing field ⇒ known Nomic id” would relabel history without evidence; the plan forbids that.
4. **Partial attention policy.** Implementing floor-only in the matcher and leaving seed-context’s margin/length behind (or the reverse) recreates the “unchanged consumer” error the plan already corrected.
5. **Cache poisoning.** Text-only cache would mix recipes after a switch.
6. **Birth / writer ordering.** Embedding during `prepareSeedBirth` or admitting writers before warm-up permanently blinds first contacts.
7. **Scope merge.** One encoder process is not one memory source. Indexing helper/channel nodes into a resident ANN would violate resident authority.
8. **Existing-home default flip.** Changing operator or Host defaults before Stage 6 would alter lived attention with no crash and no failing test.

## 8. Existing tests Memory will extend later

Do not replace unrelated suites. Keep personal text out of public fixtures.

| Suite | Why extend |
|---|---|
| `tests/agent/semantic-projection-parity.test.ts` | Lock projection seed/dim; later stamp must not change math. |
| `substrate/tests/semantic-encoder.test.ts` | `encodeEvent` meaning overlay vs identity-hash fallback; projection rejects non-768. |
| `substrate/tests/adapter-runner.test.ts` | Conversation line already asserts `semanticVector` length 16; add unknown-provenance parse and event-id stability. |
| `tests/agent/seed-context.test.ts` | Floor + margin + short-turn + bootstrap silence; add null-calibration and recipe-keyed cache. |
| `tests/agent/context-assembly` / trigger-index coverage (today via `src/agent/context-assembly.ts` and `src/agent/trigger-index.ts` call sites; no dedicated semantic-match test file) | Add a focused attention-policy test that all three consumers share. |
| `tests/engine/memory/network-memory-embedding-batch.test.js` | Batch order/fallback; later carry recipe and refuse mixed dims. |
| `tests/engine/memory/network-memory-temporal.test.js` | Embedding normalize / missing status. |
| `tests/engine/memory/network-memory-keyword-index.test.js` | Lexical fallback; preserve concurrent keyword-bound work. |
| `tests/engine/merge/build-ann-index.test.js` | Already refuses reuse across provider/model; extend to recipe fingerprint, not alias. |
| `tests/scripts/rebuild-ann-indexes.test.cjs` | Derived-index rebuild policy. |
| `tests/engine/dashboard/memory-search.test.js` | Search must not mix incompatible ANN generations. |
| `tests/cli/seed-birth.test.js` | Byte-identical retry; no encoder side effects in birth. |
| `tests/shared/seed-embedding-config.test.cjs` | Read for credential-free contact contract; Encoder owns edits. |
| `tests/agent/memory-objects-provenance.test.ts` | Resident correction authority; keep scopes separate from encoder stamps. |
| `tests/shared/memory-source-*.js` / `tests/shared/memory-authority*.cjs` | Own-brain / accessMode / attestation unchanged. |
| `tests/agent/context-brain-retrieval.test.ts` | Brain retrieval wiring. |
| `tests/cli/product-{host,memory,package,payload}` | Host-owned; Memory only reads readiness distinctions. |
| `tests/agent/attention-gate.test.ts`, `tests/engine/attention/attention-policy.test.js` | Notification attention — do not overload with encoder calibration. |

Plan also names Apple `Home23Host/Tests/HostCommandTests.swift` (Host, not Memory).

Gap: there is no `semantic-match` unit test that pins dimension reject or recipe-keyed cache. Add one in Stage 2.

## 9. Recommended first Memory implementation slice (after contracts; do not implement)

Stage 2 only, on an isolated Memory worktree, after the lead publishes shared contracts and Stage 1 evidence:

1. Additive optional provenance on `SourceEvent` and the four vector-carrying adapter parse sites. Old lines parse unchanged; unknown stays unknown.
2. Shared attention-policy helper: floor, relative margin, min alnum, null-calibration ⇒ no semantic gate. Switch `semantic-match.ts`, `seed-context.ts`, `context-assembly.ts`, and `trigger-index.ts` to it.
3. Reject dimension/recipe mismatches in matcher and brain cosine (no `Math.min` length). Key the embed cache by recipe id.
4. ANN reuse: treat recipe id as required identity alongside provider/model; do not rebuild or re-embed yet.
5. Tests from §8 for parse/replay, null calibration, and mismatch reject.

Out of this first slice: default endpoint flip, model download, Host process, index replacement generation, Seed rewrite, existing-home transition, live installation.

## 10. Open questions only experiment evidence can answer

1. Native-vector agreement between current Ollama `nomic-embed-text` and the candidate (plan: want > 0.99; ~0.95 suggests prefix/pooling drift).
2. Whether turn↔anchor distributions keep the same pairs on the same side of floor 0.60 and margin 0.12.
3. Whether projected 16-dim / 4dp outputs agree. If not, recorded Seed vectors and live perception diverge even if native cosine looks close.
4. Exact pinned recipe: model revision, artifact format, precision, prefix, truncation, pooling, normalization, runtime version.
5. Whether brain stored embeddings are in the same space as Seed native/projected spaces (two knobs today).
6. Whether existing ANN `provider`+`model` metadata is trustworthy enough to reuse, or every index is unknown-provenance.
7. Contact latency under ingestion load vs current 1.5–2s synchronous deadlines (Memory fallback vs Host queue).
8. What, if anything, can be established about unstamped historical records. Missing stamps stay unknown unless evidence identifies them.
9. Whether Stage 5’s paraphrase-retrieval bar is reachable with the candidate without changing projection or scopes.

Passing a finite nonpersonal corpus supports a compatibility decision. It does not prove all future inputs produce identical vectors. It does not authorize changing an existing home.

## Concurrent work preserved

- Shared checkout `/Users/jtr/_JTR23_/development/home23` remains `codex/jerry-continuity-20260907` @ `44288211`. Not switched.
- Encoder Stage 1 worktree: `.home23-worktrees/owned-embedder-encoder-stage1` on `home23-agent/owned-embedder-encoder-stage1`. Work-record and contracts files not touched.
- Memory keyword bound: `.home23-worktrees/fix-memory-keyword-cpu-runaway` @ `eda7a46c`. Resume, do not replace.
- Historical encoder stages (2026-08 commits `dbc583550`, `ac4095a91`, `8eea39ed8`) are the current architecture, not a competing owned-embedder attempt.
- `../release/home23` is the live installation, not a development source.
- home23-apple inspected only; no edits.

## Handoff

Next Memory action after the lead publishes contracts and Stage 1 evidence: implement the §9 slice on this worktree (or a successor from the then-current maintained commit). Do not claim the product milestone complete.
