/**
 * IDEAgent - Codebase modification specialist
 * 
 * Purpose:
 * - Modify existing code files (edit, create, delete)
 * - Integrate artifacts from other agents (CodeCreation)
 * - Fix bugs and implement features
 * - Refactor and restructure code
 * 
 * Safety Features:
 * - Workspace scope enforcement
 * - Path traversal prevention
 * - Operation limits (files, bytes, time)
 * - Dangerous command blocking
 * - Full audit trail
 * 
 * MCP Integration:
 * - Uses checkExistingKnowledge() for prior work
 * - Uses getStrategicContext() for priorities
 * - Uses checkAgentOverlap() to avoid duplication
 * - Uses injectTopicToQueue() for error reporting
 */

const { BaseAgent } = require('./base-agent');
const { PathSecurityError, LimitExceededError, CommandBlockedError } = require('./ide-errors');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

class IDEAgent extends BaseAgent {
  constructor(mission, config, logger) {
    super(mission, config, logger);
    
    // Workspace configuration with safety boundaries
    this.workspaceConfig = {
      root: null,  // Set in onStart after pathResolver is injected
      allowedPaths: config.ide?.allowedPaths || [],
      deniedPaths: config.ide?.deniedPaths || [
        '.git',
        'node_modules',
        '.env',
        '*.pem',
        '*.key',
        'secrets/',
        '.credentials'
      ],
      maxReadSize: config.ide?.maxReadSize || 5 * 1024 * 1024,
      maxWriteSize: config.ide?.maxWriteSize || 1 * 1024 * 1024,
      maxFilesModified: config.ide?.maxFilesModified || 50,
      maxTotalWriteSize: config.ide?.maxTotalWriteSize || 10 * 1024 * 1024
    };
    
    // Execution limits
    this.maxIterations = config.ide?.maxIterations || 25;
    this.maxToolCalls = config.ide?.maxToolCalls || 150;
    this.terminalTimeout = config.ide?.terminalTimeout || 60000;
    
    // State tracking
    this.modifiedFiles = [];
    this.totalBytesWritten = 0;
    this.operationLog = [];
    
    // Audit log
    this.auditLog = {
      agentId: this.agentId,
      missionId: mission.goalId,
      startedAt: null,
      completedAt: null,
      workspace: null,
      operations: [],
      errors: [],
      summary: null
    };
    
    // Blocked terminal patterns
    this.blockedPatterns = [
      /rm\s+-rf?\s+[\/~]/,
      />\s*\/dev\//,
      /curl.*\|.*sh/,
      /wget.*\|.*sh/,
      /sudo\s+/,
      /chmod\s+777/,
      /mkfs\./,
      /:(){.*};:/
    ];
  }

  /**
   * Resolve workspace root with priority order
   */
  resolveWorkspaceRoot() {
    if (this.mission.metadata?.workspaceRoot) {
      return this.mission.metadata.workspaceRoot;
    }
    if (this.config.ide?.workspaceRoot) {
      return this.config.ide.workspaceRoot;
    }
    if (this.pathResolver) {
      return this.pathResolver.getRuntimeRoot();
    }
    if (this.config.logsDir) {
      return this.config.logsDir;
    }
    throw new Error('Cannot determine workspace root - no valid source');
  }

  /**
   * Initialize agent resources
   */
  async onStart() {
    await super.onStart();
    
    // Resolve workspace after pathResolver is injected
    this.workspaceConfig.root = this.resolveWorkspaceRoot();
    
    // Validate workspace exists
    try {
      const stat = await fs.stat(this.workspaceConfig.root);
      if (!stat.isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${this.workspaceConfig.root}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Workspace root does not exist: ${this.workspaceConfig.root}`);
      }
      throw error;
    }
    
    // Initialize audit
    this.auditLog.startedAt = new Date().toISOString();
    this.auditLog.workspace = this.workspaceConfig.root;
    
    // Set output directory
    // P5: Use shared phase workspace if provided for coordination
    if (this.mission.metadata?.coordinationContext?.sharedWorkspace) {
      this.outputDir = this.mission.metadata.coordinationContext.sharedWorkspace;
      this.logger.info('📁 Using shared phase workspace for collaboration', { 
        dir: this.outputDir,
        phase: this.mission.metadata.coordinationContext.phaseTitle || 'unknown'
      });
    } else if (this.pathResolver) {
      this.outputDir = path.join(this.pathResolver.getOutputsRoot(), 'ide', this.agentId);
    } else if (this.config.logsDir) {
      this.outputDir = path.join(this.config.logsDir, 'outputs', 'ide', this.agentId);
    } else {
      throw new Error('Cannot determine output directory - no pathResolver or config.logsDir');
    }
    await fs.mkdir(this.outputDir, { recursive: true });
    
    this.logger.info('🖥️ IDEAgent initialized', {
      agentId: this.agentId,
      workspace: this.workspaceConfig.root,
      outputDir: this.outputDir
    });
    
    await this.reportProgress(5, 'Initialized workspace and tools');
  }

  /**
   * Main execution logic
   */
  async execute() {
    this.logger.info('🖥️ IDEAgent: Starting mission', {
      agentId: this.agentId,
      goal: this.mission.goalId,
      description: this.mission.description
    });

    // ═══════════════════════════════════════════════════════════════════════
    // COSMO HANDS: Check for pre-planned actions (bypass LLM loop)
    // When MetaCoordinator has already determined exact steps, execute directly
    // ═══════════════════════════════════════════════════════════════════════
    if (this.mission.metadata?.prePlannedActions && 
        Array.isArray(this.mission.metadata.prePlannedActions) &&
        this.mission.metadata.prePlannedActions.length > 0) {
      return await this.executePrePlannedActions(this.mission.metadata.prePlannedActions);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: CONTEXT GATHERING (MCP + Memory + Artifacts)
    // ═══════════════════════════════════════════════════════════════════════
    
    await this.reportProgress(10, 'Gathering context from MCP and memory');
    
    // 1a. Check MCP for existing knowledge (inherited from BaseAgent)
    let existingKnowledge = null;
    try {
      existingKnowledge = await this.checkExistingKnowledge(this.mission.description, 3);
      if (existingKnowledge?.hasKnowledge) {
        this.logger.info('📚 Found existing knowledge on topic', {
          relevantNodes: existingKnowledge.relevantNodes
        });
      }
    } catch (e) {
      this.logger.debug('MCP knowledge check unavailable', { error: e.message });
    }
    
    // 1b. Get strategic context from coordinator
    let strategicContext = null;
    try {
      strategicContext = await this.getStrategicContext();
    } catch (e) {
      this.logger.debug('Strategic context unavailable', { error: e.message });
    }
    
    // 1c. Check for overlapping agent work
    let agentOverlap = null;
    try {
      agentOverlap = await this.checkAgentOverlap();
      if (agentOverlap?.hasOverlap) {
        this.logger.warn('⚠️ Potential agent overlap detected', {
          overlappingAgents: agentOverlap.overlappingAgents
        });
      }
    } catch (e) {
      this.logger.debug('Agent overlap check unavailable', { error: e.message });
    }
    
    // 1d. Get current operating mode
    let operatingMode = null;
    try {
      operatingMode = await this.getCurrentSystemMode();  // FIX: was getCurrentOperatingMode (phantom)
    } catch (e) {
      this.logger.debug('Operating mode check unavailable', { error: e.message });
    }
    
    // 1e. Query memory for relevant context
    let priorContext = [];
    if (this.memory) {
      try {
        priorContext = await this.memory.query(this.mission.description, 50);
      } catch (e) {
        this.logger.warn('Memory query failed', { error: e.message });
      }
    }
    
    // 1f. Discover files from other agents
    let agentArtifacts = [];
    try {
      agentArtifacts = await this.discoverFiles({
        tags: ['code', 'implementation'],
        goalId: this.mission.goalId
      });
    } catch (e) {
      this.logger.warn('Artifact discovery failed', { error: e.message });
    }
    
    // Build context prompt with all gathered information
    const contextPrompt = this.buildContextPrompt(
      priorContext, 
      agentArtifacts,
      existingKnowledge,
      strategicContext,
      operatingMode
    );

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: INITIALIZE CONVERSATION
    // ═══════════════════════════════════════════════════════════════════════
    
    const messages = [
      { role: 'system', content: this.buildSystemPrompt() },
      { role: 'user', content: contextPrompt }
    ];

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: AGENTIC LOOP
    // ═══════════════════════════════════════════════════════════════════════
    
    let iteration = 0;
    let toolCallCount = 0;
    let consecutiveNoProgress = 0;
    const MAX_NO_PROGRESS = 3;
    
    while (iteration < this.maxIterations && toolCallCount < this.maxToolCalls) {
      const progressPct = Math.min(85, 15 + (iteration / this.maxIterations) * 70);
      await this.reportProgress(progressPct, `Iteration ${iteration + 1}`);
      
      // LLM call
      let response;
      try {
        response = await this.gpt5.createCompletion({
          messages: this.trimMessages(messages),
          tools: this.getToolDefinitions(),
          model: this.config.ide?.model || this.config.models?.primary
        });
      } catch (llmError) {
        this.logger.error('LLM call failed', { error: llmError.message });
        throw llmError;
      }
      
      const assistantMsg = response.choices?.[0]?.message;
      if (!assistantMsg) {
        throw new Error('No response from LLM');
      }
      messages.push(assistantMsg);
      
      // Check for completion
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        this.logger.info('✅ IDEAgent concluded', { 
          iteration, 
          toolCallCount,
          conclusion: assistantMsg.content || 'Task completed'
        });
        break;
      }
      
      // Execute tool calls
      let madeProgress = false;
      
      for (const toolCall of assistantMsg.tool_calls) {
        toolCallCount++;
        const result = await this.executeToolCallSafe(toolCall);
        
        if (this.isWriteOperation(toolCall.function.name)) {
          madeProgress = true;
        }
        
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
      
      // Stuck detection
      if (!madeProgress) {
        consecutiveNoProgress++;
        if (consecutiveNoProgress >= MAX_NO_PROGRESS) {
          this.logger.warn('Agent appears stuck - no write operations', { consecutiveNoProgress });
          messages.push({
            role: 'user',
            content: 'You seem to be reading without making changes. Please either make the necessary edits or explain why you cannot proceed.'
          });
          consecutiveNoProgress = 0;
        }
      } else {
        consecutiveNoProgress = 0;
      }
      
      iteration++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: FINALIZATION
    // ═══════════════════════════════════════════════════════════════════════
    
    await this.reportProgress(90, 'Finalizing and writing summary');
    
    // Generate and write summary
    const summary = this.generateChangeSummary();
    await this.writeSummaryFile(summary);
    
    // Write operation log
    await this.writeOperationLog();
    
    // Write completion marker
    await this.writeCompletionMarker(this.outputDir, {
      fileCount: this.modifiedFiles.length,
      iterations: iteration,
      toolCalls: toolCallCount
    });
    
    // Note: IDE completion status logged but not saved to memory (operational, not knowledge)
    
    return {
      status: 'completed',
      iterations: iteration,
      toolCalls: toolCallCount,
      modifiedFiles: this.modifiedFiles,
      summary: summary,
      // CRITICAL: Add metadata so assessAccomplishment() sees accomplishment
      metadata: {
        filesCreated: this.modifiedFiles.length,
        artifactsCreated: this.modifiedFiles.length,
        bytesWritten: this.totalBytesWritten
      }
    };
  }

  /**
   * Build system prompt for the LLM
   * Uses the comprehensive template from templates/AGENT_SYSTEM_PROMPT.md
   */
  buildSystemPrompt() {
    const context = this.config?.context || '';

    // IDE-specific behavioral prompt — the "motor cortex" identity and execution discipline
    const ideBehavioralPrompt = `## Role: IDE Agent — COSMO's Motor Cortex

You are the hands that build, the eyes that read, the voice that documents.
When you act, COSMO acts through you.

## Mission
${this.mission.description}

## Success Criteria
${(this.mission.successCriteria || ['Complete the specified task']).map((c, i) => `${i + 1}. ${c}`).join('\n')}
${context ? `\nContext: ${context}` : ''}

## Core Directives

### 1. Explore → Understand → Act
NEVER assume. ALWAYS explore first.
\`\`\`
Bad: "Based on typical project structures..."
Good: list_directory(".") → read_file("README.md") → "I explored and found..."
\`\`\`

### 2. Surgical Edits Over Rewrites
- Small change → \`search_replace\` or \`edit_file_range\`
- New file → \`create_file\`
- Complete rewrite → \`edit_file\` (last resort only)

### 3. Evidence-Based Work
Show what you explored. Cite files. Verify changes. Document reasoning.

### 4. Respect the Architecture
Check what exists (\`list_directory\`, \`codebase_search\`) before creating. Build on prior work.

## Toolbox
**Read (START HERE):** read_file, list_directory, grep_search, codebase_search
**Modify:** edit_file_range, search_replace, insert_lines, delete_lines
**Create:** create_file, delete_file
**Execute:** run_terminal (sandboxed to workspace)

## SOP: Read → Explore → Understand → Plan → Act → Verify → Complete

## Safety
- Workspace: ${this.workspaceConfig.root}
- No: .git, node_modules, .env, *.pem, *.key, secrets/, .credentials
- Prefer small, targeted edits

You have full authority. Complete the task fully.`;

    return this.buildCOSMOSystemPrompt(ideBehavioralPrompt);
  }

  /**
   * Build context prompt from MCP, memory and artifacts
   */
  buildContextPrompt(priorContext, agentArtifacts, existingKnowledge, strategicContext, operatingMode) {
    let prompt = `## Mission\n${this.mission.description}\n\n`;
    const researchDigest = this.mission.metadata?.researchDigest || null;
    const explicitArtifactInputs = Array.isArray(this.mission.metadata?.artifactInputs)
      ? this.mission.metadata.artifactInputs
      : [];
    const handoffContext = this.mission.metadata?.handoffContext || this.mission.spawningContext?.parentContext || null;
    
    // Include operating mode guidance - FIX (Jan 21, 2026): Made less restrictive
    // Previous "prioritize concrete deliverables" language was kneecapping output
    if (operatingMode) {
      prompt += `## Current System Mode: ${operatingMode}\n`;
      if (operatingMode === 'focus') {
        prompt += `(System is in focused mode - go deep, produce comprehensive analysis)\n\n`;
      } else if (operatingMode === 'explore') {
        prompt += `(System is exploring - consider broader implications, create rich documentation)\n\n`;
      } else if (operatingMode === 'execute') {
        prompt += `(System is in execution mode - produce thorough, well-documented deliverables)\n\n`;
      }
    }
    
    // Include strategic context from coordinator
    // FIX (Jan 21, 2026): Increased slice limits - was too restrictive
    if (strategicContext?.priorities) {
      prompt += `## Strategic Priorities\n`;
      for (const p of strategicContext.priorities.slice(0, 10)) {
        prompt += `- ${p}\n`;
      }
      prompt += '\n';
    }

    // Include existing knowledge summary
    if (existingKnowledge?.hasKnowledge) {
      prompt += `## Existing System Knowledge\n`;
      prompt += `The system already has ${existingKnowledge.relevantNodes} relevant nodes on this topic.\n`;
      if (existingKnowledge.topMatches?.length > 0) {
        prompt += `Key prior findings:\n`;
        for (const match of existingKnowledge.topMatches.slice(0, 10)) {
          prompt += `- ${match.content?.substring(0, 200) || match.label || 'Related work'}\n`;
        }
      }
      prompt += `Build on and extend existing knowledge.\n\n`;
    }

    // Include memory context
    if (priorContext && priorContext.length > 0) {
      prompt += `## Relevant Context from Memory\n`;
      for (const ctx of priorContext.slice(0, 15)) {
        prompt += `- ${ctx.content?.substring(0, 300) || ctx.label || 'Unknown'}\n`;
      }
      prompt += '\n';
    }

    // Include artifacts from other agents
    if (agentArtifacts && agentArtifacts.length > 0) {
      prompt += `## Artifacts from Other Agents (Available for Integration)\n`;
      for (const artifact of agentArtifacts.slice(0, 20)) {
        prompt += `- ${this.formatArtifactReferenceForPrompt(artifact)}\n`;
      }
      prompt += '\n';
    }

    if (explicitArtifactInputs.length > 0) {
      prompt += `## Explicit Handoff Artifacts\n`;
      for (const artifact of explicitArtifactInputs.slice(0, 20)) {
        prompt += `- ${this.formatArtifactReferenceForPrompt(artifact)}\n`;
      }
      prompt += '\n';
    }

    if (researchDigest) {
      prompt += `## Research Digest\n`;

      if (Array.isArray(researchDigest.topFindings) && researchDigest.topFindings.length > 0) {
        prompt += `Top findings:\n`;
        for (const finding of researchDigest.topFindings.slice(0, 10)) {
          prompt += `- ${finding}\n`;
        }
      }

      if (Array.isArray(researchDigest.completedMissions) && researchDigest.completedMissions.length > 0) {
        prompt += `Completed mission summaries:\n`;
        for (const summary of researchDigest.completedMissions.slice(0, 8)) {
          prompt += `- ${summary}\n`;
        }
      }

      if (Array.isArray(researchDigest.priorityGaps) && researchDigest.priorityGaps.length > 0) {
        prompt += `Priority gaps to address:\n`;
        for (const gap of researchDigest.priorityGaps.slice(0, 8)) {
          prompt += `- ${gap}\n`;
        }
      }

      if (Array.isArray(researchDigest.artifactRefs) && researchDigest.artifactRefs.length > 0) {
        prompt += `Available artifact refs:\n`;
        for (const ref of researchDigest.artifactRefs.slice(0, 12)) {
          prompt += `- ${this.formatArtifactReferenceForPrompt(ref)}\n`;
        }
      }

      if (Array.isArray(researchDigest.processedSourceUrls) && researchDigest.processedSourceUrls.length > 0) {
        prompt += `Already-processed source URLs:\n`;
        for (const url of researchDigest.processedSourceUrls.slice(0, 12)) {
          prompt += `- ${url}\n`;
        }
      }

      prompt += 'Advance the existing research thread without repeating completed work.\n\n';
    }

    if (handoffContext?.topFindings || handoffContext?.artifactRefs || handoffContext?.sourceUrls) {
      prompt += `## Structured Handoff Context\n`;

      if (handoffContext.summary) {
        prompt += `Summary: ${handoffContext.summary}\n`;
      }

      if (Array.isArray(handoffContext.topFindings)) {
        for (const finding of handoffContext.topFindings.slice(0, 5)) {
          prompt += `- ${finding}\n`;
        }
      }

      if (Array.isArray(handoffContext.artifactRefs) && handoffContext.artifactRefs.length > 0) {
        prompt += `Artifact refs:\n`;
        for (const ref of handoffContext.artifactRefs.slice(0, 10)) {
          prompt += `- ${this.formatArtifactReferenceForPrompt(ref)}\n`;
        }
      }

      if (Array.isArray(handoffContext.sourceUrls) && handoffContext.sourceUrls.length > 0) {
        prompt += `Source URLs:\n`;
        for (const url of handoffContext.sourceUrls.slice(0, 10)) {
          prompt += `- ${url}\n`;
        }
      }

      prompt += '\n';
    }

    // FIX (Jan 21, 2026): Made instructions more encouraging of comprehensive output
    prompt += `## Instructions
Produce comprehensive, thorough work on this mission. Create all relevant documentation, code, analysis, and artifacts.
- Write detailed reports and findings
- Create well-structured output files
- Document your analysis thoroughly
- Don't be minimal - be comprehensive
Build on existing knowledge where relevant.`;
    
    return prompt;
  }

  formatArtifactReferenceForPrompt(ref) {
    const candidates = [
      ref?.workspacePath,
      ref?.relativePath,
      ref?.path,
      ref?.absolutePath
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalized = String(candidate).replace(/\\/g, '/');
      const outputsIndex = normalized.lastIndexOf('/outputs/');
      if (outputsIndex >= 0) {
        return normalized.slice(outputsIndex + 1);
      }
      if (normalized.startsWith('@outputs/')) {
        return normalized.slice(1);
      }
      if (normalized.startsWith('outputs/')) {
        return normalized;
      }
      if (/^(research|ide|code|document|analysis|synthesis|quality|completion)\//.test(normalized)) {
        return `outputs/${normalized}`;
      }
    }

    return ref?.label || 'artifact';
  }

  /**
   * Get tool definitions for LLM
   */
  getToolDefinitions() {
    // CRITICAL: All parameters MUST have additionalProperties: false for strict mode
    return [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file contents',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path relative to workspace' }
            },
            required: ['file_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'List directory contents',
          parameters: {
            type: 'object',
            properties: {
              directory_path: { type: 'string', description: 'Path relative to workspace' }
            },
            required: ['directory_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'grep_search',
          description: 'Search for exact pattern in files',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Text or regex pattern' },
              path: { type: 'string', description: 'Path to search (use "." for workspace root)' }
            },
            required: ['pattern', 'path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'edit_file_range',
          description: 'Edit specific line range in a file (PREFERRED for targeted changes)',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to file' },
              start_line: { type: 'number', description: 'Starting line (1-based)' },
              end_line: { type: 'number', description: 'Ending line (1-based, inclusive)' },
              new_content: { type: 'string', description: 'New content for the range' }
            },
            required: ['file_path', 'start_line', 'end_line', 'new_content'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_replace',
          description: 'Find and replace text in a file',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to file' },
              old_text: { type: 'string', description: 'Text to find (must be unique)' },
              new_text: { type: 'string', description: 'Replacement text' }
            },
            required: ['file_path', 'old_text', 'new_text'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'create_file',
          description: 'Create a new file',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path for new file' },
              content: { type: 'string', description: 'File content' }
            },
            required: ['file_path', 'content'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'insert_lines',
          description: 'Insert lines at a position',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to file' },
              line_number: { type: 'number', description: 'Line to insert at (1-based)' },
              content: { type: 'string', description: 'Content to insert' }
            },
            required: ['file_path', 'line_number', 'content'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_lines',
          description: 'Delete a range of lines',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to file' },
              start_line: { type: 'number', description: 'Start line (1-based)' },
              end_line: { type: 'number', description: 'End line (1-based, inclusive)' }
            },
            required: ['file_path', 'start_line', 'end_line'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file (use carefully)',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path to file to delete' }
            },
            required: ['file_path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'run_terminal',
          description: 'Run a shell command (sandboxed to workspace)',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Command to run' }
            },
            required: ['command'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  /**
   * Execute tool call with safety checks
   */
  async executeToolCallSafe(toolCall) {
    const { name, arguments: argsJson } = toolCall.function;
    
    try {
      const args = JSON.parse(argsJson);
      
      // Log operation
      await this.logOperation({ type: name, args, timestamp: new Date().toISOString() });
      
      switch (name) {
        case 'read_file':
          return await this.toolReadFile(args.file_path);
        case 'list_directory':
          return await this.toolListDirectory(args.directory_path || '.');
        case 'grep_search':
          return await this.toolGrepSearch(args.pattern, args.path || '.');
        case 'edit_file_range':
          return await this.toolEditFileRange(args.file_path, args.start_line, args.end_line, args.new_content);
        case 'search_replace':
          return await this.toolSearchReplace(args.file_path, args.old_text, args.new_text);
        case 'create_file':
          return await this.toolCreateFile(args.file_path, args.content);
        case 'insert_lines':
          return await this.toolInsertLines(args.file_path, args.line_number, args.content);
        case 'delete_lines':
          return await this.toolDeleteLines(args.file_path, args.start_line, args.end_line);
        case 'delete_file':
          return await this.toolDeleteFile(args.file_path);
        case 'run_terminal':
          return await this.toolRunTerminal(args.command);
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      const errorInfo = {
        tool: name,
        error: error.message,
        type: error.constructor.name
      };
      this.auditLog.errors.push(errorInfo);
      this.logger.error('Tool execution error', errorInfo);
      
      return {
        error: error.message,
        suggestion: this.getSuggestionForError(error)
      };
    }
  }

  /**
   * Validate path is within workspace and not denied
   * 
   * ✅ FIX: Resolve @prefixes (@outputs/, @exports/, @coordinator/) using PathResolver
   * BEFORE validating against workspace root. This prevents ENOENT errors when
   * agents use logical prefixes that need to be resolved to actual paths.
   */
  validatePath(targetPath) {
    // ✅ FIX: Resolve logical prefixes FIRST if pathResolver available
    let pathToValidate = targetPath;
    
    if (this.pathResolver && typeof targetPath === 'string' && targetPath.startsWith('@')) {
      try {
        pathToValidate = this.pathResolver.resolve(targetPath);
        this.logger.debug('Resolved logical prefix', {
          original: targetPath,
          resolved: pathToValidate
        });
      } catch (error) {
        // If resolution fails, continue with original path
        // This handles cases where @ is used but not a valid prefix
        this.logger.debug('PathResolver.resolve() failed, using path as-is', {
          path: targetPath,
          error: error.message
        });
      }
    }
    
    const resolved = path.resolve(this.workspaceConfig.root, pathToValidate);
    
    // Must be within workspace
    if (!resolved.startsWith(this.workspaceConfig.root)) {
      throw new PathSecurityError(`Path escapes workspace: ${targetPath} (resolved: ${resolved})`);
    }
    
    // Check denied paths
    for (const denied of this.workspaceConfig.deniedPaths) {
      if (denied.includes('*')) {
        const regex = new RegExp(denied.replace(/\*/g, '.*'));
        if (regex.test(resolved)) {
          throw new PathSecurityError(`Path matches denied pattern: ${denied}`);
        }
      } else {
        if (resolved.includes(`/${denied}`) || resolved.includes(`\\${denied}`)) {
          throw new PathSecurityError(`Path in denied directory: ${denied}`);
        }
      }
    }
    
    return resolved;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════════

  async toolReadFile(filePath) {
    const resolved = this.validatePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');
    
    if (content.length > this.workspaceConfig.maxReadSize) {
      return {
        content: content.substring(0, this.workspaceConfig.maxReadSize),
        truncated: true,
        message: `File truncated (>${this.workspaceConfig.maxReadSize} bytes)`
      };
    }
    
    const lines = content.split('\n');
    return {
      content,
      lines: lines.length,
      path: resolved
    };
  }

  async toolListDirectory(dirPath) {
    const resolved = this.validatePath(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    
    const items = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.gitignore')
      .filter(e => e.name !== 'node_modules')
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file'
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    
    return { items, path: resolved, count: items.length };
  }

  async toolGrepSearch(pattern, searchPath) {
    const resolved = this.validatePath(searchPath);
    
    try {
      const escapedPattern = pattern.replace(/"/g, '\\"');
      let output;
      
      try {
        output = execSync(`rg "${escapedPattern}" "${resolved}" --max-count 50 --max-columns 200`, {
          encoding: 'utf8',
          maxBuffer: 5 * 1024 * 1024,
          timeout: 30000
        });
      } catch {
        output = execSync(`grep -r "${escapedPattern}" "${resolved}" | head -100`, {
          encoding: 'utf8',
          maxBuffer: 5 * 1024 * 1024,
          timeout: 30000
        });
      }
      
      return { matches: output, count: (output.match(/\n/g) || []).length };
    } catch (err) {
      if (err.status === 1) {
        return { matches: '', count: 0, message: 'No matches found' };
      }
      throw err;
    }
  }

  async toolEditFileRange(filePath, startLine, endLine, newContent) {
    const resolved = this.validatePath(filePath);
    
    // Read current content
    const content = await fs.readFile(resolved, 'utf8');
    const lines = content.split('\n');
    
    // Validate range
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return { error: `Invalid range: ${startLine}-${endLine} (file has ${lines.length} lines)` };
    }
    
    // Apply edit
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const newLines = newContent.split('\n');
    const editedContent = [...before, ...newLines, ...after].join('\n');
    
    // Write with guards
    await this.writeFileWithGuards(resolved, editedContent);
    
    return {
      success: true,
      message: `Edited lines ${startLine}-${endLine}`,
      linesReplaced: endLine - startLine + 1,
      newLineCount: newLines.length
    };
  }

  async toolSearchReplace(filePath, oldText, newText) {
    const resolved = this.validatePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');
    
    const escapedOld = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (content.match(new RegExp(escapedOld, 'g')) || []).length;
    
    if (count === 0) {
      return { error: 'Text not found in file' };
    }
    if (count > 1) {
      return { error: `Text found ${count} times - add more context to make it unique` };
    }
    
    const editedContent = content.replace(oldText, newText);
    await this.writeFileWithGuards(resolved, editedContent);
    
    return { success: true, message: 'Replacement made' };
  }

  async toolCreateFile(filePath, content) {
    const resolved = this.validatePath(filePath);
    
    // Check if exists
    try {
      await fs.access(resolved);
      return { error: 'File already exists. Use edit tools to modify.' };
    } catch {
      // File doesn't exist, good to create
    }
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    
    // Write with guards
    await this.writeFileWithGuards(resolved, content);
    
    return { success: true, path: resolved };
  }

  async toolInsertLines(filePath, lineNumber, content) {
    const resolved = this.validatePath(filePath);
    const fileContent = await fs.readFile(resolved, 'utf8');
    const lines = fileContent.split('\n');
    
    if (lineNumber < 1 || lineNumber > lines.length + 1) {
      return { error: `Invalid line number: ${lineNumber} (file has ${lines.length} lines)` };
    }
    
    const newLines = content.split('\n');
    lines.splice(lineNumber - 1, 0, ...newLines);
    
    await this.writeFileWithGuards(resolved, lines.join('\n'));
    
    return { success: true, message: `Inserted ${newLines.length} lines at line ${lineNumber}` };
  }

  async toolDeleteLines(filePath, startLine, endLine) {
    const resolved = this.validatePath(filePath);
    const content = await fs.readFile(resolved, 'utf8');
    const lines = content.split('\n');
    
    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return { error: `Invalid range: ${startLine}-${endLine}` };
    }
    
    lines.splice(startLine - 1, endLine - startLine + 1);
    await this.writeFileWithGuards(resolved, lines.join('\n'));
    
    return { success: true, message: `Deleted lines ${startLine}-${endLine}` };
  }

  async toolDeleteFile(filePath) {
    const resolved = this.validatePath(filePath);
    
    try {
      await fs.unlink(resolved);
      this.logger.info('File deleted', { path: resolved });
      return { success: true, message: `Deleted ${filePath}` };
    } catch (err) {
      return { error: `Failed to delete: ${err.message}` };
    }
  }

  async toolRunTerminal(command) {
    // Check blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(command)) {
        throw new CommandBlockedError(`Command blocked by security policy`);
      }
    }
    
    // Execute within workspace
    try {
      const output = execSync(command, {
        cwd: this.workspaceConfig.root,
        encoding: 'utf8',
        timeout: this.terminalTimeout,
        maxBuffer: 5 * 1024 * 1024
      });
      return { output, exitCode: 0 };
    } catch (err) {
      return {
        output: err.stdout || err.stderr || err.message,
        exitCode: err.status || 1,
        error: err.message
      };
    }
  }

  /**
   * Write file with all safety guards
   */
  async writeFileWithGuards(resolvedPath, content) {
    // Guard: File count
    if (!this.modifiedFiles.includes(resolvedPath)) {
      if (this.modifiedFiles.length >= this.workspaceConfig.maxFilesModified) {
        throw new LimitExceededError(`Max files modified (${this.workspaceConfig.maxFilesModified}) reached`);
      }
    }
    
    // Guard: Size
    const size = Buffer.byteLength(content, 'utf8');
    if (size > this.workspaceConfig.maxWriteSize) {
      throw new LimitExceededError(`Content exceeds max size (${this.workspaceConfig.maxWriteSize} bytes)`);
    }
    
    // Guard: Total bytes
    if (this.totalBytesWritten + size > this.workspaceConfig.maxTotalWriteSize) {
      throw new LimitExceededError(`Total write limit would be exceeded`);
    }
    
    // Write file
    await fs.writeFile(resolvedPath, content, 'utf8');
    
    // Update tracking
    if (!this.modifiedFiles.includes(resolvedPath)) {
      this.modifiedFiles.push(resolvedPath);
    }
    this.totalBytesWritten += size;
    
    // Log file modification
    this.logger.info('File modified', { path: resolvedPath, size });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════

  isWriteOperation(toolName) {
    return ['edit_file_range', 'search_replace', 'create_file', 'insert_lines', 'delete_lines', 'delete_file'].includes(toolName);
  }

  getSuggestionForError(error) {
    if (error instanceof PathSecurityError) {
      return 'Path is outside workspace or denied. Check allowed paths.';
    }
    if (error instanceof LimitExceededError) {
      return 'Operation limit reached. Complete current changes first.';
    }
    if (error instanceof CommandBlockedError) {
      return 'Command blocked for safety. Try a different approach.';
    }
    if (error.code === 'ENOENT') {
      return 'File not found. Check the path.';
    }
    return 'Review and retry.';
  }

  trimMessages(messages) {
    // Simple token management - keep last N messages
    const MAX_MESSAGES = 50;
    if (messages.length > MAX_MESSAGES) {
      // Keep system message + recent messages
      return [messages[0], ...messages.slice(-MAX_MESSAGES + 1)];
    }
    return messages;
  }

  async logOperation(op) {
    this.operationLog.push(op);
    this.auditLog.operations.push({ seq: this.auditLog.operations.length + 1, ...op });
  }

  generateChangeSummary() {
    return {
      filesModified: this.modifiedFiles,
      totalBytesWritten: this.totalBytesWritten,
      operationCount: this.operationLog.length,
      errorCount: this.auditLog.errors.length
    };
  }

  async writeSummaryFile(summary) {
    const summaryPath = path.join(this.outputDir, 'summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  }

  async writeOperationLog() {
    const logPath = path.join(this.outputDir, 'operations.jsonl');
    const lines = this.operationLog.map(op => JSON.stringify(op)).join('\n');
    await fs.writeFile(logPath, lines);
  }

  async onComplete() {
    this.auditLog.completedAt = new Date().toISOString();
    this.auditLog.summary = this.generateChangeSummary();
    
    // Write audit log
    const auditPath = path.join(this.outputDir, 'audit-log.json');
    await fs.writeFile(auditPath, JSON.stringify(this.auditLog, null, 2));
    
    this.logger.info('✅ Audit complete', this.auditLog.summary);
    
    // Report significant findings via MCP for coordinator attention
    if (this.auditLog.errors.length > 0) {
      try {
        await this.injectFollowUpTopic(  // FIX: was injectTopicToQueue (phantom)
          `IDEAgent ${this.agentId} encountered ${this.auditLog.errors.length} errors during implementation`,
          'high',  // FIX: use string priority not numeric
          JSON.stringify({ agentId: this.agentId, errors: this.auditLog.errors })
        );
      } catch (e) {
        this.logger.debug('MCP topic injection unavailable', { error: e.message });
      }
    }
    
    // Report successful significant changes
    if (this.modifiedFiles.length >= 5) {
      try {
        await this.injectFollowUpTopic(  // FIX: was injectTopicToQueue (phantom)
          `IDEAgent ${this.agentId} completed significant implementation: ${this.modifiedFiles.length} files modified`,
          'medium',  // FIX: use string priority not numeric
          JSON.stringify({ agentId: this.agentId, filesModified: this.modifiedFiles })
        );
      } catch (e) {
        this.logger.debug('MCP topic injection unavailable', { error: e.message });
      }
    }
    
    this.logger.info('✅ IDEAgent completed', {
      agentId: this.agentId,
      filesModified: this.modifiedFiles.length,
      operations: this.operationLog.length
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COSMO HANDS: Pre-Planned Actions Mode
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute pre-planned actions without LLM loop
   * 
   * Used when MetaCoordinator has already determined the exact steps needed.
   * This bypasses the full agentic loop for speed when actions are known.
   * 
   * @param {Array} actions - Array of { tool, args, critical? }
   * @returns {Object} - Execution results
   */
  async executePrePlannedActions(actions) {
    this.logger.info('🖥️ IDEAgent: Executing pre-planned actions (COSMO Hands mode)', {
      agentId: this.agentId,
      actionCount: actions.length
    });
    
    await this.reportProgress(10, 'Starting pre-planned action execution');
    
    const results = [];
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const progress = 10 + Math.floor((i / actions.length) * 80);
      
      await this.reportProgress(progress, `Executing ${action.tool} (${i + 1}/${actions.length})`);
      
      this.logger.info(`🔧 Pre-planned action: ${action.tool}`, {
        index: i + 1,
        total: actions.length,
        args: Object.keys(action.args || {})
      });
      
      try {
        // Build tool call in expected format
        const toolCall = {
          id: `preplanned_${this.agentId}_${Date.now()}_${i}`,
          function: {
            name: action.tool,
            arguments: JSON.stringify(action.args || {})
          }
        };
        
        const result = await this.executeToolCallSafe(toolCall);
        
        const success = !result.error;
        results.push({
          action: action.tool,
          success,
          result: result.content || result.error,
          duration: result.duration || null
        });
        
        if (success) {
          successCount++;
          this.logger.info(`   ✅ ${action.tool} succeeded`);
        } else {
          failCount++;
          this.logger.warn(`   ❌ ${action.tool} failed: ${result.error}`);
          
          // Stop on critical failure
          if (action.critical) {
            this.logger.error('Critical action failed, stopping execution', {
              action: action.tool,
              error: result.error
            });
            break;
          }
        }
        
      } catch (error) {
        failCount++;
        results.push({
          action: action.tool,
          success: false,
          error: error.message
        });
        
        this.logger.error('Pre-planned action threw exception', {
          action: action.tool,
          error: error.message
        });
        
        if (action.critical) {
          break;
        }
      }
    }
    
    await this.reportProgress(95, 'Finalizing pre-planned execution');
    
    // Note: Pre-planned execution status logged but not saved to memory (operational, not knowledge)
    
    this.logger.info('🖥️ IDEAgent: Pre-planned execution complete', {
      agentId: this.agentId,
      totalActions: actions.length,
      succeeded: successCount,
      failed: failCount,
      filesModified: this.modifiedFiles.length
    });
    
    return {
      status: failCount === 0 ? 'completed' : 'partial',
      mode: 'pre_planned',
      totalActions: actions.length,
      succeeded: successCount,
      failed: failCount,
      results,
      modifiedFiles: this.modifiedFiles,
      operationCount: this.operationLog.length,
      // CRITICAL: Add metadata for accomplishment tracking
      metadata: {
        filesCreated: this.modifiedFiles.length,
        artifactsCreated: this.modifiedFiles.length,
        actionsExecuted: successCount
      }
    };
  }
}

module.exports = { IDEAgent };
