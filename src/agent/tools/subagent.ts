/**
 * Sub-agent tool — spawn background agents for parallel work.
 *
 * Each spawn registers a durable async-work record (Step 31). Results are
 * delivered back through:
 * 1. onEvent callback (streams to the parent turn if it is still live)
 * 2. the async-work completion pipeline (root-origin history append, Telegram
 *    for numeric origins, iOS async_work push for ios_/mac_ origins)
 *
 * By default each sub-agent runs under a fresh `subagent:<parent>:<hex>` chat
 * id so its turns don't masquerade as the parent conversation; delivery always
 * targets the ROOT origin conversation, never the sub-chat.
 */

import { randomBytes } from 'node:crypto';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Spawn a background sub-agent to handle a task in parallel. The sub-agent runs independently (in its own isolated chat session by default) and delivers its result when done. Returns immediately.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Description of the task for the sub-agent' },
      label: { type: 'string', description: 'Short human label for the sub-agent run' },
      isolated: { type: 'boolean', description: 'Run under a fresh sub-chat id so the sub-agent does not share the parent conversation history (default true)' },
      model: { type: 'string', description: 'Model override for the sub-agent turn (provider inferred from the model name)' },
    },
    required: ['task'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = input.task as string;
    const label = typeof input.label === 'string' && input.label ? input.label.slice(0, 100) : undefined;
    const isolated = input.isolated !== false;
    const model = typeof input.model === 'string' && input.model ? input.model : undefined;

    if (!ctx.runAgentLoop) {
      return { content: 'Sub-agent spawning not available (agent loop runner not configured).', is_error: true };
    }

    const tracker = ctx.subAgentTracker;
    const headline = label ?? task.slice(0, 100);
    const subChatId = isolated
      ? `subagent:${ctx.chatId}:${randomBytes(2).toString('hex')}`
      : ctx.chatId;

    if (tracker.active >= tracker.maxConcurrent) {
      return { content: `Sub-agent limit reached (${tracker.maxConcurrent} active). Try again when a current sub-agent completes, or wait.` };
    }

    // Durable async-work record (Step 31). The registry resolves the root
    // origin; nested spawns thread parentWorkId through subCtx below.
    const work = ctx.workRegistry?.create({
      kind: 'subagent',
      originChatId: ctx.chatId,
      originTurnId: ctx.turnRuntime?.turnId,
      parentWorkId: ctx.parentWorkId,
      label: headline,
      resultHandle: { type: 'subagent_chat', chatId: subChatId },
    }) ?? null;

    const runSubAgent = async (): Promise<void> => {
      tracker.active++;
      try {
        const subCtx: ToolContext = { ...ctx, chatId: subChatId, parentWorkId: work?.workId ?? ctx.parentWorkId };
        const systemPrompt = ctx.contextManager.getSystemPrompt();

        const result = await ctx.runAgentLoop!(
          systemPrompt, task, [], subCtx,
          model ? { modelOverride: { model } } : undefined,
        );

        const text = `[Sub-agent complete] ${headline}\n\n${result.text}`;
        console.log(`[subagent] Result for "${task.slice(0, 50)}": ${result.text.slice(0, 200)}`);

        // 1. Live-stream to the parent turn if it still exists
        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: result.text });
        }

        // 2. Terminal delivery through the async-work pipeline: root-origin
        //    history append, numeric-checked Telegram, iOS async_work push.
        //    Without a registry (legacy wiring), fall back to the old direct
        //    parent-chat append so results are never dropped.
        if (work && ctx.onWorkTerminal) {
          ctx.workRegistry!.complete(work.workId, 'completed');
          ctx.onWorkTerminal(work.workId, text);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{
            role: 'assistant' as const,
            content: text,
            ts: new Date().toISOString(),
          }]);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[subagent] Error: ${errMsg}`);
        const text = `[Sub-agent failed] ${headline}\n\nError: ${errMsg}`;

        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: `Error: ${errMsg}` });
        }
        if (work && ctx.onWorkTerminal) {
          ctx.workRegistry!.complete(work.workId, 'failed', errMsg);
          ctx.onWorkTerminal(work.workId, text);
        } else if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{
            role: 'assistant' as const,
            content: text,
            ts: new Date().toISOString(),
          }]);
        }
      } finally {
        tracker.active--;
        if (tracker.queue.length > 0) {
          const next = tracker.queue.shift()!;
          next.resolve();
        }
      }
    };

    // Fire and forget — never blocks the parent
    runSubAgent().catch(console.error);

    const handle = [
      work ? `work ${work.workId}` : null,
      isolated ? `session ${subChatId}` : null,
    ].filter(Boolean).join(', ');
    return { content: `Sub-agent spawned for: "${task.slice(0, 200)}"${handle ? ` (${handle})` : ''}. Results will be delivered when complete.` };
  },
};
