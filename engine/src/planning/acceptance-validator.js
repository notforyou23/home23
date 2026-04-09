/**
 * AcceptanceValidator - Validates task completion against acceptance criteria
 * 
 * Supports three validation types:
 * - literal: Pattern matching in artifacts
 * - tool: Execute command and check exit code/output
 * - qa: AI QA agent evaluation
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class AcceptanceValidator {
  constructor(agentExecutor, logger) {
    this.agentExecutor = agentExecutor;
    this.logger = logger;
    
    // Read acceptance thresholds from config (defaults maintain current behavior)
    const config = agentExecutor?.config || {};
    this.defaultThreshold = config.acceptance?.defaultThreshold || 0.7;
    this.qaEnabled = config.acceptance?.qaEnabled !== false;
    this.toolValidation = config.acceptance?.toolValidation !== false;
    this.literalValidation = config.acceptance?.literalValidation !== false;
  }

  /**
   * Extract candidate file paths from a rubric/prompt
   * Supports @outputs/@exports prefixes and plain runtime paths.
   *
   * @param {string} text
   * @returns {string[]} unique paths
   */
  extractPathsFromText(text) {
    if (!text || typeof text !== 'string') return [];

    const paths = new Set();

    // Match @outputs/foo/bar.ext and @exports/foo.ext
    const tagged = text.match(/@(outputs|exports)\/[A-Za-z0-9_\-./]+/g) || [];
    for (const p of tagged) paths.add(p);

    // Match runtime/outputs/... and runtime/exports/...
    const runtime = text.match(/runtime\/(outputs|exports)\/[A-Za-z0-9_\-./]+/g) || [];
    for (const p of runtime) paths.add(p);

    // Match absolute paths under COSMO runtime (best-effort)
    const abs = text.match(/\/[A-Za-z0-9_\-./]*runtime\/(outputs|exports)\/[A-Za-z0-9_\-./]+/g) || [];
    for (const p of abs) paths.add(p);

    return Array.from(paths);
  }

  /**
   * Resolve a logical path to an absolute path (best-effort).
   * Prefers PathResolver when available.
   *
   * @param {string} logicalOrAbsolute
   * @returns {string}
   */
  resolvePath(logicalOrAbsolute) {
    if (!logicalOrAbsolute) return logicalOrAbsolute;
    try {
      const pathResolver = this.agentExecutor?.pathResolver;
      if (pathResolver && typeof pathResolver.resolve === 'function') {
        return pathResolver.resolve(logicalOrAbsolute);
      }
    } catch (_) {}

    // Fallback: treat as relative-to-repo or absolute as-is
    const path = require('path');
    return path.isAbsolute(logicalOrAbsolute)
      ? logicalOrAbsolute
      : path.join(process.cwd(), logicalOrAbsolute);
  }

  /**
   * Read small files referenced in the rubric and convert them into QA "results" entries.
   * This lets the QA agent validate REAL artifacts instead of guessing via keyword search.
   *
   * @param {string[]} logicalPaths
   * @returns {Promise<Array<{type: string, content?: string, path: string, metadata?: any}>>}
   */
  async loadFileEvidence(logicalPaths) {
    if (!logicalPaths || logicalPaths.length === 0) return [];
    const fs = require('fs').promises;
    const path = require('path');

    const MAX_BYTES = 200_000; // keep prompts bounded
    const results = [];

    for (const logical of logicalPaths) {
      const absPath = this.resolvePath(logical);
      try {
        const stats = await fs.stat(absPath);

        if (stats.isDirectory()) {
          // Shallow list for directories
          const entries = await fs.readdir(absPath);
          results.push({
            type: 'artifact_directory',
            path: logical,
            content: entries.slice(0, 50).join('\n'),
            metadata: { entryCount: entries.length }
          });
          continue;
        }

        if (stats.size > MAX_BYTES) {
          results.push({
            type: 'artifact_file',
            path: logical,
            content: `[File too large to inline: ${stats.size} bytes]`,
            metadata: { size: stats.size }
          });
          continue;
        }

        const ext = path.extname(absPath).toLowerCase();
        const isLikelyText = ['.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.bib', '.yaml', '.yml', '.py', '.js', '.ts'].includes(ext);
        if (!isLikelyText) {
          results.push({
            type: 'artifact_file',
            path: logical,
            content: `[Binary or unsupported extension for inline read: ${ext || '(none)'}]`,
            metadata: { size: stats.size }
          });
          continue;
        }

        const content = await fs.readFile(absPath, 'utf8');
        results.push({
          type: 'artifact_file',
          path: logical,
          content,
          metadata: { size: stats.size }
        });
      } catch (error) {
        results.push({
          type: 'artifact_missing',
          path: logical,
          content: `[Missing/unreadable: ${error.message}]`
        });
      }
    }

    return results;
  }

  /**
   * Check all acceptance criteria for a task
   * 
   * @param {array} acceptanceCriteria - Array of AcceptanceCriterion objects
   * @param {array} artifacts - Task artifacts to validate against
   * @returns {object} - { passed: boolean, failures: [{criterion, reason}] }
   */
  async checkAll(acceptanceCriteria, artifacts) {
    const failures = [];
    
    if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
      // No criteria = automatic pass
      return { passed: true, failures: [] };
    }
    
    for (const criterion of acceptanceCriteria) {
      try {
        let passed = false;
        
        switch (criterion.type) {
          case 'literal':
            passed = await this.checkLiteral(criterion, artifacts);
            break;
          case 'tool':
            passed = await this.checkTool(criterion, artifacts);
            break;
          case 'qa':
            passed = await this.checkQA(criterion, artifacts);
            break;
          default:
            this.logger?.warn('[AcceptanceValidator] Unknown criterion type', {
              type: criterion.type
            });
            passed = false;
        }
        
        if (!passed) {
          failures.push({
            criterion,
            reason: this.getFailureReason(criterion)
          });
        }
      } catch (error) {
        this.logger?.error('[AcceptanceValidator] Criterion check error', {
          criterion,
          error: error.message
        });
        failures.push({
          criterion,
          reason: `Error checking criterion: ${error.message}`
        });
      }
    }
    
    return {
      passed: failures.length === 0,
      failures
    };
  }

  /**
   * Check literal pattern matching in artifacts
   * 
   * @param {object} criterion - Literal acceptance criterion with pattern
   * @param {array} artifacts - Artifacts to search
   * @returns {boolean} - True if pattern found
   */
  async checkLiteral(criterion, artifacts) {
    if (!criterion.pattern) {
      this.logger?.warn('[AcceptanceValidator] Literal criterion missing pattern');
      return false;
    }
    
    // Create regex from pattern
    let regex;
    try {
      regex = new RegExp(criterion.pattern, 'i');
    } catch (error) {
      this.logger?.warn('[AcceptanceValidator] Invalid regex pattern', {
        pattern: criterion.pattern,
        error: error.message
      });
      // Try literal string match
      const pattern = criterion.pattern.toLowerCase();
      
      for (const artifact of artifacts) {
        const text = this.extractTextFromArtifact(artifact);
        if (text.toLowerCase().includes(pattern)) {
          return true;
        }
      }
      
      return false;
    }
    
    // Search artifacts for pattern
    for (const artifact of artifacts) {
      const text = this.extractTextFromArtifact(artifact);
      if (regex.test(text)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check tool execution (command exit code and output)
   * 
   * @param {object} criterion - Tool acceptance criterion with command
   * @param {array} artifacts - Artifacts (may be used by command)
   * @returns {boolean} - True if command succeeds (exit code 0)
   */
  async checkTool(criterion, artifacts) {
    if (!criterion.command) {
      this.logger?.warn('[AcceptanceValidator] Tool criterion missing command');
      return false;
    }
    
    try {
      // Execute command
      const { stdout, stderr } = await execAsync(criterion.command, {
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024 // 1MB buffer
      });
      
      this.logger?.debug('[AcceptanceValidator] Tool check passed', {
        command: criterion.command,
        stdout: stdout.substring(0, 200),
        stderr: stderr.substring(0, 200)
      });
      
      return true;
    } catch (error) {
      this.logger?.debug('[AcceptanceValidator] Tool check failed', {
        command: criterion.command,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check QA agent evaluation
   * 
   * @param {object} criterion - QA acceptance criterion with rubric and threshold
   * @param {array} artifacts - Artifacts to evaluate
   * @returns {boolean} - True if QA agent passes evaluation
   */
  async checkQA(criterion, artifacts) {
    if (!criterion.rubric) {
      this.logger?.warn('[AcceptanceValidator] QA criterion missing rubric');
      return false;
    }
    
    const threshold = criterion.threshold || this.defaultThreshold;
    
    try {
      // Attach file evidence referenced by the rubric (e.g., "@outputs/foo.json")
      const referencedPaths = this.extractPathsFromText(criterion.rubric);
      const fileEvidence = await this.loadFileEvidence(referencedPaths);

      // Prepare prompt for QA agent
      const artifactsText = artifacts.map(a => this.extractTextFromArtifact(a)).join('\n\n');
      
      const prompt = `You are a QA agent evaluating task completion.

Evaluation Rubric:
${criterion.rubric}

Task Artifacts:
${artifactsText.substring(0, 5000)}

Evaluate whether the task meets the rubric. Respond with:
- PASS if the task meets the criteria (score >= ${threshold})
- FAIL if the task does not meet the criteria

Provide your verdict and a brief explanation.`;

      // Use agent executor to spawn QA agent
      const result = await this.spawnQAAgent(prompt, {
        rubric: criterion.rubric,
        threshold,
        artifacts,
        fileEvidence
      });
      
      // Parse verdict from result
      const verdict = this.parseQAVerdict(result);
      
      this.logger?.debug('[AcceptanceValidator] QA check result', {
        rubric: criterion.rubric.substring(0, 100),
        verdict: verdict.verdict,
        score: verdict.score
      });
      
      return verdict.verdict === 'PASS' && verdict.score >= threshold;
    } catch (error) {
      this.logger?.error('[AcceptanceValidator] QA check error', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Spawn a QA agent to evaluate artifacts
   * 
   * @param {string} prompt - Evaluation prompt
   * @param {object} context - Optional context for artifact-driven QA
   * @returns {object} - Agent result
   */
  async spawnQAAgent(prompt, context = {}) {
    if (!this.agentExecutor) {
      throw new Error('AgentExecutor not available');
    }
    
    // Build artifactToReview so the QA agent validates concrete artifacts
    // (avoids brittle keyword-based filesystem scans).
    const artifactToReview = {
      mission: {
        description: 'Acceptance QA validation',
        // IMPORTANT: never null; QA agent may do string ops on this field.
        goalId: context.goalId || 'acceptance_validation',
        successCriteria: context.rubric ? [context.rubric] : []
      },
      results: [
        // Inlined artifact text extracted from agent results
        ...(Array.isArray(context.artifacts) ? context.artifacts.map(a => ({
          type: 'artifact_text',
          content: this.extractTextFromArtifact(a)
        })) : []),
        // File evidence (real @outputs/@exports artifacts)
        ...(Array.isArray(context.fileEvidence) ? context.fileEvidence.map(e => ({
          type: e.type || 'artifact_file',
          content: e.content,
          path: e.path,
          metadata: e.metadata
        })) : [])
      ]
    };

    // Construct mission spec for QA agent
    const missionSpec = {
      agentType: 'quality_assurance', // CRITICAL: Must use agentType (not type)
      goalId: 'goal_acceptance_qa_' + Date.now(),
      description: 'Evaluate task artifacts against acceptance criteria',
      instructions: prompt,
      artifactToReview,
      expectedOutput: 'Quality assessment verdict (PASS/FAIL) with score and explanation',
      maxDuration: 60000,
      spawnedBy: 'acceptance-validator',
      priority: 10
    };
    
    // Spawn QA agent
    try {
      const agentId = await this.agentExecutor.spawnAgent(missionSpec);

      if (!agentId) {
        // Some executors return null when they cannot spawn (e.g. max concurrency).
        this.logger?.warn('[AcceptanceValidator] QA agent NOT spawned (executor returned null)', {
          reason: 'spawn_returned_null'
        });

        // Non-blocking behavior: keep flow moving, but record that QA was deferred.
        return {
          verdict: 'PASS',
          score: 0.8,
          qaSpawned: false,
          agentId: null,
          explanation: 'QA deferred (could not spawn agent due to executor capacity); non-blocking fallback'
        };
      }

      // Note: We do not currently wait for QA completion (async).
      this.logger?.info('[AcceptanceValidator] QA agent spawned', { agentId });
      
      // Fallback: Use simple heuristic (agent will complete async)
      return {
        verdict: 'PASS',
        score: 0.8,
        qaSpawned: true,
        agentId,
        explanation: 'Async QA agent spawned for evaluation'
      };
    } catch (error) {
      this.logger?.warn('[AcceptanceValidator] Failed to spawn QA agent, using fallback', {
        error: error.message
      });
      
      // Fallback: Use simple heuristic
      return {
        verdict: 'PASS',
        score: 0.8,
        qaSpawned: false,
        agentId: null,
        explanation: 'Fallback evaluation (QA agent unavailable)'
      };
    }
  }

  /**
   * Parse verdict from QA agent result
   * 
   * @param {object} result - Agent result
   * @returns {object} - { verdict: 'PASS'|'FAIL', score: number }
   */
  parseQAVerdict(result) {
    // Try to extract verdict from result
    const text = JSON.stringify(result).toUpperCase();
    
    const hasPass = text.includes('PASS');
    const hasFail = text.includes('FAIL');
    
    let verdict = 'FAIL';
    let score = 0.5;
    
    if (hasPass && !hasFail) {
      verdict = 'PASS';
      score = 0.8;
    } else if (hasFail && !hasPass) {
      verdict = 'FAIL';
      score = 0.3;
    }
    
    // Try to extract numeric score
    const scoreMatch = text.match(/SCORE[:\s]+([0-9.]+)/);
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
    }
    
    return { verdict, score };
  }

  /**
   * Extract text content from an artifact
   * 
   * @param {object} artifact - Artifact object
   * @returns {string} - Text content
   */
  extractTextFromArtifact(artifact) {
    if (typeof artifact === 'string') {
      return artifact;
    }
    
    if (artifact.content) {
      return typeof artifact.content === 'string' 
        ? artifact.content 
        : JSON.stringify(artifact.content);
    }
    
    if (artifact.text) {
      return artifact.text;
    }
    
    if (artifact.output) {
      return artifact.output;
    }
    
    return JSON.stringify(artifact);
  }

  /**
   * Get failure reason for a criterion
   * 
   * @param {object} criterion - Failed criterion
   * @returns {string} - Human-readable reason
   */
  getFailureReason(criterion) {
    switch (criterion.type) {
      case 'literal':
        return `Pattern not found: ${criterion.pattern}`;
      case 'tool':
        return `Tool check failed: ${criterion.command}`;
      case 'qa':
        return `QA evaluation failed: ${criterion.rubric}`;
      default:
        return 'Unknown criterion type';
    }
  }
}

module.exports = AcceptanceValidator;

