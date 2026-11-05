/** Conservative budgeting policy, not a claim of exact provider token counts. */
export interface ContextPressureInput {
  historyChars: number;
  systemChars: number;
  toolSchemaChars: number;
  incomingChars: number;
  outputTokens: number;
  historyBudget: number;
  model?: string;
  provider?: string;
}
export interface ContextPolicy {
  triggerThreshold: number;
  targetFraction: number;
  reserveChars: number;
  modelContextTokens: Record<string, number>;
}
export function measureContextPressure(input: ContextPressureInput, policy: ContextPolicy) {
  const modelTokens = policy.modelContextTokens[`${input.provider}/${input.model}`] ?? policy.modelContextTokens[input.model ?? ''];
  // Exact configured model limits may lower the operational cap. They never
  // silently inflate the installation's chosen cost/latency budget.
  const totalBudgetChars = modelTokens ? Math.min(input.historyBudget, modelTokens * 3) : input.historyBudget;
  const overheadChars = input.systemChars + input.toolSchemaChars + input.incomingChars + Math.max(0, input.outputTokens) * 4 + policy.reserveChars;
  const availableHistoryChars = Math.max(0, totalBudgetChars - overheadChars);
  return {
    ...input, totalBudgetChars, overheadChars, availableHistoryChars,
    estimated: true as const,
    triggerChars: Math.floor(availableHistoryChars * policy.triggerThreshold),
    targetHistoryChars: Math.floor(availableHistoryChars * policy.targetFraction),
    shouldCompact: input.historyChars > availableHistoryChars * policy.triggerThreshold,
    reason: availableHistoryChars <= 0 ? 'request_overhead_exhausts_budget' : 'context_pressure',
  };
}
export type ContextPressure = ReturnType<typeof measureContextPressure>;

/** Image transport bytes are not text tokens. Reserve a fixed estimate per image;
 * resolution/provider-specific accounting still requires provider token usage. */
export function estimateContextChars(value: unknown): number {
  let imageReserve = 0;
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && ['image', 'image_url', 'input_image'].includes(item.type)) {
      imageReserve += 16000;
      return { type: item.type, image: 'budgeted separately' };
    }
    return item;
  });
  return (encoded?.length ?? 0) + imageReserve;
}
