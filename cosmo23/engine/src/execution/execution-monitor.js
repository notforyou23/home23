/**
 * Execution Monitor — Run code, capture everything, validate outputs, feed results to memory
 *
 * Responsibilities:
 *   1. Execute code (Python, Bash) in local or Docker environments via async child_process.spawn
 *   2. Capture stdout, stderr, runtime, and output files
 *   3. Validate output files against an output contract
 *   4. Ingest execution results into the memory graph as typed nodes with semantic edges
 *
 * Part of the Execution Architecture (Plugin → Skill → Tool → Environment → Monitor).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeExecutionResult, normalizeOutputContract } = require('./schemas');

class ExecutionMonitor {
  /**
   * @param {Object} config - Engine config
   * @param {Object} logger - Logger with info/warn/error/debug methods
   * @param {Object} toolRegistry - ToolRegistry instance
   * @param {Object} environmentProvisioner - EnvironmentProvisioner instance
   */
  constructor(config, logger, toolRegistry, environmentProvisioner) {
    this.config = config || {};
    this.logger = logger || console;
    this.toolRegistry = toolRegistry;
    this.environmentProvisioner = environmentProvisioner;
  }

  // ── Execution ──────────────────────────────────────────────────────────

  /**
   * Execute code in an environment and return a structured result.
   *
   * @param {Object} options
   * @param {string} options.code        - Source code or command to execute
   * @param {string} options.language     - 'python' | 'bash' | 'node'
   * @param {Object} [options.environment] - Environment object with envId, containerId, containerName, type
   * @param {Object} [options.outputContract] - Expected output files (normalizeOutputContract shape)
   * @param {number} [options.timeout_sec] - Execution timeout in seconds (default 120)
   * @param {string} [options.workingDir]  - Working directory override
   * @param {string} [options.skillId]     - Skill ID for provenance tracking
   * @param {string} [options.pluginId]    - Plugin ID for provenance tracking
   * @returns {Promise<Object>} normalizeExecutionResult() output
   */
  async execute(options) {
    const {
      code,
      language = 'python',
      environment = null,
      outputContract = null,
      timeout_sec = 120,
      workingDir = null,
      skillId = null,
      pluginId = null
    } = options;

    const effectiveWorkDir = workingDir
      || (environment && environment.workingDir)
      || process.cwd();

    const startTime = Date.now();
    let exitCode = -1;
    let stdout = '';
    let stderr = '';

    try {
      const execResult = await this._spawn(code, language, environment, effectiveWorkDir, timeout_sec);
      exitCode = execResult.exitCode;
      stdout = execResult.stdout;
      stderr = execResult.stderr;
    } catch (err) {
      stderr = err.message || String(err);
      this.logger.error(`[ExecutionMonitor] Execution error:`, err.message);
    }

    const runtimeSec = (Date.now() - startTime) / 1000;

    // Scan working directory for output files
    const outputFiles = this._scanOutputFiles(effectiveWorkDir);

    // Validate output contract if provided
    let contractValidation = null;
    if (outputContract) {
      contractValidation = await this.validateOutputs(outputContract, effectiveWorkDir);
    }

    const result = normalizeExecutionResult({
      skillId,
      pluginId,
      exitCode,
      stdout,
      stderr,
      outputFiles,
      runtimeSec,
      contractValidation
    });

    this.logger.info(`[ExecutionMonitor] Execution complete: exit=${exitCode}, runtime=${runtimeSec.toFixed(1)}s, files=${outputFiles.length}`);
    return result;
  }

  /**
   * Spawn a child process to execute code.
   * Uses child_process.spawn for async streaming (not execSync).
   *
   * @private
   */
  _spawn(code, language, environment, workingDir, timeout_sec) {
    return new Promise((resolve, reject) => {
      let cmd;
      let args;

      const isDocker = environment && environment.containerId && environment.type === 'docker';
      const containerRef = environment && environment.containerName;

      if (isDocker && containerRef) {
        // Execute inside Docker container
        const interpreter = this._getInterpreter(language);
        cmd = 'docker';
        args = ['exec', containerRef, interpreter, '-c', code];
      } else {
        // Execute locally
        const interpreter = this._getInterpreter(language);
        cmd = interpreter;
        args = ['-c', code];
      }

      const spawnOpts = {
        cwd: workingDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 0  // We manage timeout ourselves for clean kill
      };

      let child;
      try {
        child = spawn(cmd, args, spawnOpts);
      } catch (err) {
        return reject(new Error(`Failed to spawn process: ${err.message}`));
      }

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      // Timeout enforcement
      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill('SIGTERM');
          // Give a grace period before SIGKILL
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }, 3000);
        } catch { /* process already exited */ }
      }, timeout_sec * 1000);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Process error: ${err.message}`));
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (killed) {
          stderr += `\n[COSMO] Process killed after ${timeout_sec}s timeout`;
        }
        resolve({
          exitCode: exitCode !== null ? exitCode : (killed ? 137 : -1),
          stdout,
          stderr
        });
      });
    });
  }

  /**
   * Resolve language name to interpreter command.
   * @private
   */
  _getInterpreter(language) {
    switch ((language || '').toLowerCase()) {
      case 'python':
      case 'python3':
        return 'python3';
      case 'bash':
      case 'sh':
      case 'shell':
        return 'bash';
      case 'node':
      case 'javascript':
      case 'js':
        return 'node';
      default:
        return 'bash';
    }
  }

  /**
   * Scan a directory for output files (non-recursive, top-level only).
   * @private
   */
  _scanOutputFiles(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => e.isFile())
        .map(e => {
          const filePath = path.join(dir, e.name);
          let size = 0;
          try { size = fs.statSync(filePath).size; } catch { /* ignore */ }
          return {
            name: e.name,
            path: filePath,
            size,
            contractMatch: true  // Will be updated by validateOutputs if contract exists
          };
        });
    } catch (err) {
      this.logger.warn(`[ExecutionMonitor] Failed to scan output dir:`, err.message);
      return [];
    }
  }

  // ── Output Contract Validation ─────────────────────────────────────────

  /**
   * Validate actual output files against an output contract.
   *
   * @param {Object} contract - Raw or normalized output contract
   * @param {string} workingDir - Directory to check for files
   * @returns {Promise<{passed: boolean, expected: string[], found: string[], missing: string[]}>}
   */
  async validateOutputs(contract, workingDir) {
    const normalized = normalizeOutputContract(contract);
    const expectedOutputs = normalized.expectedOutputs;

    const expected = expectedOutputs.map(o => o.name);
    const found = [];
    const missing = [];

    for (const output of expectedOutputs) {
      const filePath = path.join(workingDir, output.name);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (output.minSizeBytes && stat.size < output.minSizeBytes) {
          missing.push(output.name);
          this.logger.warn(`[ExecutionMonitor] Output '${output.name}' exists but is too small (${stat.size} < ${output.minSizeBytes})`);
        } else {
          found.push(output.name);
        }
      } else if (output.required) {
        missing.push(output.name);
      }
    }

    const passed = missing.length === 0;
    this.logger.info(`[ExecutionMonitor] Contract validation: ${passed ? 'PASSED' : 'FAILED'} (${found.length}/${expected.length} found, ${missing.length} missing)`);

    return { passed, expected, found, missing };
  }

  // ── Memory Ingestion ───────────────────────────────────────────────────

  /**
   * Ingest an execution result into the memory graph as a typed node.
   *
   * - Success (exitCode 0) → node tagged 'execution_result'
   * - Failure (exitCode != 0) → node tagged 'execution_failure'
   * - Creates semantic edges to agent and goal if context provides IDs
   *
   * @param {Object} result - normalizeExecutionResult() output
   * @param {Object} memory - NetworkMemory instance (must have addNode, addEdge)
   * @param {Object} [agentContext] - { agentId, goalId, skillId }
   * @returns {Promise<{nodeId: *, tag: string, edges: Array}>}
   */
  async ingestResult(result, memory, agentContext = {}) {
    if (!memory || typeof memory.addNode !== 'function') {
      this.logger.warn('[ExecutionMonitor] Cannot ingest result: memory instance missing or invalid');
      return { nodeId: null, tag: null, edges: [] };
    }

    const isSuccess = result.exitCode === 0;
    const tag = isSuccess ? 'execution_result' : 'execution_failure';
    let concept;

    if (isSuccess) {
      const skillLabel = agentContext.skillId || result.skillId || 'code';
      const stdoutPreview = (result.stdout || '').slice(0, 500).replace(/\n/g, ' ');
      const fileCount = (result.outputFiles || []).length;
      concept = `Execution of ${skillLabel} completed: ${stdoutPreview}. Produced ${fileCount} output file${fileCount !== 1 ? 's' : ''}.`;
    } else {
      const stderrPreview = (result.stderr || '').slice(0, 500).replace(/\n/g, ' ');
      concept = `Execution failed (exit ${result.exitCode}): ${stderrPreview}`;
    }

    // Truncate concept to a reasonable length for the memory network
    if (concept.length > 2000) {
      concept = concept.slice(0, 2000) + '...';
    }

    const node = await memory.addNode(concept, tag);
    if (!node) {
      this.logger.warn('[ExecutionMonitor] Memory addNode returned null (quality gate rejection or embedding failure)');
      return { nodeId: null, tag, edges: [] };
    }

    const edges = [];

    // Create semantic edges if agent context provides IDs
    if (agentContext.agentId && typeof memory.addEdge === 'function') {
      try {
        memory.addEdge(node.id, agentContext.agentId, 0.4, 'EXECUTED_BY');
        edges.push({ from: node.id, to: agentContext.agentId, type: 'EXECUTED_BY' });
      } catch (err) {
        this.logger.debug(`[ExecutionMonitor] Edge creation (EXECUTED_BY) failed: ${err.message}`);
      }
    }

    if (agentContext.goalId && typeof memory.addEdge === 'function') {
      try {
        memory.addEdge(node.id, agentContext.goalId, 0.3, 'CONTRIBUTES_TO');
        edges.push({ from: node.id, to: agentContext.goalId, type: 'CONTRIBUTES_TO' });
      } catch (err) {
        this.logger.debug(`[ExecutionMonitor] Edge creation (CONTRIBUTES_TO) failed: ${err.message}`);
      }
    }

    this.logger.info(`[ExecutionMonitor] Ingested ${tag} node ${node.id} with ${edges.length} edges`);
    return { nodeId: node.id, tag, edges };
  }
}

module.exports = { ExecutionMonitor };
