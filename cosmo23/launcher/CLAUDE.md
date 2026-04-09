# CLAUDE.md — Launcher & Continue (launcher/)

This file provides guidance to Claude Code (claude.ai/code) when working on the launch and continuation flows in COSMO 2.3.

---

## Quick Orientation

```
launcher/
  config-generator.js     # UI settings → config.yaml + run-metadata.json
  process-manager.js      # spawn/stop engine subprocesses
  run-manager.js          # run directory CRUD + fork/dream-fork logic
server/
  index.js                # Express app, launchResearch(), all HTTP routes
  lib/
    brain-registry.js       # listBrains, resolveBrainBySelector, importReferenceBrain
    brains-router.js        # /api/brains and /api/continue/:brainId routes
    continuation-state.js   # snapshot read/write, settings merge
    run-metadata-repair.js  # boot-time metadata recovery
```

The server and engine share NO in-process state. Communication is file-based (`state.json.gz`, `config.yaml`) and port-based (dashboard, MCP, WebSocket).

---

## 1. Launch Flow End-to-End

`POST /api/launch` → `launchResearch(payload, req)` in `server/index.js`:

1. **Guard:** 409 if `activeContext` is set OR `isLaunching` flag is true (single-tenant: one run at a time)
2. **Brain resolution:** If `brainId` → find existing brain. If reference → `importReferenceBrain()` copies to `runs/`. If no brainId → `sanitizeRunName()` + `createRun()`
3. **Serialize settings:** `serializeLaunchSettings()` maps UI camelCase to snake_case, infers providers from model IDs, normalizes URLs, coerces types
4. **Write config.yaml:** `configGenerator.writeConfig()` to `runs/<name>/config.yaml`
5. **Write metadata:** `run-metadata.json` (engine-facing) + `metadata.json` (UI-facing, camelCase)
6. **Symlink runtime:** `runtime/ → runs/<name>`
7. **Start processes:** MCP server (43147, 1.5s wait) → Dashboard (43144, 1.5s wait) → Engine (`src/index.js`)
8. **Set activeContext:** `{ runName, runPath, brainId, topic, explorationMode, executionMode, effectiveExecutionMode, startedAt, wsUrl }`
9. **Return:** `{ success, runName, brainId, isContinuation, cycles, executionMode, effectiveExecutionMode, wsUrl, dashboardUrl }`

---

## 2. Config Generator (`config-generator.js`)

### Model Role Assignments

Three UI slots: **Primary**, **Fast**, **Strategic**. Resolution order (first non-empty):
- Primary: `settings.primary_model` → local LLM default → Anthropic default → xAI default → catalog default (`gpt-5.2`)
- Fast: `settings.fast_model` → local LLM fast → Anthropic → xAI → catalog default (`gpt-5-mini`)
- Strategic: `settings.strategic_model` → local LLM → Anthropic strategic → xAI strategic → catalog default (`gpt-5.2`)

Provider inference via `inferProviderFromModel()`: exact catalog lookup → prefix heuristics (`claude*`→anthropic, `grok*`→xai, `gpt*`→openai, `qwen*`/`llama*`→ollama).

### How Roles Map to YAML

- **`models:`** — `primary` = Primary, `fast`/`nano` = Fast, `strategicModel`/`coordinatorStrategic` = Strategic
- **`modelAssignments:`** — `research`/`analysis`/`default` → Primary; `synthesis`/`integration`/`quality_assurance` → Strategic; `quantumReasoner.branches`/`coordinator` → Fast
- **`providers:`** — blocks emitted only if that provider is actually used

### Embedding Config (Locked)
`text-embedding-3-small`, 512 dimensions. From `getEmbeddingConfig()`. NOT affected by role selections. Changing mid-run invalidates all stored vectors.

### Key Behavioral Flags
- `enable_local_llm = true`: `parallelBranches: 2`, `cycleTimeoutMs: 300000`, `maxConcurrent: 2`
- `enable_stabilization` / `enable_consolidation_mode`: disables chaos, mutations, quantum, curiosity; caps `maxGoals: 25`
- `enable_consolidation_mode`: additionally disables sensors, coordinator, introspection
- `max_cycles = 'unlimited'`: emitted as `null` in YAML

---

## 3. Process Manager (`process-manager.js`)

### Subprocess Inventory

| Key | Command | cwd |
|---|---|---|
| `mcp-http` | `node mcp/http-server.js <port>` | `engine/` |
| `main-dashboard` | `node src/dashboard/server.js` | `engine/` |
| `cosmo-main` | `node src/index.js` | `engine/` |

All use `stdio: ['ignore', 'pipe', 'pipe']`, `detached: false`. Not daemonized.

### Environment Inheritance
Critical env vars before spawning: `COSMO_RUNTIME_PATH`, `DASHBOARD_PORT`, `MCP_HTTP_PORT`, `COSMO_TUI=false`, `COSMO_NO_AUTO_OPEN=true`.

### Log Buffering
Line-by-line capture, ANSI stripped, max 1500 entries. `getLogs({ after, limit })` supports cursor-based polling. Cleared at each new launch.

### Shutdown (`stopAll()`)
1. SIGINT to all COSMO instances → poll up to 3 min for exit
2. Force SIGKILL if needed
3. SIGTERM to support processes
4. `killPort()` on all used ports

---

## 4. Run Manager (`run-manager.js`)

### Run Directory Skeleton
`createRun(name)` creates: `coordinator/`, `agents/`, `outputs/`, `exports/`, `policies/`, `training/`

### `forkRun(sourceRunName, newRunName)`
Full directory copy + state surgery on `state.json.gz`:
- `cycleCount = 0`, goals archived, coordinator reset, temporal/cognitive state reset to awake
- Memory nodes without `consolidatedAt` stamped with fork timestamp (prevents O(n²) re-consolidation)
- `guidedMissionPlan = null`, `completionTracker = null`
- Subdirs `coordinator/`, `agents/`, `evaluation/`, `policies/`, `plans/` nuked and recreated
- Domain/context cleared in metadata (forces fresh configuration)

### `createDreamFork(sourceRunName, newRunName, settings)`
Like fork but optimized for sleep/consolidation: temporal state = sleeping, energy = 0.1.

### `linkRuntime(runName, runtimePath)`
Removes existing `runtime/` path → creates symlink `runtime/ → runs/<name>`.

---

## 5. Continuation Flow

### Route: `POST /api/continue/:brainId`

1. `resolveBrainBySelector()` → find brain by SHA1 ID or name
2. `getBrainContinuationState()` → loads metadata + snapshots, returns `effectiveContinueSettings`
3. `mergeContinuationPayload()` → merges request body onto effective settings (only `UI_SETTING_FIELDS`)
4. `launchResearch(mergedPayload)` → same as `/api/launch` but reuses existing run dir
5. Writes `initial-launch.json` (idempotent) + timestamped continuation snapshot

### Settings Resolution Priority
`normalizeBrainMetadataToSettings()` reads from three sources:
1. `metadata.json` (webMetadata — most recent UI settings)
2. `run-metadata.json` (runtimeMetadata)
3. `brain` object from `inspectBrain()`

### Continuation Snapshots
Stored in `runs/<name>/continuation-snapshots/`:
- `initial-launch.json` — written once on first continue
- `<timestamp>.json` — per-continue snapshot with `changedFields` diff

### Reference Brain Continuation
`importReferenceBrain()` deep-copies to `runs/`, writes `reference-origin.json` for provenance. Reference source is never modified.

---

## 6. Stop Flow

`POST /api/stop` → `processManager.stopAll()` (blocks up to 3 min) → `activeContext = null` (in `finally` — always clears even on error).

**Natural completion:** When the engine exits naturally (maxCycles, maxRuntime, signal), ProcessManager emits `cosmo-exit` event → server listener clears `activeContext` automatically. No manual `/api/stop` required.

**Race guard:** `isLaunching` flag prevents concurrent launch/continue requests from both passing the `activeContext` check before either sets it.

No partial stop. No pause/resume at process level (continuation handles this via state persistence).

---

## 7. Status Polling

`GET /api/status` — `running` = `activeContext !== null` AND `processManager.processes.has('cosmo-main')`.

`GET /api/watch/logs?after=<cursor>&limit=<n>` — cursor-based log polling, max 1000 entries. Uses the same compound `running` check as `/api/status`.

---

## 8. Brain Registry (`server/lib/brain-registry.js`)

- **Brain ID:** `sha1(path.resolve(runPath)).slice(0, 16)`
- **Discovery:** scans `runs/` (local) + reference paths, dedupes by resolved path, sorted by mtime
- **Reference paths:** default `../Cosmo_Unified_dev/runs` and `../COSMO/runs`, override with `COSMO_REFERENCE_RUNS_PATHS`
- **`inspectBrain()`:** reads state.json.gz + metadata files, returns full brain info
- **`sanitizeRunName()`:** lowercase, replace non-alphanum with hyphens

---

## 9. Runtime Artifacts

### Written at Launch
| File | By | Purpose |
|---|---|---|
| `config.yaml` | ConfigGenerator | Engine configuration |
| `run-metadata.json` | ConfigGenerator | Engine-facing metadata |
| `metadata.json` | server/index.js | UI-facing camelCase settings |
| `runtime/` symlink | RunManager | Points to active run |

### Written by Engine During Run
`state.json.gz`, `thoughts.jsonl`, `cosmo-progress.md`, `guided-plan.md`, `coordinator/`, `agents/`, `outputs/`, `plans/`, `tasks/`, `milestones/`, `.clean_shutdown`

### Written After Continue
`continuation-snapshots/initial-launch.json`, `continuation-snapshots/<timestamp>.json`, `reference-origin.json` (for imports)

---

## 10. Execution Mode Logic (`lib/execution-mode.js`)

`normalizeExecutionMode(explorationMode, requestedMode)`:
- `guided` → `effectiveMode: 'guided-exclusive'`, `persistedMode: 'strict'` (always)
- anything else → `effectiveMode: 'autonomous'`, `persistedMode: requestedMode || 'mixed'`

---

## 11. Common Pitfalls

- **`activeContext` is in-memory only.** Server restart loses subprocess tracking. Cleared automatically on engine exit via `cosmo-exit` event.
- **`config.yaml` is in the run directory, not `engine/`.** `COSMO_RUNTIME_PATH` points the engine there.
- **Two metadata files coexist.** `run-metadata.json` + `metadata.json`. Both must be updated when modifying settings.
- **`runtime/` symlink not reliable after restart.** Scan `runs/` by mtime instead.
- **Fork clears domain and context.** Intentional — forces fresh configuration.
- **Reference brains always imported before launch.** Source never modified.
- **Embeddings locked per-run.** Changing model invalidates all stored vectors.
- **QA disabled in guided mode.** Hardcoded in `config-generator.js`.
