// Keep chat and background Codex transport capabilities on one source line.
// New models require catalog/provider evidence before accepting effort here.
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const capabilities = new Map();
function registerModelCapabilities(provider, model, value) {
  capabilities.set(`${provider}\0${model}`, Object.freeze({ ...value }));
}
function modelCapabilities(provider, model) { return capabilities.get(`${provider}\0${model}`); }
function isDiscoveredReasoningEffort(value) { return [...capabilities.values()].some(row => row.reasoningEffortOptions?.includes(value)); }
function reviewedReasoningCapabilities(provider, model) {
  if (provider !== 'openai-codex' || typeof model !== 'string' || !(/gpt-5\.6(?:$|[-:.])/.test(model) || model === 'gpt-6-astra' || model === 'gpt-6.1-sol')) return null;
  return { reasoningCapabilitiesKnown: true, reasoningTransport: 'responses', reasoningEffortOptions: model === 'gpt-6-astra' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [...EFFORTS] };
}
function supportsResponsesReasoning(model, provider = 'openai-codex') {
  const discovered = modelCapabilities(provider, model);
  if (discovered?.reasoningCapabilitiesKnown !== false && discovered) return discovered.reasoningTransport === 'responses';
  return typeof model === 'string' && (/gpt-5\.6(?:$|[-:.])/.test(model)
    || model === 'gpt-6-astra' || model === 'gpt-6.1-sol');
}
function responsesReasoning(model, effort, provider = 'openai-codex') {
  if (effort === undefined || !supportsResponsesReasoning(model, provider)) return undefined;
  const discovered = modelCapabilities(provider, model);
  const options = discovered?.reasoningCapabilitiesKnown === false ? null : discovered?.reasoningEffortOptions;
  if (!(options ? options.includes(effort) : EFFORTS.has(effort))) throw new TypeError('Unsupported Responses reasoning effort');
  return effort === 'none' ? undefined : { effort, summary: 'auto' };
}
module.exports = { supportsResponsesReasoning, responsesReasoning, registerModelCapabilities, modelCapabilities, isDiscoveredReasoningEffort, reviewedReasoningCapabilities };
