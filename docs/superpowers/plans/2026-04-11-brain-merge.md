# Brain Merge (jtr → jerry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Absorb jtr's 4,575-node cognitive archive into jerry's 15,537-node brain as native knowledge, preserving jerry's full life-state (cycles, conversations, dreams, goals).

**Architecture:** Three-phase: (1) merge via existing `merge_runs_v2.js` to produce deduplicated combined memory, (2) splice only `memory.nodes/edges` into jerry's live state via a new one-shot script, with weight normalization for jtr-sourced nodes, (3) forced dream integration via engine's built-in `dreamMode` to naturally consolidate the new knowledge.

**Tech Stack:** Node.js, gzip, existing `StateCompression` + `mergeRuns` modules, PM2 for process management.

**Spec:** `docs/superpowers/specs/2026-04-11-brain-merge-design.md`

---

### Task 1: Write splice-brain.js

**Files:**
- Create: `engine/scripts/splice-brain.js`

This is the core new code. One-shot script that grafts merged memory into jerry's live state.

- [ ] **Step 1: Create the splice script**

```js
#!/usr/bin/env node

const path = require('path');
const { StateCompression } = require('../src/core/state-compression');

// loadCompressed auto-resolves state.json → state.json.gz
// saveCompressed writes to state.json.gz (compressed by default)
const JERRY_STATE = path.resolve(__dirname, '..', '..', 'instances', 'jerry', 'brain', 'state.json');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node splice-brain.js <merged-state-path>');
    console.error('  e.g.: node splice-brain.js ../runs/jerry-merged/state.json');
    process.exit(1);
  }

  const mergedStatePath = path.resolve(args[0]);

  console.log('Loading jerry live state...');
  const jerryState = await StateCompression.loadCompressed(JERRY_STATE);
  const jerryNodes = jerryState.memory.nodes;
  const jerryEdges = jerryState.memory.edges;
  console.log(`  jerry: ${jerryNodes.length} nodes, ${jerryEdges.length} edges, cycle ${jerryState.cycleCount}`);

  console.log('Loading merged state...');
  const mergedState = await StateCompression.loadCompressed(mergedStatePath);
  const mergedNodes = mergedState.memory.nodes;
  const mergedEdges = mergedState.memory.edges;
  console.log(`  merged: ${mergedNodes.length} nodes, ${mergedEdges.length} edges`);

  // Identify jtr-sourced nodes via set difference
  const jerryNodeIds = new Set(jerryNodes.map(n => n.id));
  const jtrNodes = mergedNodes.filter(n => !jerryNodeIds.has(n.id));
  const jerryInMerged = mergedNodes.filter(n => jerryNodeIds.has(n.id));
  console.log(`  jtr-sourced nodes (new): ${jtrNodes.length}`);
  console.log(`  jerry nodes (kept/merged): ${jerryInMerged.length}`);

  // Compute weight normalization ratio
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
  const jerryMeanWeight = mean(jerryNodes.map(n => n.weight || 0.5));
  const jtrMeanWeight = jtrNodes.length > 0 ? mean(jtrNodes.map(n => n.weight || 0.5)) : jerryMeanWeight;
  const ratio = jerryMeanWeight / jtrMeanWeight;
  console.log(`  jerry mean weight: ${jerryMeanWeight.toFixed(4)}`);
  console.log(`  jtr mean weight: ${jtrMeanWeight.toFixed(4)}`);
  console.log(`  normalization ratio: ${ratio.toFixed(4)}`);

  // Normalize jtr node weights
  const jtrNodeIds = new Set(jtrNodes.map(n => n.id));
  let normalized = 0;
  for (const node of mergedNodes) {
    if (jtrNodeIds.has(node.id)) {
      node.weight = Math.min(1.0, Math.max(0.1, (node.weight || 0.5) * ratio));
      normalized++;
    }
  }
  console.log(`  normalized ${normalized} jtr node weights`);

  // Compute new nextNodeId (max of all node IDs + 1)
  const maxNodeId = mergedNodes.reduce((max, n) => Math.max(max, typeof n.id === 'number' ? n.id : 0), 0);
  const nextNodeId = Math.max(maxNodeId + 1, jerryState.memory.nextNodeId || 0);

  // Splice: replace only memory.nodes, memory.edges, nextNodeId
  jerryState.memory.nodes = mergedNodes;
  jerryState.memory.edges = mergedEdges;
  jerryState.memory.nextNodeId = nextNodeId;

  console.log(`\nSpliced state:`);
  console.log(`  nodes: ${jerryState.memory.nodes.length}`);
  console.log(`  edges: ${jerryState.memory.edges.length}`);
  console.log(`  nextNodeId: ${jerryState.memory.nextNodeId}`);
  console.log(`  cycleCount: ${jerryState.cycleCount} (preserved)`);
  console.log(`  timestamp: ${jerryState.timestamp} (preserved)`);

  // Save
  console.log('\nSaving spliced state...');
  await StateCompression.saveCompressed(JERRY_STATE, jerryState);
  console.log('Done. Jerry state spliced successfully.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script parses without errors**

Run:
```bash
cd /Users/jtr/_JTR23_/release/home23/engine
node -c scripts/splice-brain.js
```
Expected: no output (clean parse).

- [ ] **Step 3: Commit**

```bash
git add engine/scripts/splice-brain.js
git commit -m "Add one-shot brain splice script for jtr→jerry merge"
```

---

### Task 2: Backup jerry's brain

**Files:**
- None (operational step)

- [ ] **Step 1: Create pre-merge backup**

```bash
cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz \
   /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz.pre-merge-backup
```

- [ ] **Step 2: Verify backup**

```bash
ls -lh /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz*
```

Expected: two files, same size (~120MB each).

---

### Task 3: Stop jerry and set up merge

**Files:**
- None (operational step)

- [ ] **Step 1: Stop all jerry processes**

```bash
pm2 stop home23-jerry home23-jerry-dash home23-jerry-harness
```

Note: `home23-jerry-feeder` is a separate process — stop it too:
```bash
pm2 stop home23-jerry-feeder
```

- [ ] **Step 2: Verify all stopped**

```bash
pm2 list | grep home23-jerry
```

Expected: all four show `stopped`.

- [ ] **Step 3: Create engine/runs symlink structure**

```bash
mkdir -p /Users/jtr/_JTR23_/release/home23/engine/runs/jerry
mkdir -p /Users/jtr/_JTR23_/release/home23/engine/runs/jtr-source

ln -s /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz \
      /Users/jtr/_JTR23_/release/home23/engine/runs/jerry/state.json.gz

ln -s /Users/jtr/_JTR23_/cosmo-home/runs/jtr/state.json.gz \
      /Users/jtr/_JTR23_/release/home23/engine/runs/jtr-source/state.json.gz
```

- [ ] **Step 4: Verify merge script sees both runs**

```bash
cd /Users/jtr/_JTR23_/release/home23/engine
node scripts/merge_runs_v2.js --list
```

Expected: output lists `jerry` and `jtr-source` as available runs.

---

### Task 4: Run the merge

**Files:**
- None (uses existing script, produces output in `engine/runs/jerry-merged/`)

- [ ] **Step 1: Run merge_runs_v2.js**

```bash
cd /Users/jtr/_JTR23_/release/home23/engine
NODE_OPTIONS=--max-old-space-size=8192 node scripts/merge_runs_v2.js jerry jtr-source \
  --output jerry-merged \
  --threshold 0.85 \
  --policy BEST_REP \
  --verbose
```

Expected: completes without errors, reports merged node/edge counts.

- [ ] **Step 2: Read the merge report**

```bash
cat /Users/jtr/_JTR23_/release/home23/engine/runs/jerry-merged/MERGE_REPORT.md
```

Check:
- Output node count (expect ~18-20k)
- Deduplication count (how many jtr nodes merged vs added fresh)
- No errors or warnings

- [ ] **Step 3: Quick sanity check on merged state**

```bash
cd /Users/jtr/_JTR23_/release/home23/engine
NODE_OPTIONS=--max-old-space-size=8192 node -e "
const { StateCompression } = require('./src/core/state-compression');
(async () => {
  const s = await StateCompression.loadCompressed('runs/jerry-merged/state.json');
  const nodes = s.memory.nodes;
  const edges = s.memory.edges;
  console.log('Merged: ' + nodes.length + ' nodes, ' + edges.length + ' edges');
  console.log('Has mergeV2 metadata:', !!s.mergeV2);
})();
"
```

Expected: node count matches report, mergeV2 metadata present.

**STOP GATE: If node count is wildly off or errors occurred, do NOT proceed. Investigate.**

---

### Task 5: Run the splice

**Files:**
- Modifies: `instances/jerry/brain/state.json.gz` (via splice script)

- [ ] **Step 1: Run splice-brain.js**

```bash
cd /Users/jtr/_JTR23_/release/home23/engine
NODE_OPTIONS=--max-old-space-size=8192 node scripts/splice-brain.js runs/jerry-merged/state.json
```

Expected output:
```
Loading jerry live state...
  jerry: ~15537 nodes, ~30859 edges, cycle 1210
Loading merged state...
  merged: ~18-20k nodes, ~35-40k edges
  jtr-sourced nodes (new): ~3-4k
  jerry nodes (kept/merged): ~15-16k
  jerry mean weight: ~0.990
  jtr mean weight: ~0.969
  normalization ratio: ~1.02
  normalized ~3-4k jtr node weights

Spliced state:
  nodes: ~18-20k
  edges: ~35-40k
  nextNodeId: >= 32450
  cycleCount: 1210 (preserved)
  ...
Saving spliced state...
Done.
```

- [ ] **Step 2: Verify spliced state preserves jerry's life-state**

```bash
cd /Users/jtr/_JTR23_/release/home23/engine
NODE_OPTIONS=--max-old-space-size=8192 node -e "
const { StateCompression } = require('./src/core/state-compression');
(async () => {
  const s = await StateCompression.loadCompressed('../instances/jerry/brain/state.json');
  console.log('cycleCount:', s.cycleCount);
  console.log('nodes:', s.memory.nodes.length);
  console.log('edges:', s.memory.edges.length);
  console.log('nextNodeId:', s.memory.nextNodeId);
  console.log('journal entries:', (s.journal || []).length);
  console.log('has goals:', !!s.goals);
  console.log('has oscillator:', !!s.oscillator);
  console.log('has cognitiveState:', !!s.cognitiveState);
  console.log('has reflection:', !!s.reflection);
  console.log('timestamp:', s.timestamp);
})();
"
```

Expected: cycleCount=1210, nodes ~18-20k, all life-state keys present and non-empty.

**STOP GATE: If cycleCount is 0 or life-state keys are missing, the splice failed. Restore from backup:**
```bash
cp /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz.pre-merge-backup \
   /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/state.json.gz
```

---

### Task 6: Enable dreamMode and start dream integration

**Files:**
- Modify: `instances/jerry/config.yaml` (temporary dreamMode block)

- [ ] **Step 1: Add dreamMode config to jerry's config.yaml**

Add this block at the top level (after the existing keys, before the end of file):

```yaml
execution:
  dreamMode: true
  dreamModeSettings:
    preventWake: true
    disableConsolidationRateLimit: true
    continuousConsolidation: true
    dreamsPerCycle: 3
  maxCycles: 75
```

- [ ] **Step 2: Start only jerry's engine process**

```bash
pm2 start home23-jerry
```

Only the engine — not dash, harness, or feeder. Jerry should dream, not serve requests.

- [ ] **Step 3: Verify dreamMode is active**

```bash
pm2 logs home23-jerry --lines 20
```

Expected: logs show dream/sleep cycles starting, consolidation running, no errors loading state. Look for mentions of "dream", "consolidation", "sleep" in the output.

- [ ] **Step 4: Monitor dream integration (~40-75 min)**

Check progress periodically:
```bash
pm2 logs home23-jerry --lines 10
```

Look for:
- Consolidation summaries mentioning new concepts (jtr-related content being traversed)
- Hebbian reinforcement activity
- No OOM or crash errors
- Cycle count advancing

If jerry crashes (OOM or otherwise), check logs, restart with `pm2 start home23-jerry`. Dream cycles are idempotent — restarting is safe.

Tuning: if after 50 cycles logs show jtr nodes being traversed, integration is progressing well. If by cycle 40 consolidation is mostly touching existing jerry nodes, integration may have saturated early — safe to proceed to Task 7.

---

### Task 7: Disable dreamMode and resume normal operation

**Files:**
- Modify: `instances/jerry/config.yaml` (remove dreamMode block)

- [ ] **Step 1: Stop jerry's engine**

```bash
pm2 stop home23-jerry
```

- [ ] **Step 2: Remove dreamMode config from jerry's config.yaml**

Remove the entire `execution:` block that was added in Task 6:

```yaml
execution:
  dreamMode: true
  dreamModeSettings:
    preventWake: true
    disableConsolidationRateLimit: true
    continuousConsolidation: true
    dreamsPerCycle: 3
  maxCycles: 75
```

- [ ] **Step 3: Start all jerry processes**

```bash
pm2 start home23-jerry home23-jerry-dash home23-jerry-harness home23-jerry-feeder
```

- [ ] **Step 4: Verify clean startup**

```bash
pm2 logs home23-jerry --lines 30
```

Expected: engine starts normally, loads state without errors, begins regular cognitive cycles (not dream mode).

```bash
pm2 list | grep home23-jerry
```

Expected: all four processes `online`.

---

### Task 8: Verify the merge

**Files:**
- None (verification only)

- [ ] **Step 1: Check brain status via dashboard API**

```bash
curl -s http://localhost:5002/api/brain/status | python3 -m json.tool
```

Expected: node count in ~18-20k range, no errors.

- [ ] **Step 2: Query jtr-specific knowledge**

```bash
curl -s "http://localhost:5002/api/memory/search?q=grateful+dead+jtr" | python3 -m json.tool | head -30
```

Expected: returns nodes with jtr/Dead-related content, relevance scores > 0.

```bash
curl -s "http://localhost:5002/api/memory/search?q=shakedown+shuffle" | python3 -m json.tool | head -30
```

Expected: returns Shakedown Shuffle content from jtr brain.

- [ ] **Step 3: Verify jerry's existing knowledge still works**

```bash
curl -s "http://localhost:5002/api/memory/search?q=home23+dashboard+architecture" | python3 -m json.tool | head -30
```

Expected: returns Home23-related nodes (jerry's original knowledge intact).

- [ ] **Step 4: Commit the splice script (if not already committed in Task 1)**

```bash
git add engine/scripts/splice-brain.js
git commit -m "Add one-shot brain splice script for jtr→jerry merge"
```

---

### Task 9: Cleanup

**Files:**
- None (cleanup step)

- [ ] **Step 1: Remove temporary symlinks**

```bash
rm -rf /Users/jtr/_JTR23_/release/home23/engine/runs/jerry
rm -rf /Users/jtr/_JTR23_/release/home23/engine/runs/jtr-source
```

- [ ] **Step 2: Keep jerry-merged as archive (do not delete)**

The `engine/runs/jerry-merged/` directory contains the merge report and merged state. Keep it for at least a week as reference.

- [ ] **Step 3: Keep backup for at least a week**

`instances/jerry/brain/state.json.gz.pre-merge-backup` stays. Remove after a week of confirmed stable operation.

- [ ] **Step 4: Add engine/runs/ to .gitignore if not already present**

Check:
```bash
grep 'engine/runs' /Users/jtr/_JTR23_/release/home23/.gitignore
```

If not present:
```bash
echo 'engine/runs/' >> /Users/jtr/_JTR23_/release/home23/.gitignore
git add .gitignore
git commit -m "Ignore engine/runs/ (merge working directory)"
```
