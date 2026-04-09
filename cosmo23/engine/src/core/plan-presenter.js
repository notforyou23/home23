const fs = require('fs').promises;
const path = require('path');

/**
 * Plan Presenter
 * 
 * Formats and displays guided mode execution plans in terminal
 * and saves them to markdown files for later reference.
 */
class PlanPresenter {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Display plan in terminal with box-drawn formatting
   * @param {Object} plan - Execution plan from GuidedModePlanner
   * @param {Object} guidedFocus - Guided focus configuration
   * @returns {string} Formatted plan text
   */
  displayPlan(plan, guidedFocus) {
    const lines = [];
    
    lines.push('');
    lines.push('╔══════════════════════════════════════════════════════════╗');
    lines.push('║              GUIDED EXECUTION PLAN                       ║');
    lines.push('╚══════════════════════════════════════════════════════════╝');
    lines.push('');
    
    // Task description
    lines.push(`TASK: ${guidedFocus.domain}`);
    if (guidedFocus.context && guidedFocus.context !== 'No additional context provided') {
      lines.push(`CONTEXT: ${guidedFocus.context}`);
    }
    lines.push('');
    
    // Strategy
    if (plan.strategy) {
      lines.push('STRATEGY:');
      lines.push(this.wrapText(plan.strategy, 60, '  '));
      lines.push('');
    }
    
    // Resources
    if (plan.requiredResources && plan.requiredResources.length > 0) {
      lines.push('RESOURCES REQUIRED:');
      plan.requiredResources.forEach(resource => {
        lines.push(`  ✓ ${resource}`);
      });
      lines.push('');
    }
    
    // Execution phases
    if (plan.taskPhases && plan.taskPhases.length > 0) {
      lines.push('EXECUTION PHASES:');
      plan.taskPhases.forEach(phase => {
        lines.push(`  Phase ${phase.number}: ${phase.name}`);
        if (phase.description) {
          const wrappedDesc = this.wrapText(phase.description, 54, '    - ');
          lines.push(wrappedDesc);
        }
      });
      lines.push('');
    }
    
    // Agents to spawn
    if (plan.agentMissions && plan.agentMissions.length > 0) {
      lines.push('AGENTS TO SPAWN:');
      plan.agentMissions.forEach((mission, idx) => {
        lines.push(`  ${idx + 1}. ${this.formatAgentType(mission.type)} Agent`);
        lines.push(`     Mission: ${mission.mission}`);
        lines.push(`     Priority: ${(mission.priority || 'medium').toUpperCase()}`);
        if (mission.expectedOutput) {
          lines.push(`     Expected Output: ${mission.expectedOutput}`);
        }
      });
      lines.push('');
    }
    
    // Success criteria
    if (plan.successCriteria && plan.successCriteria.length > 0) {
      lines.push('SUCCESS CRITERIA:');
      plan.successCriteria.forEach(criterion => {
        lines.push(`  ☐ ${criterion}`);
      });
      lines.push('');
    }
    
    // Deliverable specification
    if (plan.deliverable) {
      lines.push('DELIVERABLE:');
      lines.push(`  Type: ${this.formatDeliverableType(plan.deliverable.type)}`);
      lines.push(`  Location: ${plan.deliverable.location || 'runtime/outputs/'}${plan.deliverable.filename || 'output.md'}`);
      
      if (plan.deliverable.requiredSections && plan.deliverable.requiredSections.length > 0) {
        lines.push('  Required Sections:');
        plan.deliverable.requiredSections.forEach(section => {
          lines.push(`    - ${section}`);
        });
      }
      
      if (plan.deliverable.minimumContent) {
        lines.push(`  Minimum Content: ${plan.deliverable.minimumContent}`);
      }
      lines.push('');
    }
    
    // Execution mode
    if (plan.executionMode) {
      lines.push(`EXECUTION MODE: ${plan.executionMode.toUpperCase()}`);
      if (plan.executionMode === 'guided-exclusive') {
        lines.push('  (Exclusive guided execution; autonomous spawning is disabled)');
      } else if (plan.executionMode === 'mixed') {
        lines.push('  (Task-focused with autonomous exploration allowed)');
      } else if (plan.executionMode === 'strict') {
        lines.push('  (Strict task focus, minimal autonomous exploration)');
      } else if (plan.executionMode === 'advisory') {
        lines.push('  (Autonomous with task awareness)');
      }
      lines.push('');
    }
    
    lines.push('Plan will be saved to: runtime/guided-plan.md');
    lines.push('Starting execution...');
    lines.push('');
    
    return lines.join('\n');
  }

  /**
   * Save plan to markdown file
   * PRODUCTION: Archives old plan before saving new one
   * @param {Object} plan - Execution plan
   * @param {Object} guidedFocus - Guided focus configuration
   * @param {string} outputPath - Path to save plan
   * @param {Object} options - { capabilities?, agentContext? }
   */
  async savePlanToFile(plan, guidedFocus, outputPath, options = {}) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // PRODUCTION: Archive old plan if it exists (prevents overwriting history)
    try {
      const stats = await fs.stat(outputPath);
      if (stats.isFile()) {
        // Old plan exists - archive it with timestamp
        const timestamp = stats.mtime.getTime();
        const dir = path.dirname(outputPath);
        const ext = path.extname(outputPath);
        const base = path.basename(outputPath, ext);
        const archivedPath = path.join(dir, `${base}-${timestamp}${ext}`);
        
        await fs.rename(outputPath, archivedPath);
        this.logger?.info('📦 Archived previous plan', { 
          old: path.basename(outputPath), 
          archived: path.basename(archivedPath) 
        });
      }
    } catch (error) {
      // File doesn't exist (first plan) or can't access - that's fine
      if (error.code !== 'ENOENT') {
        this.logger?.debug('Could not archive old plan', { error: error.message });
      }
    }
    
    const lines = [];
    
    lines.push('# Guided Execution Plan');
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Task:** ${guidedFocus.domain}`);
    lines.push('');
    
    // Strategy
    lines.push('## Strategy');
    lines.push('');
    lines.push(plan.strategy || 'Execute guided task');
    lines.push('');
    
    // Resources
    if (plan.requiredResources && plan.requiredResources.length > 0) {
      lines.push('## Required Resources');
      lines.push('');
      plan.requiredResources.forEach(resource => {
        lines.push(`- ${resource}`);
      });
      lines.push('');
    }
    
    // Execution phases
    if (plan.taskPhases && plan.taskPhases.length > 0) {
      lines.push('## Execution Phases');
      lines.push('');
      plan.taskPhases.forEach(phase => {
        lines.push(`### Phase ${phase.number}: ${phase.name}`);
        lines.push('');
        if (phase.description) {
          lines.push(phase.description);
          lines.push('');
        }
        if (phase.dependencies && phase.dependencies.length > 0) {
          lines.push(`**Dependencies:** ${phase.dependencies.join(', ')}`);
          lines.push('');
        }
      });
    }
    
    // Agent missions
    if (plan.agentMissions && plan.agentMissions.length > 0) {
      lines.push('## Agent Missions');
      lines.push('');
      plan.agentMissions.forEach((mission, idx) => {
        lines.push(`### ${idx + 1}. ${this.formatAgentType(mission.type)} Agent`);
        lines.push('');
        lines.push(`**Mission:** ${mission.mission}`);
        lines.push(`**Priority:** ${mission.priority || 'medium'}`);
        if (mission.expectedOutput) {
          lines.push(`**Expected Output:** ${mission.expectedOutput}`);
        }
        if (mission.tools && mission.tools.length > 0) {
          lines.push(`**Tools:** ${mission.tools.join(', ')}`);
        }
        lines.push('');
      });
    }
    
    // Success criteria
    if (plan.successCriteria && plan.successCriteria.length > 0) {
      lines.push('## Success Criteria');
      lines.push('');
      plan.successCriteria.forEach(criterion => {
        lines.push(`- [ ] ${criterion}`);
      });
      lines.push('');
    }
    
    // Deliverable
    if (plan.deliverable) {
      lines.push('## Deliverable Specification');
      lines.push('');
      lines.push(`**Type:** ${this.formatDeliverableType(plan.deliverable.type)}`);
      lines.push(`**Filename:** ${plan.deliverable.filename || 'output.md'}`);
      lines.push(`**Location:** ${plan.deliverable.location || 'runtime/outputs/'}`);
      lines.push('');
      
      if (plan.deliverable.requiredSections && plan.deliverable.requiredSections.length > 0) {
        lines.push('**Required Sections:**');
        lines.push('');
        plan.deliverable.requiredSections.forEach(section => {
          lines.push(`- ${section}`);
        });
        lines.push('');
      }
      
      if (plan.deliverable.minimumContent) {
        lines.push(`**Minimum Content:** ${plan.deliverable.minimumContent}`);
        lines.push('');
      }
    }
    
    // Execution mode
    if (plan.executionMode) {
      lines.push('## Execution Mode');
      lines.push('');
      lines.push(`**Mode:** ${plan.executionMode}`);
      lines.push('');
      if (plan.executionMode === 'guided-exclusive') {
        lines.push('Exclusive guided execution. Autonomous spawning remains disabled until the guided thread completes or fails.');
      } else if (plan.executionMode === 'mixed') {
        lines.push('Task-focused execution with autonomous exploration allowed.');
      } else if (plan.executionMode === 'strict') {
        lines.push('Strict task focus with minimal autonomous exploration.');
      } else if (plan.executionMode === 'advisory') {
        lines.push('Autonomous exploration with task awareness.');
      }
      lines.push('');
    }
    
    // Configuration
    lines.push('## Configuration');
    lines.push('');
    lines.push('```yaml');
    lines.push(`domain: "${guidedFocus.domain}"`);
    if (guidedFocus.context) {
      lines.push(`context: "${guidedFocus.context}"`);
    }
    if (guidedFocus.depth) {
      lines.push(`depth: ${guidedFocus.depth}`);
    }
    lines.push(`executionMode: ${plan.executionMode || 'guided-exclusive'}`);
    lines.push('```');
    lines.push('');
    
    lines.push('---');
    lines.push('');
    lines.push('*Plan generated by COSMO Guided Mode Planner*');
    
    const markdown = lines.join('\n');
    
    // Prefer embodied path (Executive Ring + FrontierGate) when available
    if (options?.capabilities && options.capabilities.writeFile) {
      // PRODUCTION: outputPath is already absolute from pathResolver
      // PathResolver.resolve() handles absolute paths correctly (returns as-is)
      const result = await options.capabilities.writeFile(
        outputPath,  // Already absolute, PathResolver will handle it
        markdown,
        options.agentContext || { agentId: 'meta_coordinator', agentType: 'coordinator', missionGoal: guidedFocus?.domain }
      );
      
      if (result?.success) {
        this.logger?.info('📋 Execution plan saved', { path: outputPath });
        return;
      }
      
      // If capabilities declined, do not fall back to bypass Executive
      if (result?.skipped) {
        this.logger?.warn('📋 Execution plan save skipped by Executive', {
          path: outputPath,
          reason: result.reason
        });
        return;
      }
      
      // For transient failures, fall back to fs (plan file is convenience, not mission-critical)
      this.logger?.warn('📋 Capabilities write failed, falling back to fs', {
        path: outputPath,
        error: result?.error || result?.reason
      });
    }
    
    await fs.writeFile(outputPath, markdown, 'utf-8');
    
    this.logger?.info('📋 Execution plan saved', { path: outputPath });
  }

  /**
   * Format agent type for display
   */
  formatAgentType(type) {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Format deliverable type for display
   */
  formatDeliverableType(type) {
    const typeMap = {
      'markdown': 'Markdown document',
      'html': 'HTML document',
      'json': 'JSON data file',
      'pdf-style-md': 'PDF-style Markdown document'
    };
    return typeMap[type] || type;
  }

  /**
   * Wrap text to specified width with prefix
   */
  wrapText(text, width, prefix = '') {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = prefix;
    
    words.forEach(word => {
      if ((currentLine + word).length > width) {
        if (currentLine.trim()) {
          lines.push(currentLine);
        }
        currentLine = prefix + word + ' ';
      } else {
        currentLine += word + ' ';
      }
    });
    
    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }
    
    return lines.join('\n');
  }
}

module.exports = { PlanPresenter };
