const { BaseAgent } = require('./base-agent');
const fs = require('fs').promises;
const path = require('path');

/**
 * SpecializedBinaryAgent - Binary file processing specialist
 * 
 * Purpose:
 * - Extract text and metadata from PDF documents
 * - Extract content from Office documents (DOCX, XLSX)
 * - Process compressed files (.gz)
 * - Store extractions in memory and file system
 * - Enable other agents to work with previously inaccessible binary data
 * 
 * Capabilities:
 * - PDF: Full text extraction, page count, metadata
 * - DOCX: Plain text and HTML extraction
 * - XLSX: Structured data as JSON (with row limits)
 * - Graceful handling of password-protected files
 * - Memory-safe chunking for large extractions
 * 
 * Use Cases:
 * - Process research papers (PDF) for analysis
 * - Extract data from spreadsheets for computational validation
 * - Read documentation from Office documents
 * - Build knowledge base from binary document collections
 */
class SpecializedBinaryAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    
    // State tracking
    this.processedFiles = [];
    this.extractionResults = [];
    this.tempFiles = [];  // Track temp files for cleanup
    
    // Configuration limits - set high for research-grade document processing
    // COSMO processes serious workloads, not toy examples
    this.limits = {
      MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024,  // 2GB - handles large research documents, books, datasets
      MAX_PDF_PAGES: 10000,                    // 10k pages - full books, technical manuals, research compendia
      MAX_XLSX_ROWS: 1000000,                  // 1M rows - serious datasets, not toy spreadsheets
      MAX_EXTRACTION_SIZE: 5 * 1024 * 1024 * 1024  // 5GB extracted content - large document collections
    };
    
    // Libraries (lazy-loaded)
    this.pdfParse = null;
    this.mammoth = null;
    this.xlsx = null;
    
    // NEW: Batch processing configuration (additive, backward compatible)
    // Default batch size of 50 binary files (smaller than text files due to processing overhead)
    this.batchSize = mission.batchSize !== undefined ? mission.batchSize : 50;
    this.continuationId = mission.continuationId || null;
    this.processedFilesList = mission.processedFiles || []; // Files already processed (for continuations)
    this.isContinuation = !!mission.continuationId;
  }

  /**
   * Initialize agent - load libraries
   */
  async onStart() {
    await super.onStart();
    
    this.logger.info('📚 Specialized Binary Agent initializing...', {
      agentId: this.agentId
    });
    
    // Lazy-load libraries
    try {
      this.pdfParse = require('pdf-parse');
      this.mammoth = require('mammoth');
      this.xlsx = require('xlsx');
      
      this.logger.info('✅ Binary processing libraries loaded', {
        pdf: 'pdf-parse',
        docx: 'mammoth',
        xlsx: 'xlsx'
      });
    } catch (error) {
      throw new Error(`Failed to load required libraries: ${error.message}. Run: npm install pdf-parse mammoth xlsx`);
    }
    
    // Verify MCP binary file reading capability
    if (!this.gpt5?.callMCPTool) {
      this.logger.warn('⚠️  MCP tools not available - cannot read binary files');
      throw new Error('MCP required for binary file access');
    }
    
    await this.reportProgress(10, 'Binary processing agent ready');
  }

  /**
   * NEW: Get or create progress registry for batch tracking
   * Registry tracks: processed files, batch info, continuation chain
   * @returns {Object} Progress registry
   */
  async getOrCreateProgressRegistry() {
    const registryPath = path.join(
      this.config.logsDir || path.join(process.cwd(), 'runtime'),
      'agents',
      this.agentId,
      'binary-progress.json'
    );
    
    try {
      const data = await fs.readFile(registryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // Registry doesn't exist yet - create new one
      const registry = {
        agentId: this.agentId,
        createdAt: new Date().toISOString(),
        isContinuation: this.isContinuation,
        continuationId: this.continuationId,
        processedFiles: [...this.processedFilesList],
        totalDiscovered: 0,
        batches: [],
        status: 'active'
      };
      
      // Create directory if needed
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), registryPath),
          JSON.stringify(registry, null, 2),
          { agentId: this.agentId, agentType: 'specialized-binary', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
      }
      
      this.logger.info('📝 Created binary progress registry', {
        agentId: this.agentId,
        isContinuation: this.isContinuation,
        alreadyProcessed: this.processedFilesList.length
      });
      
      return registry;
    }
  }

  /**
   * NEW: Update progress registry after processing batch
   * @param {Object} registry - Progress registry to update
   * @param {Array} newProcessedFiles - Files processed in this batch
   * @param {Object} batchInfo - Information about this batch
   */
  async updateProgressRegistry(registry, newProcessedFiles, batchInfo) {
    const registryPath = path.join(
      this.config.logsDir || path.join(process.cwd(), 'runtime'),
      'agents',
      this.agentId,
      'binary-progress.json'
    );
    
    // Add new files to processed list
    registry.processedFiles.push(...newProcessedFiles);
    
    // Add batch info
    registry.batches.push({
      batchNumber: registry.batches.length + 1,
      filesProcessed: newProcessedFiles.length,
      completedAt: new Date().toISOString(),
      ...batchInfo
    });
    
    // Update status
    registry.lastUpdated = new Date().toISOString();
    
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), registryPath),
        JSON.stringify(registry, null, 2),
        { agentId: this.agentId, agentType: 'specialized-binary', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
    }
    
    this.logger.debug('📝 Updated binary progress registry', {
      totalProcessed: registry.processedFiles.length,
      batchNumber: registry.batches.length
    });
  }

  /**
   * NEW: Spawn continuation agent to process remaining binary files
   * @param {Array} remainingFiles - Files not yet processed
   * @param {Object} registry - Progress registry
   */
  async spawnContinuationAgent(remainingFiles, registry) {
    if (remainingFiles.length === 0) {
      return null;
    }
    
    // Generate continuation ID (chain continuations together)
    const continuationId = this.continuationId || `continuation_${this.agentId}`;
    
    // Build continuation mission
    const continuationMission = {
      ...this.mission,
      description: `${this.mission.description} [CONTINUATION: Processing ${remainingFiles.length} remaining binary files]`,
      batchSize: this.batchSize,
      continuationId: continuationId,
      processedFiles: [...registry.processedFiles], // Pass list of already processed files
      _isContinuation: true,
      _originalAgentId: this.continuationId ? this.mission._originalAgentId : this.agentId
    };
    
    this.logger.info('🔄 Spawning binary continuation agent', {
      remainingFiles: remainingFiles.length,
      processedSoFar: registry.processedFiles.length,
      continuationId: continuationId,
      batchSize: this.batchSize
    });
    
    // Queue continuation agent via actions queue
    try {
      const actionsQueuePath = path.join(
        this.config.logsDir || path.join(process.cwd(), 'runtime'),
        'actions-queue.json'
      );
      
      let actionsData = { actions: [] };
      try {
        const data = await fs.readFile(actionsQueuePath, 'utf-8');
        actionsData = JSON.parse(data);
      } catch (error) {
        // Queue doesn't exist - will be created
      }
      
      const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const newAction = {
        actionId,
        type: 'spawn_agent',
        agentType: 'specialized_binary',
        mission: JSON.stringify(continuationMission),
        priority: this.mission.priority || 0.8,
        requestedAt: new Date().toISOString(),
        source: 'specialized_binary_agent_continuation',
        status: 'pending',
        parentAgentId: this.agentId,
        continuationOf: this.continuationId || this.agentId
      };
      
      actionsData.actions = actionsData.actions || [];
      actionsData.actions.push(newAction);
      
      if (this.capabilities) {
        await this.capabilities.writeFile(
          path.relative(process.cwd(), actionsQueuePath),
          JSON.stringify(actionsData, null, 2),
          { agentId: this.agentId, agentType: 'specialized-binary', missionGoal: this.mission.goalId }
        );
      } else {
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
      }
      
      this.logger.info('✅ Binary continuation agent queued', {
        actionId,
        continuationId,
        remainingFiles: remainingFiles.length
      });
      
      // Store continuation info in registry
      registry.continuationAgentQueued = {
        actionId,
        queuedAt: new Date().toISOString(),
        remainingFiles: remainingFiles.length
      };
      await this.updateProgressRegistry(registry, [], {
        continuationQueued: true,
        actionId
      });
      
      return actionId;
      
    } catch (error) {
      this.logger.error('Failed to spawn binary continuation agent', {
        error: error.message,
        remainingFiles: remainingFiles.length
      });
      throw error;
    }
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('🔍 Starting binary file processing mission', {
      agentId: this.agentId,
      mission: this.mission.description.substring(0, 100),
      batchSize: this.batchSize,
      isContinuation: this.isContinuation,
      alreadyProcessed: this.processedFilesList.length
    });

    // NEW: Initialize progress registry for batch tracking
    const registry = await this.getOrCreateProgressRegistry();

    await this.reportProgress(15, 'Discovering binary files');

    // Step 1: Discover binary files to process
    let allFiles = await this.discoverBinaryFiles();
    
    if (allFiles.length === 0) {
      this.logger.warn('No binary files found to process');
      return {
        success: true,
        filesProcessed: 0,
        message: 'No binary files found matching mission criteria'
      };
    }
    
    // NEW: Filter out already processed files (for continuation agents)
    const processedSet = new Set(registry.processedFiles);
    const unprocessedFiles = allFiles.filter(f => !processedSet.has(f.path || f.name));
    
    if (unprocessedFiles.length === 0) {
      this.logger.warn('All discovered files have already been processed');
      return {
        success: true,
        filesProcessed: 0,
        message: 'All files already processed in previous batch'
      };
    }
    
    this.logger.info(`📂 Found ${allFiles.length} binary files (${unprocessedFiles.length} unprocessed)`, {
      total: allFiles.length,
      alreadyProcessed: allFiles.length - unprocessedFiles.length,
      unprocessed: unprocessedFiles.length
    });
    
    // NEW: Apply batch limits
    let filesToProcess;
    let remainingFiles = [];
    
    if (this.batchSize === 0) {
      // Unlimited mode
      filesToProcess = unprocessedFiles;
      this.logger.info('📊 Batch size: UNLIMITED (will process all files)');
    } else {
      // Apply batch limit
      filesToProcess = unprocessedFiles.slice(0, this.batchSize);
      remainingFiles = unprocessedFiles.slice(this.batchSize);
      
      this.logger.info('📊 Batch size configured', {
        batchSize: this.batchSize,
        willProcess: filesToProcess.length,
        remaining: remainingFiles.length
      });
    }
    
    // Store for continuation logic
    registry.totalDiscovered = allFiles.length;
    registry.currentBatchSize = filesToProcess.length;
    registry.remainingFiles = remainingFiles;
    
    await this.reportProgress(25, `Processing ${filesToProcess.length} files`);

    // Step 2: Process each file
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < filesToProcess.length; i++) {
      const file = filesToProcess[i];
      const progress = 25 + ((i + 1) / filesToProcess.length) * 60;
      
      try {
        await this.reportProgress(progress, `Processing ${file.name} (${i + 1}/${filesToProcess.length})`);
        
        const result = await this.processFile(file);
        
        if (result.success) {
          successCount++;
          this.extractionResults.push(result);
        } else {
          errorCount++;
          this.logger.warn(`File processing returned error: ${file.name}`, {
            error: result.error
          });
        }
      } catch (error) {
        errorCount++;
        this.logger.error(`Failed to process file: ${file.name}`, {
          error: error.message,
          stack: error.stack
        });
        
        // Continue processing other files (error isolation)
        this.extractionResults.push({
          success: false,
          file: file.name,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    await this.reportProgress(90, 'Storing results in memory');
    
    // Step 3: Store summary in memory for other agents
    const summary = `Processed ${filesToProcess.length} binary files: ` +
                   `${successCount} successful, ${errorCount} errors. ` +
                   `Extracted content available in binary-data directory.`;
    
    await this.addFinding(summary, 'binary_extraction');
    
    // NEW: Update progress registry with processed files
    const processedFilePaths = filesToProcess.map(f => f.path || f.name);
    await this.updateProgressRegistry(registry, processedFilePaths, {
      filesProcessed: filesToProcess.length,
      successCount,
      errorCount,
      extractions: this.extractionResults.length
    });

    // NEW: Check if continuation is needed
    let continuationInfo = null;
    if (remainingFiles.length > 0) {
      this.logger.info('📚 More binary files remaining - spawning continuation agent', {
        processedInThisBatch: filesToProcess.length,
        totalProcessedSoFar: registry.processedFiles.length,
        remaining: remainingFiles.length
      });
      
      await this.reportProgress(95, `Spawning continuation agent for ${remainingFiles.length} remaining files`);
      
      try {
        const actionId = await this.spawnContinuationAgent(remainingFiles, registry);
        
        continuationInfo = {
          continuationQueued: true,
          actionId: actionId,
          remainingFiles: remainingFiles.length,
          message: `Continuation agent queued to process ${remainingFiles.length} remaining binary files`
        };
        
        // Add finding about continuation
        await this.addFinding(
          `Batch processing complete. Processed ${filesToProcess.length} binary files in this batch. ` +
          `Total processed: ${registry.processedFiles.length}. ` +
          `Remaining: ${remainingFiles.length}. ` +
          `Continuation agent queued (action: ${actionId}).`,
          'binary_batch_completion'
        );
        
      } catch (error) {
        this.logger.error('Failed to spawn continuation agent', {
          error: error.message,
          remaining: remainingFiles.length
        });
        
        continuationInfo = {
          continuationQueued: false,
          error: error.message,
          remainingFiles: remainingFiles.length,
          message: `Warning: ${remainingFiles.length} files remain but continuation agent failed to spawn`
        };
      }
    } else {
      // All files processed
      this.logger.info('✅ All binary files processed - no continuation needed', {
        totalProcessed: registry.processedFiles.length,
        batchesCompleted: registry.batches.length
      });
      
      // Mark registry as complete
      registry.status = 'completed';
      registry.completedAt = new Date().toISOString();
      await this.updateProgressRegistry(registry, [], { finalBatch: true });
      
      // Add completion finding
      if (registry.batches.length > 1 || this.isContinuation) {
        await this.addFinding(
          `Binary file processing complete across ${registry.batches.length} batch(es). ` +
          `Total files processed: ${registry.processedFiles.length}. ` +
          `This was ${this.isContinuation ? 'a continuation agent completing the processing chain' : 'completed in a single agent execution'}.`,
          'binary_processing_chain_complete'
        );
      }
    }
    
    await this.reportProgress(100, 'Binary processing complete');
    
    return {
      success: true,
      filesProcessed: filesToProcess.length,
      successCount,
      errorCount,
      extractions: this.extractionResults.length,
      // NEW: Batch processing metadata
      batchInfo: {
        batchNumber: registry.batches.length,
        totalProcessedSoFar: registry.processedFiles.length,
        isContinuation: this.isContinuation,
        continuationId: this.continuationId,
        continuation: continuationInfo
      }
    };
  }

  /**
   * Discover binary files from mission or filesystem
   */
  async discoverBinaryFiles() {
    const files = [];
    
    // Method 1: Explicit file paths in mission description
    const explicitFiles = this.extractFilePathsFromMission();
    if (explicitFiles.length > 0) {
      this.logger.info(`Found ${explicitFiles.length} explicit file paths in mission`);
      return explicitFiles;
    }
    
    // Method 2: Scan configured directories for binary files
    const mcpServers = this.config?.mcp?.client?.servers;
    const allowedPaths = mcpServers?.[0]?.allowedPaths || [];
    
    if (allowedPaths.length === 0) {
      this.logger.warn('No allowed paths configured - cannot scan for binary files');
      return [];
    }
    
    for (const dirPath of allowedPaths) {
      try {
        const dirFiles = await this.scanDirectoryForBinaryFiles(dirPath);
        files.push(...dirFiles);
      } catch (error) {
        this.logger.warn(`Failed to scan directory: ${dirPath}`, {
          error: error.message
        });
      }
    }
    
    return files;
  }

  /**
   * Extract file paths from mission description
   */
  extractFilePathsFromMission() {
    const description = this.mission.description;
    const files = [];
    
    // Pattern: path/to/file.ext
    const filePattern = /(?:^|\s|["'])([\w\/-]+\.(?:pdf|docx|xlsx|doc|xls))(?:\s|["']|$)/gi;
    let match;
    
    while ((match = filePattern.exec(description)) !== null) {
      const filePath = match[1];
      const extension = path.extname(filePath).toLowerCase().substring(1);
      
      files.push({
        path: filePath,
        name: path.basename(filePath),
        extension: extension,
        explicit: true
      });
    }
    
    return files;
  }

  /**
   * Scan directory for binary files
   */
  async scanDirectoryForBinaryFiles(dirPath) {
    const files = [];
    
    try {
      const items = await this.listDirectoryViaMCP(dirPath);
      
      for (const item of items) {
        if (item.type !== 'file') continue;
        
        const ext = path.extname(item.name).toLowerCase();
        if (['.pdf', '.docx', '.xlsx', '.doc', '.xls'].includes(ext)) {
          files.push({
            path: dirPath === '.' ? item.name : `${dirPath}/${item.name}`,
            name: item.name,
            extension: ext.substring(1),
            size: item.size,
            explicit: false
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to scan directory: ${dirPath}`, {
        error: error.message
      });
    }
    
    return files;
  }

  /**
   * Process a single binary file
   */
  async processFile(file) {
    this.logger.info(`Processing binary file: ${file.name}`, {
      type: file.extension,
      size: file.size
    });
    
    // Check file size limit
    if (file.size && file.size > this.limits.MAX_FILE_SIZE) {
      return {
        success: false,
        file: file.name,
        error: 'file_too_large',
        message: `File size ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds limit of ${(this.limits.MAX_FILE_SIZE / 1024 / 1024).toFixed(1)}MB`
      };
    }
    
    // Read binary file via MCP
    let buffer;
    try {
      buffer = await this.readBinaryFileViaMCP(file.path);
    } catch (error) {
      return {
        success: false,
        file: file.name,
        error: 'read_failed',
        message: error.message
      };
    }
    
    // Detect actual file type (in case extension is wrong)
    const detectedType = this.detectFileType(buffer);
    if (detectedType && detectedType !== file.extension) {
      this.logger.warn(`File type mismatch: extension says ${file.extension}, content says ${detectedType}`, {
        file: file.name
      });
    }
    
    // Process based on type
    let extraction;
    try {
      switch (file.extension) {
        case 'pdf':
          extraction = await this.extractPDF(buffer, file);
          break;
        case 'docx':
          extraction = await this.extractDOCX(buffer, file);
          break;
        case 'xlsx':
        case 'xls':
          extraction = await this.extractXLSX(buffer, file);
          break;
        default:
          return {
            success: false,
            file: file.name,
            error: 'unsupported_type',
            message: `File type ${file.extension} not supported`
          };
      }
    } catch (error) {
      return {
        success: false,
        file: file.name,
        error: 'extraction_failed',
        message: error.message
      };
    }
    
    // Store extraction
    await this.storeExtraction(extraction, file);
    
    this.processedFiles.push(file.name);
    
    return {
      success: true,
      file: file.name,
      type: file.extension,
      extraction: extraction
    };
  }

  /**
   * Read binary file via MCP and decode from base64
   */
  async readBinaryFileViaMCP(filePath) {
    const result = await this.gpt5.callMCPTool('filesystem', 'read_binary_file', {
      path: filePath
    });
    
    if (!result?.content?.[0]) {
      throw new Error(`Empty response from MCP for: ${filePath}`);
    }
    
    const data = JSON.parse(result.content[0].text);
    
    if (data.encoding !== 'base64') {
      throw new Error(`Unexpected encoding: ${data.encoding}`);
    }
    
    // Decode base64 to buffer
    return Buffer.from(data.content, 'base64');
  }

  /**
   * Detect file type from magic bytes
   */
  detectFileType(buffer) {
    // PDF signature
    if (buffer.slice(0, 4).toString() === '%PDF') {
      return 'pdf';
    }
    
    // ZIP signature (used by DOCX/XLSX)
    if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return 'office';  // Could be docx or xlsx
    }
    
    return null;
  }

  /**
   * Extract text and metadata from PDF
   */
  async extractPDF(buffer, file) {
    this.logger.info(`Extracting PDF: ${file.name}`);
    
    try {
      const pdfData = await this.pdfParse(buffer);
      
      // Check if PDF has extractable text
      if (!pdfData.text || pdfData.text.trim().length === 0) {
        return {
          type: 'pdf',
          success: false,
          error: 'no_text',
          message: 'PDF contains no extractable text (might be scanned images)',
          metadata: pdfData.info,
          pages: pdfData.numpages
        };
      }
      
      // Check page limit
      if (pdfData.numpages > this.limits.MAX_PDF_PAGES) {
        return {
          type: 'pdf',
          success: false,
          error: 'too_many_pages',
          message: `PDF has ${pdfData.numpages} pages, exceeds limit of ${this.limits.MAX_PDF_PAGES}`,
          metadata: pdfData.info
        };
      }
      
      return {
        type: 'pdf',
        success: true,
        text: pdfData.text,
        pages: pdfData.numpages,
        metadata: pdfData.info,
        wordCount: pdfData.text.split(/\s+/).length
      };
    } catch (error) {
      // Handle password-protected PDFs
      if (error.message && error.message.toLowerCase().includes('encrypt')) {
        return {
          type: 'pdf',
          success: false,
          error: 'password_protected',
          message: `PDF is password-protected: ${file.name}`
        };
      }
      
      throw error;
    }
  }

  /**
   * Extract text from DOCX
   */
  async extractDOCX(buffer, file) {
    this.logger.info(`Extracting DOCX: ${file.name}`);
    
    // Save buffer to temp file (mammoth works with files)
    const tempPath = path.join(this.config.logsDir || 'runtime', `temp_${this.agentId}_${Date.now()}.docx`);
    if (this.capabilities) {
      const result = await this.capabilities.writeFile(
        path.relative(process.cwd(), tempPath),
        buffer,
        { agentId: this.agentId, agentType: 'specialized-binary', missionGoal: this.mission.goalId }
      );
      if (!result?.success && !result?.skipped) {
        throw new Error(result?.error || result?.reason || 'Failed to write temp DOCX');
      }
    } else {
      await fs.writeFile(tempPath, buffer);
    }
    this.tempFiles.push(tempPath);
    
    try {
      // Extract as plain text
      const textResult = await this.mammoth.extractRawText({ path: tempPath });
      
      // Extract as HTML (for formatted content)
      const htmlResult = await this.mammoth.convertToHtml({ path: tempPath });
      
      // Check for conversion warnings
      if (textResult.messages.length > 0) {
        this.logger.warn('DOCX conversion warnings', {
          file: file.name,
          warnings: textResult.messages.map(m => m.message)
        });
      }
      
      return {
        type: 'docx',
        success: true,
        text: textResult.value,
        html: htmlResult.value,
        wordCount: textResult.value.split(/\s+/).length,
        warnings: textResult.messages.length
      };
    } finally {
      // Cleanup happens in onComplete/onError/onTimeout
    }
  }

  /**
   * Extract data from XLSX
   */
  async extractXLSX(buffer, file) {
    this.logger.info(`Extracting XLSX: ${file.name}`);
    
    // Parse workbook from buffer
    const workbook = this.xlsx.read(buffer, { type: 'buffer' });
    
    const sheets = [];
    
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      
      // Get dimensions
      if (!worksheet['!ref']) {
        this.logger.warn(`Sheet ${sheetName} has no data range`);
        continue;
      }
      
      const range = this.xlsx.utils.decode_range(worksheet['!ref']);
      const rowCount = range.e.r - range.s.r + 1;
      const colCount = range.e.c - range.s.c + 1;
      
      // Apply row limit
      let data;
      if (rowCount > this.limits.MAX_XLSX_ROWS) {
        this.logger.warn(`Sheet ${sheetName} has ${rowCount} rows, limiting to ${this.limits.MAX_XLSX_ROWS}`);
        
        const limitedRange = {
          s: range.s,
          e: { r: range.s.r + this.limits.MAX_XLSX_ROWS, c: range.e.c }
        };
        worksheet['!ref'] = this.xlsx.utils.encode_range(limitedRange);
        data = this.xlsx.utils.sheet_to_json(worksheet);
      } else {
        data = this.xlsx.utils.sheet_to_json(worksheet);
      }
      
      sheets.push({
        name: sheetName,
        rowCount: Math.min(rowCount, this.limits.MAX_XLSX_ROWS),
        columnCount: colCount,
        actualRowCount: rowCount,
        truncated: rowCount > this.limits.MAX_XLSX_ROWS,
        data: data
      });
    }
    
    return {
      type: 'xlsx',
      success: true,
      sheetCount: sheets.length,
      sheets: sheets,
      totalRows: sheets.reduce((sum, s) => sum + s.rowCount, 0)
    };
  }

  /**
   * Store extraction results
   */
  async storeExtraction(extraction, file) {
    // Generate output path
    const outputFilename = `${path.parse(file.name).name}_extracted_${this.agentId}.json`;
    const paths = this.pathResolver.getDeliverablePath({
      deliverableSpec: {
        path: '@binary-cache/',
        name: outputFilename
      },
      agentType: 'specialized_binary',
      agentId: this.agentId,
      fallbackName: outputFilename
    });
    
    // Store full extraction in file via Capabilities
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), paths.fullPath),
        JSON.stringify(extraction, null, 2),
        { agentId: this.agentId, agentType: 'specialized-binary', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(paths.fullPath, JSON.stringify(extraction, null, 2));
    }
    
    // Store metadata in memory (small, embeddable)
    const metadata = {
      type: extraction.type,
      sourceFile: file.name,
      sourcePath: file.path,
      success: extraction.success,
      extractedAt: new Date().toISOString(),
      agentId: this.agentId,
      fullDataPath: paths.relativePath
    };
    
    // Add type-specific metadata
    if (extraction.type === 'pdf') {
      metadata.pages = extraction.pages;
      metadata.wordCount = extraction.wordCount;
    } else if (extraction.type === 'docx') {
      metadata.wordCount = extraction.wordCount;
    } else if (extraction.type === 'xlsx') {
      metadata.sheetCount = extraction.sheetCount;
      metadata.totalRows = extraction.totalRows;
    }
    
    // Store in memory with type-specific tag
    await this.addFinding(
      JSON.stringify(metadata),
      `${extraction.type}_extraction`
    );
    
    this.logger.info(`✅ Extraction stored`, {
      file: file.name,
      type: extraction.type,
      path: paths.relativePath
    });
  }

  /**
   * Cleanup temporary files
   */
  async cleanupTempFiles() {
    for (const tempFile of this.tempFiles) {
      try {
        await fs.unlink(tempFile);
        this.logger.debug(`Cleaned up temp file: ${tempFile}`);
      } catch (error) {
        this.logger.warn(`Failed to cleanup temp file: ${tempFile}`, {
          error: error.message
        });
      }
    }
    this.tempFiles = [];
  }

  /**
   * Lifecycle: Cleanup on completion
   */
  async onComplete() {
    await this.cleanupTempFiles();
    await super.onComplete();
  }

  /**
   * Lifecycle: Cleanup on error
   */
  async onError(error) {
    await this.cleanupTempFiles();
    await super.onError(error);
  }

  /**
   * Lifecycle: Cleanup on timeout
   */
  async onTimeout() {
    await this.cleanupTempFiles();
    await super.onTimeout();
  }
}

module.exports = { SpecializedBinaryAgent };

