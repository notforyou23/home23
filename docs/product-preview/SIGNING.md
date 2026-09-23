# Mac release assembly and consumer signing

The visible Home23 Mac app embeds its Host helper and runtime. Local assembly is
engineering work; publication, Apple submission,
and changes to an owner's installed apps are separate actions. This document does
not introduce an additional approval gate for already-authorized local builds.
An ad-hoc or development signature is not consumer distribution.

## Historical local engineering candidate (not published)

Verified against `assembly-receipt.json` only; do not rebuild from this note.

| Field | Value |
|---|---|
| Status | `local-engineering-candidate` |
| Archive | `…/mac-release-recovery-20260922/assembly/Home23-arm64-72a996151605-c4fdd5a4bbf6.zip` |
| sha256 | `e4fd3a2da590123db4049a61422b4ba366594ac78c8d9f4dec9698e863d0c148` |
| Bytes | 448010070 |
| Backend | `98aa10a0a956852519ee9d2d61f2f9af0b24e1c1` |
| Apple | `c4fdd5a4bbf6722f1a5bcf21177c766a9aae47c3` |
| Runtime `packageId` | `72a996151605ab2580eb6060a62abdf762d3246f5502cff1c19cce73bfaa01a5` |
| Host | `com.home23.host` 0.1 build 1, macOS 14.0+, arm64 |
| Mac client | `com.regina6.home23.mac` 2.0 build 140, macOS 27.0+, arm64 |
| Combined minimum | macOS 27.0 arm64 |
| Signing | ad-hoc; client sandbox true; APNs / time-sensitive entitlements omitted |
| Notarized / published / installed | false / false / false |

Receipt path:
`…/mac-release-recovery-20260922/assembly/assembly-receipt.json`.
Full verification root prefix:
`/Volumes/Casey Jones/Home23-local-disk-relief/2026-09-09/verified-relocations/Users__jtr___JTR23___development__verification/owned-embedder-review-20260911/`.

## Build a local download

Use a complete verified Darwin runtime payload from `scripts/product/package.mjs`
and a clean, isolated Apple checkout at the explicit full commit. From the backend:

```sh
node scripts/product/assemble-mac-release.mjs \
  --payload /absolute/Home23Runtime \
  --apple-source /absolute/home23-apple-checkout \
  --apple-commit FULL_APPLE_COMMIT \
  --developer-dir /absolute/Xcode.app/Contents/Developer \
  --output /absolute/new-release-directory
```

The command builds `Home23Mac` in Release, then builds Host with the same version,
build and minimum macOS and embeds it at
`Home23.app/Contents/Library/LoginItems/Home23Host.app`. It verifies runtime integrity, app identities and
architecture, then produces:

- one visible `Home23/Home23.app` containing Host and runtime;
- `Home23/Start Here.txt` with the actual OS/architecture requirements;
- `Home23/release.json` with backend and Apple revisions, runtime package ID,
  app versions, executable digests and explicit local-only status;
- a combined ZIP, basename checksum and `assembly-receipt.json`.

Build intermediates remain outside the download in `build/`. Existing outputs
are refused. The command does not install, start a home, access signing identities,
notarize, upload or publish. The helper and client are only ad-hoc signed for local work. The client retains its
sandbox and file/network/media permissions; profile-backed APNs and time-sensitive
notification entitlements are omitted from this local artifact and remain unverified.
Do not present this ZIP as Gatekeeper-approved consumer distribution.

The combined download requires the stricter minimum OS of its two apps. A Host
build for macOS 14 does not mean a Mac client built for macOS 27 works on macOS 14.
Each component's own requirement is retained in the descriptor. Assembly proves the
artifact pairing, not provider setup, update/recovery or clean-machine acceptance;
those require their separately recorded journeys on that exact release set.

## Production signing and integrity order

The local command above is **not** the Developer ID signing pipeline. Consumer
signing must be prepared separately against an agreed release, without silently
changing any already-tested artifact:

1. Build the runtime and apps from frozen source. Complete signing of runtime
   executables, native modules and nested code first. Code signing can change
   file bytes and add files.
2. Inventory the **final signed runtime bytes**, write a new runtime manifest and
   derive its `packageId`. Verify it. A manifest frozen before runtime signing
   would describe different bytes and must not be reused.
3. Embed that runtime in Host. Sign remaining nested app code and the enclosing
   Host and Mac apps from inside out. Signing the outer app must not mutate the
   frozen embedded runtime. Re-verify the runtime inventory after signing; do
   not use recursive re-signing to conceal a mismatch.
4. Submit the signed apps/container for notarization and staple as appropriate.
   Verify the resulting apps and test Gatekeeper on a clean supported Mac. Any
   runtime mutation requires repeating the runtime manifest/signing dependency.
5. Assemble the final single-app download and runtime tar. Hash the **final**
   downloadable bytes, including any notarization/stapling changes. Generate
   release descriptors from those exact artifacts. Sign the private-channel
   envelope described in [PRIVATE-CHANNEL.md](PRIVATE-CHANNEL.md); the runtime
   package digest and download digest are different.
6. Publish the approved archive, descriptor/signature, checksum and release notes
   together. A subsequent artifact change requires new hashes and signatures.

A development trust key is only for an isolated development feed. It is never
production publisher trust. Do not substitute
an archive checksum for publisher authentication.

## Remaining owner actions to publish (stop here)

These require the owner. Do not run them from this documentation lane:

1. Authorize **Developer ID Application** signing of Host (`com.home23.host`) and
   the Mac client (`com.regina6.home23.mac`) for this frozen release set (or a
   deliberately rebuilt successor), following the integrity order above—not
   ad-hoc, not Apple Development.
2. Authorize **notarization** (and stapling / container attachment) and confirm
   Gatekeeper on a clean supported Mac.
3. Choose and publish a **private HTTPS release origin and authenticated
   release feed**, including the publisher signing key (distinct from any
   local development trust-key). Publish the approved archives, checksums,
   descriptors, and notes together.
4. Authorize **iPhone TestFlight** (build upload and invites) separately; a Mac
   ZIP does not create TestFlight availability.
5. Authorize any **install or replacement** of apps on an owner machine; this
   candidate’s `installed: false` must stay false until that happens.

Keep existing bundle and Keychain identities. Consumer downloads remain unavailable
until steps 1–3 actually succeed. Do not bypass macOS security prompts as a
substitute for distribution acceptance.
