# Brain and PGS background reliability receipt — 2026-07-13

## Outcome

Agent-launched PGS is start-only and returns its durable operation ID without
holding the chat turn. Chat Stop and turn/transport aborts detach durable work;
only an exact operation cancel stops it. Direct Query remains attached. Status
and result inspection remain available through `brain_status`.

The xAI tool representation now keeps an object root while removing composition
keywords that the live xAI Responses validator rejects. The canonical Home23
tool schemas and executors remain strict, so invalid conditional combinations
still fail typed inside Home23 rather than preventing the provider request from
starting.

## Incident evidence and causes

- Jerry's affected chat persisted 95,662 redundant `brain_operation_active`
  status rows and grew to roughly 36 MiB while PGS remained attached.
- Provider activity was retained at frame cadence in worker/coordinator event
  paths, causing both visible chat noise and repeated bounded-journal rewrites.
- Chat Stop propagated `operator_stop` as durable cancellation instead of
  detaching the caller attachment.
- Agent PGS used the same blocking `query()` path as Direct Query.
- The eight-hour PGS execution deadline was below observed full-sweep time at
  the live graph scale.
- Live xAI rejected composed tool parameter schemas even after every union
  branch had an object type. Provider-specific schema normalization was needed
  at the xAI adapter boundary.

## Repair

- Added start-only `launchQuery()` and routed agent and research PGS through it.
- Durable operator-stop now detaches; short operations still cancel on abort.
- Coalesced visible chat status to material state/phase changes or ten-second
  intervals while every authenticated event still renews the in-memory lease.
- Coalesced provider activity in both worker implementations and the durable
  coordinator journal, while preserving semantically distinct start/progress
  markers.
- Added append windows to the bounded operation journal so compaction no longer
  rewrites the full retained file for every new event.
- Raised the default PGS server execution deadline to 24 hours.
- Exposed phase, provider activity, batch progress, and PGS session progress in
  operation status. Instructions distinguish `lastProviderActivityAt` liveness
  from `lastProgressAt` committed-batch progress.
- Corrected xAI-bound root union schemas and explicit open-object fields, then
  normalized the xAI representation to its accepted object-root subset. The
  strict canonical executor remains the final argument authority.
- Updated public, generated-agent, system-prompt, Step 16, reliability, durable
  PGS, and vendored-patch documentation.

## Verification

- TypeScript build: pass.
- Contract suite: 49 pass, 0 fail, 1 intentional skip.
- Agent/provider/brain/research focused suite: 84 pass, 0 fail.
- Worker/coordinator/store focused matrix: pass, including semantic activity
  coalescing, 24-hour PGS bound, and append-window compaction.
- Full isolated large-PGS acceptance: 100,000 nodes / 300,000 edges, pass in
  658,051 ms with durable proof retained.
- Exact isolated lifecycle acceptance: pass in 16,071 ms.
- Full receipt/smoke file after detached-client update: 79 pass, 0 fail.
- Live xAI acceptance through Forrest:
  - chat: `codex_brain_schema_acceptance_20260713_0312`
  - turn: `t_1783912221205_766f7e7f`
  - durable status operation: `brop_9PUQu7Sa62z4HEJOE77n9b37OkqAWler`
  - result: complete; `brain_status` executed; `sourceHealth=healthy`;
    `implementation=manifest-v1`; ANN fresh; 118,367 nodes / 456,885 edges.
- Post-rollout Jerry and Forrest nonterminal operation lists: zero.
- Post-rollout operation stores: Jerry 16 MiB; Forrest 576 KiB.
- Five existing Jerry PGS session databases remain intact and reusable, about
  2.18 GiB total. No session or brain data was deleted.

## Live rollout

Restarted only:

- `home23-cosmo23`
- `home23-jerry-dash`
- `home23-forrest-dash`
- `home23-jerry-harness`
- `home23-forrest-harness`

Jerry and Forrest engines were not restarted and retained PIDs 4431 and 34340.
All seven checked Home23 services were online after rollout; COSMO was
healthy-idle and both dashboard brain-operation readiness routes returned
`ready=true`.
