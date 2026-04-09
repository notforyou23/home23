const { BaseAgent } = require('./base-agent');
const { LocalExecutor } = require('./execution/local-executor');
const { COSMO_TOOLS } = require('./execution/cosmo-tools');
const { buildAutonomySystemPrompt } = require('./execution/autonomy-prompt');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * ExperimentalAgent - Local OS autonomy agent
 * 
 * Uses GPT-5.2 for planning and COSMO's LocalExecutor for actual execution
 * Enables real autonomous experimentation on the local OS
 * 
 * Safety:
 * - User approval required (by default)
 * - Hard time and action limits
 * - Sandboxed execution
 * - Full audit trail
 */
class ExperimentalAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    
    const exp = config.experimental || {};
    
    // Hard ceilings (cannot be exceeded via config)
    const HARD_MAX_TIME = 900;    // 15 minutes
    const HARD_MAX_ACTIONS = 200; // 200 actions
    
    // Limits with hard ceilings
    this.maxTime = Math.min(exp.limits?.time_sec || 600, HARD_MAX_TIME);
    this.maxActions = Math.min(exp.limits?.actions || 50, HARD_MAX_ACTIONS);
    this.allowedDomains = exp.network?.allow || ['localhost'];
    this.requireApproval = exp.approval?.required !== false;
    
    this.allowedDirs = [
      path.resolve('runtime/outputs'),
      path.resolve('runtime/exports'),
      '/tmp'
    ];
    
    this.executor = null;
    this.approved = false;
  }
  
  async onStart() {
    await super.onStart();
    
    // Cleanup stale approval files
    await this.cleanupStaleApprovals();
    
    // Request approval if required
    if (this.requireApproval) {
      this.approved = await this.requestApproval();
      if (!this.approved) {
        throw new Error('Experimental execution not approved');
      }
    }
    
    // Initialize local executor
    this.executor = new LocalExecutor(this.config, this.logger);
    await this.executor.initialize();
    
    // Store capability provenance in memory
    await this.storeCapabilityProvenance();
  }
  
  async execute() {
    this.logger.info('🚀 ExperimentalAgent starting mission', {
      mission: this.mission.description,
      maxTime: this.maxTime,
      maxActions: this.maxActions
    });
    
    await this.reportProgress(5, 'Initializing local autonomy');
    
    // Build system prompt
    const systemPrompt = buildAutonomySystemPrompt({
      missionDescription: this.mission.description,
      maxActions: this.maxActions,
      maxTimeSec: this.maxTime,
      allowedDirs: this.allowedDirs,
      allowedDomains: this.allowedDomains
    });
    
    // Initialize conversation with system prompt and first user message
    const messages = [
      {
        role: 'user',
        content: 'Begin the experiment. Plan your approach first, then use tools to execute.'
      }
    ];
    
    const startTime = Date.now();
    let iterations = 0;
    const maxIterations = 40;
    let totalToolCalls = 0;
    
    while (iterations < maxIterations) {
      iterations++;
      
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > this.maxTime) {
        this.logger.warn('⏱️  Time limit reached', {
          elapsed,
          limit: this.maxTime
        });
        break;
      }
      
      await this.reportProgress(
        Math.min(90, 5 + (iterations / maxIterations) * 80),
        `Autonomy iteration ${iterations}`
      );
      
      // Call GPT-5.2 with tools
      const response = await this.gpt5.generate({
        instructions: systemPrompt,
        messages: messages,
        tools: COSMO_TOOLS,
        tool_choice: 'auto',
        maxTokens: 3000,
        reasoningEffort: 'medium'
      });
      
      // Extract text content from response
      const textContent = response.content || '';
      
      // Add assistant message to conversation
      messages.push({
        role: 'assistant',
        content: textContent
      });
      
      this.logger.info('GPT-5.2 response received', {
        iteration: iterations,
        contentLength: textContent.length,
        responseId: response.responseId
      });
      
      // Check for completion signal
      if (textContent.toLowerCase().includes('experiment complete')) {
        this.logger.info('✅ GPT-5.2 signaled experiment completion');
        break;
      }
      
      // Extract tool calls from response
      const toolCalls = this.extractToolCalls(response);
      
      if (toolCalls.length === 0) {
        this.logger.warn('No tool calls in response', {
          iteration: iterations,
          hasContent: textContent.length > 0
        });
        
        // If GPT-5.2 responded with text but no tools, continue conversation
        // It might be explaining its plan before acting
        if (textContent.length > 0) {
          continue;
        } else {
          // No content and no tools - end
          break;
        }
      }
      
      // Execute each tool call
      const toolResults = [];
      for (const call of toolCalls) {
        totalToolCalls++;
        
        const parsedArgs = this.safeParseArgs(call);
        
        this.logger.info('Executing tool call', {
          name: call.name,
          id: call.id
        });
        
        const result = await this.executor.execute({
          name: call.name,
          arguments: parsedArgs
        });
        
        toolResults.push({
          id: call.id,
          name: call.name,
          arguments: parsedArgs,
          result: result
        });
      }
      
      // Feed results back to GPT-5
      const toolResultMessage = {
        role: 'user',
        content: `Tool execution results:\n${JSON.stringify(toolResults, null, 2)}`
      };
      
      messages.push(toolResultMessage);
      
      // Log stats
      const stats = this.executor.getStats();
      this.logger.info('Execution stats', {
        iteration: iterations,
        totalToolCalls,
        actionCount: stats.actionCount,
        elapsedTime: Math.round(stats.elapsedTime),
        actionsRemaining: stats.actionsRemaining,
        timeRemaining: Math.round(stats.timeRemaining)
      });
    }
    
    await this.executor.cleanup();
    await this.reportProgress(100, 'Experimental execution complete');
    
    const finalStats = this.executor.getStats();
    
    return {
      success: true,
      iterations,
      totalToolCalls,
      actionCount: finalStats.actionCount,
      elapsedTime: finalStats.elapsedTime
    };
  }
  
  /**
   * Extract tool calls from GPT-5.2 response
   * Response format: response.output contains tool_use or function_call items
   */
  extractToolCalls(response) {
    // Check if response has the extractToolCalls output
    if (response.output && typeof this.gpt5.extractToolCalls === 'function') {
      return this.gpt5.extractToolCalls(response);
    }
    
    // Fallback: manual extraction
    if (!response.output) return [];
    
    const toolCalls = [];
    for (const item of response.output) {
      if (item.type === 'tool_use' || item.type === 'function_call') {
        toolCalls.push({
          id: item.id,
          name: item.name,
          arguments: item.arguments
        });
      }
    }
    
    return toolCalls;
  }
  
  /**
   * Safely parse tool call arguments
   */
  safeParseArgs(call) {
    if (!call.arguments) return {};
    if (typeof call.arguments === 'object') return call.arguments;
    
    try {
      return JSON.parse(call.arguments);
    } catch {
      this.logger.warn('Failed to parse tool arguments', {
        callId: call.id,
        name: call.name
      });
      return {};
    }
  }
  
  /**
   * Clean up stale approval files
   */
  async cleanupStaleApprovals() {
    const approvalDir = path.join(this.config.logsDir, '.pending_experiments');
    
    try {
      const files = await fs.readdir(approvalDir);
      const now = Date.now();
      const maxAge = 3600000; // 1 hour
      const agentSuffix = this.agentId.slice(-8);
      
      for (const file of files) {
        if (!file.startsWith('exp_')) continue;
        if (!file.includes(agentSuffix)) continue;
        
        const filePath = path.join(approvalDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            this.logger.debug('Cleaned stale approval file', { file });
          }
        } catch {}
      }
    } catch {
      // Directory doesn't exist yet, that's fine
    }
  }
  
  /**
   * Request user approval for experimental execution
   */
  async requestApproval() {
    const approvalDir = path.join(this.config.logsDir, '.pending_experiments');
    await fs.mkdir(approvalDir, { recursive: true });
    
    const nonce = crypto.randomUUID().slice(0, 8);
    const requestId = `exp_${Date.now()}_${this.agentId.slice(-8)}_${nonce}`;
    
    const requestFile = path.join(approvalDir, `${requestId}.json`);
    const approveFile = path.join(approvalDir, `${requestId}.approved`);
    const denyFile = path.join(approvalDir, `${requestId}.denied`);
    
    const timeoutSec = this.config.experimental?.approval?.timeout_sec || 60;
    const requestTimestamp = Date.now();
    const timeoutMs = timeoutSec * 1000;
    
    // Write approval request via Capabilities
    const requestData = JSON.stringify(
        {
          requestId,
          agentId: this.agentId,
          timestamp: new Date(requestTimestamp).toISOString(),
          expiresAt: new Date(requestTimestamp + timeoutMs).toISOString(),
          mission: this.mission.description,
          capabilities: {
            mouse: true,
            keyboard: true,
            bash: true,
            filesystem: true,
            macOS: process.platform === 'darwin'
          },
          limits: {
            maxTime: this.maxTime,
            maxActions: this.maxActions
          },
          approve: `touch ${approveFile}`,
          deny: `touch ${denyFile}`,
          timeout_sec: timeoutSec
        },
        null,
        2
      );
    
    if (this.capabilities) {
      await this.capabilities.writeFile(
        path.relative(process.cwd(), requestFile),
        requestData,
        { agentId: this.agentId, agentType: 'experimental', missionGoal: this.mission.goalId }
      );
    } else {
      await fs.writeFile(requestFile, requestData, 'utf-8');
    }
    
    this.logger.info('📋 Experimental approval requested', {
      requestId,
      approveCmd: `touch ${approveFile}`,
      timeout: timeoutSec
    });
    
    // Wait for approval/denial
    for (let i = 0; i < timeoutSec; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check for approval
      try {
        const files = await fs.readdir(approvalDir);
        const exactApprovalMatch = files.find(f => f === `${requestId}.approved`);
        
        if (exactApprovalMatch) {
          const approvalPath = path.join(approvalDir, exactApprovalMatch);
          const stat = await fs.stat(approvalPath);
          
          // Check if approval is stale
          if (Date.now() - stat.mtimeMs > timeoutMs) {
            this.logger.warn('Stale approval rejected', { requestId });
            await fs.unlink(approvalPath).catch(() => {});
            await fs.unlink(requestFile).catch(() => {});
            return false;
          }
          
          this.logger.info('✅ Experimental execution approved', { requestId });
          await fs.unlink(requestFile).catch(() => {});
          await fs.unlink(approvalPath).catch(() => {});
          return true;
        }
      } catch {}
      
      // Check for denial
      try {
        const files = await fs.readdir(approvalDir);
        const exactDenyMatch = files.find(f => f === `${requestId}.denied`);
        
        if (exactDenyMatch) {
          this.logger.warn('❌ Experimental execution denied', { requestId });
          await fs.unlink(requestFile).catch(() => {});
          await fs.unlink(path.join(approvalDir, exactDenyMatch)).catch(() => {});
          return false;
        }
      } catch {}
    }
    
    // Timeout - auto-deny
    this.logger.warn('⏱️  Experimental approval timeout', { requestId });
    await fs.unlink(requestFile).catch(() => {});
    return false;
  }
  
  /**
   * Store capability provenance in memory
   */
  async storeCapabilityProvenance() {
    const capability = {
      model: 'gpt-5.2',
      limits: {
        time_sec: this.maxTime,
        actions: this.maxActions
      },
      network: {
        allow: this.allowedDomains.slice().sort().join(',')
      },
      filesystem: this.allowedDirs
    };
    
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(capability))
      .digest('hex')
      .slice(0, 16);
    
    await this.addInsight(
      `Experimental execution environment initialized:\n` +
        `Model: gpt-5.2\n` +
        `Time limit: ${this.maxTime}s\n` +
        `Action limit: ${this.maxActions}\n` +
        `Allowed dirs: ${this.allowedDirs.join(', ')}\n` +
        `Allowed domains: ${this.allowedDomains.join(', ')}\n` +
        `Config hash: ${hash}`,
      {
        tags: ['experimental_provenance', 'capability_map'],
        metadata: { 
          capability, 
          hash, 
          provenanceRoot: true 
        }
      }
    );
  }
  
  async cleanup() {
    if (this.executor) {
      await this.executor.cleanup();
    }
  }
}

module.exports = { ExperimentalAgent };

