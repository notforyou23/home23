#!/usr/bin/env node
/**
 * patch-memory-paths.js
 *
 * Patches memory nodes in a run's state.json.gz to add absolute paths
 * for code_creation_output_files entries.
 *
 * This fixes the "code without grounding" issue where files exist on disk
 * but CodeExecutionAgent can't find them because memory stores relative paths.
 *
 * Usage: node patch-memory-paths.js <run-directory>
 *
 * Example:
 *   cd /Users/jtr/_JTR_/COSMO_Unified
 *   node engine/scripts/patch-memory-paths.js data/users/cmjtizyn80000aulpahd0pfk5/runs/thoughts
 */

const path = require('path');
const fs = require('fs').promises;
const { StateCompression } = require('../src/core/state-compression');

async function patchMemoryPaths(runDir) {
  const stateFile = path.join(runDir, 'state.json');
  const compressedFile = stateFile + '.gz';

  console.log(`\n🔧 Memory Path Patcher`);
  console.log(`   Run directory: ${runDir}`);
  console.log(`   State file: ${compressedFile}`);

  // Load state
  console.log(`\n📂 Loading state...`);
  let state;
  try {
    state = await StateCompression.loadCompressed(stateFile);
  } catch (error) {
    console.error(`❌ Failed to load state: ${error.message}`);
    process.exit(1);
  }

  if (!state?.memory?.nodes || !Array.isArray(state.memory.nodes)) {
    console.error('❌ No memory nodes found in state (expected state.memory.nodes array)');
    process.exit(1);
  }

  console.log(`   Found ${state.memory.nodes.length} memory nodes`);
  console.log(`   Found ${state.memory.edges?.length || 0} edges`);

  // Find and patch code_creation_output_files nodes
  let patchedCount = 0;
  let fileCount = 0;
  const nodes = state.memory.nodes;

  for (const node of nodes) {
    if (node.tag !== 'code_creation_output_files') continue;

    try {
      // Extract JSON from concept (may have [AGENT: xxx] prefix)
      let conceptJson = node.concept;
      let prefix = '';

      // Check for [AGENT: xxx] prefix pattern
      const prefixMatch = conceptJson.match(/^(\[AGENT: [^\]]+\]\s*)/);
      if (prefixMatch) {
        prefix = prefixMatch[1];
        conceptJson = conceptJson.slice(prefix.length);
      }

      // Parse the JSON data
      const data = JSON.parse(conceptJson);
      if (!data.files || !Array.isArray(data.files)) continue;

      let modified = false;
      for (const file of data.files) {
        // Always recalculate path - don't trust existing path field
        // (it may have been incorrectly generated)

        // Get the relative path
        const relativePath = file.relativePath || file.filePath;
        if (!relativePath) continue;

        // Convert to absolute path
        let absolutePath;
        if (path.isAbsolute(relativePath)) {
          absolutePath = relativePath;
        } else {
          // The relative paths from code-creation-agent are relative to process.cwd()
          // which is typically the COSMO_Unified root. Find the project root.
          // Paths look like: ../data/users/.../runs/thoughts/outputs/...
          // or: data/users/.../runs/thoughts/outputs/...

          // Strategy: Find the project root by looking for 'data/users' in the path
          // and constructing the absolute path correctly
          if (relativePath.includes('data/users/')) {
            // Extract the part starting from 'data/users/'
            const dataIndex = relativePath.indexOf('data/users/');
            const dataRelative = relativePath.substring(dataIndex);

            // Find project root (parent of data/)
            const runDirParts = runDir.split(path.sep);
            const dataIdx = runDirParts.indexOf('data');
            if (dataIdx > 0) {
              const projectRoot = runDirParts.slice(0, dataIdx).join(path.sep);
              absolutePath = path.join(projectRoot, dataRelative);
            } else {
              // Fallback: resolve from run directory
              absolutePath = path.resolve(runDir, relativePath);
            }
          } else {
            // Resolve from run directory for other relative paths
            absolutePath = path.resolve(runDir, relativePath);
          }
        }

        // Add the absolute path field
        file.path = absolutePath;
        modified = true;
        fileCount++;
      }

      if (modified) {
        // Reconstruct the concept string with prefix
        node.concept = prefix + JSON.stringify(data);
        patchedCount++;
      }
    } catch (e) {
      // Skip nodes that don't parse as expected
      continue;
    }
  }

  console.log(`\n✅ Patched ${patchedCount} memory nodes (${fileCount} file entries)`);

  if (patchedCount === 0) {
    console.log(`\nℹ️  No nodes needed patching - all paths may already be absolute`);
    return;
  }

  // Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(runDir, `state.backup.${timestamp}.json.gz`);

  console.log(`\n💾 Saving backup to: ${backupFile}`);
  await StateCompression.saveCompressed(backupFile.replace('.gz', ''), state, { compress: true });

  // Save patched state
  console.log(`💾 Saving patched state to: ${compressedFile}`);
  await StateCompression.saveCompressed(stateFile, state, { compress: true });

  console.log(`\n🎉 Done! The run's memory has been patched.`);
  console.log(`   Backup saved to: ${backupFile}`);
  console.log(`\n   Next steps:`);
  console.log(`   1. Resume the run to verify files can be discovered`);
  console.log(`   2. If issues occur, restore from backup: cp ${backupFile} ${compressedFile}`);
}

// Verify file exists
async function verifyPath(runDir) {
  const stateFile = path.join(runDir, 'state.json.gz');
  try {
    await fs.access(stateFile);
    return true;
  } catch {
    // Try uncompressed
    try {
      await fs.access(path.join(runDir, 'state.json'));
      return true;
    } catch {
      return false;
    }
  }
}

// Main
async function main() {
  const runDir = process.argv[2];

  if (!runDir) {
    console.error('Usage: node patch-memory-paths.js <run-directory>');
    console.error('');
    console.error('Example:');
    console.error('  node engine/scripts/patch-memory-paths.js data/users/USER_ID/runs/RUN_NAME');
    process.exit(1);
  }

  const resolvedDir = path.resolve(runDir);

  // Verify the run directory exists and has state file
  if (!await verifyPath(resolvedDir)) {
    console.error(`❌ State file not found in: ${resolvedDir}`);
    console.error('   Expected: state.json.gz or state.json');
    process.exit(1);
  }

  await patchMemoryPaths(resolvedDir);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
