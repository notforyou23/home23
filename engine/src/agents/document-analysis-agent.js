const { BaseAgent } = require('./base-agent');
const { GitHubDetector } = require('./utils/github-detector');
const fs = require('fs').promises;
const path = require('path');

/**
 * DocumentAnalysisAgent - Document comparison and evolution tracking specialist
 *
 * Purpose:
 * - Analyze collections of documents for differences and evolution
 * - Track document versions and changes over time
 * - Extract metadata and understand document relationships
 * - Generate document stories and comparison reports
 * - Handle document folder exploration and analysis
 *
 * Use Cases:
 * - Compare document versions and track changes
 * - Analyze document evolution and modification patterns
 * - Extract metadata and understand document relationships
 * - Generate comprehensive document analysis reports
 * - Explore document collections for insights
 */
class DocumentAnalysisAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.analyzedDocuments = new Map();
    this.documentRelationships = new Map();
    this.versionChains = new Map();
    
    // NEW: Batch processing configuration (additive, backward compatible)
    // Default batch size of 100 documents, 0 = unlimited
    this.batchSize = mission.batchSize !== undefined ? mission.batchSize : 100;
    this.continuationId = mission.continuationId || null; // Link continuation agents
    this.processedFiles = mission.processedFiles || []; // Files already analyzed (for continuations)
    this.isContinuation = !!mission.continuationId; // Track if this is a continuation
  }

  /**
   * EXECUTIVE RING: Override accomplishment check for DocumentAnalysisAgent
   * 
   * DocumentAnalysisAgent must analyze at least 1 document to be considered accomplished.
   * This catches the common failure mode where agent completes but finds 0 documents.
   */
  assessAccomplishment(executeResult, results) {
    const documentsAnalyzed = executeResult?.metadata?.documentsAnalyzed || 0;
    
    if (documentsAnalyzed === 0) {
      return {
        accomplished: false,
        reason: 'No documents found or analyzed despite DocumentAnalysisAgent mission',
        metrics: {
          documentsAnalyzed: 0,
          documentsExpected: 'at least 1',
          allowedPaths: this.config?.mcp?.client?.servers?.[0]?.allowedPaths || [],
          batchSize: this.batchSize,
          isContinuation: this.isContinuation
        }
      };
    }
    
    // Has documents - check base criteria too (findings/insights)
    const baseCheck = super.assessAccomplishment(executeResult, results);
    
    // Override with document-specific metrics
    return {
      accomplished: true,
      reason: null,
      metrics: {
        ...baseCheck.metrics,
        documentsAnalyzed,
        relationshipsFound: executeResult?.metadata?.relationshipsFound || 0,
        versionChains: executeResult?.metadata?.versionChains || 0,
        insightsGenerated: executeResult?.metadata?.insightsGenerated || 0
      }
    };
  }

  /**
   * Initialize document analysis resources
   */
  async onStart() {
    await this.reportProgress(5, 'Initializing document analysis resources');

    // Check MCP availability
    if (!this.gpt5?.callMCPTool) {
      this.logger.warn('⚠️ MCP filesystem tools not available');
      this.logger.info('💡 Document analysis requires MCP server for file access');
      this.logger.info('💡 Use launch script: ./scripts/LAUNCH_COSMO.sh');
      this.logger.info('💡 Select "Custom directories" and configure your document folder');
    } else {
      this.logger.info('✅ MCP filesystem tools available');
    }

    // Load existing document analysis patterns from memory
    const analysisContext = await this.queryMemoryForKnowledge(15);

    if (analysisContext.length > 0) {
      this.logger.info('📚 Found existing document analysis patterns', {
        patternsFound: analysisContext.length
      });
    }

    await this.reportProgress(15, 'Document analysis agent ready');
  }

  /**
   * NEW: Get or create progress registry for batch tracking
   * Registry tracks: processed files, batch info, continuation chain
   * @returns {Object} Progress registry
   */
  async getOrCreateProgressRegistry() {
    const registryPath = path.join(
      this.config.logsDir || path.join(process.cwd(), 'runtime'),
      'agents',
      this.agentId,
      'document-progress.json'
    );
    
    try {
      const data = await fs.readFile(registryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // Registry doesn't exist yet - create new one
      const registry = {
        agentId: this.agentId,
        createdAt: new Date().toISOString(),
        isContinuation: this.isContinuation,
        continuationId: this.continuationId,
        processedFiles: [...this.processedFiles], // Copy from mission if continuation
        totalDiscovered: 0,
        batches: [],
        status: 'active'
      };
      
      // Create directory if needed
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      
      // Write via Capabilities
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), registryPath),
          JSON.stringify(registry, null, 2),
          { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
      }
      
      this.logger.info('📝 Created progress registry', {
        agentId: this.agentId,
        isContinuation: this.isContinuation,
        alreadyProcessed: this.processedFiles.length
      });
      
      return registry;
    }
  }

  /**
   * NEW: Update progress registry after processing batch
   * @param {Object} registry - Progress registry to update
   * @param {Array} newProcessedFiles - Files processed in this batch
   * @param {Object} batchInfo - Information about this batch
   */
  async updateProgressRegistry(registry, newProcessedFiles, batchInfo) {
    const registryPath = path.join(
      this.config.logsDir || path.join(process.cwd(), 'runtime'),
      'agents',
      this.agentId,
      'document-progress.json'
    );
    
    // Add new files to processed list
    registry.processedFiles.push(...newProcessedFiles);
    
    // Add batch info
    registry.batches.push({
      batchNumber: registry.batches.length + 1,
      filesProcessed: newProcessedFiles.length,
      completedAt: new Date().toISOString(),
      ...batchInfo
    });
    
    // Update status
    registry.lastUpdated = new Date().toISOString();
    
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), registryPath),
        JSON.stringify(registry, null, 2),
        { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
    }
    
    this.logger.debug('📝 Updated progress registry', {
      totalProcessed: registry.processedFiles.length,
      batchNumber: registry.batches.length
    });
  }

  /**
   * NEW: Spawn continuation agent to process remaining documents
   * @param {Array} remainingFiles - Files not yet processed
   * @param {Object} registry - Progress registry
   * @param {Object} analysisSpec - Analysis specification to pass to continuation
   */
  async spawnContinuationAgent(remainingFiles, registry, analysisSpec) {
    if (remainingFiles.length === 0) {
      return null;
    }
    
    // Generate continuation ID (chain continuations together)
    const continuationId = this.continuationId || `continuation_${this.agentId}`;
    
    // Build continuation mission
    const continuationMission = {
      ...this.mission,
      description: `${this.mission.description} [CONTINUATION: Processing ${remainingFiles.length} remaining documents]`,
      batchSize: this.batchSize,
      continuationId: continuationId,
      processedFiles: [...registry.processedFiles], // Pass list of already processed files
      _isContinuation: true,
      _originalAgentId: this.continuationId ? this.mission._originalAgentId : this.agentId
    };
    
    this.logger.info('🔄 Spawning continuation agent', {
      remainingFiles: remainingFiles.length,
      processedSoFar: registry.processedFiles.length,
      continuationId: continuationId,
      batchSize: this.batchSize
    });
    
    // Queue continuation agent via actions queue
    try {
      const actionsQueuePath = path.join(
        this.config.logsDir || path.join(process.cwd(), 'runtime'),
        'actions-queue.json'
      );
      
      let actionsData = { actions: [] };
      try {
        const data = await fs.readFile(actionsQueuePath, 'utf-8');
        actionsData = JSON.parse(data);
      } catch (error) {
        // Queue doesn't exist - will be created
      }
      
      const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const newAction = {
        actionId,
        type: 'spawn_agent',
        agentType: 'document_analysis',
        mission: JSON.stringify(continuationMission),
        priority: this.mission.priority || 0.8,
        requestedAt: new Date().toISOString(),
        source: 'document_analysis_agent_continuation',
        status: 'pending',
        parentAgentId: this.agentId,
        continuationOf: this.continuationId || this.agentId
      };
      
      actionsData.actions = actionsData.actions || [];
      actionsData.actions.push(newAction);
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), actionsQueuePath),
          JSON.stringify(actionsData, null, 2),
          { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
      }
      
      this.logger.info('✅ Continuation agent queued', {
        actionId,
        continuationId,
        remainingDocs: remainingFiles.length
      });
      
      // Store continuation info in registry
      registry.continuationAgentQueued = {
        actionId,
        queuedAt: new Date().toISOString(),
        remainingFiles: remainingFiles.length
      };
      await this.updateProgressRegistry(registry, [], {
        continuationQueued: true,
        actionId
      });
      
      return actionId;
      
    } catch (error) {
      this.logger.error('Failed to spawn continuation agent', {
        error: error.message,
        remainingFiles: remainingFiles.length
      });
      throw error;
    }
  }

  /**
   * Main document analysis and comparison logic
   */
  async execute() {
    this.logger.info('📋 DocumentAnalysisAgent: Starting document analysis mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description,
      batchSize: this.batchSize,
      isContinuation: this.isContinuation,
      alreadyProcessed: this.processedFiles.length
    });

    // NOTE: GPT-5.2-with-tools approach doesn't work for local MCP servers
    // OpenAI can't reach localhost from their servers (424 Failed Dependency)
    // Agent code must call MCP tools and pass results to GPT-5
    
    // NEW: Initialize progress registry for batch tracking
    const registry = await this.getOrCreateProgressRegistry();
    
    // Parse analysis requirements from mission
    const analysisSpec = await this.parseAnalysisRequirements();

    await this.reportProgress(25, `Analyzing ${analysisSpec.scope} documents`);

    // Discover and analyze document collection (with batch limits and continuation support)
    const documentCollection = await this.discoverDocumentCollection(analysisSpec, registry);

    await this.reportProgress(50, 'Analyzing documents');

    // MODE DETECTION: Ingestion vs Analysis
    // Ingestion: Extract and store content for knowledge base
    // Analysis: Compare versions and track evolution
    const isIngestion = this.mission.description.toLowerCase().includes('ingest') ||
                        this.mission.description.toLowerCase().includes('injected') ||
                        this.mission.metadata?.isIngestion === true;
    
    let analysisResults, report;
    
    if (isIngestion) {
      // INGESTION MODE: Extract key content and store in memory
      this.logger.info('📥 Ingestion mode: Extracting content for knowledge base', {
        documents: documentCollection.length
      });
      
      await this.reportProgress(60, 'Extracting key concepts and content');
      analysisResults = await this.ingestDocumentsIntoMemory(documentCollection, analysisSpec);
      
      await this.reportProgress(75, 'Generating ingestion summary');
      report = await this.generateIngestionReport(analysisResults, analysisSpec);
      
    } else {
      // ANALYSIS MODE: Compare documents and extract evolution story
      this.logger.info('📊 Analysis mode: Comparing and tracking evolution', {
        documents: documentCollection.length
      });
      
      await this.reportProgress(60, 'Comparing documents and extracting metadata');
      analysisResults = await this.analyzeDocumentEvolution(documentCollection, analysisSpec);
      
      await this.reportProgress(75, 'Generating analysis report and insights');
      report = await this.generateAnalysisReport(analysisResults, analysisSpec);
    }

    // NEW: Check if deliverable specified in mission
    if (this.mission.deliverable) {
      await this.reportProgress(85, 'Creating deliverable output');
      await this.createDeliverableOutput(report, this.mission.deliverable, documentCollection);
    }

    await this.reportProgress(90, 'Storing in memory network');

    // Store results in memory (mode-aware)
    if (isIngestion) {
      // Ingestion mode: content already stored during ingestDocumentsIntoMemory()
      this.logger.info('✅ Content already stored in memory during ingestion');
    } else {
      // Analysis mode: store metadata and relationships
      await this.storeAnalysisInMemory(report, analysisResults, analysisSpec);
    }

    // Store document contents for other agents (e.g., CodeExecutionAgent)
    await this.storeDocumentContentsForHandoff(documentCollection);

    // NEW: Update progress registry with processed files
    const processedFilePaths = documentCollection.map(doc => doc.path);
    await this.updateProgressRegistry(registry, processedFilePaths, {
      documentsAnalyzed: documentCollection.length,
      relationshipsFound: analysisResults.relationships.length,
      versionChains: analysisResults.versionChains.length,
      insightsGenerated: report.insights.length
    });

    // NEW: Check if continuation is needed
    let continuationInfo = null;
    if (registry.remainingFiles && registry.remainingFiles.length > 0) {
      this.logger.info('📚 More documents remaining - spawning continuation agent', {
        processedInThisBatch: documentCollection.length,
        totalProcessedSoFar: registry.processedFiles.length,
        remaining: registry.remainingFiles.length
      });
      
      await this.reportProgress(95, `Spawning continuation agent for ${registry.remainingFiles.length} remaining documents`);
      
      try {
        const actionId = await this.spawnContinuationAgent(
          registry.remainingFiles,
          registry,
          analysisSpec
        );
        
        continuationInfo = {
          continuationQueued: true,
          actionId: actionId,
          remainingDocuments: registry.remainingFiles.length,
          message: `Continuation agent queued to process ${registry.remainingFiles.length} remaining documents`
        };
        
        // Add finding about continuation
        await this.addFinding(
          `Batch analysis complete. Processed ${documentCollection.length} documents in this batch. ` +
          `Total processed: ${registry.processedFiles.length}. ` +
          `Remaining: ${registry.remainingFiles.length}. ` +
          `Continuation agent queued (action: ${actionId}).`,
          'document_batch_completion'
        );
        
      } catch (error) {
        this.logger.error('Failed to spawn continuation agent', {
          error: error.message,
          remaining: registry.remainingFiles.length
        });
        
        continuationInfo = {
          continuationQueued: false,
          error: error.message,
          remainingDocuments: registry.remainingFiles.length,
          message: `Warning: ${registry.remainingFiles.length} documents remain but continuation agent failed to spawn`
        };
      }
    } else {
      // All documents processed
      this.logger.info('✅ All documents processed - no continuation needed', {
        totalProcessed: registry.processedFiles.length,
        batchesCompleted: registry.batches.length
      });
      
      // Mark registry as complete
      registry.status = 'completed';
      registry.completedAt = new Date().toISOString();
      await this.updateProgressRegistry(registry, [], { finalBatch: true });
      
      // Add completion finding
      if (registry.batches.length > 1 || this.isContinuation) {
        await this.addFinding(
          `Document analysis complete across ${registry.batches.length} batch(es). ` +
          `Total documents analyzed: ${registry.processedFiles.length}. ` +
          `This was ${this.isContinuation ? 'a continuation agent completing the analysis chain' : 'completed in a single agent execution'}.`,
          'document_analysis_chain_complete'
        );
      }
    }

    await this.reportProgress(100, 'Document analysis completed');

    return {
      success: true,
      analysis: report,
      documentContents: documentCollection.map(doc => ({
        filename: doc.filename,
        path: doc.path,
        content: doc.content,
        metadata: doc.metadata
      })),
      metadata: {
        documentsAnalyzed: documentCollection.length,
        relationshipsFound: analysisResults.relationships.length,
        versionChains: analysisResults.versionChains.length,
        insightsGenerated: report.insights.length,
        createdAt: new Date(),
        // NEW: Batch processing metadata
        batchInfo: {
          batchNumber: registry.batches.length,
          totalProcessedSoFar: registry.processedFiles.length,
          isContinuation: this.isContinuation,
          continuationId: this.continuationId,
          continuation: continuationInfo
        }
      }
    };
  }

  /**
   * Parse analysis requirements from mission
   */
  async parseAnalysisRequirements() {
    const missionText = this.mission.description.toLowerCase();

    // Check for specific file paths in mission (can be multiple)
    const specificFiles = this.extractSpecificFilePaths(this.mission.description);

    // Determine analysis scope
    let scope = 'document_collection';
    if (specificFiles.length > 0) {
      scope = specificFiles.length === 1 ? 'single_file' : 'specific_files';
    } else if (missionText.includes('version') || missionText.includes('evolution')) {
      scope = 'version_analysis';
    } else if (missionText.includes('metadata') || missionText.includes('properties')) {
      scope = 'metadata_extraction';
    } else if (missionText.includes('comparison') || missionText.includes('difference')) {
      scope = 'document_comparison';
    }

    // Determine analysis depth
    let depth = 'standard';
    if (missionText.includes('deep') || missionText.includes('comprehensive')) {
      depth = 'comprehensive';
    } else if (missionText.includes('quick') || missionText.includes('overview')) {
      depth = 'overview';
    }

    // Extract specific requirements
    const requirements = this.extractAnalysisRequirements(missionText);
    const keywords = this.extractMissionKeywords(this.mission.description);

    return {
      scope,
      depth,
      requirements,
      keywords,
      specificFiles,  // Array of file paths if detected
      outputFormat: this.determineOutputFormat(missionText)
    };
  }

  /**
   * Extract specific analysis requirements
   */
  extractAnalysisRequirements(text) {
    const requirements = [];

    if (text.includes('version') || text.includes('evolution') || text.includes('change')) {
      requirements.push('track_versions');
    }
    if (text.includes('metadata') || text.includes('properties') || text.includes('attributes')) {
      requirements.push('extract_metadata');
    }
    if (text.includes('comparison') || text.includes('difference') || text.includes('diff')) {
      requirements.push('compare_content');
    }
    if (text.includes('relationship') || text.includes('connection') || text.includes('link')) {
      requirements.push('analyze_relationships');
    }
    if (text.includes('story') || text.includes('narrative') || text.includes('history')) {
      requirements.push('generate_story');
    }

    return requirements;
  }

  /**
   * Extract specific file paths from mission if mentioned
   * Handles patterns like:
   * - "Analyze src/core/orchestrator.js" -> [src/core/orchestrator.js]
   * - "Read orchestrator.js and base-agent.js" -> [orchestrator.js, base-agent.js]
   * - Multiple files: "Read file1.js, file2.js, file3.js" -> [file1.js, file2.js, file3.js]
   * 
   * @returns {Array<string>} Array of file paths (empty if none found)
   */
  extractSpecificFilePaths(text) {
    if (!text) return [];
    
    const files = [];
    
    // Pattern 1: Full paths with extension (src/path/to/file.ext)
    const fullPathRegex = /([a-z0-9_\-]+(?:\/[a-z0-9_\-]+)*\/[a-z0-9_\-]+\.(js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|md|json|yaml|yml|txt|sh|rb|php))/gi;
    let matches = text.matchAll(fullPathRegex);
    for (const match of matches) {
      files.push(match[1]);
    }
    
    // Pattern 2: Just filenames with extension (orchestrator.js)
    // Only look for these if we didn't find full paths, to avoid duplicates
    if (files.length === 0) {
      const filenameRegex = /\b([a-z0-9_\-]+\.(js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|md|json|yaml|yml|txt|sh|rb|php))\b/gi;
      matches = text.matchAll(filenameRegex);
      for (const match of matches) {
        if (!files.includes(match[1])) {
          files.push(match[1]);
        }
      }
    }
    
    return files;
  }

  extractMissionKeywords(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const keywords = new Set();
    const addKeyword = (term) => {
      if (!term) return;
      const cleaned = term.trim().toLowerCase();
      if (cleaned.length < 3) return;
      keywords.add(cleaned);
    };

    const singleQuoteRegex = /'([^']+)'/g;
    let match;
    while ((match = singleQuoteRegex.exec(text)) !== null) {
      addKeyword(match[1]);
    }

    const doubleQuoteRegex = /"([^"]+)"/g;
    while ((match = doubleQuoteRegex.exec(text)) !== null) {
      addKeyword(match[1]);
    }

    const stopwords = new Set([
      'about', 'after', 'again', 'against', 'among', 'because', 'before', 'between',
      'could', 'document', 'focus', 'guide', 'important', 'include', 'information',
      'insight', 'links', 'methodology', 'methods', 'other', 'practical', 'report',
      'requirement', 'should', 'summary', 'three', 'facts', 'evidence', 'sources',
      'section', 'minimum', 'words', 'analysis', 'agent', 'mission', 'related'
    ]);

    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .forEach(word => {
        if (word.length >= 4 && !stopwords.has(word)) {
          addKeyword(word);
        }
      });

    return Array.from(keywords);
  }

  /**
   * Determine output format from mission
   */
  determineOutputFormat(text) {
    if (text.includes('html') || text.includes('web')) {
      return 'html';
    }
    if (text.includes('json') || text.includes('structured')) {
      return 'json';
    }
    return 'markdown'; // default
  }

  /**
   * Discover and analyze document collection
   * NEW: Supports batching and continuation via registry
   */
  async discoverDocumentCollection(spec, registry = null) {
    const documents = [];

    // Get document paths from mission or discover from file system
    const documentPaths = await this.getDocumentPaths(spec);
    
    // CRITICAL: Check if this is a GitHub repository analysis
    if (documentPaths.length > 0 && documentPaths[0]._githubRepo) {
      const { owner, repo } = documentPaths[0];
      this.logger.info('🌐 Analyzing external GitHub repository', { owner, repo });
      
      // Use GitHub MCP to analyze repository
      const githubAnalysis = await this.analyzeGitHubRepository(owner, repo, spec);
      return githubAnalysis;
    }
    
    // NEW: Filter out already processed files (for continuation agents)
    let candidatePaths = documentPaths;
    if (registry && registry.processedFiles.length > 0) {
      const processedSet = new Set(registry.processedFiles);
      candidatePaths = documentPaths.filter(p => !processedSet.has(p));
      
      this.logger.info('📋 Filtered already processed files', {
        total: documentPaths.length,
        alreadyProcessed: registry.processedFiles.length,
        remaining: candidatePaths.length
      });
    }
    
    // Store total for continuation logic
    if (registry) {
      registry.totalDiscovered = candidatePaths.length;
    }
    
    const filteredPaths = this.filterPathsByKeywords(candidatePaths, spec.keywords);
    const enforceKeywordFilter = Array.isArray(spec.keywords) && spec.keywords.length > 0;
    const limitedPaths = this.limitDocumentCount(
      filteredPaths.length > 0 ? filteredPaths : candidatePaths,
      spec
    );
    
    // NEW: Store remaining files for potential continuation
    const remainingPaths = (filteredPaths.length > 0 ? filteredPaths : candidatePaths).slice(limitedPaths.length);
    if (registry) {
      registry.remainingFiles = remainingPaths;
      registry.currentBatchSize = limitedPaths.length;
    }

    for (const docPath of limitedPaths) {
      let preloaded = null;

      if (enforceKeywordFilter) {
        try {
          const loaded = await this.readDocumentContent(docPath);
          if (!this.documentContentMatchesKeywords(loaded.content, spec.keywords)) {
            this.logger.debug('Skipping document (no keyword hit in content)', { path: docPath });
            continue;
          }
          preloaded = loaded;
        } catch (error) {
          this.logger.warn('Failed to preview document for keyword match', {
            path: docPath,
            error: error.message
          });
          continue;
        }
      }

      try {
        const document = await this.analyzeSingleDocument(docPath, spec, preloaded);
        documents.push(document);

        // Track in analyzed documents map
        this.analyzedDocuments.set(document.id, document);
      } catch (error) {
        this.logger.warn('Failed to analyze document', {
          path: docPath,
          error: error.message
        });
      }
    }

    this.logger.info('📁 Document collection analyzed', {
      totalDocuments: documents.length,
      successfulAnalyses: this.analyzedDocuments.size
    });

    return documents;
  }

  /**
   * Get document paths for analysis
   * Supports both local files (filesystem MCP) and external GitHub repositories (github MCP)
   */
  async getDocumentPaths(spec) {
    const paths = [];

    // NEW: Check if mission specifies specific files
    if (spec.specificFiles && spec.specificFiles.length > 0) {
      this.logger.info('📄 Analyzing specific files', { 
        count: spec.specificFiles.length,
        files: spec.specificFiles 
      });
      
      const resolvedPaths = [];
      
      // Resolve each file (handle both full paths and just filenames)
      for (const file of spec.specificFiles) {
        if (!file.includes('/')) {
          // Just a filename - search for it
          this.logger.info('🔍 Searching for file by name', { filename: file });
          const foundPath = await this.findFileByName(file);
          if (foundPath) {
            this.logger.info('✅ File located', { path: foundPath });
            resolvedPaths.push(foundPath);
          } else {
            this.logger.warn('⚠️ File not found', { filename: file });
          }
        } else {
          // Has path - use directly
          resolvedPaths.push(file);
        }
      }
      
      if (resolvedPaths.length > 0) {
        this.logger.info('✅ Resolved files for analysis', { count: resolvedPaths.length });
        return resolvedPaths;
      } else {
        this.logger.warn('⚠️ No files resolved, falling back to directory search');
      }
    }

    // CRITICAL: Check if mission mentions GitHub repository
    const githubRepo = GitHubDetector.detectAndValidate(this.mission.description);
    
    if (githubRepo.detected && githubRepo.valid) {
      // Mission targets a GitHub repository - use github MCP
      this.logger.info('🌐 Detected GitHub repository in mission', {
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        pattern: githubRepo.pattern
      });
      this.logger.info('📋 Mission will use github MCP to access external repository');
      
      // Return special marker that indicates GitHub mode
      // Actual GitHub access will happen in discoverDocumentCollection
      return [{
        _githubRepo: true,
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        source: 'github_mcp',
        detectionPattern: githubRepo.pattern
      }];
    } else if (githubRepo.detected && !githubRepo.valid) {
      // Detected but invalid format - log warning and continue with local files
      this.logger.warn('⚠️  Detected potential GitHub repo but validation failed', {
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        note: 'Continuing with local file access'
      });
    }

    // PRIMARY METHOD: Use configured allowedPaths from launch script
    // This is what the user selected during setup - use it directly!
    const mcpServers = this.config?.mcp?.client?.servers;
    const filesystemServer = mcpServers?.find(s => s.label === 'filesystem');
    const allowedPaths = filesystemServer?.allowedPaths;

    if (allowedPaths && allowedPaths.length > 0) {
      this.logger.info('📁 Using configured file access paths from launch script', {
        allowedPaths
      });

      // Discover documents in ALL configured paths
      for (const configuredPath of allowedPaths) {
        const cleanPath = configuredPath.replace(/\/$/, ''); // Remove trailing slash
        const docs = await this.discoverDocumentsViaMCPInSpecificPath(cleanPath, spec);
        paths.push(...docs);
      }
    } else {
      // FALLBACK: Only if no configuration exists, try to extract from mission
      this.logger.warn('⚠️ No file access paths configured - trying to extract from mission');

      const pathMatches = this.mission.description.match(/in\s+the\s+([a-zA-Z0-9_\-]+)\s+folder/i) ||
                         this.mission.description.match(/in\s+the\s+([a-zA-Z0-9_\-]+)\s+directory/i);

      if (pathMatches) {
        const basePath = pathMatches[1];
        this.logger.info('📁 Extracted path from mission text', { path: basePath });
        const docs = await this.discoverDocumentsViaMCPInSpecificPath(basePath, spec);
        paths.push(...docs);
      } else {
        this.logger.error('💡 No file access configured and no path in mission');
        this.logger.error('💡 Use launch script and select "Custom directories" to configure file access');
      }
    }

    if (paths.length === 0) {
      this.logger.warn('No documents found for analysis');

      if (!this.gpt5?.callMCPTool) {
        this.logger.error('💡 MCP filesystem server not available');
        this.logger.error('💡 To use document analysis:');
        this.logger.error('   1. Use the launch script: ./scripts/LAUNCH_COSMO.sh');
        this.logger.error('   2. Select "Custom directories" for file access');
        this.logger.error('   3. Configure the directory containing your documents');
        this.logger.error('   4. The MCP server will be started automatically');
      } else {
        this.logger.error('💡 No documents found in accessible directories');
        this.logger.error('💡 Configured allowed paths:', allowedPaths || 'none');
        this.logger.error('💡 To analyze documents, ensure they exist in allowed paths');
        this.logger.error('   Or use launch script to add more directories to file access');
      }

      // DO NOT use fallback discovery - it bypasses MCP security by scanning filesystem directly
      // This would find files outside allowed paths, then fail when trying to read via MCP
    }
    
    // PROVENANCE CHECK: Filter out already-analyzed documents from injected directories
    // This prevents re-analysis loops by checking injection manifests
    if (paths.length > 0) {
      const filteredPaths = await this.filterAlreadyAnalyzedDocuments(paths);
      const skippedCount = paths.length - filteredPaths.length;
      
      if (skippedCount > 0) {
        this.logger.info('🔍 Filtered already-analyzed documents from injected directories', {
          totalFound: paths.length,
          alreadyAnalyzed: skippedCount,
          willAnalyze: filteredPaths.length
        });
      }
      
      return filteredPaths;
    }

    return paths;
  }
  
  /**
   * Filter out documents that are already marked as analyzed in injection manifests
   * Prevents re-analysis loops by checking provenance tracking
   * @param {Array<string>} paths - Document paths to check
   * @returns {Array<string>} Paths that need analysis (not already analyzed)
   */
  async filterAlreadyAnalyzedDocuments(paths) {
    const pathsToAnalyze = [];
    const manifestCache = new Map(); // Cache manifests to avoid re-reading
    
    for (const docPath of paths) {
      // Only check documents in injected directories
      if (!docPath.includes('/injected/')) {
        pathsToAnalyze.push(docPath);
        continue;
      }
      
      try {
        // Extract injection directory
        const match = docPath.match(/(.*\/injected\/\d+)\//);
        if (!match) {
          pathsToAnalyze.push(docPath);
          continue;
        }
        
        const injectionDir = match[1];
        
        // Check cache first
        let manifest = manifestCache.get(injectionDir);
        
        // Load manifest if not cached
        if (!manifest) {
          const manifestPath = `${injectionDir}/.injection-manifest.json`;
          
          try {
            if (this.gpt5?.callMCPTool) {
              const result = await this.gpt5.callMCPTool('filesystem', 'read_file', { path: manifestPath });
              if (result?.content?.[0]) {
                const data = JSON.parse(result.content[0].text);
                manifest = JSON.parse(data.content);
                manifestCache.set(injectionDir, manifest);
              }
            } else {
              const content = await fs.readFile(manifestPath, 'utf-8');
              manifest = JSON.parse(content);
              manifestCache.set(injectionDir, manifest);
            }
          } catch (error) {
            // No manifest or error reading - assume needs analysis
            this.logger.debug(`No manifest found for ${injectionDir}, will analyze`);
            pathsToAnalyze.push(docPath);
            continue;
          }
        }
        
        // Check if this specific file is marked as analyzed
        const fileRecord = manifest.files.find(f => f.path === docPath);
        
        if (fileRecord && fileRecord.analyzed) {
          // Already analyzed - skip it
          this.logger.debug(`📋 Skipping already-analyzed document: ${path.basename(docPath)}`);
        } else {
          // Not analyzed yet - include it
          pathsToAnalyze.push(docPath);
        }
        
      } catch (error) {
        // Error checking - safer to include than skip
        this.logger.debug(`Error checking analysis status for ${docPath}, will analyze`, {
          error: error.message
        });
        pathsToAnalyze.push(docPath);
      }
    }
    
    return pathsToAnalyze;
  }

  /**
   * EXECUTIVE RING FIX: Filter document paths by keywords from mission
   * 
   * Critical fix: Don't filter out ALL documents due to keyword mismatch.
   * This was Ghost #3 - agent would find files but reject them all as "irrelevant",
   * causing "0 documents analyzed" even when files existed.
   * 
   * Now: If keyword filter eliminates everything, proceed WITHOUT filter and let
   * executive ring catch semantic mismatches at higher level.
   */
  filterPathsByKeywords(paths, keywords = []) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return [];
    }

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return paths;
    }

    const filtered = paths.filter(p => this.isDocumentRelevant(p, keywords));
    
    // CRITICAL FIX: If keyword filtering eliminates EVERYTHING, it's likely a semantic mismatch
    // Example: Mission asks for "caselaw" but actual files are code/schemas
    if (filtered.length === 0 && paths.length > 0) {
      this.logger.warn('⚠️ Keyword filter eliminated all documents - possible semantic mismatch', {
        totalFound: paths.length,
        keywords: keywords.slice(0, 5),
        samplePaths: paths.slice(0, 5).map(p => path.basename(p)),
        reason: 'Mission keywords may not match actual document content'
      });
      
      this.logger.info('📂 Proceeding WITHOUT keyword filter to analyze available documents', {
        willAnalyze: paths.length
      });
      this.logger.info('💡 Tip: If these documents are irrelevant, configure correct paths in launch script');
      
      // Return unfiltered paths so agent can analyze what EXISTS
      // Executive ring will catch if this creates semantic incoherence
      return paths;
    }
    
    if (filtered.length < paths.length) {
      this.logger.info('🔍 Keyword filter applied', {
        before: paths.length,
        after: filtered.length,
        filtered: paths.length - filtered.length
      }, 3);
    }
    
    return filtered;
  }

  /**
   * Limit document count based on batch size
   * NEW: Uses configurable batchSize (default 100), 0 = unlimited
   * Backward compatible: if batchSize not set, uses legacy depth-based limits
   */
  limitDocumentCount(paths, spec = {}) {
    if (!Array.isArray(paths)) {
      return [];
    }

    // NEW: Check if batch size is configured (0 = unlimited)
    if (this.batchSize !== undefined && this.batchSize !== null) {
      if (this.batchSize === 0) {
        // Unlimited mode - process all documents
        this.logger.info('📊 Batch size: UNLIMITED (will process all documents)');
        return paths;
      }
      
      // Use configured batch size
      this.logger.info('📊 Batch size configured', { 
        batchSize: this.batchSize,
        totalAvailable: paths.length,
        willProcess: Math.min(this.batchSize, paths.length)
      });
      return paths.slice(0, this.batchSize);
    }

    // LEGACY: Backward compatible depth-based limits (for missions without batchSize)
    const depth = spec.depth || 'standard';
    const maxDocuments = depth === 'comprehensive'
      ? 60
      : depth === 'overview'
        ? 15
        : 30;

    this.logger.debug('📊 Using legacy depth-based limit', { depth, maxDocuments });
    return paths.slice(0, maxDocuments);
  }

  /**
   * Analyze GitHub repository using github MCP
   * Called when mission mentions a github.com URL
   */
  async analyzeGitHubRepository(owner, repo, spec) {
    this.logger.info('🌐 Starting GitHub repository analysis', { owner, repo });
    
    // Check if github MCP is available
    if (!await this.gpt5.hasMCPServer('github')) {
      this.logger.error('❌ GitHub MCP not available - cannot analyze external repository');
      this.logger.error('💡 Enable GitHub MCP during launch to analyze external repositories');
      return [];
    }
    
    try {
      // Get repository information
      this.logger.info('📡 Fetching repository structure from GitHub...');
      
      // Read key files to understand repository
      const keyFiles = ['README.md', 'setup.py', 'requirements.txt', 'pyproject.toml'];
      const documents = [];
      
      for (const filePath of keyFiles) {
        try {
          const content = await this.gpt5.callMCPTool('github', 'get_file_contents', {
            owner,
            repo,
            path: filePath
          });
          
          this.logger.info('✅ Read from GitHub', { file: filePath, size: content.content?.length || 0 });
          
          // Create document object compatible with existing analysis flow
          documents.push({
            id: `github:${owner}/${repo}/${filePath}`,
            filename: filePath,
            path: filePath,
            source: 'github',
            githubRepo: `${owner}/${repo}`,
            content: content.content || content,
            metadata: {
              wordCount: (content.content || content).split(/\s+/).length,
              size: (content.content || content).length,
              encoding: content.encoding || 'utf-8'
            }
          });
        } catch (error) {
          this.logger.debug(`File ${filePath} not found in repository (skipping)`, {
            error: error.message
          });
        }
      }
      
      this.logger.info('✅ GitHub repository analysis complete', {
        owner,
        repo,
        filesAnalyzed: documents.length
      });
      
      return documents;
    } catch (error) {
      this.logger.error('Failed to analyze GitHub repository', {
        owner,
        repo,
        error: error.message
      });
      return [];
    }
  }

  /**
   * @deprecated This function is not currently used in the codebase.
   * Document discovery now uses discoverDocumentsViaMCPInSpecificPath() with
   * configured allowedPaths from launch script. See getDocumentPaths() (lines 314-404).
   * 
   * NOTE: The hardcoded directory list below (['documents', etc.]) should not
   * be used as it makes assumptions about filesystem structure. Use configured paths instead.
   * 
   * TODO: Consider removing in future cleanup if confirmed unused.
   */
  async discoverDocumentsViaMCP(spec) {
    const documents = [];

    if (!this.gpt5?.callMCPTool) {
      this.logger.warn('MCP tools not available - ensure MCP server is running via launch script');
      return documents;
    }

    try {
      // DEPRECATED: Hardcoded directory list - use configured allowedPaths instead
      const directories = ['.', 'documents', 'runtime/outputs/document-creation', 'research'];

      for (const dir of directories) {
        try {
          this.logger.debug(`Attempting to list directory via MCP: ${dir}`);
          const result = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
            path: dir
          });

          if (result?.content?.[0]) {
            const data = JSON.parse(result.content[0].text);
            this.logger.debug(`MCP directory listing for ${dir}:`, { itemCount: data.items?.length || 0 });

            if (data.items && Array.isArray(data.items)) {
              for (const item of data.items) {
                if (item.type === 'file' && this.isDocumentFile(item.name)) {
                  documents.push(path.join(dir, item.name));
                  this.logger.debug(`Found document file: ${path.join(dir, item.name)}`);
                } else if (item.type === 'directory') {
                  // Recursively check subdirectories
                  try {
                    const subResult = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
                      path: path.join(dir, item.name)
                    });

                    if (subResult?.content?.[0]) {
                      const subData = JSON.parse(subResult.content[0].text);
                      if (subData.items && Array.isArray(subData.items)) {
                        for (const subItem of subData.items) {
                          if (subItem.type === 'file' && this.isDocumentFile(subItem.name)) {
                            documents.push(path.join(dir, item.name, subItem.name));
                            this.logger.debug(`Found document in subdirectory: ${path.join(dir, item.name, subItem.name)}`);
                          }
                        }
                      }
                    }
                  } catch (subError) {
                    this.logger.debug(`Failed to access subdirectory via MCP: ${path.join(dir, item.name)}`, { error: subError.message });
                  }
                }
              }
            }
          } else {
            this.logger.debug(`No content returned for directory: ${dir}`);
          }
        } catch (error) {
          this.logger.debug(`Failed to access directory via MCP: ${dir}`, { error: error.message });
        }
      }
    } catch (error) {
      this.logger.warn('MCP document discovery failed', { error: error.message });
      this.logger.info('💡 Tip: Ensure MCP filesystem server is running via launch script');
      this.logger.info('💡 Launch script: ./scripts/LAUNCH_COSMO.sh');
    }

    this.logger.info('📋 Found documents via MCP', { count: documents.length });
    return documents;
  }

  /**
   * Discover documents in a specific path using MCP (for targeted directory access)
   * Now with true recursive traversal of nested directories
   */
  async discoverDocumentsViaMCPInSpecificPath(targetPath, spec = {}, depth = 0, maxDepth = 50) {
    const documents = [];

    if (!this.gpt5?.callMCPTool) {
      return documents;
    }

    // Prevent infinite recursion
    if (depth >= maxDepth) {
      this.logger.debug(`Max recursion depth reached at ${targetPath}`);
      return documents;
    }

    try {
      this.logger.debug(`Attempting MCP access to specific path: ${targetPath} (depth ${depth})`);
      const result = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
        path: targetPath
      });

      if (result?.content?.[0]) {
        const data = JSON.parse(result.content[0].text);

        if (data.items && Array.isArray(data.items)) {
          for (const item of data.items) {
            if (item.type === 'file' && this.isDocumentFile(item.name)) {
              const candidatePath = path.join(targetPath, item.name);
              if (this.isDocumentRelevant(candidatePath, spec.keywords)) {
                documents.push(candidatePath);
              }
            } else if (item.type === 'directory') {
              // CRITICAL: Skip system/audit directories
              if (this.shouldSkipDirectory(item.name, path.join(targetPath, item.name))) {
                this.logger.debug(`Skipping system directory: ${item.name}`);
                continue;
              }
              
              // TRUE RECURSION: Call this function recursively for subdirectories
              const subDocs = await this.discoverDocumentsViaMCPInSpecificPath(
                path.join(targetPath, item.name),
                spec,
                depth + 1,
                maxDepth
              );
              documents.push(...subDocs);
            }
          }
        }
      }
    } catch (error) {
      this.logger.debug(`MCP access failed for specific path: ${targetPath}`, { error: error.message });
    }

    if (depth === 0) {
      // Only log summary at top level to avoid spam
    this.logger.info('📋 Found documents in specific path via MCP', {
      path: targetPath,
      count: documents.length
    });
    }
    
    return documents;
  }

  /**
   * Check if directory should be skipped during document discovery
   * CRITICAL: Excludes system/audit directories that would confuse analysis
   */
  shouldSkipDirectory(dirName, fullPath) {
    // System directories to always exclude
    const systemDirs = [
      'node_modules',
      '.git',
      '.cursor',
      'coverage',
      'dist',
      'build'
    ];
    
    // CRITICAL: Audit/governance directories (provenance, events, inventory)
    // These contain system tracking data that pollutes document analysis
    const auditDirs = [
      'governance',      // Contains provenance/events/inventory
      'provenance',      // Agent execution audit logs
      'events',          // System event logs
      'inventory',       // File inventory tracking
      'checkpoints',     // System state checkpoints
      'logs',            // System logs
      'metrics',         // Performance metrics
      'evaluation'       // Evaluation results
    ];
    
    // Check directory name
    if (systemDirs.includes(dirName) || auditDirs.includes(dirName)) {
      return true;
    }
    
    // Check full path for audit patterns (e.g., runtime/outputs/governance)
    const lowerPath = fullPath.toLowerCase();
    if (lowerPath.includes('/governance/') || 
        lowerPath.includes('/provenance/') ||
        lowerPath.includes('/events/') ||
        lowerPath.includes('/.git/')) {
      return true;
    }
    
    return false;
  }

  /**
   * REMOVED: discoverFallbackDocuments() and discoverDocumentsInPath()
   * These methods used direct filesystem scanning (fs.readdir) which bypassed MCP security.
   * They would find files outside allowed paths, then fail when trying to read via MCP.
   * DocumentAnalysisAgent now respects MCP allowed paths exclusively.
   */

  /**
   * Find file by name across allowed paths
   * Lightweight search without building full catalog
   */
  async findFileByName(filename) {
    const mcpServers = this.config?.mcp?.client?.servers;
    const filesystemServer = mcpServers?.find(s => s.label === 'filesystem');
    const allowedPaths = filesystemServer?.allowedPaths || [];

    // Search all allowed paths (respects user configuration)
    for (const dir of allowedPaths) {
      try {
        const found = await this.searchFileInDirectory(dir, filename, 0, 10);
        if (found) return found;
      } catch (error) {
        // Continue searching
      }
    }

    return null;
  }

  /**
   * Recursively search for file in directory
   */
  async searchFileInDirectory(dirPath, targetFilename, depth = 0, maxDepth = 10) {
    if (depth >= maxDepth) return null;
    if (!this.gpt5?.callMCPTool) return null;

    try {
      const result = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
        path: dirPath
      });

      if (!result?.content?.[0]) return null;
      const data = JSON.parse(result.content[0].text);
      if (!data.items) return null;

      for (const item of data.items) {
        if (item.type === 'file' && item.name === targetFilename) {
          return path.join(dirPath, item.name);
        } else if (item.type === 'directory') {
          const found = await this.searchFileInDirectory(
            path.join(dirPath, item.name),
            targetFilename,
            depth + 1,
            maxDepth
          );
          if (found) return found;
        }
      }
    } catch (error) {
      // Continue searching
    }

    return null;
  }

  /**
   * Check if file is a TEXT document (readable as UTF-8)
   * IMPORTANT: Binary formats (.pdf, .docx, .xlsx) are handled by SpecializedBinaryAgent
   * This agent only processes plain text files
   */
  isDocumentFile(filename) {
    const textDocumentExtensions = [
      // Text Documents
      '.txt', '.md', '.markdown', '.html', '.htm', '.rtf',
      
      // Data & Config (all text-based)
      '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.csv',
      
      // Source Code (all text)
      '.js', '.mjs', '.cjs',        // JavaScript
      '.ts', '.tsx', '.jsx',         // TypeScript/JSX
      '.py', '.pyi',                 // Python
      '.go',                         // Go
      '.rs',                         // Rust
      '.java',                       // Java
      '.c', '.cpp', '.cc', '.h', '.hpp',  // C/C++
      '.rb',                         // Ruby
      '.php',                        // PHP
      '.sh', '.bash', '.zsh',        // Shell scripts
      '.sql',                        // SQL
      '.r',                          // R
      '.m',                          // MATLAB/Objective-C
      
      // Additional Config/Text
      '.conf', '.config', '.env', '.gitignore', '.log',
      '.dockerfile', '.makefile',
      
      // NOTE: Binary formats explicitly EXCLUDED:
      // .pdf, .doc, .docx, .xlsx, .xls, .ppt, .pptx, .odt, .ods
      // These are handled by SpecializedBinaryAgent which has proper extraction libraries
    ];

    const ext = path.extname(filename).toLowerCase();
    return textDocumentExtensions.includes(ext) || !ext; // Include files without extensions
  }

  isDocumentLikelyRelevant(docPath, spec = {}) {
    const keywords = Array.isArray(spec.keywords) ? spec.keywords : [];
    if (keywords.length === 0) {
      return true;
    }
    return this.isDocumentRelevant(docPath, keywords);
  }

  isDocumentRelevant(docPath, keywords = []) {
    if (!docPath || !Array.isArray(keywords) || keywords.length === 0) {
      return true;
    }

    const lowerPath = docPath.toLowerCase();
    return keywords.some(keyword => {
      const normalized = keyword.toLowerCase();
      if (!normalized) return false;
      if (lowerPath.includes(normalized)) return true;
      const underscored = normalized.replace(/\s+/g, '_');
      if (underscored !== normalized && lowerPath.includes(underscored)) return true;
      return false;
    });
  }

  /**
   * Read document content with full provenance tracking
   * Logs file access via FrontierGate and updates injection manifest
   */
  async readDocumentContent(docPath) {
    let content = null;
    let stat = null;
    let accessMethod = null;

    try {
      if (this.gpt5?.callMCPTool) {
        this.logger.debug(`Attempting to read document via MCP: ${docPath}`);
        const result = await this.gpt5.callMCPTool('filesystem', 'read_file', { path: docPath });

        if (result?.content?.[0]) {
          const data = JSON.parse(result.content[0].text);
          content = data.content;
          stat = {
            size: data.size || content.length,
            mtime: new Date(data.modified || Date.now()),
            birthtime: new Date(data.created || Date.now()),
            atime: new Date(data.accessed || Date.now())
          };
          accessMethod = 'mcp';
        } else {
          this.logger.debug(`No content returned from MCP for: ${docPath}`);
        }
      }

      if (!content) {
        this.logger.debug(`Attempting direct file access for: ${docPath}`);
        content = await fs.readFile(docPath, 'utf8');
        stat = await fs.stat(docPath);
        accessMethod = 'direct';
      }
      
      // PROVENANCE TRACKING: Log file access via FrontierGate (if available)
      if (this.frontierGate) {
        await this.frontierGate.logEvent({
          type: 'document_read',
          path: docPath,
          agentId: this.agentId,
          size: stat.size,
          accessMethod,
          timestamp: new Date().toISOString()
        });
      }
      
      // PROVENANCE TRACKING: Update injection manifest (if this is an injected document)
      if (docPath.includes('/injected/')) {
        await this.updateInjectionManifestReadStatus(docPath).catch(err => {
          // Non-fatal - log but continue
          this.logger.debug('Could not update injection manifest', { error: err.message });
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to read document', {
        path: docPath,
        error: error.message,
        hasMCP: !!this.gpt5?.callMCPTool
      });

      if (error.message.includes('ENOENT') && !this.gpt5?.callMCPTool) {
        this.logger.error('💡 Document not found and MCP not available. Ensure:');
        this.logger.error('   1. MCP filesystem server is running (via launch script)');
        this.logger.error('   2. File access is configured in launch script');
        this.logger.error('   3. Document exists in an accessible directory');
      }

      throw error;
    }

    return { content, stat, accessMethod };
  }
  
  /**
   * Update injection manifest when a document is read
   * Tracks which agent read which document and when
   */
  async updateInjectionManifestReadStatus(docPath) {
    try {
      // Extract injection directory (e.g., runtime/outputs/injected/1765827287029/)
      const match = docPath.match(/(.*\/injected\/\d+)\//);
      if (!match) return;
      
      const injectionDir = match[1];
      const manifestPath = `${injectionDir}/.injection-manifest.json`;
      
      // Read existing manifest
      let manifest;
      if (this.gpt5?.callMCPTool) {
        const result = await this.gpt5.callMCPTool('filesystem', 'read_file', { path: manifestPath });
        if (result?.content?.[0]) {
          const data = JSON.parse(result.content[0].text);
          manifest = JSON.parse(data.content);
        }
      } else {
        const content = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(content);
      }
      
      if (!manifest) return;
      
      // Find the file record
      const fileRecord = manifest.files.find(f => f.path === docPath);
      if (!fileRecord) return;
      
      // Update read tracking
      const readEntry = {
        agentId: this.agentId,
        agentType: 'document_analysis',
        readAt: new Date().toISOString()
      };
      
      if (!fileRecord.readByAgents) {
        fileRecord.readByAgents = [];
      }
      
      // Add if not already tracked
      if (!fileRecord.readByAgents.some(r => r.agentId === this.agentId)) {
        fileRecord.readByAgents.push(readEntry);
        this.logger.debug(`📊 Updated injection manifest: ${path.basename(docPath)} read by ${this.agentId}`);
      }
      
      // Write updated manifest
      if (this.gpt5?.callMCPTool) {
        await this.gpt5.callMCPTool('filesystem', 'write_file', {
          path: manifestPath,
          content: JSON.stringify(manifest, null, 2)
        });
      } else {
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      }
      
    } catch (error) {
      // Non-fatal - this is audit tracking, don't fail document read
      this.logger.debug('Could not update injection manifest read status', { 
        path: docPath, 
        error: error.message 
      });
    }
  }

  documentContentMatchesKeywords(content, keywords = []) {
    if (!content || !Array.isArray(keywords) || keywords.length === 0) {
      return true;
    }

    const lowerContent = content.toLowerCase();
    return keywords.some(keyword => lowerContent.includes(keyword.toLowerCase()));
  }

  /**
   * Analyze a single document
   */
  async analyzeSingleDocument(docPath, spec, preloaded = null) {
    let content, stat, accessMethod;

    if (preloaded && preloaded.content) {
      ({ content, stat, accessMethod } = preloaded);
    } else {
      const loaded = await this.readDocumentContent(docPath);
      content = loaded.content;
      stat = loaded.stat;
      accessMethod = loaded.accessMethod;
    }

    // Extract metadata
    const metadata = await this.extractDocumentMetadata(docPath, stat, content);

    // Generate document fingerprint for comparison
    const fingerprint = this.generateDocumentFingerprint(content, metadata);

    // Analyze content based on scope
    const contentAnalysis = await this.analyzeDocumentContent(content, spec);

    const document = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      path: docPath,
      filename: path.basename(docPath),
      content,
      metadata,
      fingerprint,
      contentAnalysis,
      analyzedAt: new Date(),
      size: stat.size,
      modified: stat.mtime,
      accessMethod: accessMethod || (this.gpt5?.callMCPTool ? 'mcp' : 'direct')
    };

    return document;
  }

  /**
   * Extract comprehensive metadata from document
   */
  async extractDocumentMetadata(docPath, stat, content) {
    const metadata = {
      filename: path.basename(docPath),
      extension: path.extname(docPath),
      size: stat.size,
      created: stat.birthtime,
      modified: stat.mtime,
      accessed: stat.atime,

      // Content-based metadata
      wordCount: this.countWords(content),
      characterCount: content.length,
      lineCount: content.split('\n').length,

      // File type detection
      mimeType: this.detectMimeType(docPath),
      encoding: 'utf8',

      // Content analysis
      hasTitle: this.hasTitle(content),
      hasHeaders: this.hasHeaders(content),
      hasLinks: this.hasLinks(content),
      hasImages: this.hasImages(content),
      hasCode: this.hasCode(content),
      hasTables: this.hasTables(content),

      // Version indicators
      versionIndicators: this.extractVersionIndicators(content),
      revisionMarkers: this.extractRevisionMarkers(content)
    };

    return metadata;
  }

  /**
   * Generate document fingerprint for comparison
   */
  generateDocumentFingerprint(content, metadata) {
    // Create a hash based on key characteristics
    const keyElements = [
      metadata.wordCount,
      metadata.lineCount,
      content.substring(0, 1000), // First 1000 chars
      content.substring(content.length - 1000) // Last 1000 chars
    ].join('|');

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < keyElements.length; i++) {
      const char = keyElements.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return {
      hash: hash.toString(16),
      characteristics: {
        length: metadata.wordCount,
        structure: this.analyzeStructure(content),
        keywords: this.extractKeywords(content, 10)
      }
    };
  }

  /**
   * Analyze document content based on scope
   */
  async analyzeDocumentContent(content, spec) {
    const analysis = {
      summary: '',
      keyTopics: [],
      structure: [],
      entities: [],
      relationships: []
    };

    // Generate content summary
    analysis.summary = await this.generateContentSummary(content);

    // Extract key topics
    analysis.keyTopics = this.extractKeyTopics(content);

    // Analyze structure
    analysis.structure = this.analyzeDocumentStructure(content);

    // Extract entities (people, places, organizations)
    analysis.entities = this.extractEntities(content);

    return analysis;
  }

  /**
   * Compare documents and analyze evolution
   */
  async analyzeDocumentEvolution(documents, spec) {
    const results = {
      relationships: [],
      versionChains: [],
      evolutionStory: '',
      majorDifferences: [],
      metadataComparison: {},
      insights: []
    };

    // Group documents by similarity/type
    const documentGroups = this.groupSimilarDocuments(documents);

    // Find version chains
    results.versionChains = this.identifyVersionChains(documents);

    // Analyze relationships between documents
    results.relationships = this.analyzeDocumentRelationships(documents);

    // Compare metadata across documents  
    results.metadataComparison = this.compareAllDocumentMetadata(documents);

    // Identify major differences
    results.majorDifferences = this.identifyMajorDifferences(documents);

    // Generate evolution story
    results.evolutionStory = await this.generateEvolutionStory(documents, results);

    // Generate insights
    results.insights = await this.generateDocumentInsights(documents, results);

    return results;
  }

  /**
   * Group similar documents together
   */
  groupSimilarDocuments(documents) {
    const groups = new Map();

    for (const doc of documents) {
      let groupKey = 'other';

      // Group by filename patterns (version indicators)
      if (doc.metadata.versionIndicators.length > 0) {
        groupKey = 'versioned';
      } else if (doc.filename.includes('draft') || doc.filename.includes('revision')) {
        groupKey = 'drafts';
      } else if (doc.filename.includes('final') || doc.filename.includes('complete')) {
        groupKey = 'final';
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(doc);
    }

    return groups;
  }

  /**
   * Identify version chains based on filename patterns and content similarity
   */
  identifyVersionChains(documents) {
    const chains = [];

    // Group by base filename (remove version indicators)
    const baseNameGroups = new Map();

    for (const doc of documents) {
      const baseName = this.extractBaseName(doc.filename);
      if (!baseNameGroups.has(baseName)) {
        baseNameGroups.set(baseName, []);
      }
      baseNameGroups.get(baseName).push(doc);
    }

    // For each group with multiple documents, analyze as version chain
    for (const [baseName, docs] of baseNameGroups.entries()) {
      if (docs.length > 1) {
        chains.push({
          baseName,
          documents: docs.sort((a, b) => a.metadata.modified - b.metadata.modified),
          evolution: this.analyzeVersionEvolution(docs)
        });
      }
    }

    return chains;
  }

  /**
   * Extract base name by removing version indicators
   */
  extractBaseName(filename) {
    // Remove common version patterns
    return filename
      .replace(/v?\d+\.\d+(\.\d+)?/g, '') // Version numbers
      .replace(/draft\d*/gi, '') // Draft indicators
      .replace(/revision\d*/gi, '') // Revision indicators
      .replace(/final/gi, '') // Final indicators
      .replace(/copy\d*/gi, '') // Copy indicators
      .replace(/_\d+/g, '') // Number suffixes
      .replace(/\s+/g, '') // Whitespace
      .toLowerCase();
  }

  /**
   * Analyze how a document has evolved through versions
   */
  analyzeVersionEvolution(documents) {
    if (documents.length < 2) {
      return { type: 'single', changes: [] };
    }

    const sorted = documents.sort((a, b) => a.metadata.modified - b.metadata.modified);
    const evolution = {
      type: 'version_chain',
      startDate: sorted[0].metadata.modified,
      endDate: sorted[sorted.length - 1].metadata.modified,
      changes: []
    };

    // Compare consecutive versions
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      const changes = this.compareDocumentVersions(prev, curr);
      evolution.changes.push({
        fromVersion: prev.filename,
        toVersion: curr.filename,
        timeSpan: curr.metadata.modified - prev.metadata.modified,
        changes: changes
      });
    }

    return evolution;
  }

  /**
   * Compare two document versions
   */
  compareDocumentVersions(doc1, doc2) {
    const changes = [];

    // Compare word count
    const wordDiff = doc2.metadata.wordCount - doc1.metadata.wordCount;
    if (Math.abs(wordDiff) > 50) {
      changes.push({
        type: 'content_length',
        change: wordDiff > 0 ? 'increased' : 'decreased',
        magnitude: Math.abs(wordDiff),
        description: `Word count changed by ${Math.abs(wordDiff)} words`
      });
    }

    // Compare structure
    const structChanges = this.compareDocumentStructure(doc1.contentAnalysis.structure, doc2.contentAnalysis.structure);
    changes.push(...structChanges);

    // Compare metadata
    const metaChanges = this.compareDocumentMetadata([doc1, doc2]);
    changes.push(...metaChanges);

    return changes;
  }

  /**
   * Compare metadata between two documents
   */
  compareDocumentMetadata(documents) {
    const changes = [];
    
    // Defensive check - ensure we have two documents with metadata
    if (!Array.isArray(documents) || documents.length < 2) {
      return changes;
    }
    
    const doc1 = documents[0];
    const doc2 = documents[1];
    
    if (!doc1?.metadata || !doc2?.metadata) {
      return changes;
    }

    // Note: Word count comparison is already done in compareDocumentVersions
    // to avoid duplication, we focus on other metadata changes here

    // Compare line count
    const lineDiff = doc2.metadata.lineCount - doc1.metadata.lineCount;
    if (Math.abs(lineDiff) > 10) {
      changes.push({
        type: 'metadata',
        change: 'line_count',
        from: doc1.metadata.lineCount,
        to: doc2.metadata.lineCount,
        description: `Line count changed from ${doc1.metadata.lineCount} to ${doc2.metadata.lineCount} (${lineDiff > 0 ? '+' : ''}${lineDiff})`
      });
    }

    // Compare content features (presence/absence of elements)
    const features = ['hasTitle', 'hasHeaders', 'hasLinks', 'hasImages', 'hasCode', 'hasTables'];
    for (const feature of features) {
      if (doc1.metadata[feature] !== doc2.metadata[feature]) {
        const featureName = feature.replace(/^has/, '').toLowerCase();
        changes.push({
          type: 'metadata',
          change: feature,
          from: doc1.metadata[feature],
          to: doc2.metadata[feature],
          description: `Document ${doc2.metadata[feature] ? 'gained' : 'lost'} ${featureName}`
        });
      }
    }

    // Compare version indicators
    const v1Count = doc1.metadata.versionIndicators?.length || 0;
    const v2Count = doc2.metadata.versionIndicators?.length || 0;
    if (v1Count !== v2Count) {
      changes.push({
        type: 'metadata',
        change: 'version_indicators',
        from: v1Count,
        to: v2Count,
        description: `Version indicators changed from ${v1Count} to ${v2Count}`
      });
    }

    return changes;
  }

  /**
   * Compare document structures
   */
  compareDocumentStructure(struct1, struct2) {
    const changes = [];

    // Compare section counts
    if (struct1.sections !== struct2.sections) {
      changes.push({
        type: 'structure',
        change: 'sections',
        from: struct1.sections,
        to: struct2.sections,
        description: `Number of sections changed from ${struct1.sections} to ${struct2.sections}`
      });
    }

    return changes;
  }

  /**
   * Generate comprehensive analysis report
   */
  async generateAnalysisReport(analysisResults, spec) {
    const report = {
      title: 'Document Collection Analysis Report',
      generatedAt: new Date(),
      scope: spec.scope,
      depth: spec.depth,

      // Summary
      summary: await this.generateAnalysisSummary(analysisResults),

      // Document inventory
      documentInventory: this.generateDocumentInventory(analysisResults),

      // Version analysis
      versionAnalysis: this.generateVersionAnalysis(analysisResults),

      // Relationship analysis
      relationshipAnalysis: this.generateRelationshipAnalysis(analysisResults),

      // Evolution story
      evolutionStory: analysisResults.evolutionStory,

      // Insights and recommendations
      insights: analysisResults.insights,

      // Metadata comparison
      metadataComparison: analysisResults.metadataComparison
    };

    return report;
  }

  /**
   * Generate analysis summary
   */
  async generateAnalysisSummary(results) {
    let summary = `Analyzed ${this.analyzedDocuments.size} documents with ${results.versionChains.length} version chains identified. `;

    if (results.relationships.length > 0) {
      summary += `Found ${results.relationships.length} document relationships. `;
    }

    summary += `Generated ${results.insights.length} key insights about the document collection.`;

    return summary;
  }

  /**
   * Generate document inventory
   */
  generateDocumentInventory(results) {
    return Array.from(this.analyzedDocuments.values()).map(doc => ({
      filename: doc.filename,
      size: doc.size,
      wordCount: doc.metadata.wordCount,
      modified: doc.metadata.modified,
      type: doc.metadata.mimeType,
      versionIndicators: doc.metadata.versionIndicators,
      keyTopics: doc.contentAnalysis.keyTopics.slice(0, 5)
    }));
  }

  /**
   * Generate version analysis
   */
  generateVersionAnalysis(results) {
    return results.versionChains.map(chain => ({
      baseName: chain.baseName,
      documentCount: chain.documents.length,
      timeSpan: chain.evolution.endDate - chain.evolution.startDate,
      majorChanges: chain.evolution.changes.filter(c => c.changes.length > 3),
      evolutionType: chain.evolution.type
    }));
  }

  /**
   * Generate relationship analysis
   */
  generateRelationshipAnalysis(results) {
    return results.relationships.map(rel => ({
      type: rel.type,
      strength: rel.strength,
      documents: rel.documents,
      description: rel.description
    }));
  }

  /**
   * Store analysis results in memory network
   */
  async storeAnalysisInMemory(report, results, spec) {
    // Store overall analysis report
    await this.addFinding(
      `Document Collection Analysis: ${report.title}\n\n${report.summary}`,
      'document_collection_analysis'
    );

    // Store individual document analyses
    for (const [docId, doc] of this.analyzedDocuments.entries()) {
      await this.addFinding(
        `Document Analysis: ${doc.filename}\n\n` +
        `Size: ${doc.metadata.wordCount} words\n` +
        `Modified: ${doc.metadata.modified}\n` +
        `Key Topics: ${doc.contentAnalysis.keyTopics.join(', ')}\n` +
        `Structure: ${doc.contentAnalysis.structure.sections} sections`,
        'document_analysis'
      );
    }

    // Store version chains
    for (const chain of results.versionChains) {
      await this.addFinding(
        `Version Chain: ${chain.baseName}\n\n` +
        `Documents: ${chain.documents.map(d => d.filename).join(', ')}\n` +
        `Evolution: ${chain.evolution.changes.length} changes over time`,
        'document_version_chain'
      );
    }

    // Store insights
    for (const insight of results.insights) {
      await this.addInsight(insight, 'document_analysis_insight');
    }

    this.logger.info('🧠 Document analysis stored in memory network', {
      documentsAnalyzed: this.analyzedDocuments.size,
      versionChains: results.versionChains.length,
      insights: results.insights.length
    });
  }
  
  /**
   * INGESTION MODE: Extract and store document content for knowledge base
   * Used when injecting documents for the first time
   * Focus: Extract key concepts, facts, and substantive content (not metadata/comparison)
   */
  async ingestDocumentsIntoMemory(documentCollection, spec) {
    const results = {
      documentsIngested: documentCollection.length,
      conceptsExtracted: 0,
      contentChunksStored: 0,
      insights: []
    };
    
    this.logger.info('📥 Starting content ingestion for knowledge base', {
      documents: documentCollection.length
    });
    
    // Process each document for content extraction
    for (const doc of documentCollection) {
      try {
        // Extract key concepts and content from this document
        const extraction = await this.extractDocumentContent(doc);
        
        // Store content chunks in memory (with compression if needed)
        for (const chunk of extraction.contentChunks) {
          await this.addFinding(
            `${doc.filename}: ${chunk.content}`,
            chunk.tag || 'injected_document_content'
          );
          results.contentChunksStored++;
        }
        
        // Store key concepts separately (shorter, more queryable)
        for (const concept of extraction.keyConcepts) {
          await this.addFinding(
            `Concept from ${doc.filename}: ${concept}`,
            'document_concept'
          );
          results.conceptsExtracted++;
        }
        
        this.logger.info(`✅ Ingested: ${doc.filename}`, {
          contentChunks: extraction.contentChunks.length,
          keyConcepts: extraction.keyConcepts.length
        });
        
      } catch (error) {
        this.logger.error(`Failed to ingest ${doc.filename}`, {
          error: error.message
        });
      }
    }
    
    // Generate overall insights about the document collection
    if (documentCollection.length > 1) {
      const collectionInsight = await this.generateCollectionInsights(documentCollection);
      results.insights.push(...collectionInsight);
      
      for (const insight of collectionInsight) {
        await this.addInsight(insight, 'document_ingestion_insight');
      }
    }
    
    this.logger.info('🧠 Document ingestion complete', {
      documents: results.documentsIngested,
      concepts: results.conceptsExtracted,
      chunks: results.contentChunksStored,
      insights: results.insights.length
    });
    
    return results;
  }
  
  /**
   * Extract key content and concepts from a single document
   * Returns content chunks and key concepts for memory storage
   */
  async extractDocumentContent(doc) {
    const content = doc.content;
    const maxChunkSize = 3000; // ~750 tokens per chunk (safe for embedding)
    
    // Use GPT-5.2 to extract key concepts and important sections
    const prompt = `Extract key concepts and important content from this document.

DOCUMENT: ${doc.filename}
${content.substring(0, 15000)} ${content.length > 15000 ? '...(truncated for analysis)' : ''}

Identify:
1. Key concepts, facts, and data points (bullet list)
2. Important sections worth preserving for future synthesis (quote directly, max 3 sections)

Return JSON:
{
  "keyConcepts": ["concept 1", "concept 2", ...],
  "importantSections": [
    {"title": "section name", "content": "quoted content (max 500 chars)"},
    ...
  ]
}`;

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: 'You extract key concepts and important content from documents. Be selective and substantive.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 4000
      });
      
      const extraction = JSON.parse(response.content);
      
      // Build content chunks from important sections
      const contentChunks = extraction.importantSections.map(section => ({
        content: `${section.title}: ${section.content}`,
        tag: 'injected_document_content'
      }));
      
      return {
        keyConcepts: extraction.keyConcepts || [],
        contentChunks: contentChunks || []
      };
      
    } catch (error) {
      this.logger.warn(`Failed to extract content from ${doc.filename}, using fallback`, {
        error: error.message
      });
      
      // Fallback: Simple chunking without GPT
      const chunks = [];
      for (let i = 0; i < content.length; i += maxChunkSize) {
        chunks.push({
          content: content.substring(i, i + maxChunkSize),
          tag: 'injected_document_content'
        });
      }
      
      return {
        keyConcepts: doc.contentAnalysis?.keyTopics || [],
        contentChunks: chunks.slice(0, 5) // Max 5 chunks per doc
      };
    }
  }
  
  /**
   * Generate insights about the document collection as a whole
   */
  async generateCollectionInsights(documents) {
    const insights = [];
    
    // Create a summary of what was ingested
    const summary = `Ingested ${documents.length} documents into knowledge base: ${documents.map(d => d.filename).join(', ')}. Content extracted and available for synthesis.`;
    insights.push(summary);
    
    return insights;
  }
  
  /**
   * Generate ingestion report (simpler than full analysis report)
   */
  async generateIngestionReport(results, spec) {
    return {
      title: `Document Ingestion Report`,
      summary: `Successfully ingested ${results.documentsIngested} documents into memory. Extracted ${results.conceptsExtracted} key concepts and stored ${results.contentChunksStored} content chunks for future synthesis.`,
      documentsIngested: results.documentsIngested,
      conceptsExtracted: results.conceptsExtracted,
      contentChunksStored: results.contentChunksStored,
      insights: results.insights,
      createdAt: new Date()
    };
  }

  // Helper methods

  countWords(content) {
    return content.trim().split(/\s+/).length;
  }

  detectMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  hasTitle(content) {
    const lines = content.split('\n').slice(0, 10);
    return lines.some(line => line.match(/^#\s+.+$/) || line.match(/^title:\s*.+$/i));
  }

  hasHeaders(content) {
    return content.match(/^#{2,6}\s+.+$/m) !== null;
  }

  hasLinks(content) {
    return content.match(/https?:\/\/[^\s]+/) !== null;
  }

  hasImages(content) {
    return content.match(/!\[.*?\]\(.*?\)/) !== null;
  }

  hasCode(content) {
    return content.match(/```[\s\S]*?```/) !== null;
  }

  hasTables(content) {
    return content.match(/\|.*\|.*\|/) !== null;
  }

  extractVersionIndicators(content) {
    const indicators = [];

    // Look for version patterns in content
    const versionPatterns = [
      /version\s+\d+\.\d+/gi,
      /v\d+\.\d+/gi,
      /revision\s+\d+/gi,
      /draft\s+\d+/gi
    ];

    for (const pattern of versionPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        indicators.push(...matches);
      }
    }

    return [...new Set(indicators)]; // Remove duplicates
  }

  extractRevisionMarkers(content) {
    const markers = [];

    // Look for revision indicators
    const revisionPatterns = [
      /updated?\s+\d{4}-\d{2}-\d{2}/gi,
      /modified?\s+\d{4}-\d{2}-\d{2}/gi,
      /revised?\s+\d{4}-\d{2}-\d{2}/gi,
      /last\s+modified/gi
    ];

    for (const pattern of revisionPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        markers.push(...matches);
      }
    }

    return [...new Set(markers)];
  }

  analyzeStructure(content) {
    const structure = {
      sections: 0,
      subsections: 0,
      paragraphs: content.split('\n\n').length,
      lines: content.split('\n').length
    };

    // Count header sections
    const headers = content.match(/^#{1,6}\s+.+$/gm);
    if (headers) {
      structure.sections = headers.length;
    }

    return structure;
  }

  extractKeywords(content, limit = 10) {
    // Simple keyword extraction - split by common delimiters and count frequency
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3);

    const frequency = {};
    for (const word of words) {
      frequency[word] = (frequency[word] || 0) + 1;
    }

    return Object.entries(frequency)
      .sort(([,a], [,b]) => b - a)
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));
  }

  async generateContentSummary(content) {
    // Generate summary using GPT-5
    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: 'You are an expert document analyst. Provide a concise summary of the document content in 2-3 sentences.'
          },
          {
            role: 'user',
            content: `Summarize this document:\n\n${content.substring(0, 2000)}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1000 // Increased from 200 - context validation needs space
      });

      return response.content;
    } catch (error) {
      return 'Summary generation failed';
    }
  }

  extractKeyTopics(content) {
    const topics = [];

    // Extract potential topics from headers
    const headers = content.match(/^#{2,4}\s+(.+)$/gm);
    if (headers) {
      topics.push(...headers.map(h => h.replace(/^#{2,4}\s+/, '')));
    }

    // Extract from first paragraph
    const firstPara = content.split('\n\n')[0];
    if (firstPara && firstPara.length > 100) {
      topics.push(firstPara.substring(0, 100) + '...');
    }

    return topics.slice(0, 5); // Top 5 topics
  }

  analyzeDocumentStructure(content) {
    return {
      sections: (content.match(/^#{1,6}\s+.+$/gm) || []).length,
      paragraphs: content.split('\n\n').length,
      codeBlocks: (content.match(/```[\s\S]*?```/g) || []).length,
      lists: (content.match(/^[-\*]\s+.+$/gm) || []).length,
      tables: (content.match(/\|.*\|/g) || []).length
    };
  }

  extractEntities(content) {
    const entities = {
      people: [],
      places: [],
      organizations: [],
      dates: []
    };

    // Simple entity extraction patterns
    entities.people = content.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [];
    entities.dates = content.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/g) || [];

    return entities;
  }

  async generateEvolutionStory(documents, results) {
    try {
      const prompt = `Analyze the evolution of these documents and tell their story:

Documents: ${documents.length}
Version Chains: ${results.versionChains.length}
Relationships: ${results.relationships.length}

Key findings:
${results.majorDifferences.slice(0, 5).map(d => `- ${d.description}`).join('\n')}

Generate a narrative about how these documents evolved over time.`;

      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: 'You are a document historian. Tell the story of how these documents evolved, their relationships, and key changes over time.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 4000 // Increased from 1000 - analysis needs comprehensive output
      });

      return response.content;
    } catch (error) {
      return 'Evolution story generation failed';
    }
  }

  async generateDocumentInsights(documents, results) {
    const insights = [];

    // Generate insights based on analysis
    if (results.versionChains.length > 0) {
      insights.push(`Found ${results.versionChains.length} document version chains showing clear evolution patterns`);
    }

    if (results.relationships.length > 0) {
      insights.push(`Identified ${results.relationships.length} relationships between documents`);
    }

    const totalWords = documents.reduce((sum, doc) => sum + doc.metadata.wordCount, 0);
    insights.push(`Total content analyzed: ${totalWords.toLocaleString()} words across ${documents.length} documents`);

    return insights;
  }

  /**
   * Analyze relationships between documents
   */
  analyzeDocumentRelationships(documents) {
    const relationships = [];

    // Compare documents pairwise for relationships
    for (let i = 0; i < documents.length; i++) {
      for (let j = i + 1; j < documents.length; j++) {
        const doc1 = documents[i];
        const doc2 = documents[j];

        // Check for similarity
        const similarity = this.calculateSimilarity(doc1, doc2);

        if (similarity > 0.5) {
          relationships.push({
            type: 'similar_content',
            strength: similarity,
            documents: [doc1.filename, doc2.filename],
            description: `${doc1.filename} and ${doc2.filename} are ${Math.round(similarity * 100)}% similar`
          });
        }
      }
    }

    return relationships;
  }

  /**
   * Calculate similarity between two documents
   */
  calculateSimilarity(doc1, doc2) {
    // Simple similarity based on keyword overlap
    const keywords1 = new Set(doc1.fingerprint.characteristics.keywords.map(k => k.word));
    const keywords2 = new Set(doc2.fingerprint.characteristics.keywords.map(k => k.word));

    const intersection = new Set([...keywords1].filter(x => keywords2.has(x)));
    const union = new Set([...keywords1, ...keywords2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Compare metadata across all documents
   */
  compareAllDocumentMetadata(documents) {
    return {
      totalDocuments: documents.length,
      sizeRange: {
        min: Math.min(...documents.map(d => d.metadata.wordCount)),
        max: Math.max(...documents.map(d => d.metadata.wordCount)),
        avg: documents.reduce((sum, d) => sum + d.metadata.wordCount, 0) / documents.length
      },
      dateRange: {
        earliest: new Date(Math.min(...documents.map(d => d.metadata.modified))),
        latest: new Date(Math.max(...documents.map(d => d.metadata.modified)))
      }
    };
  }

  /**
   * Identify major differences between documents
   */
  identifyMajorDifferences(documents) {
    const differences = [];

    if (documents.length < 2) {
      return differences;
    }

    // Compare first and last document chronologically
    const sorted = documents.sort((a, b) => a.metadata.modified - b.metadata.modified);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const wordDiff = last.metadata.wordCount - first.metadata.wordCount;
    if (Math.abs(wordDiff) > 100) {
      differences.push({
        type: 'content_growth',
        magnitude: wordDiff,
        description: `Document collection ${wordDiff > 0 ? 'grew' : 'shrunk'} by ${Math.abs(wordDiff)} words from earliest to latest version`
      });
    }

    return differences;
  }

  /**
   * Store document contents in memory for handoff to other agents
   * This allows CodeExecutionAgent to receive the data even though it can't access local files
   */
  async storeDocumentContentsForHandoff(documents) {
    // Store complete document contents as structured data
    const totalSize = documents.reduce((sum, doc) => sum + doc.content.length, 0);

    // Create the documentData structure to check actual JSON size
    const documentData = {
      source: 'document_analysis_agent',
      timestamp: new Date().toISOString(),
      documentCount: documents.length,
      documents: documents.map(doc => ({
        filename: doc.filename,
        path: doc.path,
        content: doc.content,
        size: doc.size,
        wordCount: doc.metadata.wordCount,
        modified: doc.metadata.modified,
        metadata: doc.metadata
      }))
    };

    const jsonString = JSON.stringify(documentData);
    const jsonSize = jsonString.length;

    // If JSON is too large (>50KB to account for embedding limits), store metadata only and chunk content separately
    // This prevents embedding API failures with large JSON payloads
    if (jsonSize > 50000) {
      this.logger.info('📦 Large document collection detected, storing with chunking strategy', {
        documentCount: documents.length,
        totalSize,
        jsonSize,
        threshold: 50000
      });
      
      // Store metadata summary (embeddable)
      const metadataSummary = {
        source: 'document_analysis_agent',
        timestamp: new Date().toISOString(),
        documentCount: documents.length,
        totalSize,
        documents: documents.map(doc => ({
          filename: doc.filename,
          path: doc.path,
          size: doc.size,
          wordCount: doc.metadata.wordCount,
          modified: doc.metadata.modified
          // contentPreview and full metadata removed - too large for embeddings
          // Full content available in runtime/agent-data/ files
        }))
      };
      
      // Store metadata summary (small, embeddable)
      await this.addFinding(
        JSON.stringify(metadataSummary),
        'document_metadata_summary'
      );
      
      // Store each document individually (without embedding to avoid size issues)
      for (const doc of documents) {
        const docData = {
          filename: doc.filename,
          path: doc.path,
          content: doc.content,
          metadata: doc.metadata
        };
        
        // Write to file system instead of memory (too large for embeddings)
        const outputDir = path.join(__dirname, '..', '..', 'runtime', 'agent-data');
        await fs.mkdir(outputDir, { recursive: true });
        
        const safeFilename = doc.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const dataPath = path.join(outputDir, `${safeFilename}.json`);
        if (this.capabilities) {
          await this.capabilities.writeFile(
            path.relative(process.cwd(), dataPath),
            JSON.stringify(docData, null, 2),
            { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
          );
        } else {
          await fs.writeFile(dataPath, JSON.stringify(docData, null, 2), 'utf-8');
        }
      }
      
      this.logger.info('📦 Document contents stored in runtime/agent-data/', {
        documentCount: documents.length,
        metadataInMemory: true,
        fullContentInFiles: true
      });
      
      // PROVENANCE TRACKING: Update injection manifest for memory storage
      await this.updateInjectionManifestMemoryStatus(documents, 'metadata_summary');
      
    } else {
      // Small enough to store directly in memory
      // Store as finding so other agents can retrieve via queryMemoryForData()
      await this.addFinding(
        jsonString,
        'document_contents_for_analysis'
      );

      this.logger.info('📦 Document contents stored for handoff to other agents', {
        documentCount: documents.length,
        totalSize,
        jsonSize,
        tag: 'document_contents_for_analysis'
      });

      // PROVENANCE TRACKING: Update injection manifest for memory storage
      await this.updateInjectionManifestMemoryStatus(documents, 'full_content');
    }
  }
  
  /**
   * Update injection manifest when documents are stored in memory
   * Marks documents as inMemory:true and records analysis completion
   */
  async updateInjectionManifestMemoryStatus(documents, storageType) {
    for (const doc of documents) {
      // Only update for injected documents
      if (!doc.path.includes('/injected/')) continue;
      
      try {
        // Extract injection directory
        const match = doc.path.match(/(.*\/injected\/\d+)\//);
        if (!match) continue;
        
        const injectionDir = match[1];
        const manifestPath = `${injectionDir}/.injection-manifest.json`;
        
        // Read existing manifest
        let manifest;
        if (this.gpt5?.callMCPTool) {
          const result = await this.gpt5.callMCPTool('filesystem', 'read_file', { path: manifestPath });
          if (result?.content?.[0]) {
            const data = JSON.parse(result.content[0].text);
            manifest = JSON.parse(data.content);
          }
        } else {
          const content = await fs.readFile(manifestPath, 'utf-8');
          manifest = JSON.parse(content);
        }
        
        if (!manifest) continue;
        
        // Find and update file record
        const fileRecord = manifest.files.find(f => f.path === doc.path);
        if (!fileRecord) continue;
        
        // Update memory tracking
        fileRecord.inMemory = true;
        fileRecord.memoryStoredAt = new Date().toISOString();
        fileRecord.memoryStorageType = storageType;
        fileRecord.analyzed = true;
        fileRecord.analyzedAt = new Date().toISOString();
        
        // Track this analysis agent
        if (!fileRecord.analysisAgents) {
          fileRecord.analysisAgents = [];
        }
        if (!fileRecord.analysisAgents.includes(this.agentId)) {
          fileRecord.analysisAgents.push(this.agentId);
        }
        
        this.logger.debug(`📊 Updated injection manifest: ${path.basename(doc.path)} stored in memory (${storageType})`);
        
        // Write updated manifest (only write once per injection directory)
        if (this.gpt5?.callMCPTool) {
          await this.gpt5.callMCPTool('filesystem', 'write_file', {
            path: manifestPath,
            content: JSON.stringify(manifest, null, 2)
          });
        } else {
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        }
        
      } catch (error) {
        // Non-fatal - log but continue
        this.logger.debug('Could not update injection manifest memory status', {
          path: doc.path,
          error: error.message
        });
      }
    }
  }

  /**
   * Create deliverable output file
   * NEW: For guided mode deliverable specification
   */
  async createDeliverableOutput(report, deliverableSpec, documentCollection) {
    // Use PathResolver if available
    if (this.pathResolver && deliverableSpec) {
      try {
        const paths = this.pathResolver.getDeliverablePath({
          deliverableSpec,
          agentType: 'document-analysis',
          agentId: this.agentId,
          fallbackName: 'analysis_output.md'
        });
        
        await fs.mkdir(paths.directory, { recursive: true });
        const outputPath = paths.fullPath;
        
        // Format based on type
        let content;
        if (deliverableSpec.type === 'markdown' || !deliverableSpec.type) {
          content = this.formatAsMarkdown(report, deliverableSpec, documentCollection);
        } else if (deliverableSpec.type === 'json') {
          content = JSON.stringify({
            report,
            documents: documentCollection.map(doc => ({
              filename: doc.filename,
              path: doc.path,
              size: doc.size,
              metadata: doc.metadata
            }))
          }, null, 2);
        } else if (deliverableSpec.type === 'html') {
          content = this.formatAsHTML(report, deliverableSpec, documentCollection);
        } else {
          // Default to markdown
          content = this.formatAsMarkdown(report, deliverableSpec, documentCollection);
        }
        
        if (this.capabilities) {
          await this.capabilities.writeFile(
            path.relative(process.cwd(), outputPath),
            content,
            { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
          );
        } else {
          await fs.writeFile(outputPath, content, 'utf-8');
        }
        
        this.logger.info('📄 Deliverable created', {
          path: paths.relativePath,
          type: deliverableSpec.type || 'markdown',
          size: content.length,
          sections: deliverableSpec.requiredSections?.length || 0,
          mcpAccessible: paths.isAccessible
        });
        
        return outputPath;
        
      } catch (error) {
        this.logger.error('PathResolver failed, using fallback', {
          error: error.message,
          deliverableSpec
        });
        // Fall through to legacy behavior
      }
    }
    
    // LEGACY FALLBACK - Use agent-specific directory to prevent collisions
    const outputDir = this.config.logsDir
      ? path.join(this.config.logsDir, 'outputs', 'document-analysis', this.agentId)
      : path.join(process.cwd(), 'runtime', 'outputs', 'document-analysis', this.agentId);
    await fs.mkdir(outputDir, { recursive: true });
    
    const outputPath = path.join(outputDir, deliverableSpec?.filename || 'analysis_output.md');
    
    // Format based on type
    let content;
    if (deliverableSpec?.type === 'markdown' || !deliverableSpec?.type) {
      content = this.formatAsMarkdown(report, deliverableSpec, documentCollection);
    } else if (deliverableSpec?.type === 'json') {
      content = JSON.stringify({
        report,
        documents: documentCollection.map(doc => ({
          filename: doc.filename,
          path: doc.path,
          size: doc.size,
          metadata: doc.metadata
        }))
      }, null, 2);
    } else if (deliverableSpec?.type === 'html') {
      content = this.formatAsHTML(report, deliverableSpec, documentCollection);
    } else {
      // Default to markdown
      content = this.formatAsMarkdown(report, deliverableSpec, documentCollection);
    }
    
    if (this.capabilities) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), outputPath),
        content,
        { agentId: this.agentId, agentType: 'document-analysis', missionGoal: this.mission.goalId }
      );
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to write deliverable');
      }
    } else {
      await fs.writeFile(outputPath, content, 'utf-8');
    }
    
    this.logger.info('📄 Deliverable created', {
      path: outputPath,
      type: deliverableSpec?.type || 'markdown',
      size: content.length,
      sections: deliverableSpec?.requiredSections?.length || 0
    });
    
    return outputPath;
  }

  /**
   * Format report as markdown document
   */
  formatAsMarkdown(report, spec, documentCollection) {
    const lines = [];
    
    // Title
    lines.push(`# ${report.title || 'Document Analysis Report'}`);
    lines.push('');
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Agent:** Document Analysis Agent`);
    lines.push('');
    
    // Executive Summary (required section)
    lines.push('## Executive Summary');
    lines.push('');
    if (report.summary) {
      lines.push(report.summary);
    } else {
      lines.push(`Analyzed ${documentCollection?.length || 0} documents with comprehensive version tracking and change analysis.`);
    }
    lines.push('');
    
    // Document Inventory
    if (documentCollection && documentCollection.length > 0) {
      lines.push('## Document Inventory');
      lines.push('');
      lines.push('| Filename | Size | Modified | Type |');
      lines.push('|----------|------|----------|------|');
      documentCollection.forEach(doc => {
        const sizeKB = Math.round(doc.size / 1024);
        const modified = doc.metadata?.modified ? new Date(doc.metadata.modified).toLocaleDateString() : 'Unknown';
        const type = doc.filename.split('.').pop().toUpperCase();
        lines.push(`| ${doc.filename} | ${sizeKB} KB | ${modified} | ${type} |`);
      });
      lines.push('');
    }
    
    // Version Timeline
    if (report.timeline && report.timeline.length > 0) {
      lines.push('## Version Timeline');
      lines.push('');
      report.timeline.forEach((entry, idx) => {
        lines.push(`### ${idx + 1}. ${entry.version || entry.document || `Version ${idx + 1}`}`);
        lines.push('');
        if (entry.date) {
          lines.push(`**Date:** ${entry.date}`);
          lines.push('');
        }
        if (entry.changes) {
          lines.push(`**Changes:** ${entry.changes}`);
          lines.push('');
        }
        if (entry.description) {
          lines.push(entry.description);
          lines.push('');
        }
      });
    }
    
    // Change Analysis
    if (report.insights && report.insights.length > 0) {
      lines.push('## Change Analysis');
      lines.push('');
      report.insights.forEach((insight, idx) => {
        lines.push(`### ${idx + 1}. ${insight.title || `Insight ${idx + 1}`}`);
        lines.push('');
        lines.push(insight.content || insight.description || insight.text || '');
        lines.push('');
      });
    }
    
    // Relationships and Patterns
    if (report.relationships || report.patterns) {
      lines.push('## Relationships and Patterns');
      lines.push('');
      
      if (report.relationships) {
        lines.push('### Document Relationships');
        lines.push('');
        if (Array.isArray(report.relationships)) {
          report.relationships.forEach(rel => {
            lines.push(`- ${rel.description || JSON.stringify(rel)}`);
          });
        } else {
          lines.push(report.relationships);
        }
        lines.push('');
      }
      
      if (report.patterns) {
        lines.push('### Patterns Identified');
        lines.push('');
        if (Array.isArray(report.patterns)) {
          report.patterns.forEach(pattern => {
            lines.push(`- ${pattern.description || pattern.name || JSON.stringify(pattern)}`);
          });
        } else {
          lines.push(report.patterns);
        }
        lines.push('');
      }
    }
    
    // Metadata Table
    if (documentCollection && documentCollection.length > 0) {
      lines.push('## Metadata Analysis');
      lines.push('');
      lines.push('| Document | Word Count | Created | Modified | Size |');
      lines.push('|----------|-----------|---------|----------|------|');
      documentCollection.forEach(doc => {
        const wordCount = doc.metadata?.wordCount || 0;
        const created = doc.metadata?.created ? new Date(doc.metadata.created).toLocaleDateString() : 'Unknown';
        const modified = doc.metadata?.modified ? new Date(doc.metadata.modified).toLocaleDateString() : 'Unknown';
        const sizeKB = Math.round(doc.size / 1024);
        lines.push(`| ${doc.filename} | ${wordCount} | ${created} | ${modified} | ${sizeKB} KB |`);
      });
      lines.push('');
    }
    
    // Conclusions
    if (report.conclusions) {
      lines.push('## Conclusions');
      lines.push('');
      if (Array.isArray(report.conclusions)) {
        report.conclusions.forEach(conclusion => {
          lines.push(`- ${conclusion}`);
        });
      } else {
        lines.push(report.conclusions);
      }
      lines.push('');
    }
    
    // Footer
    lines.push('---');
    lines.push('');
    lines.push('*Generated by COSMO Document Analysis Agent*');
    lines.push(`*Report contains ${lines.length} lines*`);
    
    return lines.join('\n');
  }

  /**
   * Format report as HTML document
   */
  formatAsHTML(report, spec, documentCollection) {
    // Simple HTML conversion of markdown
    const markdown = this.formatAsMarkdown(report, spec, documentCollection);
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>${report.title || 'Document Analysis Report'}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    h1 { color: #333; }
    h2 { color: #666; border-bottom: 2px solid #ddd; padding-bottom: 5px; }
  </style>
</head>
<body>
${markdown.split('\n').map(line => {
  if (line.startsWith('# ')) return `<h1>${line.substring(2)}</h1>`;
  if (line.startsWith('## ')) return `<h2>${line.substring(3)}</h2>`;
  if (line.startsWith('### ')) return `<h3>${line.substring(4)}</h3>`;
  if (line.startsWith('| ')) return line; // Keep table rows
  if (line.trim() === '') return '<br>';
  return `<p>${line}</p>`;
}).join('\n')}
</body>
</html>`;
    
    return html;
  }
}

module.exports = { DocumentAnalysisAgent };
