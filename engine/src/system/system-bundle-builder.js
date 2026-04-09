const fs = require('fs').promises;
const path = require('path');

/**
 * SystemBundleBuilder - Declarative artifact collection for system documentation
 * 
 * Purpose:
 * - Collects and catalogs COSMO artifacts based on user-declared scope
 * - Creates deterministic, JSON-based system bundles
 * - Scoped collection (not filesystem sweeping)
 * - Reference-based (no file copying in v1)
 * 
 * Strategy:
 * - User declares systems (not auto-detected)
 * - Explicit scope parameters (runDir, agentTypes, timeRange)
 * - Artifact references (relativePath + absolutePath)
 * - Minimal memory collection (optional, non-heuristic)
 */
class SystemBundleBuilder {
  constructor(config, logger, capabilities = null) {
    this.config = config;
    this.logger = logger;
    this.capabilities = capabilities;
  }
  
  setCapabilities(capabilities) {
    this.capabilities = capabilities;
  }

  /**
   * Build a system bundle from specified scope
   * 
   * @param {string} systemId - User-declared system identifier (alphanumeric + dashes/underscores)
   * @param {object} options - Bundle creation options
   * @returns {Promise<{bundlePath: string, bundleDir: string, bundle: object}>}
   */
  async build(systemId, options = {}) {
    this.logger.info('📦 SystemBundleBuilder: Creating bundle', {
      systemId,
      hasOptions: Object.keys(options).length > 0
    });

    // Step 1: Validate and prepare inputs
    const validated = this.validateAndPrepareOptions(systemId, options);
    
    // Step 2: Create bundle directory
    const bundleDir = path.join(validated.runDir, 'systems', systemId);
    await fs.mkdir(bundleDir, { recursive: true });
    
    this.logger.debug('Bundle directory created', { bundleDir });

    // Step 3: Collect artifacts (SCOPED)
    const artifacts = await this.collectArtifacts(
      validated.runDir,
      validated.agentTypes,
      {
        selectedQueries: validated.selectedQueries || []
      }
    );
    
    this.logger.info('Artifacts collected', {
      code: artifacts.code.length,
      schemas: artifacts.schemas.length,
      documents: artifacts.documents.length,
      other: artifacts.other.length,
      total: artifacts.code.length + artifacts.schemas.length + 
             artifacts.documents.length + artifacts.other.length
    });

    // Step 4: Collect memory nodes (OPTIONAL)
    let memoryNodes = [];
    if (validated.includeMemory) {
      memoryNodes = await this.collectMinimalMemory(
        validated.runDir,
        validated.memoryNodeLimit
      );
      
      this.logger.debug('Memory nodes collected', { count: memoryNodes.length });
    }

    // Step 5: Collect context (queries metadata)
    const context = await this.collectContext(validated.runDir);

    // Step 6: Build bundle object
    const bundle = {
      bundleVersion: '1.0.0',
      systemId: systemId,
      name: validated.name,
      description: validated.description,
      createdAt: new Date().toISOString(),
      createdBy: 'user_declaration',
      
      scope: {
        runDir: validated.runDir,
        agentTypes: validated.agentTypes,
        memoryIncluded: validated.includeMemory
      },
      
      artifacts: artifacts,
      
      memoryNodes: memoryNodes,
      
      metadata: {
        totalArtifacts: artifacts.code.length + artifacts.schemas.length + 
                        artifacts.documents.length + artifacts.other.length,
        totalMemoryNodes: memoryNodes.length,
        notes: validated.notes
      },
      
      queryContext: options.queryContext || null
    };

    // Step 7: Write bundle file
    const bundlePath = path.join(bundleDir, 'system_bundle.json');
    await this.writeTextFile(
      bundlePath,
      JSON.stringify(bundle, null, 2),
      { agentId: 'system_bundle_builder', agentType: 'builder', missionGoal: `system:${systemId}` }
    );
    
    // Step 8 (optional): Write source queries file for DocumentCompilerAgent
    // (Only when build is query-driven)
    if (validated.selectedQueries && Array.isArray(validated.selectedQueries) && validated.selectedQueries.length > 0) {
      const queriesPath = path.join(bundleDir, 'source_queries.jsonl');
      const payload = validated.selectedQueries.map(q => JSON.stringify(q)).join('\n') + '\n';
      
      await this.writeTextFile(
        queriesPath,
        payload,
        { agentId: 'system_bundle_builder', agentType: 'builder', missionGoal: `system:${systemId}` }
      );
    }
    
    this.logger.info('✅ System bundle created', {
      systemId,
      bundlePath: path.relative(process.cwd(), bundlePath),
      totalArtifacts: bundle.metadata.totalArtifacts
    });

    return {
      bundlePath,
      bundleDir,
      bundle
    };
  }
  
  /**
   * Write a text file, optionally via Capabilities (Executive-gated when available)
   * @private
   */
  async writeTextFile(absPath, content, agentContext = {}) {
    // Prefer embodied write when available (agent/orchestrator context)
    if (this.capabilities && this.capabilities.writeFile) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), absPath),
        content,
        agentContext
      );
      
      // Respect Executive skip (do not bypass)
      if (result?.success || result?.skipped) return;
      
      throw new Error(result?.error || result?.reason || 'Builder write failed');
    }
    
    // Fallback (dashboard context)
    await fs.writeFile(absPath, content, 'utf-8');
  }

  /**
   * Validate inputs and apply defaults
   */
  validateAndPrepareOptions(systemId, options) {
    // Validate systemId
    if (!systemId || typeof systemId !== 'string') {
      throw new Error('Invalid systemId: must be a non-empty string');
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(systemId)) {
      throw new Error('Invalid systemId: must be alphanumeric with dashes/underscores only');
    }
    
    if (systemId.includes('..') || systemId.includes('/') || systemId.includes('\\')) {
      throw new Error('Invalid systemId: cannot contain path traversal characters');
    }

    // Apply defaults
    const defaults = {
      runDir: this.config.logsDir || path.join(process.cwd(), 'runtime'),
      name: systemId,
      description: '',
      agentTypes: [
        'code-creation',
        'code-execution',
        'document-creation',
        'document-analysis',
        'synthesis',
        'analysis'
      ],
      includeMemory: false,
      memoryNodeLimit: 20,
      selectedQueries: [], // NEW: For query-driven artifact collection
      notes: ''
    };

    const validated = { ...defaults, ...options };
    
    // Sanitize string inputs
    validated.description = (validated.description || '').trim().substring(0, 1000);
    validated.notes = (validated.notes || '').trim().substring(0, 5000);

    return validated;
  }

  /**
   * Collect artifacts from specified agent types (SCOPED)
   * 
   * @param {string} runDir - Run directory to scan
   * @param {string[]} agentTypes - Agent types to include
   * @param {object} options - Collection options (selectedQueries for query-driven mode)
   * @returns {Promise<{code: Array, schemas: Array, documents: Array, other: Array}>}
   */
  async collectArtifacts(runDir, agentTypes, options = {}) {
    const { selectedQueries = [] } = options;
    
    // QUERY-DRIVEN MODE: Only collect artifacts mentioned in/created by selected queries
    if (selectedQueries.length > 0) {
      this.logger.info('Query-driven artifact collection mode', {
        queryCount: selectedQueries.length
      });
      return await this.collectQueryRelatedArtifacts(runDir, selectedQueries);
    }
    
    // FULL-RUN MODE: Collect all artifacts from specified agent types
    this.logger.info('Full-run artifact collection mode', {
      agentTypes: agentTypes.length
    });
    
    const artifacts = {
      code: [],
      schemas: [],
      documents: [],
      other: []
    };

    const outputsDir = path.join(runDir, 'outputs');
    
    // Verify outputs directory exists
    try {
      await fs.access(outputsDir);
    } catch {
      this.logger.warn('No outputs directory found', { outputsDir });
      return artifacts;  // Return empty but valid structure
    }

    // CRITICAL: Only scan specified agent types (scoped collection)
    for (const agentType of agentTypes) {
      const agentTypeDir = path.join(outputsDir, agentType);
      
      try {
        await fs.access(agentTypeDir);
      } catch {
        // Agent type not present in this run - skip silently
        continue;
      }

      try {
        const agentIds = await fs.readdir(agentTypeDir);
        
        for (const agentId of agentIds) {
          const agentDir = path.join(agentTypeDir, agentId);
          
          // Verify it's a directory
          try {
            const stat = await fs.stat(agentDir);
            if (!stat.isDirectory()) continue;
          } catch {
            continue;
          }

          // Recursively scan this agent's output
          const files = await this.scanDirectory(agentDir);
          
          for (const file of files) {
            const artifact = {
              source: agentType,
              agentId: agentId,
              filename: path.basename(file.path),
              relativePath: path.relative(runDir, file.path),
              absolutePath: file.path,
              size: file.size,
              type: this.classifyFile(path.basename(file.path))
            };
            
            // Categorize by type
            const category = artifact.type;
            if (artifacts[category]) {
              artifacts[category].push(artifact);
            }
          }
        }
      } catch (error) {
        this.logger.warn(`Error scanning agent type ${agentType}`, {
          error: error.message
        });
        // Continue with other agent types
      }
    }

    return artifacts;
  }

  /**
   * Recursively scan directory and return file list
   * 
   * @param {string} dir - Directory to scan
   * @returns {Promise<Array<{name: string, path: string, size: number}>>}
   */
  async scanDirectory(dir) {
    const files = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip hidden and debug directories
          if (entry.name.startsWith('.') || entry.name.startsWith('_debug')) {
            continue;
          }
          
          // Recurse into subdirectory
          try {
            const subFiles = await this.scanDirectory(fullPath);
            files.push(...subFiles);
          } catch (error) {
            this.logger.warn(`Skipped directory ${entry.name}`, {
              error: error.message
            });
            // Continue with other directories
          }
        } else {
          // Regular file
          // Skip hidden and temp files
          if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) {
            continue;
          }
          
          try {
            const stat = await fs.stat(fullPath);
            files.push({
              name: entry.name,
              path: fullPath,
              size: stat.size
            });
          } catch (error) {
            this.logger.warn(`Skipped file ${entry.name}`, {
              error: error.message
            });
            // Continue with other files
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Error scanning directory ${dir}`, {
        error: error.message
      });
      // Return whatever we collected so far
    }

    return files;
  }

  /**
   * Classify file by extension
   * 
   * @param {string} filename - File name
   * @returns {string} - Category: 'code', 'schemas', 'documents', or 'other'
   */
  classifyFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    
    // Code files
    const codeExtensions = ['.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.go', 
                            '.rs', '.cpp', '.c', '.h', '.hpp', '.cs', '.rb', 
                            '.php', '.swift', '.kt', '.scala'];
    if (codeExtensions.includes(ext)) {
      return 'code';
    }
    
    // Schema/configuration files
    const schemaExtensions = ['.json', '.yaml', '.yml', '.xml', '.toml', '.ini', '.conf'];
    if (schemaExtensions.includes(ext)) {
      return 'schemas';
    }
    
    // Document files
    const docExtensions = ['.md', '.txt', '.html', '.htm', '.rst', '.adoc'];
    if (docExtensions.includes(ext)) {
      return 'documents';
    }
    
    // Everything else
    return 'other';
  }

  /**
   * Collect minimal memory context (optional, non-heuristic)
   * 
   * @param {string} runDir - Run directory
   * @param {number} limit - Maximum memory nodes to collect
   * @returns {Promise<Array>}
   */
  async collectMinimalMemory(runDir, limit = 20) {
    const thoughtsPath = path.join(runDir, 'thoughts.jsonl');
    
    try {
      const content = await fs.readFile(thoughtsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      // Take last N lines (most recent)
      const recentLines = lines.slice(-limit);
      
      const memoryNodes = recentLines.map((line, idx) => {
        try {
          const thought = JSON.parse(line);
          return {
            index: idx,
            thought: thought.thought?.substring(0, 200),  // Truncate to 200 chars
            timestamp: thought.timestamp
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
      
      return memoryNodes;
    } catch (error) {
      // No thoughts file or read error - not fatal
      this.logger.debug('No memory nodes collected', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Collect context metadata (goals, queries)
   * 
   * @param {string} runDir - Run directory
   * @returns {Promise<{goals: Array, queries: Array}>}
   */
  async collectContext(runDir) {
    const context = {
      goals: [],
      queries: []
    };

    // Collect query metadata from queries.jsonl
    const queriesPath = path.join(runDir, 'queries.jsonl');
    
    try {
      const content = await fs.readFile(queriesPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      // Last 10 queries metadata (not full answers - those go in source_queries.jsonl)
      context.queries = lines.slice(-10).map(line => {
        try {
          const q = JSON.parse(line);
          return {
            timestamp: q.timestamp,
            query: q.query,
            model: q.model,
            mode: q.mode
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (error) {
      // No queries file - not fatal
      this.logger.debug('No queries context collected', {
        error: error.message
      });
    }

    return context;
  }
  
  /**
   * Collect artifacts related to specific queries (INTENT-BASED)
   * Includes: 1) Code blocks from answers, 2) Files created/referenced by queries
   * 
   * @param {string} runDir - Run directory
   * @param {Array} selectedQueries - Query objects with answers
   * @returns {Promise<{code: Array, schemas: Array, documents: Array, other: Array}>}
   */
  async collectQueryRelatedArtifacts(runDir, selectedQueries) {
    const artifacts = {
      code: [],
      schemas: [],
      documents: [],
      other: []
    };
    
    const seenPaths = new Set(); // Prevent duplicates
    const seenContent = new Set(); // Prevent duplicate embedded content
    
    this.logger.info('Collecting query-related artifacts from answers', {
      queryCount: selectedQueries.length
    });
    
    for (const query of selectedQueries) {
      const answer = query.answer || '';
      
      // SOURCE 1: Extract code blocks embedded in answer (PRIMARY)
      const codeBlocks = this.extractCodeBlocksFromAnswer(answer);
      
      this.logger.debug(`Query "${query.query.substring(0, 40)}..." has ${codeBlocks.length} code blocks`);
      
      for (const block of codeBlocks) {
        const contentHash = block.code.substring(0, 100); // Simple dedup
        if (seenContent.has(contentHash)) continue;
        seenContent.add(contentHash);
        
        const filename = this.inferFilenameFromQuery(query.query, block.language);
        const category = this.classifyFileByLanguage(block.language);
        
        artifacts[category].push({
          source: 'query-answer',
          agentId: 'embedded',
          filename: filename,
          content: block.code,  // Embedded content (not file path)
          size: block.code.length,
          type: category,
          origin: 'query-answer-embedded',
          embedded: true  // Flag for packaging
        });
        
        this.logger.debug(`  ✓ Extracted code block: ${filename} (${(block.code.length/1024).toFixed(1)}KB)`);
      }
      
      // SOURCE 2: Files created by query actions (SECONDARY)
      // Only include files from query.actionResult (explicitly created)
      // NOT files mentioned in answer text (those are citations, not deliverables)
      if (query.actionResult && query.actionResult.filesCreated) {
        this.logger.debug(`Query has ${query.actionResult.filesCreated.length} action-created files`);
        
        for (const fileInfo of query.actionResult.filesCreated) {
          const filePath = fileInfo.path || fileInfo;
          
          if (seenPaths.has(filePath)) continue;
          seenPaths.add(filePath);
          
          try {
            const fullPath = path.join(runDir, filePath);
            const stat = await fs.stat(fullPath);
            
            if (!stat.isFile()) continue;
            
            const artifact = {
              source: 'query-action',
              agentId: 'action-created',
              filename: path.basename(filePath),
              relativePath: filePath,
              absolutePath: fullPath,
              size: stat.size,
              type: this.classifyFile(path.basename(filePath)),
              origin: 'query-action-created',
              embedded: false  // From filesystem
            };
            
            const category = artifact.type;
            if (artifacts[category]) {
              artifacts[category].push(artifact);
            }
            
            this.logger.debug(`  ✓ Added action-created file: ${filePath} (${(stat.size/1024).toFixed(1)}KB)`);
            
          } catch (error) {
            this.logger.debug(`  ✗ Action-created file not found: ${filePath}`);
          }
        }
      }
    }
    
    const total = artifacts.code.length + artifacts.schemas.length + 
                  artifacts.documents.length + artifacts.other.length;
    
    this.logger.info('Query-driven collection complete', {
      total,
      fromAnswers: artifacts.code.filter(a => a.embedded).length +
                   artifacts.schemas.filter(a => a.embedded).length +
                   artifacts.documents.filter(a => a.embedded).length,
      fromFiles: total - (artifacts.code.filter(a => a.embedded).length +
                         artifacts.schemas.filter(a => a.embedded).length +
                         artifacts.documents.filter(a => a.embedded).length),
      code: artifacts.code.length,
      schemas: artifacts.schemas.length,
      documents: artifacts.documents.length,
      other: artifacts.other.length
    });
    
    return artifacts;
  }
  
  /**
   * Extract file paths from query answer text
   * Finds references to outputs/* files
   * 
   * @param {string} answer - Query answer text
   * @returns {Array<string>} - Array of file paths (relative to runDir)
   */
  extractFilePathsFromAnswer(answer) {
    const paths = new Set();
    
    // Pattern: outputs/path/to/file.ext
    // Matches: outputs/code-creation/agent_123/file.py
    //          outputs/web-assets/query_456/page.html
    const pathRegex = /outputs\/[\w/-]+\.[\w]+/g;
    const matches = answer.matchAll(pathRegex);
    
    for (const match of matches) {
      paths.add(match[0]);
    }
    
    this.logger.debug('Extracted file paths from answer', {
      count: paths.size
    });
    
    return Array.from(paths);
  }
  
  /**
   * Extract code blocks from query answer
   * 
   * @param {string} answer - Query answer text
   * @returns {Array<{language: string, code: string}>} - Code blocks
   */
  extractCodeBlocksFromAnswer(answer) {
    const blocks = [];
    const codeBlockRegex = /```(\w+)?\s*\n([\s\S]*?)\n```/g;
    let match;
    
    while ((match = codeBlockRegex.exec(answer)) !== null) {
      const language = match[1] || 'text';
      const code = match[2].trim();
      
      // Skip tiny snippets (< 100 chars)
      if (code.length < 100) continue;
      
      // Validate it's a complete file
      if (this.isCompleteCodeBlock(code, language)) {
        blocks.push({ language, code });
      }
    }
    
    this.logger.debug('Extracted code blocks from answer', {
      count: blocks.length
    });
    
    return blocks;
  }
  
  /**
   * Check if code block is a complete file (not a snippet)
   */
  isCompleteCodeBlock(code, language) {
    if (language === 'html' || language === 'htm') {
      return code.includes('<!DOCTYPE') || code.includes('<html');
    }
    if (language === 'python' || language === 'py') {
      return code.includes('def ') || code.includes('class ') || code.length > 200;
    }
    if (language === 'javascript' || language === 'js') {
      return code.includes('function ') || code.includes('const ') || code.length > 200;
    }
    if (language === 'json') {
      try {
        JSON.parse(code);
        return true;
      } catch {
        return false;
      }
    }
    
    // For other types, use size heuristic
    return code.length > 150;
  }
  
  /**
   * Infer filename from query and code language
   */
  inferFilenameFromQuery(query, language) {
    // Extract subject from query
    const subjectPatterns = [
      /\b(?:of|for|about|showing)\s+(?:the\s+)?([a-z0-9 _-]+?)(?:\s|$)/i,
      /\b(?:create|make|generate)\s+(?:an?\s+)?\w+\s+(?:of|for|showing)\s+([a-z0-9 _-]+)/i,
      /\b([a-z0-9 _-]{3,})\s+(?:diagram|visualization|system|design)/i
    ];
    
    let subject = 'artifact';
    for (const pattern of subjectPatterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        subject = match[1].trim().toLowerCase().replace(/\s+/g, '_').substring(0, 40);
        break;
      }
    }
    
    // Map language to extension
    const extensions = {
      html: 'html', htm: 'html',
      python: 'py', py: 'py',
      javascript: 'js', js: 'js',
      json: 'json',
      css: 'css',
      yaml: 'yaml', yml: 'yaml',
      markdown: 'md', md: 'md',
      svg: 'svg',
      xml: 'xml',
      bash: 'sh', sh: 'sh'
    };
    
    const ext = extensions[language.toLowerCase()] || 'txt';
    return `${subject}.${ext}`;
  }
  
  /**
   * Classify file by language/extension
   */
  classifyFileByLanguage(language) {
    const codeLanguages = ['python', 'py', 'javascript', 'js', 'java', 'go', 'rust', 'cpp', 'c'];
    const schemaLanguages = ['json', 'yaml', 'yml', 'xml', 'toml'];
    const docLanguages = ['html', 'htm', 'markdown', 'md', 'txt'];
    
    const lang = language.toLowerCase();
    
    if (codeLanguages.includes(lang)) return 'code';
    if (schemaLanguages.includes(lang)) return 'schemas';
    if (docLanguages.includes(lang)) return 'documents';
    
    return 'other';
  }
}

module.exports = { SystemBundleBuilder };

