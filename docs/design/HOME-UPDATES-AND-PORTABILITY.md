# Home23 continuity, updates and portability

Current direction, September 22, 2026. This replaces the accumulated embedder,
product-completion and migration work orders. Old plans and receipts are evidence
for specific behavior, not instructions to repeat their next steps.

## One product, one continuing home

Home23 has one maintained backend source and one maintained Apple source. The
owner's live installation runs an older selected release; newer product packages
are built from the maintained source. These are releases and installation formats
of the same product, not two feature branches to maintain indefinitely.

Home23 is the conversation/client app. Home23 Host is its Mac companion for
running and managing a home. These may remain separate technical components,
but the owner wants one installation, one obvious Home23 entry point and one
coordinated update experience. Users must not assemble or independently maintain
them. Preserve the client sandbox and identities rather than merging executables
merely to get one product name. Test homes are fixtures, not product editions.

The goal is the owner's existing home using current Home23 software with convenient,
safe updates and portability. iPhone and iPad are the owner's primary clients;
Mac hosts the home and also has a client. Mobile/iPad daily use and ordinary home
update controls are central, not downstream or optional acceptance. Preserve residents, Seed history, brain, conversations,
channels/helpers, Work, Library, files, projects, credentials, integrations and
app identities. Family distribution follows. Website, public feed, notarization
and store release do not gate a private software upgrade.

## What was built

- Owned local ONNX embeddings, automatic model preparation, recipe provenance,
  resume/restart handling and degraded retrieval.
- Self-contained Host runtime, home lifecycle and native controls.
- Staged updates, independent recovery, software-unit switching instead of
  repeated file copying, and preservation of mutable state.
- Encrypted backup, inspection, restore/move and path rebinding.
- Host integration with Home23's existing Anthropic and OpenAI subscription
  sign-in alongside API keys and local models. Preserve these capabilities.
- Smaller consumer packages omitting standalone Evobrew and build-only baggage.
  The Home23 chat/device/agency bridge and saved state remain.
- A managed/source-to-product adoption adapter that assumes a separate product
  destination. It does not implement in-place Host control of the existing root.

These changes are locally integrated; packaged trials and focused checks exist.
They do not mean the owner's home was upgraded. The latest assembled package
predates later adoption fixes; rebuild only if the selected operation needs them.

## Three separate choices

| Choice | Changes | Does not require |
|---|---|---|
| Software upgrade | The reviewed Home23 release running the home | New residents, an encoder switch or relocation |
| Lifecycle/layout transition | Managed release tooling versus Host ownership of updates/recovery | Rebirth or an encoder switch |
| Embedding transition | How new/query vectors are calculated and compared | A second product or moving the home directory |

The source supports both historical Ollama and owned ONNX recipes. Fresh Host
creation selects owned embeddings. Adoption preserves the existing encoder
contract; Host supports `encoderRequired: false`. That field means the owned
sidecar is not required, not that the home lacks embeddings. Different provider
configurations do not imply different software products.

Embedding options:

1. **Keep existing Ollama nomic (recommended now).** Gain newer software and
   lifecycle improvements while preserving the established vector space and
   attention behavior. No history rebuild is needed for this choice.
2. **Make that same encoder easier to manage.** Host could provision/manage the
   exact historical runtime/model recipe. This is an optional future implementation,
   not a delivered feature. A familiar model name does not prove recipe identity.
3. **Choose owned ONNX later.** It is a different measured vector space and still
   has no calibrated semantic attention floor. A switch needs explicit handling
   of historical comparisons, new/query vectors and derived index rebuilds.
   Never rewrite the append-only Seed history or mix incompatible vectors.

Owned embeddings simplify setup for new owners. They are not a smarter chat
model, a new Seed, or a demonstrated memory improvement for the established home.
Chat-provider sign-in and embedding-provider choice are independent.

## Realistic routes for the established home

The managed installation combines software, mutable state and external-volume
references. Product Host expects `bin/`, `app/`, `tools/` and an owned installation
receipt. Installing a package over the old root is unsupported. This refusal
does not prevent a normal upgrade through the existing managed release mechanism.

The recommendation is to retain the home and Ollama configuration, prepare useful
software changes against its actual live baseline, and choose the smallest Host
transition separately. Do not automatically perform two deployments if one
chosen transition can deliver the same result with less disruption.

| Route | Benefit | Remaining work / limit |
|---|---|---|
| Managed software upgrade, existing state paths | Existing release mechanism; home layout stays put | Compatibility review and scoped release; native Host ownership remains separate |
| Host management retaining existing state locations | Desired low-disruption lifecycle result | Not implemented; establish whether existing path/supervisor contracts permit a small bridge before promising it |
| Copy/rebind into product layout | Reuses the implemented adoption adapter and product updater | Map lived state and external links, fence writers, preserve identity and reconnect endpoints; do not copy the whole checkout by default |

A whole-home relocation is not an approved inevitability. Do not keep expanding
the copy adapter just to satisfy its classifier while the lifecycle choice is
open. Unknown-path and symlink counts are inventory findings, not counts of
migration defects. Never discard files or follow external links blindly to make
that inventory pass. Keep original state and recovery material.

## Final consolidation sprint

The owner requests a fresh Codex session with a durable goal, a capable lead and
parallel implementation. Its finish line is one ordinary-user Home23 installation
and update experience, with iPhone/iPad as primary clients and a supported Mac
running the home behind the scenes. Carry the owner's existing home forward and
make the same product easy for a new person to install and pair. A separately
managed Host application is not an acceptable required daily user journey.
Supporting both Ollama and owned ONNX is configuration in that same release line, not separate editions.

The current ZIP contains Host and client but is not a coordinated app updater.
The current native Check compares the installed engine with the package inside
Host. Delivering compatible new Host and client executables, release discovery,
and an ordinary update interface across iPhone, iPad and Mac are still concrete
work. Do not call the goal complete by improving only that bundled-engine comparison.

1. Reconcile the current source and evidence once. Claude's Mac connection UI and
   later offline/window fixes are already integrated; extend them. Choose the
   smallest lifecycle route for the existing home from its actual paths and
   ownership contracts. A managed software-only upgrade is an interim step, not
   completion of the unified lifecycle goal.
2. Work in parallel on (a) existing-home continuity, (b) coherent install/release
   and app-plus-runtime updates, and (c) normal-user setup/update/connection UI
   with iPhone/iPad first. Use existing authenticated control paths and shared
   contracts; do not invent a second remote administration service.
   Assign exclusive file ownership and agree shared interfaces first. Keep heavy
   package copies/builds coordinated; do not serialize independent engineering.
3. Deliver one coherent installation route with compatible internal components,
   normal Check/Update/Resume controls reachable from the primary clients, a usable
   release channel and reconnection. iOS/iPadOS app delivery must use the supported
   Apple installation/update mechanism; a home update is not a way to replace an
   iOS binary. Coordinate the experience without claiming those are one executable.
   No developer feed/key pickers, package hashes or Terminal commands
   in the normal flow. Keep diagnostics available under Details. A private release
   channel suffices; a public website and store launch are separate later work.
4. Integrate and verify changed behavior using accepted receipts plus one bounded
   walkthrough of the newly connected delivery/UI path. Prepare one existing-home
   cutover/recovery operation. Preserve state, credentials, external references,
   client identities and the configured encoder; never run duplicate Seed writers.
5. Perform the concrete authorized cutover and owner-app installation. Confirm
   everyday chat, memory, Work/Library, and the shared home/update controls from
   iPhone and iPad, plus Mac connections. Mac-only success does not close the goal.
   A new owner must be able to install that same product on a supported Mac and
   pair the phone/tablet apps without a source checkout or developer tooling.
   Produce a concise release and recovery record, then close the goal when these outcomes are established.

Use the available goal tool once in the new session, without an invented token
budget. Keep the original objective across compaction; query goal state and the
short task record before resuming. Update one current record with lane owners,
completed evidence, concrete blockers and next actions. Do not create an endless
append-only progress transcript or a new recurring automation.

This document prepares the sprint; it is not live activation authority. Build and
integrate the concrete result before seeking any genuinely missing permission for
production changes, owner apps, publication/uploads or credentials. Do independent
work while waiting. Do not declare a private channel operational if only a
loopback development fixture exists. Do not make public marketing, hosted homes,
new platform ports or an encoder migration prerequisites for this sprint.

## Verification and agent rules

- Never start duplicate live instances of a Seed or create a replacement home
  to claim an upgrade. No silent loss of existing capabilities or state.
- Reuse accepted update/recovery, backup/move and provider-turn evidence for
  its actual scope. No repeated pilot install or broad campaign because a
  document, label or unrelated artifact hash changed.
- Every extra check must answer a concrete changed behavior or failure. A prepared
  Install plus restart should take a couple of minutes at most; slow updates are
  product defects. Do not turn all safety properties into mandatory reruns.
- Keep one short current task record. Archive superseded instructions and preserve
  receipts. Finished Cursor/Claude lanes stay finished; paused automation stays paused.
- Keep source, artifact and live status truthful without creating endless new
  acceptance work. After new work is accepted, never silently restore an older
  database just to match previous software.

[Archived implementation details](../archive/HOME-UPDATES-AND-PORTABILITY-before-continuity-reset-20260922.md)
remain available as history. Current command behavior lives in
`cli/lib/product-host.js`, `product-update.js`, `product-update-apply.js`,
`product-backup.js`, `product-payload.js`, `scripts/product/` and Apple `Home23Host/`.
See [managed releases](../reference/MANAGED-RELEASES.md) for the existing deployment
mechanism and [product delivery](PRODUCT-DELIVERY.md) for later distribution.
