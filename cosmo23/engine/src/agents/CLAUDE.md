# CLAUDE.md — Agent System (engine/src/agents/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 agent subsystem.

---

## Overview

Every agent is a subclass of `BaseAgent` (`base-agent.js`). `AgentExecutor` (`agent-executor.js`) is the single point of control for spawning, executing, and integrating agent results. `AgentRegistry` (`agent-registry.js`) tracks live and historical state. `AgentResultsQueue` (`results-queue.js`) persists results to `coordinator/results_queue.jsonl`.

---

## Agent Executor — Spawn Flow

`spawnAgent(missionSpec)` is the single entry point. Returns `agent.agentId` immediately; execution is async.

### Check sequence:
1. **Concurrency guard:** `registry.canSpawnMore(maxConcurrent)`. Strategic/urgent goals bypass this.
2. **Goal dedup:** `registry.isGoalBeingPursued(goalId)` — rejects if already active.
3. **SpawnGate evaluation:** Memory similarity (≥0.9 cosine) and results queue similarity (≥0.55 Jaccard). See spawn-gate details below.
4. **IDE-First routing:** When `config.ideFirst.enabled`, all types except `research` and `consistency` are remapped to `ide`.
5. **Agent class lookup:** Unregistered type logs error with all registered keys, returns null.
6. **Mission enrichment:** `enrichMissionWithArtifacts()` discovers predecessor task artifacts.
7. **Resource injection:** memory, goals, messageQueue, mcp, pathResolver, frontierGate, capabilities, clusterStateStore.
8. **Fire-and-forget execution:** `executeAgentAsync(agent)` — not awaited.

### `agent.run()` lifecycle (BaseAgent):
1. Status → `running`, emit `start`
2. `onStart()` hook
3. `Promise.race([execute(), timeoutPromise(maxDuration)])` — default 5 min
4. On success: status → `completed`, `onComplete()`, `buildFinalResults()`
5. `assessAccomplishment()` — if zero substantive output, status → `completed_unproductive`

---

## Complete Agent Catalog

| Agent Class | Type Key | Purpose |
|---|---|---|
| `ResearchAgent` | `research` | Web search, code analysis via MCP, synthesizes findings. NOT remapped by IDE-First. |
| `AnalysisAgent` | `analysis` | Multi-perspective deep analysis; randomly selects 3 of 13 frameworks per run |
| `SynthesisAgent` | `synthesis` | Writes structured synthesis reports; handles final deliverable assembly when `isFinalSynthesis` |
| `ExplorationAgent` | `exploration` | Creative lateral thinking; 3 exploration vectors + cross-vector connections |
| `PlanningAgent` | `planning` | Decomposes goals into 3–7 sub-goals with topological sort |
| `IntegrationAgent` | `integration` | Finds patterns/contradictions across recent agent work (4-hour lookback) |
| `QualityAssuranceAgent` | `qualityassurance` | Validates agent outputs before memory integration. Never QA-checks itself. |
| `IDEAgent` | `ide` | Multi-turn agentic LLM loop with tool calls. COSMO's "motor cortex." |
| `CodeCreationAgent` | `codecreation` | Generates code files; plan-mode by default; local or container execution |
| `CodeExecutionAgent` | `codeexecution` | Runs Python in containers or locally; persistent validation tracking |
| `CodebaseExplorationAgent` | `codebaseexploration` | READ-ONLY codebase audit: architecture, deps, quality, patterns |
| `DocumentCreationAgent` | `documentcreation` | Business/technical docs; 25+ templates; Markdown/HTML output |
| `DocumentAnalysisAgent` | `documentanalysis` | Document comparison, evolution tracking, metadata extraction |
| `DocumentCompilerAgent` | `documentcompiler` | Dual-substrate compilation: narrative + technical specification |
| `SpecializedBinaryAgent` | `specializedbinary` | Text extraction from PDF, DOCX, XLSX, .gz files |
| `ConsistencyAgent` | `consistency` | Branch divergence evaluation. NOT remapped by IDE-First. |
| `ExperimentalAgent` | `experimental` | Local OS autonomy; requires user approval; hard limits: 900s/200 actions (Deprecated — replaced by AutomationAgent) |
| `CompletionAgent` | `completion` | Oversight and completion validation; human-in-the-loop review |
| `DataAcquisitionAgent` | `dataacquisition` | Web scraping, API consumption, file downloading, feed ingestion. CLI-first, tool-composing. |
| `DataPipelineAgent` | `datapipeline` | ETL, database creation (SQLite/DuckDB), validation, export. Transforms raw data into structured knowledge. |
| `InfrastructureAgent` | `infrastructure` | Container management, service setup, environment provisioning. Docker, compose, venv, nvm. |
| `AutomationAgent` | `automation` | General-purpose OS automation, file operations, process management. Graduated safety model. Replaces ExperimentalAgent. |

---

## Agent Interface / Contract

### Required: `async execute()` — must be overridden

### Optional hooks:
- `onStart()`, `onComplete()`, `onError(error)`, `onTimeout()` — lifecycle
- `assessAccomplishment(executeResult, results)` — override for domain-specific validation
- `generateHandoffSpec()` — override for handoff chaining (ResearchAgent does this)

### Agent ID format:
`agent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

### Status state machine:
`initialized → running → completed | completed_unproductive | failed | timeout | stopped`

### Injected properties (all null at construction):
`memory`, `goals`, `messageQueue`, `mcp`, `external`, `pathResolver`, `frontierGate`, `capabilities`, `clusterStateStore`

### Memory methods (inherited from BaseAgent):
- **Write:** `addFinding(content, tag)`, `addInsight(content, tag)` — quality-gated, embedded, journaled to JSONL
- **Read:** `exploreMemoryConnections()`, `getKnowledgeDomain()`, `getHotTopics()`, `getRecentInsights()`, `traverseKnowledgeGraph()`
- **Communicate:** `reportProgress(percent, message)`, `sendMessage(to, type, payload)`

---

## Research Agent Specifics

### Intent Detection
Verification missions (contain `verify`/`check if`, 6+ words, no survey words) require `mission.intake.claim` with ≥10 chars or return `needs_intake`.

### Execution Branches
1. Code analysis + MCP → `readFilesForAnalysis()` or `scanFilesystem()` first
2. Web research (default) → `generateResearchQueries()` → `performWebSearch()` per query → `synthesizeFindings()`

### Corpus Export
Writes to `outputs/research/<agentId>/`: `research_findings.json`, `sources.json`, `bibliography.bib`, `synthesis.md`

### Handoff
`generateHandoffSpec()` returns spec targeting `ide` (IDE-First) or `synthesis` with `artifactRefs`, `topFindings`, `followUpGoals`, `sourceUrls`. Triggers `HANDOFF_REQUEST` to meta_coordinator.

---

## IDE Agent Specifics

### Safety Boundaries
- Denied paths: `.git`, `node_modules`, `.env`, `*.pem`, `*.key`, `secrets/`, `.credentials`
- Blocked commands: `rm -rf /`, `sudo`, `chmod 777`, `curl|sh`, `wget|sh`, fork bombs
- Limits: 5MB read, 1MB write, 50 files, 25 iterations, 150 tool calls

### Execute — 4-Phase Agentic Loop
1. **Context gathering** via MCP (knowledge, strategy, overlap, system mode, prior artifacts)
2. **Initialize conversation** with system prompt (COSMO motor cortex identity)
3. **Agentic loop:** LLM call → tool calls → track progress → stuck detection (3 no-write iterations)
4. **Finalization:** `summary.md`, `operations.jsonl`, `.complete` marker

Model: `config.ide.model || 'gpt-4.1'` (NOT `gpt-5.2`).

Pre-planned actions shortcut: `mission.metadata.prePlannedActions` bypasses the agentic loop.

---

## Execution Agent Layer

### ExecutionBaseAgent (`execution-base-agent.js`)

Shared base class for all execution agents. Extends `BaseAgent` with:

- **Bash execution** — `executeBash(command, options)` with blocked pattern detection, timeout, output capture
- **Python runtime** — `executePython(script, options)` with package management
- **Filesystem ops** — sandboxed `readFile()`, `writeFile()`, `listDirectory()`
- **HTTP** — `httpFetch(url, options)` via curl subprocess
- **SQLite** — `sqliteExec(dbPath, sql)` via sqlite3 CLI
- **Package management** — `installPackage(name, manager)` scoped to workspace

**Agentic execution loop:** `runAgenticLoop(systemPrompt, context)` — LLM → tool calls → execute → evaluate → iterate. Same pattern as IDEAgent but generalized for CLI-first execution.

**Safety:** sandbox enforcement, blocked command patterns (same as IDEAgent), resource limits (bytes, files, commands), full audit trail.

**Extended timeout:** 15-30 min (vs 5 min default for cerebral agents).

**Abstract methods (subclasses must override):** `getAgentType()`, `getDomainKnowledge()`, `getToolSchema()`

### Agent Differentiation

Execution agents share the same code infrastructure. Their differentiation is in **domain knowledge** — the system prompt that tells the LLM what tools to reach for and what strategies to use. This is CLI-first: agents compose existing tools (curl, jq, sqlite3, playwright, etc.) rather than using hardcoded domain logic.

### DataAcquisitionAgent Specifics

- **Domain knowledge:** 9 scraping tools (curl, wget, playwright, scrapy, cheerio, etc.), API pagination patterns, rate limiting, robots.txt, JS rendering detection
- **Output:** `outputs/data-acquisition/<agentId>/` — manifest.json, raw/, extracted/, sources.json, crawl-log.jsonl
- **Handoff:** → `datapipeline` with discovered schema and artifact paths

### DataPipelineAgent Specifics

- **Domain knowledge:** jq, csvkit, pandas, miller, sqlite3, duckdb, schema inference, ETL patterns, validation
- **Output:** `outputs/data-pipeline/<agentId>/` — manifest.json, database.sqlite, schema.sql, transforms/, validation-report.json, exports/
- **Handoff:** → `analysis` or `synthesis` with database paths and schema

### InfrastructureAgent Specifics

- **Domain knowledge:** docker, compose, podman, venv, nvm, nginx, redis, postgres, health checks, port management
- **Output:** `outputs/infrastructure/<agentId>/` — manifest.json, config/, docker-compose.yml, teardown.sh
- **Handoff:** → any agent that needs the provisioned infrastructure

### AutomationAgent Specifics

- **Replaces ExperimentalAgent** with graduated safety (non-destructive: free, destructive: approval required)
- **Domain knowledge:** osascript, rsync, find, tar, cron, launchd, file management, process management
- **GUI capabilities:** mouse, keyboard, screenshot via LocalExecutor controllers (macOS only)
- **Output:** `outputs/automation/<agentId>/` — manifest.json, operations.jsonl, artifacts/

### Capability Manifest

`engine/src/execution/capability-manifest.js` — structured JSON description of execution agent capabilities injected into all coordinator LLM prompts. Coordinators use this to decide when to dispatch execution vs cerebral agents.

### Tool Discovery

`engine/src/execution/tool-discovery.js` — runtime discovery of tools via npm/pip/GitHub search. Agents can install packages scoped to the run workspace when they need a tool that isn't pre-installed.

---

## Result Integration

`processCompletedResults()` called by orchestrator each cycle:

1. QA gate (fail-closed, min confidence 0.7)
2. Goal progress update (+0.5 for completed agents)
3. CodeCreation → writes output dir to goal metadata for downstream CodeExecution
4. Handoff → pushes `HANDOFF_REQUEST` to message queue
5. Insight broadcasting to all agents
6. Deliverable handling → verify file exists, record in goals, broadcast
7. Task artifact registration in ClusterStateStore with semantic kind classification
8. Semantic edges: `EXECUTED_BY` (task→agent), `PRODUCED` (agent→deliverable)
9. Follow-up goals injection
10. Review pipeline artifact update

### QA Gate
- Failed/timeout → reject
- QA agents → auto-pass (prevents recursion)
- No findings → pass with 0.8 confidence
- Full check: finding length, specificity, count → must score ≥ 0.7

---

## Spawn-Time Dedup (SpawnGate)

**File:** `engine/src/core/spawn-gate.js`

Mission key: `[description, sourceScope, expectedOutput, originalAgentType].join(' | ')`

Two parallel checks:
- **Memory:** cosine similarity ≥ 0.9 against top-8 memory query results
- **Results:** Jaccard similarity ≥ 0.55 against productive historical results

On block: annotates task/goal with evidence, `spawnAgent()` returns null. Strategic/urgent missions bypass concurrency only, NOT SpawnGate.

---

## Output Directory Convention

```
<pathResolver.getOutputsRoot()>/<normalizedType>/<agentId>/
```

Type normalization: `codecreation`→`code-creation`, `codeexecution`→`code-execution`, `documentcreation`→`document-creation`, `documentanalysis`→`document-analysis`, `qualityassurance`→`quality-assurance`, `codebaseexploration`→`codebase-exploration`

---

## Testing

```bash
cd engine

# Structural validation only — no API keys, fast
npm run test:agents

# End-to-end execution — requires OPENAI_API_KEY, 2 min timeout
npm run test:agents:execution

# Single test
npx mocha tests/agents/agent-structure-validation.test.js --timeout 10000
```

Structure validation checks: instantiation, agentId format (`/^agent_\d+_[a-z0-9]+$/`), status = `initialized`, lifecycle methods exist, results/errors are empty arrays.

### Minimal test config:
```javascript
const config = {
  logsDir: 'runtime',
  architecture: { memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } } }
};
const mission = { goalId: 'test', description: 'Test', agentType: 'test', successCriteria: ['Test'], maxDuration: 60000 };
const logger = { info: ()=>{}, warn: ()=>{}, error: ()=>{}, debug: ()=>{} };
```

---

## Key Config Paths

| Config | Used By | Default |
|---|---|---|
| `coordinator.maxConcurrent` | AgentExecutor | 2 |
| `ideFirst.enabled` | AgentExecutor | false |
| `coordinator.qualityAssurance.enabled` | AgentExecutor | true |
| `coordinator.qualityAssurance.minConfidence` | AgentExecutor | 0.7 |
| `ide.model` | IDEAgent | `gpt-4.1` |
| `ide.maxIterations` | IDEAgent | 25 |
| `ide.maxToolCalls` | IDEAgent | 150 |
| `ide.maxReadSize` | IDEAgent | 5MB |
| `ide.maxWriteSize` | IDEAgent | 1MB |
| `ide.maxFilesModified` | IDEAgent | 50 |
| `models.enableWebSearch` | ResearchAgent | — |
| `models.strategicModel` | SynthesisAgent, PlanningAgent | `gpt-5.2` |
