# Step 26 - Home23 Graph-Native Artifact Loop

Home23 now has a graph-native artifact substrate for Jerry and sibling agents. This repurposes the COSMO23 Step 25 artifact-loop pattern for the inward Home23 engine: durable outputs, memory promotions, and predecessor reuse are registered as artifacts and linked back into the memory graph.

## Blueprint References

- `docs/design/STEP25-COSMO23-GRAPH-NATIVE-ARTIFACT-LOOP-PLAN.md` - source plan for the artifact loop mechanics.
- `docs/design/STEP25-COSMO23-ARTIFACT-LOOP-CODE-MAP.md` - source code map for COSMO23 implementation boundaries.
- `engine/src/artifacts/` - Home23 engine-native implementation.

## Implemented Task List

- Add a Home23 artifact registry:
  - `engine/src/artifacts/artifact-registry.js`
  - Persists `home23.artifacts.v1` records under `<brain>/artifacts/artifact-registry.json`.
  - Supports file artifacts and memory-promotion artifacts.
  - Records producer, agent, goal, task, status, hash, preview, lineage, supports, and reuse.

- Add artifact ingestion:
  - `engine/src/artifacts/artifact-ingestor.js`
  - Parses durable text outputs into graph nodes.
  - Links extracted nodes back to artifact mirror nodes with `artifact_contains`.

- Add artifact lifecycle operations:
  - `engine/src/artifacts/artifact-lifecycle.js`
  - Marks artifacts consumed/reused by later missions.
  - Commits promoted outputs.
  - Links supporting artifacts with `artifact_supports`.

- Add artifact audit:
  - `engine/src/artifacts/artifact-audit.js`
  - Cross-checks durable output files against registry records.
  - Reports registered files, memory artifacts, committed artifacts, reused artifacts, missing files, and unregistered files.

- Add a verifier loop:
  - `engine/src/artifacts/artifact-loop-verifier.js`
  - `engine/scripts/artifact-loop.js verify`
  - Proves file artifact creation, ingestion, reuse, support linkage, committed output, memory promotion, and audit pass.

- Wire the substrate into the Home23 engine:
  - `engine/src/core/orchestrator.js`
  - Initializes registry, ingestor, lifecycle, and audit after memory/goals load.
  - Injects artifact services into `AgentExecutor`, Capabilities, and autonomous actions.

- Wire file writes into artifact registration:
  - `engine/src/core/capabilities.js`
  - Successful writes/appends register durable files.
  - Routine capability writes do not mirror into memory unless explicitly requested, preventing append-only logs from flooding the graph.

- Wire agent deliverables and task artifacts:
  - `engine/src/agents/agent-executor.js`
  - Verified deliverables become committed artifacts.
  - Plan-task output scans register artifacts with task and goal provenance.
  - Predecessor artifact gathering now reads both `task.artifacts` and the artifact registry.
  - Mission enrichment marks consumed predecessor artifacts as reused.

- Wire memory promotion:
  - `engine/src/cognition/actions/promote-to-memory.js`
  - `promote_to_memory` now creates a committed memory artifact and graph edge to the promoted node.
  - Action dispatch and thought-action routing pass the artifact registry through.

## Verification

- `node engine/scripts/artifact-loop.js verify`
- `node --test --test-concurrency=1 tests/engine/artifacts/artifact-loop.test.js`
- `node --test --test-concurrency=1 tests/engine/agents/document-creation-agent-path.test.js tests/engine/planning/acceptance-validator.test.js`
- `node --test --test-concurrency=1 tests/engine/cognition/*.test.js`
- `node --test --test-concurrency=1 tests/engine/agents/*.test.js`
- `node --test --test-concurrency=1 tests/engine/core/*.test.js tests/engine/memory/*.test.js`
- `npm run build`
- Live: `home23-jerry` started/restarted only by name and reached cycle 7339.
- Live receipt: `instances/jerry/brain/artifacts/artifact-registry.json` exists with schema `home23.artifacts.v1`.
