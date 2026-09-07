# Managed releases

A working checkout and an installed release can contain different source histories. On installations with `instances/.house/coordination/active-release.json`, the selected package owns Core and managed resident harness executables. The live installation owns configuration, resident identity, keys, conversations and canonical state. A Canary client can share that backend even when its app bundle and local storage are separate.

## Before changing anything

Run `npm run release:status` from the installation, or pass its absolute root after `--`. It reads the pointer, both saved launcher definitions and PM2, reporting only deployment fields. A nonzero exit means drift or an unreadable prerequisite. It does not establish behavioral readiness and never updates configuration or restarts processes. Recheck it immediately before a cutover; its observations are not a lock against other writers.

The generator selects the packaged `dist/home.js` for managed residents. An invalid pointer or missing harness fails closed. Ordinary unmanaged agents continue to use checkout `dist/home.js`. Editing the generator does not regenerate an existing ecosystem file.

`home23 update` (including `--check`) refuses managed installations before fetching, migrating, building or restarting. `npm run build` also refuses a managed live root, because other agents can still use checkout output. Direct compiler/PM2 invocations bypass these guards; they are not an alternative update procedure. Build in the isolated candidate instead.

## Prepare a candidate

Use a verified deployed package as baseline. A release ID that resembles a Git SHA need not be a commit, and dirty source worktrees need an explicit manifest. Preserve newer deployed behavior when merging older-checkout improvements.

`npm run release:prepare -- prepare /absolute/path/plan.json` accepts:

```json
{
  "baseline": "/absolute/path/verified-release",
  "source": "/absolute/path/working-checkout",
  "baseRef": "REVIEWED_COMMON_BASE_COMMIT",
  "files": ["src/agent/loop.ts", "tests/agent/context-loop.test.ts"],
  "output": "/absolute/path/new-candidate-directory"
}
```

The output must be new and outside both inputs. The helper inventories the baseline, copies it without hard links, captures the exact selected source/base/deployed bytes, and performs three-way text merges. It includes untracked files only when explicitly listed. It refuses protected installation paths, escaping symlinks and binary merge inputs, and checks for input drift. Review the baseline independently before preparation; a fresh fingerprint records what was supplied, not that it was the correct release. Verify that `baseRef` is a valid common base for the selected paths rather than assuming `HEAD` is one.

Conflicts leave the deployed candidate file intact, with conflicting inputs under `inputs/`. Resolve deliberately and save the rationale. A clean textual merge still needs semantic review: it can duplicate declarations, revive obsolete paths, lose caller wiring, or preserve stale tests. Inspect production entry points and both sets of regression tests. Do not resolve by choosing an entire older file merely because its tests pass.

The existing `scripts/verify-live-deployment-tree.mjs` serves Git-backed deployment-tree verification. This preparation helper complements it for packaged baselines that do not resolve to a commit; it does not replace canonical deployment or state-migration authority.

## Build and verify exact contents

Run `npm run build` in the candidate. The build includes runtime-read contract JSON assets that TypeScript does not copy from static imports. Check native modules against the intended Node runtime. Keep test logs and reports outside the package.

Use `npm run release:verify -- run /absolute/path/checks.json` with:

```json
{
  "preparation": "/absolute/path/new-candidate-directory",
  "receiptDir": "/absolute/path/new-verification-directory",
  "allowedChanges": ["src/agent/loop.ts", "tests/agent/context-loop.test.ts"],
  "checks": [
    {"command": "npm", "args": ["run", "test:harness"], "timeoutMs": 300000},
    {"command": "npm", "args": ["run", "test:context"], "timeoutMs": 120000}
  ]
}
```

List every reviewed non-generated change, including tests/docs/tooling. `dist/` is treated as build output, but it is included in the artifact fingerprint. Checks execute the specified commands without a shell in the candidate. They must use isolated state and scripted/local providers unless a separate live acceptance run is authorized. A timeout means failed verification; inspect any surviving test children before retrying.

Packaged candidates have no Git metadata. For the isolated brain acceptance tests, set `HOME23_TEST_PRIMARY_CHECKOUT` to the absolute path of the actual installation checkout when running `npm test`. The fixture launcher validates that Git root and excludes both it and the candidate from fixture storage. An invalid root fails closed. This setting establishes a protected path for offline tests; it does not grant live-service or deployment authority. The selected path is inherited only by the controlled test children and is included in their environment receipt validation.

The complete test command also exercises bundled standalone Cosmo source. If its dependencies are absent from the managed package, install the exact `cosmo23/package.json` and lockfile into a separate test directory with `npm ci --ignore-scripts`, then supply that directory's `node_modules` through `NODE_PATH` for those tests. Do not add a standalone server or its runtime state to the backend release merely to satisfy tests. Controlled brain fixture children discard inherited `NODE_PATH` and select their own known dependencies.

The helper rejects unreviewed paths, unresolved conflict markers and baseline drift. It records exit status, log hashes and the artifact digest before/after testing. Any failure or artifact mutation prevents a passing receipt. Every preparation conflict additionally requires a `resolutions` entry keyed by file path, containing the resolved file’s `sha256` and a nonempty `reason`. Changing the resolved file invalidates that review. Keep the detailed resolution rationale with the saved inputs.

`npm run release:verify -- check /absolute/path/verification.json` rechecks a passing receipt against current candidate contents and log hashes. These local receipts detect accidental drift; they are not signed attestations against an actor who can rewrite both code and receipts. A passing receipt always retains `activationReady:false`: build/test success does not authorize service changes or establish client acceptance.

For harness changes, cover context-window transitions, retained evidence, late corrections, cancellation, permissions, nested worker scope, cache accounting and provider failure handling. For Connected Agents integration, also cover asynchronous turn recovery, exact queued-message retries, signed resident transport, single final delivery, and conversation during Work across separate processes. Test the production runner, not only helper mocks. Client contract or persistence changes require the corresponding app checks and correct source lineage.

## Activation is a separate operation

Prepare a cutover plan for the exact verified package and installation. Preserve keys and canonical state outside the package. Specify the affected processes, admission fence and active-work handling, consistent DB backup and integrity checks, candidate launcher definitions, pointer update, readback, acceptance probes and recovery route. Use the existing coordination release preflight contracts where applicable.

Do not replay date-specific scripts from old handoffs. A PM2 restart may keep the old executable path, and an ecosystem restart can load a different one. Verify the pointer, saved definitions, actual executable/cwd and selected environment agree after activation. Signed resident readiness, ordinary message/retry behavior and actual client use are separate checks.

A previous package is not automatically a rollback plan. Prove compatibility with the current persisted schema and writes; otherwise plan a forward repair. Never restore a stale DB after new canonical writes merely to match older code. Do not update the app, engines, dashboards or unrelated services as incidental parts of a harness release.

## Tooling regression checks

`npm run test:managed-release` covers launcher selection, invalid managed state, native runtime requirements, preparation conflicts, source isolation, escaping paths, updater/build guards and stale/failed verification receipts. Machine-specific release IDs, device builds, credentials and cutover receipts belong in ignored local operator documents, not this portable guide.

### Rebinding stale PM2 registrations

`node scripts/release/rebind.mjs check PLAN.json` inspects a restart-phase
plan with `root`, selected `releaseId`, exact `expectedRunning` rows from
`status(root).processes.map(p => ({name:p.name,...p.running[0]}))`, and a new
`receipt` path. `execute` performs only the scoped restart phase after the
operator's cutover preparation, admission fence, active-work drain and DB
backup/integrity checks are complete. It does not choose or update a release.

Run it from an independent operator terminal. It refuses target-process
ancestry and nonterminal coding jobs, including detached coding children.
PM2 tree termination crosses process groups; detachment alone is not a safe
activation mechanism. Do not disable supervision to bypass this guard.

Existing PM2 registrations can retain `pm_exec_path` after ecosystem
start/restart. The helper deletes only each named managed registration and
starts it from the verified saved ecosystem definition. It never deletes
application data or invokes a blanket PM2 operation. Failure leaves a partial
receipt for forward recovery, with no automatic database rollback. The final
check calls the exported `status()` function and requires actual registered
executable, cwd and resident runtime to match, with online PIDs. Separately
verify OS process paths and resident behavioral readiness before acceptance.
