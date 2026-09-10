# Owned embedder — work record

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Plan commit verified: `3c7495d6dd5b424a7e17307364b1b5a26586e49a` (`git show` in this repo; not assumed on GitHub)

## Isolation

| Item | Value |
|---|---|
| Worktree | `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-encoder-stage1` |
| Branch | `home23-agent/owned-embedder-encoder-stage1` |
| Base | `44288211b1d11512bca2d590fccd7eb77024e7a4` (contains plan `3c7495d6`) |
| Shared checkout left untouched | `/Users/jtr/_JTR23_/development/home23` on `codex/jerry-continuity-20260907` |
| Apple | not edited |
| Live homes / release installation | not altered; not used as development source |

## Lane status

| Lane | Owner | Status | Dependencies | Commits | Evidence | Next action |
|---|---|---|---|---|---|---|
| Encoder | Encoder worker | Stage 1 complete (local). Stages 2+ not started. | Plan `3c7495d6` | see §Commits | `scripts/embedder-experiment/results/` | Lead evaluates; authorize Stage 2+ |
| Memory | unknown (placeholder) | not started here | Encoder contracts; plan Stage 2 | — | — | Implement provenance/guards after lead GO |
| Host | unknown (placeholder) | not started here | Encoder Stages 1–3; plan Stage 4 | — | — | Wait |
| Lead | lead agent | evaluating Stage 1 | this record + contracts | — | — | Authorize or block Stage 2+ |

## Proposed Stage 1 file list (owned)

| Path | Role |
|---|---|
| `docs/superpowers/plans/2026-09-10-owned-embedder-work-record.md` | this record |
| `docs/superpowers/plans/2026-09-10-owned-embedder-contracts.md` | shared contracts |
| `scripts/embedder-experiment/*` | harness, corpus, inventory, results |
| Not owned | `scripts/embedder/serve.mjs`, Memory/Host product files, `home23-apple` |

## Experiment hypothesis

Current Home23 Seed/Memory embeddings are Ollama `nomic-embed-text` with **no task prefix** and **no provider L2-norm**. A Node 22 Transformers.js ONNX build of `nomic-ai/nomic-embed-text-v1.5` matches that space (per-vector cosine > 0.99, gate agreement, 16-d projection equal to 4 d.p.) only if preprocessing matches. Passing a finite public corpus would support compatibility; it would not prove all future inputs.

**Result:** hypothesis **rejected** for drop-in compatibility. Best ONNX recipe mean cosine 0.9009, min 0.517, **0/25** projections equal to 4 d.p.

## Existing attempts and reconciliation

- Design spec `7b1d22d94` and plan `3c7495d6` only. Identical plan also on `codex/scout-linux-reconciliation-20260910`.
- No `scripts/embedder/` service, no prior experiment results.
- Dirty worktrees left untouched: `home23-queued-work` (`node_modules`), `home23-scheduled-outcome-evidence` (`node_modules`), `.home23-worktrees/connected-agents-notification-context` (coordination/push edits).
- Shared jerry-continuity checkout not switched.

## Experiment design vs plan

| Plan Stage 1 ask | What ran |
|---|---|
| Caller inventory | `scripts/embedder-experiment/inventory.json` from source (writers, gates, Memory, ANN, Host config, birth boundary) |
| Pinned candidate recipe | `results/recipe-pin.json` — official `nomic-ai` ONNX fp32 + tokenizer digests |
| Compare baseline vs candidate | Ollama `/api/embeddings` (Seed shape) vs ONNX mean/cls × prefix ablations |
| Native + projected vectors | cosine + published 768→16 projection |
| All attention gates | shared floor 0.60 / min-alnum 20; seed-context floor+margin 0.12 |
| Retrieval behavior | 4 public query/doc sets, rank compare |
| Small nonpersonal corpus | `corpus.json` (27 texts, 20 pairs, 4 retrieval sets, 3 seed-context pools) |
| Private turn/anchor pairs | not run (no private corpus file; personal text kept out of Git) |
| Packaged-runtime constraints | official-style Node **v22.19.0** darwin **arm64** (system dylibs only; Host packager would accept this class of binary). Not Homebrew Node 25. |
| Latency / footprint | cold/warm load, RSS, disk, 1500 ms Seed deadline probe |
| No default or live-state changes | honored |

Original spec’s ~200 live ledger pairs were **not** used (plan: keep personal text out of public fixtures).

## Commands run

```text
node home23/scripts/development/status.mjs --installation ../release/home23
# read-only; backend 44288211 on jerry-continuity; 15 worktrees

git show 3c7495d6 --stat
git worktree add .home23-worktrees/owned-embedder-encoder-stage1 \
  -b home23-agent/owned-embedder-encoder-stage1 44288211b1

# worktree:
/Users/jtr/.nvm/versions/node/v22.19.0/bin/node -v   # v22.19.0
otool -L …/v22.19.0/bin/node                         # system dylibs only
ollama show nomic-embed-text --modelfile             # TEMPLATE {{ .Prompt }}
cd scripts/embedder-experiment
/Users/jtr/.nvm/versions/node/v22.19.0/bin/npm install --omit=dev
/Users/jtr/.nvm/versions/node/v22.19.0/bin/node run.mjs
# first ONNX attempt: Xenova/nomic-embed-text-v1.5 → HTTP 401
# rerun after fallback to nomic-ai/nomic-embed-text-v1.5 (public ONNX)
# rerun with CLS pooling ablation
shasum -a 256 .cache/nomic-ai/nomic-embed-text-v1.5/onnx/model.onnx
```

## Numeric results (real inference)

Fixture/synthetic vectors: **none**. Both backends produced real embeddings.

### Baseline (Ollama)

| Item | Value |
|---|---|
| Model | `nomic-embed-text:latest` |
| Digest | `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f` |
| Size | 274,302,450 bytes; GGUF F16; nomic-bert 137M |
| Dim | 768 |
| Warmup L2 | 21.81 (not unit) |
| First-process warmup | 13.5 s (earlier probe) / 393 ms once already loaded |
| Seed deadline 1500 ms (idle, n=8) | **8/8 pass**, 13–28 ms |
| Seed vs Memory protocol (short texts) | cosine **1.0** (25/25), projection 25/25 equal |
| Seed 1000 vs Memory 2000 chars | cosine **0.981** |
| Prefix `search_document:` vs none | mean cosine 0.900; 2 shared-gate flips |

### Candidate (ONNX, Node 22)

| Item | Value |
|---|---|
| Model | `nomic-ai/nomic-embed-text-v1.5` |
| Runtime | `@huggingface/transformers@3.7.6` |
| `onnx/model.onnx` | 547,310,275 bytes; sha256 `147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965` |
| Cache total | 548,025,400 bytes |
| Cold load (first) | 32,359 ms; RSS 97.9 → 985.4 MB |
| Later load | 1,134 ms; RSS ~877 MB |
| Warm embed p50 (after first) | ~25 ms |

### Compatibility vs Ollama Seed

| Recipe | mean cos | min | <0.99 | <0.95 | proj 4 d.p. | shared-gate disagree |
|---|---|---|---|---|---|---|
| onnx mean, no prefix | 0.9009 | 0.517 | 25/25 | 15/25 | 0/25 | 1 (near-floor retrieval) |
| onnx mean, L2 | 0.9009 | 0.517 | 25/25 | 15/25 | 0/25 | 1 |
| onnx mean + `search_document` | 0.848 | 0.531 | 25/25 | 25/25 | 0/25 | 1 |
| onnx mean + `search_query` | 0.873 | 0.575 | 25/25 | 24/25 | 0/25 | 2 (incl. unrelated over floor) |
| onnx CLS, no prefix | 0.773 | 0.432 | 25/25 | 25/25 | 0/25 | 1 |

Retrieval top-1 agreed 4/4 for mean-pool. Seed-context admit agreed 3/3 pools. CLS swapped one retrieval top.

Ollama paraphrase scores on this corpus: 0.67–0.90. Unrelated: 0.40–0.53. The 0.60 floor sits in a live band; near-threshold pairs flip when the recipe moves.

Contended Ollama timings while ONNX occupied ~1 GB RSS reached p85 ~3 s and max ~6.9 s — above the Seed 1.5 s deadline. Isolated warm Ollama stayed far under.

## Fixture vs real-provider

| Path | Real? |
|---|---|
| Ollama baseline | **real** local `nomic-embed-text` |
| ONNX candidate | **real** Transformers.js inference |
| Public corpus | synthetic nonpersonal text (not a live ledger) |
| Private calibration | **not run** |
| Product defaults / homes | unchanged |

## Limitations

- Public corpus is small (not 200 live pairs).
- One Mac arm64; no other release targets.
- Only fp32 ONNX measured (not fp16/int8/q4).
- Xenova mirrors 401 here; official `nomic-ai` used.
- Ollama vs ONNX mismatch root cause (tokenizer, GGUF graph, undocumented Ollama pooling) is **unknown**.
- Node used is nvm v22.19.0, not a copied Host payload binary. It meets the Host packager’s Node 22 + system-dylib rule.

## Go / no-go for Stage 2+

| Stage | Recommendation | Why |
|---|---|---|
| 2 Encoder-aware contracts | **GO** | Spaces are not interchangeable; provenance and mismatch rejection are required even if defaults stay |
| 3 Owned inference service | **GO as a new recipe** | Real Node 22 ONNX works; do not advertise Ollama parity |
| Default flip / new-home owned default | **NO-GO** | Failed 0.99 / 4 d.p. bar; `matchFloor` must stay null until calibration |
| Existing-home switch | **NO-GO** | Plan Stage 6; Seed history must not be rewritten |
| Encoder Stages 3 implementation in this session | **not done** | Lead must authorize |

## Commits

Filled after local commit.

## Handoff

```text
Worktree: /Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-encoder-stage1
Branch:   home23-agent/owned-embedder-encoder-stage1
Next:     lead review of contracts + evidence. Do not implement scripts/embedder/serve.mjs until authorized.
Re-run:   /Users/jtr/.nvm/versions/node/v22.19.0/bin/node scripts/embedder-experiment/run.mjs
```
