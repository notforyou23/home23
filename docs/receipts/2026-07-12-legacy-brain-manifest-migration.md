# Legacy Brain Manifest Migration Receipt

Date: 2026-07-12  
Operator: Codex  
Repository: `/Users/jtr/_JTR23_/release/home23`  
Implementation commits: `2730f4b`, `67d60be`, `80b38b0`
Branch: `codex/brain-agent-migration`

## Verdict

Jerry and Forrest are live on native `manifest-v1` memory authority. Both engines restarted and loaded their exact migrated graph, both revisioned ANN indexes are pinned fresh, dashboard search uses `semantic-ann` without `ann_missing`, both MCP health routes report healthy current revisions, the repaired nightly wrapper truthfully reuses both indexes, and Jerry native chat completed a real streamed turn.

No legacy source, stale ANN, null ANN, or operator data was deleted. The live checkout was updated without reset, clean, or branch switching.

## Live Authority

| Agent | Generation | Revision | Nodes | Edges | Clusters | ANN revision |
|---|---|---:|---:|---:|---:|---:|
| Jerry | `g-1891463280844112-e169cc2d-8c24-437d-ad45-d995265369f0` | `1891463280844112` | 142,231 | 465,991 | 30 | `1891463280844112` |
| Forrest | `g-1677572487654287-0d19ad59-f27a-4b87-9825-fba66f1c4b58` | `1677572487654287` | 118,367 | 456,885 | 2 | `1677572487654287` |

Jerry ANN files:

- `memory-ann.1891463280844112.index` — 458,070,580 bytes
- `memory-ann.1891463280844112.meta.json` — 136,437,098 bytes

Forrest ANN files:

- `memory-ann.1677572487654287.index` — 381,214,952 bytes
- `memory-ann.1677572487654287.meta.json` — 116,789,461 bytes

The live-scale metadata test exposed and fixed a 16 MiB reader ceiling that rejected Jerry's valid 136 MB metadata with HTTP 413. The final loader has a 256 MiB hard cap, exact generation/revision/count validation, anchored-file identity in its cache key, and a serialized one-entry cache so parallel requests cannot multiply large HNSW loads.

## Preserved Legacy Sources

The migration returned `unchangedLegacy: true`; the original inputs remain present:

| Agent/file | Bytes | SHA-256 |
|---|---:|---|
| Jerry `memory-nodes.jsonl.gz` | 1,203,460,990 | `c37ed19d35e428fc42e121d64f101c74001387a44ca8e647e432ba027a662b2f` |
| Jerry `memory-edges.jsonl.gz` | 8,266,703 | `f2f66e71e1389851b5a78ee93f557479fee72a83b3809304a2cbbeba48a06558` |
| Jerry `memory-delta.jsonl` | 462,807,524 | `4e49c0543c414a856c9495d4de3206b9985127a2d4038e2fd5e2b6b0ecab7aa0` |
| Forrest `memory-nodes.jsonl.gz` | 1,017,813,418 | `90eec23a92257cd528f6c8ddfde1bf4870e1a8c7efb6a73258376e17aa4aab1c` |
| Forrest `memory-edges.jsonl.gz` | 8,514,801 | `a0fe95cde8cbf5c8885f0f5fbd8159eaeb60de830de266b74944cdb12f9d2309` |
| Forrest `memory-delta.jsonl` | 120,687,623 | `82a6a915d64b3074e754cfa3a119da8ecaff8eb15221c8ac9529af6f3e163254` |

Old unpinned ANN files and the false-green `memory-ann.null.*` evidence are also retained pending a separate operator-approved reclamation pass.

## Current Rollback Backups

Final audit found that the earlier pre-migration backups were absent after the transient low-space migration window. Completion was held, and new coherent native backups were created and hash-verified after both ANN pins were fresh. No cause is assigned without deletion provenance.

The first native backups copied the rebuildable ANN artifacts and pushed free space below the Home23 floor. Commit `80b38b0` changed native backup publication to copy authoritative state/base/delta only and to write a self-consistent backup manifest with `ann` null. It validates a complete canonical, non-colliding ANN descriptor before omission. The two full copies were replaced through normal retention only after the lean backups published and opened successfully as healthy `manifest-v1` sources. The live ANN remains pinned and unchanged.

Jerry:

- `backup-2026-07-12T15-53-48.954Z-35252-06193bb7-eaa3-490f-a962-276ab21eaf42`
- source `memory-manifest`, generation and revision equal live authority
- 1,240,854,668 copied bytes
- active base SHA-256 `c5526fc625deda4be4468efdfd057d478d7d8d742ae35f15b1608dc24567248e`
- backup source manifest has ANN null and SHA-256 `871fc165a8d72779778ae85923653f7bf45ed72590074aeb9febaba8cfe81d28`
- omitted derived files: `memory-ann.1891463280844112.index`, `memory-ann.1891463280844112.meta.json`

Forrest:

- `backup-2026-07-12T15-53-55.454Z-35252-c897713c-b0df-4cb2-a19c-bdcca7a3206b`
- source `memory-manifest`, generation and revision equal live authority
- 1,039,486,738 copied bytes
- active base SHA-256 `be9890c48c38988dff0239f03d5451f037572b713c256b31674c70f77e17d055`
- backup source manifest has ANN null and SHA-256 `a3a7dfe6356a7d4458cb91062afe3231caa2031fdd9df7c908be4e6117ad29c2`
- omitted derived files: `memory-ann.1677572487654287.index`, `memory-ann.1677572487654287.meta.json`

The data volume showed 11,911,308 KiB available after the lean backups replaced their full predecessors. The temporary implementation worktree is removed only after its commits are pushed.

## Live Route Proof

- Jerry dashboard `GET /home23/api/brain/status`: HTTP 200, `implementation=manifest-v1`, `sourceHealth=healthy`, ANN fresh.
- Forrest dashboard `GET /home23/api/brain/status`: HTTP 200, `implementation=manifest-v1`, `sourceHealth=healthy`, ANN fresh.
- Jerry and Forrest dashboard `POST /api/memory/search`: HTTP 200, three `semantic-ann` results, exact fresh ANN revision, no `ann_missing`.
- Jerry MCP `GET :5003/health`: HTTP 200, healthy, revision `1891463280844112`, totals 142,231/465,991.
- Forrest MCP `GET :5015/health`: HTTP 200, healthy, revision `1677572487654287`, totals 118,367/456,885.
- Both MCP `get_memory_statistics` and `query_memory`: HTTP 200 with healthy `manifest-v1` evidence and fresh ANN watermarks.
- Jerry bridge `POST :5004/api/chat`: streamed exactly `HOME23_CHAT_OK` and terminal `data: [DONE]`.
- `node cli/home23.js brain-operations list --state nonterminal --all-requesters`: `count: 0`.
- `bash scripts/rebuild-ann-indexes.sh`: both agents reported existing index fresh and `<agent> OK`; no null index was written.

Search evidence may say degraded when ANN results are deliberately supplemented by an exact keyword result (`exact_canary_missing`). That is retrieval-quality evidence; the independent source-health and MCP status routes remain healthy and native.

## Runtime Proof

Final scoped processes were online:

| Process | PID | Restart count |
|---|---:|---:|
| `home23-jerry` | 75271 | 4 |
| `home23-forrest` | 38839 | 5 |
| `home23-jerry-dash` | 21760 | 102 |
| `home23-forrest-dash` | 57770 | 3 |
| `home23-jerry-harness` | 66447 | 11 |
| `home23-forrest-harness` | 66495 | 5 |
| `home23-jerry-mcp` | 66269 | 2 |
| `home23-forrest-mcp` | 66282 | 2 |
| `home23-cosmo23` | 90999 | 17 |

Only the two engines, dashboards, harnesses, and MCP processes were restarted as required by their loaded code or stale readiness snapshots. COSMO remained online.

## Automated Verification

- `npm run build`: pass.
- `npm run test:contracts`: 36 pass, 1 intentional live skip, 0 fail.
- Focused final brain/ANN/backup/pin matrix: 132 pass, 0 fail.
- Full `npm test` with all installed Home23/COSMO dependency roots: pass. Major phase totals included 39/39 acceptance-runtime, 1,129/1,129 engine matrix, 229/229 script matrix, and 2/2 legacy route tests.
- Final lean-backup recovery suite after the full pass: 9/9, including real source open/search, post-restore delta append, exact copied-manifest hash, and adversarial ANN/source collision refusal.
- The first full invocation used an incomplete isolated `NODE_PATH`; its 10 module-resolution failures were rerun with the complete dependency roots and passed 24/24 before the clean full pass.
- Adversarial subagent review completed with no remaining rollout blocker before live migration; a second live-scale ANN review identified the metadata ceiling and per-request reload risk that became commit `67d60be`.

## Retention Boundary

Do not delete the original legacy sidecars, prior ANN artifacts, null ANN evidence, or the two named rollback backups as part of this rollout. Reclamation is a separate explicit operator decision after a stable observation window.
