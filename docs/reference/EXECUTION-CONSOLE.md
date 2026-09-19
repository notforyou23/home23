# Execution Console backend

The Console exposes retained coding-run output and Home23 subagent execution
journals through the authenticated House API. It uses the owner's normal House
session. It does not require an agent bridge token or start an agent when viewed.

The Apple interface owns presentation. Core owns the wire contract in
`src/coordination/contracts/v1`, including examples generated for Apple consumers.

## Read API

| Request | Result |
| --- | --- |
| `GET /api/v1/console/sources?state=active` | Source catalog, pagination cursor, discovery notices. `state=recent` includes retained terminal executions. |
| `GET /api/v1/console/sources/:sourceId` | `{source}` with identity, execution state, output availability, and action capabilities. |
| `GET /api/v1/console/sources/:sourceId/records` | Recent records, `beforeCursor`, `resumeCursor`, `hasMore`, and gaps. Pass `before` for older history. |
| `GET /api/v1/console/stream?sourceId=A&sourceId=B` | SSE for an explicit source selection. Use `scope=active` instead to discover active sources while connected. |
| `GET /api/v1/console/sources/:sourceId/records/:recordId/raw` | Exact retained bytes for a large or non-UTF-8 record. |

`sourceId`, harness `aw_` IDs, canonical `wrk_` IDs, coding-job IDs, and turn IDs
are distinct. Nullable links are not fabricated. A source can remain completed
after its output has been removed; `output.availability` conveys that difference.
Parent links describe verified execution parentage. A shared Work assignment
alone does not establish that one source spawned another.

### Records and replay

Records preserve their source format: `codex-jsonl`, `cursor-jsonl`,
`home23-turn`, or `text`. Decode known formats and retain a raw fallback. A missing
provider timestamp remains null. `observedAt` describes the reader's observation,
not the historical execution time. Order is preserved within each output stream;
cross-source delivery order is the order observed by that connection.

A record's `raw` field excludes the JSONL framing newline. `byteLength` counts the
original payload bytes. Large records use `raw: null` and an authenticated relative
`rawUrl`; fetch that URL from the same House origin with the same session. A
replaced or removed source cannot make an old raw URL serve unrelated bytes.

Inline records fit within 48 KiB after serialization. Clients should render a
bounded window and fetch older history or raw content as needed. Oversized raw
content does not require increasing the global Apple SSE parser limit.

SSE event names and JSON data:

| Event | Data |
| --- | --- |
| `source` | `{source, beforeCursor?, hasMore?}` |
| `record` | `{record}` |
| `checkpoint` | `{cursor}`; this event also sets the SSE `id`. |
| `gap` | A reason, with source/stream identity where applicable. |
| `end` | `{sourceId, status}`; `drained`, `incomplete`, or `unavailable` describes output disposition. |

Reconnect with `Last-Event-ID` from a complete checkpoint. A single-source
history page's `resumeCursor` can be passed as `after`. Conflicting cursor values
are rejected. Records since the last checkpoint can replay: deduplicate by record
ID. Do not advance a cursor from a partially processed SSE frame.

Completing one source does not close an active feed. A socket close is never a
completion receipt. Selected sources have resumable retained output; discovery
while disconnected is not a complete global execution audit. Capacity limits and
unknown discovery coverage produce notices rather than silently claiming full
coverage.

`lastOutputAt` advances for known execution output. Heartbeats, polling, and
provider liveness statuses are not output. `lastOutputAtBasis` distinguishes an
actual timestamp from approximate file modification time or observed appends.
Do not derive a historical command elapsed timer from a replay timestamp.

## Execution controls

Use advertised source actions. Requests use the House origin and normal session,
plus `Idempotency-Key`:

- `POST /api/v1/executions/:sourceId/cancel` with `expectedExecutionId`.
- `POST /api/v1/executions/:sourceId/steer` with `expectedExecutionId` and `text`.

Only the owning runtime acts on a verified exact job/turn. Coding sources do not
support steering. Whole-assignment cancellation remains the separate
`/api/v1/work/:workId/cancel` operation; it must not be substituted for stopping
one source.

`cancellation_requested` is admission, not a stopped receipt. Observe the source
until terminal settlement. Steering can be `queued`, `applied`, `not_applied`, or
`unknown`. Applied means inserted into the selected turn's durable model input;
it does not prove that the model followed the instruction. Retry an uncertain
request with the same idempotency key and exact target.

## Capture limits

Coding output is limited to what its CLI writes. Some CLIs publish shell results
only when a command finishes. The Console cannot reconstruct discarded output or
unreported nested-agent transcripts.

Home23 shell capture adds stdout/stderr chunks correlated with the turn and tool
call in a separate execution-output sidecar. It preserves existing shell guards,
timeout/cancellation, and the bounded result returned to the model. Capture queues
and retained storage are bounded. Missing capture-end receipts, dropped output,
and removed history must remain visible as incomplete evidence. A slow viewer
must not hold up command execution.

## Consumer fixtures

Generate, then check, the Apple fixture artifact from the reviewed backend source:

```sh
node --import tsx src/coordination/contracts/generate-apple-fixtures.ts --write /absolute/output/ConnectedAgentsCanonicalFixtures.swift
node --import tsx src/coordination/contracts/generate-apple-fixtures.ts --check /absolute/output/ConnectedAgentsCanonicalFixtures.swift
```

The seven `console-*` fixture files cover formats, sources, reconnects, limits,
and control receipts. `consoleOversizedRawFixture()` reconstructs the large raw
body without checking in repetitive output. Import generated Swift into the Apple
branch and explicitly handle its new pack digest alongside existing persisted
product data. Do not hand-edit the generated file or treat a fixture as a live
service receipt.

## Storage configuration

Core uses the configured resident instance resolver and the existing helper-bot
storage layout. If a resident process overrides its instance or conversation
directory through process-specific environment, provide Core the matching
`HOME23_COORDINATION_RESIDENT_<SLUG>_INSTANCE_DIR` and
`HOME23_COORDINATION_RESIDENT_<SLUG>_CONVERSATIONS_DIR` absolute paths. Core cannot
infer another process's private environment. These are backend configuration
values; clients never submit filesystem paths.
