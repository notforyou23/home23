const { BaseAgent } = require('./base-agent');
const { DeliverableManifest } = require('./deliverable-manifest');

/**
 * SynthesisAgent - Report writing and knowledge consolidation specialist
 * 
 * Purpose:
 * - Synthesizes accumulated knowledge on a topic into coherent reports
 * - Consolidates insights from multiple sources and agents
 * - Creates structured summaries of complex information
 * - Identifies knowledge gaps and areas for further exploration
 * 
 * Use Cases:
 * - Creating comprehensive reports on completed research
 * - Consolidating insights from multiple analysis sessions
 * - Summarizing what the system has learned about a topic
 * - Generating documentation of cognitive work
 */
class SynthesisAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## SynthesisAgent Behavioral Specification

You consolidate knowledge into structured reports. Integrate across sources — don't restate.
Build arguments with evidence chains. Output: comprehensive report with sections, citations, and knowledge gaps.

### Operating Principles
- Synthesize, don't summarize: add value by finding connections across sources
- Every claim in the report must trace back to a memory node or agent finding
- Structure sections to build a coherent argument, not a list of topics
- Identify and explicitly call out knowledge gaps — what the system does NOT know yet
- When assembling final deliverables, maintain technical accuracy from source artifacts
- Skip failed sections entirely rather than inserting placeholder noise
- Executive summaries must stand alone — a reader should get full value without the body
- Hot topics and recent agent insights get priority coverage
- Your output is often the terminal artifact in a research pipeline — quality is paramount
- Preserve provenance: note which agents/sources contributed to each section`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.sourceNodes = [];
    this.sections = [];
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('📝 SynthesisAgent: Starting synthesis mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      taskId: this.mission.taskId,
      description: this.mission.description
    }, 3);

    const preFlightData = await this.gatherPreFlightContext();

    // NEW: Check if this is final deliverable assembly
    const isFinalDeliverable = this.mission.metadata?.isFinalSynthesis || 
                                (this.mission.description && 
                                 this.mission.description.includes('Assemble Final Deliverable'));
    
    if (isFinalDeliverable) {
      this.logger.info('📦 Executing final deliverable assembly', {
        agentId: this.agentId,
        taskId: this.mission.taskId
      }, 3);
      return await this.assembleFinalDeliverable();
    }

    await this.reportProgress(10, 'Gathering relevant knowledge');

    // NEW: Check what's been synthesized before
    const previousSynthesis = await this.checkExistingKnowledge(this.mission.description, 2);
    if (previousSynthesis && previousSynthesis.hasKnowledge) {
      this.logger.info('📚 Found previous synthesis work', {
        relevantNodes: previousSynthesis.relevantNodes,
        willUpdate: true,
        note: 'This synthesis will incorporate latest findings'
      });
    }

    // NEW: Get coordinator context for strategic alignment
    const strategicContext = await this.getStrategicContext();
    if (strategicContext) {
      this.logger.info('🎯 Synthesis aligned with strategic priorities', {
        hasRecommendations: !!strategicContext.recommendations
      });
    }

    // NEW: Check recent agent activity for fresh findings
    const agentActivity = await this.checkAgentActivity();
    if (agentActivity) {
      const recentWorkTypes = agentActivity.recentTypes.slice(0, 5);
      this.logger.info('🤝 Recent agent work detected', {
        types: recentWorkTypes,
        willIncorporate: true
      });
      
      // Agents recently completed - their findings are fresh in memory
      const hasRecentResearch = recentWorkTypes.includes('research');
      const hasRecentAnalysis = recentWorkTypes.includes('analysis');
      const hasRecentCode = recentWorkTypes.includes('code_execution');
      
      if (hasRecentResearch || hasRecentAnalysis || hasRecentCode) {
        this.logger.info('Synthesis incorporates fresh agent work', {
          sources: recentWorkTypes.join(', ')
        });
      }
    }

    // Step 1: Gather relevant knowledge from memory
    const knowledgeBase = await this.gatherRelevantKnowledge();
    
    if (knowledgeBase.nodes.length === 0) {
      this.logger.info('📭 No existing knowledge in memory (fresh start)', {
        agentId: this.agentId
      });
      // Continue anyway - can synthesize from mission description and MCP files
    }

    // NEW: Use cluster analysis to understand knowledge domains
    const clusters = await this.getKnowledgeClusters();
    this.logger.info('🗺️  Knowledge clusters for synthesis', {
      clusterCount: clusters.size,
      largestClusterSize: Math.max(...Array.from(clusters.values()).map(nodes => nodes.length), 0)
    });

    // NEW: Identify hot topics to prioritize in synthesis
    const hotTopics = await this.getHotTopics(10);
    this.logger.info('🔥 Hot topics to emphasize', {
      topics: hotTopics.slice(0, 5).map(t => t.concept?.substring(0, 40))
    });

    // NEW: Check recent insights from all agent types
    const recentInsights = await this.aggregateAgentInsights(
      ['research', 'analysis', 'code_execution', 'exploration'],
      7200000 // Last 2 hours
    );
    this.logger.info('🤝 Recent agent insights', {
      research: recentInsights.research?.count || 0,
      analysis: recentInsights.analysis?.count || 0,
      code_execution: recentInsights.code_execution?.count || 0,
      exploration: recentInsights.exploration?.count || 0
    });

    await this.reportProgress(30, `Gathered ${knowledgeBase.nodes.length} memory nodes`);

    // Step 2: Structure the synthesis
    const structure = await this.createSynthesisStructure(knowledgeBase);
    this.sections = structure.sections;
    
    await this.reportProgress(45, 'Synthesis structure created');

    // Step 3: Generate sections
    const generatedSections = [];
    
    for (let i = 0; i < structure.sections.length; i++) {
      const section = structure.sections[i];
      
      this.logger.info('✍️  Generating section', {
        agentId: this.agentId,
        sectionTitle: section.title,
        sectionNum: i + 1,
        total: structure.sections.length
      }, 3);

      try {
        const content = await this.generateSection(section, knowledgeBase);
        
        // CRITICAL: Skip failed sections instead of adding placeholder noise
        if (content === null || content === undefined) {
          this.logger.error('❌ Section generation returned null - SKIPPING', {
            section: section.title,
            action: 'Section omitted from report'
          });
          continue; // Skip to next section
        }
        
        generatedSections.push({
          title: section.title,
          content
        }, 3);
        
        await this.reportProgress(
          45 + (i + 1) * (35 / structure.sections.length),
          `Generated section: ${section.title}`
        );
      } catch (error) {
        this.logger.error('❌ Section generation threw error - SKIPPING', {
          section: section.title,
          error: error.message,
          action: 'Section omitted from report'
        });
        
        // Error already logged - don't save to memory (transient error, not knowledge)
        // Don't add placeholder - just skip to next section
        continue;
      }
    }

    // Step 4: Create executive summary
    await this.reportProgress(85, 'Creating executive summary');
    const executiveSummary = await this.createExecutiveSummary(generatedSections);

    // Step 5: Identify knowledge gaps
    await this.reportProgress(92, 'Identifying knowledge gaps');
    const gaps = await this.identifyKnowledgeGaps(knowledgeBase, generatedSections);

    // Step 6: Compile final report
    const report = this.compileReport({
      executiveSummary,
      sections: generatedSections,
      knowledgeGaps: gaps,
      metadata: {
        sourcesConsulted: knowledgeBase.nodes.length,
        sectionsGenerated: generatedSections.length,
        createdAt: new Date()
      }
    }, 3);

    // Step 7: Add report to memory
    await this.reportProgress(97, 'Adding synthesis to memory');
    await this.addFinding(report, 'synthesis_report');

    // Store final results
    this.results.push({
      type: 'synthesis_report',
      content: report,
      executiveSummary,
      sectionsGenerated: generatedSections.length,
      sourcesConsulted: knowledgeBase.nodes.length,
      knowledgeGaps: gaps,
      timestamp: new Date()
    }, 3);

    await this.reportProgress(100, 'Synthesis complete');

    this.logger.info('✅ SynthesisAgent: Mission complete', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      sectionsGenerated: generatedSections.length,
      sourcesConsulted: knowledgeBase.nodes.length,
      reportLength: report.length
    }, 3);

    return {
      success: true,
      sectionsGenerated: generatedSections.length,
      sourcesConsulted: knowledgeBase.nodes.length,
      reportLength: report.length,
      
      // NEW: Explicitly set DoD fields for Executive Ring validation
      metadata: {
        reportGenerated: true,
        wordCount: report.split(/\s+/).length,
        sectionsGenerated: generatedSections.length,
        sourcesConsulted: knowledgeBase.nodes.length,
        status: 'complete'
      }
    };
  }

  /**
   * Gather relevant knowledge from memory network
   */
  async gatherRelevantKnowledge() {
    if (!this.memory) {
      throw new Error('No memory system available');
    }

    // Query memory for nodes related to mission
    const queryResults = await this.memory.query(this.mission.description, 30);
    
    this.sourceNodes = queryResults;

    this.logger.info('Knowledge gathered from memory', {
      nodesFound: queryResults.length,
      topSimilarity: queryResults[0]?.similarity || 0
    }, 3);

    return {
      nodes: queryResults,
      totalNodes: queryResults.length
    };
  }

  /**
   * Create structure for the synthesis report
   */
  async createSynthesisStructure(knowledgeBase) {
    // Sample top nodes for context
    const topNodes = knowledgeBase.nodes
      .slice(0, 10)
      .map(n => (n.concept || '').substring(0, 150))
      .join('\n');

    const prompt = `You are structuring a synthesis report.

MISSION: ${this.mission.description}

SUCCESS CRITERIA:
${this.mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

AVAILABLE KNOWLEDGE (sample):
${topNodes}

Create a 3-4 section structure for this synthesis report.

Each section should:
- Have a clear, descriptive title
- Cover a distinct aspect of the topic
- Build on previous sections logically

Respond in JSON format:
{
  "sections": [
    {
      "title": "Section 1 Title",
      "focus": "What this section covers..."
    },
    {
      "title": "Section 2 Title",
      "focus": "What this section covers..."
    }
  ]
}`;

    try {
      const response = await this.gpt5.generateWithRetry({
        instructions: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Create synthesis structure.' }],
        maxTokens: 6000, // Increased from 1500 - knowledge gap analysis needs comprehensive output
        reasoningEffort: 'low'
      }, 3);

      // Check for valid content
      if (!response.content || response.content.trim() === '' || response.content.includes('[Error:')) {
        this.logger.warn('Empty response for synthesis structure, using fallback');
        return this.getFallbackStructure();
      }

      const match = response.content.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }

      // Fallback structure
      return this.getFallbackStructure();
    } catch (error) {
      this.logger.error('Structure creation failed', { error: error.message }, 3);
      return this.getFallbackStructure();
    }
  }

  /**
   * Get fallback structure when GPT-5.2 fails
   */
  getFallbackStructure() {
    return {
      sections: [
        { title: 'Overview', focus: 'General overview of the topic' },
        { title: 'Key Findings', focus: 'Main discoveries and insights' },
        { title: 'Implications', focus: 'Consequences and applications' }
      ]
    };
  }

  /**
   * Generate content for a specific section
   */
  async generateSection(section, knowledgeBase) {
    // Get most relevant nodes for this section
    const sectionQuery = `${section.title} ${section.focus}`;
    const relevantNodes = await this.memory.query(sectionQuery, 10);
    
    const nodesSummary = relevantNodes
      .map(n => `- ${n.concept}`)
      .join('\n');

    const prompt = `You are writing a section of a synthesis report.

SECTION TITLE: ${section.title}
SECTION FOCUS: ${section.focus}

RELEVANT KNOWLEDGE:
${nodesSummary}

OVERALL MISSION: ${this.mission.description}

Write a comprehensive section (3-4 well-developed paragraphs) that:
- Synthesizes the available knowledge on this aspect
- Presents information clearly and coherently
- Connects ideas and shows relationships
- Provides specific insights and examples

Write in a clear, informative style. Be substantive and specific.`;

    try {
      const response = await this.gpt5.generate({
        component: 'agents',
        purpose: 'synthesis',
        model: this.config.models?.strategicModel, // Use strategic model for synthesis writing
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: `Write section: ${section.title}` }],
        maxTokens: 16000, // Increased from 12000 to prevent truncation
        reasoningEffort: 'low' // Efficient for synthesis - tokens increased from 1500 to 16000, safe to use 'medium' if needed
      });

      // Handle empty or error responses - SKIP section instead of placeholder
      if (!response.content || response.content.trim() === '' || response.content.includes('[Error:')) {
        this.logger.error('❌ Section generation failed - SKIPPING to avoid noise', {
          section: section.title,
          hadError: response.hadError,
          errorType: response.errorType,
          action: 'Section will be omitted from report'
        });
        
        // Error already logged - don't save to memory (transient error, not knowledge)
        return null; // Return null instead of placeholder
      }

      return response.content;
    } catch (error) {
      this.logger.error('❌ Section generation failed - SKIPPING to avoid noise', {
        section: section.title,
        error: error.message,
        action: 'Section will be omitted from report'
      });

      // Error already logged - don't save to memory (transient error, not knowledge)
      return null; // Return null instead of placeholder
    }
  }

  /**
   * Create executive summary
   */
  async createExecutiveSummary(sections) {
    const sectionsSummary = sections
      .map(s => `${s.title}:\n${(s.content || '[Section incomplete]').substring(0, 300)}...`)
      .join('\n\n');

    const prompt = `You are creating an executive summary of a synthesis report.

MISSION: ${this.mission.description}

REPORT SECTIONS:
${sectionsSummary}

Create a concise executive summary (1-2 paragraphs) that:
- Captures the most important findings
- Provides clear value and insights
- Can stand alone as a complete summary

Be clear, direct, and informative.`;

    try {
      const response = await this.gpt5.generateWithRetry({
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Create executive summary.' }],
        maxTokens: 10000, // Executive synthesis needs space
        reasoningEffort: 'medium' // Reasoning about what's most important
      }, 3);

      // Handle empty or error responses
      if (!response.content || response.content.trim() === '' || response.content.includes('[Error:')) {
        this.logger.warn('Empty response for executive summary, using fallback');
        return '[Executive summary unavailable due to API error]';
      }

      return response.content;
    } catch (error) {
      this.logger.error('Executive summary creation failed', { error: error.message }, 3);
      return 'Executive summary: See detailed sections below for comprehensive synthesis of available knowledge.';
    }
  }

  /**
   * Identify knowledge gaps
   */
  async identifyKnowledgeGaps(knowledgeBase, sections) {
    const sectionTitles = sections.map(s => s.title).join(', ');

    const prompt = `Based on this synthesis work, identify 2-3 specific knowledge gaps.

MISSION: ${this.mission.description}

SECTIONS COVERED: ${sectionTitles}
SOURCES CONSULTED: ${knowledgeBase.nodes.length} memory nodes

What specific areas need more information? What questions remain unanswered?

Respond with JSON array:
["Gap 1: Specific gap...", "Gap 2: Another gap...", "Gap 3: Third gap..."]`;

    try {
      const response = await this.gpt5.generateFast({
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Identify knowledge gaps.' }],
        maxTokens: 6000 // Increased from 1500 to prevent incomplete responses
      }, 3);

      // Check for incomplete response
      if (response.hadError || response.errorType === 'response.incomplete') {
        this.logger.warn('Incomplete response for knowledge gaps, returning empty array');
        return [];
      }

      const match = response.content.match(/\[[\s\S]*?\]/);
      if (match) {
        return JSON.parse(match[0]).slice(0, 3);
      }
      return [];
    } catch (error) {
      this.logger.error('Gap identification failed', { error: error.message }, 3);
      return [];
    }
  }

  /**
   * Compile final report
   */
  compileReport(data) {
    const { executiveSummary, sections, knowledgeGaps, metadata } = data;

    let report = `# SYNTHESIS REPORT\n\n`;
    report += `**Mission:** ${this.mission.description}\n\n`;
    report += `**Generated:** ${metadata.createdAt.toISOString()}\n`;
    report += `**Sources:** ${metadata.sourcesConsulted} memory nodes\n`;
    report += `**Sections:** ${metadata.sectionsGenerated}\n\n`;
    
    report += `---\n\n`;
    
    report += `## EXECUTIVE SUMMARY\n\n`;
    report += `${executiveSummary}\n\n`;
    
    report += `---\n\n`;
    
    for (const section of sections) {
      const title = (section.title || 'UNTITLED SECTION').toUpperCase();
      const content = section.content || '[Section content unavailable]';
      report += `## ${title}\n\n`;
      report += `${content}\n\n`;
      report += `---\n\n`;
    }
    
    if (knowledgeGaps.length > 0) {
      report += `## KNOWLEDGE GAPS\n\n`;
      for (const gap of knowledgeGaps) {
        report += `- ${gap}\n`;
      }
      report += `\n`;
    }

    return report;
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('🎉 SynthesisAgent completed successfully', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      sectionsGenerated: this.sections.length,
      sourcesConsulted: this.sourceNodes.length
    }, 3);
  }

  /**
   * NEW: Assemble final deliverable from tracked artifacts
   */
  async assembleFinalDeliverable() {
    const fs = require('fs').promises;
    const path = require('path');
    
    await this.reportProgress(10, 'Gathering phase artifacts');
    
    // Get deliverable spec from mission metadata
    const deliverableSpec = this.mission.metadata?.deliverableSpec || this.mission.deliverable;
    
    if (!deliverableSpec) {
      throw new Error('No deliverable specification found for synthesis task');
    }
    
    this.logger.info('📦 Deliverable spec loaded', {
      type: deliverableSpec.type,
      filename: deliverableSpec.filename,
      requiredSections: deliverableSpec.requiredSections?.length || 0
    }, 3);
    
    // Gather all phase artifacts
    const artifacts = await this.gatherPhaseArtifacts();
    
    await this.reportProgress(30, `Reading ${artifacts.length} artifact files`);
    
    // Read artifact files
    const artifactContents = await this.readArtifactFiles(artifacts);
    
    await this.reportProgress(50, 'Assembling final deliverable with GPT-5.2');
    
    // Use GPT-5.2 to intelligently combine artifacts into final format
    const assembled = await this.assembleDeliverable(artifactContents, deliverableSpec);
    
    await this.reportProgress(75, 'Writing final deliverable');
    
    // Write final deliverable
    const outputPath = await this.writeFinalDeliverable(assembled, deliverableSpec);
    
    await this.reportProgress(90, 'Storing in memory');
    
    // Register as deliverable result
    this.results.push({
      type: 'deliverable',
      label: `Final Deliverable: ${deliverableSpec.filename}`,
      path: outputPath,
      format: deliverableSpec.type || 'markdown',
      createdAt: new Date().toISOString(),
      agentId: this.agentId,
      isFinalDeliverable: true
    });
    
    // Note: Deliverable path logged but not saved to memory (file path, not knowledge)
    
    await this.reportProgress(100, 'Synthesis complete');
    
    this.logger.info('✅ SynthesisAgent: Final deliverable complete', {
      agentId: this.agentId,
      path: outputPath,
      artifactsAssembled: artifacts.length,
      size: assembled.length
    }, 3);
    
    return {
      success: true,
      deliverablePath: outputPath,
      artifactsAssembled: artifacts.length,
      deliverableSize: assembled.length
    };
  }

  /**
   * Gather all phase artifacts from memory and filesystem
   */
  async gatherPhaseArtifacts() {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Query memory for deliverables tagged from this run
    const deliverableNodes = await this.memory.query('deliverable runtime/outputs', 20);
    
    // Also scan runtime/outputs directly
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > skip scan (no process.cwd() fallback)
    let outputsDir;
    if (this.pathResolver) {
      outputsDir = this.pathResolver.getOutputsRoot();
    } else if (this.config?.logsDir) {
      outputsDir = path.join(this.config.logsDir, 'outputs');
    } else {
      this.logger.warn('Cannot determine outputs directory for artifact scan - skipping');
      return []; // Return empty artifacts rather than using wrong path
    }
    let files = [];
    
    try {
      files = await fs.readdir(outputsDir);
    } catch (error) {
      this.logger.warn('Could not scan outputs directory', { error: error.message }, 3);
    }
    
    const artifacts = [];
    const seen = new Set();
    
    // Combine memory-tracked and filesystem artifacts (dedupe by path)
    for (const node of deliverableNodes) {
      if (node.metadata?.path && !seen.has(node.metadata.path)) {
        artifacts.push({
          path: node.metadata.path,
          title: node.metadata.title || node.concept,
          format: node.metadata.format,
          source: 'memory'
        });
        seen.add(node.metadata.path);
      }
    }
    
    for (const file of files) {
      const filePath = path.join(outputsDir, file);
      if (!seen.has(filePath)) {
        // Filter for likely phase outputs (skip metadata files, temp files, etc)
        if (file.endsWith('.md') || file.endsWith('.html') || file.endsWith('.json')) {
          artifacts.push({
            path: filePath,
            title: file,
            format: path.extname(file).slice(1),
            source: 'filesystem'
          });
          seen.add(filePath);
        }
      }
    }
    
    this.logger.info('📦 Gathered artifacts for assembly', {
      count: artifacts.length,
      fromMemory: artifacts.filter(a => a.source === 'memory').length,
      fromFilesystem: artifacts.filter(a => a.source === 'filesystem').length
    }, 3);
    
    return artifacts;
  }

  /**
   * Read contents of artifact files
   */
  async readArtifactFiles(artifacts) {
    const fs = require('fs').promises;
    const contents = [];
    
    for (const artifact of artifacts) {
      try {
        const content = await fs.readFile(artifact.path, 'utf-8');
        contents.push({
          ...artifact,
          content,
          size: content.length
        });
        this.logger.debug('Read artifact', { 
          path: artifact.path, 
          size: content.length 
        }, 4);
      } catch (error) {
        this.logger.warn('Could not read artifact', { 
          path: artifact.path, 
          error: error.message 
        }, 3);
      }
    }
    
    return contents;
  }

  /**
   * Assemble deliverable using GPT-5
   */
  async assembleDeliverable(artifactContents, deliverableSpec) {
    const artifactsDescription = artifactContents.map(a => 
      `### ${a.title} (${a.format})\n${a.content.substring(0, 2000)}${a.content.length > 2000 ? '...[truncated]' : ''}`
    ).join('\n\n');
    
    const prompt = `You are assembling a final deliverable for a completed guided task.

DELIVERABLE SPECIFICATION:
- Type: ${deliverableSpec.type || 'markdown'}
- Filename: ${deliverableSpec.filename}
- Required Sections: ${deliverableSpec.requiredSections?.join(', ') || 'All phase outputs'}
- Minimum Content: ${deliverableSpec.minimumContent || 'Comprehensive coverage'}

AVAILABLE ARTIFACTS:
${artifactsDescription}

YOUR TASK:
Create a cohesive, professional ${deliverableSpec.type || 'document'} that:
1. Integrates all artifacts into a unified narrative
2. Includes ALL required sections with appropriate headings
3. Maintains technical accuracy from source artifacts
4. Provides clear navigation and structure
5. Meets the minimum content requirements
6. Is polished and presentation-ready

${deliverableSpec.type === 'html' ? 'Format as a complete HTML document with proper structure, styling, and interactivity where appropriate.' : ''}
${deliverableSpec.type === 'markdown' ? 'Use proper markdown formatting with clear headings, lists, code blocks, and links.' : ''}

Generate the complete final deliverable now:`;

    try {
      const response = await this.gpt5.generateWithRetry({
        model: this.config.models?.strategicModel,
        instructions: this.getAgentBehavioralPrompt() + '\n\n' + prompt,
        messages: [{ role: 'user', content: 'Assemble the final deliverable.' }],
        maxTokens: 16000, // Allow large output for comprehensive documents
        reasoningEffort: 'high' // High effort for quality assembly
      }, 3);
      
      return response.content;
    } catch (error) {
      this.logger.error('Failed to assemble deliverable with GPT-5.2', {
        error: error.message
      }, 3);
      
      // Fallback: Simple concatenation with headers
      let fallback = `# ${deliverableSpec.filename}\n\n`;
      fallback += `*Automated assembly (GPT-5.2 unavailable)*\n\n`;
      
      for (const artifact of artifactContents) {
        fallback += `\n\n## ${artifact.title}\n\n`;
        fallback += artifact.content;
        fallback += `\n\n---\n\n`;
      }
      
      this.logger.warn('Using fallback concatenation for deliverable assembly', 3);
      return fallback;
    }
  }

  /**
   * Write final deliverable to filesystem
   * 
   * CRITICAL: SynthesisAgent outputs are CANONICAL by default
   * They consolidate multiple agent outputs and mark prior versions as superseded
   */
  async writeFinalDeliverable(content, deliverableSpec) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Determine agent-specific output directory
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > error (no process.cwd() fallback)
    let agentOutputDir;
    if (this.pathResolver) {
      agentOutputDir = path.join(this.pathResolver.getOutputsRoot(), 'synthesis', this.agentId);
    } else if (this.config?.logsDir) {
      agentOutputDir = path.join(this.config.logsDir, 'outputs', 'synthesis', this.agentId);
    } else {
      // Critical: Don't fall back to process.cwd() - it breaks multi-tenant isolation
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    await fs.mkdir(agentOutputDir, { recursive: true });
    
    const outputPath = path.join(agentOutputDir, deliverableSpec.filename || 'final_deliverable.md');
    
    // Write via Capabilities
    // CRITICAL FIX: Use absolute path - pathResolver handles it correctly
    if (this.capabilities) {
      await this.capabilities.writeFile(
        outputPath,  // Absolute path - don't use path.relative(process.cwd(), ...) which causes path doubling
        content,
        {
          agentId: this.agentId,
          agentType: 'synthesis',
          missionGoal: this.mission.goalId
        }
      );
    } else {
      await fs.writeFile(outputPath, content, 'utf-8');
    }
    
    this.logger.info('📄 Final deliverable written', {
      path: outputPath,
      size: content.length,
      type: deliverableSpec.type
    }, 3);
    
    // Find prior deliverables for this goal
    const priorAgents = await this.findPriorDeliverablesForGoal(this.mission.goalId);
    
    // Create standardized manifest with canonical flag
    const manifest = DeliverableManifest.create({
      agentId: this.agentId,
      agentType: 'synthesis',
      mission: this.mission,
      spawnCycle: this.mission.spawnCycle,
      coordinatorReview: this.mission.coordinatorReview
    });
    
    manifest.deliverableType = 'synthesis';
    manifest.canonical = true; // Synthesis outputs are canonical by default
    manifest.supersedes = priorAgents.map(a => a.agentId);
    manifest.completedAt = new Date().toISOString();
    manifest.files = [{ 
      path: outputPath, 
      type: deliverableSpec.type || 'markdown',
      size: content.length
    }];
    
    // Write manifest
    const manifestPath = path.join(agentOutputDir, 'manifest.json');
    await DeliverableManifest.save(manifest, manifestPath, {
      capabilities: this.capabilities,
      agentContext: { agentId: this.agentId, agentType: 'synthesis', missionGoal: this.mission.goalId }
    });
    
    this.logger.info('✅ Canonical manifest created', {
      manifestPath,
      supersedes: manifest.supersedes.length,
      canonical: true
    }, 3);
    
    // Mark prior deliverables as superseded
    if (priorAgents.length > 0) {
      await this.markPriorDeliverablesSuperseded(priorAgents, this.agentId);
    }
    
    return outputPath;
  }

  /**
   * Find prior deliverables for the same goal
   * Scans runtime/outputs/ for manifests/metadata with matching goalId
   */
  async findPriorDeliverablesForGoal(goalId) {
    const fs = require('fs').promises;
    const path = require('path');
    
    if (!goalId) return [];
    
    const priorDeliverables = [];
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > return empty (no process.cwd() fallback)
    let outputsDir;
    if (this.pathResolver) {
      outputsDir = this.pathResolver.getOutputsRoot();
    } else if (this.config?.logsDir) {
      outputsDir = path.join(this.config.logsDir, 'outputs');
    } else {
      this.logger.warn('Cannot determine outputs directory for prior deliverables scan - skipping');
      return []; // Return empty rather than using wrong path
    }

    try {
      // Check code-creation, document-creation, and other synthesis agents
      const agentTypes = ['code-creation', 'document-creation', 'synthesis'];
      
      for (const agentType of agentTypes) {
        const agentTypeDir = path.join(outputsDir, agentType);
        
        try {
          const agentDirs = await fs.readdir(agentTypeDir);
          
          for (const agentDir of agentDirs) {
            // Skip our own directory
            if (agentDir === this.agentId) continue;
            
            const agentPath = path.join(agentTypeDir, agentDir);
            const manifestPath = path.join(agentPath, 'manifest.json');
            const metadataPath = path.join(agentPath, `${agentDir}_metadata.json`);
            
            // Try manifest.json first (code-creation, synthesis)
            try {
              const manifestData = await fs.readFile(manifestPath, 'utf8');
              const manifest = JSON.parse(manifestData);
              
              if (manifest.goalId === goalId) {
                priorDeliverables.push({
                  agentId: manifest.agentId,
                  agentType: manifest.agentType || agentType,
                  manifestPath,
                  goalId: manifest.goalId
                });
              }
            } catch (manifestError) {
              // Try metadata files (document-creation uses different naming)
              try {
                const files = await fs.readdir(agentPath);
                const metadataFile = files.find(f => f.endsWith('_metadata.json'));
                
                if (metadataFile) {
                  const metadataContent = await fs.readFile(path.join(agentPath, metadataFile), 'utf8');
                  const metadata = JSON.parse(metadataContent);
                  
                  if (metadata.goalId === goalId) {
                    priorDeliverables.push({
                      agentId: metadata.agentId || metadata.createdBy,
                      agentType: metadata.agentType || agentType,
                      manifestPath: path.join(agentPath, metadataFile),
                      goalId: metadata.goalId
                    });
                  }
                }
              } catch (metadataError) {
                // No metadata file, skip
              }
            }
          }
        } catch (agentTypeError) {
          // Agent type directory doesn't exist, skip
        }
      }
    } catch (error) {
      this.logger.warn('Could not scan for prior deliverables', {
        error: error.message
      }, 3);
    }
    
    return priorDeliverables;
  }

  /**
   * Mark prior deliverables as superseded by this synthesis output
   */
  async markPriorDeliverablesSuperseded(priorDeliverables, supersedingAgentId) {
    const fs = require('fs').promises;
    
    for (const prior of priorDeliverables) {
      try {
        // Read existing manifest/metadata
        const manifestData = await fs.readFile(prior.manifestPath, 'utf8');
        const manifest = JSON.parse(manifestData);
        
        // Update with superseded info
        manifest.canonical = false;
        manifest.supersededBy = supersedingAgentId;
        manifest.supersededAt = new Date().toISOString();
        
        // Write back via Capabilities
        if (this.capabilities) {
          await this.capabilities.writeFile(
            prior.manifestPath,  // Use absolute path - pathResolver handles it correctly
            JSON.stringify(manifest, null, 2),
            { agentId: this.agentId, agentType: 'synthesis', missionGoal: this.mission.goalId }
          );
        } else {
          await fs.writeFile(prior.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        }
        
        this.logger.info('📝 Marked deliverable as superseded', {
          agentId: prior.agentId,
          supersededBy: supersedingAgentId
        }, 3);
      } catch (error) {
        this.logger.warn('Could not mark deliverable as superseded', {
          agentId: prior.agentId,
          error: error.message
        }, 3);
      }
    }
  }
}

module.exports = { SynthesisAgent };

