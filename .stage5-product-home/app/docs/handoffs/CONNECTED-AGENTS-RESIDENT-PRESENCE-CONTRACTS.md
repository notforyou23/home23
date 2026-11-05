# Lane 3 — Canonical State and Coordination

- **State:** integrated
- **Worktree (git toplevel):** `/Volumes/Bertha - Data/JTR23-archives/disk-pressure-2026-08-30/home23-inactive/.home23-worktrees/resident-presence-contracts`
- **Live-checkout alias:** `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-contracts`
- **Branch:** `codex/resident-presence-contracts`
- **Base:** `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- **HEAD:** `e076c83572aa5dc0e24ce31d487759585d80fcb3`
- **Owned files:** `src/coordination/**`, migrations, public coordination APIs, canonical contracts, fixtures, matching tests
- **Objective:** Lock the first-slice shared state-transition contract so other lanes consume one Message / Work / Attempt / office / event authority.

## Completed behavior

Round-1 review fixes are in the pack. Other lanes must **not** consume digest `1a9e2e86…`. Consume this digest only:

- Pack digest: `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`

Fixtures and APIs:

- `resident-presence-admission-while-work` now includes `foregroundWork` `wrk_…d5` with `originMessageId` = admitted `msg_…c2`, Jerry as accountable resident, `roundId` null. Background Work `wrk_…d1` remains running after admission.
- `resident-presence-one-result`
- `resident-presence-cursor-reconnect`
- `resident-presence-projections` — calendar answer `msg_…c3` provenance is `wrk_…d5`. Activity keys match the live projector: progress `work:${observationId}:progress`, result completion `event:${eventId}:completion`.
- Helper: `workResultIdempotencyKey(workId)` → `work-result:${workId}`
- Registry: `scope.residentPresence` (`residents: ["jerry", "forrest"]`, first lived proof Jerry)

Existing APIs unchanged: `messages.sendMessage`, `work.create`, lease `stale_fence`, `EventSequenceCursor`.

## Changed files (round 1 fix)

- `src/coordination/contracts/v1/fixtures/resident-presence-admission-while-work.json`
- `src/coordination/contracts/v1/fixtures/resident-presence-projections.json`
- `src/coordination/contracts/v1/schema.json`
- `src/coordination/contracts/contract-pack.ts`
- `tests/coordination/contracts/resident-presence-invariants.test.ts`

## Verification

```bash
node --import tsx --test --test-concurrency=1 \
  tests/coordination/contracts/resident-presence-invariants.test.ts \
  tests/coordination/contracts/contract-pack.test.ts \
  tests/coordination/app/resident-presence-first-slice.test.ts
```

Result: 13/13 pass.

```bash
node --import tsx --test --test-concurrency=1 \
  tests/coordination/app/direct-message-e2e.test.ts \
  tests/coordination/app/channel-message.test.ts \
  tests/coordination/app/channel-admission-durability.test.ts
```

Result: 20/20 pass.

```bash
npm run test:coordination
```

Result: 534/538 pass. The four failures are pre-existing on this worktree path and are not pack-fixture regressions: capability object now includes `push: false` vs an older expected bag; two production UDS tests exceed the platform socket-path byte limit on the Bertha realpath; bootstrap apply requires a built `dist/` that this worktree does not have.

## Integration requests

- **Lane 1:** Admit with `provenance.workId = null`. Create background Work from the origin Message and `foregroundWork` from the admitted Message (`wrk_…d5` / `msg_…c2`). Do not invent another foreground Work id.
- **Lane 2:** Terminal background result uses `workResultIdempotencyKey(wrk_…d1)`.
- **Lane 4:** Regenerate Apple fixtures against `2828398f3e8a6edc6c75340a2aff07ce2a9cab983b680ad48497bb01b0a2aee8`. Use projector-shaped Activity keys. Do not consume `1a9e2e86…`.
- **Lane 5:** Existing lease fencing / `stale_fence` only.

## Unresolved risk

Conversation list summaries still carry a compact activity chip from the older `conversations` fixture. That chip is not Activity authority.

## Next concrete action

Stay recovered. Pack `2828398f…` is already on Core integration and Canary `b8963271`. First-convergence closure is owned by Core integration. Do not start journeys 2–4 from this lane.

## Prohibited live action

No process restart, live DB migration, release activation, cloud credentials, or device install.
