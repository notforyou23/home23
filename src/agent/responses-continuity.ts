type OutputItem = Record<string, unknown>;

function identity(item: OutputItem): string {
  // A function call's stable identity is call_id even when one transport
  // representation omits the response-item id.
  if (item.type === 'function_call' && typeof item.call_id === 'string') return `function_call:${item.call_id}`;
  if (typeof item.id === 'string') return `${item.type}:${item.id}`;
  return JSON.stringify(item);
}

/** Preserve complete output order across coalesced and partially omitted SSE
 * items. Terminal values win, but incomplete terminal output cannot move an
 * earlier streamed reasoning item behind its completed function call. */
export function mergeCompletedResponsesOutput(terminal: OutputItem[], streamed: OutputItem[]): OutputItem[] {
  const terminalById = new Map(terminal.map(item => [identity(item), item]));
  const terminalHasAllStreamed = streamed.every(item => terminalById.has(identity(item)));
  const ordered = terminalHasAllStreamed ? [...terminal, ...streamed] : [...streamed, ...terminal];
  const seen = new Set<string>();
  const output: OutputItem[] = [];
  for (const item of ordered) {
    const key = identity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(terminalById.get(key) ?? item);
  }
  return output;
}
