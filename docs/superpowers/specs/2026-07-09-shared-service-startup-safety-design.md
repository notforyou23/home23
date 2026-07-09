# Shared-Service Startup Safety Design

**Date:** 2026-07-09

**Status:** Written spec approved; ready for implementation

**Scope:** Home23 startup entry points for the shared `home23-evobrew`, `home23-cosmo23`, and `home23-screenlogic` PM2 services, plus the bounded live COSMO recovery procedure.

## Problem

`home23 start` currently handles each shared service with an independent check-then-start sequence:

1. read `pm2 jlist`;
2. decide whether a shared service is online;
3. run `pm2 start ecosystem.config.cjs --only <name>` when it is not.

That sequence is not atomic across processes. If two callers reach it together, both can observe the service as stopped and both can ask PM2 to start it. For a service with a fixed TCP port, one process can bind successfully while the other enters an `EADDRINUSE` restart loop. PM2 can then disagree with the real listener, leaving a healthy-but-untracked process and a failed managed record.

The July 9 COSMO incident demonstrated the failure mode after reboot: PM2 resurrected a saved `home23-cosmo23` record as stopped, two starts arrived concurrently, one process retained port `43210`, and PM2 marked the managed app errored after repeated bind failures.

## Goals

- Make shared-service startup safe when multiple `home23 start` callers overlap.
- Cover COSMO, Evobrew, and ScreenLogic through one reusable coordinator.
- Re-read PM2 state only after acquiring exclusive startup ownership.
- Start each missing shared service at most once per coordinated startup pass.
- Recover from a stale lock without requiring manual file deletion.
- Record enough local evidence to identify future startup callers and outcomes.
- Repair the current COSMO PM2/listener split without touching unrelated PM2 apps.
- Preserve the public-repo boundary: source, tests, and docs are tracked; machine-specific receipts and runtime state remain ignored.

## Non-Goals

- Replacing PM2 or the existing LaunchAgent resurrection mechanism.
- Building a new always-running supervisor daemon.
- Changing COSMO, Evobrew, or ScreenLogic application behavior.
- Restarting all Home23 processes or any non-Home23 PM2 process.
- Automatically killing an unknown port owner from normal CLI startup.
- Committing `dump.pm2`, `ecosystem.config.cjs`, `instances/`, logs, or other local runtime state.

## Architecture

Add a focused module at `cli/lib/shared-service-start.js`. It owns cross-process coordination, PM2 state refresh, sequential shared-service starts, stale-lock recovery, and local receipts. `cli/lib/pm2-commands.js` remains the command orchestrator and calls the module once after the requested agent processes have been started.

The implementation audit found additional ways to start COSMO that must share the same lock: the self-updater, the dashboard COSMO watchdog, the settings COSMO endpoint, and the public `pm2:start`/`pm2:restart` scripts. The unfiltered `home23 start` ecosystem launch also included shared services before lock acquisition. Those entry points route through the coordinator, while non-shared process starts use exact PM2 names and a sanitized environment.

The coordinator receives the three service definitions in deterministic order:

1. `home23-evobrew`
2. `home23-cosmo23`
3. `home23-screenlogic`

The coordinator acquires one lock for the entire shared-service pass. This prevents separate callers from interleaving PM2 reads and writes across different shared services.

## Lock Contract

The lock is a local runtime file outside Git, under `${TMPDIR:-/tmp}/home23/shared-service-start.lock`.

Acquisition uses atomic exclusive file creation. The file contains JSON with:

- schema identifier;
- owner PID;
- creation timestamp;
- caller command arguments;
- Home23 root.

If acquisition fails because the lock exists, the coordinator reads its metadata and checks the owner PID:

- live owner: wait with bounded condition polling, then retry;
- dead owner: remove the stale lock and retry;
- unreadable or invalid metadata: treat the lock as stale only after the maximum lock age;
- deadline exceeded while a live owner remains: fail without issuing PM2 mutations.

The owner releases the lock in a `finally` block. Release removes the lock only when its recorded owner PID still matches the current process, preventing one caller from deleting another caller's lock.

## Startup Data Flow

For each shared service, while holding the lock:

1. read a fresh `pm2 jlist`;
2. locate all PM2 records with the exact service name;
3. if exactly one record is online with a nonzero PID, record a no-op and continue;
4. if duplicate records exist, fail closed and record the duplicate state rather than guessing which record to delete;
5. otherwise invoke PM2 once from a sanitized environment:
   `pm2 start ecosystem.config.cjs --only <name> --update-env --silent`;
6. poll fresh PM2 state until one exact-name record is online with a nonzero PID or the startup deadline expires;
7. record the verified result before continuing to the next shared service.

The normal startup path does not kill port owners. Listener reconciliation is deliberately reserved for the explicit live-repair procedure because killing a process requires stronger identity and active-work checks than the generic CLI can safely infer.

## Evidence Receipt

Every coordinated pass appends one JSON object to the ignored local file `logs/shared-service-startup.jsonl`.

The receipt contains:

- schema identifier and timestamp;
- owner PID and caller arguments;
- lock wait and stale-lock recovery information;
- per-service PM2 state before the decision;
- action taken: `already-online`, `started`, or `failed`;
- explicit settings restart action: `restarted`;
- per-service PM2 state after the action;
- command error text when a start fails;
- overall success boolean.

Receipt-writing failure must not turn a successful startup into a failure. The coordinator prints one concise warning and returns the real startup result.

## Failure Handling

- PM2 list parsing failure: abort the pass before starting anything.
- Live lock owner past deadline: abort without PM2 mutation.
- Duplicate exact-name PM2 records: abort that service and the remaining pass; require explicit operator repair.
- PM2 start failure: record the failure, release the lock, and return a nonzero CLI outcome.
- Service never reaches online/nonzero-PID state: record timeout and fail.
- Stale lock owned by a dead PID: remove it, record recovery, and continue.
- Receipt write failure: warn but preserve the coordinator's actual success or failure.

## Live COSMO Repair

The current runtime repair is intentionally separate from normal CLI startup:

1. Back up `/Users/jtr/.pm2/dump.pm2` and its backup when present.
2. Re-read `/api/status` and require `activeRun=false` before terminating anything.
3. Confirm the listener PID command is the Home23 COSMO server from this checkout.
4. Terminate only the confirmed orphan listener.
5. Delete only the failed `home23-cosmo23` PM2 record.
6. Start only `home23-cosmo23` from the generated `ecosystem.config.cjs` with a sanitized environment.
7. Require all of the following before saving PM2 state:
   - PM2 reports one exact-name online record with a nonzero PID;
   - that PID owns TCP port `43210`;
   - `/api/status` returns success;
   - COSMO reports `lifecycle=idle` and `activeRun=false`;
   - every other intended PM2 app remains present and online.
8. Run `pm2 save` once.
9. Verify the saved dump contains the intended 15 app names and records COSMO online with the correct script path.
10. Write a machine-local recovery receipt under `instances/jerry/brain/evidence/pm2-recovery/`.

## Testing Strategy

Use Node's built-in test runner and temporary directories. Production behavior is exercised through dependency injection at process boundaries; lock acquisition and release use the real filesystem.

Required regression tests:

- two concurrent coordinator calls start each missing shared service exactly once;
- the waiting caller refreshes PM2 state after lock acquisition and performs no duplicate start;
- an already-online service is a no-op;
- a stale lock whose owner PID is dead is recovered;
- a live lock owner is never displaced;
- a start failure releases the lock;
- duplicate PM2 records fail closed;
- a startup timeout releases the lock and records failure;
- receipt data includes caller identity and per-service before/action/after state;
- receipt-writing failure does not hide a successful startup result.

The test must be observed failing before the implementation is added. After the focused test is green, run the existing CLI/unit suite, then the repository's build and contract checks because startup behavior is part of the installation contract.

## Documentation

Update `docs/ONBOARDING.md` to state that concurrent `home23 start` commands serialize shared-service startup and that operators should use exact-name PM2 commands for manual recovery. Do not document machine-specific PIDs or backup filenames.

## Verification and Completion

Completion requires all of the following:

- focused shared-service startup tests pass;
- existing relevant CLI and PM2 watchdog tests pass;
- `npm run build` passes;
- `npm test` passes;
- `npm run test:contracts` passes;
- `git diff --check` passes;
- live COSMO PM2 PID equals the listener PID on `43210`;
- the COSMO status route is healthy-idle;
- the saved PM2 dump contains the verified intended app set;
- the local recovery receipt exists;
- only the design, implementation, tests, and public documentation are committed;
- pre-existing user changes remain unstaged and untouched;
- the scoped portable commit is pushed to `origin/main` after verification.
