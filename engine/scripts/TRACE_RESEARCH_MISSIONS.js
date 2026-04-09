#!/usr/bin/env node

/**
 * COSMO Mission Tracer
 * 
 * Systematically traces research, analysis, and synthesis missions from run logs
 * Provides complete auditability and provenance tracking
 * 
 * Usage:
 *   node scripts/TRACE_RESEARCH_MISSIONS.js [run_name] [options]
 * 
 * Options:
 *   --agent-type <type>    Filter by agent type (research, analysis, synthesis)
 *   --min-sources <n>      Minimum sources found (for research agents)
 *   --format <fmt>         Output format: json, markdown, summary (default: summary)
 *   --output <file>        Write to file instead of stdout
 *   --full                 Include complete mission details and all sources
 * 
 * Examples:
 *   node scripts/TRACE_RESEARCH_MISSIONS.js Philosophy
 *   node scripts/TRACE_RESEARCH_MISSIONS.js Biology --agent-type research --min-sources 50
 *   node scripts/TRACE_RESEARCH_MISSIONS.js Art_and_Music --format markdown --full
 */

const fs = require('fs');
const path = require('path');

class MissionTracer {
  constructor(options = {}) {
    this.options = {
      agentType: options.agentType || null,
      minSources: options.minSources || 0,
      format: options.format || 'summary',
      output: options.output || null,
      full: options.full || false
    };
    
    this.runsDir = path.join(__dirname, '..', 'runs');
  }

  /**
   * Trace all missions in a specific run
   */
  async traceRun(runName) {
    // Special case: "runtime" lives at root runtime/, not runs/runtime/
    const runPath = runName === 'runtime'
      ? path.join(__dirname, '..', 'runtime')
      : path.join(this.runsDir, runName);
    
    const resultsQueuePath = path.join(runPath, 'coordinator', 'results_queue.jsonl');
    
    if (!fs.existsSync(resultsQueuePath)) {
      throw new Error(`Results queue not found: ${resultsQueuePath}`);
    }
    
    console.error(`📂 Reading: ${resultsQueuePath}`);
    
    const missions = this.parseResultsQueue(resultsQueuePath);
    const filtered = this.filterMissions(missions);
    
    const report = this.generateReport(runName, filtered);
    
    if (this.options.output) {
      fs.writeFileSync(this.options.output, report, 'utf8');
      console.error(`✅ Report written to: ${this.options.output}`);
    } else {
      console.log(report);
    }
    
    return filtered;
  }

  /**
   * Parse results_queue.jsonl file
   */
  parseResultsQueue(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    
    const missions = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const entry = JSON.parse(line);
        
        // Skip integration markers and other non-agent entries
        if (!entry.agentId || !entry.agentType) continue;
        
        missions.push(entry);
      } catch (error) {
        console.error(`Warning: Failed to parse line: ${error.message}`);
      }
    }
    
    console.error(`📊 Parsed ${missions.length} agent missions`);
    return missions;
  }

  /**
   * Filter missions by criteria
   */
  filterMissions(missions) {
    let filtered = missions;
    
    // Filter by agent type
    if (this.options.agentType) {
      const targetType = this.options.agentType.toLowerCase();
      filtered = filtered.filter(m => 
        m.agentType && m.agentType.toLowerCase().includes(targetType)
      );
    }
    
    // Filter by minimum sources (research agents only)
    if (this.options.minSources > 0) {
      filtered = filtered.filter(m => 
        m.agentSpecificData?.sourcesFound >= this.options.minSources
      );
    }
    
    console.error(`🔍 Filtered to ${filtered.length} missions`);
    return filtered;
  }

  /**
   * Generate report in specified format
   */
  generateReport(runName, missions) {
    switch (this.options.format) {
      case 'json':
        return this.generateJSON(runName, missions);
      case 'markdown':
        return this.generateMarkdown(runName, missions);
      case 'summary':
      default:
        return this.generateSummary(runName, missions);
    }
  }

  /**
   * Generate JSON report
   */
  generateJSON(runName, missions) {
    return JSON.stringify({
      run: runName,
      tracedAt: new Date().toISOString(),
      missionsCount: missions.length,
      missions: missions.map(m => this.extractMissionData(m))
    }, null, 2);
  }

  /**
   * Generate Markdown report
   */
  generateMarkdown(runName, missions) {
    let md = `# Mission Trace Report: ${runName}\n\n`;
    md += `**Traced:** ${new Date().toISOString()}\n`;
    md += `**Missions Found:** ${missions.length}\n\n`;
    md += `---\n\n`;
    
    missions.forEach((mission, i) => {
      md += this.formatMissionMarkdown(mission, i + 1);
      md += `\n---\n\n`;
    });
    
    return md;
  }

  /**
   * Generate summary report
   */
  generateSummary(runName, missions) {
    let summary = `\n╔════════════════════════════════════════════════════════╗\n`;
    summary += `║  COSMO Mission Trace: ${runName.padEnd(32)} ║\n`;
    summary += `╚════════════════════════════════════════════════════════╝\n\n`;
    
    summary += `Missions Found: ${missions.length}\n`;
    summary += `Traced: ${new Date().toISOString()}\n\n`;
    
    // Group by agent type
    const byType = {};
    missions.forEach(m => {
      const type = m.agentType || 'Unknown';
      if (!byType[type]) byType[type] = [];
      byType[type].push(m);
    });
    
    summary += `Agent Type Distribution:\n`;
    Object.entries(byType).forEach(([type, agents]) => {
      summary += `  ${type}: ${agents.length}\n`;
    });
    summary += `\n`;
    
    // Research agents with web searches
    const researchAgents = missions.filter(m => 
      m.agentType === 'ResearchAgent' && m.agentSpecificData?.sourcesFound > 0
    );
    
    if (researchAgents.length > 0) {
      summary += `Research Agents with Web Searches:\n`;
      researchAgents.forEach(agent => {
        const data = agent.agentSpecificData;
        summary += `\n  Agent: ${agent.agentId}\n`;
        summary += `  ├─ Queries: ${data.queriesExecuted || 0}\n`;
        summary += `  ├─ Sources: ${data.sourcesFound || 0}\n`;
        summary += `  ├─ Findings: ${data.findingsAdded || 0}\n`;
        summary += `  ├─ Duration: ${agent.durationFormatted}\n`;
        summary += `  └─ Mission: ${(agent.mission?.description || '').substring(0, 80)}...\n`;
        
        if (this.options.full && data.sources) {
          summary += `\n  Sample Sources:\n`;
          data.sources.slice(0, 5).forEach(src => {
            summary += `    - ${src}\n`;
          });
        }
      });
      summary += `\n`;
    }
    
    // Synthesis agents
    const synthesisAgents = missions.filter(m => m.agentType === 'SynthesisAgent');
    if (synthesisAgents.length > 0) {
      summary += `Synthesis Agents:\n`;
      synthesisAgents.forEach(agent => {
        const data = agent.agentSpecificData;
        summary += `\n  Agent: ${agent.agentId}\n`;
        summary += `  ├─ Sources Consulted: ${data?.sourcesConsulted || 'N/A'}\n`;
        summary += `  ├─ Sections Generated: ${data?.sectionsGenerated || 'N/A'}\n`;
        summary += `  ├─ Report Length: ${data?.reportLength || 'N/A'} chars\n`;
        summary += `  └─ Duration: ${agent.durationFormatted}\n`;
      });
      summary += `\n`;
    }
    
    return summary;
  }

  /**
   * Format mission as markdown
   */
  formatMissionMarkdown(mission, index) {
    let md = `## Mission ${index}: ${mission.agentType}\n\n`;
    md += `**Agent ID:** ${mission.agentId}\n`;
    md += `**Status:** ${mission.status}\n`;
    md += `**Duration:** ${mission.durationFormatted}\n`;
    md += `**Start:** ${mission.startTime}\n`;
    md += `**End:** ${mission.endTime}\n\n`;
    
    md += `**Mission:**\n`;
    md += `> ${mission.mission?.description || 'N/A'}\n\n`;
    
    if (mission.agentSpecificData) {
      md += `**Results:**\n`;
      const data = mission.agentSpecificData;
      
      if (data.queriesExecuted !== undefined) {
        md += `- Queries Executed: ${data.queriesExecuted}\n`;
      }
      if (data.findingsAdded !== undefined) {
        md += `- Findings Added: ${data.findingsAdded}\n`;
      }
      if (data.sourcesFound !== undefined) {
        md += `- Sources Found: ${data.sourcesFound}\n`;
      }
      if (data.sourcesConsulted !== undefined) {
        md += `- Sources Consulted: ${data.sourcesConsulted}\n`;
      }
      if (data.sectionsGenerated !== undefined) {
        md += `- Sections Generated: ${data.sectionsGenerated}\n`;
      }
      
      md += `\n`;
      
      // Include sources if full mode
      if (this.options.full && data.sources && data.sources.length > 0) {
        md += `**Sources:**\n`;
        data.sources.slice(0, 20).forEach(src => {
          md += `- ${src}\n`;
        });
        if (data.sources.length > 20) {
          md += `- ... (${data.sources.length - 20} more sources)\n`;
        }
        md += `\n`;
      }
    }
    
    // Include findings
    if (mission.results && mission.results.length > 0) {
      md += `**Key Findings:**\n`;
      mission.results
        .filter(r => r.type === 'finding')
        .slice(0, 3)
        .forEach((finding, i) => {
          md += `${i + 1}. ${finding.content.substring(0, 200)}...\n`;
        });
      md += `\n`;
    }
    
    return md;
  }

  /**
   * Extract essential mission data
   */
  extractMissionData(mission) {
    const data = {
      agentId: mission.agentId,
      agentType: mission.agentType,
      status: mission.status,
      duration: mission.durationFormatted,
      startTime: mission.startTime,
      endTime: mission.endTime,
      mission: {
        description: mission.mission?.description,
        goalId: mission.mission?.goalId,
        tools: mission.mission?.tools,
        createdBy: mission.mission?.createdBy,
        spawnCycle: mission.mission?.spawnCycle,
        priority: mission.mission?.priority
      },
      results: mission.agentSpecificData,
      findingsCount: mission.results?.filter(r => r && r.type === 'finding').length || 0,
      insightsCount: mission.results?.filter(r => r && r.type === 'insight').length || 0
    };
    
    // Include full results array if in full mode
    if (this.options.full && mission.results) {
      data.fullResults = mission.results.map(r => {
        if (typeof r === 'string') return { type: 'unknown', content: r };
        return {
          type: r.type || 'unknown',
          content: r.content,
          nodeId: r.nodeId,
          timestamp: r.timestamp,
          tag: r.tag,
          // For consistency reviews
          summary: r.summary,
          divergence: r.divergence,
          cycle: r.cycle
        };
      });
    }
    
    return data;
  }

  /**
   * List all available runs
   */
  static listRuns() {
    const runsDir = path.join(__dirname, '..', 'runs');
    const runtimeDir = path.join(__dirname, '..', 'runtime');
    
    const runs = [];
    
    // Check runtime (special case)
    const runtimeResultsQueue = path.join(runtimeDir, 'coordinator', 'results_queue.jsonl');
    if (fs.existsSync(runtimeResultsQueue)) {
      runs.push('runtime');
    }
    
    // Check runs directory
    if (fs.existsSync(runsDir)) {
      const entries = fs.readdirSync(runsDir, { withFileTypes: true });
      const runDirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => !name.startsWith('.'));
      runs.push(...runDirs);
    }
    
    console.log('\nAvailable runs:');
    runs.forEach(run => {
      const resultsQueue = run === 'runtime'
        ? path.join(runtimeDir, 'coordinator', 'results_queue.jsonl')
        : path.join(runsDir, run, 'coordinator', 'results_queue.jsonl');
      const exists = fs.existsSync(resultsQueue);
      console.log(`  ${exists ? '✓' : '✗'} ${run}${run === 'runtime' ? ' (active)' : ''}`);
    });
    console.log('');
    
    return runs;
  }

  /**
   * Generate cross-domain comparison
   */
  static async generateComparison(runs) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  COSMO Cross-Domain Research Comparison                ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
    const comparison = [];
    
    for (const runName of runs) {
      try {
        const tracer = new MissionTracer({ agentType: 'research' });
        const missions = await tracer.traceRun(runName);
        
        const researchAgents = missions.filter(m => 
          m.agentSpecificData?.sourcesFound > 0
        );
        
        if (researchAgents.length === 0) continue;
        
        const totalSources = researchAgents.reduce((sum, m) => 
          sum + (m.agentSpecificData.sourcesFound || 0), 0
        );
        
        const avgSources = (totalSources / researchAgents.length).toFixed(1);
        const maxSources = Math.max(...researchAgents.map(m => m.agentSpecificData.sourcesFound));
        
        comparison.push({
          domain: runName,
          researchAgents: researchAgents.length,
          totalSources,
          avgSources: parseFloat(avgSources),
          maxSources,
          bestAgent: researchAgents.find(m => m.agentSpecificData.sourcesFound === maxSources)?.agentId
        });
        
      } catch (error) {
        console.error(`⚠️  ${runName}: ${error.message}`);
      }
    }
    
    // Sort by total sources
    comparison.sort((a, b) => b.totalSources - a.totalSources);
    
    console.log('\n| Domain | Research Agents | Total Sources | Avg Sources | Max Sources |');
    console.log('|--------|----------------|---------------|-------------|-------------|');
    comparison.forEach(c => {
      console.log(`| ${c.domain.padEnd(20)} | ${String(c.researchAgents).padStart(2)} | ${String(c.totalSources).padStart(5)} | ${String(c.avgSources).padStart(5)} | ${String(c.maxSources).padStart(4)} |`);
    });
    console.log('');
    
    return comparison;
  }
}

// CLI Entry Point
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    console.log(`
COSMO Mission Tracer
Systematically trace research, analysis, and synthesis missions

Usage:
  node scripts/TRACE_RESEARCH_MISSIONS.js <run_name> [options]
  node scripts/TRACE_RESEARCH_MISSIONS.js --list
  node scripts/TRACE_RESEARCH_MISSIONS.js --compare

Options:
  --agent-type <type>    Filter: research, analysis, synthesis, planning
  --min-sources <n>      Minimum sources (research agents only)
  --format <fmt>         Output: summary (default), markdown, json
  --output <file>        Write to file instead of stdout
  --full                 Include all sources and complete details
  --list                 List all available runs
  --compare              Generate cross-domain comparison

Examples:
  # Trace Philosophy run
  node scripts/TRACE_RESEARCH_MISSIONS.js Philosophy
  
  # Research agents with 50+ sources
  node scripts/TRACE_RESEARCH_MISSIONS.js Biology --agent-type research --min-sources 50
  
  # Full markdown trace
  node scripts/TRACE_RESEARCH_MISSIONS.js Physics --format markdown --full > physics_trace.md
  
  # Compare all domain runs
  node scripts/TRACE_RESEARCH_MISSIONS.js --compare
`);
    process.exit(0);
  }
  
  // Handle --list
  if (args[0] === '--list') {
    MissionTracer.listRuns();
    process.exit(0);
  }
  
  // Handle --compare
  if (args[0] === '--compare') {
    const domainRuns = ['Biology', 'Chemistry', 'Physics', 'Psychology', 
                        'Philosophy', 'Mathematics', 'Art_and_Music', 
                        'History', 'Sociology', 'Medicine'];
    MissionTracer.generateComparison(domainRuns)
      .then(() => process.exit(0))
      .catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
      });
    return;
  }
  
  // Parse run name and options
  const runName = args[0];
  const options = {};
  
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--agent-type':
        options.agentType = args[++i];
        break;
      case '--min-sources':
        options.minSources = parseInt(args[++i]);
        break;
      case '--format':
        options.format = args[++i];
        break;
      case '--output':
        options.output = args[++i];
        break;
      case '--full':
        options.full = true;
        break;
    }
  }
  
  const tracer = new MissionTracer(options);
  tracer.traceRun(runName)
    .then(missions => {
      console.error(`\n✅ Traced ${missions.length} missions from ${runName}`);
      process.exit(0);
    })
    .catch(error => {
      console.error(`❌ Error: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { MissionTracer };
