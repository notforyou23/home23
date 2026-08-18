import type { AgentLoop } from './loop.js';
import type { AgentEventCallback, AgentResponse } from './types.js';
import type { MediaAttachment } from '../types.js';
import type { ToolRegistry } from './tools/index.js';

export async function executeTrackedTurn(
  agent: Pick<AgentLoop, 'runWithTurn'>,
  chatId: string,
  userText: string,
  options: {
    media?: MediaAttachment[];
    onEvent?: AgentEventCallback;
    inactivityMs?: number;
    hardDurationMs?: number;
    modelOverride?: { model: string; provider?: string };
    registry?: ToolRegistry;
  } = {},
): Promise<{ turnId: string; response: AgentResponse }> {
  const started = await agent.runWithTurn(chatId, userText, {
    media: options.media,
    onEvent: options.onEvent,
    inactivityMs: options.inactivityMs,
    hardDurationMs: options.hardDurationMs,
    ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
  });
  return { turnId: started.turnId, response: await started.response };
}
