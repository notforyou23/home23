import type { ContentBlock, StoredMessage } from './history.js';

export interface ProviderToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolHistoryResult {
  id: string;
  content: string;
  isError?: boolean;
}

function malformed(message: string): never {
  throw Object.assign(new Error(`Invalid provider tool call: ${message}`), { code: 'provider_invalid_tool_call' });
}

/** Validate the complete batch before any tool can run. Native Ollama omits
 * IDs; allocate each once and retain that identity through events and replay. */
export function normalizeProviderToolCalls(raw: unknown, makeId: (index: number) => string): ProviderToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return malformed('tool_calls must be an array');
  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed('call must be an object');
    const call = value as Record<string, any>;
    const fn = call.function;
    if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name.trim()) return malformed('function name is missing');
    let args: unknown = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return malformed('arguments are not valid JSON'); }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return malformed('arguments must be an object');
    if (call.id !== undefined && (typeof call.id !== 'string' || !call.id.trim())) return malformed('call ID is invalid');
    const id = call.id ?? makeId(index);
    if (seen.has(id)) return malformed('duplicate call ID');
    seen.add(id);
    return { id, type: 'function', function: { name: fn.name, arguments: args as Record<string, unknown> } };
  });
}

/** Store the bounded payload actually supplied to the model. Exact tool output
 * remains in the existing event/artifact path; no second truncation is applied. */
export function toolRoundHistory(
  calls: readonly ProviderToolCall[], results: readonly ToolHistoryResult[], text = '',
): StoredMessage[] {
  if (!calls.length) return text ? [{ role: 'assistant', content: text }] : [];
  if (results.length !== calls.length || results.some((result, i) => result.id !== calls[i]?.id)) {
    throw new Error('Tool history must contain one ordered result for every call');
  }
  const content: ContentBlock[] = text ? [{ type: 'text', text }] : [];
  content.push(...calls.map(call => ({ type: 'tool_use' as const, id: call.id, name: call.function.name, input: call.function.arguments })));
  return [
    { role: 'assistant', content },
    { role: 'user', content: results.map(result => ({ type: 'tool_result', tool_use_id: result.id,
      content: result.content, ...(result.isError ? { is_error: true } : {}) })) },
  ];
}

export type HistoryWireFormat = 'chat-completions' | 'responses' | 'ollama';

/** Convert canonical typed history without guessing missing historic arguments.
 * Legacy text summaries remain text. Thinking signatures are never replayed. */
export function serializeProviderHistory(history: readonly StoredMessage[], format: HistoryWireFormat): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  const names = new Map<string, string>();
  for (const message of history) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    let text: string[] = [];
    let images: Array<{ data: string; mimeType: string }> = [];
    let calls: Array<Record<string, any>> = [];
    const flush = () => {
      if (!text.length && !images.length && !calls.length) return;
      const content = text.join('\n');
      if (format === 'responses') {
        if (content || images.length) messages.push({ role: message.role, content: images.length
          ? [ ...(content ? [{ type: 'input_text', text: content }] : []), ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` })) ]
          : content });
        for (const call of calls) messages.push({ type: 'function_call', call_id: call.id, name: call.function.name,
          arguments: JSON.stringify(call.function.arguments) });
      } else if (format === 'ollama') {
        messages.push({ role: message.role, content, ...(images.length ? { images: images.map(image => image.data) } : {}),
          ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        messages.push({ role: message.role, content: images.length
          ? [ ...(content ? [{ type: 'text', text: content }] : []), ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })) ]
          : content || (calls.length ? null : ''),
          ...(calls.length ? { tool_calls: calls.map(call => ({ ...call, function: { ...call.function, arguments: JSON.stringify(call.function.arguments) } })) } : {}) });
      }
      text = []; images = []; calls = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text);
      else if (block.type === 'image') images.push({ data: block.source.data, mimeType: block.source.media_type });
      else if (block.type === 'image_ref') throw Object.assign(new Error('Image reference was not loaded before provider serialization'), { code: 'provider_image_unavailable' });
      else if (block.type === 'tool_use') {
        names.set(block.id, block.name);
        calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.input } });
      } else if (block.type === 'tool_result') {
        flush();
        if (format === 'responses') messages.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
        else messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content,
          ...(format === 'ollama' ? { tool_name: names.get(block.tool_use_id) ?? '' } : {}) });
      }
    }
    flush();
  }
  return messages;
}
