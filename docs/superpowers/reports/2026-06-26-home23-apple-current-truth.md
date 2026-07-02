# Home23 Apple Current Truth Report

Captured: `2026-06-26T14:28:00Z`

Scope: backend repo `/Users/jtr/_JTR23_/release/home23`; Apple repo `/Users/jtr/xCode_Builds/Home23`.

## Command Evidence

Commands run from `/Users/jtr/_JTR23_/release/home23` unless another directory is shown:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
pm2 jlist | python3 -c "import sys,json; data=json.load(sys.stdin); [print(f\"{p['name']:30s} {p['pm2_env']['status']:10s} pid={p['pid']} restarts={p['pm2_env'].get('restart_time')}\") for p in data if p['name'].startswith('home23-')]"
curl -sS http://localhost:5002/api/state | python3 -m json.tool
curl -sS http://localhost:5004/health | python3 -m json.tool
curl -sS http://localhost:5004/api/chat/models | python3 -m json.tool
curl -sS http://localhost:43210/api/status | python3 -m json.tool
curl -sS http://localhost:5002/home23/api/settings/agents | python3 -m json.tool
curl -sS -i http://localhost:5002/home23/api/client-capabilities
rg -n "bridgeApp\.(get|post|delete|put)|this\.app\.(get|post|delete|put)\('/(?:home23/)?api/(?:chat|device|settings|query|tiles|media|brain|providers)|this\.app\.(get|post|delete|put)\('/home23/api" src/home.ts engine/src/dashboard/server.js src/routes/chat-turn.ts src/routes/chat-history.ts src/routes/device.ts
cd /Users/jtr/xCode_Builds/Home23 && rg -n "43210|api/providers/models|api/brains|api/query|api/chat/turn|api/chat/stream|api/chat/pending|api/chat/stop-turn|api/chat/models|api/device/register|client-capabilities|settings/query|settings/models|settings/agents|tiles/sauna-control|home23/api/media" Home23/Sources Home23Shared/Sources Home23TV
diff -qr contracts /Users/jtr/xCode_Builds/Home23/contracts || true
node -e "const p=require('./package.json'); console.log(JSON.stringify({scripts:p.scripts, devDependencies:p.devDependencies, dependencies:p.dependencies}, null, 2))"
find tests -maxdepth 3 -type f | sort | rg "contract|chat-turn|device|query|settings|home23-tiles"
```

The sections below quote the relevant command output directly or summarize it where the raw search output was too large to keep readable.

## Backend Runtime

Read-only PM2 and localhost probes showed Home23 is running and Jerry's brain is loaded.

Home23-family PM2 processes:

```text
home23-evobrew                 online     pid=35051 restarts=1
home23-screenlogic             online     pid=35097 restarts=1
home23-cosmo23                 online     pid=86737 restarts=12
home23-chrome-cdp              online     pid=37319 restarts=0
home23-forrest-harness         online     pid=92103 restarts=27
home23-forrest                 online     pid=90660 restarts=25
home23-jerry                   online     pid=77969 restarts=70
home23-dashboard               online     pid=86834 restarts=9
home23-forrest-dash            online     pid=59742 restarts=4
home23-jerry-harness           online     pid=18208 restarts=33
home23-jerry-dash              online     pid=43513 restarts=7
```

Jerry engine state from `http://localhost:5002/api/state`:

- `cycleCount`: `33296`
- `phase`: `journal_freshness`
- `memory.nodes`: `119959`
- `memory.edges`: `388646`
- `goals.active`: `17`
- `temporal.state`: `awake`
- `lastThoughtAt`: `2026-06-26T14:26:16.135Z`

Jerry bridge health from `http://localhost:5004/health`:

```json
{
  "status": "ok",
  "agent": "jerry",
  "type": "cosmohome",
  "endpoint": "/api/chat",
  "model": "claude-opus-4-8",
  "provider": "anthropic"
}
```

Jerry chat model catalog from `http://localhost:5004/api/chat/models`:

- `defaultProvider`: `anthropic`
- `defaultModel`: `claude-opus-4-8`
- aliases include Anthropic, OpenAI Codex, xAI, Ollama Cloud, and MiniMax entries.

Agent roster from `http://localhost:5002/home23/api/settings/agents`:

- `primaryAgent`: `jerry`
- `currentAgent`: `jerry`
- `jerry`: running, dashboard `5002`, bridge `5004`, primary true.
- `forrest`: running, dashboard `5012`, bridge `5014`, primary false.

COSMO23 status from `http://localhost:43210/api/status`:

- API reachable: true
- `running`: false
- `lifecycle`: `idle`
- `activeRun`: false
- `processOnline`: false
- ports remain declared as app `43210`, websocket `43240`, dashboard `43244`, MCP HTTP `43247`.

## Backend Routes

Bridge route registrations in `src/home.ts` currently include:

- `POST /api/chat/turn`
- `GET /api/chat/stream`
- `POST /api/chat/stop-turn`
- `GET /api/chat/pending`
- `GET /api/chat/models`
- `GET /api/chat/media`
- `POST /api/device/register`
- `DELETE /api/device/register`
- `GET /api/device/registry`
- `GET /api/chat/history`
- `GET /api/chat/conversations`
- `GET /health`

Dashboard route registrations in `engine/src/dashboard/server.js` currently include:

- `GET /home23/api/scope`
- `GET /home23/api/brain/current`
- `GET /home23/api/tiles/config`
- `GET /home23/api/tiles/:tileId/data`
- `POST /home23/api/tiles/:tileId/actions/:actionId`
- `GET /home23/api/workers*`
- `GET /home23/api/settings/*`
- `GET /home23/api/chat/conversations/:agent`
- `GET /home23/api/chat/history/:agent`
- `GET /home23/api/chat/config/:agent`
- `GET /home23/api/vibe/*`
- `GET /home23/api/media`
- `GET /home23/api/brain/graph`
- `POST /api/query`
- `GET /api/query/history`
- `GET /api/query/suggestions`
- `POST /api/query/followup`
- `GET /api/query/models`
- `GET /api/query/backend-info`
- `POST /api/query/ai-review`
- `GET /api/query/ai-review-status/:runName`

Verified missing or drifted routes:

- `GET /home23/api/client-capabilities` returned `404 Cannot GET /home23/api/client-capabilities`.
- `GET /api/chat/turn-status` is not registered.
- `GET /home23/api/query/catalog`, `POST /home23/api/query/run`, and `GET /home23/api/query/stream` are not registered.
- Dashboard query routes exist as `/api/query*`, not as a selected-agent Apple facade.

Chat lifecycle source truth:

- `createTurnStartHandler` only checks `config.agent.isRunning(chatId)` before looking at persisted pending turns. Persisted pending turns are not a standalone restart-safe concurrency gate.
- `createTurnStreamHandler` replays persisted events, checks final envelope, then subscribes to `turnBus`; a terminal envelope can land between those operations.
- `createTurnStopHandler` reads only `chatId`; it ignores `turn_id`.
- `createPendingTurnsHandler` calls `store.sweepOrphans(chatId, 10 * 60 * 1000)` while handling a client polling request.

Device route source truth:

- `POST /api/device/register` accepts `device_token`, `chat_ids`, `bundle_id`, and `env`.
- `GET /api/device/registry` currently returns `devices` without calling `checkAuth`.

## Contracts And Fixtures

Backend contract files:

```text
contracts/README.md
contracts/fixtures/agent-roster.json
contracts/fixtures/chat-turn-event.json
contracts/fixtures/client-capabilities.json
contracts/fixtures/query-result.json
contracts/fixtures/sauna-tile.json
contracts/fixtures/settings-status.json
contracts/schemas/agent-roster.schema.json
contracts/schemas/chat.schema.json
contracts/schemas/client-capabilities.schema.json
contracts/schemas/home-surfaces.schema.json
contracts/schemas/query.schema.json
contracts/schemas/sauna.schema.json
contracts/schemas/settings.schema.json
```

Backend and Apple contract trees differ as follows:

```text
Files contracts/.DS_Store and /Users/jtr/xCode_Builds/Home23/contracts/.DS_Store differ
Files contracts/README.md and /Users/jtr/xCode_Builds/Home23/contracts/README.md differ
Only in /Users/jtr/xCode_Builds/Home23/contracts: worker-agents.md
```

Current backend package/test state:

- `tsx` is already present in `devDependencies`.
- `ajv` is not installed.
- No `test:contracts` or `test:contracts:live` script exists.
- No `tests/contracts/` suite exists.
- Existing relevant tests include `tests/agent/chat-turn-images.test.ts`, `tests/engine/channels/contract.test.js`, and `tests/engine/dashboard/home23-tiles.test.js`.

Current schema gaps:

- `chat.schema.json` has `startTurnResponse`, `turnEnvelope`, `turnEvent`, `pendingTurnsResponse`, `conversation`, and `modelsResponse`, but no canonical `turnStatus` definition.
- `client-capabilities.schema.json` is minimal: `contractVersion`, `features`, and `endpoints`.
- There is no manifest mapping schemas, fixtures, live routes, auth mode, and Apple consumers.
- There are no contract fixtures for turn start, pending envelope, terminal envelope, turn status, models, pending response, conversations, history, device registration, device registry, settings scope, settings query, query catalog, query stream events, home actions, or worker agents.

## Apple Client Surfaces

Apple files found under `/Users/jtr/xCode_Builds/Home23` include full iOS/Mac sources, `Home23Shared`, `Home23TV`, and a copied `contracts/` snapshot.

Current Apple route usage:

- `AgentDirectory` fetches `/home23/api/settings/agents`.
- `ModelCatalog` fetches `/api/chat/models` from the selected bridge.
- `ChatViewModel` posts `/api/chat/turn`, posts `/api/chat/stop-turn`, polls `/api/chat/pending`, and opens `/api/chat/stream`.
- `ChatViewModel` uses `host.bridgeURL(for: agent)`, so selected-agent chat routing is structurally correct.
- `PushRegistrar` posts `/api/device/register`.
- `SaunaTabView` uses `/home23/api/tiles/sauna-control/data` and `/home23/api/tiles/sauna-control/actions/<id>` through the global dashboard URL.
- `SettingsControlCenter` uses `/home23/api/settings/models`, `/home23/api/settings/query`, and agent lifecycle routes.
- `QueryTabView` fetches `/home23/api/settings/query`, then directly reaches COSMO with `/api/providers/models`, `/api/brains`, and port `43210`.
- `SettingsControlCenter` also directly reaches COSMO port `43210` for `/api/providers/models`.
- Settings UI still displays endpoint copy naming `/api/query`, `/api/query/models`, and `/api/providers/models`.
- tvOS uses settings agents, sauna tile routes, chat turn/stream/stop routes, and selected bridge/dashboard URL helpers. It does not implement full iOS Query or Settings parity.

Swift shared test state:

- `ContractFixtureDecodeTests.swift` decodes only `AgentListResponse` and `TurnEvent` as typed fixtures.
- `client-capabilities`, `query-result`, `settings-status`, and `sauna-tile` are only parsed as generic JSON objects.

## Drift Findings

1. Client capabilities are documented and fixture-backed, but the live route is absent.
2. Chat has no canonical status endpoint, so iOS cannot distinguish waiting, streaming, tool-running, stopped, orphaned, timeout, provider error, or complete without guessing from pending/stream behavior.
3. Stop is not turn-scoped even though clients send or can send a `turn_id`.
4. Pending polling mutates state by sweeping orphans, which makes a user opening the app part of backend recovery behavior.
5. Device registry diagnostics are not auth-gated in `src/routes/device.ts`.
6. Device registration has no explicit platform/app build/contract metadata and is not per-agent in the request contract.
7. Query is not backend-locked for Apple. The iOS/Mac Query path still depends on hardcoded COSMO port `43210` and direct COSMO routes.
8. COSMO23 is reachable but idle right now, so Query availability must be represented as backend state.
9. Backend contracts lack a manifest and live validation harness.
10. Swift contract tests do not prove most contract fixtures decode into app wire models.
11. Apple contract snapshot has `worker-agents.md`; backend contract source does not.
12. Sauna is backend-backed but house-global; the contract needs to say that explicitly.
13. tvOS is a subset client and must not advertise full iOS capabilities until Query and full Settings exist there.

## Required Fix Lanes

1. Add `contracts/manifest.json`, missing fixtures, AJV fixture validation, and live route validation.
2. Implement `/home23/api/client-capabilities` as the Apple capability and route-truth handshake.
3. Add canonical chat turn status, stop-by-turn behavior, non-mutating pending/status reads, backend orphan recovery, stream race hardening, provider error normalization, and first-token/timeout visibility.
4. Add device registration and registry contracts with auth-gated diagnostics and per-agent receipt semantics.
5. Add Home23 dashboard query facade routes so Apple clients stop calling COSMO directly.
6. Move Apple wire contracts into `Home23Shared` and decode every fixture with typed tests.
7. Update iOS/Mac/tvOS app surfaces to consume capability/status/query contracts instead of hardcoded assumptions.
8. Add app diagnostics for selected agent, bridge/dashboard URLs, health, model catalog, active turn status, query availability, push receipt, and recent endpoint failures.
9. Keep restarts scoped by process name only after code changes and after tests pass.
