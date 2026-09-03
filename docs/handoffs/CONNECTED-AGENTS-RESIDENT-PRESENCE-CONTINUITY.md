# Lane handoff — Continuity Office

- Lane name and state: Lane 5 Continuity Office; needs integration
- Worktree: `/Users/jtr/_JTR23_/release/home23/.home23-worktrees/resident-presence-continuity`
- Branch: `codex/resident-presence-continuity`
- Base: `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`
- Current HEAD: `b743d7b2565a3292362c944f2afb5d1d9d170758` (implementation). This handoff is committed after that SHA on the same branch.
- Owned files: `src/coordination-adapter/continuity-office/**` and `tests/continuity-office/**` only. Did not edit `src/home.ts`, `src/channels/router.ts`, `src/work/**`, `src/coordination-adapter/index.ts`, or the contract pack.
- Current objective: isolated continuity-office adapter first slice — office boundary only, no cloud, no live DB, no second Jerry.

## Completed behavior and changed files

In-process isolated adapter `createIsolatedContinuityOffice`:

- Authenticated ingress with clientMessageId replay; unauthenticated requests store nothing.
- Office registry for headquarters + continuity-office with health and capability declarations. Continuity cannot declare `private_brain`, `household_credentials`, or `household_machinery`.
- Bounded continuity context: charter/relationship summaries, last 16 conversation turns, active Work, authority limits, freshness markers. Private-brain and household-credential exports are refused.
- Local-only work is `queued` and presented as `waiting for headquarters`; it cannot be completed by this office. Continuity-capable work may succeed here.
- Lease/epoch takeover and fencing: continuity cannot take the pen while headquarters is healthy; a stale epoch/fence cannot write; two offices cannot both hold canonical write.
- Deterministic headquarters-return stub: write authority returns to headquarters, continuity results deliver once via `work-result:${workId}` / `kind: "result"`, waiting work stays waiting.

Changed files:

- `src/coordination-adapter/continuity-office/adapter.ts`
- `src/coordination-adapter/continuity-office/constants.ts`
- `src/coordination-adapter/continuity-office/contract-map.ts`
- `src/coordination-adapter/continuity-office/errors.ts`
- `src/coordination-adapter/continuity-office/index.ts`
- `src/coordination-adapter/continuity-office/types.ts`
- `tests/continuity-office/*.test.ts`

## Verification

```bash
node --import tsx --test --test-concurrency=1 tests/continuity-office/*.test.ts
```

Result: 20 pass, 0 fail. Did not run full `npm test`. No process restart, live DB, release activation, cloud credential, or device install.

## Integration requests

Lane 3 owns shared schema. This lane mapped to current contracts and did not edit the pack. Please add or confirm:

1. `Attempt.officeId` (and optionally Work.officeId) so an Attempt names its office. Current `AttemptRecord` has holder/instance/authority/fencing only.
2. Client/Activity presentation `waiting for headquarters` without a new terminal Work state. This adapter keeps `Work.state = queued` and holds the phrase on a local presentation field.
3. `Attempt.contextRevision` and Attempt deadline (build plan: every Attempt names office, authority, lease, fencing token, deadline, and context revision).
4. Durable office registry (office id, role, health, capabilities) if clients must read it from canonical state.
5. Office-level canonical write epoch/writer distinct from capability `AuthorityEpoch` (`messages` / `attachments` / …). Dual-canonical-writer remains forbidden.
6. Ingress presentation `accepted by a continuity office` if Canary must show which office accepted the Message.

Do not treat this adapter as a second Message/Work/Attempt ledger. Integration should project through Lane 3 APIs.

## Unresolved risk or blocker

- Isolated only. Not wired into `home.ts`, the channel router, or Work execution.
- Lane 3 fixtures for office/waiting/epoch were not published at this baseline (`f3ad98dc`). The local mapper will need a follow-up if Lane 3 chooses a different field than `queued` + presentation.
- Authenticated ingress can accept while headquarters is still healthy; canonical write stays with headquarters. Integration may want the door closed or proxied when HQ holds the pen.
- No model runner and no cloud Attempt executor, per first-slice limits.

## Next concrete action

Coordinator: cherry-pick `b743d7b2565a3292362c944f2afb5d1d9d170758` (and this handoff commit) onto the Core integration branch after review. Do not wire live offices until Lane 3 answers the schema requests.

## Live action still prohibited

No process restart, live DB mutation, release activation, cloud credential or paid resource, private-brain export, or physical Canary install.
