# Connected Agents — Durable Working Threads

**Status:** Isolated implementation approved; live activation and physical iPhone acceptance await explicit authorization, 2026-09-04  
**Authority:** jtr's correction to the ratified Regina Household Charter v2  
**Goal:** Keep Jerry and Forrest continuously available while substantial assignments continue as durable, inspectable Work threads.

## The distinction

- **Conversation** is the direct relationship with Jerry or Forrest.
- **Work thread** is one durable assignment owned by the accountable resident.
- **Activity** is the meaningful progress, thoughts, tools, artifacts, blockers, and outcomes inside that Work.
- **Attempt, worker, and subagent** are hidden execution hands. They are not separate residents and do not become top-level product threads.

Activity is not the Work thread. A transient response pulse is not the Work thread. A raw `aw_...` receipt is not the Work thread.

## Resident behavior

A fast, bounded conversational answer stays inline. An assignment becomes a durable Work thread before substantial execution when it can outlive a quick response because it waits, monitors, performs multiple substantial operations, or can proceed independently.

The resident acknowledges the handoff once and remains available. Nested work inherits the same canonical parent Work. Progress stays in Work and Activity. Only a question that genuinely requires jtr and the accountable resident's final verified result return to the originating Conversation.

## Product behavior

The originating Conversation has a persistent **Working** tray above the composer. It is driven by canonical Work, not by whether a speaking response is currently streaming. It survives subsequent messages, app closure, reconnect, and another device.

The **Work** tab lists independent active and recent Work threads. It must support several simultaneous Works from one resident or Conversation rather than projecting one activity row per Conversation.

Opening a Work thread shows:

- human title and originating assignment;
- accountable resident;
- truthful state and last meaningful update;
- one Thoughts disclosure;
- one Tools disclosure with independently expandable tools;
- meaningful progress, blockers, artifacts, and final result;
- only the actions the state truly permits. Stop is supported for active Working Threads; Retry and steering remain hidden until their execution paths are real.

The main transcript contains no tool receipts, attempt narration, interim subagent results, raw Work IDs, or periodic status messages. Completion creates one canonical final result Message and the Work remains inspectable as completed.

Residents do not call a `work_create` tool. They invoke one intended supported long tool; successful runtime interception creates the canonical Working Thread before exact execution begins. A refusal means the resident states the limitation and does not claim Work exists.

## Core projection

Canonical `wrk_...` Work is the Work-thread identity. The authenticated product projection is additive to the existing Work control contract:

```text
{
  id,
  channelId,
  conversationId,
  originMessageId,
  accountableResident: { principalId, residentBinding, displayName },
  kind,
  title,
  summary,
  state,
  cancelAvailable,
  retryAvailable,
  createdAt,
  updatedAt,
  terminalAt,
  retryOfWorkId,
  finalResultMessageId
}
```

The list is owner- and Channel-scoped, ordered active first and then by most recent update. Exact Work read and mutations remain backward compatible.

## Observed failure this replaces

On 2026-09-04, the first detached child for the FTI restoration assignment retained canonical parent Work `wrk_01a06d2e-c490-7c31-b87f-8b030e06e146`, then emitted an interim assistant Message into Chat. Its nested child lost both `parentWorkId` and `coordinationDestination`, timed out after 900000 ms, and had no delivery timestamp. Canary showed two status speeches with raw `aw_...` IDs instead of one durable Working thread.

## Acceptance

1. Start two substantial assignments from the same Jerry Conversation.
2. Jerry acknowledges each once and answers a new unrelated question while both continue.
3. Two persistent Working items appear above Chat and independently in Work.
4. Each opens to its own Activity; nested hands remain within the correct parent.
5. Closing/reopening Canary restores both from Core with no local-animation dependency.
6. A nested failure becomes truthful Work attention and never an unsolicited machinery Message.
7. Each successful Work posts one useful final result into the originating Conversation exactly once; replay does not duplicate it.
8. Jerry and Forrest follow the same contract. Production Home23 remains untouched until separately authorized.

## Current implementation surfaces

- Core branch/worktree: `codex/resident-presence-core-integration` in the Bertha resident-presence Core worktree.
- Canary branch/worktree: `codex/home23-next-current` in `apple-connected-agents-worktrees/home23-next-current`.
- Paired contract pack: `8d079f1bf5f9b27c6e7e320721b492941e7cc2b6dabefe3ec9e02aa10bed469d`.
- Active headquarters release remains `f3ad98dc190697dafeb5ab6894f01a2c70e02c91` until an explicit live activation.
- Core scoped verification: 178/178, including immutable resident deployment 11/11; contract suite 71 passed with 2 intentional skips; TypeScript build/typecheck and diff checks clean.
- Canary verification: focused Working Threads proofs 6/6; shared contract/runtime tests 116 XCTest plus 18 Swift Testing; unsigned iPhoneOS build succeeded; diff check clean.
- Independent implementation and final deployment-pattern reviews: approved for isolated integration with no Working Threads blocker.
- Retry and steering are intentionally unavailable; unsupported long-tool families and owner-message attachments fail closed rather than manufacturing Work.
- No PM2 restart, live database mutation, release activation, simulator, or device installation occurred during isolated implementation.
- The candidate closes a preflight deployment split: Jerry and Forrest's generated PM2 entries now execute `dist/home.js` from the same pointer-selected immutable release as the coordinator. The resolver refuses a release without that harness entry point. Non-resident harnesses continue to execute the normal Home23 build.

## Next authorized action

Only after jtr explicitly authorizes the live step: activate the reviewed Core build through the controlled release path, restart only the required Home23 processes, install the paired Canary build on jtr's iPhone, and run the acceptance journey above. Do not start unrelated continuity journeys or broaden the release.

### Verified preflight snapshot

- The live pointer still names release `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`; its pointer SHA-256 is `d8129edce5d54974716db13b8b8b658da577024a15ade7adea991dd8abab7d22`, with file mode 0600 and release-directory mode 0700.
- `home23-coordination`, `home23-coordination-edge`, `home23-jerry-harness`, and `home23-forrest-harness` were all online with zero PM2 restarts in the captured process records. Re-read their exact PIDs and the pointer hash immediately before any mutation; this snapshot is not permission to restart them.
- The current PM2 entries still run Jerry and Forrest from the live `dist/home.js`, and their retained runtime-root environment still names predecessor `ca78b60d125dc87d684ee71a793c82820affa105` even though the pointer now names `f3ad98dc190697dafeb5ab6894f01a2c70e02c91`. The runtime-root variable does not redirect imported code, and a plain restart does not refresh it. This is expected until the candidate pointer and generated ecosystem are changed together. A pointer-only activation is forbidden.
- The paired unsigned artifact is `apple-connected-agents-worktrees/home23-next-current/.DerivedData-Home23NextCurrent/Build/Products/Debug-iphoneos/Home23.app`, bundle `com.regina6.home23.canary`, version `1.10 (102)`. It is deliberately unsigned and therefore is not the install artifact.

### Controlled acceptance order

1. Re-run the Core and Canary contract/diff gates and prove both still carry pack `8d079f1bf5f9b27c6e7e320721b492941e7cc2b6dabefe3ec9e02aa10bed469d`.
2. Capture the active pointer, exact allow-listed process rows, current production and Canary bundle identities, and a closed database backup before mutation.
3. Materialize an immutable Core candidate containing the complete harness as well as the coordinator, complete dependency/native-module and SQLite probes, and prove in a closed-root generation that Jerry and Forrest resolve to that candidate's absolute `dist/home.js` while non-residents do not. Keep it inactive until those pass.
4. As one rollback-bounded cutover, atomically move the pointer and regenerate the main ecosystem from the reviewed candidate. Reload the coordinator **only** from the dedicated `instances/.house/coordination/ecosystem.config.cjs`; reload Jerry and Forrest harnesses **only** from the regenerated main ecosystem. Use exact `--only` targets with refreshed environment, never a bare named restart. Caddy edge configuration is unchanged: preserve its process and verify it still routes the new coordinator. Read back all three executable paths and working directories and require the coordinator plus both resident harnesses to name the exact immutable candidate before client installation. On any red gate, restore the predecessor pointer and ecosystem snapshot, then repeat those scoped reloads onto the predecessor.
5. Produce and deeply verify a development-signed build 102 for only `com.regina6.home23.canary`; install in place without uninstalling or touching `com.regina6.home23`.
6. Run only the eight-item Working Threads acceptance journey above. Record canonical Work, Activity, cancellation, exact-once result, relaunch, and production-preservation evidence. Do not infer acceptance from HTTP status, process presence, or the unsigned build.
