# Resident-requested product maintenance

The independent `home23-maintenance` service lets an authorized resident queue a restart, finish its requesting turn, and read a durable receipt afterward. It uses the launchd-owned product supervisor. This trusted local facility is not an OS security boundary against another process using the same account.

An independent operator installs the reviewed controller once:

```sh
node scripts/product/maintenance.mjs install "/absolute/product/Home" jerry forrest
```

Installation snapshots the controller under `runtime/maintenance/controllers/<sha256>/`, records it as a continuing service in the Host record, and starts only `home23-maintenance`. Normal Host Start/Stop and updates then include it. The local policy lists allowed residents. Disabling `runtime/maintenance/policy.json` prevents execution. The workspace PM2 shim stays read-only.

Residents use the installed product script:

```sh
node scripts/product/maintenance.mjs request "/absolute/product/Home" jerry "Reload owner-authorized settings"
node scripts/product/maintenance.mjs status "/absolute/product/Home" REQUEST_ID
```

The request returns immediately. Finish the requesting turn; do not poll inside work that the worker must wait to finish. Report `queued` or `waiting` until the record becomes terminal. `cancel HOME REQUEST_ID` cancels a request before execution.

Requests pin the installed package and exact harness registration. Duplicates join pending work. Requests wait at least 30 seconds, expire after one day, and each resident has a one-hour restart cooldown. The worker takes the home lifecycle and writer locks used by Start/update/adoption. It checks process ancestry and refuses unaligned registrations.

An authenticated bridge lease closes turn and scheduler admission before checking all active turns, async Work, coding jobs and scheduled jobs. Existing work continues. Busy residents regain normal admission while their request waits. A lost worker's lease expires after 60 seconds. After restart, success requires a different aligned PID and signed Home23 readiness. The request is the receipt. Lost restart responses, failed readiness and interrupted workers never replay a mutation automatically.

Scope is the currently installed resident harness only. Core, engines, Seed writers, source deployment, package selection, arbitrary shell commands and database restores are excluded. New software still uses the normal product updater with activation authority. A queued request or online worker is not a completed restart.
