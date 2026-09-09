# A new Home23

A home starts with its own owner context, resident, brain/workspace, Seed lineage,
and canonical app conversation. It does not inherit Jerry's lived memory or a
copy of his installation. The existing substrate remains the authority for Seed
genesis, checkpoints, and subsequent contact.

## One preparation operation

`createHome(root, profile)` in `cli/lib/create-home.js` is shared by browser
first-run setup, terminal first-run setup, and `home create <profile.json>`.
It prepares local state without installing dependencies, calling a model, or
starting a service. Run `init` first to install dependencies and build the
runtime and its contract assets.

The saved profile includes resident name, display name, owner name, purpose,
personal facts, timezone, provider/model, and starter ingestion folders. Provider
credentials remain in the installation's protected secrets store. Receipts never
contain provider or resident credentials.

The local `instances/.house/creation.json` records the original request and
stable home ID. A cross-process lock serializes creation. An interrupted request
resumes from that profile and retains the same Seed, resident, and conversation.
A different request or an existing installation without this claim is refused.
The receipt is installation state and must never be committed.

Preparation creates:

- The existing identity and working-memory surfaces, including owner context,
  purpose, and watched import folders.
- An instance-owned cognitive engine configuration using the selected provider
  and model, with owner-specific prompts. Existing homes retain their configuration.
- A real independent Seed genesis/checkpoint with generic starting anatomy and
  governed self-formation. Real future contact supplies lived events.
- A permanent resident binding and durable direct conversation in Core, with
  fresh canonical authority for messages, roster, unread, search, attachments,
  activity, and helper lifecycle. Availability remains offline until the actual
  resident registers through the signed runtime connection.
- Private resident credentials, runtime configuration, and matching Seed/feed
  process definitions. Named startup includes Core and the conversation shipper.

`prepared` means these files and authorities exist. It does not mean a process
has started, a provider request succeeded, an app was installed, or an owner
accepted the experience. Startup refuses an incomplete creation receipt.
Browser setup exposes Resume setup; terminal setup resumes the saved profile.
Completed retries verify Seed lineage and return the original receipt without
rewriting the resident's subsequently lived configuration or memory.

## App connection and transport

Core's local API is `http://127.0.0.1:7346`. The Apple apps accept a home-specific
server address and pair with owner-issued credentials. Remote devices still
need the existing trusted transport boundary; exposing the local operator API
to the public internet is not part of home creation.

## Product work after this foundation

This change joins the current runtime's new-home state and existing guided
setup. A signed Mac distribution with managed installation/updates, automatic
secure remote connection, app-led provisioning without a terminal, hosted home
provisioning and recovery, and packaged account connectors remain separate
product delivery work. They should reuse this operation and its durable receipt,
not introduce a second way to create an identity or Seed.
