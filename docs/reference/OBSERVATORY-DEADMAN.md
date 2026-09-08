# Observatory deadman

`scripts/observatory-deadman.sh` remains the cron entry point (every five
minutes). It sets the established cron-safe PATH and PM2 override, then runs
`scripts/lib/observatory-deadman.mjs` with Node and the existing
`proper-lockfile` dependency. State belongs to the installation's ignored
`instances/.house/observatory-deadman/state.json`, resolved relative to the
script root or an explicit `HOME23_ROOT`. Keep that root stable across releases.

The watchdog requests `http://127.0.0.1:5050/healthz`, with a six-second timeout,
requiring HTTP 200 and `ok\n`. The observatory route does no Seed composition,
filesystem reads or remote probing. It certifies HTTP process responsiveness,
not the health of every organ or freshness of the sentinel's results. Existing
sentinel behavior remains in place. Synchronous work elsewhere in the same
observatory process can still delay the response.

Three consecutive failed cron checks open an incident (roughly 10–15 minutes
from outage onset at the normal cadence). One healthy check clears the failure
count. Each incident reserves one outage notification and at most one scoped
`pm2 restart home23-seed-observatory --update-env`. A 30-minute cooldown between
restart attempts survives recovery and also applies to failed restart commands.
A new incident during cooldown alerts once and defers its restart until a later
failed check reaches the cooldown boundary. An ongoing incident never repeats
its restart, even after cooldown. The next normal check verifies recovery; a
successful restart command alone is never called recovery.

An acknowledged outage gets one recovery notification on the first healthy
check. Healthy runs and transient failures produce no notifications. The outage
wording says **observatory monitoring is unavailable**. Recovery says the local
health check recovered. It does not certify organ health.

State updates use atomic rename under a heartbeat lock, with two-minute stale
lock recovery. Invalid state fails closed rather than erasing suppression.
Action reservations are saved before effects to prevent repeated attempts after
process interruption. Bridge tokens are read at use by PM2 app name, with the
existing Jerry/Forrest/Evobrew fallback. Only HTTP 200/201/204 count as accepted;
failed or ambiguous delivery is logged and never reported as successful.

This is one notification **attempt** per incident transition, not guaranteed
exactly-once transport delivery: the bridge provides no idempotency receipt here.
A timeout may hide an accepted send; a crash between reservation and send may
lose a notice. Recovery is sent only after a recorded accepted outage. There are
no automatic delivery retries because they could recreate duplicate pages.
Do not erase incident state as routine maintenance.

## Focused verification

From a checkout with dependencies installed:

```sh
node --test tests/scripts/observatory-deadman.test.mjs tests/scripts/observatory-health.test.mjs
bash -n scripts/observatory-deadman.sh
git diff --check
```

State-machine tests execute decisions only: no PM2 invocation, credential
lookup or notification send. Health tests use local ephemeral listeners and an
isolated real observatory with an empty temporary Seed directory. That child is
killed before its first sentinel tick, so it cannot run remote organ probes.

## Parent integration and activation

1. Recheck source authority, current maintained Git state, the active package,
   and the installed versions of both existing files. Reconcile newly changed
   bytes before cherry-picking this commit. The scoped reconciliation preserves
   the installed cron PATH/PM2 fix, app-name token resolution and HTTP acceptance
   checks; it does not reconcile unrelated backend source drift.
2. Integrate all five implementation/test files plus this document. Run the
   focused commands above in the integrated source and exact activation
   candidate. Preserve executable mode on the shell entry point. Confirm Node
   and `proper-lockfile` resolve under cron's environment.
3. Follow [Managed releases](MANAGED-RELEASES.md) for candidate preparation where
   applicable. Inspect the actual observatory PM2 executable/cwd and the cron
   script path; they may run from installation source rather than the selected
   backend package. Merely selecting a backend package will not necessarily
   update either. Preserve both previous files and the new helper for rollback.
4. With explicit activation authority, activate the observatory endpoint first,
   targeting only `home23-seed-observatory` if a restart is needed. Read back
   executable/cwd and confirm `curl -fsS --max-time 6
   http://127.0.0.1:5050/healthz` returns exactly `ok`. Check actual organ results
   separately. Do not switch the watchdog to `/healthz` before that endpoint is
   serving.
5. Activate the shell and helper together at the path cron actually invokes.
   Keep the existing cadence and stable installation state root. Observe normal
   healthy invocations under cron PATH: state has zero failures, no incident,
   no restart and no notification. Read the logs and state; do not infer success
   from PM2 online status alone.
6. Only with separate disruption/notification authority, exercise a controlled
   outage over three checks: verify one named restart, one accepted outage,
   cooldown across a subsequent incident, no repeated pages/restarts during a
   persistent incident, and one accepted recovery on a healthy check. Verify
   recipient delivery separately from the bridge HTTP acknowledgement. Preserve
   receipts and restore healthy operation. Offline tests do not establish this
   live completion.
