# Lane handoff — Work Execution and Return

- Lane name and state: Lane 2 Work Execution and Return; integrated
- Worktree (git toplevel): `/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-work`
- Live-checkout alias: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-work`
- Branch: `codex/resident-presence-work`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Current HEAD: `2fb78d42859b0634ce2a6efbed5431da3d9642df`
- Owned files: `src/work/**`; coding/subagent delivery paths required for detach + one-result return
- Current objective: first-slice local foreground/background convergence — long Work detaches and returns one result

## Completed behavior and changed files

Long assignments now have one `create Work → run Attempt → return result` path that does not occupy the conversation run lock.

- `src/work/detach.ts` — conversation vs Attempt chat identity; `mustDetachLongTool` for human chats
- `src/work/detached-attempt.ts` — calls Lane 3 `createWorkService` + `createLeaseService` (offer/accept/start/revoke/terminalize); runs the Attempt on `coordination:<channel>:<workId>` (Jerry branch) or `subagent:coordination:…` (delegated); completion uses existing `handleWorkCompletion` and `work-result:<workId>`; terminal Work replays; artifacts stay on the result Message; cancel revokes the lease and terminalizes as `cancelled`; persisted Lane 3 `cancelling` / `cancel_requested` is cancel authority across a new path instance
- `src/work/registry.ts` / `src/work/types.ts` — optional `office`, bounded `evidenceNotes` (Work-only; not transcript rows)
- `src/agent/tools/coding.ts` — conversation-foreground `coding_run` / `coding_continue` never wait; jobs stay detached
- Tests: `tests/work/detach.test.ts`, `tests/work/detached-attempt.test.ts`, registry evidence, coding conversation detach

Proved in isolated tests: a speaking-turn conversation lock is not marked by the Attempt; one canonical result Message; a second `dispatch` / restart replays the same Message without a new Attempt; artifact-only success still writes that Message; cancel terminalizes Lane 3 Work/Attempt as `cancelled`; a restarted path with empty maps does not succeed a Work that already revoked.

## Verification

```bash
node --import tsx --test --test-concurrency=1 tests/work/*.test.ts tests/agent/tools/coding.test.ts
```

Result: 70 passed, 0 failed.

## Integration requests

- Lane 1 (`src/home.ts`, `src/channels/router.ts`): call `createDetachedAttemptPath.dispatch` for long assignments. Do not keep `markRunActive(conversationChatId)` / `agent.isRunning(conversationChatId)` around the Attempt. Coding tools now return immediately on human chats, but the speaking turn still holds the conversation lock until Lane 1 ends that turn.
- Lane 1: inject the real conversation `ConversationRunLock` (`isRunning` / mark / clear) and the Attempt runner (`runWithTurn` on the detached chat id, never the conversation chat id).
- Lane 3: wire `CanonicalResultCommit` to `messages.sendMessage` with `kind: "result"` and `idempotencyKey: work-result:<workId>` (same key direct-message already uses). No new schema was required for this slice.
- Lane 3: harness Jerry-branch records still use `kind: "subagent"` so existing `coordinationCompletionCommit` validation accepts them. If a distinct canonical `childKind` / office field is wanted, add it in Lane 3; do not invent it here.
- No contract field was missing for first-slice detach + one-result return.

## Unresolved risk or blocker

The path is not wired from `home.ts` (Lane 1 owns that file). Isolated tests construct Work/Attempt via the public coordination APIs and a fake result-message sink. Deadline is recorded as Work evidence; lease TTL remains Lane 3's `createLeaseService` setting. Joined `spawn_agent` still waits inside the current turn (short foreground hand).

## Next concrete action

Stay recovered. This lane is already cherry-picked onto `codex/resident-presence-core-integration`. First-convergence closure is owned by Core integration. Do not start journeys 2–4 from this lane.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical-device install.
