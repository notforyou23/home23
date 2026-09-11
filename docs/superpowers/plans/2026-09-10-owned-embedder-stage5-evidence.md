# Owned embedder — Stage 5 isolated TEST evidence

Date: 2026-09-10  
Plan: `docs/superpowers/plans/2026-09-10-owned-embedder-host-integration.md` @ `3c7495d6`  
Branch: `home23-agent/owned-embedder-stage5-verify`  
Kind: cache-copy / in-process harness. **Not** a packaged Host create, product import-folder, or full-home restart. Stages 1–5 are not complete.

Full machine receipt stays untracked next to the TEST home. This note is the public summary.

## Integration

| Item | SHA |
|---|---|
| Host Stage 4 base | `95e7f7adf5d5050ee5df9118077f20b8bad62cb0` |
| Memory writer stamps (source) | `0acc647f3d173a71678d4bdd5be1fa20c6911162` |
| Memory cherry-pick on this branch | `a58e5c61` |

Shared `home23` stayed `codex/jerry-continuity-20260907`. Apple Host Stage 4 is `88123ded` on `home23-apple-agent/owned-embedder-host-stage4`; shared Apple stayed `codex/mac-dashboard2-20260908`.

## TEST home

`home23/.home23-worktrees/owned-embedder-stage5-evidence-5/Home`

Schema `home23.host.v2`, `encoderRequired: true`. Cache is that home's `runtime/embedder-cache`, copied from Encoder Stage 1. Host evidence homes `owned-embedder-host-stage4-evidence` and `*-evidence-2` were not deleted. Earlier Stage 5 attempt dirs `evidence`, `evidence-2`, `evidence-3`, `evidence-4` were left in place.

## Checks

| Check | Status | Fixture vs real | Evidence |
|---|---|---|---|
| 1. Owned encoder `/ready` | **pass** | **real** ONNX | `warm: true`, recipe `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9`, dim 768 |
| 2. Document retrieval by meaning | **pass** | **real** import + owned `/v1/embeddings` | `DocumentFeeder.ingestFile` of original USGS-style public prose; paraphrase cosine 0.711 hydrologic vs 0.555 granite distractor; `NetworkMemory.query` ranked hydrologic first; keyword-only ranked both 0.526 (granite first) |
| 3. Semantic contact stamp | **pass** | **real** `embedTextSync` + Memory `0acc647f` stamp | New shipper line recipe hash + owned profile + 16-d projection; pre-existing unstamped line byte-identical; birth `modelInvocations: 0` and retry byte-identical |
| 4. Encoder process restart | **harness only** | source `serve.mjs` via ambient Node | Did not start Seed/engine/coordination. Committed Stop on `3cfdea94` could leave `/ready` warm. |
| 5. Chat e2e answer | **probe only** | retrieve-then-answer | Ambient Ollama `llama3.2:1b` (since deleted). Not Host GUI. Not “no ambient Ollama.” |

Owned `matchFloor` stayed `null`. No calibration receipt was found or invented.

## What this is not

- Not a packaged Host payload, codesign, or notarization run.
- Not a product default flip. Lived homes still resolve to legacy unless they set the owned recipe explicitly.
- Not Stage 6 existing-home migration.
- NetworkMemory `addNode` still does not persist `embedding_recipe_id` on brain nodes. Retrieval compared unstamped 768-d owned vectors. Writer JSONL stamps are the Memory `0acc647f` path.
- Host mock `stop` left ORT listening once; restart was completed with an explicit TERM of that TEST encoder, then a new `serve.mjs` on the same cache/port.

## Unit tests run on this tree

- `tests/cli/seed-birth.test.js`: 7 pass, 0 fail (`modelInvocations: 0`; retry byte-identical).
- Memory stamp/contract tests: 8 + 21 pass, 0 fail. Conversation-shipper stamp tests are **fixture** embed (no live encoder); live stamp is check 3 above.
- Stage 3 encoder protocol tests were not re-run in this session.
