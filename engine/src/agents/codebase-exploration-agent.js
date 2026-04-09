const { BaseAgent } = require('./base-agent');
const { parseWithFallback } = require('../core/json-repair');
const path = require('path');

/**
 * CodebaseExplorationAgent - READ-ONLY codebase understanding specialist
 * 
 * Purpose:
 * - Explore and understand codebases without modification
 * - Perform comprehensive codebase audits
 * - Map architecture, dependencies, and patterns
 * - Identify technical debt, quality issues, and opportunities
 * - Build structured knowledge about code organization
 * 
 * Key Constraint: READ-ONLY
 * - No file creation
 * - No file modification
 * - No code execution
 * - Only reading, analyzing, and documenting
 * 
 * Use Cases:
 * - Initial codebase understanding
 * - Technical debt assessment
 * - Architecture documentation
 * - Code quality audits
 * - Onboarding new team members (understanding existing code)
 * - Pre-refactoring analysis
 */
class CodebaseExplorationAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    
    // Exploration state
    this.fileInventory = [];
    this.architectureMap = {};
    this.dependencyGraph = {};
    this.qualityMetrics = {};
    this.patterns = [];
    this.findings = [];
  }

  /**
   * Main execution logic - READ-ONLY codebase exploration
   */
  async execute() {
    this.logger.info('📖 CodebaseExplorationAgent: Starting read-only codebase exploration', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    });

    // NEW: Check existing knowledge about this codebase
    const existingKnowledge = await this.checkExistingKnowledge(
      this.mission.description,
      3
    );

    if (existingKnowledge?.hasKnowledge) {
      this.logger.info('📚 Found existing codebase knowledge', {
        relevantNodes: existingKnowledge.relevantNodes,
        recommendation: existingKnowledge.recommendation
      });
    }

    await this.reportProgress(5, 'Scanning codebase structure');

    // Step 1: Build file inventory (directories and files)
    const inventory = await this.scanCodebaseStructure();
    this.fileInventory = inventory;

    if (inventory.totalFiles === 0) {
      throw new Error('No files found in codebase - check MCP configuration');
    }

    await this.reportProgress(15, `Scanned ${inventory.totalFiles} files across ${inventory.directories.length} directories`);

    // Step 2: Identify key files (entry points, configs, docs)
    await this.reportProgress(20, 'Identifying key files and entry points');
    const keyFiles = await this.identifyKeyFiles(inventory);

    // Step 3: Analyze architecture and patterns
    await this.reportProgress(30, 'Analyzing architecture and code patterns');
    const architecture = await this.analyzeArchitecture(inventory, keyFiles);
    this.architectureMap = architecture;

    // Step 4: Map dependencies (imports, requires, modules)
    await this.reportProgress(45, 'Mapping dependencies and module structure');
    const dependencies = await this.mapDependencies(keyFiles);
    this.dependencyGraph = dependencies;

    // Step 5: Assess code quality and technical debt
    await this.reportProgress(60, 'Assessing code quality and technical debt');
    const quality = await this.assessQuality(keyFiles);
    this.qualityMetrics = quality;

    // Step 6: Identify patterns and anti-patterns
    await this.reportProgress(75, 'Identifying code patterns and conventions');
    const patterns = await this.identifyPatterns(keyFiles);
    this.patterns = patterns;

    // Step 7: Generate comprehensive audit report
    await this.reportProgress(85, 'Generating codebase audit report');
    const auditReport = await this.generateAuditReport({
      inventory,
      keyFiles,
      architecture,
      dependencies,
      quality,
      patterns
    });

    // Step 8: Store findings in memory
    await this.reportProgress(95, 'Storing findings in memory network');
    
    // Store structured inventory
    await this.addFinding(
      JSON.stringify({
        type: 'codebase_inventory',
        totalFiles: inventory.totalFiles,
        fileTypes: inventory.fileTypes,
        directories: inventory.directories,
        timestamp: new Date().toISOString()
      }),
      'codebase_inventory'
    );

    // Store architecture insights
    await this.addInsight(
      `Codebase Architecture: ${architecture.summary}`,
      'architecture_analysis'
    );

    // Store quality assessment
    await this.addInsight(
      `Code Quality Assessment: ${quality.summary}`,
      'quality_analysis'
    );

    // Store key patterns
    for (const pattern of patterns.slice(0, 5)) {
      await this.addInsight(pattern, 'code_pattern');
    }

    // Store audit report
    this.results.push({
      type: 'codebase_audit',
      auditReport,
      inventory: {
        totalFiles: inventory.totalFiles,
        fileTypes: inventory.fileTypes
      },
      architecture: architecture.summary,
      quality: quality.summary,
      patterns: patterns.length,
      timestamp: new Date()
    });

    await this.reportProgress(100, 'Codebase exploration complete');

    this.logger.info('✅ CodebaseExplorationAgent: Exploration complete', {
      agentId: this.agentId,
      filesScanned: inventory.totalFiles,
      keyFilesAnalyzed: keyFiles.length,
      patternsFound: patterns.length
    });

    return {
      success: true,
      filesScanned: inventory.totalFiles,
      keyFilesAnalyzed: keyFiles.length,
      patternsFound: patterns.length,
      auditReport
    };
  }

  /**
   * Scan codebase structure (directories and files)
   * READ-ONLY: Uses MCP to list directories
   */
  async scanCodebaseStructure() {
    this.logger.info('📂 Scanning codebase structure via MCP');

    try {
      // Start from root directory
      const rootItems = await this.listDirectoryViaMCP('.');
      
      const inventory = {
        totalFiles: 0,
        directories: [],
        fileTypes: {},
        filesByDirectory: {}
      };

      // Recursive directory traversal
      const visited = new Set();
      const queue = [{ path: '.', depth: 0 }];
      const maxDepth = 10; // Prevent infinite recursion
      const maxFiles = 1000; // Safety limit

      while (queue.length > 0 && inventory.totalFiles < maxFiles) {
        const { path: dirPath, depth } = queue.shift();

        if (visited.has(dirPath) || depth > maxDepth) continue;
        visited.add(dirPath);

        try {
          const items = await this.listDirectoryViaMCP(dirPath);
          
          const files = [];
          
          for (const item of items) {
            const fullPath = dirPath === '.' ? item.name : `${dirPath}/${item.name}`;
            
            // Skip common ignore patterns
            if (this.shouldIgnore(item.name, fullPath)) continue;

            if (item.type === 'directory') {
              inventory.directories.push(fullPath);
              queue.push({ path: fullPath, depth: depth + 1 });
            } else if (item.type === 'file') {
              const ext = path.extname(item.name).toLowerCase();
              
              files.push({
                name: item.name,
                path: fullPath,
                size: item.size,
                extension: ext,
                modified: item.modified
              });

              inventory.totalFiles++;
              inventory.fileTypes[ext] = (inventory.fileTypes[ext] || 0) + 1;
            }
          }

          if (files.length > 0) {
            inventory.filesByDirectory[dirPath] = files;
          }

        } catch (error) {
          this.logger.debug(`Skipping directory ${dirPath}: ${error.message}`);
          continue;
        }
      }

      this.logger.info('📊 Codebase scan complete', {
        totalFiles: inventory.totalFiles,
        directories: inventory.directories.length,
        fileTypes: Object.keys(inventory.fileTypes).length
      });

      return inventory;

    } catch (error) {
      this.logger.error('Failed to scan codebase structure', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Check if file/directory should be ignored
   */
  shouldIgnore(name, fullPath) {
    const ignorePatterns = [
      'node_modules',
      '.git',
      '.env',
      'dist',
      'build',
      'coverage',
      '.next',
      '__pycache__',
      'venv',
      '.pytest_cache',
      '.DS_Store'
    ];

    return ignorePatterns.some(pattern => 
      name === pattern || fullPath.includes(`/${pattern}/`) || fullPath.includes(`\\${pattern}\\`)
    );
  }

  /**
   * Identify key files (entry points, configs, README)
   * READ-ONLY: Analyzes file names and locations
   */
  async identifyKeyFiles(inventory) {
    this.logger.info('🔍 Identifying key files');

    const keyFiles = [];
    const allFiles = Object.values(inventory.filesByDirectory).flat();

    // Entry point patterns
    const entryPointPatterns = [
      /^index\.(js|ts|jsx|tsx|py)$/i,
      /^main\.(js|ts|py)$/i,
      /^app\.(js|ts|py)$/i,
      /^server\.(js|ts)$/i,
      /^__init__\.py$/i
    ];

    // Config file patterns
    const configPatterns = [
      /^package\.json$/i,
      /^tsconfig\.json$/i,
      /^setup\.py$/i,
      /^requirements\.txt$/i,
      /^Dockerfile$/i,
      /^docker-compose\.yml$/i,
      /\.config\.(js|ts)$/i
    ];

    // Documentation patterns
    const docPatterns = [
      /^README\.md$/i,
      /^CONTRIBUTING\.md$/i,
      /^ARCHITECTURE\.md$/i
    ];

    for (const file of allFiles) {
      let category = null;
      let priority = 0;

      // Check entry points
      if (entryPointPatterns.some(p => p.test(file.name))) {
        category = 'entry_point';
        priority = 10;
      }
      // Check configs
      else if (configPatterns.some(p => p.test(file.name))) {
        category = 'configuration';
        priority = 9;
      }
      // Check docs
      else if (docPatterns.some(p => p.test(file.name))) {
        category = 'documentation';
        priority = 8;
      }
      // Core source files
      else if (['.js', '.ts', '.py', '.java', '.go', '.rs'].includes(file.extension)) {
        category = 'source_code';
        priority = 5;
      }

      if (category) {
        keyFiles.push({
          ...file,
          category,
          priority
        });
      }
    }

    // Sort by priority (highest first)
    keyFiles.sort((a, b) => b.priority - a.priority);

    this.logger.info('📋 Key files identified', {
      total: keyFiles.length,
      byCategory: keyFiles.reduce((acc, f) => {
        acc[f.category] = (acc[f.category] || 0) + 1;
        return acc;
      }, {})
    });

    return keyFiles.slice(0, 50); // Limit to top 50 key files
  }

  /**
   * Analyze architecture from file structure and key files
   * READ-ONLY: Reads files to understand structure
   */
  async analyzeArchitecture(inventory, keyFiles) {
    this.logger.info('🏗️  Analyzing codebase architecture');

    // Read README for high-level understanding
    const readmeFile = keyFiles.find(f => /README\.md/i.test(f.name));
    let readmeContent = null;

    if (readmeFile) {
      try {
        readmeContent = await this.readFileViaMCP(readmeFile.path, 50 * 1024); // 50KB limit
        this.logger.debug('📄 Read README.md for context');
      } catch (error) {
        this.logger.debug('Could not read README.md');
      }
    }

    // Read package.json or setup.py for dependencies
    const configFile = keyFiles.find(f => 
      f.name === 'package.json' || f.name === 'setup.py'
    );
    
    let configContent = null;
    if (configFile) {
      try {
        configContent = await this.readFileViaMCP(configFile.path, 20 * 1024);
        this.logger.debug(`📄 Read ${configFile.name} for dependencies`);
      } catch (error) {
        this.logger.debug(`Could not read ${configFile.name}`);
      }
    }

    // Analyze with GPT-5.2
    const analysisPrompt = `You are analyzing a codebase structure for a comprehensive audit.

FILE INVENTORY:
- Total files: ${inventory.totalFiles}
- File types: ${Object.entries(inventory.fileTypes).map(([ext, count]) => `${ext}: ${count}`).join(', ')}
- Directories: ${inventory.directories.length}

KEY FILES FOUND:
${keyFiles.slice(0, 20).map(f => `- ${f.path} (${f.category})`).join('\n')}

${readmeContent ? `README CONTENT:\n${readmeContent.substring(0, 2000)}\n` : ''}

${configContent ? `CONFIG/DEPENDENCIES:\n${configContent.substring(0, 1000)}\n` : ''}

Based on this structure, provide a concise architectural analysis:

1. **Primary Language/Framework**: What is this codebase built with?
2. **Architecture Pattern**: What architectural pattern is used? (MVC, microservices, monolith, etc.)
3. **Key Components**: What are the main logical components/modules?
4. **Organization Strategy**: How is the code organized? (by feature, by layer, etc.)

Respond in JSON format:
{
  "primaryLanguage": "...",
  "framework": "...",
  "architecturePattern": "...",
  "components": ["component1", "component2", ...],
  "organizationStrategy": "...",
  "summary": "2-3 sentence overview of the architecture"
}`;

    try {
      const response = await this.callGPT5({
        model: 'gpt-5.2',
        instructions: analysisPrompt,
        messages: [{ role: 'user', content: 'Analyze this codebase architecture.' }],
        maxTokens: 4000,
        reasoningEffort: 'low' // Architectural analysis from structure
      });

      const parsed = parseWithFallback(response.content, 'object');
      
      if (parsed) {
        this.logger.info('🏛️  Architecture analyzed', {
          language: parsed.primaryLanguage,
          pattern: parsed.architecturePattern
        });
        return parsed;
      }

      // Fallback
      return {
        summary: 'Architecture analysis incomplete - see file inventory for structure',
        components: [],
        organizationStrategy: 'unknown'
      };

    } catch (error) {
      this.logger.error('Architecture analysis failed', { error: error.message });
      return {
        summary: 'Architecture analysis failed',
        components: [],
        organizationStrategy: 'unknown'
      };
    }
  }

  /**
   * Map dependencies by reading import statements
   * READ-ONLY: Analyzes imports/requires without execution
   */
  async mapDependencies(keyFiles) {
    this.logger.info('🔗 Mapping dependencies');

    const dependencies = {
      external: new Set(),
      internal: new Map(),
      summary: ''
    };

    // Read a sample of source files to find imports
    const sourceFiles = keyFiles
      .filter(f => f.category === 'source_code')
      .slice(0, 10); // Sample first 10 source files

    for (const file of sourceFiles) {
      try {
        const content = await this.readFileViaMCP(file.path, 100 * 1024); // 100KB limit
        
        // Extract imports (JavaScript/TypeScript)
        const importMatches = content.matchAll(/import\s+.*?from\s+['"](.+?)['"]/g);
        const requireMatches = content.matchAll(/require\(['"](.+?)['"]\)/g);
        
        // Extract imports (Python)
        const pythonImports = content.matchAll(/^import\s+(\w+)/gm);
        const pythonFromImports = content.matchAll(/^from\s+(\w+)/gm);

        // Collect all imports
        for (const match of [...importMatches, ...requireMatches]) {
          const imported = match[1];
          
          if (imported.startsWith('.') || imported.startsWith('/')) {
            // Internal/relative import
            const moduleList = dependencies.internal.get(file.path) || [];
            moduleList.push(imported);
            dependencies.internal.set(file.path, moduleList);
          } else {
            // External package
            dependencies.external.add(imported.split('/')[0]); // Get package name
          }
        }

        for (const match of [...pythonImports, ...pythonFromImports]) {
          const imported = match[1];
          if (!imported.startsWith('.')) {
            dependencies.external.add(imported);
          }
        }

      } catch (error) {
        this.logger.debug(`Could not read ${file.path} for dependencies`);
        continue;
      }
    }

    dependencies.summary = `Found ${dependencies.external.size} external dependencies and ${dependencies.internal.size} files with internal imports`;

    this.logger.info('📦 Dependencies mapped', {
      external: dependencies.external.size,
      internalFiles: dependencies.internal.size
    });

    return {
      external: Array.from(dependencies.external),
      internal: Object.fromEntries(dependencies.internal),
      summary: dependencies.summary
    };
  }

  /**
   * Assess code quality by analyzing patterns and structure
   * READ-ONLY: Static analysis only
   */
  async assessQuality(keyFiles) {
    this.logger.info('📊 Assessing code quality');

    const metrics = {
      totalFiles: keyFiles.length,
      hasTests: false,
      hasDocumentation: false,
      hasTypeScript: false,
      hasLinting: false,
      fileComplexity: {},
      summary: ''
    };

    // Check for test files
    metrics.hasTests = keyFiles.some(f => 
      f.path.includes('test') || 
      f.path.includes('spec') ||
      f.name.includes('.test.') ||
      f.name.includes('.spec.')
    );

    // Check for documentation
    metrics.hasDocumentation = keyFiles.some(f => 
      /README|CONTRIBUTING|docs?/i.test(f.path)
    );

    // Check for TypeScript
    metrics.hasTypeScript = keyFiles.some(f => 
      f.extension === '.ts' || f.extension === '.tsx'
    );

    // Check for linting config
    metrics.hasLinting = keyFiles.some(f => 
      f.name.includes('eslint') || 
      f.name.includes('prettier') ||
      f.name.includes('pylint')
    );

    // Sample a few source files for complexity analysis
    const sourceFiles = keyFiles
      .filter(f => f.category === 'source_code')
      .slice(0, 5);

    for (const file of sourceFiles) {
      try {
        const content = await this.readFileViaMCP(file.path, 50 * 1024);
        
        // Simple complexity heuristics
        const lines = content.split('\n').length;
        const functions = (content.match(/function\s+\w+|def\s+\w+|=>\s*{/g) || []).length;
        const complexity = functions > 0 ? lines / functions : lines;

        metrics.fileComplexity[file.path] = {
          lines,
          functions,
          avgComplexity: complexity
        };

      } catch (error) {
        continue;
      }
    }

    // Generate summary
    const qualityIndicators = [];
    if (metrics.hasTests) qualityIndicators.push('has tests');
    if (metrics.hasDocumentation) qualityIndicators.push('documented');
    if (metrics.hasTypeScript) qualityIndicators.push('type-safe');
    if (metrics.hasLinting) qualityIndicators.push('linted');

    metrics.summary = qualityIndicators.length > 0 
      ? `Code quality: ${qualityIndicators.join(', ')}`
      : 'Code quality: basic structure, could benefit from tests and documentation';

    this.logger.info('✅ Quality assessment complete', {
      hasTests: metrics.hasTests,
      hasDocumentation: metrics.hasDocumentation
    });

    return metrics;
  }

  /**
   * Identify code patterns and conventions
   * READ-ONLY: Pattern recognition
   */
  async identifyPatterns(keyFiles) {
    this.logger.info('🔍 Identifying code patterns');

    const patterns = [];

    // Sample source files
    const sourceFiles = keyFiles
      .filter(f => f.category === 'source_code')
      .slice(0, 5);

    const sampleCode = [];
    
    for (const file of sourceFiles) {
      try {
        const content = await this.readFileViaMCP(file.path, 30 * 1024);
        sampleCode.push({
          file: file.path,
          content: content.substring(0, 2000) // First 2KB
        });
      } catch (error) {
        continue;
      }
    }

    if (sampleCode.length === 0) {
      return ['No code samples available for pattern analysis'];
    }

    // Analyze patterns with GPT-5.2
    const patternPrompt = `Analyze these code samples for common patterns and conventions.

CODE SAMPLES:
${sampleCode.map(s => `\n--- ${s.file} ---\n${s.content}`).join('\n')}

Identify:
1. Naming conventions (camelCase, snake_case, etc.)
2. Code organization patterns
3. Common design patterns used
4. Error handling approaches
5. Documentation style

List 3-5 key patterns observed.

Respond with JSON array:
["Pattern 1: Description...", "Pattern 2: Description...", ...]`;

    try {
      const response = await this.callGPT5({
        model: 'gpt-5.2',
        instructions: patternPrompt,
        messages: [{ role: 'user', content: 'Identify code patterns.' }],
        maxTokens: 3000,
        reasoningEffort: 'low'
      });

      const parsed = parseWithFallback(response.content, 'array');
      
      if (Array.isArray(parsed)) {
        patterns.push(...parsed.slice(0, 5));
      } else {
        patterns.push('Pattern analysis incomplete - manual review recommended');
      }

    } catch (error) {
      this.logger.error('Pattern analysis failed', { error: error.message });
      patterns.push('Pattern analysis failed - see logs');
    }

    return patterns;
  }

  /**
   * Generate comprehensive audit report
   * Synthesizes all findings into actionable report
   */
  async generateAuditReport(data) {
    this.logger.info('📝 Generating comprehensive audit report');

    const reportPrompt = `Generate a comprehensive codebase audit report based on this analysis.

INVENTORY:
- Total files: ${data.inventory.totalFiles}
- File types: ${Object.entries(data.inventory.fileTypes).slice(0, 10).map(([k, v]) => `${k}: ${v}`).join(', ')}

ARCHITECTURE:
${data.architecture.summary || 'Not analyzed'}

DEPENDENCIES:
${data.dependencies.summary || 'Not analyzed'}

CODE QUALITY:
${data.quality.summary || 'Not assessed'}

PATTERNS OBSERVED:
${data.patterns.slice(0, 5).join('\n')}

Generate a structured audit report with:

1. **Executive Summary** (2-3 sentences)
2. **Codebase Overview** (architecture, size, complexity)
3. **Strengths** (what's done well)
4. **Areas for Improvement** (technical debt, missing pieces)
5. **Recommendations** (3-5 actionable items)

Keep it concise and actionable. Format as markdown.`;

    try {
      const response = await this.callGPT5({
        model: 'gpt-5.2',
        instructions: reportPrompt,
        messages: [{ role: 'user', content: 'Generate audit report.' }],
        maxTokens: 6000,
        reasoningEffort: 'medium' // Synthesis requires some reasoning
      });

      return response.content;

    } catch (error) {
      this.logger.error('Report generation failed', { error: error.message });
      
      // Fallback minimal report
      return `# Codebase Audit Report

## Summary
Analyzed ${data.inventory.totalFiles} files.

## Architecture
${data.architecture.summary || 'Not analyzed'}

## Quality
${data.quality.summary || 'Not assessed'}

## Recommendations
- Review patterns identified
- Consider adding tests if missing
- Document architecture if not present
`;
    }
  }

  /**
   * Called on successful completion
   */
  async onComplete() {
    this.logger.info('✅ CodebaseExplorationAgent completed successfully', {
      agentId: this.agentId,
      filesScanned: this.fileInventory.totalFiles,
      findingsStored: this.results.filter(r => r.type === 'finding').length,
      insightsStored: this.results.filter(r => r.type === 'insight').length
    });
  }
}

module.exports = { CodebaseExplorationAgent };
