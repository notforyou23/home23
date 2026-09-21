# Consumer distribution signing checklist

Checklist only. Do not run `codesign`, `notarytool`, `productbuild`, or any
other signing/notarization command from this document. Completing a developer
build or an ad-hoc signature does not satisfy this list.

Host and the Mac conversation client are separate applications. Keep their
signing identities, entitlements, and package membership distinct even when
they ship in one download experience.

## Order (do not skip ahead)

1. **Freeze the package manifest and package id**
   - Lock the exact payload contents (runtime, Host, client pieces you intend to
     ship) and the package identity recorded in the product manifest.
   - Record hashes and version metadata for that frozen set.
   - Do not sign a moving tree; any content change after freeze requires a new
     freeze before signing.

2. **Sign**
   - Sign the frozen Host and Mac client binaries/bundles with the distribution
     identity appropriate for external Mac installation (not an Apple
     Development cert used only for local device builds).
   - Keep Host and Mac client signing identities separate; do not collapse them
     into one “signed something” claim.
   - Re-verify the frozen manifest still matches the signed bits.

3. **Notarize**
   - Submit the signed artifacts for Apple notarization only after the freeze and
     sign steps above.
   - Staple or otherwise attach notarization evidence as required for the chosen
     download container.
   - Confirm Gatekeeper acceptance on a clean supported Mac that is not the
     development machine used to build.

## What does not count as consumer acceptance

- Ad-hoc signatures
- Apple Development signatures used for local/dev installs
- “It launched on my machine” after a developer or ad-hoc sign
- Signing Host while leaving the Mac client unsigned (or the reverse), then
  describing the download as distribution-ready
- Notarizing before the package manifest and package id are frozen

## Out of scope for this checklist

- Choosing a public domain or website repository
- Uploading builds, creating store listings, or TestFlight invites
- Claiming a price, release version, or live download URL
- Changing an existing owner’s home

When distribution work proceeds, follow this order against the frozen package
for that release—not against a live checkout that is still changing.
