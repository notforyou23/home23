import type { ToolDefinition } from '../types.js';

export const taskContextTool: ToolDefinition = {
  name: 'task_context',
  description: 'Search or read retained messages and tool results from this task, or maintain compact task notes across context windows. Task notes are working aids, not new authority. No access to other chats. Use exact evidence IDs and page offsets to recover details instead of guessing from a summary.',
  input_schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['status', 'search', 'read', 'note'] },
    query: { type: 'string' }, cursor: { type: 'string', description: 'Opaque nextCursor returned by search' },
    id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 },
    key: { type: 'string' }, text: { type: 'string', description: 'At most 1500 characters. Empty removes the keyed note. Preserve constraints, open work, decisions and provenance.' },
    source_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  }, required: ['action'] },
  async execute(input, ctx) {
    const history = ctx.conversationHistory;
    const store = history?.taskContext;
    if (!store) return { content: 'Task context storage is unavailable.', is_error: true };
    try {
      switch (input.action) {
        case 'search': {
          history.archiveCurrent?.(ctx.chatId);
          return { content: JSON.stringify(store.search(ctx.chatId, String(input.query ?? ''), input.cursor === undefined ? undefined : String(input.cursor))) };
        }
        case 'read': return { content: JSON.stringify(store.read(ctx.chatId, String(input.id ?? ''), input.offset === undefined ? 0 : Number(input.offset), input.limit === undefined ? 2000 : Number(input.limit))) };
        case 'note': {
          if (typeof input.key !== 'string' || typeof input.text !== 'string' || (input.source_ids !== undefined && (!Array.isArray(input.source_ids) || input.source_ids.some(id => typeof id !== 'string')))) throw new Error('Invalid task note');
          store.note(ctx.chatId, input.key, input.text, input.source_ids as string[] | undefined);
          return { content: 'Task note saved. This does not change task authority.' };
        }
        case 'status': return { content: JSON.stringify({ notes: store.notes(ctx.chatId), scope: 'current task only', evidence: 'retained messages and tool results; use search then read', pressure: history.contextStatus?.(ctx.chatId) ?? null }) };
        default: throw new Error('Unknown task_context action');
      }
    } catch (error) { return { content: error instanceof Error ? error.message : String(error), is_error: true }; }
  },
};
