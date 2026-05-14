# Step 25 - COSMO23 Graph-Native Artifact Loop Plan

## Blueprint Sources

This plan is a reference checklist for implementing the next COSMO23 substrate layer:
turning run outputs into durable, graph-native state that future loops can inherit,
reuse, revise, supersede, and promote.

Treat these query exports as the real blueprint:

- `cosmo23/runs/labor23/exports/markdown/query_2026-05-10T13-55-05_so_The_loop_creates_real_value_during_the_run__but.md`
  - Establishes the diagnosis: COSMO23 can think, connect, infer, and generate, but it does not consistently close the loop from thought to file to artifact record to graph node to future input.
  - Defines the missing productivity loop as create, register, semantically extract, graph-link, close task, retrieve by lineage, reuse, update or supersede, and promote only after causal use.
- `cosmo23/runs/labor23/exports/markdown/query_2026-05-10T13-59-36_so_put_that_into_a_plan_outline_fully_for_use_by_a.md`
  - Converts the diagnosis into an agent-executable implementation plan.
  - Defines the main work areas: artifact identity, commitment compilation, state-binding continuity, lineage-first reuse, lifecycle-gated promotion, migration, audit, and end-to-end validation.

The implementation rule is:

```text
Do not build a better archive. Build a state transition system.
```

## Reference Task List

Use this as the operator checklist. The phase details below remain the fuller
implementation notes; this list is the task spine tied back to the two query
exports.

- Phase 0 - map the mechanics before changing behavior.
  - Locate durable writers, task closure paths, queue/state persistence, graph APIs, memory retrieval, introspection, context builders, output directories, and producer identity sources.
  - Output: `docs/design/STEP25-COSMO23-ARTIFACT-LOOP-CODE-MAP.md`.
  - Blueprint: Query 13:59 Phase 0; Query 13:55 diagnosis of the broken thought-to-output-to-reuse loop.
- Phase 1 - create artifact identity.
  - Add stable artifact records with `artifactId`, run/task/goal binding, producer, path, hash, kind, lifecycle, lineage, supersession, support links, and reuse contract.
  - Add idempotent lookup/update APIs by ID, path, hash, task, producer, and lifecycle state.
  - Blueprint: Query 13:55 Artifact Record; Query 13:59 Phase 1.
- Phase 2 - hook durable writes.
  - Register durable output writes after success, including IDE `modifiedFiles`, research outputs, synthesis outputs, coordinator outputs, reports, and exports.
  - Surface missing bindings as warnings/orphans instead of losing them.
  - Blueprint: Query 13:55 Created File/Deliverable Files/Output Exhaust; Query 13:59 Phase 2.
- Phase 3 - bind artifacts into task closure.
  - Persist consumed, produced, updated, superseded, promoted, deprecated, and failed-reuse artifact IDs on completed tasks.
  - Treat artifact count as telemetry only, not closure truth.
  - Blueprint: Query 13:55 Artifact List/Task Completion; Query 13:59 Phase 3.
- Phase 4 - make the graph causal.
  - Add typed edges for task consumption/production, agent production, artifact derivation, support, supersession, invalidation, and claim support.
  - Ensure artifact traversal can recover work by lineage, not only semantic similarity.
  - Blueprint: Query 13:55 Graph Layer; Query 13:59 Graph Edges.
- Phase 5 - parse artifacts into reusable structure.
  - Extract claims, evidence, source refs, headings, recommendations, open questions, reuse contracts, unresolved dependencies, confidence, and parse warnings from common output formats.
  - Blueprint: Query 13:55 Structured Artifact Node; Query 13:59 Semantic Extraction.
- Phase 6 - make future tasks lineage-first.
  - Build lineage packets with required artifacts, candidates, supersession warnings, read order, and semantic-memory fallback query.
  - Inject artifact context before broad memory retrieval so future agents inherit prior work.
  - Blueprint: Query 13:55 Lineage Packet/Future Input; Query 13:59 State-Binding Continuity and Reuse.
- Phase 7 - enforce reuse before overwrite.
  - Block durable writes when required lineage artifacts are ignored without declaring consumed or explicitly ignored artifacts.
  - Mark consumed artifacts as reused when later work produces new artifacts from them.
  - Blueprint: Query 13:55 Reuse or Supersession; Query 13:59 State-Transition System.
- Phase 8 - add lifecycle and promotion gates.
  - Track registered, parsed, candidate, reused, superseded, deprecated, failed_reuse, and committed states.
  - Allow promotion only after causal reuse or explicit validation evidence.
  - Blueprint: Query 13:55 Promotion Only After Causal Use; Query 13:59 Lifecycle-Gated Promotion.
- Phase 9 - migrate existing runs without pretending.
  - Register old durable outputs and exports with hashes and orphan/missing-lineage warnings.
  - Do not invent task, producer, or derivation lineage for historical files.
  - Blueprint: Query 13:59 Migration; Query 13:55 diagnosis that old run gold is present but not productively bound.
- Phase 10 - audit continuously.
  - Report unregistered files, orphan artifacts, unparsed artifacts, never-reused artifacts, superseded/current counts, and failed promotion/reuse.
  - Blueprint: Query 13:59 Audit; Query 13:55 gap between generated value and reusable substrate.
- Phase 11 - validate end to end.
  - Prove create-register-parse-link-close-retrieve-reuse-supersede-promote across a small run and against `labor23`.
  - Keep Query exports visible to the artifact loop.
  - Blueprint: Query 13:59 Validation Matrix; Query 13:55 target closed loop.

## Target Loop

The intended closed loop is:

```text
thought
  -> file
  -> artifact record
  -> structured artifact node
  -> graph lineage
  -> task closure
  -> lineage packet
  -> future input
  -> reuse or supersession
  -> promotion only after causal use
```

The output layer should stop behaving like exhaust and start behaving like a durable workbench.

## Core Terms

- `Artifact record`: durable identity and metadata for a created file.
- `Structured artifact node`: graph representation of an artifact with claims, evidence, lifecycle, and lineage.
- `Lineage packet`: required prior artifacts, claims, and supersession warnings loaded into a future agent before semantic memory.
- `Reuse contract`: instructions that tell future agents how an artifact should or should not be used.
- `Lifecycle state`: artifact status such as registered, parsed, candidate, committed, reused, superseded, deprecated, or failed_reuse.
- `Promotion`: marking an artifact as durable substrate only after it has proven useful.
- `Supersession`: explicit replacement of older artifacts or claims by newer artifacts.

## Phase 0 - Reconnaissance

Goal: produce a precise code map before implementation.

Tasks:

- Locate every durable file-writing path in `cosmo23/`.
- Locate all uses of `writeFile`, `writeFileSync`, `appendFile`, `createWriteStream`, and output directory writes.
- Locate task completion logic.
- Locate task state queue processing.
- Locate result queue processing.
- Locate artifact counting logic.
- Locate agent result integration logic.
- Locate IDE agent file writing and `modifiedFiles` handling.
- Locate research agent output writing.
- Locate synthesis agent output writing.
- Locate coordinator output writing.
- Locate graph write APIs.
- Locate memory node creation APIs.
- Locate introspection file scanning.
- Locate agent context assembly.
- Locate semantic memory retrieval.
- Locate existing output inventory or export code.
- Identify where run ID, task ID, goal ID, and producer ID are available.
- Identify file-writing paths that lack task or producer context.
- Identify existing tests for task completion, query, PGS, runtime, and agent execution.
- Produce `code_map_artifact_loop.md`.

Required `code_map_artifact_loop.md` sections:

- file writers
- task closure points
- queue/state persistence
- graph write APIs
- memory retrieval APIs
- introspection modules
- agent context builders
- known output directories
- producer identity sources
- task/run/goal identity sources
- risk points

Blueprint reference:

- Query 13:59: Phase 0 - Reconnaissance.

## Phase 1 - Artifact Registry

Goal: create the durable identity layer for output files.

Tasks:

- Add an artifact schema.
- Add artifact persistence under the run state or coordinator state.
- Add `artifactId` generation.
- Add stable lookup by artifact ID.
- Add lookup by path.
- Add lookup by content hash.
- Add lookup by task ID.
- Add lookup by producer.
- Add lookup by lifecycle state.
- Add SHA-256 hash computation.
- Add file size capture.
- Add MIME/type inference.
- Add artifact kind inference.
- Add missing-binding tracking.
- Add orphan artifact state.
- Add registry append/update APIs.
- Add registry read APIs.
- Add idempotent registration behavior.
- Add mutation detection when a registered path hash changes.
- Add tests proving one created file becomes one artifact record.

Minimum artifact fields:

```json
{
  "artifactId": "artifact_<stable_id>",
  "runId": "run_<id>",
  "taskId": "task_<id_or_null>",
  "goalId": "goal_<id_or_null>",
  "producer": {
    "type": "agent|coordinator|tool|system",
    "id": "agent_or_process_id"
  },
  "path": "outputs/example.md",
  "hash": "sha256:<content_hash>",
  "sizeBytes": 0,
  "kind": "unknown",
  "mimeType": "text/markdown",
  "createdAt": "ISO-8601",
  "derivedFrom": {
    "artifactIds": [],
    "memoryNodeIds": [],
    "taskIds": [],
    "claimIds": []
  },
  "supersedes": {
    "artifactIds": [],
    "claimIds": []
  },
  "supports": {
    "claimIds": [],
    "taskIds": []
  },
  "lifecycleState": "registered",
  "reuseContract": null
}
```

Blueprint reference:

- Query 13:55: Artifact Record, artifactId, runId, taskId, producer, path, hash, kind, derivedFrom, supersedes.
- Query 13:59: Phase 1 - Artifact Registry.

## Phase 2 - Write Hook Integration

Goal: no durable output file is silently created without an artifact identity.

Tasks:

- Add a single artifact registration function for durable file writes.
- Register files after successful writes.
- Capture `runId` where available.
- Capture `taskId` where available.
- Capture `goalId` where available.
- Capture producer type and producer ID where available.
- Register IDE agent root-output files from `modifiedFiles`.
- Register research output files.
- Register synthesis output files.
- Register coordinator output files.
- Register generated reports and exports when durable.
- Mark missing bindings explicitly instead of silently dropping them.
- Mark files as `orphan_registered` when identity exists but task/producer binding is incomplete.
- Ensure file write failures do not create successful artifact records.
- Ensure artifact registration failures are surfaced as structured warnings or task closure warnings.
- Add tests for registered and orphan-registered outputs.
- Add an audit check for durable files without artifact records.

Implementation rule:

```text
No durable output file without an artifactId.
```

Blueprint reference:

- Query 13:59: Phase 2 - Write Hook Integration.
- Query 13:55: Created File, Deliverable Files, Agent Output Files, Output Exhaust.

## Phase 3 - Task Closure Binding

Goal: make task completion persist artifact identities, not artifact counts.

Tasks:

- Extend task completion records to include consumed artifacts.
- Extend task completion records to include produced artifacts.
- Extend task completion records to include updated artifacts.
- Extend task completion records to include superseded artifacts.
- Extend task completion records to include deprecated artifacts.
- Extend task completion records to include failed-reuse artifacts.
- Extend task completion records to include promoted artifacts.
- Replace artifact count as authoritative closure.
- Preserve artifact count only as derived telemetry.
- Update task state queue processing so `COMPLETE_TASK` can persist artifact lists.
- Update state store completion APIs to accept artifact lineage.
- Update result integration to pass produced artifact IDs into task closure.
- Add closure validation.
- Mark tasks as `completed_with_artifact_warnings` if files exist but lineage is incomplete.
- Mark tasks as `completed_unbound` if no durable artifact lineage is available.
- Add tests for task completion with artifact IDs.
- Add regression test for the observed failure where completion events carried artifact counts but final tasks had empty artifact arrays.

Task closure should be able to answer:

- Which artifacts did this task consume?
- Which artifacts did this task produce?
- Which artifacts did this task update?
- Which artifacts did this task supersede?
- Which artifacts did this task promote?
- Which artifacts failed reuse?
- Which open dependencies remain?

Blueprint reference:

- Query 13:55: Artifact List, Task Completion.
- Query 13:59: Phase 3 - Task Closure Binding.

## Phase 4 - Graph Edges

Goal: make artifacts causally and evidentially traversable in the graph.

Tasks:

- Add typed artifact edge support where needed.
- Add edge endpoint validation.
- Add `TASK_CONSUMED`.
- Add `TASK_PRODUCED`.
- Add `AGENT_PRODUCED`.
- Add `ARTIFACT_DERIVED_FROM`.
- Add `ARTIFACT_SUPPORTS`.
- Add `ARTIFACT_SUPERSEDES`.
- Add `ARTIFACT_INVALIDATES`.
- Add `TASK_SUPPORTS_CLAIM`.
- Add `CLAIM_SUPPORTED_BY`.
- Add `CLAIM_SUPERSEDED_BY`.
- Add traversal helpers for task to artifacts.
- Add traversal helpers for agent to artifacts.
- Add traversal helpers for artifact ancestry.
- Add traversal helpers for artifact supported claims.
- Add traversal helpers for supersession chains.
- Add tests for `task -> artifact -> claim -> evidence` traversal.
- Add tests proving semantic similarity is not required to recover lineage.

Required minimum edges:

```text
TASK_CONSUMED
AGENT_PRODUCED
ARTIFACT_DERIVED_FROM
ARTIFACT_SUPPORTS
```

Blueprint reference:

- Query 13:55: Graph Edges, TASK_CONSUMED, AGENT_PRODUCED, ARTIFACT_DERIVED_FROM, ARTIFACT_SUPPORTS, ARTIFACT_SUPERSEDES, ARTIFACT_INVALIDATES.
- Query 13:59: Phase 4 - Graph Edges.

## Phase 5 - Structured Ingestion

Goal: convert files into structured artifact nodes, claims, evidence, and reuse instructions.

Tasks:

- Replace shallow basename-preview introspection with structured artifact ingestion.
- Preserve raw files unchanged.
- Create structured artifact nodes linked to artifact records.
- Build a handler for `findings.jsonl`.
- Build a handler for `research_findings.json`.
- Build a handler for `research_summary.md`.
- Build a handler for `sources.json`.
- Build a handler for `bibliography.bib`.
- Extract canonical claims.
- Extract supported claims.
- Extract contradicted claims when visible.
- Extract evidence references.
- Extract source references.
- Extract open questions.
- Extract explicit recommendations.
- Extract unresolved dependencies.
- Extract supersession candidates.
- Extract reuse contracts.
- Mark parse failures without blocking artifact registration.
- Add tests for each parser.
- Add tests proving future agents can use structured artifact nodes without reading the entire raw file.

Required extraction object:

```json
{
  "artifactId": "artifact_<id>",
  "kind": "research_summary",
  "canonicalClaims": [],
  "evidenceRefs": [],
  "sourceRefs": [],
  "openQuestions": [],
  "supersessionCandidates": [],
  "reuseContract": {
    "recommendedUse": "candidate_synthesis|source_inventory|evidence_package|committed_verdict|raw_notes",
    "readBefore": [],
    "doNotUseIf": [],
    "supersededBy": null
  }
}
```

Blueprint reference:

- Query 13:55: Commitment Compilation, Structured Artifact Nodes, Introspection, Claim Node, Reuse Contract.
- Query 13:59: Phase 5 - Structured Ingestion.

## Phase 6 - Lifecycle and Supersession

Goal: prevent all artifacts from living forever as equally current.

Tasks:

- Add artifact lifecycle states.
- Add lifecycle transition history.
- Add lifecycle transition API.
- Add lifecycle transition reasons.
- Add lifecycle transition actor identity.
- Add lifecycle transition evidence references.
- Add promotion rules.
- Add supersession resolver.
- Add invalidation resolver.
- Add deprecation behavior.
- Add failed-reuse behavior.
- Add retrieval filtering by lifecycle state.
- Prevent superseded artifacts from appearing as current.
- Keep superseded artifacts available for audit.
- Add current-artifact lookup by topic/task/claim.
- Add tests for every lifecycle transition.
- Add tests for stale-artifact prevention.
- Add tests for supersession warnings in lineage packets.

Lifecycle ladder:

```text
raw
registered
parsed
candidate
committed
reused
superseded
deprecated
failed_reuse
archived
```

Promotion rule:

```text
Every file can be registered.
Only artifacts that are extracted, graph-linked, and causally useful should become durable workbench state.
```

Blueprint reference:

- Query 13:55: Experiment-Gated Promotion, Artifact Lifecycle State, Promote only reused artifacts.
- Query 13:59: Phase 6 - Lifecycle and Supersession.

## Phase 7 - Lineage-First Retrieval

Goal: future agents inherit obligation-bearing artifacts before broad semantic memory.

Tasks:

- Build a lineage packet.
- Load current task lineage.
- Load parent task artifacts.
- Load current committed artifacts for the topic.
- Load supersession chains.
- Load open dependencies.
- Load unresolved claims.
- Load reuse contracts.
- Load semantic memory only after lineage.
- Exclude superseded artifacts from current-state retrieval.
- Add supersession warnings.
- Add read-before-write gate.
- Require agents to declare consumed artifacts before creating new durable artifacts.
- Record ignored required artifacts.
- Record reason if a required artifact is ignored.
- Modify agent handoff payloads to include the lineage packet.
- Add tests comparing lineage-first against semantic-memory-first behavior.
- Add tests for artifact-only reconstruction.

Required context order:

```text
1. Current task lineage
2. Parent task artifacts
3. Current committed artifacts for the topic
4. Supersession chain
5. Open dependencies and unresolved claims
6. Reuse contracts
7. Semantic memory
8. Broad exploratory search
```

Blueprint reference:

- Query 13:55: Lineage-First Reuse, Lineage Packet, Future Agents, Semantic Memory.
- Query 13:59: Phase 7 - Lineage-First Retrieval.

## Phase 8 - Migration and Audit

Goal: bring existing run outputs into the new artifact system without pretending all old files have perfect lineage.

Tasks:

- Walk existing run output files.
- Register all existing durable files.
- Compute hashes for existing files.
- Infer producer from path only when reliable.
- Infer task from path or existing records only when reliable.
- Infer run ID from run directory.
- Mark missing bindings explicitly.
- Mark uncertain links as inferred.
- Run structured ingestion on supported file types.
- Mark unsupported files as registered but unparsed.
- Mark stale or duplicate artifacts where detectable.
- Produce orphan file report.
- Produce unparsed artifact report.
- Produce uncertain-binding report.
- Produce current committed artifact report if possible.
- Add artifact audit CLI.
- Add audit command for unregistered files.
- Add audit command for orphan artifacts.
- Add audit command for never-reused artifacts.
- Add audit command for superseded-but-loaded artifacts.
- Add audit command for task completion without produced artifact IDs.

Migration rule:

```text
Do not invent lineage. Register uncertainty.
```

Blueprint reference:

- Query 13:55: Audit orphan files, Raw File Inventory, Output Exhaust.
- Query 13:59: Phase 8 - Migration and Audit.

## Phase 9 - End-to-End Loop Test

Goal: prove the whole loop works before declaring the schema layer successful.

Tasks:

- Create task A.
- Have task A produce artifact A.
- Register artifact A.
- Parse artifact A.
- Create structured artifact node A.
- Extract claim A.
- Link artifact A to claim A.
- Close task A with artifact A's ID.
- Create task B as a follow-up.
- Load artifact A through the lineage packet before semantic memory.
- Require task B to declare artifact A as consumed.
- Have task B produce artifact B derived from artifact A.
- Register artifact B.
- Link artifact B with `ARTIFACT_DERIVED_FROM`.
- If artifact B revises artifact A, link `ARTIFACT_SUPERSEDES`.
- Close task B with consumed and produced artifact IDs.
- Verify traversal from task B back to artifact A.
- Verify task B did not rediscover artifact A from scratch.
- Verify final query can recover the lineage.

Pass condition:

```text
thought -> file -> artifact record -> graph node -> task closure -> future input works
```

Blueprint reference:

- Query 13:55: Ranked Experiments, especially end-to-end artifact registration and causal artifact use.
- Query 13:59: Phase 9 - End-to-End Loop Test.

## Ranked Validation Experiments

These experiments should be used to prove the schema work is load-bearing.

- Artifact registration smoke test
  - Create one file during a task.
  - Verify one artifact record exists.
  - Verify artifact ID, path, hash, run ID, task ID, producer, and kind.
  - Verify a graph node exists.
  - Verify task completion stores the artifact ID.
- Task closure lineage test
  - Complete a task with consumed and produced artifacts.
  - Verify final task state stores artifact IDs.
  - Verify artifact count is derived, not authoritative.
- Existing output migration audit
  - Register old run outputs.
  - Mark uncertain links explicitly.
  - Report orphaned, unparsed, duplicate, and never-reused files.
- Structured extraction test
  - Parse a `research_summary.md`.
  - Extract claims, evidence, open questions, and reuse contract.
  - Verify future agent context can use the structured node.
- Lineage-first replay test
  - Compare semantic-memory-first against lineage-first on the same continuation task.
  - Measure duplicate reasoning, stale claims, artifact reuse, and closure quality.
- Supersession drill
  - Create a new artifact that replaces an older one.
  - Verify `ARTIFACT_SUPERSEDES`.
  - Verify older artifact is not loaded as current.
- Read-before-write enforcement test
  - Require an agent to declare consumed artifacts before writing.
  - Record ignored required artifacts and reasons.
- Causal artifact use A/B test
  - Compare full memory plus artifacts, memory only, and lineage artifacts only.
  - Verify hiding artifacts degrades work if artifacts are truly load-bearing.
- Lifecycle promotion test
  - Prevent immediate promotion.
  - Promote only after reuse or validator commitment.
  - Track failed reuse and deprecation.
- Artifact-only reconstruction test
  - Ask an agent to reconstruct the current verdict from committed artifacts only.
  - Compare against graph-memory retrieval.
- Hash mutation test
  - Mutate a registered file.
  - Verify hash mismatch and mutation warning.
- Coordinator closure test
  - Verify coordinator does not close tasks cleanly when produced files remain unregistered.

Blueprint reference:

- Query 13:55: Ranked Experiments.
- Query 13:59: Ranked Experiments.

## Agent Work Packages

Use these as implementation assignments.

- Codebase scout
  - Own Phase 0.
  - Deliver `code_map_artifact_loop.md`.
- Registry implementer
  - Own artifact schema, persistence, IDs, hashes, lookup helpers, and registry tests.
- Write-hook integrator
  - Own wrapping durable file writes and registering outputs from agents, tools, and coordinators.
- Task-system implementer
  - Own task completion schema, state queue changes, closure validation, and task-artifact persistence.
- Graph implementer
  - Own typed edges, traversal helpers, claim/artifact links, and supersession edges.
- Ingestion implementer
  - Own structured parsers for common output file types and structured artifact nodes.
- Lifecycle implementer
  - Own lifecycle states, transition history, promotion, supersession, invalidation, and retrieval filters.
- Retrieval implementer
  - Own lineage packets, read-before-write gate, and agent context ordering.
- Migration implementer
  - Own existing output registration, uncertainty marking, audit CLI, and migration report.
- Validation implementer
  - Own end-to-end tests and ranked experiments.

## Non-Goals For The First Pass

- Do not start with dashboard UI.
- Do not optimize for more files.
- Do not treat file path as artifact identity.
- Do not treat artifact count as task closure.
- Do not promote every registered artifact.
- Do not rely on semantic memory as the first source of current state for continuation tasks.
- Do not invent lineage during migration.
- Do not make old artifacts disappear; supersede or deprecate them while preserving auditability.

## Completion Standard

This project is complete only when a future COSMO23 task can:

- inherit required prior artifacts by lineage,
- verify their content hash,
- understand their claims and reuse contract,
- know which artifacts are current versus superseded,
- declare which artifacts it consumed,
- produce new artifacts with durable identity,
- close with actual artifact IDs,
- update or supersede prior artifacts,
- and later prove that those artifacts changed downstream behavior.

The schema is not the destination. The schema is the substrate that lets COSMO23 turn cognition into reusable work.
