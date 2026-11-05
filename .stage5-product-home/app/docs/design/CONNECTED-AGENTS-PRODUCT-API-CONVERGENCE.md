# Connected Agents product API convergence

The convergence composition injects the canonical SQLite-backed Bot directory, Channels, Messages, Inbox/Unread, Search, Work, Leases, events, and per-binding Jerry/Forrest message submission over one coordination database. Each direct conversation resolves its own reviewed resident transport, holder identity, and credential context. The submitted response is the actual target resident's `AgentLoop` result and is appended to that same transcript with Work provenance. No second product store is introduced.

## M14 integration handoff

At the M14 composition point, construct the existing canonical services over the one coordination database and inject them into `createCoordinationRuntimeComposition` as `bots`, `channels`, `messages`, `unread`, `messageSubmission`, `work`, `leases`, `events`, `activity`, and `channelCoordinator`. Supply lifecycle effect adapters and a server-owned `resolveHttpPolicy` through the existing `botLifecycle` composition option. The resolver must derive standing scope and impact facts from trusted installation policy, never request JSON. The composition factory creates the trusted HTTP lifecycle adapter; do not inject `botLifecycle` or `botLifecycleApi` through the general service bag.

The Channel coordinator adapter is an internal part of canonical group Message admission. It resolves the canonical Message event, membership snapshot, standing-scope facts, authority epoch/writer, deadline, and context manifest on the server. None of those authority facts may come from the HTTP body. A product client submits the owner Message once through `POST /api/v1/channels/{channelId}/messages`; there is no second public coordinate mutation that could start the same Round without the Message idempotency boundary.

The Activity adapter must implement `list`, assembling the complete retained event/Message/Work-observation window and authenticated M08 audience before calling the M18 projector and paginator. A raw projector is intentionally insufficient to advertise the route. The canonical process constructs this adapter only behind the independent `coordination.activity.enabled` runtime setting, and the application advertises it only while the separate `activity` authority epoch names `home23-coordination` as canonical.

Keep the listener at the canonical coordination port (default `7346`) and explicit loopback host. Do not mount these routes in the dashboard or add another database/event journal.

## Lifecycle removal semantics

The frozen v1 contract uses recoverable archive/restore, not destructive Bot deletion. The canonical lifecycle boundary exposes create/list/get/start/stop/archive/restore. Archive and restore are owner-authorized, authority-epoch checked, idempotent receipt-backed operations: they use exact resident process names and atomically transition only the SQLite Bot lifecycle/runtime-registration projection. Stable Bot, conversation/mailbox, transcript, attachment links, aliases, resident files, and provenance are retained. There is no destructive Bot delete route.

## Activation order

1. Merge this slice after the M14 composition owner resolves only the `CoordinationServices` type conflicts.
2. Inject canonical read ports first and verify the temp-database HTTP journey.
3. Inject Jerry and Forrest direct-message submission after their resident flags and message authority epochs are accepted.
4. Compose Activity and coordinator adapters, leaving `coordination.activity.enabled` and `coordination.channels.enabled` off until their independent M18/M16 acceptance; Activity additionally requires its canonical authority epoch.
5. Inject lifecycle adapters, leaving `coordination.bot_lifecycle.enabled` off until M28 acceptance.

All flags and independent runtime switches default off. Missing switches, authority, or dependencies fail closed; no injection changes an authority epoch.

## Bounded product-behavior blockers

Bot details truthfully labels the attested default boundary as `local_mac` / `This Mac`. It reports typed, non-retryable blockers rather than implying uncomposed capabilities:

- `isolated_execution_not_attested`: no attested disposable isolation adapter exists.
- `canonical_scheduler_adapter_unavailable`: the scheduler has no reviewed canonical routine-summary adapter in this bounded convergence.
- `consequential_action_consumer_unavailable`: the policy engine exists, but no native consequential action consumer supplies replay-safe approval persistence/action.

Archive/restore is available only when the complete canonical M28 lifecycle composition is present and its feature flag and authority epoch are active; otherwise the routes remain unavailable. Delegated Channel coordination remains blocked on the trusted M16 adapter. Neither capability is inferred from process labels or raw Work endpoints. Canonical Inbox activity derives compact queued/background/stopping/attention state from durable Work after restart while withholding Work IDs.

Apple and web clients may call the contract-locked `POST /api/v1/bots/{botId}/archive` and `/restore` endpoints with an idempotency key. They should retain cached transcript/attachment projections while archived, remove the Bot from ordinary active composition, and reconcile the returned receipt plus subsequent canonical event. A successful archive receipt means exact resident processes were stopped and the directory is archived; restore means exact resident processes were started and the same stable mailbox became active. Neither response claims a VM or isolated execution boundary.
