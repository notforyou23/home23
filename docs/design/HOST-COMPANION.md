# Home23 Host

Home23 Host is a separate native Mac companion. It installs and supervises a
home; the existing Home23 app connects to that home for conversation, Work,
Library, and channels. The client keeps its current sandbox and app identity.
The Host is intended for direct distribution with its own identity. Its current
developer artifact is not a signed/notarized public release.

Current owner-upgrade decisions follow [Home23 continuity, updates and portability](HOME-UPDATES-AND-PORTABILITY.md).
Host and client are parts of one product. Host ownership, software version and
embedding provider are separate choices; Host does not require replacing an
established resident or its configured Ollama space.

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
The consumer Host package omits the standalone Evobrew app and its dependency
tree. Home23's resident chat/device/agency bridge remains part of Home23.
Source installations may still run Evobrew separately. When an older Host home
updates to a package without Evobrew, its Evobrew conversations, workspaces and
configuration remain as local state; the old process is stopped and not
restarted. Removing those saved files is a separate owner decision.

[Home updates and portability](HOME-UPDATES-AND-PORTABILITY.md) owns the current
continuity direction. The implemented lifecycle includes preview and staging,
explicit local installation, interruption recovery, encrypted backup and
restore/move. Preview, a staged payload and an installed release are distinct
states; none by itself establishes public publisher trust or a successful start.

Backup requires quiet owned writers and a held lifecycle lock. Move restores
and rebinds a destination and fences the source against duplicate startup.
Managed/source adoption is a separate adapter; it does not mean an arbitrary
existing directory can be overwritten or controlled in place by Host.

The companion invokes the bundled Node with `app/scripts/product/host.mjs`.
The protocol accepts one action and absolute operation paths. Its current action
and flag matrix is in `scripts/product/host.mjs`; the native caller is Apple
`Home23Host/HostCommand.swift`. Do not use early command snapshots as the current
dispatch contract. Native Host now supports bundled-package Check/preparation,
staged Install and recovery as well as local development feed workflows.
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

Current source supports OpenAI and Anthropic subscription sign-in through the
existing Home23 broker (`shared/home23-oauth.cjs` and dashboard oauth routes),
alongside API-key and local-model setup. The recorded isolated Anthropic trial
completed native consent and a persisted provider turn. Preserve those flows;
the early API/local-only package description is historical.

Native bundled-package Check/preparation and local install/recovery are now
implemented. Public publisher-hosted updates, consumer signing/notarization,
broader distribution, hosted homes and account connectors remain separate work.
Reuse existing evidence for its scope rather than interpreting this older
developer milestone as a mandate to repeat the first-owner journey.
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
independent Linux evidence. Those historical receipts do not establish public
signing, clean-machine acceptance or remote transport. Provider authorization
evidence is scoped to the recorded provider and installed trial above.
