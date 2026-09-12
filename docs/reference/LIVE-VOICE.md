# Live voice in product conversations

GPT-Live-1 supplies continuous speech for direct conversations in the iOS and iPadOS product client. The selected Home23 resident remains responsible for identity, memory, substantive answers, tools and durable Work. Mac retains dictation in this first implementation.

The native client negotiates WebRTC through authenticated Core endpoints. Core resolves the configured OpenAI credential at session creation; the client receives an opaque session ID and SDP answer, never an API key. The control sideband admits spoken requests through the same canonical message submission service as typed messages, retaining the current model and reasoning selection. No Agents API migration or separate reduced-capability voice agent is involved.

The live model can acknowledge speech and clarify a request. Substantive work is delegated to the resident. Delegation events contain metadata, not task text. Core collects timestamped transcript fragments, partitions requests at the delegation's own audio offset, and allows a short delivery-settling interval. Fragments have no authoritative completed-turn signal: transcription and request interpretation still need evaluation with real conversations. Brief replies carry attributed historical voice context so the resident can understand the question being answered. That context is quoted within the owner message; live paraphrases are not appended as authoritative resident messages.

Only committed resident result messages with matching channel, conversation, owner request and terminal Work provenance are returned to speech. Raw specialist outputs wait for resident follow-through. Initial acknowledgments and later results are distinct; accepting Work never claims completion. Duplicate events/results are suppressed. Results overtaken by a newer owner request remain in canonical history and are supplied as quiet context. Ending voice leaves ongoing Work intact.

Endpoints under `/api/v1/channels/:channelId/voice`:

| Method | Suffix | Result |
| --- | --- | --- |
| GET | none | `available`, `model`, optional `reason` |
| POST | `/sessions` | `sessionId`, answer `sdp`, `model` |
| POST | `/sessions/:sessionId/heartbeat` | `sessionId`, `active` |
| POST | `/sessions/:sessionId/close` | `sessionId`, `finalized`, `reason`, optional `usageSeconds` |

All requests require product-read and message-send scopes. Mutations require an Idempotency-Key. Creation accepts `sdp`, optional `modelAlias` and `reasoningEffort`. Session ownership is bound to the owner, device and canonical conversation. A heartbeat every 20 seconds renews the transient credential after normal authentication refresh; authorization and membership are checked again before delegated work and result delivery. A missing heartbeat ends the session after 75 seconds. Sessions also end after 60 minutes or Core drain.

Creation retries reuse one in-process result; a durable start digest prevents an uncertain or restarted request from silently creating a second billable session. Core stores minimal session/admission/close receipts beside its coordination database, without audio, credentials or SDP. Provider audio storage is disabled. Closing waits up to 2.5 seconds for finalization, with a separate two-second best-effort cleanup bound. `finalized: false` never implies final usage or billing has been confirmed.

The microphone remains active during received speech. Explicit mute only affects microphone capture; it does not end billing. End stops local capture/playback immediately while control finalization drains. The UI does not call a device synthesizer during a live session.

Validation commands: `npm run test:live-voice`, `npx tsc --noEmit`, and the Apple repository's shared tests and unsigned iOS/Mac builds. A model-list response or successful build does not establish physical microphone, speaker, echo cancellation or interruption acceptance. Those require a device conversation after an authorized deployment.

Protocol references: [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [conversation lifecycle](https://developers.openai.com/api/docs/guides/live-conversations), and [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).
