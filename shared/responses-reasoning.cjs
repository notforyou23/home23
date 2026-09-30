// Keep chat and background Codex transport capabilities on one source line.
// New models require catalog/provider evidence before accepting effort here.
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
function supportsResponsesReasoning(model) {
  return typeof model === 'string' && (/gpt-5\.6(?:$|[-:.])/.test(model)
    || model === 'gpt-6-astra' || model === 'gpt-6.1-sol');
}
function responsesReasoning(model, effort) {
  if (effort === undefined || !supportsResponsesReasoning(model)) return undefined;
  if (!EFFORTS.has(effort)) throw new TypeError('Unsupported Responses reasoning effort');
  return effort === 'none' ? undefined : { effort, summary: 'auto' };
}
module.exports = { supportsResponsesReasoning, responsesReasoning };
