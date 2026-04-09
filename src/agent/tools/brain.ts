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
  description: 'Query the COSMO brain knowledge graph with semantic search + edge traversal. Fast (~200-500ms). Returns relevant nodes and connected knowledge.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question' },
      mode: { type: 'string', enum: ['normal', 'deep'], description: 'Query mode: normal (top 10, 1-hop edges) or deep (top 20, 2-hop edges). Default: normal' },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const mode = (input.mode as string) || 'normal';

    try {
      const url = `http://localhost:${ctx.enginePort}/api/query`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, mode }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `Brain query failed: HTTP ${res.status} — ${errText.slice(0, 300)}`, is_error: true };
      }

      const data = await res.json() as Record<string, unknown>;
      const answer = (data.answer ?? data.response ?? data.text ?? '') as string;
      return { content: answer.slice(0, 6000) || 'Query returned empty result.' };
    } catch (err) {
      return { content: `Brain query error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
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
