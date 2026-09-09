# Home23 Host

Home23 Host is a separate native Mac companion. It installs and supervises a
home; the existing Home23 app connects to that home for conversation, Work,
Library, and channels. The client keeps its current sandbox and app identity.
The Host is a directly distributed application with its own identity.

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

The companion invokes the bundled Node with `app/scripts/product/host.mjs`.
The protocol accepts one action and an absolute `--home` path; `install` also
accepts `--payload`. Creation data arrives over stdin, including any credential,
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

## Evidence and remaining delivery work

`scripts/product/verify-install.mjs PAYLOAD NEW_OUTPUT_DIRECTORY` exercises the
installed artifact in an isolated directory. It launches real owned processes,
pairs a client, sends a canonical message, checks a persisted answer, then stops
and restarts the home to verify identity, Seed, session, and history continuity.
Its model and embedding endpoints are local fixtures. It retains a JSON receipt
and the stopped installation; this is not a clean-machine or real-provider test.

Distribution signing/notarization, a clean-Mac owner trial, automatic upgrades,
secure remote phone connection, hosted homes, and account connectors remain
delivery work. No package or test receipt should be described as proving those
steps. The initial Host form supports API-key and local-provider setup; existing
browser OAuth setup is not automatically an app-native OAuth flow.

API-key setup can run in Memory Lite mode: conversation history and text memory
are retained while semantic search needs a separate embedding service. Host
reports whether the configured local model is detected and displays missing
dependency warnings beside runtime readiness. Model detection is distinct from
a successful embedding call. Host does not yet install Ollama or its model.
Seed contact encoding remains credential-free and 768-dimensional; its explicit
endpoint is shared by the harness and conversation feed. No paid-provider key
is added to that encoding interface. Completing semantic setup without an
additional installation remains part of the distribution work.
