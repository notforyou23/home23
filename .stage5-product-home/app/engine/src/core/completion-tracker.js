const fs = require('fs').promises;
const path = require('path');

/**
 * Completion Tracker
 * 
 * Monitors progress against success criteria defined in execution plan.
 * Provides real-time progress updates and completion detection.
 */
class CompletionTracker {
  constructor(plan, logger) {
    this.plan = plan;
    this.logger = logger;
    this.criteria = plan.successCriteria || [];
    this.progress = new Map(); // criterionId -> { status, evidence, checkedAt }
    this.startTime = Date.now();
    this.completionTime = null;
    this.lastDisplayTime = 0;
    
    // Initialize all criteria as pending
    this.criteria.forEach((criterion, idx) => {
      this.progress.set(idx, {
        criterion,
        status: 'pending', // pending | in_progress | completed
        evidence: null,
        checkedAt: null
      });
    });
  }

  /**
   * Update progress based on agent results from meta-coordinator
   * @param {Object} agentResults - Agent results with insights and findings
   */
  updateFromAgentResults(agentResults) {
    if (!agentResults || !agentResults.insights) return;
    
    const allText = [
      ...agentResults.insights.map(i => i.text || ''),
      ...agentResults.findings.map(f => f.text || '')
    ].join(' ').toLowerCase();
    
    // Check each criterion
    this.criteria.forEach((criterion, idx) => {
      const current = this.progress.get(idx);
      
      if (current.status === 'completed') {
        return; // Already completed
      }
      
      // Check if criterion is met
      const check = this.checkCriterion(criterion, {
        agentResults,
        allText,
        currentStatus: current.status
      });
      
      if (check.met && current.status !== 'completed') {
        this.progress.set(idx, {
          criterion,
          status: 'completed',
          evidence: check.evidence,
          checkedAt: Date.now()
        });
        
        this.logger?.debug('Success criterion met', {
          criterion: criterion.substring(0, 50) + '...',
          evidence: check.evidence
        });
      } else if (check.inProgress && current.status === 'pending') {
        this.progress.set(idx, {
          criterion,
          status: 'in_progress',
          evidence: check.evidence,
          checkedAt: Date.now()
        });
      }
    });
  }

  /**
   * Check if a specific criterion is met
   * @param {string} criterionText - The criterion to check
   * @param {Object} context - Context for checking (agent results, etc.)
   * @returns {Object} { met: boolean, inProgress: boolean, evidence: string }
   */
  checkCriterion(criterionText, context) {
    const lowerCriterion = criterionText.toLowerCase();
    const { allText, agentResults } = context;
    
    // File creation checks
    if (lowerCriterion.includes('output created') || lowerCriterion.includes('file created')) {
      const match = criterionText.match(/([a-z0-9_\-/.]+\.(md|json|html|txt|pdf))/i);
      if (match) {
        const filename = match[1];
        // Check if any agent mentioned creating this file
        if (allText.includes(filename) && 
            (allText.includes('created') || allText.includes('saved') || allText.includes('generated'))) {
          return {
            met: true,
            inProgress: false,
            evidence: `File ${filename} mentioned in agent results`
          };
        }
        // Check if work on this file is in progress
        if (allText.includes(filename) && allText.includes('generating')) {
          return {
            met: false,
            inProgress: true,
            evidence: `Work on ${filename} in progress`
          };
        }
      }
    }
    
    // Document reading checks
    if (lowerCriterion.includes('documents') && lowerCriterion.includes('read')) {
      const numberMatch = criterionText.match(/(\d+)\s+(?:documents|files)/i);
      if (numberMatch) {
        const expectedCount = parseInt(numberMatch[1]);
        // Count file reading mentions
        const fileReadCount = (allText.match(/read.*?file|analyzed.*?document/gi) || []).length;
        
        if (fileReadCount >= expectedCount) {
          return {
            met: true,
            inProgress: false,
            evidence: `${fileReadCount} files mentioned as read`
          };
        } else if (fileReadCount > 0) {
          return {
            met: false,
            inProgress: true,
            evidence: `${fileReadCount}/${expectedCount} files read so far`
          };
        }
      }
      
      // General document reading check
      if (allText.includes('read') && (allText.includes('document') || allText.includes('file'))) {
        return {
          met: true,
          inProgress: false,
          evidence: 'Documents read confirmed in agent results'
        };
      }
    }
    
    // Version/relationship identification checks
    if (lowerCriterion.includes('version') || lowerCriterion.includes('relationship')) {
      if (allText.includes('version') && allText.includes('identified')) {
        return {
          met: true,
          inProgress: false,
          evidence: 'Version relationships identified'
        };
      }
      if (allText.includes('version') && (allText.includes('analyzing') || allText.includes('comparing'))) {
        return {
          met: false,
          inProgress: true,
          evidence: 'Version analysis in progress'
        };
      }
    }
    
    // Timeline/chronological checks
    if (lowerCriterion.includes('timeline') || lowerCriterion.includes('chronological')) {
      if (allText.includes('timeline') && (allText.includes('created') || allText.includes('generated'))) {
        return {
          met: true,
          inProgress: false,
          evidence: 'Timeline created'
        };
      }
      if (allText.includes('timeline') || allText.includes('chronological')) {
        return {
          met: false,
          inProgress: true,
          evidence: 'Timeline work in progress'
        };
      }
    }
    
    // Change documentation checks
    if (lowerCriterion.includes('change') && lowerCriterion.includes('documented')) {
      const numberMatch = criterionText.match(/(\d+)\s+(?:major\s+)?changes/i);
      if (numberMatch) {
        const expectedChanges = parseInt(numberMatch[1]);
        const changeCount = (allText.match(/change|modification|update|diff/gi) || []).length;
        
        if (changeCount >= expectedChanges * 3) { // Generous threshold
          return {
            met: true,
            inProgress: false,
            evidence: `${changeCount} change mentions found`
          };
        } else if (changeCount > 0) {
          return {
            met: false,
            inProgress: true,
            evidence: `Changes being documented`
          };
        }
      }
    }
    
    // Generic keyword matching (last resort)
    const keywords = this.extractKeywords(lowerCriterion);
    let matchCount = 0;
    keywords.forEach(keyword => {
      if (allText.includes(keyword)) {
        matchCount++;
      }
    });
    
    if (matchCount >= keywords.length * 0.7) {
      return {
        met: true,
        inProgress: false,
        evidence: `${matchCount}/${keywords.length} keywords matched`
      };
    } else if (matchCount >= keywords.length * 0.3) {
      return {
        met: false,
        inProgress: true,
        evidence: `${matchCount}/${keywords.length} keywords matched (partial)`
      };
    }
    
    return {
      met: false,
      inProgress: false,
      evidence: null
    };
  }

  /**
   * Extract keywords from criterion text
   */
  extractKeywords(text) {
    // Remove common words and extract meaningful keywords
    const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
    const words = text.toLowerCase().split(/\s+/);
    return words
      .filter(word => word.length > 3 && !commonWords.includes(word))
      .filter((word, idx, arr) => arr.indexOf(word) === idx); // unique
  }

  /**
   * Display progress in terminal
   */
  displayProgress() {
    // Don't spam - only show every 30 seconds minimum
    const now = Date.now();
    if (now - this.lastDisplayTime < 30000 && !this.isComplete()) {
      return;
    }
    this.lastDisplayTime = now;
    
    const lines = [];
    
    lines.push('');
    lines.push('🎯 TASK PROGRESS:');
    
    let completedCount = 0;
    let inProgressCount = 0;
    let pendingCount = 0;
    
    this.progress.forEach((item, idx) => {
      const symbol = item.status === 'completed' ? '✓' : 
                     item.status === 'in_progress' ? '○' : 
                     '☐';
      
      let displayText = `  ${symbol} ${item.criterion}`;
      if (item.status === 'in_progress' && item.evidence) {
        displayText += ` (${item.evidence})`;
      }
      
      lines.push(displayText);
      
      if (item.status === 'completed') completedCount++;
      else if (item.status === 'in_progress') inProgressCount++;
      else pendingCount++;
    });
    
    lines.push('');
    const totalCriteria = this.criteria.length;
    const percentage = totalCriteria > 0 ? Math.round((completedCount / totalCriteria) * 100) : 0;
    
    lines.push(`  Progress: ${percentage}% (${completedCount}/${totalCriteria} criteria met)`);
    
    const elapsed = this.formatDuration(now - this.startTime);
    lines.push(`  Elapsed: ${elapsed}`);
    lines.push('');
    
    this.logger?.info(lines.join('\n'));
  }

  /**
   * Check if all criteria are met
   */
  isComplete() {
    if (this.completionTime) return true; // Already marked complete
    
    const allCompleted = Array.from(this.progress.values()).every(item => item.status === 'completed');
    
    if (allCompleted && this.criteria.length > 0) {
      this.completionTime = Date.now();
      return true;
    }
    
    return false;
  }

  /**
   * Generate completion report
   */
  generateCompletionReport() {
    const lines = [];
    
    lines.push('');
    lines.push('╔══════════════════════════════════════════════════════════╗');
    lines.push('║              TASK COMPLETION REPORT                      ║');
    lines.push('╚══════════════════════════════════════════════════════════╝');
    lines.push('');
    
    if (this.isComplete()) {
      lines.push('All success criteria met:');
      this.progress.forEach((item, idx) => {
        lines.push(`  ✓ ${item.criterion}`);
      });
    } else {
      lines.push('Task in progress:');
      const completed = Array.from(this.progress.values()).filter(i => i.status === 'completed');
      const pending = Array.from(this.progress.values()).filter(i => i.status !== 'completed');
      
      if (completed.length > 0) {
        lines.push('');
        lines.push('Completed:');
        completed.forEach(item => {
          lines.push(`  ✓ ${item.criterion}`);
        });
      }
      
      if (pending.length > 0) {
        lines.push('');
        lines.push('Pending:');
        pending.forEach(item => {
          const symbol = item.status === 'in_progress' ? '○' : '☐';
          lines.push(`  ${symbol} ${item.criterion}`);
        });
      }
    }
    
    lines.push('');
    
    // Deliverable info
    if (this.plan.deliverable) {
      const deliverablePath = `${this.plan.deliverable.location || 'runtime/outputs/'}${this.plan.deliverable.filename || 'output.md'}`;
      lines.push(`Deliverable: ${deliverablePath}`);
    }
    
    const duration = this.formatDuration(
      (this.completionTime || Date.now()) - this.startTime
    );
    lines.push(`Duration: ${duration}`);
    lines.push('');
    
    if (this.isComplete() && this.plan.deliverable) {
      const deliverablePath = `${this.plan.deliverable.location || 'runtime/outputs/'}${this.plan.deliverable.filename || 'output.md'}`;
      lines.push(`View output: cat ${deliverablePath}`);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Save completion report to file
   */
  async saveCompletionReport(outputPath) {
    const lines = [];
    
    lines.push('# Task Completion Report');
    lines.push('');
    lines.push(`**Task:** ${this.plan.strategy || 'Guided task'}`);
    lines.push(`**Started:** ${new Date(this.startTime).toISOString()}`);
    if (this.completionTime) {
      lines.push(`**Completed:** ${new Date(this.completionTime).toISOString()}`);
    }
    lines.push('');
    
    lines.push('## Success Criteria');
    lines.push('');
    this.progress.forEach((item, idx) => {
      const checkbox = item.status === 'completed' ? '[x]' : '[ ]';
      lines.push(`${checkbox} ${item.criterion}`);
      if (item.evidence) {
        lines.push(`   - Evidence: ${item.evidence}`);
      }
    });
    lines.push('');
    
    lines.push('## Summary');
    lines.push('');
    const completedCount = Array.from(this.progress.values()).filter(i => i.status === 'completed').length;
    lines.push(`- Criteria met: ${completedCount}/${this.criteria.length}`);
    lines.push(`- Duration: ${this.formatDuration((this.completionTime || Date.now()) - this.startTime)}`);
    
    if (this.plan.deliverable) {
      lines.push(`- Deliverable: ${this.plan.deliverable.location || 'runtime/outputs/'}${this.plan.deliverable.filename || 'output.md'}`);
    }
    lines.push('');
    
    await fs.writeFile(outputPath, lines.join('\n'), 'utf-8');
    this.logger?.info('Completion report saved', { path: outputPath });
  }
}

module.exports = { CompletionTracker };

