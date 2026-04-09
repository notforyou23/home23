/**
 * Skill Registry — Discovery, loading, invocation, and learning of reusable operations
 *
 * Skills are Level 2 of the Plugin → Skill → Tool hierarchy.
 * A skill is a reusable operation that combines tools with domain knowledge.
 * Examples: "Parse SDPB XML output", "Run a Python data analysis",
 * "Analyze convergence of a parameter sweep".
 *
 * Skills are loaded from three directories:
 *   1. engine/src/execution/skills/    — shipped with COSMO (authored)
 *   2. ~/.cosmo2.3/skills/             — user-installed
 *   3. ~/.cosmo2.3/skills/learned/     — COSMO-created from successful executions
 *
 * The registry:
 *   - Loads skill definitions from all three directories at startup
 *   - Normalizes all definitions through schemas.normalizeSkill
 *   - Invokes skills by resolving tool requirements and running implementations
 *   - Learns new skills from successful code executions via LLM-assisted extraction
 *   - Provides relevance scoring for capability-aware agent planning
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeSkill } = require('./schemas');

const COSMO_HOME = path.join(os.homedir(), '.cosmo2.3');
const USER_SKILLS_DIR = path.join(COSMO_HOME, 'skills');
const LEARNED_SKILLS_DIR = path.join(COSMO_HOME, 'skills', 'learned');
const BUILTIN_SKILLS_DIR = path.join(__dirname, 'skills');

// Minimum line count for a code block to be considered learnable
const MIN_LEARNABLE_LINES = 20;

// Max timeout for skill execution (seconds)
const MAX_EXECUTION_TIMEOUT_SEC = 600;

class SkillRegistry {
  /**
   * @param {Object} config - Registry configuration
   * @param {Object} logger - Logger instance (defaults to console)
   * @param {Object} toolRegistry - ToolRegistry instance for resolving tool requirements
   */
  constructor(config = {}, logger = console, toolRegistry = null) {
    this.config = config;
    this.logger = logger;
    this.toolRegistry = toolRegistry;
    this.skills = new Map();
    this._loadErrors = [];
  }

  get size() {
    return this.skills.size;
  }

  // ── Loading ───────────────────────────────────────────────────────────

  /**
   * Load skills from all three directories. Safe — never throws on bad files.
   * @returns {number} Number of skills loaded
   */
  async loadAll() {
    const dirs = [
      { path: BUILTIN_SKILLS_DIR, origin: 'authored', label: 'built-in' },
      { path: USER_SKILLS_DIR, origin: 'authored', label: 'user-installed', excludeSubdir: 'learned' },
      { path: LEARNED_SKILLS_DIR, origin: 'learned', label: 'learned' }
    ];

    let loaded = 0;
    this._loadErrors = [];

    for (const dir of dirs) {
      loaded += this._loadFromDirectory(dir.path, dir.origin, dir.label, dir.excludeSubdir);
    }

    this.logger.info(`[SkillRegistry] Loaded ${loaded} skills (${this.skills.size} total registered)`);
    if (this._loadErrors.length > 0) {
      this.logger.warn(`[SkillRegistry] ${this._loadErrors.length} files failed to load`);
    }

    return loaded;
  }

  /**
   * Load all .json skill files from a directory.
   * @param {string} dirPath - Directory to scan
   * @param {string} defaultOrigin - Origin to assign if not specified in file
   * @param {string} label - Human label for logging
   * @param {string|null} excludeSubdir - Subdirectory name to skip (avoids double-loading learned/)
   * @returns {number} Number loaded from this directory
   */
  _loadFromDirectory(dirPath, defaultOrigin, label, excludeSubdir = null) {
    if (!fs.existsSync(dirPath)) return 0;

    let count = 0;
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      this.logger.warn(`[SkillRegistry] Cannot read ${label} directory ${dirPath}: ${err.message}`);
      return 0;
    }

    for (const entry of entries) {
      // Skip excluded subdirectory
      if (excludeSubdir && entry.isDirectory() && entry.name === excludeSubdir) continue;

      // Only load .json files at this level
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const filePath = path.join(dirPath, entry.name);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw.origin) raw.origin = defaultOrigin;
        const skill = this.register(raw);
        if (skill) count++;
      } catch (err) {
        this._loadErrors.push({ file: filePath, error: err.message });
        this.logger.warn(`[SkillRegistry] Failed to load ${label} skill ${filePath}: ${err.message}`);
      }
    }

    if (count > 0) {
      this.logger.info(`[SkillRegistry] Loaded ${count} ${label} skills from ${dirPath}`);
    }
    return count;
  }

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register a skill definition. Normalizes through schemas.js.
   * Overwrites if a skill with the same ID already exists.
   * @param {Object} skillDef - Raw skill definition
   * @returns {Object} Normalized skill, or null on validation failure
   */
  register(skillDef) {
    try {
      const skill = normalizeSkill(skillDef);
      this.skills.set(skill.id, skill);
      return skill;
    } catch (err) {
      this.logger.warn(`[SkillRegistry] Failed to register skill: ${err.message}`);
      return null;
    }
  }

  // ── Querying ──────────────────────────────────────────────────────────

  /**
   * Get a skill by ID.
   * @param {string} skillId
   * @returns {Object|null}
   */
  get(skillId) {
    return this.skills.get(skillId) || null;
  }

  /**
   * Find skills matching filter criteria.
   * @param {Object} filter - { domain, pluginId, tags, capability, origin, available }
   * @returns {Array} Matching skills
   */
  query(filter = {}) {
    return Array.from(this.skills.values()).filter(skill => {
      if (filter.domain && skill.domain !== filter.domain) return false;
      if (filter.pluginId && skill.pluginId !== filter.pluginId) return false;
      if (filter.origin && skill.origin !== filter.origin) return false;

      if (filter.tags && Array.isArray(filter.tags)) {
        const hasOverlap = filter.tags.some(t => skill.tags.includes(t));
        if (!hasOverlap) return false;
      }

      if (filter.capability) {
        const capStr = filter.capability.toLowerCase();
        const matchesTag = skill.tags.some(t => t.toLowerCase().includes(capStr));
        const matchesDesc = skill.description.toLowerCase().includes(capStr);
        const matchesName = skill.name.toLowerCase().includes(capStr);
        if (!matchesTag && !matchesDesc && !matchesName) return false;
      }

      return true;
    });
  }

  /**
   * Get all skills belonging to a specific plugin.
   * @param {string} pluginId
   * @returns {Array}
   */
  getForPlugin(pluginId) {
    return this.query({ pluginId });
  }

  // ── Invocation ────────────────────────────────────────────────────────

  /**
   * Execute a skill by ID.
   *
   * Flow:
   *   1. Resolve tool requirements from toolRegistry
   *   2. Run implementation (python_script, bash_command, etc.)
   *   3. Capture stdout, stderr, exit code
   *   4. Check for expected output files
   *   5. Return structured result
   *
   * @param {string} skillId - Skill to invoke
   * @param {Object} inputs - Input values matching skill's input schema
   * @param {Object} executionContext - { workingDir, env, timeout_sec, runId }
   * @returns {Object} { success, exitCode, stdout, stderr, outputFiles, runtimeSec }
   */
  async invoke(skillId, inputs = {}, executionContext = {}) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return this._failResult(skillId, `Skill not found: ${skillId}`);
    }

    const impl = skill.implementation;
    if (!impl || impl.type === 'none') {
      return this._failResult(skillId, `Skill ${skillId} has no implementation`);
    }

    // 1. Check tool requirements
    const missingTools = this._checkToolRequirements(skill);
    if (missingTools.length > 0) {
      return this._failResult(skillId, `Missing required tools: ${missingTools.join(', ')}`);
    }

    // 2. Resolve execution parameters
    const workingDir = executionContext.workingDir || impl.workingDir || process.cwd();
    const timeoutSec = Math.min(
      executionContext.timeout_sec || impl.timeout_sec || 120,
      MAX_EXECUTION_TIMEOUT_SEC
    );
    const env = { ...process.env, ...(executionContext.env || {}) };

    // Inject inputs as environment variables (COSMO_INPUT_<key>)
    for (const [key, value] of Object.entries(inputs)) {
      env[`COSMO_INPUT_${key.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    // Also provide the full inputs as JSON
    env.COSMO_INPUTS_JSON = JSON.stringify(inputs);

    // 3. Execute based on implementation type
    const startTime = Date.now();
    let result;

    try {
      switch (impl.type) {
        case 'python_script':
          result = await this._executePython(impl, workingDir, env, timeoutSec);
          break;
        case 'bash_command':
          result = await this._executeBash(impl, workingDir, env, timeoutSec);
          break;
        case 'agent_delegation':
          result = this._failResult(skillId, 'Agent delegation must be handled by the orchestrator');
          break;
        case 'api_call':
          result = this._failResult(skillId, 'API call execution not yet implemented');
          break;
        default:
          result = this._failResult(skillId, `Unknown implementation type: ${impl.type}`);
      }
    } catch (err) {
      result = this._failResult(skillId, `Execution error: ${err.message}`);
    }

    const runtimeSec = (Date.now() - startTime) / 1000;
    result.runtimeSec = runtimeSec;
    result.skillId = skillId;

    // 4. Check for expected output files
    if (result.success && skill.outputs && skill.outputs.properties) {
      result.outputFiles = this._checkOutputFiles(skill.outputs, workingDir);
    }

    // 5. Update usage tracking
    this._recordUsage(skill, result.success);

    return result;
  }

  /**
   * Execute a Python script implementation.
   */
  async _executePython(impl, workingDir, env, timeoutSec) {
    const pythonCmd = this._resolvePythonCommand();
    if (!pythonCmd) {
      return { success: false, exitCode: -1, stdout: '', stderr: 'Python not available', outputFiles: [] };
    }

    const code = this._resolveCode(impl);
    if (!code) {
      return { success: false, exitCode: -1, stdout: '', stderr: 'No code or script path for python_script', outputFiles: [] };
    }

    return this._executeCommand(
      pythonCmd, ['-c', code],
      workingDir, env, timeoutSec
    );
  }

  /**
   * Execute a bash command implementation.
   */
  async _executeBash(impl, workingDir, env, timeoutSec) {
    const code = this._resolveCode(impl);
    if (!code) {
      return { success: false, exitCode: -1, stdout: '', stderr: 'No code or script path for bash_command', outputFiles: [] };
    }

    return this._executeCommand(
      '/bin/bash', ['-c', code],
      workingDir, env, timeoutSec
    );
  }

  /**
   * Run a command via child_process.spawn and capture output.
   * Uses spawn for proper streaming and timeout handling.
   */
  _executeCommand(command, args, workingDir, env, timeoutSec) {
    return new Promise((resolve) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;

      const child = spawn(command, args, {
        cwd: workingDir,
        env,
        timeout: timeoutSec * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      const finish = (exitCode, errorMsg) => {
        if (settled) return;
        settled = true;
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8') + (errorMsg || '');
        resolve({
          success: exitCode === 0,
          exitCode,
          stdout,
          stderr,
          outputFiles: []
        });
      };

      child.on('close', (code) => finish(code ?? 1));
      child.on('error', (err) => {
        if (err.code === 'ETIMEDOUT' || err.killed) {
          finish(-1, `\nProcess timed out after ${timeoutSec}s`);
        } else {
          finish(-1, `\nProcess error: ${err.message}`);
        }
      });
    });
  }

  /**
   * Resolve the Python command from the tool registry or fall back to python3.
   */
  _resolvePythonCommand() {
    if (this.toolRegistry) {
      const pythonTool = this.toolRegistry.get('tool:python');
      if (pythonTool && pythonTool.available) return pythonTool.command;
    }
    // Fallback: try python3 directly
    try {
      execSync('which python3 2>/dev/null', { timeout: 3000 });
      return 'python3';
    } catch {
      return null;
    }
  }

  /**
   * Resolve inline code or load from scriptPath.
   */
  _resolveCode(impl) {
    if (impl.code) return impl.code;
    if (impl.scriptPath) {
      const resolved = path.isAbsolute(impl.scriptPath)
        ? impl.scriptPath
        : path.join(__dirname, impl.scriptPath);
      try {
        return fs.readFileSync(resolved, 'utf-8');
      } catch (err) {
        this.logger.warn(`[SkillRegistry] Cannot read script: ${resolved}: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  /**
   * Check that all required tools are available.
   * @returns {string[]} Array of missing tool IDs (empty if all satisfied)
   */
  _checkToolRequirements(skill) {
    if (!this.toolRegistry) return []; // No registry — skip checks
    const missing = [];

    const requirements = [
      ...(skill.toolsRequired || []),
      ...(skill.implementation?.toolsRequired || [])
    ];

    for (const req of requirements) {
      const toolId = typeof req === 'string' ? req : req.id;
      if (!this.toolRegistry.isAvailable(toolId)) {
        missing.push(toolId);
      }
    }

    return missing;
  }

  /**
   * Check for expected output files declared in the skill's outputs schema.
   */
  _checkOutputFiles(outputs, workingDir) {
    const files = [];
    if (!outputs.properties) return files;

    for (const [key, schema] of Object.entries(outputs.properties)) {
      if (schema.type === 'file' || schema.filePath) {
        const filePath = schema.filePath
          ? path.resolve(workingDir, schema.filePath)
          : path.resolve(workingDir, key);
        try {
          const stat = fs.statSync(filePath);
          files.push({
            name: key,
            path: filePath,
            size: stat.size,
            contractMatch: true
          });
        } catch {
          files.push({
            name: key,
            path: filePath,
            size: 0,
            contractMatch: false
          });
        }
      }
    }
    return files;
  }

  /**
   * Record usage statistics on a skill after invocation.
   */
  _recordUsage(skill, success) {
    skill.usageCount = (skill.usageCount || 0) + 1;
    skill.lastUsed = new Date().toISOString();
    if (success) {
      skill.successCount = (skill.successCount || 0) + 1;
    } else {
      skill.failureCount = (skill.failureCount || 0) + 1;
    }
  }

  /**
   * Build a failure result object.
   */
  _failResult(skillId, reason) {
    return {
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: reason,
      outputFiles: [],
      runtimeSec: 0,
      skillId
    };
  }

  // ── Learning ──────────────────────────────────────────────────────────

  /**
   * Package a successful execution as a new learned skill.
   *
   * Pipeline:
   *   1. Check if the code is reusable (>20 lines, structured I/O, not a one-liner)
   *   2. Extract code and infer I/O schema
   *   3. Generate description via LLM
   *   4. Save to ~/.cosmo2.3/skills/learned/
   *   5. Register immediately
   *
   * @param {Object} executionResult - Result from a successful code execution
   * @param {Object} agentContext - { runId, agentId, cycle, domain, researchGoal }
   * @param {Object} llmClient - UnifiedClient instance for LLM calls
   * @returns {Object|null} The learned skill, or null if not learnable
   */
  async learnSkill(executionResult, agentContext = {}, llmClient = null) {
    // 1. Check reusability heuristics
    if (!this._isLearnable(executionResult)) {
      this.logger.info('[SkillRegistry] Execution result is not learnable (too short or no clear structure)');
      return null;
    }

    const code = executionResult.code || executionResult.stdout || '';
    const skillId = this._generateSkillId(agentContext);

    // 2. Infer I/O schema from code
    const ioSchema = this._inferIOSchema(code);

    // 3. Generate description via LLM (or fall back to basic extraction)
    let description = '';
    let name = skillId;
    let tags = [];
    let domain = agentContext.domain || null;

    if (llmClient) {
      try {
        const llmResult = await this._generateSkillMetadata(code, agentContext, llmClient);
        description = llmResult.description || '';
        name = llmResult.name || skillId;
        tags = llmResult.tags || [];
        if (llmResult.domain) domain = llmResult.domain;
      } catch (err) {
        this.logger.warn(`[SkillRegistry] LLM metadata generation failed: ${err.message}`);
        description = this._extractBasicDescription(code);
        name = this._extractNameFromCode(code) || skillId;
      }
    } else {
      description = this._extractBasicDescription(code);
      name = this._extractNameFromCode(code) || skillId;
    }

    // 4. Build skill definition
    const skillDef = {
      id: skillId,
      name,
      description,
      domain,
      tags,
      inputs: ioSchema.inputs,
      outputs: ioSchema.outputs,
      implementation: {
        type: this._inferImplementationType(code),
        code,
        timeout_sec: 120
      },
      toolsRequired: this._inferToolRequirements(code),
      origin: 'learned',
      learnedFrom: {
        runId: agentContext.runId || null,
        agentId: agentContext.agentId || null,
        cycle: agentContext.cycle || null
      },
      confidence: 0.7, // Learned skills start with moderate confidence
      createdAt: new Date().toISOString()
    };

    // 5. Save to disk and register
    try {
      this._ensureDirectory(LEARNED_SKILLS_DIR);
      const filePath = path.join(LEARNED_SKILLS_DIR, `${skillId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(skillDef, null, 2), 'utf-8');
      this.logger.info(`[SkillRegistry] Learned skill saved: ${filePath}`);
    } catch (err) {
      this.logger.warn(`[SkillRegistry] Failed to save learned skill to disk: ${err.message}`);
      // Still register in-memory even if disk write fails
    }

    const skill = this.register(skillDef);
    if (skill) {
      this.logger.info(`[SkillRegistry] Learned and registered skill: ${skill.id} (${skill.name})`);
    }

    return skill;
  }

  /**
   * Check whether an execution result is worth learning.
   * Heuristics: code is >20 lines, has clear structure, isn't a trivial one-off.
   */
  _isLearnable(executionResult) {
    if (!executionResult) return false;
    if (executionResult.exitCode !== 0 && !executionResult.success) return false;

    const code = executionResult.code || executionResult.stdout || '';
    if (!code || typeof code !== 'string') return false;

    const lines = code.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < MIN_LEARNABLE_LINES) return false;

    // Must have at least one function or class definition to suggest reusability
    const hasStructure = /^(def |class |function |async function |const \w+ = |module\.exports)/m.test(code);
    if (!hasStructure) {
      // Also accept if it has clear I/O patterns (argparse, sys.argv, input())
      const hasIO = /(argparse|sys\.argv|input\(|process\.argv|readline)/m.test(code);
      if (!hasIO) return false;
    }

    return true;
  }

  /**
   * Infer input/output schema from code by scanning for common patterns.
   */
  _inferIOSchema(code) {
    const inputs = { type: 'object', properties: {} };
    const outputs = { type: 'object', properties: {} };

    // Detect COSMO_INPUT env vars
    const envMatches = code.matchAll(/COSMO_INPUT_(\w+)/g);
    for (const match of envMatches) {
      const key = match[1].toLowerCase();
      inputs.properties[key] = { type: 'string', description: `Input: ${key}` };
    }

    // Detect argparse arguments
    const argMatches = code.matchAll(/add_argument\(['"]--?(\w[\w-]*)['"].*?type=(\w+)?/g);
    for (const match of argMatches) {
      const key = match[1].replace(/-/g, '_');
      const typ = match[2] || 'string';
      inputs.properties[key] = { type: typ === 'int' ? 'integer' : typ === 'float' ? 'number' : 'string' };
    }

    // Detect file outputs (open(..., 'w'), to_csv, savefig, etc.)
    const fileWriteMatches = code.matchAll(/(?:open\(['"]([^'"]+)['"],\s*['"]w|\.to_csv\(['"]([^'"]+)|\.savefig\(['"]([^'"]+)|\.to_json\(['"]([^'"]+))/g);
    for (const match of fileWriteMatches) {
      const filePath = match[1] || match[2] || match[3] || match[4];
      if (filePath) {
        const name = path.basename(filePath, path.extname(filePath));
        outputs.properties[name] = { type: 'file', filePath, description: `Output file: ${filePath}` };
      }
    }

    // Detect stdout as output if code prints structured data
    if (/json\.dumps|print\(.*json|console\.log\(JSON/m.test(code)) {
      outputs.properties.stdout_json = { type: 'string', description: 'JSON output on stdout' };
    }

    return { inputs, outputs };
  }

  /**
   * Use the LLM to generate a name, description, and tags for a code block.
   */
  async _generateSkillMetadata(code, agentContext, llmClient) {
    const truncatedCode = code.length > 3000 ? code.slice(0, 3000) + '\n...(truncated)' : code;
    const prompt = [
      'Analyze the following code that was successfully executed during a research run.',
      'Generate a JSON object with these fields:',
      '  - "name": short human-readable name (2-5 words, lowercase with hyphens)',
      '  - "description": one-sentence description of what the code does',
      '  - "tags": array of 2-5 relevant tags (lowercase)',
      '  - "domain": research domain if apparent (e.g., "data_analysis", "physics", "statistics")',
      '',
      `Research context: ${agentContext.researchGoal || agentContext.domain || 'general research'}`,
      '',
      '```',
      truncatedCode,
      '```',
      '',
      'Respond with ONLY the JSON object, no markdown fences.'
    ].join('\n');

    const response = await llmClient.chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 300
    });

    const text = (response.content || response.text || '').trim();

    // Parse JSON from response — handle possible markdown fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { description: text.slice(0, 200), name: null, tags: [], domain: null };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return { description: text.slice(0, 200), name: null, tags: [], domain: null };
    }
  }

  /**
   * Extract a basic description from code comments.
   */
  _extractBasicDescription(code) {
    const lines = code.split('\n');

    // Look for docstrings or top-level comments
    for (const line of lines.slice(0, 15)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && trimmed.length > 3) {
        return trimmed.replace(/^#+\s*/, '');
      }
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        return trimmed.replace(/^['"]{3}\s*/, '').replace(/['"]{3}$/, '');
      }
      if (trimmed.startsWith('//') && trimmed.length > 3) {
        return trimmed.replace(/^\/\/\s*/, '');
      }
    }
    return 'Learned skill from successful execution';
  }

  /**
   * Try to extract a readable name from the code's main function or filename references.
   */
  _extractNameFromCode(code) {
    // Look for def main or primary function name
    const funcMatch = code.match(/^(?:def|function|async function)\s+(\w+)/m);
    if (funcMatch && funcMatch[1] !== 'main') {
      return funcMatch[1].replace(/_/g, '-');
    }

    // Look for class name
    const classMatch = code.match(/^class\s+(\w+)/m);
    if (classMatch) {
      return classMatch[1].replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    }

    return null;
  }

  /**
   * Infer the implementation type from code content.
   */
  _inferImplementationType(code) {
    // Python markers
    if (/^(import |from |def |class |print\()/m.test(code)) return 'python_script';
    // Bash markers
    if (/^(#!\/bin\/(ba)?sh|set -e|echo |export |if \[)/m.test(code)) return 'bash_command';
    // Default to python
    return 'python_script';
  }

  /**
   * Infer tool requirements from code imports and commands.
   */
  _inferToolRequirements(code) {
    const tools = [];

    if (/^(import |from )/m.test(code)) {
      tools.push({ id: 'tool:python' });
    }

    // Check for common Python packages
    const importMatches = code.matchAll(/^(?:import|from)\s+([\w]+)/gm);
    const stdlibModules = new Set([
      'os', 'sys', 'json', 'math', 're', 'datetime', 'collections', 'itertools',
      'functools', 'pathlib', 'subprocess', 'shutil', 'glob', 'argparse', 'io',
      'csv', 'hashlib', 'logging', 'time', 'random', 'string', 'textwrap', 'copy'
    ]);
    for (const match of importMatches) {
      const mod = match[1].toLowerCase();
      if (!stdlibModules.has(mod)) {
        tools.push({ id: `tool:pip:${mod}` });
      }
    }

    if (/\b(docker run|docker exec|docker build)/m.test(code)) {
      tools.push({ id: 'tool:docker' });
    }
    if (/\b(curl |wget )/m.test(code)) {
      tools.push({ id: 'tool:curl' });
    }
    if (/\bgit (clone|pull|push|checkout)/m.test(code)) {
      tools.push({ id: 'tool:git' });
    }

    return tools;
  }

  /**
   * Generate a unique skill ID.
   */
  _generateSkillId(agentContext) {
    const timestamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    const prefix = agentContext.domain ? agentContext.domain.replace(/[^a-z0-9]/gi, '-').toLowerCase() : 'learned';
    return `skill:${prefix}:${timestamp}-${rand}`;
  }

  // ── Relevance Scoring ─────────────────────────────────────────────────

  /**
   * Score and rank skills by relevance to a research context.
   *
   * @param {Object} researchContext - { domain, goals, recentThoughts, gapAnalysis }
   * @returns {Array<{ skillId, score, skill }>} Sorted by descending score
   */
  scoreRelevance(researchContext = {}) {
    if (!researchContext || this.skills.size === 0) return [];

    const domain = (researchContext.domain || '').toLowerCase();
    const goals = Array.isArray(researchContext.goals) ? researchContext.goals : [];
    const goalTokens = this._extractTokens(goals.join(' '));
    const thoughtTokens = this._extractTokens(researchContext.recentThoughts || '');
    const gapTokens = this._extractTokens(researchContext.gapAnalysis || '');

    const scored = [];

    for (const skill of this.skills.values()) {
      let score = 0;

      // Exact domain match: +1.0
      if (domain && skill.domain && skill.domain.toLowerCase() === domain) {
        score += 1.0;
      }

      // Tag overlap with goals: +0.5 per overlapping tag
      const skillTokens = new Set([
        ...skill.tags.map(t => t.toLowerCase()),
        ...(skill.name || '').toLowerCase().split(/[\s\-_]+/)
      ]);
      for (const token of goalTokens) {
        if (skillTokens.has(token)) score += 0.5;
      }

      // Tag overlap with recent thoughts: +0.2 per overlap
      for (const token of thoughtTokens) {
        if (skillTokens.has(token)) score += 0.2;
      }

      // Tag overlap with gap analysis: +0.3 per overlap
      for (const token of gapTokens) {
        if (skillTokens.has(token)) score += 0.3;
      }

      // Recent usage bonus: +0.2
      if (skill.lastUsed) {
        const hoursSinceUse = (Date.now() - new Date(skill.lastUsed).getTime()) / (1000 * 60 * 60);
        if (hoursSinceUse < 24) score += 0.2;
      }

      // High success rate: +0.3
      if (skill.usageCount > 0) {
        const successRate = skill.successCount / skill.usageCount;
        if (successRate >= 0.7) score += 0.3;
      }

      if (score > 0) {
        scored.push({ skillId: skill.id, score, skill });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Extract meaningful tokens from text for relevance matching.
   */
  _extractTokens(text) {
    if (!text || typeof text !== 'string') return [];
    return text
      .toLowerCase()
      .split(/[\s,;:.\-_/()[\]{}'"]+/)
      .filter(t => t.length > 2)
      .filter(t => !STOP_WORDS.has(t));
  }

  // ── Snapshots ─────────────────────────────────────────────────────────

  /**
   * Compact summary for agent context injection.
   * @returns {Array} Skill summaries
   */
  getSnapshot() {
    return Array.from(this.skills.values()).map(s => ({
      id: s.id,
      name: s.name,
      domain: s.domain,
      tags: s.tags,
      origin: s.origin,
      confidence: s.confidence,
      usageCount: s.usageCount,
      successRate: s.usageCount > 0 ? +(s.successCount / s.usageCount).toFixed(2) : null
    }));
  }

  /**
   * Human-readable summary for system prompts.
   * @returns {string}
   */
  getSummaryText() {
    if (this.skills.size === 0) return 'No skills registered';

    const byOrigin = { authored: [], learned: [], generated: [] };
    for (const skill of this.skills.values()) {
      const bucket = byOrigin[skill.origin] || byOrigin.authored;
      bucket.push(skill);
    }

    const parts = [];

    if (byOrigin.authored.length > 0) {
      parts.push(`Built-in skills (${byOrigin.authored.length}): ${byOrigin.authored.map(s => s.name).join(', ')}`);
    }
    if (byOrigin.learned.length > 0) {
      const top = byOrigin.learned
        .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
        .slice(0, 10);
      parts.push(`Learned skills (${byOrigin.learned.length}): ${top.map(s => s.name).join(', ')}${byOrigin.learned.length > 10 ? ` (+${byOrigin.learned.length - 10} more)` : ''}`);
    }
    if (byOrigin.generated.length > 0) {
      parts.push(`Generated skills (${byOrigin.generated.length}): ${byOrigin.generated.map(s => s.name).join(', ')}`);
    }

    // Domains
    const domains = new Set();
    for (const skill of this.skills.values()) {
      if (skill.domain) domains.add(skill.domain);
    }
    if (domains.size > 0) {
      parts.push(`Domains: ${Array.from(domains).join(', ')}`);
    }

    return parts.join('\n');
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  /**
   * Ensure a directory exists, creating it recursively if needed.
   */
  _ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

// Common English stop words to exclude from relevance token matching
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'her', 'was', 'one', 'our', 'out', 'its', 'also', 'that', 'this', 'with',
  'from', 'they', 'been', 'have', 'will', 'each', 'make', 'like', 'into',
  'than', 'then', 'them', 'some', 'when', 'what', 'there', 'which', 'their',
  'about', 'would', 'these', 'other', 'could', 'after', 'should', 'using'
]);

module.exports = { SkillRegistry };
