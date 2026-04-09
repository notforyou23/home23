const { BaseAgent } = require('./base-agent');
const fs = require('fs').promises;
const path = require('path');

/**
 * DocumentCompilerAgent - Dual-substrate documentation compilation
 * 
 * Purpose:
 * - Compile system bundles into professional documentation suites
 * - Use dual-substrate strategy: queries=narrative, artifacts=technical truth
 * - Generate 3 core documents: exec overview, architecture, implementation guide
 * - Prevent hallucination by loading actual artifact contents
 * 
 * Strategy:
 * - NARRATIVE SUBSTRATE: Query answers provide context, reasoning, concepts
 * - TECHNICAL SUBSTRATE: Actual code/schemas provide technical specifications
 * - NEVER extract technical details from query text
 * - ALWAYS extract technical details from actual files
 * 
 * Agent Type: document_compiler
 */
class DocumentCompilerAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    
    // Extract mission parameters
    this.systemId = mission.systemId;
    this.runDir = mission.runDir || config.logsDir || path.join(process.cwd(), 'runtime');
    
    // Compilation settings
    this.maxContentPerFile = 50000;  // chars per file (~12K tokens)
    this.maxTotalContext = 100000;   // chars total context
    
    // Document generation status
    this.documentsGenerated = [];
    this.extractedArtifacts = [];  // NEW: Artifacts extracted by intelligent synthesis
    this.compilationErrors = [];
    this.compilationWarnings = [];
  }

  /**
   * Write progress to file for monitoring (especially useful in standalone mode)
   */
  async writeProgressFile(percent, message) {
    try {
      const progressFile = path.join(
        this.runDir,
        'compiled-docs',
        this.systemId,
        '.compilation-progress.json'
      );
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(progressFile), { recursive: true });
      
      const progressData = JSON.stringify({
        systemId: this.systemId,
        agentId: this.agentId,
        percent,
        message,
        timestamp: new Date().toISOString(),
        status: percent === 100 ? 'completed' : 'running'
      }, null, 2);
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), progressFile),
          progressData,
          { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(progressFile, progressData, 'utf-8');
      }
    } catch (error) {
      // Non-fatal - progress file is optional
      this.logger?.warn('Could not write progress file:', error.message);
    }
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('📚 DocumentCompilerAgent v1: Starting compilation', {
      agentId: this.agentId,
      systemId: this.systemId,
      runDir: path.basename(this.runDir),
      strategy: 'dual-substrate',
      model: 'gpt-5.2',
      maxTokens: 16384
    });

    // STEP 1: Load system bundle
    await this.reportProgress(10, 'Loading system bundle');
    await this.writeProgressFile(10, 'Loading system bundle');
    
    const bundle = await this.loadBundle();
    
    this.logger.info('Bundle loaded', {
      artifacts: bundle.metadata.totalArtifacts,
      hasQueryContext: !!bundle.queryContext
    });

    // STEP 2: Load source queries (if from query series)
    await this.reportProgress(20, 'Loading source queries');
    await this.writeProgressFile(20, 'Loading source queries');
    
    const sourceQueries = await this.loadSourceQueries();
    
    if (sourceQueries) {
      this.logger.info('Source queries loaded', {
        count: sourceQueries.length,
        totalAnswerLength: sourceQueries.reduce((sum, q) => sum + (q.answer?.length || 0), 0)
      });
    }

    // STEP 3: Load artifact contents (TECHNICAL SUBSTRATE)
    await this.reportProgress(35, 'Loading artifact contents');
    await this.writeProgressFile(35, 'Loading artifact contents');
    
    const artifactContents = await this.loadArtifactContents(bundle);
    
    this.logger.info('Artifact contents loaded', {
      code: artifactContents.code.length,
      schemas: artifactContents.schemas.length,
      docs: artifactContents.docs.length
    });

    // STEP 4: INTELLIGENT SYNTHESIS (not templates)
    // Use GPT-5.2 to synthesize complete package like Claude would
    await this.reportProgress(50, 'Intelligent synthesis from query answers (GPT-5.2, max tokens, high reasoning)');
    await this.writeProgressFile(50, 'Performing intelligent synthesis of query exploration');
    
    if (sourceQueries && sourceQueries.length > 0) {
      // NEW: Intelligent synthesis mode
      const synthesizedDocs = await this.synthesizeEnterprisePackage(bundle, sourceQueries, artifactContents);
      this.documentsGenerated.push(...synthesizedDocs);
    } else {
      // FALLBACK: Original 3-doc template mode (for non-query compilations)
      await this.reportProgress(50, 'Compiling executive overview (GPT-5.2, 16K tokens)');
      await this.writeProgressFile(50, 'Compiling executive overview (GPT-5.2, high reasoning)');
      
      const execDoc = await this.compileExecutiveOverview(bundle, sourceQueries, artifactContents);
      this.documentsGenerated.push(execDoc);
      
      await this.reportProgress(65, 'Compiling system architecture (GPT-5.2, 16K tokens)');
      await this.writeProgressFile(65, 'Compiling system architecture (GPT-5.2, high reasoning)');
      
      const archDoc = await this.compileArchitecture(bundle, sourceQueries, artifactContents);
      this.documentsGenerated.push(archDoc);

      await this.reportProgress(80, 'Compiling implementation guide (GPT-5.2, 16K tokens)');
      await this.writeProgressFile(80, 'Compiling implementation guide (GPT-5.2, high reasoning)');
      
      const implDoc = await this.compileImplementationGuide(bundle, sourceQueries, artifactContents);
      this.documentsGenerated.push(implDoc);
    }

    // STEP 7: Write documentation suite and package artifacts
    await this.reportProgress(90, 'Writing documentation and packaging artifacts');
    await this.writeProgressFile(90, 'Writing documentation and packaging artifacts');
    
    const outputDir = await this.writeSuite(
      this.documentsGenerated,
      bundle,
      sourceQueries
    );

    // STEP 7b: Package artifacts
    // Includes: 1) Artifacts from bundle, 2) Artifacts extracted by synthesis
    const bundleArtifactCount = bundle.metadata.totalArtifacts;
    const synthesisArtifactCount = this.extractedArtifacts.length;
    const totalArtifactCount = bundleArtifactCount + synthesisArtifactCount;
    
    this.logger.info('Packaging artifacts', {
      fromBundle: bundleArtifactCount,
      fromSynthesis: synthesisArtifactCount,
      total: totalArtifactCount
    });
    
    if (totalArtifactCount === 0) {
      this.logger.info('No artifacts to package - documentation only');
    } else if (totalArtifactCount <= 50) {
      // Package bundle artifacts
      if (bundleArtifactCount > 0) {
        await this.packageArtifacts(bundle, outputDir);
      }
      
      // Package synthesis-extracted artifacts
      if (synthesisArtifactCount > 0) {
        await this.packageSynthesisArtifacts(outputDir);
      }
    } else {
      this.logger.warn(`Large artifact count (${totalArtifactCount}) - packaging may be skipped`);
      if (bundleArtifactCount <= 20) {
        await this.packageArtifacts(bundle, outputDir);
      }
      if (synthesisArtifactCount > 0 && synthesisArtifactCount <= 20) {
        await this.packageSynthesisArtifacts(outputDir);
      }
    }

    // STEP 8: Record in memory
    await this.recordCompilationInMemory(bundle, outputDir, sourceQueries);

    await this.reportProgress(100, 'System package complete');
    await this.writeProgressFile(100, 'Compilation complete! System package ready.');

    return {
      success: true,
      outputDir: path.relative(this.runDir, outputDir),
      documents: this.documentsGenerated.length,
      strategy: 'dual-substrate',
      errors: this.compilationErrors,
      warnings: this.compilationWarnings
    };
  }

  /**
   * Load system bundle JSON
   */
  async loadBundle() {
    const bundlePath = path.join(
      this.runDir,
      'systems',
      this.systemId,
      'system_bundle.json'
    );
    
    try {
      const content = await fs.readFile(bundlePath, 'utf-8');
      const bundle = JSON.parse(content);
      
      // Basic validation
      if (!bundle.systemId || bundle.systemId !== this.systemId) {
        throw new Error(`Bundle systemId mismatch: expected ${this.systemId}, got ${bundle.systemId}`);
      }
      
      if (!bundle.artifacts) {
        throw new Error('Invalid bundle: missing artifacts');
      }
      
      return bundle;
      
    } catch (error) {
      this.logger.error('Failed to load system bundle', {
        bundlePath,
        error: error.message
      });
      throw new Error(`Cannot load system bundle: ${error.message}`);
    }
  }

  /**
   * Load source queries that created this bundle (if from query series)
   */
  async loadSourceQueries() {
    const queriesPath = path.join(
      this.runDir,
      'systems',
      this.systemId,
      'source_queries.jsonl'
    );
    
    try {
      const content = await fs.readFile(queriesPath, 'utf-8');
      const queries = content.trim().split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      
      this.logger.info('Source queries loaded', {
        count: queries.length
      });
      
      return queries;
      
    } catch (error) {
      // Not fatal - bundle may not be from query series
      this.logger.info('No source queries (bundle not from query series)');
      return null;
    }
  }

  /**
   * Load ACTUAL contents of artifacts (prevents hallucination)
   */
  async loadArtifactContents(bundle) {
    const contents = {
      code: [],
      schemas: [],
      docs: []
    };
    
    // LOAD CODE FILES (up to 10)
    this.logger.info('Loading code artifacts', {
      total: bundle.artifacts.code.length,
      willLoad: Math.min(bundle.artifacts.code.length, 10)
    });
    
    for (const artifact of bundle.artifacts.code.slice(0, 10)) {
      try {
        const fullPath = path.join(this.runDir, artifact.relativePath);
        let content = await fs.readFile(fullPath, 'utf-8');
        
        // Truncate if too large
        if (content.length > this.maxContentPerFile) {
          const originalLength = content.length;
          content = content.substring(0, this.maxContentPerFile);
          content += `\n\n[... file truncated: ${originalLength} chars → ${this.maxContentPerFile} chars for context size]`;
        }
        
        contents.code.push({
          filename: artifact.filename,
          source: artifact.source,
          agentId: artifact.agentId,
          size: artifact.size,
          content
        });
        
        this.logger.debug(`  ✓ Loaded: ${artifact.filename} (${(artifact.size/1024).toFixed(1)}KB)`);
        
      } catch (error) {
        this.logger.warn(`  ✗ Skipped ${artifact.filename}: ${error.message}`);
        this.compilationErrors.push({
          type: 'artifact_load_error',
          filename: artifact.filename,
          error: error.message
        });
        // Continue with other files
      }
    }
    
    // LOAD SCHEMAS (up to 10)
    this.logger.info('Loading schema artifacts', {
      total: bundle.artifacts.schemas.length,
      willLoad: Math.min(bundle.artifacts.schemas.length, 10)
    });
    
    for (const artifact of bundle.artifacts.schemas.slice(0, 10)) {
      try {
        const fullPath = path.join(this.runDir, artifact.relativePath);
        let content = await fs.readFile(fullPath, 'utf-8');
        
        if (content.length > this.maxContentPerFile) {
          content = content.substring(0, this.maxContentPerFile);
          content += `\n\n[... truncated]`;
        }
        
        contents.schemas.push({
          filename: artifact.filename,
          source: artifact.source,
          agentId: artifact.agentId,
          content
        });
        
        this.logger.debug(`  ✓ Loaded: ${artifact.filename}`);
        
      } catch (error) {
        this.logger.warn(`  ✗ Skipped ${artifact.filename}: ${error.message}`);
        this.compilationErrors.push({
          type: 'artifact_load_error',
          filename: artifact.filename,
          error: error.message
        });
      }
    }
    
    // LOAD KEY DOCUMENTS (up to 5)
    this.logger.info('Loading document artifacts', {
      total: bundle.artifacts.documents.length,
      willLoad: Math.min(bundle.artifacts.documents.length, 5)
    });
    
    for (const artifact of bundle.artifacts.documents.slice(0, 5)) {
      try {
        const fullPath = path.join(this.runDir, artifact.relativePath);
        let content = await fs.readFile(fullPath, 'utf-8');
        
        if (content.length > this.maxContentPerFile) {
          content = content.substring(0, this.maxContentPerFile);
          content += `\n\n[... truncated]`;
        }
        
        contents.docs.push({
          filename: artifact.filename,
          source: artifact.source,
          content
        });
        
        this.logger.debug(`  ✓ Loaded: ${artifact.filename}`);
        
      } catch (error) {
        this.logger.warn(`  ✗ Skipped ${artifact.filename}: ${error.message}`);
      }
    }
    
    this.logger.info('Artifact loading complete', {
      code: contents.code.length,
      schemas: contents.schemas.length,
      docs: contents.docs.length,
      errors: this.compilationErrors.filter(e => e.type === 'artifact_load_error').length
    });
    
    return contents;
  }

  /**
   * Compile Executive Overview document
   */
  async compileExecutiveOverview(bundle, sourceQueries, artifactContents) {
    this.logger.info('Compiling executive overview');
    
    const context = this.buildExecContext(bundle, sourceQueries, artifactContents);
    
    const prompt = `You are compiling an EXECUTIVE OVERVIEW for a technical system.

SYSTEM: ${bundle.name}
${bundle.description}

${context}

YOUR TASK:
Create a professional executive overview that explains this system for business and strategic audiences.

COMPILATION RULES:
1. Use the exploration context to understand WHY this system matters and HOW it was conceived
2. Use the artifact inventory to confirm WHAT actually exists
3. Do NOT extract or invent technical implementation details
4. Focus on: strategic value, key capabilities, business impact, stakeholders, readiness

STRUCTURE:
- Executive Summary (2-3 paragraphs)
- Strategic Value & Business Impact
- Key Capabilities
- Stakeholders & Use Cases
- Implementation Readiness Assessment
- Recommendations

TARGET: 1000-1500 words, professional tone, actionable insights.

Generate the complete executive overview in markdown format:`;

    const response = await this.callGPT5({
      model: 'gpt-5.2',  // GPT-5.2 for best quality
      instructions: prompt,
      messages: [{ role: 'user', content: 'Generate executive overview' }],
      maxTokens: 16384,  // Maximum output tokens for comprehensive docs
      reasoningEffort: 'high'  // High reasoning for quality
    });

    return {
      filename: 'executive_overview.md',
      content: response.content,
      usedCode: false,
      usedSchemas: false,
      usedDocs: false
    };
  }

  /**
   * Build context for executive overview
   */
  buildExecContext(bundle, sourceQueries, artifactContents) {
    let ctx = '';
    
    // NARRATIVE SUBSTRATE: Query exploration
    if (sourceQueries && sourceQueries.length > 0) {
      ctx += `=== EXPLORATION CONTEXT ===\n\n`;
      ctx += `The following ${sourceQueries.length} queries explored this system:\n\n`;
      
      sourceQueries.forEach((q, idx) => {
        ctx += `Query ${idx + 1}: ${q.query}\n\n`;
        
        // Include first 500 chars of each answer for context
        const answer = q.answer || '';
        ctx += `Key insights:\n${answer.substring(0, 500)}...\n\n`;
        ctx += `---\n\n`;
      });
    } else {
      ctx += `System declared without query series.\n\n`;
    }
    
    // ARTIFACT INVENTORY (what exists)
    ctx += `=== SYSTEM DELIVERABLES ===\n\n`;
    ctx += `Total artifacts: ${bundle.metadata.totalArtifacts}\n\n`;
    ctx += `Breakdown:\n`;
    ctx += `- Code files: ${bundle.artifacts.code.length}\n`;
    ctx += `- Schemas: ${bundle.artifacts.schemas.length}\n`;
    ctx += `- Documents: ${bundle.artifacts.documents.length}\n`;
    ctx += `- Other: ${bundle.artifacts.other.length}\n\n`;
    
    // Brief artifact listing
    if (bundle.artifacts.code.length > 0) {
      ctx += `Key code files:\n`;
      bundle.artifacts.code.slice(0, 5).forEach(a => {
        ctx += `- ${a.filename} (${a.source}, ${(a.size/1024).toFixed(1)}KB)\n`;
      });
      ctx += `\n`;
    }
    
    return ctx;
  }

  /**
   * Compile System Architecture document (DUAL-SUBSTRATE)
   */
  async compileArchitecture(bundle, sourceQueries, artifactContents) {
    this.logger.info('Compiling system architecture');
    
    const context = this.buildArchContext(bundle, sourceQueries, artifactContents);
    
    const prompt = `You are compiling a TECHNICAL ARCHITECTURE DOCUMENT.

SYSTEM: ${bundle.name}

DUAL-SUBSTRATE COMPILATION STRATEGY:

The context below is divided into TWO substrates:

1. CONCEPTUAL CONTEXT (from query exploration)
   - Use for: Understanding design decisions, architectural reasoning, tradeoffs
   - DO NOT use for: Extracting API signatures, class definitions, data schemas

2. TECHNICAL SUBSTRATE (from actual code and schema files)
   - Use for: ALL technical specifications, APIs, component structure, data models
   - This is ground truth - document ONLY what appears in these files

${context}

YOUR TASK:
Create a technical architecture document for engineers and architects.

CRITICAL RULES:
- Document ONLY components, APIs, and structures present in the TECHNICAL SUBSTRATE
- Use CONCEPTUAL CONTEXT to explain WHY decisions were made
- NEVER invent or infer technical details not in actual code/schemas
- If something is mentioned in queries but not in artifacts, state: "Not yet implemented"
- Be explicit about what exists vs what is conceptual

STRUCTURE:
- System Overview
- Component Architecture (from actual code)
- Data Flow & Integration (from actual schemas)
- Key Technical Decisions (from query reasoning + code evidence)
- Architecture Diagrams (mermaid - based on actual structure)
- Technical Considerations (scalability, reliability, security)

TARGET: Comprehensive technical documentation, grounded in reality.

Generate in markdown with mermaid diagrams where appropriate:`;

    const response = await this.callGPT5({
      model: 'gpt-5.2',  // GPT-5.2 for best quality
      instructions: prompt,
      messages: [{ role: 'user', content: 'Generate system architecture document' }],
      maxTokens: 16384,  // Maximum output tokens for comprehensive technical docs
      reasoningEffort: 'high'  // High reasoning for complex architecture
    });

    return {
      filename: 'system_architecture.md',
      content: response.content,
      usedCode: artifactContents.code.length > 0,
      usedSchemas: artifactContents.schemas.length > 0,
      usedDocs: false
    };
  }

  /**
   * Build context for architecture document (DUAL-SUBSTRATE)
   */
  buildArchContext(bundle, sourceQueries, artifactContents) {
    let ctx = '';
    
    // PART 1: CONCEPTUAL SUBSTRATE (from queries)
    if (sourceQueries && sourceQueries.length > 0) {
      ctx += `=== CONCEPTUAL CONTEXT (from query exploration) ===\n\n`;
      ctx += `Use this section ONLY for understanding:\n`;
      ctx += `- Conceptual architecture and design decisions\n`;
      ctx += `- Reasoning behind component choices\n`;
      ctx += `- Strategic technical direction\n\n`;
      ctx += `DO NOT extract API signatures, class definitions, or technical specs from this section.\n\n`;
      
      sourceQueries.forEach((q, idx) => {
        ctx += `Query ${idx + 1}: ${q.query}\n\n`;
        const answer = q.answer || '';
        ctx += `Exploration:\n${answer.substring(0, 3000)}...\n\n`;
        ctx += `---\n\n`;
      });
    }
    
    ctx += `\n=== TECHNICAL SUBSTRATE (from actual artifacts) ===\n\n`;
    ctx += `Use this section for ALL technical specifications.\n`;
    ctx += `RULE: Only document components, APIs, and structures that appear below.\n\n`;
    
    // PART 2: TECHNICAL SUBSTRATE (actual code)
    if (artifactContents.code.length > 0) {
      ctx += `CODE FILES (${artifactContents.code.length} total):\n\n`;
      
      artifactContents.code.forEach(f => {
        ctx += `### File: ${f.filename}\n`;
        ctx += `Source: ${f.source}\n`;
        ctx += `\`\`\`\n${f.content}\n\`\`\`\n\n`;
      });
    } else {
      ctx += `No code files in bundle.\n\n`;
    }
    
    // PART 3: TECHNICAL SUBSTRATE (schemas)
    if (artifactContents.schemas.length > 0) {
      ctx += `SCHEMAS (${artifactContents.schemas.length} total):\n\n`;
      
      artifactContents.schemas.forEach(s => {
        ctx += `### File: ${s.filename}\n`;
        ctx += `Source: ${s.source}\n`;
        ctx += `\`\`\`\n${s.content}\n\`\`\`\n\n`;
      });
    } else {
      ctx += `No schema files in bundle.\n\n`;
    }
    
    // Cap total context size
    return ctx.substring(0, this.maxTotalContext);
  }

  /**
   * Compile Implementation Guide document
   */
  async compileImplementationGuide(bundle, sourceQueries, artifactContents) {
    this.logger.info('Compiling implementation guide');
    
    const context = this.buildImplContext(bundle, sourceQueries, artifactContents);
    
    const prompt = `You are compiling an IMPLEMENTATION GUIDE.

SYSTEM: ${bundle.name}

COMPILATION STRATEGY:
- Query context provides USAGE PATTERNS and GOALS
- Actual code provides IMPLEMENTATION DETAILS
- All code examples must come from actual files provided
- Never invent setup steps or code not present in artifacts

${context}

YOUR TASK:
Create a practical implementation guide for developers.

CRITICAL RULES:
- ALL code examples must be from the actual files provided above
- If code is missing, state "To be implemented" - do not invent
- Use query context to explain intended use cases
- Be specific about prerequisites and dependencies visible in code
- Include only configuration options present in actual schemas

STRUCTURE:
- Prerequisites & Dependencies (from actual code imports/requires)
- Installation & Setup (based on actual file structure)
- Configuration (from actual schema/config files)
- Usage Examples (from actual code)
- Common Patterns (from actual implementations)
- Troubleshooting (based on code error handling)

TARGET: Practical, accurate guide grounded in actual implementation.

Generate in markdown with code examples:`;

    const response = await this.callGPT5({
      model: 'gpt-5.2',  // GPT-5.2 for best quality
      instructions: prompt,
      messages: [{ role: 'user', content: 'Generate implementation guide' }],
      maxTokens: 16384,  // Maximum output tokens for detailed implementation examples
      reasoningEffort: 'high'  // High reasoning for practical guidance
    });

    return {
      filename: 'implementation_guide.md',
      content: response.content,
      usedCode: artifactContents.code.length > 0,
      usedSchemas: artifactContents.schemas.length > 0,
      usedDocs: false
    };
  }

  /**
   * Build context for implementation guide
   */
  buildImplContext(bundle, sourceQueries, artifactContents) {
    let ctx = '';
    
    // PART 1: USAGE CONTEXT (from queries)
    if (sourceQueries && sourceQueries.length > 0) {
      ctx += `=== USAGE CONTEXT (from exploration) ===\n\n`;
      ctx += `These queries explored intended usage and goals:\n\n`;
      
      sourceQueries.forEach((q, idx) => {
        ctx += `${idx + 1}. ${q.query}\n`;
      });
      
      ctx += `\n`;
    }
    
    ctx += `=== IMPLEMENTATION (from actual code) ===\n\n`;
    ctx += `Base ALL examples and instructions on the code below.\n`;
    ctx += `RULE: Never show code examples not present in these files.\n\n`;
    
    // PART 2: ACTUAL CODE (implementation details)
    if (artifactContents.code.length > 0) {
      ctx += `CODE FILES:\n\n`;
      
      // Prioritize entry points and main files
      const sortedCode = this.prioritizeCodeFiles(artifactContents.code);
      
      sortedCode.slice(0, 5).forEach(f => {
        ctx += `### ${f.filename}\n`;
        ctx += `Source: ${f.source}\n`;
        ctx += `\`\`\`\n${f.content.substring(0, 10000)}\n\`\`\`\n\n`;
      });
    } else {
      ctx += `No code files available.\n`;
      ctx += `Implementation guide will focus on conceptual setup based on exploration context.\n\n`;
    }
    
    // PART 3: CONFIGURATION (schemas)
    if (artifactContents.schemas.length > 0) {
      ctx += `CONFIGURATION FILES:\n\n`;
      
      artifactContents.schemas.slice(0, 3).forEach(s => {
        ctx += `### ${s.filename}\n`;
        ctx += `\`\`\`\n${s.content}\n\`\`\`\n\n`;
      });
    }
    
    return ctx.substring(0, 80000);  // Cap context
  }

  /**
   * Prioritize code files (entry points first)
   */
  prioritizeCodeFiles(codeFiles) {
    const scored = codeFiles.map(f => {
      let score = 0;
      const name = f.filename.toLowerCase();
      
      // Entry points (highest priority)
      if (name === 'main.py' || name === 'index.js' || name === 'app.py' || name === 'main.js') {
        score += 100;
      }
      
      // Core/important indicators
      if (name.includes('core') || name.includes('main') || name.includes('base')) {
        score += 50;
      }
      
      // Configuration
      if (name.includes('config') || name.includes('settings')) {
        score += 30;
      }
      
      // Size (larger files likely more important, up to a point)
      if (f.size > 5000 && f.size < 50000) {
        score += 20;
      }
      
      // Agents (synthesis/analysis more likely to have specs)
      if (f.source === 'synthesis' || f.source === 'analysis') {
        score += 10;
      }
      
      return { ...f, priority: score };
    });
    
    // Sort by priority (descending)
    return scored.sort((a, b) => b.priority - a.priority);
  }

  /**
   * INTELLIGENT SYNTHESIS MODE
   * Synthesize complete enterprise package from query answers (like Claude would)
   * Not templated - GPT-5.2 decides what to create based on content
   */
  async synthesizeEnterprisePackage(bundle, sourceQueries, artifactContents) {
    this.logger.info('🧠 Intelligent synthesis mode - enterprise-grade deliverable generation');
    
    // Build comprehensive context from ALL query answers
    let context = `# COSMO RESEARCH EXPLORATION\n\n`;
    context += `System: ${bundle.name}\n`;
    context += `Query Series: ${sourceQueries.length} queries\n\n`;
    context += `---\n\n`;
    
    // Include ALL query answers (full text - this is the research material)
    sourceQueries.forEach((q, idx) => {
      context += `## Query ${idx + 1}: ${q.query}\n\n`;
      context += `${q.answer || 'No answer'}\n\n`;
      context += `---\n\n`;
    });
    
    // Artifact summary (what exists in outputs/)
    if (artifactContents.code.length > 0 || artifactContents.schemas.length > 0) {
      context += `\n## ARTIFACTS IN OUTPUTS/\n\n`;
      if (artifactContents.code.length > 0) {
        context += `Code files found:\n`;
        artifactContents.code.forEach(f => {
          context += `- ${f.filename} (${f.source})\n`;
        });
        context += `\n`;
      }
      if (artifactContents.schemas.length > 0) {
        context += `Schema/config files found:\n`;
        artifactContents.schemas.forEach(f => {
          context += `- ${f.filename}\n`;
        });
        context += `\n`;
      }
    }
    
    const prompt = `You are COSMO's Enterprise Synthesis Agent.

You have been given ${sourceQueries.length} query ${sourceQueries.length === 1 ? 'answer' : 'answers'} from COSMO's research brain. These are RESEARCH-GRADE explorations - dense, sophisticated, complete.

YOUR TASK:
Synthesize a complete, professional deliverable package from this material.

WHAT TO DO:

1. EXTRACT ALL ARTIFACTS from query answers:
   - Find every code block: \`\`\`html, \`\`\`python, \`\`\`json, etc.
   - Extract complete files (skip tiny snippets)
   - List each with appropriate filename

2. DECIDE WHAT DOCUMENTATION IS NEEDED:
   - NOT hardcoded templates
   - Based on what was actually built/explored
   - Examples: README, Architecture, API docs, Usage guide, Specifications, etc.
   - Create what makes sense for THIS content

3. SYNTHESIZE COMPREHENSIVELY:
   - This is COSMO's output - treat it as research-grade
   - Be thorough, detailed, professional
   - Enterprise quality, not summaries
   - Extract insights, organize intelligently

OUTPUT FORMAT:

Return JSON with this structure:
{
  "artifacts": [
    {
      "filename": "sauna_fan.html",
      "type": "code" | "schemas" | "documents" | "other",
      "content": "...complete file content...",
      "description": "Interactive diagram of sauna TEG system"
    }
  ],
  "documents": [
    {
      "filename": "README.md",
      "content": "...complete markdown content...",
      "purpose": "Main entry point and overview"
    }
  ]
}

CRITICAL RULES:
- Extract EVERY complete code block as a file
- Create comprehensive documentation (not templates)
- Be intelligent about structure
- Match COSMO's sophistication level
- If you find HTML, Python, JSON, etc - include it
- Decide what docs are needed based on content
- NO generic filler - everything should be substantive

Generate the complete package manifest:`;

    const response = await this.callGPT5({
      model: 'gpt-5.2',
      instructions: prompt,
      messages: [{ role: 'user', content: context }],
      maxTokens: 32000,  // Large output for complete synthesis
      reasoningEffort: 'high'
    });
    
    // Parse the JSON response
    let synthesis;
    try {
      synthesis = JSON.parse(response.content);
    } catch (error) {
      this.logger.error('Failed to parse synthesis JSON', { error: error.message });
      // Fallback to old mode if JSON parsing fails
      this.logger.warn('Falling back to template mode due to synthesis parse error');
      return await this.fallbackToTemplateMode(bundle, sourceQueries, artifactContents);
    }
    
    this.logger.info('Intelligent synthesis complete', {
      artifactsExtracted: synthesis.artifacts?.length || 0,
      documentsCreated: synthesis.documents?.length || 0
    });
    
    // Convert synthesis output to document format
    const documents = [];
    
    // Add synthesized documents
    if (synthesis.documents && Array.isArray(synthesis.documents)) {
      for (const doc of synthesis.documents) {
        documents.push({
          filename: doc.filename,
          content: doc.content,
          purpose: doc.purpose
        });
      }
    }
    
    // Store extracted artifacts for packaging
    this.extractedArtifacts = synthesis.artifacts || [];
    
    return documents;
  }
  
  /**
   * Fallback to template mode if intelligent synthesis fails
   */
  async fallbackToTemplateMode(bundle, sourceQueries, artifactContents) {
    const docs = [];
    docs.push(await this.compileExecutiveOverview(bundle, sourceQueries, artifactContents));
    docs.push(await this.compileArchitecture(bundle, sourceQueries, artifactContents));
    docs.push(await this.compileImplementationGuide(bundle, sourceQueries, artifactContents));
    return docs;
  }

  /**
   * Package actual artifacts (code, schemas, etc.) into output directory
   */
  async packageArtifacts(bundle, outputDir) {
    this.logger.info('📦 Packaging artifacts into output directory');
    
    const stats = {
      code: { attempted: 0, copied: 0, failed: 0, bytes: 0 },
      schemas: { attempted: 0, copied: 0, failed: 0, bytes: 0 },
      documents: { attempted: 0, copied: 0, failed: 0, bytes: 0 },
      other: { attempted: 0, copied: 0, failed: 0, bytes: 0 },
      totalCopied: 0,
      totalBytes: 0,
      errors: []
    };

    // Create subdirectories
    const srcDir = path.join(outputDir, 'src');
    const configDir = path.join(outputDir, 'config');
    const artifactsDir = path.join(outputDir, 'artifacts');
    
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });

    // Package code files
    if (bundle.artifacts.code && bundle.artifacts.code.length > 0) {
      this.logger.info(`  Packaging ${bundle.artifacts.code.length} code files...`);
      
      for (const artifact of bundle.artifacts.code) {
        stats.code.attempted++;
        
        try {
          const destPath = path.join(srcDir, artifact.filename);
          let content;
          
          if (artifact.embedded) {
            // Write embedded content from query answer
            content = artifact.content;
          if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [embedded] src/${artifact.filename} (${(content.length/1024).toFixed(1)}KB)`);
          } else {
            // Copy from filesystem
            const sourcePath = path.join(this.runDir, artifact.relativePath);
            content = await fs.readFile(sourcePath, 'utf-8');
            if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [file] src/${artifact.filename} (${(content.length/1024).toFixed(1)}KB)`);
          }
          
          stats.code.copied++;
          stats.code.bytes += content.length;
          stats.totalCopied++;
          stats.totalBytes += content.length;
          
        } catch (error) {
          stats.code.failed++;
          stats.errors.push({
            type: 'code',
            filename: artifact.filename,
            error: error.message
          });
          this.logger.warn(`    ✗ Failed to package ${artifact.filename}: ${error.message}`);
          this.compilationWarnings.push(`Failed to package code file: ${artifact.filename}`);
        }
      }
    }

    // Package schema/config files
    if (bundle.artifacts.schemas && bundle.artifacts.schemas.length > 0) {
      this.logger.info(`  Packaging ${bundle.artifacts.schemas.length} schema/config files...`);
      
      for (const artifact of bundle.artifacts.schemas) {
        stats.schemas.attempted++;
        
        try {
          const destPath = path.join(configDir, artifact.filename);
          let content;
          
          if (artifact.embedded) {
            content = artifact.content;
          if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [embedded] config/${artifact.filename}`);
          } else {
            const sourcePath = path.join(this.runDir, artifact.relativePath);
            content = await fs.readFile(sourcePath, 'utf-8');
            if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [file] config/${artifact.filename}`);
          }
          
          stats.schemas.copied++;
          stats.schemas.bytes += content.length;
          stats.totalCopied++;
          stats.totalBytes += content.length;
          
        } catch (error) {
          stats.schemas.failed++;
          stats.errors.push({
            type: 'schemas',
            filename: artifact.filename,
            error: error.message
          });
          this.logger.warn(`    ✗ Failed to package ${artifact.filename}: ${error.message}`);
          this.compilationWarnings.push(`Failed to package schema file: ${artifact.filename}`);
        }
      }
    }

    // Package document artifacts
    if (bundle.artifacts.documents && bundle.artifacts.documents.length > 0) {
      this.logger.info(`  Packaging ${bundle.artifacts.documents.length} document artifacts...`);
      
      for (const artifact of bundle.artifacts.documents) {
        stats.documents.attempted++;
        
        try {
          const destPath = path.join(artifactsDir, artifact.filename);
          let content;
          
          if (artifact.embedded) {
            content = artifact.content;
          if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [embedded] artifacts/${artifact.filename}`);
          } else {
            const sourcePath = path.join(this.runDir, artifact.relativePath);
            content = await fs.readFile(sourcePath, 'utf-8');
            if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
            this.logger.debug(`    ✓ [file] artifacts/${artifact.filename}`);
          }
          
          stats.documents.copied++;
          stats.documents.bytes += content.length;
          stats.totalCopied++;
          stats.totalBytes += content.length;
          
        } catch (error) {
          stats.documents.failed++;
          stats.errors.push({
            type: 'documents',
            filename: artifact.filename,
            error: error.message
          });
          this.logger.warn(`    ✗ Failed to package ${artifact.filename}: ${error.message}`);
          this.compilationWarnings.push(`Failed to package document file: ${artifact.filename}`);
        }
      }
    }

    // Package other artifacts
    if (bundle.artifacts.other && bundle.artifacts.other.length > 0) {
      this.logger.info(`  Packaging ${bundle.artifacts.other.length} other artifacts...`);
      
      for (const artifact of bundle.artifacts.other) {
        stats.other.attempted++;
        
        try {
          const sourcePath = path.join(this.runDir, artifact.relativePath);
          const destPath = path.join(artifactsDir, artifact.filename);
          
          // Try to read as text first, fall back to binary
          let content;
          try {
            content = await fs.readFile(sourcePath, 'utf-8');
            if (this.capabilities) {
            await this.capabilities.writeFile(
              path.relative(process.cwd(), destPath),
              content,
              { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(destPath, content, 'utf-8');
          }
          } catch {
            // Binary file - copy as buffer
            content = await fs.readFile(sourcePath);
            if (this.capabilities) {
              await this.capabilities.writeFile(
                path.relative(process.cwd(), destPath),
                content,
                { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
              );
            } else {
              await fs.writeFile(destPath, content);
            }
          }
          
          stats.other.copied++;
          stats.other.bytes += content.length;
          stats.totalCopied++;
          stats.totalBytes += content.length;
          
          this.logger.debug(`    ✓ artifacts/${artifact.filename}`);
          
        } catch (error) {
          stats.other.failed++;
          stats.errors.push({
            type: 'other',
            filename: artifact.filename,
            error: error.message
          });
          this.logger.warn(`    ✗ Failed to copy ${artifact.filename}: ${error.message}`);
          this.compilationWarnings.push(`Failed to package artifact: ${artifact.filename}`);
        }
      }
    }

    this.logger.info(`✅ Artifact packaging complete`, {
      copied: stats.totalCopied,
      failed: stats.code.failed + stats.schemas.failed + stats.documents.failed + stats.other.failed,
      totalSize: `${(stats.totalBytes / 1024).toFixed(1)}KB`
    });

    return stats;
  }
  
  /**
   * Package artifacts extracted by intelligent synthesis
   */
  async packageSynthesisArtifacts(outputDir) {
    this.logger.info('📦 Packaging synthesis-extracted artifacts', {
      count: this.extractedArtifacts.length
    });
    
    const srcDir = path.join(outputDir, 'src');
    const configDir = path.join(outputDir, 'config');
    const artifactsDir = path.join(outputDir, 'artifacts');
    
    for (const artifact of this.extractedArtifacts) {
      try {
        let targetDir;
        if (artifact.type === 'code') targetDir = srcDir;
        else if (artifact.type === 'schemas') targetDir = configDir;
        else targetDir = artifactsDir;
        
        const destPath = path.join(targetDir, artifact.filename);
        if (this.capabilities) {
          await this.capabilities.writeFile(
            path.relative(process.cwd(), destPath),
            artifact.content,
            { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
          );
        } else {
          await fs.writeFile(destPath, artifact.content, 'utf-8');
        }
        
        this.logger.debug(`  ✓ [synthesis] ${artifact.filename}`);
      } catch (error) {
        this.logger.warn(`  ✗ Failed synthesis artifact ${artifact.filename}: ${error.message}`);
      }
    }
  }

  /**
   * Write complete documentation suite to disk
   */
  async writeSuite(documents, bundle, sourceQueries) {
    // Output directory
    const outputDir = path.join(this.runDir, 'compiled-docs', this.systemId);
    await fs.mkdir(outputDir, { recursive: true });

    // Create subdirectories for organized output
    const docsDir = path.join(outputDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });

    // Write INDEX.md to root (for quick access)
    const index = this.buildIndex(documents, bundle, sourceQueries);
    const indexPath = path.join(outputDir, 'INDEX.md');
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), indexPath),
        index,
        { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(indexPath, index, 'utf-8');
    }

    // Write each generated document to docs/ subdirectory
    for (const doc of documents) {
      const docPath = path.join(docsDir, doc.filename);
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), docPath),
          doc.content,
          { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(docPath, doc.content, 'utf-8');
      }
      
      this.logger.info(`  ✓ docs/${doc.filename} (${(doc.content.length/1024).toFixed(1)}KB)`);
    }

    // Package actual artifacts (code, schemas, etc.)
    const packagedArtifacts = await this.packageArtifacts(bundle, outputDir);

    // Write COMPILATION_MANIFEST.json (provenance)
    const manifest = this.buildCompilationManifest(bundle, sourceQueries, documents, packagedArtifacts);
    const manifestPath = path.join(outputDir, 'MANIFEST.json');
    const manifestContent = JSON.stringify(manifest, null, 2);
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), manifestPath),
        manifestContent,
        { agentId: this.agentId, agentType: 'document-compiler', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(manifestPath, manifestContent, 'utf-8');
    }

    this.logger.info(`✅ Documentation suite written`, {
      outputDir: path.relative(this.runDir, outputDir),
      documents: documents.length,
      artifacts: packagedArtifacts.totalCopied,
      totalSize: documents.reduce((sum, d) => sum + d.content.length, 0)
    });

    return outputDir;
  }

  /**
   * Build INDEX.md with navigation and provenance
   */
  buildIndex(documents, bundle, sourceQueries) {
    const lines = [
      `# ${bundle.name}`,
      ``,
      `**System ID:** \`${bundle.systemId}\``,
      `**Compiled:** ${new Date().toISOString()}`,
      `**Agent:** \`${this.agentId}\``,
      `**Compilation Strategy:** Dual-substrate (queries=narrative, artifacts=technical)`,
      `**Version:** v1.1 (with artifact packaging)`,
      ``
    ];
    
    if (bundle.description) {
      lines.push(bundle.description);
      lines.push(``);
    }
    
    lines.push(`---`);
    lines.push(``);
    lines.push(`## 📁 Suite Contents`);
    lines.push(``);
    lines.push(`This is a **complete, self-contained system package** with documentation and all artifacts.`);
    lines.push(``);
    lines.push(`### Directory Structure`);
    lines.push(``);
    lines.push(`\`\`\``);
    lines.push(`${bundle.systemId}/`);
    lines.push(`├── docs/               # Generated documentation`);
    documents.forEach(d => {
      lines.push(`│   ├── ${d.filename}`);
    });
    if (bundle.artifacts.code.length > 0) {
      lines.push(`├── src/                # Code artifacts (${bundle.artifacts.code.length} files)`);
    }
    if (bundle.artifacts.schemas.length > 0) {
      lines.push(`├── config/             # Schemas and configuration (${bundle.artifacts.schemas.length} files)`);
    }
    if (bundle.artifacts.documents.length > 0 || bundle.artifacts.other.length > 0) {
      const otherCount = bundle.artifacts.documents.length + bundle.artifacts.other.length;
      lines.push(`├── artifacts/          # Other artifacts (${otherCount} files)`);
    }
    lines.push(`├── INDEX.md            # This file`);
    lines.push(`└── MANIFEST.json       # Complete compilation manifest`);
    lines.push(`\`\`\``);
    lines.push(``);
    lines.push(`### 📖 Documentation`);
    lines.push(``);
    
    documents.forEach(d => {
      const title = this.formatDocTitle(d.filename);
      lines.push(`- [**${title}**](./docs/${d.filename})`);
    });
    
    lines.push(``);
    lines.push(`### 💻 Packaged Artifacts`);
    lines.push(``);
    
    if (bundle.artifacts.code.length > 0) {
      lines.push(`**Code Files** (\`src/\` directory):`);
      lines.push(``);
      bundle.artifacts.code.slice(0, 10).forEach(a => {
        lines.push(`- \`${a.filename}\` - ${(a.size/1024).toFixed(1)}KB (from ${a.source})`);
      });
      if (bundle.artifacts.code.length > 10) {
        lines.push(`- ... and ${bundle.artifacts.code.length - 10} more`);
      }
      lines.push(``);
    }
    
    if (bundle.artifacts.schemas.length > 0) {
      lines.push(`**Configuration Files** (\`config/\` directory):`);
      lines.push(``);
      bundle.artifacts.schemas.slice(0, 10).forEach(a => {
        lines.push(`- \`${a.filename}\` - ${(a.size/1024).toFixed(1)}KB`);
      });
      if (bundle.artifacts.schemas.length > 10) {
        lines.push(`- ... and ${bundle.artifacts.schemas.length - 10} more`);
      }
      lines.push(``);
    }
    
    lines.push(`---`);
    lines.push(``);
    lines.push(`## 🔍 Compilation Sources`);
    lines.push(``);
    
    // Source queries section
    if (sourceQueries && sourceQueries.length > 0) {
      lines.push(`### Query Exploration Series`);
      lines.push(``);
      lines.push(`This system was synthesized through ${sourceQueries.length} queries:`);
      lines.push(``);
      
      sourceQueries.forEach((q, idx) => {
        const time = new Date(q.timestamp).toLocaleString();
        lines.push(`${idx + 1}. **"${q.query}"**`);
        lines.push(`   - Time: ${time}`);
        lines.push(`   - Model: ${q.model} (${q.mode} mode)`);
        const answerLength = (q.answer?.length || 0);
        lines.push(`   - Length: ${(answerLength/1024).toFixed(1)}KB`);
        lines.push(``);
      });
    }
    
    // Artifacts section
    lines.push(`### System Artifacts`);
    lines.push(``);
    lines.push(`**Total Artifacts:** ${bundle.metadata.totalArtifacts}`);
    lines.push(``);
    lines.push(`- Code files: ${bundle.artifacts.code.length}`);
    lines.push(`- Schemas: ${bundle.artifacts.schemas.length}`);
    lines.push(`- Documents: ${bundle.artifacts.documents.length}`);
    lines.push(`- Other: ${bundle.artifacts.other.length}`);
    lines.push(``);
    
    if (bundle.artifacts.code.length > 0) {
      lines.push(`<details>`);
      lines.push(`<summary>View code files</summary>`);
      lines.push(``);
      bundle.artifacts.code.forEach(a => {
        lines.push(`- \`${a.filename}\` (${a.source}, ${(a.size/1024).toFixed(1)}KB)`);
      });
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }
    
    // Scope section
    lines.push(`### Compilation Scope`);
    lines.push(``);
    lines.push(`- **Run:** ${bundle.scope.runDir}`);
    lines.push(`- **Agent Types:** ${bundle.scope.agentTypes.join(', ')}`);
    lines.push(`- **Memory Included:** ${bundle.scope.memoryIncluded ? 'Yes' : 'No'}`);
    lines.push(``);
    
    lines.push(`---`);
    lines.push(``);
    lines.push(`## 📝 About This Package`);
    lines.push(``);
    lines.push(`This is a **complete, self-contained system package** generated by COSMO's DocumentCompilerAgent.`);
    lines.push(``);
    lines.push(`### Compilation Strategy: Dual-Substrate`);
    lines.push(``);
    lines.push(`- **Query answers** provide narrative context, conceptual structure, and reasoning`);
    lines.push(`- **Artifacts** (code, schemas) provide technical ground truth`);
    lines.push(``);
    lines.push(`All technical specifications in the documentation are extracted from actual artifact files.`);
    lines.push(`All code, schemas, and configuration files are **packaged in this directory** for standalone use.`);
    lines.push(``);
    lines.push(`### Usage`);
    lines.push(``);
    lines.push(`This package is fully self-contained and can be:`);
    lines.push(`- Shared with team members or stakeholders`);
    lines.push(`- Version controlled as a complete unit`);
    lines.push(`- Used as a reference implementation`);
    lines.push(`- Deployed or adapted as needed`);
    lines.push(``);
    lines.push(`See \`MANIFEST.json\` for complete provenance and packaging details.`);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    lines.push(`*Generated by COSMO DocumentCompilerAgent v1.1 (${this.agentId})*`);
    
    return lines.join('\n');
  }

  /**
   * Format document title from filename
   */
  formatDocTitle(filename) {
    return filename
      .replace('.md', '')
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * Build compilation manifest (provenance)
   */
  buildCompilationManifest(bundle, sourceQueries, documents, packagedArtifacts) {
    return {
      systemId: this.systemId,
      compiledAt: new Date().toISOString(),
      agentId: this.agentId,
      agentType: 'document_compiler',
      
      compilationStrategy: {
        name: 'dual-substrate',
        principle: 'queries provide narrative, artifacts provide technical truth',
        version: '1.1.0'  // Bumped for artifact packaging
      },
      
      sources: {
        queries: sourceQueries ? {
          count: sourceQueries.length,
          timestamps: sourceQueries.map(q => q.timestamp),
          totalAnswerLength: sourceQueries.reduce((sum, q) => sum + (q.answer?.length || 0), 0),
          models: [...new Set(sourceQueries.map(q => q.model))],
          modes: [...new Set(sourceQueries.map(q => q.mode))]
        } : null,
        
        artifacts: {
          code: {
            total: bundle.artifacts.code.length,
            loaded: this.documentsGenerated.filter(d => d.usedCode).length,
            packaged: packagedArtifacts?.code.copied || 0,
            files: bundle.artifacts.code.map(a => a.filename)
          },
          schemas: {
            total: bundle.artifacts.schemas.length,
            loaded: this.documentsGenerated.filter(d => d.usedSchemas).length,
            packaged: packagedArtifacts?.schemas.copied || 0,
            files: bundle.artifacts.schemas.map(a => a.filename)
          },
          documents: {
            total: bundle.artifacts.documents.length,
            loaded: this.documentsGenerated.filter(d => d.usedDocs).length,
            packaged: packagedArtifacts?.documents.copied || 0,
            files: bundle.artifacts.documents.map(a => a.filename)
          },
          other: {
            total: bundle.artifacts.other?.length || 0,
            packaged: packagedArtifacts?.other.copied || 0,
            files: (bundle.artifacts.other || []).map(a => a.filename)
          }
        }
      },
      
      outputs: {
        structure: {
          'docs/': 'Generated documentation (markdown)',
          'src/': 'Code artifacts from agents',
          'config/': 'Schema and configuration files',
          'artifacts/': 'Other artifacts (documents, data, etc.)',
          'INDEX.md': 'Suite navigation and overview',
          'MANIFEST.json': 'This file - complete compilation manifest'
        },
        documents: documents.map(d => ({
          filename: d.filename,
          location: `docs/${d.filename}`,
          size: d.content.length,
          generated: true
        })),
        artifacts: packagedArtifacts ? {
          totalPackaged: packagedArtifacts.totalCopied,
          totalBytes: packagedArtifacts.totalBytes,
          byType: {
            code: { copied: packagedArtifacts.code.copied, failed: packagedArtifacts.code.failed },
            schemas: { copied: packagedArtifacts.schemas.copied, failed: packagedArtifacts.schemas.failed },
            documents: { copied: packagedArtifacts.documents.copied, failed: packagedArtifacts.documents.failed },
            other: { copied: packagedArtifacts.other.copied, failed: packagedArtifacts.other.failed }
          },
          errors: packagedArtifacts.errors
        } : null,
        totalDocSize: documents.reduce((sum, d) => sum + d.content.length, 0),
        totalArtifactSize: packagedArtifacts?.totalBytes || 0
      },
      
      compilation: {
        errors: this.compilationErrors,
        warnings: this.compilationWarnings,
        duration: null  // Set by BaseAgent
      }
    };
  }

  /**
   * Record compilation in memory
   */
  async recordCompilationInMemory(bundle, outputDir, sourceQueries) {
    if (!this.memory) {
      return;
    }
    
    const finding = `System package compiled: ${bundle.name} (${bundle.systemId}). ` +
      `Generated ${this.documentsGenerated.length} professional documents and packaged ` +
      `${bundle.metadata.totalArtifacts} artifacts${sourceQueries ? ` from ${sourceQueries.length} queries` : ''}. ` +
      `Output: ${path.relative(this.runDir, outputDir)} (self-contained package). ` +
      `Strategy: dual-substrate (queries=narrative, artifacts=technical).`;
    
    await this.addFinding(finding, 'document_compilation');
    
    // Record as deliverable
    this.results.push({
      type: 'deliverable',
      label: `System Package: ${bundle.name}`,
      path: outputDir,
      format: 'complete-system-package',
      documents: this.documentsGenerated.length,
      artifacts: bundle.metadata.totalArtifacts,
      systemId: bundle.systemId,
      createdAt: new Date().toISOString()
    });
  }
}

module.exports = { DocumentCompilerAgent };

