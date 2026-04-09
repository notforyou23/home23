/**
 * FrontierGate - Runtime governance for COSMO agents
 * 
 * Provides:
 * - Inventory tracking (what artifacts are created)
 * - Classification (creation vs execution context)
 * - Provenance logging (audit trail)
 * - Capability gating (approval for high-risk actions)
 * 
 * Modes:
 * - observe: Log everything, block nothing
 * - soft: Warn on violations, block nothing
 * - hard: Enforce gates, block high-risk actions without approval
 * 
 * Design: Additive, fail-safe, non-breaking
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

class FrontierGate {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Enable/disable - Environment variable overrides config
    this.enabled = process.env.FRONTIER_ENABLED === 'true' ? true :
                   process.env.FRONTIER_ENABLED === 'false' ? false :
                   (config.frontier?.enabled ?? false);
    
    // Mode: observe | soft | hard - Environment variable overrides config
    this.mode = process.env.FRONTIER_MODE || config.frontier?.mode || 'observe';
    
    // Output directory
    this.outputDir = config.frontier?.outputDir || 
                     path.join(config.logsDir || './logs', 'governance');
    
    // Event buffer (batch writes for performance)
    this.eventBuffer = [];
    this.inventoryBuffer = [];
    this.maxBufferSize = 100;
    
    // Stats
    this.stats = {
      eventsLogged: 0,
      actionsClassified: 0,
      actionsBlocked: 0,
      actionsWarned: 0,
      errors: 0
    };
    
    // Capability policies (from config or defaults)
    this.policies = config.frontier?.policies || {
      bashExecute: 'observe',
      codeExecute: 'observe',
      fileWrite: 'observe',
      configLoad: 'observe'
    };
    
    this.initialized = false;
  }
  
  /**
   * Initialize frontier (create directories)
   */
  async initialize() {
    if (!this.enabled) return;
    
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
      await fs.mkdir(path.join(this.outputDir, 'inventory'), { recursive: true });
      await fs.mkdir(path.join(this.outputDir, 'events'), { recursive: true });
      await fs.mkdir(path.join(this.outputDir, 'provenance'), { recursive: true });
      
      this.initialized = true;
      this.logger.info('🛡️  FrontierGate initialized', {
        mode: this.mode,
        outputDir: this.outputDir
      });
    } catch (error) {
      // Fail-safe: if init fails, disable frontier
      this.logger.error('FrontierGate initialization failed (disabling)', error);
      this.enabled = false;
    }
  }
  
  /**
   * Classify a file artifact (created output)
   */
  classifyArtifact(filePath, size = 0) {
    const ext = path.extname(filePath).toLowerCase();
    const pathLower = filePath.toLowerCase();
    
    let role, category, creationRisk, executionRisk;
    let capabilitiesCreate, capabilitiesExecute;
    
    // Code files
    if (ext === '.py') {
      role = 'code';
      category = 'python_script';
      creationRisk = 'medium';
      executionRisk = 'high';
      capabilitiesCreate = ['file_write', 'code_creation'];
      capabilitiesExecute = ['code_execute', 'python'];
    } else if (ext === '.sh') {
      role = 'code';
      category = 'shell_script';
      creationRisk = 'medium';
      executionRisk = 'high';
      capabilitiesCreate = ['file_write', 'code_creation'];
      capabilitiesExecute = ['bash_execute', 'shell'];
    } else if (ext === '.js') {
      role = 'code';
      category = 'javascript';
      creationRisk = 'medium';
      executionRisk = 'high';
      capabilitiesCreate = ['file_write', 'code_creation'];
      capabilitiesExecute = ['code_execute', 'node'];
    }
    // Config files
    else if (['.yaml', '.yml', '.toml', '.ini'].includes(ext)) {
      role = 'config';
      category = 'configuration';
      creationRisk = 'low';
      executionRisk = 'medium';
      capabilitiesCreate = ['file_write', 'config_creation'];
      capabilitiesExecute = ['config_load'];
    }
    // Data files
    else if (ext === '.json') {
      role = 'data';
      category = 'structured_data';
      creationRisk = 'low';
      executionRisk = 'low';
      capabilitiesCreate = ['file_write'];
      capabilitiesExecute = ['read'];
    } else if (ext === '.txt' || ext === '.md') {
      role = 'document';
      category = ext === '.md' ? 'markdown' : 'text';
      creationRisk = 'low';
      executionRisk = 'low';
      capabilitiesCreate = ['file_write'];
      capabilitiesExecute = ['read'];
    }
    // Default
    else {
      role = 'other';
      category = 'unknown';
      creationRisk = 'low';
      executionRisk = 'low';
      capabilitiesCreate = ['file_write'];
      capabilitiesExecute = ['read'];
    }
    
    // Determine source
    let source = 'other';
    if (pathLower.includes('/outputs/')) source = 'agent_output';
    else if (pathLower.includes('/scripts/')) source = 'infrastructure';
    else if (pathLower.includes('/_debug/')) source = 'debug';
    
    return {
      path: filePath,
      role,
      category,
      context: 'creation',
      creationRisk,
      executionRisk,
      source,
      capabilities: {
        creation: capabilitiesCreate,
        execution: capabilitiesExecute
      },
      size,
      requiresApprovalForCreation: creationRisk === 'high',
      requiresApprovalForExecution: executionRisk === 'high'
    };
  }
  
  /**
   * Classify a runtime action (what agent wants to execute)
   */
  classifyRuntimeAction(actionName, args = {}) {
    let riskLevel, category, capabilities, requiresApproval, reason;
    
    switch (actionName) {
      case 'bash_execute':
        riskLevel = 'high';
        category = 'shell_execution';
        capabilities = ['bash_execute', 'shell'];
        requiresApproval = true;
        reason = 'Shell execution can modify system state';
        break;
        
      case 'file_write':
        const filePath = args.path || '';
        const ext = path.extname(filePath).toLowerCase();
        
        if (['.py', '.sh', '.js'].includes(ext)) {
          riskLevel = 'medium';
          category = 'code_creation';
          capabilities = ['file_write', 'code_creation'];
          requiresApproval = false;
          reason = 'Creating code file as artifact (not executing)';
        } else {
          riskLevel = 'low';
          category = 'file_creation';
          capabilities = ['file_write'];
          requiresApproval = false;
          reason = 'Creating data/document file';
        }
        break;
        
      case 'file_read':
        riskLevel = 'low';
        category = 'file_read';
        capabilities = ['file_read'];
        requiresApproval = false;
        reason = 'Read-only operation';
        break;
        
      default:
        riskLevel = 'medium';
        category = 'other_action';
        capabilities = [actionName];
        requiresApproval = false;
        reason = 'Unknown action type';
    }
    
    this.stats.actionsClassified++;
    
    return {
      action: actionName,
      args,
      context: 'execution',
      riskLevel,
      category,
      capabilities,
      requiresApproval,
      reason
    };
  }
  
  /**
   * Check if an action is allowed (main enforcement point)
   */
  async checkAction(actionName, args = {}, intentToken = null) {
    if (!this.enabled) return { allowed: true };
    
    try {
      const classification = this.classifyRuntimeAction(actionName, args);
      
      // Always log
      await this.logEvent('action_classified', {
        classification,
        timestamp: new Date().toISOString()
      });
      
      // Check if requires approval
      if (classification.requiresApproval) {
        const hasApproval = intentToken || process.env.FRONTIER_INTENT_TOKEN;
        
        if (!hasApproval) {
          // No approval token
          
          if (this.mode === 'hard') {
            // HARD MODE: Block
            this.stats.actionsBlocked++;
            this.logger.error('🚫 FrontierGate blocked action', {
              action: actionName,
              risk: classification.riskLevel,
              reason: classification.reason
            });
            
            return {
              allowed: false,
              blocked: true,
              classification,
              message: `Action '${actionName}' blocked by FrontierGate. ` +
                      `Risk: ${classification.riskLevel}. ` +
                      `Provide FRONTIER_INTENT_TOKEN or request approval.`
            };
          } else if (this.mode === 'soft') {
            // SOFT MODE: Warn but allow
            this.stats.actionsWarned++;
            this.logger.warn('⚠️  FrontierGate warning: high-risk action without approval', {
              action: actionName,
              risk: classification.riskLevel,
              reason: classification.reason
            });
          }
          // OBSERVE MODE: Just logged above, allow
        } else {
          // Has approval token
          this.logger.info('✅ FrontierGate approved action', {
            action: actionName,
            token: hasApproval.substring(0, 8) + '...'
          });
        }
      }
      
      return {
        allowed: true,
        classification
      };
      
    } catch (error) {
      // Fail-safe: on error, allow (but log)
      this.stats.errors++;
      this.logger.error('FrontierGate check failed (allowing)', error);
      return { allowed: true, error: error.message };
    }
  }
  
  /**
   * Record agent lifecycle event
   */
  async recordAgentEvent(eventType, agentId, data = {}) {
    if (!this.enabled) return;
    
    try {
      await this.logEvent(eventType, {
        agentId,
        timestamp: new Date().toISOString(),
        ...data
      });
    } catch (error) {
      // Fail-safe: don't throw
      this.logger.error('Failed to record agent event', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Record file creation
   */
  async recordFileCreation(filePath, agentId, size = 0) {
    if (!this.enabled) return;
    
    try {
      const classification = this.classifyArtifact(filePath, size);
      
      this.inventoryBuffer.push({
        ...classification,
        agentId,
        timestamp: new Date().toISOString()
      });
      
      // Flush if buffer full
      if (this.inventoryBuffer.length >= this.maxBufferSize) {
        await this.flushInventory();
      }
    } catch (error) {
      this.logger.error('Failed to record file creation', error);
      this.stats.errors++;
    }
  }

  /**
   * Record an action outcome (used by Capabilities)
   * This is intentionally fail-safe and schema-flexible: we store whatever context is provided.
   *
   * Expected shape (best-effort):
   * {
   *   action: string,
   *   args: object,
   *   success: boolean,
   *   agent: string,
   *   agentType?: string,
   *   goalId?: string,
   *   taskId?: string,
   *   timestamp?: number|ISO string
   * }
   */
  async recordOutcome(outcome = {}) {
    if (!this.enabled) return;

    try {
      const actionName = outcome.action || outcome.type || 'unknown_action';
      const args = outcome.args || {};

      // Log action outcome event
      await this.logEvent('action_outcome', {
        ...outcome,
        action: actionName,
        args,
        timestamp: outcome.timestamp || new Date().toISOString()
      });

      // If the action likely created/modified a file, also record inventory entry (best-effort)
      if (actionName === 'file_write' || actionName === 'append_file' || actionName === 'replace_text') {
        const filePath = args.file_path || args.path || args.file || null;
        if (filePath) {
          // size is optional; if provided as content length, use it
          const sizeGuess = typeof args.content === 'string'
            ? args.content.length
            : (typeof args.text === 'string' ? args.text.length : 0);
          await this.recordFileCreation(filePath, outcome.agent || outcome.agentId || 'unknown', sizeGuess);
        }
      }
    } catch (error) {
      // Fail-safe: do not throw
      this.logger.error('Failed to record action outcome', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Log an event (buffered)
   */
  async logEvent(eventType, data) {
    if (!this.enabled) return;
    
    this.eventBuffer.push({
      eventType,
      data,
      timestamp: new Date().toISOString()
    });
    
    this.stats.eventsLogged++;
    
    // Flush if buffer full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      await this.flushEvents();
    }
  }
  
  /**
   * Flush event buffer to disk
   */
  async flushEvents() {
    if (!this.enabled || this.eventBuffer.length === 0) return;
    
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const eventFile = path.join(
        this.outputDir,
        'events',
        `events-${timestamp}.jsonl`
      );
      
      const lines = this.eventBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(eventFile, lines);
      
      this.eventBuffer = [];
    } catch (error) {
      this.logger.error('Failed to flush events', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Flush inventory buffer to disk
   */
  async flushInventory() {
    if (!this.enabled || this.inventoryBuffer.length === 0) return;
    
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const inventoryFile = path.join(
        this.outputDir,
        'inventory',
        `inventory-${timestamp}.json`
      );
      
      await fs.writeFile(
        inventoryFile,
        JSON.stringify(this.inventoryBuffer, null, 2)
      );
      
      this.inventoryBuffer = [];
    } catch (error) {
      this.logger.error('Failed to flush inventory', error);
      this.stats.errors++;
    }
  }
  
  /**
   * Generate provenance report (called at end of agent run)
   */
  async generateProvenance(agentId, agentData = {}) {
    if (!this.enabled) return;
    
    try {
      // Flush any pending buffers
      await this.flushEvents();
      await this.flushInventory();
      
      // Compute tree hash from inventory
      const inventoryHash = this.inventoryBuffer.length > 0
        ? this.hashArray(this.inventoryBuffer)
        : 'no_inventory';
      
      const provenance = {
        agentId,
        timestamp: new Date().toISOString(),
        mode: this.mode,
        stats: { ...this.stats },
        inventoryHash,
        agentData
      };
      
      const provenanceFile = path.join(
        this.outputDir,
        'provenance',
        `${agentId}.json`
      );
      
      await fs.writeFile(
        provenanceFile,
        JSON.stringify(provenance, null, 2)
      );
      
      return provenance;
      
    } catch (error) {
      this.logger.error('Failed to generate provenance', error);
      this.stats.errors++;
      return null;
    }
  }
  
  /**
   * Hash an array of objects for provenance
   */
  hashArray(arr) {
    const hash = crypto.createHash('sha256');
    const sorted = arr.map(item => JSON.stringify(item)).sort();
    hash.update(sorted.join(''));
    return hash.digest('hex');
  }
  
  /**
   * Get current stats
   */
  getStats() {
    return { ...this.stats, mode: this.mode, enabled: this.enabled };
  }
  
  /**
   * Cleanup (flush buffers)
   */
  async cleanup() {
    if (!this.enabled) return;
    
    try {
      await this.flushEvents();
      await this.flushInventory();
    } catch (error) {
      this.logger.error('FrontierGate cleanup failed', error);
    }
  }
}

module.exports = { FrontierGate };

