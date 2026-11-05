export const CHAT_REASONING_EFFORTS = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const CHAT_REASONING_EFFORT_SET = new Set(CHAT_REASONING_EFFORTS);

export const CHAT_REASONING_EFFORT_LABELS = Object.freeze({
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
});

export function parseChatReasoningEffort(value, { allowDefault = false } = {}) {
  if (allowDefault && (value === '' || value === null || value === undefined)) return null;
  if (typeof value === 'string' && CHAT_REASONING_EFFORT_SET.has(value)) return value;
  throw new TypeError(`reasoning effort must be one of: ${CHAT_REASONING_EFFORTS.join(', ')}`);
}

export function encodeChatEffortKey(agentName, conversationId) {
  return `home23:chat:effort:${encodeURIComponent(String(agentName || ''))}:${encodeURIComponent(String(conversationId || ''))}`;
}

export function effectiveChatReasoningEffort(override, configuredDefault) {
  return parseChatReasoningEffort(override, { allowDefault: true })
    ?? parseChatReasoningEffort(configuredDefault);
}

export function reasoningEffortsForChatModel(model, available = CHAT_REASONING_EFFORTS) {
  const efforts = available.map((value) => parseChatReasoningEffort(value));
  return model === 'gpt-6-astra'
    ? efforts.filter((value) => value !== 'none')
    : efforts;
}

export function modelSupportsChatReasoningEffort(model, effort, available) {
  return reasoningEffortsForChatModel(model, available).includes(
    parseChatReasoningEffort(effort),
  );
}

export function effortLabel(effort) {
  return CHAT_REASONING_EFFORT_LABELS[effort] || effort;
}
