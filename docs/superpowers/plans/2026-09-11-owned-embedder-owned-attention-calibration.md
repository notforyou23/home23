# Owned encoder attention policy (measured calibration unfinished)

Date: 2026-09-11  
Recipe: `owned-nomic-v1.5-onnx-fp32-mean-noprefix` / `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9`  
Policy version: `owned-null-cal-20260911`  
Status: **null-cal policy recorded. Measured owned match-floor calibration is unfinished.** It does not block a scoped Linux embedding/retrieval test.

## Decision

The owned recipe stays **null-calibrated**. `matchFloor` and `matchMargin` are `null`. `canSemanticGate` is `false`.

Do **not** copy Ollama / lived-legacy `0.60` / `0.12`. Those constants were calibrated on 2026-08-08 against live conversation turns in the **Ollama `nomic-embed-text`** space. Official ONNX nomic is a different space (Stage 1: mean cosine **0.900851**, min **0.517358**, **0/25** projections equal to 4 d.p.). Borrowing the floor would gate silently on the wrong distribution.

An uncalibrated policy must not perform semantic gating. Owned / unknown recipes use existing lexical / no-match behavior. Short-turn `minMatchableAlnum: 20` is unchanged and is not a cosine threshold.

Lived homes that still resolve as legacy (`nomic-embed-text` or the frozen legacy hash) keep `0.60` / `0.12`. Missing stamps on those homes do not mute them. That is not a license to label owned vectors as legacy.

## Evidence used

| Fact | Source |
|---|---|
| Spaces are not drop-in compatible | Stage 1 committed measurements; contracts work record |
| Owned policy is null-cal in code | `shared/semantic-encoder-contract.cjs` `POLICIES[OWNED_EMBEDDING_PROFILE]` |
| Live TEST processes used owned `SEED_EMBED_RECIPE_ID` and did not borrow 0.60/0.12 | `.stage5-host-home/memory-receipt.json` `attention` |
| Pair/pool admit at 0.99 is false on owned | same receipt; `tests/agent/semantic-match.test.ts` |
| Retrieval still ranks by cosine in NetworkMemory | Stage 5 context-mode search; attention gating is a separate consumer |

## What this is not

This is not a measured owned match floor. No public corpus yet supports replacing `null` with a number. A future calibration is a **new policy version** tied to this recipe id, with its own receipt. It must not edit Seed history or flip Jerry.

## Enforcement

- `resolveAttentionPolicy(owned)` → null floor, `canSemanticGate: false`
- `admitsPairScore` / `admitsPoolScore` return false when the policy cannot gate
- `context-assembly` / `trigger-index` pass `activeAttentionRecipeId()` (`SEED_EMBED_RECIPE_ID`)
- Caches key by recipe id so owned and legacy vectors do not share a calibrated cache
