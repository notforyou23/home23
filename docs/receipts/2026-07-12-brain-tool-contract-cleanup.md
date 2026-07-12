# Brain Tool Contract Cleanup Receipt

Date: 2026-07-12
Status: implementation and repository verification complete; live rollout pending

## Outcome

- Replaced the ambiguous standalone `brain_pgs` surface with the canonical `brain_query` PGS contract.
- Added direct discovery for the brain catalog, recent durable operations, canonical PGS partitions, and completed/active research runs.
- Aligned agent schemas, system instructions, Query UI/contracts, MCP behavior, provider/model selection, and documentation.
- Made PGS continuation explicit (`fresh`, `continue`, `auto`) and added automatic reclamation of expired durable PGS sessions before quota admission.
- Kept direct search/status/graph reads separate from provider-backed Query/PGS work and preserved requester/target authority boundaries.

## Repository verification

- `npm run build` — passed.
- `npm run test:contracts` — 46 passed, 0 failed, 1 intentionally skipped.
- Focused integrated brain/Query/PGS/MCP matrix — 280 passed, 0 failed.
- `npm test` — passed, including the live-shaped 100k-node/300k-edge isolated PGS lifecycle proof.
- `git diff --check` — passed.

## Live rollout

Pending merge with the 23 newer `origin/main` commits, scoped PM2 restarts, and post-restart route/tool receipts.
