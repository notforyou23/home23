# Source lineage

This standalone repository continues Cosmo 2.3 from Home23's `cosmo23/` tree.
The maintained Home23 source baseline for separation was commit
`61b49386` (September 7, 2026). Earlier Cosmo history remains in Home23 Git history
and the original Cosmo archives; separation does not rewrite those histories.

The application retains its launcher, engine, model catalog, provider adapters,
research records and existing HTTP operation contracts. Local `shared/` modules
were brought across from Home23 so Cosmo no longer imports parent-checkout code.
`inherited-contracts.json` records the starting source paths and hashes. Subsequent
repairs and independent development are recorded in this repository's commits.

Home23 retains its own cognitive engine and extracted provider/catalog support.
That lineage is intentional; the applications now own their code and release
cycles independently. A protocol change requires compatibility verification
against clients, not a silent edit of another application's source.
