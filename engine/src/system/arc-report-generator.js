// src/system/arc-report-generator.js
const fs = require('fs').promises;
const path = require('path');

/**
 * ArcReportGenerator - Generates comprehensive arc reports
 * 
 * Purpose:
 * - Documents complete cognitive arc
 * - Captures goals, agents, findings, evidence
 * - Integrates determinism reports
 * - Human-readable + machine-parsable
 * 
 * Called at arc closure (when COSMO halts)
 */
class ArcReportGenerator {
  constructor(config, logger, capabilities = null) {
    this.config = config;
    this.logger = logger;
    this.capabilities = capabilities;
  }
  
  setCapabilities(capabilities) {
    this.capabilities = capabilities;
  }

  /**
   * Generate complete arc report
   * @param {Object} arcData - Data from orchestrator
   * @returns {Object} { reportPath, reportContent }
   */
  async generateReport(arcData) {
    const {
      arcId,
      startTime,
      endTime,
      cycleCount,
      haltReason,
      goals,
      agents,
      thoughts,
      recursivePlannerState,
      manifestData,
      validationData,
      memoryStats
    } = arcData;

    const report = this.buildReportMarkdown({
      arcId,
      startTime,
      endTime,
      cycleCount,
      haltReason,
      goals,
      agents,
      thoughts,
      recursivePlannerState,
      manifestData,
      validationData,
      memoryStats
    });

    // Save report
    const reportsDir = path.join(arcData.runRoot || 'runtime', 'outputs', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    
    const reportPath = path.join(reportsDir, `arc_report_${arcId}.md`);
    
    if (this.capabilities && this.capabilities.writeFile) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), reportPath),
        report,
        { agentId: 'arc_report_generator', agentType: 'builder', missionGoal: `arc:${arcId}` }
      );
      
      // Respect Executive skip (do not bypass)
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to write arc report');
      }
    } else {
      await fs.writeFile(reportPath, report, 'utf8');
    }

    this.logger.info('✅ Arc report generated', {
      path: reportPath,
      size: report.length
    });

    return { reportPath, reportContent: report };
  }

  buildReportMarkdown(data) {
    const {
      arcId,
      startTime,
      endTime,
      cycleCount,
      haltReason,
      goals = {},
      agents = {},
      thoughts = [],
      recursivePlannerState = {},
      manifestData = {},
      validationData = {},
      memoryStats = {}
    } = data;

    const duration = endTime - startTime;
    const durationMin = (duration / 60000).toFixed(1);

    return `# COSMO V3 ARC REPORT

**Arc ID:** \`${arcId}\`  
**Duration:** ${cycleCount} cycles (${durationMin} minutes)  
**Started:** ${new Date(startTime).toISOString()}  
**Ended:** ${new Date(endTime).toISOString()}  
**Halt Reason:** ${haltReason}  

---

## 1. Executive Summary

**Arc Purpose:** ${goals.initial ? goals.initial[0]?.description?.substring(0, 200) : 'Autonomous exploration'}

**Outcome:** ${this.summarizeOutcome(haltReason, goals, agents)}

**Convergence:** ${haltReason === 'goal_exhaustion' ? 'All goals completed' : haltReason === 'stagnation' ? 'Progress stagnated' : haltReason}

---

## 2. Goals Pursued

### Initial Goals (${goals.initial?.length || 0})
${this.formatGoalList(goals.initial)}

### Recursive Goals Added (${goals.recursive?.length || 0})
${this.formatGoalList(goals.recursive)}

### Goals Completed (${goals.completed?.length || 0})
${goals.completed?.length || 0} goals completed during this arc

### Goals Remaining (${goals.remaining?.length || 0})
${goals.remaining?.length > 0 ? this.formatGoalList(goals.remaining) : '_None - arc complete_'}

---

## 3. Agent Activity

**Total Agents Spawned:** ${agents.total || 0}

**By Type:**
${this.formatAgentBreakdown(agents.byType)}

**Auto-Spawned from Routing:** ${agents.autoSpawned || 0}

---

## 4. Cognitive Timeline

**Total Cycles:** ${cycleCount}  
**Introspection Scans:** ${Math.floor(cycleCount / 3)}  
**Coordinator Reviews:** ${Math.floor(cycleCount / 50)}  
**Recursive Evaluations:** ${recursivePlannerState.metaIterations || 0}  

**Key Thought Samples:**
${this.formatThoughtSamples(thoughts)}

---

## 5. Evidence & Verification

### Manifest Summary
${manifestData.artifact_count ? `
- **Artifacts:** ${manifestData.artifact_count} files
- **Merkle Root:** \`${manifestData.merkle_root}\`
- **Algorithm:** ${manifestData.algorithm || 'sha256'}
` : '_No manifest generated_'}

### Validation Report
${validationData.status ? `
- **Status:** ${validationData.status.toUpperCase()}
- **Verified:** ${validationData.artifacts_verified || 0} files
- **Failed:** ${validationData.artifacts_failed || 0} files
- **Errors:** ${validationData.errors?.length || 0}
` : '_No validation run_'}

---

## 6. Memory Integration

**Memory Nodes at Start:** ${memoryStats.nodesStart || 0}  
**Memory Nodes at End:** ${memoryStats.nodesEnd || 0}  
**New Nodes Created:** ${(memoryStats.nodesEnd || 0) - (memoryStats.nodesStart || 0)}  
**Introspection Nodes:** ${memoryStats.introspectionNodes || 0}  

---

## 7. Recursive Planning Summary

${recursivePlannerState.metaIterations ? `
**Meta-Iterations:** ${recursivePlannerState.metaIterations}  
**Stagnation Count:** ${recursivePlannerState.stagnationCount || 0}  
**Last Drift Score:** ${recursivePlannerState.lastDriftScore?.toFixed(2) || 'N/A'}%  
**Last Alert Count:** ${recursivePlannerState.lastAlertCount || 0}  
` : '_Recursive planning not enabled_'}

---

## 8. Outputs & Deliverables

${manifestData.artifacts ? `
**Total Outputs:** ${manifestData.artifacts.length} files

**By Agent Type:**
${this.formatOutputsByType(manifestData.artifacts)}

**Recent Outputs:**
${this.formatRecentOutputs(manifestData.artifacts.slice(0, 10))}
` : '_No outputs catalogued_'}

---

## 9. Arc Metadata (Machine-Readable)

\`\`\`json
{
  "arc_id": "${arcId}",
  "version": "3.0",
  "start_time": ${startTime},
  "end_time": ${endTime},
  "cycle_count": ${cycleCount},
  "halt_reason": "${haltReason}",
  "goals": {
    "initial": ${goals.initial?.length || 0},
    "recursive": ${goals.recursive?.length || 0},
    "completed": ${goals.completed?.length || 0}
  },
  "agents": {
    "total": ${agents.total || 0},
    "auto_spawned": ${agents.autoSpawned || 0}
  },
  "memory": {
    "nodes_added": ${(memoryStats.nodesEnd || 0) - (memoryStats.nodesStart || 0)},
    "introspection_nodes": ${memoryStats.introspectionNodes || 0}
  },
  "verification": {
    "manifest_generated": ${Boolean(manifestData.merkle_root)},
    "validation_passed": ${validationData.status === 'pass'},
    "artifacts_verified": ${validationData.artifacts_verified || 0}
  }
}
\`\`\`

---

## 10. Reproducibility

**To reproduce this arc:**
1. Use manifest: \`runtime/outputs/manifests/manifest.json\`
2. Merkle root: \`${manifestData.merkle_root || 'N/A'}\`
3. Validation report: \`runtime/outputs/reports/validation_report.json\`

**Arc is:** ${validationData.status === 'pass' ? '✅ Verified and reproducible' : '⚠️ Validation issues present'}

---

_Generated by COSMO V3 Recursive Cognitive Engine_  
_Arc closed at: ${new Date(endTime).toISOString()}_
`;
  }

  summarizeOutcome(haltReason, goals, agents) {
    if (haltReason === 'goal_exhaustion') {
      return `Successfully completed ${goals.completed?.length || 0} goals with ${agents.total || 0} agents`;
    } else if (haltReason === 'stagnation') {
      return `Progress stagnated after ${goals.completed?.length || 0} goals completed`;
    } else if (haltReason === 'max_meta_iterations') {
      return `Reached maximum recursive depth (${agents.total || 0} agents spawned)`;
    } else {
      return `Arc terminated: ${haltReason}`;
    }
  }

  formatGoalList(goalArray) {
    if (!goalArray || goalArray.length === 0) return '_None_\n';
    return goalArray.slice(0, 10).map((g, i) => 
      `${i + 1}. **${g.id}**: ${g.description?.substring(0, 100)}...`
    ).join('\n') + (goalArray.length > 10 ? `\n_...and ${goalArray.length - 10} more_` : '');
  }

  formatAgentBreakdown(byType) {
    if (!byType || Object.keys(byType).length === 0) return '_No agents spawned_\n';
    return Object.entries(byType)
      .map(([type, count]) => `- **${type}**: ${count}`)
      .join('\n');
  }

  formatThoughtSamples(thoughts) {
    if (!thoughts || thoughts.length === 0) return '_No thoughts recorded_\n';
    return thoughts.slice(0, 5).map(t =>
      `- **Cycle ${t.cycle}**: "${t.thought?.substring(0, 100)}..."`
    ).join('\n');
  }

  formatOutputsByType(artifacts) {
    const byType = {};
    artifacts.forEach(a => {
      const parts = a.path.split('/');
      const type = parts[0] || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    });
    return Object.entries(byType)
      .map(([type, count]) => `- **${type}**: ${count} files`)
      .join('\n');
  }

  formatRecentOutputs(artifacts) {
    if (!artifacts || artifacts.length === 0) return '_None_\n';
    return artifacts.map(a =>
      `- \`${a.path}\` (${(a.size / 1024).toFixed(1)} KB)`
    ).join('\n');
  }
}

module.exports = { ArcReportGenerator };

