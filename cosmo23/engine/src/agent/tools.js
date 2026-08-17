'use strict';

/**
 * Research Launch harness. The model sees these tools and decides.
 * Interactive chat tools that spawn specialists or refocus the engine are excluded.
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { tools: interactiveTools, executeTool: executeInteractiveTool } = require('../interactive/interactive-tools');
const { unprivilegedChildEnv } = require('../../../../shared/child-process-env.cjs');

const INTERACTIVE_ONLY = new Set([
  'spawn_agent',
  'check_agent',
  'list_agents',
  'create_goal',
  'refocus',
  'get_executive_state'
]);

const extraTools = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'remember',
    description: 'Journal a candidate finding in this run. Brain changes at promotion, not here.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Finding to remember' },
        tag: { type: 'string', description: 'Optional memory tag (default: finding)' }
      },
      required: ['content'],
      additionalProperties: false
    }
  },
  {
    name: 'list_skills',
    description: 'List available Cosmo skills.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'run_skill',
    description: 'Run a Cosmo skill by id.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill id' },
        inputs: { type: 'object', description: 'Skill inputs' }
      },
      required: ['skill_id'],
      additionalProperties: false
    }
  },
  {
    name: 'coding_run',
    description: 'Home23-style coding backend. Runs Claude Code or Codex in the run directory when installed.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Coding task' },
        backend: { type: 'string', description: 'claude-code or codex (default: auto)' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'finish',
    description: 'Mark the research run complete after the deliverable is written.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was delivered and where' }
      },
      required: ['summary'],
      additionalProperties: false
    }
  }
];

const tools = [
  ...interactiveTools.filter((tool) => !INTERACTIVE_ONLY.has(tool.name)),
  ...extraTools
];

const extraExecutors = {
  async web_search(args, context) {
    const query = String(args.query || '').trim();
    if (!query) return 'web_search requires query.';

    const orchestrator = context.orchestrator;
    const mcp = orchestrator?.mcp || orchestrator?.agentExecutor?.mcp || context.mcp;
    if (mcp && typeof mcp.callTool === 'function') {
      try {
        const mcpResponse = await mcp.callTool('web_search', {
          query,
          maxResults: 10,
          allowDuckDuckGoFallback: true
        });
        const text = mcpResponse?.content?.[0]?.text;
        if (text) return text;
      } catch (err) {
        context.logger?.warn?.('web_search MCP failed, trying FreeWebSearch', { error: err.message });
      }
    }

    try {
      const { FreeWebSearch } = require('../tools/web-search-free');
      const searcher = new FreeWebSearch(context.logger, {
        searxngUrl: orchestrator?.config?.providers?.local?.searxngUrl
          || orchestrator?.config?.search?.searxngUrl
          || process.env.SEARXNG_URL,
        braveApiKey: orchestrator?.config?.search?.braveApiKey,
        allowDuckDuckGoFallback: true
      });
      const result = await searcher.search(query, { maxResults: 10 });
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return `web_search failed: ${err.message}`;
    }
  },

  async remember(args, context) {
    const content = String(args.content || '').trim();
    if (!content) return 'remember requires content.';
    const tag = String(args.tag || 'finding').trim() || 'finding';
    const runtimePath = context.runtimePath
      || context.orchestrator?.logsDir
      || process.cwd();
    const dir = path.join(runtimePath, 'outputs', 'candidates');
    await fs.mkdir(dir, { recursive: true });
    const entry = {
      type: 'candidate_finding',
      content,
      tag,
      at: Date.now(),
      source: 'launch_loop',
      promoted: false
    };
    await fs.appendFile(path.join(dir, 'findings.jsonl'), `${JSON.stringify(entry)}\n`);
    return 'Journaled candidate finding. Brain changes at promotion.';
  },

  async list_skills(args, context) {
    const registry = context.orchestrator?.skillRegistry;
    if (!registry?.skills) return 'No skill registry on this run.';
    const ids = Array.from(registry.skills.keys());
    if (ids.length === 0) return 'No skills loaded.';
    return ids.map((id) => {
      const skill = registry.skills.get(id);
      const summary = skill?.description || skill?.summary || '';
      return summary ? `${id}: ${summary}` : id;
    }).join('\n');
  },

  async run_skill(args, context) {
    const registry = context.orchestrator?.skillRegistry;
    if (!registry || typeof registry.invoke !== 'function') {
      return 'No skill registry on this run.';
    }
    const skillId = String(args.skill_id || '').trim();
    if (!skillId) return 'run_skill requires skill_id.';
    const runtimePath = context.runtimePath || context.orchestrator?.logsDir || process.cwd();
    const result = await registry.invoke(skillId, args.inputs || {}, {
      workingDir: runtimePath,
      runId: context.orchestrator?.runName || null
    });
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  },

  async coding_run(args, context) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return 'coding_run requires prompt.';
    const runtimePath = context.runtimePath || context.orchestrator?.logsDir || process.cwd();
    const requested = String(args.backend || 'auto').trim();
    const candidates = requested === 'codex'
      ? [{ id: 'codex', bin: 'codex', argv: ['exec', '--skip-git-repo-check', '-C', runtimePath, prompt] }]
      : requested === 'claude-code'
        ? [{ id: 'claude-code', bin: 'claude', argv: ['-p', '--dangerously-skip-permissions', prompt] }]
        : [
          { id: 'claude-code', bin: 'claude', argv: ['-p', '--dangerously-skip-permissions', prompt] },
          { id: 'codex', bin: 'codex', argv: ['exec', '--skip-git-repo-check', '-C', runtimePath, prompt] }
        ];

    for (const candidate of candidates) {
      const result = await runCodingBackend(candidate, runtimePath, context.logger);
      if (result.ran) return result.text;
    }
    return 'No coding backend installed (claude / codex). Use write_file and run_command instead.';
  },

  async finish(args, context) {
    const summary = String(args.summary || '').trim();
    if (context.loop && typeof context.loop.markFinished === 'function') {
      context.loop.markFinished(summary);
    }
    return summary ? `Research finished: ${summary}` : 'Research finished.';
  }
};

async function runCodingBackend(candidate, cwd, logger) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(candidate.bin, candidate.argv, {
      cwd,
      env: unprivilegedChildEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const chunks = [];
    const fail = (text) => {
      if (settled) return;
      settled = true;
      resolve({ ran: false, text });
    };
    const succeed = (text) => {
      if (settled) return;
      settled = true;
      resolve({ ran: true, text });
    };

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail(`${candidate.id} not installed`);
        return;
      }
      fail(`${candidate.id} failed: ${err.message}`);
    });
    child.stdout.on('data', (data) => chunks.push(data));
    child.stderr.on('data', (data) => chunks.push(data));
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8').slice(0, 20000);
      if (code === 0) {
        succeed(text || `${candidate.id} completed with no output.`);
        return;
      }
      succeed(`${candidate.id} exited ${code}\n${text}`.trim());
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      succeed(`${candidate.id} timed out after 10 minutes. Partial output:\n${Buffer.concat(chunks).toString('utf8').slice(0, 8000)}`);
    }, 10 * 60 * 1000);
    timer.unref?.();
    child.on('close', () => clearTimeout(timer));
  });
}

async function executeTool(name, args, context) {
  if (extraExecutors[name]) {
    try {
      return await extraExecutors[name](args || {}, context);
    } catch (err) {
      context.logger?.error?.('Research tool failed', { tool: name, error: err.message });
      return `Tool "${name}" failed: ${err.message}`;
    }
  }
  return executeInteractiveTool(name, args, context);
}

function toChatTools() {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

module.exports = {
  tools,
  executeTool,
  toChatTools,
  INTERACTIVE_ONLY
};
