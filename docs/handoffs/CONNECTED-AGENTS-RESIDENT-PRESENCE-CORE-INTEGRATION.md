# Lane handoff — Core integration

- Lane name and state: Core integration; in progress
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-core-integration`
- Branch: `codex/resident-presence-core-integration`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Owned files: integration branch only.
- Current objective: first convergence — message admitted and answered while Work remains active; one later result.

## Integrated so far

**Lane 1 (foreground)** — reviewed clean. Picked as `0e05fba5`…`31137c78`. 18/18 after the Lane 2 pick.

**Lane 2 (Work)** — reviewed clean (`22b2fe5d-0ed9-448a-82ff-31ff694a3d00`). Picked as `511c093f`, `99a4ea12`, `21866c45`, `233ef884`, `96967a59`, `80abaa21`. Focused Work / coding tests 70/70 on this branch. Durable cancel survives a new path instance. Detached Attempt stays off the conversation run lock.

**Lane 3 (shared contract)** — pack SHA-256 `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`. 13/13.

**Lane 5 (continuity office)** — isolated, unwired. 24/24.

**Lane 4** — Canary review clean; fixture regen against `2828398f…` in flight.

## Not wired yet

`onForegroundDetachRequired` in `src/home.ts` still only logs. `createDetachedAttemptPath` is on this branch but not constructed from live Lane 3 ports. `ForegroundDetachRequest` currently carries `tool`, `reason`, `chatId`, `turnId` only — not `channelId` / `conversationId` / `originMessageId` / instruction. Do not mint those IDs. The next integration commit must use existing ToolContext / Lane 3 facts, keep Attempt `runWithTurn` / `writeStart` off the conversation `chatId`, and attach `CanonicalResultCommit` to `messages.sendMessage` with `work-result:${workId}`.

## Verification

```bash
node --import tsx --test --test-concurrency=1 tests/work/*.test.ts tests/agent/tools/coding.test.ts
```

70 pass.

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/foreground-admission.test.ts \
  tests/agent/foreground-work-view.test.ts \
  tests/agent/foreground-tool-policy.test.ts \
  tests/channels/router-foreground-admission.test.ts \
  tests/agent/foreground-speaking-lock.test.ts \
  tests/coordination-adapter/resident-adapter-foreground.test.ts
```

18 pass.

## Next concrete action

Wire Lane 1 `onForegroundDetachRequired` to Lane 2 `dispatch` on this branch, using existing Lane 3 work/lease/message ports. Do not invent canonical IDs.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical Canary install.
