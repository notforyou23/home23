export type ModelAliases = Record<string, { provider: string; model: string }>;

export interface ModelOverride {
  model: string;
  provider?: string;
}

export function inferProviderFromModel(model: string, provider?: string): string {
  return provider ?? (
    model.includes('claude') ? 'anthropic' :
    model.includes('grok') ? 'xai' :
    model.includes('MiniMax') ? 'minimax' :
    model.startsWith('gpt') ? 'openai' :
    'unknown'
  );
}

/**
 * Resolve a configured alias or a raw model name that the runtime can route.
 * Unknown raw names must be rejected before a caller creates background work.
 */
export function resolveModelOverride(model: string, aliases?: ModelAliases): ModelOverride | null {
  const alias = aliases?.[model];
  if (alias) return { model: alias.model, provider: alias.provider };

  const provider = inferProviderFromModel(model);
  return provider === 'unknown' ? null : { model, provider };
}
