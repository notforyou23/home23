import type { AgentLoop } from './loop.js';
import type { AgentEventCallback, AgentResponse, AgentLoopRunner } from './types.js';
import type { MediaAttachment } from '../types.js';
import { createSeededToolRegistry, type ToolRegistry } from './tools/index.js';
import type { ReasoningEffort } from './reasoning-effort.js';
import type { CoordinationTurnOrigin, DurableTurnStart } from './types.js';
import type { CoordinationWorkDestination } from '../work/types.js';

export async function executeTrackedTurn(
  agent: Pick<AgentLoop, 'runWithTurn'> & Partial<Pick<AgentLoop, 'stop'>>,
  chatId: string,
  userText: string,
  options: {
    signal?: AbortSignal;
    media?: MediaAttachment[];
    onEvent?: AgentEventCallback;
    inactivityMs?: number;
    hardDurationMs?: number;
    /** Outer caller deadline. Unlike the activity lease, this settles even if a provider ignores abort. */
    settlementTimeoutMs?: number;
    modelOverride?: { model: string; provider?: string; reasoningEffort?: ReasoningEffort };
    effort?: ReasoningEffort;
    registry?: ToolRegistry;
    coordinationOrigin?: CoordinationTurnOrigin;
    coordinationWorkDestination?: CoordinationWorkDestination;
    parentWorkId?: string;
    onDurableStart?: (start: DurableTurnStart) => void | Promise<void>;
    delegatedContext?: { systemPrompt: string; workspacePath: string };
  } = {},
): Promise<{ turnId: string; response: AgentResponse }> {
  options.signal?.throwIfAborted();
  const started = await agent.runWithTurn(chatId, userText, {
    media: options.media,
    onEvent: options.onEvent,
    inactivityMs: options.inactivityMs,
    hardDurationMs: options.hardDurationMs,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
    ...(options.delegatedContext ? { delegatedContext: options.delegatedContext } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.coordinationOrigin ? { coordinationOrigin: options.coordinationOrigin } : {}),
    ...(options.coordinationWorkDestination ? { coordinationWorkDestination: options.coordinationWorkDestination } : {}),
    ...(options.parentWorkId ? { parentWorkId: options.parentWorkId } : {}),
    ...(options.onDurableStart ? { onDurableStart: options.onDurableStart } : {}),
  });
  const cancel = () => agent.stop?.(chatId, started.turnId);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
  if (options.settlementTimeoutMs === undefined) {
    return { turnId: started.turnId, response: await started.response };
  }
  if (!Number.isSafeInteger(options.settlementTimeoutMs) || options.settlementTimeoutMs <= 0) {
    throw new TypeError('invalid turn settlement deadline');
  }
  const settlementTimeoutMs = options.settlementTimeoutMs;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      agent.stop?.(chatId, started.turnId);
      const error = Object.assign(
        new Error(`turn settlement timeout after ${settlementTimeoutMs}ms`),
        { code: 'turn_settlement_timeout' },
      );
      reject(error);
    }, settlementTimeoutMs);
    timer.unref?.();
  });
  try {
    return { turnId: started.turnId, response: await Promise.race([started.response, timeout]) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  } finally { options.signal?.removeEventListener('abort', cancel); }
}


/** Shared production boundary for general subagents and configured workers. */
export function createTrackedAgentRunner(agent: Parameters<typeof executeTrackedTurn>[0]): AgentLoopRunner {
  return async (_systemPrompt, userMessage, tools, ctx, options) => {
    const registry = options?.registry ?? ctx.turnRuntime?.registry
      ?? createSeededToolRegistry(tools);
    ctx.abortSignal?.throwIfAborted();
    const run = await agent.runWithTurn(ctx.chatId, userMessage, {
      modelOverride: options?.modelOverride,
      effort: options?.effort,
      onEvent: ctx.onEvent,
      parentWorkId: ctx.parentWorkId,
      delegationOrigin: ctx.delegationOrigin,
      onDurableStart: ctx.onDelegatedDurableStart,
      coordinationWorkDestination: ctx.coordinationWorkDestination,
      ...(_systemPrompt
        ? { delegatedContext: { systemPrompt: _systemPrompt, workspacePath: ctx.workspacePath } }
        : ctx.turnRuntime?.delegatedContext ? { delegatedContext: ctx.turnRuntime.delegatedContext } : {}),
      registry,
    });
    const cancel = () => agent.stop?.(ctx.chatId, run.turnId);
    ctx.abortSignal?.addEventListener('abort', cancel, { once: true });
    if (ctx.abortSignal?.aborted) cancel();
    try {
      const response = await run.response;
      if (response.terminalStatus && response.terminalStatus !== 'complete') {
        throw Object.assign(new Error(`Delegated turn ${response.terminalStatus}`), { code: `turn_${response.terminalStatus}` });
      }
      return response;
    } finally { ctx.abortSignal?.removeEventListener('abort', cancel); }
  };
}
