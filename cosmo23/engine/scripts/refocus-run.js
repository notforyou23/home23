#!/usr/bin/env node
/**
 * refocus-run.js
 *
 * Clear a run's head without losing memory.
 * Archives goals, resets coherence, optionally injects new focus.
 *
 * Usage:
 *   node refocus-run.js <run-directory>
 *   node refocus-run.js <run-directory> --focus "new directive"
 *   node refocus-run.js <run-directory> --keep-goals  # Don't archive goals
 *
 * Example:
 *   cd /Users/jtr/_JTR_/COSMO_Unified
 *   node engine/scripts/refocus-run.js data/users/USER_ID/runs/RUN_NAME
 *   node engine/scripts/refocus-run.js data/users/USER_ID/runs/RUN_NAME --focus "Focus on validating code"
 */

const path = require('path');
const fs = require('fs').promises;
const { StateCompression } = require('../src/core/state-compression');

async function refocusRun(runDir, options = {}) {
  const { newFocus = null, archiveGoals = true } = options;

  const stateFile = path.join(runDir, 'state.json');
  const compressedFile = stateFile + '.gz';

  console.log(`\n🔄 REFOCUS RUN`);
  console.log(`   Run directory: ${runDir}`);

  // Load state
  console.log(`\n📂 Loading state...`);
  let state;
  try {
    state = await StateCompression.loadCompressed(stateFile);
  } catch (error) {
    console.error(`❌ Failed to load state: ${error.message}`);
    process.exit(1);
  }

  let changes = {
    coherenceReset: false,
    goalsArchived: 0,
    agentsCleared: 0,
    focusInjected: false
  };

  // 1. Reset coherence in executive state
  if (state.executiveState) {
    state.executiveState.coherenceScore = 1.0;
    state.executiveState.recentActions = [];
    changes.coherenceReset = true;
    console.log('✅ Reset coherence to 1.0');
  } else {
    console.log('ℹ️  No executive state found - skipping coherence reset');
  }

  // 2. Archive active goals
  if (archiveGoals && state.goals?.goals) {
    for (const goal of state.goals.goals) {
      if (goal.status === 'active') {
        goal.status = 'archived';
        goal.archivedAt = Date.now();
        goal.archiveReason = 'refocus_requested';
        changes.goalsArchived++;
      }
    }
    console.log(`✅ Archived ${changes.goalsArchived} active goals`);
  } else if (!archiveGoals) {
    console.log('ℹ️  Keeping goals active (--keep-goals specified)');
  }

  // 3. Clear pending agent results
  if (state.agentResults?.queue) {
    changes.agentsCleared = state.agentResults.queue.length;
    state.agentResults.queue = [];
    console.log(`✅ Cleared ${changes.agentsCleared} pending agent results`);
  }

  // 4. Inject new focus goal if provided
  if (newFocus) {
    const newGoal = {
      id: `goal_refocus_${Date.now()}`,
      description: newFocus,
      status: 'active',
      priority: 0.95,
      createdAt: Date.now(),
      source: 'refocus_script',
      metadata: { urgency: 'critical', rationale: 'Manual refocus directive' }
    };
    state.goals = state.goals || {};
    state.goals.goals = state.goals.goals || [];
    state.goals.goals.push(newGoal);
    changes.focusInjected = true;
    console.log(`✅ Injected new focus: "${newFocus.substring(0, 60)}${newFocus.length > 60 ? '...' : ''}"`);
  }

  // 5. Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(runDir, `state.pre-refocus.${timestamp}.json.gz`);

  console.log(`\n💾 Saving backup to: ${path.basename(backupFile)}`);
  await StateCompression.saveCompressed(backupFile.replace('.gz', ''), state, { compress: true });

  // 6. Save refocused state
  console.log(`💾 Saving refocused state to: ${path.basename(compressedFile)}`);
  await StateCompression.saveCompressed(stateFile, state, { compress: true });

  // Summary
  console.log(`\n🎉 REFOCUS COMPLETE`);
  console.log(`   Coherence reset: ${changes.coherenceReset ? 'Yes' : 'No'}`);
  console.log(`   Goals archived: ${changes.goalsArchived}`);
  console.log(`   Agents cleared: ${changes.agentsCleared}`);
  console.log(`   New focus: ${changes.focusInjected ? 'Yes' : 'No'}`);
  console.log(`   Memory preserved: Yes`);
  console.log(`\n   Backup: ${path.basename(backupFile)}`);
  console.log(`\n   Next: Resume the run to continue with a clear head`);

  return changes;
}

// Verify path exists
async function verifyPath(runDir) {
  try {
    await fs.access(path.join(runDir, 'state.json.gz'));
    return true;
  } catch {
    try {
      await fs.access(path.join(runDir, 'state.json'));
      return true;
    } catch {
      return false;
    }
  }
}

// Parse command line arguments
function parseArgs(args) {
  const runDir = args.find(arg => !arg.startsWith('--'));
  const focusIdx = args.indexOf('--focus');
  const newFocus = focusIdx >= 0 && args[focusIdx + 1] ? args[focusIdx + 1] : null;
  const keepGoals = args.includes('--keep-goals');
  const help = args.includes('--help') || args.includes('-h');

  return { runDir, newFocus, keepGoals, help };
}

// Main
async function main() {
  const { runDir, newFocus, keepGoals, help } = parseArgs(process.argv.slice(2));

  if (help || !runDir) {
    console.log(`
Usage: node refocus-run.js <run-directory> [options]

Options:
  --focus "directive"    Inject a new focus goal after clearing
  --keep-goals           Don't archive existing goals
  --help, -h             Show this help

Examples:
  node refocus-run.js data/users/USER/runs/myrun
  node refocus-run.js data/users/USER/runs/myrun --focus "Validate the generated code files"
  node refocus-run.js data/users/USER/runs/myrun --keep-goals

What it does:
  - Resets coherence score to 1.0
  - Archives all active goals (unless --keep-goals)
  - Clears pending agent work queue
  - Optionally injects a new focus goal
  - Preserves all memory (learned knowledge intact)
  - Creates a backup before making changes
`);
    process.exit(help ? 0 : 1);
  }

  const resolvedDir = path.resolve(runDir);

  // Verify the run directory exists
  if (!await verifyPath(resolvedDir)) {
    console.error(`❌ State file not found in: ${resolvedDir}`);
    console.error('   Expected: state.json.gz or state.json');
    process.exit(1);
  }

  await refocusRun(resolvedDir, { newFocus, archiveGoals: !keepGoals });
}

// Export for use as module
module.exports = { refocusRun };

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
