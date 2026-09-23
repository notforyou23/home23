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
running and managing a home. They are deliberately separate applications within
one product. Test homes are independent fixtures, never replacements for the
owner's residents or additional supported product editions.

The goal is the owner's existing home using current Home23 software with convenient,
safe updates and portability. Preserve residents, Seed history, brain, conversations,
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

## Next work

1. Produce one concise comparison for the actual running home: selected software,
   state paths that stay or move, active external references, process ownership,
   auth continuity and client endpoints. Reuse the existing inventory; investigate
   only unresolved active dependencies. Identify the smallest route to Host updates.
2. Resolve the lifecycle route from that comparison, then close only its concrete
   compatibility/adapter gaps. Keep one release line and the existing encoder.
   Do not create another product fork or a third migration framework.
3. Prepare one candidate and one cutover/recovery procedure with affected services,
   downtime, writer stop/admission, retained software/state, and the boundary after
   which new writes require forward recovery. Prepare before seeking live authority.
4. Execute the authorized operation and check the same residents, history, ordinary
   chat, memory, Work/Library and existing client connections. Stop when the changed
   behavior and relevant lifecycle controls work.

This reconciliation is guidance work, not production activation. Existing user
authority persists; archived checklists cannot invent approval requirements.
The current source-to-product copy method remains available, but this document
does not choose or authorize a whole-home move or an encoder migration.

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
