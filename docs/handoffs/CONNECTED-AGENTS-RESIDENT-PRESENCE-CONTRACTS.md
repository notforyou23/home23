# Lane 3 — Canonical State and Coordination

- **State:** needs integration
- **Worktree:** `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-contracts`
- **Branch:** `codex/resident-presence-contracts`
- **Base:** `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- **HEAD:** `483f5e2699e1b34f690f80dc109a9ce245c54873` (implementation). This handoff commit follows.
- **Owned files:** `src/coordination/**`, migrations, public coordination APIs, canonical contracts, fixtures, matching tests
- **Objective:** Lock the first-slice shared state-transition contract so other lanes consume one Message / Work / Attempt / office / event authority.

## Completed behavior

The v1 contract pack now names the first convergence target without starting a v2 job system and without migrating a live database.

Other lanes must consume:

- Fixtures: `resident-presence-admission-while-work`, `resident-presence-one-result`, `resident-presence-cursor-reconnect`, `resident-presence-projections`
- Helper: `workResultIdempotencyKey(workId)` → `work-result:${workId}` from `src/coordination/contracts/resident-presence.ts`
- Registry: `scope.residentPresence` in `src/coordination/contracts/v1/registry.json`
- Pack digest: `1a9e2e866dc97360b1d966d65e51a14872356feeb2818dbfd328c8019c8982aa`
- Existing APIs: `messages.sendMessage` (admission independent of Work), `work.create` (one origin Message, one accountable resident, `roundId` null for direct resident Work), lease fencing / `stale_fence`, `EventSequenceCursor` (`apply` / `duplicate` / `reset`), Conversation messages vs Activity entries vs forensic/communication events

Direct and group result delivery now call the shared helper instead of inlining the key string.

## Changed files

- `src/coordination/contracts/resident-presence.ts`
- `src/coordination/contracts/v1/fixtures/resident-presence-*.json` (four fixtures)
- `src/coordination/contracts/v1/pack-manifest.json`
- `src/coordination/contracts/v1/schema.json`
- `src/coordination/contracts/v1/registry.json`
- `src/coordination/contracts/contract-pack.ts`
- `src/coordination/app/direct-message.ts`
- `src/coordination/app/channel-message.ts`
- `tests/coordination/contracts/resident-presence-invariants.test.ts`
- `tests/coordination/contracts/contract-pack.test.ts`
- `tests/coordination/app/resident-presence-first-slice.test.ts`

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

`npm run test:coordination` was not run (first-slice focused verification). Isolated temp DBs only.

## Integration requests

- **Lane 1:** Admit with `messages.sendMessage` and `provenance.workId = null`. Do not refuse because another Work is `running`. Create Work after the Message exists; link with `originMessageId`.
- **Lane 2:** Post the terminal Conversation row as `kind: "result"` using `workResultIdempotencyKey(workId)`. Retry/replay must return the same Message id.
- **Lane 4:** Consume the four new fixtures and regenerate Apple canonical fixtures against pack SHA-256 `1a9e2e866dc97360b1d966d65e51a14872356feeb2818dbfd328c8019c8982aa`. Do not invent a client-only lifecycle.
- **Lane 5:** Use the existing lease fencing token / `stale_fence` decision. Do not add a second Work or event authority.

## Unresolved risk

Conversation list summaries still carry a compact activity chip from the older `conversations` fixture. That chip is not Activity authority; the new projections fixture is.

## Next concrete action

Coordinator cherry-picks `483f5e2699e1b34f690f80dc109a9ce245c54873` (and this handoff commit) onto `codex/resident-presence-core-integration`. Lane 4 regenerates Apple fixtures from the new pack.

## Prohibited live action

No process restart, live DB migration, release activation, cloud credentials, or device install.
