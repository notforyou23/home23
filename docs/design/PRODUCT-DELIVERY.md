# Home23 product delivery

Agreed direction: September 9, 2026. This document owns the product's entry
points, distribution plan and remaining delivery work. Planned downloads,
browser access and hosted services are not claims of public availability.

## The same product, each person's own home

Home23 is shared software. Each home has its own owner context, residents,
purpose, credentials, documents, conversations, brain/workspace and Seed
lineage. Creating a home uses [the shared home birth operation](HOME-BIRTH.md);
it does not copy another person's resident or lived memory. Existing homes keep
their identity and data as the shared software develops.

The initial consumer hosting path is a Mac running the separate
[Home23 Host companion](HOST-COMPANION.md). The Mac and iPhone apps and the web
dashboard connect to that home. Closing a conversation app does not stop the
home; availability still depends on the host being running, awake and reachable.
An explicit Host stop preserves the home and leaves it stopped.

## Where people get Home23

The public Home23 website is the front door for the whole product. End users
should not need GitHub, Git, npm or Terminal. Source installation remains an
option for developers and operators, documented separately in
[Onboarding](../ONBOARDING.md).

| Piece | Intended delivery | Status / boundary |
|---|---|---|
| Home23 Host for Mac | Signed, notarized download from the public website | Complete developer bundle exists; external distribution remains to be prepared |
| Home23 Mac app | Offered alongside Host through one coherent Mac setup path | Separate client; combined delivery and missing-client guidance need finishing; a Mac App Store listing is not assumed |
| Home23 iPhone app | TestFlight for the first private beta; App Store link after release approval | Prepare the appropriate beta/release record, build and verified link; current private device installation is not a public listing |
| Private web dashboard | Served by the person's home; open in a browser, no separate client installation | Local dashboard exists; browser authentication, cross-device connection and supported-browser acceptance remain delivery work |
| Hosted home | Provisioned remotely for someone without a Mac | Later work; not available through this Host milestone |

Host and the Mac client remain separate applications with separate responsibilities
and permissions even if presented in one download/setup experience. The native
client keeps its sandbox. Installing a client does not create another home.
GitHub can host source and release infrastructure behind the website, but it is
not the ordinary user journey. No public domain, website repository, download
URL or new App Store identity is selected by this document.

## Getting started by situation

| Person's situation | Website and app journey |
|---|---|
| Wants a new home on a Mac | Get Host (with the Mac client clearly offered), create the resident, connect a model provider, introduce context/documents, then open the app or dashboard |
| Already has a home | Get the Mac/iPhone client or open that home's dashboard, then connect to the existing home without repeating birth |
| Uses Windows | Use the private dashboard in a supported browser once secure access to the home is configured; initially the home still runs on a Mac |
| Has only Windows or an iPhone, with no Mac host | Explain the current host requirement clearly; hosted homes are a later option, not an available setup button |

Windows browser access is the initial Windows client strategy. It does not
require a Windows native app, and does not mean the Host runs on Windows.
Current packaged services bind to loopback: a Windows browser cannot reach a
Mac's `localhost`. A secure home-specific address and access flow must be
delivered and verified before advertising cross-device support. The same
connection work supports phones and access away from home.

The source/operator CLI has its own platform requirements. Do not use those
requirements as evidence that consumer Host packages ship on other platforms.
iPad/TV work can share the Apple foundation; their consumer availability must
be stated per released target rather than inferred from source targets.

## Public website and private dashboard

The public website will provide:

- What Home23 is, how a home works, and practical examples of daily use.
- Get started, with the situation-based routes above and clear host requirements.
- Downloads for Host and the Mac client, plus the current iPhone beta/store link.
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

The intended Host action is **Open Dashboard**, using that home's actual
dashboard address. **Open Home23** remains the native-client action. The current
Host implements the latter; the browser action and handoff still need work.
The public site can explain how to open an existing home without knowing its
private address or storing credentials in a public link.

Local access, access from another device and access away from home are separate
delivery cases. Choose and implement the secure transport and authenticated web
session boundary across dashboard pages, APIs, streams and files; merely exposing
operator ports or adding TLS does not establish that boundary. Reconnect,
revocation, wrong-home selection and host-offline states need clear behavior.

## Developer milestones and current candidate

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

The delivery goal is a small Mac-hosted private beta. Before that broader beta,
the immediate priority is to bring the current owner's Jerry and Forrest home
into the supported Host lifecycle without rebirth, lost history or an encoder
switch. Existing isolated update and portability evidence should be reused;
public website, notarization and first-owner release work do not gate this
private daily-home transition. The
[home updates and portability plan](HOME-UPDATES-AND-PORTABILITY.md) defines
Check for Updates, recovery, backup/transfer and the ordered D08 implementation.
These are implementation and delivery items with observable completion criteria,
not a list of tests alone.

| ID | Work and responsibility | Done when |
|---|---|---|
| D01 | Website: choose the public domain/source/deployment and build the product, getting-started, download, docs/examples and support surfaces | A new person can select the right route and follow versioned instructions without GitHub or developer commands; links match actual published artifacts |
| D02 | Backend + Apple distribution: narrow the developer source payload to reviewed runtime contents; sign/notarize the runtime and apps in the correct integrity-manifest order; assemble a coherent Host/Mac download | A signed release installs on a clean supported Mac without developer tooling or copied owner state; interruption/recovery is understandable |
| D03 | Apple release: prepare iPhone TestFlight, then App Store submission and real website links; settle distribution identities without disrupting existing installs | Beta invite installs and connects; public store link appears only after release approval; existing identity/data are preserved through any deliberate migration |
| D04 | Apple + website: reconcile minimum OS versions, supported architectures, download selection and compatibility | Host and client requirements are individually stated and tested; a source target or successful build is not marketed as a shipped platform |
| D05 | Backend + Host onboarding: complete real-provider setup including OpenAI and Anthropic subscription sign-in beside API keys and local models, optional dependency guidance, owned embeddings and document ingestion; remove feature-specific provider assumptions | A new owner can authorize a supported chat provider via the existing Home23 OAuth broker (Anthropic and OpenAI subscription sign-in), an API key, or a local model; bring in documents; retrieve useful memory; and understand costs/readiness without inheriting developer accounts; subscription, API-key and local setup remain distinct billing paths |
| D06 | Host + web: add Open Dashboard, actual per-home URL handoff and missing-Mac-client guidance; check dashboard parity and browser behavior | A browser-only owner can enter and use the same home; Windows Edge/Chrome acceptance covers chat/streaming, reports, files and reconnect through the supported connection path |
| D07 | Backend + web + Apple: deliver secure discovery/pairing and authenticated cross-device/remote transport | Phone and Windows can connect to the intended home, recover from interruptions, revoke access and handle an offline host; private operator routes remain protected |
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
a second credential system. Archive package
`72a996151605ab2580eb6060a62abdf762d3246f5502cff1c19cce73bfaa01a5`
(Apple `c4fdd5a`, backend `98aa10a0`) is API-key and local-provider setup only;
it is not a consumer release and does not prove subscription-capable Host birth.
Completing the embedder plan does not by itself complete D05's remaining
provider-authorization work or the other delivery items.

D01's structure/content can proceed alongside release engineering. Download
publication depends on D02–D04. Advertising Windows/remote access depends on
D06–D07. The private beta needs D01's initial download/docs path and D02–D09
to reach its stated supported scope; unfinished capabilities must remain
explicitly unavailable. D10–D11 are later
phases, not prerequisites for the Mac-hosted foundation.

Open implementation choices include the website's domain/source, Mac download
container and the updater details tracked in D08, supported release
OS/architectures, secure remote transport, and eventual provider/hosting
commercial model. These choices should
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
