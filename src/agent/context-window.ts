import { estimateContextChars } from './context-pressure.js';
import type { TaskContextStore } from './task-context.js';

/** Drop only complete old tool exchanges, after retaining their exact payload.
 * The current tail, user requests, and unmatched tool calls are never removed. */
export function relieveToolPressure(items: Array<any>, budgetChars: number, store: TaskContextStore, chatId: string): { archived: number; beforeChars: number; afterChars: number } {
  const size = () => estimateContextChars(items);
  const beforeChars = size();
  let archived = 0;
  for (let i = 0; i < items.length - 4 && size() > budgetChars * 0.8; i++) {
    const item = items[i];
    let end = i;
    let label = '';
    let replacement: any;
    if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      const ids = new Set(item.tool_calls.map((call: any) => call.id));
      let next = i + 1;
      while (next < items.length && items[next].role === 'tool' && ids.has(items[next].tool_call_id)) { ids.delete(items[next].tool_call_id); next++; }
      if (ids.size || next > items.length - 4) continue;
      end = next;
      label = item.tool_calls.map((call: any) => call.function?.name ?? 'tool').join(', ');
      replacement = (text: string) => ({ role: 'assistant', content: text });
    } else if (item.role === 'assistant' && Array.isArray(item.content) && item.content.some((block: any) => block.type === 'tool_use')) {
      const ids = new Set(item.content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.id));
      let next = i + 1;
      while (next < items.length && items[next].role === 'user' && Array.isArray(items[next].content)
        && items[next].content.length > 0 && items[next].content.every((block: any) => block.type === 'tool_result' && ids.has(block.tool_use_id))) {
        for (const block of items[next].content) ids.delete(block.tool_use_id);
        next++;
      }
      if (ids.size || next > items.length - 4) continue;
      end = next;
      label = item.content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.name).join(', ');
      replacement = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
    } else if (item.type === 'function_call') {
      const ids = new Set<string>();
      const names: string[] = [];
      let next = i;
      while (next < items.length && items[next].type === 'function_call') {
        ids.add(items[next].call_id); names.push(items[next].name); next++;
      }
      while (next < items.length && items[next].type === 'function_call_output' && ids.has(items[next].call_id)) { ids.delete(items[next].call_id); next++; }
      if (ids.size || next > items.length - 4) continue;
      end = next;
      label = names.join(', ');
      replacement = (text: string) => ({ role: 'assistant', content: text });
    } else continue;
    const payload = JSON.stringify(items.slice(i, end));
    if (payload.length < 1600) continue;
    const id = store.save(chatId, 'transcript', payload);
    const text = `[Earlier completed tool exchange: ${label}. Exact input and results retained as ${id}. Use task_context read for evidence; this pointer does not establish success.]`;
    items.splice(i, end - i, replacement(text));
    archived++;
  }
  return { archived, beforeChars, afterChars: size() };
}
