# Lane handoff — Resident Presence

- Lane name and state: Lane 1 Resident Presence; needs integration
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-foreground`
- Branch: `codex/resident-presence-foreground`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Current HEAD: `b29ec36a3bb2ce262b7910544520c4aa04c67fe0`
- Owned files: `src/home.ts`, `src/channels/router.ts`, foreground behavior in `src/agent/**`, `src/coordination-adapter/**` outside Work completion
- Current objective: first-slice local foreground/background convergence — admit a Message and assemble a speaking turn while Work remains active

## Completed behavior and changed files

A user Message is durably accepted even when Work is active. The conversation busy reply is gone. Only an orderly speaking turn holds the conversation lock. Coordination / Work turns no longer set `isRunning(chatId)`.

- `src/agent/foreground-admission.ts` — admit/hold policy; speaking vs Work; `ForegroundTurnHeld`
- `src/agent/foreground-work-view.ts` — compact view from existing WorkRegistry + relationship ledger
- `src/agent/foreground-tool-policy.ts` — fast tools only; coding/spawn_agent/shell hand off; other long tools refuse with a detach hook
- `src/channels/router.ts` — speaking lock; park accepted Messages; hold regardless of `queueDuringRun`
- `src/home.ts` — removed `"I'm still working on something"`; speaking lock around the tracked turn
- `src/agent/loop.ts` — `isRunning` is speaking-only; every foreground turn gets the Work/commitment view
- `src/agent/tool-result.ts` — apply the foreground tool policy before execution
- `src/coordination-adapter/resident-adapter.ts` — `listActiveWorkIds()`; still keyed by `workId`, not resident
- Tests under `tests/agent/foreground-*.test.ts`, `tests/channels/router-foreground-admission.test.ts`, `tests/coordination-adapter/resident-adapter-foreground.test.ts`

Proved in isolated tests: stubbed Work W1 stays running; Message M2 is accepted; a foreground turn starts; no busy reply; a second speaking completion cannot start; coordination Work on the same `chatId` does not set `isRunning`.

## Verification

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/foreground-admission.test.ts \
  tests/agent/foreground-work-view.test.ts \
  tests/agent/foreground-tool-policy.test.ts \
  tests/channels/router-foreground-admission.test.ts \
  tests/agent/foreground-speaking-lock.test.ts \
  tests/coordination-adapter/resident-adapter-foreground.test.ts \
  tests/agent/tool-result.test.ts \
  tests/agent/tools/subagent-isolation.test.ts \
  tests/agent/chat-turn-janitor-timeout.test.ts \
  tests/coordination-adapter/resident-adapter.test.ts \
  tests/agent/turn-entrypoints.test.ts
```

Result: 99 passed, 0 failed.

## Integration requests

- Lane 2: sink `toolContext.onForegroundDetachRequired` into `createDetachedAttemptPath.dispatch` (or the equivalent public detach API) for `worker_run`, research launch/continue/compile, `generate_image` / `generate_music` / `tts` / `skills_run` / `cron_run` / `brain_synthesize` / `brain_query_export`. Do not execute those tools inside a speaking turn.
- Lane 2: conversation-foreground `spawn_agent` is forced to `detached` by the speaking-turn policy. Keep joined specialists on Work/coordination chats only.
- Lane 2: do not mark `router.markSpeakingActive` or `agent.isRunning(conversationChatId)` for a detached Attempt. Attempts must stay on the Work-scoped chat.
- Lane 3: no schema change was required for this slice. If a canonical compact Work projection other than `WorkRegistry.list({ active: true, originChatId })` is the intended source, publish it; this lane reads the existing registry.
- Lane 4 / `src/routes/chat-turn.ts` (not owned): HTTP turn start still 409s when `agent.isRunning(chatId)`. After this lane, that means speaking-only. Durable accept-while-speaking for Canary still needs that route to acknowledge and hold, not reject.

## Unresolved risk or blocker

`src/routes/chat-turn.ts` is outside this lane and still uses `isRunning` as a 409 gate. Isolated tests do not start a live model. Foreground `require_work` tools are refused until Lane 2 wires the detach sink; they do not silently run.

## Next concrete action

Integration: pair this speaking-lock admission with Lane 2's detached Attempt path so a live Jerry Work stays visible while Canary's next Message starts a new foreground turn.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical-device install.
