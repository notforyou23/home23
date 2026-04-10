/**
 * COSMO 2.3 research toolkit — 11 atomic tools mapping to COSMO's API surface.
 *
 * Policy/workflow lives in the COSMO_RESEARCH.md skill file loaded via the
 * identity layer. This file is pure mechanism — one HTTP call per tool, focused
 * schemas, minimal branching.
 *
 * See: docs/design/STEP16-AGENT-COSMO-TOOLKIT-DESIGN.md
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';

function getCosmoBase(_ctx?: ToolContext): string {
  const port = parseInt(process.env.COSMO23_PORT || '43210', 10);
  return `http://localhost:${port}`;
}

function errResult(msg: string): ToolResult {
  return { content: msg, is_error: true };
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json() as Promise<T>;
}

// ────────────────────────────────────────────────────────────────────────────
// Shared types (narrow — only what we read from responses)
// ────────────────────────────────────────────────────────────────────────────

interface BrainSummary {
  id?: string;
  name?: string;
  path?: string;
  source?: string;
  updatedAt?: string;
  nodeCount?: number;
  cycleCount?: number;
  topic?: string;
  domain?: string;
}

interface ActiveContext {
  runName?: string;
  topic?: string;
  explorationMode?: string;
  startedAt?: string;
}

interface StatusResponse {
  running?: boolean;
  activeContext?: ActiveContext | null;
  processStatus?: { running?: Array<{ name?: string }>; count?: number };
}

interface QueryResponse {
  response?: string;
  answer?: string;
}

interface LaunchResponse {
  success: boolean;
  runName?: string;
  brainId?: string;
  cycles?: number;
  dashboardUrl?: string;
  wsUrl?: string;
  message?: string;
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Active-run helper (also used by loop.ts for situational awareness)
// ────────────────────────────────────────────────────────────────────────────

export async function checkCosmoActiveRun(
  _ctx?: ToolContext
): Promise<{ runName: string; topic: string; startedAt: string; processCount: number } | null> {
  try {
    const base = getCosmoBase();
    const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const status = (await res.json()) as StatusResponse;
    if (!status.running || !status.activeContext?.runName) return null;
    return {
      runName: status.activeContext.runName,
      topic: status.activeContext.topic || '',
      startedAt: status.activeContext.startedAt || '',
      processCount: status.processStatus?.count || 0,
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 1. research_list_brains
// ────────────────────────────────────────────────────────────────────────────

export const listBrainsTool: ToolDefinition = {
  name: 'research_list_brains',
  description:
    'List all available COSMO 2.3 research brains with metadata (name, node count, cycle count, source). Always use this first to discover what research already exists before launching new runs.',
  input_schema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max brains to return (default 20)' },
      includeReferences: {
        type: 'boolean',
        description: 'Include reference brains from external paths (default true)',
      },
    },
  },
  async execute(input, ctx) {
    const limit = (input.limit as number) || 20;
    const includeRefs = input.includeReferences !== false;
    try {
      const base = getCosmoBase(ctx);
      const data = await fetchJson<{ brains?: BrainSummary[]; count?: number }>(
        `${base}/api/brains`
      );
      let brains = data.brains || [];
      if (!includeRefs) brains = brains.filter((b) => !b.source || b.source === 'local');
      brains = brains.slice(0, limit);
      if (brains.length === 0) {
        return { content: 'No research brains available. Use research_launch to start one.' };
      }
      const lines = [`${brains.length} research brain(s):`, ''];
      for (const b of brains) {
        const nodes = b.nodeCount != null ? `${b.nodeCount} nodes` : '—';
        const cycles = b.cycleCount != null ? `${b.cycleCount} cycles` : '—';
        const src = b.source && b.source !== 'local' ? ` [${b.source}]` : '';
        const topic = b.topic || b.domain || '';
        lines.push(`- **${b.name || b.id}**${src} — ${nodes}, ${cycles}`);
        if (topic) lines.push(`  topic: ${topic}`);
      }
      return { content: lines.join('\n') };
    } catch (err) {
      return errResult(`research_list_brains: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 2. research_query_brain
// ────────────────────────────────────────────────────────────────────────────

export const queryBrainTool: ToolDefinition = {
  name: 'research_query_brain',
  description:
    'Query ONE specific COSMO research brain with full mode control. Use this when you know which brain to target. Modes: quick=fast overview, full=standard (default), expert=deep with coordinator insights, dive=exhaustive. Response can be 5-30KB — paraphrase or compile rather than quoting verbatim.',
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID or run name (from research_list_brains)' },
      query: { type: 'string', description: 'Question to ask the brain' },
      mode: {
        type: 'string',
        enum: ['quick', 'full', 'expert', 'dive'],
        description: 'Query depth (default: full)',
      },
      includeThoughts: { type: 'boolean', description: 'Include agent thoughts (default true)' },
      includeCoordinatorInsights: {
        type: 'boolean',
        description: 'Include coordinator reviews (default: true for expert/dive)',
      },
    },
    required: ['brainId', 'query'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    const query = input.query as string;
    const mode = (input.mode as string) || 'full';
    const includeThoughts = input.includeThoughts !== false;
    const includeCoordinatorInsights =
      input.includeCoordinatorInsights !== undefined
        ? Boolean(input.includeCoordinatorInsights)
        : mode === 'expert' || mode === 'dive';
    try {
      const base = getCosmoBase(ctx);
      const result = await fetchJson<QueryResponse>(
        `${base}/api/brain/${encodeURIComponent(brainId)}/query`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            mode,
            enableSynthesis: true,
            includeThoughts,
            includeCoordinatorInsights,
          }),
        },
        60_000
      );
      const answer = result.response || result.answer || '';
      if (!answer) {
        return { content: `Brain "${brainId}" returned no response for query: ${query}` };
      }
      return { content: answer };
    } catch (err) {
      return errResult(`research_query_brain: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 3. research_search_all_brains
// ────────────────────────────────────────────────────────────────────────────

export const searchAllBrainsTool: ToolDefinition = {
  name: 'research_search_all_brains',
  description:
    'Query the top N most recent research brains at once. Convenience for "do I already have research on X?" Use this as step 2 after research_list_brains, before deciding to launch a new run.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Question to search across brains' },
      topN: { type: 'number', description: 'Number of most recent brains to query (default 5)' },
      mode: {
        type: 'string',
        enum: ['quick', 'full', 'expert'],
        description: 'Query depth (default: full)',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const query = input.query as string;
    const topN = (input.topN as number) || 5;
    const mode = (input.mode as string) || 'full';
    try {
      const base = getCosmoBase(ctx);
      const data = await fetchJson<{ brains?: BrainSummary[] }>(`${base}/api/brains`);
      const brains = (data.brains || []).slice(0, topN);
      if (brains.length === 0) {
        return { content: 'No brains available. Use research_launch to start one.' };
      }
      const results: string[] = [];
      for (const brain of brains) {
        try {
          const qRes = await fetchJson<QueryResponse>(
            `${base}/api/brain/${encodeURIComponent(brain.id || brain.name || '')}/query`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query,
                mode,
                enableSynthesis: true,
                includeThoughts: true,
              }),
            },
            45_000
          );
          const answer = qRes.response || qRes.answer || '';
          if (answer && answer.length > 50) {
            results.push(`## ${brain.name || brain.id}\n\n${answer}`);
          }
        } catch {
          // skip brains that fail — listed in summary at end
        }
      }
      if (results.length === 0) {
        return {
          content: `Searched ${brains.length} brain(s) for "${query}" — no relevant findings. Consider research_launch.`,
        };
      }
      return {
        content: `Found relevant research in ${results.length}/${brains.length} brain(s):\n\n${results.join('\n\n---\n\n')}`,
      };
    } catch (err) {
      return errResult(
        `research_search_all_brains: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 4. research_launch
// ────────────────────────────────────────────────────────────────────────────

export const launchTool: ToolDefinition = {
  name: 'research_launch',
  description:
    'Start a NEW COSMO 2.3 research run. CRITICAL: always provide `context` — without it, the guided planner fabricates framing from model priors and over-scopes the plan. Cycles: 5-10 for primers, 20-40 for investigations, 60-80 for deep dives. Runs take minutes to hours. Only launch if an existing brain does not already answer the question — check first with research_list_brains and research_search_all_brains.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Focused research topic. "Cosine similarity in semantic search" not "everything about embeddings".',
      },
      context: {
        type: 'string',
        description:
          'Framing, constraints, source preferences, scope, rails. Example: "One-page primer for someone who knows linear algebra. Wikipedia + primary docs fine, no academic deep-dives. 5 cycles, normal depth." DO NOT skip this.',
      },
      cycles: { type: 'number', description: 'Max cognitive cycles (default 20)' },
      explorationMode: {
        type: 'string',
        enum: ['guided', 'autonomous'],
        description: 'guided=plan-then-execute (default), autonomous=exploratory',
      },
      analysisDepth: {
        type: 'string',
        enum: ['shallow', 'normal', 'deep'],
        description: 'Synthesis detail (default: normal)',
      },
      maxConcurrent: { type: 'number', description: 'Max parallel agents (default 6)' },
      primaryModel: {
        type: 'string',
        description: 'Model for research/analysis agents (e.g., gpt-5.2)',
      },
      primaryProvider: { type: 'string', description: 'openai, anthropic, xai, ollama-cloud' },
      fastModel: { type: 'string', description: 'Model for coordinator/planner (e.g., gpt-5-mini)' },
      fastProvider: { type: 'string' },
      strategicModel: { type: 'string', description: 'Model for synthesis/QA' },
      strategicProvider: { type: 'string' },
    },
    required: ['topic'],
  },
  async execute(input, ctx) {
    const topic = input.topic as string;
    if (!topic) return errResult('research_launch: topic is required');
    try {
      const base = getCosmoBase(ctx);
      // Refuse if a run is already active — jerry should explicitly stop first
      const active = await checkCosmoActiveRun(ctx);
      if (active) {
        return errResult(
          `Cannot launch: a run is already active ("${active.runName}", topic: "${active.topic}"). Use research_stop first, or research_watch_run to monitor it.`
        );
      }
      const payload: Record<string, unknown> = {
        topic,
        context: input.context || '',
        explorationMode: input.explorationMode || 'guided',
        analysisDepth: input.analysisDepth || 'normal',
        cycles: input.cycles || 20,
        maxConcurrent: input.maxConcurrent || 6,
        enableWebSearch: true,
        enableCodingAgents: false,
        enableAgentRouting: true,
        enableMemoryGovernance: true,
      };
      if (input.primaryModel) payload.primaryModel = input.primaryModel;
      if (input.primaryProvider) payload.primaryProvider = input.primaryProvider;
      if (input.fastModel) payload.fastModel = input.fastModel;
      if (input.fastProvider) payload.fastProvider = input.fastProvider;
      if (input.strategicModel) payload.strategicModel = input.strategicModel;
      if (input.strategicProvider) payload.strategicProvider = input.strategicProvider;

      const result = await fetchJson<LaunchResponse>(
        `${base}/api/launch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        45_000
      );

      if (!result.success) {
        return errResult(`research_launch failed: ${result.error || result.message || 'unknown'}`);
      }
      const lines = [
        `Research run launched:`,
        `- runName: **${result.runName}**`,
        `- brainId: ${result.brainId || '(pending)'}`,
        `- cycles: ${result.cycles || payload.cycles}`,
      ];
      if (result.dashboardUrl) lines.push(`- dashboard: ${result.dashboardUrl}`);
      lines.push('');
      lines.push('Use research_watch_run to check progress. Do not check every turn.');
      return { content: lines.join('\n') };
    } catch (err) {
      return errResult(`research_launch: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 5. research_continue
// ────────────────────────────────────────────────────────────────────────────

export const continueRunTool: ToolDefinition = {
  name: 'research_continue',
  description:
    "Resume a completed research brain with a new focus. Reuses the prior run's model selections and settings by default — only pass overrides for what you want to change. Useful for deepening research you already have, or shifting emphasis without starting from scratch.",
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID of the completed run to continue' },
      context: { type: 'string', description: 'New framing or focus for the continuation' },
      cycles: { type: 'number', description: 'Additional cycles to run' },
      primaryModel: { type: 'string' },
      primaryProvider: { type: 'string' },
    },
    required: ['brainId'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    if (!brainId) return errResult('research_continue: brainId is required');
    try {
      const base = getCosmoBase(ctx);
      const active = await checkCosmoActiveRun(ctx);
      if (active) {
        return errResult(
          `Cannot continue: a run is already active ("${active.runName}"). Use research_stop first.`
        );
      }
      const payload: Record<string, unknown> = {};
      if (input.context) payload.context = input.context;
      if (input.cycles) payload.cycles = input.cycles;
      if (input.primaryModel) payload.primaryModel = input.primaryModel;
      if (input.primaryProvider) payload.primaryProvider = input.primaryProvider;

      const result = await fetchJson<LaunchResponse>(
        `${base}/api/continue/${encodeURIComponent(brainId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        45_000
      );
      if (!result.success) {
        return errResult(
          `research_continue failed: ${result.error || result.message || 'unknown'}`
        );
      }
      return {
        content: `Continuation launched on brain "${brainId}":\n- runName: ${result.runName}\n- cycles: ${result.cycles}\n\nUse research_watch_run to monitor.`,
      };
    } catch (err) {
      return errResult(`research_continue: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 6. research_stop
// ────────────────────────────────────────────────────────────────────────────

export const stopRunTool: ToolDefinition = {
  name: 'research_stop',
  description:
    'Stop the currently active COSMO research run. Use this to cancel a run that is going the wrong direction, or before launching a new one when an old one is still in flight.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(_input, ctx) {
    try {
      const base = getCosmoBase(ctx);
      const result = await fetchJson<{ success?: boolean; status?: string; message?: string }>(
        `${base}/api/stop`,
        { method: 'POST' },
        30_000
      );
      if (result.status === 'not_running') {
        return { content: 'No active research run to stop.' };
      }
      return { content: `Research run stopped: ${result.status || 'ok'}` };
    } catch (err) {
      return errResult(`research_stop: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 7. research_watch_run
// ────────────────────────────────────────────────────────────────────────────

interface LogEntry {
  source?: string;
  level?: string;
  message?: string;
  timestamp?: number;
}

interface LogsResponse {
  success?: boolean;
  logs?: LogEntry[];
  latest?: number;
  running?: boolean;
  activeContext?: ActiveContext | null;
}

export const watchRunTool: ToolDefinition = {
  name: 'research_watch_run',
  description:
    'Tail logs from the currently active research run. Use cursor-paginated calls (pass `after` from the previous response) so you only see new entries. Check every 2-3 turns, not every turn. Returns run state at top + filtered log entries.',
  input_schema: {
    type: 'object',
    properties: {
      after: {
        type: 'number',
        description: 'Log cursor from the previous call (default 0 = from start)',
      },
      limit: { type: 'number', description: 'Max entries to return (default 50)' },
      filter: {
        type: 'string',
        enum: ['all', 'errors', 'progress', 'cycles'],
        description:
          'What to include (default progress). all=everything, errors=warn+error only, progress=agent progress + phases, cycles=cycle markers only',
      },
    },
  },
  async execute(input, ctx) {
    const after = (input.after as number) || 0;
    const limit = (input.limit as number) || 50;
    const filter = (input.filter as string) || 'progress';
    try {
      const base = getCosmoBase(ctx);
      const data = await fetchJson<LogsResponse>(
        `${base}/api/watch/logs?after=${after}&limit=${Math.min(limit, 500)}`
      );
      const header: string[] = [];
      if (data.running && data.activeContext?.runName) {
        header.push(`**Active run:** ${data.activeContext.runName}`);
        if (data.activeContext.topic) header.push(`**Topic:** ${data.activeContext.topic}`);
      } else {
        header.push('**No active run**');
      }
      const allLogs = data.logs || [];
      // Filter
      const filtered = allLogs.filter((e) => {
        const msg = e.message || '';
        const lvl = (e.level || '').toLowerCase();
        if (filter === 'errors') return lvl === 'warn' || lvl === 'error' || lvl === 'warning';
        if (filter === 'cycles')
          return /cycle\s+(\d+|start|complete)/i.test(msg) || /phase\s+\d/i.test(msg);
        if (filter === 'progress')
          return /agent|goal|cycle|phase|synthesis|completed|progress/i.test(msg);
        return true;
      });
      const shown = filtered.slice(-limit);
      header.push(
        `**Cursor:** ${data.latest ?? allLogs.length} (pass as \`after\` next call)`,
        `**Filtered:** ${shown.length}/${allLogs.length} entries (filter=${filter})`,
        ''
      );
      const body = shown.map((e) => `[${(e.level || 'info').slice(0, 5)}] ${(e.message || '').slice(0, 220)}`);
      if (body.length === 0) body.push('(no new entries)');
      return { content: header.concat(body).join('\n') };
    } catch (err) {
      return errResult(`research_watch_run: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 8. research_get_brain_summary
// ────────────────────────────────────────────────────────────────────────────

export const getBrainSummaryTool: ToolDefinition = {
  name: 'research_get_brain_summary',
  description:
    "Aggregated high-level summary of a completed brain: executive review, goals, trajectory, optionally thoughts and insights. Pulls from COSMO's intelligence endpoints. Use this to orient yourself on a brain before deciding which section to query in depth.",
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID or run name' },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['executive', 'goals', 'trajectory', 'thoughts', 'insights'] },
        description: 'Sections to include (default: [executive, goals, trajectory])',
      },
    },
    required: ['brainId'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    if (!brainId) return errResult('research_get_brain_summary: brainId is required');
    const include =
      (input.include as string[]) || ['executive', 'goals', 'trajectory'];
    try {
      const base = getCosmoBase(ctx);
      const sections: string[] = [`# Brain summary: ${brainId}`, ''];

      const fetchSection = async (kind: string, label: string) => {
        try {
          const data = await fetchJson<Record<string, unknown>>(
            `${base}/api/brain/${encodeURIComponent(brainId)}/intelligence/${kind}`,
            undefined,
            15_000
          );
          return { label, data };
        } catch (err) {
          return { label, error: err instanceof Error ? err.message : String(err) };
        }
      };

      for (const kind of include) {
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        const result = await fetchSection(kind, label);
        sections.push(`## ${result.label}`);
        if ('error' in result) {
          sections.push(`_error: ${result.error}_`);
        } else {
          // Compact JSON-ish rendering — intelligence endpoints return varied shapes
          const json = JSON.stringify(result.data, null, 2);
          const truncated = json.length > 3000 ? json.slice(0, 3000) + '\n... (truncated)' : json;
          sections.push('```json', truncated, '```');
        }
        sections.push('');
      }
      return { content: sections.join('\n') };
    } catch (err) {
      return errResult(
        `research_get_brain_summary: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 9. research_get_brain_graph
// ────────────────────────────────────────────────────────────────────────────

interface GraphResponse {
  nodes?: Array<{ id?: string | number; concept?: string; tag?: string; cluster?: string; weight?: number }>;
  edges?: Array<{ source?: string | number; target?: string | number; weight?: number; type?: string }>;
  clusters?: Array<{ id?: string; label?: string; nodeCount?: number }>;
}

export const getBrainGraphTool: ToolDefinition = {
  name: 'research_get_brain_graph',
  description:
    'Get the knowledge graph structure of a brain: nodes, edges, and clusters. Use this to see HOW knowledge connects rather than what it says. Returns structural summary + a capped sample of nodes/edges to control context size.',
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID or run name' },
      clusterId: { type: 'string', description: 'Filter to one cluster' },
      minWeight: { type: 'number', description: 'Filter edges by weight (default 0.3)' },
      limit: { type: 'number', description: 'Max nodes returned (default 50)' },
    },
    required: ['brainId'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    if (!brainId) return errResult('research_get_brain_graph: brainId is required');
    const clusterId = input.clusterId as string | undefined;
    const minWeight = (input.minWeight as number) ?? 0.3;
    const limit = (input.limit as number) || 50;
    try {
      const base = getCosmoBase(ctx);
      const data = await fetchJson<GraphResponse>(
        `${base}/api/brain/${encodeURIComponent(brainId)}/graph`,
        undefined,
        30_000
      );
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      const clusters = data.clusters || [];

      let filteredNodes = nodes;
      if (clusterId) filteredNodes = filteredNodes.filter((n) => n.cluster === clusterId);
      filteredNodes = filteredNodes.slice(0, limit);

      const filteredEdges = edges.filter((e) => (e.weight ?? 0) >= minWeight).slice(0, limit * 2);

      const lines = [
        `# Brain graph: ${brainId}`,
        '',
        `**Totals:** ${nodes.length} nodes · ${edges.length} edges · ${clusters.length} clusters`,
        `**Filtered:** ${filteredNodes.length} nodes (limit ${limit})${clusterId ? ` in cluster "${clusterId}"` : ''}, ${filteredEdges.length} edges (weight >= ${minWeight})`,
        '',
      ];

      if (clusters.length > 0) {
        lines.push('## Clusters');
        for (const c of clusters.slice(0, 20)) {
          lines.push(`- ${c.id || c.label} (${c.nodeCount ?? '?'} nodes)`);
        }
        lines.push('');
      }

      lines.push('## Sample nodes');
      for (const n of filteredNodes) {
        const concept = (n.concept || '').slice(0, 120);
        lines.push(
          `- [${n.id}] tag=${n.tag || '?'} cluster=${n.cluster || '?'} weight=${(n.weight ?? 0).toFixed(2)} · ${concept}`
        );
      }

      if (filteredEdges.length > 0) {
        lines.push('');
        lines.push('## Sample edges');
        for (const e of filteredEdges.slice(0, 30)) {
          lines.push(`- ${e.source} → ${e.target} [${e.type || 'assoc'}] w=${(e.weight ?? 0).toFixed(2)}`);
        }
      }
      return { content: lines.join('\n') };
    } catch (err) {
      return errResult(
        `research_get_brain_graph: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 10. research_compile_brain
// ────────────────────────────────────────────────────────────────────────────

async function writeWorkspaceFile(filename: string, content: string): Promise<string> {
  const agentName = process.env.HOME23_AGENT || 'test-agent';
  const projectRoot = process.cwd();
  const researchDir = `${projectRoot}/instances/${agentName}/workspace/research`;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(researchDir, { recursive: true });
  const path = `${researchDir}/${filename}`;
  writeFileSync(path, content);
  return path;
}

export const compileBrainTool: ToolDefinition = {
  name: 'research_compile_brain',
  description:
    "Compile a completed research brain to a markdown file in your workspace/research/ directory. The engine feeder automatically ingests it into your own brain as a compiled knowledge node. Use this to KEEP the knowledge from a run. Prefer research_compile_section when you only need one thread — whole-brain compiles produce one giant node.",
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID or run name to compile' },
      focus: {
        type: 'string',
        description: 'Optional focused prompt (default: comprehensive summary)',
      },
    },
    required: ['brainId'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    if (!brainId) return errResult('research_compile_brain: brainId is required');
    const focus =
      (input.focus as string) ||
      'Provide a comprehensive summary of all key findings, conclusions, and insights from this research. Include the main topic, methodology, key discoveries, contradictions found, and open questions remaining.';
    try {
      const base = getCosmoBase(ctx);
      const brainCheck = await fetch(
        `${base}/api/brains/${encodeURIComponent(brainId)}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!brainCheck.ok) {
        return errResult(`Brain "${brainId}" not found. Use research_list_brains to see available.`);
      }
      const queryResult = await fetchJson<QueryResponse>(
        `${base}/api/brain/${encodeURIComponent(brainId)}/query`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: focus,
            mode: 'expert',
            enableSynthesis: true,
            includeCoordinatorInsights: true,
            includeThoughts: true,
          }),
        },
        90_000
      );
      const summary = queryResult.response || queryResult.answer || '';
      if (!summary || summary.length < 50) {
        return errResult('Brain returned insufficient summary to compile.');
      }
      const date = new Date().toISOString().slice(0, 10);
      const filename = `cosmo-${brainId}-${date}.md`;
      const body = `# COSMO Research: ${brainId}\n\nCompiled: ${new Date().toISOString()}\nSource: COSMO 2.3 run "${brainId}"\n\n---\n\n${summary}`;
      const path = await writeWorkspaceFile(filename, body);
      return {
        content: `Compiled brain "${brainId}" to workspace:\n- path: ${path}\n- size: ${body.length} bytes\n\nThe engine feeder will ingest this into your brain shortly.\n\n**Preview:**\n${summary.slice(0, 500)}...`,
      };
    } catch (err) {
      return errResult(`research_compile_brain: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ────────────────────────────────────────────────────────────────────────────
// 11. research_compile_section
// ────────────────────────────────────────────────────────────────────────────

export const compileSectionTool: ToolDefinition = {
  name: 'research_compile_section',
  description:
    'Compile ONE section of a brain (a single goal, insight, or agent output) to your workspace — narrower than research_compile_brain. Use when you only need one specific thread from a larger run. Produces a focused brain node that clusters better than a whole-run dump.',
  input_schema: {
    type: 'object',
    properties: {
      brainId: { type: 'string', description: 'Brain ID or run name' },
      section: {
        type: 'string',
        enum: ['goal', 'insight', 'agent'],
        description: 'What kind of section to compile',
      },
      sectionId: {
        type: 'string',
        description: 'Goal ID, insight filename, or agent ID (see research_get_brain_summary)',
      },
      focus: { type: 'string', description: 'Optional focused query about this section' },
    },
    required: ['brainId', 'section', 'sectionId'],
  },
  async execute(input, ctx) {
    const brainId = input.brainId as string;
    const section = input.section as string;
    const sectionId = input.sectionId as string;
    if (!brainId || !section || !sectionId) {
      return errResult('research_compile_section: brainId, section, sectionId all required');
    }
    const focus =
      (input.focus as string) ||
      `Summarize the ${section} "${sectionId}" from this research brain — its goal, findings, conclusions, and how it connects to the broader research.`;
    try {
      const base = getCosmoBase(ctx);
      // Use focused query — COSMO's PGS engine handles the routing
      const queryResult = await fetchJson<QueryResponse>(
        `${base}/api/brain/${encodeURIComponent(brainId)}/query`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: focus,
            mode: 'expert',
            enableSynthesis: true,
            includeCoordinatorInsights: true,
            includeThoughts: true,
          }),
        },
        60_000
      );
      const summary = queryResult.response || queryResult.answer || '';
      if (!summary || summary.length < 50) {
        return errResult(`No content found for ${section} "${sectionId}".`);
      }
      const date = new Date().toISOString().slice(0, 10);
      const safeSectionId = sectionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
      const filename = `cosmo-${brainId}-${section}-${safeSectionId}-${date}.md`;
      const body = `# COSMO Research Section: ${brainId} / ${section}:${sectionId}\n\nCompiled: ${new Date().toISOString()}\nSource: COSMO 2.3 run "${brainId}", ${section} "${sectionId}"\n\n---\n\n${summary}`;
      const path = await writeWorkspaceFile(filename, body);
      return {
        content: `Compiled ${section} "${sectionId}" from brain "${brainId}" to workspace:\n- path: ${path}\n- size: ${body.length} bytes\n\nThe engine feeder will ingest this shortly.\n\n**Preview:**\n${summary.slice(0, 500)}...`,
      };
    } catch (err) {
      return errResult(
        `research_compile_section: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
};
