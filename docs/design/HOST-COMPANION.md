# Home23 Host

Home23 Host is a separate native Mac companion. It installs and supervises a
home; the existing Home23 app connects to that home for conversation, Work,
Library, and channels. The client keeps its current sandbox and app identity.
The Host is intended for direct distribution with its own identity. Its current
developer artifact is not a signed/notarized public release.

The [product delivery agreement](PRODUCT-DELIVERY.md) owns the public website,
downloads, user journeys and delivery backlog. The website will present Host
and the Mac client together, link to iPhone TestFlight during beta and the App
Store after release, and provide documentation, examples and support. End users
should not need GitHub or Terminal.

The private web dashboard stays part of each home and can be used without the
Mac conversation app. It is the intended Windows client surface once secure
cross-device access and browser compatibility are delivered. Host currently
binds services to loopback; it does not yet provide a Windows host or a public
remote dashboard service. Open Dashboard and the home-specific browser handoff
are tracked alongside the existing Open Home23 native-client action.

## One home, the same substrate

The companion calls [the shared home creation operation](HOME-BIRTH.md). Owner
context, purpose, import folders, provider/model selection, the resident's
workspace and brain, canonical conversations, and actual Seed genesis all use
the existing implementation. Installation does not copy an operator's home.

The distribution payload contains a self-contained Node executable, compiled
Home23 source and contract assets, platform-matched dependencies, and a private
PM2 installation. A new owner does not need Git, npm, a compiler, or global PM2
to start the installed payload. Building the distribution remains a developer
operation. Optional tools and integrations still need their own dependencies.

## Ownership and lifecycle

The payload has `bin/`, `app/`, `tools/`, and `manifest.json`. The manifest
identifies source, platform, architecture, and file content. It detects damage;
it is not a publisher signature or a substitute for signing and notarization.

`installProductPayload({payloadPath, homeRoot})` installs into a new owned root.
It refuses to adopt an arbitrary directory or overwrite an existing home with
a different package. The installation receipt is `.home23-install.json`.
The initial runtime keeps its mutable configuration and `instances/` under
`app/`; upgrading that layout requires a separate state-preserving updater.
The source Git updater must refuse these installations.

[Home updates and portability](HOME-UPDATES-AND-PORTABILITY.md) defines the
replacement lifecycle: Check for Updates, compatible staged releases, consistent
checkpoints, durable activation/recovery and state-preserving home transfer.
It covers existing Host installations and adoption of managed/source homes.
The backend supports a read-only `preview --home ABS --payload ABS` and local
`stage --home ABS --payload ABS --staging ABS` for an explicit candidate.
Staging prepares a separate verified payload with an owned resumable claim.
Both commands still report `canInstall: false`; publisher trust stays
unverified. Preview's preservation plan and contract hashes do not by
themselves make an update safe.

`update --home ABS --payload ABS --staging ABS` is a separate local opt-in for
a schema-preserving Host v1 package replacement. It keeps the v1 path contract,
checks the stored coordination schema, and resumes from a journal outside
`app/`. It does not download a release, migrate data, or provide the native
Check for Updates screen. `check-update --home ABS --feed ABS` reads one local
unverified feed and reports unavailable, damaged, incompatible, current, or
available. A missing feed is not up to date. It does not download or install,
and `canInstall` stays false. `backup --home ABS --archive ABS --key ABS`
streams an encrypted archive only after the owned-writer inventory is quiet
and while it holds the host lifecycle lock. `backup-inspect` restores that
archive into an empty directory for inspection and does not start writers.
See [Home updates and portability](HOME-UPDATES-AND-PORTABILITY.md).

The companion invokes the bundled Node with `app/scripts/product/host.mjs`.
The protocol accepts one action and an absolute `--home` path; `install`,
`preview` and `stage` also accept `--payload`. Only `stage` and `update` accept
`--staging`. Only `check-update` accepts `--feed`.
Creation data arrives over stdin, including any credential,
so keys never appear in arguments, preferences, or returned receipts. Stdout is
one JSON result. Diagnostic progress goes to stderr.

Each home owns a private PM2 daemon, lifecycle lock, persisted port allocation,
and short Unix socket paths. Starting a home must not reuse the operator's
global PM2 daemon or inherited provider credentials. Start and stop operate on
explicitly owned process definitions. Stopping preserves the home and Seed.

Preparation, process admission, and functional readiness are separate states.
`ready` requires the actual local API and signed resident availability. It does
not assert that a provider has answered or an owner has accepted the interface.
The Host retains recovery information if installation or startup is interrupted.
Connecting the client reuses its existing pairing flow.

## Monitoring belongs to the installed home

Host's organ sentinel derives its residents, Seed state, engines and feed paths
from the submitted `runtime/ecosystem.config.json` process plan. Optional
services present only in the general generator output are not expected to run.
A home without a submitted plan reports inventory unavailable. It does not
borrow another home's resident roster or contact a developer's remote machine. A missing declared
process or unreadable chain remains a reported failure.

The initial Live Problems invariants monitor the Host's harness, dashboard and
engine endpoints. A new home does not implicitly own HealthKit, sauna/weather
hardware, a Codex login, a browser daemon, or a mature brain containing hundreds
of memories. The owner can add checks through Live Problems. For built-in
checks, `monitoring.liveProblems.seedIds` in the home's `config/home.yaml`
explicitly selects the desired IDs (an empty array selects none). This setting
changes default monitoring, not the resident's tools or authority. Existing
non-Host installations keep their current default invariants and remote probes.

## Evidence and remaining delivery work

`scripts/product/verify-install.mjs PAYLOAD NEW_OUTPUT_DIRECTORY` exercises the
installed artifact in an isolated directory. It launches real owned processes,
pairs a client, sends a canonical message, checks a persisted answer, then stops
and restarts the home to verify identity, Seed, session, and history continuity.
Its model and embedding endpoints are local fixtures. It retains a JSON receipt
and the stopped installation; this is not a clean-machine or real-provider test.

The September 9 developer milestone passed this installed conversation/restart
proof with a local model fixture. It did not exercise embedding inference or
establish clean-Mac, real-provider, Windows-browser or remote-device acceptance.

Distribution signing/notarization, a clean-Mac owner trial, automatic upgrades,
secure remote phone connection, hosted homes, and account connectors remain
delivery work. No package or test receipt should be described as proving those
steps. The initial Host form supports API-key and local-provider setup; existing
browser OAuth setup is not automatically an app-native OAuth flow.
Track those items and public website/download work in
[the delivery backlog](PRODUCT-DELIVERY.md#delivery-work-to-address).

New Host homes prepare a private owned ONNX embedding service automatically.
Host downloads and verifies pinned artifacts, retains genuine partial downloads,
warms inference before admitting writers, and supervises the encoder with the
home. Its endpoint and recipe identity are shared by document memory and Seed
contact encoding. New owners do not install Ollama for this function. Selecting
a local conversational model is a separate provider choice and dependency.

Existing homes retain their configured provider. During an embedding outage,
context retrieval can return keyword hits with degraded/incomplete evidence.
Its scan budget is cooperative; it does not forcibly interrupt operating-system
reads. Owned attention remains explicitly uncalibrated until measured rather
than borrowing another encoder's thresholds.

The [owned embedder integration plan](../superpowers/plans/2026-09-10-owned-embedder-host-integration.md)
records the implementation and separates new-home delivery from existing
residents' encoder transitions. The [candidate record](../superpowers/plans/2026-09-11-owned-embedder-candidate-status.md)
identifies integrated revisions and the distinct source, packaged-install and
independent Linux evidence. Developer verification does not establish public
signing, clean-machine acceptance, provider authorization, or remote transport.
