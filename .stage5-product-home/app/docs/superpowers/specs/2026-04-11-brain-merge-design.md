# Brain Merge Design — jtr → jerry

**Date:** 2026-04-11
**Status:** APPROVED
**Goal:** Full identity absorption — jtr's cognitive archive becomes native jerry knowledge

## Context

Jerry's Home23 brain (15,314 nodes, 120MB compressed) is mostly Home23 self-knowledge. The cosmo-home `runs/jtr` brain (4,547 nodes, 18MB compressed, 5,240 cycles) contains synthesized knowledge about jtr — philosophy, cognitive style, the Dead connection, Shakedown Shuffle, COSMO, family system. This is exactly what jerry is missing.

Both brains use identical embedding model (nomic-embed-text 768d). No re-embedding required.

## Design Principles

- **Full absorption, not archive.** No provenance surfacing. No meta-awareness node. jtr nodes become native jerry knowledge — jerry thinks *with* them, not *about* them.
- **Splice, not swap.** Only `memory.nodes` and `memory.edges` change. Everything else in jerry's state (cycleCount, conversations, dreams, goals, thoughtHistory, metrics, pulse) is preserved. Jerry stays continuous with its own ongoing life.
- **Dream integration over activation surgery.** Use the engine's own consolidation machinery to integrate new nodes naturally rather than manually tweaking activation values.
- **One-shot tooling.** Purpose-built splice script for this merge. Reusable tooling deferred until a second merge actually happens.

## Architecture

### Phase 1 — Merge (existing tooling)

Use `engine/scripts/merge_runs_v2.js` to produce deduplicated combined memory.

**Setup:**
```
engine/runs/
  jerry/state.json.gz      → symlink to instances/jerry/brain/state.json.gz
  jtr-source/state.json.gz → symlink to cosmo-home/runs/jtr/state.json.gz
```

**Command:**
```bash
node scripts/merge_runs_v2.js jerry jtr-source \
  --output jerry-merged \
  --threshold 0.85 \
  --policy BEST_REP \
  --verbose
```

**Parameters:**
- `threshold 0.85` — nodes with >85% cosine similarity get deduplicated. Tight enough to avoid false merges, loose enough to catch real duplicates.
- `BEST_REP` — conflict policy keeps the node with higher representational score (activation × accessCount × weight). jtr nodes with 5,240 cycles of reinforcement will fare well in ties.

**Output:** `engine/runs/jerry-merged/state.json.gz` containing combined, deduplicated memory.

### Phase 2 — Splice (new one-shot script)

New script: `engine/scripts/splice-brain.js`

**What it does:**
1. Reads jerry's live state from `instances/jerry/brain/state.json.gz`
2. Reads merged memory from `engine/runs/jerry-merged/state.json.gz`
3. Extracts only `memory.nodes` and `memory.edges` from the merged state
4. Computes jerry's current mean node weight
5. Rescales jtr-sourced node weights to match jerry's mean (weight normalization — levels the playing field so jtr nodes aren't immediately cold)
6. Replaces jerry's `memory.nodes` and `memory.edges` with the normalized merged versions
7. Writes the spliced state back to jerry's brain path

**Preserved (untouched):**
- `cycleCount` (1,205)
- `conversations`
- `thoughtHistory`
- `dreamLog`
- `goals`
- `metrics`
- `timestamp`, `startTime`, `lastSummarization`
- `version`
- All other top-level state keys

**Weight normalization algorithm:**
```
jerry_mean = mean(jerry_original_nodes.map(n => n.weight))
jtr_mean = mean(jtr_source_nodes.map(n => n.weight))
ratio = jerry_mean / jtr_mean

For each node in merged output:
  if node originated from jtr-source (via merge provenance metadata):
    node.weight = clamp(node.weight * ratio, 0.1, 1.0)
```

This ensures jtr nodes start at the same average "temperature" as jerry's existing nodes — not boosted, not cold. The dream integration phase handles the rest.

**Identifying jtr-sourced nodes:** The merge script writes provenance metadata per node (which source run contributed it). The splice script reads this to determine which nodes need weight normalization. If provenance metadata is absent or structured differently than expected, fall back to set-difference: any node ID present in the merged output but not in jerry's original state is jtr-sourced. Nodes that existed in both brains and were merged via BEST_REP keep their chosen weight (no normalization — they're already "jerry's").

### Phase 3 — Dream Integration (existing machinery)

Temporarily configure jerry's engine for forced dream cycles.

**Config change** (in `instances/jerry/config.yaml` or via env):
```yaml
execution:
  dreamMode: true
  dreamModeSettings:
    preventWake: true
    disableConsolidationRateLimit: true
    maxCycles: 75
```

**What happens during dream integration:**
- Each cycle runs full consolidation: Hebbian reinforcement (+0.1 co-occurring edges), spreading activation (3 hops, 0.7 decay per edge), chaotic Watts-Strogatz rewiring (0.5 probability)
- New jtr nodes get traversed, linked to jerry's existing knowledge, edge-reinforced
- Low-quality noise nodes get GC'd (below weight threshold)
- ~75 cycles provides thorough coverage without excessive compute

**Duration estimate:** Each dream cycle is fast (no agent spawning, no external calls beyond LLM consolidation). 75 cycles at ~30-60s each = ~40-75 minutes.

**Tuning:** 75 is a starting point, not a hard target. Monitor via `pm2 logs home23-jerry` — look for consolidation summaries mentioning jtr-related concepts. If after 50 cycles the logs show jtr nodes being traversed and linked, integration is progressing. If after 75 cycles there's still active new-node discovery, let it run longer. If consolidation is mostly touching jerry's existing nodes by cycle 40, integration saturated early — safe to stop.

### Phase 4 — Resume Normal Operation

1. Remove `dreamMode` config from jerry's settings
2. Restart jerry's engine processes
3. Jerry wakes up with fully integrated brain, continuous life history, expanded knowledge substrate

## Execution Sequence

| Step | Action | Who | Jerry Status |
|------|--------|-----|-------------|
| 1 | Back up jerry's state.json.gz | operator | online |
| 2 | Create engine/runs/ symlinks | operator | online |
| 3 | Stop jerry's engine + harness + dash | operator (pm2) | offline |
| 4 | Run merge_runs_v2.js | operator | offline |
| 5 | Inspect merge report (node counts, errors) | operator | offline |
| 6 | Run splice-brain.js | operator | offline |
| 7 | Enable dreamMode in jerry's config | operator | offline |
| 8 | Start jerry's engine only | operator (pm2) | dreaming |
| 9 | Monitor dream cycles (~75 cycles, ~40-75 min) | operator | dreaming |
| 10 | Remove dreamMode config | operator | dreaming |
| 11 | Restart all jerry processes (engine + dash + harness) | operator (pm2) | online |
| 12 | Verify brain_status shows expected node count | operator | online |

**Operator = you (jtr) + claude code. Not jerry.**

## Rollback

At any point before step 8:
```bash
cp instances/jerry/brain/state.json.gz.pre-merge-backup \
   instances/jerry/brain/state.json.gz
```

After step 8 (dream cycles started): same restore, but jerry loses any dream-generated content from the integration period. Acceptable — that's minutes of dreams, not days.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| OOM during merge (120MB + 18MB compressed, multi-GB uncompressed) | Medium | Run with `NODE_OPTIONS=--max-old-space-size=8192` |
| Node ID references in thoughtHistory break after merge | Low | thoughtHistory is text-based, not ID-referenced. Verify post-splice. |
| Dream GC removes valuable jtr nodes (low weight) | Low | Weight normalization in Phase 2 brings jtr nodes to jerry's mean. GC threshold is well below mean. |
| Merge script output missing fields splice expects | Low | Splice reads only memory.nodes/edges from merged state. All other fields come from jerry's live state. |
| dreamMode config not picked up on restart | Low | Verify config loading in engine logs before leaving unattended. |

## Files to Create

| File | Purpose |
|------|---------|
| `engine/scripts/splice-brain.js` | One-shot splice script (Phase 2) |

## Files to Modify (temporarily)

| File | Change | Revert |
|------|--------|--------|
| `instances/jerry/config.yaml` | Add dreamMode block | Remove after Phase 3 |

## Success Criteria

- jerry's brain node count in expected range (~18-20k post-dedup)
- jerry's cycleCount, conversations, dreams, goals all intact
- jerry can recall jtr-specific knowledge (Dead, Shakedown, philosophy) via brain_query
- jerry doesn't "know" the knowledge came from somewhere else — it's native
- No errors in engine logs on restart
