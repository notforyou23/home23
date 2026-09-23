# Private Home23 release channel

The consumer Mac download contains one visible `Home23.app`. Its existing
`com.home23.host` helper and runtime are embedded at
`Contents/Library/LoginItems/Home23Host.app`. The visible app retains
`com.regina6.home23.mac` and its sandbox. A new owner copies this one app to
Applications and opens it. An update prepares the runtime and replacement app
before switching either component; a detached survivor performs the app swap
and confirms the new client and helper PIDs, paths and build.

The local `assemble-mac-release.mjs` output is ad-hoc signed engineering
evidence. It is not a published or Gatekeeper-ready download. A private
release needs the Developer ID/notarization sequence in [SIGNING.md](SIGNING.md).

The final app bundles `Contents/Resources/release-channel.json`:

```json
{"schema":"home23.product-channel.v1","channel":"private","manifestURL":"https://RELEASE-HOST/home23/manifest.json","publicKey":"BASE64_32_BYTE_ED25519_PUBLIC_KEY"}
```

The HTTPS endpoint serves `home23.signed-release.v1`, whose Ed25519 signature
covers the full canonical release object. It binds the package ID, source
commit, supported Mac architecture and OS, app/helper identities and build,
coordination compatibility, minimum mobile client build, mobile delivery URL,
and the URLs, byte lengths and SHA-256 hashes of both artifacts. Missing,
unreachable or invalid channel information means **unavailable**, never
“up to date.” Downloads use HTTPS byte ranges and resume a verified partial;
their final SHA-256 must match before staging. The runtime tar is extracted
with bounded memory and checked against its package manifest. The app ZIP is
extracted and checked for signature, Gatekeeper acceptance, sandbox, identity,
version and embedded runtime before a swap is allowed.

For a frozen signed payload, `scripts/product/archive-runtime.mjs` creates the
runtime tar. After final Developer ID signing, notarization/stapling and final
ZIP creation, `scripts/product/sign-channel-release.mjs` signs an envelope from
the exact final artifact bytes. Its signing key path is private and never
bundled. The script rejects ad-hoc receipts. Upload the archive files and
signed envelope to the approved HTTPS origin only after explicit publication
authorization. The app must be assembled with the matching `--channel-config`
before final outer signing; any changed bundle bytes require signing and
artifact hashes to be refreshed.

The backend update does not install iPhone or iPad apps. The signed release's
`appDeliveryURL` points to their supported Apple distribution route, and
`minimumClientBuild` lets native clients explain when their own update is
required. Do not use a placeholder URL as a published release.
