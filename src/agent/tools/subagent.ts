/**
 * Sub-agent tool — spawn background agents for parallel work.
 *
 * Results are delivered back through:
 * 1. onEvent callback (streams to dashboard chat in real-time)
 * 2. Conversation history (persisted, visible on reload)
 * 3. Telegram (if available)
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Spawn a background sub-agent to handle a task in parallel. The sub-agent runs independently and delivers its result when done. Returns immediately.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Description of the task for the sub-agent' },
    },
    required: ['task'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = input.task as string;

    if (!ctx.runAgentLoop) {
      return { content: 'Sub-agent spawning not available (agent loop runner not configured).', is_error: true };
    }

    const tracker = ctx.subAgentTracker;

    const runSubAgent = async (): Promise<void> => {
      tracker.active++;
      try {
        const subCtx: ToolContext = { ...ctx, chatId: ctx.chatId };
        const systemPrompt = ctx.contextManager.getSystemPrompt();

        const result = await ctx.runAgentLoop!(systemPrompt, task, [], subCtx);

        const text = `[Sub-agent complete] ${task.slice(0, 100)}\n\n${result.text}`;
        console.log(`[subagent] Result for "${task.slice(0, 50)}": ${result.text.slice(0, 200)}`);

        // 1. Fire onEvent so dashboard chat sees it in real-time
        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: result.text });
        }

        // 2. Append to conversation history so it persists
        if (ctx.conversationHistory) {
          ctx.conversationHistory.append(ctx.chatId, [{
            role: 'assistant' as const,
            content: text,
            ts: new Date().toISOString(),
          }]);
        }

        // 3. Try Telegram if available
        if (ctx.telegramAdapter) {
          try {
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            if (botToken) {
              await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: ctx.chatId,
                  text: text.slice(0, 4096),
                }),
              });
            }
          } catch (err) {
            console.warn(`[subagent] Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[subagent] Error: ${errMsg}`);
        const text = `[Sub-agent failed] ${task.slice(0, 100)}\n\nError: ${errMsg}`;

        if (ctx.onEvent) {
          ctx.onEvent({ type: 'subagent_result', task: task.slice(0, 200), result: `Error: ${errMsg}` });
        }
        if (ctx.conversationHistory) {
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

    if (tracker.active >= tracker.maxConcurrent) {
      return { content: `Sub-agent limit reached (${tracker.maxConcurrent} active). Try again when a current sub-agent completes, or wait.` };
    }

    // Fire and forget — never blocks the parent
    runSubAgent().catch(console.error);

    return { content: `Sub-agent spawned for: "${task.slice(0, 200)}". Results will be delivered when complete.` };
  },
};
