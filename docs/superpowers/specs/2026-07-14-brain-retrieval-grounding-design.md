# Brain Retrieval Grounding Repair Design

Date: 2026-07-14
Status: approved by operator request
Scope: resident and read-only brain retrieval through the shared manifest-v1 source, dashboard search, MCP/agent brain tools, and Query/PGS consumers of those routes

## Problem

Home23 has three coupled retrieval defects:

1. A revisioned ANN is considered usable only when `builtFromRevision === currentRevision`. Normal memory persistence can append thousands of node and edge revisions after the nightly build, so search drops to a whole-source semantic scan for most of the day. The nightly wrapper can report success while the useful freshness window is already gone.
2. Archive and synthesized material can outrank current operational truth. The semantic path applies a partial salience multiplier, while the keyword path accepts the first physical matches and does not apply the same temporal, closure, domain, or authority policy.
3. Rich provenance already captured by some ingestion paths is not normalized into a retrieval authority contract and is not carried through ANN labels and result evidence. A generated report can therefore be reused as if it were a direct operational source.

These are one evidence-chain problem. Index repair must land first so ranking and provenance tests measure the intended retrieval route rather than degraded whole-corpus scanning.

## Goals

- Serve current logical truth efficiently when ANN is behind but the same manifest generation retains a contiguous delta that covers the gap.
- Never return a stale ANN label for a node updated or removed after the ANN revision.
- Make indexed, indexed-plus-overlay, and full-source-scan modes explicit in every result.
- Apply one deterministic retrieval-authority score to semantic ANN, semantic delta overlay, and keyword candidates.
- Separate graph community `cluster` from retrieval `domain`; do not rewrite graph topology merely to fix retrieval policy.
- Rank current verified state, direct artifacts, worker receipts, and jtr corrections above generated doctrine, narrative, stale telemetry, and raw archive accumulation.
- Preserve closed incidents as retrievable closure records with proof while preventing old alarm text from presenting as active state.
- Surface a bounded provenance class and source chain on every result.
- Provide a dry-run-first, compare-and-swap provenance sweep for existing high-activation operational nodes.
- Add sustained-gap semantics to the rebuild job so a mechanical zero exit is not the only health signal.

## Non-goals

- Destructive deletion of legacy sidecars, graph nodes, or old ANN artifacts.
- Reassigning graph cluster IDs as a substitute for retrieval domains.
- Treating generated doctrine or narrative as worthless; they remain useful context but cannot be final authority for present-tense operational facts.
- Rebuilding ANN on every graph mutation.
- Letting an index or sweep mutate another agent's brain through a read-only target.

## Authority Model

### Retrieval domains

Every candidate receives exactly one derived domain:

- `current_ops`: live/current state surfaces, recent state snapshots, current machine or project observations.
- `closed_incidents`: resolved, completed, superseded, fixed, or archived issues with closure evidence retained.
- `project_history`: durable project decisions, implementation history, and prior receipts that are not current state.
- `external_intake`: news, X/timeline, market, research intake, cron telemetry, and recurring digest material.

`cluster` remains a topology/community field and is returned for graph inspection. `retrievalDomain` is the policy field used for ranking and filtering. This avoids a destructive, semantically false recluster of the live graph.

### Provenance classes

Every candidate receives exactly one public authority class, ordered for operational reuse:

1. `verified_current_state`
2. `jtr_correction`
3. `artifact_log`
4. `worker_receipt`
5. `generated_doctrine`
6. `narrative`

Existing internal `source_class`, memory-ingest authority, temporal status, tags, metadata, and consolidation lineage are inputs to this projection. Unknown or conflicting records default to `narrative`, not to verified state.

`home23.node-provenance.v1` is a data schema, not proof. High-authority classes are accepted only when the normalized profile and every authority-bearing field are covered by a valid `home23.memory-authority-attestation.v1`. The durable node or memory ID, every claim-text fallback, class/domain, evidence and relation refs, status, actor, source classification, and semantic-time fields are bound into the attestation. The signed projection is strict and non-lossy: oversized text/arrays and object-valued refs are rejected rather than truncated, sliced, or string-coerced. Copying an attestation to another ID or changing any bound field fails verification. Unsigned legacy profiles remain retrievable but cannot close, supersede, or establish current operational truth.

Trusted persistence snapshots an authenticated input synchronously before any provider await and re-signs only after deterministic, semantics-preserving normalization. It never imports an external tag into a signed record, invents current authority time, accepts caller vectors for authoritative placement, or mints a new authority identity on ID collision. A malformed or oversized optional signing attempt remains an ordinary unsigned write instead of breaking chat/goal persistence.

The attestation key is domain-separated from the stable installation brain-operations capability root; agent engines, harnesses, MCP, dashboards, and COSMO receive only the derived authority key. Missing or invalid keys fail closed without breaking ordinary reads or writes. Existing nodes are never bulk-signed merely because their old metadata claimed authority. The first audit reports `attestation_missing`; later adoption requires revalidation against the real user turn, verifier, artifact, or worker lifecycle event.

Signing is policy-gated, not automatic. A correction is signed only after the one-use authenticated user-turn validator succeeds. A goal-curator lifecycle receipt may close its own `goal:<id>` with a signed worker receipt, but it records an incident only as context and cannot manufacture `verifier:` proof or close that incident. Generic ingest tags, source strings, generated doctrine labels, and ordinary `NetworkMemory.addNode` callers do not auto-sign.

This HMAC is an application-layer integrity boundary against forged or model-generated memory data. It is not claimed to resist arbitrary hostile code executing as the same operating-system user, which could read local installation files. Model/tool/provider child processes have both the authority key and brain-operations capability removed from their inherited environment as defense in depth. A stronger hostile-local-code boundary would require a separately privileged signer or OS-user/process isolation and is outside this retrieval repair; deployment receipts must state this limitation rather than overclaim it.

The result also carries a bounded `sourceChain` containing direct source refs, trace ID, generation method, consolidation source IDs, verification requirements, and closure proof refs when present. A generated node may point to direct evidence, but the generated node itself stays `generated_doctrine` or `narrative`.

### Ranking

One pure scorer is used by all routes. It combines:

- semantic or keyword relevance;
- provenance-class weight;
- domain weight;
- temporal decay;
- current-state and jtr-correction boosts;
- closure handling;
- stored confidence decay;
- a report-only penalty when the source chain contains no direct evidence.

Closed alarm text is penalized as present-tense state. A closure receipt with proof is boosted for a query about resolution, history, or the incident itself. External intake decays aggressively and never outranks a similarly relevant current verified source solely because of activation or physical file order.

The scorer returns an explanation with bounded factor names and values. Retrieval results expose that explanation; callers do not need to infer why an archive item was demoted.

The same authority profile is also applied to legacy active-cluster context and cognition discovery. Recent access alone cannot resurrect project history or external intake into current context, and orphan age cannot turn stale external material into a current anomaly. Discovery computes anomaly sizes from live, authority-eligible IDs rather than raw historical cluster membership.

Source semantic time is distinct from ingest time. When present, `source_event_at`, assertion time, report period, resolution time, or an authority-profile production time takes precedence over feeder/backfill creation time. Rewriting an old conversation or digest today cannot make its claims current.

Closure receipts are evidence, not stale debris. Completion/archive paths must emit the receipt even when no narrative summary is available. Retrieval builds a bounded closure index from explicitly authorized closure references, uses a newer verified closure to suppress or annotate the old open-alarm claim, and keeps the receipt eligible for recurrence/history queries. Goal lifecycle completion/archive proves goal closure only; an incident or source requires its own independently validated verifier evidence.

## ANN Plus Delta Overlay

### Safe coverage rule

An ANN built at revision `R` is usable against current revision `C` when all are true:

- the source is native manifest-v1;
- ANN and source generation match;
- `baseRevision <= R <= C`;
- the active committed delta is contiguous from `baseRevision + 1` through `C`;
- the ANN metadata revision equals `R`;
- the ANN metadata declares the exact current `home23.ann-authority-projection.v1` schema;
- the ANN metadata's non-secret authority-verifier key ID exactly matches the current verifier context;
- the source reader can identify every node upsert and tombstone in the active delta.

The authority-projection schema is distinct from the ANN file-format `version`.
Metadata created before authenticated authority projection has no schema declaration
and must never be reused or loaded as a trusted label source. A future projection
change likewise requires an exact schema match, forcing rebuild instead of silently
reinterpreting old correction or closure labels under newer trust rules.

The active delta overlay may contain changes before `R`. Suppressing and rescanning every distinct node changed since `baseRevision` is conservative but correct: it can do extra bounded work, but it cannot serve an obsolete ANN label.

### Search algorithm

For an eligible stale ANN:

1. Load/search the pinned ANN.
2. Drop each ANN hit whose node ID appears in the active delta node-change set.
3. Semantically score the current versions of all delta node upserts.
4. Treat delta node tombstones as suppression-only.
5. Merge ANN and overlay candidates through the same authority scorer.
6. Search bounded ANN labels plus current delta nodes for keyword supplementation using the same scorer.
7. Use a logical full-source scan only when ANN/metadata is unavailable, incompatible, corrupt, or when bounded label coverage cannot prove an exact requested match. Report that route and latency explicitly.

The response reports:

- `retrievalMode`: `semantic-ann`, `semantic-ann-delta-overlay`, `keyword-index-overlay`, or `logical-source-scan`;
- indexed revision, current revision, and covered-through revision;
- total committed delta records and distinct changed/upserted/removed node counts;
- stage timings for source open, embedding, ANN load/search, overlay scoring, keyword scoring, merge, and response;
- fallback reason and completeness when a full scan is used.

`indexWatermark.fresh` continues to mean exact revision equality. A separate `indexCoverage.complete` means ANN plus the verified overlay covers current logical truth. Source health remains healthy for a complete verified overlay; it becomes degraded only when a less-preferred but complete fallback is used, and unavailable when authority cannot be established.

### Builder publication

The builder pins generation and revision `R`, writes immutable revisioned ANN files, and publishes them if:

- generation is unchanged;
- current revision has not moved behind `R`;
- the current manifest still has a contiguous active delta capable of covering from the base through its current revision;
- publication does not regress an already newer ANN watermark.

This changes the current compare-and-swap from “publish only if no write happened during the multi-minute build” to “publish the exact index revision and let the verified delta cover later writes.” A superseded concurrent build exits with a typed non-success outcome and removes only its own files.

The wrapper must distinguish `fresh`, `overlay-covered`, `rebuilt-overlay-covered`, and failure. It exits nonzero when an attempted build cannot publish or validate coverage. Its structured receipt includes per-stage duration and gap size. Alerting is based on a configurable sustained coverage failure or excessive overlay size across consecutive runs, not one transient revision of lag.

## Archive Hygiene and Compost

Domain classification is applied immediately at retrieval and projected into all newly built ANN labels. A provenance sweep can persist the same classifications onto existing nodes, but retrieval never waits for the sweep.

Recurring digests/timelines are eligible for existing consolidation compost only when:

- a durable summary node exists;
- the summary records exact source-node lineage;
- a dry-run receipt exists;
- source identities still match at apply time;
- direct artifacts, jtr corrections, current state, and closure proof nodes are excluded.

The first rollout runs classification and compost in dry-run mode only. Any destructive compost apply remains a separate explicit operator action after the receipt is reviewed.

## Provenance Sweep

The sweep is a bounded CLI/service over a pinned own-brain source. It selects high-activation operational candidates, projects domain/provenance/source-chain metadata, and emits a durable dry-run report with counts and sampled before/after records. Apply mode requires the dry-run receipt, own-brain authority, an unchanged generation/revision, and compare-and-swap node identities. It patches metadata only; it does not rewrite content, delete nodes, change embeddings, or modify cluster IDs.

Report-only operational claims with no direct source ref are marked `authorityStatus: quarantine_pending_verification`. This is a ranking quarantine, not deletion. Source-backed claims are promoted only to the class justified by their direct evidence.

## Consumers

The shared memory-search response remains the authority for dashboard brain search, agent brain tools, MCP query/search, automatic context enrichment, Query, and PGS when those consumers use resident or completed-brain retrieval. Adapters must preserve the evidence envelope rather than substitute their own provider/model or retrieval status. Query/PGS pins retain the exact source revision used at operation start; their displayed evidence uses the same domain, provenance, source-chain, and index-coverage fields.

Query and PGS must compute authenticated authority from the raw validated node before provider redaction, while exposing only attestation-bound claim fields for authenticated records. PGS persists that compact provider authority with an integrity MAC bound to node ID, sanitized record bytes, source revision/descriptor, and projection version. Missing keys demote safely to a narrative projection; they do not make old sweeps unreadable. Requested PGS scope completion is reported separately from unavailable ANN/index coverage, and durable pre-authority sweeps migrate in bounded, checkpointed, cancellable pages without discarding completed work.

PGS attempt scopes are transient execution metadata, not durable sweep results. A single compact retained policy carries the monotonic level or targeted-union rule and at most one mapping per work unit across continuations; batch scopes are released after use and stale historical attempts are compacted on reopen. The operation loop retains only cumulative numeric counters plus the current bounded batch/concurrency window, never cumulative selected, failed, or retryable ID collections. Completed sweep rows remain durable and reusable independently of that compaction.

When ANN cannot be trusted or used, native logical retrieval performs exactly one streaming authority-index pass and one combined semantic/keyword scoring pass. Semantic and exact-keyword fallback must share those passes; neither route may independently decompress and rescan the complete brain.

The dashboard state summary reads cluster count from the selected manifest summary. A missing field in an optional snapshot must not turn a known nonzero cluster count into zero.

## Acceptance

Deterministic fixtures and a live canary suite must prove:

1. A recent verified state claim outranks an old archive item with similar text.
2. A jtr correction outranks the superseded claim it corrects.
3. A closure receipt ranks above stale active-alarm text and displays proof/status as closed.
4. An old external/news/X item remains retrievable but ranks below the first three.
5. A stale ANN plus contiguous delta returns a new/updated delta node, suppresses a tombstoned ANN hit, performs no base semantic scan, and reports complete overlay coverage.
6. A builder can publish revision `R` when current advances to `C` during the build, but cannot regress a newer ANN.
7. Corrupt/gapped delta evidence refuses overlay coverage and reports a typed full-scan fallback or unavailable source.
8. Generated synthesis without direct refs cannot claim present-tense operational authority.
9. Dashboard, MCP, agent tools, Query, and PGS preserve the same evidence fields.
10. Live wait-aware probes complete against Jerry and Forrest without short client deadlines; no broad PM2 command is used.
11. A raw node with a complete-looking provenance schema and matching self-declared refs remains narrative and cannot close or supersede.
12. A valid attestation copied to another durable ID, or modified in any authority-bearing field, fails verification.
13. Authenticated user-turn correction and goal-lifecycle writers sign only after their real validation boundary; generic ingest and ordinary graph callers remain unsigned.
14. Goal completion/archive closes the goal but cannot close a merely related incident or manufacture verifier proof.
15. Model-controlled shell, file-search, cron-exec, and ACP subprocesses inherit neither the authority key nor the brain-operations capability key, and tests/receipts never print either value.
16. Signed arrays and text cannot hide authority after a 64-item or 16 KiB prefix, object-valued refs cannot alias relation targets, and every consumed relation/time alias is either bound or ignored.
17. Caller mutation during an embedding await cannot change the stored signed receipt; external tags, undated replay, ID collisions, and caller vectors cannot promote or retarget authority.
18. ANN metadata without the exact current authority-projection schema is rejected by both fresh builder reuse and dashboard loading before its labels become trusted; a current rebuild writes the schema explicitly.
19. ANN metadata built under a missing or different authority-verifier key context is never trusted; retrieval falls back to a complete logical source scan with an explicit reason.
20. PGS authority storage rejects forged classes, copied authority between node IDs, and changed sanitized node bytes; missing-key transitions remain readable but narrative.
21. Query/PGS ignore post-signature text and unknown metadata for authenticated relevance/provider claims, redact local paths, and report final requested-scope success/pending counts separately from index completeness.
22. One thousand repeated PGS attempts remain bounded to one compact policy plus active scope, and a native missing-ANN fallback reads the logical node source exactly twice rather than four times.

## Rollout and Safety

Implementation lands index/overlay first, then authority ranking, then provenance projection/sweep. Focused tests precede broad tests. Live data is read-only through development. Before any sweep apply or compaction, create and verify a coherent backup and retain the dry-run receipt. Runtime restart is scoped to processes that load changed code; ANN files and manifest pins do not require a dashboard restart when their loader observes a new immutable pin. Activating authority attestation requires regenerating the ignored local ecosystem config and a controlled restart of both agent engines, harnesses, MCP services, dashboards, and COSMO so every signer and verifier has the same derived key. A dashboards-plus-COSMO restart alone is explicitly insufficient; missing-key processes remain safely unsigned until the complete scoped rollout.
