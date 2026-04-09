const { UnifiedClient } = require('../core/unified-client');
const { classifyContent } = require('../core/validation');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

/**
 * BaseAgent - Foundation class for all specialist agents
 * 
 * Provides:
 * - Complete lifecycle management (initialize → running → completed/failed/timeout)
 * - Progress reporting with goal integration
 * - Memory network integration for findings
 * - Inter-agent messaging
 * - Timeout protection
 * - Event emission for tracking
 */
class BaseAgent extends EventEmitter {
  constructor(mission, config, logger) {
    super();
    this.mission = mission; // { goalId, description, successCriteria, tools, maxDuration }
    this.config = config;
    this.logger = logger;
    this.gpt5 = new UnifiedClient(config, logger);
    
    // Agent state
    this.agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.agentType = this.constructor.name.replace(/Agent$/, '').toLowerCase(); // Standard type key
    this.status = 'initialized'; // initialized → running → completed | failed | timeout
    this.startTime = null;
    this.endTime = null;
    this.results = [];
    this.progressReports = [];
    this.errors = [];
    
    // Shared resources (injected by AgentExecutor)
    this.memory = null;
    this.goals = null;
    this.messageQueue = null;
    this.mcp = null;  // NEW: MCP bridge for system introspection
    this.pathResolver = null; // NEW: PathResolver for deliverable paths
    this.frontierGate = null; // NEW: FrontierGate for governance tracking
    this.capabilities = null; // NEW: Capabilities for direct tool access (embodied cognition)

    // Memory quality gate stats
    this.memoryQualityStats = { passed: 0, filtered: 0 };

    // Template directory for COSMO context
    this._templatesDir = path.join(__dirname, '..', '..', '..', 'templates');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEMPLATE SYSTEM - Provides COSMO architecture context to all agents
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load a template file from the templates directory
   * @param {string} templateName - Name of the template file (e.g., 'AGENT_QUICK_START.md')
   * @returns {Promise<string|null>} Template content or null if not found
   */
  async loadTemplate(templateName) {
    try {
      const templatePath = path.join(this._templatesDir, templateName);
      const content = await fs.readFile(templatePath, 'utf8');
      return content;
    } catch (error) {
      this.logger?.debug?.(`Template ${templateName} not found`, { error: error.message });
      return null;
    }
  }

  /**
   * Populate a template with runtime values
   * Replaces {{PLACEHOLDER}} tokens with actual values
   * @param {string} template - Template content with placeholders
   * @returns {string} Populated template
   */
  populateTemplate(template) {
    if (!template) return '';
    
    const runId = this.config?.runId || this.config?.brainName || 'unknown';
    const domain = this.config?.domain || 'autonomous research';
    const context = this.config?.context || '';
    
    // Get runtime values
    const replacements = {
      '{{RUN_ID}}': runId,
      '{{AGENT_ID}}': this.agentId,
      '{{AGENT_TYPE}}': this.agentType,
      '{{DOMAIN}}': domain,
      '{{CONTEXT_DESCRIPTION}}': context,
      '{{EXECUTION_MODE}}': this.config?.executionMode || 'guided',
      '{{CURRENT_CYCLE}}': String(this.config?.currentCycle || 0),
      '{{MAX_CYCLES}}': String(this.config?.maxCycles || 100),
      '{{ACTIVE_GOALS_COUNT}}': String(this.goals?.getActiveGoals?.()?.length || 0),
      '{{COMPLETED_GOALS_COUNT}}': String(this.goals?.getCompletedGoals?.()?.length || 0),
      '{{SPAWNED_AGENTS_COUNT}}': String(this.config?.spawnedAgentsCount || 0),
      '{{TIMESTAMP}}': new Date().toISOString(),
      '{{WORKSPACE_ROOT}}': this.pathResolver?.runtimeRoot || this.config?.logsDir || process.cwd()
    };
    
    let populated = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
      populated = populated.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
    }
    
    return populated;
  }

  /**
   * Get comprehensive COSMO architecture context for this agent
   * Loads and populates relevant templates based on agent type and verbosity
   * @param {string} verbosity - 'quick' (5 min read) | 'standard' (15 min) | 'comprehensive' (45 min)
   * @returns {Promise<string>} COSMO context for system prompt
   */
  async getCOSMOContext(verbosity = 'quick') {
    const sections = [];
    
    // Always include core identity
    sections.push(`# COSMO Agent Context

You are a **${this.agentType}** agent within COSMO (Cognitive Orchestration System for Multi-agent Operations).

**Your Relationship to COSMO**: You are **part of COSMO**, not separate from it. When you explore and act, COSMO is exploring and acting through you. Your outputs feed back into memory consolidation, goal prioritization, strategic planning, and learning cycles.

**Run ID**: ${this.config?.runId || this.config?.brainName || 'unknown'}
**Agent ID**: ${this.agentId}
**Domain**: ${this.config?.domain || 'autonomous research'}
`);

    // Load appropriate template based on verbosity
    if (verbosity === 'quick') {
      const quickStart = await this.loadTemplate('AGENT_QUICK_START.md');
      if (quickStart) {
        // Extract key sections from quick start
        const coreSection = this.extractSection(quickStart, '## 🎯 Core Principles', '## 🛠️');
        const toolSection = this.extractSection(quickStart, '## 🛠️ Your Toolbox', '## 📋');
        const sopSection = this.extractSection(quickStart, '## 📋 Standard Operating Procedure', '## 🎓');
        
        if (coreSection) sections.push(coreSection);
        if (toolSection) sections.push(toolSection);
        if (sopSection) sections.push(sopSection);
      }
    } else if (verbosity === 'standard') {
      const systemPrompt = await this.loadTemplate('AGENT_SYSTEM_PROMPT.md');
      if (systemPrompt) {
        // Extract key sections from system prompt
        const directivesSection = this.extractSection(systemPrompt, '## Core Directives', '## Your Toolbox');
        const toolboxSection = this.extractSection(systemPrompt, '## Your Toolbox', '## Standard Operating');
        const rulesSection = this.extractSection(systemPrompt, '## Behavioral Rules', '## What NOT to Do');
        
        if (directivesSection) sections.push(directivesSection);
        if (toolboxSection) sections.push(toolboxSection);
        if (rulesSection) sections.push(rulesSection);
      }
    } else if (verbosity === 'comprehensive') {
      // Full architecture reference (use sparingly - very long)
      const archRef = await this.loadTemplate('COSMO_ARCHITECTURE_REFERENCE.md');
      if (archRef) {
        // Extract executive summary and key sections
        const execSummary = this.extractSection(archRef, '## Executive Summary', '## What is COSMO');
        const ideRole = this.extractSection(archRef, '## The IDE Agent Role', '## Cognitive Subsystems');
        
        if (execSummary) sections.push(execSummary);
        if (ideRole) sections.push(ideRole);
      }
    }
    
    // Always add dual directory structure reminder
    sections.push(`
## Key Architecture Points

**Dual Directory Structure**:
- \`/agents/\` = Agent METADATA (findings, insights via appendToJournal)
- \`/outputs/\` = Agent DELIVERABLES (actual files via @outputs/ prefix)

**Path Resolution**: Always use \`@outputs/\` prefix for deliverables - it resolves to the correct run-isolated directory.

**Hebbian Learning**: Your work creates memory connections - co-activated concepts strengthen over time.
`);

    // Populate all placeholders
    return this.populateTemplate(sections.join('\n\n'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // THREE-LAYER PROMPT ARCHITECTURE
  // Layer 1: Shared COSMO identity (this method)
  // Layer 2: Agent-specific behavioral prompt (passed as parameter)
  // Layer 3: Mission context (buildContextMessage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the system prompt using the three-layer architecture.
   *
   * Layer 1: Shared COSMO identity — who we are, behavioral contract, system architecture.
   * Layer 2: Agent-specific behavioral prompt — HOW this agent type works (not what it knows).
   *
   * Domain knowledge does NOT belong here. It goes in the user message via buildContextMessage().
   *
   * @param {string} agentBehavioralPrompt - Agent-specific behavioral specification (10-30 lines)
   * @returns {string} Combined system prompt
   */
  buildCOSMOSystemPrompt(agentBehavioralPrompt) {
    const runId = this.config?.runId || this.config?.brainName || 'unknown';
    const domain = this.config?.architecture?.roleSystem?.guidedFocus?.domain
      || this.config?.domain || 'autonomous research';
    const workspace = this.pathResolver?.getOutputsRoot?.()
      || this.config?.logsDir || 'runtime';

    const cosmoIdentity = `# COSMO Cognitive Agent

You are a specialized module within COSMO, a persistent cognitive architecture for
autonomous research and artifact generation. You are not a chatbot. You are an executor.

## Behavioral Contract
1. ACT, DON'T ADVISE. Produce artifacts — files, data, findings — not suggestions.
2. NEVER ASSUME. Explore first. Verify with tools before proceeding.
3. BUILD ON PRIOR WORK. Check memory before starting. Don't duplicate.
4. VERIFY RESULTS. After acting, confirm output exists and is correct.
5. STOP WHEN DONE. Don't pad. Don't summarize what you just did.

## System Architecture
- Persistent memory graph: your findings become nodes other agents can query
- Multi-agent coordination: other agents work in parallel on related tasks
- Coordinator oversight: strategic priorities are set above you — follow them
- Plan-driven execution: you are executing a specific task in a larger plan
- Hebbian learning: co-activated concepts strengthen connections over time

## Context
Run: ${runId} | Agent: ${this.agentId} (${this.agentType})
Domain: ${domain} | Workspace: ${workspace}`;

    return `${cosmoIdentity}\n\n${agentBehavioralPrompt}`;
  }

  /**
   * Gather pre-flight context before starting an agent's main work.
   * Assembles knowledge, strategic context, overlap detection, operating mode,
   * memory search results, and artifact references.
   *
   * All calls are fail-soft — agent proceeds with less context rather than failing.
   * Extracted from IDEAgent's 6-phase context gathering pattern.
   *
   * @returns {Promise<Object>} Pre-flight context object
   */
  async gatherPreFlightContext() {
    const TIMEOUT = 5000;
    const withTimeout = (promise, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), TIMEOUT))
      ]).catch(err => {
        this.logger.debug(`Pre-flight ${label} failed (non-fatal): ${err.message}`);
        return null;
      });

    const missionText = this.mission?.description || '';

    const [existingKnowledge, strategicContext, agentOverlap, operatingMode, priorContext, agentArtifacts] =
      await Promise.all([
        withTimeout(this.checkExistingKnowledge(missionText, 3), 'knowledge'),
        withTimeout(this.getStrategicContext(), 'strategic'),
        withTimeout(this.checkAgentOverlap(), 'overlap'),
        withTimeout(this.getCurrentSystemMode(), 'mode'),
        withTimeout(
          this.memory?.query?.(missionText, 50) || Promise.resolve(null),
          'memory'
        ),
        withTimeout(
          this.discoverFiles({ goalId: this.mission?.goalId }),
          'artifacts'
        )
      ]);

    return { existingKnowledge, strategicContext, agentOverlap, operatingMode, priorContext, agentArtifacts };
  }

  /**
   * Build the rich first user message from pre-flight context (Layer 3).
   * This is where domain knowledge and mission details go — NOT in the system prompt.
   *
   * @param {Object} preFlightData - Output from gatherPreFlightContext()
   * @param {Object} mission - Mission object with description, successCriteria, metadata
   * @param {string} [domainReference] - Optional compressed domain reference material
   * @returns {string} Assembled context message
   */
  buildContextMessage(preFlightData, mission, domainReference = null) {
    const parts = [];

    // Mission
    parts.push(`## Mission\n${mission.description || 'No mission description provided.'}`);

    // Success criteria
    if (mission.successCriteria?.length) {
      parts.push(`## Success Criteria\n${mission.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
    }

    // Source scope and expected output (promoted from metadata for visibility)
    if (mission.sourceScope || mission.metadata?.sourceScope) {
      parts.push(`## Source Scope\n${mission.sourceScope || mission.metadata.sourceScope}`);
    }
    if (mission.expectedOutput || mission.metadata?.expectedOutput) {
      parts.push(`## Expected Output\n${mission.expectedOutput || mission.metadata.expectedOutput}`);
    }

    // Artifact inputs from prior agents
    const artifactInputs = mission.artifactInputs || mission.metadata?.artifactInputs || [];
    if (artifactInputs.length > 0) {
      const refs = artifactInputs.map(a =>
        typeof a === 'string' ? `- ${a}` : `- ${a.path || a.ref} — ${a.label || ''}`
      ).join('\n');
      parts.push(`## Prior Artifacts (inputs from earlier agents)\n${refs}`);
    }

    // Pre-flight context sections
    if (preFlightData) {
      // Prior knowledge from memory
      const priorContext = preFlightData.priorContext;
      if (priorContext && Array.isArray(priorContext) && priorContext.length > 0) {
        const matches = priorContext
          .filter(n => n && (n.summary || n.concept))
          .slice(0, 10)
          .map(n => `- ${(n.summary || n.concept || '').substring(0, 200)}`);
        if (matches.length > 0) {
          parts.push(`## Prior Knowledge (from memory)\n${matches.join('\n')}`);
        }
      }

      // Strategic priorities from coordinator
      const strat = preFlightData.strategicContext;
      if (strat && Array.isArray(strat) && strat.length > 0) {
        const priorities = strat.slice(0, 10).map(p =>
          typeof p === 'string' ? `- ${p}` : `- ${p.description || p.directive || JSON.stringify(p)}`
        );
        parts.push(`## Strategic Priorities\n${priorities.join('\n')}`);
      }

      // Discovered artifacts from other agents
      const artifacts = preFlightData.agentArtifacts;
      if (artifacts && Array.isArray(artifacts) && artifacts.length > 0) {
        const refs = artifacts.slice(0, 20).map(a =>
          `- ${a.relativePath || a.filename} (${a.sourceAgentType || 'unknown'}, ${a.size || '?'}b)`
        );
        parts.push(`## Available Artifacts (from other agents)\n${refs.join('\n')}`);
      }

      // Operating mode guidance
      const mode = preFlightData.operatingMode;
      if (mode) {
        const modeStr = typeof mode === 'string' ? mode : mode.mode || mode.currentMode || '';
        if (modeStr) {
          parts.push(`## Operating Mode: ${modeStr}`);
        }
      }
    }

    // Domain reference (compressed, only relevant sections)
    if (domainReference && domainReference.trim().length > 0) {
      parts.push(`## Domain Reference\n${domainReference}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Extract a section from a markdown document
   * @param {string} content - Full document content
   * @param {string} startMarker - Section start (e.g., '## Section Name')
   * @param {string} endMarker - Section end marker (next section)
   * @returns {string|null} Extracted section or null
   */
  extractSection(content, startMarker, endMarker) {
    const startIdx = content.indexOf(startMarker);
    if (startIdx === -1) return null;
    
    const endIdx = endMarker ? content.indexOf(endMarker, startIdx + startMarker.length) : content.length;
    if (endIdx === -1) return content.substring(startIdx);
    
    return content.substring(startIdx, endIdx).trim();
  }

  /**
   * Lifecycle hooks - Override in subclasses
   */
  async onStart() {
    // Called before execute()
    this.logger.debug('Agent starting', { agentId: this.agentId }, 3);
  }

  async execute() {
    // MUST be implemented by subclasses
    throw new Error('Subclass must implement execute()');
  }

  async onComplete() {
    // Called after successful completion
    this.logger.debug('Agent completed', {
      agentId: this.agentId,
      memoryQuality: this.memoryQualityStats
    }, 3);
  }

  async onError(error) {
    // Called on execution error
    this.logger.error('Agent error', { 
      agentId: this.agentId, 
      error: error.message 
    }, 3);
  }

  async onTimeout() {
    // Called on timeout
    this.logger.warn('Agent timeout', { 
      agentId: this.agentId,
      duration: this.mission.maxDuration 
    }, 3);
  }

  /**
   * Main execution wrapper with lifecycle management
   */
  async run() {
    this.status = 'running';
    this.startTime = new Date();
    this.emit('start', { agentId: this.agentId, mission: this.mission }, 3);

    // FrontierGate: Record agent start (fail-safe)
    try {
      if (this.frontierGate) {
        await this.frontierGate.recordAgentEvent('agent_start', this.agentId, {
          mission: this.mission.description,
          type: this.constructor.name
        });
      }
    } catch (error) {
      this.logger.error('FrontierGate tracking failed (continuing)', error);
    }

    try {
      await this.onStart();
      
      // Race between execution and timeout
      const result = await Promise.race([
        this.execute(),
        this.timeoutPromise(this.mission.maxDuration || 300000) // Default 5 min
      ]);

      this.status = 'completed';
      this.endTime = new Date();
      
      await this.onComplete();
      this.emit('complete', { agentId: this.agentId, result }, 3);
      
      // FrontierGate: Record completion and generate provenance (fail-safe)
      try {
        if (this.frontierGate) {
          await this.frontierGate.recordAgentEvent('agent_complete', this.agentId, {
            status: 'completed',
            duration: this.endTime - this.startTime
          });
          await this.frontierGate.generateProvenance(this.agentId, {
            mission: this.mission.description,
            status: 'completed',
            results: result
          });
        }
      } catch (error) {
        this.logger.error('FrontierGate provenance failed (continuing)', error);
      }

      // CRITICAL FIX: Set status to completed for DoD contract validation
      // Without this, agentResult.status is still 'running', failing IDE agent DoD checks
      this.status = 'completed';

      return this.buildFinalResults(result);
      
    } catch (error) {
      if (error.message === 'AGENT_TIMEOUT') {
        this.status = 'timeout';
        await this.onTimeout();
        this.emit('timeout', { agentId: this.agentId }, 3);
      } else {
        this.status = 'failed';
        this.errors.push({ 
          error: error.message, 
          stack: error.stack,
          timestamp: new Date() 
        });
        await this.onError(error);
        this.emit('error', { agentId: this.agentId, error }, 3);
      }
      
      // FrontierGate: Record failure (fail-safe)
      try {
        if (this.frontierGate) {
          await this.frontierGate.recordAgentEvent('agent_failed', this.agentId, {
            status: this.status,
            error: error.message
          });
        }
      } catch (frontierError) {
        this.logger.error('FrontierGate error tracking failed', frontierError);
      }

      // Pass partial results even on failure so accomplishment tracking sees what was done
      const partialResult = {
        status: this.status,
        metadata: {
          filesCreated: this.modifiedFiles?.length || 0,
          artifactsCreated: this.modifiedFiles?.length || 0
        }
      };
      return this.buildFinalResults(partialResult);
    }
  }

  /**
   * Request graceful stop (for plan superseding, shutdown, etc.)
   * Agent saves checkpoint and returns partial results.
   * 
   * FIX P1.5: Added to support clean agent cleanup when plans are injected.
   * Prevents duplicate agents from old and new plans running simultaneously.
   * 
   * @param {string} reason - Why agent is being stopped
   * @returns {Promise<Object>} Partial results with checkpoint
   */
  async requestStop(reason = 'stop_requested') {
    this.logger.info('🛑 Graceful stop requested', {
      agentId: this.agentId,
      reason,
      currentProgress: this.progressReports[this.progressReports.length - 1]?.percent || 0,
      resultsCollected: this.results.length
    }, 2);
    
    // Save checkpoint before stopping (includes partial results)
    const checkpoint = await this.saveCheckpoint();
    
    // Mark as stopped (distinct from failed/timeout/completed)
    this.status = 'stopped';
    this.endTime = new Date();
    
    // Record stop reason in metadata
    if (!this.metadata) this.metadata = {};
    this.metadata.stopReason = reason;
    this.metadata.stoppedAt = this.endTime.toISOString();
    this.metadata.checkpointSaved = !!checkpoint;
    
    // Emit stop event (for registry cleanup)
    this.emit('stopped', { 
      agentId: this.agentId, 
      reason,
      checkpoint,
      partialResults: this.results.length
    });
    
    // Build and return partial results
    const partialResults = this.buildFinalResults({ 
      stopped: true, 
      reason,
      checkpointSaved: !!checkpoint
    });
    
    // Mark results as partial
    partialResults.partial = true;
    partialResults.stopReason = reason;
    
    this.logger.info('✅ Agent stopped gracefully', {
      agentId: this.agentId,
      checkpointSaved: !!checkpoint,
      partialResultsCount: this.results.length
    }, 2);
    
    return partialResults;
  }

  /**
   * Create timeout promise for race condition
   */
  timeoutPromise(ms) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AGENT_TIMEOUT')), ms)
    );
  }

  /**
   * Report progress - Updates goal and emits event
   * @param {number} percentComplete - 0-100
   * @param {string} message - Progress description
   */
  async reportProgress(percentComplete, message) {
    this.progressReports.push({
      percent: percentComplete,
      message,
      timestamp: new Date()
    });

    // Update goal progress (max 50% per agent to leave room for others)
    if (this.goals && this.mission.goalId) {
      const delta = (percentComplete / 100) * 0.5; 
      this.goals.updateGoalProgress(this.mission.goalId, delta, message);
    }

    this.emit('progress', { 
      agentId: this.agentId, 
      percent: percentComplete, 
      message 
    }, 3);

    this.logger.info('Agent progress', {
      agentId: this.agentId,
      percent: percentComplete,
      message: message.substring(0, 100)
    }, 3);
  }

  /**
   * Add finding to memory network
   * @param {string} finding - The finding to store
   * @param {string} tag - Memory tag (default: 'agent_finding')
   * @returns {Object|null} Memory node or null if no memory injected
   */
  async addFinding(finding, tag = 'agent_finding') {
    if (!this.memory) {
      this.logger.warn('No memory system injected, finding not stored');
      return null;
    }

    // Quality gate: classify content before expensive embedding
    const mqConfig = this.config?.coordinator?.memoryQuality;
    if (!mqConfig || mqConfig.enabled !== false) {
      const classification = classifyContent(finding, tag);
      if (classification.category === 'operational' || classification.category === 'error') {
        this.memoryQualityStats.filtered++;
        this.logger.debug('Finding filtered by quality gate', {
          agentId: this.agentId,
          tag,
          category: classification.category,
          reason: classification.reason,
          preview: finding.substring(0, 80)
        }, 3);
        this.results.push({
          type: 'finding',
          content: finding,
          nodeId: null,
          timestamp: new Date(),
          filteredByQualityGate: true,
          filterReason: classification.reason
        });
        return null;
      }
    }

    this.memoryQualityStats.passed++;
    const node = await this.memory.addNode(
      `[AGENT: ${this.agentId}] ${finding}`,
      tag
    );
    
    // Check if node creation failed (embedding too large or API error)
    if (!node) {
      this.logger.warn('Failed to create memory node (likely embedding too large)', {
        findingLength: finding.length,
        tag
      });
      // Still add to results even if memory storage failed
      this.results.push({
        type: 'finding',
        content: finding,
        nodeId: null,
        timestamp: new Date(),
        memoryStorageFailed: true
      });
      return null;
    }

    // Reinforce connections to related concepts
    const related = await this.memory.query(finding, 3);
    if (related.length > 0) {
      const relatedIds = related.map(n => n.id);
      this.memory.reinforceCooccurrence([node.id, ...relatedIds]);
    }

    this.results.push({
      type: 'finding',
      content: finding,
      nodeId: node.id,
      timestamp: new Date()
    });

    this.logger.debug('Finding added to memory', {
      agentId: this.agentId,
      nodeId: node.id,
      tag
    }, 3);

    // NEW: Append to incremental journal (non-blocking, crash-safe)
    this.appendToJournal({
      type: 'finding',
      nodeId: node.id,
      content: finding,
      tag,
      timestamp: new Date().toISOString()
    }).catch(err => {
      // Log but don't throw - journal failure shouldn't break agent execution
      this.logger.debug('Journal append failed (non-fatal)', {
        nodeId: node.id,
        error: err.message
      }, 4);
    });

    return node;
  }

  /**
   * Add insight to memory network
   * Insights are higher-level interpretations/conclusions vs findings (raw data)
   * @param {string} insight - The insight to store
   * @param {string} tag - Memory tag (default: 'agent_insight')
   * @returns {Object|null} Memory node or null if no memory injected
   */
  async addInsight(insight, tag = 'agent_insight') {
    if (!this.memory) {
      this.logger.warn('No memory system injected, insight not stored');
      return null;
    }

    // Quality gate: classify content before expensive embedding
    const mqConfig = this.config?.coordinator?.memoryQuality;
    if (!mqConfig || mqConfig.enabled !== false) {
      const classification = classifyContent(insight, tag);
      if (classification.category === 'operational') {
        this.memoryQualityStats.filtered++;
        this.logger.debug('Insight filtered by quality gate', {
          agentId: this.agentId,
          tag,
          category: classification.category,
          reason: classification.reason,
          preview: insight.substring(0, 80)
        }, 3);
        this.results.push({
          type: 'insight',
          content: insight,
          nodeId: null,
          timestamp: new Date(),
          filteredByQualityGate: true,
          filterReason: classification.reason
        });
        return null;
      }
    }

    this.memoryQualityStats.passed++;
    const node = await this.memory.addNode(
      `[AGENT INSIGHT: ${this.agentId}] ${insight}`,
      tag
    );
    
    // Check if node creation failed (embedding too large or API error)
    if (!node) {
      this.logger.warn('Failed to create insight node (likely embedding issue)', {
        insightLength: insight.length,
        tag
      });
      // Still add to results even if memory storage failed
      this.results.push({
        type: 'insight',
        content: insight,
        nodeId: null,
        timestamp: new Date(),
        memoryStorageFailed: true
      });
      return null;
    }

    // Reinforce connections to related concepts
    const related = await this.memory.query(insight, 3);
    if (related.length > 0) {
      const relatedIds = related.map(n => n.id);
      this.memory.reinforceCooccurrence([node.id, ...relatedIds]);
    }

    this.results.push({
      type: 'insight',
      content: insight,
      nodeId: node.id,
      timestamp: new Date()
    });

    this.logger.debug('Insight added to memory', {
      agentId: this.agentId,
      nodeId: node.id,
      tag
    }, 3);

    // NEW: Append to incremental journal (non-blocking, crash-safe)
    this.appendToJournal({
      type: 'insight',
      nodeId: node.id,
      content: insight,
      tag,
      timestamp: new Date().toISOString()
    }).catch(err => {
      this.logger.debug('Journal append failed (non-fatal)', {
        nodeId: node.id,
        error: err.message
      }, 4);
    });

    return node;
  }

  /**
   * Add execution result to memory network
   * Records outcomes of code/tool execution for capability tracking
   * @param {string} content - Description of the execution result
   * @param {boolean} success - Whether execution succeeded
   * @param {Object} metadata - Additional context (tool, duration, etc.)
   * @returns {Object|null} Memory node or null if no memory injected
   */
  async addExecutionResult(content, success, metadata = {}) {
    const tag = success ? 'execution_result' : 'execution_failure';
    const prefix = success ? '[EXECUTION RESULT]' : '[EXECUTION FAILURE]';

    const node = await this.addFinding(`${prefix} ${content}`, tag);

    // Record in execution results journal
    if (this.config?.logsDir) {
      try {
        await this.appendToJournal({
          type: tag,
          nodeId: node?.id || null,
          content,
          success,
          metadata,
          timestamp: new Date().toISOString()
        });
      } catch { /* journal append optional */ }
    }

    return node;
  }

  /**
   * Append entry to agent's incremental journal (crash-safe, non-blocking)
   * Enables real-time dashboard updates and crash recovery
   * @param {Object} entry - Journal entry {type, nodeId, content, tag, timestamp}
   */
  async appendToJournal(entry) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Use config.logsDir if available (points to actual run directory)
    // Fallback to process.cwd()/runtime for backwards compatibility
    const baseDir = this.config?.logsDir || path.join(process.cwd(), 'runtime');
    const journalDir = path.join(baseDir, 'agents', this.agentId);
    const journalPath = path.join(journalDir, `${entry.type}s.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    
    // DEBUG: Log journal path construction
    const debugJournal = {
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      'entry.type': entry.type,
      'config.logsDir': this.config?.logsDir,
      'process.cwd()': process.cwd(),
      baseDir,
      journalDir,
      journalPath,
      'journalPath is absolute': path.isAbsolute(journalPath)
    };
    try {
      require('fs').appendFileSync('/tmp/journal-path-debug.log', JSON.stringify(debugJournal, null, 2) + '\n---\n');
    } catch (e) {}
    
    // Prefer embodied path (Executive Ring + FrontierGate) when available
    if (this.capabilities && this.capabilities.appendFile) {
      try {
        // CRITICAL FIX: Pass absolute path directly - pathResolver handles absolute paths correctly
        // Previously used path.relative(process.cwd(), journalPath) which caused path doubling
        // when process.cwd() != runtimeRoot (multi-tenant mode)
        // This matches the fix in writeFileAtomic() at line 1696
        await this.capabilities.appendFile(
          journalPath,  // Use absolute path - same as writeFileAtomic fix
          line,
          {
            agentId: this.agentId,
            agentType: this.mission?.agentType || 'agent',
            missionGoal: this.mission?.goalId,
            // Link actions to plan tasks when available (canonical provenance join)
            taskId: this.mission?.taskId || this.mission?.metadata?.originalTaskId || null
          }
        );
        return;
      } catch (err) {
        // Fallback (journal is non-critical)
        this.logger.debug('Journal append via capabilities failed (fallback to fs)', {
          error: err.message
        }, 4);
      }
    }
    
    await fs.mkdir(journalDir, { recursive: true });
    await fs.appendFile(journalPath, line, 'utf8');
  }

  /**
   * Helper: Call GPT-5.2 with automatic retry on connection errors
   * Wraps gpt5.generateWithRetry for convenience
   * @param {Object} options - GPT-5.2 options
   * @param {number} maxRetries - Max retry attempts (default 3)
   * @returns {Promise<Object>} GPT-5.2 response
   */
  async callGPT5(options, maxRetries = 3) {
    // Check if in pure mode and adapt prompting
    const explorationMode = this.config?.architecture?.roleSystem?.explorationMode;
    
    if (explorationMode === 'pure' && options.instructions) {
      // PURE MODE: Strip instructions down to minimal label or empty
      // If caller provided instructionsPure, use it; otherwise minimize current instruction
      const pureInstructions = options.instructionsPure || this.minimizeInstruction(options.instructions);
      
      return await this.gpt5.generateWithRetry({
        ...options,
        instructions: pureInstructions,
        systemPrompt: options.systemPrompt || 'Generating...'
      }, maxRetries);
    }
    
    // NORMAL MODE: Use instructions as-is
    return await this.gpt5.generateWithRetry(options, maxRetries);
  }
  
  /**
   * Minimize instruction to bare essence for pure mode
   * Extracts key noun/verb from instruction
   */
  minimizeInstruction(instruction) {
    if (!instruction || instruction.length === 0) return '';
    
    // Extract first meaningful word from instruction
    const keywords = {
      'Generate': '',
      'Analyze': 'ANALYSIS:',
      'Research': 'RESEARCH:',
      'Synthesize': 'SYNTHESIS:',
      'Explore': 'EXPLORATION:',
      'Plan': 'PLAN:',
      'Execute': 'EXECUTION:',
      'Validate': 'VALIDATION:',
      'Review': 'REVIEW:',
      'Create': 'CREATION:',
      'Identify': 'IDENTIFICATION:'
    };
    
    for (const [verb, label] of Object.entries(keywords)) {
      if (instruction.includes(verb)) {
        return label;
      }
    }
    
    // Default: just use ellipsis
    return '...';
  }

  // ============================================================
  // FULL MEMORY NETWORK API - Leverage all capabilities
  // ============================================================

  /**
   * Explore memory connections using spreading activation
   * Discovers related concepts through network topology
   * @param {string} concept - Starting concept
   * @param {number} depth - How many hops to spread (default 2)
   * @returns {Promise<Array>} Activated nodes sorted by activation level
   */
  async exploreMemoryConnections(concept, depth = 2) {
    if (!this.memory) {
      this.logger.debug('No memory system available for exploration');
      return [];
    }

    // Find starting nodes
    const startNodes = await this.memory.query(concept, 3);
    if (startNodes.length === 0) {
      this.logger.debug('No starting nodes found for concept', { concept: concept.substring(0, 50) });
      return [];
    }

    // Spread activation from starting nodes
    const activated = new Map();
    for (const startNode of startNodes) {
      const nodeActivation = await this.memory.spreadActivation(startNode.id, depth);
      // Merge activations
      for (const [nodeId, level] of nodeActivation.entries()) {
        const current = activated.get(nodeId) || 0;
        activated.set(nodeId, Math.max(current, level));
      }
    }

    // Convert to array with node details
    const results = Array.from(activated.entries())
      .map(([id, activation]) => ({
        ...this.memory.nodes.get(id),
        activation
      }))
      .sort((a, b) => b.activation - a.activation)
      .slice(0, 20); // Top 20 most activated

    this.logger.debug('Memory connections explored', {
      concept: concept.substring(0, 50),
      startNodes: startNodes.length,
      activated: results.length,
      depth
    });

    return results;
  }

  /**
   * Get knowledge domain (cluster) containing a concept
   * Returns all nodes in the same cluster plus cluster metadata
   * @param {string} topic - Topic to find domain for
   * @returns {Promise<Object>} {clusterId, nodes, size}
   */
  async getKnowledgeDomain(topic) {
    if (!this.memory) {
      return { clusterId: null, nodes: [], size: 0 };
    }

    // Find node for topic
    const matches = await this.memory.query(topic, 1);
    if (matches.length === 0) {
      return { clusterId: null, nodes: [], size: 0 };
    }

    const node = matches[0];
    const clusterId = node.cluster;

    if (clusterId === null) {
      return { clusterId: null, nodes: [node], size: 1 };
    }

    // Get all nodes in this cluster
    const clusterNodes = [];
    for (const [id, n] of this.memory.nodes) {
      if (n.cluster === clusterId) {
        clusterNodes.push(n);
      }
    }

    this.logger.debug('Knowledge domain retrieved', {
      topic: topic.substring(0, 50),
      clusterId,
      size: clusterNodes.length
    });

    return {
      clusterId,
      nodes: clusterNodes,
      size: clusterNodes.length
    };
  }

  /**
   * Get all knowledge clusters
   * Returns map of clusterId -> nodes for understanding knowledge landscape
   * @returns {Promise<Map>} Map of clusterId -> array of nodes
   */
  async getKnowledgeClusters() {
    if (!this.memory) {
      return new Map();
    }

    const clusters = new Map();
    for (const [id, node] of this.memory.nodes) {
      if (node.cluster !== null) {
        if (!clusters.has(node.cluster)) {
          clusters.set(node.cluster, []);
        }
        clusters.get(node.cluster).push(node);
      }
    }

    this.logger.debug('Knowledge clusters retrieved', {
      clusterCount: clusters.size,
      totalNodes: this.memory.nodes.size
    });

    return clusters;
  }

  /**
   * Get recent insights by timeframe and optional tag
   * Uses temporal tracking to find fresh knowledge
   * @param {number} timeframeMs - Milliseconds back to look (default 1 hour)
   * @param {string} tag - Optional tag filter
   * @returns {Promise<Array>} Recent nodes sorted by access time
   */
  async getRecentInsights(timeframeMs = 3600000, tag = null) {
    if (!this.memory) {
      return [];
    }

    const cutoff = new Date(Date.now() - timeframeMs);
    const recent = [];

    for (const [id, node] of this.memory.nodes) {
      if (node.accessed >= cutoff) {
        if (!tag || node.tag === tag) {
          recent.push(node);
        }
      }
    }

    recent.sort((a, b) => b.accessed - a.accessed);

    this.logger.debug('Recent insights retrieved', {
      timeframeMs,
      tag: tag || 'all',
      found: recent.length
    });

    return recent;
  }

  /**
   * Get "hot" topics - frequently accessed nodes
   * Identifies what's currently important to the system
   * @param {number} topK - How many hot topics to return
   * @returns {Promise<Array>} Most accessed nodes
   */
  async getHotTopics(topK = 10) {
    if (!this.memory) {
      return [];
    }

    const nodes = Array.from(this.memory.nodes.values())
      .filter(n => n.accessCount > 0)
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, topK);

    this.logger.debug('Hot topics retrieved', {
      topK,
      found: nodes.length,
      topAccessCount: nodes[0]?.accessCount || 0
    });

    return nodes;
  }

  /**
   * Get edges by type (causal, temporal, associative, etc.)
   * Enables relationship-aware queries
   * @param {string} edgeType - Type of relationship
   * @returns {Array} Edges of specified type with node details
   */
  getEdgesByType(edgeType) {
    if (!this.memory) {
      return [];
    }

    const typedEdges = [];
    for (const [key, edge] of this.memory.edges) {
      if (edge.type === edgeType) {
        const [nodeA, nodeB] = key.split('->').map(Number);
        typedEdges.push({
          nodeA: this.memory.nodes.get(nodeA),
          nodeB: this.memory.nodes.get(nodeB),
          weight: edge.weight,
          type: edge.type,
          created: edge.created
        });
      }
    }

    return typedEdges;
  }

  /**
   * Traverse knowledge graph from starting point
   * Walks the graph following connections up to maxDepth
   * @param {string} startConcept - Starting concept
   * @param {string} edgeType - Optional edge type to follow (null = all)
   * @param {number} maxDepth - Maximum traversal depth
   * @returns {Promise<Array>} Traversed nodes with path information
   */
  async traverseKnowledgeGraph(startConcept, edgeType = null, maxDepth = 3) {
    if (!this.memory) {
      return [];
    }

    // Find starting node
    const startNodes = await this.memory.query(startConcept, 1);
    if (startNodes.length === 0) return [];

    const startId = startNodes[0].id;
    const visited = new Set();
    const traversed = [];
    const queue = [{ id: startId, depth: 0, path: [startId] }];

    while (queue.length > 0) {
      const { id, depth, path } = queue.shift();
      
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.memory.nodes.get(id);
      traversed.push({
        ...node,
        depth,
        path
      });

      // Get neighbors
      const neighbors = this.memory.getNeighbors(id);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          // Check edge type if specified
          if (edgeType) {
            const edge = this.memory.getEdge(id, neighborId);
            if (edge && edge.type === edgeType) {
              queue.push({
                id: neighborId,
                depth: depth + 1,
                path: [...path, neighborId]
              });
            }
          } else {
            queue.push({
              id: neighborId,
              depth: depth + 1,
              path: [...path, neighborId]
            });
          }
        }
      }
    }

    this.logger.debug('Knowledge graph traversed', {
      startConcept: startConcept.substring(0, 50),
      edgeType: edgeType || 'all',
      maxDepth,
      nodesTraversed: traversed.length
    });

    return traversed;
  }

  /**
   * Find patterns across recent agent activity
   * Aggregates insights from ALL agent types over timeframe
   * @param {Array<string>} filterTypes - Optional list of types to restrict to (null = all)
   * @param {number} timeframeMs - How far back to look
   * @returns {Promise<Object>} Aggregated insights by agent type
   */
  async aggregateAgentInsights(filterTypes = null, timeframeMs = 3600000) {
    if (!this.memory) {
      return {};
    }

    const cutoff = new Date(Date.now() - timeframeMs);
    const byType = new Map();

    // If explicit filters provided, initialize them
    if (filterTypes) {
      for (const t of filterTypes) {
        byType.set(t, []);
      }
    }

    for (const [id, node] of this.memory.nodes) {
      // Skip if too old or not an agent work product
      if (node.accessed < cutoff) continue;
      
      const isAgentProduct = node.concept.includes('[AGENT') || 
                            node.tag?.includes('finding') || 
                            node.tag?.includes('insight');
      
      if (!isAgentProduct) continue;

      // DISCOVERY: Extract agent type from concept or tag
      let detectedType = null;
      
      // Try concept pattern: [AGENT INSIGHT: agent_123_abc] or [AGENT: agent_123_abc]
      const conceptMatch = node.concept.match(/\[AGENT\s+(?:INSIGHT|FINDING):\s+agent_\d+_([a-z0-9]+)\]/i) ||
                          node.concept.match(/\[AGENT:\s+agent_\d+_([a-z0-9]+)\]/i);
      
      if (conceptMatch) {
        // Many agent IDs contain the type as the suffix (e.g. agent_timestamp_research)
        // This is a common pattern in our system
        detectedType = conceptMatch[1];
      }

      // Fallback: use the tag (e.g. 'research_finding' -> 'research')
      if (!detectedType && node.tag) {
        detectedType = node.tag.split('_')[0];
      }

      if (!detectedType) detectedType = 'unknown';

      // Apply filters if provided
      if (filterTypes && !filterTypes.includes(detectedType)) continue;

      if (!byType.has(detectedType)) {
        byType.set(detectedType, []);
      }
      byType.get(detectedType).push(node);
    }

    const summary = {};
    for (const [type, nodes] of byType.entries()) {
      summary[type] = {
        count: nodes.length,
        nodes: nodes.sort((a, b) => b.accessed - a.accessed)
      };
    }

    this.logger.debug('Agent insights aggregated', {
      typesFound: Object.keys(summary),
      timeframeMs,
      totalInsights: Object.values(summary).reduce((sum, type) => sum + type.count, 0)
    });

    return summary;
  }

  /**
   * Send message to another agent or coordinator
   * @param {string} to - Target agent ID or 'meta_coordinator' or 'ALL'
   * @param {string} type - Message type (HANDOFF, INSIGHT, RESOURCE_REQUEST, etc.)
   * @param {Object} payload - Message payload
   */
  async sendMessage(to, type, payload) {
    if (!this.messageQueue) {
      this.logger.warn('No message queue injected, message not sent');
      return;
    }

    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      from: this.agentId,
      to,
      type,
      payload,
      timestamp: new Date(),
      read: false
    };

    await this.messageQueue.push(message);
    this.emit('message_sent', message);

    this.logger.debug('Message sent', {
      from: this.agentId,
      to,
      type
    }, 3);
  }

  /**
   * Build final results package
   */
  buildFinalResults(executeResult = {}) {
    const duration = this.endTime 
      ? this.endTime.getTime() - this.startTime.getTime() 
      : null;

    // EXECUTIVE RING: Assess whether agent accomplished its mission (not just completed)
    // This is critical for honest failure signals and proper task validation
    const accomplishment = this.assessAccomplishment(executeResult, this.results);

    // CRITICAL FIX (Jan 21, 2026): Store accomplishment on agent instance
    // PlanExecutor queries agent.accomplishment via AgentRegistry to determine task completion
    // Without this, hasAccomplishedWork is always false and tasks never complete
    this.accomplishment = accomplishment;

    // Log accomplishment for debugging the plan execution chain
    this.logger.info(`[BaseAgent:${this.agentId}] Accomplishment assessed`, {
      agentType: this.constructor.name,
      taskId: this.mission?.taskId,
      accomplished: accomplishment.accomplished,
      reason: accomplishment.reason,
      metrics: accomplishment.metrics
    }, 2);

    // If agent completed but produced nothing useful, mark as unproductive
    if (!accomplishment.accomplished && this.status === 'completed') {
      this.logger.warn('⚠️ Agent completed but did not accomplish mission', {
        agentId: this.agentId,
        agentType: this.constructor.name,
        reason: accomplishment.reason,
        outputCount: this.results.length,
        metrics: accomplishment.metrics
      }, 2);
      
      // Set special status for executive ring to detect
      this.status = 'completed_unproductive';
    }

    return {
      agentId: this.agentId,
      agentType: this.constructor.name,
      mission: this.mission,
      status: this.status,
      accomplishment, // NEW: Executive ring uses this for validation
      startTime: this.startTime,
      endTime: this.endTime,
      duration,
      durationFormatted: duration ? `${(duration / 1000).toFixed(1)}s` : null,
      results: this.results,
      progressReports: this.progressReports,
      errors: this.errors,
      handoffSpec: this.generateHandoffSpec(), // For next agent
      
      // Preserve agent-specific data from execute() return value
      agentSpecificData: executeResult || {},
      
      // NEW: Include metadata for DoD contract validation
      metadata: executeResult.metadata || {}
    };
  }

  /**
   * EXECUTIVE RING: Assess whether agent accomplished its mission
   * Override in subclasses for domain-specific accomplishment checks
   * 
   * This provides honest failure signals - distinguishing "completed" from "accomplished work"
   * Critical for executive function reality checking and task validation
   * 
   * @param {Object} executeResult - Result from execute() method
   * @param {Array} results - Findings and insights collected
   * @returns {Object} - { accomplished: boolean, reason: string|null, metrics: object }
   */
  assessAccomplishment(executeResult, results) {
    // Base implementation: check for substantive output
    const hasFindings = results.filter(r => r.type === 'finding').length > 0;
    const hasInsights = results.filter(r => r.type === 'insight').length > 0;
    
    // Check execute result for domain-specific metrics
    const metadata = executeResult?.metadata || {};
    const hasArtifacts = metadata.documentsAnalyzed > 0 
                      || metadata.artifactsCreated > 0
                      || metadata.filesCreated > 0
                      || metadata.tasksCompleted > 0;
    
    const accomplished = hasFindings || hasInsights || hasArtifacts;
    
    return {
      accomplished,
      reason: accomplished ? null : 'No substantive output produced (0 findings, 0 insights, 0 artifacts)',
      metrics: {
        findings: results.filter(r => r.type === 'finding').length,
        insights: results.filter(r => r.type === 'insight').length,
        documentsAnalyzed: metadata.documentsAnalyzed || 0,
        artifactsCreated: metadata.artifactsCreated || 0,
        filesCreated: metadata.filesCreated || 0
      }
    };
  }

  /**
   * Generate handoff spec for next agent in chain
   * Override in subclasses if agent should hand off to another
   * @returns {Object|null} Handoff specification or null
   */
  generateHandoffSpec() {
    return null; // No handoff by default
  }

  /**
   * Get agent summary for logging/monitoring
   */
  getSummary() {
    return {
      agentId: this.agentId,
      type: this.constructor.name,
      status: this.status,
      goal: this.mission.goalId,
      startTime: this.startTime,
      resultsCount: this.results.length,
      progressReports: this.progressReports.length,
      errors: this.errors.length
    };
  }

  // ============================================================================
  // MCP TOOL ACCESS - System Introspection ("Measure Twice")
  // ============================================================================

  /**
   * Check if system already has knowledge on this topic
   * Uses MCP query_memory for keyword search
   * @param {string} topic - Topic to check
   * @param {number} threshold - Minimum results to consider "has knowledge"
   * @returns {Object} Knowledge check results
   */
  async checkExistingKnowledge(topic, threshold = 3) {
    if (!this.mcp) {
      return { hasKnowledge: false, reason: 'MCP not available' };
    }

    try {
      const memoryResults = await this.mcp.query_memory(topic, threshold);
      
      return {
        hasKnowledge: memoryResults.resultsFound >= threshold,
        relevantNodes: memoryResults.resultsFound,
        topMatches: memoryResults.results,
        recommendation: memoryResults.resultsFound >= threshold
          ? 'Substantial existing knowledge - consider refining or building on it'
          : 'Novel territory - proceed with research'
      };
    } catch (error) {
      // Graceful handling for fresh starts (no state file yet)
      if (error.message && error.message.includes('ENOENT')) {
        this.logger.debug('System state not found (fresh start)', { agentId: this.agentId });
        return { hasKnowledge: false, reason: 'Fresh start - no state yet' };
      }
      this.logger.warn('MCP knowledge check failed', { error: error.message });
      return { hasKnowledge: false, reason: 'Check failed' };
    }
  }

  /**
   * Get strategic context from meta-coordinator
   * @returns {Object} Strategic priorities and recommendations
   */
  async getStrategicContext() {
    if (!this.mcp) return null;

    try {
      return await this.mcp.getStrategicContext();
    } catch (error) {
      // Graceful handling for fresh starts
      if (error.message && error.message.includes('ENOENT')) {
        this.logger.debug('No strategic context yet (fresh start)');
        return null;
      }
      this.logger.warn('MCP strategic context failed', { error: error.message });
      return null;
    }
  }

  /**
   * Check what other agents are currently doing
   * @returns {Object} Agent activity summary
   */
  async checkAgentActivity() {
    if (!this.mcp) return null;

    try {
      return await this.mcp.checkAgentActivity();
    } catch (error) {
      // Graceful handling for fresh starts
      if (error.message && error.message.includes('ENOENT')) {
        this.logger.debug('No agent activity yet (fresh start)');
        return null;
      }
      this.logger.warn('MCP agent activity check failed', { error: error.message });
      return null;
    }
  }

  /**
   * Check for overlapping agent work in same phase
   * P4: Implementation of phantom method referenced in ide-agent.js
   * @returns {Object} Overlap detection results
   */
  async checkAgentOverlap() {
    if (!this.clusterStateStore || !this.mission.milestoneId) {
      return { 
        hasOverlap: false, 
        reason: 'No coordination context available',
        siblingCount: 0,
        overlappingAgents: []
      };
    }
    
    try {
      // Get all tasks in my phase
      const phaseTasks = await this.clusterStateStore.listTasks(
        this.mission.planId || 'plan:main',
        { milestoneId: this.mission.milestoneId }
      );
      
      // Find tasks with active agents (excluding self)
      const activeWorkInPhase = phaseTasks.filter(t => 
        t.assignedAgentId && 
        t.assignedAgentId !== this.agentId &&
        (t.state === 'IN_PROGRESS' || t.state === 'CLAIMED')
      );
      
      return {
        hasOverlap: activeWorkInPhase.length > 0,
        siblingCount: activeWorkInPhase.length,
        overlappingAgents: activeWorkInPhase.map(t => ({
          agentId: t.assignedAgentId,
          taskId: t.id,
          taskTitle: t.title,
          working: t.description.substring(0, 100)
        })),
        recommendation: activeWorkInPhase.length > 0
          ? `Coordinate with ${activeWorkInPhase.length} other agent(s) in this phase`
          : 'You are the only agent in this phase'
      };
    } catch (error) {
      this.logger.warn('checkAgentOverlap failed', { 
        error: error.message,
        agentId: this.agentId
      });
      return { 
        hasOverlap: false, 
        reason: 'Check failed',
        siblingCount: 0,
        overlappingAgents: []
      };
    }
  }

  /**
   * Get current system mode (focus/explore/execute)
   * @returns {Object} Oscillator mode info
   */
  async getCurrentSystemMode() {
    if (!this.mcp) return null;

    try {
      return await this.mcp.getCurrentMode();
    } catch (error) {
      this.logger.warn('MCP mode check failed', { error: error.message });
      return null;
    }
  }

  /**
   * Inject follow-up topic for system to explore
   * @param {string} topic - Topic to inject
   * @param {string} priority - 'high', 'medium', or 'low'
   * @param {string} context - Additional context
   */
  async injectFollowUpTopic(topic, priority = 'medium', context = '') {
    if (!this.mcp) {
      this.logger.warn('Cannot inject topic - MCP not available');
      return null;
    }

    try {
      return await this.mcp.inject_topic(topic, priority, context);
    } catch (error) {
      this.logger.warn('MCP topic injection failed', { error: error.message });
      return null;
    }
  }

  // ============================================================================
  // AGENT-TO-AGENT DATA SHARING - Memory Network Queries
  // ============================================================================

  /**
   * Query memory for structured data from other agents
   * 
   * This enables agent-to-agent communication through the memory network.
   * Agents store structured data (JSON) via addFinding(), and other agents
   * can retrieve it using this method.
   * 
   * Pattern:
   * 1. Research agent: await this.addFinding(JSON.stringify(inventory), 'file_inventory')
   * 2. Code agent: const data = await this.queryMemoryForData(['inventory'], ['file_inventory'])
   * 3. Synthesis agent: const all = await this.queryMemoryForData() // Get all structured data
   * 
   * @param {Array<string>} keywords - Additional keywords to search for (optional)
   * @param {Array<string>} tags - Specific tags to filter by (optional)
   * @param {number} limit - Max nodes to retrieve (default 10)
   * @returns {Array<Object>} Array of {type, data, sourceNode, tag}
   */
  async queryMemoryForData(keywords = [], tags = [], limit = 10) {
    if (!this.memory) {
      this.logger?.warn('No memory system available for data query');
      return [];
    }

    try {
      // Build query string from mission + keywords
      const queryTerms = [this.mission.description, ...keywords].join(' ');
      
      // Query memory network
      const nodes = await this.memory.query(queryTerms, limit);
      
      if (nodes.length === 0) {
        this.logger?.debug('No memory nodes found for query', {
          keywords: keywords.slice(0, 3)
        });
        return [];
      }

      // Filter and parse structured data
      const structuredData = [];
      
      for (const node of nodes) {
        // Skip if tags specified and doesn't match
        if (tags.length > 0 && !tags.includes(node.tag)) {
          continue;
        }
        
        // Look for JSON structures in concept
        const jsonMatch = node.concept.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const data = JSON.parse(jsonMatch[0]);
            
            // Determine data type from tag or content
            let type = node.tag || 'unknown';
            if (node.concept.includes('inventory')) type = 'inventory';
            if (node.concept.includes('analysis')) type = 'analysis';
            if (node.concept.includes('findings')) type = 'findings';
            
            structuredData.push({
              type,
              data,
              sourceNode: {
                id: node.id,
                tag: node.tag,
                similarity: node.similarity,
                concept: node.concept.substring(0, 200)
              },
              tag: node.tag
            });
            
            this.logger?.debug('Found structured data in memory', {
              type,
              tag: node.tag,
              similarity: node.similarity?.toFixed(3)
            });
          } catch (parseError) {
            // Not valid JSON, skip
            this.logger?.debug('Found JSON-like structure but failed to parse', {
              nodeId: node.id,
              error: parseError.message
            });
          }
        }
      }
      
      if (structuredData.length > 0) {
        this.logger?.info(`📦 Retrieved ${structuredData.length} structured data objects from memory`, {
          types: [...new Set(structuredData.map(d => d.type))]
        });
      }
      
      return structuredData;
      
    } catch (error) {
      this.logger?.error('Failed to query memory for data', {
        error: error.message,
        keywords: keywords.slice(0, 3)
      });
      return [];
    }
  }

  /**
   * Query memory for ALL relevant knowledge (not just structured data)
   * This is a convenience wrapper for broader memory queries
   * 
   * @param {number} limit - Max nodes to retrieve (default 30)
   * @returns {Array<Object>} Memory nodes with similarity scores
   */
  async queryMemoryForKnowledge(limit = 30) {
    if (!this.memory) {
      this.logger?.warn('No memory system available');
      return [];
    }

    try {
      const nodes = await this.memory.query(this.mission.description, limit);
      
      this.logger?.info('Knowledge gathered from memory', {
        nodesFound: nodes.length,
        topSimilarity: nodes[0]?.similarity?.toFixed(3) || '0.000'
      });
      
      return nodes;
    } catch (error) {
      this.logger?.error('Failed to query memory for knowledge', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Universal file discovery - finds all agent-created files
   * CRITICAL: Enables agents to find and use each other's work products
   * 
   * Solves the "write-only file system" problem by providing standardized discovery
   * across all agent types with automatic tag matching and deduplication.
   * 
   * @param {Object} options - Discovery options
   * @param {Array<string>} options.agentTypes - Agent types to search ['code_creation', 'code_execution', 'document_creation']
   * @param {string} options.fileType - Filter by extension (py, js, md, json, etc.)
   * @param {string} options.sourceAgentId - Filter to specific source agent ID (null = all agents)
   * @param {number} options.limit - Max files to return (default 20)
   * @param {number} options.maxAgeMs - Only files created within this timeframe (null = all)
   * @param {string} options.missionContext - Optional mission description for semantic filtering (defaults to this.mission.description)
   * @param {number} options.semanticLimit - When using semantic filtering, max files per source agent (default 10)
   * @param {boolean} options.includeInheritedArtifacts - Include artifacts from merged parent runs (default false)
   * @returns {Promise<Array>} File references with {filename, relativePath, size, sourceAgentType, sourceAgentId, createdAt, tag}
   */
  async discoverFiles(options = {}) {
    const {
      agentTypes = ['code_creation', 'code_execution', 'document_creation', 'document_analysis', 'ide'],
      fileType = null,
      sourceAgentId = null,
      limit = 20,
      maxAgeMs = null,
      missionContext = null,
      semanticLimit = 10
    } = options;
    
    if (!this.memory) {
      this.logger?.warn('No memory system available for file discovery');
      return [];
    }
    
    // CRITICAL: Semantic filtering for goal-scoped discovery
    // If no sourceAgentId is specified AND we have mission context, use semantic filtering
    // to only discover files relevant to the current goal/mission
    const useSemanticFiltering = !sourceAgentId && (missionContext || this.mission?.description);
    const contextForFiltering = missionContext || this.mission?.description || '';
    
    if (useSemanticFiltering && contextForFiltering) {
      this.logger?.info('🔍 Using semantic filtering for goal-scoped file discovery', {
        missionContext: contextForFiltering.substring(0, 100) + '...'
      });
    }
    
    // Tag mapping for each agent type (handles historical tag variations)
    const TAG_MAP = {
      'code_creation': ['code_creation_output_files', 'generated_code_python_script', 'generated_code_javascript_script', 'generated_code_python_module', 'generated_code_javascript_module'],
      'code_execution': ['code_execution_output_files'],
      'document_creation': ['document_metadata'],
      'document_analysis': ['document_contents_for_analysis', 'document_metadata_summary'],
      'specialized_binary': ['pdf_extraction', 'docx_extraction', 'xlsx_extraction', 'binary_extraction'],
      'research': ['research_output_files'],  // Research corpus files
      'ide': ['file_modified', 'ide_output_files']  // IDE agent modifications
    };
    
    const allFiles = [];
    const filesBySourceAgent = new Map(); // Track files per source agent for semantic limiting
    
    for (const agentType of agentTypes) {
      const tags = TAG_MAP[agentType] || [];
      
      for (const tag of tags) {
        try {
          // Query memory by TAG ONLY (not semantic - we want ALL files regardless of mission)
          // Direct memory access bypassing semantic search for file discovery
          const taggedNodes = [];

          if (this.memory && this.memory.nodes) {
            for (const [nodeId, node] of this.memory.nodes) {
              if (node.tag === tag) {
                taggedNodes.push({
                  type: tag,
                  data: null,
                  sourceNode: {
                    id: nodeId,
                    tag: node.tag,
                    concept: node.concept,
                    similarity: 1.0 // Direct tag match
                  },
                  tag: node.tag
                });
              }
            }
          }
          
          this.logger?.debug(`Tag search for ${tag}`, {
            nodesFound: taggedNodes.length
          });
          
          for (const item of taggedNodes) {
            const data = this.extractJsonPayload(item.sourceNode.concept);
            if (!data) {
              continue;
            }

            try {
              // Handle different data formats from various agent types
              let files = [];
              
              if (data?.files && Array.isArray(data.files)) {
                // Format: { agentId, files: [{filename, path?, relativePath, size}] }
                // Prefer absolute 'path' field over 'relativePath' for discovery
                files = data.files.map(f => ({
                  ...f,
                  relativePath: f.path || f.filePath || f.relativePath
                }));
              } else if (data?.filePath) {
                // Format: { title, filePath, wordCount, ... } (DocumentCreationAgent)
                files = [{ 
                  filename: data.title || 'document', 
                  relativePath: data.filePath, 
                  size: data.wordCount 
                }];
              }
              
              // Apply filters
              for (const file of files) {
                // PRIORITY FILTER: Match by goalId (prevents cross-goal contamination)
                // If current agent has a goalId and file data has goalId, they must match
                if (this.mission?.goalId && data.goalId && data.goalId !== this.mission.goalId) {
                  this.logger?.debug('Skipping file from different goal', {
                    fileGoalId: data.goalId,
                    currentGoalId: this.mission.goalId,
                    filename: file.filename
                  });
                  continue;
                }
                
                // Filter by source agent ID if specified
                if (sourceAgentId && data.agentId !== sourceAgentId) {
                  continue;
                }
                
                // CRITICAL: Skip inherited artifacts from merged runs (unless explicitly requested)
                // Merged runs preserve knowledge about artifacts from parent runs, but those files
                // don't exist in the merged run's directory. This prevents discovery of broken references.
                // Agents can opt-in by setting includeInheritedArtifacts: true in discovery options.
                if (data.inheritedArtifact && !options.includeInheritedArtifacts) {
                  this.logger?.debug('Skipping inherited artifact reference from merged run', {
                    agentId: data.agentId,
                    filename: file.filename,
                    note: 'File exists in parent run, not current run'
                  });
                  continue;
                }

                // Filter by file type if specified
                if (fileType) {
                  const ext = (file.filename || file.relativePath || '').split('.').pop();
                  if (ext !== fileType) continue;
                }
                
                // Filter by age if specified
                if (maxAgeMs && data.timestamp) {
                  const age = Date.now() - new Date(data.timestamp).getTime();
                  if (age > maxAgeMs) continue;
                }
                
                // CRITICAL: Semantic filtering per source agent
                // When semantic filtering is enabled, limit files from each agent based on relevance
                if (useSemanticFiltering && contextForFiltering && data.agentId) {
                  if (!filesBySourceAgent.has(data.agentId)) {
                    filesBySourceAgent.set(data.agentId, []);
                  }
                  
                  const agentFiles = filesBySourceAgent.get(data.agentId);
                  
                  // Skip if we already have enough files from this agent
                  if (agentFiles.length >= semanticLimit) {
                    continue;
                  }
                  
                  agentFiles.push(file);
                }
                
                allFiles.push({
                  ...file,
                  sourceAgentType: agentType,
                  sourceAgentId: data.agentId,
                  createdAt: data.timestamp,
                  tag: tag
                });
              }
            } catch (parseError) {
              // JSON parse failed, skip this node
              this.logger?.debug('Failed to parse JSON from memory node', {
                tag,
                error: parseError.message
              });
            }
          }
        } catch (error) {
          this.logger?.debug('Error processing tag, continuing', {
            agentType,
            tag,
            error: error.message
          });
          // Continue with other tags
        }
      }
    }
    
    // STEP 1: Deduplicate by filename+size (removes identical files from different agents)
    const fileSignatures = new Map(); // filename:size -> newest file
    for (const file of allFiles) {
      if (!file.filename || !file.size) continue;
      
      const signature = `${file.filename}:${file.size}`;
      const existing = fileSignatures.get(signature);
      
      if (!existing) {
        fileSignatures.set(signature, file);
      } else {
        // Keep the newer file
        const fileTime = file.createdAt ? new Date(file.createdAt).getTime() : 0;
        const existingTime = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
        if (fileTime > existingTime) {
          fileSignatures.set(signature, file);
        }
      }
    }
    
    const deduplicatedByContent = Array.from(fileSignatures.values());
    const duplicatesRemoved = allFiles.length - deduplicatedByContent.length;
    
    if (duplicatesRemoved > 0) {
      this.logger?.info('🔍 File deduplication by content', {
        before: allFiles.length,
        after: deduplicatedByContent.length,
        duplicatesRemoved
      });
    }
    
    // STEP 2: Deduplicate by relativePath (same file might be in multiple tags)
    const seen = new Set();
    const unique = deduplicatedByContent.filter(f => {
      if (!f.relativePath) return false;
      if (seen.has(f.relativePath)) return false;
      seen.add(f.relativePath);
      return true;
    });
    
    // Sort by creation time (newest first)
    unique.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    
    const limited = unique.slice(0, limit);
    
    this.logger?.info(`📂 File discovery complete`, {
      agentTypes,
      totalFound: unique.length,
      returned: limited.length,
      byType: agentTypes.reduce((acc, type) => {
        acc[type] = unique.filter(f => f.sourceAgentType === type).length;
        return acc;
      }, {})
    });
    
    return limited;
  }

  extractJsonPayload(concept) {
    if (!concept || typeof concept !== 'string') {
      return null;
    }

    const startIndex = concept.indexOf('{');
    if (startIndex === -1) {
      return null;
    }

    let depth = 0;
    for (let idx = startIndex; idx < concept.length; idx++) {
      const char = concept[idx];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = concept.slice(startIndex, idx + 1);
          try {
            return JSON.parse(candidate);
          } catch (error) {
            // Continue searching for a valid JSON block
          }
        }
      }
    }

    const endIndex = concept.lastIndexOf('}');
    if (endIndex > startIndex) {
      const fallbackCandidate = concept.slice(startIndex, endIndex + 1);
      try {
        return JSON.parse(fallbackCandidate);
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  // ============================================================================
  // EXTERNAL MCP TOOLS - File Reading (Local MCP Servers)
  // ============================================================================

  /**
   * Read a file from repository via MCP
   * Uses local MCP server (callMCPTool), not passed to GPT-5
   * (GPT-5.2 Responses API can't reach localhost servers)
   * 
   * @param {string} filePath - Relative path from repo root
   * @param {number} maxSizeBytes - Maximum file size in bytes (default: 100MB)
   * @returns {string} File content
   * @throws {Error} If MCP unavailable, file not found, too large, or read fails
   */
  async readFileViaMCP(filePath, maxSizeBytes = 100 * 1024 * 1024) {
    if (!this.gpt5?.callMCPTool) {
      throw new Error('MCP tools not available - file reading disabled');
    }

    // Helper to attempt reading a path
    const tryReadPath = async (pathToTry) => {
      const result = await this.gpt5.callMCPTool('filesystem', 'read_file', {
        path: pathToTry
      });

      if (!result?.content?.[0]) {
        throw new Error(`Empty response from MCP server for: ${pathToTry}`);
      }

      const data = JSON.parse(result.content[0].text);

      if (data.size > maxSizeBytes) {
        throw new Error(
          `File too large: ${pathToTry} is ${(data.size / (1024 * 1024)).toFixed(2)}MB ` +
          `(max: ${(maxSizeBytes / (1024 * 1024)).toFixed(2)}MB)`
        );
      }

      return data;
    };

    // Build list of paths to try (primary path first, then fallbacks)
    const pathsToTry = [filePath];

    // If path is not absolute, add resolution fallbacks
    if (!path.isAbsolute(filePath)) {
      // Try resolving via pathResolver if available
      if (this.pathResolver) {
        try {
          const resolved = this.pathResolver.resolve(filePath);
          if (resolved && resolved !== filePath) {
            pathsToTry.push(resolved);
          }
        } catch (e) {
          // Ignore resolution errors, will try fallbacks
        }
      }

      // Add common output directory fallbacks
      if (this.pathResolver?.getOutputsRoot()) {
        pathsToTry.push(path.join(this.pathResolver.getOutputsRoot(), filePath));
      }
      if (this.config?.logsDir) {
        pathsToTry.push(path.join(this.config.logsDir, filePath));
        pathsToTry.push(path.join(this.config.logsDir, 'outputs', filePath));
      }
      pathsToTry.push(path.resolve(process.cwd(), filePath));
    }

    // Try each path in order
    let lastError = null;
    for (const pathToTry of pathsToTry) {
      try {
        const data = await tryReadPath(pathToTry);

        if (pathToTry !== filePath) {
          this.logger.debug(`📁 Read file via fallback path: ${pathToTry} (original: ${filePath})`);
        } else {
          this.logger.debug(`📁 Read file via MCP: ${filePath} (${(data.size / 1024).toFixed(2)}KB)`);
        }

        return data.content;
      } catch (error) {
        lastError = error;
        // Continue to next fallback path
      }
    }

    // All paths failed - throw with detailed context
    const err = new Error(`Failed to read file '${filePath}': ${lastError?.message || 'Unknown error'}`);
    err.originalError = lastError;
    err.filePath = filePath;
    err.pathsAttempted = pathsToTry;
    err.agentId = this.agentId;

    this.logger.warn(`Failed to read file via MCP: ${filePath}`, {
      error: lastError?.message,
      pathsAttempted: pathsToTry.length,
      agentId: this.agentId
    });

    throw err;
  }

  /**
   * List directory contents via MCP
   * 
   * @param {string} dirPath - Relative path from repo root
   * @returns {Array} Directory items [{name, type, size, modified}, ...]
   * @throws {Error} If MCP unavailable, directory not found, or listing fails
   */
  async listDirectoryViaMCP(dirPath = '.') {
    if (!this.gpt5?.callMCPTool) {
      throw new Error('MCP tools not available - directory listing disabled');
    }

    try {
      const result = await this.gpt5.callMCPTool('filesystem', 'list_directory', {
        path: dirPath
      });
      
      if (!result?.content?.[0]) {
        throw new Error(`Empty response from MCP server for directory: ${dirPath}`);
      }
      
      const data = JSON.parse(result.content[0].text);
      
      // Better error handling for malformed responses
      if (!data) {
        throw new Error(`MCP returned null/undefined data for directory: ${dirPath}`);
      }
      
      // Check if response contains an error (directory doesn't exist, access denied, etc.)
      if (data.error || data.message) {
        throw new Error(`MCP error: ${data.error || data.message}`);
      }
      
      if (!Array.isArray(data.items)) {
        // Log the actual response for debugging
        this.logger.warn(`Unexpected MCP response format for ${dirPath}:`, data);
        throw new Error(`Invalid response format for directory: ${dirPath} (expected items array, got ${typeof data.items})`);
      }
      
      this.logger.debug(`📂 Listed directory via MCP: ${dirPath} (${data.items.length} items)`);
      return data.items;
      
    } catch (error) {
      // Provide detailed error context
      const err = new Error(`Failed to list directory '${dirPath}': ${error.message}`);
      err.originalError = error;
      err.dirPath = dirPath;
      err.agentId = this.agentId;
      
      this.logger.warn(`Failed to list directory via MCP: ${dirPath}`, {
        error: error.message,
        agentId: this.agentId
      });
      
      throw err;
    }
  }

  /**
   * Atomic file write using temp-file-then-rename pattern
   * Prevents partial/corrupted files from being visible if process interrupted
   * 
   * @param {string} filePath - Final destination path
   * @param {Buffer|string} content - File content
   * @param {Object} options - Write options (encoding, etc)
   * @returns {Promise<void>}
   * 
   * How it works:
   * 1. Write to temporary file (filePath + '.tmp')
   * 2. Atomically rename temp to final (POSIX guarantee)
   * 3. If interrupted: temp file may exist, but final file doesn't (safe)
   */
  async writeFileAtomic(filePath, content, options = {}) {
    // DEBUG: Log all file writes to trace recursive path creation
    const fs = require('fs');
    const debugInfo = {
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
      filePath: filePath,
      'filePath is absolute': require('path').isAbsolute(filePath),
      'capabilities enabled': !!this.capabilities
    };
    try {
      fs.appendFileSync('/tmp/base-agent-writes.log', JSON.stringify(debugInfo, null, 2) + '\n---\n');
    } catch (e) {}
    
    // CAPABILITIES INTEGRATION: Use capabilities if available (includes atomic write + Executive judgment)
    if (this.capabilities) {
      // CRITICAL FIX: Pass absolute path directly - pathResolver handles absolute paths correctly
      // Previously used path.relative(process.cwd(), filePath) which caused path doubling
      // when process.cwd() != runtimeRoot (multi-tenant mode)
      const result = await this.capabilities.writeFile(
        filePath,  // Use absolute path - pathResolver.resolve() returns absolute paths as-is
        Buffer.isBuffer(content) ? content.toString('utf8') : content,
        {
          agentId: this.agentId,
          agentType: this.constructor.name,
          missionGoal: this.mission.goalId,
          // Link file writes to plan task when available
          taskId: this.mission?.taskId || this.mission?.metadata?.originalTaskId || null
        }
      );
      
      if (!result.success) {
        throw new Error(`Capabilities declined write: ${result.reason}`);
      }
      
      this.logger?.debug?.('File written via Capabilities', {
        file: path.basename(filePath),
        size: Buffer.isBuffer(content) ? content.length : content.length
      });
      
      return;
    }
    
    // FALLBACK: Direct atomic write for backwards compatibility
    const tempPath = filePath + '.tmp';
    
    try {
      // Write to temporary file
      await fs.writeFile(tempPath, content, options);
      
      // Atomic rename (POSIX guarantee: either succeeds completely or fails)
      await fs.rename(tempPath, filePath);
      
      this.logger?.debug?.('Atomic file write successful', {
        file: path.basename(filePath),
        size: Buffer.isBuffer(content) ? content.length : content.length
      });
    } catch (error) {
      // Cleanup temp file on error
      try {
        await fs.unlink(tempPath).catch(() => {});
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      this.logger?.error?.('Atomic file write failed', {
        file: filePath,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Write completion marker for deliverable directory
   * Signals that all files have been successfully written
   * 
   * @param {string} outputDir - Directory containing deliverable files
   * @param {Object} metadata - Completion metadata (fileCount, totalSize, etc)
   * @returns {Promise<void>}
   */
  async writeCompletionMarker(outputDir, metadata = {}) {
    const markerPath = path.join(outputDir, '.complete');
    
    const markerContent = {
      completedAt: new Date().toISOString(),
      agentId: this.agentId,
      agentType: this.constructor.name,
      ...metadata
    };
    
    // Use atomic write for completion marker too
    await this.writeFileAtomic(
      markerPath,
      JSON.stringify(markerContent, null, 2),
      { encoding: 'utf8' }
    );
    
    this.logger?.info?.('✓ Completion marker written', {
      outputDir: path.basename(outputDir),
      fileCount: metadata.fileCount
    });
  }

  /**
   * Check if deliverable directory is complete
   * 
   * @param {string} outputDir - Directory to check
   * @returns {Promise<{complete: boolean, metadata?: Object}>}
   */
  async checkCompletionMarker(outputDir) {
    const markerPath = path.join(outputDir, '.complete');
    
    try {
      const markerContent = await fs.readFile(markerPath, 'utf8');
      const metadata = JSON.parse(markerContent);
      
      return { complete: true, metadata };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { complete: false };
      }
      
      this.logger?.warn?.('Failed to read completion marker', {
        outputDir,
        error: error.message
      });
      
      return { complete: false, error: error.message };
    }
  }

  /**
   * Cleanup orphaned temporary files from previous crashed runs
   * Called automatically in onStart() hook
   * 
   * @param {string} outputDir - Directory to clean
   * @param {number} maxAge - Max age in ms for temp files (default 5 minutes)
   * @returns {Promise<number>} Number of files cleaned
   */
  async cleanupOrphanedTempFiles(outputDir, maxAge = 300000) {
    let cleanedCount = 0;
    
    try {
      // Ensure directory exists
      await fs.mkdir(outputDir, { recursive: true });
      
      const files = await fs.readdir(outputDir);
      
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          const tempPath = path.join(outputDir, file);
          
          try {
            const stats = await fs.stat(tempPath);
            const age = Date.now() - stats.mtimeMs;
            
            if (age > maxAge) {
              await fs.unlink(tempPath);
              cleanedCount++;
              
              this.logger?.info?.('🧹 Cleaned up orphaned temp file', {
                file,
                ageMinutes: Math.round(age / 60000)
              });
            }
          } catch (statError) {
            // File may have been deleted by another process, ignore
          }
        }
      }
      
      if (cleanedCount > 0) {
        this.logger?.info?.('Cleanup complete', {
          outputDir: path.basename(outputDir),
          filesRemoved: cleanedCount
        });
      }
    } catch (error) {
      this.logger?.warn?.('Failed to cleanup orphaned temp files', {
        outputDir,
        error: error.message
      });
    }
    
    return cleanedCount;
  }

  /**
   * Get enhanced mission description with artifact context
   * 
   * Returns the mission description plus information about available artifacts.
   * Agents should use this instead of this.mission.description directly when
   * providing context to LLMs.
   * 
   * @returns {string} Enhanced mission description
   */
  getMissionWithArtifactContext() {
    let description = this.mission.description;
    
    // Add artifact context if available
    if (this.mission.artifactContext) {
      description += this.mission.artifactContext;
    }
    
    // Add summary of uploaded artifacts if they exist
    if (this._uploadedArtifacts && this._uploadedArtifacts.length > 0) {
      description += '\n\n**Note:** The following files from previous agents are now available in your execution environment:\n';
      for (const artifact of this._uploadedArtifacts) {
        description += `- ${artifact.filename} (from ${artifact.sourceAgent})\n`;
      }
    }
    
    return description;
  }

  /**
   * Upload predecessor artifacts to execution backend
   * 
   * Called automatically after backend initialization if mission has artifactsToUpload.
   * Implements the decisions from design:
   * - Upload ALL predecessor files (within limits already enforced by executor)
   * - Continue with partial uploads if some fail (non-fatal errors)
   * - Preserve directory structure (maintains relative paths for imports)
   * 
   * @param {Array} artifacts - Artifact references from mission.artifactsToUpload
   * @returns {Promise<Object>} Upload results with success/failure counts
   */
  async uploadPredecessorArtifacts(artifacts) {
    if (!artifacts || artifacts.length === 0) {
      return { uploaded: 0, failed: 0, skipped: 0 };
    }
    
    // Check if we have an execution backend
    if (!this.executionBackend) {
      this.logger?.debug('No execution backend available for artifact upload');
      return { uploaded: 0, failed: 0, skipped: artifacts.length };
    }
    
    // Skip upload for local backend - files already accessible via shared filesystem
    if (this.executionBackend.getBackendType() === 'local') {
      this.logger?.info('📁 Local backend detected - artifacts accessible via shared filesystem', {
        count: artifacts.length
      });
      return { uploaded: 0, failed: 0, skipped: artifacts.length };
    }
    
    // Upload to container backend
    this.logger?.info('📤 Uploading predecessor artifacts to container', {
      count: artifacts.length,
      sources: [...new Set(artifacts.map(a => a.sourceAgentId))]
    });
    
    const results = {
      uploaded: 0,
      failed: 0,
      skipped: 0,
      uploadedFiles: [],
      failedFiles: []
    };
    
    for (const artifact of artifacts) {
      try {
        // Read file from host filesystem via MCP
        let content;
        try {
          content = await this.readFileViaMCP(artifact.relativePath);
        } catch (readError) {
          this.logger?.warn('  ✗ Cannot read artifact file (may not exist)', {
            file: artifact.relativePath,
            error: readError.message
          });
          results.skipped++;
          results.failedFiles.push({
            ...artifact,
            reason: 'file_not_found'
          });
          continue; // Skip to next file
        }
        
        if (!content) {
          this.logger?.warn('  ✗ Artifact file is empty or null', {
            file: artifact.relativePath
          });
          results.skipped++;
          results.failedFiles.push({
            ...artifact,
            reason: 'empty_file'
          });
          continue;
        }
        
        // Upload to container
        // CRITICAL: Preserve relative path structure for imports
        const buffer = Buffer.from(content, 'utf-8');
        await this.executionBackend.uploadFile(buffer, artifact.filename);
        
        results.uploaded++;
        results.uploadedFiles.push({
          filename: artifact.filename,
          relativePath: artifact.relativePath,
          size: content.length,
          sourceAgent: artifact.sourceAgentId
        });
        
        this.logger?.info('  ✓ Uploaded', {
          file: artifact.filename,
          size: Math.round(content.length / 1024) + 'KB',
          from: artifact.sourceAgentId
        });
        
      } catch (error) {
        results.failed++;
        results.failedFiles.push({
          ...artifact,
          reason: 'upload_error',
          error: error.message
        });
        
        this.logger?.warn('  ✗ Upload failed', {
          file: artifact.filename,
          error: error.message
        });
        
        // Continue with other files - partial upload is better than none
      }
    }
    
    // Log summary
    if (results.uploaded > 0 || results.failed > 0) {
      this.logger?.info('✅ Artifact upload complete', {
        uploaded: results.uploaded,
        failed: results.failed,
        skipped: results.skipped,
        total: artifacts.length,
        files: results.uploadedFiles.map(f => f.filename)
      });
    }
    
    // Store uploaded artifacts for reference
    this._uploadedArtifacts = results.uploadedFiles;

    return results;
  }

  /**
   * Save checkpoint of current agent progress (for graceful shutdown)
   * Default implementation - subclasses can override for richer checkpoints
   *
   * This enables agents to preserve partial work when interrupted during shutdown.
   */
  async saveCheckpoint() {
    const checkpoint = {
      agentId: this.id,
      agentType: this.constructor.name,
      mission: this.mission,
      status: this.status,
      resultsCount: this.results.length,
      progressReports: this.progressReports,
      errors: this.errors,
      startTime: this.startTime,
      checkpointTime: Date.now(),
      timestamp: new Date().toISOString()
    };

    try {
      const checkpointPath = path.join(this.workingDir, 'agent-checkpoint.json');
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
      this.logger.debug(`💾 Agent checkpoint saved`, { agentId: this.id }, 3);
      return checkpoint;
    } catch (error) {
      this.logger.warn(`Failed to save agent checkpoint`, { error: error.message });
      return null;
    }
  }

  /**
   * Signal handler for graceful shutdown
   * Called when system is shutting down - agents should wrap up quickly
   *
   * Subclasses can override to save partial work, close connections, etc.
   * Default implementation just logs acknowledgment.
   */
  onShutdownSignal() {
    this.logger.info(`📢 Shutdown signal received, wrapping up...`, {
      agentId: this.id,
      type: this.constructor.name,
      resultsCount: this.results.length
    }, 2);

    // Subclasses should override to add custom checkpoint logic
    // Example: Save partial file generation, close API connections, etc.
  }
}

module.exports = { BaseAgent };

