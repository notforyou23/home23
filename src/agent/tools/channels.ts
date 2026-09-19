import type { ToolContext, ToolDefinition } from '../types.js';

export const nativeChessTool: ToolDefinition = {
  name: 'native_chess',
  description: 'Play and study native Chess in a Connected Agents channel. Always identify the gameId. Read the current game and board before moving, then supply its expectedVersion with from and to squares (and promotion if needed). Algebraic notation alone cannot submit a move. Save a teaching position with save_position; this does not alter a live game. A boardReference URL in the result can be shared as a normal chat link for an inline board.',
  input_schema: { type: 'object', required: ['operation'], properties: {
    operation: { type: 'string', enum: ['list', 'get', 'create', 'move', 'control', 'save_position', 'get_position', 'list_positions', 'export'] },
    gameId: { type: 'string' }, positionId: { type: 'string' }, channelId: { type: 'string' },
    players: { type: 'object', required: ['white', 'black'], properties: { white: { type: 'string' }, black: { type: 'string' } } },
    title: { type: 'string' }, initialPgn: { type: 'string' },
    expectedVersion: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' }, promotion: { type: 'string' },
    action: { type: 'string', enum: ['pause', 'resume', 'resign', 'retry_turn'] },
    fen: { type: 'string' }, note: { type: 'string' }, label: { type: 'string' },
    cursor: { type: 'string' }, limit: { type: 'integer' },
  } },
  async execute(input, ctx: ToolContext) {
    const origin = ctx.turnRuntime?.coordinationOrigin;
    if (!origin || !ctx.coordinationChannelOperation || !ctx.parentToolCallId)
      return { content: 'Native Chess requires an authenticated current resident turn.', is_error: true };
    const operation = String(input.operation);
    if (!['list', 'get', 'create', 'move', 'control', 'save_position', 'get_position', 'list_positions', 'export'].includes(operation))
      return { content: 'Unknown native Chess operation.', is_error: true };
    const result = await ctx.coordinationChannelOperation({ origin, invocationId: ctx.parentToolCallId,
      args: { ...input, operation: `chess_${operation}` } });
    return { content: JSON.stringify(result) };
  },
};

export const channelManageTool: ToolDefinition = {
  name: 'channel_manage',
  description: 'Manage Connected Agents topic/group channels through the owner’s standing household authority. List or inspect channels, create one, or update subject, purpose, members, responder policy, pinning and archive/restore state. Read current state/version before updating. Use operation bot_list to discover IDs, bot_create to create a durable helper, and bot_archive or bot_restore to manage its lifecycle. Use history to retrieve earlier channel messages beyond the current context, paging with beforeSequence. Use project_read to read the channel’s shared instructions and memory; project_write saves one document with its expectedRevision from the read. Archiving preserves history; this tool does not permanently delete conversations.',
  input_schema: { type: 'object', required: ['operation'], properties: {
    operation: { type: 'string', enum: ['list', 'get', 'create', 'update', 'bot_list', 'bot_create', 'bot_archive', 'bot_restore', 'project_read', 'project_write', 'history'] },
    beforeSequence: { type: 'integer', description: 'Read older history before this channel message sequence.' },
    botId: { type: 'string' }, displayName: { type: 'string' },
    channelId: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' },
    name: { type: 'string', enum: ['AGENTS.md', 'MEMORY.md', 'LEARNINGS.md'] }, text: { type: 'string' }, expectedRevision: { type: 'string' },
    title: { type: 'string' }, purpose: { type: 'string' },
    memberBotIds: { type: 'array', items: { type: 'string' } },
    expectedVersion: { type: 'integer' }, pinned: { type: 'boolean' },
    lifecycle: { type: 'string', enum: ['active', 'archived'] },
    responderPolicy: { type: 'object', additionalProperties: true },
  } },
  async execute(input, ctx: ToolContext) {
    const origin = ctx.turnRuntime?.coordinationOrigin;
    if (!origin || !ctx.coordinationChannelOperation || !ctx.parentToolCallId) {
      return { content: 'Connected Agents channel management requires the authenticated current resident turn.', is_error: true };
    }
    const result = await ctx.coordinationChannelOperation({ origin, invocationId: ctx.parentToolCallId, args: input });
    return { content: JSON.stringify(result) };
  },
};


export const botInvokeTool: ToolDefinition = {
  name: 'bot_invoke',
  description: 'Ask a persistent Bot to contribute in a shared Connected Agents topic channel. The Bot must be a channel member. This creates a Working Thread; Jerry waits for its verified result and remains accountable. Bot replies appear under the Bot’s identity in the channel. Use channel_manage to discover IDs and configure membership first.',
  input_schema: { type: 'object', required: ['botId', 'prompt'], properties: {
    botId: { type: 'string' }, prompt: { type: 'string' }, channelId: { type: 'string' },
  } },
  async execute(input, ctx) {
    const origin = ctx.turnRuntime?.coordinationOrigin;
    if (!origin || !ctx.coordinationWorkDestination || !ctx.coordinationChannelOperation || !ctx.parentToolCallId)
      return { content: 'Bot invocation requires a canonical Working Thread and its authenticated resident connection.', is_error: true };
    const call = async (operation: string): Promise<{ state: string; text?: string; error?: string; deliveries?: unknown[] }> => {
      for (;;) {
        try { return await ctx.coordinationChannelOperation!({ origin,
          invocationId: ctx.parentToolCallId!, args: { ...input, operation } }) as { state: string; text?: string; error?: string; deliveries?: unknown[] }; }
        catch (error) {
          if (!['connection_lost', 'deadline_exceeded', 'request_timeout', 'server_busy', 'request_rate_limited'].includes(String((error as { code?: string }).code))) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    };
    await call('bot_invoke');
    let lastActivity = 0;
    while (true) {
      if (ctx.abortSignal?.aborted) await call('bot_stop');
      const result = await call('bot_result');
      if (['succeeded', 'failed', 'cancelled'].includes(result.state))
        return { content: result.deliveries ? JSON.stringify(result) : result.text || result.error || `Helper ${result.state}`, is_error: result.state !== 'succeeded' };
      if (Date.now() - lastActivity >= 15000) {
        ctx.onEvent?.({ type: 'status', status: 'joined_bot_active', message: 'Waiting for the selected helper’s result.' });
        lastActivity = Date.now();
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  },
};
