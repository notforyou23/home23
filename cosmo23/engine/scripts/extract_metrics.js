#!/usr/bin/env node
/**
 * COSMO Research Paper - Metrics Extraction Script
 * Extracts quantitative metrics from run data for research paper
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

class MetricsExtractor {
  constructor(runsDir = 'runs') {
    this.runsDir = runsDir;
    this.metrics = {
      runs: [],
      aggregate: {
        totalCycles: 0,
        totalGoals: 0,
        totalMemoryNodes: 0,
        totalMemoryEdges: 0,
        totalAgentTasks: 0,
        totalInsights: 0,
        avgCyclesPerRun: 0,
        avgGoalsPerCycle: 0,
        avgMemoryGrowthRate: 0
      }
    };
  }

  async extractAll() {
    console.log('🔬 COSMO Research Metrics Extraction');
    console.log('=' .repeat(60));
    
    const runs = await this.discoverRuns();
    console.log(`\n📁 Found ${runs.length} runs to analyze\n`);

    for (const run of runs) {
      console.log(`\n⏳ Processing: ${run.name}`);
      const runMetrics = await this.extractRunMetrics(run);
      if (runMetrics) {
        this.metrics.runs.push(runMetrics);
        console.log(`   ✅ ${runMetrics.cycles} cycles, ${runMetrics.goals} goals`);
      }
    }

    this.computeAggregates();
    await this.saveResults();

    console.log('\n' + '='.repeat(60));
    console.log('📊 EXTRACTION COMPLETE');
    console.log('=' .repeat(60));
    this.printSummary();
  }

  async discoverRuns() {
    const entries = await readdir(this.runsDir);
    const runs = [];

    for (const entry of entries) {
      const fullPath = path.join(this.runsDir, entry);
      const stats = await stat(fullPath);
      
      if (stats.isDirectory() && !entry.startsWith('.')) {
        runs.push({
          name: entry,
          path: fullPath
        });
      }
    }

    return runs;
  }

  async extractRunMetrics(run) {
    try {
      const metrics = {
        runName: run.name,
        timestamp: this.extractTimestamp(run.name),
        cycles: 0,
        goals: 0,
        memoryNodes: 0,
        memoryEdges: 0,
        agentTasks: 0,
        insights: 0,
        coordinatorReviews: 0,
        topGoals: [],
        memoryGrowth: [],
        agentBreakdown: {}
      };

      // Extract from state file
      const stateData = await this.loadState(run.path);
      if (stateData) {
        metrics.cycles = stateData.cycle || 0;
        metrics.goals = stateData.goals?.length || 0;
        metrics.memoryNodes = stateData.memory?.nodes?.length || 0;
        metrics.memoryEdges = stateData.memory?.edges?.length || 0;
        
        // Top goals by priority
        if (stateData.goals) {
          metrics.topGoals = stateData.goals
            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
            .slice(0, 5)
            .map(g => ({ concept: g.concept, priority: g.priority }));
        }
      }

      // Extract from thoughts file
      const thoughtsData = await this.loadThoughts(run.path);
      if (thoughtsData) {
        metrics.insights = thoughtsData.filter(t => t.insightful).length;
      }

      // Extract coordinator reviews
      const coordinatorData = await this.loadCoordinatorReviews(run.path);
      metrics.coordinatorReviews = coordinatorData.length;
      metrics.agentTasks = coordinatorData.reduce((sum, review) => {
        return sum + (review.agents_spawned || 0);
      }, 0);

      // Agent breakdown
      for (const review of coordinatorData) {
        if (review.agent_decisions) {
          for (const decision of review.agent_decisions) {
            const type = decision.agent_type || 'unknown';
            metrics.agentBreakdown[type] = (metrics.agentBreakdown[type] || 0) + 1;
          }
        }
      }

      // Memory growth over time
      if (coordinatorData.length > 0) {
        metrics.memoryGrowth = coordinatorData.map(review => ({
          cycle: review.cycle,
          nodes: review.memory_nodes || 0,
          edges: review.memory_edges || 0
        }));
      }

      return metrics;
    } catch (error) {
      console.error(`   ❌ Error processing ${run.name}: ${error.message}`);
      return null;
    }
  }

  async loadState(runPath) {
    try {
      const statePath = path.join(runPath, 'state.json.gz');
      if (!fs.existsSync(statePath)) return null;

      const compressed = await readFile(statePath);
      const decompressed = await gunzip(compressed);
      return JSON.parse(decompressed.toString());
    } catch (error) {
      console.warn(`   ⚠️  Could not load state: ${error.message}`);
      return null;
    }
  }

  async loadThoughts(runPath) {
    try {
      const thoughtsPath = path.join(runPath, 'thoughts.jsonl');
      if (!fs.existsSync(thoughtsPath)) return [];

      const content = await readFile(thoughtsPath, 'utf8');
      return content.trim().split('\n').map(line => JSON.parse(line));
    } catch (error) {
      return [];
    }
  }

  async loadCoordinatorReviews(runPath) {
    try {
      const coordinatorDir = path.join(runPath, 'coordinator');
      if (!fs.existsSync(coordinatorDir)) return [];

      const files = await readdir(coordinatorDir);
      const reviews = [];

      for (const file of files) {
        if (file.startsWith('review_') && file.endsWith('.json')) {
          const content = await readFile(path.join(coordinatorDir, file), 'utf8');
          reviews.push(JSON.parse(content));
        }
      }

      return reviews.sort((a, b) => (a.cycle || 0) - (b.cycle || 0));
    } catch (error) {
      return [];
    }
  }

  extractTimestamp(runName) {
    const match = runName.match(/(\d{8})_(\d{6})/);
    if (match) {
      const [_, date, time] = match;
      return new Date(`${date.substr(0,4)}-${date.substr(4,2)}-${date.substr(6,2)}T${time.substr(0,2)}:${time.substr(2,2)}:${time.substr(4,2)}`);
    }
    return null;
  }

  computeAggregates() {
    const agg = this.metrics.aggregate;
    const runs = this.metrics.runs;

    if (runs.length === 0) return;

    agg.totalCycles = runs.reduce((sum, r) => sum + r.cycles, 0);
    agg.totalGoals = runs.reduce((sum, r) => sum + r.goals, 0);
    agg.totalMemoryNodes = runs.reduce((sum, r) => sum + r.memoryNodes, 0);
    agg.totalMemoryEdges = runs.reduce((sum, r) => sum + r.memoryEdges, 0);
    agg.totalAgentTasks = runs.reduce((sum, r) => sum + r.agentTasks, 0);
    agg.totalInsights = runs.reduce((sum, r) => sum + r.insights, 0);

    agg.avgCyclesPerRun = agg.totalCycles / runs.length;
    agg.avgGoalsPerCycle = agg.totalGoals / Math.max(agg.totalCycles, 1);
    agg.avgMemoryGrowthRate = agg.totalMemoryNodes / Math.max(agg.totalCycles, 1);

    // Aggregate agent type usage
    agg.agentTypeDistribution = {};
    for (const run of runs) {
      for (const [type, count] of Object.entries(run.agentBreakdown)) {
        agg.agentTypeDistribution[type] = (agg.agentTypeDistribution[type] || 0) + count;
      }
    }
  }

  async saveResults() {
    const outputDir = path.join('research', 'results');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save full metrics
    const metricsPath = path.join(outputDir, 'metrics.json');
    fs.writeFileSync(metricsPath, JSON.stringify(this.metrics, null, 2));
    console.log(`\n💾 Saved metrics to: ${metricsPath}`);

    // Save summary for paper
    const summaryPath = path.join(outputDir, 'summary.txt');
    fs.writeFileSync(summaryPath, this.generateTextSummary());
    console.log(`💾 Saved summary to: ${summaryPath}`);

    // Save CSV for graphing
    const csvPath = path.join(outputDir, 'runs.csv');
    fs.writeFileSync(csvPath, this.generateCSV());
    console.log(`💾 Saved CSV to: ${csvPath}`);
  }

  generateTextSummary() {
    const agg = this.metrics.aggregate;
    return `COSMO Research Paper - Empirical Results Summary
${'='.repeat(60)}

AGGREGATE METRICS (${this.metrics.runs.length} runs):

Total Autonomous Cycles: ${agg.totalCycles.toLocaleString()}
Total Goals Discovered: ${agg.totalGoals.toLocaleString()}
Total Memory Nodes: ${agg.totalMemoryNodes.toLocaleString()}
Total Memory Edges: ${agg.totalMemoryEdges.toLocaleString()}
Total Agent Tasks: ${agg.totalAgentTasks.toLocaleString()}
Total Insights: ${agg.totalInsights.toLocaleString()}

AVERAGES:

Cycles per Run: ${agg.avgCyclesPerRun.toFixed(1)}
Goals per Cycle: ${agg.avgGoalsPerCycle.toFixed(2)}
Memory Growth Rate: ${agg.avgMemoryGrowthRate.toFixed(2)} nodes/cycle

AGENT TYPE DISTRIBUTION:

${Object.entries(agg.agentTypeDistribution || {})
  .sort((a, b) => b[1] - a[1])
  .map(([type, count]) => `  ${type}: ${count}`)
  .join('\n')}

${'='.repeat(60)}
Generated: ${new Date().toISOString()}
`;
  }

  generateCSV() {
    const headers = ['Run Name', 'Cycles', 'Goals', 'Memory Nodes', 'Memory Edges', 'Agent Tasks', 'Insights', 'Reviews'];
    const rows = this.metrics.runs.map(r => [
      r.runName,
      r.cycles,
      r.goals,
      r.memoryNodes,
      r.memoryEdges,
      r.agentTasks,
      r.insights,
      r.coordinatorReviews
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  printSummary() {
    const agg = this.metrics.aggregate;
    console.log(`
📊 SUMMARY STATISTICS

Runs Analyzed: ${this.metrics.runs.length}
Total Cycles: ${agg.totalCycles.toLocaleString()}
Total Goals: ${agg.totalGoals.toLocaleString()}
Memory Nodes: ${agg.totalMemoryNodes.toLocaleString()}
Agent Tasks: ${agg.totalAgentTasks.toLocaleString()}

Avg Cycles/Run: ${agg.avgCyclesPerRun.toFixed(1)}
Avg Goals/Cycle: ${agg.avgGoalsPerCycle.toFixed(2)}
Memory Growth: ${agg.avgMemoryGrowthRate.toFixed(2)} nodes/cycle
`);
  }
}

// Run if called directly
if (require.main === module) {
  const extractor = new MetricsExtractor();
  extractor.extractAll().catch(console.error);
}

module.exports = MetricsExtractor;

