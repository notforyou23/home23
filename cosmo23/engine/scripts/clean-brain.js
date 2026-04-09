#!/usr/bin/env node
/**
 * clean-brain.js - Remove junk from existing brain state files
 *
 * Loads a brain's state.json.gz, classifies every memory node using the
 * quality gate, removes operational/error/garbage nodes (+ their edges),
 * and saves back with a backup.
 *
 * Usage:
 *   node engine/scripts/clean-brain.js <run-directory>
 *   node engine/scripts/clean-brain.js <run-directory> --dry-run
 *   node engine/scripts/clean-brain.js <run-directory> --journals
 *   node engine/scripts/clean-brain.js <run-directory> --dry-run --journals
 */

const path = require('path');
const fs = require('fs').promises;
const { classifyContent } = require('../src/core/validation');
const { StateCompression } = require('../src/core/state-compression');

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));

  const dryRun = flags.includes('--dry-run');
  const cleanJournals = flags.includes('--journals');

  if (positional.length === 0) {
    console.log('Usage: node engine/scripts/clean-brain.js <run-directory> [--dry-run] [--journals]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run    Preview what would be removed without saving');
    console.log('  --journals   Also clean findings.jsonl and insights.jsonl in agent dirs');
    process.exit(1);
  }

  const runDir = path.resolve(positional[0]);
  const statePath = path.join(runDir, 'state.json');

  // Verify run directory exists
  try {
    await fs.access(runDir);
  } catch {
    console.error(`Error: Run directory not found: ${runDir}`);
    process.exit(1);
  }

  // Verify state file exists
  const gzExists = await fs.access(statePath + '.gz').then(() => true).catch(() => false);
  const jsonExists = await fs.access(statePath).then(() => true).catch(() => false);

  if (!gzExists && !jsonExists) {
    console.error(`Error: No state file found at ${statePath} or ${statePath}.gz`);
    process.exit(1);
  }

  console.log(`\n🧹 Brain Cleanup${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('─'.repeat(60));
  console.log(`📂 Run directory: ${runDir}`);

  // Load state
  console.log('📥 Loading state...');
  const state = await StateCompression.loadCompressed(statePath);

  if (!state.memory || !state.memory.nodes) {
    console.error('Error: State file has no memory.nodes');
    process.exit(1);
  }

  const nodesBefore = state.memory.nodes.length;
  const edgesBefore = state.memory.edges ? state.memory.edges.length : 0;

  console.log(`   Nodes: ${nodesBefore}`);
  console.log(`   Edges: ${edgesBefore}`);
  console.log('');

  // Classify every node
  console.log('🔍 Classifying nodes...');
  const removedIds = new Set();
  const kept = [];
  const stats = { knowledge: 0, structural: 0, operational: 0, error: 0, garbage: 0 };

  for (const node of state.memory.nodes) {
    const result = classifyContent(node.concept || '', node.tag || 'general');
    stats[result.category] = (stats[result.category] || 0) + 1;

    if (result.category === 'operational' || result.category === 'error' || result.category === 'garbage') {
      removedIds.add(node.id);
      if (dryRun && removedIds.size <= 20) {
        const preview = (node.concept || '').substring(0, 70).replace(/\n/g, ' ');
        console.log(`   ✗ [${result.category}] (${node.tag}) ${preview}`);
      }
    } else {
      kept.push(node);
    }
  }

  if (dryRun && removedIds.size > 20) {
    console.log(`   ... and ${removedIds.size - 20} more`);
  }

  // Clean edges
  let edgesRemoved = 0;
  const keptEdges = [];
  if (state.memory.edges) {
    for (const edge of state.memory.edges) {
      if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
        edgesRemoved++;
      } else {
        keptEdges.push(edge);
      }
    }
  }

  // Clean clusters
  let clustersRemoved = 0;
  const keptClusters = [];
  if (state.memory.clusters) {
    for (const cluster of state.memory.clusters) {
      // Clusters can be {id, size, nodes} objects or [id, nodeIds] tuples
      const nodeIds = Array.isArray(cluster) ? cluster[1] : cluster.nodes;
      const filtered = (Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds || []))
        .filter(id => !removedIds.has(id));
      if (filtered.length > 0) {
        if (Array.isArray(cluster)) {
          keptClusters.push([cluster[0], filtered]);
        } else {
          keptClusters.push({ ...cluster, nodes: filtered, size: filtered.length });
        }
      } else {
        clustersRemoved++;
      }
    }
  }

  // Report
  console.log('');
  console.log('📊 Results:');
  console.log(`   Categories: knowledge=${stats.knowledge}, structural=${stats.structural}, operational=${stats.operational}, error=${stats.error}, garbage=${stats.garbage}`);
  console.log(`   Nodes:    ${nodesBefore} → ${kept.length} (removed ${removedIds.size})`);
  console.log(`   Edges:    ${edgesBefore} → ${keptEdges.length} (removed ${edgesRemoved})`);
  if (state.memory.clusters) {
    console.log(`   Clusters: ${state.memory.clusters.length} → ${keptClusters.length} (removed ${clustersRemoved})`);
  }
  console.log(`   Reduction: ${((removedIds.size / nodesBefore) * 100).toFixed(1)}% of nodes removed`);

  if (dryRun) {
    console.log('\n⚠️  Dry run - no changes saved.');

    if (cleanJournals) {
      await previewJournalCleanup(runDir);
    }

    process.exit(0);
  }

  // Create backup
  console.log('\n💾 Creating backup...');
  const timestamp = Date.now();
  const backupName = `state.json.gz.backup-${timestamp}`;
  if (gzExists) {
    await fs.copyFile(statePath + '.gz', path.join(runDir, backupName));
    console.log(`   Backup: ${backupName}`);
  } else {
    await fs.copyFile(statePath, path.join(runDir, `state.json.backup-${timestamp}`));
    console.log(`   Backup: state.json.backup-${timestamp}`);
  }

  // Apply changes
  state.memory.nodes = kept;
  state.memory.edges = keptEdges;
  if (state.memory.clusters) {
    state.memory.clusters = keptClusters;
  }

  // Save
  console.log('💾 Saving cleaned state...');

  // Remove old files before saving (saveCompressed adds .gz automatically)
  if (gzExists) await fs.unlink(statePath + '.gz').catch(() => {});
  if (jsonExists) await fs.unlink(statePath).catch(() => {});

  const result = await StateCompression.saveCompressed(statePath, state);
  console.log(`   Saved: ${(result.size / 1024).toFixed(1)}KB compressed`);

  // Clean journals if requested
  if (cleanJournals) {
    await cleanJournalFiles(runDir);
  }

  console.log('\n✅ Brain cleanup complete!');
}

async function previewJournalCleanup(runDir) {
  const agentsDir = path.join(runDir, 'agents');
  try {
    await fs.access(agentsDir);
  } catch {
    console.log('\n   No agents/ directory found for journal cleanup.');
    return;
  }

  const agents = await fs.readdir(agentsDir);
  let totalFiltered = 0;
  let totalKept = 0;

  for (const agentId of agents) {
    for (const journalName of ['findings.jsonl', 'insights.jsonl']) {
      const journalPath = path.join(agentsDir, agentId, journalName);
      try {
        const content = await fs.readFile(journalPath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const result = classifyContent(entry.content || '', entry.tag || 'general');
            if (result.category === 'operational' || result.category === 'error' || result.category === 'garbage') {
              totalFiltered++;
            } else {
              totalKept++;
            }
          } catch { totalKept++; }
        }
      } catch { /* file doesn't exist */ }
    }
  }

  if (totalFiltered > 0 || totalKept > 0) {
    console.log(`\n   Journals: would keep ${totalKept}, remove ${totalFiltered} entries`);
  }
}

async function cleanJournalFiles(runDir) {
  const agentsDir = path.join(runDir, 'agents');
  try {
    await fs.access(agentsDir);
  } catch {
    return;
  }

  console.log('\n📝 Cleaning journal files...');
  const agents = await fs.readdir(agentsDir);
  let totalFiltered = 0;
  let totalKept = 0;

  for (const agentId of agents) {
    for (const journalName of ['findings.jsonl', 'insights.jsonl']) {
      const journalPath = path.join(agentsDir, agentId, journalName);
      try {
        const content = await fs.readFile(journalPath, 'utf8');
        const lines = content.trim().split('\n').filter(l => l.trim());
        const kept = [];

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const result = classifyContent(entry.content || '', entry.tag || 'general');
            if (result.category === 'operational' || result.category === 'error' || result.category === 'garbage') {
              totalFiltered++;
            } else {
              kept.push(line);
              totalKept++;
            }
          } catch {
            kept.push(line); // Keep unparseable lines
            totalKept++;
          }
        }

        if (kept.length < lines.length) {
          await fs.writeFile(journalPath, kept.join('\n') + '\n', 'utf8');
        }
      } catch { /* file doesn't exist */ }
    }
  }

  console.log(`   Journal entries: kept ${totalKept}, removed ${totalFiltered}`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
