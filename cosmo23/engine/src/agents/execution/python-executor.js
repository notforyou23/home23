const { execFile, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * PythonExecutor - Safe Python code execution with file tracking
 * 
 * Executes Python code locally via subprocess, similar to BashExecutor
 * but specialized for Python with file tracking capabilities.
 * 
 * Key features:
 * - Execute Python code via subprocess
 * - Track generated files (scan output directory before/after)
 * - Capture stdout/stderr separately
 * - Handle timeouts (kill process on timeout)
 * - Support file inputs/outputs
 * - Return results in same format as containers
 */
class PythonExecutor {
  constructor(sandbox, logger, config = {}) {
    // sandbox is kept for backward compatibility in constructor but unused
    this.logger = logger;
    this.config = config;

    // Allowlist of valid Python executable names
    this.allowedPythonNames = new Set(['python', 'python3', 'python3.8', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13']);

    // Python path detection with validation
    const configPythonPath = config.pythonPath;
    if (configPythonPath) {
      this.pythonPath = this._validatePythonPath(configPythonPath);
    } else {
      this.pythonPath = this.detectPythonPath();
    }

    // Execution settings
    this.timeout = config.timeout || 30000; // 30 seconds default

    // CRITICAL: Use config.logsDir for multi-tenant isolation
    // Priority: config.workingDir > config.logsDir > fallback
    // FIX: Removed hardcoded 'runtime/outputs' - use process.cwd() for standalone mode
    if (config.workingDir) {
      this.workingDir = path.resolve(config.workingDir);
    } else if (config.logsDir) {
      this.workingDir = path.join(config.logsDir, 'outputs');
    } else {
      // Multi-tenant: config.logsDir ALWAYS set by server
      // Standalone CLI: Falls back to process.cwd() + 'outputs'
      this.workingDir = path.join(process.cwd(), 'outputs');
    }

    // File tracking
    this.tempFiles = [];
    this.beforeFiles = new Set();
    this.afterFiles = new Set();

    // Process tracking for cleanup
    this.activeProcesses = new Map();

    // Dependency auto-install settings
    this.autoInstallDeps = config.autoInstallDeps !== false; // Default: true
    this.maxInstallRetries = config.maxInstallRetries || 2;
    this.pipPath = config.pipPath || 'pip3';

    // Security: Allowlist of common data science packages that can be auto-installed
    this.allowedPackages = new Set([
      'numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn', 'sklearn',
      'seaborn', 'plotly', 'pillow', 'PIL', 'cv2', 'opencv-python',
      'requests', 'beautifulsoup4', 'bs4', 'lxml', 'json5',
      'pyyaml', 'yaml', 'toml', 'python-dotenv',
      'tqdm', 'rich', 'colorama', 'tabulate',
      'networkx', 'sympy', 'statsmodels',
      'torch', 'tensorflow', 'keras', 'transformers',
      'nltk', 'spacy', 'gensim', 'biopython', 'Bio'
    ]);

    // Map module names to pip package names (some differ)
    this.packageMap = {
      'cv2': 'opencv-python',
      'PIL': 'pillow',
      'sklearn': 'scikit-learn',
      'yaml': 'pyyaml',
      'bs4': 'beautifulsoup4',
      'Bio': 'biopython'
    };
  }

  /**
   * Validate Python path against allowlist to prevent injection
   * @private
   */
  _validatePythonPath(pythonPath) {
    // Get base name of the path
    const baseName = path.basename(pythonPath);

    // Check against allowlist
    if (!this.allowedPythonNames.has(baseName)) {
      throw new Error(`Invalid Python path: ${pythonPath}. Base name must be one of: ${Array.from(this.allowedPythonNames).join(', ')}`);
    }

    // Check for shell metacharacters in the path
    const dangerousChars = [';', '|', '&', '$', '`', '(', ')', '{', '}', '<', '>', '\n', '\r'];
    for (const char of dangerousChars) {
      if (pythonPath.includes(char)) {
        throw new Error(`Invalid Python path: contains dangerous character '${char}'`);
      }
    }

    return pythonPath;
  }

  /**
   * Detect Python executable path
   * Tries python3, python, then throws if not found
   */
  detectPythonPath() {
    const { execFileSync } = require('child_process');

    // Try python3 first (preferred on macOS/Linux)
    try {
      execFileSync('python3', ['--version'], { stdio: 'ignore' });
      return 'python3';
    } catch {
      // Try python (Windows or older systems)
      try {
        execFileSync('python', ['--version'], { stdio: 'ignore' });
        return 'python';
      } catch {
        throw new Error('Python not found. Please install Python 3.8+ or set pythonPath in config.');
      }
    }
  }
  
  /**
   * Initialize executor (setup working directory)
   */
  async initialize() {
    try {
      // Ensure working directory exists
      await fs.mkdir(this.workingDir, { recursive: true });
      
      this.logger?.info('✅ PythonExecutor initialized', {
        pythonPath: this.pythonPath,
        workingDir: this.workingDir,
        timeout: this.timeout
      });
    } catch (error) {
      this.logger?.error('Failed to initialize PythonExecutor', { error: error.message });
      throw error;
    }
  }
  
  /**
   * Execute Python code
   * @param {string} code - Python code to execute
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} Execution results in container-compatible format
   */
  async execute(code, options = {}) {
    if (!code || typeof code !== 'string') {
      throw new Error('Python code must be a non-empty string');
    }
    
    const outputDir = options.outputDir || this.workingDir;
    const timeout = options.timeout || this.timeout;
    
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Step 1: Scan directory BEFORE execution to track new files
    const beforeFiles = await this.scanDirectory(outputDir);
    this.beforeFiles = new Set(beforeFiles.map(f => f.name));
    
    // Step 2: Preprocess code to fix container paths
    // Replace /mnt/data/ with working directory in generated code
    const processedCode = this.preprocessCode(code, outputDir);
    
    // Step 3: Write code to temporary file
    const tempScriptPath = await this.writeTempScript(processedCode, outputDir);
    this.tempFiles.push(tempScriptPath);
    
    // Step 4: Execute with auto-dependency install retry loop
    let installAttempts = 0;
    let lastError = null;

    while (installAttempts <= this.maxInstallRetries) {
      try {
        // Execute Python script
        const result = await this.executeScript(tempScriptPath, outputDir, timeout);

        // Step 5: Scan directory AFTER execution to find new files
        const afterFiles = await this.scanDirectory(outputDir);
        this.afterFiles = new Set(afterFiles.map(f => f.name));

        this.logger?.debug('File tracking', {
          outputDir,
          beforeCount: beforeFiles.length,
          afterCount: afterFiles.length,
          beforeFiles: beforeFiles.map(f => f.name),
          afterFiles: afterFiles.map(f => f.name)
        });

        // Step 6: Identify newly generated files
        const newFiles = this.findNewFiles(beforeFiles, afterFiles);

        this.logger?.debug('New files detected', {
          count: newFiles.length,
          files: newFiles.map(f => f.name)
        });

        // Step 7: Format results in container-compatible format
        // Cleanup temp script before returning
        await this.cleanupTempScript(tempScriptPath);
        return this.formatResults(result, newFiles);

      } catch (error) {
        lastError = error;

        // Check if this is a missing dependency error and we should try to auto-install
        if (this.autoInstallDeps && installAttempts < this.maxInstallRetries) {
          const missingModule = this.parseMissingModule(error.message);

          if (missingModule) {
            this.logger?.info('Detected missing Python dependency, attempting auto-install', {
              module: missingModule,
              attempt: installAttempts + 1,
              maxAttempts: this.maxInstallRetries
            });

            const installResult = await this.installPackage(missingModule);

            if (installResult.success) {
              installAttempts++;
              this.logger?.info('Package installed successfully, retrying execution', {
                module: missingModule,
                attempt: installAttempts
              });
              continue; // Retry execution with newly installed package
            } else {
              this.logger?.warn('Package install failed, not retrying', {
                module: missingModule,
                reason: installResult.output
              });
            }
          }
        }

        // Not a dependency error, install failed, or max retries reached
        // Return error results
        try {
          const afterFiles = await this.scanDirectory(outputDir);
          const newFiles = this.findNewFiles(beforeFiles, afterFiles);
          await this.cleanupTempScript(tempScriptPath);
          return this.formatErrorResults(lastError, newFiles);
        } catch (scanError) {
          // If scanning fails, return error without files
          await this.cleanupTempScript(tempScriptPath);
          return this.formatErrorResults(lastError, []);
        }
      }
    }

    // Should not reach here, but safety fallback
    await this.cleanupTempScript(tempScriptPath);
    return this.formatErrorResults(lastError || new Error('Max install retries reached'), []);
  }
  
  /**
   * Execute Python code with file inputs
   * @param {string} code - Python code to execute
   * @param {Array} inputFiles - Array of {data: Buffer, filename: string}
   * @param {string} outputDir - Output directory
   * @returns {Promise<Object>} Execution results
   *
   * Security: Validates that input filenames don't escape the working directory
   */
  async executeWithFiles(code, inputFiles = [], outputDir = null) {
    const workDir = path.resolve(outputDir || this.workingDir);
    await fs.mkdir(workDir, { recursive: true });

    // Write input files to working directory with path validation
    const inputPaths = [];
    for (const file of inputFiles) {
      // Validate filename doesn't contain path traversal
      const validation = this._validatePathContainment(file.filename, workDir);
      if (!validation.valid) {
        throw new Error(`Invalid input filename: ${validation.reason}`);
      }

      const filePath = validation.resolved;
      // Ensure parent directory exists (for nested paths like subdir/file.txt)
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.data);
      inputPaths.push(filePath);
      this.tempFiles.push(filePath); // Track for cleanup if needed
    }

    // Execute code (which can now access input files)
    return await this.execute(code, { outputDir: workDir });
  }
  
  /**
   * Validate that a path stays within the allowed directory (containment check)
   * @private
   */
  _validatePathContainment(requestedPath, allowedBase) {
    const resolved = path.resolve(allowedBase, requestedPath);
    const normalized = path.normalize(resolved);
    const normalizedBase = path.normalize(path.resolve(allowedBase));

    if (!normalized.startsWith(normalizedBase + path.sep) && normalized !== normalizedBase) {
      return { valid: false, reason: `Path escapes allowed directory: ${requestedPath}` };
    }
    return { valid: true, resolved: normalized };
  }

  /**
   * Preprocess Python code to fix container paths
   * Replaces /mnt/data/ with actual working directory
   * CRITICAL: This handles code generated for containers that needs to run locally
   *
   * Security: Validates that replacement paths don't escape the working directory
   */
  preprocessCode(code, outputDir) {
    // Normalize paths - handle both forward and backslashes
    const normalizedOutputDir = path.resolve(outputDir).replace(/\\/g, '/');
    
    // Replace all variations of /mnt/data/ paths
    let processed = code;
    
    // Pattern 1: String literals with /mnt/data/
    processed = processed.replace(/['"]\/mnt\/data\//g, `'${normalizedOutputDir}/`);
    processed = processed.replace(/['"]\/mnt\/data['"]/g, `'${normalizedOutputDir}'`);
    
    // Pattern 2: Path('/mnt/data') or Path("/mnt/data")
    processed = processed.replace(/Path\(['"]\/mnt\/data['"]\)/g, `Path('${normalizedOutputDir}')`);
    
    // Pattern 3: Path('/mnt/data').joinpath(...)
    processed = processed.replace(/Path\(['"]\/mnt\/data['"]\)\.joinpath/g, `Path('${normalizedOutputDir}').joinpath`);
    
    // Pattern 4: .relative_to(Path("/mnt/data"))
    processed = processed.replace(/\.relative_to\(Path\(['"]\/mnt\/data['"]\)\)/g, `.relative_to(Path('${normalizedOutputDir}'))`);
    
    // Pattern 5: os.path.join('/mnt/data', ...)
    processed = processed.replace(/os\.path\.join\(['"]\/mnt\/data['"]/g, `os.path.join('${normalizedOutputDir}'`);
    
    // CRITICAL: Always change to working directory at start
    // This ensures files are written to the correct location regardless of where Python is executed
    if (!processed.includes('os.chdir') && !processed.includes('chdir')) {
      // Use raw string to handle Windows paths with backslashes
      const chdirBlock = `import os\nos.chdir(r'${normalizedOutputDir}')\n\n`;
      
      // Find where imports end (match all consecutive import statements)
      // This handles imports that may or may not have trailing newlines
      const importPattern = /^((?:import .+|from .+ import .+)(?:\n|$))+/m;
      const importMatch = processed.match(importPattern);
      
      if (importMatch && importMatch[0]) {
        // Found imports - insert chdir block after them
        // Ensure there's a newline separator if imports don't end with one
        const importEnd = importMatch[0];
        const needsNewline = !importEnd.endsWith('\n');
        const separator = needsNewline ? '\n' : '';
        processed = importEnd + separator + chdirBlock + processed.slice(importEnd.length);
      } else {
        // No imports found - add at very start
        processed = chdirBlock + processed;
      }
      
      this.logger?.info('Added os.chdir to code', { 
        path: normalizedOutputDir,
        codeLength: processed.length 
      });
    }
    
    return processed;
  }

  /**
   * Parse ModuleNotFoundError to extract missing module name
   * @param {string} errorMessage - stderr or error message
   * @returns {string|null} Module name or null if not a dependency error
   */
  parseMissingModule(errorMessage) {
    // Pattern: ModuleNotFoundError: No module named 'xyz'
    const match = errorMessage.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
    if (match) {
      // Handle submodule imports like 'cv2.something' -> 'cv2'
      const moduleName = match[1].split('.')[0];
      return moduleName;
    }
    return null;
  }

  /**
   * Install a Python package using pip
   * @param {string} moduleName - Package to install
   * @returns {Promise<{success: boolean, output: string}>}
   */
  async installPackage(moduleName) {
    // Security: Check allowlist
    if (!this.allowedPackages.has(moduleName)) {
      this.logger?.warn('Package not in allowlist, skipping install', { moduleName });
      return { success: false, output: `Package '${moduleName}' not in allowlist` };
    }

    // Map module name to pip package name if different
    const packageName = this.packageMap[moduleName] || moduleName;

    this.logger?.info('Installing missing Python package', { moduleName, packageName });

    return new Promise((resolve) => {
      const proc = spawn(this.pipPath, ['install', '--user', packageName], {
        env: { ...process.env }
      });

      let output = '';
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      // Timeout for install (60 seconds)
      const installTimeout = setTimeout(() => {
        proc.kill('SIGTERM');
        this.logger?.warn('Package install timed out', { packageName });
        resolve({ success: false, output: 'Install timed out after 60 seconds' });
      }, 60000);

      proc.on('close', (code) => {
        clearTimeout(installTimeout);
        const success = code === 0;
        this.logger?.info('Package install completed', { packageName, success, code });
        resolve({ success, output });
      });

      proc.on('error', (err) => {
        clearTimeout(installTimeout);
        this.logger?.error('Package install failed', { packageName, error: err.message });
        resolve({ success: false, output: err.message });
      });
    });
  }

  /**
   * Write Python code to temporary script file
   */
  async writeTempScript(code, outputDir) {
    const scriptName = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.py`;
    const scriptPath = path.join(outputDir, scriptName);
    
    await fs.writeFile(scriptPath, code, 'utf-8');
    
    return scriptPath;
  }
  
  /**
   * Execute Python script via subprocess using execFile (no shell interpretation)
   *
   * Security: Uses execFile with argument array instead of exec with string command
   * to prevent shell injection attacks.
   */
  async executeScript(scriptPath, cwd, timeout) {
    // CRITICAL: Use absolute path for script to avoid path resolution issues
    // when cwd is different from script location
    const absoluteScriptPath = path.resolve(scriptPath);

    // Validate script path is within allowed directory (containment check)
    const resolvedCwd = path.resolve(cwd);
    if (!absoluteScriptPath.startsWith(resolvedCwd)) {
      throw new Error(`Script path escapes working directory: ${absoluteScriptPath}`);
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Use spawn instead of exec for better control and no shell interpretation
      const childProcess = spawn(this.pythonPath, [absoluteScriptPath], {
        cwd: cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1' } // Unbuffered output
      });

      // Track process for potential cleanup
      if (childProcess.pid) {
        this.activeProcesses.set(childProcess.pid, childProcess);
      }

      // Setup timeout
      const timer = setTimeout(() => {
        timedOut = true;
        childProcess.kill('SIGTERM');
        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (!childProcess.killed) {
            childProcess.kill('SIGKILL');
          }
        }, 2000);
      }, timeout);

      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        // Limit buffer size to prevent memory issues
        if (stdout.length > 10 * 1024 * 1024) {
          stdout = stdout.slice(-5 * 1024 * 1024); // Keep last 5MB
        }
      });

      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024 * 1024) {
          stderr = stderr.slice(-5 * 1024 * 1024);
        }
      });

      childProcess.on('close', (code) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;

        // Remove from active processes
        this.activeProcesses.delete(childProcess.pid);

        if (timedOut) {
          reject(new Error(`Python execution timed out after ${timeout}ms`));
          return;
        }

        if (code !== 0) {
          reject(new Error(`Python execution failed (exit code ${code}): ${stderr || 'No error output'}`));
          return;
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: 0,
          duration: duration,
          success: true
        });
      });

      // Handle process spawn errors
      childProcess.on('error', (error) => {
        clearTimeout(timer);
        this.activeProcesses.delete(childProcess.pid);
        reject(new Error(`Failed to start Python process: ${error.message}`));
      });
    });
  }
  
  /**
   * Scan directory for files (recursively scans subdirectories)
   * CRITICAL: Recursively scans to find files created in nested paths like schemas/, data/pilot/
   * @returns {Promise<Array>} Array of {name: string, path: string, size: number}
   */
  async scanDirectory(dirPath) {
    try {
      const files = [];
      
      // Recursive directory scan
      const scanRecursive = async (currentPath) => {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const entryPath = path.join(currentPath, entry.name);
          
          if (entry.isFile()) {
            // Skip temp script files
            if (entry.name.startsWith('exec_') && entry.name.endsWith('.py')) {
              continue;
            }
            
            const stats = await fs.stat(entryPath);
            
            // Use relative path from base directory for name (preserves subdirectory structure)
            const relativePath = path.relative(dirPath, entryPath);
            
            files.push({
              name: relativePath, // e.g., "schemas/v0_summarization.schema.json"
              path: entryPath,    // Full absolute path
              size: stats.size,
              mtime: stats.mtime
            });
          } else if (entry.isDirectory()) {
            // Recursively scan subdirectories
            await scanRecursive(entryPath);
          }
        }
      };
      
      await scanRecursive(dirPath);
      
      return files;
    } catch (error) {
      this.logger?.warn('Failed to scan directory', { dirPath, error: error.message });
      return [];
    }
  }
  
  /**
   * Find files that were created or modified during execution
   * Excludes the temporary script file itself
   */
  findNewFiles(beforeFiles, afterFiles) {
    const beforeMap = new Map(beforeFiles.map(f => [f.name, f]));
    const newFiles = [];
    
    for (const afterFile of afterFiles) {
      // Skip temporary script files (they start with exec_)
      if (afterFile.name.startsWith('exec_') && afterFile.name.endsWith('.py')) {
        continue;
      }

      const beforeFile = beforeMap.get(afterFile.name);
      
      // If file didn't exist before, it's new
      if (!beforeFile) {
        newFiles.push(afterFile);
        continue;
      }
      
      // If file existed, check if it was modified
      // Compare mtime (milliseconds) and size
      const beforeTime = beforeFile.mtime?.getTime() || 0;
      const afterTime = afterFile.mtime?.getTime() || 0;
      
      if (afterTime > beforeTime || afterFile.size !== beforeFile.size) {
        newFiles.push(afterFile);
      }
    }
    
    return newFiles;
  }
  
  /**
   * Format execution results in container-compatible format
   */
  formatResults(execResult, newFiles) {
    // Create file references in container format
    const files = newFiles.map(file => {
      // Generate file_id from path hash (similar to container file IDs)
      const fileId = `local_${crypto.createHash('sha256').update(file.path).digest('hex').substring(0, 16)}`;
      
      return {
        file_id: fileId,
        filename: file.name,
        path: file.path,
        size: file.size
      };
    });
    
    // Format codeResults array (container format)
    const codeResults = [{
      type: 'code_output',
      output: execResult.stdout,
      logs: execResult.stderr ? [execResult.stderr] : [],
      files: files
    }];
    
    // Return in same format as executeInContainer
    return {
      content: execResult.stdout,
      reasoning: '', // Local execution doesn't have reasoning
      codeResults: codeResults,
      hadError: !execResult.success,
      errorType: execResult.success ? null : 'execution_error',
      usage: {
        // Local execution doesn't have token usage, but include duration
        duration_ms: execResult.duration
      },
      responseId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
  }
  
  /**
   * Format error results in container-compatible format
   */
  formatErrorResults(error, newFiles) {
    const files = newFiles.map(file => {
      const fileId = `local_${crypto.createHash('sha256').update(file.path).digest('hex').substring(0, 16)}`;
      return {
        file_id: fileId,
        filename: file.name,
        path: file.path,
        size: file.size
      };
    });

    const errorMessage = error.message || String(error);
    const isTimeout = errorMessage.includes('timed out');

    // Log full error for debugging
    this.logger?.warn('Python execution error', {
      errorPreview: errorMessage.substring(0, 1000),
      isTimeout,
      filesCreated: files.length
    });
    
    return {
      content: `[Error: ${errorMessage}]`,
      reasoning: '',
      codeResults: files.length > 0 ? [{
        type: 'code_output',
        output: errorMessage,
        logs: [errorMessage],
        files: files
      }] : [],
      hadError: true,
      errorType: isTimeout ? 'timeout' : 'execution_error',
      usage: {
        duration_ms: 0
      },
      responseId: `local_error_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
  }
  
  /**
   * List generated files (for compatibility with container interface)
   */
  async listGeneratedFiles(outputDir = null) {
    const dir = outputDir || this.workingDir;
    const files = await this.scanDirectory(dir);
    
    return files.map(file => ({
      id: `local_${crypto.createHash('sha256').update(file.path).digest('hex').substring(0, 16)}`,
      file_id: `local_${crypto.createHash('sha256').update(file.path).digest('hex').substring(0, 16)}`,
      filename: file.name,
      name: file.name,
      path: file.path,
      size: file.size
    }));
  }
  
  /**
   * Read file content (for compatibility with container download)
   */
  async readFile(fileId) {
    // For local backend, fileId might be a path or a hash
    // Try to find file by scanning directory
    const files = await this.listGeneratedFiles();
    const file = files.find(f => f.id === fileId || f.file_id === fileId || f.path === fileId);
    
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }
    
    return await fs.readFile(file.path);
  }
  
  /**
   * Cleanup temporary script file
   */
  async cleanupTempScript(scriptPath) {
    if (!scriptPath) return;
    
    try {
      await fs.unlink(scriptPath);
    } catch (error) {
      // Non-fatal - log but don't throw
      this.logger?.debug('Failed to cleanup temp script', { scriptPath, error: error.message });
    }
  }
  
  /**
   * Cleanup all temporary files and kill active processes
   */
  async cleanup() {
    // Kill any active processes
    for (const [pid, proc] of this.activeProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch (error) {
        this.logger?.warn('Failed to kill process', { pid, error: error.message });
      }
    }
    this.activeProcesses.clear();
    
    // Cleanup temp files (but keep generated output files)
    for (const tempFile of this.tempFiles) {
      try {
        // Only delete if it's a temp script (starts with exec_)
        if (tempFile.includes('exec_') && tempFile.endsWith('.py')) {
          await fs.unlink(tempFile);
        }
      } catch (error) {
        // Non-fatal
        this.logger?.debug('Failed to cleanup temp file', { tempFile, error: error.message });
      }
    }
    
    this.tempFiles = [];
    this.beforeFiles.clear();
    this.afterFiles.clear();
  }
  
  /**
   * Kill all active processes (emergency cleanup)
   */
  async killAll() {
    for (const [pid, proc] of this.activeProcesses) {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }
    this.activeProcesses.clear();
  }
}

module.exports = { PythonExecutor };
