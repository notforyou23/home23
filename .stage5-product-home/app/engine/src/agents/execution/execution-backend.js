const { PythonExecutor } = require('./python-executor');
const { cosmoEvents } = require('../../realtime/event-emitter');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * ExecutionBackend - Abstract interface for code execution backends
 * 
 * Provides unified interface for both container and local execution.
 * Both backends must return results in the same format for compatibility.
 */
class ExecutionBackend {
  constructor() {
    if (this.constructor === ExecutionBackend) {
      throw new Error('ExecutionBackend is abstract and cannot be instantiated directly');
    }
  }
  
  /**
   * Initialize execution backend
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }
  
  /**
   * Execute code (handles LLM code generation internally)
   * @param {Object} options - Execution options
   * @param {string} options.input - Input prompt for LLM
   * @param {string} options.code - Optional pre-written code (if provided, skip LLM)
   * @param {Array} options.files - Files to upload before execution
   * @param {number} options.max_output_tokens - Max tokens for LLM
   * @param {string} options.reasoningEffort - Reasoning effort level
   * @param {number} options.retryCount - Retry count
   * @returns {Promise<Object>} Execution results in container-compatible format
   */
  async executeCode(options = {}) {
    throw new Error('executeCode() must be implemented by subclass');
  }
  
  /**
   * Upload file to execution environment
   * @param {Buffer|string} file - File data
   * @param {string} filename - Filename
   * @returns {Promise<Object>} Upload result
   */
  async uploadFile(file, filename) {
    throw new Error('uploadFile() must be implemented by subclass');
  }
  
  /**
   * Download file from execution environment
   * @param {string} fileId - File identifier
   * @returns {Promise<Buffer>} File content
   */
  async downloadFile(fileId) {
    throw new Error('downloadFile() must be implemented by subclass');
  }
  
  /**
   * List all files in execution environment
   * @returns {Promise<Array>} List of files
   */
  async listFiles() {
    throw new Error('listFiles() must be implemented by subclass');
  }
  
  /**
   * Cleanup execution environment
   * @returns {Promise<void>}
   */
  async cleanup() {
    throw new Error('cleanup() must be implemented by subclass');
  }
  
  /**
   * Get backend type
   * @returns {string} 'container' or 'local'
   */
  getBackendType() {
    throw new Error('getBackendType() must be implemented by subclass');
  }
}

/**
 * ContainerBackend - Wraps existing GPT5Client container methods
 * 
 * Maintains backward compatibility by using existing container API.
 */
class ContainerBackend extends ExecutionBackend {
  constructor(gpt5Client, logger) {
    super();
    this.gpt5 = gpt5Client;
    this.logger = logger;
    this.containerId = null;
  }
  
  async initialize() {
    try {
      this.logger?.info('🐳 Creating code execution container...');
      this.containerId = await this.gpt5.createContainer();
      this.logger?.info('✅ Container ready', { containerId: this.containerId }, 3);
      return this.containerId;
    } catch (error) {
      this.logger?.error('❌ Failed to create container', { error: error.message }, 3);
      throw new Error(`Container creation failed: ${error.message}`);
    }
  }
  
  async executeCode(options = {}) {
    if (!this.containerId) {
      throw new Error('Container not initialized. Call initialize() first.');
    }
    
    // Wrap executeInContainer call
    return await this.gpt5.executeInContainer({
      containerId: this.containerId,
      ...options
    });
  }
  
  async uploadFile(file, filename) {
    if (!this.containerId) {
      throw new Error('Container not initialized. Call initialize() first.');
    }
    
    return await this.gpt5.uploadFileToContainer(this.containerId, file, filename);
  }
  
  async downloadFile(fileId) {
    if (!this.containerId) {
      throw new Error('Container not initialized. Call initialize() first.');
    }
    
    return await this.gpt5.downloadFileFromContainer(this.containerId, fileId);
  }
  
  async listFiles() {
    if (!this.containerId) {
      throw new Error('Container not initialized. Call initialize() first.');
    }
    
    return await this.gpt5.listContainerFiles(this.containerId);
  }
  
  async cleanup() {
    if (this.containerId) {
      try {
        await this.gpt5.deleteContainer(this.containerId);
        this.logger?.info('✅ Container deleted successfully', { containerId: this.containerId });
      } catch (error) {
        // Log but don't throw - cleanup should be best-effort
        this.logger?.warn('Container cleanup failed (non-fatal)', { 
          containerId: this.containerId,
          error: error.message 
        }, 3);
      }
      this.containerId = null;
    }
  }
  
  getBackendType() {
    return 'container';
  }
}

/**
 * LocalPythonBackend - Executes Python code locally
 * 
 * Uses LLM to generate code, then executes it locally via PythonExecutor.
 * Eliminates response.incomplete failures by avoiding container API.
 */
class LocalPythonBackend extends ExecutionBackend {
  constructor(config, logger, gpt5Client = null) {
    super();
    this.config = config;
    this.logger = logger;
    this.gpt5 = gpt5Client; // Required for LLM code generation
    
    // Initialize PythonExecutor
    const localConfig = config?.execution?.local || {};
    
    // CRITICAL: Use logsDir from config if available (run-specific directory)
    // This ensures execution happens in the correct run's directory structure
    // Format: runs/{runName}/outputs/execution/ (when logsDir is set)
    // OR: runtime/outputs/execution/ (when using default runtime)
    let executionWorkingDir;
    if (localConfig.workingDir) {
      // Explicit config override
      executionWorkingDir = path.isAbsolute(localConfig.workingDir) 
        ? localConfig.workingDir 
        : path.resolve(process.cwd(), localConfig.workingDir);
    } else if (config?.logsDir) {
      // Use logsDir (which points to runs/{runName}/) + outputs/execution
      // This matches where agents save their outputs
      executionWorkingDir = path.resolve(config.logsDir, 'outputs', 'execution');
    } else {
      // Fallback to runtime/outputs/execution relative to process.cwd()
      executionWorkingDir = path.resolve(process.cwd(), 'runtime', 'outputs', 'execution');
    }
    
    this.pythonExecutor = new PythonExecutor(null, logger, {
      pythonPath: localConfig.pythonPath,
      timeout: localConfig.timeout || 30000,
      workingDir: executionWorkingDir
    });
    
    // Track uploaded files
    this.uploadedFiles = [];
    this.workingDir = this.pythonExecutor.workingDir;
  }
  
  async initialize() {
    try {
      await this.pythonExecutor.initialize();
      this.logger?.info('✅ Local Python execution backend ready', {
        pythonPath: this.pythonExecutor.pythonPath,
        workingDir: this.workingDir
      }, 3);
    } catch (error) {
      this.logger?.error('❌ Failed to initialize local execution backend', { error: error.message }, 3);
      throw new Error(`Local execution backend initialization failed: ${error.message}`);
    }
  }
  
  async executeCode(options = {}) {
    const {
      input = null,
      code = null,
      files = [],
      max_output_tokens,
      maxOutputTokens,
      maxTokens,
      reasoningEffort = 'low',
      retryCount = 3,
      instructions = '',
      messages = []
    } = options;
    
    // Step 1: Upload files if provided
    if (files && files.length > 0) {
      for (const file of files) {
        await this.uploadFile(file.data, file.name);
      }
    }
    
    // Step 2: If code is provided directly, execute it
    if (code && code.trim().length > 0) {
      this.logger?.info('Executing provided Python code directly', {
        codeLength: code.length
      });
      
      const result = await this.pythonExecutor.execute(code, {
        outputDir: this.workingDir,
        timeout: this.pythonExecutor.timeout
      });
      
      return result;
    }
    
    // Step 3: If no code provided, use LLM to generate code from input
    if (!this.gpt5) {
      throw new Error('GPT5Client required for code generation. Provide code directly or initialize gpt5Client.');
    }
    
    // Build prompt for LLM to generate Python code
    const prompt = this.buildCodeGenerationPrompt(input, instructions, messages);
    
    // Call LLM to generate Python code
    this.logger?.info('🤖 Generating Python code via LLM...');
    cosmoEvents.emitEvent('code_generation', { status: 'started', language: 'python' });

    // For local execution, we simulate code_interpreter by having LLM generate code
    // But we need to match the container behavior: LLM uses a tool, tool executes code
    // Since we can't use OpenAI's code_interpreter tool locally, we extract code and execute it
    // Use config's model if available, otherwise let UnifiedClient decide (supports local LLM)
    const modelToUse = this.config?.models?.strategicModel || this.config?.models?.defaultModel;
    const llmResponse = await this.gpt5.generateWithRetry({
      model: modelToUse, // Let UnifiedClient route based on config (undefined = use default)
      input: prompt,
      max_output_tokens: max_output_tokens || maxOutputTokens || maxTokens || 8000,
      reasoningEffort: reasoningEffort,
      instructions: `You are generating Python code for local execution (not a container).
The working directory is: ${this.workingDir}
All file paths should use this directory. Replace any /mnt/data/ references with: ${this.workingDir}
Generate clean, executable Python code that accomplishes the task.
Return ONLY the Python code, no explanations, no markdown formatting, just the code.`
    }, retryCount);
    
    // Extract Python code from LLM response
    const pythonCode = this.extractPythonCode(llmResponse.content);
    
    if (!pythonCode || pythonCode.trim().length === 0) {
      throw new Error('LLM did not generate valid Python code');
    }
    
    this.logger?.info('✅ Python code generated, executing locally...', {
      codeLength: pythonCode.length
    });
    cosmoEvents.emitEvent('code_generation', { status: 'complete', language: 'python', codeLength: pythonCode.length });
    
    // Step 4: Execute generated code locally
    const result = await this.pythonExecutor.execute(pythonCode, {
      outputDir: this.workingDir,
      timeout: this.pythonExecutor.timeout
    });
    
    // Step 5: Combine LLM response metadata with execution results
    return {
      ...result,
      // Preserve LLM metadata
      reasoning: llmResponse.reasoning || '',
      usage: {
        ...llmResponse.usage,
        ...result.usage
      },
      responseId: llmResponse.responseId || result.responseId
    };
  }
  
  /**
   * Build prompt for LLM to generate Python code
   * CRITICAL: This mimics the container code_interpreter tool behavior
   * The prompt should match the container prompt structure but use local paths
   * 
   * Key insight: Containers use code_interpreter TOOL, which handles execution.
   * For local, we extract code from tool calls and execute it ourselves.
   * But the prompt is designed for containers, so we transform it.
   */
  buildCodeGenerationPrompt(input, instructions, messages) {
    const workingDir = this.workingDir;
    const normalizedWorkingDir = workingDir.replace(/\\/g, '/'); // Normalize for Python
    
    // Transform container-specific prompt to local environment
    // The original prompt says "You are inside the OpenAI code interpreter environment with filesystem access to /mnt/data/"
    // We need to change this to local environment
    let processedInput = input || '';
    if (typeof processedInput === 'string') {
      // Replace container environment description
      processedInput = processedInput.replace(
        /You are inside the OpenAI code interpreter environment with filesystem access to \/mnt\/data\/\./g,
        `You are in a local Python environment with filesystem access to ${normalizedWorkingDir}.`
      );
      
      // Replace all /mnt/data/ path references
      processedInput = processedInput.replace(/\/mnt\/data\//g, normalizedWorkingDir + '/');
      processedInput = processedInput.replace(/\/mnt\/data['"]/g, normalizedWorkingDir + "'");
      processedInput = processedInput.replace(/Path\(['"]\/mnt\/data['"]\)/g, `Path('${normalizedWorkingDir}')`);
      
      // Replace instructions about writing to /mnt/data/
      processedInput = processedInput.replace(/All files must be written beneath \/mnt\/data\/\./g, 
        `All files must be written beneath ${normalizedWorkingDir}.`);
    }
    
    // Process instructions similarly
    let processedInstructions = instructions || '';
    if (instructions && instructions.trim().length > 0) {
      processedInstructions = processedInstructions.replace(/\/mnt\/data\//g, normalizedWorkingDir + '/');
      processedInstructions = processedInstructions.replace(/Path\(['"]\/mnt\/data['"]\)/g, `Path('${normalizedWorkingDir}')`);
    }
    
    // Build the transformed prompt
    const parts = [];
    
    if (processedInstructions && processedInstructions.trim().length > 0) {
      parts.push(`Instructions: ${processedInstructions.trim()}`);
    }
    
    if (processedInput && processedInput.trim().length > 0) {
      parts.push(processedInput.trim());
    }
    
    if (messages && messages.length > 0) {
      const userMessages = messages.filter(m => m.role === 'user').map(m => {
        let content = m.content || '';
        if (typeof content === 'string') {
          content = content.replace(/\/mnt\/data\//g, normalizedWorkingDir + '/');
          content = content.replace(/Path\(['"]\/mnt\/data['"]\)/g, `Path('${normalizedWorkingDir}')`);
        }
        return content;
      });
      if (userMessages.length > 0) {
        parts.push(`Context: ${userMessages.join('\n')}`);
      }
    }
    
    // Add explicit instruction about local execution
    // CRITICAL: For local execution, use normal Python file I/O (not base64 encoding like containers)
    parts.push(`\nIMPORTANT FOR LOCAL EXECUTION:`);
    parts.push(`- Working directory: ${normalizedWorkingDir}`);
    parts.push(`- All file paths must use: ${normalizedWorkingDir}`);
    parts.push(`- Replace any remaining /mnt/data/ references with: ${normalizedWorkingDir}`);
    parts.push(`- Use normal Python file I/O to write files (e.g., open(), Path.write_text(), etc.)`);
    parts.push(`- NO base64 encoding needed - write files directly using standard Python file operations`);
    parts.push(`- Ensure files are actually written to disk (not just defined in code)`);
    parts.push(`- Return ONLY the Python code, no markdown, no explanations.`);
    
    return parts.join('\n\n');
  }
  
  /**
   * Extract Python code from LLM response
   * Handles markdown code blocks, plain code, etc.
   */
  extractPythonCode(content) {
    if (!content || typeof content !== 'string') {
      return '';
    }
    
    // Try to extract from markdown code blocks
    const codeBlockMatch = content.match(/```(?:python)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    
    // Try to find code between triple backticks (any language)
    const anyCodeBlock = content.match(/```[\s\S]*?```/);
    if (anyCodeBlock) {
      const extracted = anyCodeBlock[0].replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
      // Check if it looks like Python (has Python keywords or patterns)
      if (extracted.includes('import ') || extracted.includes('def ') || extracted.includes('print(')) {
        return extracted;
      }
    }
    
    // If no code blocks, check if entire content is Python code
    // (starts with import, def, class, or is mostly code-like)
    const trimmed = content.trim();
    if (trimmed.startsWith('import ') || 
        trimmed.startsWith('from ') || 
        trimmed.startsWith('def ') || 
        trimmed.startsWith('class ') ||
        trimmed.split('\n').length > 3) {
      return trimmed;
    }
    
    // Fallback: return content as-is (LLM might have returned plain code)
    return trimmed;
  }
  
  async uploadFile(file, filename) {
    // Validate filename
    if (!filename || typeof filename !== 'string') {
      throw new Error('Filename is required');
    }
    
    // Ensure directory exists
    const filePath = path.join(this.workingDir, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    // Write file
    const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
    await fs.writeFile(filePath, buffer);
    
    this.uploadedFiles.push({
      filename,
      path: filePath,
      size: buffer.length
    });
    
    this.logger?.debug('File uploaded to local backend', { filename, path: filePath });
    
    return {
      id: `local_${crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16)}`,
      filename,
      path: filePath
    };
  }
  
  async downloadFile(fileId) {
    // For local backend, fileId might be a path, hash, or filename
    // Try to find file
    const files = await this.listFiles();
    const file = files.find(f => 
      f.id === fileId || 
      f.file_id === fileId || 
      f.path === fileId ||
      f.filename === fileId
    );
    
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }
    
    return await fs.readFile(file.path);
  }
  
  async listFiles() {
    return await this.pythonExecutor.listGeneratedFiles(this.workingDir);
  }
  
  async cleanup() {
    try {
      await this.pythonExecutor.cleanup();
      this.uploadedFiles = [];
      this.logger?.info('✅ Local execution backend cleaned up');
    } catch (error) {
      this.logger?.warn('Local backend cleanup failed (non-fatal)', { error: error.message }, 3);
    }
  }
  
  getBackendType() {
    return 'local';
  }
}

module.exports = {
  ExecutionBackend,
  ContainerBackend,
  LocalPythonBackend
};

