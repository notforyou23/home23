/**
 * ExecutionBaseAgent — Shared base class for all execution agents
 *
 * Extends BaseAgent with execution infrastructure:
 *  - Sandboxed bash, Python, filesystem, HTTP, SQLite operations
 *  - Package installation scoped to workspace
 *  - Resource tracking (bytes, files, commands) with configurable limits
 *  - Full audit trail (JSONL)
 *  - Agentic execution loop with stuck detection
 *
 * Subclasses MUST override:
 *  - getAgentType()      — returns type key string (e.g. 'automation')
 *  - getDomainKnowledge() — returns domain-specific system prompt text
 *  - getToolSchema()      — returns tool definitions for the agentic loop
 *  - execute()            — entry point (typically calls runAgenticLoop)
 */

const { BaseAgent } = require('./base-agent');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { execSync, exec } = require('child_process');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════════════
// Blocked command patterns — reused from IDEAgent safety boundary
// ═══════════════════════════════════════════════════════════════════════════
const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+-rf?\s+\/(\s|$)/,             // rm -rf / (root wipe)
  /rm\s+-rf?\s+\/(bin|sbin|usr|etc|var|System|Library|Applications)\b/,  // System dirs
  /rm\s+-rf?\s+~\/?(\s|$)/,          // rm -rf ~/ (home wipe)
  />\s*\/dev\/(?!null)/,              // Block > /dev/sda etc, allow > /dev/null
  /curl.*\|\s*(ba)?sh/,              // curl | sh (remote code exec)
  /wget.*\|\s*(ba)?sh/,              // wget | sh
  /sudo\s/,
  /chmod\s+777/,
  /mkfs\./,
  /:\(\)\{.*\}/                       // fork bomb
];

// ═══════════════════════════════════════════════════════════════════════════
// Default resource limits
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_LIMITS = {
  maxBytesWritten: 100 * 1024 * 1024,  // 100 MB
  maxFilesCreated: 500,
  maxCommandsRun: 1000
};

const MIN_EXTENDED_DURATION = 900000; // 15 min

class ExecutionBaseAgent extends BaseAgent {
  constructor(mission, config, logger, eventEmitter = null) {
    // Ensure extended timeout — execution agents need more time
    const extendedMission = { ...mission };
    extendedMission.maxDuration = Math.max(mission.maxDuration || 0, MIN_EXTENDED_DURATION);
    super(extendedMission, config, logger);

    this.events = eventEmitter;

    // ── Resource tracking ─────────────────────────────────────────────────
    this.totalBytesWritten = 0;
    this.totalFilesCreated = 0;
    this.totalCommandsRun = 0;

    const cfgLimits = config?.execution?.limits || {};
    this.limits = {
      maxBytesWritten:  cfgLimits.maxBytesWritten  ?? DEFAULT_LIMITS.maxBytesWritten,
      maxFilesCreated:  cfgLimits.maxFilesCreated  ?? DEFAULT_LIMITS.maxFilesCreated,
      maxCommandsRun:   cfgLimits.maxCommandsRun   ?? DEFAULT_LIMITS.maxCommandsRun
    };

    // ── Agentic loop limits ───────────────────────────────────────────────
    // 25 iterations is too low for complex ETL/pipeline tasks that need to:
    // discover sources → read → transform → write → verify → fix
    // Execution agents have 30-60 min timeouts; iterations should match.
    this.maxIterations = config?.execution?.maxIterations || 150;

    // ── Audit log ─────────────────────────────────────────────────────────
    this.auditLog = [];

    // ── Sandbox: allowed paths ────────────────────────────────────────────
    const sandboxCfg = config?.execution?.sandbox || {};
    // Include both /tmp and the OS-reported temp directory (on macOS, os.tmpdir()
    // returns /var/folders/... while /tmp is a symlink to /private/tmp)
    const systemTmp = os.tmpdir();
    this._allowedPaths = ['/tmp', '/private/tmp', systemTmp];
    // Deduplicate
    this._allowedPaths = [...new Set(this._allowedPaths.map(p => path.resolve(p)))];

    // Add configured sandbox paths
    if (Array.isArray(sandboxCfg.allowedPaths)) {
      for (const p of sandboxCfg.allowedPaths) {
        this._allowedPaths.push(path.resolve(p));
      }
    }

    // The run's outputs directory will be resolved once pathResolver is available (onStart)
    this._outputDir = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Abstract methods — subclasses MUST override
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @returns {string} Agent type key (e.g. 'automation', 'dataacquisition')
   */
  getAgentType() {
    throw new Error('Subclass must implement getAgentType()');
  }

  /**
   * @returns {string} Domain-specific system prompt text
   */
  getDomainKnowledge() {
    throw new Error('Subclass must implement getDomainKnowledge()');
  }

  /**
   * @returns {Array<Object>} Tool definitions for the agentic loop (OpenAI function schema)
   */
  getToolSchema() {
    throw new Error('Subclass must implement getToolSchema()');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  async onStart() {
    await super.onStart();

    // Resolve output directory after pathResolver is injected
    if (this.pathResolver) {
      this._outputDir = path.join(
        this.pathResolver.getOutputsRoot(),
        this.getAgentType(),
        this.agentId
      );
    } else if (this.config.logsDir) {
      this._outputDir = path.join(
        this.config.logsDir,
        'outputs',
        this.getAgentType(),
        this.agentId
      );
    } else {
      this._outputDir = path.join(os.tmpdir(), 'cosmo-exec', this.agentId);
    }

    // Add outputs dir to sandbox allowlist
    this._allowedPaths.push(path.resolve(this._outputDir));

    // Add the run's outputs root so agents can read predecessor artifacts
    // (e.g., datapipeline reading dataacquisition output files)
    if (this.pathResolver) {
      this._allowedPaths.push(path.resolve(this.pathResolver.getOutputsRoot()));
    } else if (this.config.logsDir) {
      this._allowedPaths.push(path.resolve(path.join(this.config.logsDir, 'outputs')));
    }

    // Add the run root for reading state, coordinator files, etc.
    const runRoot = this.pathResolver?.getRuntimeRoot?.() || this.config.logsDir;
    if (runRoot) {
      this._allowedPaths.push(path.resolve(runRoot));
    }

    // Ensure output directory exists
    await fsPromises.mkdir(this._outputDir, { recursive: true });

    this.logger.info('ExecutionBaseAgent initialized', {
      agentId: this.agentId,
      agentType: this.getAgentType(),
      outputDir: this._outputDir,
      limits: this.limits
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Sandbox / Path Validation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Validate that a path is within the sandbox.
   * @param {string} targetPath — absolute or relative path
   * @returns {string} Resolved absolute path
   * @throws {Error} with "sandbox" in message for violations
   */
  validatePath(targetPath) {
    const resolved = path.resolve(targetPath);

    for (const allowed of this._allowedPaths) {
      if (resolved.startsWith(allowed)) {
        return resolved;
      }
    }

    throw new Error(
      `Path sandbox violation: "${targetPath}" (resolved: ${resolved}) is outside allowed paths: [${this._allowedPaths.join(', ')}]`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Audit Trail
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Record an operation in the audit log.
   */
  _audit(operation, args, result) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation,
      args,
      result: {
        success: result.success !== false,
        duration: result.duration || 0
      },
      agentId: this.agentId
    });
  }

  /**
   * @returns {Array<Object>} The full audit log
   */
  getAuditLog() {
    return this.auditLog;
  }

  /**
   * Write audit trail to disk as JSONL.
   */
  async writeAuditTrail() {
    if (!this._outputDir || this.auditLog.length === 0) return;

    const auditPath = path.join(this._outputDir, 'audit.jsonl');
    const lines = this.auditLog.map(e => JSON.stringify(e)).join('\n') + '\n';

    try {
      await fsPromises.mkdir(path.dirname(auditPath), { recursive: true });
      await fsPromises.writeFile(auditPath, lines, 'utf8');
      this.logger.debug('Audit trail written', { path: auditPath, entries: this.auditLog.length });
    } catch (err) {
      this.logger.warn('Failed to write audit trail', { error: err.message });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Resource Limit Checks
  // ═══════════════════════════════════════════════════════════════════════

  _checkBytesLimit(additionalBytes) {
    if (this.totalBytesWritten + additionalBytes > this.limits.maxBytesWritten) {
      throw new Error(
        `Resource limit: maxBytesWritten exceeded (${this.totalBytesWritten + additionalBytes} > ${this.limits.maxBytesWritten})`
      );
    }
  }

  _checkFilesLimit() {
    if (this.totalFilesCreated + 1 > this.limits.maxFilesCreated) {
      throw new Error(
        `Resource limit: maxFilesCreated exceeded (${this.totalFilesCreated + 1} > ${this.limits.maxFilesCreated})`
      );
    }
  }

  _checkCommandsLimit() {
    if (this.totalCommandsRun + 1 > this.limits.maxCommandsRun) {
      throw new Error(
        `Resource limit: maxCommandsRun exceeded (${this.totalCommandsRun + 1} > ${this.limits.maxCommandsRun})`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Command Safety
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check a command against blocked patterns.
   * @param {string} command
   * @returns {{ blocked: boolean, pattern?: string }}
   */
  _checkCommandSafety(command) {
    for (const pattern of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(command)) {
        return { blocked: true, pattern: pattern.toString() };
      }
    }
    return { blocked: false };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Execution Primitives
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute a shell command in a subprocess.
   *
   * @param {string} command
   * @param {Object} [options]
   * @param {number} [options.timeout=60000]  Timeout in ms
   * @param {string} [options.cwd]            Working directory
   * @param {Object} [options.env]            Additional env vars
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, blocked: boolean, duration: number}>}
   */
  async executeBash(command, options = {}) {
    const start = Date.now();
    const timeout = options.timeout || 60000;

    // Safety check
    const safety = this._checkCommandSafety(command);
    if (safety.blocked) {
      const result = {
        stdout: '',
        stderr: `BLOCKED: Command matched safety pattern ${safety.pattern}`,
        exitCode: -1,
        timedOut: false,
        blocked: true,
        duration: Date.now() - start
      };
      this._audit('executeBash', { command }, { success: false, duration: result.duration });
      this.logger.warn('Blocked dangerous command', { command: command.substring(0, 80), pattern: safety.pattern });
      return result;
    }

    // Resource limit
    this._checkCommandsLimit();

    return new Promise((resolve) => {
      const execOptions = {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...(options.env || {}) }
      };

      if (options.cwd) {
        execOptions.cwd = options.cwd;
      }

      exec(command, execOptions, (error, stdout, stderr) => {
        const duration = Date.now() - start;
        const timedOut = error && error.killed;

        this.totalCommandsRun++;

        const result = {
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error.code || 1) : 0,
          timedOut: !!timedOut,
          blocked: false,
          duration
        };

        this._audit('executeBash', { command: command.substring(0, 200) }, { success: result.exitCode === 0, duration });
        resolve(result);
      });
    });
  }

  /**
   * Execute a Python script.
   *
   * Writes the script to a temp file, optionally pip-installs packages,
   * then runs with python3.
   *
   * @param {string} script        Python source code
   * @param {Object} [options]
   * @param {number} [options.timeout=120000]
   * @param {string[]} [options.packages]  pip packages to install first
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean, duration: number}>}
   */
  async executePython(script, options = {}) {
    const timeout = options.timeout || 120000;
    const tmpDir = path.join(os.tmpdir(), `cosmo-py-${this.agentId}-${Date.now()}`);
    await fsPromises.mkdir(tmpDir, { recursive: true });

    const scriptPath = path.join(tmpDir, 'script.py');
    await fsPromises.writeFile(scriptPath, script, 'utf8');

    // Install packages if requested
    if (options.packages && options.packages.length > 0) {
      const pkgList = options.packages.join(' ');
      const installResult = await this.executeBash(
        `python3 -m pip install --target "${tmpDir}/site-packages" ${pkgList}`,
        { timeout: Math.min(timeout, 60000) }
      );
      if (installResult.exitCode !== 0) {
        await this._cleanupDir(tmpDir);
        return {
          stdout: '',
          stderr: `Package install failed: ${installResult.stderr}`,
          exitCode: installResult.exitCode,
          timedOut: false,
          duration: installResult.duration
        };
      }
    }

    // Build PYTHONPATH if we installed packages
    const envOverrides = {};
    try {
      await fsPromises.stat(path.join(tmpDir, 'site-packages'));
      envOverrides.PYTHONPATH = path.join(tmpDir, 'site-packages');
    } catch { /* no site-packages */ }

    const result = await this.executeBash(
      `python3 "${scriptPath}"`,
      { timeout, cwd: tmpDir, env: envOverrides }
    );

    // Cleanup
    await this._cleanupDir(tmpDir);

    return result;
  }

  /**
   * Read a file's contents. Path must be within sandbox.
   *
   * @param {string} filePath — absolute path
   * @returns {Promise<string>}
   */
  async readFile(filePath) {
    const start = Date.now();
    const resolved = this.validatePath(filePath);
    const content = await fsPromises.readFile(resolved, 'utf8');
    this._audit('readFile', { path: resolved }, { success: true, duration: Date.now() - start });
    return content;
  }

  /**
   * Write a file. Path must be within sandbox.
   *
   * @param {string} filePath — absolute path
   * @param {string} content
   * @returns {Promise<void>}
   */
  async writeFile(filePath, content) {
    const start = Date.now();
    const resolved = this.validatePath(filePath);
    const bytes = Buffer.byteLength(content, 'utf8');

    this._checkBytesLimit(bytes);
    this._checkFilesLimit();

    await fsPromises.mkdir(path.dirname(resolved), { recursive: true });
    await fsPromises.writeFile(resolved, content, 'utf8');

    this.totalBytesWritten += bytes;
    this.totalFilesCreated++;

    this._audit('writeFile', { path: resolved, bytes }, { success: true, duration: Date.now() - start });
  }

  /**
   * List directory contents. Path must be within sandbox.
   *
   * @param {string} dirPath — absolute path
   * @returns {Promise<Array<{name: string, type: string}>>}
   */
  async listDirectory(dirPath) {
    const start = Date.now();
    const resolved = this.validatePath(dirPath);
    const entries = await fsPromises.readdir(resolved, { withFileTypes: true });

    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file'
    }));

    this._audit('listDirectory', { path: resolved }, { success: true, duration: Date.now() - start });
    return items;
  }

  /**
   * HTTP fetch via curl subprocess. Avoids heavy npm dependencies.
   *
   * @param {string} url
   * @param {Object} [options]
   * @param {string} [options.method='GET']
   * @param {Object} [options.headers]
   * @param {string} [options.body]
   * @param {number} [options.timeout=30000]
   * @returns {Promise<{status: number, body: string, headers: string}>}
   */
  async httpFetch(url, options = {}) {
    const start = Date.now();
    const method = (options.method || 'GET').toUpperCase();
    const timeoutSec = Math.ceil((options.timeout || 30000) / 1000);

    let cmd = `curl -s -w "\\n__HTTP_STATUS__%{http_code}" -X ${method} --max-time ${timeoutSec}`;

    // Headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        // Escape double quotes and backslashes in header values
        const safeKey = String(key).replace(/["\\\n\r]/g, '');
        const safeValue = String(value).replace(/["\\\n\r]/g, '');
        cmd += ` -H "${safeKey}: ${safeValue}"`;
      }
    }

    // Body
    let bodyFile = null;
    if (options.body) {
      // Write body to temp file to avoid shell escaping issues
      bodyFile = path.join(os.tmpdir(), `cosmo-http-body-${Date.now()}.tmp`);
      await fsPromises.writeFile(bodyFile, options.body, 'utf8');
      cmd += ` -d @"${bodyFile}"`;
    }

    cmd += ` "${url}"`;

    const execResult = await this.executeBash(cmd, { timeout: (options.timeout || 30000) + 5000 });

    // Clean up body temp file
    if (bodyFile) {
      try { await fsPromises.unlink(bodyFile); } catch (e) { /* ignore */ }
    }

    // Parse status from output
    let body = execResult.stdout;
    let status = 0;

    const statusMatch = body.match(/__HTTP_STATUS__(\d+)$/);
    if (statusMatch) {
      status = parseInt(statusMatch[1], 10);
      body = body.replace(/__HTTP_STATUS__\d+$/, '').trimEnd();
    }

    const result = {
      status,
      body,
      headers: '' // curl -s doesn't include headers; use -i if needed
    };

    this._audit('httpFetch', { url, method }, { success: status >= 200 && status < 400, duration: Date.now() - start });
    return result;
  }

  /**
   * Execute SQL against a SQLite database via the sqlite3 CLI.
   *
   * @param {string} dbPath — absolute path to .db file (must be in sandbox)
   * @param {string} sql
   * @returns {Promise<{output: string, exitCode: number}>}
   */
  async sqliteExec(dbPath, sql) {
    const start = Date.now();
    const resolved = this.validatePath(dbPath);

    // Write SQL to temp file to avoid shell escaping
    const sqlFile = path.join(os.tmpdir(), `cosmo-sql-${Date.now()}.sql`);
    await fsPromises.writeFile(sqlFile, sql, 'utf8');

    const result = await this.executeBash(
      `sqlite3 "${resolved}" < "${sqlFile}"`,
      { timeout: 30000 }
    );

    // Cleanup temp SQL file
    await fsPromises.unlink(sqlFile).catch(() => {});

    const output = {
      output: result.stdout || result.stderr,
      exitCode: result.exitCode
    };

    this._audit('sqliteExec', { dbPath: resolved, sqlLength: sql.length }, { success: result.exitCode === 0, duration: Date.now() - start });
    return output;
  }

  /**
   * Install a package scoped to the workspace directory.
   *
   * @param {string} packageName
   * @param {'npm'|'pip'} [manager='npm']
   * @returns {Promise<{success: boolean, output: string}>}
   */
  async installPackage(packageName, manager = 'npm') {
    const start = Date.now();
    let cmd;

    if (manager === 'pip') {
      const targetDir = path.join(this._outputDir, 'pip-packages');
      await fsPromises.mkdir(targetDir, { recursive: true });
      cmd = `python3 -m pip install --target "${targetDir}" ${packageName}`;
    } else {
      // npm — install into output directory
      const targetDir = this._outputDir;
      cmd = `cd "${targetDir}" && npm install ${packageName} --save --no-fund --no-audit`;
    }

    const result = await this.executeBash(cmd, { timeout: 120000 });

    const output = {
      success: result.exitCode === 0,
      output: result.stdout + (result.stderr ? '\n' + result.stderr : '')
    };

    this._audit('installPackage', { packageName, manager }, { success: output.success, duration: Date.now() - start });
    return output;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Agentic Execution Loop
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The shared execution loop that all subclasses call from their execute().
   *
   * 1. Build initial messages with system prompt + mission + context
   * 2. Call LLM with tool definitions from getToolSchema()
   * 3. If response has tool_calls, execute each via dispatchToolCall()
   * 4. Append tool results to conversation
   * 5. Check stuck detection (3 iterations with no meaningful output)
   * 6. Check iteration limit
   * 7. Loop back to step 2
   * 8. On completion, write audit trail, return results
   *
   * @param {string} systemPrompt    Full system prompt
   * @param {string} initialContext  Initial user message / context
   * @returns {Promise<Object>}      { success, iterations, toolCalls, conclusion }
   */
  async runAgenticLoop(systemPrompt, initialContext) {
    const tools = this.getToolSchema();

    // Auto-gather pre-flight context if caller didn't provide initialContext
    let contextMessage = initialContext;
    if (!contextMessage) {
      try {
        const preFlightData = await this.gatherPreFlightContext();
        contextMessage = this.buildContextMessage(
          preFlightData,
          this.mission,
          this._getDomainReferenceForMission?.() || null
        );
      } catch (err) {
        this.logger.warn('Pre-flight context gathering failed (non-fatal)', { error: err.message });
        contextMessage = `Execute the following mission:\n\n${this.mission.description}`;
      }
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextMessage }
    ];

    let iteration = 0;
    let totalToolCalls = 0;
    let consecutiveNoProgress = 0;
    const MAX_NO_PROGRESS = 3;
    let conclusion = '';

    while (iteration < this.maxIterations) {
      iteration++;

      const progressPct = Math.min(90, 5 + (iteration / this.maxIterations) * 80);
      await this.reportProgress(progressPct, `Execution iteration ${iteration}`);

      // ── LLM call ────────────────────────────────────────────────────────
      let response;
      try {
        response = await this.gpt5.createCompletion({
          messages: this._trimMessages(messages),
          tools,
          model: this.config?.execution?.model || this.config?.models?.primary
        });
      } catch (llmError) {
        this.logger.error('LLM call failed in agentic loop', { error: llmError.message, iteration });
        throw llmError;
      }

      const assistantMsg = response.choices?.[0]?.message;
      if (!assistantMsg) {
        this.logger.warn('No response from LLM', { iteration });
        break;
      }

      messages.push(assistantMsg);
      conclusion = assistantMsg.content || conclusion;

      // ── Check for completion (no tool calls) ────────────────────────────
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        this.logger.info('Agentic loop concluded (no more tool calls)', {
          iteration,
          totalToolCalls,
          conclusionLength: (assistantMsg.content || '').length
        });
        break;
      }

      // ── Execute tool calls ──────────────────────────────────────────────
      let madeProgress = false;

      for (const toolCall of assistantMsg.tool_calls) {
        totalToolCalls++;

        const result = await this._dispatchToolCallSafe(toolCall);

        // Track progress — write operations count as progress
        if (this._isProgressOperation(toolCall.function?.name)) {
          madeProgress = true;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      // ── Stuck detection ─────────────────────────────────────────────────
      if (!madeProgress) {
        consecutiveNoProgress++;
        if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
          this.logger.warn('Agent appears stuck — no progress operations', { consecutiveNoProgress });
          messages.push({
            role: 'user',
            content: 'You have not made progress in several iterations. Please either take concrete action or explain why you cannot proceed, then signal completion.'
          });
          consecutiveNoProgress = 0;
        }
      } else {
        consecutiveNoProgress = 0;
      }
    }

    // ── Bridge results into memory ──────────────────────────────────────────
    // Execution agents produce output via tool calls (files, commands) and a
    // final LLM conclusion. Without this bridge, this.results stays empty and
    // nothing enters the knowledge graph — the agent looks "unproductive."
    try {
      if (conclusion && conclusion.length > 50) {
        // Truncate very long conclusions to fit embedding limits
        const summaryText = conclusion.length > 4000
          ? conclusion.substring(0, 4000) + '\n[truncated]'
          : conclusion;
        await this.addFinding(summaryText, 'execution_result');
      }

      // Register created files as findings so downstream agents can discover them
      if (this._outputDir && this.totalFilesCreated > 0) {
        const filesSummary = `Execution agent ${this.getAgentType()} created ${this.totalFilesCreated} file(s) ` +
          `(${this.totalBytesWritten} bytes) in ${this._outputDir}. ` +
          `Ran ${this.totalCommandsRun} command(s) over ${iteration} iterations.`;
        await this.addFinding(filesSummary, 'execution_result');
      }
    } catch (bridgeErr) {
      this.logger.warn('Failed to bridge execution results to memory (non-fatal)', {
        error: bridgeErr.message
      });
    }

    // ── Finalization ────────────────────────────────────────────────────────
    await this.writeAuditTrail();
    await this.reportProgress(100, 'Execution complete');

    return {
      success: true,
      iterations: iteration,
      toolCalls: totalToolCalls,
      conclusion,
      metadata: {
        filesCreated: this.totalFilesCreated,
        artifactsCreated: this.totalFilesCreated,
        bytesWritten: this.totalBytesWritten,
        commandsRun: this.totalCommandsRun
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tool Dispatch
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Dispatch a tool call safely, catching errors and returning them as results.
   *
   * @param {Object} toolCall — { id, function: { name, arguments } }
   * @returns {Promise<Object>} Tool result or error object
   */
  async _dispatchToolCallSafe(toolCall) {
    const name = toolCall.function?.name;
    const argsJson = toolCall.function?.arguments || '{}';

    let args;
    try {
      args = typeof argsJson === 'object' ? argsJson : JSON.parse(argsJson);
    } catch {
      return { error: `Failed to parse arguments for tool ${name}` };
    }

    try {
      return await this.dispatchToolCall(name, args);
    } catch (error) {
      this.logger.error('Tool dispatch error', { tool: name, error: error.message });
      return { error: error.message };
    }
  }

  /**
   * Route a tool call by name to the appropriate execution method.
   *
   * This handles the built-in execution primitives. Subclasses can override
   * to add domain-specific tools (call super.dispatchToolCall for defaults).
   *
   * @param {string} name — tool name
   * @param {Object} args — parsed arguments
   * @returns {Promise<Object>} Tool result
   */
  async dispatchToolCall(name, args) {
    switch (name) {
      case 'execute_bash':
      case 'run_bash':
      case 'run_terminal': {
        const result = await this.executeBash(args.command, {
          timeout: args.timeout,
          cwd: args.cwd
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          blocked: result.blocked
        };
      }

      case 'execute_python':
      case 'run_python': {
        const result = await this.executePython(args.script || args.code, {
          timeout: args.timeout,
          packages: args.packages
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut
        };
      }

      case 'read_file': {
        const content = await this.readFile(args.file_path || args.path);
        return { content, path: args.file_path || args.path };
      }

      case 'write_file':
      case 'create_file': {
        await this.writeFile(args.file_path || args.path, args.content);
        return { success: true, path: args.file_path || args.path };
      }

      case 'list_directory': {
        const items = await this.listDirectory(args.directory_path || args.path || args.dir_path);
        return { items };
      }

      case 'http_fetch':
      case 'http_request': {
        const result = await this.httpFetch(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body,
          timeout: args.timeout
        });
        return result;
      }

      case 'sqlite_exec':
      case 'run_sql': {
        const result = await this.sqliteExec(args.db_path || args.database, args.sql || args.query);
        return result;
      }

      case 'install_package': {
        const result = await this.installPackage(args.package_name || args.name, args.manager);
        return result;
      }

      default:
        return { error: `Unknown tool: ${name}. Available: execute_bash, execute_python, read_file, write_file, list_directory, http_fetch, sqlite_exec, install_package` };
    }
  }

  /**
   * Determine whether a tool call name counts as a "progress" operation
   * (used for stuck detection).
   */
  _isProgressOperation(toolName) {
    const progressOps = new Set([
      'execute_bash', 'run_bash', 'run_terminal',
      'execute_python', 'run_python',
      'write_file', 'create_file',
      'http_fetch', 'http_request',
      'sqlite_exec', 'run_sql',
      'install_package'
    ]);
    return progressOps.has(toolName);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Base Tool Schema — shared across all execution agents
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Returns the common execution tool definitions.
   * Subclasses typically call this from getToolSchema() and append domain-specific tools.
   */
  getBaseToolSchema() {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_bash',
          description: 'Execute a shell command and return stdout/stderr/exit code',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to execute' },
              timeout: { type: 'number', description: 'Timeout in milliseconds (default 60000)' },
              cwd: { type: 'string', description: 'Working directory (optional)' }
            },
            required: ['command'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'execute_python',
          description: 'Execute a Python script. Optionally install pip packages first.',
          parameters: {
            type: 'object',
            properties: {
              script: { type: 'string', description: 'Python source code' },
              timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
              packages: {
                type: 'array',
                items: { type: 'string' },
                description: 'pip packages to install before running'
              }
            },
            required: ['script'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents (must be within sandbox)',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Absolute path to file' }
            },
            required: ['file_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file (must be within sandbox)',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Absolute path to file' },
              content: { type: 'string', description: 'File content to write' }
            },
            required: ['file_path', 'content'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'List directory contents (must be within sandbox)',
          parameters: {
            type: 'object',
            properties: {
              directory_path: { type: 'string', description: 'Absolute path to directory' }
            },
            required: ['directory_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'http_fetch',
          description: 'HTTP request via curl. Returns status, body.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to fetch' },
              method: { type: 'string', description: 'HTTP method (GET, POST, etc.)' },
              headers: {
                type: 'object',
                description: 'Request headers as key-value pairs',
                additionalProperties: { type: 'string' }
              },
              body: { type: 'string', description: 'Request body (for POST/PUT)' },
              timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' }
            },
            required: ['url'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'sqlite_exec',
          description: 'Execute SQL against a SQLite database file',
          parameters: {
            type: 'object',
            properties: {
              db_path: { type: 'string', description: 'Path to SQLite database file' },
              sql: { type: 'string', description: 'SQL to execute' }
            },
            required: ['db_path', 'sql'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'install_package',
          description: 'Install a package (npm or pip) scoped to workspace',
          parameters: {
            type: 'object',
            properties: {
              package_name: { type: 'string', description: 'Package to install' },
              manager: { type: 'string', description: "'npm' or 'pip' (default: 'npm')" }
            },
            required: ['package_name'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Accomplishment Assessment Override
  // ═══════════════════════════════════════════════════════════════════════

  assessAccomplishment(executeResult, results) {
    // Execution agents measure accomplishment by commands run, files created, bytes written
    const metadata = executeResult?.metadata || {};
    const hasFindings = results.filter(r => r.type === 'finding').length > 0;
    const hasInsights = results.filter(r => r.type === 'insight').length > 0;
    const hasArtifacts = (metadata.filesCreated || 0) > 0
                      || (metadata.artifactsCreated || 0) > 0
                      || (metadata.commandsRun || 0) > 0;

    const accomplished = hasFindings || hasInsights || hasArtifacts;

    return {
      accomplished,
      reason: accomplished ? null : 'No execution output produced (0 findings, 0 files, 0 commands)',
      metrics: {
        findings: results.filter(r => r.type === 'finding').length,
        insights: results.filter(r => r.type === 'insight').length,
        filesCreated: metadata.filesCreated || 0,
        bytesWritten: metadata.bytesWritten || 0,
        commandsRun: metadata.commandsRun || 0
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Trim conversation messages to avoid exceeding context limits.
   * Keeps system message + last N messages.
   */
  _trimMessages(messages, maxMessages = 60) {
    if (messages.length <= maxMessages) return messages;

    // Always keep system message + first user message (mission context)
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const firstUser = rest[0]?.role === 'user' ? [rest[0]] : [];
    const conversation = firstUser.length > 0 ? rest.slice(1) : rest;

    // Take from the end, but ensure we don't split tool_call/tool_result pairs.
    // Walk backward to find a safe cut point: the start of a user or assistant
    // message that is NOT a tool result.
    const budget = maxMessages - system.length - firstUser.length;
    let cutIdx = Math.max(0, conversation.length - budget);

    // Scan forward from the cut point to find a safe boundary.
    // A safe boundary is a message that is NOT a tool result (role === 'tool')
    // and NOT a tool_result content block. This ensures we never start
    // the trimmed conversation with orphaned tool results.
    while (cutIdx < conversation.length) {
      const msg = conversation[cutIdx];
      if (msg.role === 'tool') {
        cutIdx++;
        continue;
      }
      // Also skip assistant messages that are just tool_use responses
      // (their tool results may have already been cut)
      break;
    }

    const kept = conversation.slice(cutIdx);
    return [...system, ...firstUser, ...kept];
  }

  /**
   * Clean up a temporary directory (best-effort).
   */
  async _cleanupDir(dirPath) {
    try {
      await fsPromises.rm(dirPath, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  /**
   * Get the output directory for this agent.
   */
  getOutputDir() {
    return this._outputDir;
  }
}

module.exports = { ExecutionBaseAgent };
