# Lane handoff — Core integration

- Lane name and state: Core integration; in progress (first-convergence closure)
- Worktree (git toplevel): `/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-core-integration`
- Live-checkout alias (same directory): `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-core-integration`
- Branch: `codex/resident-presence-core-integration`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- HEAD: record after the first-convergence closure commit on this branch (was `80025e606fbaa49f9acf6972a43755f40ad1c712` before that commit)
- Owned files: integration branch only.
- Current objective: first convergence — a second real Jerry turn while Work remains active; one later result. Do not expand into journeys 2–4. Do not install.

## Recover this lane

```bash
git -C "/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-core-integration" status --short --branch
git -C "/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-core-integration" rev-parse HEAD
```

Headquarters still points at the original release `f3ad98dc` (`instances/.house/coordination/active-release.json`). Nothing has touched live Jerry.

## Integrated so far

**Lane 1 (foreground)** — `a8ccc1ecd482d6af3a1ec1a8b2db936c16a6138d`. Picked as `0e05fba5`…`31137c78`. Speaking-only `isRunning`.

**Lane 2 (Work)** — `2fb78d42859b0634ce2a6efbed5431da3d9642df`. Detached Attempt on `coordination:<channel>:<workId>`.

**Lane 3 (shared contract)** — `e076c83572aa5dc0e24ce31d487759585d80fcb3`. Pack SHA-256 `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`.

**Lane 5 (continuity office)** — `16a97e1b9869f5688e1f45d2c41151fc748f6d98`. Isolated, **unwired**. Stay unwired.

**Lane 4 (Canary)** — first-slice isolated proofs Approved (`1cfa30d8-6cf6-49ff-b86b-821cbe2f1ef3`). Consumes pack `2828398f…` at Canary `b89632710883aed4adcf9eb4dbe3326f3904e0e0`. Pair with this branch after the closure commit. No device install.

## First-convergence closure (this pass)

1. `tsc --noEmit` is clean. Relationship-ledger typing in `foreground-work-view.ts` matches `RelationshipLedger.listEntries`. Detach missing-fields keep a `string[]` without widening through `Set`.
2. Successful speaking-turn detach is not an error. `tool-result.ts` omits `is_error` and reports `success: true` when `outcome.created === true`. Missing-fact refusals stay `is_error: true` / `success: false`.
3. Real isolated proof: `tests/coordination/app/resident-presence-real-runtime-second-turn.test.ts`.

   Canary-style `POST /api/v1/channels/:channelId/messages` → coordination DB → real `ResidentTurnUdsServer` → real `AgentLoop` → holding local-model stub → second HTTP message → second real provider call while W1 is held → W2 result first → W1 result once → replay stays one row.

   The earlier composed test with a fake `ResidentAgentPort` remains. It is not this proof.

`src/routes/chat-turn.ts` was not edited. Lane 5 was not wired. No live restart.

## Verification

```bash
npx tsc --noEmit
```

Exit 0.

```bash
node --import tsx --test --test-concurrency=1 tests/work/*.test.ts tests/agent/tools/coding.test.ts
```

72 pass.

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

20 pass.

```bash
node --import tsx --test --test-concurrency=1 --test-timeout=120000 \
  tests/coordination/app/resident-presence-second-turn-while-work.test.ts \
  tests/coordination/app/resident-presence-real-runtime-second-turn.test.ts
```

2/2 pass.

## Next concrete action

Build the complete Canary `Home23` iOS app from `resident-presence-canary` (not only `Home23Shared`). Then stop and ask jtr to authorize a lived install. Do **not** implement chat-turn 409 on this branch. Do **not** start journeys 2–4.

## Live action still prohibited

No live restart, DB mutation, release activation, cloud credential, or physical Canary install.
