/**
 * Temporary specialist tool.
 *
 * Joined specialists are foreground hands: they run in a fresh subagent chat,
 * with an explicitly seeded tool registry, and their exact result comes back
 * through this tool call so the resident can use it in the current answer.
 * Detached specialists preserve the durable background-delivery behavior.
 */

import { randomBytes } from 'node:crypto';
import type {
  SubAgentExecutionMode,
  ToolDefinition,
  ToolContext,
  ToolResult,
} from '../types.js';
import { resolveModelOverride } from '../model-resolution.js';
import { parseReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from '../reasoning-effort.js';
import { SUBAGENT_TOOL_GRANTS } from './subagent-grants.js';
import type { CoordinationWorkDestination } from '../../work/types.js';

/** Leaves room for the loop's 4,000-character tool-result framing. */
export const JOINED_RESULT_MAX_CHARS = 3_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isCancellation(error: unknown, requested: boolean, signal?: AbortSignal): boolean {
  if (requested || signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === 'AbortError' || code === 'operator_stop' || code === 'cancelled';
}

function releaseTracker(ctx: ToolContext): void {
  ctx.subAgentTracker.active--;
  if (ctx.subAgentTracker.queue.length > 0) {
    const next = ctx.subAgentTracker.queue.shift()!;
    next.resolve();
  }
}

function coordinationDestination(ctx: ToolContext): CoordinationWorkDestination | null {
  const origin = ctx.turnRuntime?.coordinationOrigin;
  const delivery = ctx.turnRuntime?.coordinationDelivery;
  if (!origin || !delivery || origin.originMessageId === null) return null;
  if (
    ctx.chatId !== `coordination:${origin.channelId}:${origin.workId}` ||
    delivery.targetPrincipalId !== origin.holderPrincipalId ||
    origin.authorityReference !== `resident:${ctx.agentName}`
  ) return null;
  return Object.freeze({
    kind: 'coordination',
    parentWorkId: origin.workId,
    channelId: origin.channelId,
    conversationId: delivery.conversationId,
    originMessageId: origin.originMessageId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    fencingToken: origin.fencingToken,
    targetPrincipalId: delivery.targetPrincipalId,
    residentBinding: ctx.agentName,
    residentInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
  });
}

export const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Bring in a temporary specialist. Joined mode waits and returns the specialist result into the current answer. Detached mode runs durable background work and returns immediately.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Self-contained task for the specialist' },
      label: { type: 'string', description: 'Short human label for the specialist run' },
      mode: {
        type: 'string',
        enum: ['joined', 'detached'],
        description: 'joined waits for a result needed in this answer; detached continues in the background. Canonical Connected Agents conversations default to joined; explicit detached mode requires their durable canonical completion bridge.',
      },
      tool_grants: {
        type: 'array',
        items: { type: 'string', enum: [...SUBAGENT_TOOL_GRANTS] },
        description: 'Joined mode only. Explicit minimal capability groups; omit or [] for a no-tools specialist.',
      },
      isolated: { type: 'boolean', description: 'Detached mode only. Run under a fresh sub-chat id (default true); joined mode is always isolated.' },
      model: { type: 'string', description: 'Model override for the specialist turn (provider inferred from the model name)' },
      effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Reasoning effort for the specialist turn' },
    },
    required: ['task'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = input.task as string;
    const label = typeof input.label === 'string' && input.label ? input.label.slice(0, 100) : undefined;
    const rawMode = input.mode;
    if (rawMode !== undefined && rawMode !== 'joined' && rawMode !== 'detached') {
      return { content: 'spawn_agent mode must be "joined" or "detached".', is_error: true };
    }
    const isCanonicalCoordinationChat = ctx.chatId.startsWith('coordination:');
    const canonicalDestination = coordinationDestination(ctx);
    if (
      isCanonicalCoordinationChat && rawMode === 'detached' &&
      (!canonicalDestination || !ctx.workRegistry || !ctx.onWorkTerminal)
    ) {
      return {
        content: 'Detached specialist delivery is unavailable for this Connected Agents turn; use joined mode.',
        is_error: true,
      };
    }
    const mode: SubAgentExecutionMode = rawMode === 'joined' || (rawMode === undefined && isCanonicalCoordinationChat)
      ? 'joined'
      : 'detached';
    const isolated = mode === 'joined' || input.isolated !== false;
    const model = typeof input.model === 'string' && input.model ? input.model : undefined;
    const modelOverride = model ? resolveModelOverride(model, ctx.modelAliases) : undefined;
    let effort: ReasoningEffort | undefined;
    try {
      effort = parseReasoningEffort(input.effort, 'spawn_agent effort');
    } catch (error) {
      return { content: error instanceof Error ? error.message : 'spawn_agent effort is invalid', is_error: true };
    }

    if (model && !modelOverride) {
      return {
        content: `Unable to resolve sub-agent model override "${model}". Use a configured model alias or a supported raw model name.`,
        is_error: true,
      };
    }

    if (!ctx.runAgentLoop) {
      return { content: 'Sub-agent spawning not available (agent loop runner not configured).', is_error: true };
    }

    let systemPrompt: string;
    try {
      // Resolve before creating Work or emitting start evidence. A prompt-source
      // failure means no specialist run began.
      systemPrompt = ctx.contextManager.getSystemPrompt();
    } catch (error) {
      return { content: `Unable to prepare sub-agent context: ${errorMessage(error)}`, is_error: true };
    }

    let joinedTools: ToolDefinition[] = [];
    let joinedRegistry: import('./index.js').ToolRegistry | undefined;
    if (mode === 'joined') {
      if (input.isolated === false) {
        return { content: 'Joined specialists are always isolated; remove isolated:false or use detached mode.', is_error: true };
      }
      const rawGrants = input.tool_grants ?? [];
      if (!Array.isArray(rawGrants) || rawGrants.some((grant) => typeof grant !== 'string')) {
        return { content: 'spawn_agent tool_grants must be an array of grant names.', is_error: true };
      }
      try {
        // Delayed to avoid the index -> subagent registration cycle during module initialization.
        const { createSeededToolRegistry, resolveSubAgentTools } = await import('./index.js');
        joinedTools = resolveSubAgentTools(rawGrants as string[], ctx.restrictedToolSource);
        // This override is mandatory even when joinedTools is empty. Omitting it
        // would make the loop fall back to the resident's unrestricted registry.
        joinedRegistry = createSeededToolRegistry(joinedTools);
      } catch (error) {
        return { content: errorMessage(error), is_error: true };
      }
    } else if (input.tool_grants !== undefined) {
      return { content: 'spawn_agent tool_grants apply only to joined mode.', is_error: true };
    }

    const tracker = ctx.subAgentTracker;
    const headline = label ?? task.slice(0, 100);
    const subChatId = isolated
      ? `subagent:${ctx.chatId}:${randomBytes(mode === 'joined' ? 16 : 2).toString('hex')}`
      : ctx.chatId;

    if (tracker.active >= tracker.maxConcurrent) {
      return { content: `Sub-agent limit reached (${tracker.maxConcurrent} active). Try again when a current sub-agent completes, or wait.` };
    }

    // Keep lineage/evidence for both modes. Joined work is terminalized here
    // but deliberately never enters detached completion delivery.
    const work = ctx.workRegistry?.create({
      kind: 'subagent',
      originChatId: ctx.chatId,
      originTurnId: ctx.turnRuntime?.turnId,
      parentWorkId: canonicalDestination?.parentWorkId ?? ctx.parentWorkId,
      ...(mode === 'detached' && canonicalDestination
        ? { coordinationDestination: canonicalDestination }
        : {}),
      deliveryMode: mode === 'joined' ? 'inline' : 'detached',
      label: headline,
      resultHandle: { type: 'subagent_chat', chatId: subChatId },
    }) ?? null;
    const subagentId = work?.workId ?? subChatId;
    ctx.onEvent?.({
      type: 'subagent_start',
      subagentId,
      task,
      label: headline,
      parentToolCallId: ctx.parentToolCallId,
      sourceEventType: 'runtime.subagent_started',
    });

    const subCtx: ToolContext = {
      ...ctx,
      chatId: subChatId,
      parentWorkId: work?.workId ?? ctx.parentWorkId,
    };
    const commonOptions = {
      ...(modelOverride ? { modelOverride } : {}),
      ...(effort ? { effort } : {}),
    };

    if (mode === 'joined') {
      tracker.active++;
      let cancellationRequested = false;
      const cancelJoined = (): void => {
        cancellationRequested = true;
        if (work && ctx.requestWorkCancel) ctx.requestWorkCancel(work.workId);
      };
      ctx.abortSignal?.addEventListener('abort', cancelJoined, { once: true });
      try {
        ctx.abortSignal?.throwIfAborted();
        const joinedTask = [
          task,
          '',
          '[Joined specialist output contract]',
          `Return one self-contained, concise synthesis no longer than ${JOINED_RESULT_MAX_CHARS} characters.`,
          'Do not dump raw logs or evidence; preserve only the facts the resident needs for its current answer.',
        ].join('\n');
        const result = await ctx.runAgentLoop(
          systemPrompt,
          joinedTask,
          joinedTools,
          subCtx,
          { ...commonOptions, registry: joinedRegistry! },
        );
        ctx.abortSignal?.throwIfAborted();
        if (result.text.length > JOINED_RESULT_MAX_CHARS) {
          throw Object.assign(
            new Error(`joined specialist result exceeded ${JOINED_RESULT_MAX_CHARS} characters`),
            { code: 'joined_result_too_large' },
          );
        }

        ctx.onEvent?.({
          type: 'subagent_result', subagentId, task, result: result.text, success: true,
          parentToolCallId: ctx.parentToolCallId,
          sourceEventType: 'runtime.subagent_completed',
        });
        if (work) ctx.workRegistry!.completeInline(work.workId, 'completed');
        return {
          content: result.text,
          ...(result.media && result.media.length > 0 ? { media: result.media } : {}),
        };
      } catch (error) {
        const message = errorMessage(error);
        const cancelled = isCancellation(error, cancellationRequested, ctx.abortSignal);
        ctx.onEvent?.({
          type: 'subagent_result',
          subagentId,
          task,
          result: cancelled ? `Cancelled: ${message}` : `Error: ${message}`,
          success: false,
          parentToolCallId: ctx.parentToolCallId,
          sourceEventType: cancelled ? 'runtime.subagent_cancelled' : 'runtime.subagent_failed',
        });
        if (work) ctx.workRegistry!.completeInline(work.workId, cancelled ? 'cancelled' : 'failed', message);
        return {
          content: cancelled ? `Sub-agent cancelled: ${message}` : `Sub-agent failed: ${message}`,
          is_error: true,
        };
      } finally {
        ctx.abortSignal?.removeEventListener('abort', cancelJoined);
        releaseTracker(ctx);
      }
    }

    const runDetachedSubAgent = async (): Promise<void> => {
      tracker.active++;
      try {
        const options = modelOverride || effort ? commonOptions : undefined;
        const result = await ctx.runAgentLoop!(systemPrompt, task, [], subCtx, options);

        const text = `[Sub-agent complete] ${headline}\n\n${result.text}`;
        console.log(`[subagent] Result for "${task.slice(0, 50)}": ${result.text.slice(0, 200)}`);
        ctx.onEvent?.({
          type: 'subagent_result', subagentId, task, result: result.text, success: true,
          parentToolCallId: ctx.parentToolCallId,
          sourceEventType: 'runtime.subagent_completed',
        });

        if (work && ctx.onWorkTerminal) {
          const terminalResult = {
            receiptText: text,
            resultText: result.text.trim() ? result.text : null,
            ...(result.media && result.media.length > 0 ? { artifacts: result.media } : {}),
          };
          ctx.workRegistry!.complete(work.workId, 'completed', undefined, terminalResult);
          ctx.onWorkTerminal(work.workId, terminalResult);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{
            role: 'assistant' as const,
            content: text,
            ts: new Date().toISOString(),
          }]);
        }
      } catch (error) {
        const message = errorMessage(error);
        console.error(`[subagent] Error: ${message}`);
        const text = `[Sub-agent failed] ${headline}\n\nError: ${message}`;
        ctx.onEvent?.({
          type: 'subagent_result', subagentId, task, result: `Error: ${message}`, success: false,
          parentToolCallId: ctx.parentToolCallId,
          sourceEventType: 'runtime.subagent_failed',
        });
        if (work && ctx.onWorkTerminal) {
          const terminalResult = {
            receiptText: text,
            resultText: null,
            artifacts: Object.freeze([]),
          };
          ctx.workRegistry!.complete(work.workId, 'failed', message, terminalResult);
          ctx.onWorkTerminal(work.workId, terminalResult);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{
            role: 'assistant' as const,
            content: text,
            ts: new Date().toISOString(),
          }]);
        }
      } finally {
        releaseTracker(ctx);
      }
    };

    // Explicitly detached work remains fire-and-forget.
    runDetachedSubAgent().catch(console.error);

    const handle = [
      work ? `work ${work.workId}` : null,
      isolated ? `session ${subChatId}` : null,
    ].filter(Boolean).join(', ');
    return { content: `Sub-agent spawned for: "${task.slice(0, 200)}"${handle ? ` (${handle})` : ''}. Results will be delivered when complete.` };
  },
};
