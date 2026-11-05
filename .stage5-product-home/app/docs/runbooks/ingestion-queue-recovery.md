# Ingestion queue recovery and cutover

This runbook is intentionally stop-the-world for the feeder. Never run the
migration while an old engine process can rewrite `ingestion-pending.jsonl`.

## Preconditions

1. Stop the exact agent engine and verify no supervisor restarts it.
   Set `feeder.maintenanceMode: true` in that engine's effective configuration
   before any upgraded-engine verification. Maintenance mode initializes the
   durable queue but starts no watcher, scan, interval, startup flush, or
   shutdown flush.
2. Record the source queue byte count, line count, SHA-256, inode, and external
   backup SHA-256. The source and backup hashes must match.
3. Keep `ingestion-pending.jsonl` in place. The migration treats it as an
   immutable recovery source; it never truncates or rewrites it.
4. Deploy the durable-queue code before restarting an engine. Do not roll back
   to the full-rewrite implementation while the large queue is present.

## Inspect without writing

```bash
node scripts/migrate-ingestion-queue.cjs \
  --run-path /absolute/path/to/the/agent/run-directory \
  --max-records 100000
```

The default mode reports source inode, byte count, mtime, and SHA-256. It does
not create queue state.

## Build the compact journal

```bash
node scripts/migrate-ingestion-queue.cjs \
  --run-path /absolute/path/to/the/agent/run-directory \
  --max-records 100000 \
  --apply
```

The operation is resumable at file-generation boundaries. Re-running the same
command continues from `ingestion-queue/migration.json`. The immutable JSONL
remains the content store: migration writes only one relationship/identity
metadata transaction per file generation, never a second copy of chunk content.
Every transaction carries an item count and SHA-256, uses full-write loops and
`fsync`, and is quarantined from its begin marker after a crash, ENOSPC, short
write, malformed complete line, or checksum mismatch. The first pass projects
journal size and refuses to start without that space plus a 64 MiB reserve.

Do not remove the legacy source after this step. Verify:

- the command reports `complete: true`;
- source inode, bytes, and SHA-256 are unchanged;
- `ingestion-queue/status.json` reports the expected pending count and has a
  valid checksum (the COSMO feeder status endpoint reads this snapshot);
- `events.jsonl` is materially smaller than the legacy source;
- no `.tmp` or uncommitted journal tail remains.

## Runtime cutover

1. Start only the upgraded engine with `feeder.maintenanceMode: true`.
2. Confirm the authoritative queue count and manifest count. Verify logs state
   that maintenance mode disabled watchers, scans, timers, and flushes.
3. Stop the engine, set `feeder.maintenanceMode: false`, and restart only the
   upgraded engine. This second start is the explicit watcher/flush enable.
4. Run one batch and confirm the legacy source inode, bytes, and SHA-256 remain
   unchanged while `state.json` advances by a bounded number of bytes.
5. Restart once and confirm the next delivered chunk is after the durable ack.
6. Exercise one file upsert, one remove/reingest, one embedding failure/retry,
   and one clean shutdown.
7. Keep the external byte-identical backup until the queue drains and the brain
   save plus manifest receipt are independently verified.

## Recovery

- If startup finds an incomplete record, malformed complete line, checksum
  mismatch, or incomplete transaction, inspect
  `ingestion-queue/corrupt-tail.bin`; the journal is truncated only to its last
  committed boundary.
- If an ack write fails, do not delete state. The same batch token remains
  retryable and the prior durable cursor remains authoritative.
- If migration fails, leave the source untouched, restore disk headroom, and
  rerun `--apply`. Never substitute an empty queue.
- To abandon the compact migration before cutover, stop the engine and preserve
  the entire `ingestion-queue` directory for inspection. The unchanged JSONL
  source plus its external hash-matched backup remain the recovery authority.
