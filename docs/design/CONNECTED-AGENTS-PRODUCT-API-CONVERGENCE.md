# Connected Agents product API convergence

This slice owns the HTTP adapters and application ports only. It deliberately does not edit the M14 composition root or duplicate canonical Bot, Channel, Message, Unread, Work, Activity, coordinator, or lifecycle logic.

## M14 integration handoff

At the M14 composition point, construct the existing canonical services over the one coordination database and inject them into `createCoordinationRuntimeComposition` as `bots`, `channels`, `messages`, `unread`, `messageSubmission`, `work`, `leases`, `events`, `activity`, and `channelCoordinator`. Supply lifecycle effect adapters and a server-owned `resolveHttpPolicy` through the existing `botLifecycle` composition option. The resolver must derive standing scope and impact facts from trusted installation policy, never request JSON. The composition factory creates the trusted HTTP lifecycle adapter; do not inject `botLifecycle` or `botLifecycleApi` through the general service bag.

The Channel coordinator public adapter must implement `startFromMessage`. It resolves the canonical Message event, membership snapshot, standing-scope facts, authority epoch/writer, deadline, and context manifest on the server. None of those authority facts may come from the HTTP body. The route accepts only `messageId`, and is reachable only when `coordination.channels.enabled` is true and the adapter is present.

The Activity adapter must implement `list`, assembling the complete retained event/Message/Work-observation window and authenticated M08 audience before calling the M18 projector and paginator. A raw projector is intentionally insufficient to advertise the route.

Keep the listener at the canonical coordination port (default `7346`) and explicit loopback host. Do not mount these routes in the dashboard or add another database/event journal.

## Lifecycle removal semantics

The frozen v1 contract uses recoverable archive/restore, not destructive Bot deletion. This slice exposes create/list/get/start/stop. Archive/restore must converge only after the canonical M28 directory and resident adapters expose a single idempotent operation that retains mailbox/history; HTTP must not emulate deletion with process stop or filesystem removal.

## Activation order

1. Merge this slice after the M14 composition owner resolves only the `CoordinationServices` type conflicts.
2. Inject canonical read ports first and verify the temp-database HTTP journey.
3. Inject Jerry and Forrest direct-message submission after their resident flags and message authority epochs are accepted.
4. Inject Activity and coordinator adapters, leaving `coordination.channels.enabled` off until M16 acceptance.
5. Inject lifecycle adapters, leaving `coordination.bot_lifecycle.enabled` off until M28 acceptance.

All flags default off. Missing flags or dependencies fail closed; no injection changes an authority epoch.
