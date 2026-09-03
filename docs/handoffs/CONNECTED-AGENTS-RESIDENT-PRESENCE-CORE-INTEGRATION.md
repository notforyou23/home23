# Lane handoff — Core integration

- Lane name and state: Core integration; in progress
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-core-integration`
- Branch: `codex/resident-presence-core-integration`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Previous HEAD: `0076f774e7bb25ea57190066bbdaaefa08131a50`
- Owned files: integration branch only.
- Current objective: first convergence — message admitted and answered while Work remains active; one later result.

## Integrated so far

**Lane 1 (foreground)** — reviewed clean. Picked as `0e05fba5`…`31137c78`. 18/18 after the Lane 2 pick.

**Lane 2 (Work)** — reviewed clean (`22b2fe5d-0ed9-448a-82ff-31ff694a3d00`). Picked as `511c093f`, `99a4ea12`, `21866c45`, `233ef884`, `96967a59`, `80abaa21`. Focused Work / coding tests 70/70 on this branch before this join. Durable cancel survives a new path instance. Detached Attempt stays off the conversation run lock.

**Lane 3 (shared contract)** — pack SHA-256 `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`. 13/13.

**Lane 5 (continuity office)** — isolated, unwired. 24/24.

**Lane 4 (Canary)** — first-slice isolated proofs Approved (`1cfa30d8-6cf6-49ff-b86b-821cbe2f1ef3`). Consumes pack `2828398f…` at Canary `b8963271`. Pair with this branch after the detach-join commit. No device install.

## This join

Lane 1 `onForegroundDetachRequired` now calls Lane 2 `createDetachedAttemptPath.dispatch` through `src/work/foreground-detach.ts`. Lane 3 `messages.sendMessage` is the result port: `kind: "result"` and `workResultIdempotencyKey(workId)` (`work-result:${workId}`). Result Message ids are derived from the Work id (`msg_` + work uuid), the same pattern as direct-message — not minted as origin ids.

Fail-closed: if ports or `channelId` / `conversationId` / `originMessageId` / `principalId` / `targetPrincipalId` / `residentBinding` / `residentInstanceId` / `authorityReference` / `instruction` are missing, no Work is created and the refusal lists the missing facts. No `chn_` / `cnv_` / `msg_` / `bot_` / `user_` ids are minted for origin facts. Manifest watermarks are read from the seeded/live Channel; digests are hashes of the included message ids + instruction.

Attempt `runWithTurn` is only called with `attemptChatId` and `{ coordinationOrigin }`. `isRunning` stays speaking-only (`agent.isRunning`). `markActive` / `clear` track the Attempt chat locally and never mark the conversation `chatId`.

Live Lane 3 ports are constructed in `home.ts` only when `HOME23_COORDINATION_DB_PATH` is set and `openCoordinationDatabase` succeeds (same work/lease/message constructors as `composition.ts`). Exclusive-writer busy or missing Jerry bot facts leave ports null. Unit tests inject ports and never open the live DB.

`src/routes/chat-turn.ts` was not edited. Lane 5 was not wired. Lane 3 schema was not changed. No live restart, DB mutation, or device install.

## Verification

```bash
node --import tsx --test --test-concurrency=1 tests/work/*.test.ts tests/agent/tools/coding.test.ts
```

72 pass (previous 70 plus created-Work and missing-fact).

```bash
node --import tsx --test --test-concurrency=1 \
  tests/agent/foreground-admission.test.ts \
  tests/agent/foreground-work-view.test.ts \
  tests/agent/foreground-tool-policy.test.ts \
  tests/channels/router-foreground-admission.test.ts \
  tests/agent/foreground-speaking-lock.test.ts \
  tests/coordination-adapter/resident-adapter-foreground.test.ts \
  tests/work/foreground-detach.test.ts
```

20 pass (previous 18 plus the two detach-join cases).

## Next concrete action

Chat-turn 409: `src/routes/chat-turn.ts` still reports 409 from pending TurnStore rows on that `chatId`. Do **not** implement that on this commit. Coordinator owns that gate.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical Canary install.
