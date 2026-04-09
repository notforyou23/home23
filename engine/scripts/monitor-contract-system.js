#!/usr/bin/env node

/**
 * Monitor Contract System Activity
 * 
 * Watches for contract-aware goals, missions, and CompletionAgent activity
 * Run alongside COSMO to see the contract system in action
 */

const fs = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const { createInterface } = require('readline');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const EVENTS_LOG = path.join(RUNTIME_DIR, 'events.log');
const GOALS_DIR = path.join(RUNTIME_DIR, 'goals');

let lastPosition = 0;
let contractGoalsFound = 0;
let validationsRun = 0;
let promotionsCompleted = 0;

console.log('╔═══════════════════════════════════════════════════╗');
console.log('║   Contract System Activity Monitor               ║');
console.log('╚═══════════════════════════════════════════════════╝\n');
console.log('Watching for contract-aware activity...\n');

async function checkForContractGoals() {
  try {
    const pending = path.join(GOALS_DIR, 'pending');
    const assigned = path.join(GOALS_DIR, 'assigned');
    
    const dirs = [pending, assigned];
    
    for (const dir of dirs) {
      try {
        const files = await fs.promises.readdir(dir);
        
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          
          const goalPath = path.join(dir, file);
          const content = await fs.promises.readFile(goalPath, 'utf8');
          const goal = JSON.parse(content);
          
          if (goal.metadata?.contractId) {
            contractGoalsFound++;
            console.log(`📋 Contract-Aware Goal Found:`);
            console.log(`   ID: ${goal.id}`);
            console.log(`   Contract: ${goal.metadata.contractId}`);
            console.log(`   Location: ${goal.metadata.canonicalOutputLocation || 'not specified'}`);
            console.log(`   Expected: ${goal.metadata.expectedArtifacts?.length || 0} artifacts`);
            console.log(`   Priority: ${goal.metadata.executionPriority || 'default'}\n`);
          }
        }
      } catch (error) {
        // Directory doesn't exist yet or not accessible
      }
    }
  } catch (error) {
    // Goals directory not accessible
  }
}

async function scanLogs() {
  try {
    const stat = await fs.promises.stat(EVENTS_LOG);
    
    if (stat.size <= lastPosition) {
      return; // No new content
    }
    
    const stream = createReadStream(EVENTS_LOG, {
      start: lastPosition,
      encoding: 'utf8'
    });
    
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    
    for await (const line of rl) {
      // Check for contract-related activity
      if (line.includes('contractId')) {
        console.log('📋 Contract Activity:', line.substring(line.indexOf('INFO:') + 5).trim());
      }
      
      if (line.includes('Contract Validation')) {
        validationsRun++;
        console.log('✅ Validation:', line.substring(line.indexOf('Contract')).trim());
      }
      
      if (line.includes('Promoted') && line.includes('canonical')) {
        promotionsCompleted++;
        console.log('📦 Promotion:', line.substring(line.indexOf('Promoted')).trim());
      }
      
      if (line.includes('parseExecutionHintsWithContract')) {
        console.log('🔍 Parsing hints:', line.substring(line.indexOf('INFO:') + 5).trim());
      }
    }
    
    lastPosition = stat.size;
    
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading logs:', error.message);
    }
  }
}

// Main monitoring loop
async function monitor() {
  await checkForContractGoals();
  await scanLogs();
}

// Initial check
monitor();

// Then check every 5 seconds
const interval = setInterval(async () => {
  await monitor();
  
  // Show stats every minute
  const elapsed = Math.floor(process.uptime());
  if (elapsed % 60 === 0) {
    console.log(`\n📊 Stats (${Math.floor(elapsed / 60)} min):`);
    console.log(`   Contract goals: ${contractGoalsFound}`);
    console.log(`   Validations: ${validationsRun}`);
    console.log(`   Promotions: ${promotionsCompleted}\n`);
  }
}, 5000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n📊 Final Stats:');
  console.log(`   Contract goals found: ${contractGoalsFound}`);
  console.log(`   Validations run: ${validationsRun}`);
  console.log(`   Promotions completed: ${promotionsCompleted}`);
  console.log('\n✅ Monitor stopped\n');
  clearInterval(interval);
  process.exit(0);
});

console.log('Press Ctrl+C to stop monitoring\n');

