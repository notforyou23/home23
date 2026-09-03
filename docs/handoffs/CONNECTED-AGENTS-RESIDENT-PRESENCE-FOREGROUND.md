# Lane handoff — Resident Presence

- Lane name and state: Lane 1 Resident Presence; integrated
- Worktree (git toplevel): `/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-foreground`
- Live-checkout alias: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-foreground`
- Branch: `codex/resident-presence-foreground`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Current HEAD: `a8ccc1ecd482d6af3a1ec1a8b2db936c16a6138d`
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
- Lane 2: do not mark `router.markSpeakingActive` or `agent.isRunning(conversationChatId)` for a detached Attempt. Attempts must stay on the Work-scoped chat. `runWithTurn` still `writeStart`s a pending TurnStore envelope on the chatId it is given — keep Attempt `writeStart` off the conversation `chatId`.
- Lane 3: no schema change was required for this slice. If a canonical compact Work projection other than `WorkRegistry.list({ active: true, originChatId })` is the intended source, publish it; this lane reads the existing registry.
- Lane 4 / `src/routes/chat-turn.ts` (not owned): HTTP 409 is `TurnStore.pendingTurns(chatId)`, not `isRunning`. After this lane `isRunning` is speaking-only, but a coordination Work that `writeStart`s on the conversation chat still leaves a pending row and 409s Canary. Acknowledge-and-hold must get past pending TurnStore rows.

## Unresolved risk or blocker

`src/routes/chat-turn.ts` is outside this lane. Its 409 is pending TurnStore rows on that `chatId`; `isRunning` is only an `active` flag on that response. Isolated tests do not start a live model. Foreground `require_work` tools are refused until Lane 2 wires the detach sink; they do not silently run and must not be described as existing Work.

## Next concrete action

Stay recovered. This lane is already cherry-picked onto `codex/resident-presence-core-integration`. First-convergence closure (real UDS+AgentLoop proof, Canary app build) is owned by Core integration. Do not start journeys 2–4 from this lane.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical-device install.
