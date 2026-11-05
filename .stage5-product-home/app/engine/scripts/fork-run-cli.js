#!/usr/bin/env node
/**
 * CLI wrapper for RunManager.forkRun
 * Used by LAUNCH_COSMO.sh to ensure consistent fork behavior
 * 
 * Usage: node scripts/fork-run-cli.js <source_run> <new_run_name>
 */

const path = require('path');
const { RunManager } = require('../src/launcher/run-manager');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node scripts/fork-run-cli.js <source_run> <new_run_name>');
    process.exit(1);
  }
  
  const [sourceRun, newRunName] = args;
  const runsDir = path.join(__dirname, '..', 'runs');
  
  const runManager = new RunManager(runsDir, console);
  
  try {
    const result = await runManager.forkRun(sourceRun, newRunName);
    
    if (result.success) {
      console.log(`✓ Forked ${sourceRun} → ${newRunName}`);
      process.exit(0);
    } else {
      console.error(`✗ Fork failed: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`✗ Fork failed: ${error.message}`);
    process.exit(1);
  }
}

main();

