import { estimateContextChars } from './context-pressure.js';
import type { TaskContextStore } from './task-context.js';

type Call = { name: string; args: unknown };

/** A recovery page already has an immutable, task-scoped source. Retaining its
 * rendered copy again creates a chain of transcript wrappers around that source. */
function retainRecoveryReferences(exchange: any[], calls: Map<string, Call>, store: TaskContextStore, chatId: string) {
  const references: string[] = [];
  const recovered = new Set<string>();
  const replacePage = (callId: string, content: unknown): unknown => {
    const call = calls.get(callId);
    if (call?.name !== 'task_context' || typeof content !== 'string') return content;
    try {
      const args = typeof call.args === 'string' ? JSON.parse(call.args) : call.args;
      if (!args || args.action !== 'read' || typeof args.id !== 'string') return content;
      const page = JSON.parse(content);
      const exact = store.read(chatId, args.id, args.offset === undefined ? 0 : Number(args.offset), args.limit === undefined ? 2000 : Number(args.limit));
      if (page.id !== exact.id || page.kind !== exact.kind || page.offset !== exact.offset
          || page.totalChars !== exact.totalChars || page.text !== exact.text || page.nextOffset !== exact.nextOffset) return content;
      const reference = `${exact.id} offset=${exact.offset} nextOffset=${exact.nextOffset}`;
      references.push(reference);
      recovered.add(callId);
      return `[Recovered page remains at original task evidence ${reference}.]`;
    } catch {
      // Invalid, corrupt or cross-task references retain the actual exchange;
      // they never become an apparently valid shortcut to unavailable evidence.
      return content;
    }
  };
  const retained = exchange.map(item => {
    if (item.role === 'tool') return { ...item, content: replacePage(item.tool_call_id, item.content) };
    if (item.type === 'function_call_output') return { ...item, output: replacePage(item.call_id, item.output) };
    if (item.role === 'user' && Array.isArray(item.content)) return { ...item, content: item.content.map((block: any) =>
      block.type === 'tool_result' ? { ...block, content: replacePage(block.tool_use_id, block.content) } : block) };
    return item;
  });
  // An assistant can also state a new conclusion beside its recovery calls.
  // Keep that exact content, including thinking blocks, without copying pages.
  const otherContent = exchange.some(item => item.role === 'assistant' && (
    typeof item.content === 'string' ? item.content.length > 0
      : Array.isArray(item.content) && item.content.some((block: any) => block.type !== 'tool_use')
  ));
  return { retained, references: [...new Set(references)], onlyRecovery: recovered.size > 0 && recovered.size === calls.size && !otherContent };
}

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
    const calls = new Map<string, Call>();
    if (item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      for (const call of item.tool_calls) calls.set(call.id, { name: call.function?.name, args: call.function?.arguments });
      const ids = new Set(item.tool_calls.map((call: any) => call.id));
      let next = i + 1;
      while (next < items.length && items[next].role === 'tool' && ids.has(items[next].tool_call_id)) { ids.delete(items[next].tool_call_id); next++; }
      if (ids.size || next > items.length - 4) continue;
      end = next;
      label = item.tool_calls.map((call: any) => call.function?.name ?? 'tool').join(', ');
      replacement = (text: string) => ({ role: 'assistant', content: text });
    } else if (item.role === 'assistant' && Array.isArray(item.content) && item.content.some((block: any) => block.type === 'tool_use')) {
      for (const block of item.content.filter((block: any) => block.type === 'tool_use')) calls.set(block.id, { name: block.name, args: block.input });
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
        calls.set(items[next].call_id, { name: items[next].name, args: items[next].arguments });
        ids.add(items[next].call_id); names.push(items[next].name); next++;
      }
      while (next < items.length && items[next].type === 'function_call_output' && ids.has(items[next].call_id)) { ids.delete(items[next].call_id); next++; }
      if (ids.size || next > items.length - 4) continue;
      end = next;
      label = names.join(', ');
      replacement = (text: string) => ({ role: 'assistant', content: text });
    } else continue;
    const exchange = items.slice(i, end);
    const payload = JSON.stringify(exchange);
    if (payload.length < 1600) continue;
    const recovery = retainRecoveryReferences(exchange, calls, store, chatId);
    const id = recovery.onlyRecovery ? null : store.save(chatId, 'transcript', JSON.stringify(recovery.retained));
    const retained = id ? ` Exact other input and results retained as ${id}; recovered pages remain at their original sources.` : '';
    const pages = recovery.references.length ? ` Original recovered evidence: ${recovery.references.join('; ')}.` : '';
    const text = `[Earlier completed tool exchange: ${label}.${retained}${pages} Use task_context read only for missing details; this pointer does not establish success.]`;
    items.splice(i, end - i, replacement(text));
    archived++;
  }
  return { archived, beforeChars, afterChars: size() };
}
