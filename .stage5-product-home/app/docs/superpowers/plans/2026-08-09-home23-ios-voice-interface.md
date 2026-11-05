# Home23 iOS Voice Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` for execution. This is a two-repo program (Home23 backend + Home23 Apple clients), not a single patch. Track progress by checking off the `- [ ]` items in this file as each step is completed and verified.

**Goal:** Give the Home23 iOS app a real voice interface — speech as *live conversational input* (streaming on-device transcription with visible partial results, silence endpointing, and auto-submit), a hands-free conversation loop with barge-in, and spoken replies in the agent's actual configured voice — without changing a single existing wire contract. Voice turns are ordinary chat turns; the only new backend surface is one small, contract-locked TTS route.

**Architecture:** The backend stays the source of truth. Speech-to-text runs entirely on device (`SpeechAnalyzer`/`SpeechTranscriber`, iOS 26+) and submits finalized utterances through the existing locked chat contract (`POST /api/chat/turn` → SSE `response_chunk` stream → stop by exact `turn_id`). Text-to-speech has two sources: the agent's real voice via a new authenticated bridge route backed by the harness's existing `TTSService` (ElevenLabs/MiniMax), and `AVSpeechSynthesizer` as the fail-closed on-device fallback. Capability and health endpoints advertise voice truth; the app never guesses.

**Tech Stack:** Home23 Node/TypeScript harness bridge (`src/routes/`, `src/home.ts`), AJV contract layer under `contracts/`, engine dashboard `client-capabilities.js`; Swift/SwiftUI Apple clients in `/Users/jtr/xCode_Builds/Home23` (`Home23`, `Home23Shared`, `Home23TV`); Speech framework (`SpeechAnalyzer`, `SpeechTranscriber`, `SpeechDetector`), `AVAudioEngine` with voice processing (AEC), `AVAudioSession .playAndRecord/.voiceChat`, App Intents; Xcode 27 beta with iOS 27 SDK, deployment target iOS 26.

---

## Current Truth (verified 2026-08-09 against this repo)

- **The backend already synthesizes the agent's voice.** `src/observability/tts.ts` exports `TTSService` with providers `elevenlabs` and `minimax`, returning `audio/mpeg` Buffers. `TTSConfig` (src/types.ts) is `{ enabled, auto, provider, apiKey, voiceId, modelId }`; `src/home.ts` (~line 305) hydrates `apiKey` from the matching `providers.<name>.apiKey` block and instantiates `ttsService` (null when disabled/keyless). The only consumer today is the media tool (`src/agent/tools/media.ts` line ~676) calling `ctx.ttsService.speak(text, true)` — `tagged: true` bypasses the `auto: 'tagged'` gate. **There is no client-facing TTS route.**
- **The chat wire already supports everything voice needs on input.** `POST /api/chat/turn` starts a turn, `GET /api/chat/stream` delivers `response_chunk`/`thinking`/`tool_start`/`status` events, `GET /api/chat/turn-status` is non-mutating recovery truth, and `POST /api/chat/stop-turn` honors exact `turn_id` — barge-in maps directly onto it. None of these change.
- **Contract layer:** `contracts/manifest.json` (contractVersion `2026.07.14`) entries carry `{ id, method, base, route, schema, definition, fixture, auth, liveValidation, consumers }`. Bridge routes use `auth: "optional"` (bearer-if-configured, `checkAuth()` pattern in `src/routes/device.ts`). `npm run test:contracts` validates fixtures; `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live` runs bounded action probes.
- **Capabilities:** `engine/src/dashboard/client-capabilities.js` serves `features`, `endpoints`, `auth`, `chat`, `push`, `houseGlobal` blocks; no `voice` block exists. `CONTRACT_VERSION` is a dated string.
- **Bridge `/health`** reports per-agent provider/model truth and is the app's per-agent liveness authority; it does not yet report TTS state.
- **Apple client state** (per `docs/ios-parity.md` and the 2026-06-26 lock-in receipts): Chat is contract-locked with turn status, stop-by-turn_id, and capability gating; `Home23Shared` decodes every backend fixture; `scripts/check-endpoint-categories.mjs` fails any hardcoded backend path. The last verification pass recorded **missing local iOS/tvOS platform components in Xcode** — installing current platforms is step zero for any device build.
- **OS/tooling versions:** iOS 26.x ships today. iOS 27 was announced at WWDC on 2026-06-08 and is in developer beta (public beta since July; Xcode 27 beta 4, build 27A5228h, 2026-07-20); GA expected ~mid-September 2026. Everything this plan needs (`SpeechAnalyzer`, `SpeechTranscriber`, `SpeechDetector`, voice-processing audio) is **iOS 26 baseline**; nothing speech-specific is 27-only. WWDC 2026 deprecated SiriKit — App Intents is the only supported Siri path.
- **v2 substrate note:** voice turns enter the agent's life through the same conversation channel as typed turns, so the Seed's conversation shipper metabolizes them with no substrate work. Do not add any voice-specific writes to substrate surfaces — organic events only.

## Non-Negotiable Gates

- **Contract-first.** No Swift work on a surface until its schema, fixture, and AJV validation exist in this repo and pass.
- **No existing wire shape changes.** Chat, device, settings, query, home, and sauna contracts are frozen; voice adds surfaces, it never mutates them.
- **On-device STT only.** Raw microphone audio never leaves the phone for transcription. The only audio on the wire is backend TTS *output*.
- **Fail-closed voice source.** The app uses backend TTS only when capabilities advertise it AND the selected agent's bridge `/health` reports it enabled; otherwise it falls back to `AVSpeechSynthesizer` and says so in diagnostics. Never a silent dead speaker.
- **Voice turns are ordinary chat turns.** Same `chat_id` space, same history, same pending/stop semantics. No parallel voice transcript store, no manufactured events.
- **No wake word.** Invocation is push-to-talk, an explicit hands-free session toggle, or App Intents. No always-on microphone.
- **Deployment target iOS 26, built with the Xcode 27 beta SDK.** 27-only APIs (if any get adopted) sit behind `#available(iOS 27, *)`.
- **No hardcoded ports or COSMO routes in Swift.** Endpoint truth comes from `/home23/api/client-capabilities`; `scripts/check-endpoint-categories.mjs` must stay green.
- **Scoped restarts only.** Backend changes restart the named harness process (`home23-<agent>-harness`), nothing broader.
- **tvOS is out of scope** and must not advertise voice; gate by capabilities.

---

## Task 1: Backend TTS Contract And Route (this repo)

**Files:**

- Create: `src/routes/tts.ts`
- Modify: `src/home.ts` (route registration + startup banner line)
- Modify: `contracts/schemas/chat.schema.json` or create `contracts/schemas/voice.schema.json`
- Create: `contracts/fixtures/tts-request.json`
- Create: `contracts/fixtures/tts-unavailable.json`
- Modify: `contracts/manifest.json`
- Modify: `engine/src/dashboard/client-capabilities.js`
- Modify: `tests/contracts/client-capabilities-route.test.cjs`
- Create: `tests/agent/tts-route.test.ts` (register in package.json `test` list — tests/agent files are enumerated explicitly)
- Modify: `scripts/validate-live-contracts.mjs` (action-gated probe)

- [ ] **Step 1: Define the wire contract**

Decisions (pre-made — do not reopen):

- Route: `POST /api/tts` on the selected-agent **bridge** (same port family as chat).
- Request: `{ "text": "<1..2000 chars>", "format": "mp3" }` — `format` optional, `mp3` is the only v1 value.
- Success: `200` with `Content-Type: audio/mpeg` binary body (stateless; no file writes, no media-path indirection).
- Unavailable (no `ttsService` — disabled or keyless): `503` JSON `{ "error": "tts_unavailable" }`. This is a contract state, not a failure.
- Oversize text: `413` JSON `{ "error": "text_too_long", "max": 2000 }`. Empty/missing text: `400`.
- Auth: identical bearer-if-configured policy as chat/device (`checkAuth` pattern).
- Schema definitions: `ttsRequest`, `ttsUnavailableResponse`, `ttsErrorResponse`. The binary success body is validated by the live probe (status + content-type + non-empty body), not AJV.
- Manifest entry: `id: "tts-speak"`, `base: "bridge"`, `auth: "optional"`, `liveValidation: "requires-action"`, `consumers: ["ios", "mac"]`.

- [ ] **Step 2: Implement `src/routes/tts.ts`**

`createTtsHandler({ ttsService, authToken })` mirroring the device-route style: auth check, body validation, `ttsService.speak(text, true)` (tagged-bypass, same as the media tool), buffer → `res.type('audio/mpeg').send(buf)`; `null` service or `null` buffer → the 503 contract state. Register in `src/home.ts` next to the device routes and add `/api/tts` to the bridge startup log line.

- [ ] **Step 3: Advertise voice truth**

- `client-capabilities.js`: add `features.voiceTts: true`, `endpoints.tts: '/api/tts'`, and a `voice` block:

```json
{ "input": "on-device", "tts": true, "ttsEndpoint": "/api/tts", "ttsFormats": ["mp3"], "maxTextLength": 2000 }
```

- Bump `CONTRACT_VERSION` to the execution date.
- Bridge `/health`: add an additive optional `tts` field — `{ "enabled": bool, "provider": string, "voice": string }` (no secrets). Capabilities advertise the *surface*; `/health` is the per-agent *availability* truth the app gates on.
- Extend `tests/contracts/client-capabilities-route.test.cjs` for the new block.

- [ ] **Step 4: Tests and live probe**

- `tests/agent/tts-route.test.ts`: mocked `TTSService` — success returns audio/mpeg buffer; disabled service → 503 shape; oversize → 413; auth enforced when token configured; `auto: 'tagged'` config still speaks (tagged bypass).
- Live probe (action-gated): POST a short fixed string (≤ 40 chars), assert 200 + `audio/mpeg` + non-empty body, or a valid 503 envelope when the install has TTS disabled. Never log the audio or the text with user data.
- Run: `npm run build`, registered test file, `npm run test:contracts`, then scoped `pm2 restart home23-<agent>-harness` and `HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live`.

Expected:

- A client can obtain the agent's voice for arbitrary text with one authenticated POST, and can distinguish "no TTS configured" from failure.

---

## Task 2: Apple Contract Snapshot And Typed Models

**Files:**

- Modify: `/Users/jtr/xCode_Builds/Home23/contracts/*` (rsync snapshot from backend after Task 1)
- Create: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/VoiceContracts.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Sources/Home23Shared/Models/ClientCapabilities.swift`
- Modify: `/Users/jtr/xCode_Builds/Home23/Home23Shared/Tests/Home23SharedTests/ContractFixtureDecodeTests.swift` (+ fixture copies)

- [ ] Snapshot backend `contracts/` into the Apple repo (same rsync flow as the 2026-06-26 lock-in), add typed `TtsRequest`, `TtsUnavailableResponse`, `VoiceCapabilities`, extend the capabilities model with the `voice` block and `/health` `tts` field, decode every new fixture, and add negative decodes (missing `text`, unknown `format`). `swift test` green.

---

## Task 3: Voice Input Engine (iOS)

**Files:**

- Create: `Home23/Sources/Core/Voice/AudioCaptureController.swift`
- Create: `Home23/Sources/Core/Voice/TranscriptionController.swift`
- Modify: `Home23/Info.plist` (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`)
- Modify: `Home23/Sources/Features/Chat/ChatView.swift` (mic affordance + live transcript rendering)

- [ ] **Step 1: Capture.** `AVAudioEngine` input tap with `setVoiceProcessingEnabled(true)` on the input node (echo cancellation — required for barge-in later), audio session `.playAndRecord` + `.voiceChat` + `.duckOthers`, interruption and route-change handling (Bluetooth/CarPlay mic switches must not kill the session).
- [ ] **Step 2: Transcription.** `SpeechAnalyzer` + `SpeechTranscriber` fed from the tap via `AsyncStream`; render **volatile** results live in the chat input as styled provisional text; keep finalized segments. Ensure the locale model via `AssetInventory` (download UI state when the on-device model is absent). No `SFSpeechRecognizer` anywhere.
- [ ] **Step 3: Endpointing.** Finalize an utterance on (a) explicit user tap, or (b) hands-free silence endpoint: `SpeechDetector` (or volatile-result quiescence) + a configurable 0.9–1.5s silence window. Endpointed text auto-submits through the **existing** `ChatViewModel` turn start — no new send path.

Expected:

- Push-to-talk dictation works end to end with visible live words, entirely on device, and a finished utterance becomes a normal chat turn.

---

## Task 4: Hands-Free Conversation Loop With Barge-In

**Files:**

- Create: `Home23/Sources/Core/Voice/VoiceSessionController.swift`
- Modify: `Home23/Sources/Features/Chat/ChatViewModel.swift`
- Modify: `Home23/Sources/Features/Chat/ChatView.swift`

- [ ] **Step 1: State machine.** `idle → listening → endpointing → thinking(turn_id) → speaking → listening…`, surfaced as a visible chip using the shared status vocabulary (`Home23StatusVocabulary`) — the user must always see which state the session is in. `thinking` maps from the existing turn status contract (`accepted/running/awaiting_model/streaming/tool_running`).
- [ ] **Step 2: Speak-as-it-streams.** Sentence-segment the `response_chunk` SSE accumulation (punctuation + length heuristic) and enqueue segments for playback while the turn is still streaming. Strip markdown/code fences from spoken text; code blocks are summarized as "…code omitted…" aloud but render normally in the transcript.
- [ ] **Step 3: Barge-in.** Mic stays open during `speaking` (AEC from Task 3). Sustained user speech (VAD, not a cough — ≥ ~300ms voiced) → immediately stop playback, flush the speech queue, and `POST /api/chat/stop-turn` with the exact active `turn_id`; transition to `listening` with the interrupted turn's partial text preserved in the transcript.
- [ ] **Step 4: Recovery.** Lost SSE during a voice turn uses the existing `turn-status` polling path; a voice session never starts a duplicate turn to unstick itself.

Expected:

- A full spoken exchange works hands-free; interrupting the agent mid-sentence stops the exact turn and returns to listening in under ~500ms perceived.

---

## Task 5: Voice Output — The Agent's Voice With Fail-Closed Fallback

**Files:**

- Create: `Home23/Sources/Core/Voice/VoicePlaybackController.swift`
- Modify: `Home23/Sources/Core/Networking/APIClient.swift`

- [ ] Backend source: per sentence-segment, `POST /api/tts` (from capability endpoint truth) with the bridge bearer; play returned `audio/mpeg` via a gapless `AVQueuePlayer`/`AVAudioPlayer` pipeline; prefetch segment N+1 while N plays. On 503/timeout/decode failure → mark backend voice unavailable for the session, switch to `AVSpeechSynthesizer`, surface the switch in diagnostics. Cache identical short segments per session (LRU, memory-only).
- [ ] Fallback source: `AVSpeechSynthesizer` with a quality installed voice; same queue semantics so barge-in behavior is identical.
- [ ] Gate: backend voice only when `capabilities.voice.tts == true` AND selected-agent `/health.tts.enabled == true`.

Expected:

- Replies speak in the agent's ElevenLabs voice when the install has it; otherwise a clear on-device voice — never silence, never a spinner.

---

## Task 6: App Intents Invocation

**Files:**

- Create: `Home23/Sources/App/Intents/AskAgentIntent.swift`

- [ ] `AskAgentIntent` (App Intents — **not** SiriKit, which WWDC 2026 deprecated): opens the app into hands-free voice mode for the selected agent and starts listening; optional `agent` parameter resolved from the roster. Donate on voice-mode use so Shortcuts/Siri suggest it. No transcription inside the intent — it launches the session; the in-app engine owns audio.

---

## Task 7: Settings, Diagnostics, tvOS Scope

**Files:**

- Modify: `Home23/Sources/Features/Settings/SettingsView.swift`
- Modify: `Home23TV/*` (verification only)

- [ ] Settings: voice section — enable voice mode, hands-free toggle, silence-window slider, voice source (auto/backend/on-device), locale + on-device model asset state, spoken-code preference, and route-truth diagnostics: capabilities `voice` block, selected-agent `/health.tts`, last `/api/tts` failure, active session state.
- [ ] tvOS: assert it does not surface voice (capabilities-gated; `platforms.tvos` unchanged).
- [ ] `node scripts/check-endpoint-categories.mjs` passes with `/api/tts` categorized as a selected-agent bridge route.

---

## Task 8: End-To-End Verification And Receipts

- [ ] **Step 0 (blocking):** install current Apple platforms in Xcode — Xcode 27 beta with the iOS 27 SDK and at least one iOS simulator runtime (the 2026-06-26 receipts recorded zero installed runtimes). Deployment target stays iOS 26.
- [ ] Backend: `npm run build`, registered tests, `npm run test:contracts`, scoped harness restart, safe + action-gated live validation.
- [ ] Apple: `Home23Shared` `swift test`, endpoint categorization, iOS build (simulator + generic device), Mac Catalyst build; tvOS build unchanged.
- [ ] Live smoke on a real device: push-to-talk turn; hands-free multi-turn exchange; barge-in mid-reply (verify exact-turn stop via `/api/chat/pending`); backend-voice → airplane-mode fallback switch; App Intents launch; Bluetooth route change mid-session.
- [ ] Write `docs/superpowers/reports/<date>-home23-ios-voice-verification.md` with command output per gate; update `docs/ios-parity.md` (both repos) with the voice surface, capability version, and the tvOS exclusion.

## Execution Model

1. **Coordinator:** owns this plan, sequencing, contract version bump, receipts, commit scope.
2. **Backend Contract Worker:** Task 1 (route, schemas, fixtures, capabilities, live probe).
3. **Apple Shared Contracts Worker:** Task 2.
4. **Voice Input Worker:** Task 3.
5. **Conversation Loop Worker:** Task 4 (owns `ChatViewModel` touchpoints).
6. **Playback Worker:** Task 5.
7. **App Worker:** Tasks 6–7.
8. **Reviewer:** cross-checks endpoint names, auth modes, capability gating, fail-closed fallback, and that no existing contract shape changed.

Backend Task 1 must land and validate before any Swift worker starts (contract-first gate). Tasks 3/5 can run in parallel after Task 2; Task 4 depends on both.

## Completion Definition

- One new backend route, contract-locked, live-validated, advertised in capabilities and `/health` — and zero changes to existing wire shapes.
- Live streaming on-device transcription with visible partials, silence endpointing, and auto-submit through the existing chat path.
- Hands-free loop with sub-second barge-in that stops the exact turn.
- Agent-voice TTS with a fail-closed on-device fallback, capability- and health-gated.
- App Intents invocation; tvOS unchanged; endpoint categorization green.
- Verification report and parity docs updated in both repos.
