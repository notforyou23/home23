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
import { brainSearchTool, brainQueryTool, brainQueryExportTool, brainStatusTool, brainMemoryGraphTool, brainSynthesizeTool } from './brain.js';
import { generateImageTool, generateMusicTool, ttsTool } from './media.js';
import { cronScheduleTool, cronListTool, cronDeleteTool, cronEnableTool, cronDisableTool, cronUpdateTool } from './cron.js';
import { selfUpdateTool, selfReadTool } from './identity.js';
import { spawnAgentTool } from './subagent.js';
import { promoteToMemoryTool } from './promote.js';
import { skillsAuditTool, skillsGetTool, skillsListTool, skillsRunTool, skillsSuggestTool } from './skills.js';
import {
  listBrainsTool,
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

  register(tool: ToolDefinition): void {
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
  // COSMO 2.3 research toolkit — 11 tools (see docs/design/STEP16)
  registry.register(listBrainsTool);
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
  registry.register(promoteToMemoryTool);

  return registry;
}
