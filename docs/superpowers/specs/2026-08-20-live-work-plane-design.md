# Home23 Live Work Plane — Design (v1)

Date: 2026-08-20  
Status: approved — implement attach + steer for chat-backed runs  
Extends: `docs/design/STEP31-ASYNC-WORK-DESIGN.md`  
Does not replace: `docs/superpowers/specs/2026-07-17-ai-os-kernel-control-plane-design.md` (kernel approvals)

## Bar

The operator can answer, for one agent:

> What is running right now, and can I open it and correct it?

v1 is a **live work plane**, not a kernel. Home Needs you / In flight / Verified stay authorization lanes. This plane is process attach: subagents and cron `agentTurn`s that already have a Home23 conversation.

## Product

- **WorkRegistry** is the source of truth for detached chat-backed runs.
- **Chat strip** shows work launched from the conversation you are in. Open switches Chat to that child `chatId` and attaches the live turn.
- **Work tab** (this agent's dashboard) lists every active record for the agent, including cron that never touched a human chat.
- **Steer** queues an operator note. AgentLoop drains it at the **next** tool-round (before the next model call). Mid-stream / mid-tool waits. Cancel still aborts the whole turn.
- Per-agent only. No Jerry+Forrest rollup. No writing this list into OS-kernel In flight.

## Non-goals (v1)

- Workers, coding-job talk-to, house-wide multi-agent rollup
- Splicing tokens into a live completion
- True mid-tool abort via steer (Cancel only)
- Cron `exec` / `query` / `systemEvent` work records

## Objects

### Work kinds and handles

`AsyncWorkKind` adds `cron`.

`WorkResultHandle` adds `{ type: 'cron_chat'; chatId: string }`.

| Kind | Handle | Open | Steer | Cancel |
|------|--------|------|-------|--------|
| `subagent` | `subagent_chat` | yes | yes | `stopChat` |
| `cron` | `cron_chat` | yes | yes | `stopChat` |
| `coding` | `coding_job` | no | no | existing job cancel |

Chat handles are any handle with a `chatId` (`subagent_chat`, `cron_chat`).

### Cron records

Created when a cron `agentTurn` starts in `src/home.ts`:

- `originChatId` = `cron-<jobId>` (the isolated cron chat; no human parent)
- `label` = job name
- `resultHandle` = `{ type: 'cron_chat', chatId: cron-<jobId> }`
- `complete` in `finally` (`completed` / `failed` / `cancelled`)

Boot reconciliation treats non-terminal `cron` like `subagent`: the in-process turn is gone → `interrupted`.

### Steer queue

In-memory, per `chatId`, cap 8. Dies on harness restart (existing interrupt rules apply).

`POST /api/work/:workId/inject { text }`:

- 400 empty text or coding-job handle
- 409 already terminal
- overflow (9th note) rejected
- on accept: enqueue + `noteProgress` ("steer pending")

Drained notes are prefixed `[Operator steer]` and appended as a user message to the in-flight loop arrays **and** conversation history so an opened chat shows them.

## Surfaces

### Chat strip

Origin-filtered (`?chatId=` of the open conversation). Row: kind, label, progress. **Open** (and row click) switches to the child chat — does not dump a receipt into the parent transcript. Cancel stays.

Machine chats (`cron-*`, `subagent:*`) stay hidden from the default sidebar. Opening one pins it until you leave.

When the open conversation has an active turn, **Send injects**. Stop / Cancel remain separate.

### Work tab

New dock tab next to Workers. SSE `GET {bridge}/api/work/stream` with no `chatId` (already agent-wide). Rows: kind, label, origin, progress, Open (chat handles only), Cancel. Active by default; a short Recent slice so a just-finished run is still openable.

Deep link: `/home23/chat?work=<workId>` → Chat tab + Open that run.

## APIs

Reuse `/api/work`. Empty `chatId` already means this-agent-wide list + SSE.

New: `POST /api/work/:workId/inject`.

Live thinking/tools stay on `/api/chat/stream`. Open uses existing `openConversation` + `resumePendingTurns`.

## Tests

- Registry accepts `cron` + `cron_chat`; cancel still `stopChat`; boot interrupts leftover cron
- Inject: enqueue, 400/409, cap
- Loop: queued steer appears in the next iteration's messages
- Cron handler creates and terminals a work record
- Chat strip Open switches `chatConversationId`; machine chats stay hidden unless pinned
- Existing async-work + subagent-isolation tests still pass
