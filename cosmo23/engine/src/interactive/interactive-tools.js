/**
 * InteractiveTools - Tool definitions and executors for the Interactive Session
 *
 * Provides brain inspection, file operations, terminal commands, agent spawning,
 * and system status tools. Each tool has an OpenAI function-calling definition
 * and an async execute(args, context) handler.
 *
 * Context shape:
 *   { orchestrator, runtimePath, logger }
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════════
// SAFETY
// ═══════════════════════════════════════════════════════════════════════

const BLOCKED_COMMAND_PATTERNS = [
  /rm\s+-rf?\s+[\/~]/,
  />\s*\/dev\//,
  /curl.*\|.*sh/,
  /wget.*\|.*sh/,
  /sudo\s+/,
  /chmod\s+777/,
  /mkfs\./,
  /:(){.*};:/   // fork bomb
];

function isCommandBlocked(cmd) {
  return BLOCKED_COMMAND_PATTERNS.some(pattern => pattern.test(cmd));
}

function isPathSafe(targetPath, runtimePath) {
  if (!runtimePath) return false;
  const resolved = path.resolve(targetPath);
  const base = path.resolve(runtimePath);
  return resolved.startsWith(base);
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (OpenAI function-calling format)
// ═══════════════════════════════════════════════════════════════════════

const tools = [
  // ─── Brain Tools ───────────────────────────────────────────────────

  {
    name: 'brain_query',
    description: 'Query the brain\'s knowledge graph semantically. Returns top matching memory nodes with concept and summary.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic search query' },
        limit: { type: 'number', description: 'Max results to return (default 10)' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },

  {
    name: 'brain_stats',
    description: 'Get brain statistics: node count, edge count, cluster count, cycle count, coherence score.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: 'brain_goals',
    description: 'List active research goals with priorities and descriptions.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: 'brain_plan',
    description: 'Get the current guided plan status including phases, tasks, and progress.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: 'brain_recent_thoughts',
    description: 'Get the last N journal entries (thoughts) from the orchestrator.',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of recent thoughts to return (default 10)' }
      },
      additionalProperties: false
    }
  },

  // ─── File Tools ────────────────────────────────────────────────────

  {
    name: 'read_file',
    description: 'Read a file\'s content. Path must be within the run directory. Capped at 100KB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the run directory' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },

  {
    name: 'write_file',
    description: 'Write content to a file in the outputs/ subdirectory of the run. Creates directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to outputs/ in the run directory' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },

  {
    name: 'list_directory',
    description: 'List directory contents within the run directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the run directory (default: root)' }
      },
      additionalProperties: false
    }
  },

  {
    name: 'search_files',
    description: 'Search for a text pattern in run files using grep.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text pattern to search for' },
        path: { type: 'string', description: 'Directory path relative to run directory to search in (default: root)' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },

  // ─── Terminal Tools ────────────────────────────────────────────────

  {
    name: 'run_command',
    description: 'Execute a shell command with a 30-second timeout. Dangerous commands (rm -rf /, sudo, etc.) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (relative to run dir, default: run root)' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },

  // ─── Agent Tools ───────────────────────────────────────────────────

  {
    name: 'spawn_agent',
    description: 'Spawn a COSMO research agent. Available types: research, analysis, synthesis, exploration, planning, integration, qualityassurance, ide, codecreation, codeexecution, codebaseexploration, documentcreation, documentanalysis.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Agent type (e.g., research, analysis, synthesis, exploration)' },
        description: { type: 'string', description: 'Mission description for the agent' },
        priority: { type: 'number', description: 'Priority level 1-10 (default 5)' }
      },
      required: ['type', 'description'],
      additionalProperties: false
    }
  },

  {
    name: 'check_agent',
    description: 'Get the status and results of a specific agent by ID.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to check' }
      },
      required: ['agent_id'],
      additionalProperties: false
    }
  },

  {
    name: 'list_agents',
    description: 'List active and recently completed agents.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  // ─── System Tools ──────────────────────────────────────────────────

  {
    name: 'get_run_status',
    description: 'Get current run status: cycle count, active agents, energy, coherence, memory size.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: 'get_executive_state',
    description: 'Get the executive ring (dlPFC) state and decision stats.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },

  {
    name: 'create_goal',
    description: 'Create a new research goal for the running engine to pursue. The engine picks this up within ~500ms.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the goal should accomplish' },
        priority: { type: 'number', description: 'Priority 0-1 (higher = more important). Default 0.8' }
      },
      required: ['description'],
      additionalProperties: false
    }
  },

  {
    name: 'refocus',
    description: 'Refocus the running engine on a new direction. Archives existing goals and clears pending agents.',
    parameters: {
      type: 'object',
      properties: {
        new_focus: { type: 'string', description: 'The new focus or direction for the run' },
        archive_goals: { type: 'boolean', description: 'Archive all existing goals (default true)' }
      },
      required: ['new_focus'],
      additionalProperties: false
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// TOOL EXECUTORS
// ═══════════════════════════════════════════════════════════════════════

const executors = {
  // ─── Brain Tools ───────────────────────────────────────────────────

  async brain_query(args, context) {
    const { orchestrator, logger } = context;
    const memory = orchestrator.memory;
    if (!memory) return 'Brain memory not available.';

    const limit = args.limit || 10;
    try {
      // If memory has a query method (live orchestrator), use it
      if (typeof memory.query === 'function') {
        const results = await memory.query(args.query, limit);
        if (!results || results.length === 0) {
          return `No results found for query: "${args.query}"`;
        }
        return results.map((node, i) => {
          const concept = node.concept || node.id || 'unknown';
          const summary = (node.summary || node.content || '').substring(0, 300);
          const score = node.score !== undefined ? ` (score: ${node.score.toFixed(3)})` : '';
          return `${i + 1}. [${concept}]${score}\n   ${summary}`;
        }).join('\n\n');
      }

      // Hydrated mode: keyword search across nodes (no embeddings available for cosine search)
      const queryTerms = args.query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const nodes = memory.nodes instanceof Map ? Array.from(memory.nodes.values()) : (memory.nodes || []);
      const scored = nodes.map(node => {
        const text = ((node.concept || '') + ' ' + (node.summary || '') + ' ' + (node.tag || '')).toLowerCase();
        const hits = queryTerms.filter(term => text.includes(term)).length;
        return { node, score: hits / (queryTerms.length || 1) };
      }).filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) {
        return `No results found for query: "${args.query}" (keyword search across ${nodes.length} nodes)`;
      }

      return scored.map((s, i) => {
        const concept = (s.node.concept || s.node.id || 'unknown').substring(0, 200);
        const summary = (s.node.summary || '').substring(0, 300);
        const tag = s.node.tag ? ` [${s.node.tag}]` : '';
        return `${i + 1}.${tag} (relevance: ${(s.score * 100).toFixed(0)}%)\n   ${concept}${summary ? '\n   Summary: ' + summary : ''}`;
      }).join('\n\n');
    } catch (err) {
      logger?.error('brain_query failed', { error: err.message });
      return `Error querying brain: ${err.message}`;
    }
  },

  async brain_stats(args, context) {
    const { orchestrator } = context;
    const memory = orchestrator.memory;
    const nodeCount = memory?.nodes?.size || 0;
    const edgeCount = memory?.edges?.size || 0;
    const clusterCount = memory?.clusters?.size || memory?.clusterCount || 0;
    const cycleCount = orchestrator.cycleCount || 0;
    const coherence = orchestrator.executiveRing?.getCoherenceScore?.();

    return JSON.stringify({
      nodes: nodeCount,
      edges: edgeCount,
      clusters: clusterCount,
      cycle: cycleCount,
      coherence: coherence !== undefined ? Number(coherence.toFixed(3)) : 'N/A'
    }, null, 2);
  },

  async brain_goals(args, context) {
    const { orchestrator, logger } = context;
    const goals = orchestrator.goals;
    if (!goals) return 'Goals subsystem not available.';

    try {
      // Support both live Goals class (getGoals method) and hydrated plain object
      let allGoals;
      if (typeof goals.getGoals === 'function') {
        allGoals = goals.getGoals();
      } else {
        // Hydrated mode: goals is { active: [], completed: [] }
        allGoals = [...(goals.active || []), ...(goals.completed || [])];
      }

      if (!allGoals || allGoals.length === 0) {
        return 'No goals found.';
      }
      return allGoals.map((g, i) => {
        const priority = g.priority !== undefined ? ` [priority: ${g.priority}]` : '';
        const progress = g.progress !== undefined ? ` (${Math.round(g.progress * 100)}%)` : '';
        const status = g.status ? ` status=${g.status}` : '';
        return `${i + 1}. ${g.description || g.id}${priority}${progress}${status}`;
      }).join('\n');
    } catch (err) {
      logger?.error('brain_goals failed', { error: err.message });
      return `Error listing goals: ${err.message}`;
    }
  },

  async brain_plan(args, context) {
    const { orchestrator, runtimePath, logger } = context;

    // Try live state store first
    const store = orchestrator.clusterStateStore;
    if (store && typeof store.get === 'function') {
      try {
        const plan = store.get('plan:main');
        if (plan) {
          const lines = [`Plan: ${plan.title || plan.id || 'main'} — Status: ${plan.status || 'unknown'}`];
          const allKeys = typeof store.keys === 'function' ? store.keys() : [];
          const milestones = allKeys.filter(k => k.startsWith('ms:'));
          const tasks = allKeys.filter(k => k.startsWith('task:'));
          for (const msKey of milestones) {
            const ms = store.get(msKey);
            if (!ms) continue;
            lines.push(`\n  Phase: ${ms.title || msKey} [${ms.status || '?'}]`);
            for (const tKey of tasks) {
              const task = store.get(tKey);
              if (!task) continue;
              if (task.milestoneId === msKey || task.phaseId === msKey) {
                const assignee = task.assignedAgent ? ` -> ${task.assignedAgent}` : '';
                lines.push(`    - ${task.title || tKey} [${task.status || '?'}]${assignee}`);
              }
            }
          }
          return lines.join('\n');
        }
      } catch { /* fall through to file-based approach */ }
    }

    // Hydrated mode: read plan from disk files
    if (!runtimePath) return 'Plan not available (no runtime path).';

    try {
      // Try guided-plan.md first (most readable)
      const guidedPlanPath = path.join(runtimePath, 'guided-plan.md');
      try {
        const content = await fs.readFile(guidedPlanPath, 'utf8');
        if (content.trim()) return content.substring(0, 3000);
      } catch { /* try next */ }

      // Try plans directory
      const plansDir = path.join(runtimePath, 'plans');
      try {
        const files = await fs.readdir(plansDir);
        const mdFiles = files.filter(f => f.endsWith('.md') || f.endsWith('.json')).sort().reverse();
        if (mdFiles.length > 0) {
          const content = await fs.readFile(path.join(plansDir, mdFiles[0]), 'utf8');
          return `Plan (${mdFiles[0]}):\n${content.substring(0, 3000)}`;
        }
      } catch { /* no plans dir */ }

      // Try guidedMissionPlan from hydrated state
      const plan = orchestrator.guidedMissionPlan;
      if (plan) {
        return JSON.stringify(plan, null, 2).substring(0, 3000);
      }

      return 'No active plan found.';
    } catch (err) {
      logger?.error('brain_plan failed', { error: err.message });
      return `Error reading plan: ${err.message}`;
    }
  },

  async brain_recent_thoughts(args, context) {
    const { orchestrator } = context;
    const journal = orchestrator.journal || [];
    const count = args.count || 10;
    const recent = journal.slice(-count);

    if (recent.length === 0) return 'No journal entries yet.';

    return recent.map((entry, i) => {
      const thought = entry.thought || entry.content || entry.message || JSON.stringify(entry);
      const time = entry.timestamp ? new Date(entry.timestamp).toISOString() : '';
      const cycle = entry.cycle !== undefined ? `[cycle ${entry.cycle}]` : '';
      return `${i + 1}. ${cycle} ${time}\n   ${String(thought).substring(0, 300)}`;
    }).join('\n\n');
  },

  // ─── File Tools ────────────────────────────────────────────────────

  async read_file(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Error: Run directory not configured.';

    const targetPath = path.resolve(runtimePath, args.path);
    if (!isPathSafe(targetPath, runtimePath)) {
      return `Error: Path "${args.path}" is outside the run directory.`;
    }

    try {
      const stat = await fs.stat(targetPath);
      if (stat.size > 100 * 1024) {
        return `Error: File is ${(stat.size / 1024).toFixed(1)}KB, exceeds 100KB limit. Use search_files for large files.`;
      }
      const content = await fs.readFile(targetPath, 'utf-8');
      return content;
    } catch (err) {
      if (err.code === 'ENOENT') return `File not found: ${args.path}`;
      logger?.error('read_file failed', { path: args.path, error: err.message });
      return `Error reading file: ${err.message}`;
    }
  },

  async write_file(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Error: Run directory not configured.';

    // Force writes to outputs/ subdirectory
    const targetPath = path.resolve(runtimePath, 'outputs', args.path);
    if (!isPathSafe(targetPath, runtimePath)) {
      return `Error: Path "${args.path}" resolves outside the run directory.`;
    }

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, args.content, 'utf-8');
      return `File written: outputs/${args.path} (${Buffer.byteLength(args.content, 'utf-8')} bytes)`;
    } catch (err) {
      logger?.error('write_file failed', { path: args.path, error: err.message });
      return `Error writing file: ${err.message}`;
    }
  },

  async list_directory(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Error: Run directory not configured.';

    const dirPath = path.resolve(runtimePath, args.path || '.');
    if (!isPathSafe(dirPath, runtimePath)) {
      return `Error: Path "${args.path}" is outside the run directory.`;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      if (entries.length === 0) return 'Directory is empty.';

      return entries.map(e => {
        const suffix = e.isDirectory() ? '/' : '';
        return `${e.name}${suffix}`;
      }).join('\n');
    } catch (err) {
      if (err.code === 'ENOENT') return `Directory not found: ${args.path || '.'}`;
      logger?.error('list_directory failed', { path: args.path, error: err.message });
      return `Error listing directory: ${err.message}`;
    }
  },

  async search_files(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Error: Run directory not configured.';

    const searchDir = path.resolve(runtimePath, args.path || '.');
    if (!isPathSafe(searchDir, runtimePath)) {
      return `Error: Path "${args.path}" is outside the run directory.`;
    }

    try {
      const result = execSync(
        `grep -rl --include="*.json" --include="*.md" --include="*.txt" --include="*.yaml" --include="*.yml" --include="*.js" --include="*.py" ${JSON.stringify(args.pattern)} ${JSON.stringify(searchDir)}`,
        { timeout: 15000, maxBuffer: 512 * 1024, encoding: 'utf-8' }
      );
      // Make paths relative to runtime
      const lines = result.trim().split('\n').filter(Boolean).map(p => path.relative(runtimePath, p));
      if (lines.length === 0) return `No matches found for "${args.pattern}"`;
      return `Found ${lines.length} file(s) matching "${args.pattern}":\n${lines.slice(0, 50).join('\n')}`;
    } catch (err) {
      // grep returns exit code 1 when no matches — not an error
      if (err.status === 1) return `No matches found for "${args.pattern}"`;
      logger?.error('search_files failed', { pattern: args.pattern, error: err.message });
      return `Error searching files: ${err.message}`;
    }
  },

  // ─── Terminal Tools ────────────────────────────────────────────────

  async run_command(args, context) {
    const { runtimePath, logger } = context;
    const cmd = args.command;

    if (isCommandBlocked(cmd)) {
      return `Error: Command blocked for safety. Blocked patterns include: rm -rf /, sudo, chmod 777, curl|sh, fork bombs.`;
    }

    const cwd = runtimePath && args.cwd
      ? path.resolve(runtimePath, args.cwd)
      : runtimePath || process.cwd();

    // If cwd is provided, verify it's within runtime path
    if (runtimePath && args.cwd && !isPathSafe(cwd, runtimePath)) {
      return `Error: Working directory "${args.cwd}" is outside the run directory.`;
    }

    try {
      const output = execSync(cmd, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        cwd
      });
      const trimmed = output.substring(0, 10000);
      return trimmed || '(command completed with no output)';
    } catch (err) {
      const stderr = err.stderr ? err.stderr.substring(0, 2000) : '';
      const stdout = err.stdout ? err.stdout.substring(0, 2000) : '';
      logger?.warn('run_command failed', { command: cmd, error: err.message });
      return `Command failed (exit ${err.status || 'unknown'}):\n${stderr || stdout || err.message}`;
    }
  },

  // ─── Agent Tools ───────────────────────────────────────────────────

  async spawn_agent(args, context) {
    const { orchestrator, runtimePath, logger } = context;

    // Try live executor first (if available)
    const executor = orchestrator.agentExecutor;
    if (executor && typeof executor.spawnAgent === 'function') {
      const type = args.type;
      const description = args.description;
      const priority = args.priority || 5;

      try {
        const goalId = `interactive_${Date.now()}`;
        const agentId = await executor.spawnAgent({
          type,
          description,
          goalId,
          agentType: type,
          successCriteria: [description],
          priority,
          mission: { description, goalId, successCriteria: [description] },
          metadata: { source: 'interactive_session' }
        });

        if (!agentId) {
          return `Agent spawn rejected (possible duplicate or concurrency limit). Type: ${type}`;
        }

        return `Agent spawned successfully.\n  ID: ${agentId}\n  Type: ${type}\n  Mission: ${description}`;
      } catch (err) {
        logger?.error('spawn_agent failed via executor', { type, error: err.message });
        return `Error spawning agent: ${err.message}`;
      }
    }

    // Hydrated mode: inject action into the engine's action queue
    // The engine polls actions-queue.json every 500ms
    if (!runtimePath) return 'Cannot spawn agent: no runtime path available.';

    const type = args.type;
    const description = args.description;
    const priority = args.priority || 5;

    try {
      const actionsPath = path.join(runtimePath, 'actions-queue.json');
      let actionsData = { actions: [] };
      try {
        const content = await fs.readFile(actionsPath, 'utf8');
        actionsData = JSON.parse(content);
        if (!actionsData.actions) actionsData.actions = [];
      } catch { /* file doesn't exist yet, start fresh */ }

      const actionId = `interactive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      actionsData.actions.push({
        actionId,
        type: 'spawn_agent',
        agentType: type,
        mission: description,
        priority,
        immediate: true,
        status: 'pending',
        source: 'interactive_session',
        createdAt: new Date().toISOString(),
        metadata: { source: 'interactive_session' }
      });

      await fs.writeFile(actionsPath, JSON.stringify(actionsData, null, 2));

      return `Agent spawn requested via action queue (engine picks up within ~500ms).\n  Action ID: ${actionId}\n  Type: ${type}\n  Mission: ${description}\n\nThe engine will spawn this agent on the next cycle. Use list_agents to check status.`;
      return `Agent spawned successfully.\n  ID: ${agentId}\n  Type: ${type}\n  Mission: ${description}`;
    } catch (err) {
      logger?.error('spawn_agent failed', { type, error: err.message });
      return `Error spawning agent: ${err.message}`;
    }
  },

  async check_agent(args, context) {
    const { orchestrator, runtimePath, logger } = context;
    const registry = orchestrator.agentExecutor?.registry;
    if (!registry || typeof registry.getAgent !== 'function') {
      // Hydrated mode: search agents.jsonl for this agent ID
      if (!runtimePath) return 'Agent registry not available.';
      try {
        const content = await fs.readFile(path.join(runtimePath, 'agents.jsonl'), 'utf8');
        const entries = content.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const matches = entries.filter(e => (e.agentId || e.id) === args.agent_id);
        if (matches.length === 0) return `Agent not found in history: ${args.agent_id}`;
        return JSON.stringify(matches[matches.length - 1], null, 2).substring(0, 3000);
      } catch {
        return `Agent registry not available and no agent history found.`;
      }
    }

    try {
      const agent = registry.getAgent?.(args.agent_id) || registry.get?.(args.agent_id);
      if (!agent) return `Agent not found: ${args.agent_id}`;

      const info = {
        id: agent.agentId || args.agent_id,
        type: agent.type || agent.agentType || 'unknown',
        status: agent.status || 'unknown',
        mission: agent.mission?.description || '',
        startTime: agent.startTime ? new Date(agent.startTime).toISOString() : 'N/A',
        endTime: agent.endTime ? new Date(agent.endTime).toISOString() : 'N/A'
      };

      // Include results summary if completed
      if (agent.results && agent.results.length > 0) {
        info.resultCount = agent.results.length;
        info.resultSample = agent.results.slice(0, 3).map(r =>
          (r.content || r.summary || JSON.stringify(r)).substring(0, 200)
        );
      }

      return JSON.stringify(info, null, 2);
    } catch (err) {
      logger?.error('check_agent failed', { agentId: args.agent_id, error: err.message });
      return `Error checking agent: ${err.message}`;
    }
  },

  async list_agents(args, context) {
    const { orchestrator, runtimePath } = context;

    // Try live registry first
    const registry = orchestrator.agentExecutor?.registry;
    if (registry && typeof registry.getActive === 'function') {
      try {
        const active = registry.getActive?.() || [];
        const completed = registry.getCompleted?.() || [];
        const lines = [];
        if (active.length > 0) {
          lines.push('=== Active Agents ===');
          for (const a of active.slice(0, 20)) {
            const type = a.type || a.agentType || '?';
            const desc = (a.mission?.description || '').substring(0, 80);
            lines.push(`  [${a.agentId || a.id}] ${type}: ${desc} (${a.status || 'running'})`);
          }
        }
        if (completed.length > 0) {
          lines.push('\n=== Recent Completed ===');
          for (const a of completed.slice(-10)) {
            const type = a.type || a.agentType || '?';
            const desc = (a.mission?.description || '').substring(0, 80);
            lines.push(`  [${a.agentId || a.id}] ${type}: ${desc} (${a.status || 'done'})`);
          }
        }
        return lines.join('\n') || 'No agents found.';
      } catch { /* fall through */ }
    }

    // Hydrated mode: read from agents.jsonl on disk
    if (!runtimePath) return 'Agent registry not available.';
    try {
      const agentsPath = path.join(runtimePath, 'agents.jsonl');
      const content = await fs.readFile(agentsPath, 'utf8');
      const entries = content.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      if (entries.length === 0) return 'No agents recorded in this run.';

      const recent = entries.slice(-20);
      const lines = [`=== Agent History (${entries.length} total, showing last ${recent.length}) ===`];
      for (const a of recent) {
        const type = a.type || a.agentType || '?';
        const desc = (a.description || a.mission?.description || '').substring(0, 80);
        const status = a.status || a.event || '?';
        lines.push(`  [${a.agentId || a.id || '?'}] ${type}: ${desc} (${status})`);
      }
      return lines.join('\n');
    } catch {
      return 'No agent history found for this run.';
    }
  },

  // ─── System Tools ──────────────────────────────────────────────────

  async get_run_status(args, context) {
    const { orchestrator } = context;
    const o = orchestrator;

    const status = {
      cycle: o.cycleCount || 0,
      running: o.running || false,
      memoryNodes: o.memory?.nodes?.size || 0,
      memoryEdges: o.memory?.edges?.size || 0,
      activeAgents: o.agentExecutor?.registry?.getActiveCount?.() || 0,
      energy: o.stateModulator?.cognitiveState?.energy,
      coherence: o.executiveRing?.getCoherenceScore?.(),
      sleeping: o.sleepSession?.active || false,
      domain: o.config?.architecture?.roleSystem?.guidedFocus?.domain || 'general'
    };

    // Round floats
    if (typeof status.energy === 'number') status.energy = Number(status.energy.toFixed(3));
    if (typeof status.coherence === 'number') status.coherence = Number(status.coherence.toFixed(3));

    return JSON.stringify(status, null, 2);
  },

  async get_executive_state(args, context) {
    const { orchestrator } = context;
    const ring = orchestrator.executiveRing;

    if (!ring) return 'Executive ring not initialized for this session.';

    try {
      if (typeof ring.getStats === 'function') {
        return JSON.stringify(ring.getStats(), null, 2);
      }
      // Hydrated mode: ring is plain JSON from state
      return JSON.stringify(ring, null, 2).substring(0, 3000);
    } catch (err) {
      return `Error reading executive state: ${err.message}`;
    }
  },

  // ─── Action Queue Tools (inject into running engine) ──────────────

  async create_goal(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Cannot create goal: no runtime path available.';

    try {
      const actionsPath = path.join(runtimePath, 'actions-queue.json');
      let actionsData = { actions: [] };
      try {
        const content = await fs.readFile(actionsPath, 'utf8');
        actionsData = JSON.parse(content);
        if (!actionsData.actions) actionsData.actions = [];
      } catch { /* start fresh */ }

      const actionId = `interactive_goal_${Date.now()}`;
      actionsData.actions.push({
        actionId,
        type: 'create_goal',
        description: args.description,
        priority: args.priority || 0.8,
        immediate: true,
        status: 'pending',
        source: 'interactive_session',
        createdAt: new Date().toISOString()
      });

      await fs.writeFile(actionsPath, JSON.stringify(actionsData, null, 2));
      return `Goal created via action queue (engine picks up within ~500ms).\n  Action ID: ${actionId}\n  Description: ${args.description}\n  Priority: ${args.priority || 0.8}`;
    } catch (err) {
      logger?.error('create_goal failed', { error: err.message });
      return `Error creating goal: ${err.message}`;
    }
  },

  async refocus(args, context) {
    const { runtimePath, logger } = context;
    if (!runtimePath) return 'Cannot refocus: no runtime path available.';

    try {
      const actionsPath = path.join(runtimePath, 'actions-queue.json');
      let actionsData = { actions: [] };
      try {
        const content = await fs.readFile(actionsPath, 'utf8');
        actionsData = JSON.parse(content);
        if (!actionsData.actions) actionsData.actions = [];
      } catch { /* start fresh */ }

      const actionId = `interactive_refocus_${Date.now()}`;
      actionsData.actions.push({
        actionId,
        type: 'refocus',
        immediate: true,
        status: 'pending',
        source: 'interactive_session',
        createdAt: new Date().toISOString(),
        payload: {
          newFocus: args.new_focus,
          archiveGoals: args.archive_goals !== false,
          clearPendingAgents: true
        }
      });

      await fs.writeFile(actionsPath, JSON.stringify(actionsData, null, 2));
      return `Refocus requested via action queue (engine picks up within ~500ms).\n  Action ID: ${actionId}\n  New focus: ${args.new_focus}\n  Archive existing goals: ${args.archive_goals !== false}`;
    } catch (err) {
      logger?.error('refocus failed', { error: err.message });
      return `Error refocusing: ${err.message}`;
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Execute a tool by name
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} context - { orchestrator, runtimePath, logger }
 * @returns {string} Result string
 */
async function executeTool(name, args, context) {
  const executor = executors[name];
  if (!executor) {
    return `Unknown tool: ${name}. Available tools: ${tools.map(t => t.name).join(', ')}`;
  }

  try {
    return await executor(args || {}, context);
  } catch (err) {
    context.logger?.error('Tool execution error', { tool: name, error: err.message, stack: err.stack });
    return `Tool "${name}" failed: ${err.message}`;
  }
}

module.exports = {
  tools,
  executeTool
};
