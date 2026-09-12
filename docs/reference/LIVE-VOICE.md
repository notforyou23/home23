# Live voice in product conversations

GPT-Live-1 supplies continuous speech for direct conversations in the iOS and iPadOS product client. The selected Home23 resident remains responsible for identity, memory, substantive answers, tools and durable Work. Mac retains dictation in this first implementation.

The native client negotiates WebRTC through authenticated Core endpoints. Core resolves the configured OpenAI credential at session creation; the client receives an opaque session ID and SDP answer, never an API key. The control sideband admits spoken requests through the same canonical message submission service as typed messages, retaining the current model and reasoning selection. No Agents API migration or separate reduced-capability voice agent is involved.

The live model can acknowledge speech and clarify a request. Substantive work is delegated to the resident. Delegation events contain metadata, not task text. Core appends transcript fragments in provider delivery order, partitions requests at the delegation's own audio offset, and allows a short delivery-settling interval. Fragments have no authoritative completed-turn signal: transcription and request interpretation still need evaluation with real conversations.

Both sides of speech are saved as ordinary canonical chat messages on speaker changes, quiet intervals, delegation boundaries and close. Recording speech alone does not create Work or send a push notification. Spoken assistant rows have no Work provenance; they record what was said and cannot establish that an action completed. A delegated request reuses its saved owner row. If the request spans several saved owner rows, a trusted internal ordered selection carries all of them into the resident instruction and durable recovery, while assistant clarification remains historical context. This selection is not accepted from an HTTP request body.

Only committed resident result messages with matching channel, conversation, owner request and terminal Work provenance are returned to speech. Raw specialist outputs wait for resident follow-through. Initial acknowledgments and later results are distinct; accepting Work never claims completion. Duplicate events/results are suppressed. Results overtaken by a newer owner request remain in canonical history and are supplied as quiet context. Ending voice leaves ongoing Work intact.

Endpoints under `/api/v1/channels/:channelId/voice`:

| Method | Suffix | Result |
| --- | --- | --- |
| GET | none | `available`, `model`, optional `reason` |
| POST | `/sessions` | `sessionId`, answer `sdp`, `model` |
| POST | `/sessions/:sessionId/heartbeat` | `sessionId`, `active` |
| POST | `/sessions/:sessionId/close` | `sessionId`, `finalized`, `reason`, optional `usageSeconds`, `transcriptSaved` |

All requests require product-read and message-send scopes. Mutations require an Idempotency-Key. Creation accepts `sdp`, optional `modelAlias`, `reasoningEffort`, `voice` and `speakingPace`. Voice defaults to `marin`; speaking pace is `slower`, `normal` (default) or `faster`. Pace is a prompt preference rather than a playback-speed parameter. These settings are fixed for each session and included in its replay identity. Session ownership is bound to the owner, device and canonical conversation. A heartbeat every 20 seconds renews the transient credential after normal authentication refresh; authorization and membership are checked again before delegated work and result delivery. A missing heartbeat ends the session after 75 seconds. Sessions also end after 60 minutes or Core drain.

Creation retries reuse one in-process result; a durable start digest prevents an uncertain or restarted request from silently creating a second billable session. Core stores private session/admission/close receipts beside its coordination database, without audio, credentials or SDP. Pending transcript text remains there until its canonical append succeeds; committed entries retain only IDs, sequence and digests. A failed final append returns `transcriptSaved: false` and the phone reports that the last transcript could not be saved. Provider audio storage is disabled. Closing waits up to 2.5 seconds for provider finalization, with a separate two-second best-effort transport cleanup bound, then flushes trailing transcript deltas. `finalized: false` never implies final usage or billing has been confirmed.

The microphone remains active during received speech. Explicit mute only affects microphone capture; it does not end billing. End stops local capture/playback immediately while control finalization drains. The UI does not call a device synthesizer during a live session.

The Apple app exposes voice and speaking pace under **Settings → Live Voice**, applying changes to the next session. Phone playback defaults to its loudspeaker and preserves supported external audio routes. The **Talk to Jerry** App Shortcut opens the current home's canonical Jerry conversation and starts voice once the app is ready in the foreground. The owner can assign it in iPhone **Settings → Action Button → Shortcut**. It requires device authentication; it does not silently start recording while the app is in the background.

Validation commands: `npm run test:live-voice`, `npx tsc --noEmit`, and the Apple repository's shared tests and unsigned iOS/Mac builds. A model-list response or successful build does not establish physical microphone, speaker, echo cancellation or interruption acceptance. Those require a device conversation after an authorized deployment.

Protocol references: [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [conversation lifecycle](https://developers.openai.com/api/docs/guides/live-conversations), and [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).
