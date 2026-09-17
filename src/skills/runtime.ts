/**
 * Skills load and run in-process via a dynamic `import()` of workspace/skills/index.js
 * (see loadSkillsModule below) and call fs directly — they do not go through
 * tracked-source-guard / shell-write-guard at all. This is deliberate, not
 * an oversight: skills are maintained first-party code shipped the same way
 * the rest of the harness is, not agent-authored shell improvisation. A
 * guard fenced around trusted code you already reviewed and shipped would
 * cost real complexity for no real protection. If skills ever start
 * accepting untrusted, model-authored code paths, this needs revisiting.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext } from '../agent/types.js';

type SkillModule = {
  listSkills?: () => unknown;
  getSkillInfo?: (skillId: string) => unknown;
  getSkillDetails?: (skillId: string) => unknown;
  suggestSkills?: (task: string, options?: Record<string, unknown>) => unknown;
  auditSkills?: (options?: Record<string, unknown>) => unknown;
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
    abortSignal: ctx.abortSignal,
    onEvent: ctx.onEvent,
    coordinationWorkDestination: ctx.coordinationWorkDestination,
    parentWorkId: ctx.parentWorkId,
    invocationId: ctx.parentToolCallId,
  };
}

function telemetryDir(projectRoot: string): string {
  return join(projectRoot, process.env.HOME23_PRODUCT_HOST === 'true' ? 'runtime' : 'workspace', 'skills', '.telemetry');
}

function deriveAgentName(workspacePath: string): string {
  const parent = dirname(workspacePath);
  return basename(parent) || 'unknown';
}

function recordTelemetry(
  projectRoot: string,
  event: string,
  ctx?: ToolContext | null,
  payload: Record<string, unknown> = {},
): void {
  try {
    const dir = telemetryDir(projectRoot);
    const productHost = process.env.HOME23_PRODUCT_HOST === 'true';
    mkdirSync(dir, { recursive: true, ...(productHost ? { mode: 0o700 } : {}) });
    const filePath = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = {
      ts: new Date().toISOString(),
      event,
      agent: ctx?.workspacePath ? deriveAgentName(ctx.workspacePath) : 'system',
      chatId: ctx?.chatId || '',
      ...payload,
    };
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', ...(productHost ? { mode: 0o600 } : {}) });
  } catch {
    // Telemetry must never break the agent loop.
  }
}

export async function listSharedSkills(projectRoot: string, ctx?: ToolContext | null): Promise<unknown[]> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.listSkills) return [];
  const result = await mod.listSkills();
  const skills = Array.isArray(result) ? result : [];
  recordTelemetry(projectRoot, 'skills_list', ctx, { resultCount: skills.length });
  return skills;
}

export async function getSharedSkillDetails(projectRoot: string, skillId: string, ctx?: ToolContext | null): Promise<unknown | null> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.getSkillDetails) return null;
  const details = await mod.getSkillDetails(skillId);
  recordTelemetry(projectRoot, 'skills_get', ctx, { skillId, found: !!details });
  return details;
}

export async function suggestSharedSkills(
  projectRoot: string,
  task: string,
  ctx?: ToolContext | null,
): Promise<unknown[]> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.suggestSkills) return [];
  const result = await mod.suggestSkills(task, {});
  const suggestions = Array.isArray(result) ? result : [];
  recordTelemetry(projectRoot, 'skills_suggest', ctx, { task, resultCount: suggestions.length });
  return suggestions;
}

export async function auditSharedSkills(
  projectRoot: string,
  options: Record<string, unknown> = {},
  ctx?: ToolContext | null,
): Promise<unknown | null> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.auditSkills) return null;
  const result = await mod.auditSkills(options);
  recordTelemetry(projectRoot, 'skills_audit', ctx, { skillId: options.skillId ?? '', telemetryDays: options.telemetryDays ?? '' });
  return result;
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

  const startedAt = Date.now();
  try {
    ctx.abortSignal?.throwIfAborted();
    // Await the actual action, even when cancellation was requested. Arbitrary actions
    // cannot be declared stopped by racing their promise against an abort timer.
    const result = await mod.executeSkill(skillId, action, params, buildExecutionContext(projectRoot, ctx));
    ctx.abortSignal?.throwIfAborted();
    recordTelemetry(projectRoot, 'skills_run', ctx, {
      skillId,
      action,
      success: true,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    recordTelemetry(projectRoot, 'skills_run', ctx, {
      skillId,
      action,
      success: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function syncSharedSkillsRegistry(projectRoot: string): Promise<unknown | null> {
  const mod = await loadSkillsModule(projectRoot);
  if (!mod?.syncRegistry) return null;
  return await mod.syncRegistry();
}
