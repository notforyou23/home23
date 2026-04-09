const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const lockfile = require('lockfile');

const gunzip = promisify(zlib.gunzip);
const lock = promisify(lockfile.lock);
const unlock = promisify(lockfile.unlock);

/**
 * MCP Bridge for Agents
 * 
 * Enables agents to access MCP tools for system introspection
 * 
 * Available Tools (13 total):
 * 
 * Core (8):
 * 1. get_system_state - Cycle count, cognitive state, memory/goal counts
 * 2. get_recent_thoughts - Recent thought stream
 * 3. query_memory - Search memory network
 * 4. get_active_goals - View goals by status
 * 5. get_agent_activity - Monitor agent missions
 * 6. get_coordinator_report - Latest strategic review
 * 7. get_memory_statistics - Network structure
 * 8. inject_topic - Add topics (WRITE OPERATION)
 * 
 * Extended (5):
 * 9. get_journal - Full thought journal
 * 10. get_oscillator_mode - Focus/explore/execute mode
 * 11. get_topic_queue - Topic queue status
 * 12. get_memory_graph - Complete network graph
 * 13. get_dreams - Sleep-generated insights
 */
class MCPBridge {
  constructor(logsDir, logger, clusterStateStore = null) {
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');
    this.logger = logger;
    this.clusterStateStore = clusterStateStore; // P3: Inject for plan/task queries
    
    // File paths
    this.stateFile = path.join(this.logsDir, 'state.json.gz');
    this.thoughtsFile = path.join(this.logsDir, 'thoughts.jsonl');
    this.topicsQueue = path.join(this.logsDir, 'topics-queue.json');
    this.topicsQueueLock = this.topicsQueue + '.lock';  // Lock file path
    this.coordinatorDir = path.join(this.logsDir, 'coordinator');
  }

  /**
   * Read compressed system state
   */
  async readSystemState() {
    try {
      const compressed = await fs.readFile(this.stateFile);
      const decompressed = await gunzip(compressed);
      return JSON.parse(decompressed.toString());
    } catch (error) {
      this.logger?.warn?.('Failed to read system state', { error: error.message });
      return null;
    }
  }

  /**
   * Tool 1: get_system_state
   * Returns: cycle, cognitiveState, mode, memory stats, goal counts
   */
  async get_system_state() {
    const state = await this.readSystemState();
    if (!state) return null;

    return {
      cycle: state.cycleCount || 0,
      cognitiveState: state.cognitiveState || {},
      mode: state.currentMode || 'focus',
      memory: {
        totalNodes: state.memory?.nodes?.length || 0,
        totalEdges: state.memory?.edges?.length || 0,
        clusters: state.memory?.clusters?.length || 0,
      },
      goals: {
        active: state.goals?.active?.length || 0,
        completed: state.goals?.completed?.length || 0,
        archived: state.goals?.archived?.length || 0,
      },
      journal: {
        totalEntries: state.journal?.length || 0,
      },
      agents: state.activeAgents || [],
    };
  }

  /**
   * Tool 2: get_recent_thoughts
   */
  async get_recent_thoughts(limit = 20) {
    try {
      const content = await fs.readFile(this.thoughtsFile, 'utf-8');
      const lines = content.trim().split('\n');
      const thoughts = lines.slice(-Math.min(limit, 100)).map(line => JSON.parse(line));
      return {
        count: thoughts.length,
        thoughts: thoughts.reverse() // Most recent first
      };
    } catch (error) {
      this.logger?.warn?.('Failed to read thoughts', { error: error.message });
      return { count: 0, thoughts: [] };
    }
  }

  /**
   * Tool 3: query_memory
   * Simple keyword-based search (agents can also use this.memory.query for embedding-based)
   */
  async query_memory(query, limit = 10) {
    const state = await this.readSystemState();
    
    if (!state?.memory?.nodes || state.memory.nodes.length === 0) {
      return { query, resultsFound: 0, totalNodes: 0, results: [] };
    }
    
    const queryWords = query.toLowerCase().split(/\s+/);
    
    const scored = state.memory.nodes.map(node => {
      const conceptLower = (node.concept || '').toLowerCase();
      let score = 0;
      
      queryWords.forEach(word => {
        if (conceptLower.includes(word)) {
          score += 1;
        }
      });
      
      score *= (node.activation || 0.5) * (node.weight || 0.5);
      
      return { ...node, score };
    });
    
    const results = scored
      .filter(n => n.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ score, concept, tag, activation, weight, accessCount, cluster }) => ({
        concept: concept.substring(0, 200),
        tag,
        activation: activation?.toFixed(3),
        weight: weight?.toFixed(3),
        accessCount,
        cluster,
        relevanceScore: score.toFixed(3)
      }));
    
    return {
      query,
      resultsFound: results.length,
      totalNodes: state.memory.nodes.length,
      results
    };
  }

  /**
   * Tool 4: get_active_goals
   */
  async get_active_goals(status = 'active', limit = 20) {
    const state = await this.readSystemState();
    if (!state?.goals) return { filter: status, count: 0, goals: [] };

    let goals = [];
    if (status === 'all') {
      goals = [
        ...(state.goals.active || []).map(g => ({ ...g, status: 'active' })),
        ...(state.goals.completed || []).map(g => ({ ...g, status: 'completed' })),
        ...(state.goals.archived || []).map(g => ({ ...g, status: 'archived' })),
      ];
    } else {
      goals = (state.goals[status] || []).map(g => ({ ...g, status }));
    }

    goals = goals
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, limit)
      .map(g => ({
        id: g.id,
        description: g.description,
        status: g.status,
        priority: g.priority?.toFixed(3),
        progress: g.progress?.toFixed(3),
        pursuitCount: g.pursuitCount,
        source: g.source,
        reason: g.reason,
      }));

    return { filter: status, count: goals.length, goals };
  }

  /**
   * Tool 5: get_agent_activity
   */
  async get_agent_activity() {
    const state = await this.readSystemState();
    return {
      activeAgents: state?.activeAgents || [],
      recentMissions: state?.agentHistory?.slice(-10) || [],
      agentStats: state?.agentStats || {},
    };
  }

  /**
   * Tool 6: get_coordinator_report
   */
  async get_coordinator_report() {
    try {
      const files = await fs.readdir(this.coordinatorDir);
      const reviewFiles = files
        .filter(f => f.startsWith('review_') && f.endsWith('.md'))
        .sort()
        .reverse();
      
      if (reviewFiles.length === 0) {
        return { report: 'No coordinator reports found yet.' };
      }
      
      const latestFile = path.join(this.coordinatorDir, reviewFiles[0]);
      const content = await fs.readFile(latestFile, 'utf-8');
      
      return {
        filename: reviewFiles[0],
        content,
        totalReports: reviewFiles.length
      };
    } catch (error) {
      this.logger?.warn?.('Failed to read coordinator report', { error: error.message });
      return { error: error.message };
    }
  }

  /**
   * Tool 7: get_memory_statistics
   */
  async get_memory_statistics() {
    const state = await this.readSystemState();
    const memory = state?.memory || { nodes: [], edges: [] };

    const stats = {
      totalNodes: memory.nodes?.length || 0,
      totalEdges: memory.edges?.length || 0,
      clusters: memory.clusters?.length || 0,
      nodesByTag: {},
      averageActivation: 0,
      averageWeight: 0,
      mostAccessedNodes: [],
      highestActivationNodes: [],
    };

    if (memory.nodes && memory.nodes.length > 0) {
      // Group by tag
      memory.nodes.forEach(node => {
        const tag = node.tag || 'unknown';
        stats.nodesByTag[tag] = (stats.nodesByTag[tag] || 0) + 1;
      });

      // Averages
      const totalActivation = memory.nodes.reduce((sum, n) => sum + (n.activation || 0), 0);
      const totalWeight = memory.nodes.reduce((sum, n) => sum + (n.weight || 0), 0);
      stats.averageActivation = (totalActivation / memory.nodes.length).toFixed(3);
      stats.averageWeight = (totalWeight / memory.nodes.length).toFixed(3);

      // Most accessed
      stats.mostAccessedNodes = memory.nodes
        .sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0))
        .slice(0, 5)
        .map(n => ({
          concept: n.concept?.substring(0, 100),
          accessCount: n.accessCount,
          activation: n.activation?.toFixed(3),
        }));

      // Highest activation
      stats.highestActivationNodes = memory.nodes
        .sort((a, b) => (b.activation || 0) - (a.activation || 0))
        .slice(0, 5)
        .map(n => ({
          concept: n.concept?.substring(0, 100),
          activation: n.activation?.toFixed(3),
          weight: n.weight?.toFixed(3),
        }));
    }

    return stats;
  }

  /**
   * Tool 8: inject_topic (WRITE OPERATION with file locking)
   * Prevents race conditions when multiple agents inject topics simultaneously
   */
  async inject_topic(topic, priority = 'medium', context = '', depth = 'moderate') {
    if (!topic || typeof topic !== 'string') {
      throw new Error('topic is required and must be a string');
    }

    // Acquire lock (wait up to 10 seconds, retry 5 times)
    try {
      await lock(this.topicsQueueLock, {
        wait: 10000,      // Wait up to 10 seconds
        retries: 5,       // Retry 5 times
        stale: 30000      // Consider lock stale after 30 seconds
      });
    } catch (error) {
      throw new Error(`Could not acquire lock for topics queue: ${error.message}`);
    }

    try {
      // Read current queue
      let topicsData;
      try {
        const content = await fs.readFile(this.topicsQueue, 'utf-8');
        topicsData = JSON.parse(content);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist, create empty queue
          topicsData = { topics: [] };
        } else {
          throw error;
        }
      }

      // Create new topic
      const newTopic = {
        topic: topic.trim(),
        priority: priority.toLowerCase(),
        context: context ? String(context).trim().substring(0, 2000) : '',
        depth: depth || 'moderate',
        injectedAt: new Date().toISOString(),
        source: 'agent_bridge',
      };

      // Add to queue
      topicsData.topics = topicsData.topics || [];
      topicsData.topics.push(newTopic);

      // Atomic write: temp file + rename
      const tmpPath = `${this.topicsQueue}.tmp.${process.pid}`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify(topicsData, null, 2),
        'utf-8'
      );
      await fs.rename(tmpPath, this.topicsQueue);

      this.logger?.debug?.('Topic injected with file locking', {
        topic: newTopic.topic,
        queueLength: topicsData.topics.length
      });

      return {
        success: true,
        message: 'Topic injected successfully',
        topic: newTopic,
        queueLength: topicsData.topics.length,
      };
    } catch (error) {
      this.logger?.error?.('Failed to inject topic', { error: error.message });
      throw error;
    } finally {
      // ALWAYS release lock
      try {
        await unlock(this.topicsQueueLock);
      } catch (error) {
        this.logger?.warn?.('Failed to release lock', { error: error.message });
      }
    }
  }

  /**
   * Tool 9: get_journal
   */
  async get_journal(limit = 20) {
    const state = await this.readSystemState();
    const journal = state?.journal || [];
    
    return {
      count: journal.length,
      entries: journal.slice(-Math.min(limit, 100)).reverse()
    };
  }

  /**
   * Tool 10: get_oscillator_mode
   */
  async get_oscillator_mode() {
    const state = await this.readSystemState();
    const oscillator = state?.oscillator || {};

    return {
      currentMode: oscillator.currentMode || 'focus',
      timeRemaining: oscillator.timeRemaining || 0,
      cycleCount: oscillator.cycleCount || 0,
      explorationProductivity: oscillator.explorationProductivity || 0,
      stats: oscillator.stats || {}
    };
  }

  /**
   * Tool 11: get_topic_queue
   */
  async get_topic_queue() {
    try {
      const content = await fs.readFile(this.topicsQueue, 'utf-8');
      const data = JSON.parse(content);
      
      return {
        pending: data.topics?.length || 0,
        topics: data.topics || []
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { pending: 0, topics: [] };
      }
      throw error;
    }
  }

  /**
   * Tool 12: get_memory_graph
   * Returns complete memory network for visualization
   */
  async get_memory_graph(limit = 200) {
    const state = await this.readSystemState();
    const memory = state?.memory || { nodes: [], edges: [], clusters: [] };

    const nodes = limit === 0 ? memory.nodes : memory.nodes?.slice(0, limit) || [];
    
    return {
      nodes: nodes.map(n => ({
        id: n.id,
        concept: n.concept,
        tag: n.tag,
        activation: n.activation,
        weight: n.weight,
        cluster: n.cluster,
        accessCount: n.accessCount
      })),
      edges: memory.edges || [],
      clusters: memory.clusters || [],
      stats: {
        totalNodes: memory.nodes?.length || 0,
        returnedNodes: nodes.length,
        totalEdges: memory.edges?.length || 0,
        totalClusters: memory.clusters?.length || 0
      }
    };
  }

  /**
   * Tool 13: get_dreams
   * Returns dreams generated during sleep cycles
   */
  async get_dreams(limit = 20) {
    try {
      const content = await fs.readFile(this.thoughtsFile, 'utf-8');
      const lines = content.trim().split('\n');
      const allThoughts = lines.map(line => JSON.parse(line));
      
      // Filter for dreams (thoughts during sleep/dream mode)
      const dreams = allThoughts.filter(t => 
        t.oscillatorMode === 'dream' || 
        t.role === 'dreamer' ||
        t.isDream === true
      );

      return {
        count: dreams.length,
        dreams: dreams.slice(-Math.min(limit, 100)).reverse()
      };
    } catch (error) {
      this.logger?.warn?.('Failed to read dreams', { error: error.message });
      return { count: 0, dreams: [] };
    }
  }

  /**
   * Helper: Check if system already knows about a topic
   * Returns similarity score and related concepts
   */
  async checkExistingKnowledge(topic, threshold = 3) {
    const memoryResults = await this.query_memory(topic, threshold);
    
    return {
      hasKnowledge: memoryResults.resultsFound > 0,
      relevantNodes: memoryResults.resultsFound,
      topMatches: memoryResults.results,
      recommendation: memoryResults.resultsFound >= threshold
        ? 'Substantial existing knowledge - consider refining or building on it'
        : 'Novel territory - proceed with research'
    };
  }

  /**
   * Helper: Check if goal is already being pursued
   */
  async checkGoalStatus(description) {
    const goals = await this.get_active_goals('all', 100);
    
    const related = goals.goals.filter(g => 
      g.description.toLowerCase().includes(description.toLowerCase()) ||
      description.toLowerCase().includes(g.description.toLowerCase())
    );

    return {
      isBeingPursued: related.some(g => g.status === 'active'),
      relatedGoals: related,
      recommendation: related.length > 0
        ? `Found ${related.length} related goal(s) - consider coordinating`
        : 'No related goals - unique pursuit'
    };
  }

  /**
   * Helper: Get strategic context from coordinator
   */
  async getStrategicContext() {
    const report = await this.get_coordinator_report();
    if (!report || !report.content) return null;

    // Extract key sections from markdown
    const content = report.content;
    const sections = {
      priorities: this.extractSection(content, 'Prioritized Goals') || 
                   this.extractSection(content, 'Strategic Priorities'),
      recommendations: this.extractSection(content, 'Strategic Recommendations') ||
                        this.extractSection(content, 'Action Plan'),
      concerns: this.extractSection(content, 'Concerns') ||
                 this.extractSection(content, 'Issues'),
    };

    return {
      reviewCycle: report.filename.match(/review_(\d+)/)?.[1],
      ...sections,
      fullReport: content
    };
  }

  /**
   * Helper: Extract section from markdown
   */
  extractSection(content, heading) {
    const regex = new RegExp(`##\\s+${heading}[\\s\\S]*?(?=##|$)`, 'i');
    const match = content.match(regex);
    return match ? match[0] : null;
  }

  /**
   * Helper: Check what other agents are doing
   */
  async checkAgentActivity() {
    const activity = await this.get_agent_activity();
    
    return {
      activeCount: activity.activeAgents?.length || 0,
      activeTypes: activity.activeAgents?.map(a => a.type) || [],
      recentTypes: activity.recentMissions?.map(m => m.type) || [],
      successRate: activity.agentStats?.successRate || 0,
      recommendation: activity.activeCount >= 3
        ? 'System busy - consider waiting or coordinating'
        : 'Capacity available'
    };
  }

  /**
   * Helper: Get oscillator state (focus/explore/execute)
   */
  async getCurrentMode() {
    const mode = await this.get_oscillator_mode();
    
    return {
      mode: mode.currentMode,
      isExecuteMode: mode.currentMode === 'execute',
      isFocusMode: mode.currentMode === 'focus',
      isExploreMode: mode.currentMode === 'explore',
      productivity: mode.explorationProductivity,
      timeRemaining: mode.timeRemaining
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // P3: NEW COORDINATION TOOLS (14-19) - Plan/Task Queries for Agent Swarm
  // ═══════════════════════════════════════════════════════════════════════════
  
  /**
   * Tool 14: get_current_plan
   * Returns: Active plan structure with milestones and status
   */
  async get_current_plan(planId = 'plan:main') {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const plan = await this.clusterStateStore.getPlan(planId);
      if (!plan) {
        return { error: `Plan ${planId} not found` };
      }
      
      return {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        milestones: plan.milestones || [],
        activeMilestone: plan.activeMilestone,
        version: plan.version,
        createdAt: plan.createdAt
      };
    } catch (error) {
      this.logger?.warn?.('get_current_plan failed', { error: error.message });
      return { error: error.message };
    }
  }
  
  /**
   * Tool 15: get_task
   * Returns: Specific task details including dependencies and state
   */
  async get_task(taskId) {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const task = await this.clusterStateStore.getTask(taskId);
      if (!task) {
        return { error: `Task ${taskId} not found` };
      }
      
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        state: task.state,
        planId: task.planId,
        milestoneId: task.milestoneId,
        dependencies: task.deps || [],
        assignedAgent: task.assignedAgentId,
        priority: task.priority,
        artifacts: task.artifacts || [],
        acceptanceCriteria: task.acceptanceCriteria || []
      };
    } catch (error) {
      this.logger?.warn?.('get_task failed', { error: error.message });
      return { error: error.message };
    }
  }
  
  /**
   * Tool 16: list_phase_tasks
   * Returns: All tasks in a milestone/phase
   */
  async list_phase_tasks(milestoneId, planId = 'plan:main') {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const tasks = await this.clusterStateStore.listTasks(planId, { milestoneId });
      
      return {
        milestoneId,
        taskCount: tasks.length,
        tasks: tasks.map(t => ({
          id: t.id,
          title: t.title,
          state: t.state,
          assignedTo: t.assignedAgentId,
          priority: t.priority
        }))
      };
    } catch (error) {
      this.logger?.warn?.('list_phase_tasks failed', { error: error.message });
      return { error: error.message };
    }
  }
  
  /**
   * Tool 17: get_task_dependencies
   * Returns: Tasks that this task depends on (predecessors)
   */
  async get_task_dependencies(taskId) {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const task = await this.clusterStateStore.getTask(taskId);
      if (!task) {
        return { error: `Task ${taskId} not found` };
      }
      
      if (!task.deps || task.deps.length === 0) {
        return { taskId, dependencies: [] };
      }
      
      const deps = await Promise.all(
        task.deps.map(id => this.clusterStateStore.getTask(id))
      );
      
      return {
        taskId,
        dependencyCount: deps.length,
        dependencies: deps.filter(Boolean).map(d => ({
          id: d.id,
          title: d.title,
          state: d.state,
          completed: d.state === 'DONE'
        }))
      };
    } catch (error) {
      this.logger?.warn?.('get_task_dependencies failed', { error: error.message });
      return { error: error.message };
    }
  }
  
  /**
   * Tool 18: get_phase_agents
   * Returns: Agents working on tasks in this phase
   */
  async get_phase_agents(milestoneId, planId = 'plan:main') {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const tasks = await this.clusterStateStore.listTasks(planId, { milestoneId });
      const agents = tasks
        .filter(t => t.assignedAgentId)
        .map(t => ({
          agentId: t.assignedAgentId,
          taskId: t.id,
          taskTitle: t.title,
          taskState: t.state
        }));
      
      return {
        milestoneId,
        agentCount: agents.length,
        agents
      };
    } catch (error) {
      this.logger?.warn?.('get_phase_agents failed', { error: error.message });
      return { error: error.message };
    }
  }
  
  /**
   * Tool 19: get_my_coordination_context
   * Returns: Full coordination context for an agent's task
   * This is the "one-stop-shop" for agents to understand their work context
   */
  async get_my_coordination_context(taskId) {
    if (!this.clusterStateStore) {
      return { error: 'ClusterStateStore not available' };
    }
    
    try {
      const task = await this.clusterStateStore.getTask(taskId);
      if (!task) {
        return { error: `Task ${taskId} not found` };
      }
      
      const plan = await this.clusterStateStore.getPlan(task.planId);
      const milestones = await this.clusterStateStore.listMilestones(task.planId);
      const milestone = milestones.find(m => m.id === task.milestoneId);
      const phaseTasks = await this.clusterStateStore.listTasks(task.planId, { 
        milestoneId: task.milestoneId 
      });
      
      const deps = task.deps && task.deps.length > 0
        ? await Promise.all(task.deps.map(id => this.clusterStateStore.getTask(id)))
        : [];
      
      const siblings = phaseTasks.filter(t => 
        t.assignedAgentId && 
        t.assignedAgentId !== task.assignedAgentId &&
        (t.state === 'IN_PROGRESS' || t.state === 'CLAIMED')
      );
      
      return {
        myTask: {
          id: task.id,
          title: task.title,
          state: task.state,
          description: task.description
        },
        plan: {
          id: plan.id,
          title: plan.title,
          status: plan.status
        },
        phase: {
          id: milestone?.id,
          title: milestone?.title,
          order: milestone?.order,
          status: milestone?.status
        },
        dependencies: deps.filter(Boolean).map(d => ({
          id: d.id,
          title: d.title,
          state: d.state,
          ready: d.state === 'DONE'
        })),
        siblings: siblings.map(s => ({
          agentId: s.assignedAgentId,
          taskId: s.id,
          taskTitle: s.title,
          working: s.description.substring(0, 100)
        })),
        coordination: {
          allDependenciesMet: deps.length === 0 || deps.every(d => d.state === 'DONE'),
          siblingsCount: siblings.length,
          phaseTotalTasks: phaseTasks.length,
          phaseCompletedTasks: phaseTasks.filter(t => t.state === 'DONE').length
        }
      };
    } catch (error) {
      this.logger?.warn?.('get_my_coordination_context failed', { error: error.message });
      return { error: error.message };
    }
  }
}

module.exports = { MCPBridge };

