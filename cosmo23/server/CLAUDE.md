# CLAUDE.md — Server Layer (server/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 server layer.

---

## Express App Structure

**Entry point:** `server/index.js`

Single Express instance. All routes except the brains/continue group live directly in `index.js`. No separate router hierarchy.

### Middleware (lines 118–120)

```
cors()                                          // wide-open, no origin filter
express.json({ limit: '10mb' })
express.urlencoded({ extended: true, limit: '10mb' })
```

### Static file serving

`app.use(express.static(PUBLIC_DIR))` where `PUBLIC_DIR = ../public/`. Root handler returns `index.html`.

### Startup sequence

1. `mkdir -p <project-root>/runs`
2. `repairAllRunMetadata(LOCAL_RUNS_PATH)` — fills missing topic/domain/context in old run-metadata.json files
3. Console log with port, config path, reference paths, repair summary

---

## Port Map and Environment Variables

| Port | Default | Env vars (priority order) |
|---|---|---|
| HTTP server | 43110 | `COSMO23_PORT`, `PORT` |
| WebSocket | 43140 | `COSMO23_WS_PORT`, `WS_PORT`, `REALTIME_PORT` |
| MCP HTTP | 43147 | `COSMO23_MCP_HTTP_PORT`, `MCP_HTTP_PORT` |
| Dashboard | 43144 | `COSMO23_DASHBOARD_PORT`, `DASHBOARD_PORT` |

After resolution, all variants are written back to `process.env` so child processes inherit them.

Config paths: `COSMO23_HOME` → `~/.cosmo2.3/`, `COSMO23_CONFIG_PATH` → `~/.cosmo2.3/config.json`, `DATABASE_URL` → `file:~/.cosmo2.3/database.db`.

---

## Complete Route Map

### Health and Status

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Basic health check, includes `running` flag |
| GET | `/api/status` | Full status: `activeContext`, process status, all ports, `dashboardUrl`, `wsUrl` |

### Setup / Configuration

| Method | Path | Description |
|---|---|---|
| GET | `/api/setup/status` | `summarizeSetup(config)` — masked keys, provider flags, paths |
| POST | `/api/setup/bootstrap` | Writes `~/.cosmo2.3/config.json`, applies to env, resets provider registry |

Bootstrap key behaviors: `mergeSecret()` never overwrites existing secrets with empty strings. Generates random 32-byte hex `encryption_key` if none exists. Calls `applyStoredConfig()` after saving. Anthropic API keys are not accepted — Anthropic auth is OAuth-only.

### Provider and Model Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/providers/models` | Merged model list from catalog + live Ollama detection |
| GET | `/api/providers/status` | Health checks all registered providers |
| GET | `/api/providers/capabilities` | Capability objects for all providers |
| GET | `/api/models/catalog` | Full catalog + merged model list |
| POST | `/api/models/catalog` | Overwrites `~/.cosmo2.3/model-catalog.json`, resets registry |

For Ollama: if health check succeeds, catalog entries are replaced with live `listModels()` result. `source` field: `'installed'` vs `'catalog'`.

For Ollama Cloud: dynamic model discovery from `ollama.com/v1/models` with 5-min TTL cache and seed list fallback. API key from `OLLAMA_CLOUD_API_KEY` env or `config.providers.ollama-cloud.api_key`. Uses OpenAI-compatible API via `OpenAIAdapter` with custom ID/name override.

### Anthropic OAuth

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/oauth/anthropic/start` | PKCE challenge generation, returns `{ authUrl }` |
| GET | `/api/oauth/anthropic/callback` | Receives redirect, exchanges code for tokens |
| POST | `/api/oauth/anthropic/exchange` | Same exchange logic as callback (POST body) |
| GET | `/api/oauth/anthropic/status` | `{ configured, source, valid, expiresAt, oauthOnly: true }` |
| POST | `/api/oauth/anthropic/logout` | Deletes DB record, clears cache, resets registry |

### OpenAI Codex OAuth

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/oauth/codex/start` | PKCE challenge generation for Codex OAuth |
| GET | `/api/oauth/codex/callback` | Receives redirect, exchanges code for JWT tokens |
| POST | `/api/oauth/codex/exchange` | Same exchange logic as callback (POST body) |
| POST | `/api/oauth/codex/import` | Import Codex credentials via evobrew format |
| GET | `/api/oauth/codex/status` | `{ configured, valid, expiresAt }` |
| POST | `/api/oauth/codex/logout` | Deletes DB record, clears cache, resets registry |

### Brain Management (via `server/lib/brains-router.js`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/brains` | Lists all local + reference brains with snapshot summaries |
| GET | `/api/brains/:brainId` | Single brain with full continuation state and snapshots |
| POST | `/api/continue/:brainId` | Merges stored settings with overrides, launches continuation |

### Launch and Stop

| Method | Path | Description |
|---|---|---|
| POST | `/api/launch` | Launches new run or resumes existing brain. 409 if already running or launching |
| POST | `/api/stop` | Stops all processes, clears `activeContext` (always, even on error via `finally`) |

### Brain Query

| Method | Path | Description |
|---|---|---|
| POST | `/api/brain/:name/query` | Non-streaming query |
| POST | `/api/brain/:name/query/stream` | SSE streaming query |
| GET | `/api/brain/:name/suggestions` | Query suggestions |
| POST | `/api/brain/:name/export-query` | Export query+answer to file |

`:name` resolves via `resolveBrainBySelector` matching on id, routeKey, or directory name.

### Brain Graph & Intelligence

| Method | Path | Description |
|---|---|---|
| GET | `/api/brain/:name/graph` | Knowledge graph nodes/edges/clusters (embeddings stripped) |
| GET | `/api/brain/:name/intelligence/goals` | Active + completed goals from state |
| GET | `/api/brain/:name/intelligence/plans` | Plan + milestones + tasks + guided-plan.md + archived |
| GET | `/api/brain/:name/intelligence/thoughts` | Paginated thoughts from thoughts.jsonl |
| GET | `/api/brain/:name/intelligence/agents` | Agent analytics summary + timeline |
| GET | `/api/brain/:name/intelligence/insights` | Coordinator reviews + curated insights list |
| GET | `/api/brain/:name/intelligence/insight/:filename` | Full markdown for a specific review/insight |
| GET | `/api/brain/:name/intelligence/trajectory` | Trajectory + forks from state |
| GET | `/api/brain/:name/intelligence/executive` | Executive ring data from state |
| GET | `/api/brain/:name/intelligence/deliverables` | Agent output directories |

All intelligence endpoints work on any saved brain — no active run required. Data comes from `state.json.gz`, filesystem (thoughts.jsonl, coordinator/*.md, plans/, tasks/), and `agents.jsonl`.

### Watch

| Method | Path | Description |
|---|---|---|
| GET | `/api/watch/logs` | Buffered log lines from ProcessManager. Params: `after`, `limit` |

---

## Launch Flow — Step by Step

`launchResearch(payload, req)` in index.js:

1. **Guard:** 409 if `activeContext` is set OR `isLaunching` flag is true (prevents race condition on concurrent requests)
2. **Brain resolution:** If `brainId` provided → resolve brain. If reference → `importReferenceBrain` deep-copies to `runs/`. If no brainId → `createRun(sanitizedName)`
3. **Load config** from `~/.cosmo2.3/config.json`
4. **Serialize settings:** `normalizeExecutionMode()` — guided always → `guided-exclusive`. Resolve model/provider assignments with cascading fallbacks. Normalize Ollama/LMStudio URLs
5. **Clear logs**, **create runtime symlink**
6. **Write `config.yaml`** via `configGenerator.writeConfig()`
7. **Write metadata** — both `run-metadata.json` (engine-facing) and `metadata.json` (web-facing)
8. **Start processes:** MCP server (43147) → Dashboard (43144) → Engine
9. **Set `activeContext`** with all run info including `wsUrl`
10. **Return** launch result (strips `brainPath` and `brainSourceType`)

---

## Provider Adapter Architecture

### Abstract base (`server/providers/adapters/base.js`)

Subclasses implement: `id`, `name`, `capabilities`, `getAvailableModels()`, `_initClient()`, `createMessage()`, `streamMessage()`, `convertTools()`, `parseToolCalls()`, `normalizeResponse()`.

Base provides: lazy client init, request validation, graceful degradation (strips unsupported features), error classification with retry logic, tool filtering by capability.

### Anthropic adapter (OAuth-only)

- **Always OAuth:** No API key path. SDK always initialized with `authToken` + stealth headers impersonating Claude Code CLI (`user-agent: claude-cli/2.1.32`, `x-app: cli`), and mandatory system prompt prepend
- Extended thinking budget: low=2000, medium=8000, high=32000 tokens

### OpenAI adapter

- **Dual API routing:** `shouldUseResponsesAPI(model)` returns true for `gpt-5*` and `o3*/o4*` → uses `client.responses.create()`. Others → `client.chat.completions.create()`
- Responses API carries stateful context via `_previousResponseId`
- **xAI and LMStudio reuse:** same class with different `baseUrl` and `id` overrides
- **OpenAI Codex reuse:** same class with `id: 'openai-codex'`, standard OpenAI API (no custom base URL), JWT bearer auth via OAuth token. OAuth-only — no API key accepted. Dynamic model discovery at runtime.

### Ollama adapter

- Native REST for embeddings (`/api/embeddings`), OpenAI-compatible `/v1` for chat
- XML tool call fallback: parses `<tool_call>...</tool_call>` blocks from raw text
- `reducedParallelism: true` — engine uses fewer parallel operations

### Registry (`server/providers/registry.js`)

Model lookup order: explicit map → provider prefix → heuristic name matching → provider scan. Singleton via `getDefaultRegistry()`, reset with `resetDefaultRegistry()` after any credential/model change.

---

## OAuth Flow (Anthropic PKCE) — OAuth-Only

**File:** `server/services/anthropic-oauth.js`

Anthropic is OAuth-only — no API keys accepted or stored. Two credential paths:

1. **PKCE flow:** `getAuthorizationUrl()` → PKCE verifier + SHA-256 challenge → user authorizes at `claude.ai/oauth/authorize` → `exchangeCodeForTokens()` → `storeToken()` → AES-256-GCM encrypt → Prisma/SQLite upsert
2. **CLI import:** `importFromClaudeCLI()` — reads `~/.claude/auth.json`

`getAnthropicApiKey()` → cache → DB → auto-refresh if expired → error (no env var fallback). `ANTHROPIC_OAUTH_ONLY` is always `true`.

**Engine mirror:** `engine/src/services/anthropic-oauth-engine.js` — must stay in sync with server version.

---

## Brain Registry (`server/lib/brain-registry.js`)

- **Brain ID:** SHA-1 of absolute path, first 16 hex chars
- **Discovery:** scans `runs/` (local) + reference paths (reference), dedupes by resolved path, sorts by mtime
- **Reference paths:** default `../Cosmo_Unified_dev/runs` and `../COSMO/runs`, override with `COSMO_REFERENCE_RUNS_PATHS`
- **Import:** `importReferenceBrain()` deep-copies directory, writes `reference-origin.json`

---

## Continuation State (`server/lib/continuation-state.js`)

### Snapshot layout

```
<runPath>/continuation-snapshots/
  initial-launch.json           # First launch settings
  20250601T123456789Z.json      # Timestamped continuation snapshots
```

### Settings resolution

`getBrainContinuationState()` priority: web metadata > runtime metadata > brain object > defaults. Returns `effectiveContinueSettings` from most recent snapshot.

### Continue flow

1. Get `effectiveContinueSettings`
2. Merge with request body overrides (only `UI_SETTING_FIELDS`)
3. Launch research
4. Write `initial-launch.json` (if first time) + timestamped snapshot with `changedFields`

---

## Config Management

| Path | Purpose |
|---|---|
| `~/.cosmo2.3/config.json` | Primary config (providers, security, ports) |
| `~/.cosmo2.3/model-catalog.json` | Model catalog overrides |
| `~/.cosmo2.3/database.db` | SQLite (OAuth tokens via Prisma) |

Secrets encrypted at rest: format `"encrypted:IV:AuthTag:Ciphertext"`, key from `ENCRYPTION_KEY` env var or machine-derived PBKDF2. File written atomically (`.tmp` then rename), mode `0o600`.

---

## WebSocket Integration

The server does NOT run a WebSocket server. The engine process runs its own on `WS_PORT`. The server's role:
1. Report `wsUrl` in launch/status responses
2. Start the engine process via ProcessManager

The UI connects directly to the engine's WebSocket.

---

## Error Handling

Consistent pattern across all routes:
```js
try { ... res.json(result) }
catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }) }
```

For streaming: mid-stream errors sent as `data: { type: 'error', error: message }` SSE event. No global error middleware.

---

## Key Dependencies

### Server → Launcher
- `RunManager` — `createRun()`, `linkRuntime()`
- `ConfigGenerator` — `writeConfig()`, `writeMetadata()`
- `ProcessManager` — `startMCPServer()`, `startMainDashboard()`, `startCOSMO()`, `stopAll()`, `getLogs()`

### Server → lib/
- `BrainQueryEngine` — wraps `lib/query-engine.js` for brain query routes
- `loadConfigurationSync` — startup config loading
- `normalizeExecutionMode` — guided always → guided-exclusive

### Data flow: config.yaml
`runtime/config.yaml` is written by `ConfigGenerator.writeConfig(launchSettings)` during launch. The engine reads this on startup. Changes to field names/defaults require matching changes in `serializeLaunchSettings`, `ConfigGenerator.writeConfig`, and the engine's config reader.
