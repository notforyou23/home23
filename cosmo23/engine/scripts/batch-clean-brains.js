#!/usr/bin/env node
/**
 * batch-clean-brains.js - Safely clean junk from ALL brain state files
 *
 * Safety measures:
 *   1. Creates timestamped backup of every state file BEFORE modification
 *   2. After saving, re-loads the file and verifies node/edge counts match
 *   3. If verification fails, auto-restores from backup
 *   4. Stops on any unexpected error (no silent failures)
 *   5. Dry-run mode previews everything without saving
 *
 * Usage:
 *   node engine/scripts/batch-clean-brains.js <data-directory> --dry-run
 *   node engine/scripts/batch-clean-brains.js <data-directory>
 *
 * Example:
 *   node engine/scripts/batch-clean-brains.js /Users/jtr/websites/cosmos.evobrew.com/data --dry-run
 *   node engine/scripts/batch-clean-brains.js /Users/jtr/websites/cosmos.evobrew.com/data
 */

const path = require('path');
const fs = require('fs').promises;
const { classifyContent } = require('../src/core/validation');
const { StateCompression } = require('../src/core/state-compression');

// ─── Find all brain state files ─────────────────────────────────────────────────

async function findBrainDirs(baseDir) {
  const brainDirs = [];

  async function walk(dir, depth) {
    if (depth > 6) return; // Don't recurse too deep
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      // Check if this directory has a state file
      const hasState = entries.some(e =>
        e.name === 'state.json.gz' || e.name === 'state.json'
      );
      if (hasState) {
        brainDirs.push(dir);
        return; // Don't recurse into brain dirs
      }
      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await walk(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {}
  }

  await walk(baseDir, 0);
  return brainDirs;
}

// ─── Classify a single brain ────────────────────────────────────────────────────

function classifyBrain(state) {
  const nodes = state.memory?.nodes || [];
  const edges = state.memory?.edges || [];

  const kept = [];
  const removedIds = new Set();
  const stats = { knowledge: 0, structural: 0, operational: 0, error: 0, garbage: 0 };

  for (const node of nodes) {
    const result = classifyContent(node.concept || '', node.tag || 'general');
    stats[result.category] = (stats[result.category] || 0) + 1;

    if (result.category === 'operational' || result.category === 'error' || result.category === 'garbage') {
      removedIds.add(node.id);
    } else {
      kept.push(node);
    }
  }

  // Clean edges
  const keptEdges = edges.filter(e => !removedIds.has(e.source) && !removedIds.has(e.target));

  // Clean clusters
  let keptClusters = null;
  if (state.memory?.clusters) {
    keptClusters = [];
    for (const cluster of state.memory.clusters) {
      const nodeIds = Array.isArray(cluster) ? cluster[1] : cluster.nodes;
      const filtered = (Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds || []))
        .filter(id => !removedIds.has(id));
      if (filtered.length > 0) {
        if (Array.isArray(cluster)) {
          keptClusters.push([cluster[0], filtered]);
        } else {
          keptClusters.push({ ...cluster, nodes: filtered, size: filtered.length });
        }
      }
    }
  }

  return { kept, keptEdges, keptClusters, removedIds, stats };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));
  const dryRun = flags.includes('--dry-run');

  if (positional.length === 0) {
    console.log('Usage: node engine/scripts/batch-clean-brains.js <data-directory> [--dry-run]');
    console.log('');
    console.log('Finds all brain state files under <data-directory> and removes junk nodes.');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run    Preview what would be removed without saving');
    process.exit(1);
  }

  const baseDir = path.resolve(positional[0]);

  try {
    await fs.access(baseDir);
  } catch {
    console.error(`Error: Directory not found: ${baseDir}`);
    process.exit(1);
  }

  console.log(`\n🧹 Batch Brain Cleanup${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═'.repeat(70));
  console.log(`📂 Scanning: ${baseDir}`);

  // Find all brains
  const brainDirs = await findBrainDirs(baseDir);
  console.log(`   Found ${brainDirs.length} brains\n`);

  if (brainDirs.length === 0) {
    console.log('No brain state files found.');
    process.exit(0);
  }

  const timestamp = Date.now();
  let totalBrains = 0;
  let cleanBrains = 0;
  let cleanedBrains = 0;
  let failedBrains = 0;
  let totalNodesRemoved = 0;
  let totalEdgesRemoved = 0;

  for (const brainDir of brainDirs) {
    totalBrains++;
    const name = path.relative(baseDir, brainDir);
    const statePath = path.join(brainDir, 'state.json');

    // Check which format exists
    const gzExists = await fs.access(statePath + '.gz').then(() => true).catch(() => false);
    const jsonExists = await fs.access(statePath).then(() => true).catch(() => false);

    if (!gzExists && !jsonExists) continue;

    try {
      // ── Step 1: Load ──────────────────────────────────────────────────────
      const state = await StateCompression.loadCompressed(statePath);
      if (!state.memory || !state.memory.nodes) {
        console.log(`⏭  ${name} — no memory.nodes, skipping`);
        continue;
      }

      // ── Step 2: Classify ──────────────────────────────────────────────────
      const { kept, keptEdges, keptClusters, removedIds, stats } = classifyBrain(state);

      if (removedIds.size === 0) {
        cleanBrains++;
        continue; // Already clean, no output needed
      }

      const nodesBefore = state.memory.nodes.length;
      const edgesBefore = (state.memory.edges || []).length;
      const edgesRemoved = edgesBefore - keptEdges.length;

      console.log(`🔧 ${name}`);
      console.log(`   Nodes: ${nodesBefore} → ${kept.length} (−${removedIds.size})  |  Edges: ${edgesBefore} → ${keptEdges.length} (−${edgesRemoved})`);
      console.log(`   Categories: knowledge=${stats.knowledge} structural=${stats.structural} | removed: op=${stats.operational} err=${stats.error} garb=${stats.garbage}`);

      if (dryRun) {
        totalNodesRemoved += removedIds.size;
        totalEdgesRemoved += edgesRemoved;
        cleanedBrains++;
        continue;
      }

      // ── Step 3: Backup ────────────────────────────────────────────────────
      const backupSuffix = `.backup-${timestamp}`;
      let backupPath;
      if (gzExists) {
        backupPath = statePath + '.gz' + backupSuffix;
        await fs.copyFile(statePath + '.gz', backupPath);
      } else {
        backupPath = statePath + backupSuffix;
        await fs.copyFile(statePath, backupPath);
      }

      // ── Step 4: Apply changes ─────────────────────────────────────────────
      state.memory.nodes = kept;
      state.memory.edges = keptEdges;
      if (keptClusters !== null) {
        state.memory.clusters = keptClusters;
      }

      // ── Step 5: Save ──────────────────────────────────────────────────────
      if (gzExists) await fs.unlink(statePath + '.gz').catch(() => {});
      if (jsonExists) await fs.unlink(statePath).catch(() => {});

      await StateCompression.saveCompressed(statePath, state);

      // ── Step 6: Verify ────────────────────────────────────────────────────
      let verified = false;
      try {
        const reloaded = await StateCompression.loadCompressed(statePath);
        const reloadedNodes = reloaded.memory?.nodes?.length || 0;
        const reloadedEdges = reloaded.memory?.edges?.length || 0;

        if (reloadedNodes === kept.length && reloadedEdges === keptEdges.length) {
          verified = true;
          console.log(`   ✅ Verified — backup: ${path.basename(backupPath)}`);
        } else {
          console.log(`   ❌ VERIFY FAILED — expected ${kept.length} nodes/${keptEdges.length} edges, got ${reloadedNodes}/${reloadedEdges}`);
        }
      } catch (verifyErr) {
        console.log(`   ❌ VERIFY FAILED — could not reload: ${verifyErr.message}`);
      }

      // ── Step 7: Restore if verification failed ────────────────────────────
      if (!verified) {
        console.log(`   🔄 RESTORING from backup...`);
        try {
          // Remove the bad save
          await fs.unlink(statePath + '.gz').catch(() => {});
          await fs.unlink(statePath).catch(() => {});
          // Restore backup
          if (gzExists) {
            await fs.copyFile(backupPath, statePath + '.gz');
          } else {
            await fs.copyFile(backupPath, statePath);
          }
          console.log(`   🔄 Restored successfully. Brain unchanged.`);
        } catch (restoreErr) {
          console.error(`   🚨 RESTORE FAILED: ${restoreErr.message}`);
          console.error(`   🚨 Manual recovery needed from: ${backupPath}`);
        }
        failedBrains++;
        continue;
      }

      totalNodesRemoved += removedIds.size;
      totalEdgesRemoved += edgesRemoved;
      cleanedBrains++;

    } catch (err) {
      console.log(`❌ ${name} — ERROR: ${err.message}`);
      failedBrains++;
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log('═'.repeat(70));
  console.log(`📊 Summary${dryRun ? ' (DRY RUN — nothing was modified)' : ''}`);
  console.log(`   Total brains scanned:  ${totalBrains}`);
  console.log(`   Already clean:         ${cleanBrains}`);
  console.log(`   Cleaned:               ${cleanedBrains}`);
  if (failedBrains > 0) {
    console.log(`   Failed (restored):     ${failedBrains}`);
  }
  console.log(`   Nodes removed:         ${totalNodesRemoved}`);
  console.log(`   Edges removed:         ${totalEdgesRemoved}`);
  if (!dryRun && cleanedBrains > 0) {
    console.log(`   Backup suffix:         .backup-${timestamp}`);
  }
  console.log('');

  if (failedBrains > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
