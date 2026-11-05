# Brain Tool Contract Cleanup Receipt

Date: 2026-07-12
Status: implementation, origin integration, and repository verification complete; live rollout pending

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
- `npm test` pretest/acceptance — passed, including the live-shaped 100k-node/300k-edge isolated PGS lifecycle proof attached for more than ten minutes.
- `npm --ignore-scripts test` post-merge repository suite — passed.
- `git diff --check` — passed.

## Integration

- Protected the complete local tree in commit `9367c36` before integrating upstream.
- Merged the 23 newer `origin/main` commits and preserved both their context-latency/reliability safeguards and the new brain-tool/PGS contracts.
- Corrected the merged large-PGS acceptance wait from five minutes to fifteen minutes; the real 100k/300k proof completed in about ten and a half minutes.
- Final implementation and instruction clarification were pushed through commit `da602dc` on `main`.

## Live rollout

- Restarted only `home23-cosmo23`, Jerry/Forrest MCP, dashboards, harnesses, and engines. All returned online.
- Jerry Chat completed `t_1783891772333_494c486d` on `openai-codex/gpt-5.6-terra` with canonical response `LIVE_CHAT_OK` in about five seconds.
- Direct Query completed `brop_0hxBGu1wYTEi7Q8tEqCiMjS1RPhdWDog` on `openai-codex/gpt-5.5`, with healthy pinned evidence and 142,231 authoritative nodes.
- `brain_status` completed `brop_A-8_5cems2BToNInOlbSDMDey8C1gt8K`: 142,231 nodes / 465,991 edges, manifest-v1, healthy.
- Query PGS partition discovery completed `brop_DT-Mltq8LnjTIiEuy7whNtkZb2TLf4XD`: 286 canonical partitions and 836 estimated work units.
- MCP health is healthy for Jerry and Forrest; Jerry reports the same 142,231 / 465,991 authority and a live `query_memory` match.
- The configured Anthropic PGS pair failed honestly with HTTP 401 and was removed from both agents' defaults. Jerry and Forrest now use the proven `openai-codex/gpt-5.4-mini` sweep and `openai-codex/gpt-5.5` synthesis defaults.
- Targeted PGS completed `brop_A-Fydrlilo08aQ_JHnj3dJzp76PIA5Ti` for `c-13`. The cumulative/full continuation `brop_TR_cXk4tUdE3uzED9kBqpsxIfq4BqxC3` reused that unit and added `c-14` (`reusedWorkUnits:1`, `newWorkUnits:1`, `scopeComplete:true`).
- Startup cleanup reclaimed the previous expired PGS store from about 893 MiB to zero. The two live acceptance sessions now occupy about 896 MiB total, are quota-bound, and expire automatically on 2026-07-19.
- `npm run test:contracts:live` passed all non-mutating registered live contracts; Chat, Query, and PGS action routes were proven separately above.
