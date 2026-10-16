import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharedReasoning = require('../../shared/responses-reasoning.cjs');

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number] | (string & {});

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

export function supportsResponsesReasoning(model: string, provider = 'openai-codex'): boolean {
  return sharedReasoning.supportsResponsesReasoning(model, provider);
}

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = Object.freeze({
  'gpt-6-astra': Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const),
});

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  // Wire syntax only. Admission checks the selected provider/model's catalog.
  // The coordinator and resident need not share a process-local registry.
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

export function parseReasoningEffort(value: unknown, field = 'effort'): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value) && (REASONING_EFFORT_SET.has(value) || sharedReasoning.isDiscoveredReasoningEffort(value))) return value;
  throw new TypeError(
    `${field} must be one of: ${REASONING_EFFORTS.join(', ')} (received ${JSON.stringify(value)})`,
  );
}

/** Exact model-specific effort capabilities; other models retain the house catalog. */
export function reasoningEffortsForModel(model: string, provider?: string): readonly ReasoningEffort[] {
  const discovered = provider ? sharedReasoning.modelCapabilities(provider, model) : null;
  if (discovered) return discovered.reasoningEffortOptions;
  return MODEL_REASONING_EFFORTS[model] ?? REASONING_EFFORTS;
}

export function modelSupportsReasoningEffort(model: string, effort: ReasoningEffort, provider?: string): boolean {
  return reasoningEffortsForModel(model, provider).includes(effort);
}

export function legacyReasoningEffortsForModel(model: string, provider?: string): readonly (typeof REASONING_EFFORTS)[number][] {
  return REASONING_EFFORTS.filter(effort => reasoningEffortsForModel(model, provider).includes(effort));
}

/** Installed clients bound model counts and decode only the original six
 * values. The additive modelOptions array retains the complete catalog. */
export function legacyModelOptions<T extends { provider: string; model: string; reasoningEfforts?: readonly ReasoningEffort[] }>(
  models: readonly T[], defaultProvider: string, defaultModel: string,
): T[] {
  const compatible = models.filter(row => row.reasoningEfforts && row.reasoningEfforts.length > 0);
  const current = compatible.find(row => row.provider === defaultProvider && row.model === defaultModel);
  const result = compatible.slice(0, 128);
  if (current && !result.includes(current)) result[result.length - 1] = current;
  return result;
}

export function discoveredModelCapabilities(provider: string, model: string): Record<string, any> | undefined {
  return sharedReasoning.modelCapabilities(provider, model);
}

export function reasoningCapabilitiesKnown(model: string, provider: string): boolean {
  return sharedReasoning.modelCapabilities(provider, model)?.reasoningCapabilitiesKnown !== false;
}

export function defaultReasoningEffortOptionForModel(model: string, provider: string): ReasoningEffort | null {
  return sharedReasoning.modelCapabilities(provider, model)?.defaultReasoningEffortOption ?? null;
}

export function catalogReasoningEffortOptions(models: readonly { reasoningEffortOptions?: readonly ReasoningEffort[] }[], defaultEffort: ReasoningEffort): ReasoningEffort[] {
  return [...new Set([...models.flatMap(row => row.reasoningEffortOptions ?? []), defaultEffort])];
}

/** Provider metadata, never a model-name guess, controls new reasoning options. */
export function providerReasoningParameters(provider: string, model: string, effort: ReasoningEffort, capturedCapabilities?: Record<string, any> | null): Record<string, unknown> {
  const caps = capturedCapabilities === undefined ? sharedReasoning.modelCapabilities(provider, model) : capturedCapabilities;
  if (!caps || !caps.reasoningTransport) return {};
  if (!caps.reasoningEffortOptions.includes(effort)) throw new TypeError(`Reasoning effort ${effort} is unavailable for ${provider}/${model}`);
  if (caps.reasoningTransport === 'responses') return effort === 'none' ? {} : { reasoning_effort: effort };
  if (caps.reasoningTransport === 'anthropic-adaptive') return { thinking: { type: 'adaptive' }, output_config: { effort } };
  if (caps.reasoningTransport === 'ollama-think') {
    const values = caps.thinkingValues || [];
    return { think: effort === 'none' ? false : values.includes(effort) ? effort : true };
  }
  return {};
}

export function resolveConfiguredReasoningEffort(
  model: string,
  defaultEffort?: ReasoningEffort,
  modelEfforts?: Record<string, ReasoningEffort>,
): ReasoningEffort {
  return modelEfforts?.[model] ?? defaultEffort ?? DEFAULT_REASONING_EFFORT;
}

export const RESPONSES_REASONING_SUMMARY = 'auto' as const;

/** Responses API reasoning object. `none` means do not request visible thinking. */
export function responsesReasoningConfig(
  effort: ReasoningEffort,
): { effort: ReasoningEffort; summary: typeof RESPONSES_REASONING_SUMMARY } | undefined {
  if (effort === 'none') return undefined;
  return { effort, summary: RESPONSES_REASONING_SUMMARY };
}

const ANTHROPIC_THINKING_BUDGET: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  low: 2000,
  medium: 8000,
  high: 16000,
  xhigh: 24000,
  max: 31999,
};

/** Claude extended thinking. `max_tokens` must exceed `budget_tokens`. */
export function anthropicThinkingConfig(
  effort: ReasoningEffort,
  maxTokens: number,
): { thinking: { type: 'enabled'; budget_tokens: number }; maxTokens: number } | undefined {
  if (effort === 'none') return undefined;
  const budget = ANTHROPIC_THINKING_BUDGET[effort];
  if (budget === undefined) throw new TypeError(`Anthropic budget thinking does not support ${effort}`);
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    maxTokens: Math.max(maxTokens, budget + 4096),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate only the reasoning-effort portions of the merged Home23 config. */
export function validateReasoningEffortConfig(config: unknown, { allowUnavailableSelections = false } = {}): void {
  if (!isRecord(config)) throw new TypeError('config must be an object');
  const parse = (value: unknown, field: string): ReasoningEffort | undefined =>
    allowUnavailableSelections && isReasoningEffort(value) ? value : parseReasoningEffort(value, field);

  const chat = config.chat;
  if (chat !== undefined) {
    if (!isRecord(chat)) throw new TypeError('chat must be an object');
    const effort = parse(chat.reasoningEffort, 'chat.reasoningEffort');
    if (!allowUnavailableSelections && effort && typeof chat.defaultModel === 'string' &&
        !modelSupportsReasoningEffort(chat.defaultModel, effort, typeof chat.defaultProvider === 'string' ? chat.defaultProvider : typeof chat.provider === 'string' ? chat.provider : undefined)) {
      throw new TypeError(`chat.reasoningEffort is unavailable for ${chat.defaultModel}`);
    }
  }

  const models = config.models;
  if (models === undefined) return;
  if (!isRecord(models)) throw new TypeError('models must be an object');

  const modelEfforts = models.reasoningEffort;
  if (modelEfforts !== undefined) {
    if (!isRecord(modelEfforts)) throw new TypeError('models.reasoningEffort must be an object');
    for (const [model, effort] of Object.entries(modelEfforts)) {
      const parsed = parse(effort, `models.reasoningEffort.${model}`);
      if (!allowUnavailableSelections && parsed && !modelSupportsReasoningEffort(model, parsed)) {
        throw new TypeError(`models.reasoningEffort.${model} is unavailable for ${model}`);
      }
    }
  }

  const aliases = models.aliases;
  if (aliases === undefined) return;
  if (!isRecord(aliases)) throw new TypeError('models.aliases must be an object');
  for (const [alias, definition] of Object.entries(aliases)) {
    if (!isRecord(definition)) continue;
    const effort = parse(
      definition.reasoningEffort,
      `models.aliases.${alias}.reasoningEffort`,
    );
    if (!allowUnavailableSelections && effort && typeof definition.model === 'string' &&
        !modelSupportsReasoningEffort(definition.model, effort, typeof definition.provider === 'string' ? definition.provider : undefined)) {
      throw new TypeError(`models.aliases.${alias}.reasoningEffort is unavailable for ${definition.model}`);
    }
  }
}
