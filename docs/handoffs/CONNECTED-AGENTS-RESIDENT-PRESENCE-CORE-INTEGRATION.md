# Lane handoff — Core integration

- Lane name and state: Core integration; in progress
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-core-integration`
- Branch: `codex/resident-presence-core-integration`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Owned files: integration branch only.
- Current objective: first convergence — message admitted and answered while Work remains active; one later result.

## Integrated so far

**Lane 1 (foreground)** — reviewed clean. Picked as `0e05fba5`, `e1163b29`, `fe025fa0`, `31137c78`. Focused admission / speaking / tool-policy / router tests 18/18 on this branch. Busy reply is gone. Detach refusal is honest (does not claim Work exists). HTTP speaking drain works. `onForegroundDetachRequired` still only logs until Lane 2 is picked and wired.

**Lane 3 (shared contract)** — pack SHA-256 `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`. 13/13.

**Lane 5 (continuity office)** — isolated, unwired. 24/24.

**Lane 2** — not picked; re-review pending. After pick: wire `onForegroundDetachRequired` to detach, and keep Attempt `writeStart` off the conversation `chatId`.

**Lane 4** — Canary must regenerate Apple fixtures against `2828398f…` after its review.

## Verification

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

Cherry-pick Lane 2 after re-review, then wire the detach hook on this branch.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical Canary install.
