const { ToolExecutor } = require('../ide/tools');
const { getOpenAIClient } = require('./openai-client');
const { FilesystemHelpers } = require('../cluster/fs/helpers');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

/**
 * Capabilities - COSMO's Motor Cortex
 *
 * Purpose:
 * - Provides direct tool access (read, write, edit, search, terminal)
 * - Routes through ExecutiveRing for autonomous judgment
 * - Uses PathResolver for canonical path resolution
 * - Uses FrontierGate for action classification and logging
 * - Learns from outcomes via pattern reinforcement
 *
 * Architecture:
 * - Motor cortex (this) connected to prefrontal cortex (ExecutiveRing)
 * - Sensory feedback via FrontierGate
 * - Hebbian learning via successPatterns/knownBlockers
 * - No human approval gates (autonomous operation)
 *
 * Safety:
 * - Command allowlisting for terminal execution
 * - Dangerous pattern rejection
 * - Atomic writes (temp + rename)
 * - Cluster file locking (when cluster.enabled)
 * - Async terminal execution (with timeout)
 * - Graceful shutdown (cleanup pending actions)
 * - Null checks (defensive programming)
 */
class Capabilities {
  constructor(config, logger, executiveRing, frontierGate, pathResolver) {
    this.config = config;
    this.logger = logger;
    this.executiveRing = executiveRing;
    this.frontierGate = frontierGate;
    this.pathResolver = pathResolver;

    // Feature flags
    this.enabled = config.capabilities?.enabled !== false;
    this.executiveGating = config.capabilities?.executiveGating !== false;
    this.useFrontierGate = config.capabilities?.useFrontierGate !== false;

    // Working directory (COSMO root for tool execution)
    const workingDir = process.cwd();

    // Initialize ToolExecutor (indexer passed as null for now - can add semantic search later)
    this.toolExecutor = new ToolExecutor(null, workingDir);

    // Cluster support
    this.clusterEnabled = config.cluster?.enabled || false;
    this.fsHelpers = new FilesystemHelpers(logger);

    // Pending actions (for graceful shutdown)
    this.pendingActions = new Set();
    this.cleanupRegistered = false;

    // Command security configuration
    this._initializeCommandSecurity();

    // Stats
    this.stats = {
      actionsAttempted: 0,
      actionsExecuted: 0,
      actionsSkipped: 0,
      actionsDegraded: 0,
      actionsBlocked: 0,
      actionsFailed: 0
    };

    // Register cleanup handler
    this.registerCleanupHandler();

    this.logger.info('🤲 Capabilities initialized', {
      enabled: this.enabled,
      executiveGating: this.executiveGating,
      frontierGate: this.useFrontierGate,
      clusterMode: this.clusterEnabled,
      workingDir
    });
  }

  /**
   * Initialize command security allowlists and blocklists
   * @private
   */
  _initializeCommandSecurity() {
    // Allowlist of command prefixes that are safe to execute
    // Commands starting with these are permitted
    this.allowedCommandPrefixes = new Set([
      // File operations (read-only or limited)
      'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat',
      'find', 'locate', 'which', 'whereis', 'type',
      // Text processing
      'grep', 'awk', 'sed', 'sort', 'uniq', 'cut', 'tr', 'diff', 'comm',
      // Development tools
      'git', 'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3',
      'make', 'cargo', 'go', 'rustc', 'gcc', 'g++', 'javac', 'java',
      // System info
      'pwd', 'whoami', 'hostname', 'uname', 'date', 'uptime', 'env', 'printenv',
      'ps', 'top', 'htop', 'df', 'du', 'free',
      // Network (read-only)
      'ping', 'curl', 'wget', 'dig', 'nslookup', 'host',
      // Archive
      'tar', 'zip', 'unzip', 'gzip', 'gunzip',
      // Safe file ops
      'mkdir', 'touch', 'cp', 'mv', 'ln',
      // Testing
      'jest', 'mocha', 'pytest', 'npm test', 'npm run',
      // Echo for debugging
      'echo', 'printf'
    ]);

    // Dangerous patterns that should always be rejected
    this.dangerousPatterns = [
      // Destructive operations
      /rm\s+(-[rf]+\s+)*\/($|\s)/, // rm -rf / or rm /
      /rm\s+(-[rf]+\s+)*~/, // rm -rf ~
      />\s*\/dev\/sd[a-z]/, // Writing to disk devices
      />\s*\/dev\/null.*2>&1.*rm/, // Hiding destructive ops
      /mkfs\./i, // Formatting filesystems
      /dd\s+.*of=\/dev/i, // dd to devices
      /:(){ :|:& };:/, // Fork bomb
      /\|\s*sh\b/, // Piping to shell
      /\|\s*bash\b/, // Piping to bash
      /`.*`.*`.*`/, // Multiple nested backticks (injection)
      /\$\([^)]*\$\(/, // Nested command substitution
      // System modification
      /passwd/i,
      /chown\s+.*\//, // Changing ownership of system files
      /chmod\s+[0-7]*\s+\//, // Changing permissions of system files
      /sudo/i, // Privilege escalation
      /su\s+-/, // Switch user
      // Network attacks
      /nc\s+-[el]/, // Netcat listeners
      /nmap\s+-s[STUFNAXWMO]/, // Aggressive nmap scans
      // Sensitive file access
      /\/etc\/shadow/,
      /\/etc\/passwd.*>/,
      // Kill signals to system processes
      /kill\s+-9\s+1\b/, // Kill init
      /killall/,
      // History/credential theft
      /\.bash_history/,
      /\.ssh\/id_/,
      /\.aws\/credentials/,
      /\.env\b.*>/
    ];

    // Always blocked commands (even if they pass other checks)
    this.blockedCommands = new Set([
      'reboot', 'shutdown', 'halt', 'poweroff', 'init',
      'mkfs', 'fdisk', 'parted', 'wipefs',
      'iptables', 'firewall-cmd', 'ufw',
      'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel',
      'visudo', 'chpasswd'
    ]);
  }

  /**
   * Validate a command against security rules
   * @private
   * @returns {{ valid: boolean, reason?: string }}
   */
  _validateCommand(command) {
    if (!command || typeof command !== 'string') {
      return { valid: false, reason: 'Command must be a non-empty string' };
    }

    const trimmedCmd = command.trim();

    // Extract the base command (first word, ignoring env vars like VAR=val cmd)
    let baseCommand = trimmedCmd;
    // Skip environment variable assignments at the start
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(baseCommand)) {
      baseCommand = baseCommand.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
    }
    const firstWord = baseCommand.split(/\s+/)[0].replace(/^.*\//, ''); // Get basename

    // Check blocked commands
    if (this.blockedCommands.has(firstWord)) {
      return { valid: false, reason: `Command '${firstWord}' is blocked for security reasons` };
    }

    // Check dangerous patterns
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(trimmedCmd)) {
        return { valid: false, reason: `Command matches dangerous pattern` };
      }
    }

    // Check if command starts with an allowed prefix
    let isAllowed = false;
    for (const prefix of this.allowedCommandPrefixes) {
      if (firstWord === prefix || trimmedCmd.startsWith(prefix + ' ')) {
        isAllowed = true;
        break;
      }
    }

    if (!isAllowed) {
      // Log but allow with executive gating - the executive ring provides secondary check
      this.logger.warn('Command not in allowlist, relying on executive gating', {
        command: trimmedCmd.substring(0, 100),
        baseCommand: firstWord
      });
      // Still allow if executive gating is enabled (defense in depth)
      if (!this.executiveGating) {
        return { valid: false, reason: `Command '${firstWord}' is not in the allowed commands list` };
      }
    }

    return { valid: true };
  }
  
  /**
   * Register cleanup handler for graceful shutdown
   */
  registerCleanupHandler() {
    if (this.cleanupRegistered) return;
    
    // IMPORTANT:
    // Do NOT register SIGINT/SIGTERM handlers here.
    //
    // The Orchestrator owns graceful shutdown via `GracefulShutdownHandler`, which:
    // - waits for active agents to complete
    // - saves state
    // - runs registered cleanup tasks
    // - then exits the process
    //
    // If Capabilities calls `process.exit(0)` on SIGINT/SIGTERM, it can preempt that
    // orchestrator-level wait and cause early termination (observed in production logs).
    //
    // Instead, we do a best-effort cleanup on `beforeExit` as a fallback for any
    // non-orchestrated usage, and the orchestrator explicitly invokes `capabilities.cleanup()`.
    const cleanup = async () => {
      try {
        await this.cleanup();
      } catch (e) {
        // Best-effort only; never crash shutdown due to cleanup
      }
    };

    process.once('beforeExit', () => {
      // Fire-and-wait: scheduling async work here keeps the event loop alive until cleanup completes.
      cleanup();
    });
    
    this.cleanupRegistered = true;
  }
  
  /**
   * Cleanup pending actions on shutdown
   */
  async cleanup() {
    if (this.pendingActions.size === 0) {
      this.logger.info('✅ Capabilities cleanup - no pending actions');
      return;
    }
    
    this.logger.warn('⏳ Capabilities cleanup - waiting for pending actions', {
      pending: this.pendingActions.size
    });
    
    const timeout = 10000; // 10 seconds max wait
    const start = Date.now();
    
    while (this.pendingActions.size > 0 && Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (this.pendingActions.size > 0) {
      this.logger.error('⚠️ Capabilities shutdown with pending actions', {
        count: this.pendingActions.size,
        actions: Array.from(this.pendingActions)
      });
    } else {
      this.logger.info('✅ Capabilities cleanup complete');
    }
  }
  
  /**
   * Read file
   * @param {string} logicalPath - Logical or absolute path (@outputs/file.txt)
   * @param {Object} agentContext - { agentId, agentType, missionGoal, cycleCount }
   * @returns {Object} - { success: boolean, content?: string, reason?: string }
   */
  async readFile(logicalPath, agentContext = {}) {
    if (!this.enabled) {
      // Feature disabled - direct read
      const resolved = this.pathResolver.resolve(logicalPath);
      const content = await fs.readFile(resolved, 'utf8');
      return { success: true, content };
    }
    
    return await this._executeAction('read_file', {
      file_path: logicalPath
    }, agentContext);
  }
  
  /**
   * Read file as binary buffer (executive-gated)
   * @param {string} logicalPath - Logical or absolute path
   * @param {Object} agentContext - Agent context
   * @returns {Object} - { success: boolean, buffer?: Buffer, reason?: string }
   */
  async readFileBinary(logicalPath, agentContext = {}) {
    if (!this.enabled) {
      const resolved = this.pathResolver.resolve(logicalPath);
      const buffer = await fs.readFile(resolved);
      return { success: true, buffer };
    }
    
    const actionId = `readbin_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.pendingActions.add(actionId);
    this.stats.actionsAttempted++;
    
    try {
      const resolvedPath = this.pathResolver.resolve(logicalPath);
      
      if (this.executiveGating && this.executiveRing && this.executiveRing.evaluateAction) {
        const decision = await this.executiveRing.evaluateAction({
          type: 'file_read',
          path: resolvedPath,
          operation: 'binary',
          agentId: agentContext.agentId,
          agentType: agentContext.agentType,
          missionGoal: agentContext.missionGoal
        }, agentContext);
        
        if (!decision.aligned) {
          this.stats.actionsSkipped++;
          return { success: false, reason: decision.reason, skipped: true };
        }
      }
      
      const buffer = await fs.readFile(resolvedPath);
      this.stats.actionsExecuted++;
      
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: 'file_read',
          operation: 'binary',
          path: resolvedPath,
          success: true,
          agent: agentContext.agentId,
          agentType: agentContext.agentType,
          goalId: agentContext.missionGoal || agentContext.goalId,
          taskId: agentContext.taskId,
          timestamp: Date.now()
        });
      }
      
      if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
        await this.executiveRing.recordCapabilityOutcome({
          type: 'file_read',
          success: true,
          agentType: agentContext.agentType,
          cycle: agentContext.cycleCount
        });
      }
      
      return { success: true, buffer };
    } catch (error) {
      this.stats.actionsFailed++;
      
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: 'file_read',
          operation: 'binary',
          path: logicalPath,
          success: false,
          error: error.message,
          agent: agentContext.agentId,
          agentType: agentContext.agentType,
          goalId: agentContext.missionGoal || agentContext.goalId,
          taskId: agentContext.taskId
        });
      }
      
      if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
        await this.executiveRing.recordCapabilityOutcome({
          type: 'file_read',
          success: false,
          error: error.message,
          agentType: agentContext.agentType
        });
      }
      
      return { success: false, error: error.message };
    } finally {
      this.pendingActions.delete(actionId);
    }
  }
  
  /**
   * Append to file (cluster-safe, executive-gated)
   * NOTE: Intended for small append-only logs (e.g., agent journals).
   * @param {string} logicalPath - Logical or absolute path
   * @param {string} contentToAppend - Content to append (string)
   * @param {Object} agentContext - Agent context
   * @returns {Object} - { success: boolean, path?: string, reason?: string }
   */
  async appendFile(logicalPath, contentToAppend, agentContext = {}) {
    const path = require('path');
    
    if (!this.enabled) {
      const resolved = this.pathResolver.resolve(logicalPath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.appendFile(resolved, contentToAppend, 'utf8');
      return { success: true, path: resolved };
    }
    
    const actionId = `append_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.pendingActions.add(actionId);
    this.stats.actionsAttempted++;
    
    try {
      const resolvedPath = this.pathResolver.resolve(logicalPath);
      
      // Classify (same pipeline as writeFile)
      let classification = { risk: 'low', category: 'file_write' };
      if (this.useFrontierGate && this.frontierGate) {
        classification = this.frontierGate.classifyArtifact(resolvedPath, String(contentToAppend || '').length);
      }
      
      // Executive judgment (use same action type as writeFile for alignment logic)
      if (this.executiveGating && this.executiveRing && this.executiveRing.evaluateAction) {
        const decision = await this.executiveRing.evaluateAction({
          type: 'file_write',
          path: resolvedPath,
          operation: 'append',
          classification: classification,
          agentId: agentContext.agentId,
          agentType: agentContext.agentType,
          missionGoal: agentContext.missionGoal
        }, agentContext);
        
        if (!decision.aligned) {
          this.stats.actionsSkipped++;
          this.logger.info('Executive: action not aligned', {
            action: 'appendFile',
            path: logicalPath,
            reason: decision.reason,
            agent: agentContext.agentId
          });
          
          if (decision.alternative) {
            this.stats.actionsDegraded++;
            this.logger.info('Executive proposed alternative', {
              original: 'appendFile',
              alternative: decision.alternative.method
            });
            return await this[decision.alternative.method](...decision.alternative.args);
          }
          
          return { success: false, reason: decision.reason, skipped: true };
        }
      }
      
      // Cluster locking (best-effort)
      let lockAcquired = false;
      let lockPath = null;
      if (this.clusterEnabled) {
        lockPath = `${resolvedPath}.lock`;
        lockAcquired = await this.fsHelpers.tryAcquireLock(lockPath, {
          instanceId: this.config.instanceId || 'cosmo-1',
          timestamp: Date.now(),
          agent: agentContext.agentId
        });
        
        if (!lockAcquired) {
          this.stats.actionsBlocked++;
          this.logger.warn('File locked by another instance', {
            path: resolvedPath,
            agent: agentContext.agentId
          });
          return { success: false, reason: 'File locked by another instance', retry: true };
        }
      }
      
      try {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.appendFile(resolvedPath, contentToAppend, 'utf8');
        
        this.stats.actionsExecuted++;
        
        if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
          await this.frontierGate.recordOutcome({
            action: 'file_write',
            operation: 'append',
            path: resolvedPath,
            success: true,
            agent: agentContext.agentId,
            agentType: agentContext.agentType,
            goalId: agentContext.missionGoal || agentContext.goalId,
            taskId: agentContext.taskId,
            timestamp: Date.now()
          });
        }
        
        if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
          await this.executiveRing.recordCapabilityOutcome({
            type: 'file_write',
            operation: 'append',
            success: true,
            agentType: agentContext.agentType,
            cycle: agentContext.cycleCount
          });
        }
        
        return { success: true, path: resolvedPath };
      } finally {
        if (lockAcquired && lockPath) {
          await this.fsHelpers.releaseLock(lockPath);
        }
      }
      
    } catch (error) {
      this.stats.actionsFailed++;
      
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: 'file_write',
          operation: 'append',
          path: logicalPath,
          success: false,
          error: error.message,
          agent: agentContext.agentId,
          agentType: agentContext.agentType,
          goalId: agentContext.missionGoal || agentContext.goalId,
          taskId: agentContext.taskId
        });
      }
      
      if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
        await this.executiveRing.recordCapabilityOutcome({
          type: 'file_write',
          operation: 'append',
          success: false,
          error: error.message,
          agentType: agentContext.agentType
        });
      }
      
      return { success: false, error: error.message };
    } finally {
      this.pendingActions.delete(actionId);
    }
  }
  
  /**
   * Write file (with atomic write + cluster locking)
   * @param {string} logicalPath - Logical or absolute path
   * @param {string} content - File content
   * @param {Object} agentContext - Agent context
   * @returns {Object} - { success: boolean, path?: string, reason?: string }
   */
  async writeFile(logicalPath, content, agentContext = {}) {
    if (!this.enabled) {
      // Feature disabled - direct write via PathResolver
      const resolved = this.pathResolver.resolve(logicalPath);
      await this._atomicWrite(resolved, content);
      return { success: true, path: resolved };
    }
    
    const actionId = `write_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.pendingActions.add(actionId);
    this.stats.actionsAttempted++;
    
    try {
      // 1. Resolve path canonically
      const resolvedPath = this.pathResolver.resolve(logicalPath);
      
      // 2. Classify action (if FrontierGate available)
      let classification = { risk: 'low', category: 'file_write' };
      if (this.useFrontierGate && this.frontierGate) {
        classification = this.frontierGate.classifyArtifact(resolvedPath, content.length);
      }
      
      // 3. Executive judgment (if available and gating enabled)
      if (this.executiveGating && this.executiveRing && this.executiveRing.evaluateAction) {
        const decision = await this.executiveRing.evaluateAction({
          type: 'file_write',
          path: resolvedPath,
          classification: classification,
          agentId: agentContext.agentId,
          agentType: agentContext.agentType,
          missionGoal: agentContext.missionGoal
        }, agentContext);
        
        if (!decision.aligned) {
          this.stats.actionsSkipped++;
          this.logger.info('Executive: action not aligned', {
            action: 'writeFile',
            path: logicalPath,
            reason: decision.reason,
            agent: agentContext.agentId
          });
          
          // Try alternative if Executive proposed one
          if (decision.alternative) {
            this.stats.actionsDegraded++;
            this.logger.info('Executive proposed alternative', {
              original: 'writeFile',
              alternative: decision.alternative.method
            });
            return await this[decision.alternative.method](...decision.alternative.args);
          }
          
          return { success: false, reason: decision.reason, skipped: true };
        }
      }
      
      // 4. Cluster file locking (if cluster enabled)
      let lockAcquired = false;
      let lockPath = null;
      
      if (this.clusterEnabled) {
        lockPath = `${resolvedPath}.lock`;
        lockAcquired = await this.fsHelpers.tryAcquireLock(lockPath, {
          instanceId: this.config.instanceId || 'cosmo-1',
          timestamp: Date.now(),
          agent: agentContext.agentId
        });
        
        if (!lockAcquired) {
          this.stats.actionsBlocked++;
          this.logger.warn('File locked by another instance', {
            path: resolvedPath,
            agent: agentContext.agentId
          });
          return { success: false, reason: 'File locked by another instance', retry: true };
        }
      }
      
      try {
        // 5. Execute via ToolExecutor with atomic write
        await this._atomicWrite(resolvedPath, content);
        
        this.stats.actionsExecuted++;
        
        // 6. Record outcome via FrontierGate
        if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
          await this.frontierGate.recordOutcome({
            action: 'file_write',
            path: resolvedPath,
            success: true,
            agent: agentContext.agentId,
            agentType: agentContext.agentType,
            goalId: agentContext.missionGoal || agentContext.goalId,
            taskId: agentContext.taskId,
            timestamp: Date.now()
          });
        }
        
        // 7. Inform Executive of success (pattern learning)
        if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
          await this.executiveRing.recordCapabilityOutcome({
            type: 'file_write',
            success: true,
            agentType: agentContext.agentType,
            cycle: agentContext.cycleCount
          });
        }
        
        this.logger.debug('File written successfully', {
          path: logicalPath,
          size: content.length,
          agent: agentContext.agentId
        });
        
        return { success: true, path: resolvedPath };
        
      } finally {
        // Always release lock
        if (lockAcquired && lockPath) {
          await this.fsHelpers.releaseLock(lockPath);
        }
      }
      
    } catch (error) {
      this.stats.actionsFailed++;
      
      // Record failure
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: 'file_write',
          path: logicalPath,
          success: false,
          error: error.message,
          agent: agentContext.agentId,
          agentType: agentContext.agentType,
          goalId: agentContext.missionGoal || agentContext.goalId,
          taskId: agentContext.taskId
        });
      }
      
      // Inform Executive of failure
      if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
        await this.executiveRing.recordCapabilityOutcome({
          type: 'file_write',
          success: false,
          error: error.message,
          agentType: agentContext.agentType
        });
      }
      
      this.logger.error('File write failed', {
        path: logicalPath,
        error: error.message,
        agent: agentContext.agentId
      });
      
      return { success: false, error: error.message };
      
    } finally {
      this.pendingActions.delete(actionId);
    }
  }
  
  /**
   * List directory
   */
  async listDirectory(logicalPath, agentContext = {}) {
    if (!this.enabled) {
      const resolved = this.pathResolver.resolve(logicalPath);
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return { success: true, entries };
    }
    
    return await this._executeAction('list_directory', {
      directory_path: logicalPath
    }, agentContext);
  }
  
  /**
   * Run terminal command (async with timeout)
   *
   * Security: Commands are validated against allowlist and dangerous patterns
   * before execution. Executive gating provides secondary approval.
   */
  async runTerminal(command, agentContext = {}, options = {}) {
    if (!this.enabled) {
      // Feature disabled - not safe to execute
      this.logger.warn('Terminal execution disabled (capabilities not enabled)');
      return { success: false, reason: 'Capabilities disabled' };
    }

    const actionId = `terminal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.pendingActions.add(actionId);
    this.stats.actionsAttempted++;

    try {
      // SECURITY: Validate command against allowlist and dangerous patterns
      const validation = this._validateCommand(command);
      if (!validation.valid) {
        this.stats.actionsBlocked++;
        this.logger.error('Terminal command blocked by security validation', {
          command: command.substring(0, 100),
          reason: validation.reason,
          agent: agentContext.agentId
        });
        return { success: false, reason: validation.reason, blocked: true };
      }

      // Executive judgment (critical for terminal commands)
      if (this.executiveGating && this.executiveRing && this.executiveRing.evaluateAction) {
        const decision = await this.executiveRing.evaluateAction({
          type: 'terminal_execute',
          command: command,
          agentId: agentContext.agentId,
          agentType: agentContext.agentType,
          missionGoal: agentContext.missionGoal
        }, agentContext);

        if (!decision.aligned) {
          this.stats.actionsSkipped++;
          this.logger.warn('Executive: terminal command not aligned', {
            command: command.substring(0, 100),
            reason: decision.reason
          });
          return { success: false, reason: decision.reason, skipped: true };
        }
      }

      // Execute with timeout
      const timeout = options.timeout || 30000;
      const result = await this._execWithTimeout(command, timeout);
      
      this.stats.actionsExecuted++;
      
      // Record outcome
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: 'terminal_execute',
          command: command.substring(0, 200),
          success: result.exitCode === 0,
          agent: agentContext.agentId
        });
      }
      
      // Inform Executive
      if (this.executiveRing && this.executiveRing.recordCapabilityOutcome) {
        await this.executiveRing.recordCapabilityOutcome({
          type: 'terminal_execute',
          success: result.exitCode === 0,
          agentType: agentContext.agentType
        });
      }
      
      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
      
    } catch (error) {
      this.stats.actionsFailed++;
      this.logger.error('Terminal execution failed', {
        command: command.substring(0, 100),
        error: error.message
      });
      return { success: false, error: error.message };
      
    } finally {
      this.pendingActions.delete(actionId);
    }
  }
  
  /**
   * Semantic code search
   */
  async semanticSearch(query, scope, agentContext = {}) {
    if (!this.enabled) {
      return { success: false, reason: 'Capabilities disabled' };
    }
    
    return await this._executeAction('codebase_search', {
      query: query,
      limit: scope?.limit || 10
    }, agentContext);
  }
  
  /**
   * Grep search (exact pattern)
   */
  async grepSearch(pattern, searchPath, agentContext = {}) {
    if (!this.enabled) {
      return { success: false, reason: 'Capabilities disabled' };
    }
    
    return await this._executeAction('grep_search', {
      pattern: pattern,
      path: searchPath || '.'
    }, agentContext);
  }
  
  /**
   * Edit file range (surgical edit)
   */
  async editFileRange(logicalPath, startLine, endLine, newContent, agentContext = {}) {
    if (!this.enabled) {
      return { success: false, reason: 'Capabilities disabled' };
    }
    
    return await this._executeAction('edit_file_range', {
      file_path: logicalPath,
      start_line: startLine,
      end_line: endLine,
      new_content: newContent,
      instructions: `Agent ${agentContext.agentId} edit lines ${startLine}-${endLine}`
    }, agentContext);
  }
  
  /**
   * Search and replace
   */
  async searchReplace(logicalPath, oldString, newString, agentContext = {}) {
    if (!this.enabled) {
      return { success: false, reason: 'Capabilities disabled' };
    }
    
    return await this._executeAction('search_replace', {
      file_path: logicalPath,
      old_string: oldString,
      new_string: newString,
      instructions: `Agent ${agentContext.agentId} replacing text`
    }, agentContext);
  }
  
  /**
   * Get capability stats
   */
  getStats() {
    return {
      ...this.stats,
      pendingActions: this.pendingActions.size
    };
  }
  
  // ============================================================================
  // INTERNAL METHODS
  // ============================================================================
  
  /**
   * Execute action via ToolExecutor with full routing
   * @private
   */
  async _executeAction(toolName, toolArgs, agentContext) {
    const actionId = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.pendingActions.add(actionId);
    this.stats.actionsAttempted++;
    
    try {
      // Resolve paths in tool args
      const resolvedArgs = this._resolveArgsPath(toolArgs);
      
      // Executive judgment (if gating enabled and ExecutiveRing available)
      if (this.executiveGating && this.executiveRing && this.executiveRing.evaluateAction) {
        const decision = await this.executiveRing.evaluateAction({
          type: toolName,
          args: resolvedArgs,
          agentId: agentContext.agentId,
          agentType: agentContext.agentType,
          missionGoal: agentContext.missionGoal
        }, agentContext);
        
        if (!decision.aligned) {
          this.stats.actionsSkipped++;
          this.logger.debug('Executive declined action', {
            tool: toolName,
            reason: decision.reason
          });
          return { success: false, reason: decision.reason, skipped: true };
        }
      }
      
      // Execute via ToolExecutor
      const result = await this.toolExecutor.execute(toolName, resolvedArgs);
      
      this.stats.actionsExecuted++;
      
      // Record outcome (if FrontierGate available)
      if (this.useFrontierGate && this.frontierGate && this.frontierGate.recordOutcome) {
        await this.frontierGate.recordOutcome({
          action: toolName,
          args: resolvedArgs,
          success: result.success !== false,
          agent: agentContext.agentId,
          agentType: agentContext.agentType,
          goalId: agentContext.missionGoal || agentContext.goalId,
          taskId: agentContext.taskId,
          timestamp: Date.now()
        });
      }
      
      return result;
      
    } catch (error) {
      this.stats.actionsFailed++;
      this.logger.error('Tool execution failed', {
        tool: toolName,
        error: error.message
      });
      return { success: false, error: error.message };
      
    } finally {
      this.pendingActions.delete(actionId);
    }
  }
  
  /**
   * Resolve paths in tool arguments
   * @private
   */
  _resolveArgsPath(args) {
    const resolved = { ...args };
    
    // Resolve common path parameters
    if (args.file_path) {
      resolved.file_path = this.pathResolver.resolve(args.file_path);
    }
    if (args.directory_path) {
      resolved.directory_path = this.pathResolver.resolve(args.directory_path);
    }
    if (args.path) {
      resolved.path = this.pathResolver.resolve(args.path);
    }
    
    return resolved;
  }
  
  /**
   * Atomic write (temp + rename pattern from BaseAgent)
   * @private
   */
  async _atomicWrite(filePath, content) {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      // Write to temp file
      const isBinary = Buffer.isBuffer(content) || content instanceof Uint8Array;
      if (isBinary) {
        await fs.writeFile(tempPath, content);
      } else {
        await fs.writeFile(tempPath, content, 'utf8');
      }
      
      // Atomic rename
      await fs.rename(tempPath, filePath);
      
    } catch (error) {
      // Cleanup temp file if rename failed
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }
  
  /**
   * Execute terminal command with timeout (async)
   * @private
   */
  async _execWithTimeout(command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        cwd: process.cwd(),
        env: process.env
      });
      
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        
        // Force kill after 2 more seconds
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
      }, timeoutMs);
      
      child.stdout.on('data', data => {
        stdout += data.toString();
      });
      
      child.stderr.on('data', data => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        clearTimeout(timer);
        
        if (timedOut) {
          reject(new Error(`Command timeout after ${timeoutMs}ms`));
        } else {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code
          });
        }
      });
      
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

module.exports = { Capabilities };

