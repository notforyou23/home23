# Consumer distribution signing checklist

Checklist only. Do **not** run `codesign`, `notarytool`, `productbuild`,
`node scripts/product/package.mjs`, `home23-apple/scripts/build-home23-host.mjs`,
or any upload/publish command from this document. Completing a developer build
or an ad-hoc signature does not satisfy this list.

Host and the Mac conversation client are separate applications. Keep their
signing identities, entitlements, and package membership distinct even when
they ship in one download experience.

## Assembly pointers (do not run here)

When the owner authorizes a release build, assemble from maintained source:

1. Product runtime payload: `node scripts/product/package.mjs` (Home23 backend).
2. Host app against that payload: `home23-apple/scripts/build-home23-host.mjs`.

Those commands produce local engineering artifacts. They are not a public
download, not Developer ID acceptance, and not notarization.

## Manifest and signature order

Freeze and sign in this order. Do not skip ahead.

1. **Package files** — Lock the exact payload file inventory (paths, modes,
   sizes, content hashes) that will ship in the product manifest’s `files`
   list. Any content change requires a new inventory.
2. **`packageId`** — Derive and record the package id from that frozen
   manifest body (the digest of the manifest without `packageId`). The id must
   match the inventory; a changed tree needs a new id.
3. **Development or production signature** — Sign that `packageId` (Ed25519
   over the id bytes for the chosen publisher-trust claim). Development
   trust-key verification is for local feeds only. Production publisher trust
   requires the owner-held production key and a published feed—neither exists
   as a public download today.

Do not claim production trust on a development signature. Do not notarize
before the files and `packageId` are frozen.

## Owner approval sequence (exact; do not perform)

These steps require explicit owner authorization. They are listed in the order
they must be approved and completed for consumer distribution. This document
does not authorize or execute them.

1. **Approve Developer ID Application signing**
   - Owner confirms the frozen package (files + `packageId`) and the Host/Mac
     client builds that embed or ship with that payload.
   - Owner authorizes signing Host and the Mac client
     (`com.regina6.home23.mac`) with Apple **Developer ID Application**
     identities appropriate for external distribution—not Apple Development,
     not ad-hoc.
   - Host and Mac client identities stay separate. Re-verify the frozen
     `packageId` still matches the signed bits.

2. **Approve notarization**
   - Owner authorizes submission of those Developer ID–signed artifacts to
     Apple notarization (and stapling / container attachment as required for
     the chosen Mac download form).
   - Gatekeeper acceptance must be confirmed on a clean supported Mac that is
     not the development build machine.
   - Notarization of an ad-hoc or Development-signed build does not count.

3. **Approve a public release feed**
   - Owner selects and publishes the public download channel and authenticated
     release feed (domain, artifact hosting, and feed URL are unset until this
     approval).
   - Owner authorizes the **production** release-feed signing key material
     (distinct from local development trust-key JSON) and publication of
     versioned Host (+ Mac client) artifacts that match the frozen
     `packageId`.
   - Until this step is done, public downloads remain unavailable. A local
     development feed with `--trust-key` is not a public feed.

4. **Approve iPhone TestFlight**
   - Owner authorizes the Apple account actions, build upload, and TestFlight
     (internal/external) invite path for the iPhone app.
   - A public App Store link appears only after a later release approval.
   - TestFlight readiness is independent of Mac Developer ID + notarization;
     do not advertise an iPhone beta from this preview until the owner
     completes this step.

## What does not count as consumer acceptance

- Ad-hoc signatures or Apple Development signatures
- “It launched on my machine” after a developer or ad-hoc sign
- The September 22 06:44 stub package (fixture Node candidate)—not a release
- Signing Host while leaving the Mac client unsigned (or the reverse)
- Notarizing or publishing before package files and `packageId` are frozen
- A development `--trust-key` Check result (contract at
  `app/scripts/product/host-command-contract.json`, Apple `243147d`, backend
  `8903df6c`) presented as public publisher trust
- Managed/source adoption without a held supervisor fence
- Claiming a price, release version, or live download URL from this checklist

## Out of scope for this checklist

- Creating another website repository
- Running packaging, signing, notarization, upload, or TestFlight from an agent
- Changing an existing owner’s home or touching an in-progress install trial
- Measuring or advertising update wall time for a trial that is still running

When distribution work proceeds, follow this order against the frozen package
for that release—not against a live checkout that is still changing.
