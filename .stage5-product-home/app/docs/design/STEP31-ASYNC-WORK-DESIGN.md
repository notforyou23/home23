# Step 31 — Durable Async Work Contract

One durable contract for detached work — coding jobs (Step 29) and sub-agents in
this first slice — replacing closure-based delivery and the fake-`turnId` iOS
push. Detailed task-level plan: `docs/superpowers/plans/2026-08-06-durable-async-work.md`.

## The problem this closes

- Coding jobs were durable but pushed to iOS with `turnId: job.id` (`cj_…`),
  which the app adopted into durable cache and polled as a chat turn — wedging
  the conversation in a fake in-flight turn.
- Sub-agents had no run id, no durable record, no status/list/cancel surface,
  no restart recovery, and no iOS push. Delivery worked only through a captured
  closure; a harness restart silently lost the work.
- A coding job launched inside a sub-agent captured `requestedBy =
  "subagent:<parent>:<hex>"` and matched no delivery route: the result landed in
  the hidden sub-chat and no human was ever notified.

## The record (`home23.async-work.v1`)

`src/work/types.ts` — one file per record under `instances/<agent>/async-work/`
(atomic tmp+rename, same idiom as the coding job-store):

| Field | Meaning |
|---|---|
| `workId` | `aw_<base36 ts>_<4hex>` |
| `kind` | `coding` \| `subagent` (extensible: workers, cron later) |
| `agent` | owning HOME23_AGENT |
| `originChatId` | **ROOT** conversation — `resolveRootChatId` unwraps `subagent:` layers |
| `originTurnId` | launching turn when known |
| `parentWorkId` | set for nested work (sub-agent → coding job) |
| `label`, `status` | status: `queued\|running\|blocked\|completed\|failed\|cancelled\|interrupted` |
| `startedAt/updatedAt/finishedAt` | ISO timestamps |
| `progressSummary` | throttled (≥15s) note from `job_event` — milestones, not confetti |
| `resultHandle` | `{type:'coding_job', jobId}` \| `{type:'subagent_chat', chatId}` |
| `verification` | `none\|pending\|reviewed\|skipped` — honest values only; the harness attests a review *happened*, never that work is "correct" |
| `deliveredAt` | stamped once the receipt reached the origin; recovery re-delivers when absent |

Records are created at the **tool boundary** (`coding_run`, `coding_continue`,
`spawn_agent`) where origin context is real. `spawn_agent` threads its
`workId` into the sub-context as `parentWorkId`, so nested coding jobs link to
their parent work and resolve to the same root origin.

## Completion pipeline (`src/work/completion.ts`)

- **Failure interrupts immediately:** terminal non-success → compact receipt to
  origin history + at most one channel notification (Telegram for numeric,
  `async_work` APNs push for `ios_`/`mac_`), `verification: none`.
- **Success reports once:** completed coding work with a human origin → the
  evidence receipt lands in origin history (no push), then a **review turn**
  runs in an isolated `workreview:<workId>` chat (origin transcript stays clean
  of injected prompts; defers up to `reviewIdleTimeoutMs` while the origin has a
  live turn). The review's report is what reaches the human, with the single
  push. Review impossible → receipt becomes the notification, `verification: skipped`.
- Sub-agent successes deliver directly (review config-off for the kind).
- `deliveredAt` + an in-process in-flight guard make delivery exactly-once even
  when the live `job_finished` listener races boot reconciliation.

Config (`config/home.yaml.example`): `asyncWork.review.{coding,subagent}`,
`asyncWork.reviewIdleTimeoutMs`.

## Push contract (`src/push/types.ts`)

`AsyncWorkPushPayload`: `{aps, kind:'async_work', chatId, workId, status, agent}` —
**no `turnId` key exists**. Legacy chat pushes (`kind` absent) still carry real
`t_…` turn ids only. `ApnsPusher.notifyAsyncWork` mirrors `notifyTurnComplete`
semantics (device lookup by chatId, 410 invalidation, preview truncation).

## HTTP surface (bridge port, `src/routes/async-work.ts`)

Bearer (`timingSafeEqual`, same policy as `/api/device/*`):

```
GET  /api/work?chatId=&active=1&limit=     → { work: AsyncWorkRecord[] }
GET  /api/work/:workId                     → record
GET  /api/work/:workId/receipt             → { work, detail }   (coding: receipt + events tail; subagent: sub-chat tail)
POST /api/work/:workId/cancel              → 202 (terminal ⇒ 409); coding → bridge.cancelJob, subagent → agent.stop(subChat)
```

## Recovery

On boot (runs even with the acp bridge disabled), after `bridge.recover()`:
non-terminal `subagent` records → `interrupted` + notice to origin; non-terminal
`coding` records sync with the job store (finished-while-down → deliver the
receipt now); running jobs without records → backfilled with root-resolved
origin; any terminal record without `deliveredAt` → delivered late instead of
never.

## iOS (Home23 app repo)

- `Home23TurnIDPolicy.isServerTurnID` gates every pushed/cached turn id
  (`^t_[a-z0-9]+_[a-z0-9]+$`) at `OpenChatRoutePayload` parse AND at
  `ChatViewModel.checkpointInitialRouteIfNeeded` — a `cj_`/`aw_` id can no
  longer be adopted as a turn.
- `OpenAsyncWorkRoutePayload` (validated) routes `kind:"async_work"` pushes to
  the origin conversation with no turn adoption; `.home23AsyncWorkArrived`
  triggers work-list refresh.
- `AsyncWorkService` + `ActiveWorkStrip` (chat, above composer — NOT in the
  fixed-height sticky HUD) show active work with tap-through to a detail sheet
  with cancel.

## Retired

`src/acp/result-delivery.ts` + its tests (superseded by
`src/work/receipt-delivery.ts`); the intended-behavior test that asserted
subagent-origin coding results stay in the hidden sub-chat.
