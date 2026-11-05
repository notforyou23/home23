# Connected Agents web acceptance matrix

This matrix applies the owner acceptance contract to the `/home23` web surface. “Code-verified” means deterministic source or HTTP tests cover the behavior. It does not substitute for the real authenticated screenshot journey.

| Area | Web implementation | Evidence state |
|---|---|---|
| Product root | `/home23` serves Connected Agents; `/home23/legacy` serves the prior dashboard. | Code-verified; desktop/narrow screenshots required. |
| Inbox grammar | One compact Inbox with Bots and Channels sections, obvious Search, New Bot, and New Channel. | Code-verified; real roster screenshot required. |
| Jerry / Forrest | Primary comes from bootstrap and falls back to Jerry identity; primary treatment is a small continuity mark. Forrest is a normal independently selectable Bot. | Code-verified; requires authenticated live roster evidence. |
| Ordering and unread | Pinned, active, unread, recent, stable-name ordering; unread comes only from canonical Inbox. | Code-verified; multi-device convergence remains a live workflow requirement. |
| Conversation | Split-pane transcript, actual authors, bounded line length, optimistic send, durable reload, visible retry, composer, attachment cards, compact activity. | Code-verified; send/response/activity screenshots and lost-response exercise required. |
| Long/background work | The web client refreshes canonical Inbox and the selected transcript every 15 seconds, pauses while hidden, and reconciles durable terminal messages. | Code-verified for refresh wiring; Core restart, late/duplicate completion, delegation return, and push/deep-link receipts still required. |
| Channels | Creation uses persistent Bot membership and canonical responder policy; transcript renders actual message authors and explicit `@Name` mentions. | Code/API-tested; real Jerry+Forrest mention/pass/failure journey required. |
| New Bot | Name, purpose, accent, collapsed Advanced section, idempotent create, preserved draft on failure, and an accepted provisioning row. | Code-verified; real provisioning/restart/stop/start journey required. |
| Details | Bot/Channel identity, purpose, members, availability, truthful “On this Mac,” notification state, exact start/stop/restart controls, and diagnostics link. | Code-verified. Core archive/restore routes pass through the authenticated proxy, but archived inventory and restore controls are not yet available in this web view. Routine details and verified isolation remain unavailable. |
| Search | Command-K, five visible scopes, local canonical Bot/Channel inventory matches, server-backed Message results, exact message destination, and partial/unavailable coverage labels. | Code-verified; exact live deep-link and partial-index screenshot required. Attachment search is explicitly unavailable. |
| Attachments | Existing durable attachment cards render safely. | Code-verified. Web upload/selection/retry remains blocked: the current dashboard request parser cannot safely stream the canonical multipart body through this bounded proxy. |
| Connection / onboarding | Tab-scoped bearer credential, revoked/expired/offline/reconnecting states, retry, forget-token, and no secret in URL or config. | Code/proxy-tested. Pair-code discovery, refresh, wrong-home selection, and device management are absent from the merged Core HTTP contract. |
| Approvals / stop / cancel | Failed sends have inline retry; Bot lifecycle has exact start/stop/restart. | Partial. Turn stop/cancel, consequential inline approvals, and durable approval outcomes have no product API in this commit and are not fabricated. |
| Delegation / routines | Durable returned messages and compact canonical activity can appear in the originating conversation. | Partial. No dedicated delegation, handoff, routine, or next-run product DTO exists in this commit; full workflow evidence remains blocked. |
| Execution truth | Details say “On this Mac”; verified isolation is explicitly unavailable. No weaker mechanism is called isolated. | Code-verified; no isolation workflow claimed. |
| Responsive / accessible | Desktop split view, optional details pane, narrow Inbox → Conversation → Details stack, skip link, semantic labels, focus return, arrow traversal, Command-K, light/dark, reduced motion, safe-area spacing. | Code-verified; desktop/narrow screenshots plus keyboard/screen-reader inspection required. |
| Performance / continuity | Skeleton launch state, no blank generic spinner, stable selection, conservative durable refresh. | Code-verified; cold/cached launch timing, offline reload cache, cross-device and app-restoration measurements remain outstanding. |

## Required real workflow evidence still outstanding

The isolated screenshot fixture can establish layout and responsive visual quality without touching runtime state. It cannot prove canonical behavior. Release acceptance still requires an operator-authorized authenticated workflow against a non-production or explicitly approved installation for: Jerry and Forrest identity, message send/response, Channel mention/pass, Bot provisioning and lifecycle, search deep-link, unread convergence, attachments, delegation return, background completion across restart, approvals, offline recovery, and cross-device continuity.
