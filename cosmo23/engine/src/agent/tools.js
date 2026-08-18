'use strict';

/**
 * Research Launch harness. The model sees these tools and decides.
 * Interactive chat tools that spawn specialists or refocus the engine are excluded.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { tools: interactiveTools, executeTool: executeInteractiveTool } = require('../interactive/interactive-tools');
const { unprivilegedChildEnv } = require('../../../../shared/child-process-env.cjs');
const { getSearchGovernor } = require('./search-governor');
const { writeBrainStream, bumpStreamEvidence } = require('./brain-stream');
const {
  assessPhaseReceipt,
  hasPhaseWriteup,
  recordWriteupReceipt
} = require('../drill/writeup-gate');

const INTERACTIVE_ONLY = new Set([
  'spawn_agent',
  'check_agent',
  'list_agents',
  'create_goal',
  'refocus',
  'get_executive_state'
]);

function uniqueToolsByName(list) {
  const seen = new Set();
  const unique = [];
  for (const tool of list) {
    const name = tool?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(tool);
  }
  return unique;
}

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
      required: ['content', 'tag'],
      additionalProperties: false
    }
  },
  {
    name: 'list_skills',
    description: 'List available Cosmo skills.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
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
      required: ['skill_id', 'inputs'],
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
      required: ['prompt', 'backend'],
      additionalProperties: false
    }
  },
  {
    name: 'finish',
    description: 'Mark THIS phase\'s deliverable complete. The drill keeps going after you — finishing a writeup never ends the run. Refused until a markdown writeup exists under outputs/. Tape, thoughts, receipts, and /tmp dumps cannot close a phase.',
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

const tools = uniqueToolsByName([
  ...interactiveTools.filter((tool) => !INTERACTIVE_ONLY.has(tool.name)),
  ...extraTools
]);

const URL_PATTERN = /https?:\/\/[^\s)\]"'<>]+/g;

function extractUrls(text, limit = 8) {
  return [...new Set(String(text || '').match(URL_PATTERN) || [])].slice(0, limit);
}

function resolveRuntimePath(context) {
  return context.runtimePath
    || context.orchestrator?.logsDir
    || process.cwd();
}

function drillProvenance(context) {
  const drill = context.loop?.drill || null;
  return {
    cycle: drill?.cycle ?? null,
    workerId: drill?.workerId ?? null,
    goalNumber: drill?.goalNumber ?? null,
    phaseNumber: drill?.phaseNumber ?? null
  };
}

/**
 * The control center's Sources feed: EVERY successful fetch leaves a receipt
 * in outputs/sources.jsonl — web_search hits, run_command fetches of a URL,
 * coding_run against a URL, and harvested material written into outputs/.
 * Search is one tool in the kit, not the research; the other paths persist
 * the same way.
 */
async function journalSourceReceipt(context, {
  tool,
  query,
  urls = [],
  path: outputPath = null,
  bytes = null,
  sha256 = null
}) {
  try {
    const runtimePath = resolveRuntimePath(context);
    const entry = {
      at: Date.now(),
      tool,
      query,
      urls,
      path: outputPath,
      bytes,
      sha256,
      ...drillProvenance(context)
    };
    await fs.mkdir(path.join(runtimePath, 'outputs'), { recursive: true });
    await fs.appendFile(path.join(runtimePath, 'outputs', 'sources.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch { /* the tool result itself is unaffected */ }
}

/**
 * The working stream: a harvest (or any other stream entry) goes onto the
 * tape and into the Brain as it happens. Anything that reaches the record
 * counts as this worker's evidence for the phase gate.
 */
async function streamFromTool(context, kind, content, extra = {}) {
  try {
    const result = await writeBrainStream({
      runtimePath: resolveRuntimePath(context),
      memory: context.orchestrator?.memory || null,
      logger: context.logger
    }, { kind, content, ...drillProvenance(context), ...extra });
    if (result.streamed) bumpStreamEvidence(context.loop);
    return result;
  } catch (err) {
    context.logger?.warn?.('Stream write from tool failed', { kind, error: err.message });
    return { streamed: false, brain: 'lost' };
  }
}

/**
 * Non-search harvest paths leave the same trail as a search hit. Any
 * successful run_command that touched a URL (curl, wget, scripts) and any
 * successful write_file into outputs/ gets a Sources receipt and a stream
 * entry — raw dumps on disk are never hidden work.
 */
async function recordInteractiveHarvest(name, args, result, context) {
  if (typeof result !== 'string') return;
  try {
    if (name === 'run_command') {
      if (/^(Command failed|Error:)/.test(result)) return;
      const urls = extractUrls(args.command);
      if (urls.length === 0) return;
      await journalSourceReceipt(context, {
        tool: 'run_command',
        query: String(args.command || '').slice(0, 300),
        urls
      });
      await streamFromTool(context, 'harvest', `Fetched via run_command: ${urls.join(' ')}`);
      return;
    }
    if (name === 'write_file') {
      if (!/^File written:/.test(result)) return;
      const relPath = `outputs/${args.path}`;
      const urls = extractUrls(args.content);
      const provenance = drillProvenance(context);
      const content = String(args.content || '');
      await journalSourceReceipt(context, {
        tool: 'write_file',
        query: relPath,
        path: relPath,
        urls,
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: crypto.createHash('sha256').update(content).digest('hex')
      });
      const writeupReceipt = await recordWriteupReceipt(
        resolveRuntimePath(context),
        relPath,
        provenance,
        content
      );
      const bytes = Buffer.byteLength(content, 'utf-8');
      const streamContent = writeupReceipt.recorded
        ? `Writeup ${relPath}:\n${String(args.content || '').slice(0, 2000)}`
        : `Harvested to ${relPath} (${bytes} bytes)${urls.length ? ` from ${urls.slice(0, 3).join(' ')}` : ''}`;
      await streamFromTool(context, writeupReceipt.recorded ? 'writeup' : 'harvest', streamContent);
    }
  } catch (err) {
    context.logger?.warn?.('Harvest receipt failed', { tool: name, error: err.message });
  }
}

const extraExecutors = {
  /**
   * Governed web search. The per-run SearchGovernor owns the backend chain:
   * each backend (MCP, SearXNG, Brave, DuckDuckGo) is tried at most once per
   * query under a hard timeout, circuit-breaks after bounded failures, and a
   * near-duplicate of an already-failed query is blocked before any backend
   * is touched — the model gets a structured strategy-change instruction
   * instead of another multi-second stall.
   */
  async web_search(args, context) {
    const query = String(args.query || '').trim();
    if (!query) return 'web_search requires query.';

    const governor = getSearchGovernor(context);
    const orchestrator = context.orchestrator;
    const searchConfig = orchestrator?.config?.search || {};
    const mcp = orchestrator?.mcp || orchestrator?.agentExecutor?.mcp || context.mcp;
    const searxngUrl = orchestrator?.config?.providers?.local?.searxngUrl
      || searchConfig.searxngUrl
      || process.env.SEARXNG_URL;
    const braveApiKey = searchConfig.braveApiKey || process.env.BRAVE_API_KEY || '';
    const allowDuckDuckGo = searchConfig.allowDuckDuckGoFallback !== false;

    const configuredBackends = [
      mcp && typeof mcp.callTool === 'function' ? 'mcp' : null,
      searxngUrl ? 'searxng' : null,
      braveApiKey ? 'brave' : null,
      allowDuckDuckGo ? 'duckduckgo' : null
    ].filter(Boolean);

    const gate = governor.checkQuery(query, configuredBackends);
    if (gate.blocked) {
      return governor.strategyMessage(query, gate.reason, configuredBackends);
    }

    const searcherFactory = context.createSearcher || (() => {
      const { FreeWebSearch } = require('../tools/web-search-free');
      return new FreeWebSearch(context.logger, {
        searxngUrl,
        braveApiKey,
        allowDuckDuckGoFallback: allowDuckDuckGo
      });
    });
    let searcher = null;
    const getSearcher = () => {
      if (!searcher) searcher = searcherFactory();
      return searcher;
    };

    const succeed = async (backend, payload) => {
      governor.recordSuccess(backend);
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      const urls = extractUrls(text);
      await journalSourceReceipt(context, { tool: 'web_search', query, urls });
      await streamFromTool(context, 'harvest', `Search "${query}" surfaced: ${urls.join(' ') || '(no URLs in result)'}`);
      return text;
    };

    // Backend 1: MCP web_search (whatever provider it routes internally).
    if (configuredBackends.includes('mcp') && !governor.isOpen('mcp')) {
      try {
        const mcpResponse = await governor.withTimeout(
          () => mcp.callTool('web_search', { query, maxResults: 10, allowDuckDuckGoFallback: allowDuckDuckGo }),
          'mcp web_search'
        );
        const text = mcpResponse?.content?.[0]?.text;
        if (text) return await succeed('mcp', text);
        governor.recordFailure('mcp', 'empty response');
      } catch (err) {
        governor.recordFailure('mcp', err);
        context.logger?.warn?.('web_search MCP failed', { error: err.message });
      }
    }

    // Backends 2-4: direct FreeWebSearch backends, one bounded attempt each.
    const directBackends = [
      { name: 'searxng', run: () => getSearcher().searchSearXNG(query, 10) },
      { name: 'brave', run: () => getSearcher().searchBrave(query, 10) },
      { name: 'duckduckgo', run: () => getSearcher().searchDuckDuckGo(query, 10) }
    ];
    let sawEmptyHealthyBackend = false;
    for (const backend of directBackends) {
      if (!configuredBackends.includes(backend.name) || governor.isOpen(backend.name)) continue;
      try {
        const results = await governor.withTimeout(backend.run, `${backend.name} search`);
        if (Array.isArray(results) && results.length > 0) {
          return await succeed(backend.name, {
            success: true,
            query,
            source: backend.name,
            resultCount: results.length,
            results
          });
        }
        // A healthy backend with zero hits is a query problem, not a
        // backend failure — do not trip the breaker for it.
        governor.recordSuccess(backend.name);
        sawEmptyHealthyBackend = true;
      } catch (err) {
        governor.recordFailure(backend.name, err);
        context.logger?.warn?.(`web_search ${backend.name} failed`, { error: err.message });
      }
    }

    governor.recordFailedQuery(query);
    if (sawEmptyHealthyBackend) {
      return JSON.stringify({
        web_search: 'no_results',
        query,
        backends: governor.statusSummary(configuredBackends),
        instruction: 'The search ran but found nothing. Do not retry a similar query — change the query substantially, fetch a known URL directly with run_command (curl -sL <url>), or proceed from your own knowledge and mark it as unverified.'
      }, null, 2);
    }
    return governor.strategyMessage(
      query,
      'all available search backends failed for this query',
      configuredBackends
    );
  },

  async remember(args, context) {
    const content = String(args.content || '').trim();
    if (!content) return 'remember requires content.';
    const tag = String(args.tag || 'finding').trim() || 'finding';
    const runtimePath = resolveRuntimePath(context);
    const dir = path.join(runtimePath, 'outputs', 'candidates');
    await fs.mkdir(dir, { recursive: true });

    // The stream writes the Brain AS IT HAPPENS — remember is not a gate.
    // Degraded-honest: if the live write fails, the row stays journaled and
    // the drill promotes it at settle time.
    const streamed = await streamFromTool(context, 'finding', content, { tag: 'drill_finding' });

    const entry = {
      id: `cand_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'candidate_finding',
      content,
      tag,
      at: Date.now(),
      source: 'launch_loop',
      ...drillProvenance(context),
      brain: streamed.brain === 'live' ? 'live' : 'journaled',
      streamId: streamed.id || null,
      promoted: streamed.brain === 'live'
    };
    await fs.appendFile(path.join(dir, 'findings.jsonl'), `${JSON.stringify(entry)}\n`);
    return streamed.brain === 'live'
      ? 'Journaled finding and wrote it into the Brain.'
      : 'Journaled candidate finding. The drill writes it into the Brain at cycle end.';
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
      if (result.ran) {
        // A coding_run descent is part of the working stream, same as a
        // search hit: receipt for any URL it was pointed at, stream entry
        // for the run itself. Research is bigger than search.
        const urls = extractUrls(prompt);
        if (urls.length > 0) {
          await journalSourceReceipt(context, {
            tool: 'coding_run',
            query: prompt.slice(0, 300),
            urls
          });
        }
        await streamFromTool(context, 'harvest', `coding_run (${candidate.id}): ${prompt.slice(0, 240)}`);
        return result.text;
      }
    }
    return 'No coding backend installed (claude / codex). Use write_file and run_command instead.';
  },

  async finish(args, context) {
    const summary = String(args.summary || '').trim();
    if (context.loop && typeof context.loop.markFinished === 'function') {
      // A phase cannot close on tape alone. Hidden work (nothing on the
      // record) is still refused. Harvest without a writeup under
      // outputs/*.md is also refused. /tmp dumps never count.
      const streamed = Number(context.loop.evidence?.streamed) || 0;
      const expectedOutput = context.loop.expectedOutput
        || context.loop.plan?.shortPlan?.expectedOutput
        || (context.loop.plan?.shortPlan?.writeupPath
          ? `outputs/${context.loop.plan.shortPlan.writeupPath}`
          : null);
      const provenance = drillProvenance(context);
      const receipt = !expectedOutput
          && provenance.goalNumber == null
          && provenance.phaseNumber == null
        ? {
            accepted: hasPhaseWriteup(resolveRuntimePath(context)),
            reason: hasPhaseWriteup(resolveRuntimePath(context))
              ? 'legacy_unscoped_writeup'
              : 'missing_writeup'
          }
        : assessPhaseReceipt(
            resolveRuntimePath(context),
            expectedOutput,
            provenance
          );
      if (!receipt.accepted) {
        const expected = Array.isArray(expectedOutput) ? expectedOutput.join(', ') : expectedOutput;
        if (streamed === 0) {
          return JSON.stringify({
            finish: 'refused',
            reason: 'hidden_work',
            receiptReason: receipt.reason,
            instruction: `Nothing complete from this phase has reached its named receipt${expected ? ` (${expected})` : ''}. write_file that exact finished artifact, remember() the findings, then call finish. Progress notes and hidden /tmp dumps cannot close a phase.`
          }, null, 2);
        }
        return JSON.stringify({
          finish: 'refused',
          reason: receipt.reason,
          instruction: `This phase has tape but its named receipt${expected ? ` (${expected})` : ''} is not finished. Stop fetching. write_file that exact completed artifact, remember() the findings, then call finish. Tape, progress notes, and another file cannot close this phase.`
        }, null, 2);
      }
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
  const result = await executeInteractiveTool(name, args, context);
  await recordInteractiveHarvest(name, args || {}, result, context);
  return result;
}

function toChatTools(allowedNames = null) {
  const allow = Array.isArray(allowedNames) ? new Set(allowedNames) : null;
  return uniqueToolsByName(tools).filter(tool => !allow || allow.has(tool.name)).map((tool) => ({
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
  uniqueToolsByName,
  extractUrls,
  INTERACTIVE_ONLY
};
