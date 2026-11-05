# Owned embedder — published shared contracts

Date: 2026-09-10  
From: Lead (evaluation / integration)  
Plan: `2026-09-10-owned-embedder-host-integration.md` @ `3c7495d6dd5b424a7e17307364b1b5a26586e49a`  
Encoder evidence (committed): `scripts/embedder-experiment/results/stage1-summary.json`, `stage1-evidence.json`, `recipe-pin.json` @ `642b57f640899586edaf479f940d01b875beb337`  
Investigations cherry-picked: Memory `6bbaa03b`, Host `b3f88e80`  
Field marks: **measured** / **specified by plan** / **proposed** / **unknown** / **lead-specified**

This file supersedes Encoder’s Stage 1 proposal as the shared contract.  
The plan wins over the original embedder spec, then measured evidence, then investigations.  
These contracts do **not** change product defaults, live homes, or Seed history.

## 0. Lead decisions

| Decision | Ruling | Why |
|---|---|---|
| Stage 2 (Memory guards/contracts) | **GO** | Spaces are not interchangeable (mean cosine 0.900851, min 0.517358, **0/25** projections equal to 4 d.p.). Plan Stage 2 may proceed without selecting a new default. Provenance, null-cal, and dimension/recipe reject are required even if owned never becomes a default. |
| Stage 3 (inference service) | **GO as a new distinct recipe only**, after Stage 2 contracts land in source | Real Node 22 ONNX inference works. It is **not** Ollama drop-in. Do not build `scripts/embedder/serve.mjs` until Stage 2 first-slice contracts exist in source. Contract-test seams may start now (see authorization brief). |
| Product default flip to owned embedder | **NO-GO** | Failed the plan/spec 0.99 / 4 d.p. compatibility bar. Owned `matchFloor` stays `null`. Plan Stage 1 said evidence determines the candidate rather than a speculative default change. Do not flip existing homes (Stage 6). |
| Stage 5 path | Isolated TEST home with **explicit owned recipe**, not a product-wide default flip | Plan Stage 5 is an isolated new home with no ambient Ollama. “Owned default” in that table is the eventual packaged-Host encoder for that proof, not authorization to change shared defaults now. Full “working attention” still needs an owned-recipe calibration receipt. |
| Existing-home switch | **NO-GO** | Plan Stage 6; out of this product assignment. |

## 1. Vector space

| Field | Value | Mark |
|---|---|---|
| Native dimension | 768 | specified by plan; measured on Ollama and ONNX |
| Projected Seed dimension | 16 | specified by plan (published; do not change) |
| Projection seed | `20260808` | specified by plan |
| Projection math | L2-normalize native vector, multiply published matrix, clamp `[-1,1]`, quantize 4 d.p. | specified by plan; copied in experiment `projection.mjs` |
| Native metric | cosine (attention and ANN / hnswlib `cosine`) | specified by plan; measured |
| Provider L2 normalization | Ollama baseline is **not** unit-length (L2 mean 20.424549, range 16.762869–23.541110). Cosine and the published projection re-normalize. ONNX mean-pool noprefix L2 mean 24.508787. | measured |
| Task prefix | Current Home23 writers send **no** Nomic prefix. Ollama template is `{{ .Prompt }}` (Encoder work-record command; not re-run by Lead). Adding `search_document:` on Ollama vs unprefixed baseline: mean cosine 0.90039, max 0.94784, **0/25** projections equal. | measured |
| Compatible drop-in | Official ONNX `nomic-ai/nomic-embed-text-v1.5` fp32 mean-pool, with or without prefixes, is **not** the Ollama space. Best candidate (`onnx-fp32-noprefix`) mean 0.900851; min 0.517358; **0/25** projections equal; 25/25 below 0.99; 15/25 below 0.95. CLS pooling mean 0.773335. | measured |
| Alias / equal dim | A requested model alias or equal dimension does **not** establish compatibility. | specified by plan |

Lead-independent hash of cached artifacts matched `recipe-pin.json` (onnx/tokenizer/config).

## 2. Encoder identity / recipe

Recipe identity fingerprints the **actual computation**, not the alias. **specified by plan.**

Fingerprint **must** include: model/tokenizer artifact digests, precision, prefix policy, truncation policy, pooling, normalization, expected dimension, projection seed, projection dimension. **specified by plan** (Memory inventory).

**proposed** hash (Encoder; Lead accepts as the implementation shape, not yet computed in-repo):

```
recipe_id = sha256(canonical_json({
  family, source, artifact_digests, precision,
  pooling, prefix_policy, truncation, expected_dim,
  projection_seed, projection_dim
}))
```

Two **lead-specified** human profile ids. They stay distinct. Equal dimension does not merge them.

| Profile | Computation | When |
|---|---|---|
| `legacy-ollama-nomic-unprefixed` | Ollama `nomic-embed-text` GGUF F16, digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`, no prefix, Seed `slice(0,1000)` / Memory tokenizer-512-or-`slice(0,2000)` | existing homes / current writers |
| `owned-nomic-v1.5-onnx-fp32-mean-noprefix` | HF `nomic-ai/nomic-embed-text-v1.5` `onnx/model.onnx` sha256 `147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965`, Transformers.js 3.7.6, fp32, mean pool, no prefix, Node 22 | candidate owned service; **new recipe**, not a relabel of legacy |

Seed 1000 vs Memory 2000 on the same Ollama model is cosine **0.981068** on the experiment’s long text. Those truncation rules are part of the fingerprint. Stage 2 must not silently unify them (that would change existing homes). Long inputs are not the same recipe facet.

Calibration is a separately versioned attention policy attached to a recipe. **specified by plan.**

| Recipe | `matchFloor` | `matchMargin` | `minMatchableAlnum` | Mark |
|---|---|---|---|---|
| `legacy-ollama-nomic-unprefixed` | `0.60` | `0.12` (seed-context; shared matcher is floor-only today) | `20` | measured current policy; **keep for homes whose active recipe is legacy**. This is lived behavior, not a calibration borrowed onto owned. |
| `owned-nomic-v1.5-onnx-fp32-mean-noprefix` | `null` | `null` | `20` (length skip still applies) | lead-specified until a recorded owned-recipe calibration receipt exists |

`null` floor or margin ⇒ **no semantic gate** in any consumer. Use lexical / no-match / seed-context silence as that consumer already does. **specified by plan.** Do not borrow `0.60` / `0.12` for owned.

Do **not** treat missing historical stamps as `nomic-embed-text/768/20260808`. **specified by plan** (supersedes the original spec’s automatic legacy identity). Missing stamps also do **not** by themselves change a resident’s established live attention. **specified by plan.**

## 3. Encode API

The owned service must speak **both** existing protocols. **specified by plan.**

### 3.1 Ollama-native (Seed / contact)

| Field | Value | Mark |
|---|---|---|
| Request | `POST /api/embeddings` `{ model, prompt }` | measured (callers) |
| Response | `{ embedding: number[768] }` | measured |
| Seed preprocess | `trim`; harness contact rejects length `< 8`; substrate fetch rejects only empty; `slice(0, 1000)`; no prefix | measured |
| Seed deadline | 1500 ms (`embed-at-contact`); 2000 ms (`embed-fetch`) | measured |
| Warm idle Seed deadline | 8/8 under 1500 ms; committed-run times **17.985–41.493 ms** (p50 of those 8 ≈ 25.96 ms) | measured |
| Cold Ollama | Committed run warmup **352.523 ms** (model already resident). Encoder work-record “first-process 13.5 s” is **not** in committed JSON. | measured / unknown (first-process) |
| Errors on writer paths | non-768, timeout, connection refused → typed absence / `null`; no fabricated vector | measured today as `null`; typed codes proposed below |

### 3.2 OpenAI-compatible (Memory)

| Field | Value | Mark |
|---|---|---|
| Request | `POST /v1/embeddings` `{ model, input: string \| string[] }` | measured |
| Response | `{ data: [{ embedding, index }] }` | measured |
| Memory preprocess | Ollama path: 512-token cap if tokenizer present, else `slice(0, 2000)`; no min-8; no prefix | measured |
| Batch | up to 2048 inputs; missing indexes retried one-by-one | measured |
| Deadline | none in Memory client today | measured |
| Same short texts, both Ollama protocols | cosine 1.0 (25/25), projections 25/25 equal | measured |
| Long text Seed 1000 vs Memory 2000 | cosine 0.981068 | measured |

### 3.3 Validation and scheduling

- Reject unknown `model` / recipe id (strict). Alias equality is not enough. **specified by plan.**
- Return a structured error or typed absence, never a different-length vector. **specified by plan.**
- Health/warm-up: actual inference, expected dim, finite values, recipe id. `/api/tags` or PM2 `online` is not readiness. **specified by plan.**
- Bind `127.0.0.1`; Origin/Host checks; no document/conversation logs. **specified by plan.**
- Bounded queue: contact/interactive first; cancel expired work. **specified by plan.**
- Chat provider URL is independent of the encoder endpoint. **specified by plan.**

## 4. Model delivery manifest

| Field | Rule | Mark |
|---|---|---|
| `recipe_id` | §2 fingerprint | proposed |
| Human profile | `owned-nomic-v1.5-onnx-fp32-mean-noprefix` | lead-specified |
| `source` | `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5` | measured candidate |
| `files[]` | path, bytes, sha256 (Lead rehashed; match pin) | measured |
| `precision` | `fp32` (candidate) / `gguf-f16` (legacy) | measured |
| `license` | Apache-2.0 | measured (Encoder; Lead did not re-read license files) |
| `runtime` | official Node 22 matching platform/arch; Host rejects Homebrew-linked Node | specified by plan; experiment used nvm v22.19.0 darwin arm64 |
| `cache_path` | per-home private dir, **Host-selected explicit env**; not the GUI home directory; not `~/.home23` (original spec, superseded); not ambient `~/` | specified by plan |
| Cache env **name** | Host chooses at Stage 4; must be explicit | unknown |
| `download` | bounded, disk-checked, atomic publish after digest verify, resumable, cancellable, offline pre-seed | specified by plan |
| Disk (candidate fp32 ONNX) | 548,025,400 bytes cached (weights 547,310,275) | measured |
| Disk (legacy Ollama GGUF) | 274,302,450 bytes | measured |
| RAM after ONNX load (this committed run) | RSS 94 → 877.5 MB | measured |
| ONNX load (this committed run) | 1134.496 ms from local cache | measured |
| First download/load 32.4 s / RSS 985.4 MB | Encoder work-record only; **not** in committed JSON | unknown |
| Warm ONNX embed | p50 25.726 ms (`onnx-fp32-noprefix` after first calls) | measured |
| Xenova mirror | Encoder work-record: `Xenova/nomic-embed-text-v1.5` HTTP 401 on an earlier attempt. Committed evidence `onnx.attempts` is `[]` (nomic-ai tried first and succeeded). Prefer official `nomic-ai` artifacts. | unknown (401) / lead-specified (prefer nomic-ai) |

Quantized ONNX variants (`model_fp16.onnx`, `model_int8.onnx`, …) were **not** measured. **unknown.**

Process argv, supervised binary vs `node scripts/embedder/serve.mjs`, and codesign/JIT needs are **unknown** until Stage 3 measures packaged Node 22 load. Host must not guess a payload layout.

## 5. Memory provenance (additive, new lines only)

### Seed / contact records

| Field | Rule | Mark |
|---|---|---|
| `semantic_vector` | optional projected 16-d; keep parsing without it | specified by plan; measured (four parse sites, no encoder field today) |
| `semantic_recipe_id` | optional fingerprint; absence = **unknown** | lead-specified name; specified by plan (additive) |
| `semantic_encoder` | optional human profile id (`legacy-…` / `owned-…`) | proposed (original spec name, not authority) |
| Absent-vector reason | optional typed code on **new** lines only | proposed (Memory) |
| Replay | keep recorded vectors; do not re-perceive; additive fields must not reject old lines | specified by plan |
| Unstamped history | parse; do not auto-label as Nomic | specified by plan |
| Preparation | Seed genesis does **not** call the embedder (`modelInvocations: 0`) | measured |
| Line-hashed ids | house / non-canonical conversation / fallback relationship / worker-runs hash the source line | measured (Memory) |
| Committed contact | conversation shipper never re-embeds an existing contact | measured |

Stage 2 first slice is **parse-through only**. Writers do not stamp until a later Memory slice.

### Brain / ANN (new nodes and new index metadata)

| Field | Required on new writes | Mark |
|---|---|---|
| `embedding` | native float vector | measured (already stored) |
| recipe id | verified fingerprint / human profile | proposed / lead-specified |
| `embedding_model` | requested alias (not sufficient alone) | measured (ANN stores model name) |
| dimension | 768 until a separate design change | specified by plan |
| metric | `cosine` | proposed |
| generation / revision | keep existing ANN fields | measured |

ANN builder today indexes `node.embedding` and matches `meta.provider` + `meta.model` only. **measured.** That is not a recipe fingerprint.

**Lead reuse rule (Stage 2 first slice):**

- If the query recipe is **owned** (or any recipe id that the index does not carry): **do not reuse**; do not silently mix. Do not build a replacement generation in this slice.
- If the home is **legacy** and the index has no recipe id: keep today’s provider+model reuse. Do not force rebuild. Missing recipe id ≠ compatible with owned.
- Do not regenerate vectors from `node.concept`. **specified by plan.**
- Query recipe, stored vectors, ANN, and caches switch together when a home actually switches. **specified by plan.** No mixed live encoder fleet.

## 6. Host process, port, health, preparation

Host remains **investigation-only for product implementation** until Stage 4 (depends on Stages 1–3). These fields are **frozen** so Stage 3/4 do not fork.

| Duty | Rule | Mark |
|---|---|---|
| Process name | house-level `home23-embedder` (same class as `home23-coordination`). Not a resident-scoped duplicate. | lead-specified (Host + original spec proposal) |
| Admission | requirement version / `encoderRequired` so old homes are **not** expected to run it | specified by plan; Host proposed flag name |
| `ownedProcessNames()` / `PORT_KEYS` | do **not** expand unversioned (would degrade existing Host homes) | specified by plan; measured current lists |
| Port | new key `embedder` on a **versioned** port plan (`home23.host.v2` or nested `ports.version`). Loopback only, 20000–60999 like current keys. | lead-specified key; specified by plan (versioned) |
| Not Host port | original spec `11435` | specified by plan (operator source default may exist later; it is not the Host port) |
| Bind / Origin / Host | `127.0.0.1`; reject bad Origin; Host allowlist | specified by plan |
| Start/stop/reconcile | only that home; preserve `desiredRunning`; no duplicate Seed runners; reconcile surviving worker before another starts | specified by plan |
| Argv / interpreter | under `app/` with bundled Node **or** payload-owned binary Host can ownership-check | proposed (Host); exact argv **unknown** |
| Memory cap / autorestart | Encoder proposes at Stage 3; Host applies | unknown |
| Cache | Host-named explicit path; offline pre-seed supported | specified by plan |
| Logs | no user document or conversation text | specified by plan |
| Chat provider URL | must not select the encoder | specified by plan |
| Users | must not operate PM2 or manually install embedding deps | specified by plan |
| Birth | shared `createHome` / `prepareSeedBirth` remains the birth path. No model download, no encoder start, no contact writers inside birth. Host does not backfill Seed. | specified by plan; genesis measured embedder-free |
| Create/start lock | 180s `.host.lock` cannot own model download. Durable semantic-prep handle required. | specified by plan; measured lock |
| Native timeouts | create 300s / start 180s stay short | measured (Host) |
| Ambient Ollama | today’s Host `ollama-local` profile writes Seed+Memory to the same chat `baseUrl`. Owned path must not depend on that. | measured |

### Health (frozen fields; HTTP path unknown)

Health proves **warm inference**, not process-up. Required fields:

| Field | Rule | Mark |
|---|---|---|
| `recipeId` | loaded fingerprint / human profile | specified by plan |
| `dimension` | 768 until a separate design change | specified by plan |
| artifact digests | match pin; refuse mismatch | specified by plan |
| `warm` | actual inference produced finite expected-dim output | specified by plan |
| `protocols` | which of the two HTTP shapes are live | proposed (Host) |
| `pid` / start generation | reconcile workers | proposed (Host) |
| `lastError` | no document/conversation text | specified by plan |
| HTTP path | Encoder chooses at Stage 3 | unknown |

`/api/tags` may remain for source compatibility; it is **not** Host ready. **specified by plan.**

### Semantic preparation (Host-owned operation)

Durable handle, persisted under the home (not the GUI home). States: `downloading`, `verifying`, `warming`, `ready`, `interrupted`, `failed`. **specified by plan.**

Order: install/reserve port → birth (no embedder) → fetch/verify/warm with **real** inference → then admit contact writers. **specified by plan.** Encoder inventory: birth emits no contact. **measured.**

Fresh setup pauses before live contact while mandatory semantic preparation is unavailable; Retry / Resume / Stop with the saved home intact. Structured Encoder errors must map to those actions. **specified by plan.** Exact error-code enum beyond Memory’s typed absences is **unknown** until Stage 3.

Later outage on a running home: vector-absent + lexical fallback; capability reported degraded; restore must **not** backfill history. **specified by plan.**

Writer-admission after warm-up. **specified by plan.**

## 7. Attention / compatibility constraints

| Gate | Floor | Margin | Min alnum | Space | Mark |
|---|---|---|---|---|---|
| `semantic-match` / context-assembly / trigger-index | 0.60 | none today | 20 | native 768 cosine; **truncates to `min(length)` today** | measured (`semantic-match.ts`) |
| `seed-context` | 0.60 | 0.12 vs pool median | 20 | native 768; not an unchanged consumer of the shared matcher | measured |

Stage 2 **must** reject unequal lengths instead of `min(len)`. **specified by plan.**

Caches must be keyed by recipe id (today: exact text only, max 800). **specified by plan.**

Shared attention helper for **all four** consumers: floor, min-alnum, and null-cal. **Relative margin is pool-only** (`seed-context` vs the turn median). Pair consumers (`semantic-match` / context-assembly / trigger-index) stay floor-only because they have no pool; do not invent a pair margin. For the **legacy** active recipe, keep 0.60 / 0.12 / 20 so existing homes do not go mute or dump. For **owned** / uncalibrated: no semantic gate.

On the public corpus, Ollama Seed vs ONNX mean-pool noprefix:

- Shared-floor admit: **1 disagree / 18 compared pairs** (16 non-skipped + 2 skipped-short that still emit a gate). Flip: `p-embed-retr` baseline 0.595905 (deny) vs candidate 0.637494 (admit). Encoder’s “1/18 scorable” wording counted compared pairs, not the 16 non-skipped.
- Seed-context admit agreed **3/3** pools (`sc-library`, `sc-recycle` admit; `sc-short` skip).
- Retrieval **top-1 agreed 4/4** for every mean-pool recipe (`r-recycle`, `r-embed`, `r-orange`, `r-library`). CLS pooling swapped `r-library` top (`library_hours` → `library_closed_sundays`).
- Spaces still not interchangeable (projections 0/25; min cosine 0.517).

Ollama baseline paraphrase scores: 0.674191–0.899403. Unrelated: 0.438847–0.528701. The 0.60 floor sits in a live band.

Private representative turn/anchor pairs were **not** run (`privateCalibration.ran: false`, `reason: no-private-corpus`). **measured.**

## 8. Seed-preservation implications

| Rule | Mark |
|---|---|
| Do not rewrite source contacts or developmental ledgers to re-perceive history | specified by plan |
| Projected 16-d records stay as perceived; new recipe ≠ same 16-d space (0/25 4 d.p. match) | measured + specified |
| Retaining the old encoder is the default for existing homes | specified by plan |
| Line-hashed event ids / cursors stay stable if old JSONL bytes stay untouched | measured |
| A future incompatible Seed transition needs an explicit receipt-linked policy; not authorized | specified by plan |
| Host does not backfill Seed | specified by plan |

## 9. Typed absence (never fabricate a vector)

Memory-proposed codes, **lead-specified** for Stage 2/3:

`too_short` · `timeout` · `unavailable` · `dimension_mismatch` · `bad_artifact` · `cancelled` · `recipe_mismatch`

Writers already degrade to no vector. Stage 2 parse-through must not invent ids or vectors. Host maps Encoder structured errors onto Retry / Resume / Stop without rendering arbitrary stderr.

## 10. Fixture vs real-provider (for later Stage 5)

| Path | Real? | Mark |
|---|---|---|
| Ollama baseline in Stage 1 | real local `nomic-embed-text` | measured (`fixture: false`, `realInference.ollama: true`) |
| ONNX candidate in Stage 1 | real Transformers.js `nomic-ai/nomic-embed-text-v1.5` | measured |
| Public corpus | synthetic nonpersonal text | measured |
| Private calibration | not run | measured |
| Product defaults / homes | unchanged | measured |
| Host `verify-install.mjs` today | **fixture** embeddings | measured (Host) |
| Stage 5 semantic claim | **real** owned inference; **real** configured chat provider for the answer claim; nonpersonal document | specified by plan |
| Ordinary CI | protocol/policy fixtures OK; do not substitute synthetic vectors for the Stage 5 milestone | specified by plan |

## 11. Reconciliations (plan > evidence > investigations)

| Conflict | Winner | Record |
|---|---|---|
| Original spec: missing stamp ⇒ known Nomic id | **Plan** | Unknown stays unknown. |
| Original spec: Host port 11435; cache `~/.home23/models` | **Plan** | Versioned Host port key `embedder`; Host-selected cache. |
| Original spec: `/api/tags` + PM2 ready; default flip after parity pass | **Plan** + **evidence** | Warm inference is ready. Parity failed; default flip NO-GO. |
| Original spec: seed-context unchanged consumer | **Plan** | Complete policy includes margin + short-turn; all four consumers share it. |
| Plan Stage 5 “owned default” vs Encoder “new-home default NO-GO” | **Plan’s isolated-new-home proof** + **evidence against drop-in** | Stage 5 path is an isolated TEST home with **explicit** owned recipe. Product-wide default flip remains NO-GO until owned calibration. |
| Encoder “GO Stage 3 now” vs Lead sequencing | **Plan delivery sequence** | Stage 3 service after Stage 2 contracts in source. Seams-only until then. |
| Encoder deadline “13–28 ms” | **Committed evidence** | Idle 1500 ms probe is 17.985–41.493 ms. |
| Encoder first-run 13.5 s / 32.4 s / 985 MB / Xenova 401 | **Committed JSON wins for “measured”** | Those first-run figures are work-record prose only. Treat as unknown until re-measured in Stage 3. |
| Encoder “1/18 scorable” | **Evidence pairGates** | 1 disagree / 18 compared (16 non-skipped). |
| Encoder process scope vs Host admission/versioning | **Plan** + Host investigation | One process per home, `home23-embedder`, versioned port/process admission. |
| Memory “recipe id required for ANN reuse” vs “no rebuild in first slice” | **Lead** | Required for owned/mismatched recipe; legacy indexes without recipe id keep provider+model reuse. |
| Spec GET `/api/tags` mimic as Host ready | **Plan** | Tags are not semantic ready. |
| Host open Q: Memory Lite vs pause | **Plan** | Fresh setup **pauses** before live contact while mandatory prep is unavailable. Later running-home outage stays vector-absent + fallback. |

## 12. Encoder recommendation disposition

Encoder Stage 1 recommendations are accepted with the sequencing and default-flip corrections above. Closest measured owned recipe remains unprefixed mean-pool ONNX. Documented Nomic prefixes and CLS pooling are farther from the current baseline. Private ledger pairs remain unrun.
