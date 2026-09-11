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

## Independent review vs source

Findings from the 2026-09-11 independent review, checked against this branch after `c1b7cad5`.

| Finding | Verdict | Action |
|---|---|---|
| B1 Stop can leave `/ready` warm | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`** | Fail-closed Stop remains. Still no packaged Stop receipt. |
| B2 download restarts from scratch | **Confirmed** | Source now Range-resumes a `.part`, verifies digest, then renames. AbortSignal + 2 GiB cap. **Not** a real `host.mjs` create/download receipt. |
| B3 live attention borrowed 0.60/0.12 | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`** | Env + callers still fixture-only. |
| B4 unstamped brain compare | **Confirmed on `3cfdea94`; fixed in `c1b7cad5`** | This slice also stops write-time cosine from treating an unstamped new node as the active recipe. |
| B5 Stage 5 harness bypass | **Confirmed; still open** | No Host create, packaged Node/ORT, import-folder, or allowlisted PM2 restart. |
| Unknown aliases mint the frozen legacy hash | **Confirmed** | `recipeFromRequested('test-embedding')` no longer returns `5128b29c…`. Unset / `nomic-embed-text` still lived-legacy. |
| Prep worker is pid-liveness only | **Confirmed** | 8s pid-0 lease + persisted `workerArgv`. Expired lease → interrupted, then one replacement. |
| `/ready` sticky; no truncation | **Confirmed** | Encode failure clears `warm`. GET `/ready` re-encodes a finite 768-d probe. Server truncates to Memory 2000. |
| Pair consumers missing margin | **Disagree** | Seed-context margin is vs pool median. Pair callers have no pool. `admitsPairScore` stays floor-only. Contracts §7 amended to “margin is pool-only.” |
| `setup.js` must start semantic prep | **Disagree for this slice** | `setup.js` calls `createHome` (shared birth), not Host v2. `beginSemanticPrepare` requires `home23.host.v2` + `encoderRequired`. Wiring it now would make source-setup a new-home owned default (product default flip **NO-GO**). |
| Apple tests decode `phase:ready` only | **Confirmed; not this worktree** | Left on `88123ded`. |
| Create-home tests fail here | **Confirmed; worktree gap** | No `dist/` in this worktree. Not a Stage 5 receipt. |

## This slice (review corrections after `c1b7cad5`)

- Unknown recipe aliases stay unstamped / `known: false`. Lived aliases remain `nomic-embed-text`, `:latest`, the legacy profile name, and the frozen legacy hash.
- `findInitialConnections` compares the node’s own recipe ids; it does not borrow the active hash onto an unstamped node.
- Semantic-prep pid-0 window is a short lease, not “interrupted.”
- `downloadFile` resumes `.part` with Range, verifies, then publishes. Bad digest does not replace dest.
- `/ready` is a finite re-encode while warm; later encode failure clears warm.
- Contracts §7 and process-contract/recipe notes no longer say Host is unwired or that pair consumers must invent a margin.

**Still missing for a Stage 5 / Host-recovery verdict:** real `host.mjs` create + interrupt/resume of a download; packaged `Home/bin/node` ORT load; product import-folder + full allowlisted PM2 restart; live v1 receipt; Apple interrupt / `error.code` tests.

## Lane status

| Lane | Status | Next |
|---|---|---|
| Encoder | Serve + fetch verify/resume exist in source | Real Host create of a download; packaged Node/ORT |
| Memory | Guards, stamps, unknown-alias refuse | Live brain receipt after real ingest |
| Host | v2 admission, fail-closed Stop, recipe env, worker lease | Real create/download. Do not create a real home with this Host yet. Do not wire source `setup.js` until Host create is the product new-home path. |
| Apple | `88123ded` polls semantic-prepare | Interrupt tests; structured `error.code` |
| Lead | Overclaim corrected; review source gaps landed | Keep off shared main. Stages 1–5 not complete. |

## Go / no-go

| Item | Ruling |
|---|---|
| Product default flip | **NO-GO** |
| Existing-home switch (Stage 6) | **NO-GO** |
| Integrate to shared main | **NO-GO** |
| Public distribution | **NO-GO** |
| Create a real home with this Host | **NO-GO** until real Host create/download + packaged Node/ORT receipts exist |
| New-home installation (Host) | Source is closer; **not ready**. Every Host create is still `encoderRequired: true` without proven download/ORT/restart. |
| Stages 1–5 milestone | **not complete** |

## Handoff

```text
Worktree: home23/.home23-worktrees/owned-embedder-stage5-verify
Branch:   home23-agent/owned-embedder-stage5-verify
Shared:   home23 remains codex/jerry-continuity-20260907
Apple:    Host Stage 4 is 88123ded on home23-apple-agent/owned-embedder-host-stage4
          Shared Apple remains codex/mac-dashboard2-20260908
Do not:   push, flip defaults, migrate existing homes, delete TEST homes,
          create a real home with this Host, commit scripts/embedder/node_modules
Next:     real host.mjs create + download interrupt/resume; packaged Node/ORT;
          product import-folder + full Host restart. Not another cache-copy harness.
```
