# Home23 product delivery

Agreed direction: September 9, 2026. This document owns the product's entry
points, distribution plan and remaining delivery work. Planned downloads,
browser access and hosted services are not claims of public availability.

For current owner work, [Home23 continuity, updates and portability](HOME-UPDATES-AND-PORTABILITY.md)
is the current direction. Software updates, Host adoption and encoder changes
are separate choices within one product. This distribution backlog does not
require a whole-home move or repeated pilot trials before useful owner upgrades.

## The same product, each person's own home

Home23 is shared software. Each home has its own owner context, residents,
purpose, credentials, documents, conversations, brain/workspace and Seed
lineage. Creating a home uses [the shared home birth operation](HOME-BIRTH.md);
it does not copy another person's resident or lived memory. Existing homes keep
their identity and data as the shared software develops.

The initial consumer hosting path is one visible Home23 Mac app with an embedded
[background home manager](HOST-COMPANION.md). The iPhone and iPad are the primary
clients; the Mac client and private dashboard connect to the same home. Closing
the conversation window does not stop the home; availability still depends on
the host being running, awake and reachable.
An explicit home-manager stop preserves the home and leaves it stopped.

## Where people get Home23

The public Home23 website is the front door for the whole product. End users
should not need GitHub, Git, npm or Terminal. Source installation remains an
option for developers and operators, documented separately in
[Onboarding](../ONBOARDING.md).

| Piece | Intended delivery | Status / boundary |
|---|---|---|
| Home23 for Mac | One signed, notarized app containing the client and background home manager | Combined source/assembly exists; release signing, notarization and verified distribution are still pending; a Mac App Store listing is not assumed |
| Home23 for iPhone and iPad | Supported private beta installation, then TestFlight when that channel is ready; App Store link after release approval | Universal client source and compiled build are not signed device delivery or owner acceptance; keep the existing installed identity and data |
| Private web dashboard | Served by the person's home; open in a browser, no separate client installation | Local dashboard exists; browser authentication, cross-device connection and supported-browser acceptance remain delivery work |
| Hosted home | Provisioned remotely for someone without a Mac | Later work; not available through this Host milestone |

The embedded helper and Mac client keep separate responsibilities and
permissions inside one app installation. The native client keeps its sandbox
and bundle identity. Installing a client does not create another home.
GitHub can host source and release infrastructure behind the website, but it is
not the ordinary user journey. No public domain, website repository, download
URL or new App Store identity is selected by this document.

## Getting started by situation

| Person's situation | Website and app journey |
|---|---|
| Wants a new home on a Mac | Get Home23 for Mac, create the resident in its guided home setup, connect a model provider, introduce context/documents, then use Home23 on Mac, iPhone or iPad |
| Already has a home | Get the Mac/iPhone client or open that home's dashboard, then connect to the existing home without repeating birth |
| Uses Windows | Use the private dashboard in a supported browser once secure access to the home is configured; initially the home still runs on a Mac |
| Has only Windows or an iPhone, with no Mac host | Explain the current host requirement clearly; hosted homes are a later option, not an available setup button |

Windows browser access is the initial Windows client strategy. It does not
require a Windows native app, and does not mean the Host runs on Windows.
Current packaged services bind to loopback: another device cannot use the
Mac's `localhost`. The guided iPhone/iPad connection flow can expose only the
home's coordination port through Tailscale Serve HTTPS, after checking for
conflicting routes and verifying the resulting address. Both devices join the
same tailnet and Home23 uses its existing pairing flow. Existing Caddy origins
stay intact. This source path still needs signed delivery and physical-device
acceptance; Windows browser support has its own browser/session acceptance.

The source/operator CLI has its own platform requirements. Do not use those
requirements as evidence that consumer Host packages ship on other platforms.
iPad and TV availability must be stated per released target rather than inferred
from source targets; the current universal iPhone/iPad build alone is not an
installed beta.

## Public website and private dashboard

The public website will provide:

- What Home23 is, how a home works, and practical examples of daily use.
- Get started, with the situation-based routes above and clear host requirements.
- One Mac app download and the actual available iPhone/iPad beta or store link.
- Documentation, searchable how-tos and walkthroughs: resident setup, model
  choice and costs, documents/memory, channels/helpers, Work, Library/Briefs,
  dashboards and supported integrations.
- Help for connection, stopped/asleep hosts, provider failures, interrupted
  setup, updates, backup and recovery; release notes and compatibility guidance.
- Clear information about where data lives, provider data access, permissions,
  connected accounts and support/feedback routes.

Downloads must show the real version, supported OS/architecture, channel and
requirements. Unavailable releases must say so instead of using placeholder
download buttons. Website examples use demonstration homes/data, not an
existing owner's private dashboard, credentials or conversation history.

The private dashboard remains a full way to use a person's home. It is not
replaced by the public website or reduced to a download page. Apps and dashboard
access the same home and residents; their current feature parity must be checked
rather than assumed. The Mac conversation client is optional for browser use.

The embedded manager implements **Open Dashboard**, using that home's actual
dashboard address, and **Open Home23** for the native client. Opening a URL is
not itself proof of remote browser connectivity.
The public site can explain how to open an existing home without knowing its
private address or storing credentials in a public link.

Local access, access from another device and access away from home are separate
delivery cases. Choose and implement the secure transport and authenticated web
session boundary across dashboard pages, APIs, streams and files; merely exposing
operator ports or adding TLS does not establish that boundary. Reconnect,
revocation, wrong-home selection and host-offline states need clear behavior.

## Historical developer milestones

The September 12 integrated Mac candidate joins the owned embedder with the
current backend, native Host, and Mac conversation client. It includes automatic
model preparation for new homes, encoder provenance, native semantic recovery,
and degraded keyword retrieval during embedding outages. Backend and native
builds and the affected contracts passed. The [candidate record](../superpowers/plans/2026-09-11-owned-embedder-candidate-status.md)
names the exact source/package identities and installed verification separately.
The independent Linux installation previously proved download/resume, owned
inference, document retrieval and restart continuity at its recorded revision.
Neither that Linux receipt nor a source build establishes a public Mac release.

The earlier September 9 developer milestone built a complete Mac Host/runtime package
and installed an independent home on the development Mac. Real owned services
reached readiness; a client paired and received a persisted model-fixture
answer. Stop/restart preserved home identity, Seed identity, pairing and history.
The test home was stopped afterward. Native app compilation and local ad-hoc
signature checks also passed.

That earlier trial establishes installed routing and continuity with a local model fixture.
It does not establish a clean-Mac install, paid-provider behavior, semantic
embedding inference, document ingestion quality, Windows browser compatibility,
remote connectivity, public distribution or physical owner acceptance. Private
artifact paths and operational receipts stay outside this public document.

## Delivery work to address

The delivery goal is a small Mac-hosted private beta used primarily from iPhone
and iPad. The immediate priority is the existing owner's continuing home on the
maintained software line, with one-product updates and portability. Keep the
existing encoder unless a separate transition is chosen. A whole-home copy is
one available adapter path,
not a prerequisite imposed by the embedding work. Reuse existing update and
portability evidence. Public website, notarization and first-owner distribution
do not gate the private daily-home upgrade. The
[continuity direction](HOME-UPDATES-AND-PORTABILITY.md) owns the current choices
and next work; the table below describes delivery capabilities, not rerun orders.
These are implementation and delivery items with observable completion criteria,
not a list of tests alone.

| ID | Work and responsibility | Done when |
|---|---|---|
| D01 | Website: choose the public domain/source/deployment and build the product, getting-started, download, docs/examples and support surfaces | A new person can select the right route and follow versioned instructions without GitHub or developer commands; links match actual published artifacts |
| D02 | Backend + Apple distribution: package the reviewed runtime and embedded manager inside one Mac app; sign/notarize in the correct integrity-manifest order | A verified release installs on a clean supported Mac without developer tooling or copied owner state; the client identity/sandbox and interruption recovery are preserved |
| D03 | Apple release: complete signed universal iPhone/iPad installation and physical acceptance, then prepare TestFlight and App Store records and real links | Both device families retain their installed identity/history and connect; a beta invite works before a beta link is published; a public store link appears only after release approval |
| D04 | Apple + website: reconcile minimum OS versions, supported architectures, download selection and compatibility | Host and client requirements are individually stated and tested; a source target or successful build is not marketed as a shipped platform |
| D05 | Backend + Host onboarding: complete real-provider setup including OpenAI and Anthropic subscription sign-in beside API keys and local models, optional dependency guidance, owned embeddings and document ingestion; remove feature-specific provider assumptions | A new owner can authorize a supported chat provider via the existing Home23 OAuth broker (Anthropic and OpenAI subscription sign-in), an API key, or a local model; bring in documents; retrieve useful memory; and understand costs/readiness without inheriting developer accounts; subscription, API-key and local setup remain distinct billing paths |
| D06 | Host + web: preserve delivered Open Dashboard/per-home URL handoff; finish missing-client installation guidance and scoped browser/remote behavior | A browser-only owner can enter and use the same home; Windows Edge/Chrome acceptance covers chat/streaming, reports, files and reconnect through the supported connection path |
| D07 | Backend + web + Apple: verify guided Tailscale HTTPS device connection with existing pairing, and finish authenticated browser/remote transport | iPhone/iPad connect to the intended home on physical devices without exposing operator routes; Windows browser, reconnect, revocation and offline-host behavior pass their own acceptance |
| D08 | Backend + Apple delivery: [Check for Updates, safe activation, backup/restore and portability](HOME-UPDATES-AND-PORTABILITY.md), including existing-home adoption | An upgrade or interrupted upgrade preserves the resident and history with a recovery receipt; a move preserves identity and enforces its declared cross-host ownership policy |
| D09 | Website + release: finish first-run progress, permissions/data explanations, troubleshooting, support and a documented end-to-end beta journey | A new owner can install, configure, converse, import, reconnect and recover using the released apps and docs; local fixtures and developer signatures are not the acceptance evidence |
| D10 | Later, connectors: app-native account authorization/import for Google and other selected services | Account scopes, data ingestion, refresh, revocation and deletion behavior are explicit and useful; connecting an account does not imply a hosting service exists |
| D11 | Later, hosting: provision and operate homes for people without a Mac | Shared home birth/continuity is retained with account isolation, credential handling, storage, recovery, service lifecycle and an agreed operating/cost model |

D05's embedding portion has a concrete
[Host integration plan](../superpowers/plans/2026-09-10-owned-embedder-host-integration.md).
It includes backend inference, model delivery, native setup/recovery, attention
and retrieval integration, and a separate existing-home continuity stage.
Owned embeddings remove an embedding-service credential requirement; they do not
complete chat-provider authorization. Subscription sign-in for OpenAI and
Anthropic is part of D05 completion beside API keys and local models. Host
first-home creation and reconnect must use the existing Home23 broker
(`shared/home23-oauth.cjs` and the dashboard oauth routes) for those flows—not
a second credential system. Current source integrates both sign-in flows into
Host creation; a recorded isolated Anthropic subscription turn succeeded.
Older API/local-only candidate descriptions are historical. Reuse the applicable
provider receipts rather than reopening sign-in engineering from those snapshots.
Completing the embedder does not make public delivery complete.

D01's structure/content can proceed alongside release engineering. Download
publication depends on D02–D04. Advertising Windows/remote access depends on
D06–D07. The private beta needs D01's initial download/docs path and D02–D09
to reach its stated supported scope; unfinished capabilities must remain
explicitly unavailable. D10–D11 are later
phases, not prerequisites for the Mac-hosted foundation.

Open implementation choices include the website's domain/source, signed Mac
download channel, supported release OS/architectures, browser transport, and
eventual provider/hosting commercial model. These choices should
be resolved in their corresponding work rather than silently assumed here.

## Related implementation and distribution references

- [Home birth and Seed continuity](HOME-BIRTH.md)
- [Host packaging and lifecycle](HOST-COMPANION.md)
- [Safe updates, recovery and home portability](HOME-UPDATES-AND-PORTABILITY.md)
- [Source/operator onboarding](../ONBOARDING.md)
- [Apple distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases/)
- [TestFlight invitations](https://testflight.apple.com/)

This agreement records direction and remaining work. It does not publish a site,
create a store listing, authorize a deployment or change any existing home.
