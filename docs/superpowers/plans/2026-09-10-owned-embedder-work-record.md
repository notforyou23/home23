# Owned embedder — work record

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Plan commit verified: `3c7495d6dd5b424a7e17307364b1b5a26586e49a`

Lead published contracts: `docs/superpowers/plans/2026-09-10-owned-embedder-contracts.md`  
Stage 2 authorization: `docs/superpowers/plans/2026-09-10-owned-embedder-stage2-authorization.md`  
Stage 5 evidence note: `docs/superpowers/plans/2026-09-10-owned-embedder-stage5-evidence.md`

## Isolation

| Item | Value |
|---|---|
| Stage 5 worktree | `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify` |
| Stage 5 branch | `home23-agent/owned-embedder-stage5-verify` |
| Created from | Host Stage 4 `95e7f7adf5d5050ee5df9118077f20b8bad62cb0` |
| Memory cherry-pick | `0acc647f` → `a58e5c61` on this branch (clean; Host admission and Encoder serve not reverted) |
| Shared checkout left untouched | `/Users/jtr/_JTR23_/development/home23` on `codex/jerry-continuity-20260907` |
| Apple | not edited (`codex/mac-dashboard2-20260908`) |
| Live homes / `../release/home23` | not used as a development source; not altered |
| Host evidence homes | `owned-embedder-host-stage4-evidence` and `*-evidence-2` preserved |

Preserved concurrent worktrees (not switched, not cleaned), including Encoder/Memory/Host lanes and other `.home23-worktrees/*`.

## Lane status

| Lane | Owner | Status | Commits | Evidence | Next action |
|---|---|---|---|---|---|
| Encoder | Encoder worker | Stage 1 complete. Stage 3 serve exists. | `642b57f6`, `c273245a`, `6d170020` | Stage 1 JSON + Stage 3 `/ready` | Keep owned recipe off product default. Packaged Node/ORT payload still open. |
| Memory | Memory worker | Stage 2 guards + writer stamps landed. | `8f42ae67`, `0acc647f` (here `a58e5c61`) | Contract tests (fixture) + Stage 5 live stamp | Stamp NetworkMemory nodes / ANN metadata if retrieval must carry recipe id. Do not rewrite history. |
| Host | Host worker | Stage 4 admission for **new** `home23.host.v2` homes only. | `95e7f7ad` | Host `*-evidence-2` `/ready` | Do not expand `ownedProcessNames` for v1 homes. Packaged payload / codesign still open. |
| Lead | Stage 5 worker | Isolated TEST home checks 1–4 **pass**. Chat e2e **pass** (owned retrieve + local Ollama `llama3.2:1b`). | this record + Stage 5 evidence note + `chat-e2e-probe.mjs` | `owned-embedder-stage5-evidence-5/chat-e2e.json` | Do not flip defaults. Do not start Stage 6. Packaged Host GUI conversation still not run. |

## Stage 5 TEST home

Path: `home23/.home23-worktrees/owned-embedder-stage5-evidence-5/Home`  
Schema: `home23.host.v2` + `encoderRequired: true`  
Cache: that home's `runtime/embedder-cache` (copy of Encoder Stage 1). Never `~/` as the cache root, never `release/home23`.

| Check | Status | Kind |
|---|---|---|
| Owned encoder `/ready` warm, hash `12e9f736…65efd9`, dim 768 | pass | real |
| Document import + paraphrase retrieval | pass | real (`DocumentFeeder.ingestFile` + `NetworkMemory.query`) |
| New Seed/contact stamp without rewriting history; birth `modelInvocations: 0` | pass | real stamp + real birth |
| Stop/start: identity, history, encoder selection | pass | real |
| Chat e2e answer | pass | real owned retrieve + real `ollama-local` `llama3.2:1b` |

Owned `matchFloor` remains `null`. No calibration receipt exists; none was invented.

## Experiment hypothesis (Encoder) — unchanged

Current Home23 Seed/Memory embeddings are Ollama `nomic-embed-text` with **no task prefix** and **no provider L2-norm**. Drop-in ONNX compatibility is **rejected** (Lead-verified Stage 1: mean cosine 0.900851, min 0.517358, 0/25 projections to 4 d.p.).

## Go / no-go (Lead)

| Stage | Lead ruling | Why |
|---|---|---|
| 2 Encoder-aware contracts | **done** | In source on this tree (`8f42ae67`) |
| 3 Owned inference service | **done as a new recipe** | `scripts/embedder/serve.mjs` @ `6d170020` |
| 4 Host new-home admission | **done, not a default flip** | `95e7f7ad`; v1 homes unchanged |
| Product default flip | **NO-GO** | Failed 0.99 / 4 d.p.; owned `matchFloor` null |
| Stage 5 isolated TEST home | **checks 1–5 pass** | Real encoder, retrieval, stamp, restart, retrieve-then-answer |
| Existing-home switch | **NO-GO** | Plan Stage 6 |
| Product milestone (Stages 1–5) | **semantic checks passed** | Not a packaged Host GUI conversation; not a default flip |

## Unresolved limitations

- No owned calibration receipt; `matchFloor` stays null (no semantic gate).
- No packaged Host payload / codesign / notarization.
- ORT teardown: Host mock stop once left the TEST encoder listening; explicit TERM then worked. Encoder Stage 3 still documents possible abort 134 on dispose.
- Chat e2e used Host’s `ollama-local` path with `llama3.2:1b` pulled for this isolated probe. It did not copy keys from existing homes.
- Memory writer unit tests remain fixture-embed except the Stage 5 live shipper pass. Stage 3 protocol tests were not re-run here.
- `NetworkMemory.addNode` does not persist `embedding_recipe_id`.

## Commits on this branch (integration + Stage 5 docs)

| SHA | Message |
|---|---|
| `95e7f7ad` | Admit the owned embedder only for new Host homes. (Host Stage 4) |
| `a58e5c61` | cherry-pick of `0acc647f` — stamp new writer lines with encoder provenance |
| *(this commit)* | Record Stage 5 isolated TEST verification |

Not pushed.

## Handoff

```text
Worktree: /Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-stage5-verify
Branch:   home23-agent/owned-embedder-stage5-verify
TEST home: home23/.home23-worktrees/owned-embedder-stage5-evidence-5/Home  (stopped; do not delete)
Shared:   home23 remains codex/jerry-continuity-20260907
Apple:    not edited; remains codex/mac-dashboard2-20260908
Next:     If chat e2e is required, resume on this worktree with credentials
          supplied for this work. Do not scrape other homes.
          Do not flip shared defaults. Do not migrate existing homes (Stage 6).
          Do not push.
```
