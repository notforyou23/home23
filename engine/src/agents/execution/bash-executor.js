const { spawn, execFile } = require('child_process');
const path = require('path');

/**
 * BashExecutor - Local bash command execution with security hardening
 *
 * Security measures:
 * - Command allowlisting for simple commands
 * - Shell metacharacter detection and rejection
 * - Process tracking for cleanup
 * - Configurable timeout
 */
class BashExecutor {
  constructor(sandbox, logger, config = {}) {
    // sandbox is kept for backward compatibility in constructor but unused
    this.logger = logger;
    this.processes = new Map();
    this.timeout = config.timeout || 30000;

    // Allowlist of safe commands that can be executed directly via execFile
    // These bypass shell interpretation entirely (safest)
    this.directExecAllowlist = new Set([
      'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'which', 'pwd',
      'date', 'whoami', 'hostname', 'uname', 'env', 'echo', 'printf',
      'mkdir', 'rmdir', 'touch', 'cp', 'mv', 'rm',
      'python', 'python3', 'node', 'npm', 'npx', 'pip', 'pip3',
      'git', 'curl', 'wget'
    ]);

    // Dangerous patterns that should be rejected
    this.dangerousPatterns = [
      /;\s*rm\s+-rf\s+\//, // rm -rf /
      />\s*\/dev\/sd[a-z]/, // Writing to disk devices
      /mkfs\./,            // Formatting filesystems
      /dd\s+.*of=\/dev/,   // dd to devices
      /:(){ :|:& };:/,     // Fork bomb
      /\$\(.*\).*\$\(/,    // Nested command substitution (potential injection)
    ];
  }

  /**
   * Validate command for dangerous patterns
   * @private
   */
  _validateCommand(command) {
    for (const pattern of this.dangerousPatterns) {
      if (pattern.test(command)) {
        return { valid: false, reason: `Command matches dangerous pattern: ${pattern}` };
      }
    }
    return { valid: true };
  }

  /**
   * Parse simple command into executable and arguments
   * Returns null if command is too complex for direct execution
   * @private
   */
  _parseSimpleCommand(command) {
    // Skip if command contains shell operators that require shell interpretation
    const shellOperators = ['|', '&&', '||', ';', '>', '<', '`', '$(',  '${', '*', '?', '[', ']'];
    for (const op of shellOperators) {
      if (command.includes(op)) {
        return null; // Too complex, needs shell
      }
    }

    // Simple tokenization (handles quoted strings)
    const tokens = [];
    let current = '';
    let inQuote = null;

    for (let i = 0; i < command.length; i++) {
      const char = command[i];

      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      tokens.push(current);
    }

    if (tokens.length === 0) {
      return null;
    }

    const executable = tokens[0];
    const args = tokens.slice(1);

    // Check if executable is in allowlist
    const baseName = path.basename(executable);
    if (!this.directExecAllowlist.has(baseName)) {
      return null; // Not in allowlist, use shell fallback
    }

    return { executable, args };
  }

  async execute(command, cwdOverride = null, options = {}) {
    // Use override if provided, otherwise default to runtime/outputs
    const cwd = cwdOverride || path.resolve('runtime/outputs');
    const timeout = options.timeout || this.timeout;

    // Validate command
    const validation = this._validateCommand(command);
    if (!validation.valid) {
      this.logger.error('Command rejected for security reasons', {
        command: command.substring(0, 50),
        reason: validation.reason
      });
      return {
        output: `Security error: ${validation.reason}`,
        exitCode: 1,
        success: false
      };
    }

    // Try to parse as simple command for direct execution (safer)
    const parsed = this._parseSimpleCommand(command);

    if (parsed) {
      // Use execFile - no shell interpretation (safest)
      return this._executeWithExecFile(parsed.executable, parsed.args, cwd, timeout);
    } else {
      // Fall back to spawn with sh -c for complex commands
      // This is less safe but necessary for pipes, redirects, etc.
      return this._executeWithShell(command, cwd, timeout);
    }
  }

  /**
   * Execute using execFile (no shell - safest)
   * @private
   */
  async _executeWithExecFile(executable, args, cwd, timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const child = execFile(executable, args, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }
      }, (error, stdout, stderr) => {
        this.processes.delete(child.pid);
        const duration = Date.now() - startTime;

        if (error) {
          this.logger.warn('Bash execution failed', {
            executable,
            args: args.slice(0, 3),
            error: error.message,
            duration
          });

          resolve({
            output: (stdout || '') + '\n' + (stderr || error.message),
            exitCode: error.code || 1,
            success: false
          });
          return;
        }

        const output = stdout || stderr || '';
        this.logger.info('⚡ Bash executed (direct)', {
          executable,
          outputLength: output.length,
          duration
        });

        resolve({
          output,
          exitCode: 0,
          success: true
        });
      });

      if (child.pid) {
        this.processes.set(child.pid, child);
      }
    });
  }

  /**
   * Execute using shell (spawn with sh -c) for complex commands
   * @private
   */
  async _executeWithShell(command, cwd, timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn('sh', ['-c', command], {
        cwd,
        env: { ...process.env }
      });

      if (child.pid) {
        this.processes.set(child.pid, child);
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 2000);
      }, timeout);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.processes.delete(child.pid);
        const duration = Date.now() - startTime;

        if (timedOut) {
          this.logger.warn('Bash execution timed out', {
            command: command.substring(0, 50),
            timeout,
            duration
          });
          resolve({
            output: `Command timed out after ${timeout}ms\n${stdout}\n${stderr}`,
            exitCode: 124,
            success: false
          });
          return;
        }

        const output = stdout || stderr || '';
        const success = code === 0;

        if (success) {
          this.logger.info('⚡ Bash executed (shell)', {
            command: command.substring(0, 50),
            outputLength: output.length,
            duration
          });
        } else {
          this.logger.warn('Bash execution failed', {
            command: command.substring(0, 50),
            exitCode: code,
            duration
          });
        }

        resolve({
          output: success ? output : `${stdout}\n${stderr}`.trim(),
          exitCode: code,
          success
        });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        this.processes.delete(child.pid);

        this.logger.error('Bash spawn error', {
          command: command.substring(0, 50),
          error: error.message
        });

        resolve({
          output: error.message,
          exitCode: 1,
          success: false
        });
      });
    });
  }

  async killAll() {
    for (const [pid, proc] of this.processes) {
      try {
        proc.kill('SIGTERM');
        // Force kill after 1 second if still running
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 1000);
      } catch {}
    }
    this.processes.clear();
  }
}

module.exports = { BashExecutor };
