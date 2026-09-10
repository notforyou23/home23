# Owned embedder — work record

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Plan commit verified: `3c7495d6dd5b424a7e17307364b1b5a26586e49a`

Lead published contracts: `docs/superpowers/plans/2026-09-10-owned-embedder-contracts.md`  
Stage 2 authorization: `docs/superpowers/plans/2026-09-10-owned-embedder-stage2-authorization.md`

## Isolation

| Item | Value |
|---|---|
| Lead worktree | `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-lead-contracts` |
| Lead branch | `home23-agent/owned-embedder-lead-contracts` |
| Created from | Encoder tip `c273245ae1b2e8ffe554e19746c693caa58b58c8` |
| Shared checkout left untouched | `/Users/jtr/_JTR23_/development/home23` on `codex/jerry-continuity-20260907` @ `44288211b1d11512bca2d590fccd7eb77024e7a4` |
| Apple | not edited (`codex/mac-dashboard2-20260908` @ `215241f`) |
| Live homes / `../release/home23` | not used as a development source; not altered |

Preserved concurrent work (not switched, not cleaned): Encoder Stage 1, Memory investigation, Host investigation, `home23-agent/fix-memory-keyword-cpu-runaway`, dirty `home23-queued-work`, `home23-scheduled-outcome-evidence`, `.home23-worktrees/connected-agents-notification-context`, Host product lineages, Apple `codex/mac-dashboard2-20260908`.

## Lane status

| Lane | Owner | Status | Dependencies | Commits | Evidence | Next action |
|---|---|---|---|---|---|---|
| Encoder | Encoder worker | Stage 1 complete (local). Stage 3 service **not** started. | Plan `3c7495d6`; Lead contracts | `642b57f6`, `c273245a` | `scripts/embedder-experiment/results/` (real Ollama + real ONNX) | Contract-test seams only until Memory Stage 2 first slice lands in source. Then Stage 3 as **new recipe** `owned-nomic-v1.5-onnx-fp32-mean-noprefix`. Do not write `scripts/embedder/serve.mjs` before that. Do not flip defaults. |
| Memory | Memory worker | Investigation complete. Stage 2 **authorized** (first slice). | Lead contracts; Encoder evidence | `6bbaa03b` (investigation; cherry-picked here as `19a4271d`) | Investigation doc + Lead verification of `min(length)` and birth `modelInvocations: 0` | Isolated Memory worktree; implement first slice in the authorization brief. Do not replace `home23-agent/fix-memory-keyword-cpu-runaway`. |
| Host | Host worker | Investigation complete. Implementation **blocked** (Stage 4). | Frozen process/health/port/recipe fields in Lead contracts; Stages 2–3 | `b3f88e80` (investigation; cherry-picked here as `8c9f9fe6`) | Host investigation (ports, `ownedProcessNames`, lock, verify-install fixture) | Remain investigation-only for product files. May read frozen contracts. Stage 4 only after Stage 3 service exists. Isolated TEST home only; never existing homes. |
| Lead | Lead worker | Stage 1 evaluated. Contracts published. Stage 2 authorized. | Encoder artifacts + Memory/Host investigations + plan | this record + contracts + authorization (this worktree) | Independent read of committed JSON; artifact sha256 rehash | Return authorization brief. Do not claim the product milestone complete. |

## Files owned in this Lead worktree

| Path | Role |
|---|---|
| `docs/superpowers/plans/2026-09-10-owned-embedder-work-record.md` | this record |
| `docs/superpowers/plans/2026-09-10-owned-embedder-contracts.md` | published shared contracts |
| `docs/superpowers/plans/2026-09-10-owned-embedder-stage2-authorization.md` | Stage 2 file list and sequencing |
| Cherry-picked, not rewritten | Memory + Host investigation docs |
| Inherited from Encoder, not edited | `scripts/embedder-experiment/*` |
| Not owned | `scripts/embedder/serve.mjs`, Memory/Host/Encoder product files, `home23-apple` |

## Experiment hypothesis (Encoder) and Lead verification

Current Home23 Seed/Memory embeddings are Ollama `nomic-embed-text` with **no task prefix** and **no provider L2-norm**. A Node 22 Transformers.js ONNX build of `nomic-ai/nomic-embed-text-v1.5` matches that space (per-vector cosine > 0.99, gate agreement, 16-d projection equal to 4 d.p.) only if preprocessing matches.

**Result (Lead-verified from committed JSON):** hypothesis **rejected** for drop-in compatibility. Best ONNX recipe mean cosine **0.900851**, min **0.517358**, **0/25** projections equal to 4 d.p.

See contracts §11 for claim-by-claim confirm / correct / unverified.

## Existing attempts and reconciliation

- Design spec `7b1d22d94` superseded by plan `3c7495d6` where they conflict.
- Encoder Stage 1 worktree left on `home23-agent/owned-embedder-encoder-stage1` @ `c273245a`. Not replaced.
- Memory investigation left on `home23-agent/owned-embedder-memory-investigation-20260910` @ `6bbaa03b`. Cherry-picked docs-only.
- Host investigation left on `home23-agent/owned-embedder-host-investigation` @ `b3f88e80`. Cherry-picked docs-only.
- No `scripts/embedder/` service.
- Shared jerry-continuity checkout not switched.

## Lead commands run (read-only + docs worktree)

```text
node home23/scripts/development/status.mjs --installation ../release/home23
# backend 44288211 on jerry-continuity; apple 215241f; 18 backend worktrees

git worktree list
git worktree add .home23-worktrees/owned-embedder-lead-contracts \
  -b home23-agent/owned-embedder-lead-contracts c273245ae1

# in lead worktree:
git cherry-pick 6bbaa03b1e9e827341ce795b5159cabe4aa0f853
git cherry-pick b3f88e80a912eebaba25b19fb16c7945e92e615a

# independent verification (Encoder worktree artifacts):
# parsed stage1-evidence.json / stage1-summary.json / recipe-pin.json
# sha256 of cached nomic-ai onnx + tokenizer + configs (matched pin)
# read semantic-match.ts min(length); seed-context floors; seed-birth modelInvocations: 0
# read PORT_KEYS and ownedProcessNames()
```

No fetch, push, merge, build, restart, install, or live-home change.

## Go / no-go (Lead)

| Stage | Lead ruling | Why |
|---|---|---|
| 2 Encoder-aware contracts | **GO** | Incompatible spaces; provenance and mismatch rejection required; plan allows this without a new default |
| 3 Owned inference service | **GO as a new recipe**, after Stage 2 first slice is in source | Real ONNX works; not Ollama parity |
| Product default flip | **NO-GO** | Failed 0.99 / 4 d.p.; owned `matchFloor` null |
| Stage 5 isolated TEST home path | **defined, not authorized to execute now** | Explicit owned recipe on a new Host home; real inference + real chat; attention-gate claim waits for owned calibration |
| Existing-home switch | **NO-GO** | Plan Stage 6 |
| Product milestone (Stages 1–5) | **not complete** | Only Stage 1 evidence + contracts exist |

## Commits on this branch

| SHA | Message |
|---|---|
| `642b57f640899586edaf479f940d01b875beb337` | Record Stage 1 owned-embedder compatibility evidence. (Encoder) |
| `c273245ae1b2e8ffe554e19746c693caa58b58c8` | Note the local Stage 1 evidence commit in the work record. (Encoder) |
| `19a4271d` (cherry-pick of `6bbaa03b`) | docs: record Memory investigation for the owned embedder |
| `8c9f9fe6` (cherry-pick of `b3f88e80`) | docs: record Host investigation for the owned embedder |
| `5a5385cdc319693f5cf417e1bc3cebadefbcb4c1` | docs: publish owned-embedder Stage 2 contracts and authorization |

Not pushed.

## Handoff

```text
Worktree: /Users/jtr/_JTR23_/development/home23/.home23-worktrees/owned-embedder-lead-contracts
Branch:   home23-agent/owned-embedder-lead-contracts
Shared:   /Users/jtr/_JTR23_/development/home23 remains codex/jerry-continuity-20260907 @ 44288211
Next:     Memory Stage 2 first slice on its own isolated worktree.
          Encoder: seams only, then Stage 3 after that slice lands.
          Host: wait for frozen fields (now published) + Stage 3 service.
          Do not implement scripts/embedder/serve.mjs until Stage 2 first slice is in source.
```
