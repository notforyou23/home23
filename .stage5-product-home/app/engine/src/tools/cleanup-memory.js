#!/usr/bin/env node
/**
 * Memory Network Cleanup Utility
 * Removes corrupted or invalid nodes from the memory network
 */

const fs = require('fs').promises;
const path = require('path');

async function cleanupMemory() {
  const logsDir = path.join(__dirname, '..', '..', 'runtime');
  const statePath = path.join(logsDir, 'state.json');

  console.log('🔧 Memory Network Cleanup Utility');
  console.log('==================================\n');

  try {
    // Load current state
    const stateData = await fs.readFile(statePath, 'utf8');
    const state = JSON.parse(stateData);

    if (!state.memory || !state.memory.nodes) {
      console.log('❌ No memory network found in state');
      return;
    }

    console.log(`📊 Current state:`);
    console.log(`   Nodes: ${state.memory.nodes.length}`);
    console.log(`   Edges: ${state.memory.edges.length}\n`);

    // Find problematic nodes
    const problematicNodes = [];
    
    for (let i = 0; i < state.memory.nodes.length; i++) {
      const node = state.memory.nodes[i];
      
      // Check for error messages in concept
      if (node.concept.includes('Error:') || 
          node.concept.includes('undefined') ||
          node.concept.includes('[Error:') ||
          node.concept.length < 10) {
        
        problematicNodes.push({
          index: i,
          id: node.id,
          concept: node.concept,
          tag: node.tag,
          reason: node.concept.includes('Error:') ? 'Contains error' :
                  node.concept.includes('undefined') ? 'Contains undefined' :
                  node.concept.length < 10 ? 'Too short' : 'Invalid'
        });
      }
    }

    if (problematicNodes.length === 0) {
      console.log('✅ No problematic nodes found! Memory network is clean.\n');
      return;
    }

    console.log(`⚠️  Found ${problematicNodes.length} problematic node(s):\n`);
    
    for (const node of problematicNodes) {
      console.log(`   Node ${node.id}:`);
      console.log(`      Tag: ${node.tag}`);
      console.log(`      Reason: ${node.reason}`);
      console.log(`      Concept: ${node.concept.substring(0, 100)}`);
      console.log('');
    }

    // Create backup
    const backupPath = path.join(logsDir, `state.backup.${Date.now()}.json`);
    await fs.writeFile(backupPath, stateData);
    console.log(`💾 Backup created: ${backupPath}\n`);

    // Remove problematic nodes
    const nodeIdsToRemove = new Set(problematicNodes.map(n => n.id));
    
    // Filter nodes
    const cleanNodes = state.memory.nodes.filter(n => !nodeIdsToRemove.has(n.id));
    
    // Filter edges that reference removed nodes
    const cleanEdges = state.memory.edges.filter(e => 
      !nodeIdsToRemove.has(e.source) && !nodeIdsToRemove.has(e.target)
    );

    // Update state
    state.memory.nodes = cleanNodes;
    state.memory.edges = cleanEdges;

    // Save cleaned state
    await fs.writeFile(statePath, JSON.stringify(state, null, 2));

    console.log('✅ Cleanup complete!');
    console.log(`   Removed nodes: ${problematicNodes.length}`);
    console.log(`   Removed edges: ${state.memory.edges.length - cleanEdges.length}`);
    console.log(`   Remaining nodes: ${cleanNodes.length}`);
    console.log(`   Remaining edges: ${cleanEdges.length}\n`);

    console.log('🔄 Restart the system to see the cleaned memory network.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  cleanupMemory().catch(console.error);
}

module.exports = { cleanupMemory };

