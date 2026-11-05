# Home23 Apple Client Contract Lock-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for execution. This is a multi-lane Home23 program, not a single patch. Track progress by checking off the `- [ ]` items in this file as each step is completed and verified.

**Goal:** Prove the current Home23 backend truth, harden every Apple-client contract surface, and bring the Home23 iOS app fully into parity with the live backend across Home, Query, Chat, Sauna, Settings, and stuck-chat recovery. Mac Catalyst shares the same core contract path. tvOS must advertise only the subset it actually supports until it implements the full iOS surface.

**Architecture:** Home23 backend is the source of truth. Apple clients consume an explicit capability and JSON-schema contract layer. The backend owns provider/model truth, route truth, turn lifecycle truth, push registration truth, and house-global vs selected-agent scope. Apple clients display and act on that truth; they do not infer it from old docs, hardcoded ports, or long spinners.

**Tech Stack:** Home23 Node/TypeScript bridge and dashboard routes, JSON Schema contracts under `contracts/`, AJV v8 backend contract validation, Swift/SwiftUI Apple clients in `/Users/jtr/xCode_Builds/Home23`, Swift Package tests in `Home23Shared`, PM2 live runtime verification, Xcode 26.4 build tooling.

---

## Discovery Already Completed

Read-only explorer agents were dispatched before implementation so current truth does not depend on stale handoffs:

- Backend route and contract audit: `019f0449-c730-7513-8217-9362e7436986`.
- Chat turn robustness audit: `019f0449-c865-75a3-899a-dfe6a3d5286d`.
- Apple client implementation audit: `019f0449-c972-74b3-80da-dda98751eca1`.
- Contract parity audit: `019f0449-ca7a-74a0-a29e-13e8d2f98844`.

Their findings are integrated below. If execution discovers a contradiction, update this plan first, then continue.

## Integrated Current Findings

- Live backend was online at discovery time: Home23 PM2 processes were up, `/api/state` returned `cycle=33291` and `nodes=119945`, and COSMO23 `/api/status` reported `running=false`.
- Backend and Apple `contracts/` trees were byte-identical except README wording and an Apple-only `worker-agents.md`.
- `/home23/api/settings/agents`, `/api/chat/turn`, `/api/chat/stream`, `/api/chat/pending`, `/api/chat/stop-turn`, `/api/chat/models`, settings routes, device registration, home surfaces, media, and sauna routes exist.
- `/home23/api/client-capabilities` is contracted but missing live; it returned 404 during audit.
- Existing fixtures are too thin. Missing or drifting fixtures include chat start, chat final envelope, chat models, pending turns, turn status, conversations, device registration, device registry, settings scope/query defaults, provider catalog, brain registry, home tile actions, worker agents, and live query catalog.
- Chat stream events in code use current event names such as `response_chunk`, `thinking`, and `tool_start`; the existing `chat-turn-event` fixture still reflects older names.
- `/api/chat/stop-turn` ignores `turn_id` and stops by `chatId`, which can stop the wrong turn or leave the requested turn without a truthful terminal envelope.
- Persisted pending turns are not a real concurrency gate. After restart or lost in-memory state, a second turn can start while old pending records remain.
- Pending/orphan handling is lazy and mutating: polling `/api/chat/pending` can mark old turns orphaned by age without checking live active runs.
- The SSE stream has a replay/final/subscription race that can leave clients receiving only heartbeat comments after a terminal envelope.
- Provider errors are not normalized. Some provider failures return a success-looking final envelope after emitting an error-like chunk, while other providers produce `error`.
- Per-turn model override can mutate shared `AgentLoop` state and leak into later model defaults.
- Apple Chat is the strongest backend-locked surface. Home and Settings are mostly backend-backed. Sauna is backend-backed but house-global. Query is not locked in: it still hardcodes COSMO port `43210` and direct brain/provider routes.
- Push registration uploads all cached chat IDs to one preferred bridge. It is selected-agent aware but not multi-agent safe.
- Apple diagnostics are too shallow to explain stuck chat, auth, selected bridge, query route, push receipt, model catalog, or recent endpoint failures.
- tvOS has Home, Chat, Sauna, and Agents, but not full Query or Settings. It must not silently claim the same capability set as iOS.
- Backend has schemas but no live contract validation harness. Swift fixture tests decode only agent roster and one chat event as typed models.
- Direct TypeScript tests currently depend on `tsx`; execution must verify `tsx` is installed and locked before relying on `node --import tsx`.

## Non-Negotiable Gates

- No Apple UI changes before backend schemas, fixtures, and live contract tests prove the intended wire shape.
- No stale docs as truth. Record live endpoint output, source-code route truth, schema truth, and Apple client usage separately.
- No broad PM2 restarts. Restart only the named process required by a verified backend change.
- No indefinite spinner state. Every chat turn must be visible as `accepted`, `running`, `awaiting_model`, `streaming`, `tool_running`, `stopping`, `stopped`, `complete`, `error`, `timeout`, or `orphaned`.
- No provider-auth guessing in iOS. Provider/model/auth truth comes from backend health, model catalog, and turn status.
- No hardcoded COSMO port in the Apple Query path. Query route truth comes from backend capability/catalog endpoints.
- No discard or reset of existing local work in either repo.

## Execution Closeout Update

Status after the implementation pass on 2026-06-26:

- Current truth report exists at `docs/superpowers/reports/2026-06-26-home23-apple-current-truth.md`.
- Verification receipt exists at `docs/superpowers/reports/2026-06-26-home23-apple-contract-lock-in-verification.md`.
- Backend contract manifest, schemas, fixtures, AJV tests, client capabilities, query catalog facade, query export facade, chat turn status, stop-by-turn hardening, device receipt hardening, scoped device unregister, and Sauna action metadata are implemented and tested.
- Apple `Home23Shared` contract snapshot and fixture decode tests are implemented and passing.
- Apple app now loads backend capabilities, routes Query through `/home23/api/query/*`, exposes stuck-chat turn status controls, stops by `turn_id`, records per-agent push registration receipts, renders Sauna action field metadata, centralizes status vocabulary, and gates tvOS sections from backend capability truth.
- Safe live backend validation passes. Bounded chat, device, query run/export/stream, and tile action probes pass. Query run/export and tile actions use explicit dry-run/validate-only semantics for live validation without forwarding to COSMO23 or house devices.
- Mac Catalyst build passes. The missing shared `Home23` scheme was restored and is now visible to Xcode. iOS and tvOS generic device builds are blocked by local Xcode destination/platform installation, not by a proven source compile error.
- Final Apple parity pass added provider-aware Query/Settings model identity, raw model/provider save/run payloads, Settings restart receipts, iPad/iOS worker capability gating, iOS Settings route navigation, and visible stuck-chat recovery banners for missing/inactive turns.
- Final verification at 2026-06-26 13:05 EDT: `npm run test:contracts` passed 12/13 with the live shim skipped; focused query/tile tests passed 18/18; safe and action-gated live contract validators passed; `Home23Shared swift test` passed 10/10; Apple endpoint categorization passed 109 checks; Mac Catalyst build succeeded. Fresh iOS/tvOS destination checks still show missing local iOS/tvOS 26.4 platform components and zero installed simulator runtimes.
- The Home23 and Apple worktrees contain broad pre-existing local work; do not blanket stage or commit without intentional scope selection.

---

## Task 1: Freeze Current Truth

**Files:**

- Read: `AGENTS.md`
- Read: `/Users/jtr/xCode_Builds/Home23/AGENTS.md`
- Read: `docs/ios-parity.md`
- Read: `/Users/jtr/xCode_Builds/Home23/docs/ios-parity.md`
- Create: `docs/superpowers/reports/2026-06-26-home23-apple-current-truth.md`

- [x] **Step 1: Capture backend runtime truth**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
pm2 jlist | python3 -c "import sys,json; data=json.load(sys.stdin); [print(f\"{p['name']:30s} {p['pm2_env']['status']:10s} pid={p['pid']} restarts={p['pm2_env'].get('restart_time')}\") for p in data if p['name'].startswith('home23-')]"
curl -sS http://localhost:5002/api/state | python3 -m json.tool
curl -sS http://localhost:5004/health | python3 -m json.tool
curl -sS http://localhost:5004/api/chat/models | python3 -m json.tool
curl -sS http://localhost:5002/home23/api/settings/agents | python3 -m json.tool
curl -sS http://localhost:43210/api/status | python3 -m json.tool
```

Expected:

- Report process status, PID, and restart counts for Home23-family processes.
- Report engine state cycle and node count.
- Report Jerry bridge provider/model truth from `/health` and `/api/chat/models`.
- Report current COSMO23 running state; do not assume it is active.

- [x] **Step 2: Capture backend route inventory**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
rg -n "client-capabilities|api/chat|api/device|settings/agents|settings/status|settings/models|settings/query|home23/api/query|api/query|api/tiles|api/media|sauna|providers/models|api/brains" src engine/src contracts tests
```

Expected:

- The report lists implemented routes, contracted routes, and missing live routes.
- `/home23/api/client-capabilities` is recorded as a required missing route until implemented.
- Query route ambiguity is recorded as a product/backend contract gap, not an iOS implementation detail.

- [x] **Step 3: Capture Apple client endpoint inventory**

Run:

```bash
cd /Users/jtr/xCode_Builds/Home23
find Home23 Home23Shared Home23TV contracts -maxdepth 5 -type f \( -name '*.swift' -o -name '*.json' -o -name '*.md' \) | sort
rg -n "bridgeURL|dashboardURL|client-capabilities|PendingTurnsResponse|TurnEnvelope|TurnStream|ModelCatalog|SettingsControlCenter|Sauna|Query|HomeTile|stopTurn|resume|PushRegistrar|PushRouter|43210|providers/models|api/brains" Home23 Home23Shared Home23TV contracts
```

Expected:

- The report maps each Apple surface to exact backend endpoints and Swift files.
- Hardcoded ports, stale fixture names, single-agent push assumptions, and missing capability gates are listed.

- [x] **Step 4: Write truth report**

Create `docs/superpowers/reports/2026-06-26-home23-apple-current-truth.md` with:

```markdown
# Home23 Apple Current Truth Report

## Backend Runtime

## Backend Routes

## Contracts And Fixtures

## Apple Client Surfaces

## Drift Findings

## Required Fix Lanes
```

Expected:

- Each claim cites command output and timestamp.
- Findings distinguish live runtime truth, source-code truth, contract truth, and old documentation.

---

## Task 2: Establish Contract Manifest And AJV Harness

**Files:**

- Create: `contracts/manifest.json`
- Create: `tests/contracts/contract-validator.cjs`
- Create: `tests/contracts/fixtures-schema.test.cjs`
- Create: `tests/contracts/live-backend-contracts.test.cjs`
- Create: `scripts/validate-live-contracts.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `contracts/fixtures/*.json`
- Modify: `contracts/schemas/*.schema.json`

- [x] **Step 1: Add locked validator dependencies and scripts**

Run only package-manager commands that preserve lockfile integrity:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm install --save-dev ajv@^8 tsx
```

Add scripts:

```json
{
  "test:contracts": "node --test --test-concurrency=1 tests/contracts/*.test.cjs",
  "test:contracts:live": "node scripts/validate-live-contracts.mjs"
}
```

Expected:

- `ajv` and `tsx` resolve from the local checkout.
- Existing unrelated `package.json` and `package-lock.json` changes are preserved.

- [x] **Step 2: Add `contracts/manifest.json`**

The manifest must include contract version, endpoint family, method, route, schema file, schema definition, fixture file, auth mode, live validation mode, and Apple surface consumers.

Required entries:

- `agent-roster`: `GET /home23/api/settings/agents`
- `client-capabilities`: `GET /home23/api/client-capabilities`
- `chat-turn-start`: `POST /api/chat/turn`
- `chat-turn-event`: SSE item from `GET /api/chat/stream`
- `chat-turn-envelope`: pending and terminal turn envelope
- `chat-turn-status`: `GET /api/chat/turn-status`
- `chat-models`: `GET /api/chat/models`
- `chat-pending`: `GET /api/chat/pending`
- `chat-conversations`: `GET /api/chat/conversations`
- `chat-history`: `GET /api/chat/history`
- `settings-status`: `GET /home23/api/settings/status`
- `settings-scope`: `GET /home23/api/settings/scope`
- `settings-models`: `GET /home23/api/settings/models`
- `settings-query`: `GET /home23/api/settings/query`
- `query-catalog`: `GET /home23/api/query/catalog`
- `query-result`: `POST /home23/api/query/run`
- `query-stream-event`: SSE item from `GET /home23/api/query/stream`
- `home-surfaces`: home cards, goals, and actions
- `sauna-tile`: `GET /home23/api/tiles/sauna-control`
- `device-register`: `POST /api/device/register`
- `device-registry`: `GET /api/device/registry`
- `worker-agents`: worker-agent roster and capabilities

Expected:

- Every Apple-consumed route has a manifest entry.
- Stream endpoints validate individual events and final envelopes, not only connection success.

- [x] **Step 3: Fill missing fixtures and schema definitions**

Add fixtures and schema definitions for every manifest entry. Existing schemas may keep `additionalProperties: true` for forward compatibility, but required fields must represent real client needs.

Required fixture additions:

- `chat-turn-start.json`
- `chat-turn-envelope-pending.json`
- `chat-turn-envelope-complete.json`
- `chat-turn-envelope-error.json`
- `chat-turn-status.json`
- `chat-models.json`
- `chat-pending.json`
- `chat-conversations.json`
- `chat-history.json`
- `device-register-request.json`
- `device-register-response.json`
- `device-registry.json`
- `settings-scope.json`
- `settings-query.json`
- `query-catalog.json`
- `query-stream-event.json`
- `home-tile-action.json`
- `worker-agents.json`

Expected:

- Fixtures mirror current route names such as `response_chunk`, `thinking`, and `tool_start`.
- Conversation schema accepts the live bridge shape or the live bridge is intentionally changed to match the schema.
- Sauna schema reflects live `targetTemperature` unless the backend is intentionally changed to `targetTempF`.

- [x] **Step 4: Add fixture validation tests**

`tests/contracts/fixtures-schema.test.cjs` must:

- Load `contracts/manifest.json`.
- Compile schemas with AJV v8.
- Validate every listed fixture against its schema and definition.
- Fail on missing fixture, missing schema, missing definition, invalid JSON, and invalid schema.

Expected:

- Fixture/schema drift fails before app code changes.

- [x] **Step 5: Add live backend validation**

`scripts/validate-live-contracts.mjs` and `tests/contracts/live-backend-contracts.test.cjs` must:

- Call live endpoints listed in the manifest where `liveValidation` is enabled.
- Include auth headers when the route requires a bridge token.
- Validate response JSON against the manifest schema definition.
- For SSE routes, start a bounded smoke turn or bounded query and validate at least one event plus the terminal envelope.
- Redact tokens and personal payloads in output.

Expected:

- `/home23/api/client-capabilities` fails live validation until Task 3 implements it.
- A failing route prints route, method, schema definition, and AJV errors.

Execution note:

- Safe read-only live validation is implemented and now passes for all `liveValidation: "safe"` routes, including `query-catalog`.
- Bounded mutating/SSE probes are intentionally gated behind `HOME23_LIVE_CONTRACTS_ACTIONS=1`.
- Chat turn action/SSE/status/stop/pending probes are implemented and pass live.
- Device registration request/response probes are implemented and pass live with synthetic token cleanup.
- Query run/export dry-run probes are implemented and pass live without forwarding to COSMO23.
- Query stream event validation is implemented and passes live against the disabled-stream contract event.
- Tile action dry-run validation is implemented and passes live against the Sauna start action contract without calling HUUM.

- [x] **Step 6: Verify contract harness**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm run test:contracts
node -e "require.resolve('ajv'); require.resolve('tsx'); console.log('contract deps ok')"
```

Expected:

- Static fixture validation passes after schema/fixture updates.
- Live validation is allowed to fail only for routes explicitly listed in the current truth report as not implemented yet.

---

## Task 3: Implement Client Capabilities And Platform Truth

**Files:**

- Create: `engine/src/dashboard/client-capabilities.js`
- Modify: `engine/src/dashboard/server.js`
- Modify: `contracts/schemas/client-capabilities.schema.json`
- Modify: `contracts/fixtures/client-capabilities.json`
- Test: `tests/contracts/client-capabilities-route.test.cjs`

- [x] **Step 1: Define capability payload**

The route must return:

- `contractVersion`
- `generatedAt`
- `server`
- `platforms.ios`
- `platforms.mac`
- `platforms.tvos`
- `features`
- `endpoints`
- `auth`
- `selectedAgent`
- `query`
- `chat`
- `push`
- `houseGlobal`

Decision:

- iOS and Mac advertise Home, Query, Chat, Sauna, Settings, diagnostics, selected-agent chat, query streaming, and push registration.
- tvOS advertises Home, Chat, Sauna, and Agents. Query and full Settings are false until implemented.
- Sauna is marked `houseGlobal: true`.
- Provider auth truth is not exposed as a raw secret check. It is represented through health/model/status endpoints.

- [x] **Step 2: Implement route as a separate module**

Create `engine/src/dashboard/client-capabilities.js` exporting a function that builds the payload from current config and route constants. Register:

```text
GET /home23/api/client-capabilities
```

Expected:

- Route output validates against `client-capabilities.schema.json`.
- Endpoint strings match the routes implemented by the backend, including `/api/chat/turn-status` and `/home23/api/query/catalog`.

- [x] **Step 3: Add route tests**

`tests/contracts/client-capabilities-route.test.cjs` must assert:

- No required Apple route is missing.
- iOS and Mac capability sets include Query, Chat, Settings, Sauna, diagnostics, and push registration.
- tvOS capability set does not claim unsupported Query or full Settings.
- `houseGlobal.sauna` is true.
- Query endpoints point to the Home23 dashboard query facade, not direct COSMO port `43210`.

- [x] **Step 4: Verify live route**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm run test:contracts
node --check engine/src/dashboard/client-capabilities.js
node --check engine/src/dashboard/server.js
pm2 restart home23-jerry-dash
curl -sS http://localhost:5002/home23/api/client-capabilities | python3 -m json.tool
npm run test:contracts:live
```

Expected:

- Scoped dashboard restart only.
- Live route validates.

Execution note:

- `home23-jerry-dash` was restarted by name only and `GET /home23/api/client-capabilities` returned the contract payload.
- `npm run test:contracts`, `node --check engine/src/dashboard/client-capabilities.js`, `node --check engine/src/dashboard/server.js`, scoped dashboard restart, and live `GET /home23/api/client-capabilities` passed for this route.
- Full safe live contract validation now passes. `/api/chat/turn-status` is live and returns JSON status/404 rather than an Express route miss; `GET /home23/api/query/catalog` is live through the Task 6 facade.

---

## Task 4: Normalize Chat Turn Lifecycle And Recovery

**Files:**

- Modify: `src/routes/chat-turn.ts`
- Modify: `src/chat/turn-store.ts`
- Modify: `src/chat/turn-types.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/home.ts`
- Modify: `contracts/schemas/chat.schema.json`
- Add fixtures listed in Task 2
- Test: `tests/agent/chat-turn-status.test.ts`
- Test: `tests/agent/chat-turn-stop.test.ts`
- Test: `tests/agent/chat-turn-pending.test.ts`
- Test: `tests/agent/chat-turn-stream-race.test.ts`
- Test: `tests/agent/loop-provider-error.test.ts`
- Test: `tests/agent/chat-turn-janitor-timeout.test.ts`
- Test: `tests/agent/chat-turn-model-override.test.ts`

- [x] **Step 1: Add canonical status object**

Add `turnStatus` schema and fixture with these required fields:

- `turn_id`
- `chat_id`
- `status`
- `phase`
- `active`
- `started_at`
- `updated_at`
- `last_event_at`
- `last_seq`
- `model`
- `provider`
- `configured_default`
- `runtime_model`
- `recoverable`

Optional fields:

- `first_event_at`
- `deadline_at`
- `first_token_deadline_at`
- `stop_requested_at`
- `stop_reason`
- `error_code`
- `error_message`

Status enum:

- `accepted`
- `running`
- `awaiting_model`
- `streaming`
- `tool_running`
- `stopping`
- `stopped`
- `complete`
- `error`
- `timeout`
- `orphaned`

Execution note:

- `contracts/schemas/chat.schema.json` now defines `turnStatus` with the required fields above, and `contracts/fixtures/chat-turn-status.json` validates through `npm run test:contracts`.

- [x] **Step 2: Implement non-mutating status route**

Register:

```text
GET /api/chat/turn-status?chatId=<chatId>&turn_id=<turn_id>
```

Expected:

- The route never starts, stops, or orphans a turn.
- It returns 404 only when the turn is unknown.
- It reports active in-memory runs and persisted envelopes together.

Execution note:

- `tests/agent/chat-turn-status.test.ts` covers persisted/runtime merge, non-mutating reads, and unknown-turn 404.
- `src/home.ts` registers `GET /api/chat/turn-status`; after scoped `home23-jerry-harness` restart, live `GET /api/chat/turn-status?chatId=ios_contract_smoke&turn_id=t_contract_smoke` returned JSON `{"error":"turn not found"}` with HTTP 404, proving the route is live.

- [x] **Step 3: Make persisted pending a real concurrency gate**

Before accepting a new turn:

- Check active in-memory runs for the chat.
- Check persisted pending/running turns for the chat.
- Allow a new turn only when any older pending turn is terminal, explicitly stopped, or recovered by the backend janitor.

Expected:

- Restart/lost in-memory state cannot create overlapping turns without a truthful recovery decision.

Execution note:

- `createTurnStartHandler` now checks persisted pending turns before starting a new run.
- Fresh persisted pending turns return 409 even when no in-memory run exists.
- Stale persisted pending turns are marked `orphaned` before a new turn is accepted.
- `tests/agent/chat-turn-pending.test.ts` covers fresh blocking and stale recovery.

- [x] **Step 4: Move orphan recovery out of client polling**

Implement boot-time and periodic recovery that:

- Checks persisted pending/running turns.
- Cross-checks active runs.
- Marks stale turns `orphaned`, `timeout`, or `stopped` with `updated_at`, `last_seq`, and recovery reason.

Expected:

- `GET /api/chat/pending` reports state but does not mutate state.

Execution note:

- `GET /api/chat/pending` is now read-only and no longer calls `sweepOrphans`.
- Stale recovery happens on turn start, startup, and a periodic backend janitor.
- `AgentLoop.recoverStaleTurns()` cross-checks in-memory active turn IDs before orphaning persisted pending rows and emits/closes terminal turn bus envelopes for recovered turns.
- `src/home.ts` runs the recovery once at harness startup and every 60 seconds afterward.
- `tests/agent/chat-turn-janitor-timeout.test.ts` proves stale turns across chats are orphaned while the active turn is skipped.

- [x] **Step 5: Honor `turn_id` in stop**

Update `/api/chat/stop-turn` so:

- `turn_id` is required when supplied by clients.
- The stop targets that exact turn.
- The route rejects a stop for a different active turn in the same chat.
- A final `stopped` envelope is written if the provider call does not unwind cleanly.
- SSE clients receive the final envelope before close when possible.

Execution note:

- `tests/agent/chat-turn-stop.test.ts` proves `turn_id` is passed to `AgentLoop.stop`, unknown requested turns return 404 without stopping the chat, a terminal `stopped` envelope is written for a pending requested turn, and mismatched active turns return 409 without terminalizing the wrong pending turn.
- Live `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` starts a throwaway turn and stops the exact `turn_id`.

- [x] **Step 6: Fix stream terminal race**

Change stream attach flow so final envelope cannot land between replay and subscription without being delivered. The stream must:

- Subscribe before or atomically with final-state check.
- Replay persisted events in order.
- Emit semantic status events in addition to heartbeat comments.
- Close on terminal envelope.

Execution note:

- `createTurnStreamHandler` now subscribes before persisted replay/final checks and flushes `: connected` immediately.
- `tests/agent/chat-turn-stream-race.test.ts` covers initial stream flush and terminal envelope delivery during replay.
- Live action validation attaches `/api/chat/stream`, stops the exact turn, and validates the terminal SSE turn envelope.

- [x] **Step 7: Normalize provider failures**

Provider errors must produce terminal `error` envelopes with `error_code`, `error_message`, and `recoverable`. Do not represent provider failure only as `response_chunk`.

Expected:

- Anthropic, OpenAI/Codex, and fallback provider errors all map to the same status contract.

Execution note:

- Non-Claude provider failures now reject the turn response and persist terminal `error` envelopes with `error_code: provider_error` and `error_message`.
- `tests/agent/loop-provider-error.test.ts` covers OpenAI HTTP, Anthropic SDK, OpenAI-Codex, and unknown-provider fallback failures. All map to terminal error envelopes and do not write success-looking `complete` envelopes.

- [x] **Step 8: Isolate per-turn model override**

Ensure a per-turn selected model/provider does not mutate global `AgentLoop` defaults or leak into `/api/chat/models`.

Execution note:

- `runWithTurn()` now builds a per-turn runtime context instead of calling `setModel()` around the run.
- The runtime context carries the selected model/provider/client/memory into `run()`, while `getModel()` and `getProvider()` continue to report configured defaults.
- `tests/agent/chat-turn-model-override.test.ts` proves the active turn envelope records the selected model while the global default remains unchanged during and after the turn.

- [x] **Step 9: Add first-token timeout**

Add a first-token deadline distinct from total turn deadline. A turn with no model/tool/status event before the first-token deadline becomes visible as `awaiting_model` and later `timeout` if the backend cannot recover it.

Execution note:

- `AgentLoop.runWithTurn()` now writes `deadline_at` and `first_token_deadline_at` on turn envelopes.
- A first-token watchdog emits a persisted/live `status: awaiting_model` event when no model/tool/status event has appeared before the first-token deadline.
- The total turn watchdog now persists terminal `timeout` envelopes with `error_code: turn_timeout` instead of a generic `error`.
- `tests/agent/chat-turn-janitor-timeout.test.ts` covers awaiting-model visibility before hard timeout.

- [x] **Step 10: Verify chat lifecycle**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
node --import tsx --test --test-concurrency=1 tests/agent/chat-turn-model-override.test.ts tests/agent/chat-turn-janitor-timeout.test.ts tests/agent/chat-turn-status.test.ts tests/agent/chat-turn-stop.test.ts tests/agent/chat-turn-pending.test.ts tests/agent/chat-turn-stream-race.test.ts tests/agent/loop-provider-error.test.ts tests/agent/chat-turn-images.test.ts tests/agent/device-route.test.ts
npm run test:contracts
npm run build
```

Expected:

- Slow, stopped, errored, orphaned, complete, and streaming turns all expose truthful status.
- A client can recover from lost SSE by polling `turn-status` without starting a duplicate turn.

Execution note:

- Focused chat lifecycle tests now pass for pending duplicate blocking, stale pending recovery, read-only pending polling, stop-by-turn, mismatched active turn rejection, initial SSE flush, terminal SSE race, and non-Claude provider terminal error envelopes.
- 2026-06-26 11:50 EDT focused suite passed 25 tests across chat pending, janitor/timeout, model override isolation, stream race, status, stop, image upload, provider-family error parity, and device route coverage.
- `npm run build`, `npm run test:contracts`, `npm run test:contracts:live`, and `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` passed after scoped `pm2 restart home23-jerry-harness`.
- Chat lifecycle backend verification for this lock-in slice is complete.

---

## Task 5: Harden Device Registration And Multi-Agent Push

**Files:**

- Modify: `src/routes/device.ts`
- Modify: `src/home.ts`
- Modify: `contracts/schemas/device.schema.json`
- Add fixtures listed in Task 2
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Core/Push/PushRegistrar.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Core/Push/PushRouter.swift`
- Test: `tests/contracts/device-registration.test.cjs`

- [x] **Step 1: Add device contract**

Schema must cover:

- Request fields: `device_token`, `agent_id`, `chat_ids`, `bundle_id`, `env`, `platform`, `app_build`, `contract_version`, `capabilities_hash`, `registered_at`.
- Response fields: `ok`, `agent_id`, `registered_chat_ids`, `ignored_chat_ids`, `updated_at`.
- Registry fields: per-agent registrations and last receipt.

Expected:

- Existing snake_case fields remain accepted.
- CamelCase aliases may be accepted only if the schema and Apple code both document them.

Execution note:

- `contracts/schemas/device.schema.json` and device fixtures cover registration request, receipt response, and registry response.
- `src/routes/device.ts` accepts `agent_id`, platform/app build, contract version, and capabilities hash, and returns an agent-scoped receipt.

- [x] **Step 2: Auth-gate registry diagnostics**

Ensure:

```text
GET /api/device/registry
```

uses the same bridge auth policy as other sensitive bridge diagnostics.

Execution note:

- `createListDevicesHandler` now calls the same auth helper as register/unregister when a bridge token is configured.
- `tests/agent/device-route.test.ts` proves unauthenticated registry access returns 401 when a token is configured and succeeds with the bearer token.

- [x] **Step 3: Make Apple push registration multi-agent safe**

Apple must store and upload chat IDs per agent:

- `agentId -> chatIds`
- `agentId -> bridgeURL`
- `agentId -> lastUploadReceipt`

Expected:

- Selecting a different agent triggers an upload for that agent's bridge.
- Jerry chat IDs do not get uploaded only to Forrest or another preferred bridge.
- Notifications carrying `agent` route to the matching chat store.

Execution note:

- `PushRegistrar` now stores chat ids per agent, can upload for a requested agent, sends `agent_id` and contract metadata, decodes the backend receipt, and persists the last receipt.
- `ChatView` registers chat ids with the current agent name.
- `PushRouter` already preserves the notification `agent` field in the routed app notification payload.

- [x] **Step 4: Add unregister/update behavior**

Implement a safe update path so removed chat IDs stop being treated as registered. Use either an explicit unregister route or idempotent replace semantics in `POST /api/device/register`; record the chosen behavior in schema description and fixture.

Execution note:

- Chosen behavior: `POST /api/device/register` remains additive for registration/update compatibility; `DELETE /api/device/register` now accepts optional `chat_ids` for scoped unsubscribe.
- `DELETE` without `chat_ids` preserves whole-device unregister behavior.
- `DELETE` with `chat_ids` removes only those chat subscriptions, returns `removed_chat_ids` and `remaining_chat_ids`, and removes the device only when no subscriptions remain.
- `contracts/schemas/device.schema.json`, `contracts/manifest.json`, backend fixtures, Apple contract snapshot fixtures, and `Home23Shared` decode models now include unregister request/response contracts.
- `tests/agent/device-route.test.ts` covers scoped chat removal, last-chat device removal, whole-device unregister, registration receipt, mismatched agent rejection, and auth-gated registry diagnostics.

- [x] **Step 5: Verify push contract**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm run test:contracts
node --check src/routes/device.ts
```

Then run Swift package tests after Task 7 adds typed device models.

Expected:

- Device registration can be validated without reading implementation code.

Execution note:

- Focused backend tests, `npm run test:contracts`, `npm run build`, live registration receipt smoke, and cleanup passed.
- 2026-06-26 12:06 EDT update: `node --import tsx --test --test-concurrency=1 tests/agent/device-route.test.ts`, `npm run test:contracts`, `npm run build`, `node --check scripts/validate-live-contracts.mjs`, and Apple `Home23Shared` `swift test` passed after adding scoped unregister semantics.

---

## Task 6: Build Query Contract Facade And Lock Apple Query To It

**Files:**

- Modify: `engine/src/dashboard/server.js`
- Add or modify: `engine/src/dashboard/home23-query-api.js`
- Modify: `contracts/schemas/query.schema.json`
- Add fixtures listed in Task 2
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Query/QueryTabViewModel.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Query/QueryTabView.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/QueryContracts.swift`
- Test: `tests/contracts/query-contract.test.cjs`

- [x] **Step 1: Decide and implement backend query facade**

Decision:

- Apple clients call Home23 dashboard query endpoints.
- Dashboard may proxy to COSMO23, selected-agent bridge, or existing brain routes internally.
- Apple clients do not call port `43210`, `/api/providers/models`, or `/api/brains` directly.

Required facade routes:

```text
GET  /home23/api/query/catalog?agent=<agentId>
POST /home23/api/query/run
GET  /home23/api/query/stream
```

Catalog must return:

- selected agent
- backend route family
- provider/model catalog
- query defaults
- brain registry
- active COSMO status
- stream support
- maximum payload limits
- last route error if the query backend is unavailable

Execution note:

- Backend catalog facade is implemented in `engine/src/dashboard/home23-query-api.js` and mounted at `/home23/api/query/*` from `engine/src/dashboard/server.js`.
- `GET /home23/api/query/catalog?agent=jerry` now returns selected agent, endpoints, model catalog, defaults, brain registry, selected brain, COSMO status, stream support, limits, and route errors.
- `POST /home23/api/query/run` and `POST /home23/api/query/export` proxy through the selected agent brain route.
- `GET /home23/api/query/stream` exists, but streaming is explicitly advertised as false. This is a contract truth state, not an iOS fallback.

- [x] **Step 2: Validate facade against contracts**

Add schema definitions for:

- `queryCatalogResponse`
- `queryRequest`
- `queryRunResponse`
- `streamEvent`

Expected:

- The catalog can truthfully say query is temporarily unavailable when COSMO23 is down.
- Unavailable is an explicit contract state, not an app crash or hardcoded fallback.

Execution note:

- `tests/contracts/query-facade-route.test.cjs`, `npm run test:contracts`, and live `npm run test:contracts:live` pass for the safe query catalog path.
- `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` now validates query run dry-run, query export dry-run, and the query stream disabled-stream event without forwarding query work to COSMO23.

- [x] **Step 3: Update iOS Query view model**

Remove hardcoded COSMO base URL and fallback GPT aliases from the execution path. The app must:

- Fetch query catalog from capabilities endpoint or `/home23/api/query/catalog`.
- Render model/provider/brain options from catalog.
- Submit query through `/home23/api/query/run` or attach to `/home23/api/query/stream`.
- Display backend unavailable, empty brain registry, and route error states directly.

Execution note:

- `Home23/Sources/Features/Query/QueryTabView.swift` now bootstraps from `/home23/api/query/catalog`, posts runs to `/home23/api/query/run`, posts exports to `/home23/api/query/export`, and disables streaming unless the backend catalog advertises it.
- `SettingsControlCenter` gets query model truth from the facade catalog, not direct COSMO routes.

- [x] **Step 4: Verify query path**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm run test:contracts
npm run test:contracts:live
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
swift test
```

Expected:

- Query route drift is caught by backend contracts and Swift fixtures before app runtime.

Execution note:

- Live catalog for `agent=jerry` returned `available: true`, selected brain `Jerry Brain`, 52 models, 253 brains, facade endpoints for run/stream/export, and `streaming: false`.
- Apple source scan for `43210`, `/api/providers/models`, `/api/brains`, `/api/brain/`, `cosmoURL`, and `brainURL` under `Home23/Sources` and `Home23Shared/Sources` returned no matches.
- `Home23Shared` fixture decode tests passed.

---

## Task 7: Move Apple Wire Contracts Into `Home23Shared`

**Files:**

- Modify: `/Users/jtr/xCode_Builds/Home23/contracts/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Tests/Home23SharedTests/Fixtures/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Tests/Home23SharedTests/ContractFixtureDecodeTests.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/ClientCapabilities.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/ChatContracts.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/QueryContracts.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/SettingsContracts.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/TileContracts.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/DeviceContracts.swift`
- Add: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/WorkerAgentContracts.swift`

- [x] **Step 1: Copy backend contract snapshot**

Run:

```bash
rsync -a --delete /Users/jtr/_JTR23_/release/home23/contracts/ /Users/jtr/xCode_Builds/Home23/contracts/
rsync -a --delete /Users/jtr/_JTR23_/release/home23/contracts/fixtures/ /Users/jtr/xCode_Builds/Home23/Home23Shared/Tests/Home23SharedTests/Fixtures/
```

Expected:

- Apple contracts and Swift fixtures exactly mirror backend contracts after backend contract work is complete.

Execution note:

- Backend `contracts/` was copied into `/Users/jtr/xCode_Builds/Home23/contracts/`.
- Backend `contracts/fixtures/` was copied into `Home23Shared/Tests/Home23SharedTests/Fixtures/`.

- [x] **Step 2: Add typed Swift models**

Move app-private wire structs into `Home23Shared` or wrap them with shared public equivalents. Required typed models:

- `ClientCapabilitiesResponse`
- `AgentListResponse`
- `TurnStartResponse`
- `TurnEvent`
- `TurnEnvelope`
- `TurnStatusResponse`
- `ChatModelsResponse`
- `PendingTurnsResponse`
- `ChatConversationsResponse`
- `DeviceRegisterRequest`
- `DeviceRegisterResponse`
- `SettingsStatusResponse`
- `SettingsScopeResponse`
- `SettingsModelsResponse`
- `SettingsQueryResponse`
- `QueryCatalogResponse`
- `QueryRunResponse`
- `QueryStreamEvent`
- `SaunaTileResponse`
- `HomeSurfaceResponse`
- `WorkerAgentsResponse`

Expected:

- Unknown optional backend fields do not break decoding.
- Required client-visible fields are non-optional in Swift.

Execution note:

- Added shared Swift contracts for client capabilities, chat status/collections, query catalog/run/stream, settings, tiles, device registration/registry, and worker agents under `Home23Shared/Sources/Home23Shared/Models/`.
- Existing `TurnEnvelope` and `TurnEvent` now accept provider/error/status fields required by current backend contracts.

- [x] **Step 3: Decode every fixture**

Extend `ContractFixtureDecodeTests.swift` so every fixture either decodes into a typed model or has a named reason for being validated as raw JSON.

Also add negative decode tests for:

- missing `turn_id` in turn status
- missing endpoint in client capabilities
- invalid query catalog route
- missing device token in registration request

Execution note:

- `ContractFixtureDecodeTests.swift` now decodes every backend fixture copied into the Swift package.
- Negative decode coverage proves missing `turn_id` in turn status, incomplete client capabilities, missing device token, and direct/non-facade query routes fail decoding.

- [x] **Step 4: Verify Swift package**

Run:

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
swift test
```

Expected:

- Fixture parity and typed model coverage fail fast before app builds.

Execution note:

- `cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test` passed with 10 tests and 0 failures after updating the shared contract version to `2026.06.26`.

---

## Task 8: Lock Apple App Surfaces To Backend Contracts

**Files:**

- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/App/AppEnvironment.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Core/Networking/APIClient.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Core/Models/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Home/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Query/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Chat/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Sauna/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23/Sources/Features/Settings/*`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23TV/*`

- [x] **Step 1: Load capabilities at app startup and refresh**

`AppEnvironment` must fetch `/home23/api/client-capabilities` for the selected Home23 host and expose:

- selected agent route truth
- per-platform feature flags
- endpoint map
- auth requirements
- query availability
- house-global surfaces
- contract version

Expected:

- UI tabs and route clients consume the capability object instead of local assumptions.

Execution note:

- `AppEnvironment` loads `/home23/api/client-capabilities` during bootstrap and host save, exposes loading/error state, and clears capability state on sign-out.

- [x] **Step 2: Chat uses `turn-status` for recovery**

`ChatViewModel` must:

- Store active `turn_id`.
- Attach to SSE after turn start.
- Poll `/api/chat/turn-status` only when useful: app resume, lost SSE, no semantic event after a bounded wait, or user opens diagnostics.
- Never start a duplicate turn to unstick UI.
- Map status contract to visible states.

Display enum:

```swift
enum ChatTurnDisplayState: Equatable {
    case idle
    case starting
    case accepted(turnId: String)
    case awaitingModel(elapsedMs: Int)
    case streaming(lastSeq: Int)
    case runningTool(name: String, elapsedMs: Int)
    case stopping
    case stopped
    case complete
    case orphaned(String?)
    case timeout(String?)
    case error(String)
}
```

Expected:

- The user never sees only a spinner when backend truth is available.

Execution note:

- `ChatViewModel` stores active turn id, polls `/api/chat/turn-status`, refreshes status on demand, reconnects to the active turn, and sends exact `turn_id` to `/api/chat/stop-turn`.
- `ChatView` displays phase/status/seq/model state plus Refresh, Reconnect, and Stop controls.

- [x] **Step 3: Query consumes the facade**

The iOS Query surface must use Task 6 facade routes. Remove direct use of:

- `http://localhost:43210`
- direct `/api/providers/models`
- direct `/api/brains`
- local fallback model aliases for execution

Expected:

- Query unavailable, no active COSMO run, no brain registry, and provider/model errors are visible backend states.

Execution note:

- Apple Query no longer has direct COSMO execution paths and uses the backend facade catalog/run/export routes.

- [x] **Step 4: Push registration uses per-agent receipts**

Update `PushRegistrar` and `PushRouter` so the app can prove:

- current APNs token
- agent id
- bridge URL
- registered chat ids
- last upload receipt
- last upload error

Expected:

- Switching selected agent cannot silently strand notification routing.

Execution note:

- `PushRegistrar` records agent-scoped chat ids, uploads to the requested agent bridge, sends contract metadata, decodes `DeviceRegisterResponse`, and surfaces the last receipt in Settings.

- [x] **Step 5: Diagnostics surface exposes route truth**

Add compact diagnostics to Settings and Chat with:

- app version/build/bundle
- selected agent id/name
- dashboard URL
- bridge URL
- bridge health result
- model catalog source
- default provider/model
- capabilities contract version
- query catalog route and availability
- active turn id/status/last seq/last event timestamp
- push registration receipt
- last endpoint failures

Expected:

- A stuck Jerry chat can be diagnosed from the app without guessing whether backend, provider, stream, auth, or route is the blocker.

Execution note:

- Chat shows active turn status truth and Refresh/Reconnect/Stop controls.
- Settings now shows app build identity, selected agent, dashboard URL, bridge URL, live selected-agent bridge health/model, capabilities contract version, query catalog route, query model availability, default chat provider/model, push registration receipt, and the current endpoint failure set from capabilities/settings/bridge/push.
- `Home23/Sources/Features/Settings/SettingsView.swift` needed `import Combine` for the diagnostics `ObservableObject`; after that, the fresh Mac Catalyst build passed.

- [x] **Step 6: Sauna renders backend-provided action fields**

Sauna remains house-global, but controls should honor backend action metadata:

- action ids
- labels
- allowed ranges
- presets
- payload keys
- current state
- command availability

Expected:

- Hardcoded presets and bounds are fallback-only and visibly marked as unavailable when backend fields are missing.

Execution note:

- Backend HUUM tile action fields now expose optional `min`, `max`, `step`, and `unit` for `targetTemperature` and `duration`; generic action field normalization preserves the same metadata.
- `contracts/schemas/home-surfaces.schema.json`, backend Sauna fixture, Apple contract snapshot, and `Home23Shared` tile contract models now include the metadata.
- Apple Sauna now uses backend action labels, confirmation metadata, field defaults, ranges, step values, units, availability, and field ids when rendering controls and building action payloads.
- If backend field metadata is missing, the app shows that fallback control limits are being used.
- Verification passed: `node --test --test-concurrency=1 tests/engine/dashboard/home23-tiles.test.js`, `npm run test:contracts`, Apple `Home23Shared` `swift test`, `node scripts/check-endpoint-categories.mjs`, and Mac Catalyst `xcodebuild`.

- [x] **Step 7: Normalize status vocabulary**

Use shared status mapping for:

- Home online/offline/running
- Settings running/online
- Chat active/stopped/error
- Query available/unavailable
- Sauna reachable/unreachable

Expected:

- The app does not call a surface online just because the screen rendered.

Execution note:

- Added `Home23StatusVocabulary` to `Home23Shared` for canonical agent status kind/label, operational checks, availability labels, and Sauna running-state parsing.
- Wired duplicated iOS/Mac/tvOS agent-status and Sauna-running helpers through the shared vocabulary in Home, Query, Chat shell, Settings, Command Center, Pad root, Agent scope picker, Sauna, TV Chat, TV Agents, TV Main, TV Dashboard model, and TV Sauna model.
- Worker run statuses remain separate because they describe worker job outcomes, not route/surface availability.
- Verification passed: Apple `Home23Shared` `swift test`, `node scripts/check-endpoint-categories.mjs`, and Mac Catalyst `xcodebuild`.

- [x] **Step 8: tvOS explicit scope**

tvOS must consume capabilities and hide or disable unsupported Query and full Settings. It should not advertise iOS parity until those surfaces are implemented.

Execution note:

- tvOS now fetches `/home23/api/client-capabilities` from the Home23 dashboard and stores the payload plus capability-load errors.
- `TVSection.availableSections(for:)` derives the tvOS sidebar from `capabilities.platforms.tvos`.
- `TVAppModel.selectSection()` clamps unsupported selections to the available section set, and `TVMainView` renders only available sections.
- The tvOS UI still only exposes Home, Chat, Sauna, and Agents for the current capability contract; Query and full Settings remain absent until backend capability truth changes and the views exist.
- tvOS source is locked to capability truth. Current generic tvOS build is blocked by local Xcode platform installation: Xcode reports `tvOS 26.4 is not installed` for the paired Apple TV and placeholder destination.

- [x] **Step 9: Add static endpoint categorization test**

Add an Apple-side test or script that scans Swift source for direct backend endpoints and categorizes each as:

- capability endpoint
- selected-agent dashboard route
- selected-agent bridge route
- house-global dashboard route
- development-only test route

Expected:

- Any reintroduced hardcoded COSMO port or undocumented backend path fails review.

Execution note:

- Added `scripts/check-endpoint-categories.mjs` in the Apple repo.
- The script scans Swift sources, categorizes endpoint literals, and fails on direct COSMO/provider/brain paths outside deliberate negative tests.
- `node scripts/check-endpoint-categories.mjs` passed with 107 endpoint literals categorized.
- Updated Apple `README.md` and `AGENTS.md` to remove stale direct query/provider/brain route expectations and document `/home23/api/query/*`.
- Re-ran after Settings diagnostics and the script passed with 108 endpoint literals categorized.

---

## Task 9: End-To-End Verification And Receipts

**Files:**

- Create: `docs/superpowers/reports/2026-06-26-home23-apple-contract-lock-in-verification.md`
- Update: `docs/ios-parity.md`
- Update: `/Users/jtr/xCode_Builds/Home23/docs/ios-parity.md`

- [x] **Step 1: Backend static and contract tests**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
npm run test:contracts
node --import tsx --test --test-concurrency=1 tests/agent/chat-turn-status.test.ts tests/agent/chat-turn-stop.test.ts tests/agent/chat-turn-pending.test.ts tests/agent/chat-turn-stream-race.test.ts tests/agent/loop-provider-error.test.ts tests/agent/chat-turn-images.test.ts
npm run build
```

Expected:

- Contract, chat lifecycle, provider error, and build gates pass.

Execution note:

- `npm run test:contracts`, focused chat/device/provider tests, and `npm run build` passed.
- Latest focused suite: 19 tests passed across chat pending, stream race, status, stop, image upload, provider error, and device route coverage.

- [x] **Step 2: Scoped runtime restart and live validation**

Restart only changed processes:

```bash
cd /Users/jtr/_JTR23_/release/home23
pm2 restart home23-jerry
pm2 restart home23-jerry-dash
curl -sS http://localhost:5004/health | python3 -m json.tool
curl -sS http://localhost:5004/api/chat/models | python3 -m json.tool
curl -sS http://localhost:5002/home23/api/client-capabilities | python3 -m json.tool
npm run test:contracts:live
```

Expected:

- Restarts are limited to the processes with code changes.
- Live contract validation passes.

Execution note:

- Restarted only `home23-jerry-dash` and `home23-jerry-harness`.
- Fresh proof after final restart: `home23-jerry-harness online pid=15453 restarts=46`, `home23-jerry-dash online pid=15393 restarts=12`.
- `npm run test:contracts:live` checked 13 safe GET routes with no failures.
- `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` passed bounded chat action/SSE/status/pending probes and device register/scoped-unregister/delete cleanup probes.
- Live Sauna tile readback returned backend action field metadata, and live client capabilities showed `platforms.tvos.query=false`, `platforms.tvos.settings=false`, and `query.directCosmo=false`.

- [x] **Step 3: Stuck-chat recovery smoke**

Run a bounded throwaway chat smoke:

- Start a turn.
- Record returned `turn_id`.
- Attach SSE.
- Poll `/api/chat/turn-status`.
- Stop the turn by `turn_id`.
- Confirm terminal `stopped` or `complete` envelope.
- Confirm `/api/chat/pending` no longer leaves the chat visually stuck.

Expected:

- Recovery path is proven without relying on the iOS UI.

Execution note:

- Focused unit/integration tests prove status polling, stop by turn id, mismatch rejection, and non-mutating unknown-turn reads.
- Live `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` now starts a throwaway turn, attaches SSE, polls status, stops by exact `turn_id`, validates the terminal SSE envelope, and confirms the turn is no longer pending.

- [x] **Step 4: Query facade smoke**

Run:

```bash
cd /Users/jtr/_JTR23_/release/home23
curl -sS "http://localhost:5002/home23/api/query/catalog?agent=jerry" | python3 -m json.tool
```

Then perform one bounded query through the facade when query backend is available. If COSMO23 is not running, verify the catalog returns a validated unavailable state.

Expected:

- Query truth is explicit either way.

Execution note:

- Live catalog for `agent=jerry` returned `available: true`, selected brain `Jerry Brain`, 52 models, 253 brains, facade endpoints for run/stream/export, and `streaming: false`.

- [ ] **Step 5: Apple shared tests and builds**

Run:

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
swift test
cd /Users/jtr/xCode_Builds/Home23
xcodebuild -project Home23.xcodeproj -scheme Home23 -configuration Debug -derivedDataPath .DerivedData -destination generic/platform=iOS build
xcodebuild -project Home23.xcodeproj -scheme Home23Mac -configuration Debug -derivedDataPath .DerivedData -destination 'platform=macOS,variant=Mac Catalyst' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Home23.xcodeproj -scheme Home23TV -configuration Debug -derivedDataPath .DerivedData -destination generic/platform=tvOS CODE_SIGNING_ALLOWED=NO build
```

Expected:

- Shared package tests pass.
- iOS, Mac Catalyst, and tvOS builds pass when local Apple platform components are installed.

Execution note:

- 2026-06-26 12:15 EDT: `Home23Shared swift test` passed 10 tests.
- 2026-06-26 12:15 EDT: `node scripts/check-endpoint-categories.mjs` passed with 109 endpoint literals categorized.
- 2026-06-26 12:15 EDT: `Home23Mac` Mac Catalyst build passed after Settings diagnostics, Sauna action metadata, shared status vocabulary, and tvOS capability-gating source changes.
- 2026-06-26 12:27 EDT: `Home23Shared swift test` passed 10 tests after adding the shared query export contract.
- 2026-06-26 12:28 EDT: `Home23Mac` Mac Catalyst build passed.
- 2026-06-26 12:29 EDT: endpoint categorization still passed with 109 endpoint literals categorized.
- 2026-06-26 12:33 EDT: added missing shared scheme `Home23.xcodeproj/xcshareddata/xcschemes/Home23.xcscheme`. `xcodebuild -project Home23.xcodeproj -list` now lists `Home23`, `Home23Mac`, `Home23Shared`, and `Home23TV`.
- 2026-06-26 12:37 EDT: XcodeBuildMCP sees `Home23` and zero enabled simulators. `build_sim` with `simulatorName=iPhone 17` fails with `Unable to find a device matching ... platform:iOS Simulator, OS:latest, name:iPhone 17`.
- 2026-06-26 12:37 EDT: `Home23` generic iOS build remains open. `xcodebuild -showsdks` lists iOS and iOS Simulator 26.4 SDKs, but `xcodebuild -showdestinations` lists only ineligible iOS destinations and reports `iOS 26.4 is not installed`; `xcrun simctl list devices available` and `xcrun simctl runtime list` return no installed devices/runtimes.
- 2026-06-26 12:39 EDT: `Home23Shared swift test` passed 10 tests after scheme investigation.
- 2026-06-26 12:40 EDT: `Home23Mac` Mac Catalyst build passed serially after avoiding the DerivedData lock from concurrent builds.
- 2026-06-26 12:40 EDT: `Home23TV` generic tvOS build is blocked by destination/platform selection. Xcode reports `tvOS 26.4 is not installed` for the paired Apple TV and placeholder destination.
- Keep this step open until local iOS/tvOS platform components are installed and the iOS/tvOS builds pass.

- [x] **Step 6: Write verification report**

Create `docs/superpowers/reports/2026-06-26-home23-apple-contract-lock-in-verification.md` with:

```markdown
# Home23 Apple Contract Lock-In Verification

## Backend Contract Tests

## Backend Chat Turn Tests

## Live Backend Smoke

## Stuck Chat Recovery Smoke

## Query Facade Smoke

## Apple Shared Contract Tests

## Apple Builds

## Remaining Known Gaps
```

Expected:

- Every command has pass/fail output.
- Remaining gaps are explicit product or infrastructure states, not hidden assumptions.

- [x] **Step 7: Update parity docs**

Update both backend and Apple `docs/ios-parity.md` files with:

- final route list
- capability version
- unsupported tvOS scope
- chat recovery behavior
- query facade behavior
- push registration behavior
- verification report path

---

## Execution Model

Use top-tier subagents with strict ownership:

1. **Coordinator:** owns this plan, sequencing, conflict resolution, receipts, final live validation, and commit scope.
2. **Backend Contract Worker:** owns `contracts/manifest.json`, schemas, fixtures, AJV tests, live validation script, and client capabilities route.
3. **Chat Lifecycle Worker:** owns turn status, stop-by-turn, pending/orphan recovery, stream race fix, provider error normalization, model override isolation, and chat lifecycle tests.
4. **Query Facade Worker:** owns Home23 query facade routes, query schemas/fixtures, and backend smoke validation.
5. **Device/Push Worker:** owns device registration schema, auth-gated registry, bridge route behavior, and Apple multi-agent push registration.
6. **Apple Shared Contracts Worker:** owns Swift shared wire models, fixture syncing, typed decode tests, and negative decode tests.
7. **Apple App Worker:** owns iOS/Mac/tvOS consumption of capabilities, chat status UI, query facade adoption, diagnostics, sauna action fields, and status vocabulary.
8. **Reviewer:** runs pattern consistency review after changes, checking endpoint names, schema names, route paths, auth modes, selected-agent scope, house-global scope, and fixture parity.

No worker edits another worker's owned files unless the coordinator updates this plan first.

## Completion Definition

The endeavor is complete only when:

- Current truth report exists and separates live/source/schema/client truth.
- Contract manifest covers every Apple-consumed route.
- Backend fixture and live contract validation pass.
- `/home23/api/client-capabilities` is live and validated.
- Chat turn status and stop recovery can unstick a chat without duplicate turns.
- Query no longer depends on hardcoded COSMO routes in the Apple app.
- Push registration is per-agent and receipt-backed.
- Apple shared fixture decode tests cover every contract fixture.
- iOS, Mac Catalyst, and tvOS builds pass.
- Verification report records command output and remaining explicit gaps.
- Any changed Home23 runtime process was restarted by name only.
