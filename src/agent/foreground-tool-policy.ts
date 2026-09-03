/**
 * Foreground tool policy: only bounded, fast tools may run inside a speaking
 * turn. Anything that can materially delay conversation must become durable
 * Work before execution starts.
 *
 * Tools that already create Work at their own boundary are handed off
 * (no wait). Tools that have no create-Work path in this lane are refused
 * with a detach request for Lane 2.
 */

import { isForegroundConversation } from './foreground-admission.js';
import type { ToolContext, TurnRuntimeContext } from './types.js';

export const FOREGROUND_SHELL_MAX_TIMEOUT_MS = 8_000;

export type ForegroundToolAction = 'permit' | 'handoff' | 'require_work';

export interface ForegroundDetachRequest {
  tool: string;
  reason: string;
  chatId: string;
  turnId?: string;
}

export interface ForegroundToolDecision {
  action: ForegroundToolAction;
  tool: string;
  input: Record<string, unknown>;
  reason?: string;
  request?: ForegroundDetachRequest;
}

const REQUIRE_WORK_TOOLS = new Set([
  'worker_run',
  'research_launch',
  'research_continue',
  'research_compile_brain',
  'research_compile_section',
  'generate_image',
  'generate_music',
  'tts',
  'skills_run',
  'cron_run',
  'brain_synthesize',
  'brain_query_export',
]);

function asRecord(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input };
}

export function classifyForegroundTool(name: string): Exclude<ForegroundToolAction, 'permit'> | 'permit' {
  if (name === 'coding_run' || name === 'coding_continue' || name === 'spawn_agent' || name === 'shell') {
    return 'handoff';
  }
  if (REQUIRE_WORK_TOOLS.has(name)) return 'require_work';
  return 'permit';
}

export function applyForegroundToolPolicy(
  name: string,
  input: Record<string, unknown>,
  ctx: Pick<ToolContext, 'chatId'> & { turnRuntime?: TurnRuntimeContext | null },
): ForegroundToolDecision {
  const foreground = isForegroundConversation({
    chatId: ctx.chatId,
    coordinationOrigin: ctx.turnRuntime?.coordinationOrigin,
  });
  if (!foreground) {
    return { action: 'permit', tool: name, input };
  }

  const kind = classifyForegroundTool(name);
  if (kind === 'permit') {
    return { action: 'permit', tool: name, input };
  }

  if (kind === 'require_work') {
    const request: ForegroundDetachRequest = {
      tool: name,
      reason: `${name} can materially delay conversation and must become durable Work before execution`,
      chatId: ctx.chatId,
      turnId: ctx.turnRuntime?.turnId,
    };
    return {
      action: 'require_work',
      tool: name,
      input,
      reason: request.reason,
      request,
    };
  }

  const next = asRecord(input);
  if (name === 'coding_run' || name === 'coding_continue') {
    next.wait_seconds = 0;
    return {
      action: 'handoff',
      tool: name,
      input: next,
      reason: 'foreground coding must create Work and return immediately',
    };
  }
  if (name === 'spawn_agent') {
    next.mode = 'detached';
    return {
      action: 'handoff',
      tool: name,
      input: next,
      reason: 'foreground spawn_agent must detach as Work before the specialist runs',
    };
  }
  if (name === 'shell') {
    const requested = Number(next.timeout_ms);
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), FOREGROUND_SHELL_MAX_TIMEOUT_MS)
      : FOREGROUND_SHELL_MAX_TIMEOUT_MS;
    next.timeout_ms = timeoutMs;
    return {
      action: 'handoff',
      tool: name,
      input: next,
      reason: `foreground shell timeout clamped to ${FOREGROUND_SHELL_MAX_TIMEOUT_MS}ms`,
    };
  }

  return { action: 'permit', tool: name, input };
}

export function foregroundDetachRefusal(decision: ForegroundToolDecision): string {
  return [
    `Foreground policy: ${decision.tool} was not started.`,
    decision.reason ?? 'This operation must become durable Work before execution.',
    'Detach is not wired yet; do not claim this assignment exists as Work.',
    'Use work_list only to inspect Work that is already active.',
  ].join(' ');
}
