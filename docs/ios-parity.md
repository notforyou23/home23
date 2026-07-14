# Apple Client Parity And Shared Contract Plan

The Apple clients should stay separate from the main Home23 runtime, but the API contract should live with main Home23. That gives backend, web, iOS, Mac Catalyst, and tvOS a shared source of truth without importing Xcode, signing, APNs, and TestFlight concerns into the core repo.

Current contract version: `2026.07.13`.

Verification receipt: `docs/superpowers/reports/2026-06-26-home23-apple-contract-lock-in-verification.md`.

## Current Lock-In State

- `contracts/manifest.json` now maps Apple-consumed routes to schema, fixture, auth mode, live validation mode, and consumers.
- `npm run test:contracts` validates all contract fixtures with AJV.
- `npm run test:contracts:live` validates safe live GET routes; `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` also runs the bounded chat start/SSE/status/stop/pending probe.
- `GET /home23/api/client-capabilities` is live and advertises platform truth, query facade truth, chat recovery support, push receipt support, and house-global surfaces.
- Apple clients should read Query truth from `/home23/api/query/catalog`; direct client calls to COSMO port `43210`, `/api/providers/models`, `/api/brains`, or `/api/brain/*` are no longer valid app paths.
- Chat recovery truth is exposed through `GET /api/chat/turn-status?chatId=<id>&turn_id=<id>`, and stop requests should include `turn_id`.
- Apple Settings now exposes route-truth diagnostics: selected agent, dashboard/bridge URLs, bridge health/model, contract version, query catalog/model availability, default chat provider/model, push receipt, and current endpoint failures.
- Device registration accepts and returns agent-scoped receipt fields: `agent_id`, `registered_chat_ids`, `ignored_chat_ids`, `updated_at`, and device metadata.
- Device unregister supports scoped `chat_ids` removal through `DELETE /api/device/register`, returning removed and remaining chat ids.
- Sauna actions expose backend field metadata (`min`, `max`, `step`, `unit`) so clients can render controls from the contract instead of hardcoded limits.
- tvOS consumes `/home23/api/client-capabilities` and advertises only its supported subset until it implements full Query and Settings parity.
- Query notebook v1 publishes strict, redacted inventory, status, progress/gap/terminal events, protected result, cancel, continuation action, notification subscription, device credential, and same-origin web-session contracts. The global dashboard remains `auth.dashboard: none`; every Query notebook manifest entry is independently `auth: required`.

## Target Shape

```text
home23/
  contracts/
    schemas/
    fixtures/
  docs/
    ios-parity.md
  tests/
    contract/

Home23 Apple clients/
  contracts/              # generated/copied snapshot during transition
  Home23Shared/           # local shared package and fixture decode checks
  Home23/                 # iOS + Mac Catalyst full-parity source
  Home23TV/               # tvOS presentation shell
```

## Contract Surfaces

| Surface | iOS usage | Contract files |
| --- | --- | --- |
| Agent roster | selected/current/primary resolution, dashboard and bridge ports | `agent-roster.schema.json` |
| Chat | turn start, stream events, pending turns, history, conversations, models | `chat.schema.json` |
| Settings control plane | status, scope, model defaults, query defaults, agent actions | `settings.schema.json` |
| Query | defaults, provider catalog, brain registry, request/result/stream/export | `query.schema.json` |
| Query notebook | protected history, status, truthful progress, result, continuation, cancel, and terminal notification subscription | `query-notebook.schema.json` |
| Home cards | summary, pulse, goals, dreams, sensors, memory, vibe | `home-surfaces.schema.json` |
| Sauna | tile state and start/stop actions | `sauna.schema.json` |
| Client handshake | backend feature/version discovery | `client-capabilities.schema.json` |
| Device registration | APNs token registration, per-agent chat ids, receipt diagnostics | `device.schema.json` |
| Worker agents | worker roster and capability surface | `worker-agents.schema.json` |

## Parity Matrix

| Capability | Web/Main Home23 | iOS | Mac | tvOS | Contract status | Notes |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Multi-agent roster | yes | yes | yes | partial | live | Required for all selected-agent surfaces |
| Selected-agent dashboard cards | yes | yes | yes | partial | live | Apple clients use `dashboardURL(for:)` |
| Selected-agent chat bridge | yes | yes | yes | partial | live | Apple clients use `bridgeURL(for:)` |
| Chat turn status/recovery | yes | yes | yes | partial | live | `/api/chat/turn-status`; stop by `turn_id` |
| Query dashboard parity | yes | yes | yes | no | live facade | `/home23/api/query/catalog`, `/run`, `/export`; legacy stream truth remains separately advertised |
| Durable Query notebook | yes | planned | planned | no | protected v1 contract | Route-scoped device bearer or same-origin web session; no raw operation records or result handles |
| Settings model/query control | yes | yes | yes | partial | live | Per-agent settings remain explicit |
| Agent lifecycle actions | yes | yes | yes | partial | live | POST action responses use common save response |
| Sauna tile control | yes | yes | yes | partial | live | House-global unless backend exposes selected-agent semantics |
| Media serving | yes | yes | yes | partial | documented | Binary endpoint, query param contract only |
| Push registration receipts | yes | yes | yes | partial | live | Agent-scoped receipt from `/api/device/register` |
| Client capability handshake | yes | yes | yes | yes | live | `/home23/api/client-capabilities` |
| Contract tests | yes | yes | yes | shared | live | Backend AJV tests and `Home23Shared` fixture decode tests |

## Route Rules

- Home and selected-agent dashboard surfaces use the selected agent dashboard port.
- Query uses the selected-agent dashboard query facade under `/home23/api/query/*`.
- Query notebook history and operation resources use the protected selected-agent routes under `/home23/api/query/notebook` and `/home23/api/query/operations/{operationId}/*`.
- iOS and Mac provision a route-scoped credential from the selected-agent harness at `/api/device/query-credential`; that credential, its token, and generation belong in protected credential storage and never in logs or notebook fixtures.
- The same-origin web Query surface exchanges its configured bridge bearer at `/home23/api/query/session` for a short-lived HttpOnly session. Cross-origin access and global `auth.dashboard: none` do not grant notebook access.
- Chat uses the selected agent bridge port.
- Roster discovery still starts from the house dashboard at port `5002`.
- Binary media remains served from `/home23/api/media?path=...`.
- Optional fields should stay optional unless every deployed iOS build can tolerate the requirement.
- No Apple client should call COSMO port `43210`, `/api/providers/models`, `/api/brains`, or `/api/brain/*` directly.
- `GET /home23/api/client-capabilities` is the authority for `query.notebookVersion`, progress snapshots, action tokens, device credentials, web sessions, terminal-notification subscriptions, and exact endpoint templates. Clients fail closed when `auth.queryNotebook` is not `required`.
- Notebook summaries and protected results use the same bounded `resultVersion`; public DTOs never contain `resultHandle`, canonical roots, source pins, filesystem paths, raw provider payloads, sweep outputs, or capability material.
- tvOS can consume shared contracts but must not claim full iOS/Mac capability until its UI implements the surface.

## Remaining Follow-Ups

- Add bounded live action contract probes for query run/export and tile actions once those have safe dry-run/read-only semantics.
- Extend Settings diagnostics with deeper endpoint history/persistence. The basic route-truth surface is live in the Apple app.
- Re-run iOS and tvOS builds after Xcode 26.4 platform/destination installation is fixed on this machine.
