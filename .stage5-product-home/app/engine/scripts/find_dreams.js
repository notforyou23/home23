#!/usr/bin/env node
/**
 * Find all runs that contain dreams
 * Dreams are stored as:
 * 1. Goals with source='dream_gpt5' or source='dream' in state.json.gz
 * 2. Memory nodes with tag='dream' in state.json.gz
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const runsDir = path.join(__dirname, '..', 'runs');
const runtimeDir = path.join(__dirname, '..', 'runtime');

async function loadState(runPath) {
  const stateFile = path.join(runPath, 'state.json.gz');
  const stateFileUncompressed = path.join(runPath, 'state.json');
  
  try {
    let content;
    if (fs.existsSync(stateFile)) {
      const compressed = fs.readFileSync(stateFile);
      content = await gunzip(compressed);
    } else if (fs.existsSync(stateFileUncompressed)) {
      content = fs.readFileSync(stateFileUncompressed);
    } else {
      return null;
    }
    
    return JSON.parse(content.toString());
  } catch (error) {
    console.error(`  Error loading state for ${runPath}:`, error.message);
    return null;
  }
}

function extractDreams(state) {
  const dreams = {
    fromGoals: [],
    fromMemory: []
  };
  
  // Extract dreams from goals
  if (state.goals) {
    const allGoals = [
      ...(Array.isArray(state.goals.active) ? state.goals.active : []),
      ...(state.goals.completed || []),
      ...(state.goals.archived || [])
    ];
    
    allGoals.forEach(goalEntry => {
      const goal = Array.isArray(goalEntry) ? goalEntry[1] : goalEntry;
      if (!goal) return;
      
      if (goal.source === 'dream_gpt5' || goal.source === 'dream') {
        dreams.fromGoals.push({
          id: goal.id,
          description: goal.description,
          timestamp: goal.created || goal.lastPursued,
          completed: !!goal.completedAt,
          source: goal.source
        });
      }
    });
  }
  
  // Extract dreams from memory nodes
  if (state.memory && state.memory.nodes) {
    state.memory.nodes.forEach(node => {
      if (node.tag === 'dream' || (node.tags && node.tags.includes('dream'))) {
        dreams.fromMemory.push({
          id: node.id,
          concept: node.concept,
          timestamp: node.created || node.accessed,
          activation: node.activation
        });
      }
    });
  }
  
  return dreams;
}

async function scanRun(runName, runPath) {
  const state = await loadState(runPath);
  if (!state) {
    return null;
  }
  
  const dreams = extractDreams(state);
  const totalDreams = dreams.fromGoals.length + dreams.fromMemory.length;
  
  if (totalDreams === 0) {
    return null;
  }
  
  return {
    runName,
    runPath,
    dreams: {
      total: totalDreams,
      fromGoals: dreams.fromGoals.length,
      fromMemory: dreams.fromMemory.length,
      goals: dreams.fromGoals,
      memory: dreams.fromMemory
    }
  };
}

async function findAllDreams() {
  console.log('🔍 Scanning for dreams in all runs...\n');
  
  const results = [];
  
  // Scan runtime
  console.log('📁 Scanning runtime...');
  const runtimeResult = await scanRun('runtime', runtimeDir);
  if (runtimeResult) {
    results.push(runtimeResult);
    console.log(`  ✅ Found ${runtimeResult.dreams.total} dreams`);
  } else {
    console.log('  ❌ No dreams found');
  }
  
  // Scan all runs
  if (!fs.existsSync(runsDir)) {
    console.log(`\n⚠️  Runs directory not found: ${runsDir}`);
    return results;
  }
  
  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .sort();
  
  console.log(`\n📁 Scanning ${runDirs.length} runs...\n`);
  
  for (const runName of runDirs) {
    const runPath = path.join(runsDir, runName);
    const result = await scanRun(runName, runPath);
    
    if (result) {
      results.push(result);
      console.log(`✅ ${runName}: ${result.dreams.total} dreams (${result.dreams.fromGoals} goals, ${result.dreams.fromMemory} memory)`);
    }
  }
  
  return results;
}

async function main() {
  const results = await findAllDreams();
  
  console.log('\n' + '='.repeat(70));
  console.log(`\n📊 SUMMARY\n`);
  console.log(`Total runs with dreams: ${results.length}`);
  
  if (results.length === 0) {
    console.log('\n❌ No dreams found in any run.');
    process.exit(0);
  }
  
  const totalDreams = results.reduce((sum, r) => sum + r.dreams.total, 0);
  const totalFromGoals = results.reduce((sum, r) => sum + r.dreams.fromGoals, 0);
  const totalFromMemory = results.reduce((sum, r) => sum + r.dreams.fromMemory, 0);
  
  console.log(`Total dreams: ${totalDreams}`);
  console.log(`  - From goals: ${totalFromGoals}`);
  console.log(`  - From memory: ${totalFromMemory}`);
  
  console.log('\n' + '='.repeat(70));
  console.log('\n📋 RUNS WITH DREAMS:\n');
  
  results.forEach((result, idx) => {
    console.log(`${idx + 1}. ${result.runName}`);
    console.log(`   Total: ${result.dreams.total} dreams`);
    console.log(`   - Goals: ${result.dreams.fromGoals}`);
    console.log(`   - Memory: ${result.dreams.fromMemory}`);
    
    if (result.dreams.goals.length > 0) {
      console.log(`\n   Sample dream goals:`);
      result.dreams.goals.slice(0, 3).forEach(dream => {
        const desc = dream.description.substring(0, 80);
        console.log(`   • ${desc}${dream.description.length > 80 ? '...' : ''}`);
      });
    }
    
    console.log('');
  });
  
  // Save detailed report
  const reportPath = path.join(__dirname, '..', 'dreams_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Detailed report saved to: ${reportPath}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

