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
        signal: AbortSignal.timeout(30_000),
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
    'Query the brain knowledge graph with LLM synthesis + edge traversal. ' +
    'Nine modes trade context breadth for reasoning depth: ' +
    'fast (quick factual, 100 nodes, low reasoning), ' +
    'normal (balanced, 200 nodes, default), ' +
    'deep (multi-hop, 400 nodes, high reasoning), ' +
    'raw (150 nodes, direct data dump with minimal synthesis), ' +
    'report (600 nodes, academic-style full synthesis), ' +
    'innovation (300 nodes, creative/novel discovery), ' +
    'consulting (300 nodes, strategic advice), ' +
    'grounded (300 nodes, every claim cited), ' +
    'executive (compresses a prior answer, requires baseAnswer). ' +
    'Pick a mode based on how much context you need and how much the answer should reason vs. just surface facts.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question' },
      mode: {
        type: 'string',
        enum: ['fast', 'normal', 'deep', 'raw', 'report', 'innovation', 'consulting', 'grounded', 'executive'],
        description: 'Query mode (see tool description). Default: normal.',
      },
      baseAnswer: {
        type: 'string',
        description: 'For executive mode only: the prior answer to compress. Ignored in other modes.',
      },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const mode = (input.mode as string) || 'normal';
    const baseAnswer = input.baseAnswer as string | undefined;

    try {
      const url = `http://localhost:${ctx.enginePort}/api/query`;
      const body: Record<string, unknown> = { query, mode };
      if (mode === 'executive' && baseAnswer) body.baseAnswer = baseAnswer;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `Brain query failed: HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
      }

      const data = await res.json() as Record<string, unknown>;
      const answer = (data.answer ?? data.response ?? data.text ?? '') as string;
      const evidence = data.evidence as Array<{ nodeId?: string | number; concept?: string }> | undefined;
      const meta = data.metadata as Record<string, unknown> | undefined;

      const suffix = evidence && evidence.length
        ? `\n\n---\n[${evidence.length} evidence nodes cited · mode=${mode}${meta?.evidenceQuality ? ` · quality=${JSON.stringify(meta.evidenceQuality)}` : ''}]`
        : `\n\n---\n[mode=${mode}]`;

      return { content: (answer.slice(0, 8000) || 'Query returned empty result.') + suffix };
    } catch (err) {
      return { content: `Brain query error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
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
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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
        const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) });
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
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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

// ── brain_pgs — Progressive Graph Search ─────────────────────────────────────

export const brainPgsTool: ToolDefinition = {
  name: 'brain_pgs',
  description:
    'Progressive Graph Search over the full brain. Four-phase pipeline: partition the graph (Louvain), ' +
    'route the query to relevant partitions, run parallel LLM sweeps per partition, synthesize across. ' +
    'Optimized for COVERAGE and finding what standard RAG misses — reports absences, discovers ' +
    'cross-domain connections. Slow (~20-60s) but most thorough. ' +
    'Dual-model control: sweeps run many parallel calls, so pick a cheap/fast model (e.g. ' +
    'minimax-m2.7-highspeed, nemotron-3-nano, gpt-5.4-mini). Synthesis is one final reasoning pass, so a ' +
    'stronger model helps (e.g. claude-opus-4-7, MiniMax-M2.7, gpt-5.4). If models are omitted, uses the ' +
    "engine's default model for both.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question' },
      mode: {
        type: 'string',
        enum: ['full', 'targeted'],
        description: 'full = sweep all routed partitions (default), targeted = single deepest partition only (faster)',
      },
      maxPartitions: {
        type: 'integer',
        description: 'Cap on how many partitions to sweep. Default 5. Higher = more coverage, slower.',
      },
      sweepModel: {
        type: 'string',
        description: 'Model for parallel partition sweeps (many calls — pick fast/cheap). E.g. MiniMax-M2.7-highspeed, gpt-5.4-mini, nemotron-3-super.',
      },
      synthesisModel: {
        type: 'string',
        description: 'Model for the single cross-partition synthesis pass (pick stronger). E.g. claude-opus-4-7, MiniMax-M2.7, gpt-5.4.',
      },
      sweepProvider: {
        type: 'string',
        description: 'Optional provider override for sweeps (minimax / anthropic / openai / openai-codex / xai / ollama-cloud). Usually auto-resolved from model name.',
      },
      synthesisProvider: {
        type: 'string',
        description: 'Optional provider override for synthesis.',
      },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const mode = (input.mode as string) || 'full';
    const maxPartitions = Number(input.maxPartitions) || 5;
    const sweepModel = input.sweepModel as string | undefined;
    const synthesisModel = input.synthesisModel as string | undefined;
    const sweepProvider = input.sweepProvider as string | undefined;
    const synthesisProvider = input.synthesisProvider as string | undefined;

    try {
      const url = `http://localhost:${ctx.enginePort}/api/pgs`;
      const body: Record<string, unknown> = { query, mode, maxPartitions };
      if (sweepModel) body.sweepModel = sweepModel;
      if (synthesisModel) body.synthesisModel = synthesisModel;
      if (sweepProvider) body.sweepProvider = sweepProvider;
      if (synthesisProvider) body.synthesisProvider = synthesisProvider;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `brain_pgs failed: HTTP ${res.status} — ${errText.slice(0, 500)}`, is_error: true };
      }

      const data = await res.json() as {
        answer?: string;
        synthesis?: string;
        partitions?: Array<{ id?: string; size?: number; keywords?: string[]; score?: number }>;
        sweeps?: Array<{ partitionId?: string; finding?: string }>;
        absences?: string[];
        crossDomain?: string[];
        metadata?: { models?: { sweep?: string; sweepProvider?: string; synthesis?: string; synthesisProvider?: string } } & Record<string, unknown>;
      };

      const parts: string[] = [];
      if (data.synthesis || data.answer) {
        parts.push(`## Synthesis\n${data.synthesis ?? data.answer}`);
      }
      if (data.absences && data.absences.length) {
        parts.push(`## Notable Absences\n- ${data.absences.join('\n- ')}`);
      }
      if (data.crossDomain && data.crossDomain.length) {
        parts.push(`## Cross-Domain Connections\n- ${data.crossDomain.join('\n- ')}`);
      }
      if (data.partitions && data.partitions.length) {
        const pList = data.partitions.slice(0, 10).map(p =>
          `- [${p.id}] size=${p.size} score=${p.score?.toFixed?.(3) ?? '?'} keywords=${(p.keywords ?? []).slice(0, 5).join(', ')}`
        ).join('\n');
        parts.push(`## Partitions Swept (${data.partitions.length})\n${pList}`);
      }
      if (data.metadata?.models) {
        const m = data.metadata.models;
        parts.push(`---\n_[PGS models: sweep=${m.sweep} (${m.sweepProvider}), synthesis=${m.synthesis} (${m.synthesisProvider})]_`);
      }

      const out = parts.join('\n\n') || 'PGS returned no synthesis.';
      return { content: out.slice(0, 10_000) };
    } catch (err) {
      return { content: `brain_pgs error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
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
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });

      if (!res.ok) return { content: `Brain status check failed: HTTP ${res.status}`, is_error: true };

      const data = await res.json() as Record<string, unknown>;
      return { content: JSON.stringify(data, null, 2).slice(0, 4000) };
    } catch {
      return { content: 'Brain status unavailable — engine may not be running.', is_error: true };
    }
  },
};
