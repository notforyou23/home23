# Home23 Owned Embedder — Design (v1)

Date: 2026-09-10  
Status: approved for planning — no implementation started  
Edits: `substrate/src/embed-fetch.ts`, `src/substrate/embed-at-contact.ts`, `src/substrate/semantic-match.ts`, `substrate/src/adapters/event-ledger-tail.ts`, `engine/src/core/openai-client.js`, `shared/seed-embedding-config.cjs`, `cli/lib/generate-ecosystem.js`, `cli/lib/init.js`  
Unchanged consumers: `engine/src/memory/network-memory.js`, `substrate/src/metabolism.ts`, `src/substrate/seed-context.ts`  
Does not replace: the published semantic projection (`SEMANTIC_PROJECTION_SEED = 20260808` stands unchanged)

## Bar

A stranger runs `npm i home23`, starts it, and the Seed perceives meaning — with no Ollama, no API key, and no documented setup step.

Two further bars, because this ships to people who are not the owner:

- **Nothing silently degrades.** No embedder still works, and says so.
- **The vector space stops being a one-way door.** Changing embedders later is a versioned migration, not a break.

## Two findings that shape everything

**1. Without an embedder, the Seed learns over identity, not meaning.**
`encodeEvent` (`substrate/src/metabolism.ts:161`) fills the leading 16 input channels from the semantic vector when present, and from `sha256(sourceRef:producedAt:category:authority)` when absent. Two paraphrases of one sentence therefore produce *orthogonal* reservoir input. Hebbian development still happens — over filing labels rather than meaning. The payoff test (`substrate/tests/semantic-encoder.test.ts:93`) proves the mechanism, but feeds synthetic vectors; the effect on real text is reasoned, not measured.

The memory network degrades more gently: the keyword index still yields candidates (`engine/src/memory/network-memory.js:2272`) and `cosineSimilarity` returns `0` for absent vectors, so ranking falls back to lexical overlap plus authority scoring.

**2. The embedder is on the attention hot path, and `0.60` is a calibrated constant.**
`embedTextRawSync` (`src/substrate/embed-at-contact.ts:114`) returns the native 768-dim vector, never persisted, and `src/substrate/semantic-match.ts` builds the harness attention gate on it — expression organ, triggered surfaces, and trigger index all gate through one cosine against `SEMANTIC_MATCH_FLOOR = 0.6`, calibrated 2026-08-08 against real conversation turns.

That floor is an **absolute** threshold in the embedder's native output space. Changing embedders re-tunes Home23's attention silently: too low a distribution and the Seed narrates on unrelated turns, too high and it goes mute. Nothing crashes and no test fails. Re-embedding stored history does not fix it, because the floor governs a live comparison that is never persisted.

**Consequence:** migration and recalibration are two different jobs with two different deliverables, and the second one has no data artifact to check afterward.

## Architecture

### A. Home23 speaks the contract it already depends on

Three call sites use two protocols:

| Call site | Protocol |
|---|---|
| `substrate/src/embed-fetch.ts:30` | Ollama-native `POST /api/embeddings` → `{embedding}` |
| `src/substrate/embed-at-contact.ts:88` | Ollama-native (membrane mirror of the above) |
| `engine/src/core/openai-client.js:59` | OpenAI-compatible `POST /v1/embeddings` → `{data:[{embedding}]}` |

The sidecar serves **both**. No call site changes *shape* — only the default endpoint each one resolves to. Substrate keeps `execFileSync('curl')`, perception stays synchronous, the membrane is untouched, and no npm dependency crosses into `substrate/`. The edits are default-constant changes at three seams; the work is a new process, config, and packaging.

Both resolvers already point at a controllable URL — `resolveSeedEmbeddingEnv` (`shared/seed-embedding-config.cjs:7`) and `resolveEmbeddingConfig()` (`cli/lib/generate-ecosystem.js:124`). Ollama demotes from prerequisite to **override**, and that override path stays tested.

### B. `home23-embedder`

- **Scope:** house-level singleton, like `home23-coordination` (`cli/lib/generate-ecosystem.js:240`) and `home23-seed-observatory` (`:540`). One loaded model serves every agent, seed and shipper.
- **Location:** harness side (`scripts/embedder/serve.mjs`). It cannot live under `substrate/` — the zero-dependency law is why `embed-fetch.ts` shells out to `curl` at all.
- **Runtime:** `@huggingface/transformers` (v3), which selects `onnxruntime-node` on Node. Preferred over raw onnxruntime because it owns tokenization, mean pooling, L2 normalization and nomic's task-prefix convention — precisely where vector-space parity is silently lost when hand-rolled.
- **Binding:** loopback TCP, default port `11435`. Not a unix socket: `shared/seed-embedding-config.cjs:11` validates the endpoint as `http:`/`https:`, and loosening that check would remove a control that is currently doing real work.
- **Hardening:** bind `127.0.0.1` explicitly, never `0.0.0.0`; reject requests carrying an `Origin` header; validate `Host` against a loopback allowlist. A loopback HTTP server is reachable by every local process and, via DNS rebinding, by any page the user visits. Credential-free by construction, satisfying the law in `shared/seed-embedding-config.cjs:15`.
- **Lifecycle:** `autorestart: true`, `max_memory_restart: '2G'`, single model instance with a request queue. `GET /api/tags` mimics Ollama's model list so `cli/lib/init.js:63` retargets with almost no change.

### C. Model delivery

Weights are **fetched, not vendored**, into `~/.home23/models/<encoder-id>/`, with SHA-256 digests pinned in-repo and load refused on mismatch.

The argument is upgrade cost, not install cost: npm tarballs are immutable, so a vendored 140 MB model is re-downloaded on every version bump even though the weights never changed. Zero setup is preserved because the fetch is automatic, never a documented user step.

Digest pinning is not ceremony. An ONNX graph is a computation graph the process executes; pinning hashes is what makes "we download a model on first run" defensible to ship to strangers.

`home23 embedder fetch` pre-seeds for offline installs, and an env override points at a local directory so air-gapped installs are not blocked. Rejected alternative: a `home23-model-nomic` package in `optionalDependencies` — npm-idiomatic, but it splits version authority across two registries for no gain here.

### D. Encoder identity on the line

Today a line carries `semantic_vector` and nothing else. Nothing records which embedder produced it. That is the one-way door.

Every line carrying a vector also carries its provenance:

```
semantic_vector:  [ ...16 floats... ]
semantic_encoder: "nomic-embed-text-v1.5/768/20260808"
```

— embedder identity, source dimensionality, projection seed.

Rules:

- **Additive and optional.** Lines without the field must still parse. The four parse sites in `substrate/src/adapters/event-ledger-tail.ts` (316, 381, 420, 460) and `sanitizeSemanticVector` carry it through.
- **Absence has a defined meaning**, not an unknown one: missing field ⇒ `nomic-embed-text/768/20260808`. Existing history becomes correctly labeled without rewriting a byte.
- **Migration is idempotent and resumable** — the pass skips lines already stamped with the target id.
- **Readers may refuse to compare across encoder ids** rather than produce meaningless similarity.

The comment at `substrate/src/semantic-projection.ts:6` promises the same sentence lands in the same direction "for every individual, on any silicon." That holds only while every writer runs the same embedder — the assumption that breaks the moment Home23 has users. Stamping the encoder makes the promise **checkable** rather than merely stated.

### E. The match floor becomes a property of the encoder

`SEMANTIC_MATCH_FLOOR = 0.6` stops being a module constant and becomes a field on a registered encoder profile:

```ts
interface EncoderProfile {
  id: string;                  // "nomic-embed-text-v1.5/768/20260808"
  embedder: string;            // model name sent to the endpoint
  dim: number;                 // 768
  projectionSeed: number;      // 20260808
  matchFloor: number | null;   // calibrated cosine floor, native space
  calibratedAt: string | null; // ISO date
  calibrationReceipt: string | null;
}
```

The active encoder's profile supplies the floor. Two rules make this safe:

- **An encoder with `matchFloor: null` MUST NOT gate on meaning.** It falls back to substring matching, exactly as the embedder-down path already does (`src/substrate/semantic-match.ts:15`). Borrowing another encoder's floor is forbidden — that is the silent-drift failure this whole section exists to prevent.
- **A floor is only ever set by a recorded calibration**, with `calibratedAt` and a receipt path. The legacy profile is seeded with `0.60` / `2026-08-08` and a pointer to the existing calibration record, so today's behavior is preserved by construction rather than by coincidence.

This turns "which floor goes with which embedder" from tribal knowledge in a doc comment into a checked invariant.

## The parity spike — gate on everything downstream

Throwaway, run first, decides whether this is "change a default" or "migrate and recalibrate."

Corpus: ~200 real turn/anchor pairs drawn from live ledgers, plus ~20 synthetic controls. Embed through both Ollama `nomic-embed-text` and the ONNX v1.5 build. Check in severity order:

1. **Per-vector agreement** — cosine between runtimes for identical input. Want > 0.99. Below ~0.95 indicates different pooling or a missing task prefix, not float noise.
2. **Distribution preservation** — turn↔anchor cosine distributions under both runtimes must place the same pairs on the same side of `0.60`. A uniform shift of 0.03 moves real traffic across that line. This is the check that protects the attention gate.
3. **Projection stability** — both pushed through `projectEmbedding`; quantized 16-dim outputs must agree to 4dp, since that is what rides chains forever.

Outcomes:

- **All three pass** → defaults change, no migration, no recalibration.
- **1 fails, 2 passes** → migration needed, attention gate survives.
- **2 fails** → migration *and* recalibration needed, and model choice reopens — bge-small's size and speed are back in play, since the recalibration cost is being paid regardless.

## Migration and recalibration

**Migration** is a pure function of data on disk. Every writer persists the exact embedded text beside the vector: `payload.head` (`src/agent/relationship-ledger.ts:301`), `summary`/`rootCause` (`src/workers/receipts.ts:67`), `text` (`substrate/bin/house-sense.ts:147`), and turn text in the conversation shipper. Nothing is lossy. Precedent: `scripts/migrate-legacy-brain.mjs`, and `scripts/rebuild-ann-indexes.sh` for the index side.

One trap: the write path embeds `trimmed.slice(0, 1000)` (`src/substrate/embed-at-contact.ts:88`) while the persisted `head` is the full text. The migration must reproduce trim-then-slice exactly, or migrated vectors will not match what the live path produces for the same event.

**Recalibration** is a different job whose deliverable is a number plus a receipt, not a data rewrite. Replay real turns through the new embedder, score pairs a human labels "genuine pull" vs "unrelated," and derive the floor that reproduces 2026-08-08 behavior. It writes an `EncoderProfile` with `calibratedAt` and a receipt path. Until it runs, the new encoder's `matchFloor` stays `null` and meaning-gating stays off.

## Failure semantics

The degraded-honest contract survives unchanged: sidecar down → connection refused → `null` → the line ships without a vector and the attention gate falls back to substring matching. Already the tested behavior; no new code.

**The new risk is startup.** Perception happens once and the vector rides the record forever, so any event born while the embedder is loading is *permanently* vectorless — seconds for a warm model, **minutes on first run while the model downloads**. A fresh Home23 would blind itself through exactly the window in which its first events are laid down.

Fixed by ordering, not retry logic: fetch the model during `home23 setup` (where `cli/lib/init.js:60` already does readiness work) rather than lazily at first start, and gate seed/shipper startup on embedder readiness via pm2 `wait_ready`. Blocking the writer paths is the fallback, and is deliberately not the first choice — those paths are non-blocking by design.

## Testing

- **Protocol conformance** — the sidecar's two endpoints are indistinguishable from Ollama's for every request shape Home23 sends, including error and timeout behavior.
- **Membrane parity** — extend `tests/agent/semantic-projection-parity.test.ts` to cover the `semantic_encoder` stamp across both implementations.
- **Frozen-corpus regression** — pinned embeddings for a fixed input set, so a future runtime upgrade cannot silently move the space.
- **Floor invariant** — an `EncoderProfile` with `matchFloor: null` never gates on meaning; asserted directly, not inferred.
- **Migration idempotence** — run twice, second pass is a no-op.
- **Startup blindness** — an event born before embedder readiness is either vectorless-and-labeled or delayed, never silently mislabeled.

## Sequencing

1. **Parity spike** — throwaway; answers go/no-go and decides everything below.
2. **`semantic_encoder` stamping + `EncoderProfile` registry** — additive, ships alone, valuable even if the embedder never changes, and cheapest before other people run Seeds.
3. **Sidecar + protocol conformance** — pointed at nothing yet; prove Ollama-shape equivalence.
4. **Model delivery + setup-time fetch** — packaging, digests, `home23 embedder fetch`.
5. **Flip defaults** — Ollama becomes an override; readiness check retargeted.
6. **Migration and/or recalibration** — only whichever step 1 says is actually required.

Steps 2 and 3 are order-independent and neither commits to step 1's outcome.

## Non-goals (v1)

- Replacing the cognitive engine's paid providers. This is the **Seed's** credential-free encoder only.
- Changing `SEMANTIC_PROJECTION_SEED` or `SEM_DIM`.
- Making perception asynchronous.
- Multi-encoder fleets running concurrently. Encoder ids make mixed history *legible*; they do not make mixed live comparison *supported*.
- An Apple-native embedder path (`NLContextualEmbedding`). The loopback contract leaves room for it later; it is a different vector space and would need its own profile and calibration.

## Open questions

- Whether the memory network's ANN indexes need re-embedding on the same trigger as the ledgers, or can be rebuilt lazily from `node.concept` on next access.
- Whether `home23-embedder` should be per-house or per-install when multiple Home23 installs share a machine.
- Whether the frozen-corpus regression belongs in CI, given it needs model weights present.
