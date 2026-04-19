/**
 * Brain tools — search memory, run deep queries, check status.
 * These call the COSMO engine's HTTP API.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const brainSearchTool: ToolDefinition = {
  name: 'brain_search',
  description: 'Semantic search across brain memory nodes using embedding cosine similarity. Returns the most relevant nodes ranked by similarity score.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query — what to look for in the brain' },
      limit: { type: 'number', description: 'Max results (default: 10)' },
      tag: { type: 'string', description: 'Optional: filter by node tag (e.g., agent_finding, insight, general)' },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;
    const tag = input.tag as string | undefined;

    try {
      const url = `http://localhost:${ctx.enginePort}/api/memory/search`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, topK: limit, minSimilarity: 0.15, tag: tag || null }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) return { content: `Brain search failed: HTTP ${res.status}`, is_error: true };

      const data = await res.json() as {
        results?: Array<{ concept?: string; tag?: string; id?: string | number; similarity?: number }>;
        stats?: { totalSearched?: number; totalMatched?: number; topSimilarity?: number; noiseFiltered?: boolean };
      };
      const results = data.results ?? [];
      if (results.length === 0) {
        const reason = data.stats?.noiseFiltered
          ? `No semantically relevant results — top similarity ${data.stats?.topSimilarity ?? 0} is below the signal threshold.`
          : `No matching nodes found.`;
        return { content: `${reason} ${data.stats?.totalSearched ?? 0} nodes searched for "${query}".` };
      }

      const formatted = results
        .map((n) => `[Node ${n.id ?? '?'}] (sim: ${n.similarity ?? 0}) [${n.tag ?? ''}]\n${(n.concept ?? '').slice(0, 500)}`)
        .join('\n\n');

      return { content: `Found ${results.length} matching node(s) (searched ${data.stats?.totalSearched ?? '?'}, top similarity: ${data.stats?.topSimilarity ?? '?'}):\n\n${formatted}` };
    } catch (err) {
      return { content: `Brain search error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const brainQueryTool: ToolDefinition = {
  name: 'brain_query',
  description:
    'Query the brain with the same protocol the dashboard Query tab uses. ' +
    'Three modes: full (balanced, default), expert (maximum depth, multi-pass), dive (exploratory synthesis, creative cross-domain). ' +
    'Enable PGS for full graph coverage via parallel partition sweeps — set enablePGS=true and pick pgsConfig.sweepFraction ' +
    '(0.10 skim, 0.25 sample, 0.50 deep, 1.0 full). Sweep model should be fast/cheap (many parallel calls); ' +
    'synthesis model stronger (one final reasoning pass). For follow-up queries that build on a prior answer, pass priorContext.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question' },
      model: { type: 'string', description: 'Main query model (answer generation). Any model from cosmo23 catalog.' },
      mode: {
        type: 'string',
        enum: ['full', 'expert', 'dive'],
        description: 'full=balanced (default), expert=maximum depth, dive=exploratory synthesis',
      },
      enableSynthesis: { type: 'boolean', description: 'Enable synthesis layer over retrieved evidence (default true)' },
      includeOutputs: { type: 'boolean', description: 'Include agent output files as evidence' },
      includeThoughts: { type: 'boolean', description: 'Include thought journal entries as evidence' },
      includeCoordinatorInsights: { type: 'boolean', description: 'Include coordinator reviews/insights' },
      allowActions: { type: 'boolean', description: 'Permit the query to trigger tool actions (default false — safety)' },
      enablePGS: { type: 'boolean', description: 'Enable Progressive Graph Search (full graph coverage)' },
      pgsMode: { type: 'string', description: 'PGS mode — default "full"' },
      pgsConfig: {
        type: 'object',
        properties: {
          sweepFraction: { type: 'number', description: '0.10=skim, 0.25=sample, 0.50=deep, 1.0=full coverage' },
        },
      },
      pgsSweepModel: { type: 'string', description: 'Model for parallel partition sweeps (pick fast/cheap)' },
      pgsSynthModel: { type: 'string', description: 'Model for final synthesis pass (pick stronger)' },
      priorContext: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          answer: { type: 'string' },
        },
        description: 'For follow-up queries — pass the previous query + answer for context continuity',
      },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.brainRoute) {
      return {
        content: `brain_query: agent brain not registered in cosmo23. Check: curl ${ctx.cosmo23BaseUrl}/api/brains`,
        is_error: true,
      };
    }

    const pgsConfig = input.pgsConfig as { sweepFraction?: number } | undefined;
    const sweepFraction = pgsConfig?.sweepFraction;
    const pgsFullSweep = typeof sweepFraction === 'number' && sweepFraction >= 1.0;

    const body: Record<string, unknown> = {
      query: input.query,
      model: input.model,
      mode: input.mode ?? 'full',
      enableSynthesis: input.enableSynthesis ?? true,
      includeOutputs: input.includeOutputs ?? false,
      includeThoughts: input.includeThoughts ?? false,
      includeCoordinatorInsights: input.includeCoordinatorInsights ?? false,
      allowActions: input.allowActions ?? false,
      enablePGS: input.enablePGS ?? false,
      pgsMode: input.pgsMode ?? 'full',
      pgsConfig: pgsConfig ?? {},
      pgsFullSweep,
      pgsSweepModel: input.pgsSweepModel,
      pgsSynthModel: input.pgsSynthModel,
      priorContext: input.priorContext ?? null,
      exportFormat: 'markdown',
      provider: null,
    };

    const timeoutMs = body.enablePGS ? 1_800_000 : 120_000;

    try {
      const res = await fetch(`${ctx.brainRoute}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `brain_query failed: HTTP ${res.status} — ${errText.slice(0, 500)}`, is_error: true };
      }

      const data = await res.json() as Record<string, unknown>;
      const answer = (data.answer ?? data.response ?? data.text ?? '') as string;
      const evidence = data.evidence as Array<unknown> | undefined;
      const meta = data.metadata as Record<string, unknown> | undefined;

      const parts: string[] = [];
      parts.push(answer.slice(0, 10_000) || 'brain_query returned empty result.');

      const footer: string[] = [];
      if (evidence?.length) footer.push(`${evidence.length} evidence nodes`);
      if (body.enablePGS && meta?.pgsPartitions) footer.push(`PGS: ${JSON.stringify(meta.pgsPartitions)}`);
      if (meta?.models) footer.push(`models=${JSON.stringify(meta.models)}`);
      if (footer.length) parts.push(`\n\n---\n[${footer.join(' · ')} · mode=${body.mode}]`);

      return { content: parts.join('') };
    } catch (err) {
      return { content: `brain_query error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

// ── brain_query_export — write a query answer to the brain's export dir ──

export const brainQueryExportTool: ToolDefinition = {
  name: 'brain_query_export',
  description:
    'Export a prior brain_query answer to the brain export directory as markdown or json. ' +
    'Pass the query, answer, and optionally metadata from the brain_query response. ' +
    'The file is written inside the brain\'s own runs/<brain>/exports/ directory and the path is returned.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The original query' },
      answer: { type: 'string', description: 'The answer to export' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default markdown)' },
      metadata: { type: 'object', description: 'Metadata from the brain_query response (models, mode, evidence counts, etc.)' },
    },
    required: ['query', 'answer'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.brainRoute) {
      return {
        content: `brain_query_export: agent brain not registered in cosmo23. Check: curl ${ctx.cosmo23BaseUrl}/api/brains`,
        is_error: true,
      };
    }

    const body = {
      query: input.query,
      answer: input.answer,
      format: (input.format as string) ?? 'markdown',
      metadata: input.metadata ?? {},
    };

    try {
      const res = await fetch(`${ctx.brainRoute}/export-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `brain_query_export failed: HTTP ${res.status} — ${errText.slice(0, 500)}`, is_error: true };
      }
      const data = await res.json() as { exportedTo?: string; error?: string };
      if (data.error) return { content: `brain_query_export: ${data.error}`, is_error: true };
      return { content: `Exported to: ${data.exportedTo ?? '(unknown path)'}` };
    } catch (err) {
      return { content: `brain_query_export error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

// ── brain_memory_graph — fetch network structure ─────────────────────────────

export const brainMemoryGraphTool: ToolDefinition = {
  name: 'brain_memory_graph',
  description:
    'Get a summarized view of the brain knowledge graph structure — node count, edge count, ' +
    'cluster count, top nodes by activation/weight, and optionally a sample of nodes filtered by tag. ' +
    'Use to answer "what clusters are forming?", "what are the most activated nodes right now?", ' +
    'or "show me a structural overview." Returns a summary, NOT the full graph (full is 10k+ nodes).',
  input_schema: {
    type: 'object',
    properties: {
      topN: { type: 'integer', description: 'How many top nodes to include (by activation*weight). Default 25, max 100.' },
      tag: { type: 'string', description: 'Optional: filter sample nodes by tag (e.g., agent_finding, insight, research).' },
    },
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topN = Math.min(Number(input.topN) || 25, 100);
    const tag = input.tag as string | undefined;

    try {
      const url = `http://localhost:${ctx.enginePort}/api/memory`;
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) return { content: `brain_memory_graph failed: HTTP ${res.status}`, is_error: true };

      const data = await res.json() as {
        nodes?: Array<{ id?: string | number; concept?: string; tag?: string; activation?: number; weight?: number; cluster?: number; accessCount?: number }>;
        edges?: Array<{ source?: string | number; target?: string | number; weight?: number; type?: string }>;
      };

      const nodes = data.nodes ?? [];
      const edges = data.edges ?? [];

      // Cluster counts
      const clusterCounts = new Map<number, number>();
      for (const n of nodes) {
        const c = typeof n.cluster === 'number' ? n.cluster : -1;
        clusterCounts.set(c, (clusterCounts.get(c) ?? 0) + 1);
      }

      // Top-N scoring
      const scored = nodes
        .filter(n => !tag || n.tag === tag)
        .map(n => ({
          id: n.id,
          concept: (n.concept ?? '').slice(0, 200),
          tag: n.tag,
          cluster: n.cluster,
          activation: n.activation ?? 0,
          weight: n.weight ?? 0,
          accessCount: n.accessCount ?? 0,
          score: (n.activation ?? 0) * (n.weight ?? 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);

      // Tag histogram
      const tagCounts = new Map<string, number>();
      for (const n of nodes) {
        const t = n.tag ?? '(none)';
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
      const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

      const summary = {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        clusters: [...clusterCounts.entries()].map(([id, size]) => ({ id, size })).sort((a, b) => b.size - a.size),
        topTags: topTags.map(([t, c]) => ({ tag: t, count: c })),
        topNodes: scored,
        filter: tag ? { tag } : null,
      };

      return { content: JSON.stringify(summary, null, 2).slice(0, 8000) };
    } catch (err) {
      return { content: `brain_memory_graph error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

// ── brain_synthesize — trigger meta-cognition ────────────────────────────────

export const brainSynthesizeTool: ToolDefinition = {
  name: 'brain_synthesize',
  description:
    'Trigger the synthesis agent to run a meta-cognition pass over the entire brain (async, ~30s). ' +
    'The agent reads the full memory graph + recent thoughts + coordinator state, produces higher-order ' +
    'insights, and writes to brain-state.json. Use when you want a fresh top-down view of what the brain ' +
    'has been learning. Call action="run" to start, action="status" to read the last synthesis output.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['run', 'status'],
        description: 'run = trigger synthesis; status = read latest synthesis output',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = input.action as string;

    try {
      if (action === 'run') {
        const url = `http://localhost:${ctx.enginePort}/api/synthesis/run`;
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return { content: `brain_synthesize run failed: HTTP ${res.status}`, is_error: true };
        const data = await res.json() as { started?: boolean; message?: string };
        return {
          content: data.started === false
            ? `Synthesis not started: ${data.message ?? 'unknown'}`
            : `Synthesis started (async). Call brain_synthesize with action="status" in ~30s to read the result.`,
        };
      }

      if (action === 'status') {
        const url = `http://localhost:${ctx.enginePort}/api/synthesis/state`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return { content: `brain_synthesize status failed: HTTP ${res.status}`, is_error: true };
        const data = await res.json() as Record<string, unknown>;
        return { content: JSON.stringify(data, null, 2).slice(0, 8000) };
      }

      return { content: `Unknown action: ${action}. Use 'run' or 'status'.`, is_error: true };
    } catch (err) {
      return { content: `brain_synthesize error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

export const brainStatusTool: ToolDefinition = {
  name: 'brain_status',
  description: 'Get the current status of the COSMO brain — node count, cycle number, health.',
  input_schema: {
    type: 'object',
    properties: {},
  },

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const url = `http://localhost:${ctx.enginePort}/api/state`;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });

      if (!res.ok) return { content: `Brain status check failed: HTTP ${res.status}`, is_error: true };

      const data = await res.json() as Record<string, unknown>;
      return { content: JSON.stringify(data, null, 2).slice(0, 4000) };
    } catch {
      return { content: 'Brain status unavailable — engine may not be running.', is_error: true };
    }
  },
};
