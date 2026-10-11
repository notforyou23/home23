# Brain bloat fixes A–D

| Configuration | Defaults | Disable |
| --- | --- | --- |
| `osEngine.channels.persistence` | `enabled: true`, `maxBytes: 67108864` (64 MiB), `keep: 3` | `enabled: false` disables rotation; appends continue. |
| `agency.inboxPersistence` | Same rotation defaults | `enabled: false` disables rotation; appends continue. |
| `osEngine.crystallization.channelPolicy` | `enabled: true`, `deny: ['machine.*', 'neighbor.*', 'os.pm2']`, `liveProblemsStateChangesOnly: true`, `liveProblemsMaxEntries: 10000`, `liveProblemsHeartbeatMs: 1800000` (30 minutes) | `enabled: false` disables the policy; `deny: []` allows telemetry; `liveProblemsStateChangesOnly: false` disables problem dedupe; heartbeat `0` or `false` disables periodic writes. |
| `feeder.queueCompaction` | `enabled: true`, `minBytes: 67108864` (64 MiB), `archive: true` | `enabled: false` disables compaction; `archive: false` disables the optional gzip archive. |

Channel and inbox rotation compress the old active file into `.1.gz`, shift
older segments, and retain three segments by default. Rotation occurs within
the append sequence, including mixed synchronous/asynchronous inbox writes.
The archive contents and directory entry are synced before the active file
is truncated and synced, preserving archived lines through a machine crash.
An oversized existing file remains untouched until its next append.

The memory policy prevents telemetry from creating memory objects or receipts.
Live-problem persistence and memory ingest share per-process state dedupe by
problem key. State, remediation step, escalation, flag, and error changes are
retained; verifier timestamps and repeated check evidence are ignored.
Each dedupe cache retains at most 10,000 problem keys by default and evicts
the least recently observed key. An evicted key writes again on its next
observation. Unchanged observations persist again after 30 minutes by default.
The interval starts from the last successfully written observation's receive
time for the local live-problems producer, or write-start time for other sources.
The live-problems channel emits unchanged polls at the configured heartbeat;
producer and writer timestamps match even when a write is delayed.
Every observation still reaches in-process listeners.

Queue compaction runs after a durable acknowledgement only when the source
and journal are fully consumed and no pending or unresolved history remains.
It optionally archives `events.jsonl` to `events.jsonl.<timestamp>.gz`, then
uses a durable marker and atomic empty-journal replacement before saving the
zero event offset with the existing state checksum. Interrupted compaction
does not replay consumed items. Startup only reads compaction recovery state;
the next owning mutation finalizes it. No compaction starts at construction.

The constructors accept `persistence`, `channelPolicy`, and `compaction`
options directly. Rotation/policy examples live in `config/home.yaml.example`;
queue defaults live in `configs/base-engine.yaml`. Per-agent feeder overrides
merge queue settings and pass them through `DocumentFeeder`/`IngestionManifest`.
The pre-existing memory and agency ledger startup compactions remain enabled.
The startup restriction applies only to these new rotation/compaction features.
Seed, substrate, ledger, observation, and memory-object formats are unchanged.

Focused tests are registered as `npm run test:bloat`, also reached by the
default test script. The registration guard's pre-existing orphan
`tests/product-supervisor.test.mjs` is now registered in `test:runtime-regressions`.
