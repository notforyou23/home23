const { BaseAgent } = require('./base-agent');
const { DocumentManager } = require('./document-manager');
const fs = require('fs').promises;
const path = require('path');

/**
 * DocumentCreationAgent - Document generation and management specialist
 *
 * Purpose:
 * - Creates high-quality documents of various types (reports, proposals, documentation, etc.)
 * - Manages document templates and formatting
 * - Handles document versioning and updates
 * - Integrates with memory system for context-aware document creation
 * - Supports multiple output formats (Markdown, HTML, PDF-ready)
 *
 * Use Cases:
 * - Generate research reports and summaries
 * - Create technical documentation
 * - Produce business proposals and presentations
 * - Draft meeting notes and agendas
 * - Generate API documentation
 * - Create project plans and timelines
 */
class DocumentCreationAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## DocumentCreationAgent Behavioral Specification

You create structured documents from knowledge. Write the document — don't plan it or
describe what you would write. Use evidence from memory and prior agents.

Creation protocol:
1. Parse requirements — type, audience, purpose, format.
2. Query memory deeply — gather all relevant findings, insights, data.
3. Write the full document in a single pass — complete, structured, cited.
4. Use ONLY facts from memory context — no generic filler, no invented data.
5. Ensure proper conclusion — never stop mid-section.

Output: complete document files (Markdown or HTML). Every claim grounded in research data.
Substantive and specific — names, dates, numbers, findings. No corporate boilerplate.`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.documentTypes = [
      'report', 'proposal', 'documentation', 'presentation',
      'meeting-notes', 'api-docs', 'project-plan', 'research-summary',
      'technical-spec', 'business-plan', 'whitepaper', 'case-study',
      'code-documentation', 'api-reference', 'technical-architecture',
      'deployment-guide', 'user-manual', 'data-analysis-report',
      'financial-report', 'spreadsheet-analysis', 'data-visualization-guide',
      'code-review-checklist', 'testing-documentation', 'performance-report'
    ];
    this.createdDocuments = [];
    this.templates = new Map();
    this.documentManager = new DocumentManager(logger);
    this.documentCounter = 1; // Sequential counter for filename generation
  }

  /**
   * Initialize document templates and resources
   */
  async onStart() {
    await this.reportProgress(5, 'Initializing document creation resources');

    // Initialize document manager
    if (this.documentManager?.setCapabilities) {
      this.documentManager.setCapabilities(this.capabilities);
    }
    await this.documentManager.initialize();

    // Load default templates
    await this.loadDefaultTemplates();

    // Query memory for existing document templates and patterns
    const templateKnowledge = await this.queryMemoryForKnowledge(20);

    if (templateKnowledge.length > 0) {
      this.logger.info('📚 Found existing document patterns in memory', {
        templatesFound: templateKnowledge.length,
        topMatches: templateKnowledge.slice(0, 3).map(n => ({
          similarity: n.similarity?.toFixed(3),
          concept: n.concept?.substring(0, 60)
        }))
      });
    }

    await this.reportProgress(15, 'Document creation agent ready');
  }

  /**
   * Main execution logic for document creation
   */
  async execute() {
    this.logger.info('📝 DocumentCreationAgent: Starting document creation mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    });

    const preFlightData = await this.gatherPreFlightContext();

    // Intake fail-closed: require a claim/statement before synthesis
    // BUT: only for research/analysis documents, not infrastructure/technical docs
    const missionText = (this.mission.description || '').toLowerCase();
    const isInfrastructureDoc =
      missionText.includes('coverage') ||
      missionText.includes('roadmap') ||
      missionText.includes('eval_loop') ||
      missionText.includes('template') ||
      missionText.includes('scaffold') ||
      missionText.includes('checklist') ||
      missionText.includes('schema') ||
      missionText.includes('workflow') ||
      missionText.includes('/outputs/') && (
        missionText.includes('.csv') ||
        missionText.includes('.md') ||
        missionText.includes('.json')
      );

    // Guided mode document creation pulls from memory - doesn't require pre-passed claims
    const isGuidedModeDoc =
      missionText.includes('guided') ||
      missionText.includes('synthesize all research') ||
      missionText.includes('comprehensive report') ||
      missionText.includes('research findings') ||
      (this.mission?.triggerSource === 'dynamic_trigger') ||
      (this.mission?.spawningReason === 'deliverable_production');

    // Check if this looks like an action/research goal misrouted to document creation
    // These goals should be handled by other agent types, not document creation
    const hasDocumentKeywords = missionText.includes('create') ||
                                missionText.includes('write') ||
                                missionText.includes('document') ||
                                missionText.includes('report');
    const hasActionKeywords = missionText.includes('invest') ||
                              missionText.includes('develop') ||
                              missionText.includes('implement') ||
                              missionText.includes('build') ||
                              missionText.includes('conduct') ||
                              missionText.includes('assemble') ||
                              missionText.includes('collaborate') ||
                              missionText.includes('review ethical');
    const isActionGoal = !hasDocumentKeywords && hasActionKeywords;

    if (isActionGoal) {
      this.logger.info('📋 Goal appears to be action-oriented, not document creation - completing gracefully', {
        mission: missionText.substring(0, 100)
      });
      return {
        success: true,
        status: 'skipped',
        reason: 'action_goal_misrouted',
        results: [{
          type: 'info',
          message: 'This goal is action-oriented and should be handled by a different agent type'
        }]
      };
    }

    if (!isInfrastructureDoc && !isGuidedModeDoc) {
      const claimText =
        this.mission?.intake?.claim ||
        this.mission?.intake?.claimText ||
        this.mission?.metadata?.claimText ||
        this.mission?.claimText ||
        null;

      if (!claimText || typeof claimText !== 'string' || claimText.trim().length < 10) {
        const message = 'Document not emitted: missing claim/intake fields (claim text is required).';
        this.logger.warn(`❌ ${message}`);
        this.results.push({
          type: 'diagnostic',
          status: 'needs_intake',
          reason: 'missing_claim',
          message,
          requirement: 'claim_text'
        });

        return {
          success: false,
          status: 'needs_intake',
          reason: 'missing_claim',
          results: this.results
        };
      }
    } else if (isGuidedModeDoc) {
      this.logger.info('📋 Guided mode document - will pull content from memory', {
        type: 'guided_synthesis',
        mission: missionText.substring(0, 100)
      });
    } else {
      this.logger.info('ℹ️  Infrastructure document - skipping claim intake requirement', {
        type: 'infrastructure',
        mission: missionText.substring(0, 100)
      });
    }

    // Parse mission to determine document requirements
    const documentSpec = await this.parseDocumentRequirements();

    await this.reportProgress(25, `Creating ${documentSpec.type} document`);

    // Generate document content
    const document = await this.generateDocument(documentSpec);

    // Check if generation failed due to insufficient memory
    if (!document) {
      const memorySize = this.memory?.nodes?.size || 0;
      const message = `Document creation deferred: insufficient memory (${memorySize} nodes, need 3+). Research agents must run first.`;
      this.logger.warn(`⏳ ${message}`);

      this.results.push({
        type: 'diagnostic',
        status: 'deferred',
        reason: 'insufficient_memory',
        message,
        memoryNodes: memorySize,
        requirement: 'research_first'
      });

      return {
        success: false,
        status: 'deferred',
        reason: 'insufficient_memory',
        results: this.results
      };
    }

    // Guardrail: block citation-free outputs (avoid placeholder reports without evidence)
    // BUT: only for research/analysis documents, not infrastructure/technical docs or guided mode synthesis
    if (!isInfrastructureDoc && !isGuidedModeDoc) {
      const rawContent = document?.content || document?.formattedContent || '';
      if (!this.hasCitationsOrEvidence(rawContent)) {
        const message = 'Document not emitted: no citations/evidence detected. Provide sources before synthesis.';
        this.logger.warn(`❌ ${message}`);
        
        this.results.push({
          type: 'diagnostic',
          status: 'needs_evidence',
          reason: 'missing_citations',
          message,
          requirement: 'citation_or_evidence'
        });

        return {
          success: false,
          status: 'needs_evidence',
          reason: 'missing_citations',
          results: this.results
        };
      }
    }

    await this.reportProgress(60, 'Formatting and structuring document');

    // Format document based on type and requirements
    const formattedDocument = await this.formatDocument(document, documentSpec);

    await this.reportProgress(80, 'Saving document and metadata');

    // Save document and update memory
    const savedDocument = await this.saveDocument(formattedDocument, documentSpec);

    // Add to memory network for future reference
    await this.addDocumentToMemory(savedDocument, documentSpec);

    // Register deliverable result for downstream systems
    this.results.push({
      type: 'deliverable',
      label: savedDocument.title,
      path: savedDocument.deliverablePath || savedDocument.filePath,
      metadataPath: savedDocument.metadataPath,
      format: savedDocument.format || documentSpec.format,
      wordCount: savedDocument.wordCount,
      createdAt: savedDocument.createdAt,
      audience: documentSpec.audience,
      purpose: documentSpec.purpose,
      agentId: this.agentId
    });

    // Trigger completion agent for validation if output is significant
    if (savedDocument.wordCount > 1000 || documentSpec.requirements.includes('include_references')) {
      await this.triggerCompletionAgent(savedDocument, documentSpec);
    }

    // CRITICAL: Trigger QA agent to validate the document
    // This ensures "research team" workflow where documents are reviewed after creation
    await this.triggerQualityAssurance(savedDocument, documentSpec);

    // CRITICAL: Write completion marker (same pattern as CodeCreationAgent/CodeExecutionAgent)
    // This allows dashboard to detect validated/complete status
    // The dashboard checks for .complete file to determine if agent output is validated
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: savedDocument path > pathResolver > config.logsDir > error
    let outputDir;
    if (savedDocument.filePath && path.isAbsolute(savedDocument.filePath)) {
      // Use directory from saved document path (PathResolver case)
      outputDir = path.dirname(savedDocument.filePath);
    } else if (this.pathResolver) {
        outputDir = path.join(this.pathResolver.getOutputsRoot(), 'document-creation', this.agentId);
    } else if (this.config?.logsDir) {
      outputDir = path.join(this.config.logsDir, 'outputs', 'document-creation', this.agentId);
      } else {
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    
    try {
      // Count actual files (document + metadata)
      const fileCount = savedDocument.metadataPath ? 2 : 1;
      
      await this.writeCompletionMarker(outputDir, {
        fileCount: fileCount,
        totalSize: savedDocument.wordCount || 0,
        documentTitle: savedDocument.title,
        wordCount: savedDocument.wordCount,
        format: savedDocument.format || documentSpec.format,
        files: [
          {
            filename: path.basename(savedDocument.filePath || 'document'),
            size: savedDocument.wordCount || 0
          }
        ]
      });
      
      this.logger.info('✅ Completion marker written for document creation', {
        outputDir: path.basename(outputDir),
        fileCount,
        documentTitle: savedDocument.title
      }, 3);
    } catch (markerError) {
      this.logger.warn('Failed to write completion marker (non-fatal)', {
        error: markerError.message,
        outputDir
      }, 3);
    }

    await this.reportProgress(100, 'Document creation completed');

    return {
      success: true,
      document: savedDocument,
      metadata: {
        type: documentSpec.type,
        title: documentSpec.title,
        filePath: savedDocument.filePath,
        wordCount: savedDocument.wordCount,
        filesCreated: 1, // NEW: DoD compliance
        status: 'complete',
        createdAt: savedDocument.createdAt
      }
    };
  }

  /**
   * Detect if this is a creative writing task vs template documentation
   * 
   * Creative tasks: original writing, brilliant prose, multi-dimensional synthesis
   * Template tasks: technical docs, API references, business reports, meeting notes
   * 
   * Design: Conservative detection - defaults to template mode unless clear creative signals
   */
  detectCreativeMode(missionText, mission) {
    // OVERRIDE: Template keywords always force template mode (highest priority)
    const templateKeywords = [
      'api reference', 'api-reference', 'technical spec', 'deployment guide',
      'user manual', 'meeting notes', 'financial report', 'business plan',
      'code documentation', 'testing documentation', 'performance report',
      'technical architecture', 'deployment-guide', 'code-review'
    ];
    
    const hasTemplateKeyword = templateKeywords.some(kw => missionText.includes(kw));
    if (hasTemplateKeyword) {
      this.logger.debug('Template mode: explicit template keyword detected');
      return false;
    }
    
    // Creative indicators (need multiple to trigger)
    const creativeKeywords = [
      'brilliant', 'startling', 'startle', 'astonish', 'amaze',
      'creative', 'original', 'novel', 'unique', 'unprecedented',
      'compose', 'craft', 'demonstrate capabilities', 'showcase',
      'impressive', 'remarkable', 'extraordinary', 'exceptional',
      'artistic', 'lyrical', 'poetic', 'evocative', 'vivid',
      'synthesize.*dimensions', 'multi-dimensional', 'cross-disciplinary',
      'surprising', 'unexpected', 'unconventional', 'innovative',
      'paragraph.*brilliance', 'demonstrate.*breadth'
    ];
    
    // Count creative signals (use regex for complex patterns)
    let creativeScore = 0;
    for (const keyword of creativeKeywords) {
      if (keyword.includes('.*')) {
        // Regex pattern
        const regex = new RegExp(keyword, 'i');
        if (regex.test(missionText)) creativeScore++;
      } else {
        // Simple keyword
        if (missionText.includes(keyword)) creativeScore++;
      }
    }
    
    // Check deliverable spec for creative signals
    let deliverableSignals = 0;
    if (mission.deliverable) {
      const delivMinContent = (mission.deliverable.minimumContent || '').toLowerCase();
      if (delivMinContent.includes('brilliant') || delivMinContent.includes('startling')) {
        deliverableSignals++;
      }
      if (delivMinContent.includes('surprising') || delivMinContent.includes('original')) {
        deliverableSignals++;
      }
      // Check required sections - if very specific/unusual, likely creative
      const sections = mission.deliverable.requiredSections || [];
      if (sections.some(s => s.toLowerCase().includes('what i did') || s.toLowerCase().includes('why it works'))) {
        deliverableSignals++;
      }
    }
    
    // Decision logic: Require STRONG signals to enable creative mode
    // This ensures we don't accidentally creative-mode a technical report
    const totalSignals = creativeScore + deliverableSignals;
    
    if (totalSignals >= 3) {
      this.logger.info('✨ Creative mode activated', {
        creativeKeywords: creativeScore,
        deliverableSignals,
        totalSignals,
        reason: 'Strong creative indicators in mission'
      });
      return true;
    }
    
    this.logger.debug('Template mode selected', {
      creativeKeywords: creativeScore,
      deliverableSignals,
      totalSignals,
      threshold: 3
    });
    return false;
  }

  /**
   * Parse mission description to determine document requirements
   */
  async parseDocumentRequirements() {
    const missionText = this.mission.description.toLowerCase();

    // Determine document type
    let documentType = 'report'; // default
    for (const type of this.documentTypes) {
      if (missionText.includes(type.replace('-', ' ')) || missionText.includes(type)) {
        documentType = type;
        break;
      }
    }

    // Extract title from mission or generate one
    const titleMatch = this.mission.description.match(/title:\s*"([^"]+)"/i) ||
                      this.mission.description.match(/create\s+(?:a\s+)?(.+?)(?:\s+document|$)/i);

    const title = titleMatch ? titleMatch[1] : `Generated ${documentType}`;

    // Determine target audience and purpose
    const audience = this.determineAudience(missionText);
    const purpose = this.determinePurpose(missionText);

    // Check for specific formatting requirements
    const format = this.determineFormat(missionText);
    
    // NEW: Detect creative vs template mode
    const creativeMode = this.detectCreativeMode(missionText, this.mission);

    return {
      type: documentType,
      title,
      audience,
      purpose,
      format,
      requirements: this.extractRequirements(missionText),
      creativeMode,  // NEW
      missionDescription: this.mission.description  // NEW: Preserve original for creative context
    };
  }

  /**
   * Determine target audience from mission text
   */
  determineAudience(text) {
    if (text.includes('technical') || text.includes('developer') || text.includes('engineer')) {
      return 'technical';
    }
    if (text.includes('business') || text.includes('executive') || text.includes('management')) {
      return 'business';
    }
    if (text.includes('general') || text.includes('public')) {
      return 'general';
    }
    return 'general';
  }

  /**
   * Determine document purpose from mission text
   */
  determinePurpose(text) {
    if (text.includes('inform') || text.includes('document') || text.includes('explain')) {
      return 'informative';
    }
    if (text.includes('persuade') || text.includes('propose') || text.includes('convince')) {
      return 'persuasive';
    }
    if (text.includes('instruct') || text.includes('guide') || text.includes('how-to')) {
      return 'instructional';
    }
    return 'informative';
  }

  /**
   * Determine output format from mission text
   */
  determineFormat(text) {
    if (text.includes('html') || text.includes('web')) {
      return 'html';
    }
    if (text.includes('pdf') || text.includes('print')) {
      return 'pdf-ready';
    }
    if (text.includes('markdown') || text.includes('md')) {
      return 'markdown';
    }
    return 'markdown'; // default
  }

  /**
   * Extract specific requirements from mission text
   */
  extractRequirements(text) {
    const requirements = [];

    if (text.includes('include images') || text.includes('visual')) {
      requirements.push('include_visuals');
    }
    if (text.includes('executive summary') || text.includes('summary')) {
      requirements.push('include_executive_summary');
    }
    if (text.includes('references') || text.includes('citations')) {
      requirements.push('include_references');
    }
    if (text.includes('table of contents') || text.includes('toc')) {
      requirements.push('include_toc');
    }
    if (text.includes('appendices') || text.includes('appendix')) {
      requirements.push('include_appendices');
    }

    return requirements;
  }

  /**
   * Heuristic check for citations/evidence presence
   * Accepts DOI/arXiv/PMID/URLs or explicit references section.
   */
  hasCitationsOrEvidence(text) {
    if (!text || typeof text !== 'string') return false;

    const lower = text.toLowerCase();
    if (lower.includes('doi.org/') || lower.includes('arxiv.org/') || lower.includes('pmid')) {
      return true;
    }

    if (lower.includes('references') || lower.includes('citations')) {
      return true;
    }

    const urlRegex = /(https?:\/\/[^\s)]+)/i;
    return urlRegex.test(text);
  }

  /**
   * Generate document content based on specification
   * ALWAYS uses memory context - no corporate templates
   */
  async generateDocument(spec) {
    // Check if we have memory context
    const memorySize = this.memory?.nodes?.size || 0;

    if (memorySize < 3) {
      this.logger.warn('⚠️  Insufficient memory for document creation', {
        memoryNodes: memorySize,
        required: 3
      });
      // Return null to signal insufficient data - don't throw
      // This allows proper diagnostic reporting instead of crash
      return null;
    }
    
    this.logger.info('📚 Generating document from memory context', {
      memoryNodes: memorySize,
      mission: spec.missionDescription?.substring(0, 100)
    });
    
    // ALWAYS use memory-based generation
    return await this.generateFromMemory(spec);
  }

  /**
   * Generate document from memory context
   * Uses ALL available memory data to create substantive, specific content
   */
  async generateFromMemory(spec) {
    this.logger.info('📚 Generating from memory', {
      mission: spec.missionDescription || spec.title,
      memoryNodes: this.memory?.nodes?.size || 0
    });
    
    // Deep query for relevant content
    const queries = [
      spec.missionDescription || spec.title,
      spec.title,
      ...(spec.requirements || [])
    ].filter(Boolean);
    
    const allContext = [];
    for (const query of queries) {
      const results = await this.memory.query(query, 50); // Deep query
      allContext.push(...results);
    }
    
    // Get agent findings
    const agentFindings = await this.memory.query('agent', 30, {
      tags: ['agent_finding', 'research', 'synthesis']
    });
    allContext.push(...agentFindings);
    
    // Calculate safe context limit based on token budget
    // Context window: 128k tokens
    // Reserve for output: 16k tokens (generous buffer beyond max_tokens: 12k)
    // Reserve for prompt overhead: 2k tokens  
    // Available for memory context: 110k tokens
    const contextLimit = this.calculateSafeContextLimit(allContext, {
      availableTokens: 110000,
      maxNodes: 150,  // Even if we have token budget, cap at reasonable maximum
      minNodes: 20    // Minimum for quality (if available)
    });
    
    this.logger.info('📊 Memory context gathered', {
      totalNodesAvailable: allContext.length,
      nodesUsed: contextLimit,
      percentUsed: allContext.length > 0 ? Math.round((contextLimit / allContext.length) * 100) : 100,
      topSimilarity: allContext[0]?.similarity || 0,
      estimatedTokens: this.estimateTokenCount(allContext.slice(0, contextLimit))
    });
    
    // Build rich context from memory
    const contextText = allContext
      .slice(0, contextLimit)  // Increased from 30 to 600 (matches query engine report mode)
      .map((node, i) => `${i+1}. ${node.concept}`)
      .join('\n\n');
    
    if (!contextText || contextText.length < 100) {
      throw new Error('Insufficient memory context for document creation');
    }
    
    const prompt = `MISSION: ${spec.missionDescription || spec.title}

KNOWLEDGE FROM MEMORY (COSMO's research and analysis):
${contextText}

CRITICAL CONSTRAINT: Your response must be complete and self-contained within ~12,000 tokens (~48,000 characters).
Plan your structure accordingly - prioritize completeness over exhaustive detail.

Using ONLY the knowledge above, create comprehensive content that directly fulfills the mission.
Be specific, detailed, and grounded in the research data.
NO generic filler - use actual facts, names, dates, and findings from the knowledge base.

IMPORTANT: Ensure your document has a proper conclusion. Do not stop mid-section.`;

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()) + '\n\n' + 'You are creating a document using COSMO\'s accumulated knowledge. Use ONLY the specific facts and findings provided. Be detailed, substantive, and grounded in the research. NO generic corporate language.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,  // Note: Ignored by GPT-5.2 Responses API (model controls sampling)
        max_tokens: 12000  // Maps to max_output_tokens in API payload
      });
      
      // DIAGNOSTIC: Log response metadata to debug truncation
      this.logger.info('📄 Document generation response', {
        contentLength: response.content?.length || 0,
        estimatedTokens: Math.round((response.content?.length || 0) / 4),
        hadError: response.hadError || false,
        errorType: response.errorType || null,
        model: response.model || 'unknown',
        responseId: response.responseId || null,
        usage: response.usage || null
      });
      
      // Validate response
      if (!response || !response.content || typeof response.content !== 'string') {
        throw new Error('Invalid GPT-5.2 response - no content generated');
      }
      
      // CRITICAL: Check if response was incomplete/truncated
      if (response.hadError && response.errorType === 'response.incomplete') {
        this.logger.error('❌ Response was incomplete after retries', {
          contentLength: response.content.length,
          errorType: response.errorType,
          memoryNodes: allContext.length,
          contextLimit: contextLimit,
          estimatedInputTokens: this.estimateTokenCount(allContext.slice(0, contextLimit))
        });
        throw new Error('GPT response incomplete after retries - document would be truncated. Reduce context or retry mission.');
      }
      
      if (response.content.length < 200) {
        this.logger.warn('⚠️  GPT-5.2 generated very short content', {
          contentLength: response.content.length,
          memoryNodes: allContext.length
        });
      }
      
      return {
        title: spec.title,
        content: response.content,
        metadata: {
          author: 'COSMO Document Agent',
          createdAt: new Date(),
          mode: 'memory_based',
          memoryNodesUsed: allContext.length
        }
      };
    } catch (error) {
      this.logger.warn('GPT-5.2 generation failed, using fallback compilation', {
        error: error.message,
        memoryNodes: allContext.length
      });
      
      // FALLBACK: When GPT-5.2 fails, compile memory content directly
      // This prevents saving error messages as documents
      let fallbackContent = `# ${spec.title}\n\n`;
      fallbackContent += `*Auto-compiled from COSMO memory (GPT-5.2 unavailable)*\n\n`;
      fallbackContent += `## Summary\n\n`;
      fallbackContent += `Based on ${allContext.length} memory nodes about ${spec.missionDescription?.substring(0, 80) || spec.title}:\n\n`;
      
      // Add top findings directly
      for (let i = 0; i < Math.min(allContext.length, 20); i++) {
        const node = allContext[i];
        fallbackContent += `${i+1}. ${node.concept}\n\n`;
      }
      
      if (allContext.length > 20) {
        fallbackContent += `\n*... and ${allContext.length - 20} more findings in memory*\n`;
      }
      
      return {
        title: spec.title,
        content: fallbackContent,
        metadata: {
          author: 'COSMO Document Agent',
          createdAt: new Date(),
          mode: 'fallback_compilation',
          memoryNodesUsed: allContext.length,
          gpt5Failed: true
        }
      };
    }
  }

  /**
   * Generate creative original content (NEW)
   * Uses COSMO's full creative capabilities: high temperature, multi-branch, dream integration
   */
  async generateCreativeDocument(spec) {
    this.logger.info('✨ Generating creative document', {
      mission: spec.missionDescription?.substring(0, 100),
      deliverable: !!this.mission.deliverable
    });
    
    // Step 1: Gather creative inspiration from memory (not templates!)
    const inspirationContext = await this.gatherCreativeContext(spec);
    
    // ENHANCEMENT: Check if we have rich accumulated knowledge
    // If so, augment with strategic context (like query interface does)
    try {
      const memoryStats = this.memory?.nodes?.size || 0;
      if (memoryStats > 50) {
        this.logger.info('🎯 Rich knowledge base detected - enhancing with strategic context', {
          memoryNodes: memoryStats
        });
        
        // Query for strategic insights from Meta-Coordinator and agent work
        // Use deep queries like query interface for rich context
        const strategicNodes = await this.memory.query('strategic', 30, {  // Increased from 5
          tags: ['meta_coordinator', 'agent_insight', 'synthesis']
        });
        
        const priorityNodes = await this.memory.query('priority', 20, {  // Increased from 3
          tags: ['goal', 'directive']
        });
        
        // Add strategic context to inspiration
        inspirationContext.strategic = {
          insights: strategicNodes.map(n => n.concept),
          priorities: priorityNodes.map(n => n.concept)
        };
        
        this.logger.info('📊 Strategic context added', {
          strategicInsights: strategicNodes.length,
          priorities: priorityNodes.length
        });
      }
    } catch (error) {
      // Non-critical - continue without strategic context
      this.logger.debug('Could not gather strategic context', {
        error: error.message
      });
    }
    
    // Step 2: Generate multiple creative branches (quantum-style)
    const numBranches = 3;
    const creativeBranches = await this.generateCreativeBranches(spec, inspirationContext, numBranches);
    
    // Step 3: Select best or synthesize
    const selectedContent = await this.selectBestCreativeBranch(creativeBranches, spec);
    
    return {
      title: spec.title,
      type: 'creative_work',
      content: selectedContent,  // Single content string, not sections
      metadata: {
        author: 'COSMO Document Agent (Creative Mode)',
        createdAt: new Date(),
        mode: 'creative',
        branches: creativeBranches.length,
        temperature: 1.0,
        memoryNodesUsed: this.memory?.nodes?.size || 0
      }
    };
  }

  /**
   * Generate template-based document (EXISTING logic, renamed for clarity)
   * Preserves all current behavior for technical docs, reports, etc.
   */
  async generateTemplatedDocument(spec) {
    const template = this.getTemplate(spec.type, spec.audience, spec.purpose);

    // Gather relevant context from memory
    const context = await this.gatherContext(spec);

    // Generate content sections
    const sections = await this.generateContentSections(spec, template, context);

    return {
      title: spec.title,
      type: spec.type,
      sections,
      metadata: {
        author: 'COSMO Document Agent',
        createdAt: new Date(),
        version: '1.0',
        audience: spec.audience,
        purpose: spec.purpose,
        mode: 'template'
      }
    };
  }

  /**
   * Get appropriate template for document type
   */
  getTemplate(type, audience, purpose) {
    const templateKey = `${type}_${audience}_${purpose}`;

    if (this.templates.has(templateKey)) {
      return this.templates.get(templateKey);
    }

    // Return generic template for the document type
    return this.templates.get(type) || this.getGenericTemplate(type);
  }

  /**
   * Generate content sections based on template and context
   */
  async generateContentSections(spec, template, context) {
    const sections = [];

    for (const sectionTemplate of template.sections) {
      const sectionContent = await this.generateSection(
        sectionTemplate,
        spec,
        context,
        sections // Pass previous sections for context
      );

      if (sectionContent) {
        sections.push(sectionContent);
      }
    }

    return sections;
  }

  /**
   * Generate individual section content
   */
  async generateSection(sectionTemplate, spec, context, previousSections) {
    const prompt = this.buildSectionPrompt(sectionTemplate, spec, context, previousSections);

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.getAgentBehavioralPrompt() + '\n\n' + `You are an expert document writer creating a ${spec.type} for a ${spec.audience} audience.
                     Purpose: ${spec.purpose}. Follow the exact section structure provided.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 12000 // Leave headroom so GPT-5.2 completes naturally, not truncates
      });

      // Check for incomplete response
      if (response.hadError && response.errorType === 'response.incomplete') {
        this.logger.error('Section generation incomplete', {
          section: sectionTemplate.title,
          errorType: response.errorType,
          partialLength: response.content?.length || 0
        });
        throw new Error(`Section "${sectionTemplate.title}" truncated - response incomplete`);
      }

      return {
        title: sectionTemplate.title,
        content: response.content,
        type: sectionTemplate.type,
        order: sectionTemplate.order
      };

    } catch (error) {
      this.logger.error('Failed to generate section', {
        section: sectionTemplate.title,
        error: error.message
      });

      return {
        title: sectionTemplate.title,
        content: `[Error generating section: ${sectionTemplate.title}]`,
        type: sectionTemplate.type,
        order: sectionTemplate.order,
        error: error.message
      };
    }
  }

  /**
   * Build prompt for section generation
   */
  buildSectionPrompt(sectionTemplate, spec, context, previousSections) {
    let prompt = `Create the "${sectionTemplate.title}" section for a ${spec.type} document.

Document Context:
- Title: ${spec.title}
- Type: ${spec.type}
- Audience: ${spec.audience}
- Purpose: ${spec.purpose}

Section Requirements:
- Type: ${sectionTemplate.type}
- Style: ${sectionTemplate.style || 'professional'}
- Length: ${sectionTemplate.length || 'appropriate'}

`;

    if (sectionTemplate.type === 'introduction') {
      prompt += `This is the introduction section. Set the context and purpose of the document.
`;
    } else if (sectionTemplate.type === 'conclusion') {
      prompt += `This is the conclusion section. Summarize key points and provide final thoughts.
`;
    } else if (sectionTemplate.type === 'executive_summary') {
      prompt += `This is an executive summary. Provide a high-level overview of the entire document.
`;
    }

    if (context.length > 0) {
      prompt += `\nRelevant Context from Knowledge Base:
${context.slice(0, 5).map(item => `- ${item}`).join('\n')}
`;
    }

    if (previousSections.length > 0) {
      prompt += `\nPrevious Sections Summary:
${previousSections.slice(-2).map(s => `- ${s.title}: ${s.content?.substring(0, 100)}...`).join('\n')}
`;
    }

    prompt += `\nGenerate the section content now:`;

    return prompt;
  }

  /**
   * Gather relevant context from memory for document generation (TEMPLATE MODE)
   * ENHANCEMENT: Increased query depth for richer template-based documents
   */
  async gatherContext(spec) {
    const contextQueries = [
      spec.title,
      `${spec.type} best practices`,
      `${spec.audience} audience preferences`,
      `${spec.purpose} writing guidelines`
    ];

    const allContext = [];

    // ENHANCEMENT: Increased from 3 to 15 for richer context
    // Template mode still uses focused queries, but gets more depth
    for (const query of contextQueries) {
      const results = await this.memory.query(query, 15);
      allContext.push(...results.map(node => node.concept));
    }

    return [...new Set(allContext)]; // Remove duplicates
  }

  /**
   * Calculate safe context limit based on token budget
   *
   * Prevents context overflow that causes response truncation.
   * Uses actual node sizes to estimate token usage dynamically.
   *
   * @param {Array} nodes - Memory nodes to include
   * @param {Object} options - Budget parameters
   * @param {number} options.availableTokens - Total tokens available for context (default: 110k)
   * @param {number} options.maxNodes - Maximum nodes even if budget allows more (default: 150)
   * @param {number} options.minNodes - Minimum nodes if available (default: 20)
   * @returns {number} Safe number of nodes to use
   */
  calculateSafeContextLimit(nodes, options = {}) {
    const {
      availableTokens = 110000, // Conservative: 128k window - 16k output - 2k overhead
      maxNodes = 150, // Reasonable maximum
      minNodes = 20 // Minimum for quality
    } = options;

    if (!nodes || nodes.length === 0) {
      return 0;
    }

    // Calculate average node size across all available nodes
    // This gives us a realistic estimate for this specific memory state
    const totalChars = nodes.reduce((sum, node) => {
      return sum + (node.concept?.length || 0);
    }, 0);

    const avgCharsPerNode = totalChars / nodes.length;

    // Rough token estimate: 1 token ≈ 4 characters (conservative)
    const tokensPerNode = avgCharsPerNode / 4;

    // Calculate how many nodes fit in our token budget
    const nodesThatFitBudget = Math.floor(availableTokens / tokensPerNode);

    // Apply constraints
    const safeLimit = Math.min(
      nodesThatFitBudget, // Token budget limit
      maxNodes, // Reasonable maximum
      nodes.length // Can't use more than available
    );

    // Ensure we use at least minNodes if available
    const finalLimit = Math.max(safeLimit, Math.min(minNodes, nodes.length));

    this.logger.debug('📊 Token budget calculation', {
      totalNodes: nodes.length,
      avgCharsPerNode: Math.round(avgCharsPerNode),
      tokensPerNode: Math.round(tokensPerNode),
      nodesThatFitBudget,
      appliedLimit: finalLimit,
      estimatedTokens: Math.round(finalLimit * tokensPerNode)
    });

    return finalLimit;
  }

  /**
   * Estimate token count for a set of memory nodes
   * Used for logging and validation
   *
   * @param {Array} nodes - Memory nodes
   * @returns {number} Estimated token count
   */
  estimateTokenCount(nodes) {
    if (!nodes || nodes.length === 0) return 0;

    const totalChars = nodes.reduce((sum, node) => {
      return sum + (node.concept?.length || 0);
    }, 0);

    // Conservative estimate: 1 token ≈ 4 characters
    return Math.round(totalChars / 4);
  }

  /**
   * Gather creative inspiration from memory (CREATIVE MODE)
   * Taps into COSMO's full knowledge: dreams, explorations, insights
   */
  async gatherCreativeContext(spec) {
    const context = {
      mission: spec.missionDescription,
      inspiration: [],
      techniques: [],
      dreamInsights: [],
      explorations: [],
      recentInsights: []
    };
    
    // Query for creative content and techniques
    const creativeQueries = [
      spec.missionDescription,  // The ACTUAL mission
      'brilliant writing techniques',
      'rhetorical devices',
      'surprising insights',
      'creative synthesis',
      'multi-dimensional thinking',
      'cross-disciplinary connections'
    ];
    
    // ENHANCEMENT: Deep memory querying (like query interface)
    // Query interface uses limit: 1000, we use 50-100 for creative work
    // This is the KEY to brilliant outputs vs generic filler
    const queryLimit = 50; // Deep query for rich context
    
    for (const query of creativeQueries) {
      const results = await this.memory.query(query, queryLimit);
      context.inspiration.push(...results.map(n => ({
        concept: n.concept,
        similarity: n.similarity,
        type: n.type
      })));
    }
    
    // Tap into recent dreams (creative/exploratory thinking)
    try {
      const dreamNodes = await this.memory.query('dream', 20, {  // Increased from 5
        tags: ['dream', 'exploration', 'fork_consolidation'] 
      });
      context.dreamInsights = dreamNodes
        .filter(n => n.concept && n.concept.length > 20)
        .map(n => n.concept);
    } catch (error) {
      this.logger.debug('No dream content available for creative inspiration');
    }
    
    // Get exploration agent insights
    try {
      const explorationNodes = await this.memory.query('novel connections', 20);  // Increased from 5
      context.explorations = explorationNodes.map(n => n.concept);
    } catch (error) {
      this.logger.debug('No exploration content available');
    }
    
    // Get recent high-activation insights
    try {
      if (this.memory.getHighActivationNodes) {
        const hotNodes = await this.memory.getHighActivationNodes(10);
        context.recentInsights = hotNodes
          .filter(n => n.activation > 0.7)
          .map(n => n.concept);
      }
    } catch (error) {
      this.logger.debug('Could not access high-activation nodes');
    }
    
    this.logger.info('🎨 Creative context gathered', {
      inspirationSources: context.inspiration.length,
      dreamInsights: context.dreamInsights.length,
      explorations: context.explorations.length,
      recentInsights: context.recentInsights.length
    });
    
    return context;
  }

  /**
   * Generate multiple creative branches (quantum-style parallel generation)
   * Each branch uses high temperature and different creative angles
   */
  async generateCreativeBranches(spec, context, numBranches = 3) {
    const branches = [];
    
    // Build rich context prompt from gathered inspiration
    const inspirationText = context.inspiration
      .filter(item => item.concept && item.similarity > 0.3)
      .slice(0, 10)
      .map(item => `- ${item.concept}`)
      .join('\n');
    
    const dreamText = context.dreamInsights.length > 0
      ? `\nRecent dream-state insights:\n${context.dreamInsights.slice(0, 3).map(d => `- ${d}`).join('\n')}`
      : '';
    
    const explorationText = context.explorations.length > 0
      ? `\nExploration findings:\n${context.explorations.slice(0, 3).map(e => `- ${e}`).join('\n')}`
      : '';
    
    // ENHANCEMENT: Include strategic context if available (like query interface)
    const strategicText = context.strategic
      ? `\nStrategic insights and priorities:\n${context.strategic.insights.slice(0, 3).map(s => `- ${s}`).join('\n')}${context.strategic.priorities.length > 0 ? '\n\nCurrent priorities:\n' + context.strategic.priorities.slice(0, 2).map(p => `- ${p}`).join('\n') : ''}`
      : '';
    
    const basePrompt = `MISSION: ${spec.missionDescription}

COSMO's Knowledge Base:
${inspirationText}${dreamText}${explorationText}${strategicText}

Generate content that fulfills this mission with full creative freedom.
Be brilliant, surprising, and multi-dimensional.`;

    this.logger.info('🌟 Generating creative branches', {
      branches: numBranches,
      temperature: 1.0,
      contextSources: context.inspiration.length
    });

    // Generate branches with slightly different creative angles
    const angles = [
      'Focus on unexpected connections and surprising juxtapositions',
      'Emphasize intellectual depth and multi-disciplinary synthesis',
      'Prioritize vivid imagery and emotional resonance'
    ];

    for (let i = 0; i < numBranches; i++) {
      try {
        const angle = angles[i] || 'Balance all dimensions equally';
        
        const response = await this.callGPT5({
          messages: [
            {
              role: 'system',
              content: this.getAgentBehavioralPrompt() + '\n\n' + 'You are COSMO in full creative mode. You have access to knowledge across all domains. Be brilliant, original, and fearless in your synthesis. This is NOT a corporate document - create something truly remarkable.'
            },
            {
              role: 'user',
              content: `${basePrompt}\n\nCreative angle for this branch: ${angle}`
            }
          ],
          temperature: 1.0,  // Maximum creativity
          max_tokens: 12000  // Leave headroom so GPT-5.2 completes naturally, not truncates
        });
        
        branches.push({
          branchId: i,
          angle,
          content: response.content,
          reasoning: response.reasoning || null
        });
        
        this.logger.debug(`Branch ${i+1} generated`, {
          length: response.content.length,
          angle
        });
      } catch (error) {
        this.logger.warn(`Failed to generate creative branch ${i+1}`, {
          error: error.message
        });
      }
    }
    
    if (branches.length === 0) {
      throw new Error('All creative branches failed to generate');
    }
    
    return branches;
  }

  /**
   * Select best creative branch or synthesize from multiple branches
   * Uses GPT-5.2 to evaluate quality and potentially combine best elements
   */
  async selectBestCreativeBranch(branches, spec) {
    if (branches.length === 1) {
      return branches[0].content;
    }
    
    // Prepare branch summaries for evaluation
    const branchPreviews = branches.map((b, i) => 
      `=== BRANCH ${i+1} (${b.angle}) ===\n${b.content.substring(0, 800)}${b.content.length > 800 ? '...' : ''}`
    ).join('\n\n');
    
    this.logger.info('🎯 Evaluating creative branches', {
      branches: branches.length,
      evaluationMode: 'synthesis'
    });
    
    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.getAgentBehavioralPrompt() + '\n\n' + 'You are evaluating creative outputs from COSMO. Your job is to either SELECT the most brilliant branch OR SYNTHESIZE the best elements from multiple branches into something even better.'
          },
          {
            role: 'user',
            content: `ORIGINAL MISSION: ${spec.missionDescription}

${branchPreviews}

INSTRUCTIONS:
1. If one branch clearly excels, respond with "SELECTED: BRANCH X" followed by that branch's full content
2. If you can synthesize something better by combining elements, respond with "SYNTHESIS:" followed by the new synthesized content
3. Ensure the output fulfills the original mission completely

Your response:`
          }
        ],
        temperature: 0.8,  // Slightly lower for evaluation, still creative
        max_tokens: 12000  // Leave headroom so GPT-5.2 completes naturally, not truncates
      });
      
      // Parse response - either selected branch or synthesis
      const content = response.content;
      
      if (content.startsWith('SELECTED: BRANCH')) {
        const branchMatch = content.match(/SELECTED: BRANCH (\d+)/i);
        if (branchMatch) {
          const branchNum = parseInt(branchMatch[1]) - 1;
          if (branches[branchNum]) {
            this.logger.info('✅ Selected branch', { branchId: branchNum + 1 });
            return branches[branchNum].content;
          }
        }
      }
      
      // Either synthesis or fallback to content as-is
      const synthesisMatch = content.match(/SYNTHESIS:\s*([\s\S]+)/i);
      if (synthesisMatch) {
        this.logger.info('✅ Synthesized from multiple branches');
        return synthesisMatch[1].trim();
      }
      
      // Fallback: use the response as-is (it might be synthesized without the marker)
      this.logger.info('✅ Using synthesized output');
      return content;
      
    } catch (error) {
      this.logger.warn('Branch evaluation failed, using first branch', {
        error: error.message
      });
      return branches[0].content;
    }
  }

  /**
   * Format document based on specification and requirements
   * Handles simple content (string) or structured (sections array)
   */
  async formatDocument(document, spec) {
    // If document has simple content string (from memory-based or creative mode)
    if (document.content && typeof document.content === 'string') {
      return {
        title: spec.title || document.title,
        content: document.content,
        format: spec.format,
        metadata: {
          ...document.metadata,
          formattedAt: new Date()
        }
      };
    }
    
    // If document has sections array (from old template mode - should rarely happen now)
    if (document.sections && Array.isArray(document.sections)) {
      const formatter = this.getFormatter(spec.format);
      return await formatter.format(document, spec);
    }
    
    // Fallback
    throw new Error('Document structure not recognized - no content or sections found');
  }

  /**
   * Get appropriate formatter for document format
   */
  getFormatter(format) {
    const formatters = {
      'markdown': new MarkdownFormatter(),
      'html': new HTMLFormatter(),
      'pdf-ready': new PDFReadyFormatter()
    };

    return formatters[format] || formatters.markdown;
  }

  /**
   * Save document to file system and create metadata
   * NEW: Handles both creative mode (document.content) and template mode (document.formattedContent)
   */
  async saveDocument(document, spec) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultExtension = this.getExtensionForFormat(spec.format);
    
    // FIXED: Use identifier-based filename pattern (safe, predictable, filesystem-friendly)
    // Format: {agentId}_{type}_{counter}.{ext}
    // Full title is stored in metadata and as first line of document
    const docType = (spec.type || 'document').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const defaultFileName = `${this.agentId}_${docType}_${String(this.documentCounter).padStart(2, '0')}.${defaultExtension}`;
    this.documentCounter++; // Increment for next document
    
    // Get content from either creative mode (content) or template mode (formattedContent)
    const content = document.content || document.formattedContent;
    
    // Validate content exists
    if (!content || typeof content !== 'string') {
      throw new Error('Document has no valid content to save');
    }

    const deliverableSpec = this.mission?.deliverable || null;
    
    // Use PathResolver if available, otherwise fall back to legacy behavior
    if (this.pathResolver && deliverableSpec) {
      try {
        // Get resolved paths using PathResolver
        const paths = this.pathResolver.getDeliverablePath({
          deliverableSpec,
          agentType: 'document-creation',
          agentId: this.agentId,
          fallbackName: defaultFileName
        });
        
        // Ensure directory exists
        await fs.mkdir(paths.directory, { recursive: true });
        
        // Write file via Capabilities (embodied cognition)
        if (this.capabilities) {
          const result = await this.capabilities.writeFile(
            paths.relativePath,
            content,
            {
              agentId: this.agentId,
              agentType: 'document-creation',
              missionGoal: this.mission.goalId,
              cycleCount: this.config?.currentCycle
            }
          );
          
          if (!result.success) {
            throw new Error(`Capabilities declined write: ${result.reason}`);
          }
        } else {
          // Fallback for backwards compatibility
          await fs.writeFile(paths.fullPath, content, 'utf8');
        }
        
        // Create metadata file in same directory (matches document filename)
        const metadataFilename = path.basename(paths.relativePath, path.extname(paths.relativePath)) + '_metadata.json';
        const metadataPath = path.join(paths.directory, metadataFilename);
        const metadata = {
          title: document.title,
          type: spec.type,
          format: spec.format,
          filePath: paths.fullPath,
          createdAt: new Date().toISOString(),
          createdBy: this.agentId,
          wordCount: this.countWords(content),
          characterCount: content.length,
          audience: spec.audience,
          purpose: spec.purpose,
          requirements: spec.requirements,
          mission: this.mission.description,
          version: '1.0.0',
          versions: [],
          deliverable: deliverableSpec,
          metadataPath,
          accessibility: {
            mcpAccessible: paths.isAccessible,
            logicalLocation: paths.logicalLocation
          },
          // NEW: Include creative mode metadata
          generationMode: document.metadata?.mode || 'template',
          creativeMetadata: spec.creativeMode ? {
            branches: document.metadata?.branches,
            temperature: document.metadata?.temperature
          } : null
        };

        // Write metadata via Capabilities
        if (this.capabilities) {
          await this.capabilities.writeFile(
            metadataPath,  // Use absolute path - pathResolver handles it correctly
            JSON.stringify(metadata, null, 2),
            {
              agentId: this.agentId,
              agentType: 'document-creation',
              missionGoal: this.mission.goalId
            }
          );
        } else {
          await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
        }

        // Register document with document manager
        this.documentManager.documents.set(document.title, metadata);
        this.documentManager.versions.set(document.title, [metadata]);

        this.logger.info('💾 Document saved', {
          title: document.title,
          filePath: paths.relativePath,
          wordCount: metadata.wordCount,
          format: spec.format,
          deliverablePath: paths.relativePath,
          mcpAccessible: paths.isAccessible
        });

        return {
          ...document,
          filePath: paths.fullPath,
          metadataPath,
          wordCount: metadata.wordCount,
          createdAt: metadata.createdAt,
          version: metadata.version,
          deliverablePath: paths.fullPath,
          format: spec.format
        };
        
      } catch (error) {
        this.logger.error('PathResolver failed, using fallback', {
          error: error.message,
          deliverableSpec
        });
        // Fall through to legacy behavior
      }
    }
    
    // LEGACY FALLBACK: If no pathResolver or deliverableSpec, use old behavior
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > error (no process.cwd() fallback)
    let runOutputDir;
    if (this.pathResolver) {
      runOutputDir = path.join(this.pathResolver.getOutputsRoot(), 'document-creation', this.agentId);
    } else if (this.config?.logsDir) {
      runOutputDir = path.join(this.config.logsDir, 'outputs', 'document-creation', this.agentId);
    } else {
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    
    await fs.mkdir(runOutputDir, { recursive: true });

    let outputDir = runOutputDir;
    let outputFileName = defaultFileName;

    if (deliverableSpec && !this.pathResolver) {
      // PRODUCTION: This path should not be hit if pathResolver is provided
      // But as fallback, try to use config.logsDir
      const baseDir = this.config.logsDir || path.join(process.cwd(), 'runtime');
      const deliverableDir = path.join(
        baseDir,
        deliverableSpec.location?.replace('runtime/', '') || 'outputs/'
      );
      await fs.mkdir(deliverableDir, { recursive: true });

      const specifiedFile = deliverableSpec.filename;
      if (specifiedFile) {
        outputFileName = specifiedFile;
      }

      if (!path.extname(outputFileName)) {
        const deliverableExtension = this.getExtensionForFormat(
          deliverableSpec.type || spec.format
        );
        outputFileName = `${outputFileName}.${deliverableExtension}`;
      }

      outputDir = deliverableDir;
    }

    const filePath = path.join(outputDir, outputFileName);
    
    // Write via Capabilities (embodied cognition)
    if (this.capabilities) {
      await this.capabilities.writeFile(
        filePath,  // Use absolute path - pathResolver handles it correctly
        content,
        {
          agentId: this.agentId,
          agentType: 'document-creation',
          missionGoal: this.mission.goalId
        }
      );
    } else {
      await fs.writeFile(filePath, content, 'utf8');
    }

    // Create metadata file in same directory as document (matches document filename)
    const metadataFilename = path.basename(outputFileName, path.extname(outputFileName)) + '_metadata.json';
    const metadataPath = path.join(outputDir, metadataFilename);
    const metadata = {
      title: document.title,
      type: spec.type,
      format: spec.format,
      filePath,
      createdAt: new Date().toISOString(),
      createdBy: this.agentId,
      wordCount: this.countWords(content),
      characterCount: content.length,
      audience: spec.audience,
      purpose: spec.purpose,
      requirements: spec.requirements,
      mission: this.mission.description,
      version: '1.0.0',
      versions: [],
      deliverable: deliverableSpec,
      metadataPath
    };
    
    if (this.capabilities) {
      await this.capabilities.writeFile(
        metadataPath,  // Use absolute path - pathResolver handles it correctly
        JSON.stringify(metadata, null, 2),
        { agentId: this.agentId, agentType: 'document-creation', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    }

    // Register document with document manager
    this.documentManager.documents.set(document.title, metadata);
    this.documentManager.versions.set(document.title, [metadata]);

    this.logger.info('💾 Document saved', {
      title: document.title,
      filePath,
      wordCount: metadata.wordCount,
      format: spec.format,
      deliverablePath: filePath
    });

    return {
      ...document,
      filePath,
      metadataPath,
      wordCount: metadata.wordCount,
      createdAt: metadata.createdAt,
      version: metadata.version,
      deliverablePath: filePath,
      metadataPath,
      format: spec.format
    };
  }

  /**
   * Add document to memory network for future reference
   */
  async addDocumentToMemory(document, spec) {
    // Get content text (handle both old sections array and new content string)
    let contentText;
    if (document.sections && Array.isArray(document.sections)) {
      contentText = document.sections.map(s => `## ${s.title}\n${s.content}`).join('\n\n');
    } else if (document.content) {
      contentText = document.content.substring(0, 2000); // Truncate for memory
    } else {
      contentText = '[No content available]';
    }
    
    // Add main document content
    await this.addFinding(
      `Document Created: ${document.title}\n\n${contentText}`,
      `document_${spec.type}`
    );

    // Add document metadata as structured data
    await this.addFinding(
      JSON.stringify({
        title: document.title,
        type: spec.type,
        format: spec.format,
        filePath: document.filePath,
        createdAt: document.createdAt,
        wordCount: document.wordCount,
        mode: document.metadata?.mode || 'unknown'
      }),
      'document_metadata'
    );

    this.logger.info('🧠 Document added to memory network', {
      title: document.title,
      type: spec.type,
      mode: document.metadata?.mode,
      tags: [`document_${spec.type}`, 'document_metadata']
    });
  }

  getExtensionForFormat(format) {
    const normalized = (format || '').toLowerCase();
    switch (normalized) {
      case 'markdown':
      case 'md':
        return 'md';
      case 'html':
        return 'html';
      case 'json':
        return 'json';
      case 'pdf':
        return 'pdf';
      case 'pdf-ready':
        return 'md';
      default:
        return normalized || 'txt';
    }
  }

  /**
   * Load default document templates
   */
  async loadDefaultTemplates() {
    // Research Report Template
    this.templates.set('report_general_informative', {
      sections: [
        { title: 'Executive Summary', type: 'executive_summary', order: 1, style: 'concise', length: '300-500 words' },
        { title: 'Introduction', type: 'introduction', order: 2, style: 'comprehensive', length: '400-600 words' },
        { title: 'Methodology', type: 'methodology', order: 3, style: 'detailed', length: '300-500 words' },
        { title: 'Findings', type: 'findings', order: 4, style: 'analytical', length: '800-1200 words' },
        { title: 'Analysis', type: 'analysis', order: 5, style: 'interpretive', length: '600-900 words' },
        { title: 'Conclusion', type: 'conclusion', order: 6, style: 'summarizing', length: '300-500 words' },
        { title: 'Recommendations', type: 'recommendations', order: 7, style: 'actionable', length: '200-400 words' }
      ]
    });

    // Technical Documentation Template
    this.templates.set('documentation_technical_instructional', {
      sections: [
        { title: 'Overview', type: 'introduction', order: 1, style: 'clear', length: '200-300 words' },
        { title: 'Architecture', type: 'architecture', order: 2, style: 'detailed', length: '400-600 words' },
        { title: 'Installation', type: 'installation', order: 3, style: 'step-by-step', length: '300-500 words' },
        { title: 'Configuration', type: 'configuration', order: 4, style: 'comprehensive', length: '400-600 words' },
        { title: 'Usage Guide', type: 'usage', order: 5, style: 'practical', length: '600-900 words' },
        { title: 'API Reference', type: 'api_reference', order: 6, style: 'technical', length: '800-1200 words' },
        { title: 'Troubleshooting', type: 'troubleshooting', order: 7, style: 'problem-solution', length: '400-600 words' }
      ]
    });

    // Business Proposal Template
    this.templates.set('proposal_business_persuasive', {
      sections: [
        { title: 'Executive Summary', type: 'executive_summary', order: 1, style: 'compelling', length: '300-500 words' },
        { title: 'Problem Statement', type: 'problem', order: 2, style: 'clear', length: '200-400 words' },
        { title: 'Proposed Solution', type: 'solution', order: 3, style: 'detailed', length: '600-900 words' },
        { title: 'Benefits', type: 'benefits', order: 4, style: 'persuasive', length: '300-500 words' },
        { title: 'Implementation Plan', type: 'implementation', order: 5, style: 'structured', length: '400-600 words' },
        { title: 'Timeline', type: 'timeline', order: 6, style: 'specific', length: '200-400 words' },
        { title: 'Cost Analysis', type: 'costs', order: 7, style: 'transparent', length: '300-500 words' },
        { title: 'Next Steps', type: 'call_to_action', order: 8, style: 'actionable', length: '150-300 words' }
      ]
    });

    // Code Documentation Template
    this.templates.set('code-documentation_technical_instructional', {
      sections: [
        { title: 'Project Overview', type: 'introduction', order: 1, style: 'comprehensive', length: '300-500 words' },
        { title: 'Architecture Overview', type: 'architecture', order: 2, style: 'detailed', length: '400-600 words' },
        { title: 'Installation & Setup', type: 'installation', order: 3, style: 'step-by-step', length: '300-500 words' },
        { title: 'Configuration Guide', type: 'configuration', order: 4, style: 'comprehensive', length: '400-600 words' },
        { title: 'API Reference', type: 'api_reference', order: 5, style: 'technical', length: '800-1200 words' },
        { title: 'Usage Examples', type: 'examples', order: 6, style: 'practical', length: '600-900 words' },
        { title: 'Testing Guide', type: 'testing', order: 7, style: 'detailed', length: '400-600 words' },
        { title: 'Deployment Instructions', type: 'deployment', order: 8, style: 'step-by-step', length: '300-500 words' },
        { title: 'Troubleshooting', type: 'troubleshooting', order: 9, style: 'problem-solution', length: '400-600 words' },
        { title: 'Contributing Guidelines', type: 'contributing', order: 10, style: 'clear', length: '200-400 words' }
      ]
    });

    // API Reference Template
    this.templates.set('api-reference_technical_instructional', {
      sections: [
        { title: 'API Overview', type: 'introduction', order: 1, style: 'clear', length: '200-300 words' },
        { title: 'Authentication', type: 'authentication', order: 2, style: 'technical', length: '300-500 words' },
        { title: 'Core Endpoints', type: 'endpoints', order: 3, style: 'detailed', length: '800-1200 words' },
        { title: 'Request/Response Formats', type: 'formats', order: 4, style: 'comprehensive', length: '400-600 words' },
        { title: 'Error Handling', type: 'errors', order: 5, style: 'detailed', length: '300-500 words' },
        { title: 'Rate Limiting', type: 'rate_limiting', order: 6, style: 'clear', length: '200-400 words' },
        { title: 'SDKs & Libraries', type: 'sdks', order: 7, style: 'informative', length: '300-500 words' },
        { title: 'Code Examples', type: 'examples', order: 8, style: 'practical', length: '600-900 words' },
        { title: 'Migration Guide', type: 'migration', order: 9, style: 'step-by-step', length: '300-500 words' },
        { title: 'Changelog', type: 'changelog', order: 10, style: 'structured', length: '200-400 words' }
      ]
    });

    // Technical Architecture Template
    this.templates.set('technical-architecture_technical_informative', {
      sections: [
        { title: 'System Overview', type: 'introduction', order: 1, style: 'high-level', length: '300-500 words' },
        { title: 'Architecture Principles', type: 'principles', order: 2, style: 'philosophical', length: '200-400 words' },
        { title: 'Component Architecture', type: 'components', order: 3, style: 'detailed', length: '600-900 words' },
        { title: 'Data Flow Diagrams', type: 'data_flow', order: 4, style: 'visual', length: '300-500 words' },
        { title: 'Technology Stack', type: 'technology_stack', order: 5, style: 'comprehensive', length: '400-600 words' },
        { title: 'Security Architecture', type: 'security', order: 6, style: 'detailed', length: '400-600 words' },
        { title: 'Scalability Considerations', type: 'scalability', order: 7, style: 'analytical', length: '300-500 words' },
        { title: 'Performance Characteristics', type: 'performance', order: 8, style: 'technical', length: '400-600 words' },
        { title: 'Deployment Architecture', type: 'deployment', order: 9, style: 'detailed', length: '300-500 words' },
        { title: 'Monitoring & Observability', type: 'monitoring', order: 10, style: 'comprehensive', length: '300-500 words' }
      ]
    });

    // Data Analysis Report Template
    this.templates.set('data-analysis-report_technical_analytical', {
      sections: [
        { title: 'Executive Summary', type: 'executive_summary', order: 1, style: 'concise', length: '300-500 words' },
        { title: 'Data Sources & Methodology', type: 'methodology', order: 2, style: 'detailed', length: '400-600 words' },
        { title: 'Data Quality Assessment', type: 'data_quality', order: 3, style: 'analytical', length: '300-500 words' },
        { title: 'Exploratory Data Analysis', type: 'eda', order: 4, style: 'comprehensive', length: '600-900 words' },
        { title: 'Statistical Analysis', type: 'statistical_analysis', order: 5, style: 'technical', length: '800-1200 words' },
        { title: 'Key Findings', type: 'findings', order: 6, style: 'clear', length: '400-600 words' },
        { title: 'Visualizations', type: 'visualizations', order: 7, style: 'descriptive', length: '300-500 words' },
        { title: 'Insights & Implications', type: 'insights', order: 8, style: 'interpretive', length: '400-600 words' },
        { title: 'Recommendations', type: 'recommendations', order: 9, style: 'actionable', length: '300-500 words' },
        { title: 'Technical Appendices', type: 'appendices', order: 10, style: 'detailed', length: '400-600 words' }
      ]
    });

    // Financial Report Template
    this.templates.set('financial-report_business_analytical', {
      sections: [
        { title: 'Executive Summary', type: 'executive_summary', order: 1, style: 'concise', length: '300-500 words' },
        { title: 'Financial Overview', type: 'financial_overview', order: 2, style: 'comprehensive', length: '400-600 words' },
        { title: 'Revenue Analysis', type: 'revenue_analysis', order: 3, style: 'detailed', length: '500-800 words' },
        { title: 'Cost Structure', type: 'cost_structure', order: 4, style: 'analytical', length: '400-600 words' },
        { title: 'Profitability Analysis', type: 'profitability', order: 5, style: 'detailed', length: '400-600 words' },
        { title: 'Cash Flow Statement', type: 'cash_flow', order: 6, style: 'technical', length: '300-500 words' },
        { title: 'Balance Sheet Analysis', type: 'balance_sheet', order: 7, style: 'comprehensive', length: '400-600 words' },
        { title: 'Key Financial Ratios', type: 'ratios', order: 8, style: 'analytical', length: '400-600 words' },
        { title: 'Market Analysis', type: 'market_analysis', order: 9, style: 'strategic', length: '300-500 words' },
        { title: 'Risk Assessment', type: 'risk_assessment', order: 10, style: 'comprehensive', length: '300-500 words' },
        { title: 'Future Projections', type: 'projections', order: 11, style: 'strategic', length: '400-600 words' },
        { title: 'Recommendations', type: 'recommendations', order: 12, style: 'actionable', length: '300-500 words' }
      ]
    });

    // Spreadsheet Analysis Template
    this.templates.set('spreadsheet-analysis_technical_analytical', {
      sections: [
        { title: 'Analysis Overview', type: 'introduction', order: 1, style: 'clear', length: '200-400 words' },
        { title: 'Data Structure & Sources', type: 'data_structure', order: 2, style: 'detailed', length: '300-500 words' },
        { title: 'Data Cleaning & Preparation', type: 'data_preparation', order: 3, style: 'methodical', length: '400-600 words' },
        { title: 'Key Metrics & KPIs', type: 'metrics', order: 4, style: 'analytical', length: '400-600 words' },
        { title: 'Trend Analysis', type: 'trend_analysis', order: 5, style: 'comprehensive', length: '500-800 words' },
        { title: 'Comparative Analysis', type: 'comparative_analysis', order: 6, style: 'detailed', length: '400-600 words' },
        { title: 'Formula & Calculation Breakdown', type: 'formulas', order: 7, style: 'technical', length: '500-800 words' },
        { title: 'Charts & Visualizations', type: 'visualizations', order: 8, style: 'descriptive', length: '300-500 words' },
        { title: 'Insights & Findings', type: 'insights', order: 9, style: 'interpretive', length: '400-600 words' },
        { title: 'Recommendations', type: 'recommendations', order: 10, style: 'actionable', length: '300-500 words' },
        { title: 'Technical Implementation Notes', type: 'technical_notes', order: 11, style: 'detailed', length: '200-400 words' }
      ]
    });

    // Code Review Checklist Template
    this.templates.set('code-review-checklist_technical_instructional', {
      sections: [
        { title: 'Review Overview', type: 'introduction', order: 1, style: 'clear', length: '150-300 words' },
        { title: 'Code Quality Standards', type: 'code_quality', order: 2, style: 'detailed', length: '400-600 words' },
        { title: 'Security Checklist', type: 'security', order: 3, style: 'comprehensive', length: '300-500 words' },
        { title: 'Performance Considerations', type: 'performance', order: 4, style: 'analytical', length: '300-500 words' },
        { title: 'Testing Requirements', type: 'testing', order: 5, style: 'detailed', length: '400-600 words' },
        { title: 'Documentation Standards', type: 'documentation', order: 6, style: 'clear', length: '200-400 words' },
        { title: 'Code Structure & Organization', type: 'structure', order: 7, style: 'detailed', length: '300-500 words' },
        { title: 'Error Handling', type: 'error_handling', order: 8, style: 'comprehensive', length: '300-500 words' },
        { title: 'Maintainability Assessment', type: 'maintainability', order: 9, style: 'analytical', length: '300-500 words' },
        { title: 'Approval Criteria', type: 'approval_criteria', order: 10, style: 'clear', length: '200-400 words' }
      ]
    });

    // Testing Documentation Template
    this.templates.set('testing-documentation_technical_instructional', {
      sections: [
        { title: 'Testing Strategy', type: 'introduction', order: 1, style: 'strategic', length: '300-500 words' },
        { title: 'Test Environment Setup', type: 'environment', order: 2, style: 'detailed', length: '300-500 words' },
        { title: 'Unit Testing Guide', type: 'unit_testing', order: 3, style: 'comprehensive', length: '500-800 words' },
        { title: 'Integration Testing', type: 'integration_testing', order: 4, style: 'detailed', length: '400-600 words' },
        { title: 'End-to-End Testing', type: 'e2e_testing', order: 5, style: 'comprehensive', length: '400-600 words' },
        { title: 'Performance Testing', type: 'performance_testing', order: 6, style: 'technical', length: '400-600 words' },
        { title: 'Security Testing', type: 'security_testing', order: 7, style: 'comprehensive', length: '300-500 words' },
        { title: 'Test Automation Framework', type: 'automation', order: 8, style: 'detailed', length: '400-600 words' },
        { title: 'Test Data Management', type: 'test_data', order: 9, style: 'methodical', length: '300-500 words' },
        { title: 'CI/CD Integration', type: 'cicd', order: 10, style: 'technical', length: '300-500 words' },
        { title: 'Reporting & Metrics', type: 'reporting', order: 11, style: 'analytical', length: '200-400 words' }
      ]
    });

    // Performance Report Template
    this.templates.set('performance-report_technical_analytical', {
      sections: [
        { title: 'Executive Summary', type: 'executive_summary', order: 1, style: 'concise', length: '300-500 words' },
        { title: 'Performance Objectives', type: 'objectives', order: 2, style: 'clear', length: '200-400 words' },
        { title: 'System Architecture Overview', type: 'architecture', order: 3, style: 'high-level', length: '300-500 words' },
        { title: 'Performance Metrics', type: 'metrics', order: 4, style: 'comprehensive', length: '500-800 words' },
        { title: 'Benchmarking Results', type: 'benchmarking', order: 5, style: 'analytical', length: '400-600 words' },
        { title: 'Bottleneck Analysis', type: 'bottlenecks', order: 6, style: 'detailed', length: '400-600 words' },
        { title: 'Optimization Strategies', type: 'optimizations', order: 7, style: 'technical', length: '500-800 words' },
        { title: 'Load Testing Results', type: 'load_testing', order: 8, style: 'comprehensive', length: '400-600 words' },
        { title: 'Scalability Assessment', type: 'scalability', order: 9, style: 'analytical', length: '300-500 words' },
        { title: 'Resource Utilization', type: 'resource_utilization', order: 10, style: 'detailed', length: '400-600 words' },
        { title: 'Performance Monitoring', type: 'monitoring', order: 11, style: 'comprehensive', length: '300-500 words' },
        { title: 'Recommendations', type: 'recommendations', order: 12, style: 'actionable', length: '300-500 words' }
      ]
    });

    this.logger.info('📋 Loaded document templates', {
      templatesLoaded: this.templates.size,
      types: Array.from(this.templates.keys())
    });
  }

  /**
   * Get generic template for document type
   */
  getGenericTemplate(type) {
    return {
      sections: [
        { title: 'Introduction', type: 'introduction', order: 1 },
        { title: 'Main Content', type: 'content', order: 2 },
        { title: 'Conclusion', type: 'conclusion', order: 3 }
      ]
    };
  }

  /**
   * Count words in content
   */
  countWords(content) {
    return content.trim().split(/\s+/).length;
  }

  /**
   * Generate code documentation from code analysis
   */
  async generateCodeDocumentation(codeAnalysis, projectInfo = {}) {
    const spec = {
      type: 'code-documentation',
      title: `${projectInfo.name || 'Project'} Code Documentation`,
      audience: 'technical',
      purpose: 'instructional',
      format: 'markdown',
      requirements: ['include_toc', 'include_references']
    };

    // Generate document using existing infrastructure but with code-specific context
    const context = [
      `Project: ${projectInfo.name || 'Unknown'}`,
      `Language: ${projectInfo.language || 'Multiple'}`,
      `Architecture: ${projectInfo.architecture || 'Not specified'}`,
      `Code Analysis: ${codeAnalysis.summary || 'Analysis completed'}`,
      ...codeAnalysis.keyFindings || []
    ];

    // Create custom template for code documentation
    const codeDocTemplate = {
      sections: [
        { title: 'Project Overview', type: 'introduction', order: 1, style: 'comprehensive', length: '300-500 words' },
        { title: 'Architecture Overview', type: 'architecture', order: 2, style: 'detailed', length: '400-600 words' },
        { title: 'Code Structure', type: 'code_structure', order: 3, style: 'detailed', length: '500-800 words' },
        { title: 'Key Components', type: 'components', order: 4, style: 'analytical', length: '600-900 words' },
        { title: 'API Reference', type: 'api_reference', order: 5, style: 'technical', length: '800-1200 words' },
        { title: 'Usage Examples', type: 'examples', order: 6, style: 'practical', length: '600-900 words' },
        { title: 'Development Guidelines', type: 'development', order: 7, style: 'instructional', length: '400-600 words' }
      ]
    };

    const document = {
      title: spec.title,
      type: spec.type,
      sections: [],
      metadata: {
        author: 'COSMO Document Agent',
        createdAt: new Date(),
        version: '1.0',
        audience: spec.audience,
        purpose: spec.purpose,
        projectInfo,
        codeAnalysis
      }
    };

    // Generate sections with code-specific prompts
    for (const sectionTemplate of codeDocTemplate.sections) {
      const sectionContent = await this.generateCodeSection(sectionTemplate, spec, context, projectInfo, codeAnalysis);
      if (sectionContent) {
        document.sections.push(sectionContent);
      }
    }

    return document;
  }

  /**
   * Generate individual code documentation section
   */
  async generateCodeSection(sectionTemplate, spec, context, projectInfo, codeAnalysis) {
    const prompt = this.buildCodeSectionPrompt(sectionTemplate, spec, context, projectInfo, codeAnalysis);

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.getAgentBehavioralPrompt() + '\n\n' + `You are an expert technical writer creating code documentation for a ${spec.audience} audience.
                     Focus on clarity, accuracy, and practical usefulness. Include specific code examples and implementation details.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 12000 // Leave headroom so GPT-5.2 completes naturally, not truncates
      });

      return {
        title: sectionTemplate.title,
        content: response.content,
        type: sectionTemplate.type,
        order: sectionTemplate.order
      };

    } catch (error) {
      this.logger.error('Failed to generate code section', {
        section: sectionTemplate.title,
        error: error.message
      });

      return {
        title: sectionTemplate.title,
        content: `[Error generating section: ${sectionTemplate.title}]`,
        type: sectionTemplate.type,
        order: sectionTemplate.order,
        error: error.message
      };
    }
  }

  /**
   * Build prompt for code documentation section generation
   */
  buildCodeSectionPrompt(sectionTemplate, spec, context, projectInfo, codeAnalysis) {
    let prompt = `Create the "${sectionTemplate.title}" section for code documentation.

Project Context:
- Name: ${projectInfo.name || 'Unknown Project'}
- Language: ${projectInfo.language || 'Multiple languages'}
- Architecture: ${projectInfo.architecture || 'Not specified'}

Code Analysis Summary:
${codeAnalysis.summary || 'No analysis summary available'}

Section Requirements:
- Type: ${sectionTemplate.type}
- Style: ${sectionTemplate.style || 'professional'}
- Audience: ${spec.audience} (focus on practical, technical details)
`;

    if (sectionTemplate.type === 'introduction') {
      prompt += `
This is the project overview section. Provide:
- High-level project description and purpose
- Technology stack overview
- Key features and capabilities
- Target users and use cases
`;
    } else if (sectionTemplate.type === 'architecture') {
      prompt += `
This is the architecture overview section. Detail:
- System architecture and design patterns
- Component relationships and data flow
- Technology choices and rationale
- Scalability and performance considerations
`;
    } else if (sectionTemplate.type === 'code_structure') {
      prompt += `
This is the code structure section. Analyze:
- Directory structure and organization
- Key files and their purposes
- Module relationships and dependencies
- Code organization patterns
`;
    } else if (sectionTemplate.type === 'components') {
      prompt += `
This is the key components section. Describe:
- Main classes, functions, and modules
- Component interfaces and contracts
- Integration points and dependencies
- Component responsibilities and interactions
`;
    } else if (sectionTemplate.type === 'api_reference') {
      prompt += `
This is the API reference section. Document:
- Public interfaces and methods
- Parameter specifications and return types
- Usage examples and code samples
- Error handling and edge cases
`;
    } else if (sectionTemplate.type === 'examples') {
      prompt += `
This is the usage examples section. Provide:
- Practical code examples and snippets
- Step-by-step usage guides
- Common use cases and patterns
- Best practices and recommendations
`;
    }

    prompt += `

Generate the section content now:`;

    return prompt;
  }

  /**
   * Generate spreadsheet analysis report from data
   */
  async generateSpreadsheetAnalysis(data, analysisConfig = {}) {
    const spec = {
      type: 'spreadsheet-analysis',
      title: analysisConfig.title || 'Spreadsheet Data Analysis Report',
      audience: 'technical',
      purpose: 'analytical',
      format: 'markdown',
      requirements: ['include_toc', 'include_references']
    };

    const document = {
      title: spec.title,
      type: spec.type,
      sections: [],
      metadata: {
        author: 'COSMO Document Agent',
        createdAt: new Date(),
        version: '1.0',
        audience: spec.audience,
        purpose: spec.purpose,
        dataSummary: {
          rows: data.length,
          columns: data[0]?.length || 0,
          dataTypes: this.analyzeDataTypes(data)
        }
      }
    };

    // Generate sections for spreadsheet analysis
    const analysisTemplate = {
      sections: [
        { title: 'Analysis Overview', type: 'introduction', order: 1, style: 'clear', length: '200-400 words' },
        { title: 'Data Structure & Sources', type: 'data_structure', order: 2, style: 'detailed', length: '300-500 words' },
        { title: 'Key Metrics & KPIs', type: 'metrics', order: 3, style: 'analytical', length: '400-600 words' },
        { title: 'Trend Analysis', type: 'trend_analysis', order: 4, style: 'comprehensive', length: '500-800 words' },
        { title: 'Formula & Calculation Breakdown', type: 'formulas', order: 5, style: 'technical', length: '500-800 words' },
        { title: 'Insights & Findings', type: 'insights', order: 6, style: 'interpretive', length: '400-600 words' }
      ]
    };

    for (const sectionTemplate of analysisTemplate.sections) {
      const sectionContent = await this.generateSpreadsheetSection(sectionTemplate, spec, data, analysisConfig);
      if (sectionContent) {
        document.sections.push(sectionContent);
      }
    }

    return document;
  }

  /**
   * Generate individual spreadsheet analysis section
   */
  async generateSpreadsheetSection(sectionTemplate, spec, data, analysisConfig) {
    const prompt = this.buildSpreadsheetSectionPrompt(sectionTemplate, spec, data, analysisConfig);

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.getAgentBehavioralPrompt() + '\n\n' + `You are an expert data analyst creating spreadsheet analysis reports for a ${spec.audience} audience.
                     Focus on data-driven insights, statistical analysis, and actionable recommendations.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 12000 // Leave headroom so GPT-5.2 completes naturally, not truncates
      });

      return {
        title: sectionTemplate.title,
        content: response.content,
        type: sectionTemplate.type,
        order: sectionTemplate.order
      };

    } catch (error) {
      this.logger.error('Failed to generate spreadsheet section', {
        section: sectionTemplate.title,
        error: error.message
      });

      return {
        title: sectionTemplate.title,
        content: `[Error generating section: ${sectionTemplate.title}]`,
        type: sectionTemplate.type,
        order: sectionTemplate.order,
        error: error.message
      };
    }
  }

  /**
   * Build prompt for spreadsheet analysis section generation
   */
  buildSpreadsheetSectionPrompt(sectionTemplate, spec, data, analysisConfig) {
    const dataSummary = this.summarizeData(data);
    const columnInfo = this.analyzeColumns(data);

    let prompt = `Create the "${sectionTemplate.title}" section for spreadsheet data analysis.

Data Summary:
- Rows: ${dataSummary.rows}
- Columns: ${dataSummary.columns}
- Column Types: ${Object.entries(columnInfo).map(([col, info]) => `${col} (${info.type})`).join(', ')}

Section Requirements:
- Type: ${sectionTemplate.type}
- Style: ${sectionTemplate.style || 'professional'}
- Focus on data-driven insights and analysis
`;

    if (sectionTemplate.type === 'introduction') {
      prompt += `
This is the analysis overview section. Provide:
- Purpose and scope of the analysis
- Data source description
- Analysis objectives and methodology
- Key questions being addressed
`;
    } else if (sectionTemplate.type === 'data_structure') {
      prompt += `
This is the data structure section. Describe:
- Data source and collection methodology
- Column definitions and data types
- Data quality assessment
- Any data transformations or cleaning performed
`;
    } else if (sectionTemplate.type === 'metrics') {
      prompt += `
This is the key metrics section. Calculate and explain:
- Central tendency measures (mean, median, mode)
- Variability measures (standard deviation, range)
- Key performance indicators relevant to the data
- Important ratios and percentages
`;
    } else if (sectionTemplate.type === 'trend_analysis') {
      prompt += `
This is the trend analysis section. Analyze:
- Temporal patterns and trends
- Seasonal variations if applicable
- Growth rates and change patterns
- Correlation between variables
`;
    } else if (sectionTemplate.type === 'formulas') {
      prompt += `
This is the formulas section. Document:
- Complex calculations and formulas used
- Excel/Spreadsheet functions applied
- Custom calculation logic
- Formula dependencies and relationships
`;
    }

    prompt += `

Generate the section content now:`;

    return prompt;
  }

  /**
   * Analyze data types in spreadsheet data
   */
  analyzeDataTypes(data) {
    if (!data || data.length === 0) return {};

    const firstRow = data[0];
    const types = {};

    for (let col = 0; col < firstRow.length; col++) {
      const columnData = data.slice(1).map(row => row[col]).filter(val => val !== null && val !== undefined && val !== '');

      if (columnData.length === 0) {
        types[col] = 'empty';
        continue;
      }

      const sample = columnData[0];
      if (typeof sample === 'number' || (!isNaN(sample) && !isNaN(parseFloat(sample)))) {
        types[col] = 'numeric';
      } else if (sample instanceof Date || (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample))) {
        types[col] = 'date';
      } else {
        types[col] = 'text';
      }
    }

    return types;
  }

  /**
   * Summarize spreadsheet data
   */
  summarizeData(data) {
    if (!data || data.length === 0) return { rows: 0, columns: 0 };

    return {
      rows: data.length,
      columns: data[0]?.length || 0,
      hasHeaders: true // Assume first row is headers
    };
  }

  /**
   * Analyze column information
   */
  analyzeColumns(data) {
    if (!data || data.length === 0) return {};

    const firstRow = data[0];
    const columnInfo = {};

    for (let col = 0; col < firstRow.length; col++) {
      const columnName = firstRow[col] || `Column_${col + 1}`;
      const columnData = data.slice(1).map(row => row[col]).filter(val => val !== null && val !== undefined && val !== '');

      columnInfo[columnName] = {
        type: this.inferColumnType(columnData),
        count: columnData.length,
        uniqueValues: new Set(columnData).size
      };
    }

    return columnInfo;
  }

  /**
   * Infer column data type
   */
  inferColumnType(data) {
    if (data.length === 0) return 'unknown';

    const sample = data[0];
    if (typeof sample === 'number') return 'numeric';
    if (sample instanceof Date) return 'date';
    if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date_string';
    if (typeof sample === 'boolean') return 'boolean';

    return 'text';
  }

  /**
   * Trigger completion agent for output validation
   */
  async triggerCompletionAgent(document, spec) {
    try {
      // Send message to spawn completion agent
      await this.sendMessage('meta_coordinator', 'spawn_completion_agent', {
        triggerSource: this.agentId,
        targetOutput: {
          id: document.filePath,
          type: 'document',
          title: document.title,
          size: document.wordCount,
          requirements: spec.requirements
        },
        reason: 'Large or complex document generated - validation recommended',
        priority: 'medium'
      });

      this.logger.info('🎯 Triggered completion agent for document validation', {
        documentTitle: document.title,
        wordCount: document.wordCount,
        requirements: spec.requirements
      });
    } catch (error) {
      this.logger.warn('Failed to trigger completion agent', {
        error: error.message,
        documentTitle: document.title
      });
    }
  }

  /**
   * Trigger QA agent to validate the created document
   * Implements "research team" workflow where outputs are reviewed
   */
  async triggerQualityAssurance(document, spec) {
    try {
      // Send message to spawn QA agent with artifact reference
      await this.sendMessage('meta_coordinator', 'spawn_qa_agent', {
        triggerSource: this.agentId,
        targetOutput: {
          id: document.filePath,
          type: 'document',
          title: document.title,
          path: document.deliverablePath || document.filePath,
          wordCount: document.wordCount,
          format: document.format,
          requirements: spec.requirements,
          audience: spec.audience,
          purpose: spec.purpose
        },
        artifactToReview: {
          path: document.deliverablePath || document.filePath,
          mission: {
            description: this.mission.description,
            goalId: this.mission.goalId
          },
          results: [
            {
              type: 'document',
              content: document.content || `Document created at ${document.filePath}`,
              path: document.deliverablePath || document.filePath,
              title: document.title,
              wordCount: document.wordCount
            }
          ]
        },
        reason: 'Document created - quality assurance review needed',
        priority: 'high'
      });

      this.logger.info('🔍 Requested QA agent for document review', {
        documentTitle: document.title,
        path: document.filePath
      });

    } catch (error) {
      this.logger.warn('Failed to trigger QA agent', {
        error: error.message,
        documentTitle: document.title
      });
    }
  }
}

/**
 * Markdown Formatter
 */
class MarkdownFormatter {
  async format(document, spec) {
    let content = `# ${document.title}\n\n`;

    if (spec.requirements.includes('include_toc')) {
      content += this.generateTOC(document.sections);
    }

    for (const section of document.sections) {
      content += `## ${section.title}\n\n${section.content}\n\n`;
    }

    if (spec.requirements.includes('include_references')) {
      content += `## References\n\n*This document was generated by COSMO Document Creation Agent*\n\n`;
    }

    return {
      ...document,
      formattedContent: content,
      format: 'markdown'
    };
  }

  generateTOC(sections) {
    let toc = `## Table of Contents\n\n`;
    for (const section of sections) {
      toc += `- [${section.title}](#${section.title.toLowerCase().replace(/\s+/g, '-')})\n`;
    }
    return toc + '\n';
  }
}

/**
 * HTML Formatter
 */
class HTMLFormatter {
  async format(document, spec) {
    let content = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${document.title}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; margin: 40px; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        .toc { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
        .toc a { text-decoration: none; color: #3498db; }
    </style>
</head>
<body>
    <h1>${document.title}</h1>
`;

    if (spec.requirements.includes('include_toc')) {
      content += `<div class="toc">
        <h2>Table of Contents</h2>
        <ul>
${document.sections.map(s => `            <li><a href="#${s.title.toLowerCase().replace(/\s+/g, '-')}">${s.title}</a></li>`).join('\n')}
        </ul>
    </div>`;
    }

    for (const section of document.sections) {
      content += `    <h2 id="${section.title.toLowerCase().replace(/\s+/g, '-')}">${section.title}</h2>
    <p>${section.content.replace(/\n/g, '</p><p>')}</p>
`;
    }

    content += `</body>
</html>`;

    return {
      ...document,
      formattedContent: content,
      format: 'html'
    };
  }
}

/**
 * PDF-Ready Formatter (Markdown with PDF-friendly styling)
 */
class PDFReadyFormatter {
  async format(document, spec) {
    let content = `# ${document.title}

*Generated by COSMO Document Creation Agent*

`;

    for (const section of document.sections) {
      content += `## ${section.title}

${section.content}

`;
    }

    if (spec.requirements.includes('include_references')) {
      content += `## References

This document was generated by COSMO Document Creation Agent on ${new Date().toLocaleDateString()}

`;
    }

    return {
      ...document,
      formattedContent: content,
      format: 'pdf-ready'
    };
  }

  /**
   * Calculate safe context limit based on token budget
   * 
   * Prevents context overflow that causes response truncation.
   * Uses actual node sizes to estimate token usage dynamically.
   * 
   * @param {Array} nodes - Memory nodes to include
   * @param {Object} options - Budget parameters
   * @param {number} options.availableTokens - Total tokens available for context (default: 110k)
   * @param {number} options.maxNodes - Maximum nodes even if budget allows more (default: 150)
   * @param {number} options.minNodes - Minimum nodes if available (default: 20)
   * @returns {number} Safe number of nodes to use
   */
  calculateSafeContextLimit(nodes, options = {}) {
    const {
      availableTokens = 110000,  // Conservative: 128k window - 16k output - 2k overhead
      maxNodes = 150,             // Reasonable maximum
      minNodes = 20               // Minimum for quality
    } = options;
    
    if (!nodes || nodes.length === 0) {
      return 0;
    }
    
    // Calculate average node size across all available nodes
    // This gives us a realistic estimate for this specific memory state
    const totalChars = nodes.reduce((sum, node) => {
      return sum + (node.concept?.length || 0);
    }, 0);
    
    const avgCharsPerNode = totalChars / nodes.length;
    
    // Rough token estimate: 1 token ≈ 4 characters (conservative)
    const tokensPerNode = avgCharsPerNode / 4;
    
    // Calculate how many nodes fit in our token budget
    const nodesThatFitBudget = Math.floor(availableTokens / tokensPerNode);
    
    // Apply constraints
    const safeLimit = Math.min(
      nodesThatFitBudget,  // Token budget limit
      maxNodes,            // Reasonable maximum
      nodes.length         // Can't use more than available
    );
    
    // Ensure we use at least minNodes if available
    const finalLimit = Math.max(safeLimit, Math.min(minNodes, nodes.length));
    
    this.logger.debug('📊 Token budget calculation', {
      totalNodes: nodes.length,
      avgCharsPerNode: Math.round(avgCharsPerNode),
      tokensPerNode: Math.round(tokensPerNode),
      nodesThatFitBudget,
      appliedLimit: finalLimit,
      estimatedTokens: Math.round(finalLimit * tokensPerNode)
    });
    
    return finalLimit;
  }

  /**
   * Estimate token count for a set of memory nodes
   * Used for logging and validation
   * 
   * @param {Array} nodes - Memory nodes
   * @returns {number} Estimated token count
   */
  estimateTokenCount(nodes) {
    if (!nodes || nodes.length === 0) return 0;
    
    const totalChars = nodes.reduce((sum, node) => {
      return sum + (node.concept?.length || 0);
    }, 0);
    
    // Conservative estimate: 1 token ≈ 4 characters
    return Math.round(totalChars / 4);
  }
}

module.exports = { DocumentCreationAgent };
