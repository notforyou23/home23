#!/usr/bin/env node

/**
 * Curate COSMO Run - Extract Gold Nuggets
 * 
 * Usage: node curate-run.js [--output report.md]
 * 
 * Analyzes current COSMO run and extracts high-value insights.
 * Produces consultant-ready report with actionable findings.
 */

const { InsightCurator } = require('./insight-curator');
const path = require('path');
const fs = require('fs').promises;

// Simple logger
const logger = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data || ''),
  debug: (msg, data) => { /* silent debug */ }
};

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   COSMO Insight Curator                         ║');
  console.log('║   Extracting Gold Nuggets from Research Run     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Load config
    const configPath = path.join(__dirname, '..', 'config.yaml');
    const yaml = require('js-yaml');
    const configFile = await fs.readFile(configPath, 'utf-8');
    const config = yaml.load(configFile);

    // Parse command line args
    const args = process.argv.slice(2);
    const outputIdx = args.indexOf('--output');
    const outputPath = outputIdx >= 0 && args[outputIdx + 1] 
      ? args[outputIdx + 1] 
      : path.join(__dirname, '..', '..', 'demo_results', 'quantum_finance_5day', 'CURATED_INSIGHTS.md');

    // Initialize curator
    const logsDir = path.join(__dirname, '..', '..', 'runtime');
    const curator = new InsightCurator(config, logger, logsDir);

    // Run curation
    console.log('🔍 Analyzing COSMO run...\n');
    const results = await curator.curateRun();

    console.log('\n✅ Curation complete!\n');
    console.log(`📊 Results:`);
    console.log(`   Raw insights collected: ${results.metadata.totalRawInsights}`);
    console.log(`   High-value insights: ${results.metadata.topInsightsCount}`);
    console.log(`   Duration: ${results.metadata.curationDuration.toFixed(1)}s`);
    console.log('');
    console.log(`📝 Generating report...`);

    // Generate report
    const report = await curator.generateReport(results, outputPath);
    
    console.log(`✅ Report saved to: ${outputPath}\n`);

    // Preview top insights
    console.log('🏆 TOP 5 INSIGHTS:\n');
    const allInsights = [
      ...results.topInsights.technical,
      ...results.topInsights.strategic,
      ...results.topInsights.operational,
      ...results.topInsights.marketIntelligence,
      ...results.topInsights.crossDomain
    ];

    allInsights.slice(0, 5).forEach((ins, idx) => {
      const category = (ins.category || 'general').toUpperCase();
      const title = ins.title || 'Insight';
      const scores = ins.scores || { actionability: 5, specificity: 5, novelty: 5, businessValue: 5 };
      const totalScore = ins.totalScore || 20;
      
      console.log(`${idx + 1}. [${category}] ${title}`);
      console.log(`   Score: ${totalScore}/40 (A:${scores.actionability} S:${scores.specificity} N:${scores.novelty} B:${scores.businessValue})`);
      console.log(`   ${ins.content.substring(0, 150)}...`);
      console.log('');
    });

    console.log(`📄 Full report with all ${allInsights.length} curated insights: ${outputPath}\n`);

  } catch (error) {
    console.error('\n❌ Curation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

