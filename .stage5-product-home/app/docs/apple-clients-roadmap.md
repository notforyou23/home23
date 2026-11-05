# Home23 Apple Clients Roadmap

Home23 should grow from an iPhone app into an Apple client family with a shared core and platform-native shells. Priority is Apple TV first, then Mac.

## Product Priority

1. tvOS app
2. iOS app hardening alongside tvOS
3. macOS app

The iOS app remains the proving ground for shared networking and contract decode behavior, but the next new platform should be Apple TV.

## Shared Core

Create a shared Swift target or package that all Apple clients use:

```text
Home23Shared
  Models
  APIClient
  AgentDirectory
  HostConfig
  TurnStream
  ChatViewModel core logic
  Home/query/settings/sauna service clients
  Contract fixture decode tests
```

Platform app targets should own layout, input, focus, navigation, and presentation:

```text
Home23 iOS
Home23 tvOS
Home23 macOS
```

## tvOS First Experience

The Apple TV app should be dashboard-first, but chat must be first-class.

Primary tvOS screens:

- Home: selected-agent overview, pulse, sensors, goals, dreams, vibe
- Chat: full-screen selected-agent conversation with dictation-friendly input
- Query: focused prompt/results view, likely simpler than iOS at first
- Sauna: couch-friendly start/stop and preset controls
- Settings: host, token, agent selection, connection test

## tvOS Chat Shape

Chat should not be treated as a compromised TV feature. The TV can use dictation for text entry, so the app should optimize around quick voice prompt submission and readable responses.

Recommended first version:

- selected agent visible in the top bar
- transcript as the main surface
- focused composer button opens a text entry field
- send/stop controls always reachable by focus
- model selector can be hidden behind an options sheet
- history is secondary, not the first-launch experience
- tool/media cards render read-only first

Reuse the existing chat turn lifecycle:

- `POST /api/chat/turn`
- `GET /api/chat/stream`
- `POST /api/chat/stop-turn`
- `GET /api/chat/pending`
- `GET /api/chat/history`
- `GET /api/chat/conversations`

## tvOS UI Rules

- Build for the Focus Engine, not touch.
- Use large readable transcript text and generous row spacing.
- Keep action count low on the main screen.
- Avoid dense settings tables.
- Treat dashboard cards as glanceable bands, not small iPhone cards.
- Prefer full-screen media/vibe display where useful.

## Mac Later

The Mac app should reuse the same shared core but serve a different job:

- menu bar status
- full chat/query workspace
- settings/control plane
- multi-agent operations
- local notifications
- quick command palette

Mac can wait until tvOS proves the shared core boundary.

## Build Order

1. Add `Home23Shared` and move pure Swift models/networking into it.
2. Add contract fixture decode tests against `contracts/fixtures`.
3. Move chat lifecycle logic into shared while leaving SwiftUI rows platform-specific.
4. Add a tvOS target using `Home23Shared`.
5. Build tvOS onboarding: host, token, roster fetch, selected agent.
6. Build tvOS Chat.
7. Add tvOS Home dashboard.
8. Add tvOS Sauna.
9. Expand Query and Settings.
10. Add macOS target after tvOS stabilizes.

## Contract Impact

The shared contract work is the spine for all Apple clients. Main Home23 owns `contracts/`; this Apple client repo keeps a snapshot. Every Apple target should decode the same fixtures before shipping.
