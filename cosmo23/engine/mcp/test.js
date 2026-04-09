#!/usr/bin/env node

/**
 * Simple test script to verify MCP server can read Cosmo state
 * This doesn't test the MCP protocol itself, just that the data access works
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const readFile = promisify(fs.readFile);

const COSMO_ROOT = path.join(__dirname, '..');
const LOGS_DIR = path.join(COSMO_ROOT, 'runtime');
const STATE_FILE = path.join(LOGS_DIR, 'state.json.gz');
const THOUGHTS_FILE = path.join(LOGS_DIR, 'thoughts.jsonl');

async function test() {
  console.log('🧪 Testing Cosmo MCP Server Data Access\n');
  
  try {
    // Test 1: Read system state
    console.log('1. Reading system state...');
    const compressed = await readFile(STATE_FILE);
    const decompressed = await gunzip(compressed);
    const state = JSON.parse(decompressed.toString());
    console.log(`   ✅ State loaded - Cycle ${state.cycleCount || 0}`);
    console.log(`   ✅ Memory: ${state.memory?.nodes?.length || 0} nodes`);
    console.log(`   ✅ Goals: ${state.goals?.active?.length || 0} active, ${state.goals?.completed?.length || 0} completed`);
    console.log(`   ✅ Mode: ${state.currentMode || 'unknown'}`);
    console.log(`   ✅ Cognitive State:`, state.cognitiveState);
    
    // Test 2: Read thoughts
    console.log('\n2. Reading recent thoughts...');
    const thoughtsContent = await readFile(THOUGHTS_FILE, 'utf-8');
    const lines = thoughtsContent.trim().split('\n');
    const recentThoughts = lines.slice(-5).map(line => JSON.parse(line));
    console.log(`   ✅ Found ${lines.length} total thoughts`);
    console.log(`   ✅ Most recent thought:`);
    if (recentThoughts.length > 0) {
      const latest = recentThoughts[recentThoughts.length - 1];
      console.log(`      Cycle: ${latest.cycle}`);
      console.log(`      Role: ${latest.role}`);
      console.log(`      Thought: ${latest.thought?.substring(0, 100)}...`);
      console.log(`      Model: ${latest.model}`);
    }
    
    // Test 3: Memory query simulation
    console.log('\n3. Testing memory query (simple keyword search)...');
    const query = 'AI';
    const queryWords = query.toLowerCase().split(/\s+/);
    
    const scored = state.memory.nodes.map(node => {
      const conceptLower = (node.concept || '').toLowerCase();
      let score = 0;
      queryWords.forEach(word => {
        if (conceptLower.includes(word)) {
          score += 1;
        }
      });
      score *= (node.activation || 0.5) * (node.weight || 0.5);
      return { ...node, score };
    });
    
    const results = scored
      .filter(n => n.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    
    console.log(`   ✅ Query: "${query}"`);
    console.log(`   ✅ Found ${results.length} relevant nodes:`);
    results.forEach((r, i) => {
      console.log(`      ${i + 1}. ${r.concept?.substring(0, 80)}...`);
      console.log(`         (activation: ${r.activation?.toFixed(3)}, score: ${r.score.toFixed(3)})`);
    });
    
    // Test 4: Goals
    console.log('\n4. Checking active goals...');
    const activeGoals = state.goals?.active || [];
    if (activeGoals.length > 0) {
      console.log(`   ✅ Found ${activeGoals.length} active goals`);
      const topGoals = activeGoals
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .slice(0, 3);
      topGoals.forEach((g, i) => {
        console.log(`      ${i + 1}. ${g.description?.substring(0, 80)}...`);
        console.log(`         (priority: ${g.priority?.toFixed(3)}, progress: ${g.progress?.toFixed(3)})`);
      });
    } else {
      console.log(`   ✅ No active goals yet`);
    }
    
    console.log('\n✅ All tests passed! MCP server should work correctly.\n');
    console.log('📝 Next steps:');
    console.log('   1. Add the server to your Claude Desktop config');
    console.log('   2. Restart Claude Desktop');
    console.log('   3. Look for the 🔌 icon to verify connection');
    console.log('   4. Try asking Claude: "What is Cosmo thinking about?"');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\n💡 Make sure:');
    console.error('   - Cosmo has been run at least once');
    console.error('   - The runtime directory exists');
    console.error('   - You have read permissions on the log files');
    process.exit(1);
  }
}

test();

