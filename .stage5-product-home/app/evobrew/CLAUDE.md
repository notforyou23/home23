# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Evobrew — model-agnostic AI workspace (Node.js/Express + vanilla JS frontend). CLI-driven app with multi-provider AI chat, semantic knowledge graphs (.brain packages), function calling, PTY terminal sessions, and persistent memory via OpenClaw. Also branded "COSMO IDE" in some docs.

## Commands

```bash
./bin/evobrew start      # Preferred local CLI entrypoint
node server/server.js    # Direct server entrypoint for debugging
node --check <file>      # Syntax-check a file (always do this before committing)
./node_modules/.bin/prisma migrate dev  # Run Prisma migrations
./node_modules/.bin/prisma generate     # Regenerate Prisma client
node scripts/security-smoke.js          # Security smoke tests (spawns server, tests auth/boundary)
```

CLI commands: `./bin/evobrew start`, `./bin/evobrew setup`, `./bin/evobrew daemon install|start|stop`, `./bin/evobrew doctor`, `./bin/evobrew config show|edit|reset`, `./bin/evobrew version`

When the CLI is installed globally, drop the `./bin/` prefix. For source checkouts, prefer `git pull` + restart over `evobrew update` until the updater is generalized beyond package-manager-specific flows.

No formal linter or test suite — validate with `node --check` on all modified files.

**Repo:** https://github.com/notforyou23/evobrew
**Default ports:** HTTP 3405, HTTPS 3406

## Rules

- Never commit `.env` — contains ENCRYPTION_KEY and all API keys
- Never hardcode absolute paths like `/Users/jtr/` — app must be portable
- Never restructure `server.js` — too large and interconnected, surgical edits only
- Never change `openai-codex` routing — intentionally bypasses the registry for OAuth reasons (ChatGPT OAuth tokens lack Platform API scopes)
- Never modify `~/.evobrew/config.json` directly — use the wizard or `config-manager.js`
- Never break the `getAvailableModels()` + `listModels()` contract — UI dropdown depends on both
- Never add a provider without also adding a setup wizard step in `lib/setup-wizard.js`
- Never kill the PM2 `evobrew` process without asking — it may be live on Pi
- Always `node --check` modified files before committing
- Always update `.env.example` when adding new env vars
- Always follow existing patterns — xAI adapter is the cleanest reference for new providers
- Always use seed list + `listModels()` for cloud providers — seed as fallback, live fetch as primary
- Always check `platform.js` when adding features that differ by Mac/Pi/Linux
- Export new wizard helpers from `module.exports` — they're tested externally
- Commit changes — git is the source of truth; unsaved work gets lost on restart

---

## Startup & Boot Sequence

### CLI Entrypoint (`bin/evobrew`)

Hand-rolled command dispatch from `process.argv[2]`. No argument parsing library. Key commands: `start` (foreground server), `setup` (interactive wizard), `daemon <action>` (service lifecycle), `config`, `doctor`, `update`.

The `start` path calls `checkAndKillStaleProcess(3405)` from `lib/process-utils.js` (interactive port-conflict resolution), then checks `needsSetup()` (at least one configured provider required), then spawns `node server/server.js` with inherited stdio.

### Server Boot Phases (`server/server.js`)

1. **Config loading (synchronous, before any imports):** `loadConfigurationSync()` from `lib/config-loader-sync.js` reads `~/.evobrew/config.json`, decrypts secrets, applies to `process.env`. Falls back to `.env` via dotenv.
2. **Security profile:** `loadSecurityProfile()` — the only hard exit at startup. Internet profile requires `EVOBREW_PROXY_SHARED_SECRET`, `WORKSPACE_ROOT`, `COLLABORA_SECRET`, `ONLYOFFICE_CALLBACK_ALLOWLIST` or exits.
3. **Module imports and middleware:** Express app, CORS, body parsers, security headers, proxy auth middleware, static files.
4. **Route registration:** All routes registered synchronously (~200 endpoints).
5. **HTTP server listen:** Binds `0.0.0.0:PORT`. No EADDRINUSE handler — port conflict here crashes.
6. **HTTPS + WebSocket:** If `ssl/cert.pem` exists, creates HTTPS server. Attaches terminal WS and gateway proxy WS to both servers.
7. **Signal handlers:** SIGINT/SIGTERM call `shutdownTerminalSessions()` then `process.exit(0)`. No graceful HTTP drain.

**AI clients are lazy** — none instantiated at startup. `getOpenAI()`, `getAnthropic()`, `getXAI()` create on first call. Provider registry is also lazy — `getDefaultRegistry()` creates singleton on first API hit.

### Daemon Modes (`lib/daemon-manager.js`)

- **macOS:** launchd plist at `~/Library/LaunchAgents/com.evobrew.server.plist` — `KeepAlive: true`, 10s restart throttle
- **Linux:** systemd user service with hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`)
- **PM2:** `pm2 start` — takes precedence in status display when both PM2 and native service exist
- Log rotation: 10MB max, 7-day retention, gzip compression (not auto-triggered — must be called externally)

---

## Configuration System

### Precedence (highest to lowest)

1. Shell/Docker environment variables (never overwritten by config)
2. `~/.evobrew/config.json` (decrypted, applied via `applyConfigToEnv()` only if env var not already set)
3. `.env` file in project root (legacy fallback via dotenv)
4. `DEFAULT_CONFIG` hardcoded defaults

### Config File Structure (`~/.evobrew/config.json`)

Sections: `server` (ports, bind), `providers` (per-provider enabled/api_key/oauth), `openclaw` (gateway), `features` (https, brains, function_calling), `terminal`, `security` (encryption_key, profile).

Secrets (any key containing `api_key`, `token`, `password`, `secret`) are AES-256-GCM encrypted at rest. The `encryption_key` itself is stored in plaintext (it encrypts everything else).

### Encryption — Two Separate Modules

- **`lib/encryption.js`** — Config-layer encryption. Key priority: `ENCRYPTION_KEY` env var → `config.json security.encryption_key` → machine-derived key (PBKDF2 from `hostname:username:evobrew-v1-config-salt`, 100K iterations). Wire format: `encrypted:<IV>:<AuthTag>:<Ciphertext>`. Machine-derived key means config is **not portable between machines**.
- **`server/services/encryption.js`** — Database-layer encryption for OAuth tokens. Requires explicit `ENCRYPTION_KEY` env var (no fallback). Wire format: `<IV>:<AuthTag>:<Ciphertext>` (no prefix).

### Setup Wizard (`lib/setup-wizard.js`)

6-step interactive onboarding: (1) AI Providers — multiSelect UI, per-provider test via raw HTTPS POST, (2) OpenClaw, (3) Brains, (4) Server ports, (5) Service installation, (6) Verification. Config saved incrementally after each step. Secret inputs use raw terminal mode with `*` echo.

Important flow details:

- Wizard is **state-aware** — loads existing config, prints current status, then offers: configure missing only, reconfigure specific sections, full setup, or exit.
- Provider step is richer than the docs imply:
  - **OpenAI** → ChatGPT OAuth (Codex models) or API key
  - **Anthropic** → OAuth or API key, with API-key fallback when OAuth fails
  - **xAI** → API key with live validation
  - **Ollama Cloud** → API key with live validation
  - **Local Models** → detects Ollama and LMStudio, can save custom URLs even if unverified
- **OpenClaw step** auto-detects three states: running gateway, installed-but-not-running, not detected. In all three cases the user can still save a manual config.
- **Brains step** is not cosmetic — it configures directories plus embeddings. If the user skips embeddings, brain search falls back to keyword search.
- **Service step** exposes real deployment choices: PM2 vs native service manager (`launchd`/`systemd`) vs skip/manual. Linux defaults toward PM2 when available.
- Verification re-tests configured providers/OpenClaw after setup. Completion message prints the final URL and operational commands.

### Runtime Provider Setup Surface

There is now a real in-app provider setup surface in Settings, backed by `server/server.js` routes under `/api/setup/*`.

- **Status route:** `/api/setup/status` returns live app/provider state plus safe detail fields (auth mode, has_api_key, Ollama base URL, brain directory count, etc.).
- **Native in-app save/test/disable flows:**
  - `OpenAI API`
  - `Anthropic` **API-key mode only**
  - `xAI`
  - `Ollama Cloud`
  - local `Ollama`
- **Still terminal/CLI-driven:**
  - `Anthropic OAuth`
  - `OpenAI Codex OAuth`
  These are launched from Settings into the integrated terminal because they still depend on the full CLI/browser exchange.
- Provider changes are **hot-applied** by saving encrypted config, syncing env, then calling `resetDefaultRegistry()` + `getDefaultRegistry()`.
- `evobrew setup --status` is special-cased to avoid stopping the server; full `evobrew setup` may still stop/restart it.

### Config Loaders

- `lib/config-loader-sync.js` — Used at server startup (before event loop). **Inlines its own decryption** to avoid circular dependency.
- `lib/config-loader.js` — Async version for runtime use.
- `lib/config-manager.js` — Read/write/validate `~/.evobrew/config.json`. Path constants, `initConfigDir()`, `migrateFromEnv()`.

### Platform Detection (`server/config/platform.js`)

Returns `{ type, supportsLocalModels }`. Pi detected via `/proc/device-tree/model` or `/proc/cpuinfo`. Pi: `supportsLocalModels: false`. Linux with <16GB RAM: `supportsLocalModels: false`.

---

## Model & Provider System

### Routing Chain

```
getProvider(modelId)
  1. Explicit model map (Map<modelId, providerId>) — checked first, wins immediately
  2. parseProviderId(modelId) — checks for "/" prefix, then heuristic chain:
     local: prefix → local-agent (routes to LocalAgentAdapter by id)
     claude → anthropic | gpt/o1/o3 → openai | grok → xai
     nemotron/kimi/cogito/minimax/devstral → ollama-cloud
     llama/mistral/qwen/deepseek or contains ":" → ollama
  3. Capability scan — iterates all providers, calls supportsModel() (substring match)
```

`extractModelName()` strips provider prefix before API calls.

### ProviderAdapter Contract (`server/providers/adapters/base.js`)

Required: `get id()`, `get name()`, `get capabilities()`, `getAvailableModels()`, `_initClient()`, `createMessage()`, `streamMessage()`, `convertTools()`, `parseToolCalls()`.

Capabilities shape: `{ tools, vision, thinking, streaming, caching, maxOutputTokens, contextWindow }`.

Error classification: `isRateLimitError` → retry (60s default), `isServerError` → retry (5s), `isBillingError`/`isAuthError` → no retry.

### Adapter Specifics

**AnthropicAdapter** — OAuth stealth headers (`anthropic-beta: claude-code-20250219,...`, user-agent spoof as `claude-cli/2.1.32`). System prompt injection required for OAuth tokens. Thinking levels: low→2000, medium→8000, high→32000 budget tokens.

**OpenAIAdapter** — Dual API: `shouldUseResponsesAPI(model)` forks on `gpt-5`/`o3`/`o4` prefix. Responses API is stateful (`previousResponseId` tracked across turns). GPT-5.2 gets `reasoning: { effort: 'none' }`, `text: { verbosity: 'medium' }`.

**OllamaAdapter** — Dual protocol: embeddings via native `/api/embeddings`, chat via OpenAI-compatible `/v1`. XML fallback for tool calls (`<tool_call>{...}</tool_call>` parsing for models like qwen2.5-coder). **Stream format differs** from other adapters (`content_delta` instead of `text`) — requires special handling in consumers.

### OpenAI Codex Special Case

ChatGPT OAuth tokens can't use the Platform API. The registry registers model IDs (`gpt-5.2`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) but **no adapter is instantiated**. Actual requests bypass the registry entirely, using a raw `fetch()` client against `chatgpt.com/backend-api/codex/responses`. Detection via `isCodexModelSelection()` in `lib/model-selection.js`.

### Two Parallel Client Layers

**Adapter layer** (`server/providers/`) — the formal abstraction with unified types. Used by registry consumers.

**Legacy client layer** (`lib/anthropic-client.js`, `lib/openai-client.js`) — older SDK wrappers used directly by `ai-handler.js`. `AnthropicClient` has OAuth refresh (50-min window), GPT-name-to-Claude-model mapping, OpenAI-to-Anthropic format translation. Both layers coexist — `ai-handler.js` was not fully migrated to the adapter layer.

### Provider Initialization Order (`providers/index.js` `createRegistry()`)

Anthropic (OAuth or API key) → OpenAI → OpenAI Codex (model IDs only, no adapter) → xAI → Ollama Cloud → Ollama local (auto-detect `/api/tags`, skipped on Pi) → LMStudio (if enabled)

### Registered Providers

| ID | Adapter | Auth | Dynamic models |
|----|---------|------|----------------|
| `anthropic` | AnthropicAdapter | OAuth or API key | No (static list) |
| `openai` | OpenAIAdapter | API key | No |
| `openai-codex` | (legacy client) | ChatGPT OAuth | No |
| `xai` | OpenAIAdapter + override | API key | No |
| `ollama` | OllamaAdapter | None (local) | Yes — `/api/tags` |
| `ollama-cloud` | OpenAIAdapter + override | API key | Yes — `/v1/models` |
| `lmstudio` | OpenAIAdapter + override | None (local) | Via listModels() |
| `local:<id>` | LocalAgentAdapter | Optional key | Via `/health` |

Important provider nuance:

- `Anthropic` init now respects `config.providers.anthropic.oauth === false`; saving an Anthropic API key from the live Settings panel intentionally flips it out of OAuth mode.
- `Ollama Cloud`, `xAI`, and `OpenAI` all ride the OpenAI-compatible adapter path, so system-prompt handling and tool-call normalization bugs can affect them together.
- `Ollama Cloud` is **not** just model listing wiring; it is a real provider path used by `ai-handler.js` with streamed chat and tool calls.

### Available Models

**Anthropic:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-sonnet-5`
**OpenAI:** `gpt-5.4`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1`, `gpt-4o`, `gpt-4o-mini`
**xAI:** `grok-code-fast-1`, `grok-4-1-fast-reasoning`, `grok-4-1-fast-non-reasoning`, `grok-2`, `grok-beta`
**Ollama Cloud:** dynamic — seed list includes `nemotron-3-super:cloud`, `qwen3.5:397b`, `deepseek-v3.1:671b`, `kimi-k2:1t`
**Ollama (local):** dynamic — whatever is installed (`ollama list`)
**OpenAI Codex:** `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.3-codex-spark` (via ChatGPT OAuth)
**Local Agents:** dynamic — whatever agents are registered in `config.providers.local_agents[]`, shown in UI under "Local Agents" group

### OpenAI-Compatible Adapter Gotcha

The OpenAI-compatible path (`OpenAI`, `xAI`, `Ollama Cloud`, `LMStudio`) is sensitive to how `system` messages are preserved:

- For **Responses API** models, system content is converted into `instructions` plus non-system input items.
- For **chat-completions** models, inline `system` messages must survive `_convertMessages()` or the model loses IDE identity, tool guidance, brain/tool strategy, open-files context, and conversation summary.
- A real Mar 2026 regression came from dropping inline `system` messages in `server/providers/adapters/openai.js`, which made `Ollama Cloud` behave like a generic public chatbot with no Evobrew context.

### Adding a New Provider

Pattern used by every cloud provider (xAI, Ollama Cloud):

1. **`registry.js`** — Add factory in `_registerBuiltinFactories()`:
   ```js
   this.adapterFactories.set('my-provider', (config) => {
     const adapter = new OpenAIAdapter({ ...config, baseUrl: 'https://api.example.com/v1' });
     Object.defineProperty(adapter, 'id', { value: 'my-provider', writable: false });
     Object.defineProperty(adapter, 'name', { value: 'My Provider', writable: false });
     adapter.getAvailableModels = () => ['model-a', 'model-b'];
     return adapter;
   });
   ```
   Also add model name heuristics to `parseProviderId()` if models have unique prefixes.

2. **`providers/index.js`** — Init block in `createRegistry()`:
   ```js
   const myKey = process.env.MY_PROVIDER_API_KEY
     || evobrewConfig?.providers?.['my-provider']?.api_key;
   if (myKey) {
     registry.initializeProvider('my-provider', { apiKey: myKey });
   }
   ```

3. **`setup-wizard.js`** — Add to `providerOptions` array, add `if (provider === 'my-provider')` case in `stepProviders()`. Follow the xAI pattern: prompt for key, call test helper, save to `config.providers['my-provider']`.

4. **`server.js`** — Only needed for dynamic model fetching (see Ollama/Ollama Cloud pattern in `/api/providers/models` endpoint around line 3140).

### Dynamic vs Static Model Lists

Static: Anthropic, OpenAI, xAI, Codex. Dynamic: Ollama local (`/api/tags`), Ollama Cloud (`ollama.com/v1/models`, 5-min TTL cache with seed list fallback), LMStudio (`listModels()`), Local Agents (registered entries in config).

---

## Local Agent System

### Overview

Local agents are first-class providers that run as separate HTTP/SSE servers on localhost. They are distinct from Ollama (model runner) and LMStudio (model server) — a local agent is a fully autonomous process with its own identity, tools, and memory. Evobrew connects to it like a provider, routing chat turns to its webhook and streaming responses back.

Provider IDs use the `local:<id>` prefix (e.g., `local:home`, `local:research`). `parseProviderId()` in `registry.js` matches the `local:` prefix and routes to `LocalAgentAdapter`.

### LocalAgentAdapter (`server/providers/adapters/local-agent.js`)

HTTP + SSE streaming adapter. Sends `POST /api/chat` to the agent's webhook server with full message history, tools, and system context. Streams back `UnifiedChunk`-format SSE events. Optional bearer-token auth via per-agent key stored encrypted in config.

The adapter implements the standard `ProviderAdapter` contract: `streamMessage()`, `createMessage()`, `convertTools()`, `getAvailableModels()` (returns `['local:<id>']`).

### Config Structure

Agents are stored in `config.providers.local_agents[]`. Each entry:
```json
{
  "id": "home",
  "name": "Home Agent",
  "endpoint": "http://localhost:4610",
  "key": "<encrypted-or-plaintext>"
}
```

On registry init (`providers/index.js`), each entry is decrypted via `decryptAgentKey()` and registered with `registry.initializeProvider('local:<id>', { endpoint, apiKey })`.

### Agent Discovery & Setup Routes (`/api/setup/*`)

- **`GET /api/setup/scan-agents`** — scans `localhost:4600–4660` for `/health` endpoints, returns discovered agents with identity info.
- **`POST /api/setup/local-agent/save`** — verifies agent identity via `/health`, saves to `config.providers.local_agents[]`, hot-reloads registry (`resetDefaultRegistry()` + `getDefaultRegistry()`).
- **`POST /api/setup/local-agent/test`** — connectivity test only, no config change.
- **`POST /api/setup/local-agent/remove`** — removes agent from config by id, hot-reloads registry.

**Health endpoint contract:** `GET /health → { status: "ok", agent: "<name>", type: "<type>", endpoint: "<url>" }`

### UI Surface

- **Settings panel** — "Local Agents" section with Scan button (calls scan-agents), per-agent Connect/Remove actions. Shows agent name, type, and endpoint URL from `/health`.
- **Model picker** (`public/js/ui-runtime-settings.js`) — registered local agents appear under a "Local Agents" group with `local:<id>` model IDs.
- **CLI wizard** (`lib/setup-wizard.js`) — scan-and-select flow in `stepProviders()` for `local-agents` option: scans, prompts user to pick, saves.

### Dispatch in ai-handler.js

Local agent branch sits between the Ollama and Ollama Cloud branches in `handleFunctionCalling()`. Detection: `providerId.startsWith('local:')`. Uses `provider.streamMessage()` from the registry — same path as Ollama/Ollama Cloud.

### Cosmohome Bridge Protocol (cosmo-home_2.3)

Each agent in the cosmohome_2.3 repo runs its own webhook server on `HOME_PORT`. The bridge route `POST /api/chat` on the agent:
- Calls `agent.run()` with full identity payload (SOUL, MISSION, MEMORY, conversation history, tools list).
- Parses IDE context (active folder, open file, brain path) from Evobrew's system prompt prefix and prepends it to the user message.
- Streams SSE back in `UnifiedChunk` format compatible with `LocalAgentAdapter`.

This is the Cosmohome side of the integration; Evobrew's side is `LocalAgentAdapter`.

---

## AI Handler & Function Calling

### The Agentic Loop (`server/ai-handler.js` `handleFunctionCalling()`)

**Init:** Registry lookup → provider flags → tool filtering (capability + security policy + terminal policy) → run context injection (walks up for `run-metadata.json`) → system prompt assembly (~4000 chars) → brain context injection (if enabled, top nodes scoring ≥0.20) → message array construction.

Request shaping happens in `server/server.js` before the loop starts:

- `allowedRoot` is derived from security profile/admin status.
- `terminalPolicy` is attached per request (`enabled`, `allowedRoot`, default client id).
- In internet profile with mutations disabled, chat tools are reduced to an explicit allowlist.
- If `workspaceId` is present, `currentFolder`, `allowedRoot`, and terminal root are all rebound to the git worktree path.

**Loop (max 75 iterations):** Each iteration: prune ephemeral messages → dispatch to provider branch → if tool calls present, execute all in parallel via `Promise.all()` → store results → continue. Loop exits when provider returns no tool calls.

Concurrency guard: there is a **per-folder session mutex**. Two agent runs cannot operate on the same `currentFolder` simultaneously unless the previous session appears stale (>10 minutes).

### Provider Branches in the Loop

Each provider has its own streaming branch in `handleFunctionCalling()`:
- **Claude** — Anthropic SDK `messages.stream()`, max_tokens 64000, temp 0.1. Orphaned tool results (no matching tool_use id) are skipped.
- **OpenAI** — `responses.create()` (Responses API), stateful via `previousResponseId`. Subsequent tool-call turns send only function outputs, not full history.
- **Grok/xAI** — `responses.create()` (OpenAI-compatible), system prompt as first input item (xAI doesn't support `instructions`).
- **Local Agents** — `provider.streamMessage()` from registry via `LocalAgentAdapter`. Branch sits between Ollama and Ollama Cloud. Detection: `providerId.startsWith('local:')`.
- **Ollama/Ollama Cloud** — `provider.streamMessage()` from registry. Gemma models: tools disabled entirely.

Reality of the architecture:

- Provider detection prefers the registry, but `handleFunctionCalling()` still receives legacy OpenAI/Anthropic/xAI clients as arguments. The loop is mid-migration, not purely registry-driven yet.
- OpenAI Codex is still a special case upstream in `server/server.js`: if the selected model is Codex, the route injects the legacy ChatGPT OAuth-backed client before entering the loop.

### Token Management

- `smartTruncate()` — For text >75K chars: keeps 60% beginning + 40% end (beginning has imports/declarations, end has recent code).
- `trimMessages()` — When estimated tokens (chars/4) exceed 200K: keeps all system messages (truncated at 80K), last 18 non-system messages. Tool results not in last 2 positions get base64 stripped and content truncated.
- `sanitizeToolResult()` — Deep clean: removes circular refs, strips functions/symbols, truncates arrays to 500 items, strings to 75K, replaces image base64 with placeholder.
- History messages from client: capped at 12K chars each, data URLs truncated at 20K.

### SSE Event Types

`iteration`, `status`, `brain_search`, `thinking`, `tool_preparing`, `tool_progress` (throttled 200ms), `response_chunk`, `tools_start`, `tool_start`, `tool_complete`, `tool_result`, `info`, `error`, `complete` (includes `fullResponse`, `tokensUsed`, `iterations`, `pendingEdits`).

Important caveats:

- SSE is implemented manually with `fetch()` + `ReadableStream`, not the browser `EventSource` API.
- The server calls `req.socket.setNoDelay(true)` for chat streams so short events (like tool starts/results) flush immediately instead of batching behind Nagle's algorithm.
- `thinking` events are emitted when the assistant returns explanatory text alongside tool calls, so the UI can show reasoning before/while tools run.
- `complete` is the handoff point for queued edits: `pendingEdits` only materialize in the frontend once the agent turn finishes.

### Planning / Tool Policy Nuances

- Tool availability is filtered in layers:
  1. provider capability filter
  2. explicit security allowlist (`allowedToolNames`)
  3. terminal policy gating
  4. planning-mode write restriction
- Planning mode is activated either by `planningMode=true` or by a message starting with `plan:` (unless `executePlan` is true). In planning mode, write tools are removed but read/plan tools remain.
- Tool execution is parallel within an iteration, but capped by provider performance hints (`maxConcurrentTools`, `maxToolsPerIteration`).
- Pending edits are tracked inside the tool executor so later tool calls in the same iteration/turn can build on earlier proposed edits before anything touches disk.

---

## Tool System

### All 30 Tools (`server/tools.js`)

**Read-only (safe in any profile):** `file_read` (text/docx/xlsx/msg), `list_directory`, `grep_search` (rg with grep fallback), `codebase_search` (semantic)

**Edit tools (queue-based, never write to disk directly):** `edit_file`, `edit_file_range`, `search_replace`, `insert_lines`, `delete_lines` — all return `{ action: 'queue_edit', code_edit: <full new content> }`. Fed into `pendingEdits[]` array, delivered to frontend in `complete` SSE event, shown in diff review UI. Actual disk write only on user approval.

**Direct write (no approval queue):** `create_file` (mkdir + writeFile), `delete_file` (unlink), `create_docx`, `create_xlsx`, `create_image` (GPT-Image-1.5), `edit_image`

**Terminal tools:** `terminal_open`, `terminal_write`, `terminal_wait`, `terminal_resize`, `terminal_close`, `terminal_list`, `run_terminal` (compat wrapper: PTY with exit-marker detection, falls back to synchronous `execSync` with 30s timeout — blocks event loop)

**Brain tools:** `brain_search`, `brain_node`, `brain_thoughts`, `brain_coordinator_insights`, `brain_stats`

### ToolExecutor Security

Three-level path validation: (1) `allowedToolNames` whitelist, (2) `resolveAndValidatePath()` — resolves to absolute, (3) `isPathAllowed()` — dual check: string-normalized containment AND `realpathSync` canonical check (catches symlink escapes). Null bytes rejected. Admin mode (`COSMO_ADMIN_MODE=true`) bypasses all path restrictions.

### Tool Argument Normalization

`server/tools.js` now has a compatibility normalization layer before dispatch. This matters for weaker OpenAI-compatible tool callers (especially some `Ollama Cloud` models) that often emit near-correct argument names instead of exact schema keys.

Examples of accepted aliasing:

- `list_directory`: `path`, `directory`, `folder`, `folder_path` → `directory_path`
- `file_read` / `delete_file` / `read_image`: `path`, `file`, `filename` → `file_path`
- `brain_node`: `id`, `nodeId` → `node_id`
- `brain_search` / `brain_thoughts`: `search`, `topic`, `text` → `query`
- edit tools: common camelCase/synonym variants for line numbers, search/replace text, and instructions

If a cloud model appears “bad at tools,” check whether it is producing alias-style arguments before blaming the model or tool implementation.

---

## Frontend / UI / UX

### Architecture

Single-page app from `public/index.html` (~6400 lines). No bundler, no framework. Three code styles coexist:
- **Massive inline `<script>` block** (~8000 lines of inline JS) — the bulk of the IDE logic
- **ES6 modules** (`ai-chat.js`, `editor.js`, `file-tree.js`, `edit-queue.js`) — loaded via `<script type="module">`
- **IIFEs** (`ui-shell.js`, `ui-panels.js`, `ui-shortcuts.js`, `terminal.js`, `ui-onboarding.js`) — expose `window.*` globals

Cross-module communication via `window.*` globals and custom events (`cosmo:folderChanged`).

UI Refresh layer details:

- `ui-shell.js` is a glue layer that converts simple inline `onclick` handlers into delegated `data-action` handlers for key shell regions. This is a partial migration away from direct inline wiring, not a full architectural reset.
- `ui-panels.js` persists layout state in `evobrew.ui.layout.v2` and restores panel visibility/docking heuristically on load.
- `ui-shortcuts.js` is the newer shortcut system; legacy Monaco/global shortcuts still coexist with it.
- `ui-onboarding.js` adds a **non-blocking empty-state card** (“Start Your Workspace”) over the editor when no folder is selected, reinforcing that folder + optional brain is the first interaction contract.
- `initUIRefresh(true)` is called immediately after `ui-shell.js` loads. This call is required to restore the overflow menu and other delegated-event handlers — missing it leaves those handlers unregistered.

Runtime context strip notes:

- The header-adjacent runtime context strip and mobile bottom sheet are additive UI Refresh surfaces implemented in `public/index.html`, `public/js/ui-shell.js`, `public/css/ui-shell.css`, and `public/css/ui-responsive.css`.
- It derives state from existing DOM/global state for folder, workspace, brain, model, pending edits, and terminal status rather than a backend runtime-context API.
- Explicit refresh triggers were added to source flows (workspace activate/reset, folder switching, brain load, edit queue changes, terminal dock open/close) to reduce reliance on MutationObserver updates alone.
- `workspaceCreate()` had a real bug: it referenced a missing `getActiveFolderPath()` function. A concrete active-folder resolver now lives in the page script.
- Browsing the connected brain folder can sit inside a separate git repo; the runtime/workspace UI now avoids falsely showing repo workspace availability there unless a real active workspace already exists.

### Tab System

5 tabs: `readme` (docs), `query` (semantic search), `files` (Agent IDE, default), `explore` (D3 graph), `openclaw` (COZ chat). Switched via `switchBrainTab(tabName)`. Each lazy-initialized on first visit.

### Agent IDE Layout (files tab)

Left sidebar (280px, resizable) | Center editor (Monaco, flex:1) | Right AI panel (400px, resizable) | Bottom terminal dock (280px, collapsible). Tablet (≤900px): sidebar/AI become fixed overlays with backdrop.

Additional shell surfaces worth knowing about:

- Workspace bar appears only when the current folder is inside a git repo and is the visible entry point to worktree isolation.
- Brain picker button is independent from folder browsing; connected brain and working folder are intentionally separate concepts in the UI.
- Command palette and recent-file/folder flows exist as first-class shell interactions, not just editor conveniences.
- OpenClaw is treated as a tab/panel **and** as a model option, reinforcing the multi-surface design of the product.

### Naming / Product Seams

- Branding is still mixed across the repo: `Evobrew` is the canonical name, but `COSMO IDE`, `Brain Studio`, and older `COSMO` terminology still appear in docs and UI text.
- This is not just docs drift — it shows up in visible interface strings (`Brain Studio`, OpenClaw copy, older comments/docs). Be careful when editing user-facing text not to create even more naming fragmentation.

### Theme System

Dark (default, VS Code-like) / Light (via `?theme=light` URL param). No runtime toggle. CSS custom properties in `:root`. UI Refresh system adds a parallel CSS layer gated by `body.ui-refresh-enabled` class.

### Backend Communication

- **REST:** `fetch()` for file ops, brain queries, terminal session CRUD
- **SSE:** Custom implementation via `ReadableStream` reader for AI chat (not `EventSource` API). Manual `\n` split + `data:` prefix strip + JSON parse per event.
- **WebSocket:** Terminal I/O (`/api/terminal/ws`), OpenClaw gateway proxy (`/api/gateway-ws`)

### Chat Rendering Pipeline

User message → `escapeHtml()` (no markdown). Assistant message → `marked.parse()` → `DOMPurify.sanitize()`. Full re-render on every SSE chunk (no incremental DOM). Per-folder conversation history in localStorage (60 messages max, 8K chars max each).

### Edit Approval Flow

1. AI tool returns `{ action: 'queue_edit', code_edit }` (full new file content)
2. Accumulated in `pendingEdits[]` during agentic loop
3. Sent in `complete` SSE event
4. `edit-queue.js` re-fetches current file content, shows pending card with Accept/Reject/Preview
5. Accept: `PUT /api/folder/write` + updates Monaco model if file is open
6. Preview: naive line-by-line diff in `alert()` (known weak point)
7. Queue is in-memory only — lost on page refresh

Important details:

- Backend surgical edit tools (`edit_file_range`, `search_replace`, `insert_lines`, `delete_lines`) still return **complete edited file content** in `code_edit`; the frontend queue does not apply patches incrementally.
- `ToolExecutor.trackPendingEdit()` means later tool calls within the same agent turn read from the **proposed** edited content, not the on-disk file. This lets the agent stack multiple edits coherently before the user approves anything.
- Frontend review is intentionally explicit: nothing auto-applies. Acceptance writes to disk only when the user clicks accept.
- Current preview UX is intentionally simple and is one of the known weak points in the otherwise strong review story.

### Workspace Isolation

- Workspaces are **git worktrees**, not ad-hoc temp directories. One workspace = one new branch under `.evobrew-workspaces/<id>` with branch name `evobrew/workspace-<id>`.
- UI detects whether the current folder is inside a git repo via `/api/workspace/check/*`. If so, it shows a workspace bar with branch state and actions.
- When a workspace is active, `workspaceId` is sent with `/api/chat` requests. Server resolves it to the worktree path and clamps both file access and terminal access to that workspace root.
- Workspace lifecycle routes:
  - `POST /api/workspace/create`
  - `GET /api/workspace/list`
  - `GET /api/workspace/:id` (includes diff summary/full diff/file list)
  - `POST /api/workspace/:id/commit`
  - `POST /api/workspace/:id/merge`
  - `DELETE /api/workspace/:id`
- Merge behavior is pragmatic: uncommitted changes in the worktree are auto-committed first; merge conflicts are detected and aborted so the source repo is not left in a conflicted state.
- Workspace metadata is persisted in `.evobrew-workspaces/workspaces.json` per repo and restored lazily when that repo is re-opened.
- UI currently auto-selects the **most recent active workspace** for a repo when refreshing workspace state.

### Keyboard Shortcuts

Two systems: legacy (Monaco `addCommand()`, hardcoded) and UI Refresh (`ui-shortcuts.js`, capture-phase keydown listener with chord support, user-remappable via settings, persisted to localStorage).

### State Management

All global or module-level. No central store. Key localStorage keys: `evobrew.ui.layout.v2`, `evobrew.ui.shortcuts.v2`, `evobrew-settings`, `evobrew.terminal.*`, `cosmo.aiChat.history:<path>`, `evobrew-brain-*`.

---

## Research / Query / Brain System

### What a .brain Package Is

A directory containing serialized COSMO research output. Required: `state.json.gz` (gzip JSON with `memory.nodes[]`, `memory.edges[]`, `cycleCount`, `goals`). Optional: `thoughts.jsonl`, `embeddings-cache.json`, `coordinator/review_NNN.md`, `partitions.json` (PGS cache), `pgs-sessions/`, `agents/agent_N/findings.jsonl`.

Nodes have: `id`, `concept` (text content), `tag`, `weight`, `activation`, `embedding` (512-dim float array), `cluster`.

### Brain Loading

`POST /api/brain/load` or CLI arg → `server/brain-loader-module.js` singleton → gunzips `state.json.gz` → instantiates `QueryEngine(brainPath, openaiKey)`. Path validated against `BRAIN_DIRS` allowlist.

`COSMO_BRAIN_DIRS`: comma-separated paths in env, or `config.json → features.brains.directories[]`. Each directory recursively scanned for subdirs containing `state.json.gz`.

Operational details:

- Brain loading is **singleton + hot-swappable**. `unloadBrain()` is called before loading a new brain; previous query engine is disposed/closed first.
- Picker/list routes are separate from load routes:
  - `/api/brains/locations` → configured brain roots + availability/counts
  - `/api/brains/list` → brains within those roots, with optional exact counts (`counts=1`) or fast size estimates
  - `/api/brain/info` → currently loaded brain, outputs path, admin status
- UI brain selection is **non-blocking** relative to folder selection. Loading a brain does not switch the current folder; it updates brain state, enables the `Use Brain` toggle, refreshes brain-aware panels, and clears stale chat context.
- Brain picker persists last loaded brain path and a short recent-brains list in localStorage so the UI can restore context across refreshes.

### Semantic Search (`lib/query-engine.js`, ~4000 lines)

**Embedding model:** `text-embedding-3-small` with `dimensions: 512`. Must match brain file embeddings.

**Scoring:** `combined = (semanticScore * 0.7 + keywordScore * 0.3) * (0.5 + activation * weight)`. Tag boosts: `agent_finding` ×1.5, `breakthrough` ×1.6. De-boosts: `meta` ×0.5, `agent_insight` ×0.6. Pre-filter removes `dream`/`reasoning`/`introspection` nodes.

**Context assembly (`buildContext`):** Model-aware node limits (Claude Opus: 4000, GPT-5: 3000, default: 2500). Tiered truncation: top 20 nodes at 2000 chars, 21-100 at 1000, 101-200 at 700, 201+ at 500. Includes goals, thoughts, coordinator reviews, agent output files.

**Live journal merge:** Scans `agents/agent_N/findings.jsonl` for active runs. Baseline nodes take priority; live entries only added if not already captured.

**Output-file context:** `executeEnhancedQuery()` can scan `outputs/` plus deliverables/code/execution artifacts. It prefers memory-guided document loading when available, but still includes filesystem-derived deliverables/code/execution so the query sees both semantic relevance and the concrete work product.

**Follow-up context:** `/api/brain/query/stream` reconstructs the latest user/assistant pair from `conversationHistory` and passes it as `priorContext`, which is injected into the next query so follow-up questions can refer back to the previous answer.

**Evidence model:** successful queries can attach `metadata.evidenceQuality` (confidence, temporal coverage, consensus, gaps) plus source counts. This is used by exporters and downstream context tracking.

### Brain UI Surface

- Main chat has a **`Use Brain`** toggle plus optional **PGS** controls. PGS controls are disabled unless a brain is loaded and brain context is enabled.
- Brain activity is surfaced in multiple ways:
  - status indicator (`none` / `passive` / `active`)
  - expandable brain-context cards appended into chat when nodes are injected
  - brain drawer with top activated nodes
- The frontend listens for `brain_search` / `brain_context` events from the AI route and updates the UI live as retrieval happens.
- Query/Explore tabs are hidden entirely if the brains feature is disabled in `/api/config`.

### PGS — Partitioned Graph Synthesis (`lib/pgs-engine.js`)

For brains too large for single-pass context. Decomposes graph into communities via Louvain, runs parallel LLM sweeps per community, then synthesizes.

**Phases:** (0) Partition — Louvain community detection, cached in `partitions.json` (hash-validated by node/edge count + timestamp). Target partition sizes: 200-1800 nodes. (1) Route — cosine similarity of query embedding vs partition centroid embeddings. (2) Sweep — parallel batches of 5, **hardcoded to `claude-sonnet-4-6`** regardless of user model. Each partition's nodes formatted with IDs/tags/weights, 6000 max output tokens. (3) Synthesize — user-selected model, `reasoningEffort: high`, 16000 output tokens.

**Sweep depth chips:** Skim (10%), Sample (25%, default), Deep (50%), Full (100%). Fraction applies to routed partitions only, not all partitions.

**Session modes:** `full` (default, reset), `continue` (skip already-swept), `targeted` (re-route among unsearched).

Runtime details:

- PGS is entered through `executeEnhancedQuery()` when `enablePGS=true`; standard brain queries and PGS queries share the same endpoint contract.
- Session state is persisted in `pgs-sessions/<sessionId>.json`, so users can resume or continue previous sweeps.
- `partitions.json` is a disk cache; stale cache is invalidated when the brain hash changes.
- SSE/streaming callers receive rich chunk events (`pgs_init`, `pgs_phase`, `pgs_session_updated`, `progress`) so long-running sweeps can show real progress instead of looking frozen.
- Standard brain retrieval is the fast, selective context-injection path for the main AI loop; PGS is the deeper, slower, explicit retrieval strategy surfaced to the user.

### Codebase Indexer (`server/codebase-indexer.js`)

Separate from brain search. Uses `text-embedding-3-small` at **default 1536 dimensions** (different vector space from brain 512d — not compatible). String-prefix chunking by function/class declarations. In-memory index only — lost on restart. Max 100 files per folder.

---

## IDE Features

### Terminal System

**Server:** `server/terminal/session-manager.js` — `node-pty` sessions with 24-char hex IDs. Rolling buffer capped at 2MB. Idle sweep every 30s, kills sessions with 0 connections after 30 min. `runCompatibilityCommand()` provides AI a sync "run and get output" interface via PTY + exit-marker pattern.

**WebSocket protocol** (`server/terminal/ws-protocol.js`): Messages: `attach`, `input`, `resize`, `close`, `ping`, `list` (inbound); `ready` (with scrollback replay), `output`, `exit`, `state`, `error`, `pong`, `sessions` (outbound). Backpressure: 256KB high watermark, queues messages and pauses PTY via `pty.pause()`.

**Frontend** (`public/js/terminal.js`): xterm.js with FitAddon/WebLinksAddon/SearchAddon. Client ID persisted in localStorage. Auto-reconnects on WS close (1200ms debounce). Session restore on page refresh via `GET /api/terminal/sessions`.

### PDF Preview

PDF.js is loaded lazily from CDN on first PDF open. Renders inside the existing preview pane with page navigation and zoom controls. Wired into `updatePreview()` in `public/index.html`. The PDF MIME type (`application/pdf`) was added to `/api/serve-file` so the browser receives the correct content-type for inline rendering.

### File Download Enhancements

**`GET /api/folder/download-zip`** — streams a ZIP archive of a directory using the `archiver` package. 500MB cap, skips `node_modules/` and `.git/`. No intermediate file on disk; streams directly to response.

Frontend functions: `downloadFileByPath()` (direct browser download of a single file), `downloadFolderAsZip()` (calls download-zip endpoint). Both are triggered from the file tree right-click context menu: "Download" on files, "Download as ZIP" on folders.

### File Operations

REST endpoints at `/api/folder/*`: `browse` (recursive with configurable depth, max 12K entries), `read`, `write`, `create`, `delete`, `upload-binary`, `write-docx`, `download-zip`. No rename/move endpoint.

### Editor (`public/js/editor.js`)

Monaco Editor from CDN. Single instance, multi-file via `openFiles` Map. View state (scroll, cursor) saved per file on tab switch. `Cmd+S` saves, `Cmd+W` closes tab.

---

## Security

### Two Profiles (`lib/security-profile.js`)

**Local (default):** CORS restricted to localhost/RFC-1918/.local. File boundary is the loaded brain folder (or unrestricted for admin). Terminal always allowed. All write endpoints open.

**Internet:** Reverse proxy required. Every `/api/` route (except `/api/health`) requires `x-evobrew-proxy-secret` header (timing-safe comparison) + authenticated user header. CORS fully open (proxy is the trust boundary). File paths hard-clamped to `WORKSPACE_ROOT`. Three opt-in flags (all false by default): `INTERNET_ENABLE_MUTATIONS`, `INTERNET_ENABLE_GATEWAY_PROXY`, `INTERNET_ENABLE_TERMINAL`.

### Path Traversal Prevention

Dual-layer on every file operation: (1) string-normalized containment check against allowed root, (2) `realpathSync` canonical check (catches symlink escapes). Null bytes rejected explicitly.

### OAuth Flows

**Anthropic:** PKCE flow via Claude CLI token import (`~/.claude/auth.json` → encrypted in SQLite). Auto-refresh via `refreshAccessToken()`. Stealth headers required (impersonates Claude Code CLI). System prompt prefix mandatory for OAuth tokens.

**OpenAI Codex:** Separate PKCE implementation in `lib/oauth-codex.cjs`. Local HTTP server on port 1455 catches callback. Tokens stored in `~/.evobrew/auth-profiles.json`. Account ID extracted from JWT for `chatgpt-account-id` header.

### Security Headers

`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, CSP with `unsafe-inline`/`unsafe-eval` (required for inline-heavy UI).

---

## Cross-Cutting Connections

### OpenClaw/COZ Integration

Two integration points: (1) COZ as virtual AI model (`openclaw:coz` in dropdown) — frontend detects prefix, bypasses `/api/chat`, sends directly to Gateway WebSocket with IDE context. (2) WebSocket proxy at `/api/gateway-ws` — raw TCP pipe to `OPENCLAW_GATEWAY_HOST:OPENCLAW_GATEWAY_PORT` for HTTPS mixed-content bypass.

More precise architecture:

- OpenClaw is exposed as a **virtual provider option** in `/api/providers/models`, labeled `COZ — Agent with Memory`. It is not part of the provider registry.
- There are **two distinct OpenClaw sessions** in the UI:
  - `evobrew:sidebar` — dedicated OpenClaw tab/chat
  - `evobrew:main` — model-picker path used when the main assistant is set to OpenClaw
- Browser auth is mediated through **`/api/gateway-auth`**. The frontend fetches connect-level auth params from the Evobrew server, so gateway credentials stay server-side.
- Browser always connects to **`/api/gateway-ws`**; the server uses `net.connect()` and rewrites the WebSocket upgrade (`Origin`, query auth params) before piping frames to the Gateway. This is a raw TCP passthrough, not a ws-to-ws relay.
- In **internet profile**, gateway proxying can be disabled independently via `INTERNET_ENABLE_GATEWAY_PROXY=false`; if enabled, it still requires proxy-secret auth on upgrade.
- Main-chat OpenClaw requests are **context-enriched in the frontend** before being sent to Gateway: current file, selected text, brain status/path, and file-tree context are wrapped into the message.
- Gateway events drive the UI directly: `connect.challenge` → send connect request, `agent` events stream deltas/lifecycle, `chat` final events provide deduped final responses.
- Session keys coming back from Gateway may be prefixed; frontend handlers intentionally match with `endsWith(':evobrew:main')` / `endsWith(':evobrew:sidebar')` semantics.
- Safe config exposed to the frontend via `/api/config` controls whether the OpenClaw tab is shown and what custom tab label (`openclaw.tab_name`) to use.

### OnlyOffice / Collabora

Dual document editor integration. Server acts as WOPI host. OnlyOffice: download/save callbacks with HMAC-SHA-256 token verification and callback URL allowlist (anti-SSRF). Collabora: WOPI CheckFileInfo/GetFile/PutFile endpoints. Both share the same signing secret and proxy path.

### WebSocket Architecture

Two WS servers + one raw TCP proxy, all attached to both HTTP and HTTPS:
- `/api/terminal/ws` — `WebSocketServer({ noServer: true })` on `upgrade` event, PTY I/O
- `/api/gateway-ws` — raw `net.connect()` TCP pipe (not ws-to-ws relay), transparent frame passthrough

---

## server.js Line Map

Key sections in the 4200+ line monolith:
- `~line 100–300` — startup, provider init, middleware
- `~line 800–1200` — file operation endpoints (`/api/folder/*`)
- `~line 1500–2500` — AI chat endpoint (`POST /api/chat`) — calls `ai-handler.js`
- `~line 2800–3200` — brain/PGS endpoints
- `~line 3139–3220` — `GET /api/providers/models` — dropdown model list with dynamic fetching
- `~line 3600+` — terminal WebSocket, OpenClaw proxy

## Key API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chat` | Main AI endpoint — SSE streaming |
| `GET` | `/api/providers/models` | Model list for UI dropdown |
| `GET` | `/api/providers/status` | Provider health check |
| `GET` | `/api/folder/browse` | List directory |
| `GET` | `/api/folder/read` | Read file |
| `PUT` | `/api/folder/write` | Write file |
| `POST` | `/api/folder/create` | Create file/directory |
| `DELETE` | `/api/folder/delete` | Delete file |
| `POST` | `/api/brain/query` | Query a .brain package |
| `POST` | `/api/brain/query/stream` | SSE streaming brain query |
| `POST` | `/api/brain/load` | Load a brain by path |
| `GET` | `/api/brains/list` | List all brains across BRAIN_DIRS |
| `POST` | `/api/index-folder` | Index codebase for semantic search |
| `POST` | `/api/codebase-search` | Semantic code search |
| `GET` | `/api/conversations` | List saved conversations |
| `GET` | `/api/folder/download-zip` | Stream ZIP archive of a directory |
| `GET` | `/api/setup/scan-agents` | Scan localhost:4600-4660 for local agents |
| `POST` | `/api/setup/local-agent/save` | Verify and save a local agent config |
| `POST` | `/api/setup/local-agent/test` | Test local agent connectivity |
| `POST` | `/api/setup/local-agent/remove` | Remove a local agent from config |
| `WS` | `/api/terminal/ws` | PTY terminal WebSocket |
| `WS` | `/api/gateway-ws` | OpenClaw gateway proxy |

---

## Common Pitfalls

- **Provider not in dropdown** — Verify `initializeProvider()` called in `providers/index.js` AND `getAvailableModels()` returns non-empty
- **Model routes to wrong provider** — Check `parseProviderId()` heuristics in `registry.js`. Models with colons default to Ollama; cloud models with colons need explicit heuristics
- **Wizard missing provider** — Check `providerOptions` array in `stepProviders()` in `setup-wizard.js`
- **Terminal broken on Pi** — `node-pty` needs native ARM compilation
- **Brain not loading** — Check `COSMO_BRAIN_DIRS` in config (comma-separated paths). Path must be in BRAIN_DIRS allowlist
- **OpenAI-compatible model acts like a generic chatbot** — Check whether inline `system` messages are being preserved in `server/providers/adapters/openai.js`; losing them strips IDE identity, tool guidance, brain strategy, open-files context, and history summary
- **Ollama/Ollama Cloud stream format mismatch** — consumers may need to handle both `content_delta` and `text`/`done` chunk styles depending on provider/model path
- **Ollama Cloud tool failures with nearly-correct args** — inspect `server/tools.js` normalization path; some models emit aliases like `path` instead of `directory_path`
- **Codex tools breaking** — `ai-handler.js`'s `buildOpenAIResponsesToolsFromChatTools()` does stricter JSON Schema normalization than `OpenAIAdapter._convertToolsForResponses()`. Check the handler version first
- **Registry singleton stale** — Provider registration state determined once at first call, never re-evaluated unless `resetDefaultRegistry()` called
- **OAuth token refresh** — AnthropicClient has 50-min refresh window. AnthropicAdapter does not have periodic refresh. Legacy client handles OAuth lifecycle better
- **Port conflict on direct server start** — `node server/server.js` has no EADDRINUSE handler; only `evobrew start` does the pre-flight port check
- **Edit queue lost on refresh** — Pending edits are in-memory only, not persisted to localStorage
- **`create_file` bypasses approval** — Unlike edit tools, `create_file` writes directly to disk without user review
- **PGS sweeps always use Claude** — Hardcoded to `claude-sonnet-4-6` regardless of user model selection (synthesis uses user model)
- **Codebase indexer vs brain embeddings** — Codebase uses 1536d, brain uses 512d. Different vector spaces, not interchangeable
- **Local agent not appearing in dropdown** — Verify `config.providers.local_agents[]` entry exists, `decryptAgentKey()` is not throwing, and `initializeProvider('local:<id>', ...)` is called in `providers/index.js` init loop
- **Local agent routes to wrong provider** — `parseProviderId()` must match `local:` prefix before the Ollama colon heuristic fires; colons in model IDs default to Ollama without the prefix check
- **PDF not rendering inline** — Check that `/api/serve-file` is returning `Content-Type: application/pdf` and that PDF.js CDN loaded successfully (lazy, only on first PDF open)
- **ZIP download hangs or truncates** — `archiver` streams directly; any unhandled `error` event on the archive will silently terminate the stream. Check server logs for archiver errors on large directories
- **Overflow menu broken after ui-shell.js load** — `initUIRefresh(true)` must be called after ui-shell.js loads. If the overflow menu stops working, verify that call is present and not being skipped by early-exit logic
