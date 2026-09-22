# Home updates and portability

Status: engineering plan with backend preview, declared-state preservation
checks, contract comparison, local candidate staging, one schema-preserving
local apply/recovery path, a local unverified release-feed check, and an
encrypted backup that streams state, refuses while owned writers are running,
and can be inspected before any writer starts, September 21, 2026. Network
installation, publisher trust, native Check for Updates, Move Home, and
existing-owner adoption remain unimplemented.

Home23 must remain usable, recoverable and movable for its current owner even
if it is never distributed to anyone else. The same lifecycle must support a
new owner installing, using and updating an independent home. This work takes
priority over public website and download polish in [product delivery](PRODUCT-DELIVERY.md).

## Owner experience

Home23 Host provides **Check for Updates**, the installed version, available
version, relevant release notes and compatibility. Checking does not stop a
home, migrate data or download a runtime. An unavailable or unconfigured feed
must not be reported as up to date. Development and unsupported installations
must be identified honestly.

**Download and Install** verifies and stages the release while the current home
continues working. Before a disruptive step, Host shows whether work needs to
finish and the recovery checkpoint's readiness. The owner can defer. A busy
home must not be forcibly interrupted merely to meet an update timeout.

Host reports preparation, waiting for work, checkpointing, installation,
verification, completion and recovery as different states. It resumes an
interrupted operation from durable evidence. A stopped home remains stopped;
an update must preserve the owner's desired-running choice.

**Back Up Home** and **Move Home** preserve the home rather than create a new
resident. Restore verifies the archive and required runtime before permitting
writers to start. Missing external folders, services and credentials are
presented as reconnection work rather than silently omitted.

## Existing implementation to build on

| Surface | Current contract | Required extension |
|---|---|---|
| `cli/lib/product-payload.js` | Manifest hashes, platform checks, owned/resumable first install; a different package is refused | Authenticated releases, staging and update compatibility; preserve the existing refusal until an explicit upgrade path owns it |
| `cli/lib/product-host.js` | Private per-home lifecycle, exact process ownership, saved running intent | Maintenance admission, durable update state and package selection |
| `scripts/product/package.mjs` | Bundled Node, dependencies and source identified by a manifest | Versioned runtime/Host/client compatibility and migration metadata; signed distribution assembly |
| Apple `Home23Host/HostCommand.swift`, `HostModel.swift`, `Home23HostApp.swift` | Invokes the installed, verified runtime and renders lifecycle state | Update status, progress and recovery; command dispatch able to recover when the selected runtime cannot start |
| `scripts/release/` and [managed releases](../reference/MANAGED-RELEASES.md) | Preparation, verification, drain, DB backup and process-binding evidence | Reusable scoped primitives after review; existing operator commands are not a packaged-home updater |
| `cli/lib/update.js` | Source/Git updater; refuses both product and managed installations | Keep those boundaries; do not route the native update button through this command |

There are two adoption cases: an existing Host v1 installation, and an existing
managed/source installation whose services can execute from different roots.
Both need coverage. A new empty Host home alone cannot prove the current
owner's portability. The [September candidate](../superpowers/plans/2026-09-11-owned-embedder-candidate-status.md)
remains historical installed evidence, not update acceptance.

### Implemented preview

From the maintained backend source, inspect an explicit home and candidate:

```sh
node scripts/product/host.mjs preview --home /absolute/home --payload /absolute/candidate
```

`cli/lib/product-update.js` reads installation receipts and package manifests,
verifies declared package files, and returns current/candidate identities and
typed reasons for a same/different package, damaged inputs or unsupported layout
and platform. It bypasses Host status/readiness because those paths can refresh
authentication state. It does not call providers, manage processes or write
either input directory. It does not perform a backup inventory of resident
memory or workspaces.

`canInstall` is always `false`; publisher trust and state-migration compatibility
are explicitly unverified. A successful preview means the inspection returned,
not that an update can be applied. Managed/source markers identify an adoption
case; complete state inventory, schema compatibility and adoption remain work.
There is no native update button or release feed in this increment. Earlier
installed runtimes do not acquire this command until deliberately updated.

Preview also returns `preservation` and `compatibility` evidence. The shared
`PRODUCT_STATE_PATHS` table in `product-payload.js` retains the existing local
state allowances and labels installation receipts/launcher metadata for future
rebinding. All other declared roots are preserved. Inspection uses file metadata
only, stops at links and reports absent, linked, unreadable or wrong-type paths.
It does not enumerate brains, parse secrets, discover external references or
take a checkpoint; its scope is `declared_state_roots` and `complete` is false.

Contract comparison uses verified manifest entries for compiled coordination
migrations and the v1 contract pack. Each group reports `unchanged`, `changed`
or `unavailable`, fingerprints and changed paths. Both sides must contain the
group's required entry point and supporting assets before equality is reported.
No candidate JavaScript is imported. Equal hashes describe packaged assets,
not the home database's actual version, supported schema ranges, other state
formats or safe rollback. Those remain unverified; `canInstall` stays false.

### Implemented local staging

```sh
node scripts/product/host.mjs stage --home /absolute/home --payload /absolute/candidate --staging /absolute/stage
```

Staging copies an explicit local candidate into `stage/payload/`, separate from
the current home and original candidate. Its private adjacent
`stage.home23-stage.json` claim binds the home location, current package and
candidate identity. The existing installation lock guards claim creation,
copying and exact retry. Completed files must match the pinned manifest;
interrupted copying can resume with the same claim. Unknown/tampered stage
contents, overlapping or linked paths, changed bindings and competing writers
are refused. The package is verified again before `status: staged` is recorded.

Capacity preflight requires the remaining file bytes plus 64 MiB headroom on
the stage volume. This is not a reservation against concurrent disk use;
copy failures preserve the claim for retry. No home data is copied and no
installation receipt, release selection or running process is changed. This
is local preparation, not a publisher-authenticated download or an update.
`canInstall` remains `false` and publisher/migration checks remain unverified.

Source verification uses synthetic packages, CLI dispatch, directory-preservation
checks and a simulated copy interruption. It does not establish power-loss
recovery, a packaged Mac trial or the complete U2/U3 lifecycle.

### Implemented local schema-preserving apply

```sh
node scripts/product/host.mjs update --home /absolute/home --payload /absolute/candidate --staging /absolute/stage
node scripts/product/host.mjs update-resume --home /absolute/home
```

`update` is an explicit local opt-in. It stages through the existing command,
then applies only when the home is an owned Host v1 installation, package bytes
differ, coordination migration and contract assets are unchanged, and the stored
coordination database is exactly the supported schema. Other data versions,
unknown files, linked state, and external paths refuse before package files
change. Preview and stage still return `canInstall: false`. There is no
download, publisher signature, or trusted-release label. Manifest hashes remain
integrity checks.

The v1 layout stays in place: `bin/node`, `app/`, `tools/`, and the installation
receipt paths do not move. Mutable state stays on its existing real paths.
Immutable package files are replaced individually. `app/` is not swapped as a
directory, brains are not replaced with links, and birth is not called.

The journal, previous software, verified coordination snapshot, and recovery
controller live outside the home at `dirname(home)/.${basename}.home23-update/`.
The controller is a copy of Node plus the updater modules, so recovery does not
import the `app/` tree being replaced. Resume with `update-resume` or that
copied controller. A busy home returns wait/defer unless maintenance is
explicitly admitted; admission stops owned writers through the normal supervisor
stop and does not force-kill them. Desired running state is preserved: a
stopped home stays stopped. Before any candidate writer is admitted, quiesced
byte identity is checked again and software rollback is still possible. Admitting
a running home records that boundary before Start. After Start, checks use stable
identity — resident profile, canonical state, encoder recipe and coordination
schema — and may see lifecycle fields such as host phase and `startedAt` change.
Seed ledgers may grow by append. Living brain and log writes are not treated as
lost identity. A failed check after admission fences writers and is
recovery-required. It does
not restore previous software or the data snapshot. A rollback that happens
before admission, for a home that was meant to be running, starts the restored
software again.

Process-kill and resume coverage is not a power-loss proof. This path does not
migrate data, publish a feed, or move a home.

## Engineering contracts

### A home survives its software

Introduce an explicit installation layout contract separating immutable
versioned software from mutable home state. The existing v1 layout places
configuration and `instances/` under `app/`; it cannot be made updatable by
overwriting that directory or substituting a symlink. Current payload checks
deliberately reject unsafe directory ancestry.

First inventory every writer and path consumer. Reuse supported per-home roots
where available and add explicit resolution where absent. The allowed-extra-file
list in `product-payload.js` is not a complete backup inventory. A versioned
adapter must account for canonical databases, Seed events/checkpoints, brains,
resident/project workspaces, conversations, reports, attachments, configuration,
credentials and external data references. Unknown state blocks adoption until
classified. Rebuildable indexes and caches may be excluded only with recorded
reconstruction requirements and acceptable recovery behavior.

Preserve the home, resident and conversation identities and Seed lineage using
their existing authorities. Adoption and restore must not call home birth to
replace an existing resident. Keep the configured encoder and vector recipe;
updating software does not authorize re-embedding or rewriting Seed history.

### Release identity and compatibility

An authenticated release descriptor identifies its version/channel, exact
runtime package, platform/architecture, minimum OS, supported Host/client
protocols, accepted installation/data versions and declared migrations. A
release selects exact artifacts, never Git branch tip. Artifact hashes detect
damage; publisher authentication requires a separate trust root. Define key
rotation, revoked releases and downgrade behavior before network installation.

Host/runtime and native clients have separate delivery channels. The release
plan must coordinate their compatibility and explain a required client update
without breaking existing pairing or silently installing incompatible versions.
The development test feed must be explicitly isolated from production trust.

### One durable update owner

Use one home-scoped update transaction and journal with exclusive ownership.
The controller and recovery entry point must remain executable independently
of services and package files being replaced. Closing the UI, restarting Core
or losing power must not erase the operation's next action.

Stages are: check compatibility; download/verify/stage; acquire maintenance
admission; drain/checkpoint; prepare migrations; select/start candidate;
verify behavior; commit success. Each durable mutation has an idempotent replay
rule, old/new package identity and recovery boundary. Journal and selection
writes need crash durability, not only an in-memory flag or rename assumption.

Maintenance ownership must cover every home writer: Core, residents, Seed,
engines, ingestion, schedulers, helpers and delegated work. Existing canonical
Work and continuation ownership remain authoritative. External or non-resumable
work requires an explicit wait/defer outcome. Startup and login recovery must
respect maintenance ownership and must not admit a competing runner.

### Consistent checkpoints and honest recovery

Quiesce writes through supported lifecycle/checkpoint APIs, verify the resulting
state, and prove backup integrity before migration or cutover. Copying an active
SQLite file or a changing JSONL directory is not a consistent checkpoint. Disk
space checks cover staging, checkpointing, migration and retained recovery data.

Every migration declares readable/writable schema ranges, replay behavior and
its point of no return. Code rollback is allowed only while the previous code
can safely use the resulting state. Never automatically restore an older data
snapshot after new work has been accepted. Otherwise preserve the evidence and
use a declared forward-repair or explicit data-recovery path. Failed rollback
must be reported as recovery required, not as a completed update.

Success requires exact executable/cwd/package bindings plus relevant behavior:
same home and Seed, usable conversations/Work, ingestion/retrieval and client
connection. API availability or process-manager status alone is insufficient.
Keep the previous valid package and checkpoint until retention permits removal.

### Portable backup and transfer

Backups carry a versioned inventory, integrity checks and runtime/schema/encoder
requirements. Portable archives require authenticated encryption and an owner
recovery mechanism; restore cannot depend solely on the lost Mac's Keychain.
Credentials either transfer securely or have an explicit reconnection step.
Regenerate machine bindings such as ports, paths and login registration through
supported configuration, preserving logical identities. Device sessions and
outboxes need a defined retain/re-pair policy that prevents duplicate sends.

Normal Move Home fences and stops the source before destination activation,
records the ownership handoff and prevents source auto-start. A backup can be
restored for inspection without starting writers. Disaster recovery with an
unreachable source is a distinct operation: a local PID lock cannot prove that
another machine is stopped. Define cross-host fencing/activation authority and
the offline recovery policy before claiming duplicate-runner prevention.

## Implementation sequence and ownership

One lead owns backend/Apple integration and the existing private task record.
Contributions must return to that lead; the owner is not a message relay.

| Step | Owner and deliverable | Completion evidence |
|---|---|---|
| U1 — Inspect and plan | Backend: non-mutating layout/state inventory for Host v1 and managed/source homes; versioned release/compatibility contracts; update/adoption preview with typed reasons | Synthetic layouts prove missing/unknown state, incompatible releases and corrupt receipts are reported; no home writes, provider calls, process changes or Git updates |
| U2 — Prepare | Backend + packaging: explicit runtime/state path resolution, v1 adoption adapter, authenticated release verification and resumable staging; Apple: Check for Updates and accurate preview | Packaged fixture can check and stage a compatible exact release while its current home keeps working; invalid publisher/artifact and insufficient-space cases leave it intact |
| U3 — Apply and recover | Backend + Host: independent controller, maintenance admission, verified checkpoint, migration journal, cutover, behavior checks and recovery UI | Update the same isolated populated home between exact packages; interrupt each durable transition; preserve identities, canonical work and desired-running state |
| U4 — Back up and move | Backend + Apple: encrypted export/restore, credential/path handling and cross-host ownership handoff | Restore onto a different installation; verify canonical contents, same Seed and required reconnects; exercise source fencing and explicit disaster-recovery behavior |
| U5 — Adopt the existing owner home | Lead: inventory all mixed-runtime services and external dependencies, rehearse the adapter on protected copied state, then prepare exact cutover and recovery | Rehearsal uses disabled integrations and fenced writers; no external side effects or new Seed; actual owner-home transition requires its scoped activation authorization |
| U6 — Deliver | Apple + release: sign/notarize compatible artifacts, publish authenticated feed and finish first-owner instructions | A supported Mac installs and subsequently checks for and applies a release through the UI; private-beta and public-release evidence stay distinct |

The implemented preview and local staging are bounded parts of **U1/U2**.
Declared-state paths and coordination contract changes are now visible.
`update` adds the schema-preserving slice of **U3** for one owned Host v1
home: inventory, stored-schema refusal, a journal outside `app/`, and local
apply/recovery. Publisher trust, downloads, native Check for Updates,
backup/move, and adoption of an existing owner home are still unimplemented.
Preview and stage do not replace packages. `update` does not export private
state or claim a trusted release.

Verification follows these boundaries rather than accumulating unrelated suite
runs. Reuse the known home and receipts when valid; publish one result for each
exact artifact. Public distribution, live cutover and destructive recovery are
separate consequential operations, not side effects of development checks.

## Decisions to resolve during implementation

- U1/U2: exact layout and schema versions after the writer/path inventory;
  release trust root and feed format; native application updater integration.
- U3: supported migration classes and which update operations require downtime.
- U4: encrypted archive/recovery-key format, cross-host activation fencing and
  disaster-recovery policy, including the limitations of an unreachable source.
- U6: signing/publishing credentials and first supported OS/architectures.

Resolve routine implementation details in source. Bring consequential owner
choices back with a concrete proposal. Website polish, hosted homes, account
connectors and changes to an existing encoder are separate from this milestone.
