// Keep chat and background Codex transport capabilities on one source line.
// New models require catalog/provider evidence before accepting effort here.
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const capabilities = new Map();
function registerModelCapabilities(provider, model, value) {
  capabilities.set(`${provider}\0${model}`, Object.freeze({ ...value }));
}
function modelCapabilities(provider, model) { return capabilities.get(`${provider}\0${model}`); }
function isDiscoveredReasoningEffort(value) { return [...capabilities.values()].some(row => row.reasoningEffortOptions?.includes(value)); }
function supportsResponsesReasoning(model, provider = 'openai-codex') {
  const discovered = modelCapabilities(provider, model);
  if (discovered) return discovered.reasoningTransport === 'responses';
  return typeof model === 'string' && (/gpt-5\.6(?:$|[-:.])/.test(model)
    || model === 'gpt-6-astra' || model === 'gpt-6.1-sol');
}
function responsesReasoning(model, effort, provider = 'openai-codex') {
  if (effort === undefined || !supportsResponsesReasoning(model, provider)) return undefined;
  const options = modelCapabilities(provider, model)?.reasoningEffortOptions;
  if (!(options ? options.includes(effort) : EFFORTS.has(effort))) throw new TypeError('Unsupported Responses reasoning effort');
  return effort === 'none' ? undefined : { effort, summary: 'auto' };
}
module.exports = { supportsResponsesReasoning, responsesReasoning, registerModelCapabilities, modelCapabilities, isDiscoveredReasoningEffort };
