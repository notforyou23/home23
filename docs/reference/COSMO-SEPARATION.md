# Cosmo separation

Home23 retains its inherited cognitive engine, Seed, Stream and resident brains.
Cosmo is the independently installed research application. Home23 accesses its
configured `cosmo23.baseUrl`; an optional `cosmo23.source` supplies a local research
catalog root. Home23 does not install, start, restart, watchdog or update Cosmo.

Home23-owned provider and catalog support lives in `shared/research-runtime/`.
These modules were extracted from the vendored application while retaining their
behavior. Cosmo carries its own local memory and operation protocol modules.
The two applications communicate using the existing authenticated operation API.
Existing request identities, metadata filenames and saved research are unchanged.
The raw-token broker API remains compatible with existing Home23 OAuth clients.

The extraction preserves source lineage through Home23 Git history and a new
Cosmo repository. Machine-specific paths, backups, credentials and run inventories
belong in local operator records, not this public document. Old vendoring design
notes describe history; they no longer establish Home23 ownership of Cosmo.

Evobrew removal is separate. Its memory-source adapter temporarily uses the
Home23-owned support library so removing Cosmo does not break Evobrew.

## Verification ownership

Cosmo's product and security regression suites live in its own repository and run
with `npm test` there. Home23 retains its engine regression suites. Cross-product
acceptance tests and tooling resolve the external checkout through the explicit
`COSMO23_SOURCE_ROOT` environment variable; they never require a vendored folder.
Run Home23's full integration suite with that variable pointing to the independent
checkout. This source setting is for development tooling, not production serving.

Legacy Home23 configuration seeding and the old run relocator were retired.
Existing encryption keys and imported research records are preserved locally.
