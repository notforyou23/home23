# Channel activity and navigation latency

Channel inspectors consume the same attributed communication events as direct chats. Foreground evidence requests are conversation-scoped; their pagination frontier must never advance the global evidence checkpoint. The phone merges that history with live events, offers tool inputs/results and an event timeline, and only serializes detailed event payloads after expansion. Provider-reported reasoning retains its provenance.

The Core event and communication repositories previously counted every retained event on each history page or stream poll. These synchronous SQLite scans delayed other HTTP work as the ledger grew. Migration 15 initializes one exact retention count and maintains it with insert/delete triggers in the event transaction. Both readers use that count alongside the existing sequence high-water mark and retention floor. Interior gaps, expired cursors and ahead-of-server cursors still require reset. Pruning and rollback preserve the count; this is not an estimated count or a time-based cache.

The migration is additive but advances the checksummed database schema. Activation requires the normal drained, consistent database backup and a verified candidate built on the running release. Older binaries reject the newer schema; after activation, prefer a forward repair and never restore a stale database over newer canonical writes.

The phone retains previously loaded channel snapshots and project documents within its current provider/session, paints those while refreshing, and requests channel metadata, messages and bot roster concurrently. Project saves still use the original revision comparison; refresh must preserve unsaved edits and must not overwrite a save that completed while the read was in flight. Main chat activity remains compact.

Verification covers schema migration/reopen, event replay and gaps, transaction rollback, conversation-scoped evidence admission and independent cursors, HTTP history, and iOS compilation. Device navigation timing and visible live activity require acceptance on the installed build; offline database timings are not device acceptance.
