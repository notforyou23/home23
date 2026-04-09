/**
 * Research tool — queries existing COSMO 2.3 brains, launches new runs, checks status.
 *
 * The agent should search existing research before launching new runs.
 * Runs take minutes to hours — the tool returns immediately with a run ID.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js';

function getCosmoBase(_ctx?: ToolContext): string {
  const port = parseInt(process.env.COSMO23_PORT || '43210', 10);
  return `http://localhost:${port}`;
}

export const researchTool: ToolDefinition = {
  name: 'research',
  description: `Access COSMO 2.3 deep research engine. Four actions:
- search: Query existing research brains for knowledge (ALWAYS try this first)
- launch: Start a new multi-agent research run (takes minutes to hours)
- status: Check active/recent run status
- compile: Distill a completed research run into a summary and write it to your workspace for brain ingestion`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'launch', 'status', 'compile'],
        description: 'Action to perform',
      },
      query: {
        type: 'string',
        description: 'For search: the question to search across research brains. For launch: the research topic.',
      },
      mode: {
        type: 'string',
        enum: ['guided', 'autonomous'],
        description: 'For launch: research mode (default: guided)',
      },
      runId: {
        type: 'string',
        description: 'For status: specific run ID to check (omit for overview)',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = input.action as string;

    try {
      switch (action) {
        case 'search':
          return await searchBrains(input.query as string, ctx);
        case 'launch':
          return await launchRun(input.query as string, (input.mode as string) || 'guided', ctx);
        case 'status':
          return await getStatus(input.runId as string | undefined, ctx);
        case 'compile':
          return await compileResearch(input.runId as string | undefined, ctx);
        default:
          return { content: `Unknown action: ${action}. Use search, launch, or status.`, is_error: true };
      }
    } catch (err) {
      return {
        content: `Research tool error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  },
};

async function searchBrains(query: string, ctx?: ToolContext): Promise<ToolResult> {
  const COSMO23_URL = getCosmoBase(ctx);
  if (!query) {
    return { content: 'Query is required for search action.', is_error: true };
  }

  const brainsRes = await fetch(`${COSMO23_URL}/api/brains`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!brainsRes.ok) {
    return { content: 'COSMO 2.3 is not running or unreachable.', is_error: true };
  }

  const brainsData = await brainsRes.json() as { brains: Array<{ id: string; name: string; path: string }> };
  const brains = brainsData.brains || [];

  if (brains.length === 0) {
    return { content: 'No research brains available. Use action "launch" to start a research run.' };
  }

  const results: string[] = [];
  const brainsToQuery = brains.slice(0, 5);

  for (const brain of brainsToQuery) {
    try {
      const queryRes = await fetch(`${COSMO23_URL}/api/brain/${encodeURIComponent(brain.id)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          mode: 'normal',
          enableSynthesis: true,
          includeThoughts: true,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (queryRes.ok) {
        const result = await queryRes.json() as { response?: string; answer?: string };
        const answer = result.response || result.answer || '';
        if (answer && answer.length > 50) {
          results.push(`## ${brain.name || brain.id}\n${answer}`);
        }
      }
    } catch {
      // Skip brains that fail to query
    }
  }

  if (results.length === 0) {
    return {
      content: `Searched ${brainsToQuery.length} research brain(s) for "${query}" — no relevant findings. Consider launching a new research run.`,
    };
  }

  return {
    content: `Found relevant research across ${results.length} brain(s):\n\n${results.join('\n\n---\n\n')}`,
  };
}

async function launchRun(topic: string, mode: string, ctx?: ToolContext): Promise<ToolResult> {
  const COSMO23_URL = getCosmoBase(ctx);
  if (!topic) {
    return { content: 'Topic is required for launch action.', is_error: true };
  }

  const res = await fetch(`${COSMO23_URL}/api/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      explorationMode: mode,
      analysisDepth: 'normal',
      cycles: 80,
      maxConcurrent: 4,
      enableWebSearch: true,
      enableCodingAgents: true,
      enableAgentRouting: true,
      enableMemoryGovernance: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    return { content: `Failed to launch research: ${err.error || res.statusText}`, is_error: true };
  }

  const result = await res.json() as { success: boolean; runName?: string; message?: string };

  if (result.success) {
    return {
      content: `Research run launched: "${result.runName || topic}". This will take a while (minutes to hours). Use action "status" to check progress. The brain will be available for querying once complete.`,
    };
  }

  return { content: `Launch failed: ${result.message || 'Unknown error'}`, is_error: true };
}

async function getStatus(runId?: string, ctx?: ToolContext): Promise<ToolResult> {
  const COSMO23_URL = getCosmoBase(ctx);
  const parts: string[] = [];

  try {
    const currentRes = await fetch(`${COSMO23_URL}/api/runs/current`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!currentRes.ok) {
      return { content: 'COSMO 2.3 is not running or unreachable.', is_error: true };
    }

    const current = await currentRes.json() as {
      name?: string;
      metadata?: { cycle?: number; agentCount?: number; status?: string } | null;
      logsDir?: string;
    };

    const isActive = current.name && current.name !== 'brain' && current.name !== 'runtime';
    if (isActive) {
      parts.push(`Active run: "${current.name}" — cycle ${current.metadata?.cycle || '?'}, ${current.metadata?.agentCount || 0} agents`);
    } else {
      parts.push('No active research run.');
    }
  } catch {
    return { content: 'COSMO 2.3 is not running or unreachable.', is_error: true };
  }

  try {
    const runsRes = await fetch(`${COSMO23_URL}/api/runs`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (runsRes.ok) {
      const runsData = await runsRes.json() as {
        current?: { name?: string };
        runs?: Array<{ name?: string; metadata?: { status?: string } | null }>;
      };
      const runs = (runsData.runs || []).filter(r => !runId || r.name === runId);
      if (runs.length > 0) {
        parts.push(`\nCompleted research brains (${runs.length}):`);
        for (const r of runs.slice(0, 10)) {
          parts.push(`  - ${r.name || 'unnamed'}${r.metadata?.status ? ` [${r.metadata.status}]` : ''}`);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return { content: parts.join('\n') };
}

async function compileResearch(runId?: string, ctx?: ToolContext): Promise<ToolResult> {
  const COSMO23_URL = getCosmoBase(ctx);
  if (!runId) {
    return { content: 'runId is required for compile action. Use status to see available runs.', is_error: true };
  }

  const brainRes = await fetch(`${COSMO23_URL}/api/brains/${encodeURIComponent(runId)}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!brainRes.ok) {
    return { content: `Run "${runId}" not found. Use status to see available runs.`, is_error: true };
  }

  const queryRes = await fetch(`${COSMO23_URL}/api/brain/${encodeURIComponent(runId)}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'Provide a comprehensive summary of all key findings, conclusions, and insights from this research. Include the main topic, methodology, key discoveries, contradictions found, and open questions remaining.',
      mode: 'expert',
      enableSynthesis: true,
      includeCoordinatorInsights: true,
      includeThoughts: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!queryRes.ok) {
    return { content: `Failed to query research brain: HTTP ${queryRes.status}`, is_error: true };
  }

  const queryResult = await queryRes.json() as { response?: string; answer?: string };
  const summary = queryResult.response || queryResult.answer || '';

  if (!summary || summary.length < 50) {
    return { content: 'Research brain returned insufficient summary.', is_error: true };
  }

  const agentName = process.env.HOME23_AGENT || 'test-agent';
  const projectRoot = process.cwd();
  const researchDir = `${projectRoot}/instances/${agentName}/workspace/research`;
  const filename = `cosmo-${runId}-${new Date().toISOString().slice(0, 10)}.md`;

  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(researchDir, { recursive: true });
    const content = `# COSMO Research: ${runId}\n\nCompiled: ${new Date().toISOString()}\nSource: COSMO 2.3 run "${runId}"\n\n---\n\n${summary}`;
    writeFileSync(`${researchDir}/${filename}`, content);

    return {
      content: `Research "${runId}" compiled and written to workspace. The feeder will compile and ingest it into your brain. Summary: ${summary.slice(0, 500)}...`,
    };
  } catch (err) {
    return { content: `Failed to write research summary: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
  }
}
