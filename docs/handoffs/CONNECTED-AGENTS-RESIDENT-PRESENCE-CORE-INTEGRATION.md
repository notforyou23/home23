# Lane handoff — Core integration

- Lane name and state: Core integration; in progress
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-core-integration`
- Branch: `codex/resident-presence-core-integration`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Current HEAD: after Lane 3 + Lane 5 picks (see log).
- Owned files: integration branch only. Do not edit lane worktrees from this branch.
- Current objective: first convergence — message admitted and answered while Work remains active; one later result.

## Integrated so far

**Lane 3 (shared contract)** — reviewed clean. Pack SHA-256:

`2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`

Picked as `7bae52a2`, `46f0ce5b`, `7902c277`, `edbce624`. Focused contract + first-slice tests 13/13 on this branch. Digest literal matches computed.

**Lane 5 (continuity office)** — reviewed clean, isolated, unwired. Picked earlier; 24/24.

**Lanes 1, 2, 4** — not picked. 1–2 are in re-review. 4 must regenerate Apple fixtures against `2828398f…` after its review.

## Verification

```bash
node --import tsx --test --test-concurrency=1 \
  tests/coordination/contracts/resident-presence-invariants.test.ts \
  tests/coordination/contracts/contract-pack.test.ts \
  tests/coordination/app/resident-presence-first-slice.test.ts
```

13 pass. `computeContractPackDigest()` equals the literal.

## Next concrete action

Cherry-pick Lanes 1 and 2 after their re-reviews. Then wire `onForegroundDetachRequired` to Lane 2 detach on this branch. Canary consumes `2828398f…`.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical Canary install.
