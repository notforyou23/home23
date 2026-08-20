export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value);
}

export function parseReasoningEffort(value: unknown, field = 'effort'): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (isReasoningEffort(value)) return value;
  throw new TypeError(
    `${field} must be one of: ${REASONING_EFFORTS.join(', ')} (received ${JSON.stringify(value)})`,
  );
}

export function resolveConfiguredReasoningEffort(
  model: string,
  defaultEffort?: ReasoningEffort,
  modelEfforts?: Record<string, ReasoningEffort>,
): ReasoningEffort {
  return modelEfforts?.[model] ?? defaultEffort ?? DEFAULT_REASONING_EFFORT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate only the reasoning-effort portions of the merged Home23 config. */
export function validateReasoningEffortConfig(config: unknown): void {
  if (!isRecord(config)) throw new TypeError('config must be an object');

  const chat = config.chat;
  if (chat !== undefined) {
    if (!isRecord(chat)) throw new TypeError('chat must be an object');
    parseReasoningEffort(chat.reasoningEffort, 'chat.reasoningEffort');
  }

  const models = config.models;
  if (models === undefined) return;
  if (!isRecord(models)) throw new TypeError('models must be an object');

  const modelEfforts = models.reasoningEffort;
  if (modelEfforts !== undefined) {
    if (!isRecord(modelEfforts)) throw new TypeError('models.reasoningEffort must be an object');
    for (const [model, effort] of Object.entries(modelEfforts)) {
      parseReasoningEffort(effort, `models.reasoningEffort.${model}`);
    }
  }

  const aliases = models.aliases;
  if (aliases === undefined) return;
  if (!isRecord(aliases)) throw new TypeError('models.aliases must be an object');
  for (const [alias, definition] of Object.entries(aliases)) {
    if (!isRecord(definition)) continue;
    parseReasoningEffort(definition.reasoningEffort, `models.aliases.${alias}.reasoningEffort`);
  }
}
