# Step 25 - COSMO23 Artifact Loop Code Map

This is the Phase 0 reconnaissance deliverable for
`STEP25-COSMO23-GRAPH-NATIVE-ARTIFACT-LOOP-PLAN.md`.

## File Writers

- `cosmo23/engine/src/agents/base-agent.js`
  - `writeFileAtomic()` is the main agent helper used by research and code agents.
  - It already carries `agentId`, `agentType`, `missionGoal`, and `taskId` into capabilities writes.
- `cosmo23/engine/src/core/capabilities.js`
  - `writeFile()` and `appendFile()` now register durable `/outputs/` files with the artifact loop when available.
  - `writeFile()` enforces read-before-write when a lineage packet declares required artifacts.
- `cosmo23/engine/src/agents/ide-agent.js`
  - `writeFileWithGuards()` writes directly with `fs.writeFile()`.
  - It tracks product files in `modifiedFiles`, which historically did not become canonical task artifacts.
- `cosmo23/engine/src/agents/research-agent.js`
  - Writes `findings.jsonl`, `research_findings.json`, `research_summary.md`, `sources.json`, and `bibliography.bib` through `writeFileAtomic()`.
- `cosmo23/engine/src/agents/synthesis-agent.js`
  - Writes synthesis outputs and manifest-style files.
- `cosmo23/engine/src/agents/document-compiler-agent.js`
  - Packages artifacts into documentation bundles.
- `cosmo23/lib/query-engine.js` and `cosmo23/engine/src/dashboard/query-engine.js`
  - Write exported query artifacts and action logs.
  - Both QueryEngine copies now register Query exports and query-created files.

## Task Closure Points

- `cosmo23/engine/src/core/orchestrator.js`
  - Acceptance validation queues `COMPLETE_TASK`.
  - The completion event previously carried `artifactCount` but not durable artifact IDs.
- `cosmo23/engine/src/cluster/task-state-queue.js`
  - Serializes task state events.
  - `COMPLETE_TASK` now forwards artifact closure lists to the state store.
- `cosmo23/engine/src/cluster/cluster-state-store.js`
  - Facade for task completion.
- `cosmo23/engine/src/cluster/backends/filesystem-state-store.js`
  - Filesystem task state backend.
- `cosmo23/engine/src/cluster/backends/redis-state-store.js`
  - Redis task state backend.

## Queue And State Persistence

- `TaskStateQueue` persists events to `coordinator/task_state_queue.jsonl`.
- `FilesystemStateStore` persists tasks as `tasks/{taskId}.json`.
- `RedisStateStore` persists task JSON through Redis keys.
- The Step 25 change keeps existing task fields compatible and adds:
  - `consumedArtifacts`
  - `producedArtifacts`
  - `updatedArtifacts`
  - `supersededArtifacts`
  - `promotedArtifacts`
  - `deprecatedArtifacts`
  - `failedArtifacts`
  - `artifactClosure`

## Graph Write APIs

- `cosmo23/engine/src/memory/network-memory.js`
  - `addNode()` creates memory graph nodes.
  - `addEdge()` creates typed edges.
  - Step 25 adds graph-native artifact edge types such as `TASK_PRODUCED`, `AGENT_PRODUCED`, and `ARTIFACT_DERIVED_FROM`.
- `cosmo23/engine/src/artifacts/artifact-registry.js`
  - New artifact registry substrate.
  - Creates artifact records and best-effort structured graph nodes.
  - Selects current reusable artifacts for a mission topic from committed, reused, parsed, and candidate registry records while excluding superseded/deprecated artifacts.
- `cosmo23/engine/src/artifacts/artifact-ingestor.js`
  - Parses supported output files into structured claims, sources, open questions, and reuse contracts.
  - Assigns deterministic claim IDs and writes artifact-to-claim support edges when memory is available.
- `cosmo23/engine/src/artifacts/artifact-audit.js`
  - Reports unregistered, orphaned, unparsed, parsed, committed, reused, current, superseded, and never-reused artifacts.
  - Reports completed tasks that still have no produced artifact IDs.
- `cosmo23/engine/src/artifacts/artifact-migration.js`
  - Registers existing output files without inventing task or producer lineage.
  - Binds historical completed tasks to registered artifacts only when the task declared the exact expected output path.
- `cosmo23/engine/src/artifacts/artifact-lifecycle.js`
  - Records lifecycle transitions, causal reuse, `TASK_CONSUMED`, and supersession state/edges.
- `cosmo23/engine/src/artifacts/artifact-loop-verifier.js`
  - Runs an isolated closed-loop verification: create, register, parse, select, lineage packet, read-before-write, reuse, promote, audit, and graph-edge check.
- `cosmo23/engine/scripts/artifact-loop.js`
  - Operator entrypoint for `audit`, `migrate`, `verify`, `transition`, `promote`, and `supersede`.

## Memory Retrieval APIs

- `cosmo23/engine/src/agents/agent-executor.js`
  - `gatherPredecessorArtifacts()` builds predecessor artifact context.
  - Step 25 changes it to read task artifact lineage before falling back to memory tag scraping.
  - `gatherCurrentReusableArtifacts()` adds current committed/reused/parsed registry artifacts for the mission topic when direct predecessor artifacts are absent.
- `cosmo23/engine/src/coordinator/context-providers.js`
  - Existing context providers include artifact-oriented context.
- `cosmo23/engine/src/agents/mcp-bridge.js`
  - Exposes task/artifact surfaces to agents.

## Introspection Modules

- `cosmo23/engine/src/system/introspection.js`
  - Current introspection creates text preview memory nodes.
  - This remains a follow-up target for structured artifact ingestion.

## Agent Context Builders

- `cosmo23/engine/src/agents/agent-executor.js`
  - Enriches missions with predecessor artifacts.
  - Enriches missions with current reusable artifact substrate selected from the registry.
  - Injects artifact context into `mission.description` once so all agent types see lineage artifacts.
- `cosmo23/engine/src/agents/base-agent.js`
  - Builds mission context and uploads predecessor artifacts where needed.
- `cosmo23/engine/src/agents/ide-agent.js`
  - Builds IDE prompt context from MCP, memory, and artifacts.

## Known Output Directories

- `outputs/research/{agentId}/`
- `outputs/ide/{agentId}/`
- `outputs/code-creation/{agentId}/`
- `outputs/code-execution/{agentId}/`
- `outputs/document-analysis/{agentId}/`
- `outputs/document-compiler/{agentId}/`
- root-level `outputs/*.md`, `outputs/*.json`, `outputs/*.csv`, and `outputs/*.db`
- `exports/markdown/`
  - Durable query exports are included in audit/migration alongside `outputs/`.

## Producer Identity Sources

- `agentResults.agentId`
- `agentResults.agentType`
- `mission.agentType`
- `BaseAgent.agentId`
- `mission.metadata.originalAgentType`

## Task, Run, And Goal Identity Sources

- `mission.taskId`
- `mission.goalId`
- `task.id`
- `task.metadata.goalId`
- `config.logsDir` basename for run ID

## Risk Points

- IDE agents can write real product files outside conventional per-agent output dirs.
- Task completion can happen after artifact registration but lose artifact IDs if completion events only carry counts.
- Memory introspection can still degrade structured file identity into basename previews.
- Migration must not invent task or producer lineage for old files.
- Current reusable selection is intentionally lexical/metadata-based for now; it should later incorporate graph traversal scores once artifact graph density is higher.

## First Implemented Slice

- New artifact registry persists `coordinator/artifact_registry.json`.
- Agent artifact registration now assigns artifact IDs and hashes.
- Registry lookup APIs exist by artifact ID, path, hash, task ID, producer, and lifecycle state.
- Capabilities writes register durable output artifacts at write time.
- IDE `modifiedFiles` are included as explicit artifact candidates.
- Task closure can persist artifact ID lists.
- Predecessor artifact gathering reads task artifact lineage before semantic memory tags.
- Mission enrichment now also loads current committed/reused/parsed artifact substrate for the mission topic when predecessor tasks are absent.
- Structured ingestion parses common research artifacts into reusable graph-native payloads.
- Claim nodes and `ARTIFACT_SUPPORTS` edges are created from extracted canonical claims.
- Lineage packets are attached to artifact-enriched missions.
- Artifact context is visible through generic `mission.description`, not only helper-aware agents.
- Audit and migration helpers exist for historical run cleanup.
- Lifecycle transitions and supersession are implemented and tested.
- Consumed lineage artifacts are persisted on task records and receive reuse lifecycle credit when the task produces new artifacts.
- Reused artifacts get `TASK_CONSUMED` graph edges from the consuming task.
- Promotion to `committed` is gated on causal reuse or validation evidence.
- Validated primary/deliverable-style produced artifacts can now be promoted to `committed` automatically using existing QA evidence.
- Read-before-write is enforced for durable Capabilities writes with required lineage artifacts.
- `labor23` migration scanned 230 durable output/export files, registered 230, failed 0, and left 0 unregistered files. Two historical tasks were bound from exact declared output paths; remaining unbound artifacts/tasks preserve uncertainty rather than invented lineage.
- Historical task binding is allowed only from explicit task-declared output paths such as `metadata.expectedOutput` or `metadata.deliverableSpec`.
- `node cosmo23/engine/scripts/artifact-loop.js verify` exercises a fresh isolated closed-loop substrate path and writes `artifact_loop_verification_report.json`.
- `labor23` audit report was written to `cosmo23/runs/labor23/coordinator/artifact_audit_report.json`.
- Focused tests cover registry identity, current reusable artifact selection, mission enrichment from committed artifacts, QA-backed promotion, task closure artifact persistence, structured ingestion, lineage packets, completed-task artifact audits, migration, and the closed-loop verifier.
