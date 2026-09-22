# Mac release assembly and consumer signing

Home23 Host and the Mac conversation client are separate applications, delivered
in one folder. Local assembly is engineering work; publication, Apple submission,
and changes to an owner's installed apps are separate actions. This document does
not introduce an additional approval gate for already-authorized local builds.

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

The command builds Host with the payload and builds `Home23Mac` in Release from
the same Apple checkout. It verifies runtime integrity, app identities and
architecture, then produces:

- `Home23/Home23 Host.app` and `Home23/Home23.app`;
- `Home23/Start Here.txt` with the actual OS/architecture requirements;
- `Home23/release.json` with backend and Apple revisions, runtime package ID,
  app versions, executable digests and explicit local-only status;
- a combined ZIP, basename checksum and `assembly-receipt.json`.

Build intermediates remain outside the download in `build/`. Existing outputs
are refused. The command does not install, start a home, access signing identities,
notarize, upload or publish. Host and client are only ad-hoc signed for local work. The client retains its
sandbox and file/network/media permissions; profile-backed APNs and time-sensitive
notification entitlements are omitted from this local artifact and remain unverified.
Do not present this ZIP as Gatekeeper-approved consumer distribution.

The combined download requires the stricter minimum OS of its two apps. A Host
build for macOS 14 does not mean a Mac client built for macOS 27 works on macOS 14.
Each app's own requirement is retained in the descriptor. Assembly proves the
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
5. Assemble the final download. Hash the **final** downloadable bytes, including
   any notarization/stapling changes. Generate release descriptors from those
   exact artifacts. Sign the existing release-feed envelope according to its
   schema; the runtime package digest and the download digest are different.
6. Publish the approved archive, descriptor/signature, checksum and release notes
   together. A subsequent artifact change requires new hashes and signatures.

A development trust key is only for an isolated development feed. It is never
production publisher trust. Do not invent a new signature schema or substitute
an archive checksum for publisher authentication.

## Remaining external actions

Prepare exact artifacts and request only authority that is still missing:

- Developer ID identities and the agreed signing operation for Host and client;
- notarization submission and clean-Mac Gatekeeper acceptance;
- the public domain/feed/artifact destination and production feed signing key;
- iPhone build upload and TestFlight distribution, separately from Mac release.

Keep existing bundle and Keychain identities. The Mac client is
`com.regina6.home23.mac`; Host is `com.home23.host`. iPhone TestFlight does not
become available because a Mac build exists. Public downloads remain unavailable
until publication actually succeeds. Do not bypass macOS security prompts as a
substitute for distribution acceptance.
