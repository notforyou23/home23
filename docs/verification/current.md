# Current Brain Retrieval, Query, and PGS Verification

Status: `PASSED WITH RETAINED LIVE NEGATIVE EVIDENCE`
Date: 2026-07-15

Current authority:

- `docs/receipts/2026-07-15-brain-retrieval-grounding-closeout.md`
- `docs/receipts/2026-07-14-query-pgs-recovery-closeout.md`
- iOS acceptance in the Home23 iOS repository:
  `docs/verification/2026-07-13-ios-query-notebook.md`
- Retrieval code HEAD before the current documentation commit:
  `307dee2f1541dae2876bc1d11ef329ff6f983635`
- Prior live Query/PGS acceptance backend HEAD:
  `d46921b119f328b58fb4c54d9cd2e51cf4da2d8d`
- iOS verifier HEAD: `091e32ca1f10f60e3f9d0b93a874f07acc584067`
- Private receipt SHA-256:
  `0d4de2a57234cb67858adc297aa7d07281cf3a7abfd73c6185db29412a02424a`

The older `2026-07-13-query-notebook-backend.md` template, its two failed
machine receipts, and the intentionally cancelled July 15 PGS diagnostic are
retained negative evidence. They must not be used as successful acceptance
receipts, but the July 15 diagnostic remains authoritative for the progress
projection bug that `e0f6013e` and `307dee2f` repaired.

No provider-backed Query, PGS, or iOS verifier was launched after the operator
ordered a credit stop. Current runtime authority is the fresh read-only health,
catalog, operation-count, key-presence, ANN-metadata, and storage evidence in
the July 15 closeout.
