> Historical implementation record. Current owner direction: [Home23 continuity, updates and portability](../../design/HOME-UPDATES-AND-PORTABILITY.md). Preserve this evidence, but do not execute old next steps or reopen completed milestones from this document.

# Built-in semantic memory for Home23

Date: September 10, 2026

Status: proposed execution plan after source review; implementation has not started.

A new owner creates a home through Home23 Host. Host prepares its local semantic
encoder automatically, establishes that it works, and starts the home with useful
semantic perception and document retrieval. The owner operates Home23; Node, PM2,
model files and process configuration remain Host responsibilities.

This plan supplies the reviewed implementation requirements for the
[initial embedder proposal](../specs/2026-09-10-owned-embedder-design.md).
It implements the embedding portion of delivery item D05 in
[Product delivery](../../design/PRODUCT-DELIVERY.md), with dependencies on D02
(packaging), D08 (existing-home upgrades) and D09 (setup/recovery).
It does not complete provider authorization, cloud connectors, remote access or
public distribution. Chat model selection and costs remain separate.

## What exists, and what this work adds

The current [Host](../../design/HOST-COMPANION.md) bundles Node and a private PM2
installation, allocates ports per home, and uses the shared
[home birth operation](../../design/HOME-BIRTH.md). The installed proof established
conversation routing and restart continuity using a local model fixture. It did
not exercise real embedding inference or establish document-ingestion quality.

The remaining work is a real inference service, reproducible model delivery,
encoder-aware consumers, Host lifecycle and progress integration, and verified
document-to-memory behavior. This is a cross-repository product feature.

The initial delivery is for new homes. Existing homes retain their selected
encoder and lived state until a separate, evidence-backed transition is ready.
Installing a newer companion must not silently change an installed home's runtime.

## Decisions carried into the plan

- One embedder process belongs to each home and is managed by that home's private
  supervisor. Allocate its loopback port through the existing port plan. A fixed
  operator default may remain for source installations; it is not the Host port.
- One active encoder recipe serves a home's default Seed/contact and retrieval
  paths. Preserve explicit supported overrides; do not replace the chat model or
  narrow any resident/helper's tools, skills or authority.
- Keep inference and dependencies outside `substrate/`. Preserve the synchronous,
  credential-free contact interface, the published projection seed and its current
  768-dimensional input contract. A different dimension is a separate design change.
- Prefer the current Nomic model family for the first compatibility experiment.
  The exact model revision, artifact format, precision and runtime version remain
  contingent on measured compatibility, performance and packaging support.
- Use a private per-home model directory outside immutable application sources,
  addressed explicitly by configuration. Shared immutable model-file caching can
  follow later; a global inference daemon is not required.
- Treat recorded Seed perception as immutable. Search indexes and derived search
  vectors have a different migration policy from developmental history.

## Prerequisites to settle before integrating the default

| Requirement | Concrete deliverable |
|---|---|
| Actual caller inventory | List every embedding writer/reader, request shape, truncation/prefix rule, deadline, vector dimension, cache and attention gate. Include brain batch calls, source ledgers, Seed adapters and helper/channel paths. |
| Reproducible encoder | Pin model revision, weights, tokenizer/config artifacts, runtime dependency versions, precision, pooling, normalization and preprocessing. Record distribution notices and supported artifact sources. |
| Compatibility and calibration | Compare the current baseline and candidate using a small nonpersonal corpus plus private representative turn/anchor pairs. Measure native vectors, projected vectors, all attention gates and retrieval behavior. Keep personal text/results out of public fixtures. |
| Supported hardware | Measure model download size, disk/RAM use, cold/warm load and interactive latency with the packaged Node runtime on the initial supported Mac architecture. Do not infer support for other release targets. |
| Historical provenance | Inventory existing encoder overrides and what can actually be established about unstamped records. Missing provenance remains unknown unless evidence identifies it. |
| Preparation boundary | Identify which creation steps emit contact events. Preserve preparation-only Seed genesis; ensure first meaningful writer activity begins after successful encoder warm-up. |

The experiment produces a recipe manifest, measurements, calibration evidence and
a recommendation. Passing a finite corpus supports a compatibility decision; it
does not prove all possible future inputs produce identical vectors. Do not borrow
the legacy calibration or silently relabel old history on that basis.

## Integration map

Paths below are existing seams unless marked proposed. Apple paths are relative
to the maintained `home23-apple` repository; all others are backend paths.

| Responsibility | Components | Required change |
|---|---|---|
| Encoder service and model delivery | Proposed `scripts/embedder/` and shared recipe/profile modules; dependency manifests/locks | Two supported embedding protocols, strict requested-model validation, pinned artifact fetch, warm-up, bounded scheduling and structured health. |
| Configuration | `shared/seed-embedding-config.cjs`, `cli/lib/generate-ecosystem.js`, public config/templates | One resolved active profile and endpoint per home; preserve explicit overrides and keep credentials out of Seed encoding. |
| Contact perception | `src/substrate/embed-at-contact.ts`, `substrate/src/embed-fetch.ts`, their ledger writers | Preserve exact preprocessing/projection and deadlines; stamp verified provenance and make absent-vector reasons observable. |
| Seed input/replay | `substrate/src/adapters/event-ledger-tail.ts`, `substrate/src/types.ts`, consumption boundary before `encodeEvent` | Carry optional provenance, enforce compatibility before consumption, and preserve old parsing, event identities and replay. Audit `metabolism.ts`; leaving it unchanged requires enforcement at its boundary. |
| Attention | `src/substrate/semantic-match.ts`, `src/substrate/seed-context.ts`, `src/agent/context-assembly.ts`, `src/agent/trigger-index.ts` | Apply the active attention policy everywhere and key caches by recipe. Cover floor, relative margin and short-turn behavior. |
| Brain retrieval | `engine/src/core/openai-client.js`, `engine/src/memory/network-memory.js`, `engine/src/merge/build-ann-index.js` | Preserve batching/index mapping and preprocessing; carry encoder identity through stored/query vectors, caches and index metadata. Prevent incompatible comparisons. |
| Host lifecycle | `cli/lib/product-host.js`, `cli/lib/product-environment.js`, `cli/lib/product-memory.js`, `scripts/product/host.mjs` | Add the owned process/port, preparation operation, inference readiness and recovery state. Decouple chat-provider base URL from automatic embedding selection. |
| Shared birth/source setup | `cli/lib/create-home.js`, `cli/lib/seed-birth.js`, `cli/lib/setup.js`, `cli/lib/init.js` | Reuse one birth operation; keep it free of service startup and model downloads. Host/source setup orchestrate semantic preparation around that operation. |
| Native Host | Apple `Home23Host/HostCommand.swift`, `HostModel.swift`, `Home23HostApp.swift` | Decode durable progress, display preparation/retry states, handle interrupted operations and expose useful diagnostics. |
| Packaging | `scripts/product/package.mjs`, `cli/lib/product-payload.js`, dependency manifests and Apple Host packaging | Bundle compatible inference libraries, load-check native modules with distributed Node, preserve integrity/signing order and keep mutable model downloads outside packaged source. |
| Onboarding/ingestion | Existing import-folder, document ingestion and memory-search paths | Trace actual document submission through parsing, embedding and retrieval; make ingestion completion distinct from service readiness. Reuse the home's service for residents/helpers/channels without merging their memory scopes. |

The iPhone and Mac conversation clients connect to the same home and need no local
encoder. Reuse existing capability/status contracts for any needed memory state;
do not add another independent setup flow. UI changes beyond native Host should
follow demonstrated gaps in that shared path.

## Encoder and continuity contracts

**Recipe and calibration.** An encoder identity fingerprints the actual recipe,
including model/tokenizer artifacts, precision, prefix/truncation, pooling,
normalization and projection version. Calibration is a separately versioned
attention policy associated with that recipe. Record receipts for both.

`seed-context.ts` currently has its own floor (`0.60`), margin (`0.12`) and minimum
turn length (`20`); it is not an unchanged consumer of the shared matcher.
An uncalibrated policy must not perform semantic gating in any consumer. Use the
appropriate existing lexical/no-match behavior, preserving short-turn handling.
Reject dimension mismatches instead of comparing only the shorter vector length.

**Provenance.** New vectors carry verified encoder identity through persistence,
adapters, caches and queries. A requested model alias or equal dimension does not
establish compatibility. Unstamped old records continue to parse, but do not
automatically acquire a known Nomic identity. Explicitly handle unknown provenance
and reject incompatible semantic comparisons rather than silently mixing spaces.
Additive provenance must not reject or reinterpret previously accepted historical
replay. Replay retains recorded vectors and legacy semantics; compatibility guards
govern newly admitted input and live comparisons. Missing old stamps do not by
themselves justify changing a resident's established attention behavior.

**Seed history.** Do not rewrite source contacts or developmental ledgers to
re-perceive history. Source-line edits can also change event IDs and byte-offset
cursors. Existing reservoirs and learned state are not translated by rebuilding
vectors on disk. A future incompatible Seed transition requires a specific,
receipt-linked policy for future input and developed state; retaining the old
encoder is the default until that is resolved. Reinterpretation, if introduced,
must be a new explicit derived observation, not an alteration of the old record.

**Retrieval migration.** The current ANN builder indexes `node.embedding`; it
does not regenerate vectors from `node.concept`. The existing missing-vector
repair also skips nodes that already have embeddings. Build a separate resumable
replacement generation from the canonical retrieval text, preserving original
records and the prior usable generation. Quiesce affected writers or capture and
apply ordered changes before switching. Activate query recipe, vectors, index and
caches together. Lazy population is allowed only with incompatible entries
excluded and honest lexical fallback. It is not a mixed live encoder fleet.

## Host preparation, readiness and failure behavior

Keep home preparation, inference readiness, resident readiness and completed
document ingestion as separately inspectable facts. PM2 `online` or `/api/tags`
alone proves none of the latter three.

The proposed sequence is:

1. Install the verified payload and reserve the home's encoder configuration/port.
2. Prepare the resident and Seed through the existing resumable birth operation.
   Keep contact writers stopped; if the inventory finds meaningful contact inside
   preparation, move encoder preparation before that contact boundary.
3. Prepare model artifacts, verify digests, start the owned encoder and warm it
   with actual inference. Verify the expected recipe, finite output and dimension.
4. Admit relevant writers and resident services in an explicitly enforced order.
5. Report resident availability and semantic readiness separately; process imported
   documents through the existing pipeline and report their actual outcome.

Add a durable semantic-preparation operation with a stable recovery handle and
states such as downloading, verifying, warming, ready, interrupted and failed.
Host commands retain one JSON response on stdout. Begin/resume returns the handle;
status reads persisted progress. Long downloads must not depend on one native
command staying alive: interrupted work resumes from verified partial state, and
any surviving worker is owned, discoverable and reconciled before another starts.
Do not solve this by increasing every timeout or rendering arbitrary stderr.

Model fetching needs bounded downloads, disk checks, atomic publication after
verification, cancellation and offline pre-seeding. Routine ready operation uses
verified local files without depending on network availability. Host's explicit
environment selects the cache path; the GUI's ambient home directory is not an
implicit dependency.

Fresh setup pauses before live contact while mandatory semantic preparation is
unavailable and offers Retry/Resume with the saved home intact. A later outage in
a running home retains the existing nonblocking, vector-absent behavior and
appropriate attention fallback, but reports the degraded capability explicitly.
Restoring the encoder must not silently backfill immutable contact history.

Use a bounded queue with interactive/contact priority, bounded batch size and
expired-request cancellation. Measure contention against existing synchronous
deadlines; a large ingestion batch must not occupy the model indefinitely while
contact requests time out. Bind explicitly to loopback, enforce the proposed
Origin/Host checks and input limits, and avoid logging document or conversation text.

Register the service in the submitted process plan and readiness/monitoring
inventory. Version additions to port plans, Host replies and saved state so old
installations remain inspectable; an old home must not acquire a missing-service
failure merely because a newer Host knows about the embedder. Its explicit
upgrade selects the new requirements. Start/stop/recovery affects only that home's
processes, preserves desired-running intent and never starts duplicate Seed runners. Translate PM2
failures into Host diagnostics and useful actions; retain technical details for
support without making commands the ordinary recovery path.

## Delivery sequence and useful proof

Each stage has a concrete artifact and a narrow completion condition. One owner
tracks the stage, dependencies, commit, evidence and return to the maintained
product line. Reconcile existing work before starting another attempt.

| Stage | Work product | Completion evidence / dependency |
|---|---|---|
| 1. Compatibility experiment | Caller inventory, pinned candidate recipe, latency/footprint measurements and calibration recommendation | Real inference using the packaged-runtime constraints; identifies compatible behavior and unresolved differences. No default or live-state changes. |
| 2. Encoder-aware contracts | Additive provenance/profile handling, complete attention policy, cache and dimension guards | Existing history still parses/replays; null calibration cannot gate semantically; mismatched vectors cannot compare. May be developed alongside stage 1 without selecting a new default. |
| 3. Owned inference service | Protocol adapters, model-fetch operation, health/warm-up, scheduling and offline artifact support | Actual single/batch request shapes work; interruption resumes; bad artifacts and expired work fail clearly; latency remains usable under ingestion load. |
| 4. Host and native setup | Private process/port integration, durable progress, explicit dependencies, native status/retry UX and source-setup parity | New-home setup needs no embedding commands; interrupted preparation keeps one home/Seed and resumes; Stop remains stopped. Depends on stages 1–3. |
| 5. New-home semantic milestone | Complete packaged Host with the owned default; document ingestion and retrieval integration | Install an isolated new home with no ambient Ollama/config/credentials. Import a nonpersonal document and retrieve it with a meaningful paraphrase; observe stamped Seed contact and working attention. Restart preserves identity, history and encoder selection. Use a real configured chat provider for the end-to-end answer claim. |
| 6. Existing-home transition | Per-home provenance inventory, continuity decision, derived-index migration where needed, activation/recovery procedure | Preserve Seed lineage and source history; verify compatible future perception and retrieval. Calibration/migration precedes any switch. A genuinely incompatible Seed transition remains blocked on its explicit design, not a blind rewrite. |
| 7. Release delivery | Reviewed runtime/app artifacts, notices, signing/notarization integration and owner-facing setup/recovery docs | Clean supported-Mac acceptance with released artifacts; source commits and fixture tests alone are insufficient. Coordinate with D02/D08/D09. |

Stages 1–5 deliver the first semantic new-home milestone. Stage 6 follows its
own continuity decision and does not block that milestone. Delivering stage 5
does not authorize changing an existing home. Package installation currently refuses
overwrite/adoption: an existing product home's upgrade requires the D08 updater,
not copying new sources over its installation. The operator installation has its
own managed-release and installation-service activation procedure.

Use existing contract suites near `tests/cli/product-{host,memory,package,payload}`,
Seed birth/contact/projection tests, attention tests, engine embedding/index tests,
and Apple `Home23Host/Tests/HostCommandTests.swift`. Add focused coverage for the
new invariants and recovery boundaries. Keep lightweight protocol/policy tests in
ordinary CI; run real inference against a small nonpersonal frozen corpus in a
dedicated job with digest-verified cached weights. Larger private calibration is
separate. Do not repeat successful unrelated checks or substitute synthetic
vectors for the real semantic milestone.

## Handoff and outstanding decisions

Before beginning each stage, record the maintained backend/Apple source commits,
scope and existing dirty work. Its receipt names the candidate recipe, component
commits, meaningful checks, actual result, unresolved dependencies and next owner
action. Keep private histories and installation receipts out of public Git.
Prepared, running, verified, activated and physically accepted remain distinct.

The remaining empirical decisions are the exact runtime/model artifacts, measured
hardware limits and performance budgets, calibrated attention policy, compatibility
with existing residents, and the D08 upgrade mechanism for installed product homes.
Per-home process scope, Host-led setup and CI corpus placement have recommendations
above and need no additional architecture fork to begin the experiment.

This plan does not start implementation, download models, call a provider, change
Seed state or activate/install anything. Source work, publication and live
activation must each follow the authorization covering that action. The first
execution assignment is stage 1; its evidence determines the candidate for the
subsequent implementation rather than another speculative default change.
