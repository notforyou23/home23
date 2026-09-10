# Owned embedder — proposed shared contracts

Date: 2026-09-10  
From: Encoder Stage 1 (compatibility experiment)  
Plan: `2026-09-10-owned-embedder-host-integration.md` @ `3c7495d6`  
Evidence: `scripts/embedder-experiment/results/stage1-summary.json`, `recipe-pin.json`  
Field marks: **measured** / **specified by plan** / **proposed** / **unknown**

These contracts are a proposal for Memory, Host, and Lead. They do not change product defaults.

## 1. Vector space

| Field | Value | Mark |
|---|---|---|
| Native dimension | 768 | specified by plan; measured on Ollama and ONNX |
| Projected Seed dimension | 16 | specified by plan (published, do not change) |
| Projection seed | `20260808` | specified by plan |
| Projection math | L2-normalize native vector, multiply published matrix, clamp `[-1,1]`, quantize 4 d.p. | specified by plan; copied in experiment |
| Native metric for attention and ANN | cosine | specified by plan; measured ANN uses hnswlib `cosine` |
| Provider L2 normalization | Ollama baseline is **not** unit-length (L2 mean 20.42, range 16.76–23.54). Cosine and the published projection both re-normalize. | measured |
| Task prefix | Current Home23 writers send **no** Nomic prefix. Ollama template is `{{ .Prompt }}`. Adding `search_document:` drops per-vector cosine vs baseline to mean 0.90 (max 0.95). | measured |
| Compatible drop-in | Official ONNX `nomic-ai/nomic-embed-text-v1.5` fp32 mean-pool, with or without prefixes, is **not** the Ollama space. Best candidate mean cosine 0.9009; min 0.517; **0/25** projections equal to 4 d.p. CLS pooling is worse (mean 0.773). | measured |

**Implication (proposed):** a requested model alias or equal dimension does not establish compatibility. Compare only vectors that share a verified recipe id.

## 2. Encoder identity / recipe

**proposed** recipe fingerprint (plan: identity includes artifacts, precision, prefix/truncation, pooling, normalization, projection version):

```
recipe_id = sha256(canonical_json({
  family, source, artifact_digests, precision,
  pooling, prefix_policy, truncation, expected_dim,
  projection_seed, projection_dim
}))
```

Two measured identities that must stay distinct:

| Profile | recipe (human) | When |
|---|---|---|
| `legacy-ollama-nomic-unprefixed` | Ollama `nomic-embed-text` GGUF F16, digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, no prefix, Seed `slice(0,1000)` / Memory `slice(0,2000)` or 512 tokens | existing homes / current writers |
| `owned-nomic-v1.5-onnx-fp32-mean-noprefix` | HF `nomic-ai/nomic-embed-text-v1.5` `onnx/model.onnx` sha256 `147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965`, Transformers.js 3.7.6, mean pool, no prefix, Node 22 | candidate owned service; **new recipe**, not a relabel of legacy |

Calibration is a separately versioned attention policy attached to a recipe. **specified by plan.** Uncalibrated `matchFloor: null` must not gate semantically. **specified by plan.**

Do **not** treat missing historical stamps as `nomic-embed-text/768/20260808`. **specified by plan** (supersedes the original spec’s automatic legacy identity).

## 3. Encode API

Two protocols already in tree; the owned service must speak both. **specified by plan.**

### 3.1 Ollama-native (Seed / contact)

| Field | Value | Mark |
|---|---|---|
| Request | `POST /api/embeddings` `{ model, prompt }` | measured (callers) |
| Response | `{ embedding: number[768] }` | measured |
| Seed preprocess | `trim`; reject length `< 8` (harness contact); substrate fetch rejects only empty; `slice(0, 1000)`; no prefix | measured |
| Seed deadline | 1500 ms (`embed-at-contact`); 2000 ms (`embed-fetch`) | measured |
| Warm latency (Ollama, idle) | 8/8 under 1500 ms (13–28 ms) | measured |
| Cold load | first Ollama embed 13.5 s on this machine; Host warm-up must not rely on the 1.5 s writer deadline | measured |
| Errors | non-768, timeout, connection refused → `null` (degraded-honest); no throw on writer paths | measured |

### 3.2 OpenAI-compatible (Memory)

| Field | Value | Mark |
|---|---|---|
| Request | `POST /v1/embeddings` `{ model, input: string \| string[] }` | measured |
| Response | `{ data: [{ embedding, index }] }` | measured |
| Memory preprocess | Ollama path: 512-token cap if tokenizer present, else `slice(0, 2000)`; no min-8; no prefix | measured |
| Batch | up to 2048 inputs; missing indexes retried one-by-one | measured |
| Deadline | none in Memory client | measured |
| Same short texts, both protocols | cosine 1.0 (25/25) | measured |
| Long text Seed 1000 vs Memory 2000 | cosine 0.981 — **not** the same recipe for long inputs | measured |

### 3.3 Versioning / validation **proposed**

- Reject unknown `model` / recipe id (strict). Alias equality is not enough. **specified by plan.**
- Return a structured error, not a different-length vector.
- Health/warm-up: actual inference, expected dim, finite values, recipe id. `/api/tags` or PM2 `online` is not readiness. **specified by plan.**
- Bind `127.0.0.1`; Origin/Host checks; no document/conversation logs. **specified by plan.**
- Bounded queue: contact/interactive first; cancel expired work. **specified by plan.**

## 4. Model delivery manifest **proposed**

| Field | Example / rule | Mark |
|---|---|---|
| `recipe_id` | see §2 | proposed |
| `source` | `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5` | measured candidate |
| `files[]` | path, bytes, sha256 | measured (recipe-pin) |
| `precision` | `fp32` (candidate) / `gguf-f16` (legacy) | measured |
| `license` | Apache-2.0 (Ollama show + Nomic) | measured |
| `runtime` | official Node 22 matching platform/arch; Host rejects Homebrew-linked Node | specified by plan; measured nvm v22.19.0 arm64 is system-dylib-only |
| `cache_path` | per-home private dir, Host-selected; not the GUI home directory | specified by plan |
| `download` | bounded, disk-checked, atomic publish after digest verify, resumable, offline pre-seed | specified by plan |
| Disk (candidate fp32 ONNX) | 548,025,400 bytes cached (weights 547,310,275) | measured |
| Disk (legacy Ollama GGUF) | 274,302,450 bytes | measured |
| RAM after ONNX load | ~877–985 MB RSS on this Mac | measured |
| Cold ONNX load | 32.4 s first download/load; ~1.1 s later load from cache | measured |
| Warm ONNX embed | p50 25 ms after first call | measured |

`Xenova/nomic-embed-text-v1.5` returned HTTP 401 in this environment. Prefer official `nomic-ai` artifacts. **measured.**

Quantized ONNX variants exist (`model_fp16.onnx`, `model_int8.onnx`, …) and were **not** measured. **unknown** (Stage 3 performance).

## 5. What Memory must store for provenance **proposed**

On every stored retrieval vector (`node.embedding` and ANN metadata):

| Field | Required | Mark |
|---|---|---|
| `embedding` | native float vector | measured (already stored) |
| `embedding_recipe_id` | verified recipe fingerprint | proposed |
| `embedding_model` | requested alias (not sufficient alone) | measured (ANN already stores model name) |
| `embedding_dim` | 768 | measured |
| `embedding_metric` | `cosine` | proposed |
| `embedded_text` or text hash + preprocess recipe | enough to reproduce the exact bytes sent to encode | proposed (plan: persist embedded text; writers already keep `head` / `concept` / `summary`) |
| `embedded_at` | ISO time | proposed |
| `provenance_status` | `verified` \| `unknown` | proposed |

ANN builder today indexes `node.embedding` and matches `meta.provider` + `meta.model` only. **measured.** That is not a recipe fingerprint. Incompatible entries must be excluded from live comparison. **specified by plan.**

Do not regenerate vectors from `node.concept` as if that were the historical input. **specified by plan.**

## 6. What Seed / contact records must carry **proposed**

| Field | Rule | Mark |
|---|---|---|
| `semantic_vector` | optional projected 16-d; keep parsing without it | specified by plan; measured (four parse sites, no encoder field today) |
| `semantic_encoder` / `semantic_recipe_id` | additive optional; absence = **unknown**, not a Nomic label | specified by plan |
| Replay | keep recorded vectors; do not re-perceive; additive fields must not reject old lines | specified by plan |
| Preparation | Seed genesis does **not** call the embedder | measured (`seed-birth` / `SeedProcess.initialize`) |

## 7. What Host must start / stop / monitor **proposed**

| Duty | Rule | Mark |
|---|---|---|
| Process scope | one embedder process per home, private supervisor, loopback port from the home port plan | specified by plan |
| Old homes | a newer Host must not invent a missing-service failure for homes that never opted in | specified by plan |
| Start/stop | only that home; preserve desired-running; no duplicate Seed runners | specified by plan |
| Preparation order | birth (no embedder) → fetch/verify/warm with **real** inference → then admit contact writers | specified by plan; genesis measured embedder-free |
| Readiness facts | process up, model verified, warm inference OK, resident ready, ingestion done are **separate** | specified by plan |
| Progress | durable handle: downloading / verifying / warming / ready / interrupted / failed | specified by plan |
| Chat provider URL | must not select the embedder | specified by plan |
| Ambient Ollama | today’s Host `ollama-local` profile writes Seed+Memory to ambient Ollama. Owned default must not depend on that. | measured |

## 8. Attention / compatibility constraints

| Gate | Floor | Margin | Min alnum | Space | Mark |
|---|---|---|---|---|---|
| `semantic-match` / context-assembly / trigger-index | 0.60 | none | 20 | native 768 cosine; **truncates to min(len)** today | measured |
| `seed-context` | 0.60 | 0.12 vs pool median | 20 | native 768; not an unchanged consumer of the shared matcher | measured |

On the public corpus, Ollama vs ONNX mean-pool:

- Shared-floor admit disagreed on **1/18** scorable pairs (near-threshold retrieval pair 0.596 vs 0.637).
- Seed-context admit agreed on 3/3 pools.
- Retrieval **top-1 agreed** on 4/4 sets for mean-pool; CLS pooling swapped one set’s top-2.

**proposed:** reject dimension mismatch instead of `min(len)`. Key caches by recipe id (today: exact text only, max 800). Uncalibrated owned recipe: lexical fallback only.

## 9. Seed-preservation implications

| Rule | Mark |
|---|---|
| Do not rewrite source contacts or developmental ledgers to re-perceive history | specified by plan |
| Projected 16-d records stay as perceived; new recipe ≠ same 16-d space (0/25 4 d.p. match) | measured + specified |
| Retaining the old encoder is the default for existing homes | specified by plan |
| A future incompatible Seed transition needs an explicit receipt-linked policy; not authorized by Stage 1 | specified by plan |

## 10. Encoder recommendation to Lead

- **Stage 2 (contracts/guards): GO.** Spaces are not interchangeable; provenance and mismatch rejection are required even if the owned service never becomes the default.
- **Stage 3 (inference service): GO as a new recipe**, not as a silent Ollama replacement. Pin `nomic-ai` artifacts above. Keep both HTTP shapes. Enforce 768 and recipe id.
- **Default flip / new-home owned default: NO-GO** until a recorded calibration exists (`matchFloor` stays null).
- **Existing-home switch: NO-GO** (plan Stage 6).
- Closest measured owned recipe is unprefixed mean-pool ONNX; it still fails the plan’s 0.99 / 4 d.p. compatibility bar. Documented Nomic prefixes are farther from the current baseline.

Private representative turn/anchor pairs were **not** run (no gitignored private corpus). Public corpus only.
