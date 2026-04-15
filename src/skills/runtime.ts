import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../agent/types.js';

type SkillModule = {
  listSkills?: () => unknown;
  getSkillInfo?: (skillId: string) => unknown;
  getSkillDetails?: (skillId: string) => unknown;
  executeSkill?: (
    skillId: string,
    action: string,
    params?: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  syncRegistry?: () => unknown;
};

function getSkillsEntryPath(projectRoot: string): string {
  return join(projectRoot, 'workspace', 'skills', 'index.js');
}

async function loadSkillsModule(projectRoot: string): Promise<SkillModule | null> {
  const entryPath = getSkillsEntryPath(projectRoot);
  if (!existsSync(entryPath)) return null;
  return import(pathToFileURL(entryPath).href) as Promise<SkillModule>;
}

function buildExecutionContext(projectRoot: string, ctx: ToolContext): Record<string, unknown> {
  return {
    projectRoot,
    workspacePath: ctx.workspacePath,
    tempDir: ctx.tempDir,
    enginePort: ctx.enginePort,
    chatId: ctx.chatId,
    browser: ctx.browser,
  };
}

export async function listSharedSkills(projectRoot: string): Promise<unknown[]> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.listSkills) return [];
  const result = await mod.listSkills();
  return Array.isArray(result) ? result : [];
}

export async function getSharedSkillDetails(projectRoot: string, skillId: string): Promise<unknown | null> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.getSkillDetails) return null;
  return await mod.getSkillDetails(skillId);
}

export async function executeSharedSkill(
  projectRoot: string,
  skillId: string,
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.executeSkill) {
    throw new Error('Shared skills runtime is unavailable');
  }

  return mod.executeSkill(skillId, action, params, buildExecutionContext(projectRoot, ctx));
}

export async function syncSharedSkillsRegistry(projectRoot: string): Promise<unknown | null> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.syncRegistry) return null;
  return await mod.syncRegistry();
}
