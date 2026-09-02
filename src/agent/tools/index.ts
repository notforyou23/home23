/**
 * COSMO Home 2.3 — Tool Registry
 *
 * Registers all tools and provides lookup by name.
 * Tools are registered at startup and their definitions
 * passed to the Anthropic SDK.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { shellTool } from './shell.js';
import { readFileTool, writeFileTool, editFileTool, listFilesTool, searchFilesTool } from './files.js';
import { webBrowseTool, createWebSearchTool, type WebToolsConfig } from './web.js';
import {
  brainCatalogTool, brainMemoryGraphTool, brainOperationsListTool, brainPgsPartitionsTool,
  brainQueryExportTool, brainQueryTool, brainSearchTool, brainStatusTool, brainSynthesizeTool,
} from './brain.js';
import { generateImageTool, generateMusicTool, ttsTool } from './media.js';
import { cronScheduleTool, cronListTool, cronRunTool, cronDeleteTool, cronEnableTool, cronDisableTool, cronUpdateTool } from './cron.js';
import { selfUpdateTool, selfReadTool } from './identity.js';
import { spawnAgentTool } from './subagent.js';
import { SUBAGENT_TOOL_GRANTS, type SubAgentToolGrant } from './subagent-grants.js';
import { workCancelTool, workListTool, workStatusTool } from './work.js';
import { promoteToMemoryTool } from './promote.js';
import { relationshipTools } from './relationship.js';
import { workerListTool, workerRunTool, workerStatusTool, workerReceiptTool, workerPromoteMemoryTool } from './workers.js';
import {
  codingRunTool,
  codingContinueTool,
  codingStatusTool,
  codingResultTool,
  codingCancelTool,
  codingJobsTool,
  codingBackendsTool,
} from './coding.js';
import {
  agencyBriefTool,
  agencyListTool,
  agencyCreatePursuitTool,
  agencyCreateTaskTool,
  agencyCloseTaskTool,
  agencyUpdatePursuitTool,
  agencyClosePursuitTool,
  agencyDiscardCandidateTool,
  agencyIntakeWorldStreamTool,
  agencyProposeDeltaTool,
  agencyRaiseQuestionTool,
  agencyRecordClaimTool,
  agencyRequestAuthorityTool,
  agencyScratchNoteTool,
  agencyTickTool,
} from './agency.js';
import { skillsAuditTool, skillsGetTool, skillsListTool, skillsRunTool, skillsSuggestTool } from './skills.js';
import { contactTools } from './contact.js';
import {
  listBrainsTool,
  listResearchRunsTool,
  queryBrainTool,
  searchAllBrainsTool,
  launchTool,
  continueRunTool,
  stopRunTool,
  watchRunTool,
  getBrainSummaryTool,
  getBrainGraphTool,
  compileBrainTool,
  compileSectionTool,
} from './research.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * 'generic' registries (the full shared toolset) refuse to execute for
   * restricted chat ids even if one is reached through an unexpected path —
   * restricted agents must only ever run against a 'seeded' registry built by
   * createSeededToolRegistry. Defense in depth, ported in shape from
   * codex/shakedown-jerry-recovery-port.
   */
  constructor(private readonly boundary: 'generic' | 'seeded' = 'generic') {}

  register(tool: ToolDefinition): void {
    if (this.boundary === 'generic') {
      const execute = tool.execute.bind(tool);
      this.tools.set(tool.name, Object.freeze({
        ...tool,
        async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          if (ctx.chatId?.startsWith('proposer:') || ctx.chatId?.startsWith('worker:')) {
            return { content: `refused: generic tool '${tool.name}' is unavailable to restricted chat '${ctx.chatId}'`, is_error: true };
          }
          return execute(input, ctx);
        },
      }));
      return;
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Get all tool definitions formatted for the Anthropic SDK tools parameter. */
  getAnthropicTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return Array.from(this.tools.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
  }

  /** Get all tool definitions formatted for OpenAI-compatible function calling. */
  getOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
  }

  async execute(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, is_error: true };
    }
    try {
      return await tool.execute(input, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Tool error (${name}): ${message}`, is_error: true };
    }
  }

  get size(): number {
    return this.tools.size;
  }
}

/** Create a registry containing ONLY the given tools (for restricted agents). */
export function createSeededToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry('seeded');
  for (const tool of tools) registry.register(tool);
  return registry;
}

/**
 * Worker tool grants: capability groups a Worker may be granted, and the exact
 * tools each group unlocks. A Worker gets the union of its enabled groups and
 * nothing else — this is the whole surface a restricted Worker can act through,
 * so it is enumerated rather than filtered from the full registry.
 */
const WORKER_TOOL_GRANT_GROUPS = {
  shell: () => [shellTool],
  files: () => [readFileTool, writeFileTool, editFileTool, listFilesTool, searchFilesTool],
  cron: () => [
    cronScheduleTool, cronListTool, cronRunTool, cronDeleteTool,
    cronEnableTool, cronDisableTool, cronUpdateTool,
  ],
  brain: () => [
    brainSearchTool, brainCatalogTool, brainOperationsListTool, brainPgsPartitionsTool,
    brainQueryTool, brainQueryExportTool, brainStatusTool, brainMemoryGraphTool,
    brainSynthesizeTool,
  ],
  web: (opts: { web?: WebToolsConfig } = {}) => [webBrowseTool, createWebSearchTool(opts.web)],
} as const;

export type WorkerToolGrants = Partial<Record<keyof typeof WORKER_TOOL_GRANT_GROUPS, boolean>>;

/**
 * Resolve a Worker's granted capability groups into the exact tool list.
 *
 * Fails CLOSED on an unrecognized group: a typo'd or invented grant name must
 * never silently resolve to "no extra tools" and read as a working grant. This
 * is an authority boundary, so an unknown name is an error, not a no-op.
 */
export function resolveWorkerTools(
  grants: WorkerToolGrants & Record<string, boolean | undefined>,
  opts: { web?: WebToolsConfig } = {},
): ToolDefinition[] {
  const known = Object.keys(WORKER_TOOL_GRANT_GROUPS);
  const unknown = Object.keys(grants ?? {}).filter((group) => !known.includes(group));
  if (unknown.length > 0) {
    throw new Error(`Unknown worker tool grant group(s): ${unknown.join(', ')}`);
  }

  const tools: ToolDefinition[] = [];
  // Iterate the declaration order, not the caller's key order, so an identical
  // grant set always produces an identical tool list.
  for (const group of known as (keyof typeof WORKER_TOOL_GRANT_GROUPS)[]) {
    if (grants?.[group] !== true) continue;
    tools.push(...WORKER_TOOL_GRANT_GROUPS[group](opts));
  }
  return tools;
}

/**
 * Temporary sub-agents are hands, not resident agents. Joined runs therefore
 * receive an explicit, closed grant list rather than inheriting the resident's
 * registry. Cron is intentionally absent: a foreground hand must not create a
 * lifecycle that outlives the turn which brought it in.
 */
export { SUBAGENT_TOOL_GRANTS, type SubAgentToolGrant } from './subagent-grants.js';

export function resolveSubAgentTools(
  grants: readonly string[],
  opts: { web?: WebToolsConfig } = {},
): ToolDefinition[] {
  const unknown = grants.filter((grant) => !SUBAGENT_TOOL_GRANTS.includes(grant as SubAgentToolGrant));
  if (unknown.length > 0) {
    throw new Error(`Unknown sub-agent tool grant(s): ${unknown.join(', ')}`);
  }

  const selected = new Set(grants as readonly SubAgentToolGrant[]);
  const tools: ToolDefinition[] = [];
  for (const grant of SUBAGENT_TOOL_GRANTS) {
    if (!selected.has(grant)) continue;
    tools.push(...WORKER_TOOL_GRANT_GROUPS[grant](opts));
  }
  return tools;
}

/** Create a fully loaded registry with all tools. */
export function createToolRegistry(opts: { web?: WebToolsConfig } = {}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(shellTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(listFilesTool);
  registry.register(searchFilesTool);
  registry.register(webBrowseTool);
  registry.register(createWebSearchTool(opts.web));
  registry.register(brainSearchTool);
  registry.register(brainCatalogTool);
  registry.register(brainOperationsListTool);
  registry.register(brainPgsPartitionsTool);
  registry.register(brainQueryTool);
  registry.register(brainQueryExportTool);
  registry.register(brainStatusTool);
  registry.register(brainMemoryGraphTool);
  registry.register(brainSynthesizeTool);
  registry.register(generateImageTool);
  registry.register(generateMusicTool);
  registry.register(ttsTool);
  registry.register(cronScheduleTool);
  registry.register(cronListTool);
  registry.register(cronRunTool);
  registry.register(cronDeleteTool);
  registry.register(cronEnableTool);
  registry.register(cronDisableTool);
  registry.register(cronUpdateTool);
  registry.register(selfUpdateTool);
  registry.register(selfReadTool);
  registry.register(skillsListTool);
  registry.register(skillsGetTool);
  registry.register(skillsSuggestTool);
  registry.register(skillsAuditTool);
  registry.register(skillsRunTool);
  registry.register(spawnAgentTool);
  registry.register(workListTool);
  registry.register(workStatusTool);
  registry.register(workCancelTool);
  // COSMO 2.3 research toolkit — 11 tools (see docs/design/STEP16)
  registry.register(listBrainsTool);
  registry.register(listResearchRunsTool);
  registry.register(queryBrainTool);
  registry.register(searchAllBrainsTool);
  registry.register(launchTool);
  registry.register(continueRunTool);
  registry.register(stopRunTool);
  registry.register(watchRunTool);
  registry.register(getBrainSummaryTool);
  registry.register(getBrainGraphTool);
  registry.register(compileBrainTool);
  registry.register(compileSectionTool);
  registry.register(workerListTool);
  registry.register(workerRunTool);
  registry.register(workerStatusTool);
  registry.register(workerReceiptTool);
  registry.register(workerPromoteMemoryTool);
  // Coding-backend bridge — 7 tools (see docs/design/STEP29)
  registry.register(codingRunTool);
  registry.register(codingContinueTool);
  registry.register(codingStatusTool);
  registry.register(codingResultTool);
  registry.register(codingCancelTool);
  registry.register(codingJobsTool);
  registry.register(codingBackendsTool);
  registry.register(agencyBriefTool);
  registry.register(agencyListTool);
  registry.register(agencyCreatePursuitTool);
  registry.register(agencyCreateTaskTool);
  registry.register(agencyCloseTaskTool);
  registry.register(agencyUpdatePursuitTool);
  registry.register(agencyClosePursuitTool);
  registry.register(agencyDiscardCandidateTool);
  registry.register(agencyIntakeWorldStreamTool);
  registry.register(agencyProposeDeltaTool);
  registry.register(agencyRaiseQuestionTool);
  registry.register(agencyRecordClaimTool);
  registry.register(agencyRequestAuthorityTool);
  registry.register(agencyScratchNoteTool);
  registry.register(agencyTickTool);
  registry.register(promoteToMemoryTool);
  for (const tool of relationshipTools) registry.register(tool);
  for (const tool of contactTools) registry.register(tool);

  return registry;
}
