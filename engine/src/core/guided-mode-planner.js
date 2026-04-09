/**
 * Guided Mode Planner
 * 
 * Runs ONCE at startup when explorationMode: guided
 * 
 * Purpose:
 * - Understand the guided task (domain + context)
 * - Identify required resources (MCP files, web search, code execution)
 * - Create initial agent missions
 * - Spawn agents in dependency order (tier-based)
 * - Set up cognitive loop with appropriate context
 * 
 * Agent Tier System:
 * - Tier 0: Data collectors (can work with empty memory)
 * - Tier 1: Processors (need source data)
 * - Tier 2: Creators (need processed results)
 * - Tier 3: Validators (need created outputs)
 * 
 * Only Tier 0 spawns immediately; subsequent tiers spawn via coordinator as dependencies complete.
 */

const { getAgentTimeout } = require('../config/agent-timeouts');

class GuidedModePlanner {
  constructor(config, subsystems, logger) {
    this.config = config;
    this.subsystems = subsystems;
    this.logger = logger;
    this.client = subsystems.client; // UnifiedClient with MCP access
  }

  /**
   * Main entry point: Plan and initialize guided mode
   * 
   * @param {Object} options - { forceNew: boolean }
   * @returns {Object} - Initial setup including agent missions AND task goals
   */
  async planMission(options = {}) {
    const { forceNew = false } = options;
    
    if (this.config.architecture?.roleSystem?.explorationMode !== 'guided') {
      this.logger?.debug('Not in guided mode, skipping planner');
      return null;
    }

    const guidedFocus = this.config.architecture?.roleSystem?.guidedFocus;
    if (!guidedFocus) {
      this.logger?.warn('Guided mode enabled but no guidedFocus config');
      return null;
    }

    this.logger?.info('');
    this.logger?.info('╔══════════════════════════════════════════════════════╗');
    this.logger?.info('║        GUIDED MODE PLANNER - MISSION SETUP           ║');
    this.logger?.info('╚══════════════════════════════════════════════════════╝');
    this.logger?.info('');
    this.logger?.info(`📋 Domain: ${guidedFocus.domain}`);
    this.logger?.info(`📋 Depth: ${guidedFocus.depth || 'normal'}`);
    
    // NEW: Check execution mode
    const executionMode = guidedFocus.executionMode || 'mixed';
    this.logger?.info(`📋 Execution Mode: ${executionMode.toUpperCase()}`);
    this.logger?.info('   - strict: Task-exclusive (100% focus, no autonomous goals)');
    this.logger?.info('   - mixed: Task-primary (~85% task, ~15% autonomous exploration)');
    this.logger?.info('   - advisory: Task-aware (~65% task, autonomous with context)');
    this.logger?.info('');

    // NEW: Check for existing plan FIRST (for resume support)
    // But skip if forceNew is true (when injecting a new plan)
    const stateStore = this.subsystems.clusterStateStore;
    const existingPlan = (!forceNew && stateStore) ? await stateStore.getPlan('plan:main') : null;
    
    // Only resume if plan exists AND is not archived/completed AND has active work
    const hasActiveTasks = existingPlan?.tasks?.some(t =>
      t.status === 'IN_PROGRESS' || t.status === 'PENDING'
    );
    const hasActiveAgents = this.subsystems?.agentExecutor?.registry?.getActiveCount() > 0;

    if (existingPlan && existingPlan.status !== 'ARCHIVED' && existingPlan.status !== 'COMPLETED' && (hasActiveTasks || hasActiveAgents)) {
      this.logger?.info('📋 Resuming existing plan', {
        planId: existingPlan.id,
        title: existingPlan.title,
        version: existingPlan.version,
        milestones: existingPlan.milestones?.length || 0,
        activeTasks: hasActiveTasks,
        activeAgents: hasActiveAgents
      });
      this.logger?.info('⏭️  Skipping mission generation (using saved plan)');
      this.logger?.info('');
      this.logger?.info('✅ Guided mode planning complete (resumed)');
      this.logger?.info('');

      // Return minimal plan object for orchestrator
      return {
        taskPhases: [],
        executionMode: guidedFocus.executionMode || 'mixed',
        spawnAgents: false  // Don't spawn agents on resume
      };
    } else if (existingPlan && !hasActiveTasks && !hasActiveAgents) {
      this.logger?.info('📋 Found stale plan with no active work - regenerating', {
        planId: existingPlan.id,
        status: existingPlan.status
      });
      // Fall through to generate new plan
    }
    
    // Only generate plan if this is a NEW run
    this.logger?.info('📋 Generating new mission plan...');
    this.logger?.info('');

    // Analyze what resources are available
    const resources = await this.analyzeAvailableResources();
    
    // NEW: Parse structured task phases from context
    const taskPhases = this.parseTaskPhases(guidedFocus.context);
    
    if (taskPhases.length > 0) {
      this.logger?.info(`📋 Detected ${taskPhases.length} structured task phases`);
      taskPhases.forEach((phase, i) => {
        this.logger?.info(`   Phase ${i + 1}: ${phase.name}`);
      });
      this.logger?.info('');
    }
    
    // If task mentions specific files to read, read them via MCP before planning
    let filesRead = [];
    if (resources.mcp.tools.includes('read_file')) {
      filesRead = await this.readFilesIfNeeded(guidedFocus);
    }
    
    // Generate mission plan (with file content if files were read)
    const plan = await this.generateMissionPlan(guidedFocus, resources, filesRead, taskPhases);
    
    // Create Plan from task phases OR generated agent missions
    // (We already checked for existing plan above, so this is only for NEW runs)
    const phasesToUse = taskPhases.length > 0 ? taskPhases : 
      (plan.agentMissions || []).map((mission, idx) => {
        const desc = mission.description || mission.mission || mission.instructions || 'Generated mission';
        return {
          name: desc.substring(0, 100),
          description: desc,
          deliverables: mission.expectedOutput ? [mission.expectedOutput] : []
        };
      });
    
    // Mission→goalId mapping for task→goal→agent linkage.
    // IMPORTANT: This must be consistent between:
    // - tasks persisted in the plan (metadata.goalId)
    // - agents spawned by GuidedModePlanner (missionSpec.goalId)
    // If these diverge, PlanScheduler cannot detect "goal already pursued" and will spawn duplicates.
    let missionGoalIds = null;

    if (phasesToUse.length > 0 && stateStore) {
      this.logger?.info(`📋 Creating Plan from ${phasesToUse.length} ${taskPhases.length > 0 ? 'explicit phases' : 'generated missions'}`);
      
      // Create Plan
      const guidedPlan = {
        id: 'plan:main',  // Use plan:main so orchestrator picks it up
        title: guidedFocus.domain,
        version: 1,
        status: 'ACTIVE',
        milestones: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      
      // Create Milestones
      const milestones = phasesToUse.map((phase, idx) => ({
        id: `ms:phase${idx + 1}`,
        planId: guidedPlan.id,
        title: phase.name,
        order: idx + 1,
        status: idx === 0 ? 'ACTIVE' : 'LOCKED',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }));
      
      guidedPlan.milestones = milestones.map(m => m.id);
      guidedPlan.activeMilestone = milestones[0].id;
      
      // Create Tasks
      // Store mission→goalId mapping for later
      const baseTimestamp = Date.now();
      missionGoalIds = (plan.agentMissions || []).map((mission, idx) => ({
        missionIdx: idx,
        missionType: mission.type,
        goalId: `goal_guided_${mission.type}_${baseTimestamp + idx}`
      }));
      
      const tasks = phasesToUse.map((phase, idx) => {
        // Link task to corresponding goal
        const goalId = missionGoalIds[idx]?.goalId || null;
        const agentType = missionGoalIds[idx]?.missionType || null;
        
        return {
          id: `task:phase${idx + 1}`,
          planId: guidedPlan.id,
          milestoneId: milestones[idx].id,
          title: phase.name,
          description: phase.description || guidedFocus.context,
          tags: [guidedFocus.domain, 'guided', 'sequential'],
          deps: idx > 0 ? [`task:phase${idx}`] : [], // Sequential dependency
          priority: 10, // High priority for guided tasks
          state: 'PENDING',
          acceptanceCriteria: this.generateAcceptanceCriteria(phase),
          artifacts: [],
          metadata: {
            goalId: goalId,  // Link task to goal for agent spawning
            agentType: agentType,
            spawningSource: 'guided_mode',
            baseTimestamp: baseTimestamp  // Store for agent spawning correlation
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
      });
      
      // NEW: Add synthesis task if deliverable requires assembly
      const needsSynthesis = this.deliverableRequiresSynthesis(plan.deliverable, phasesToUse);
      
      if (needsSynthesis) {
        const synthesisTask = {
          id: `task:synthesis_final`,
          planId: guidedPlan.id,
          milestoneId: milestones[milestones.length - 1].id, // Same milestone as last phase
          title: 'Assemble Final Deliverable',
          description: `Combine all phase outputs into final ${plan.deliverable.type || 'document'} deliverable: ${plan.deliverable.filename || 'output'}. Required sections: ${plan.deliverable.requiredSections?.join(', ') || 'all phase outputs'}. ${plan.deliverable.minimumContent || ''}`,
          tags: [guidedFocus.domain, 'guided', 'synthesis', 'final_deliverable'],
          deps: tasks.map(t => t.id), // Depends on ALL previous tasks
          priority: 11, // Higher than phase tasks to ensure it runs last
          state: 'PENDING',
          acceptanceCriteria: [{
            type: 'qa',
            rubric: `Final deliverable exists at ${plan.deliverable.location || 'runtime/outputs/'}${plan.deliverable.filename || 'output'} and contains all required sections with minimum content requirements met`,
            threshold: 0.9
          }],
          artifacts: [],
          metadata: {
            isFinalSynthesis: true,
            inputTasks: tasks.map(t => t.id),
            deliverableSpec: plan.deliverable
          },
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        
        tasks.push(synthesisTask);
        
        this.logger?.info('📦 Final synthesis task added to plan', {
          taskId: synthesisTask.id,
          dependsOn: synthesisTask.deps.length,
          deliverableType: plan.deliverable.type
        });
      }
      
      // Persist to state store
      await stateStore.createPlan(guidedPlan);
      for (const milestone of milestones) {
        await stateStore.upsertMilestone(milestone);
      }
      for (const task of tasks) {
        await stateStore.upsertTask(task);
      }
      
      this.logger?.info('✅ Plan initialized from guided mode', {
        tasks: tasks.length,
        milestones: milestones.length,
        source: taskPhases.length > 0 ? 'explicit_phases' : 'generated_missions'
      });
    }
    
    this.logger?.info('');
    this.logger?.info('✅ Guided mode planning complete');
    this.logger?.info(`   Task phases: ${taskPhases.length}`);
    this.logger?.info(`   Execution mode: ${executionMode}`);
    this.logger?.info('');

    // Prepare missionGoalIds for deferred spawning (after plan is displayed)
    const missionGoalIdsToUse = missionGoalIds || (plan.agentMissions || []).map((mission, idx) => ({
      missionIdx: idx,
      missionType: mission.type,
      goalId: `goal_guided_${mission.type}_${Date.now() + idx}`
    }));

    // Store for deferred spawning - agents will be spawned AFTER plan is displayed
    plan._deferredSpawn = {
      shouldSpawn: plan.spawnAgents && plan.agentMissions?.length > 0,
      missionGoalIds: missionGoalIdsToUse
    };

    return {
      ...plan,
      taskPhases,
      executionMode
    };
  }

  /**
   * Execute deferred agent spawning after plan is displayed
   * Called from index.js AFTER plan presentation
   *
   * @param {Object} plan - The plan with _deferredSpawn data
   */
  async executeDeferredSpawn(plan) {
    if (!plan?._deferredSpawn?.shouldSpawn) {
      this.logger?.info('ℹ️  No agents to spawn (plan did not request agent spawning)');
      return;
    }

    this.logger?.info('');
    this.logger?.info('🚀 Spawning agents as per plan...');
    await this.spawnInitialAgents(plan, plan._deferredSpawn.missionGoalIds);
    this.logger?.info('');
  }

  /**
   * Determine if deliverable requires synthesis of multiple artifacts
   * 
   * @param {Object} deliverableSpec - Deliverable specification from plan
   * @param {Array} phases - Task phases
   * @returns {boolean} - True if synthesis task should be added
   */
  deliverableRequiresSynthesis(deliverableSpec, phases) {
    if (!deliverableSpec) return false;
    
    // If deliverable has required sections AND multiple phases generate separate outputs
    if (deliverableSpec.requiredSections && 
        deliverableSpec.requiredSections.length > 1 && 
        phases.length > 1) {
      return true;
    }
    
    // If deliverable explicitly mentions combining/assembling
    const description = (deliverableSpec.minimumContent || '').toLowerCase();
    if (description.includes('combine') || 
        description.includes('assemble') || 
        description.includes('integrate') ||
        description.includes('synthesize')) {
      return true;
    }
    
    // If minimum content suggests narrative across phases
    if (deliverableSpec.minimumContent && 
        deliverableSpec.minimumContent.includes('words') && 
        phases.length > 2) {
      return true;
    }
    
    return false;
  }

  /**
   * Generate acceptance criteria for a phase
   * 
   * Creates requirements for:
   * - Specific file formats (with flexibility)
   * - Quality checks via QA agent
   * - Completeness metrics
   */
  generateAcceptanceCriteria(phase) {
    const criteria = [];
    
    // Extract deliverable requirements from description
    const desc = (phase.description || phase.name || '').toLowerCase();
    const deliverables = phase.deliverables || [];
    const fullText = desc + ' ' + deliverables.join(' ');
    
    // Check for common deliverable patterns
    if (fullText.includes('bibliography') || fullText.includes('sources') || fullText.includes('literature')) {
      criteria.push({
        type: 'qa',
        rubric: 'Contains a curated bibliography or literature corpus with >=50 sources, including metadata (title, authors, year, DOI/URL). Format can be CSV, JSON, or structured markdown table.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('taxonomy') || fullText.includes('classification') || fullText.includes('catalog')) {
      criteria.push({
        type: 'qa',
        rubric: 'Provides a structured taxonomy or classification system with clear categories, definitions, and examples. Format can be JSON, CSV, or markdown with clear structure.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('code') || fullText.includes('simulation') || fullText.includes('model') || fullText.includes('notebook')) {
      criteria.push({
        type: 'qa',
        rubric: 'Includes executable code (Python script or Jupyter notebook) with clear documentation, parameters, and example outputs. Code should be runnable and produce expected results.',
        threshold: 0.8
      });
    }
    
    if (fullText.includes('report') || fullText.includes('document') || fullText.includes('synthesis')) {
      criteria.push({
        type: 'qa',
        rubric: 'Provides a comprehensive report document (markdown) with required sections, citations, and analysis. Minimum 1500 words with substantive content.',
        threshold: 0.7
      });
    }
    
    if (fullText.includes('visualization') || fullText.includes('plot') || fullText.includes('figure')) {
      criteria.push({
        type: 'qa',
        rubric: 'Includes data visualizations or figures (PNG, SVG, or described in detail) that effectively communicate findings.',
        threshold: 0.7
      });
    }
    
    // If no specific patterns detected, use general completion check
    if (criteria.length === 0) {
      criteria.push({
        type: 'qa',
        rubric: `Phase "${phase.name}" objectives completed with evidence of substantive work and deliverables`,
        threshold: 0.8
      });
    }
    
    return criteria;
  }

  /**
   * Analyze what resources/tools are available
   */
  async analyzeAvailableResources() {
    const resources = {
      mcp: {
        available: false,
        servers: [],
        tools: []
      },
      webSearch: this.config.models?.enableWebSearch || false,
      codeExecution: this.config.coordinator?.codeExecution?.enabled || false,
      agentTypes: []
    };

    // Check MCP tools
    if (this.config.mcp?.client?.enabled) {
      try {
        const mcpTools = await this.client.getMCPTools?.() || [];
        resources.mcp.available = mcpTools.length > 0;
        resources.mcp.tools = mcpTools.map(t => t.name);
        
        const servers = this.config.mcp.client.servers?.filter(s => s.enabled) || [];
        resources.mcp.servers = servers.map(s => ({
          label: s.label,
          url: s.url,
          tools: s.allowedTools || []
        }));
        
        this.logger?.info(`✓ MCP Resources: ${resources.mcp.servers.length} servers, ${resources.mcp.tools.length} tools`);
      } catch (error) {
        this.logger?.warn('Failed to query MCP tools', { error: error.message });
      }
    }

    // Check agent types
    const agentWeights = this.config.coordinator?.agentTypeWeights || {};
    resources.agentTypes = Object.keys(agentWeights).filter(type => agentWeights[type] > 0);
    this.logger?.info(`✓ Available agent types: ${resources.agentTypes.join(', ')}`);

    if (resources.webSearch) {
      this.logger?.info('✓ Web search: enabled');
    }
    if (resources.codeExecution) {
      this.logger?.info('✓ Code execution: enabled');
    }

    return resources;
  }

  /**
   * Read files if the task context mentions specific filenames OR requests discovery
   * Supports both explicit filenames and directory scanning
   */
  async readFilesIfNeeded(guidedFocus) {
    const context = guidedFocus.context || '';
    const filesRead = [];
    
    // Check if context asks for discovery/scanning
    const shouldDiscover = context.toLowerCase().includes('discover') ||
                          context.toLowerCase().includes('scan') ||
                          context.toLowerCase().includes('all .md files') ||
                          context.toLowerCase().includes('list_directory');
    
    let filesToRead = new Set();
    
    if (shouldDiscover) {
      // Use list_directory to discover files
      this.logger?.info('🔍 Discovering files via list_directory...');
      
      // Get directories from config allowedPaths OR extract from context
      const dirsToScan = this.getDirectoriesToScan(guidedFocus);
      
      for (const dir of dirsToScan) {
        try {
          const result = await this.client.callMCPTool('filesystem', 'list_directory', {
            path: dir
          });
          
          if (result.content && result.content[0]) {
            const data = JSON.parse(result.content[0].text);
            const items = data.items || [];
            
            // Filter for .md files (or .js if context mentions code analysis)
            const mdFiles = items.filter(item => 
              item.type === 'file' && item.name.endsWith('.md')
            );
            
            mdFiles.forEach(file => {
              const fullPath = dir === '.' ? file.name : `${dir}/${file.name}`;
              filesToRead.add(fullPath);
            });
            
            this.logger?.info(`   Found ${mdFiles.length} .md files in ${dir}`);
          }
        } catch (error) {
          this.logger?.warn(`   Failed to scan ${dir}: ${error.message}`);
        }
      }
      
      this.logger?.info(`✅ Discovered ${filesToRead.size} total files`);
    } else {
      // Look for specific file patterns in context
      const filePatterns = [
        /insights_curated_cycle_\d+[^"'\s]*/g,
        /[\w\-]+\.md/g,
        /[\w\-]+\.json/g
      ];
      
      for (const pattern of filePatterns) {
        const matches = context.match(pattern);
        if (matches) {
          matches.forEach(match => {
            // Add full path if not already there
            if (!match.includes('/')) {
              filesToRead.add(`runtime/coordinator/${match}`);
            } else {
              filesToRead.add(match);
            }
          });
        }
      }
    }
    
    if (filesToRead.size === 0) {
      return [];
    }
    
    this.logger?.info('');
    this.logger?.info(`📁 Reading ${filesToRead.size} files via MCP...`);
    
    for (const filePath of filesToRead) {
      try {
        const result = await this.client.callMCPTool('filesystem', 'read_file', {
          path: filePath
        });
        
        if (result.content && result.content[0]) {
          const data = JSON.parse(result.content[0].text);
          filesRead.push({
            path: filePath,
            filename: filePath.split('/').pop(),
            content: data.content,
            size: data.size,
            preview: data.content.substring(0, 500)
          });
          this.logger?.info(`   ✓ Read: ${filePath.split('/').pop()} (${data.size} bytes)`);
        }
      } catch (error) {
        this.logger?.warn(`   ✗ Failed to read: ${filePath} - ${error.message}`);
      }
    }
    
    if (filesRead.length > 0) {
      this.logger?.info(`✅ Read ${filesRead.length} files via MCP`);
    }
    
    return filesRead;
  }

  /**
   * Check if running in local LLM mode
   */
  isLocalLLMMode() {
    return this.config.providers?.local?.enabled ||
           process.env.LLM_BACKEND === 'local' ||
           this.config.modelAssignments?.default?.provider === 'local';
  }

  /**
   * Generate mission plan using LLM
   * Uses simplified prompt for local LLMs to improve JSON reliability
   */
  async generateMissionPlan(guidedFocus, resources, filesRead = [], taskPhases = []) {
    this.logger?.info('');
    this.logger?.info('🎯 Generating mission plan...');

    const isLocal = this.isLocalLLMMode();
    if (isLocal) {
      this.logger?.info('📍 Using simplified prompt for local LLM');
    }

    const prompt = isLocal
      ? this.buildSimplePlanningPrompt(guidedFocus, resources)
      : this.buildPlanningPrompt(guidedFocus, resources, filesRead, taskPhases);

    const systemMessage = isLocal
      ? 'You are a research planner. Output valid JSON only. No markdown, no explanation.'
      : 'You are a mission planner for a guided research task. Output structured JSON plans.';

    try {
      const response = await this.client.generate({
        model: this.config.coordinator?.model || this.config.models?.plannerModel || this.config.models?.primary || 'gpt-5-mini',
        reasoningEffort: isLocal ? 'low' : 'medium',
        maxTokens: isLocal ? 2000 : 8000,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ]
      });

      const content = response.content || response.message?.content || '';
      const plan = this.parsePlanFromResponse(content, guidedFocus);

      this.logger?.info('✅ Mission plan generated');
      this.logger?.info(`   Strategy: ${plan.strategy || 'unknown'}`);
      this.logger?.info(`   Agent missions: ${plan.agentMissions?.length || 0}`);
      this.logger?.info(`   Initial goals: ${plan.initialGoals?.length || 0}`);

      return plan;
    } catch (error) {
      this.logger?.error('Failed to generate mission plan', { error: error.message });
      return this.createFallbackPlan(guidedFocus, resources);
    }
  }

  /**
   * Build a SIMPLE planning prompt for local LLMs
   * Shorter, clearer, more likely to produce valid JSON
   */
  buildSimplePlanningPrompt(guidedFocus, resources) {
    const domain = guidedFocus.domain || 'research';
    const context = guidedFocus.context || '';
    const agentTypes = resources.agentTypes.slice(0, 3).join(', '); // Limit options

    return `Create a research plan for: "${domain}"
Context: ${context}

Available agent types: ${agentTypes}
Available tools: web_search

Return ONLY this JSON (no other text):
{
  "strategy": "brief description",
  "agentMissions": [
    {"type": "research", "mission": "what to research", "tools": ["web_search"], "priority": "high"},
    {"type": "research", "mission": "another topic", "tools": ["web_search"], "priority": "medium"}
  ],
  "initialGoals": ["goal 1", "goal 2"]
}`;
  }

  /**
   * Build the planning prompt
   */
  buildPlanningPrompt(guidedFocus, resources, filesRead = [], taskPhases = []) {
    // NEW: If task phases detected, include them in prompt
    const phasesInfo = taskPhases.length > 0
      ? `\n\nSTRUCTURED TASK PHASES DETECTED (${taskPhases.length} phases):\n` +
        taskPhases.map(p => `Phase ${p.number} - ${p.name}:\n${p.description}`).join('\n\n') +
        `\n\nNOTE: Goals have been generated for each phase. Your agent missions should align with these phases.`
      : '';
    const mcpToolsList = resources.mcp.tools.length > 0 
      ? `\n  MCP tools available: ${resources.mcp.tools.join(', ')}`
      : '\n  MCP tools: None';
    
    // If many files read, provide comprehensive structure for all agents
    const filesInfo = filesRead.length > 0
      ? `\n\nFILES DISCOVERED VIA MCP (${filesRead.length} files, ${filesRead.reduce((sum, f) => sum + (f.size || 0), 0)} bytes total):\n\n` +
        `COMPLETE FILE INVENTORY:\n${filesRead.map(f => `${f.path} (${f.size}b)`).join('\n')}\n\n` +
        `AGENT FILES FOUND:\n${filesRead.filter(f => f.path.includes('agents/') && f.path.endsWith('.js')).map(f => `- ${f.filename}`).join('\n')}\n\n` +
        `DOCUMENTATION FILES:\n${filesRead.filter(f => f.path.endsWith('.md')).map(f => `- ${f.path}`).join('\n')}\n\n` +
        `KEY CONTENT SAMPLES:\n${filesRead.filter(f => f.filename.match(/README|ARCHITECTURE|config\.yaml/i)).slice(0, 3).map(f => 
          `${f.filename} (${f.size}b):\n${f.content ? f.content.substring(0, 500) : f.preview}...`
        ).join('\n\n')}\n\n` +
        `CRITICAL FOR AGENT MISSIONS:\n` +
        `- Research agents: Use this file list to know what exists\n` +
        `- Code execution agents: Analyze THIS data (file counts, names) - do NOT access local filesystem\n` +
        `- Analysis/Synthesis agents: Reference these files in your work\n` +
        `All file contents are available via the planning context above.`
      : '';

    return `You are planning a guided research mission.${filesInfo}${phasesInfo}

TASK DEFINITION:
Domain: ${guidedFocus.domain}
Context: ${guidedFocus.context || 'None provided'}
Depth: ${guidedFocus.depth || 'normal'}

AVAILABLE RESOURCES:${mcpToolsList}
Web search: ${resources.webSearch ? 'Yes' : 'No'}
Code execution: ${resources.codeExecution ? 'Yes' : 'No'}
Agent types: ${resources.agentTypes.join(', ')}

WEB SEARCH: Available via MCP web_search tool (free, no API key needed)

YOUR JOB:
1. Understand what this task requires
2. Plan research missions that use web_search to gather current information
3. Create 2-4 specific agent missions with clear objectives
4. Define what success looks like
5. Suggest initial goals for the cognitive loop

OUTPUT FORMAT (JSON):
{
  "strategy": "one sentence description of approach",
  "requiredResources": ["web_search"],
  "spawnAgents": true/false,
  "agentMissions": [
    {
      "type": "${resources.agentTypes.join('|')}",
      "mission": "specific objective",
      "tools": ["tool_name"],
      "priority": "high|medium|low",
      "expectedOutput": "what this agent should produce"
    }
  ],
  "initialGoals": [
    "specific goal 1",
    "specific goal 2"
  ],
  "successCriteria": [
    "All documents in folder X read and analyzed",
    "Timeline document created with chronological order",
    "At least N major changes documented",
    "Output saved to runtime/outputs/filename.md"
  ],
  "deliverable": {
    "type": "markdown|html|json|pdf-style-md",
    "filename": "specific_output_filename.md",
    "location": "@outputs/",
    "accessibility": "mcp-required",
    "requiredSections": ["Executive Summary", "Analysis", "Conclusions"],
    "minimumContent": "Comprehensive report with at least 1000 words, including evidence and examples"
  }
}

Be specific and actionable.

AGENT TYPE SELECTION:
- Use "research" agent for gathering information via web search
- Use "analysis" or "synthesis" for processing and combining information
- Use "document_creation" for producing final reports and deliverables
ONLY use agent types from the available list above.`;
  }

  /**
   * Repair common JSON issues from local LLMs
   */
  repairJSON(jsonStr) {
    let repaired = jsonStr;

    // Remove trailing commas before ] or }
    repaired = repaired.replace(/,\s*]/g, ']');
    repaired = repaired.replace(/,\s*}/g, '}');

    // Fix unquoted keys (common LLM error)
    repaired = repaired.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // Fix single quotes to double quotes
    repaired = repaired.replace(/'/g, '"');

    // Remove control characters
    repaired = repaired.replace(/[\x00-\x1F\x7F]/g, ' ');

    // Fix common "true/false" issues - unquoted booleans are fine in JSON
    // But fix things like True/False (Python style)
    repaired = repaired.replace(/:\s*True\b/gi, ': true');
    repaired = repaired.replace(/:\s*False\b/gi, ': false');
    repaired = repaired.replace(/:\s*None\b/gi, ': null');

    return repaired;
  }

  /**
   * Parse plan from GPT response
   */
  parsePlanFromResponse(content, guidedFocus = null) {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
                     content.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      let jsonStr = jsonMatch[1];

      // Try parsing as-is first
      try {
        const plan = JSON.parse(jsonStr);
        return this.normalizePlan(plan, guidedFocus);
      } catch (e1) {
        // Try with JSON repair
        try {
          const repaired = this.repairJSON(jsonStr);
          this.logger?.debug('Attempting JSON repair', { original: jsonStr.substring(0, 100), repaired: repaired.substring(0, 100) });
          const plan = JSON.parse(repaired);
          this.logger?.info('✅ JSON repair successful');
          return this.normalizePlan(plan, guidedFocus);
        } catch (e2) {
          this.logger?.warn('Failed to parse plan JSON even after repair', {
            error: e2.message,
            jsonPreview: jsonStr.substring(0, 200)
          });
        }
      }
    }

    // JSON parsing failed - create a USEFUL fallback plan based on the task
    this.logger?.warn('⚠️ Creating smart fallback plan (LLM JSON was invalid)');
    return this.createSmartFallbackPlan(guidedFocus);
  }

  /**
   * Normalize plan object with defaults
   * Ensures required agent types are present for complete execution
   */
  normalizePlan(plan, guidedFocus) {
    const missions = plan.agentMissions || [];

    // Ensure document_creation is present - local LLMs often omit it
    const hasDocCreation = missions.some(m => m.type === 'document_creation');
    if (!hasDocCreation && missions.length > 0) {
      const domain = guidedFocus?.domain || plan.strategy || 'the research topic';
      const deliverable = plan.deliverable || {};
      const filename = deliverable.filename || 'guided_output.md';

      this.logger?.info('📝 Adding document_creation agent (required for deliverables)');
      missions.push({
        type: 'document_creation',
        mission: `Create a comprehensive report document on ${domain}. Synthesize all research findings into a well-structured markdown document with clear sections. Save as ${filename} in the outputs directory.`,
        tools: ['mcp_filesystem'],
        priority: 'high',
        expectedOutput: 'Complete markdown report document'
      });
    }

    return {
      strategy: plan.strategy || 'Execute guided task',
      requiredResources: plan.requiredResources || ['web_search'],
      spawnAgents: plan.spawnAgents !== false, // Default true
      agentMissions: missions,
      initialGoals: plan.initialGoals || [],
      successCriteria: plan.successCriteria || [],
      deliverable: plan.deliverable || {
        type: 'markdown',
        filename: 'guided_output.md',
        location: '@outputs/',
        accessibility: 'mcp-required',
        requiredSections: [],
        minimumContent: 'Task completion report'
      }
    };
  }

  /**
   * Create a smart fallback plan when JSON parsing fails
   * This ensures the system can still function with local LLMs
   */
  createSmartFallbackPlan(guidedFocus) {
    const domain = guidedFocus?.domain || 'research topic';
    const context = guidedFocus?.context || '';

    // Extract keywords from context for more targeted missions
    const keywords = context.split(/[,\s]+/).filter(k => k.length > 3).slice(0, 5);
    const keywordStr = keywords.length > 0 ? keywords.join(', ') : domain;

    this.logger?.info(`📋 Smart fallback: Creating research plan for "${domain}" with keywords: ${keywordStr}`);

    return {
      strategy: `Comprehensive web research on ${domain} covering ${keywordStr}`,
      requiredResources: ['web_search'],
      spawnAgents: true, // IMPORTANT: Actually spawn agents!
      agentMissions: [
        {
          type: 'research',
          mission: `Research current information about ${domain}. Focus on: ${keywordStr}. Use web_search to find recent articles, studies, and expert opinions.`,
          tools: ['web_search'],
          priority: 'high',
          expectedOutput: `Comprehensive research findings on ${domain}`
        },
        {
          type: 'research',
          mission: `Find practical applications, best practices, and real-world examples related to ${domain}. Search for case studies and expert recommendations.`,
          tools: ['web_search'],
          priority: 'medium',
          expectedOutput: 'Practical insights and actionable recommendations'
        },
        {
          type: 'synthesis',
          mission: `Synthesize all research findings into a coherent analysis of ${domain}. Identify key themes, trends, and insights.`,
          tools: [],
          priority: 'medium',
          expectedOutput: 'Synthesized analysis document'
        },
        {
          type: 'document_creation',
          mission: `Create a comprehensive report document on ${domain}. Include sections for: Overview, Research Findings, Key Insights, and Recommendations. Save as guided_output.md in the outputs directory.`,
          tools: ['mcp_filesystem'],
          priority: 'high',
          expectedOutput: 'Complete markdown report document'
        }
      ],
      initialGoals: [
        `Understand the current state of ${domain}`,
        `Identify key trends and developments in ${keywordStr}`,
        `Find actionable insights and recommendations`
      ],
      successCriteria: [
        'Web research completed with multiple sources',
        'Key findings documented',
        'Synthesis report generated'
      ],
      deliverable: {
        type: 'markdown',
        filename: 'guided_output.md',
        location: '@outputs/',
        accessibility: 'mcp-required',
        requiredSections: ['Overview', 'Research Findings', 'Key Insights', 'Recommendations'],
        minimumContent: `Comprehensive report on ${domain}`
      }
    };
  }

  /**
   * Create fallback plan if LLM call completely fails
   * Uses the smart fallback to ensure we still get a useful plan
   */
  createFallbackPlan(guidedFocus, resources) {
    this.logger?.warn('⚠️ LLM call failed completely, using smart fallback plan');
    return this.createSmartFallbackPlan(guidedFocus);
  }

  /**
   * Spawn initial agents based on missions
   * @param {Object} plan - The mission plan
   * @param {Array} missionGoalIds - Pre-generated goalIds for task→goal correlation
   */
  async spawnInitialAgents(plan, missionGoalIds = []) {
    if (!this.subsystems.agentExecutor) {
      this.logger?.warn('Agent executor not available, cannot spawn agents');
      return;
    }

    const agentMissions = plan.agentMissions || [];
    if (agentMissions.length === 0) {
      this.logger?.warn('No agent missions to spawn');
      return;
    }

    const deliverableSpec = plan.deliverable;

    this.logger?.info('');
    this.logger?.info('🤖 Organizing agents by dependency tiers...');
    
    // Classify missions by dependency tier
    const classified = this.classifyMissionsByTier(agentMissions);
    
    // Log tier organization
    this.logger?.info(`   Tier 0 (Data Collectors): ${classified.tier0.length} agents`);
    this.logger?.info(`   Tier 1 (Processors): ${classified.tier1.length} agents`);
    this.logger?.info(`   Tier 2 (Creators): ${classified.tier2.length} agents`);
    this.logger?.info(`   Tier 3 (Validators): ${classified.tier3.length} agents`);
    
    // Spawn ONLY Tier 0 initially
    this.logger?.info('');
    this.logger?.info(`🚀 Spawning Tier 0: ${classified.tier0.length} agent(s) with no dependencies`);
    const tier0Count = await this.spawnMissions(classified.tier0, deliverableSpec, missionGoalIds, 0);
    
    this.logger?.info(`   ✅ Spawned ${tier0Count} Tier 0 agent(s)`);
    
    // Store remaining tiers for sequential spawning via coordinator
    const pendingTiers = [];
    if (classified.tier1.length > 0) pendingTiers.push({ tier: 1, missions: classified.tier1 });
    if (classified.tier2.length > 0) pendingTiers.push({ tier: 2, missions: classified.tier2 });
    if (classified.tier3.length > 0) pendingTiers.push({ tier: 3, missions: classified.tier3 });
    
    if (pendingTiers.length > 0 && this.subsystems.clusterStateStore) {
      await this.subsystems.clusterStateStore.set('pending_agent_tiers', {
        tiers: pendingTiers,
        deliverableSpec: deliverableSpec,
        missionGoalIds: missionGoalIds,
        currentTierToSpawn: 1,
        createdAt: new Date().toISOString()
      });
      
      this.logger?.info(`   📦 ${pendingTiers.length} tier(s) queued for sequential spawning`);
      this.logger?.info('   ℹ️  Meta-coordinator will spawn subsequent tiers as dependencies complete');
    } else if (pendingTiers.length > 0) {
      this.logger?.warn('   ⚠️  No state store available - cannot persist pending tiers');
      this.logger?.warn('   ⚠️  All agents will spawn immediately (no tier ordering)');
      
      // Fallback: spawn all remaining tiers now
      for (const tierData of pendingTiers) {
        await this.spawnMissions(tierData.missions, deliverableSpec, missionGoalIds, tierData.tier);
      }
    }
  }

  /**
   * Classify agent missions by dependency tier
   * 
   * Tier 0: Data collectors - can work with empty memory
   * Tier 1: Processors - need source data in memory
   * Tier 2: Creators - need processed results
   * Tier 3: Validators - need created outputs
   */
  classifyMissionsByTier(missions) {
    const tiers = { tier0: [], tier1: [], tier2: [], tier3: [] };
    
    for (let i = 0; i < missions.length; i++) {
      const mission = missions[i];
      const type = mission.type;
      
      // Store original index for goal mapping
      const missionWithIndex = { ...mission, originalIndex: i };
      
      // Tier 0: Can work with empty memory (gather external data)
      if (['research', 'planning', 'exploration'].includes(type)) {
        tiers.tier0.push(missionWithIndex);
      }
      // Tier 1: Need source data in memory
      else if (['analysis', 'synthesis', 'document_analysis', 'code_execution'].includes(type)) {
        tiers.tier1.push(missionWithIndex);
      }
      // Tier 2: Need processed results
      else if (['document_creation', 'code_creation'].includes(type)) {
        tiers.tier2.push(missionWithIndex);
      }
      // Tier 3: Need created outputs
      else if (['integration', 'completion', 'quality_assurance', 'consistency'].includes(type)) {
        tiers.tier3.push(missionWithIndex);
      }
      // Unknown types default to Tier 1 (safe middle ground)
      else {
        this.logger?.warn(`Unknown agent type ${type}, assigning to Tier 1`);
        tiers.tier1.push(missionWithIndex);
      }
    }
    
    return tiers;
  }

  /**
   * Spawn all agents in a specific tier
   */
  async spawnMissions(missions, deliverableSpec, missionGoalIds, tierNumber) {
    const agentWeights = this.config.coordinator?.agentTypeWeights || {};
    let spawned = 0;
    
    for (const mission of missions) {
      // Check if type is enabled in configuration
      if (!(agentWeights[mission.type] > 0)) {
        this.logger?.warn(`   ⏭️  Skipping ${mission.type} (disabled in config)`);
        continue;
      }
      
      // Find pre-generated goalId for this mission
      const goalMapping = missionGoalIds.find(m => m.missionIdx === mission.originalIndex);
      const goalId = goalMapping?.goalId || `goal_guided_${mission.type}_${Date.now()}`;
      
      const missionSpec = {
        missionId: `mission_tier${tierNumber}_${mission.type}_${Date.now()}`,
        agentType: mission.type,
        goalId: goalId,
        description: mission.mission,
        successCriteria: mission.successCriteria || [mission.expectedOutput || 'Complete successfully'],
        deliverable: deliverableSpec,
        tools: mission.tools || [],
        maxDuration: getAgentTimeout(mission.type),
        createdBy: 'guided_mode_planner',
        spawnCycle: 0,
        triggerSource: 'guided_planner',
        spawningReason: `tier_${tierNumber}_setup`,
        priority: mission.priority === 'high' ? 1.0 : mission.priority === 'low' ? 0.3 : 0.6,
        provenanceChain: [],
        tier: tierNumber
      };
      
      try {
        this.logger?.info(`   Spawning: ${mission.type} - ${mission.mission.substring(0, 60)}...`);
        const agentId = await this.subsystems.agentExecutor.spawnAgent(missionSpec);
        if (agentId) {
          spawned++;
          this.logger?.info(`      ✓ ${agentId}`);

          // If we have a plan state store, record the assignment on the corresponding task
          // so PlanScheduler won't try to spawn a duplicate agent for the same task.
          const stateStore = this.subsystems.clusterStateStore;
          if (stateStore && Number.isInteger(mission.originalIndex)) {
            const taskId = `task:phase${mission.originalIndex + 1}`;
            try {
              const task = await stateStore.getTask(taskId);
              if (task && !task.assignedAgentId) {
                task.assignedAgentId = agentId;
                task.updatedAt = Date.now();
                if (!task.metadata) task.metadata = {};
                // Ensure goalId linkage is present and consistent
                if (!task.metadata.goalId) task.metadata.goalId = missionSpec.goalId || null;
                await stateStore.upsertTask(task);
              }
            } catch (e) {
              // Best-effort only; never fail guided spawn due to task bookkeeping
            }
          }
        }
      } catch (error) {
        this.logger?.error(`      ✗ Failed: ${error.message}`);
      }
    }
    
    return spawned;
  }

  /**
   * Parse structured task phases from guided context
   * Looks for patterns like:
   * "PHASE 1 - Discovery: Do X"
   * "PHASE 1 - Name:" (with description on next lines)
   * "═══ PHASE 3 - Synthesis ═══"
   * 
   * @param {string} context - The guided focus context
   * @returns {Array} Array of phase objects
   */
  parseTaskPhases(context) {
    if (!context) {
      return [];
    }

    const phases = [];

    // First try explicit PHASE markers
    const explicitPhases = this.parseExplicitPhases(context);

    // Then try natural language sequential patterns
    const sequentialPhases = this.parseSequentialPatterns(context);

    // Combine and deduplicate
    const allPhases = [...explicitPhases, ...sequentialPhases];
    const uniquePhases = this.deduplicatePhases(allPhases);

    // Build dependency chains
    const phasesWithDeps = this.buildDependencyChains(uniquePhases, context);

    this.logger?.info(`Parsed ${phasesWithDeps.length} task phases with dependencies`, {
      explicitPhases: explicitPhases.length,
      sequentialPhases: sequentialPhases.length,
      phases: phasesWithDeps.map(p => `Phase ${p.number}: ${p.name} (deps: ${p.dependencies?.length || 0})`)
    });

    return phasesWithDeps.sort((a, b) => a.number - b.number);
  }

  /**
   * Parse explicit PHASE markers (existing functionality)
   */
  parseExplicitPhases(context) {
    const phases = [];
    const lines = context.split('\n');
    let currentPhase = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Match: "PHASE 1 - Name:" or "PHASE 1: Name"
      const phaseMatch = line.match(/(?:═+\s*)?PHASE\s+(\d+)\s*[-:]\s*([^:]+):\s*$/i);

      if (phaseMatch) {
        // Save previous phase if exists
        if (currentPhase) {
          phases.push(currentPhase);
        }

        // Start new phase
        currentPhase = {
          number: parseInt(phaseMatch[1]),
          name: phaseMatch[2].trim(),
          description: '',
          lines: [],
          source: 'explicit_phase'
        };
      } else if (currentPhase && line && !line.match(/^[═\-#]+$/)) {
        // Add to current phase description
        currentPhase.lines.push(line);
      }
    }

    // Don't forget last phase
    if (currentPhase) {
      phases.push(currentPhase);
    }

    // Format descriptions
    phases.forEach(phase => {
      phase.description = phase.lines
        .slice(0, 5)
        .join(' ')
        .substring(0, 300);
      phase.rawText = phase.lines.join('\n').substring(0, 1000);
    });

    return phases;
  }

  /**
   * Parse natural language sequential patterns
   * Detects patterns like: "first research X, then document Y, then create Z"
   */
  parseSequentialPatterns(context) {
    const phases = [];

    // Pattern 1: "first X, then Y, then Z"
    const firstThenPattern = /(?:^|\.)\s*first(?:ly)?\s+([^,]+?),\s*then\s+([^,]+?)(?:,\s*then\s+([^,]+?))?(?:\s*\.|\s*$)/gi;
    let match;

    while ((match = firstThenPattern.exec(context)) !== null) {
      const [, first, second, third] = match;

      if (first) phases.push(this.createPhaseFromText(first.trim(), 1, 'first'));
      if (second) phases.push(this.createPhaseFromText(second.trim(), 2, 'then'));
      if (third) phases.push(this.createPhaseFromText(third.trim(), 3, 'then'));
    }

    // Pattern 2: "X and then Y"
    const andThenPattern = /(?:^|\.)\s*([^,]+?)\s+and\s+then\s+([^,]+?)(?:\s*\.|\s*$)/gi;

    while ((match = andThenPattern.exec(context)) !== null) {
      const [, first, second] = match;

      // Check if this overlaps with previous patterns
      const existingPhase = phases.find(p =>
        p.description.toLowerCase().includes(first.toLowerCase().substring(0, 50))
      );

      if (!existingPhase) {
        phases.push(this.createPhaseFromText(first.trim(), phases.length + 1, 'and_then'));
        phases.push(this.createPhaseFromText(second.trim(), phases.length + 2, 'and_then'));
      }
    }

    // Pattern 3: "after X, Y" or "following X, Y"
    const afterPattern = /(?:^|\.)\s*(?:after|following)\s+([^,]+?),\s*([^,]+?)(?:\s*\.|\s*$)/gi;

    while ((match = afterPattern.exec(context)) !== null) {
      const [, prerequisite, task] = match;

      phases.push(this.createPhaseFromText(prerequisite.trim(), phases.length + 1, 'prerequisite'));
      phases.push(this.createPhaseFromText(task.trim(), phases.length + 2, 'after'));
    }

    return phases;
  }

  /**
   * Create a phase object from text description
   */
  createPhaseFromText(text, number, pattern) {
    // Extract agent type hints from text
    const agentType = this.inferAgentType(text);

    return {
      number,
      name: this.extractPhaseName(text),
      description: text.substring(0, 300),
      rawText: text.substring(0, 1000),
      source: pattern,
      agentTypeHint: agentType,
      inferredDependencies: this.inferDependencies(text, pattern)
    };
  }

  /**
   * Extract a meaningful name from phase text
   */
  extractPhaseName(text) {
    // Look for action words or key phrases
    const nameMatch = text.match(/(?:create|build|generate|research|analyze|document|write|develop)\s+([^,\.;]+?)(?:\s|$)/i);
    if (nameMatch) {
      return nameMatch[1].trim();
    }

    // Fallback to first few words
    return text.split(/\s+/).slice(0, 3).join(' ').substring(0, 50);
  }

  /**
   * Infer agent type from phase description
   */
  inferAgentType(text) {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('research') || lowerText.includes('investigate') || lowerText.includes('study')) {
      return 'research';
    }
    if (lowerText.includes('document') || lowerText.includes('write') || lowerText.includes('create') && lowerText.includes('documentation')) {
      return 'document_creation';
    }
    if (lowerText.includes('code') || lowerText.includes('script') || lowerText.includes('application') || lowerText.includes('tool')) {
      return 'code_creation';
    }
    if (lowerText.includes('analyze') || lowerText.includes('examine') || lowerText.includes('study')) {
      return 'analysis';
    }

    return null; // No specific hint
  }

  /**
   * Infer dependencies from phase text and pattern
   */
  inferDependencies(text, pattern) {
    const dependencies = [];

    // Sequential patterns imply dependency on previous phase
    if (pattern === 'then' || pattern === 'after') {
      dependencies.push('previous');
    }

    // Look for prerequisite language
    if (text.toLowerCase().includes('based on') || text.toLowerCase().includes('using')) {
      dependencies.push('context_required');
    }

    return dependencies;
  }

  /**
   * Deduplicate phases and merge information
   */
  deduplicatePhases(phases) {
    const unique = [];

    for (const phase of phases) {
      // Check if we already have a similar phase
      const existing = unique.find(p =>
        p.description.toLowerCase().includes(phase.description.toLowerCase().substring(0, 50))
      );

      if (existing) {
        // Merge information
        if (phase.agentTypeHint && !existing.agentTypeHint) {
          existing.agentTypeHint = phase.agentTypeHint;
        }
        if (phase.inferredDependencies?.length && !existing.inferredDependencies?.length) {
          existing.inferredDependencies = phase.inferredDependencies;
        }
      } else {
        unique.push(phase);
      }
    }

    return unique;
  }

  /**
   * Build dependency chains between phases
   */
  buildDependencyChains(phases, originalContext) {
    // Assign sequential numbers and build dependencies
    return phases.map((phase, index) => {
      const sequentialNumber = index + 1;

      // Build dependency information
      const dependencies = [];

      // Sequential dependencies
      if (sequentialNumber > 1) {
        dependencies.push(`phase_${sequentialNumber - 1}`);
      }

      // Context dependencies
      if (phase.inferredDependencies?.includes('context_required')) {
        dependencies.push('context_available');
      }

      // Agent type dependencies
      if (phase.agentTypeHint === 'document_creation') {
        // Document creation typically needs research results
        dependencies.push('research_complete');
      }

      if (phase.agentTypeHint === 'code_creation') {
        // Code creation might need documentation or research
        dependencies.push('documentation_available');
      }

      return {
        ...phase,
        number: sequentialNumber,
        dependencies,
        dependencyType: this.determineDependencyType(phase, originalContext)
      };
    });
  }

  /**
   * Determine the type of dependency for a phase
   */
  determineDependencyType(phase, context) {
    if (phase.source === 'explicit_phase') {
      return 'explicit';
    }
    if (phase.source === 'first' || phase.source === 'then') {
      return 'sequential';
    }
    if (phase.source === 'after' || phase.source === 'prerequisite') {
      return 'prerequisite';
    }
    return 'contextual';
  }

  /**
   * Get directories to scan based on config allowedPaths
   * ALWAYS uses configuration from launch script - never extracts from text
   */
  getDirectoriesToScan(guidedFocus) {
    // PRIMARY METHOD: Use configured allowedPaths from launch script
    // This is what the user explicitly selected during setup
    const mcpServers = this.config?.mcp?.client?.servers;
    const allowedPaths = mcpServers?.[0]?.allowedPaths;
    
    if (allowedPaths && allowedPaths.length > 0) {
      this.logger?.info('📁 Using file access paths from launch configuration', { paths: allowedPaths });
      return allowedPaths.map(p => p.replace(/\/$/, '')); // Remove trailing slashes
    }

    // If no paths configured, system should not attempt file access
    // This indicates user selected "No file access" in launch script
    this.logger?.warn('⚠️ No file access paths configured');
    this.logger?.warn('💡 Use launch script and select "Custom directories" to configure file access');
    this.logger?.warn('💡 Falling back to external research only (no file reading)');
    
    return []; // Return empty array - don't access any files
  }

  /**
   * Generate high-priority goals from task phases
   * These goals will be injected with maximum priority
   * 
   * @param {Array} taskPhases - Parsed phases
   * @param {Object} guidedFocus - Guided focus config
   * @returns {Array} Goal objects ready for injection
   */
  generateTaskGoalsFromPhases(taskPhases, guidedFocus) {
    if (taskPhases.length === 0) {
      return [];
    }

    const executionMode = guidedFocus.executionMode || 'mixed';
    const taskPriority = guidedFocus.taskPriority || 1.0;

    return taskPhases.map((phase, index) => {
      // Create a goal for each phase with dependency information
      const goal = {
        description: `[TASK PHASE ${phase.number}] ${phase.name}: ${phase.description}`,
        source: 'guided_task_phase',
        priority: taskPriority,  // Maximum priority (default 1.0)
        isTaskGoal: true,
        phaseNumber: phase.number,
        totalPhases: taskPhases.length,
        executionMode,
        createdBy: 'guided_mode_planner',
        createdAt: new Date(),

        // NEW: Sequential workflow metadata
        sequentialDependencies: phase.dependencies || [],
        dependencyType: phase.dependencyType || 'contextual',
        agentTypeHint: phase.agentTypeHint,
        phaseSource: phase.source,

        // NEW: Execution control
        canExecuteAutonomously: this.canExecuteAutonomously(phase, taskPhases),
        requiresContextFrom: this.getRequiredContext(phase, taskPhases),

        // NEW: Progress tracking
        expectedDuration: this.estimatePhaseDuration(phase),
        checkpointRequirements: this.getCheckpointRequirements(phase)
      };

      return goal;
    });
  }

  /**
   * Determine if a phase can execute autonomously or needs dependencies
   */
  canExecuteAutonomously(phase, allPhases) {
    // First phase can always execute
    if (phase.number === 1) {
      return true;
    }

    // Check if dependencies are met
    if (phase.dependencies?.length > 0) {
      // If it has sequential dependencies, it needs previous phases to complete
      if (phase.dependencies.some(dep => dep.startsWith('phase_'))) {
        return false;
      }

      // If it has context dependencies, it can execute but will query for context
      if (phase.dependencies.includes('context_available')) {
        return true;
      }
    }

    return true;
  }

  /**
   * Get what context this phase requires from previous phases
   */
  getRequiredContext(phase, allPhases) {
    const requiredContext = [];

    if (phase.agentTypeHint === 'document_creation') {
      // Document creation needs research results
      const researchPhases = allPhases.filter(p =>
        p.agentTypeHint === 'research' && p.number < phase.number
      );
      if (researchPhases.length > 0) {
        requiredContext.push('research_findings');
      }
    }

    if (phase.agentTypeHint === 'code_creation') {
      // Code creation might need documentation or research
      const docPhases = allPhases.filter(p =>
        p.agentTypeHint === 'document_creation' && p.number < phase.number
      );
      if (docPhases.length > 0) {
        requiredContext.push('documentation_content');
      }

      const researchPhases = allPhases.filter(p =>
        p.agentTypeHint === 'research' && p.number < phase.number
      );
      if (researchPhases.length > 0) {
        requiredContext.push('research_specifications');
      }
    }

    return requiredContext;
  }

  /**
   * Estimate duration for a phase based on its characteristics
   */
  estimatePhaseDuration(phase) {
    const baseDuration = 10; // 10 minutes base

    // Adjust based on agent type
    switch (phase.agentTypeHint) {
      case 'research':
        return baseDuration + 5; // Research takes longer
      case 'document_creation':
        return baseDuration + 8; // Documentation takes time
      case 'code_creation':
        return baseDuration + 12; // Code creation can be complex
      case 'analysis':
        return baseDuration + 6; // Analysis is moderate
      default:
        return baseDuration;
    }
  }

  /**
   * Get checkpoint requirements for a phase
   */
  getCheckpointRequirements(phase) {
    const checkpoints = [];

    // All phases should have basic completion validation
    checkpoints.push('completion_validation');

    // High-impact phases need additional review
    if (phase.agentTypeHint === 'code_creation' && phase.description.toLowerCase().includes('deploy')) {
      checkpoints.push('deployment_review');
    }

    if (phase.dependencies?.includes('research_complete')) {
      checkpoints.push('research_validation');
    }

    return checkpoints;
  }

  /**
   * Inject task goals into goal system with appropriate priority
   * In 'mixed' mode: Task goals get high priority, autonomous still allowed
   * In 'strict' mode: Only task goals, autonomous suppressed
   * 
   * @param {Array} taskGoals - Goals generated from phases
   * @param {string} executionMode - strict/mixed/advisory
   */
  async injectTaskGoals(taskGoals, executionMode, guidedFocus) {
    this.logger?.info('');
    this.logger?.info('🎯 Injecting task goals into goal system...');
    
    for (const taskGoal of taskGoals) {
      try {
        // Use the addGoal method from intrinsic goal system
        const specializationTags = new Set();
        if (taskGoal.agentTypeHint) {
          specializationTags.add(String(taskGoal.agentTypeHint));
        }
        if (guidedFocus?.domain) {
          specializationTags.add(String(guidedFocus.domain));
        }

        const added = await this.subsystems.goals.addGoal({
          description: taskGoal.description,
          discoveredFrom: taskGoal.source,
          priority: taskGoal.priority,
          metadata: {
            isTaskGoal: true,
            phaseNumber: taskGoal.phaseNumber,
            totalPhases: taskGoal.totalPhases,
            executionMode: taskGoal.executionMode,
            injectedAt: new Date(),
            agentTypeHint: taskGoal.agentTypeHint || null,
            dependencyType: taskGoal.dependencyType || null,
            sequentialDependencies: Array.isArray(taskGoal.sequentialDependencies)
              ? [...taskGoal.sequentialDependencies]
              : [],
            requiresContextFrom: Array.isArray(taskGoal.requiresContextFrom)
              ? [...taskGoal.requiresContextFrom]
              : [],
            expectedDuration: taskGoal.expectedDuration || null,
            checkpointRequirements: Array.isArray(taskGoal.checkpointRequirements)
              ? [...taskGoal.checkpointRequirements]
              : [],
            guidedDomain: guidedFocus?.domain || null,
            guidedContextSnippet: guidedFocus?.context
              ? String(guidedFocus.context).slice(0, 240)
              : null,
            specializationTags: Array.from(specializationTags)
          }
        });
        
        if (added) {
          this.logger?.info(`   ✓ Task goal ${taskGoal.phaseNumber}/${taskGoal.totalPhases} injected with priority ${taskGoal.priority}`);
        }
      } catch (error) {
        this.logger?.warn(`Failed to inject task goal: ${error.message}`);
      }
    }
    
    // Set flag in goal system to prioritize task goals
    if (executionMode === 'strict') {
      this.logger?.info('   📌 STRICT MODE: Autonomous goal discovery will be disabled (100% task focus)');
    } else if (executionMode === 'mixed') {
      this.logger?.info('   📌 MIXED MODE: Task-primary with autonomous exploration (~85/15 split)');
    } else if (executionMode === 'advisory') {
      this.logger?.info('   📌 ADVISORY MODE: Task-aware autonomous exploration (~65/35 split)');
    }
    
    this.logger?.info('✅ Task goals injected successfully');
  }
}

module.exports = { GuidedModePlanner };
