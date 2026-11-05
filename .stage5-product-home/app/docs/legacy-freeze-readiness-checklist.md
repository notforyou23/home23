# Legacy Freeze Readiness Checklist

Date: 2026-04-17
Companion doc: [legacy-process-decision-matrix.md](./legacy-process-decision-matrix.md)

## Purpose

This is the execution-prep layer for legacy cleanup.

It answers one question:

`Can this process or family be frozen yet, safely?`

Not deleted.
Not migrated in theory.
Frozen safely, with a rollback path.

## Readiness States

- `Not ready`: freeze would be reckless right now
- `Blocked`: likely freezeable later, but a named blocker exists
- `Candidate`: almost ready, but still needs proof
- `Ready for controlled freeze`: can be frozen after snapshot + verification

## Freeze Gates

Every process family should pass these gates before a freeze:

1. `Snapshot gate`
   Required state, sessions, logs, manifests, and config are copied somewhere safe.
2. `Coverage gate`
   If it ingests or watches files, the replacement system covers those paths or the loss is intentional.
3. `Surface gate`
   If humans still use its UI/API, there is a replacement URL or an explicit decision to lose the surface.
4. `Behavior gate`
   If it triggers automation, you know what stops happening after freeze.
5. `Rollback gate`
   You know exactly how to unfreeze it if the freeze was premature.

## Family Checklist

### 1. `cosmo-ide-local`

**State:** `Ready for controlled freeze`

Why:
- PM2 record exists, but recorded path is missing.
- No live PID.
- No live listeners on `4410/4411`.
- Replacement exists for local brain browsing: Home23 Evobrew at `3415`.

Checklist:
- [ ] Save PM2 metadata for reference.
- [ ] Confirm nobody still depends on the old `4410/4411` URLs.
- [ ] If desired, remove stale PM2 record only after recording `pm2 describe cosmo-ide-local`.

Rollback:
- Would require rebuilding/recreating the missing project path anyway.
- This is metadata cleanup, not a live-service rollback.

### 2. Passive legacy dashboards

Processes:
- `althea-dashboard`
- `cosmo23-jtr-dash`
- `regina-jtr-dash`
- `regina-terrapin-dash`
- `regina-tile-dash`
- `cosmo23-knowledge`

**State:** `Candidate`

Why not ready yet:
- Technically these are easier than engines.
- But some may still be habitual front doors or bookmarked surfaces.

Replacement targets:
- Main dashboard: `http://localhost:5002/home23`
- Chat: `http://localhost:5002/home23/chat`
- Research engine: `http://localhost:43210`
- Research dashboard: `http://localhost:43244`
- Evobrew: `http://localhost:3415`

Checklist:
- [ ] List which of these URLs you still actually open.
- [ ] For each one, identify the Home23 replacement URL.
- [ ] Save any dashboard-only docs, exports, or local DBs.
- [ ] Confirm no active process links or reverse proxies still point users there.
- [ ] Freeze one dashboard at a time, never as a group first.

Rollback:
- `pm2 start` or `pm2 restart` of the single dashboard service.
- Since these are surfaces, rollback is usually quick if the underlying engine still exists.

### 3. Legacy MCP bridges

Processes:
- `regina-mcp`
- `cosmo23-mcp`

**State:** `Candidate`

Why:
- They are bridges, not primary state holders.
- `cosmo23-mcp` is already stopped.
- Home23 has its own MCP family on `5003` plus `home23-cosmo23`.

Checklist:
- [ ] Confirm nothing still calls `3510` or `4650`.
- [ ] Confirm equivalent workflows are available through Home23 surfaces.
- [ ] Save config and recent logs.

Rollback:
- Restart the single MCP process.

### 4. Stopped old engines and voice services

Processes:
- `regina-jtr`
- `regina-terrapin`
- `regina-voice`

**State:** `Blocked`

Why blocked:
- They are already stopped, but they are still archive-bearing lineages.
- Freeze is easy, but retirement is not safe until snapshot and merge intent are clear.

Snapshot targets:
- `/Users/jtr/_JTR23_/cosmo-home/runs/jtr`
- `/Users/jtr/_JTR23_/cosmo-home/runs/terrapin`
- `/Users/jtr/_JTR23_/cosmo-home/logs`

Checklist:
- [ ] Snapshot the run directories.
- [ ] Snapshot relevant logs.
- [ ] Decide whether jtr or Terrapin memory must be merged into Home23 first.
- [ ] Decide whether any old voice journal/history matters.

Rollback:
- Start the stopped process back from PM2 if still defined.

### 5. `cosmo23-jtr-feeder`

**State:** `Not ready`

This is the clearest immediate blocker in the whole legacy cleanup effort.

Why not ready:
- It still watches legacy sources that Home23 does not fully mirror.
- Freezing it now risks silent data loss or missed ingest.

Legacy watch coverage:
- `/Users/jtr/jtrbrain-feed`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory`

Current Home23 feeder coverage:
- `/Users/jtr/_JTR23_/cosmo-home_2.3/projects`
- `/Users/jtr/life/`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/sessions`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/reports`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/memory`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/cron`

Named blockers:
- `cosmo-home_2.3/workspace/memory` is not explicitly covered by Home23.
- `jtrbrain-feed` is not explicitly covered by Home23.
- `cosmo-home_2.3/workspace/memory/sessions` is not explicitly mirrored into Home23.

Checklist before freeze is even considered:
- [ ] Decide whether legacy `workspace/memory` daily/reflection files should continue feeding the future system.
- [ ] If yes, add explicit Home23 coverage for that path first.
- [ ] Decide whether `jtrbrain-feed` should still feed the future system.
- [ ] If yes, add it to Home23 feeder coverage first.
- [ ] Decide whether legacy `workspace/memory/sessions` still matters.
- [ ] If yes, add explicit Home23 coverage or migrate that content.
- [ ] Snapshot old feeder manifests and config.
- [ ] Run a verification test: drop one test file into each legacy-only path and confirm Home23 ingests it.

Freeze proof required:
- Home23 ingests all intentionally preserved feeder inputs.
- No legacy-only ingest path remains unaccounted for.

Rollback:
- Restart `cosmo23-jtr-feeder`.
- Re-run file-event test on the legacy paths.

### 6. `cosmo23-jtr`

**State:** `Not ready`

Why not ready:
- It is a live old engine, not just a dashboard.
- It can still spend tokens and grow legacy brain state.
- It is the main legacy brain lineage most likely to need a real merge.

State that matters:
- `/Users/jtr/_JTR23_/cosmo-home_2.3/runs/jtr`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/logs`

Existing merge reference:
- `docs/superpowers/specs/2026-04-11-brain-merge-design.md`
- `docs/superpowers/plans/2026-04-11-brain-merge.md`

Checklist before freeze is even considered:
- [ ] Decide whether this engine's memory is being merged into `home23-jerry`.
- [ ] Snapshot the full run and workspace.
- [ ] Decide whether old realtime/dashboard access is still needed during migration.
- [ ] Confirm feeder migration is solved first.
- [ ] Define a rollback and resume path before any stop.

Freeze proof required:
- Brain state safely backed up.
- Relevant memory already merged or intentionally archived.
- Legacy feeder no longer required.

Rollback:
- Restart `cosmo23-jtr` and its paired support surfaces.

### 7. Protected live 2.3 agents

Processes:
- `cosmo23-coz`
- `cosmo23-home`
- `cosmo23-edison`
- `cosmo23-tick`

**State:** `Not ready`

Why not ready:
- Memory explicitly says these are live agents you still use.
- They are not cleanup-first candidates.
- Each has independent runtime state and conversation/session data.

State that matters:
- `/Users/jtr/_JTR23_/cosmo-home_2.3/state-coz`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/state-home`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/state-edison`
- `/Users/jtr/_JTR23_/cosmo-home_2.3/state-tick`

Special note on `tick`:
- `state-tick` clearly contains durable market artifacts and reports, not just chat/session state.

Checklist before freeze is even discussed:
- [ ] Decide whether each agent is being preserved, merged, or retired.
- [ ] Snapshot each `state-*` directory separately.
- [ ] Confirm whether Telegram/user-facing access must stay uninterrupted.
- [ ] Define one future per agent:
  keep standalone, recreate as Home23-native agent, or archive.

Freeze proof required:
- Explicit per-agent decision.
- State snapshot complete.
- Replacement or retirement path defined.

Rollback:
- Restart the single affected agent.
- Preserve original `state-*` directories untouched.

### 8. OpenClaw automation glue

Processes:
- `coz-dashboard`
- `brain-agent`
- `coz-cortex`

**State:** `Blocked`

Why blocked:
- These are not just UIs.
- They encode old operational habits and automation pathways.
- `coz-cortex` in particular is a watcher/wake glue layer, not just a webpage.

Known behavior surfaces:
- `coz-dashboard` on `3500`
- `coz-cortex` on `9877`
- `brain-agent` spawns OpenClaw brain sessions

Checklist:
- [ ] Identify what still uses `coz-dashboard` as an operational front door.
- [ ] Identify whether `coz-cortex` still matters for wake/event delivery.
- [ ] Identify what workflows would disappear if `brain-agent` stops spawning sessions.
- [ ] Snapshot OpenClaw state, logs, and memory surfaces first.

Freeze proof required:
- Home23 or another retained system covers the behavior, not just the UI.

Rollback:
- Restart the single OpenClaw service.

### 9. Website stack, not core brain migration

Processes:
- `cosmo-studio`
- `cosmo-unified`

**State:** `Blocked`

Why blocked:
- These are public/product surfaces, not just internal legacy cruft.
- Home23 does not replace them.

Checklist:
- [ ] Treat website retirement as a separate decision track.
- [ ] Snapshot site config, content, and logs.
- [ ] Confirm whether public consumers still matter.

Rollback:
- Standard PM2 restart if a freeze was accidental.

## Best Next Actions

If you want the safest near-term progress, do these in order:

1. Prove or close the feeder gap for `cosmo23-jtr-feeder`.
2. Snapshot `cosmo-home_2.3/runs/jtr` and the `state-*` agent directories.
3. Mark which legacy dashboards you still personally use.
4. Clean up `cosmo-ide-local` only after saving its PM2 metadata.

## Recommended Next Work Packet

The next concrete work packet should be:

`Legacy feeder coverage audit`

Deliverables:
- exact list of feeder paths that still matter
- Home23 coverage yes/no for each one
- proposed additions to Home23 feeder config
- verification method for each path

That is the shortest path from planning to a genuinely safe first freeze.
