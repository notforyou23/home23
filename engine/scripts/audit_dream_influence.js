#!/usr/bin/env node
/**
 * Dream Influence Audit Script
 * 
 * PASSIVE analysis of dream→goal→research pathways
 * NO MODIFICATIONS to core system - pure read-only analysis
 * 
 * Purpose:
 * - Prove causality: which dreams led to which research outcomes
 * - Quantify dream influence on research productivity
 * - Identify most valuable dream patterns
 * 
 * Data Sources:
 * - dreams.jsonl: All generated dreams with IDs
 * - state.json.gz: Current goals and their metadata
 * - (future): agent execution logs for research outcomes
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

async function loadDreams(dreamsPath) {
  if (!fs.existsSync(dreamsPath)) {
    return [];
  }
  
  const dreams = [];
  const content = fs.readFileSync(dreamsPath, 'utf8');
  
  content.trim().split('\n').forEach((line, index) => {
    if (line.trim()) {
      try {
        const dream = JSON.parse(line);
        dreams.push(dream);
      } catch (e) {
        console.warn(`Warning: Failed to parse dream line ${index + 1}`);
      }
    }
  });
  
  return dreams;
}

async function loadState(statePath) {
  const stateGzPath = statePath + '.gz';
  
  try {
    let content;
    if (fs.existsSync(stateGzPath)) {
      const compressed = fs.readFileSync(stateGzPath);
      content = await gunzip(compressed);
    } else if (fs.existsSync(statePath)) {
      content = fs.readFileSync(statePath, 'utf8');
    } else {
      return null;
    }
    
    return JSON.parse(content.toString());
  } catch (error) {
    console.error(`Error loading state: ${error.message}`);
    return null;
  }
}

function extractAllGoals(state) {
  if (!state || !state.goals) {
    return [];
  }
  
  const allGoals = [
    ...(Array.isArray(state.goals.active) ? state.goals.active : []),
    ...(state.goals.completed || []),
    ...(state.goals.archived || [])
  ];
  
  return allGoals.map(entry => {
    // Handle both [id, goal] tuples and direct goal objects
    return Array.isArray(entry) ? entry[1] : entry;
  }).filter(goal => goal != null);
}

function analyzeDreamInfluence(dreams, goals) {
  const dreamMap = new Map();
  
  // Initialize map with all dreams
  dreams.forEach(dream => {
    dreamMap.set(dream.id, {
      dreamId: dream.id,
      cycle: dream.cycle,
      timestamp: dream.timestamp,
      content: dream.content,
      model: dream.model,
      cognitiveState: dream.cognitiveState,
      goals: [],
      totalPursuits: 0,
      totalProgress: 0,
      completedGoals: 0,
      influenceScore: 0
    });
  });
  
  // Link goals to dreams
  goals.forEach(goal => {
    if (goal.source === 'dream_gpt5' || goal.source === 'dream') {
      const dreamId = goal.metadata?.dreamId || 'unknown';
      
      if (!dreamMap.has(dreamId)) {
        // Dream not in dreams.jsonl but goal references it
        dreamMap.set(dreamId, {
          dreamId,
          cycle: goal.metadata?.dreamCycle || null,
          timestamp: goal.metadata?.dreamTimestamp || null,
          content: goal.metadata?.dreamContentSnippet || 'Content not available',
          model: 'unknown',
          cognitiveState: null,
          goals: [],
          totalPursuits: 0,
          totalProgress: 0,
          completedGoals: 0,
          influenceScore: 0
        });
      }
      
      const influence = dreamMap.get(dreamId);
      const pursuitCount = goal.pursuitCount || 0;
      const progress = goal.progress || 0;
      const completed = !!goal.completedAt;
      
      influence.goals.push({
        id: goal.id,
        description: goal.description,
        pursuitCount,
        progress,
        completed,
        priority: goal.priority,
        created: goal.created || goal.createdAt
      });
      
      influence.totalPursuits += pursuitCount;
      influence.totalProgress += progress;
      if (completed) {
        influence.completedGoals++;
      }
      
      // Calculate influence score:
      // Base: 1 point per goal
      // Pursuit: 2 points per pursuit
      // Progress: 5 points per completion
      influence.influenceScore = 
        influence.goals.length + 
        (influence.totalPursuits * 2) + 
        (influence.completedGoals * 5);
    }
  });
  
  return dreamMap;
}

function generateReport(dreamInfluence, outputPath) {
  const influences = [...dreamInfluence.values()];
  
  // Sort by influence score
  const sorted = influences.sort((a, b) => b.influenceScore - a.influenceScore);
  
  // Calculate statistics
  const stats = {
    totalDreams: influences.length,
    dreamsWithGoals: influences.filter(d => d.goals.length > 0).length,
    totalGoals: influences.reduce((sum, d) => sum + d.goals.length, 0),
    totalPursuits: influences.reduce((sum, d) => sum + d.totalPursuits, 0),
    completedGoals: influences.reduce((sum, d) => sum + d.completedGoals, 0),
    avgGoalsPerDream: 0,
    avgPursuitsPerDream: 0,
    avgInfluenceScore: 0,
    dreamProductivityRate: 0  // % of dreams that led to at least one goal
  };
  
  if (stats.totalDreams > 0) {
    stats.avgGoalsPerDream = (stats.totalGoals / stats.totalDreams).toFixed(2);
    stats.avgPursuitsPerDream = (stats.totalPursuits / stats.totalDreams).toFixed(2);
    stats.avgInfluenceScore = (influences.reduce((sum, d) => sum + d.influenceScore, 0) / stats.totalDreams).toFixed(2);
    stats.dreamProductivityRate = ((stats.dreamsWithGoals / stats.totalDreams) * 100).toFixed(1) + '%';
  }
  
  // Console output
  console.log('\n' + '='.repeat(70));
  console.log('🧠 DREAM INFLUENCE AUDIT REPORT');
  console.log('='.repeat(70));
  console.log(`\n📊 SUMMARY STATISTICS\n`);
  console.log(`Total dreams analyzed: ${stats.totalDreams}`);
  console.log(`Dreams that produced goals: ${stats.dreamsWithGoals} (${stats.dreamProductivityRate})`);
  console.log(`Total goals from dreams: ${stats.totalGoals}`);
  console.log(`Total goal pursuits: ${stats.totalPursuits}`);
  console.log(`Completed goals: ${stats.completedGoals}`);
  console.log(`\nAverage goals per dream: ${stats.avgGoalsPerDream}`);
  console.log(`Average pursuits per dream: ${stats.avgPursuitsPerDream}`);
  console.log(`Average influence score: ${stats.avgInfluenceScore}`);
  
  // Top influential dreams
  const topInfluential = sorted.filter(d => d.goals.length > 0).slice(0, 10);
  
  if (topInfluential.length > 0) {
    console.log(`\n🏆 TOP ${topInfluential.length} MOST INFLUENTIAL DREAMS\n`);
    
    topInfluential.forEach((dream, index) => {
      console.log(`${index + 1}. ${dream.dreamId} (Cycle ${dream.cycle})`);
      console.log(`   Influence Score: ${dream.influenceScore}`);
      console.log(`   Goals: ${dream.goals.length} | Pursuits: ${dream.totalPursuits} | Completed: ${dream.completedGoals}`);
      console.log(`   Content: ${dream.content.substring(0, 120)}...`);
      
      if (dream.goals.length > 0) {
        console.log(`   Goals generated:`);
        dream.goals.slice(0, 3).forEach(g => {
          const status = g.completed ? '✓' : (g.pursuitCount > 0 ? '⏳' : '○');
          console.log(`     ${status} ${g.description.substring(0, 70)}...`);
          console.log(`        Pursued ${g.pursuitCount}x, ${(g.progress * 100).toFixed(0)}% complete`);
        });
        if (dream.goals.length > 3) {
          console.log(`     ... and ${dream.goals.length - 3} more goals`);
        }
      }
      console.log('');
    });
  }
  
  // Dreams with no influence
  const unproductive = influences.filter(d => d.goals.length === 0);
  if (unproductive.length > 0) {
    console.log(`\n💤 UNPRODUCTIVE DREAMS: ${unproductive.length} (${((unproductive.length/stats.totalDreams)*100).toFixed(1)}%)`);
    console.log(`   These dreams did not generate any goals (yet)`);
  }
  
  // Generate JSON report
  const report = {
    generated: new Date().toISOString(),
    summary: stats,
    topInfluential: topInfluential.map(d => ({
      dreamId: d.dreamId,
      cycle: d.cycle,
      timestamp: d.timestamp,
      influenceScore: d.influenceScore,
      goalsCount: d.goals.length,
      pursuitCount: d.totalPursuits,
      completedCount: d.completedGoals,
      contentPreview: d.content.substring(0, 200),
      goals: d.goals
    })),
    allInfluences: sorted.map(d => ({
      dreamId: d.dreamId,
      cycle: d.cycle,
      influenceScore: d.influenceScore,
      goalsCount: d.goals.length,
      pursuitCount: d.totalPursuits,
      completedCount: d.completedGoals
    }))
  };
  
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Detailed JSON report saved to: ${path.basename(outputPath)}`);
  console.log('\n' + '='.repeat(70));
  
  return report;
}

async function auditRunDirectory(runDir, runName) {
  console.log(`\n🔍 Auditing: ${runName}`);
  
  const dreamsPath = path.join(runDir, 'dreams.jsonl');
  const statePath = path.join(runDir, 'state.json');
  
  // Load data
  const dreams = await loadDreams(dreamsPath);
  const state = await loadState(statePath);
  
  if (dreams.length === 0) {
    console.log(`   ⚠️  No dreams found`);
    return null;
  }
  
  if (!state) {
    console.log(`   ⚠️  No state found`);
    return null;
  }
  
  const goals = extractAllGoals(state);
  
  // Analyze
  const dreamInfluence = analyzeDreamInfluence(dreams, goals);
  
  // Generate report
  const reportPath = path.join(runDir, 'dream_influence_audit.json');
  const report = generateReport(dreamInfluence, reportPath);
  
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  
  // Default to runtime directory
  let targetDir = path.join(__dirname, '..', 'runtime');
  let targetName = 'runtime';
  
  // Allow specifying a run directory
  if (args.length > 0) {
    const customPath = args[0];
    if (fs.existsSync(customPath)) {
      targetDir = customPath;
      targetName = path.basename(customPath);
    } else {
      console.error(`Error: Directory not found: ${customPath}`);
      process.exit(1);
    }
  }
  
  console.log('🧠 Dream Influence Audit Tool');
  console.log('Analyzing dream→goal→research pathways...\n');
  
  await auditRunDirectory(targetDir, targetName);
  
  console.log('\n✅ Audit complete!');
  console.log('\n💡 Usage:');
  console.log('   node scripts/audit_dream_influence.js              # Audit runtime/');
  console.log('   node scripts/audit_dream_influence.js runs/_art/   # Audit specific run');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { auditRunDirectory, analyzeDreamInfluence };

