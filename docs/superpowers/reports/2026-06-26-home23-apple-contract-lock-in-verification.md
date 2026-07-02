# Home23 Apple Contract Lock-In Verification

Captured: 2026-06-26 11:22 EDT

Scope:

- Backend: `/Users/jtr/_JTR23_/release/home23`
- Apple clients: `/Users/jtr/xCode_Builds/Home23`

## Backend Contract Tests

Passed:

```bash
npm run test:contracts
```

Result:

- 10 passed
- 1 skipped: `live-backend-contracts.test.cjs` delegates live checks to `scripts/validate-live-contracts.mjs`

Coverage added in this pass:

- `contracts/manifest.json`
- AJV fixture/schema validation
- client capabilities route tests
- query catalog facade tests
- query export facade proxy test
- chat, query, settings, home, sauna, device, and worker fixtures

## Backend Chat And Device Tests

Passed:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/device-route.test.ts \
  tests/agent/chat-turn-stop.test.ts \
  tests/agent/chat-turn-status.test.ts \
  tests/agent/loop-provider-error.test.ts
```

Result:

- 11 passed
- 0 failed

Update at 2026-06-26 11:36 EDT:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/chat-turn-pending.test.ts \
  tests/agent/chat-turn-stream-race.test.ts \
  tests/agent/chat-turn-status.test.ts \
  tests/agent/chat-turn-stop.test.ts \
  tests/agent/chat-turn-images.test.ts \
  tests/agent/loop-provider-error.test.ts \
  tests/agent/device-route.test.ts
```

Result:

- 19 passed
- 0 failed

Validated behavior:

- `GET /api/chat/turn-status` combines persisted turn envelopes, last events, runtime active state, provider, model, and configured defaults.
- `GET /api/chat/turn-status` returns 404 for an unknown turn without mutating pending state.
- `POST /api/chat/stop-turn` honors `turn_id`.
- A stop for a different active turn is rejected without terminalizing the wrong pending turn.
- Non-Claude provider failures produce visible turn events instead of silent success-looking completion.
- Provider-prefixed Claude Opus 4.8 is recognized by the sampling-deprecated guard.
- `POST /api/device/register` returns an agent-scoped receipt.
- Mismatched `agent_id` is rejected.
- `GET /api/device/registry` requires bridge auth when a bridge token is configured.
- `POST /api/chat/turn` rejects fresh persisted pending turns even when no in-memory active run exists.
- `POST /api/chat/turn` recovers stale persisted pending turns as `orphaned` before accepting a new turn.
- `GET /api/chat/pending` reports pending turns without mutating/orphaning them.
- `GET /api/chat/stream` flushes an initial `: connected` chunk before any events exist.
- `GET /api/chat/stream` catches terminal envelopes emitted during catch-up replay.
- Non-Claude provider failures now reject the turn response and persist terminal `error` envelopes with `error_code: provider_error` and `error_message`.

Passed:

```bash
npm run build
```

Result:

- TypeScript build passed.

## Live Backend Smoke

Scoped restarts only:

```bash
pm2 restart home23-jerry-dash
pm2 restart home23-jerry-harness
```

Fresh PM2 proof after the final harness restart:

```text
home23-cosmo23                 online     pid=86737 restarts=12
home23-jerry                   online     pid=77969 restarts=70
home23-jerry-harness           online     pid=16154 restarts=39
home23-jerry-dash              online     pid=6529 restarts=11
```

Jerry bridge health:

```json
{
  "status": "ok",
  "agent": "jerry",
  "type": "cosmohome",
  "endpoint": "/api/chat",
  "model": "gpt-5.5",
  "provider": "openai-codex"
}
```

Live safe contract validation:

```bash
npm run test:contracts:live
```

Result:

- Checked 13 safe GET routes.
- No failures.
- Mutating and stream probes were skipped with explicit reasons.

Bounded action validation:

```bash
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```

Result:

- Checked the same 13 safe GET routes.
- Started a throwaway chat turn through `POST /api/chat/turn`.
- Attached `GET /api/chat/stream`.
- Stopped the exact `turn_id` through `POST /api/chat/stop-turn`.
- Validated `GET /api/chat/turn-status` before and after stop.
- Validated the terminal SSE turn envelope.
- Validated `GET /api/chat/pending` and confirmed the stopped probe turn was not still pending.
- Validated query run dry-run through `POST /home23/api/query/run` without forwarding to COSMO23.
- Validated query export dry-run through `POST /home23/api/query/export` without forwarding to COSMO23.
- Validated query stream disabled-stream SSE event through `GET /home23/api/query/stream`.
- Validated Sauna tile action dry-run through `POST /home23/api/tiles/sauna-control/actions/start?dryRun=1` without calling HUUM.

Checked routes:

- `/home23/api/settings/agents`
- `/home23/api/client-capabilities`
- `/api/chat/models`
- `/api/chat/conversations`
- `/api/chat/history`
- `/home23/api/settings/status`
- `/home23/api/settings/scope`
- `/home23/api/settings/models`
- `/home23/api/settings/query`
- `/home23/api/query/catalog`
- `/api/home/summary`
- `/home23/api/tiles/sauna-control/data`
- `/home23/api/workers`

Client capabilities live route returned contract version `2026.06.26` and advertises:

- Query facade enabled.
- Direct COSMO from clients disabled.
- Query streaming disabled.
- Chat turn status enabled.
- Stop by turn id enabled.
- Resume pending enabled.
- Push registration enabled.
- Per-agent push receipts enabled.

## Device Receipt Smoke

Live throwaway registration against Jerry bridge:

```bash
POST http://localhost:5004/api/device/register
DELETE http://localhost:5004/api/device/register
```

Receipt returned:

```json
{
  "ok": true,
  "registered": true,
  "agent_id": "jerry",
  "registered_chat_ids": ["ios_contract_smoke"],
  "updated_at": "2026-06-26T15:21:34.553Z",
  "device": {
    "agent_id": "jerry",
    "platform": "ios",
    "app_build": "contract-smoke",
    "contract_version": "2026.06.26"
  }
}
```

Cleanup returned:

```json
{ "unregistered": true }
```

## Query Facade Smoke

Live catalog:

```bash
curl -sS "http://localhost:5002/home23/api/query/catalog?agent=jerry"
```

Validated summary:

```json
{
  "agent": "jerry",
  "available": true,
  "endpoints": {
    "run": "/home23/api/query/run",
    "stream": "/home23/api/query/stream",
    "export": "/home23/api/query/export"
  },
  "streaming": false,
  "selectedBrain": {
    "displayName": "Jerry Brain",
    "routeKey": "5a8323c3fe6fd70b"
  },
  "lastRouteError": null,
  "modelCount": 52,
  "brainCount": 253
}
```

Apple source scan:

```bash
rg -n "43210|/api/providers/models|/api/brains|/api/brain/|cosmoURL|brainURL" Home23/Sources Home23Shared/Sources -S
```

Result:

- No matches.

## Apple Shared Contract Tests

Passed:

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
swift test
```

Result:

- 10 passed
- 0 failed

Coverage:

- Every copied backend fixture decodes in `Home23Shared`.
- Negative decode tests reject missing required fields.
- Query contracts reject direct backend/COSMO routes.

## Apple Builds

Project-side correction:

- Added missing shared scheme `Home23.xcodeproj/xcshareddata/xcschemes/Home23.xcscheme`.
- `xcodebuild -project Home23.xcodeproj -list` now lists `Home23`, `Home23Mac`, `Home23Shared`, and `Home23TV`.
- XcodeBuildMCP also lists the `Home23` scheme, but `list_sims` returns zero simulators.

Passed:

```bash
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23Mac \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination "platform=macOS,variant=Mac Catalyst" \
  CODE_SIGNING_ALLOWED=NO build
```

Result:

- `** BUILD SUCCEEDED **`
- Serial re-run at 2026-06-26 12:40 EDT also passed after avoiding concurrent `.DerivedData` access.

Blocked by local Xcode destination/platform installation:

```bash
xcodebuild -project Home23.xcodeproj -scheme Home23 \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination generic/platform=iOS \
  CODE_SIGNING_ALLOWED=NO build

xcodebuild -project Home23.xcodeproj -scheme Home23TV \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination generic/platform=tvOS \
  CODE_SIGNING_ALLOWED=NO build
```

Result:

- Home23 iOS: `Unable to find a destination matching ... generic/platform=iOS`; Xcode reports `iOS 26.4 is not installed` for the eligible device and placeholder.
- Home23TV tvOS: `Unable to find a destination matching ... generic/platform=tvOS`; Xcode reports `tvOS 26.4 is not installed` for the eligible device and placeholder.
- `xcrun simctl list devices available` returned only `== Devices ==`.
- `xcrun simctl runtime list` returned zero disk images.
- XcodeBuildMCP `build_sim` with `simulatorName=iPhone 17` failed with `Unable to find a device matching ... platform:iOS Simulator, OS:latest, name:iPhone 17`.
- `xcrun devicectl list devices` sees `jtr iPhone` as `available (paired)`, but Xcode marks the same device ineligible because the iOS 26.4 platform component is not installed.
- System data volume had about 11 GiB free during this check, so no blind `xcodebuild -downloadPlatform iOS` or `-downloadPlatform tvOS` install was attempted.

This is an environment/destination blocker, not a passing iOS/tvOS compile result.

## Chat Lifecycle Recovery Update

Timestamp: 2026-06-26 11:50 EDT / 2026-06-26T15:50:53Z

Backend changes:

- `AgentLoop.recoverStaleTurns()` now sweeps stale persisted pending turns across all chats while skipping the active in-memory turn.
- `src/home.ts` runs the stale-turn recovery at harness startup and every 60 seconds afterward.
- `TurnEnvelope` records `deadline_at` and `first_token_deadline_at`.
- `runWithTurn()` now emits a persisted/live `status: awaiting_model` event when no model/tool/status event appears before the first-token deadline.
- Total turn timeout now persists terminal `timeout` with `error_code: turn_timeout`.
- Per-turn model selection now uses an isolated runtime context instead of mutating global `AgentLoop` model/provider defaults.
- Provider-family failures now have test coverage for OpenAI HTTP, Anthropic SDK, OpenAI-Codex HTTP, and unknown-provider fallback paths; all persist terminal `error` envelopes with `error_code: provider_error`.

Focused verification:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/chat-turn-model-override.test.ts \
  tests/agent/chat-turn-janitor-timeout.test.ts \
  tests/agent/chat-turn-pending.test.ts \
  tests/agent/chat-turn-stream-race.test.ts \
  tests/agent/chat-turn-status.test.ts \
  tests/agent/chat-turn-stop.test.ts \
  tests/agent/chat-turn-images.test.ts \
  tests/agent/loop-provider-error.test.ts \
  tests/agent/device-route.test.ts
```

Result:

- 25 passed
- 0 failed

Build and contract gates:

```bash
npm run build
npm run test:contracts
npm run test:contracts:live
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```

Result:

- TypeScript build passed.
- Offline contract tests passed.
- Safe live route contract validation passed.
- Bounded live chat action/SSE/status/stop/pending probe passed.

Scoped runtime action:

```bash
pm2 restart home23-jerry-harness
```

Post-restart runtime truth:

```text
home23-cosmo23           online     pid=86737 restarts=12
home23-jerry             online     pid=77969 restarts=70
home23-jerry-harness     online     pid=15949 restarts=45
home23-jerry-dash        online     pid=6529 restarts=11
```

Health:

```json
{
  "status": "ok",
  "agent": "jerry",
  "type": "cosmohome",
  "endpoint": "/api/chat",
  "model": "gpt-5.5",
  "provider": "openai-codex"
}
```

## Device Registration Action Probe Update

Timestamp: 2026-06-26 11:53 EDT / 2026-06-26T15:53:08Z

Validator change:

- `scripts/validate-live-contracts.mjs` now has a bounded device registration probe behind `HOME23_LIVE_CONTRACTS_ACTIONS=1`.
- The probe validates the request payload, registers a synthetic sandbox device token, validates the receipt, and deletes the same token/bundle as cleanup.

Verification:

```bash
node --check scripts/validate-live-contracts.mjs
npm run test:contracts:live
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```

Result:

- Validator syntax check passed.
- Safe live route validation passed.
- Bounded live action validation now checks `device-register-request` and `device-register-response` in addition to the chat action/SSE probe.

## Apple Endpoint Categorization Update

Timestamp: 2026-06-26 11:53 EDT / 2026-06-26T15:53:08Z

Apple repo changes:

- Added `scripts/check-endpoint-categories.mjs`.
- Updated Apple `README.md` and `AGENTS.md` so Query expectations point at `/home23/api/query/catalog`, `/home23/api/query/run`, `/home23/api/query/export`, and `/home23/api/query/stream` instead of old direct query/provider/brain routes.

Verification:

```bash
cd /Users/jtr/xCode_Builds/Home23
node scripts/check-endpoint-categories.mjs
```

Result:

- Endpoint categorization passed.
- 107 Swift endpoint literals categorized.
- Categories: capability endpoint 1, selected-agent bridge route 18, selected-agent dashboard route 69, house-global dashboard route 19.

## Apple Settings Diagnostics Update

Timestamp: 2026-06-26 12:01 EDT

Apple changes:

- `Home23/Sources/Features/Settings/SettingsView.swift` now has a Settings diagnostics card for route truth, backend health, contracts, and recent failures.
- The card shows app version/build/bundle id, selected agent, dashboard URL, bridge URL, live selected-agent bridge `/health`, capabilities contract version, query catalog route, query model availability, default chat provider/model, push registration receipt, and endpoint failures from capabilities/settings/bridge/push.
- Added `import Combine` so the diagnostics `ObservableObject` and `@Published` state compile in the Mac Catalyst target.

Fresh verification:

```bash
cd /Users/jtr/xCode_Builds/Home23
node scripts/check-endpoint-categories.mjs
```

Result:

- Endpoint categorization passed.
- 108 Swift endpoint literals categorized.
- Categories: capability endpoint 1, selected-agent bridge route 18, selected-agent dashboard route 70, house-global dashboard route 19.

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
swift test
```

Result:

- 10 passed
- 0 failed

```bash
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23Mac \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination "platform=macOS,variant=Mac Catalyst" \
  CODE_SIGNING_ALLOWED=NO build
```

Result:

- `** BUILD SUCCEEDED **`

## Device Unregister, Sauna Actions, Status Vocabulary, And tvOS Scope

Timestamp: 2026-06-26 12:16 EDT

Backend changes:

- `DELETE /api/device/register` now supports scoped `chat_ids` removal while preserving whole-device unregister when `chat_ids` is omitted.
- Device unregister receipts now report `removed_chat_ids`, `remaining_chat_ids`, and `device_unregistered`.
- HUUM Sauna tile action fields now expose optional `min`, `max`, `step`, and `unit`; generic tile action field normalization preserves the same metadata.

Apple changes:

- `Home23Shared` now includes device unregister contracts, action field range metadata, and `Home23StatusVocabulary`.
- Apple Sauna renders backend action labels, field defaults, field ranges, step values, units, availability, and field ids when building action payloads.
- iOS/Mac/tvOS agent-status colors and Sauna running-state checks now use shared status vocabulary.
- tvOS fetches `/home23/api/client-capabilities`, derives its sidebar from `platforms.tvos`, and keeps Query/full Settings absent while capability truth says unsupported.

Focused verification:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/device-route.test.ts \
  tests/agent/chat-turn-model-override.test.ts \
  tests/agent/chat-turn-janitor-timeout.test.ts \
  tests/agent/chat-turn-pending.test.ts \
  tests/agent/chat-turn-stream-race.test.ts \
  tests/agent/chat-turn-status.test.ts \
  tests/agent/chat-turn-stop.test.ts \
  tests/agent/chat-turn-images.test.ts \
  tests/agent/loop-provider-error.test.ts
node --test --test-concurrency=1 tests/engine/dashboard/home23-tiles.test.js
npm run test:contracts
npm run build
node --check engine/src/dashboard/home23-tiles.js
node --check scripts/validate-live-contracts.mjs
```

Result:

- Agent/device/chat focused suite: 28 passed, 0 failed.
- Dashboard tile suite: 9 passed, 0 failed.
- Contract tests: 10 passed, 1 skipped live shim.
- TypeScript build passed.
- JS syntax checks passed.

Apple verification:

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared && swift test
cd /Users/jtr/xCode_Builds/Home23 && node scripts/check-endpoint-categories.mjs
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23Mac \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination "platform=macOS,variant=Mac Catalyst" \
  CODE_SIGNING_ALLOWED=NO build
```

Result:

- `Home23Shared` tests: 10 passed, 0 failed.
- Endpoint categorization passed with 109 endpoint literals: capability endpoint 2, selected-agent bridge route 18, selected-agent dashboard route 70, house-global dashboard route 19.
- Mac Catalyst build succeeded.
- tvOS source is capability-gated, but current generic tvOS build is blocked by destination/platform selection: Xcode reports `tvOS 26.4 is not installed` for the paired Apple TV and placeholder destination.
- iOS build remains blocked by destination/platform selection for the `Home23` scheme: Xcode reports `iOS 26.4 is not installed` for the only listed iOS destinations, and `xcrun simctl list devices available` returns no devices.

Scoped live restart:

```bash
pm2 restart home23-jerry-dash
```

Live proof:

- Jerry bridge `/health` returned `status=ok`, `provider=openai-codex`, `model=gpt-5.5`.
- `npm run test:contracts:live` passed safe route validation.
- `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` passed chat action/SSE/status/pending probes, device register/scoped-unregister/cleanup probes, query run/export dry-run probes, query stream event validation, and Sauna tile action dry-run validation.
- Direct query run dry-run returned `ok=true`, `dryRun=true`, and `metadata.operation=run`.
- Direct query export dry-run returned `success=true`, `dryRun=true`, `exportedTo=null`, and `metadata.operation=export`.
- Direct Sauna tile action dry-run returned `ok=true`, `dryRun=true`, and action fields `targetTemperature min=100 max=240 step=1 unit=°F`, `duration min=15 max=720 step=15 unit=minutes`.
- `GET /home23/api/tiles/sauna-control/data` returned Sauna action fields with `targetTemperature min=100 max=240 step=1 unit=°F` and `duration min=15 max=720 step=15 unit=minutes`.
- `GET /home23/api/client-capabilities` returned `platforms.tvos.query=false`, `platforms.tvos.settings=false`, and `query.directCosmo=false`.

Final PM2 proof for touched Home23 processes:

```text
home23-cosmo23                 online     pid=86737 restarts=12
home23-jerry                   online     pid=77969 restarts=70
home23-jerry-harness           online     pid=15453 restarts=46
home23-jerry-dash              online     pid=70787 restarts=13
```

## Final Apple Parity Lock-In Update

Timestamp: 2026-06-26 13:05 EDT

Backend contract hardening added in the final pass:

- Stop-turn now has request, success response, and wrong-turn error response schema/fixtures in the manifest.
- Live action validation now validates exact stop request payloads, exact stopped-turn receipts, and wrong-turn stop errors while proving the wrong-turn request does not stop the active probe.
- Query run now has non-dry facade proxy coverage and upstream-error response contract coverage.
- Query streaming is marked `capability-disabled` in the manifest rather than overstated as a live streaming capability.
- Device registry validation now proves a synthetic registration appears in `GET /api/device/registry` and disappears after cleanup.
- Tile action validation now covers the full dry-run envelope live and the real action envelope through a mocked HUUM unit test.
- Query defaults/settings now expose provider identity fields: `provider`, `defaultProvider`, `pgsSweepProvider`, and `pgsSynthProvider`.

Apple parity fixes added in the final pass:

- iPad/iOS no longer auto-persists the Mac default Tailscale host; non-Mac clients stay in onboarding until the user configures a host.
- Native Query model selection now uses stable provider/source/model keys internally and sends raw `model`, `provider`, `pgsSweepModel`, `pgsSweepProvider`, and `pgsSynthProvider` to the backend.
- Settings Query defaults use the same stable provider/source/model keys and save raw model/provider pairs back to `/home23/api/settings/query`.
- Settings model saves now decode `restartedAgent` and `restartedHarness` and report the restart receipt to the user.
- Worker Desk and Worker Library entry points on iPad/iOS are gated by `/home23/api/client-capabilities` platform truth instead of rendering unsupported worker controls.
- Settings route buttons now navigate on iOS/iPad by posting `.home23SelectTab`; Mac keeps the window-targeted command router.
- Chat recovery now shows visible banners when a cached active turn is missing from `/api/chat/pending`, missing from `/api/chat/turn-status`, or inactive while still in an accepted/running state.
- Backend contract snapshots and new fixtures were mirrored into the Apple `contracts/` tree and `Home23Shared` test fixtures.

Fresh backend verification:

```bash
npm run test:contracts
node --test --test-concurrency=1 tests/contracts/query-facade-route.test.cjs tests/engine/dashboard/home23-tiles.test.js
npm run test:contracts:live
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```

Result:

- Contract suite: 12 passed, 1 skipped live shim.
- Focused query/tile suite: 18 passed, 0 failed.
- Safe live contract validation passed.
- Action-gated live contract validation passed for chat turn start/status/stop/SSE/pending, device register/registry/unregister/cleanup, query run/export dry-runs, disabled query stream event, and Sauna tile dry-run.

Scoped runtime action:

```bash
pm2 restart home23-jerry-dash
```

Fresh runtime proof:

```text
home23-cosmo23                 online     pid=86737 restarts=12
home23-jerry                   online     pid=94228 restarts=71
home23-jerry-harness           online     pid=94266 restarts=47
home23-jerry-dash              online     pid=95779 restarts=14
```

Jerry bridge health:

```json
{"status":"ok","agent":"jerry","type":"cosmohome","endpoint":"/api/chat","model":"gpt-5.5","provider":"openai-codex"}
```

Fresh Apple verification:

```bash
cd /Users/jtr/xCode_Builds/Home23/Home23Shared
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" swift test

cd /Users/jtr/xCode_Builds/Home23
node scripts/check-endpoint-categories.mjs
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23Mac \
  -configuration Debug \
  -derivedDataPath .DerivedData \
  -destination "platform=macOS,variant=Mac Catalyst" \
  CODE_SIGNING_ALLOWED=NO build
```

Result:

- `Home23Shared` tests: 10 passed, 0 failed.
- Endpoint categorization passed: 109 checked, capability endpoint 2, selected-agent bridge route 18, selected-agent dashboard route 70, house-global dashboard route 19.
- Mac Catalyst build: `** BUILD SUCCEEDED **`.

Fresh iOS/tvOS destination proof:

```bash
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23 -showdestinations

DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" \
xcodebuild -project Home23.xcodeproj -scheme Home23TV -showdestinations

DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" xcrun simctl list devices available
DEVELOPER_DIR="/Volumes/Casey Jones/XcodeStorage/Xcode.app/Contents/Developer" xcrun simctl runtime list
```

Result:

- `Home23` has only ineligible iOS destinations: `jtr iPhone` and `Any iOS Device`, both blocked by `iOS 26.4 is not installed`.
- `Home23TV` has only ineligible tvOS destinations: `Family Room` and `Any tvOS Device`, both blocked by `tvOS 26.4 is not installed`.
- `xcrun simctl list devices available` returned only `== Devices ==`.
- `xcrun simctl runtime list` returned zero disk images.
- This remains a local Xcode platform/destination installation blocker, not a proven source compile failure.

## Remaining Known Gaps

- Live contract validation now has bounded chat action/SSE coverage, device registration register/scoped-unregister/delete cleanup coverage, query run/export dry-run coverage, query stream event coverage, and Sauna tile action dry-run coverage.
- Chat now has stronger truth/recovery surfaces: persisted pending start gate, stale pending recovery on start/startup/periodic janitor, read-only pending polling, first-token `awaiting_model`, terminal timeout envelopes, isolated per-turn model selection, terminal SSE race coverage, and provider-family terminal error envelopes. The chat lifecycle backend slice is verified for this lock-in pass.
- Query streaming is intentionally disabled in the capability contract. The Apple app now follows the facade and does not call COSMO directly.
- Device registration is agent-scoped and receipt-backed. Per-chat removal is now explicit through scoped `DELETE /api/device/register` with `chat_ids`.
- Settings diagnostics now expose route truth, selected-agent bridge health, contract/query/model/push truth, restart receipts, and endpoint failures; Chat exposes turn status controls plus visible recovery banners for missing/inactive turns. Remaining diagnostics work is polish/deeper history, not the basic stuck-chat truth surface.
- iOS build could not be verified on this machine until the `Home23` scheme has an eligible iOS destination; Xcode reports `iOS 26.4 is not installed` for the listed iOS destinations even though `xcodebuild -showsdks` lists iOS/iOS Simulator 26.4 SDKs.
- tvOS build could not be verified on this machine until the `Home23TV` scheme has an eligible tvOS destination; Xcode reports `tvOS 26.4 is not installed` for the paired Apple TV and placeholder destination.
- The Home23 and Apple repos both had broad pre-existing local changes. No blanket stage/commit was performed because the working trees are not isolated to this effort.
