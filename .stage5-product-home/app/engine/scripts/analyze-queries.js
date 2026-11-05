#!/usr/bin/env node

/**
 * Analyze Queries Script
 * 
 * Processes archived queries to extract:
 * - Key concepts/things mentioned
 * - Action items and todos
 * - Quantitative targets
 * - Experimental designs
 * - Build plans
 * 
 * Generates digestible summaries for dense query responses
 */

const fs = require('fs');
const path = require('path');

// Auto-detect workspace root (git-aware, falls back to ../scripts)
const WORKSPACE_ROOT = (() => {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
})();

const ARCHIVE_DIR = path.join(WORKSPACE_ROOT, 'queries-archive');
const JSONL_DIR = path.join(ARCHIVE_DIR, 'jsonl');
const SUMMARIES_DIR = path.join(ARCHIVE_DIR, 'summaries');

// Ensure summaries directory exists
if (!fs.existsSync(SUMMARIES_DIR)) {
  fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
}

/**
 * Extract structured information from a query answer
 */
function analyzeAnswer(answer) {
  const analysis = {
    concepts: [],
    actionItems: [],
    experiments: [],
    metrics: [],
    timelines: [],
    buildPlans: [],
    keyNumbers: []
  };
  
  // Extract numbered concepts/items (1), 2), etc.)
  const conceptMatches = answer.matchAll(/(\d+)\)\s+([^\n]+?)(?:\n|$)/g);
  for (const match of conceptMatches) {
    const conceptTitle = match[2].trim();
    analysis.concepts.push({
      number: match[1],
      title: conceptTitle,
      type: 'numbered_item'
    });
  }
  
  // Extract bullet points starting with - or •
  const bulletMatches = answer.matchAll(/^[\s]*[-•]\s+([^\n]+)/gm);
  for (const match of bulletMatches) {
    const item = match[1].trim();
    
    // Categorize bullets
    if (item.match(/build|implement|create|develop|deploy|ship/i)) {
      analysis.actionItems.push(item);
    } else if (item.match(/experiment|test|trial|A\/B|measure|validate/i)) {
      analysis.experiments.push(item);
    } else if (item.match(/metric|target|goal|KPI|measure/i)) {
      analysis.metrics.push(item);
    } else if (item.match(/week|day|month|sprint|quarter|phase/i)) {
      analysis.timelines.push(item);
    }
  }
  
  // Extract percentages and quantitative targets
  const percentMatches = answer.matchAll(/([≥≤<>±]?\s*\d+(?:\.\d+)?%)/g);
  for (const match of percentMatches) {
    analysis.keyNumbers.push(match[1].trim());
  }
  
  // Extract build plan sections
  const buildPlanMatch = answer.match(/(?:Build|30[–-]60[–-]90|Week \d)[:\s]+([\s\S]*?)(?=\n\n|$)/i);
  if (buildPlanMatch) {
    const planText = buildPlanMatch[1];
    const weekMatches = planText.matchAll(/(?:Week|Day|Month)\s+(\d+)[:\s]+([^\n]+)/gi);
    for (const match of weekMatches) {
      analysis.buildPlans.push({
        period: match[1],
        task: match[2].trim()
      });
    }
  }
  
  return analysis;
}

/**
 * Generate summary markdown for a query
 */
function generateSummary(query, analysis) {
  const lines = [];
  
  lines.push(`# Query Summary`);
  lines.push('');
  lines.push(`**Query:** ${query.query}`);
  lines.push(`**Timestamp:** ${new Date(query.timestamp).toLocaleString()}`);
  lines.push(`**Model:** ${query.model} (${query.mode} mode)`);
  lines.push(`**Run:** ${query.runName}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Concepts/Things Identified
  if (analysis.concepts.length > 0) {
    lines.push(`## 🎯 Key Concepts/Things Identified (${analysis.concepts.length})`);
    lines.push('');
    analysis.concepts.forEach(concept => {
      lines.push(`${concept.number}. **${concept.title}**`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  // Action Items
  if (analysis.actionItems.length > 0) {
    lines.push(`## ✅ Action Items (${analysis.actionItems.length})`);
    lines.push('');
    analysis.actionItems.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item}`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  // Experiments
  if (analysis.experiments.length > 0) {
    lines.push(`## 🧪 Experiments & Tests (${analysis.experiments.length})`);
    lines.push('');
    analysis.experiments.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item}`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  // Build Plans
  if (analysis.buildPlans.length > 0) {
    lines.push(`## 🏗️ Build Plans & Timelines`);
    lines.push('');
    analysis.buildPlans.forEach(plan => {
      lines.push(`- **Period ${plan.period}:** ${plan.task}`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  // Metrics & Targets
  if (analysis.metrics.length > 0) {
    lines.push(`## 📊 Metrics & Targets`);
    lines.push('');
    analysis.metrics.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item}`);
    });
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  
  // Key Numbers
  if (analysis.keyNumbers.length > 0) {
    const uniqueNumbers = [...new Set(analysis.keyNumbers)];
    if (uniqueNumbers.length > 0 && uniqueNumbers.length < 50) { // Don't spam if too many
      lines.push(`## 🔢 Key Quantitative Targets`);
      lines.push('');
      lines.push(uniqueNumbers.slice(0, 20).join(', '));
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }
  
  // Answer preview
  lines.push(`## 📄 Full Answer`);
  lines.push('');
  const preview = query.answer.substring(0, 500);
  lines.push('```');
  lines.push(preview);
  if (query.answer.length > 500) {
    lines.push('...');
    lines.push('```');
    lines.push('');
    lines.push(`*[Full answer: ${query.answer.length.toLocaleString()} characters - see full query file]*`);
  } else {
    lines.push('```');
  }
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Process a queries archive file
 */
function processQueryFile(filePath) {
  const runName = path.basename(filePath, '-queries.jsonl');
  
  console.log(`📄 Analyzing: ${runName}`);
  
  // Read queries
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  const queries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (error) {
      console.warn(`   ⚠️  Could not parse line in ${filePath}`);
      return null;
    }
  }).filter(q => q !== null);
  
  console.log(`   Queries: ${queries.length}`);
  
  const summaries = [];
  
  queries.forEach((query, idx) => {
    const analysis = analyzeAnswer(query.answer);
    const summary = generateSummary(query, analysis);
    
    summaries.push({
      query,
      analysis,
      summary
    });
    
    console.log(`   - Query ${idx + 1}: Found ${analysis.concepts.length} concepts, ${analysis.actionItems.length} actions`);
  });
  
  // Write individual summaries
  summaries.forEach((item, idx) => {
    const summaryFile = path.join(SUMMARIES_DIR, `${runName}-query-${idx + 1}-summary.md`);
    fs.writeFileSync(summaryFile, item.summary, 'utf-8');
  });
  
  // Write combined summary for the run
  if (summaries.length > 1) {
    const combinedLines = [];
    combinedLines.push(`# ${runName} - All Queries Summary`);
    combinedLines.push('');
    combinedLines.push(`**Total Queries:** ${summaries.length}`);
    combinedLines.push('');
    
    summaries.forEach((item, idx) => {
      combinedLines.push(`## Query ${idx + 1}`);
      combinedLines.push('');
      combinedLines.push(`**Q:** ${item.query.query}`);
      combinedLines.push(`**Concepts:** ${item.analysis.concepts.length}`);
      combinedLines.push(`**Actions:** ${item.analysis.actionItems.length}`);
      combinedLines.push('');
    });
    
    const combinedFile = path.join(SUMMARIES_DIR, `${runName}-all-queries-summary.md`);
    fs.writeFileSync(combinedFile, combinedLines.join('\n'), 'utf-8');
  }
  
  console.log(`   ✅ Summaries written to summaries/`);
  console.log('');
  
  return {
    runName,
    queriesCount: queries.length,
    totalConcepts: summaries.reduce((sum, s) => sum + s.analysis.concepts.length, 0),
    totalActions: summaries.reduce((sum, s) => sum + s.analysis.actionItems.length, 0),
    totalExperiments: summaries.reduce((sum, s) => sum + s.analysis.experiments.length, 0)
  };
}

/**
 * Main execution
 */
function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        COSMO Query Analysis Script                   ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  
  // Find all archived query files
  const files = fs.readdirSync(JSONL_DIR)
    .filter(f => f.endsWith('-queries.jsonl'))
    .map(f => path.join(JSONL_DIR, f));
  
  if (files.length === 0) {
    console.log('❌ No archived query files found in queries-archive/jsonl/');
    process.exit(1);
  }
  
  console.log(`Found ${files.length} query archive(s)\n`);
  console.log('═══════════════════════════════════════════════════════\n');
  
  const results = [];
  
  files.forEach(filePath => {
    const result = processQueryFile(filePath);
    results.push(result);
  });
  
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('✨ Analysis complete!\n');
  console.log(`📁 Summaries location: ${path.relative(WORKSPACE_ROOT, SUMMARIES_DIR)}`);
  console.log('');
  console.log('📊 Totals:');
  console.log(`   - Runs analyzed: ${results.length}`);
  console.log(`   - Total queries: ${results.reduce((sum, r) => sum + r.queriesCount, 0)}`);
  console.log(`   - Concepts extracted: ${results.reduce((sum, r) => sum + r.totalConcepts, 0)}`);
  console.log(`   - Action items: ${results.reduce((sum, r) => sum + r.totalActions, 0)}`);
  console.log(`   - Experiments: ${results.reduce((sum, r) => sum + r.totalExperiments, 0)}`);
  console.log('');
}

// Run the script
try {
  main();
} catch (error) {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}

