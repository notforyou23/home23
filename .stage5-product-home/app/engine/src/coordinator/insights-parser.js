const fs = require('fs').promises;
const path = require('path');

/**
 * Insights Parser
 * 
 * Parses curated insights reports to extract actionable "Next Steps"
 * for integration into Meta-Coordinator strategic planning.
 */
class InsightsParser {
  constructor(logger) {
    this.logger = logger;
  }
  
  /**
   * Parse insights report and extract actionable next steps
   * @param {string} reportPath - Path to insights report markdown file
   * @returns {Object} Parsed insights with next steps
   */
  async parseReport(reportPath) {
    try {
      const content = await fs.readFile(reportPath, 'utf-8');
      return this.parseReportContent(content);
    } catch (error) {
      this.logger.warn('Failed to parse insights report', {
        reportPath,
        error: error.message
      });
      return null;
    }
  }
  
  /**
   * Parse insights report content
   */
  parseReportContent(content) {
    const result = {
      metadata: this.extractMetadata(content),
      alignments: [],
      technicalInsights: [],
      strategicInsights: [],
      operationalInsights: []
    };
    
    // Extract Goal Alignment & Next Steps section
    const alignmentSection = this.extractSection(content, '## Goal Alignment & Next Steps');
    if (alignmentSection) {
      result.alignments = this.parseAlignments(alignmentSection);
    }
    
    // Extract insight categories
    result.technicalInsights = this.extractInsightCategory(content, '## Technical Insights');
    result.strategicInsights = this.extractInsightCategory(content, '## Strategic Insights');
    result.operationalInsights = this.extractInsightCategory(content, '## Operational Insights');
    
    return result;
  }
  
  /**
   * Extract metadata from header
   */
  extractMetadata(content) {
    const metadata = {
      curationMode: null,
      rawInsights: 0,
      highValueInsights: 0,
      duration: 0,
      timestamp: null,
      cycleCount: null
    };
    
    // Extract cycle number from filename or content
    const cycleMatch = content.match(/cycle[_\s]+(\d+)/i);
    if (cycleMatch) {
      metadata.cycleCount = parseInt(cycleMatch[1]);
    }
    
    // Extract raw insights count
    const rawMatch = content.match(/Raw Insights Generated:\*\*\s*(\d+)/);
    if (rawMatch) {
      metadata.rawInsights = parseInt(rawMatch[1]);
    }
    
    // Extract high-value count
    const highValueMatch = content.match(/High-Value Insights Identified:\*\*\s*(\d+)/);
    if (highValueMatch) {
      metadata.highValueInsights = parseInt(highValueMatch[1]);
    }
    
    // Extract duration
    const durationMatch = content.match(/Curation Duration:\*\*\s*([\d.]+)s/);
    if (durationMatch) {
      metadata.duration = parseFloat(durationMatch[1]);
    }
    
    // Extract timestamp
    const timestampMatch = content.match(/Timestamp:\s*([^\n*]+)/);
    if (timestampMatch) {
      metadata.timestamp = timestampMatch[1].trim();
    }
    
    // Extract curation mode
    const modeMatch = content.match(/Curation Mode:\*\*\s*([^\n]+)/);
    if (modeMatch) {
      metadata.curationMode = modeMatch[1].trim();
    }
    
    return metadata;
  }
  
  /**
   * Extract a section from markdown content
   */
  extractSection(content, sectionHeader) {
    const headerIndex = content.indexOf(sectionHeader);
    if (headerIndex === -1) return null;
    
    // Find next ## header (same level)
    const afterHeader = content.slice(headerIndex + sectionHeader.length);
    const nextHeaderMatch = afterHeader.match(/\n## [^#]/);
    
    if (nextHeaderMatch) {
      return afterHeader.slice(0, nextHeaderMatch.index);
    }
    
    // If no next header, take rest of document
    return afterHeader;
  }
  
  /**
   * Parse Goal Alignment & Next Steps section
   */
  parseAlignments(sectionContent) {
    const alignments = [];
    
    // Split into individual alignment blocks (### Alignment N)
    const alignmentBlocks = sectionContent.split(/### Alignment \d+/);
    
    for (const block of alignmentBlocks) {
      if (!block.trim()) continue;
      
      const alignment = this.parseAlignmentBlock(block);
      if (alignment) {
        alignments.push(alignment);
      }
    }
    
    return alignments;
  }
  
  /**
   * Parse individual alignment block
   */
  parseAlignmentBlock(block) {
    const alignment = {
      insightRef: null,
      relatedGoals: [],
      contribution: null,
      nextStep: null,
      priority: null
    };
    
    // Extract Insight reference
    const insightMatch = block.match(/\*\*Insight:\*\*\s*#?(\d+)/);
    if (insightMatch) {
      alignment.insightRef = parseInt(insightMatch[1]);
    }
    
    // Extract Related Goals
    const goalsMatch = block.match(/\*\*Related Goals:\*\*\s*([^\n]+)/);
    if (goalsMatch) {
      const goalsText = goalsMatch[1];
      alignment.relatedGoals = goalsText.match(/goal_\d+/g) || [];
    }
    
    // Extract Contribution
    const contributionMatch = block.match(/\*\*Contribution:\*\*\s*([^\n]+(?:\n(?!\*\*)[^\n]+)*)/);
    if (contributionMatch) {
      alignment.contribution = contributionMatch[1].trim();
    }
    
    // Extract Next Step
    const nextStepMatch = block.match(/\*\*Next Step:\*\*\s*([^\n]+(?:\n(?!\*\*)[^\n]+)*)/);
    if (nextStepMatch) {
      alignment.nextStep = nextStepMatch[1].trim();
    }
    
    // Extract Priority
    const priorityMatch = block.match(/\*\*Priority:\*\*\s*(\w+)/);
    if (priorityMatch) {
      alignment.priority = priorityMatch[1].toLowerCase();
    }
    
    // Only return if we have the essential fields
    if (alignment.nextStep && alignment.priority) {
      return alignment;
    }
    
    return null;
  }
  
  /**
   * Extract insights from a category section
   */
  extractInsightCategory(content, categoryHeader) {
    const section = this.extractSection(content, categoryHeader);
    if (!section) return [];
    
    const insights = [];
    const insightBlocks = section.split(/### \d+\./);
    
    for (const block of insightBlocks) {
      if (!block.trim()) continue;
      
      const insight = this.parseInsightBlock(block);
      if (insight) {
        insights.push(insight);
      }
    }
    
    return insights;
  }
  
  /**
   * Parse individual insight block
   */
  parseInsightBlock(block) {
    const insight = {
      title: null,
      actionability: 0,
      strategicValue: 0,
      novelty: 0,
      content: null,
      source: null
    };
    
    // Extract title (first line)
    const titleMatch = block.match(/^\s*([^\n]+)/);
    if (titleMatch) {
      insight.title = titleMatch[1].trim();
    }
    
    // Extract scores
    const actionMatch = block.match(/Actionability:\*\*\s*(\d+)\/10/);
    if (actionMatch) {
      insight.actionability = parseInt(actionMatch[1]);
    }
    
    const valueMatch = block.match(/Strategic Value:\*\*\s*(\d+)\/10/);
    if (valueMatch) {
      insight.strategicValue = parseInt(valueMatch[1]);
    }
    
    const noveltyMatch = block.match(/Novelty:\*\*\s*(\d+)\/10/);
    if (noveltyMatch) {
      insight.novelty = parseInt(noveltyMatch[1]);
    }
    
    // Extract content (text between scores and source)
    const contentMatch = block.match(/\d+\/10[^\n]*\n\n([^\n]+(?:\n(?!\*\*Source)[^\n]+)*)/);
    if (contentMatch) {
      insight.content = contentMatch[1].trim();
    }
    
    // Extract source
    const sourceMatch = block.match(/\*\*Source:\*\*\s*([^\n]+)/);
    if (sourceMatch) {
      insight.source = sourceMatch[1].trim();
    }
    
    return insight.title ? insight : null;
  }
  
  /**
   * Filter alignments to only high-priority actionable items
   */
  filterHighPriority(alignments) {
    return alignments.filter(a => 
      a.priority === 'high' && 
      a.nextStep && 
      a.nextStep.length > 20
    );
  }
  
  /**
   * Infer agent type from next step description
   */
  inferAgentType(nextStep) {
    const lower = nextStep.toLowerCase();
    
    // Code creation keywords
    if (lower.match(/\b(implement|build|create|add|develop|generate|code|patch|module)\b/)) {
      // But check if it's document/spec creation
      if (lower.match(/\b(spec|document|report|write|draft|note|adr)\b/)) {
        return 'document_creation';
      }
      return 'code_creation';
    }
    
    // Execution keywords
    if (lower.match(/\b(run|execute|test|validate|verify|benchmark)\b/)) {
      return 'code_execution';
    }
    
    // Document creation keywords
    if (lower.match(/\b(write|draft|document|spec|report|note|adr|produce)\b/)) {
      return 'document_creation';
    }
    
    // Analysis keywords
    if (lower.match(/\b(analyze|review|audit|assess|evaluate|investigate)\b/)) {
      return 'analysis';
    }
    
    // Default to document creation for specs
    return 'document_creation';
  }
  
  /**
   * Convert alignments to urgent goal specs
   */
  convertAlignmentsToGoalSpecs(alignments, sourceReport) {
    const goalSpecs = [];
    
    for (const alignment of alignments) {
      const agentType = this.inferAgentType(alignment.nextStep);
      
      // Build goal spec
      const goalSpec = {
        description: alignment.nextStep,
        agentType: agentType,
        priority: 0.9, // High priority but slightly lower than Meta-Coordinator urgent goals (0.95)
        urgency: 'high',
        rationale: alignment.contribution 
          ? `Curated insight (actionability 8-9/10): ${alignment.contribution.substring(0, 200)}...`
          : 'High-value curated insight identified by Insight Curator',
        metadata: {
          source: 'insight_curator',
          insightRef: alignment.insightRef,
          relatedGoals: alignment.relatedGoals,
          sourceReport: sourceReport
        }
      };
      
      goalSpecs.push(goalSpec);
    }
    
    return goalSpecs;
  }
}

module.exports = { InsightsParser };

