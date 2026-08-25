# Connected Agents contract pack

`v1/` is the canonical M02 machine-readable contract pack for the Home23
Connected Agents program. `CONNECTED_AGENTS_CONTRACT_VERSION` is the integer
`1`.

The SHA-256 digest is computed from `v1/pack-manifest.json`'s
`canonicalFiles`, sorted lexically. Each UTF-8 file is framed as:

```text
<path-byte-count>:<relative-path>\n<content-byte-count>:<exact-file-bytes>\n
```

The manifest includes itself, so the digest covers the file inventory and its
ordering rule without containing the digest and creating a cycle. Generated
Swift, receipts, build logs, timestamps outside canonical examples, and
absolute paths are excluded.

Compatibility after M02 is additive within contract version 1: unknown object
fields are tolerated, enum behavior is declared per public enum in
`v1/registry.json`, and unknown durable event types advance a validated cursor
without applying unknown payload semantics. Breaking changes require a
numbered contract delta reviewed by both Core and Apple contract owners; they
must never be made as a silent mutation of this pack.

`generate-apple-fixtures.ts` mechanically embeds the exact canonical JSON
fixtures plus the reviewed version/digest in Home23Shared. The generated Apple
source is deliberately outside the digest: it is a consumer representation,
not a second contract authority.
