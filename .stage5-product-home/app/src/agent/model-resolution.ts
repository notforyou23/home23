import type { ReasoningEffort } from './reasoning-effort.js';

export type ModelAliases = Record<string, {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}>;

export interface ModelOverride {
  model: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * The canonical model→provider inference (one rule set, 2026-08-11).
 * Two caller policies exist on top of it:
 *   - STRICT — resolveModelOverride below: 'unknown' → reject. For callers
 *     about to create background work from a raw string (subagents, chat
 *     model overrides).
 *   - LENIENT — text-generation's inferTextGenerationProvider: 'unknown' →
 *     'ollama-cloud', the catch-all serving tier. For bare model names from
 *     substrate lobes and cron prompts.
 * Case rule, deliberate: 'MiniMax-M3' (brand casing) is the MiniMax API;
 * lowercase 'minimax-m2.7' is an ollama-served clone and must fall through
 * to 'unknown' so the lenient policy lands it on ollama-cloud — do not
 * "fix" this to a case-insensitive match.
 */
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
  if (alias) {
    return {
      model: alias.model,
      provider: alias.provider,
      ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
    };
  }

  const provider = inferProviderFromModel(model);
  return provider === 'unknown' ? null : { model, provider };
}
