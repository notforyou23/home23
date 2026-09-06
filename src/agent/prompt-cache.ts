import { createHash } from 'node:crypto';

export type CacheSystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** Breakpoint after the real stable prefix, before volatile context. Provider
 * minimums are token-based and include tools; character length is not eligibility. */
export function cacheableSystemPrompt(provider: string, stable: string, dynamic: string, oauthStub?: CacheSystemBlock): string | CacheSystemBlock[] {
  if (provider !== 'anthropic' && provider !== 'minimax') return stable + dynamic;
  // Preserve the existing MiniMax compatibility behavior; native automatic
  // caching below is reserved for Anthropic's documented API.
  if (provider === 'minimax' && stable.length < 1024) return stable + dynamic;
  return [
    ...(oauthStub ? [{ type: 'text' as const, text: oauthStub.text }] : []),
    ...(stable ? [{ type: 'text' as const, text: stable, cache_control: { type: 'ephemeral' as const } }] : []),
    ...(dynamic ? [{ type: 'text' as const, text: dynamic }] : []),
  ];
}

/** Routing hint, not a security boundary. Never send raw workspace/chat IDs. */
export function promptCacheKey(scope: string, provider: string, model: string, stable: string, tools: unknown): string {
  return `home23-v1-${createHash('sha256').update(JSON.stringify([scope, provider, model, stable, tools])).digest('hex')}`;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Input is normalized to uncached tokens; inputTotal includes cached reads and
 * writes. Missing provider fields remain null, never a fabricated cache miss. */
export function cacheUsage(provider: string, value: unknown) {
  const usage = value && typeof value === 'object' ? value as Record<string, any> : {};
  if (provider === 'anthropic' || provider === 'minimax') {
    const read = tokenCount(usage.cache_read_input_tokens);
    const write = tokenCount(usage.cache_creation_input_tokens);
    const input = tokenCount(usage.input_tokens);
    return { read, write, input, output: tokenCount(usage.output_tokens),
      inputTotal: input !== null && read !== null && write !== null ? input + read + write : null };
  }
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
  const read = tokenCount(details.cached_tokens);
  const write = tokenCount(details.cache_write_tokens);
  const total = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  return { read, write, input: total !== null && read !== null && write !== null && read + write <= total ? total - read - write : null,
    inputTotal: total, output: tokenCount(usage.output_tokens ?? usage.completion_tokens) };
}
