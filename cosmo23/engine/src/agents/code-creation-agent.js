const { BaseAgent } = require('./base-agent');
const { DeliverableManifest } = require('./deliverable-manifest');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

/**
 * CodeCreationAgent - Actual code generation specialist
 *
 * Purpose:
 * - Creates real, functional code files based on requirements
 * - Generates scripts, applications, modules, and programs
 * - Handles multiple programming languages and frameworks
 * - Creates complete, runnable code with proper structure
 * - Integrates with existing systems for file creation
 *
 * Use Cases:
 * - Generate utility scripts and tools
 * - Create web applications and APIs
 * - Build data processing scripts
 * - Develop automation scripts
 * - Create command-line tools
 * - Generate configuration files and templates
 */
class CodeCreationAgent extends BaseAgent {
  /**
   * Agent behavioral prompt (Layer 2) — HOW this agent works.
   * Prepended to system prompt for the first LLM call; used standalone for subsequent calls.
   */
  getAgentBehavioralPrompt() {
    return `## CodeCreationAgent Behavioral Specification

You generate production-quality code files. Write working code, not descriptions of code.
Test what you write. Every file must be complete, runnable, and well-documented.

Creation protocol:
1. Parse requirements — language, type, structure, dependencies.
2. Plan files — enumerate every file with path, purpose, category.
3. Generate each file in a single pass — no stubs, no TODOs, no placeholders.
4. Validate — run tests or syntax checks where possible.
5. Download artifacts to persistent output directory.

Output: code files that execute correctly. Plan manifest tracks status of every file.
Prefer fewer, complete files over many partial ones. Always include error handling.`;
  }

  constructor(mission, config, logger) {
    super(mission, config, logger);
    this.supportedLanguages = [
      'javascript', 'typescript', 'python', 'bash', 'shell',
      'html', 'css', 'json', 'yaml', 'xml', 'sql',
      'go', 'rust', 'java', 'csharp', 'php', 'ruby'
    ];
    this.codeTemplates = new Map();
    this.createdFiles = [];
    // Execution backend for code generation (container or local)
    this.executionBackend = this.createExecutionBackend();
    // Keep containerId for backward compatibility
    this.containerId = null;
    this.generatedFiles = [];
    this.planManifest = null;
    this.planSessionStamp = null;
    this.planConfigCache = null;
    this.currentSpec = null;
  }
  
  /**
   * Create execution backend based on config
   * Defaults to container for backward compatibility
   */
  createExecutionBackend() {
    const backendType = this.config?.execution?.backend || 
                        this.config?.architecture?.codeCreation?.backend || 
                        'local'; // Default to local for testing (can change back to container if issues)
    
    if (backendType === 'local') {
      const { LocalPythonBackend } = require('./execution/execution-backend');
      return new LocalPythonBackend(this.config, this.logger, this.gpt5);
    } else {
      const { ContainerBackend } = require('./execution/execution-backend');
      return new ContainerBackend(this.gpt5, this.logger);
    }
  }

  shouldUsePlanMode() {
    const flag = this.config?.architecture?.codeCreation?.planMode;
    return flag !== false;
  }

  /**
   * Initialize code generation resources and container
   */
  async onStart() {
    await super.onStart();
    await this.reportProgress(5, 'Initializing code creation resources');

    // Load code templates and patterns
    await this.loadCodeTemplates();

    // Query memory for existing code patterns
    const codeKnowledge = await this.queryMemoryForKnowledge(20);

    if (codeKnowledge.length > 0) {
      this.logger.info('💻 Found existing code patterns in memory', {
        patternsFound: codeKnowledge.length,
        topMatches: codeKnowledge.slice(0, 3).map(n => ({
          similarity: n.similarity?.toFixed(3),
          concept: n.concept?.substring(0, 60)
        }))
      });
    }

    // Initialize execution backend (container or local)
    try {
      this.logger.info(`🔧 Initializing ${this.executionBackend.getBackendType()} execution backend...`);
      await this.executionBackend.initialize();
      // For backward compat, set containerId if container backend
      if (this.executionBackend.getBackendType() === 'container') {
        this.containerId = this.executionBackend.containerId;
      }
      this.logger.info('✅ Execution backend ready', { 
        type: this.executionBackend.getBackendType(),
        containerId: this.containerId
      }, 3);
    } catch (error) {
      this.logger.error('❌ Failed to initialize execution backend', { error: error.message }, 3);
      throw new Error(`Execution backend initialization failed: ${error.message}`);
    }

    await this.reportProgress(15, 'Code creation agent ready');
  }

  /**
   * Main execution logic for code creation
   */
  async execute() {
    this.logger.info('💻 CodeCreationAgent: Starting code creation mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    });

    const preFlightData = await this.gatherPreFlightContext();

    // Parse mission to determine code requirements
    const codeSpec = await this.parseCodeRequirements();

    // Reset per-run state
    this.currentSpec = codeSpec;
    this.generatedFiles = [];
    this.planManifest = null;
    this.planSessionStamp = null;
    this.planConfigCache = null;

    await this.reportProgress(25, `Creating ${codeSpec.language} ${codeSpec.type} files in container`);

    let codeResult;
    if (this.shouldUsePlanMode()) {
      codeResult = await this.generateCodeWithPlan(codeSpec);
    } else {
      codeResult = await this.generateCode(codeSpec);
    }

    await this.reportProgress(80, 'Code files generated, downloading from container');

    // CRITICAL: Download files BEFORE reporting completion
    // This ensures DoD validation sees actual files on disk
    let savedFiles = [];
    if (this.executionBackend) {
      try {
        savedFiles = await this.downloadAndSaveGeneratedFiles();
        this.savedFiles = savedFiles; // Store for onComplete() to use
        this.logger.info('✅ Files downloaded from container', {
          filesDownloaded: savedFiles.length,
          filesAnnotated: this.generatedFiles.length
        }, 3);
      } catch (error) {
        this.logger.error('Failed to download files from container', {
          error: error.message,
          containerId: this.containerId
        });
        // Continue - cleanup will retry if needed
      }
    }

    await this.reportProgress(100, 'Code creation completed');

    return {
      success: codeResult.success,
      filesGenerated: this.generatedFiles.length,
      metadata: {
        language: codeSpec.language,
        type: codeSpec.type,
        projectName: codeSpec.projectName,
        filesCreated: savedFiles.length, // Actual files saved, not just annotated
        status: 'complete',
        createdAt: new Date()
      }
    };
  }

  /**
   * Parse mission description to determine code requirements
   */
  async parseCodeRequirements() {
    const missionText = this.mission.description.toLowerCase();

    // Determine programming language (prefer explicit mentions, default to python)
    const languageAliases = {
      javascript: ['javascript', 'js', 'node', 'node.js'],
      typescript: ['typescript', 'ts', 'type script'],
      python: ['python', 'py', 'python3'],
      bash: ['bash', 'shell', 'sh'],
      shell: ['shell script'],
      html: ['html'],
      css: ['css', 'stylesheet'],
      json: ['json'],
      yaml: ['yaml', 'yml'],
      xml: ['xml'],
      sql: ['sql', 'database query'],
      go: ['golang', 'go'],
      rust: ['rust'],
      java: ['java'],
      csharp: ['c#', 'csharp', '.net'],
      php: ['php'],
      ruby: ['ruby']
    };

    let language = 'python';
    outer: for (const [lang, aliases] of Object.entries(languageAliases)) {
      for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(this.mission.description)) {
          language = lang;
          break outer;
        }
      }
    }

    // Determine code type
    let codeType = 'script';
    if (missionText.includes('web app') || missionText.includes('website') || missionText.includes('html')) {
      codeType = 'web_application';
    } else if (missionText.includes('api') || missionText.includes('server') || missionText.includes('backend')) {
      codeType = 'api_server';
    } else if (missionText.includes('command line') || missionText.includes('cli') || missionText.includes('tool')) {
      codeType = 'cli_tool';
    } else if (missionText.includes('library') || missionText.includes('module') || missionText.includes('package')) {
      codeType = 'library';
    } else if (missionText.includes('automation') || missionText.includes('bot') || missionText.includes('scraper')) {
      codeType = 'automation_script';
    } else if (missionText.includes('data') && missionText.includes('process')) {
      codeType = 'data_processor';
    } else if (missionText.includes('config') || missionText.includes('template')) {
      codeType = 'configuration';
    }

    // Extract project name/title
    const nameMatch = this.mission.description.match(/create\s+(?:a\s+)?(.+?)(?:\s+script|\s+application|\s+tool|\s+program|$)/i) ||
                     this.mission.description.match(/title:\s*"([^"]+)"/i) ||
                     this.mission.description.match(/name:\s*"([^"]+)"/i);

    const projectName = nameMatch ? nameMatch[1] : `generated_${codeType}_${Date.now()}`;

    // Determine complexity and features
    const complexity = this.determineComplexity(missionText);
    const features = this.extractFeatures(missionText);

    // Determine output directory using PathResolver if available
    let runOutputDir;
    const deliverableSpec = this.mission?.deliverable;
    
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver.getDeliverablePath > pathResolver.getOutputsRoot > config.logsDir > error
    if (this.pathResolver && deliverableSpec) {
      try {
        const paths = this.pathResolver.getDeliverablePath({
          deliverableSpec,
          agentType: 'code-creation',
          agentId: this.agentId,
          fallbackName: projectName
        });
        runOutputDir = paths.directory;
      } catch (error) {
        this.logger.warn('PathResolver.getDeliverablePath failed, using getOutputsRoot fallback', {
          error: error.message
        });
          runOutputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
      }
    } else if (this.pathResolver) {
        runOutputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
    } else if (this.config?.logsDir) {
      runOutputDir = path.join(this.config.logsDir, 'outputs', 'code-creation', this.agentId);
      } else {
      // Critical: Don't fall back to process.cwd() - it breaks multi-tenant isolation
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }

    return {
      language,
      type: codeType,
      projectName,
      complexity,
      features,
      requirements: this.extractRequirements(missionText),
      outputDir: runOutputDir
    };
  }

  /**
   * Determine code complexity from requirements
   */
  determineComplexity(text) {
    if (text.includes('complex') || text.includes('advanced') || text.includes('enterprise')) {
      return 'advanced';
    }
    if (text.includes('simple') || text.includes('basic') || text.includes('minimal')) {
      return 'basic';
    }
    return 'intermediate';
  }

  /**
   * Extract features from requirements
   */
  extractFeatures(text) {
    const features = [];

    if (text.includes('database') || text.includes('db') || text.includes('sql')) {
      features.push('database');
    }
    if (text.includes('api') || text.includes('rest') || text.includes('http')) {
      features.push('api');
    }
    if (text.includes('authentication') || text.includes('auth') || text.includes('login')) {
      features.push('authentication');
    }
    if (text.includes('ui') || text.includes('interface') || text.includes('frontend')) {
      features.push('user_interface');
    }
    if (text.includes('test') || text.includes('testing')) {
      features.push('testing');
    }
    if (text.includes('config') || text.includes('configuration')) {
      features.push('configuration');
    }
    if (text.includes('logging') || text.includes('log')) {
      features.push('logging');
    }
    if (text.includes('error') && text.includes('handling')) {
      features.push('error_handling');
    }

    return features;
  }

  /**
   * Extract specific requirements
   */
  extractRequirements(text) {
    const requirements = [];

    if (text.includes('unit tests') || text.includes('test coverage')) {
      requirements.push('include_tests');
    }
    if (text.includes('documentation') || text.includes('readme')) {
      requirements.push('include_documentation');
    }
    if (text.includes('examples') || text.includes('demo')) {
      requirements.push('include_examples');
    }
    if (text.includes('docker') || text.includes('container')) {
      requirements.push('include_docker');
    }
    if (text.includes('ci/cd') || text.includes('pipeline')) {
      requirements.push('include_ci_cd');
    }

    return requirements;
  }

  /**
   * Generate code using code_interpreter (creates ACTUAL files in container)
   * This ensures complete, runnable code files instead of text descriptions
   */
  async generateCode(spec) {
    this.logger.info('💻 Generating code files in container using code_interpreter...');

    // Gather relevant context from memory
    const context = await this.gatherCodeContext(spec);

    // Build prompt that instructs model to write actual files
    const prompt = this.buildFileCreationPrompt(spec, context);
    const debugStamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.writeDebugArtifact(spec, debugStamp, 'prompt.txt', prompt);

    try {
      const response = await this.executionBackend.executeCode({
        input: prompt,
        max_output_tokens: 16000, // API maximum output limit (prevents response.incomplete during file writing)
        reasoningEffort: 'low', // Lower effort reduces chance of interruption
        retryCount: 3
      });

      await this.writeDebugArtifact(spec, debugStamp, 'response.json', response, { json: true });

      const isIncomplete = response?.errorType === 'response.incomplete';
      const contentIsErrorMessage = typeof response?.content === 'string'
        && response.content.trim().startsWith('[Error:');
      const treatContentAsFatal = contentIsErrorMessage && !isIncomplete;

      if (isIncomplete) {
        this.logger.warn('⚠️ Code interpreter response ended with response.incomplete; attempting to recover generated files', {
          debugStamp,
          outputTokens: response?.usage?.output_tokens
        }, 3);
      }

      if (!isIncomplete && (response?.hadError || (response?.errorType && response.errorType !== 'none'))) {
        this.logger.error('Code interpreter execution failed', {
          errorType: response.errorType || 'unknown',
          hadError: response.hadError,
          debugStamp
        });
        throw new Error(`Code interpreter returned ${response.errorType || 'no output'} (debug ${debugStamp})`);
      }

      if (treatContentAsFatal) {
        this.logger.error('Code interpreter execution returned error content', {
          contentPreview: response.content?.slice(0, 120),
          debugStamp
        });
        throw new Error(`Code interpreter returned error content (debug ${debugStamp})`);
      }

      // Extract generated files from annotations
      const executionRecord = {
        timestamp: new Date(),
        content: response.content,
        reasoning: response.reasoning,
        codeResults: response.codeResults || [],
        hadError: response.hadError && !isIncomplete
      };

      // Track generated files
      if (response.codeResults) {
        for (const result of response.codeResults) {
          if (result.files && result.files.length > 0) {
            this.generatedFiles.push(...result.files);
          }
        }
      }

      const filesGenerated = this.generatedFiles.length;

      if (filesGenerated === 0) {
        this.logger.warn('⚠️ Code interpreter completed without annotated files; downstream download will rely on container listing', {
          hadError: executionRecord.hadError,
          responseIncomplete: isIncomplete,
          debugStamp
        }, 3);
      } else {
        this.logger.info('✅ Code files generated in container', {
          filesGenerated,
          hadError: executionRecord.hadError,
          responseIncomplete: isIncomplete
        }, 3);
      }

      return {
        executionRecord,
        filesGenerated,
        success: !executionRecord.hadError || isIncomplete
      };
    } catch (error) {
      await this.writeDebugArtifact(spec, debugStamp, 'error.txt', `${error.message}\n${error.stack || ''}`);
      this.logger.error('Code generation failed', { error: error.message }, 3);
      throw error;
    }
  }

  getPlanConfiguration() {
    if (this.planConfigCache) {
      return this.planConfigCache;
    }

    const defaults = {
      maxOutputTokensPerCall: 16000, // API maximum output limit (prevents response.incomplete)
      perFileRetryLimit: 2,
      planRetryLimit: 1,
      planMaxOutputTokens: 16000, // Also increased for plan generation
      reasoningEffort: 'low'
    };

    const cfg = this.config?.architecture?.codeCreation || {};
    const ensurePositive = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? num : fallback;
    };
    const ensureNonNegativeInt = (value, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return fallback;
      }
      const intVal = Math.floor(num);
      return intVal >= 0 ? intVal : fallback;
    };
    const sanitizeEffort = effort => {
      const value = typeof effort === 'string' ? effort.toLowerCase() : defaults.reasoningEffort;
      // GPT-5.2 supports 'none', 'low', 'medium', 'high', and 'xhigh' reasoning effort
      return ['none', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : defaults.reasoningEffort;
    };

    this.planConfigCache = {
      maxOutputTokensPerCall: ensurePositive(
        cfg.maxOutputTokensPerCall ?? cfg.max_output_tokens_per_call,
        defaults.maxOutputTokensPerCall
      ),
      perFileRetryLimit: Math.max(
        1,
        Math.floor(
          ensurePositive(
            cfg.perFileRetryLimit ?? cfg.per_file_retry_limit,
            defaults.perFileRetryLimit
          )
        )
      ),
      planRetryLimit: ensureNonNegativeInt(
        cfg.planRetryLimit ?? cfg.plan_retry_limit,
        defaults.planRetryLimit
      ),
      planMaxOutputTokens: ensurePositive(
        cfg.planMaxOutputTokens ?? cfg.plan_max_output_tokens ?? cfg.planMaxTokens,
        defaults.planMaxOutputTokens
      ),
      reasoningEffort: sanitizeEffort(cfg.reasoningEffort ?? cfg.reasoning_effort ?? defaults.reasoningEffort)
    };

    return this.planConfigCache;
  }

  async generateCodeWithPlan(spec) {
    const planConfig = this.getPlanConfiguration();
    const context = await this.gatherCodeContext(spec);
    this.planSessionStamp = new Date().toISOString().replace(/[:.]/g, '-');

    this.logger.info('🧩 Plan mode enabled - generating file plan', {
      perFileRetryLimit: planConfig.perFileRetryLimit,
      planRetryLimit: planConfig.planRetryLimit
    }, 3);

    const planResult = await this.createFilePlan(spec, context, planConfig);

    if (!planResult.plan || planResult.plan.length === 0) {
      this.logger.warn('File plan generation failed, falling back to legacy single-run flow', {}, 3);
      return await this.generateCode(spec);
    }

    this.planManifest = this.initializePlanManifest(spec, planResult.plan);

    await this.persistPlanManifest(spec, {
      snapshotLabel: 'initial',
      includeDebug: true
    });

    await this.reportProgress(35, `Executing plan with ${this.planManifest.files.length} target files`);

    const totalFiles = this.planManifest.files.length || 1;
    const progressBase = 40;
    const progressRange = 30;

    for (let index = 0; index < this.planManifest.files.length; index++) {
      const entry = this.planManifest.files[index];
      const stageDescriptor = entry.stageGoal
        ? `stage ${entry.stage ?? 1}: ${entry.stageGoal}`
        : (entry.stage ? `stage ${entry.stage}` : null);
      const entryLabel = stageDescriptor ? `${entry.path} (${stageDescriptor})` : entry.path;

      await this.reportProgress(
        progressBase + Math.round((index / totalFiles) * progressRange),
        `Generating ${entryLabel}`
      );

      await this.executePlanEntry(entry, spec, context, planConfig);
      await this.persistPlanManifest(spec);

      await this.reportProgress(
        progressBase + Math.round(((index + 1) / totalFiles) * progressRange),
        `Completed attempt for ${entryLabel}`
      );
    }

    for (const fileEntry of this.planManifest.files) {
      if (fileEntry.status !== 'complete' && fileEntry.status !== 'failed') {
        fileEntry.status = 'failed';
      }
    }

    const completedCount = this.planManifest.files.filter(f => f.status === 'complete').length;
    const failedCount = this.planManifest.files.filter(f => f.status === 'failed').length;
    const now = new Date().toISOString();

    if (failedCount === 0 && completedCount === this.planManifest.files.length) {
      this.planManifest.status = 'complete';
    } else if (completedCount > 0) {
      this.planManifest.status = 'partial';
    } else {
      this.planManifest.status = 'failed';
    }

    this.planManifest.completedAt = now;
    this.planManifest.summary = {
      completed: completedCount,
      failed: failedCount,
      total: this.planManifest.files.length
    };

    await this.persistPlanManifest(spec, {
      snapshotLabel: 'final',
      includeDebug: true
    });

    if (this.planManifest.status !== 'complete') {
      this.logger.warn('Plan execution completed with outstanding issues', {
        status: this.planManifest.status,
        completedCount,
        failedCount,
        total: this.planManifest.files.length
      }, 3);
    } else {
      this.logger.info('Plan execution completed successfully', {
        filesGenerated: completedCount
      }, 3);
    }

    return {
      success: this.planManifest.status === 'complete',
      manifest: this.planManifest
    };
  }

  async createFilePlan(spec, context, planConfig) {
    const planAttempts = Math.max(1, planConfig.planRetryLimit + 1);
    let lastResponse = null;
    let planEntries = [];

    for (let attempt = 0; attempt < planAttempts; attempt++) {
      const prompt = this.buildFilePlanPrompt(spec, context, attempt);
      const promptLabel = `plan_attempt${attempt + 1}_prompt.txt`;
      await this.writeDebugArtifact(spec, this.planSessionStamp, promptLabel, prompt);

      try {
        const response = await this.gpt5.generateWithRetry({
          instructions: this.buildCOSMOSystemPrompt(this.getAgentBehavioralPrompt()),
          input: prompt,
          max_output_tokens: planConfig.planMaxOutputTokens,
          reasoningEffort: 'low'
        }, 2);

        lastResponse = response;
        await this.writeDebugArtifact(
          spec,
          this.planSessionStamp,
          `plan_attempt${attempt + 1}_response.json`,
          response,
          { json: true }
        );

        const parsedPlan = this.parseFilePlanResponse(response?.content);
        if (Array.isArray(parsedPlan) && parsedPlan.length > 0) {
          planEntries = this.normalizePlanEntries(parsedPlan, spec);
          if (planEntries.length > 0) {
            return { plan: planEntries, response };
          }
        }

        this.logger.warn('Plan attempt produced no usable entries', {
          attempt: attempt + 1,
          responseHadError: response?.hadError,
          errorType: response?.errorType
        }, 3);
      } catch (error) {
        this.logger.warn('Plan generation attempt failed', {
          attempt: attempt + 1,
          error: error.message
        }, 3);

        await this.writeDebugArtifact(
          spec,
          this.planSessionStamp,
          `plan_attempt${attempt + 1}_error.txt`,
          `${error.message}\n${error.stack || ''}`
        );
      }
    }

    if (lastResponse) {
      await this.writeDebugArtifact(
        spec,
        this.planSessionStamp,
        'plan_last_response.json',
        lastResponse,
        { json: true }
      );
    }

    return { plan: planEntries, response: lastResponse };
  }

  buildFilePlanPrompt(spec, context, attempt = 0) {
    const contextItems = context
      .slice(0, attempt === 0 ? 8 : 4)
      .map(item => `- ${item.substring(0, 140)}`)
      .join('\n');

    const requirementsList = Array.isArray(spec.requirements) && spec.requirements.length > 0
      ? spec.requirements.map(r => `- ${r.replace('include_', '').replace(/_/g, ' ')}`).join('\n')
      : null;

    const instructionTightening = attempt > 0
      ? '\nFocus on the minimum set of files required if the earlier attempt was too large.'
      : '';

    return `You are planning a ${spec.language} ${spec.type} implementation for the following mission:\n${this.mission.description}\n\n` +
      (contextItems ? `Relevant context:\n${contextItems}\n\n` : '') +
      (requirementsList ? `Explicit requirements:\n${requirementsList}\n\n` : '') +
      `Return ONLY a JSON array (no prose) describing the files you intend to create.\n` +
      `Each item MUST include:\n` +
      `- "path": relative path under the project root (no leading ./ or /)\n` +
      `- "description": single sentence describing the complete file purpose\n` +
      `- "category": one of ["source","test","documentation","config","support"]\n\n` +
      `Planning rules:\n` +
      `- ONE entry per file - generate complete, functional code in a single pass (GPT-5.2 supports 4000+ output tokens).\n` +
      `- NO multi-stage builds - create the entire file at once with all required functionality.\n` +
      `- Keep the overall plan focused (<= 12 files total) while covering all mission requirements.${instructionTightening}\n` +
      `- Include tests/docs only when explicitly required.\n` +
      `- Each file should be complete, runnable, and well-documented.\n\n` +
      `Example format:\n[\n  {"path": "src/main.py", "description": "Complete main module with API and analytics", "category": "source"},\n  {"path": "src/utils.py", "description": "Helper utilities", "category": "source"}\n]\n` +
      `Respond with VALID JSON only.`;
  }

  parseFilePlanResponse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return null;
    }

    const trimmed = rawText.trim();

    // Helper to repair common local LLM JSON issues
    const repairJSON = (str) => {
      return str
        .replace(/,\s*}/g, '}')           // Remove trailing commas in objects
        .replace(/,\s*]/g, ']')           // Remove trailing commas in arrays
        .replace(/True/g, 'true')         // Python True -> JSON true
        .replace(/False/g, 'false')       // Python False -> JSON false
        .replace(/None/g, 'null')         // Python None -> JSON null
        .replace(/'/g, '"')               // Single quotes -> double quotes (risky but often needed)
        .replace(/(\w+):/g, '"$1":');     // Unquoted keys -> quoted (if simple)
    };

    // Try direct parse first
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      // continue with fallback parsing
    }

    // Try with JSON repair
    try {
      return JSON.parse(repairJSON(trimmed));
    } catch (err) {
      // continue
    }

    // Try extracting from ```json block
    const jsonBlockMatch = trimmed.match(/```json\s*([\s\S]*?)```/i);
    if (jsonBlockMatch) {
      try {
        return JSON.parse(jsonBlockMatch[1]);
      } catch (err) {
        try {
          return JSON.parse(repairJSON(jsonBlockMatch[1]));
        } catch (err2) {
          // fall through
        }
      }
    }

    // Try extracting array from response
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const candidate = trimmed.slice(firstBracket, lastBracket + 1);
      try {
        return JSON.parse(candidate);
      } catch (err) {
        try {
          return JSON.parse(repairJSON(candidate));
        } catch (err2) {
          this.logger.debug('Failed to parse candidate JSON block from plan response', {
            error: err2.message
          }, 3);
        }
      }
    }

    return null;
  }

  normalizePlanEntries(planEntries, spec) {
    if (!Array.isArray(planEntries)) {
      return [];
    }

    const normalized = [];
    const seen = new Set();

    const slugify = value => {
      if (!value) {
        return '';
      }

      return value
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    };

    for (const entry of planEntries) {
      if (!entry) {
        continue;
      }

      const rawPath = typeof entry === 'string'
        ? entry
        : entry.path || entry.file || entry.name;

      if (!rawPath || typeof rawPath !== 'string') {
        continue;
      }

      const normalizedPath = this.normalizePlanPath(rawPath);
      if (!normalizedPath) {
        continue;
      }

      const description = (entry.description || entry.purpose || '').toString().trim();
      const categoryRaw = (entry.category || entry.type || this.inferPlanCategory(normalizedPath, spec)) || 'source';
      const category = categoryRaw.toString().toLowerCase();

      const stageRaw = entry.stage ?? entry.phase ?? entry.step ?? null;
      let stage = null;
      let stageLabel = null;

      if (stageRaw !== null && stageRaw !== undefined) {
        if (typeof stageRaw === 'number' && Number.isFinite(stageRaw)) {
          stage = Math.max(1, Math.floor(stageRaw));
        } else if (typeof stageRaw === 'string') {
          const trimmedStage = stageRaw.trim();
          const digitMatch = trimmedStage.match(/\d+/);
          if (digitMatch) {
            stage = Math.max(1, parseInt(digitMatch[0], 10));
          }
          if (trimmedStage.length > 0) {
            stageLabel = trimmedStage;
          }
        }
      }

      if (stage === null) {
        stage = 1;
      }
      if (!stageLabel) {
        stageLabel = `Stage ${stage}`;
      }

      const stageGoal = (entry.stage_goal || entry.stageGoal || entry.goal || entry.focus || '').toString().trim() || null;

      const modeRaw = (entry.mode || entry.action || entry.operation || '').toString().toLowerCase();
      const allowedModes = new Set(['create', 'append', 'refine', 'update', 'enhance']);
      let mode = allowedModes.has(modeRaw) ? modeRaw : null;

      if (mode === 'update' || mode === 'enhance') {
        mode = 'refine';
      }

      if (!mode) {
        mode = stage > 1 ? 'append' : 'create';
      }

      const maxLinesRaw = entry.max_lines ?? entry.maxLines ?? entry.line_budget ?? entry.estimated_lines ?? null;
      const maxLinesNumeric = Number(maxLinesRaw);
      const maxLines = Number.isFinite(maxLinesNumeric) && maxLinesNumeric > 0
        ? Math.min(250, Math.round(maxLinesNumeric))
        : (mode === 'create' ? 150 : 100);

      const maxCharsRaw = entry.max_chars ?? entry.maxChars ?? null;
      const maxCharsNumeric = Number(maxCharsRaw);
      const maxChars = Number.isFinite(maxCharsNumeric) && maxCharsNumeric > 0
        ? Math.round(maxCharsNumeric)
        : null;

      const stageSlug = slugify(stageGoal) || `stage-${stage}`;
      const dedupeKey = `${normalizedPath}::${stageSlug}`;

      if (seen.has(dedupeKey)) {
        continue;
      }

      normalized.push({
        path: normalizedPath,
        description,
        category,
        stage,
        stageLabel,
        stageGoal,
        mode,
        maxLines,
        maxChars
      });

      seen.add(dedupeKey);
    }

    return normalized;
  }

  inferPlanCategory(filePath, spec) {
    const lower = (filePath || '').toLowerCase();
    const language = spec?.language || '';

    if (lower.includes('test') || lower.includes('spec') || /\.test\.|_test\./.test(lower)) {
      return 'test';
    }
    if (lower.endsWith('.md') || lower.startsWith('docs/')) {
      return 'documentation';
    }
    if (lower.includes('docker') || lower.endsWith('dockerfile') || lower.includes('ci.yml') || lower.includes('.github/')) {
      return 'config';
    }
    if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      return 'config';
    }
    if (language === 'python' && lower.endsWith('__init__.py')) {
      return 'support';
    }
    return 'source';
  }

  initializePlanManifest(spec, planEntries) {
    const createdAt = new Date().toISOString();

    // Create standardized manifest with code-creation specific fields
    const baseManifest = DeliverableManifest.create({
      agentId: this.agentId,
      agentType: 'code-creation',
      mission: this.mission,
      spawnCycle: this.mission.spawnCycle,
      coordinatorReview: this.mission.coordinatorReview
    });

    // Add code-creation specific fields
    return {
      ...baseManifest,
      manifestVersion: '2.0.0-plan', // Upgraded from 1.0.0-plan
      deliverableType: 'code',
      projectName: spec.projectName,
      language: spec.language,
      type: spec.type,
      status: 'in_progress',
      requirements: spec.requirements,
      files: planEntries.map(entry => ({
        path: entry.path,
        description: entry.description,
        category: entry.category,
        stage: entry.stage ?? 1,
        stageLabel: entry.stageLabel || null,
        stageGoal: entry.stageGoal || null,
        mode: entry.mode || (entry.stage && entry.stage > 1 ? 'append' : 'create'),
        maxLines: entry.maxLines || null,
        maxChars: entry.maxChars || null,
        status: 'pending',
        attempts: 0,
        errors: [],
        createdAt
      }))
    };
  }

  async executePlanEntry(entry, spec, context, planConfig) {
    const maxAttempts = Math.max(1, Math.floor(planConfig.perFileRetryLimit));
    entry.errors = entry.errors || [];
    entry.status = entry.status && entry.status !== 'pending' ? entry.status : 'in_progress';

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptNumber = attempt + 1;
      entry.attempts = attemptNumber;

      const stageTag = entry.stage ? `_stage${entry.stage}` : '';
      const stampBase = `${entry.path}${stageTag}`;
      const attemptStamp = `${this.planSessionStamp}_${this.sanitizeForFilename(stampBase)}_attempt${attemptNumber}`;
      const prompt = this.buildPerFilePrompt(spec, entry, context);

      await this.writeDebugArtifact(spec, attemptStamp, 'prompt.txt', prompt);

      let response;
      try {
        response = await this.executionBackend.executeCode({
          input: prompt,
          max_output_tokens: planConfig.maxOutputTokensPerCall,
          reasoningEffort: planConfig.reasoningEffort,
          retryCount: 1
        });
      } catch (error) {
        entry.errors.push({
          attempt: attemptNumber,
          message: error.message,
          timestamp: new Date().toISOString()
        });

        await this.writeDebugArtifact(spec, attemptStamp, 'error.txt', `${error.message}\n${error.stack || ''}`);
        continue;
      }

      await this.writeDebugArtifact(spec, attemptStamp, 'response.json', response, { json: true });

      const isIncomplete = response?.errorType === 'response.incomplete';
      if (isIncomplete) {
        this.logger.warn('⚠️ Code interpreter response ended with response.incomplete during planned file generation', {
          path: entry.path,
          attempt: attemptNumber,
          outputTokens: response?.usage?.output_tokens
        }, 3);
      }

      if (response?.codeResults) {
        for (const result of response.codeResults) {
          if (Array.isArray(result.files)) {
            this.generatedFiles.push(...result.files);
          }
        }
      }

      const metadataFromResponse = this.extractFileMetadataFromResponse(response, entry);
      if (metadataFromResponse) {
        this.updateManifestEntryWithFile(entry, metadataFromResponse);
        entry.status = 'complete';
        entry.completedAt = new Date().toISOString();
        return;
      }

      const metadata = await this.findContainerFileMetadata(entry.path, entry.stage);
      if (metadata) {
        this.logger.warn('⚠️ No codeResults metadata for entry, falling back to container listing', {
          path: entry.path,
          stage: entry.stage,
          fallbackPath: metadata.path,
          debugStamp: attemptStamp
        }, 3);

        const normalizedEntryPath = this.normalizePlanPath(entry.path);
        const normalizedCandidate = this.normalizePlanPath(metadata.path);
        if (normalizedEntryPath && normalizedCandidate && normalizedCandidate !== normalizedEntryPath) {
          metadata.originalPath = metadata.path;
          metadata.path = normalizedEntryPath;

          const stageKey = `stage-${entry.stage || 1}-artifact`;
          const alreadyTracked = this.planManifest.files.some(fileEntry =>
            this.normalizePlanPath(fileEntry.path) === normalizedCandidate
          );

          if (!alreadyTracked) {
            this.logger.info('Tracking stage artifact from container listing', {
              canonical: normalizedEntryPath,
              artifact: normalizedCandidate,
              stage: entry.stage
            }, 4);

            this.planManifest.files.push({
              path: normalizedCandidate,
              description: `${entry.description || 'Stage artifact'} (stage ${entry.stage || 1})`,
              category: entry.category,
              stage: entry.stage,
              stageLabel: entry.stageLabel,
              stageGoal: entry.stageGoal,
              mode: entry.mode,
              maxLines: entry.maxLines,
              maxChars: entry.maxChars,
              status: 'complete',
              attempts: entry.attempts,
              errors: entry.errors,
              createdAt: entry.createdAt,
              completedAt: new Date().toISOString(),
              stageKey
            });
          }
        }

        this.updateManifestEntryWithFile(entry, metadata);
        entry.status = 'complete';
        entry.completedAt = new Date().toISOString();
        return;
      }

      // FEATURE 8 FIX: Check for FILE_WRITTEN markers before marking as failed
      // Parse response content for FILE_WRITTEN:path markers
      const fileWrittenMatches = [];
      if (response?.content) {
        const lines = response.content.split('\n');
        for (const line of lines) {
          if (line.startsWith('FILE_WRITTEN:')) {
            const writtenPath = line.slice('FILE_WRITTEN:'.length).trim();
            if (writtenPath) {
              fileWrittenMatches.push(this.normalizePlanPath(writtenPath));
            }
          }
        }
      }

      // If FILE_WRITTEN marker present for this entry, trust it
      const normalizedEntryPath = this.normalizePlanPath(entry.path);
      if (fileWrittenMatches.length > 0 && fileWrittenMatches.includes(normalizedEntryPath)) {
        this.logger.info('✓ FILE_WRITTEN marker found, marking as complete', {
          path: entry.path,
          attempt: attemptNumber
        }, 3);
        entry.status = 'complete';
        entry.completedAt = new Date().toISOString();
        return;  // Success - don't mark as failed
      }

      // No FILE_WRITTEN marker found - log error but continue trying
      const errorSummary = response?.errorType
        || (response?.content ? response.content.slice(-400) : 'File not found after execution');

      entry.errors.push({
        attempt: attemptNumber,
        message: 'File not found after execution',
        detail: errorSummary,
        timestamp: new Date().toISOString()
      });
    }

    // Only mark as failed if we exhausted all attempts without FILE_WRITTEN marker
    if (entry.status !== 'complete') {
      entry.status = 'failed';
      entry.failedAt = new Date().toISOString();
    }
  }

  buildPerFilePrompt(spec, entry, context) {
    const otherFiles = (this.planManifest?.files || [])
      .filter(file => file.path !== entry.path)
      .slice(0, 4)
      .map(file => `- ${file.path}: ${file.description || file.category}`)
      .join('\n');

    const contextSnippet = context
      .slice(0, 5)
      .map(item => `- ${item.substring(0, 140)}`)
      .join('\n');

    const requirementsList = Array.isArray(spec.requirements) && spec.requirements.length > 0
      ? spec.requirements.map(r => `- ${r.replace('include_', '').replace(/_/g, ' ')}`).join('\n')
      : null;

    const escapedPath = entry.path.replace(/'/g, "\\'");

    const coerceNumber = value => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const stageNumber = coerceNumber(entry?.stage) || 1;
    const stageLabel = (entry?.stageLabel && entry.stageLabel.toString().trim()) || `Stage ${stageNumber}`;
    const rawStageGoal = (entry?.stageGoal && entry.stageGoal.toString()) || entry.description || 'N/A';
    const stageGoal = rawStageGoal.replace(/\s+/g, ' ').trim() || 'N/A';

    const modeRaw = (entry?.mode || (stageNumber > 1 ? 'append' : 'create')).toString().toLowerCase();
    const allowedModes = new Set(['create', 'append', 'refine']);
    const modeNormalized = allowedModes.has(modeRaw) ? modeRaw : (stageNumber > 1 ? 'append' : 'create');

    const maxLines = Math.max(1, coerceNumber(entry?.maxLines) || (modeNormalized === 'create' ? 150 : 100));
    const maxCharsNumber = coerceNumber(entry?.maxChars);

    const stageInfoLines = [
      `- Stage: ${stageLabel}`,
      `- Mode: ${modeNormalized}`,
      `- Goal: ${stageGoal}`,
      `- Line budget for this stage: <= ${Math.round(maxLines)} new/changed lines.`
    ];
    if (maxCharsNumber) {
      stageInfoLines.push(`- Character budget: <= ${Math.round(maxCharsNumber)} new characters.`);
    }
    const stageSection = `Stage details:\n${stageInfoLines.join('\n')}\n\n`;

    let implementationBlock = '';
    let constraintLines = [];
    const baseConstraintLines = [
      `- Keep console output short (only FILE_WRITTEN / DIR_STATE plus essential status).`,
      `- Do not touch files outside ${entry.path}.`,
      `- After writing the file, provide a one-sentence summary. Do not list the file contents in the final message.`
    ];

    if (modeNormalized === 'append') {
      implementationBlock =
        `Implementation tasks (execute using Python in this environment):\n` +
        `1. from pathlib import Path\n` +
        `2. import json\n` +
        `3. target_path = Path('/mnt/data').joinpath('${escapedPath}')\n` +
        `4. assert target_path.exists(), "Expected ${entry.path} to exist before this append stage"\n` +
        `5. existing = target_path.read_text(encoding='utf-8')\n` +
        `6. Compose the new material for this stage (<= ${Math.round(maxLines)} lines) as a list named new_sections; each entry must be a multiline string without leading or trailing blank lines.\n` +
        `7. updated = existing.rstrip() + ('\\n\\n' if existing.strip() else '') + '\\n\\n'.join(section.strip('\\n') for section in new_sections) + '\\n'\n` +
        `8. target_path.write_text(updated, encoding='utf-8')\n` +
        `9. print('FILE_WRITTEN:${entry.path}')\n` +
        `10. print('DIR_STATE:' + json.dumps(sorted(str(p.relative_to(Path("/mnt/data"))) for p in target_path.parent.glob('*') if p.is_file())))\n\n`;

      constraintLines = [
        `- Preserve existing content; only append the new sections defined in this stage.`,
        `- Keep the newly added code within the stated line/character budget.`,
        ...baseConstraintLines
      ];
    } else if (modeNormalized === 'refine') {
      implementationBlock =
        `Implementation tasks (execute using Python in this environment):\n` +
        `1. from pathlib import Path\n` +
        `2. import json\n` +
        `3. target_path = Path('/mnt/data').joinpath('${escapedPath}')\n` +
        `4. assert target_path.exists(), "Expected ${entry.path} to exist before this refinement stage"\n` +
        `5. existing = target_path.read_text(encoding='utf-8')\n` +
        `6. Define a helper function apply_refinements(existing: str) -> str that updates only the sections required for this stage while leaving unrelated content untouched (limit changes to <= ${Math.round(maxLines)} lines).\n` +
        `7. updated = apply_refinements(existing)\n` +
        `8. assert updated != existing, "No changes were applied during refinement"\n` +
        `9. target_path.write_text(updated, encoding='utf-8')\n` +
        `10. print('FILE_WRITTEN:${entry.path}')\n` +
        `11. print('DIR_STATE:' + json.dumps(sorted(str(p.relative_to(Path("/mnt/data"))) for p in target_path.parent.glob('*') if p.is_file())))\n\n`;

      constraintLines = [
        `- Apply targeted updates only; do not rebuild the entire file.`,
        `- Keep the modified sections within the stated line/character budget.`,
        ...baseConstraintLines
      ];
    } else {
      implementationBlock =
        `Implementation tasks (execute using Python in this environment):\n` +
        `1. from pathlib import Path\n` +
        `2. import json\n` +
        `3. target_path = Path('/mnt/data').joinpath('${escapedPath}')\n` +
        `4. target_path.parent.mkdir(parents=True, exist_ok=True)\n` +
        `5. Build the entire stage deliverable (<= ${Math.round(maxLines)} lines) as a list named chunks where each item is a multiline string representing a contiguous block of code without leading or trailing blank lines.\n` +
        `6. final_text = '\\n'.join(block.strip('\\n') for block in chunks).strip() + '\\n'\n` +
        `7. target_path.write_text(final_text, encoding='utf-8')\n` +
        `8. print('FILE_WRITTEN:${entry.path}')\n` +
        `9. print('DIR_STATE:' + json.dumps(sorted(str(p.relative_to(Path("/mnt/data"))) for p in target_path.parent.glob('*') if p.is_file())))\n\n`;

      constraintLines = [
        `- Ensure the new file fully satisfies the stage goal with no placeholders or TODO markers.`,
        `- Keep the newly written code within the stated line/character budget.`,
        ...baseConstraintLines
      ];
    }

    const constraintsBlock = `Constraints:\n${constraintLines.join('\n')}\n`;

    return `You are inside the OpenAI code interpreter environment with filesystem access to /mnt/data.

` +
      `Mission summary: ${this.mission.description}
` +
      `Project: ${spec.projectName} (${spec.language} ${spec.type})

` +
      `Target file details:
- Path: ${entry.path}
- Purpose: ${entry.description || 'N/A'}
- Category: ${entry.category}

` +
      (otherFiles ? `Other planned files (for context only):
${otherFiles}

` : '') +
      (contextSnippet ? `Reference insights:
${contextSnippet}

` : '') +
      (requirementsList ? `Key requirements:
${requirementsList}

` : '') +
      stageSection +
      implementationBlock +
      constraintsBlock;
  }

  extractFileMetadataFromResponse(response, entry) {
    if (!response) {
      return null;
    }

    const target = this.normalizePlanPath(entry.path);
    if (!target) {
      return null;
    }

    if (response?.codeResults) {
      for (const result of response.codeResults) {
        const files = result?.files || [];
        for (const fileRef of files) {
          const candidateName = fileRef?.path || fileRef?.filename || fileRef?.name;
          const candidate = this.normalizePlanPath(candidateName);
          if (candidate && candidate === target) {
            return {
              id: fileRef.file_id || fileRef.id || null,
              name: candidateName,
              path: candidate
            };
          }
        }
      }
    }

    const fileWrittenMatches = [];
    const outputs = Array.isArray(response?.output) ? response.output : [];
    for (const block of outputs) {
      const entries = Array.isArray(block?.outputs) ? block.outputs : [];
      for (const outputEntry of entries) {
        const logPayload = outputEntry?.logs || outputEntry?.text || outputEntry?.content || '';
        if (typeof logPayload !== 'string' || logPayload.trim().length === 0) {
          continue;
        }

        for (const rawLine of logPayload.split('\n')) {
          const line = rawLine.trim();
          if (!line) {
            continue;
          }

          if (line.startsWith('FILE_WRITTEN:')) {
            const writtenPath = line.slice('FILE_WRITTEN:'.length).trim();
            if (writtenPath) {
              fileWrittenMatches.push(this.normalizePlanPath(writtenPath));
            }
          }
        }
      }
    }

    for (const candidate of fileWrittenMatches) {
      if (!candidate) {
        continue;
      }

      if (candidate === target) {
        return {
          id: null,
          name: candidate,
          path: candidate
        };
      }

      if (entry.stage) {
        const stageSuffixes = [
          `_stage${entry.stage}`,
          `_stage-${entry.stage}`,
          `_stage_${entry.stage}`,
          `.stage${entry.stage}`,
          `.stage-${entry.stage}`,
          `.stage_${entry.stage}`
        ];

        if (stageSuffixes.some(suffix => candidate === `${target}${suffix}`)) {
          return {
            id: null,
            name: candidate,
            path: target,
            originalPath: candidate
          };
        }
      }
    }

    return null;
  }

  extractFileExportPayloads(response) {
    const payloads = [];

    if (!response) {
      return payloads;
    }

    const tryParse = raw => {
      if (typeof raw !== 'string') {
        return null;
      }

      const trimmed = raw.trim();
      if (!trimmed.startsWith('FILE_EXPORT:')) {
        return null;
      }

      const jsonSegment = trimmed.slice('FILE_EXPORT:'.length).trim();
      if (!jsonSegment) {
        return null;
      }

      try {
        return JSON.parse(jsonSegment);
      } catch (error) {
        this.logger.warn('Failed to parse FILE_EXPORT payload', {
          snippet: jsonSegment.slice(0, 120),
          error: error.message
        }, 4);
        return null;
      }
    };

    const outputs = Array.isArray(response?.output) ? response.output : [];
    for (const block of outputs) {
      const entries = Array.isArray(block?.outputs) ? block.outputs : [];
      for (const entry of entries) {
        const logPayload = entry?.logs || entry?.text || entry?.content || '';
        if (typeof logPayload !== 'string') {
          continue;
        }

        for (const rawLine of logPayload.split('\n')) {
          const payload = tryParse(rawLine);
          if (payload) {
            payloads.push(payload);
          }
        }
      }
    }

    if (typeof response?.content === 'string') {
      for (const rawLine of response.content.split('\n')) {
        const payload = tryParse(rawLine);
        if (payload) {
          payloads.push(payload);
        }
      }
    }

    return payloads;
  }

  buildFileExportPrompt(entry) {
    const escapedPath = entry.path.replace(/'/g, "\\'");
    const stageDescriptor = entry.stageGoal ? `${entry.stageGoal}` : (entry.description || 'N/A');

    return `You are inside the OpenAI code interpreter environment with filesystem access to /mnt/data.\n\n` +
      `Task: Export the existing file at ${entry.path} so it can be reconstructed outside the container.\n` +
      `Context:\n` +
      `- Stage: ${entry.stage ? `Stage ${entry.stage}` : 'N/A'}\n` +
      `- Purpose: ${stageDescriptor}\n\n` +
      `Implementation tasks (execute using Python in this environment):\n` +
      `1. from pathlib import Path\n` +
      `2. import base64, json, hashlib, gzip\n` +
      `3. target_path = Path('/mnt/data').joinpath('${escapedPath}')\n` +
      `4. assert target_path.is_file(), 'Expected ${entry.path} to exist before export'\n` +
      `5. data = target_path.read_bytes()\n` +
      `6. payload = {\n` +
      `   'path': '${entry.path}',\n` +
      `   'size': len(data),\n` +
      `   'encoding': 'base64',\n` +
      `   'sha256': hashlib.sha256(data).hexdigest(),\n` +
      `   'content': None\n` +
      ` }\n` +
      `7. if len(data) > 20000:\n` +
      `      compressed = gzip.compress(data)\n` +
      `      payload['encoding'] = 'gzip+base64'\n` +
      `      payload['content'] = base64.b64encode(compressed).decode('ascii')\n` +
      `   else:\n` +
      `      payload['content'] = base64.b64encode(data).decode('ascii')\n` +
      `8. print('FILE_EXPORT:' + json.dumps(payload, separators=(',', ':')))\n` +
      `9. print('DIR_STATE:' + json.dumps(sorted(str(p.relative_to(Path("/mnt/data"))) for p in target_path.parent.glob('*') if p.is_file())))\n\n` +
      `Constraints:\n` +
      `- Output ONLY the FILE_EXPORT line plus DIR_STATE; avoid echoing file contents.\n` +
      `- Keep console output minimal.\n` +
      `- Do not modify the file contents.\n`;
  }

  async exportFileViaBase64(entry, outputDir) {
    if (!this.executionBackend) {
      return null;
    }
    
    // For local backend, files are already local - just read them directly
    if (this.executionBackend.getBackendType() === 'local') {
      // Local backend: files are already on disk, no need for base64 export
      // This method is primarily for container export, so skip for local
      return null;
    }

    try {
      const exportPrompt = this.buildFileExportPrompt(entry);
      const stageTag = entry.stage ? `_stage${entry.stage}` : '';
      const stampBase = `${entry.path}${stageTag}_export`;
      const exportStamp = `${this.planSessionStamp}_${this.sanitizeForFilename(stampBase)}`;

      await this.writeDebugArtifact(this.currentSpec, exportStamp, 'export_prompt.txt', exportPrompt);

      const response = await this.executionBackend.executeCode({
        input: exportPrompt,
        max_output_tokens: 16000,
        reasoningEffort: 'low',
        retryCount: 1
      });

      await this.writeDebugArtifact(this.currentSpec, exportStamp, 'export_response.json', response, { json: true });

      const payloads = this.extractFileExportPayloads(response);
      if (!Array.isArray(payloads) || payloads.length === 0) {
        this.logger.warn('No FILE_EXPORT payload returned from export prompt', {
          path: entry.path,
          stage: entry.stage
        }, 3);
        return null;
      }

      const target = this.normalizePlanPath(entry.path);
      const payload = payloads.find(item => this.normalizePlanPath(item?.path) === target);
      if (!payload || !payload.content) {
        this.logger.warn('Export payload missing expected file content', {
          path: entry.path,
          stage: entry.stage
        }, 3);
        return null;
      }

      let fileBuffer;
      try {
        const rawBuffer = Buffer.from(payload.content, 'base64');
        if (payload.encoding === 'gzip+base64') {
          fileBuffer = zlib.gunzipSync(rawBuffer);
        } else {
          fileBuffer = rawBuffer;
        }
      } catch (decodeError) {
        this.logger.warn('Failed to decode exported file payload', {
          path: entry.path,
          stage: entry.stage,
          error: decodeError.message
        }, 3);
        return null;
      }

      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fallbackName = path.basename(entry.path) || `export_${Date.now()}`;
      const { fullPath, relativePath } = await this.ensureUniqueOutputPath(outputDir, entry.path, fallbackName);

      // ATOMIC WRITE: Prevents partial file corruption on shutdown
      await this.writeFileAtomic(fullPath, fileBuffer);

      const relativePathForManifest = path.join(
        'runtime',
        'outputs',
        'code-creation',
        this.agentId,
        relativePath.split(path.sep).join('/')
      );

      this.logger.info('   ✓ Exported via base64', {
        path: entry.path,
        bytes: fileBuffer.length
      }, 3);

      return {
        fileId: null,
        filename: relativePath,
        filePath: fullPath,
        relativePath: relativePathForManifest,
        size: fileBuffer.length,
        sha256,
        containerPath: entry.path
      };
    } catch (error) {
      this.logger.warn('Failed to export file via base64 fallback', {
        path: entry.path,
        stage: entry.stage,
        error: error.message
      }, 3);
      return null;
    }
  }

  /**
   * Detect file type from filename extension
   */
  detectFileTypeFromName(filename) {
    const ext = path.extname(filename).toLowerCase();
    const typeMap = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.py': 'python',
      '.sh': 'shell',
      '.html': 'html',
      '.css': 'css',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.xml': 'xml',
      '.sql': 'sql',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.cs': 'csharp',
      '.php': 'php',
      '.rb': 'ruby',
      '.md': 'markdown',
      '.txt': 'text'
    };
    return typeMap[ext] || 'unknown';
  }
  
  normalizePlanPath(value) {
    if (!value || typeof value !== 'string') {
      return '';
    }

    let normalized = value.trim();
    normalized = normalized.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/^\/mnt\/data\/?/i, '');
    normalized = normalized.replace(/\/{2,}/g, '/');
    normalized = normalized.replace(/^\/+/, '');
    return normalized;
  }

  async findContainerFileMetadata(targetPath, stage = null) {
    if (!this.executionBackend) {
      return null;
    }

    try {
      const files = await this.executionBackend.listFiles();
      if (!Array.isArray(files)) {
        return null;
      }

      const normalizedTarget = this.normalizePlanPath(targetPath);
      const stageSuffixes = stage
        ? [
            '',
            `_stage${stage}`,
            `_stage-${stage}`,
            `_stage_${stage}`,
            `.stage${stage}`,
            `.stage-${stage}`,
            `.stage_${stage}`
          ]
        : [''];

      for (const file of files) {
        const candidateName = file?.path || file?.name || file?.filename;
        const candidate = this.normalizePlanPath(candidateName);
        if (!candidate) {
          continue;
        }

        for (const suffix of stageSuffixes) {
          const stageAwareTarget = suffix ? `${normalizedTarget}${suffix}` : normalizedTarget;
          if (candidate === stageAwareTarget) {
            this.logger.info('Found container file via listing', {
              targetPath,
              candidate,
              stage,
              suffix
            }, 4);
            return {
              id: file.id || file.file_id || null,
              name: candidateName,
              path: candidate,
              bytes: file.bytes ?? file.size ?? file.length ?? null,
              file
            };
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to list container files while verifying plan entry', {
        targetPath,
        stage,
        error: error.message
      }, 3);
    }

    return null;
  }

  updateManifestEntryWithFile(entry, metadata) {
    if (!entry || !metadata) {
      return;
    }

    entry.containerFileId = metadata.id || entry.containerFileId || null;
    entry.containerPath = metadata.path || entry.containerPath || entry.path;
    entry.containerFilename = metadata.name || entry.containerFilename || entry.path;
    if (metadata.originalPath) {
      entry.originalContainerPath = metadata.originalPath;
    }
    if (metadata.bytes !== undefined && metadata.bytes !== null) {
      entry.containerBytes = metadata.bytes;
    }
  }

  async persistPlanManifest(spec, options = {}) {
    if (!this.planManifest) {
      return null;
    }

    const { snapshotLabel = null, includeDebug = false } = options;
    const effectiveSpec = spec || this.currentSpec;

    if (!effectiveSpec?.outputDir) {
      return null;
    }

    await fs.mkdir(effectiveSpec.outputDir, { recursive: true });
    const manifestPath = path.join(effectiveSpec.outputDir, 'manifest.json');
    this.planManifest.lastSavedAt = new Date().toISOString();
    
    // ATOMIC WRITE: Prevents partial manifest on shutdown
    await this.writeFileAtomic(manifestPath, JSON.stringify(this.planManifest, null, 2), { encoding: 'utf8' });

    if (includeDebug) {
      const label = snapshotLabel ? `${snapshotLabel}_` : '';
      const stamp = this.planSessionStamp || new Date().toISOString().replace(/[:.]/g, '-');
      await this.writeDebugArtifact(
        effectiveSpec,
        stamp,
        `${label}manifest.json`,
        this.planManifest,
        { json: true }
      );
    }

    return manifestPath;
  }

  sanitizeForFilename(value) {
    return (value || 'file')
      .toString()
      .replace(/[^a-z0-9_\-]+/gi, '_')
      .replace(/_+/g, '_')
      .slice(-120);
  }

  async ensureUniqueOutputPath(baseDir, desiredPath, fallbackName) {
    const initialRelative = this.normalizePlanPath(desiredPath) || this.normalizePlanPath(fallbackName) || fallbackName;
    let relativePath = (initialRelative || `file_${Date.now()}`).split('/').filter(Boolean).join('/');

    if (!relativePath || relativePath.endsWith('/')) {
      relativePath = `${relativePath || ''}${this.sanitizeForFilename(fallbackName || `file_${Date.now()}`)}`;
    }

    let directory = path.dirname(relativePath);
    directory = directory === '.' ? '' : directory;
    let baseName = path.basename(relativePath);
    if (!baseName || baseName === '.' || baseName === '..') {
      baseName = this.sanitizeForFilename(fallbackName || `file_${Date.now()}`);
    }

    const candidateRelative = directory ? path.join(directory, baseName) : baseName;
    const candidateFullPath = path.join(baseDir, candidateRelative);

    // Create directory
    const outputDirectory = directory ? path.join(baseDir, directory) : baseDir;
    await fs.mkdir(outputDirectory, { recursive: true });

    // Check if file exists
    const exists = await this.fileExists(candidateFullPath);
    if (exists) {
      this.logger.info('📝 File exists - will overwrite', {
        path: candidateRelative
      });
    }

    return {
      fullPath: candidateFullPath,
      relativePath: candidateRelative,
      existed: exists
    };
  }

  async fileExists(targetPath) {
    try {
      await fs.access(targetPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  async updateManifestFromSavedFiles(savedFiles) {
    if (!this.planManifest || !Array.isArray(savedFiles) || savedFiles.length === 0) {
      return;
    }

    const now = new Date().toISOString();

    for (const file of savedFiles) {
      const primaryName = file?.filename || file?.name || '';
      const relativeName = file?.relativePath || '';
      const absoluteName = file?.filePath || '';
      const candidates = new Set(
        [
          this.normalizePlanPath(primaryName),
          this.normalizePlanPath(relativeName),
          this.normalizePlanPath(absoluteName),
          this.normalizePlanPath(path.basename(primaryName || relativeName || absoluteName || ''))
        ].filter(Boolean)
      );

      if (candidates.size === 0) {
        continue;
      }

      const entry = this.planManifest.files.find(item => {
        const entryCandidates = [
          this.normalizePlanPath(item.path),
          this.normalizePlanPath(item.containerPath || ''),
          this.normalizePlanPath(item.containerFilename || ''),
          this.normalizePlanPath(path.basename(item.path || ''))
        ].filter(Boolean);

        return entryCandidates.some(candidate => candidates.has(candidate));
      });
      if (!entry) {
        continue;
      }

      entry.localPath = file.filePath;
      entry.relativePath = file.relativePath;
      entry.sizeBytes = file.size;
      entry.sha256 = file.sha256 || entry.sha256;
      entry.downloadedAt = now;
      if (!entry.status || entry.status === 'pending') {
        entry.status = 'complete';
      }
    }

    await this.persistPlanManifest(this.currentSpec, { snapshotLabel: 'post_download' });
  }

  /**
   * Build prompt for code_interpreter to write actual files
   * CRITICAL: This prompts the model to use Python to write files to disk
   */
  buildFileCreationPrompt(spec, context) {
    const contextStr = context.length > 0 
      ? `\n\nCONTEXT FROM MEMORY:\n${context.slice(0, 3).map(item => `- ${item.substring(0, 150)}`).join('\n')}`
      : '';

    const requirementsList = Array.isArray(spec.requirements) && spec.requirements.length > 0
      ? `\nADDITIONAL REQUIREMENTS:\n${spec.requirements.map(r => `- ${r.replace('include_', '').replace(/_/g, ' ')}`).join('\n')}`
      : '';

    const mainFileName = this.getMainFileName(spec);
    const runCommand = (() => {
      switch (spec.language) {
        case 'python':
          return `python ${mainFileName}`;
        case 'javascript':
          return `node ${mainFileName}`;
        case 'typescript':
          return `ts-node ${mainFileName}`;
        case 'go':
          return `go run ${mainFileName}`;
        case 'bash':
        case 'shell':
          return `bash ${mainFileName}`;
        default:
          return null;
      }
    })();

    const executionStep = runCommand
      ? `5. After all files are written, run \`${runCommand}\` so the execution output appears in this transcript.`
      : `5. After all files are written, execute the primary entry point to demonstrate the implementation and expose runtime output.`;

    const summaryFormat = 'FILES_CREATED: [{"path": "...", "description": "..."}]';

    return `You are inside the OpenAI code interpreter environment with filesystem access to /mnt/data/.

MISSION: ${this.mission.description}${contextStr}

DELIVERABLE TARGET:
- Produce a working ${spec.language} ${spec.type} implementation comprised of real source files.
- Every file must contain full, runnable code (absolutely no TODO, placeholder, or pseudo code).
- All files must be written beneath /mnt/data/.
- Documentation files are not part of this deliverable unless explicitly required.
${requirementsList}

IMPLEMENTATION TASKS (execute using Python in this environment):
1. Determine every ${spec.language} source file needed (main module plus any support files, tests, or package initialisers).
2. For each file, inside the Python tool call:
   - \`from pathlib import Path\`
   - \`import base64, gzip, json\`
   - Define \`def write_from_base64(target_path: Path, payload: str):\` that creates parent directories, decodes the base64 string, decompresses it with gzip, and writes the resulting bytes to disk.
   - Build the full ${spec.language} source text as a string variable named \`source_text\` (no placeholders or TODOs). IMPORTANT: When the code contains docstrings (triple double-quotes), use triple SINGLE quotes for the outer string: source_text = '''#!/usr/bin/env python3\n"""Docstring here"""\nimport sys\n'''
   - \`encoded_payload = base64.b64encode(gzip.compress(source_text.encode('utf-8'))).decode('ascii')\`
   - \`write_from_base64(target_path, encoded_payload)\` where \`target_path = Path('/mnt/data').joinpath('<relative path>')\`.
   - \`print('FILE_WRITTEN:' + target_path.as_posix())\`
   - \`print('DIR_STATE:' + json.dumps(sorted(str(p.relative_to(Path("/mnt/data"))) for p in target_path.parent.glob('*') if p.is_file())))\`
3. Ensure directories exist before writing, preserve indentation, and include imports/dependencies required for the code to run.
4. Keep console output concise: only the \`FILE_WRITTEN\` / \`DIR_STATE\` lines plus essential status messages.
${executionStep}
6. Finally, print a summary EXACTLY in this format (single line):
   ${summaryFormat}
   The JSON array must list every created file with its /mnt/data path and a short description.

Execute the Python code now to create the ${spec.language} files, perform the runtime check, print the summary, and keep reasoning under 300 tokens.`;
  }

  /**
   * Get appropriate code template
   */
  getCodeTemplate(language, type, complexity) {
    const templateKey = `${language}_${type}_${complexity}`;

    if (this.codeTemplates.has(templateKey)) {
      return this.codeTemplates.get(templateKey);
    }

    // Return generic template for the language
    return this.getGenericLanguageTemplate(language);
  }

  /**
   * Generate main code file content
   */
  async generateMainCodeFile(spec, template, context) {
    const prompt = this.buildCodeGenerationPrompt(spec, template, context);

    try {
      const response = await this.callGPT5({
        messages: [
          {
            role: 'system',
            content: this.getAgentBehavioralPrompt() + '\n\n' + `You are an expert ${spec.language} developer creating functional, well-structured code.
                     Focus on creating runnable, maintainable code with proper error handling and documentation.
                     Follow best practices for ${spec.language} and the specified complexity level.`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3, // Lower temperature for more consistent code generation
        max_tokens: 3000
      });

      return {
        fileName: this.getMainFileName(spec),
        content: response.content,
        language: spec.language,
        type: 'main'
      };

    } catch (error) {
      this.logger.error('Failed to generate main code file', {
        language: spec.language,
        type: spec.type,
        error: error.message
      });

      return {
        fileName: this.getMainFileName(spec),
        content: this.getFallbackCode(spec),
        language: spec.language,
        type: 'main',
        error: error.message
      };
    }
  }

  /**
   * Build code generation prompt
   */
  buildCodeGenerationPrompt(spec, template, context) {
    let prompt = `Create a ${spec.complexity} ${spec.type} in ${spec.language}.

Project: ${spec.projectName}
Type: ${spec.type}
Complexity: ${spec.complexity}
Features: ${spec.features.join(', ')}

Requirements:
- Create functional, runnable code
- Include proper error handling
- Follow ${spec.language} best practices
- Add comments and documentation
- Make it maintainable and extensible

`;

    if (context.length > 0) {
      prompt += `\nRelevant Context from Knowledge Base:
${context.slice(0, 3).map(item => `- ${item}`).join('\n')}
`;
    }

    if (spec.features.includes('api')) {
      prompt += `
API Requirements:
- RESTful endpoints
- Proper HTTP status codes
- JSON request/response handling
- Input validation
`;
    }

    if (spec.features.includes('database')) {
      prompt += `
Database Requirements:
- Connection handling
- Query optimization
- Error handling for DB operations
- Data validation
`;
    }

    if (spec.features.includes('authentication')) {
      prompt += `
Authentication Requirements:
- User authentication system
- Session management
- Password hashing
- Protected routes/endpoints
`;
    }

    if (spec.features.includes('user_interface')) {
      prompt += `
UI Requirements:
- Clean, responsive interface
- User-friendly navigation
- Form handling and validation
- Modern styling
`;
    }

    prompt += `

Generate the complete, runnable code:`;

    return prompt;
  }

  /**
   * Generate additional files (tests, docs, config, etc.)
   */
  async generateAdditionalFiles(spec, template) {
    const files = [];

    // Generate README
    if (spec.requirements.includes('include_documentation')) {
      files.push({
        fileName: 'README.md',
        content: await this.generateReadme(spec),
        language: 'markdown',
        type: 'documentation'
      });
    }

    // Generate package.json for Node.js projects
    if (spec.language === 'javascript' || spec.language === 'typescript') {
      files.push({
        fileName: 'package.json',
        content: await this.generatePackageJson(spec),
        language: 'json',
        type: 'configuration'
      });
    }

    // Generate tests
    if (spec.requirements.includes('include_tests')) {
      files.push({
        fileName: this.getTestFileName(spec),
        content: await this.generateTests(spec),
        language: spec.language,
        type: 'test'
      });
    }

    // Generate Dockerfile
    if (spec.requirements.includes('include_docker')) {
      files.push({
        fileName: 'Dockerfile',
        content: await this.generateDockerfile(spec),
        language: 'dockerfile',
        type: 'deployment'
      });
    }

    return files;
  }

  /**
   * Generate project structure
   */
  generateProjectStructure(spec) {
    const structure = {
      main: this.getMainFileName(spec),
      directories: [],
      files: []
    };

    if (spec.features.includes('user_interface')) {
      structure.directories.push('public', 'src/components', 'src/styles');
    }

    if (spec.requirements.includes('include_tests')) {
      structure.directories.push('tests', '__tests__');
    }

    if (spec.features.includes('database')) {
      structure.directories.push('database', 'migrations');
    }

    return structure;
  }

  /**
   * Validate and format generated code
   */
  async validateAndFormatCode(codePackage, spec) {
    // SAFETY: Handle both old format (object with .content) and new format (package with .mainFile)
    let mainFileContent = '';
    if (codePackage.mainFile && typeof codePackage.mainFile.content === 'string') {
      mainFileContent = codePackage.mainFile.content;
    } else if (typeof codePackage.content === 'string') {
      mainFileContent = codePackage.content;
    } else if (typeof codePackage === 'string') {
      mainFileContent = codePackage;
    } else {
      this.logger.error('Invalid code package structure', { codePackage: typeof codePackage });
      throw new Error('Cannot validate code - invalid package structure');
    }

    // Basic validation - check for syntax errors
    const validation = await this.validateCodeSyntax(mainFileContent, spec);

    if (!validation.valid) {
      this.logger.warn('Code validation failed, attempting to fix', {
        errors: validation.errors
      });
      // Attempt to fix common issues
      mainFileContent = await this.fixCodeIssues(mainFileContent, validation.errors, spec);
    }

    // Add file header with metadata
    const header = this.generateFileHeader(spec);
    mainFileContent = header + mainFileContent;

    // Return in consistent package format
    if (codePackage.mainFile) {
      codePackage.mainFile.content = mainFileContent;
      return codePackage;
    } else {
      // Legacy format
      return {
        content: mainFileContent,
        fileName: spec.mainFileName || `main.${this.getFileExtension(spec.language)}`
      };
    }
  }

  /**
   * Save code files to file system
   */
  async saveCodeFiles(codePackage, spec) {
    const savedFiles = [];

    // Ensure output directory exists
    await fs.mkdir(spec.outputDir, { recursive: true });

    // Save main file via Capabilities
    const mainFilePath = path.join(spec.outputDir, codePackage.mainFile.fileName);
    if (this.capabilities) {
      await this.capabilities.writeFile(
        mainFilePath,  // Use absolute path - pathResolver handles it correctly
        codePackage.mainFile.content,
        { agentId: this.agentId, agentType: 'code-creation', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(mainFilePath, codePackage.mainFile.content, 'utf8');
    }

    savedFiles.push({
      fileName: codePackage.mainFile.fileName,
      filePath: mainFilePath,
      language: codePackage.mainFile.language,
      type: codePackage.mainFile.type,
      lineCount: codePackage.mainFile.content.split('\n').length,
      size: codePackage.mainFile.content.length
    });

    // Save additional files
    for (const file of codePackage.additionalFiles) {
      const filePath = path.join(spec.outputDir, file.fileName);
      if (this.capabilities) {
        await this.capabilities.writeFile(
          filePath,  // Use absolute path - pathResolver handles it correctly
          file.content,
          { agentId: this.agentId, agentType: 'code-creation', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(filePath, file.content, 'utf8');
      }

      savedFiles.push({
        fileName: file.fileName,
        filePath,
        language: file.language,
        type: file.type,
        lineCount: file.content.split('\n').length,
        size: file.content.length
      });
    }

    // Save project structure file via Capabilities
    const structurePath = path.join(spec.outputDir, 'project-structure.json');
    if (this.capabilities) {
      await this.capabilities.writeFile(
        structurePath,  // Use absolute path - pathResolver handles it correctly
        JSON.stringify(codePackage.projectStructure, null, 2),
        { agentId: this.agentId, agentType: 'code-creation', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(structurePath, JSON.stringify(codePackage.projectStructure, null, 2), 'utf8');
    }

    this.logger.info('💾 Code files saved', {
      project: spec.projectName,
      outputDir: spec.outputDir,
      filesSaved: savedFiles.length,
      totalLines: savedFiles.reduce((sum, file) => sum + file.lineCount, 0)
    });

    return savedFiles;
  }

  /**
   * Add code to memory network
   */
  async addCodeToMemory(files, spec) {
    for (const file of files) {
      // Safety check: ensure content exists before using substring
      const content = file.content || '';
      const preview = content.length > 0 
        ? `${content.substring(0, 1000)}${content.length > 1000 ? '...' : ''}`
        : '[No content]';
      
      await this.addFinding(
        `Generated Code File: ${file.fileName}\n\n${preview}`,
        `generated_code_${spec.language}_${file.type}`
      );
    }

    // Add project metadata
    await this.addFinding(
      JSON.stringify({
        projectName: spec.projectName,
        language: spec.language,
        type: spec.type,
        complexity: spec.complexity,
        features: spec.features,
        files: files.map(f => ({ name: f.fileName, type: f.type })),
        createdAt: new Date().toISOString()
      }),
      'code_project_metadata'
    );

    this.logger.info('🧠 Generated code added to memory network', {
      project: spec.projectName,
      language: spec.language,
      fileCount: files.length
    });
  }

  /**
   * Load code templates
   */
  async loadCodeTemplates() {
    // JavaScript/Node.js templates
    this.codeTemplates.set('javascript_cli_tool_intermediate', {
      structure: {
        mainFile: 'cli-tool.js',
        dependencies: ['commander', 'chalk', 'fs-extra'],
        features: ['argument parsing', 'colored output', 'file operations']
      }
    });

    this.codeTemplates.set('javascript_api_server_intermediate', {
      structure: {
        mainFile: 'server.js',
        dependencies: ['express', 'cors', 'helmet', 'morgan'],
        features: ['REST API', 'middleware', 'error handling', 'logging']
      }
    });

    this.codeTemplates.set('python_data_processor_intermediate', {
      structure: {
        mainFile: 'data_processor.py',
        dependencies: ['pandas', 'numpy', 'matplotlib'],
        features: ['data manipulation', 'analysis', 'visualization']
      }
    });

    this.logger.info('🔧 Loaded code templates', {
      templatesLoaded: this.codeTemplates.size,
      languages: ['javascript', 'python']
    });
  }

  /**
   * Get generic language template
   */
  getGenericLanguageTemplate(language) {
    const templates = {
      javascript: {
        extension: '.js',
        comment: '//',
        structure: {
          mainFile: 'index.js',
          dependencies: [],
          features: ['basic structure']
        }
      },
      go: {
        extension: '.go',
        comment: '//',
        structure: {
          mainFile: 'main.go',
          dependencies: [],
          features: ['basic structure']
        }
      },
      python: {
        extension: '.py',
        comment: '#',
        structure: {
          mainFile: 'main.py',
          dependencies: [],
          features: ['basic structure']
        }
      },
      bash: {
        extension: '.sh',
        comment: '#',
        structure: {
          mainFile: 'script.sh',
          dependencies: [],
          features: ['shell commands']
        }
      }
    };

    return templates[language] || templates.javascript;
  }

  // Helper methods

  getMainFileName(spec) {
    const template = this.getCodeTemplate(spec.language, spec.type, spec.complexity);
    return template.structure.mainFile;
  }

  getTestFileName(spec) {
    const mainFile = this.getMainFileName(spec);
    const baseName = mainFile.replace(/\.[^.]+$/, '');
    return `${baseName}.test.${spec.language === 'javascript' ? 'js' : 'py'}`;
  }

  async generateReadme(spec) {
    return `# ${spec.projectName}

Generated ${spec.type} in ${spec.language}

## Description

${this.mission.description}

## Features

${spec.features.map(f => `- ${f}`).join('\n')}

## Installation

\`\`\`bash
${spec.language === 'javascript' ? 'npm install' : 'pip install -r requirements.txt'}
\`\`\`

## Usage

\`\`\`bash
${spec.language === 'javascript' ? 'node ' + this.getMainFileName(spec) : 'python ' + this.getMainFileName(spec)}
\`\`\`

## Generated Files

${['Main file: ' + this.getMainFileName(spec), ...spec.requirements.map(r => `- ${r.replace('include_', '').replace('_', ' ').toUpperCase()}`)].join('\n')}

*Generated by COSMO Code Creation Agent*
`;
  }

  async generatePackageJson(spec) {
    const dependencies = {};
    if (spec.features.includes('api')) dependencies.express = '^4.18.0';
    if (spec.features.includes('database')) dependencies['better-sqlite3'] = '^8.0.0';

    return JSON.stringify({
      name: spec.projectName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
      version: '1.0.0',
      description: this.mission.description,
      main: this.getMainFileName(spec),
      scripts: {
        start: `node ${this.getMainFileName(spec)}`,
        test: spec.requirements.includes('include_tests') ? 'jest' : 'echo "No tests specified"'
      },
      dependencies,
      devDependencies: spec.requirements.includes('include_tests') ? {
        jest: '^29.0.0',
        nodemon: '^2.0.0'
      } : {}
    }, null, 2);
  }

  async generateTests(spec) {
    if (spec.language === 'javascript') {
      return `const ${spec.projectName.replace(/[^a-zA-Z0-9]/g, '')} = require('./${this.getMainFileName(spec).replace('.js', '')}');

describe('${spec.projectName}', () => {
  test('should perform basic functionality', () => {
    // Add your tests here
    expect(true).toBe(true);
  });
});
`;
    }

    return `# Tests for ${spec.projectName}
# Add your test functions here
`;
  }

  async generateDockerfile(spec) {
    if (spec.language === 'javascript') {
      return `FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 3000

CMD ["npm", "start"]
`;
    }

    return `# Dockerfile for ${spec.projectName}
FROM python:3.9-alpine

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
CMD ["python", "${this.getMainFileName(spec)}"]
`;
  }

  async gatherCodeContext(spec) {
    this.logger.info('📚 Gathering implementation context from memory', {}, 3);
    
    // GENERIC context gathering - adapts to ANY mission
    const contextQueries = [
      this.mission.description, // The actual mission/goal (most important)
      `${spec.projectName} requirements specifications`, // Project-specific
      `${spec.language} ${spec.type} implementation`, // Language/type specific
      'architecture design decisions', // Design work (generic)
      'implementation approach recommendations' // Analysis results (generic)
    ];

    const allContext = [];

    // ENHANCEMENT: Deep memory querying for rich context (like query interface)
    // Query interface uses 1000 nodes - we use 50 for focused but deep context
    const queryLimit = 50;  // Increased from 5 for richer code generation
    
    for (const query of contextQueries) {
      const results = await this.memory.query(query, queryLimit);
      allContext.push(...results.map(node => ({
        concept: node.concept,
        similarity: node.similarity,
        tag: node.tag
      })));
    }

    // Sort by similarity, take top results
    const sortedContext = allContext
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 100);  // Increased from 15 for more comprehensive context
    
    // Look for analysis/synthesis results (GENERIC - any domain)
    const designWork = await this.memory.query('analysis synthesis findings recommendations', 50);  // Increased from 10
    const designConcepts = designWork
      .filter(n => n.tag?.includes('analysis') || 
                  n.tag?.includes('synthesis') ||
                  n.tag?.includes('agent_finding'))
      .map(n => n.concept)
      .slice(0, 20);  // Increased from 5
    
    this.logger.info('📋 Context gathered', {
      totalItems: sortedContext.length,
      designFindings: designConcepts.length,
      topSimilarity: sortedContext[0]?.similarity?.toFixed(3) || 'none'
    }, 3);
    
    // Combine and return as strings
    return [
      ...sortedContext.map(c => c.concept),
      ...designConcepts
    ].slice(0, 20); // Rich context for informed implementation
  }

  generateFileHeader(spec) {
    const timestamp = new Date().toISOString();
    return `/**
 * Generated Code: ${spec.projectName}
 * Type: ${spec.type}
 * Language: ${spec.language}
 * Complexity: ${spec.complexity}
 * Generated: ${timestamp}
 * Agent: ${this.agentId}
 *
 * Mission: ${this.mission.description}
 */

`;
  }

  getFallbackCode(spec) {
    if (spec.language === 'javascript') {
      return `// Fallback generated code for ${spec.projectName}
// This is a basic template - please review and customize

console.log('Hello from ${spec.projectName}!');

// Add your code here

module.exports = {
  // Export your main functionality here
};
`;
    }

    if (spec.language === 'python') {
      return `# Fallback generated code for ${spec.projectName}
# This is a basic template - please review and customize

print(f"Hello from {spec.projectName}!")

# Add your code here

if __name__ == "__main__":
    # Main execution
    pass
`;
    }

    return `# Generated ${spec.language} code for ${spec.projectName}
# Please review and customize this template
`;
  }

  async validateCodeSyntax(codeContent, spec) {
    // Basic validation - check for balanced brackets, proper imports, etc.
    const errors = [];

    // SAFETY: Ensure codeContent is a string
    if (!codeContent || typeof codeContent !== 'string') {
      errors.push('Invalid code content - not a string');
      return {
        valid: false,
        errors
      };
    }

    if (spec.language === 'javascript') {
      // Check for basic JS syntax issues
      const openBraces = (codeContent.match(/\{/g) || []).length;
      const closeBraces = (codeContent.match(/\}/g) || []).length;

      if (openBraces !== closeBraces) {
        errors.push('Unbalanced curly braces');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  async fixCodeIssues(code, errors, spec) {
    // Attempt to fix common issues
    let fixedCode = code;

    for (const error of errors) {
      if (error.includes('curly braces')) {
        // Simple fix attempt - this is basic and may not work for complex cases
        fixedCode = fixedCode.replace(/}\s*$/, '\n}');
      }
    }

    return fixedCode;
  }

  /**
   * Trigger completion agent for code validation
   */
  async triggerCompletionAgent(files, spec) {
    try {
      // Send message to spawn completion agent
      await this.sendMessage('meta_coordinator', 'spawn_completion_agent', {
        triggerSource: this.agentId,
        targetOutput: {
          id: spec.projectName,
          type: 'code_project',
          files: files.map(f => ({ name: f.fileName, type: f.type, lines: f.lineCount })),
          language: spec.language,
          features: spec.features,
          totalLines: files.reduce((sum, file) => sum + file.lineCount, 0)
        },
        reason: 'Significant code project generated - validation recommended',
        priority: 'medium'
      });

      this.logger.info('🎯 Triggered completion agent for code validation', {
        projectName: spec.projectName,
        totalLines: files.reduce((sum, file) => sum + file.lineCount, 0),
        features: spec.features
      });
    } catch (error) {
      this.logger.warn('Failed to trigger completion agent', {
        error: error.message,
        projectName: spec.projectName
      });
    }
  }
  /**
   * Download and save generated files from local backend
   * Files are already on disk in the execution working directory
   * This matches the container flow: files created → tracked → copied to agent output dir → registered in memory
   */
  async downloadAndSaveGeneratedFilesLocal() {
    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > error (no process.cwd() fallback)
    let outputDir;
    if (this.pathResolver) {
      outputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
    } else if (this.config?.logsDir) {
      outputDir = path.join(this.config.logsDir, 'outputs', 'code-creation', this.agentId);
    } else {
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      
      // CRITICAL: Use same pattern as containers - check codeResults first, then fallback to directory scan
      // This ensures we respect the COSMO system design
      let filesToDownload = [];
      
      // Method 1: Files from codeResults (same as containers)
      if (this.generatedFiles && this.generatedFiles.length > 0) {
        filesToDownload = this.generatedFiles;
        this.logger.info('📁 Using files from codeResults (annotated)', {
          count: filesToDownload.length
        }, 3);
      }
      
      // Method 2: Fallback to directory scan (for local execution)
      if (filesToDownload.length === 0) {
        try {
          const files = await this.executionBackend.listFiles();
          
          // Filter out temp script files and directories
          filesToDownload = (files || []).filter(f => {
            // Skip temp execution scripts
            if (f.filename && f.filename.startsWith('exec_') && f.filename.endsWith('.py')) {
              return false;
            }
            // Skip directories
            if (f.path && f.path.endsWith('/')) {
              return false;
            }
            return true;
          });
          
          this.logger.info('📁 Using files from directory scan', {
            count: filesToDownload.length,
            totalScanned: files?.length || 0
          }, 3);
        } catch (listError) {
          this.logger.warn('Could not list local execution files', {
            error: listError.message
          }, 3);
        }
      }
      
      if (filesToDownload.length === 0) {
        this.logger.warn('⚠️ No files found from local execution backend', {
          annotated: this.generatedFiles?.length || 0,
          method: 'local_backend'
        }, 3);
        return [];
      }
      
      // Download and save files (same pattern as containers)
      const savedFiles = [];
      
      for (const fileRef of filesToDownload) {
        try {
          // Get file identifier (supports both annotation format and directory scan format)
          const fileId = fileRef.file_id || fileRef.id || 
                        (typeof fileRef === 'string' ? fileRef : null);
          const filename = fileRef.filename || fileRef.name || 
                          (fileId ? `file_${fileId.substring(6, 14)}` : `file_${Date.now()}.txt`);
          
          if (!fileId && !fileRef.path) {
            this.logger.warn('Skipping file with missing identifier', { fileRef }, 3);
            continue;
          }
          
          // Read file content from local backend
          // CRITICAL: If path exists (from codeResults), use it directly for efficiency
          // Otherwise, use downloadFile() which will scan and find by file_id
          let fileContent;
          if (fileRef.path && path.isAbsolute(fileRef.path)) {
            // Direct path access (from codeResults) - read directly
            fileContent = await fs.readFile(fileRef.path);
          } else {
            // Use downloadFile() which handles file_id lookup via directory scan
            fileContent = await this.executionBackend.downloadFile(fileId || fileRef.path);
          }
          const fileBuffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
          
          // Determine output path (preserve relative path structure if present)
          // CRITICAL: filename from formatResults is already relative (e.g., "schemas/file.json")
          // If filename contains path separators, use it directly; otherwise extract from absolute path
          let fileName = filename;
          
          // Check if filename already has directory structure (from recursive scan)
          if (filename.includes('/') || filename.includes('\\')) {
            // filename is already relative path - use it directly
            const dirPath = path.dirname(fileName);
            if (dirPath !== '.') {
              await fs.mkdir(path.join(outputDir, dirPath), { recursive: true });
            }
            // fileName already set to filename (relative path)
          } else if (fileRef.path && path.isAbsolute(fileRef.path)) {
            // Fallback: Extract relative path from absolute path if filename is just basename
            // This handles cases where filename wasn't set correctly
            const executionDir = this.executionBackend.workingDir;
            if (fileRef.path.startsWith(executionDir)) {
              const relativePath = path.relative(executionDir, fileRef.path);
              const dirPath = path.dirname(relativePath);
              if (dirPath !== '.') {
                await fs.mkdir(path.join(outputDir, dirPath), { recursive: true });
                fileName = relativePath;
              } else {
                fileName = path.basename(relativePath);
              }
            }
          }
          
          const outputPath = path.join(outputDir, fileName);
          
          // Write file via Capabilities
          if (this.capabilities) {
            await this.capabilities.writeFile(
              outputPath,  // Use absolute path - pathResolver handles it correctly
              fileBuffer,
              { agentId: this.agentId, agentType: 'code-creation', missionGoal: this.mission.goalId }
            );
          } else {
            await fs.writeFile(outputPath, fileBuffer);
          }
          
          const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          
          savedFiles.push({
            fileName: fileName, // Preserve full relative path (e.g., "schemas/file.json")
            filename: path.basename(fileName), // Basename for compatibility
            filePath: outputPath,
            relativePath: path.relative(process.cwd(), outputPath),
            size: fileBuffer.length,
            sha256: fileHash,
            type: this.detectFileTypeFromName(fileName)
          });
          
          this.logger.debug('Saved local file', { 
            fileName: path.basename(fileName), 
            size: fileBuffer.length,
            source: fileId ? 'annotation' : 'directory_scan'
          });
        } catch (error) {
          this.logger.warn('Failed to save local file', { 
            filename: fileRef.filename || fileRef.name, 
            error: error.message 
          }, 3);
        }
      }
      
      this.logger.info('✅ Local files saved', { 
        count: savedFiles.length,
        annotated: this.generatedFiles?.length || 0,
        scanned: filesToDownload.length
      }, 3);
      
      // CRITICAL: Register files in memory so CodeExecutionAgent can discover them
      // This matches the container flow - files must be registered for discovery
      if (savedFiles.length > 0) {
        const filePathsData = {
          agentId: this.agentId,
          timestamp: new Date().toISOString(),
          files: savedFiles.map(f => ({
            filename: f.filename || f.fileName,
            path: f.filePath,  // Absolute path for discovery (matches document-creation pattern)
            relativePath: f.relativePath,  // Keep for display/logging
            size: f.size
          }))
        };
        
        await this.addFinding(
          JSON.stringify(filePathsData),
          'code_creation_output_files'
        );
        
        this.logger.info('📝 Files registered in memory for discovery', {
          count: savedFiles.length,
          tag: 'code_creation_output_files'
        }, 3);
      }
      
      // CRITICAL: Write completion marker (same as container flow)
      // This is required for dashboard validation to recognize completed agents
      if (savedFiles.length > 0) {
        await this.writeCompletionMarker(outputDir, {
          fileCount: savedFiles.length,
          totalSize: savedFiles.reduce((sum, f) => sum + (f.size || 0), 0),
          viaLocal: savedFiles.length,
          backend: 'local'
        });
        
        this.logger.info('✅ Completion marker written for local execution', {
          outputDir: path.basename(outputDir),
          fileCount: savedFiles.length
        }, 3);
      }
      
      return savedFiles;
    } catch (error) {
      this.logger.error('Failed to save local files', { error: error.message }, 3);
      return [];
    }
  }
  
  /**
   * Download and save generated files from container before cleanup
   * Reuses same pattern as CodeExecutionAgent
   */
  async downloadAndSaveGeneratedFiles() {
    if (!this.executionBackend) {
      return [];
    }
    
    // For local backend, files are already on disk - just scan and return them
    if (this.executionBackend.getBackendType() === 'local') {
      return await this.downloadAndSaveGeneratedFilesLocal();
    }

    const directSaved = [];
    const exportedSaved = [];

    // PRODUCTION: Use pathResolver for user-specific, run-isolated outputs
    // Fallback chain: pathResolver > config.logsDir > error (no process.cwd() fallback)
    let outputDir;
    if (this.pathResolver) {
      outputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
    } else if (this.config?.logsDir) {
      outputDir = path.join(this.config.logsDir, 'outputs', 'code-creation', this.agentId);
    } else {
      this.logger.error('Cannot determine output directory: no pathResolver or config.logsDir');
      throw new Error('Output directory cannot be determined - pathResolver and config.logsDir both unavailable');
    }
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      
      // Cleanup any orphaned temp files from previous runs
      await this.cleanupOrphanedTempFiles(outputDir);
      
      const completedInManifest = (this.planManifest?.files || []).filter(entry => entry?.status === 'complete');
      
      if (completedInManifest.length > 0) {
        this.logger.info('📦 Plan mode: exporting all completed entries directly via base64', {
          total: completedInManifest.length
        }, 3);

        for (const entry of completedInManifest) {
          const exported = await this.exportFileViaBase64(entry, outputDir);
          if (exported) {
            exportedSaved.push(exported);
          }
        }

        if (exportedSaved.length > 0) {
          await this.updateManifestFromSavedFiles(exportedSaved);
        }
      } else {
        let filesToDownload = [];
        let directoriesInContainer = [];
        
        try {
          const containerFiles = await this.executionBackend.listFiles();
          
          filesToDownload = (containerFiles || []).filter(f => {
            const isDirectory = Boolean(f.path?.endsWith('/'));
            if (isDirectory) {
              directoriesInContainer.push(f);
              this.logger.debug('Skipping directory in container listing', {
                path: f.path
              }, 3);
            }
            return !isDirectory;
          });
          
          this.logger.info('📁 Files found in container', {
            total: containerFiles?.length || 0,
            files: filesToDownload.length,
            directories: directoriesInContainer.length,
            annotated: this.generatedFiles.length,
            method: 'container_listing'
          }, 3);
        } catch (listError) {
          this.logger.warn('Could not list container files, using annotations only', {
            error: listError.message
          }, 3);
          filesToDownload = this.generatedFiles;
        }
        
        if (filesToDownload.length === 0 && this.generatedFiles.length > 0) {
          filesToDownload = this.generatedFiles;
          this.logger.info('Using annotated files only', {
            count: filesToDownload.length
          }, 3);
        }
        
        if (filesToDownload.length === 0) {
          this.logger.warn('No files to download from execution backend', {
            backendType: this.executionBackend?.getBackendType(),
            containerId: this.containerId
          }, 3);
        }
        
        // PARALLEL DOWNLOADS: Process files in batches to improve performance
        // Batch size of 3 balances speed vs API limits and memory usage
        const BATCH_SIZE = 3;
        
        for (let i = 0; i < filesToDownload.length; i += BATCH_SIZE) {
          const batch = filesToDownload.slice(i, i + BATCH_SIZE);
          
          this.logger.info(`📥 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(filesToDownload.length / BATCH_SIZE)}`, {
            batchSize: batch.length,
            total: filesToDownload.length
          }, 3);
          
          // Process batch in parallel
          const batchResults = await Promise.all(batch.map(async fileRef => {
          try {
            const fileId = fileRef.file_id || fileRef.id || (typeof fileRef === 'string' ? fileRef : null);
            
            if (!fileId) {
              this.logger.warn('Skipping file with missing ID', { fileRef }, 3);
                return null;
            }

            const fileContent = await this.executionBackend.downloadFile(fileId);
            const fileBuffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);
            const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

            const containerPathRaw = typeof fileRef === 'string' ? fileRef : (fileRef.path || fileRef.filename || fileRef.name || '');
            const fallbackName = fileRef.filename || fileRef.name || `${fileId.substring(6, 14)}.txt`;

            const { fullPath: filePath, relativePath: relativeOutputPath } = await this.ensureUniqueOutputPath(
              outputDir,
              containerPathRaw,
              fallbackName
            );

              // ATOMIC WRITE: Prevents partial file corruption on shutdown
              await this.writeFileAtomic(filePath, fileBuffer);

            const relativePathForManifest = path.join(
              'runtime',
              'outputs',
              'code-creation',
              this.agentId,
              relativeOutputPath.split(path.sep).join('/')
            );

            const fileSize = fileBuffer.length;
              const sizeKB = (fileSize / 1024).toFixed(1);
              this.logger.info(`   ✓ Saved: ${relativeOutputPath} (${sizeKB}KB)`, {}, 3);

              return {
              fileId,
              filename: relativeOutputPath,
              filePath,
              relativePath: relativePathForManifest,
              size: fileSize,
              sha256: fileHash,
              containerPath: containerPathRaw
              };
          } catch (error) {
            this.logger.warn(`   ✗ Failed to download file`, {
              fileRef,
              error: error.message
            }, 3);
              return null;
          }
          }));
          
          // Collect successful downloads from this batch
          directSaved.push(...batchResults.filter(r => r !== null));
        }

        if (directSaved.length > 0) {
          await this.updateManifestFromSavedFiles(directSaved);
        }
      }

      const savedFiles = [...directSaved, ...exportedSaved];

      if (savedFiles.length > 0) {
        const filePathsData = {
          agentId: this.agentId,
          goalId: this.mission.goalId, // CRITICAL: Link files to goal for scoped discovery
          containerId: this.containerId,
          timestamp: new Date().toISOString(),
          files: savedFiles.map(f => ({
            filename: f.filename,
            path: f.filePath,  // Absolute path for discovery (matches document-creation pattern)
            relativePath: f.relativePath,  // Keep for display/logging
            size: f.size
          }))
        };

        await this.addFinding(
          JSON.stringify(filePathsData),
          'code_creation_output_files'
        );

        this.logger.info('✅ Code files downloaded and saved', {
          saved: savedFiles.length,
          viaContainer: directSaved.length,
          viaExport: exportedSaved.length,
          outputDir
        }, 3);
        
        // Generate deliverables manifest with checksums
        await this.generateDeliverablesManifest(savedFiles, outputDir);
        
        // CRITICAL: Validate files AFTER download (localPath is now set)
        // Must happen BEFORE container deletion so we can use container for validation
        if (this.planManifest && this.planManifest.files) {
          await this.validateExportedFiles();
        }
        
        // Write completion marker (LAST STEP - signals all files are ready)
        await this.writeCompletionMarker(outputDir, {
          fileCount: savedFiles.length,
          totalSize: savedFiles.reduce((sum, f) => sum + (f.size || 0), 0),
          viaContainer: directSaved.length,
          viaExport: exportedSaved.length
        });
      } else {
        this.logger.warn('No code files were saved from the execution backend (direct download and export both empty)', {
          backendType: this.executionBackend?.getBackendType(),
          containerId: this.containerId
        }, 3);
      }

      return savedFiles;
    } catch (error) {
      this.logger.error('Failed to download generated files', {
        error: error.message,
        backendType: this.executionBackend?.getBackendType(),
        containerId: this.containerId
      }, 3);
      return [];
    }
  }

  /**
   * Generate deliverables manifest with checksums
   * Proves file integrity and enables downstream verification
   */
  async generateDeliverablesManifest(savedFiles, outputDir) {
    if (!savedFiles || savedFiles.length === 0) {
      return;
    }
    
    const crypto = require('crypto');
    const deliverables = [];
    
    for (const fileEntry of savedFiles) {
      // savedFiles contains objects from exportFileViaBase64, not strings
      const filePath = typeof fileEntry === 'string' ? fileEntry : fileEntry.filePath;
      
      if (!filePath || typeof filePath !== 'string') {
        this.logger.warn('Skipping invalid file entry in manifest generation', {
          entry: typeof fileEntry
        }, 4);
        continue;
      }
      
      try {
        const content = await fs.readFile(filePath);
        const checksum = crypto.createHash('sha256').update(content).digest('hex');
        
        // Find corresponding plan entry for metadata
        const relativePath = filePath.substring(outputDir.length + 1);
        const planEntry = this.planManifest?.files?.find(e => 
          e.localPath === filePath || 
          e.path === relativePath ||
          (e.localPath && e.localPath.endsWith(relativePath))
        );
        
        deliverables.push({
          path: relativePath,
          absolutePath: filePath,
          size: content.length,
          checksum: checksum,
          category: planEntry?.category || 'unknown',
          stage: planEntry?.stage || null,
          validationStatus: planEntry?.validationStatus || 'pending',
          exportedAt: new Date().toISOString()
        });
      } catch (error) {
        this.logger.warn('Failed to checksum file for manifest', {
          path: filePath,
          error: error.message
        }, 4);
      }
    }
    
    // Write manifest
    const manifestPath = path.join(outputDir, 'deliverables-manifest.json');
    const manifestData = {
      agentId: this.agentId,
      projectName: this.currentSpec?.projectName || 'unknown',
      language: this.currentSpec?.language || 'unknown',
      type: this.currentSpec?.type || 'unknown',
      generatedAt: new Date().toISOString(),
      totalFiles: deliverables.length,
      deliverables: deliverables,
      // METADATA: Provenance tracking (passive, no behavior change)
      goalId: this.mission?.goalId || null,
      spawnCycle: this.mission?.spawnCycle || null,
      missionId: this.mission?.missionId || null,
      spawningReason: this.mission?.spawningReason || null
    };
    
    // ATOMIC WRITE: Prevents partial deliverables manifest on shutdown
    await this.writeFileAtomic(
      manifestPath,
      JSON.stringify(manifestData, null, 2),
      { encoding: 'utf8' }
    );
    
    this.logger.info('📋 Deliverables manifest generated', {
      path: manifestPath,
      files: deliverables.length,
      totalSize: deliverables.reduce((sum, d) => sum + d.size, 0)
    }, 3);
  }

  /**
   * Validate exported files for syntax and basic integrity
   * Runs BEFORE container cleanup so we can use container for validation
   */
  async validateExportedFiles() {
    const validatedFiles = [];
    const invalidFiles = [];
    
    for (const entry of this.planManifest.files) {
      if (!entry.localPath) continue;
      
      try {
        const content = await fs.readFile(entry.localPath, 'utf8');
        
        // Basic validation: not empty, reasonable size
        if (content.length < 20) {
          invalidFiles.push({ path: entry.path, reason: 'file_too_short', size: content.length });
          entry.validationStatus = 'invalid_empty';
          continue;
        }
        
        // Python syntax check (via container or local)
        if (entry.path.endsWith('.py')) {
          try {
            let checkResult;
            if (this.executionBackend.getBackendType() === 'local') {
              // Local backend: use local Python to check syntax
              const { execSync } = require('child_process');
              try {
                execSync(`python3 -m py_compile "${entry.localPath}"`, { stdio: 'pipe' });
                checkResult = { content: 'SYNTAX_OK' };
              } catch (error) {
                checkResult = { content: `SYNTAX_ERROR\n${error.message}` };
              }
            } else {
              // Container backend: use container
              checkResult = await this.executionBackend.executeCode({
                input: `python3 -m py_compile /mnt/data/${entry.path} 2>&1 && echo "SYNTAX_OK" || echo "SYNTAX_ERROR"`,
                max_output_tokens: 2000,
                reasoningEffort: 'low'
              });
            }
            
            const output = checkResult.content || '';
            
            if (output.includes('SYNTAX_OK')) {
              validatedFiles.push(entry.path);
              entry.validationStatus = 'valid_syntax';
            } else {
              const errorSnippet = output.substring(0, 200);
              invalidFiles.push({ path: entry.path, reason: 'syntax_error', error: errorSnippet });
              entry.validationStatus = 'invalid_syntax';
            }
          } catch (error) {
            // Container execution failed - mark as validation error
            invalidFiles.push({ path: entry.path, reason: 'validation_failed', error: error.message });
            entry.validationStatus = 'validation_error';
          }
        } else {
          // Non-Python files: mark as exported (no syntax check available)
          validatedFiles.push(entry.path);
          entry.validationStatus = 'exported_unvalidated';
        }
      } catch (error) {
        invalidFiles.push({ path: entry.path, reason: 'read_error', error: error.message });
        entry.validationStatus = 'read_error';
      }
    }
    
    // Log validation results
    this.logger.info('✅ File validation complete', {
      total: this.planManifest.files.length,
      valid: validatedFiles.length,
      invalid: invalidFiles.length
    }, 2);
    
    // Add finding with detailed results
    this.logger.info('File validation complete', {
      valid: validatedFiles.length,
      invalid: invalidFiles.length,
      failures: invalidFiles.length > 0 ? invalidFiles.map(f => `${f.path} (${f.reason})`) : []
    });
    
    // Update manifest with validation results
    await this.persistPlanManifest(this.currentSpec);
    
    // Calculate and log success rate
    const totalFiles = this.planManifest.files.filter(f => f.localPath).length;
    const validFiles = validatedFiles.length;
    const successRate = totalFiles > 0 ? (validFiles / totalFiles) : 0;
    
    if (successRate >= 0.8) {
      this.logger.info('✅ Code creation succeeded with validation', {
        total: totalFiles,
        valid: validFiles,
        rate: (successRate * 100).toFixed(1) + '%'
      }, 2);
    } else {
      this.logger.warn('⚠️ Code creation completed but validation rate below threshold', {
        total: totalFiles,
        valid: validFiles,
        rate: (successRate * 100).toFixed(1) + '%',
        threshold: '80%'
      }, 2);
    }
  }

  /**
   * Delete container and cleanup resources
   */
  async cleanupContainer() {
    if (this.executionBackend) {
      // CRITICAL: Only download if we haven't already (files downloaded in execute())
      // If savedFiles is not populated, try download (handles onTimeout/onError cases)
      if (!this.savedFiles || this.savedFiles.length === 0) {
        try {
          this.savedFiles = await this.downloadAndSaveGeneratedFiles();
          this.logger.info('📥 Files saved during cleanup', {
            count: this.savedFiles?.length || 0
          });
        } catch (error) {
          this.logger.warn('Failed to download files before cleanup (non-fatal)', {
            error: error.message
          }, 3);
          this.savedFiles = [];
        }
      } else {
        this.logger.info('📥 Files already downloaded in execute(), skipping re-download', {
          count: this.savedFiles.length
        });
      }

      // Cleanup execution backend
      this.logger.info('🧹 Cleaning up execution backend', { 
        type: this.executionBackend.getBackendType(),
        containerId: this.containerId 
      }, 3);
      
      try {
        await this.executionBackend.cleanup();
        this.logger.info('✅ Execution backend cleaned up successfully');
      } catch (error) {
        // Non-fatal - just log
        this.logger.warn('Execution backend cleanup failed (non-fatal)', { 
          error: error.message 
        }, 3);
      }
      
      // Keep containerId null for backward compat
      this.containerId = null;
    }
  }

  /**
   * Cleanup: Delete container when done
   */
  async onComplete() {
    // Files already downloaded in execute() for DoD validation
    // Only cleanup container (don't re-download)
    await this.cleanupContainer();
    
    // CRITICAL: Trigger follow-up agents AFTER files are saved to disk
    // This ensures CodeExecutionAgent and QA can find the files
    if (this.currentSpec && this.savedFiles && this.savedFiles.length > 0) {
      this.logger.info('🔗 Triggering follow-up agents after file save', {
        filesCount: this.savedFiles.length,
        language: this.currentSpec.language
      });
      
      await this.triggerCodeExecution(this.currentSpec, this.savedFiles);
      await this.triggerQualityAssurance(this.currentSpec, this.savedFiles);
    }
    
    await super.onComplete();
  }

  /**
   * Cleanup on error
   */
  async onError(error) {
    await this.cleanupContainer();
    await super.onError(error);
  }

  /**
   * Cleanup on timeout
   */
  async onTimeout() {
    await this.cleanupContainer();
    await super.onTimeout();
  }

  /**
   * Trigger CodeExecutionAgent to test the created code
   * Implements "research team" workflow where code is created → tested → refined
   */
  async triggerCodeExecution(spec, generatedFiles) {
    try {
      // Use spec.outputDir if available, otherwise derive from pathResolver/config
      let outputDir = spec.outputDir;
      if (!outputDir) {
        if (this.pathResolver) {
          outputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
        } else if (this.config?.logsDir) {
          outputDir = path.join(this.config.logsDir, 'outputs', 'code-creation', this.agentId);
        } else {
          this.logger.warn('Cannot determine outputDir for triggerCodeExecution - skipping');
          return;
        }
      }
      
      // Send message to spawn CodeExecutionAgent with file references
      await this.sendMessage('meta_coordinator', 'spawn_code_execution_agent', {
        triggerSource: this.agentId,
        targetOutput: {
          id: this.agentId,
          type: 'code',
          language: spec.language,
          projectName: spec.projectName,
          outputDir,
          filesCount: generatedFiles.length
        },
        codeFiles: generatedFiles.map(f => ({
          filename: f.filename,
          relativePath: f.relativePath,
          size: f.size
        })),
        reason: 'Code created - execution and testing needed',
        priority: 'high'
      });

      this.logger.info('🧪 Requested CodeExecutionAgent for testing', {
        language: spec.language,
        filesCount: generatedFiles.length
      });

    } catch (error) {
      this.logger.warn('Failed to trigger CodeExecutionAgent', {
        error: error.message
      });
    }
  }

  /**
   * Trigger QA agent to validate the created code
   * Implements code review workflow
   */
  async triggerQualityAssurance(spec, generatedFiles) {
    try {
      // Use spec.outputDir if available, otherwise derive from pathResolver/config
      let outputDir = spec.outputDir;
      if (!outputDir) {
        if (this.pathResolver) {
          outputDir = path.join(this.pathResolver.getOutputsRoot(), 'code-creation', this.agentId);
        } else if (this.config?.logsDir) {
          outputDir = path.join(this.config.logsDir, 'outputs', 'code-creation', this.agentId);
        } else {
          this.logger.warn('Cannot determine outputDir for triggerQualityAssurance - skipping');
          return;
        }
      }
      
      // Send message to spawn QA agent with artifact reference
      await this.sendMessage('meta_coordinator', 'spawn_qa_agent', {
        triggerSource: this.agentId,
        targetOutput: {
          id: this.agentId,
          type: 'code',
          language: spec.language,
          projectName: spec.projectName,
          outputDir,
          filesCount: generatedFiles.length
        },
        artifactToReview: {
          path: outputDir,
          mission: {
            description: this.mission.description,
            goalId: this.mission.goalId
          },
          results: generatedFiles.map(f => ({
            type: 'code_file',
            filename: f.filename,
            path: f.relativePath,
            size: f.size
          }))
        },
        reason: 'Code created - quality assurance review needed',
        priority: 'high'
      });

      this.logger.info('🔍 Requested QA agent for code review', {
        language: spec.language,
        filesCount: generatedFiles.length
      });

    } catch (error) {
      this.logger.warn('Failed to trigger QA agent for code', {
        error: error.message
      });
    }
  }

  async writeDebugArtifact(spec, stamp, fileName, data, options = {}) {
    try {
      const { json = false } = options;
      const debugDir = path.join(spec.outputDir, '_debug');
      await fs.mkdir(debugDir, { recursive: true });
      const filePath = path.join(debugDir, `${stamp}_${fileName}`);
      const payload = json ? JSON.stringify(data, null, 2) : (typeof data === 'string' ? data : String(data));
      
      if (this.capabilities) {
        const result = await this.capabilities.writeFile(
          filePath,  // Use absolute path - pathResolver handles it correctly
          payload,
          { agentId: this.agentId, agentType: 'code-creation', missionGoal: this.mission.goalId }
        );
        
        // Debug artifacts are optional; respect Executive skip
        if (result?.success) return filePath;
        return null;
      }
      
      await fs.writeFile(filePath, payload, 'utf8');
      return filePath;
    } catch (err) {
      this.logger?.warn?.('Failed to write debug artifact', {
        fileName,
        error: err.message
      });
      return null;
    }
  }
}

module.exports = { CodeCreationAgent };
