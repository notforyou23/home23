# Owned embedder — new-home candidate record

Date: 2026-09-11  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md`  
Owner: candidate integration on `home23-agent/owned-embedder-stage5-verify`

## Isolation (do not mix)

| Item | Path / value |
|---|---|
| Backend worktree | `home23/.home23-worktrees/owned-embedder-stage5-verify` |
| Branch | `home23-agent/owned-embedder-stage5-verify` |
| Apple worktree | `home23-apple-owned-embedder-host-stage4` |
| Apple branch | `home23-apple-agent/owned-embedder-host-stage4` |
| Mac TEST home | `.stage5-product-home` (stopped unless this record says otherwise) |
| Linux test root (Grok Bot) | `/home/box/home23-owned-embedder-test` — **does not exist until Grok Bot materializes it** |
| Scout on the Linux box | `/home/box/home23-test` — **do not change** |
| Live install | `/Users/jtr/_JTR23_/release/home23` — **do not change** |
| Shared main | **do not modify / do not push** |

Live Home23 still embeds with Ollama `nomic-embed-text` on port 11434. Keep that model. Mac TEST uses owned ONNX on port 32591 when started.

## Rulings

- **R1.** Existing Mac TEST home cannot be `host.mjs install`’d with a new `packageId`. D08 updater is not available here. Latest Stop (`71ee0ff1` name-loop) is **source-only** on that home. Do not create another Mac TEST home.
- **R2.** Owned attention stays null-cal. Do not borrow 0.60/0.12. See `2026-09-11-owned-embedder-owned-attention-calibration.md`.
- **R3.** Do not create another Mac TEST home. Do not pull local chat models. Reuse Mac ingest/retrieve/cloud-chat evidence where the home identity is unchanged.
- **R4.** Do not commit `.stage5-*`, `scripts/embedder/node_modules`, leftover ollama-local chat edits, or the git bundle.
- **R5.** Linux must not use source `init` (Ollama default). Linux lifecycle is Host payload built **on Debian** from this candidate, then isolated `host.mjs`.
- **R6.** Chat OAuth is out of Linux gate scope. Memory Lite is a fail.

## Candidate commits

Checkout the transfer-receipt `candidateSha` (bundle HEAD). That commit includes implementation `112a06e050b0d5561c8bcd35fa00345befeb9f75`. Not GitHub tip, not `main`.

| Area | SHA | Notes |
|---|---|---|
| Download resume (source) | `7066b9ad` | `ensureArtifacts` keeps `.part` on abort |
| Fail-closed Stop names | `71ee0ff1` | Stop owned names even when jlist empty |
| Structured Host semantic errors | `112a06e0` | `error: {code,message}`; interrupt → `host_semantic_interrupted` |
| Linux Host package builder | `112a06e0` | `ldd` + LICENSE; header tmp portable |
| Public ingest fixtures | `112a06e0` | `scripts/embedder/fixtures/public-corpus/` |
| Apple Retry/Resume + error.code | `9cc694df` on Apple branch | decode code; Retry vs Resume |
| Attention calibration doc | `112a06e0` | null-cal; do not borrow 0.60 |
| Linux handoff | `112a06e0` | Grok Bot procedure; no Linux results claimed |

## Mac verification (existing TEST home)

| Receipt | Status |
|---|---|
| Host-path interrupt/resume | Proven while latest `artifacts.mjs` was overlaid; `.stage5-host-home/interrupt-stop-receipt.json` |
| Installed Stop of `71ee0ff1` | **Not** on the packaged copies (D08 / new-home gap). Restored payload Start/Stop of `d8f45ba3` copies succeeded after overlay was reverted |
| Ingest / retrieve / stamped contact / cloud chat | Reused. Sidecar import nodes 1–2 still owned `12e9f736…`. Context-mode hydro **0.7111** / granite **0.5555**. Cloud `gpt-5.5` turn file still present. Conversation-stream 20/20 owned stamps at reconcile |

Mac TEST must remain **stopped** when idle.

## Linux

Handoff: `2026-09-11-owned-embedder-linux-handoff.md`.  
Grok Bot independently tests Debian 13. Do not claim those results here.
Transfer: untracked `.stage5-handoff/` bundle + SHA-256. Branch is not on GitHub.
