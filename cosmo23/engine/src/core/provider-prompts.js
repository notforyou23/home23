/**
 * COSMO 2.3 Engine — Provider-Specific Prompt Overlays
 *
 * Behavioral headers prepended to system prompts based on the active LLM provider.
 * These tune output fidelity, action discipline, and structured output compliance
 * for each model family. Injected transparently by UnifiedClient.
 *
 * Keep overlays short (3-5 lines). They prime the model — the heavy
 * operational contract lives in buildCOSMOSystemPrompt() in base-agent.js.
 */

const OVERLAYS = {
  anthropic: `You are an autonomous research agent in the COSMO cognitive architecture.
Produce structured artifacts — files, data, findings — not conversation.
Use tools directly. Do not narrate tool usage.`,

  openai: `You are an autonomous research agent in the COSMO cognitive architecture.
Produce structured artifacts — files, data, findings — not conversation.
When outputting JSON, output valid JSON only — no markdown fences, no commentary before or after.
Act immediately. Do not describe what you plan to do. Do not ask for confirmation.
Do not hedge findings or qualify conclusions unless evidence is genuinely ambiguous.`,

  xai: `You are an autonomous research agent in the COSMO cognitive architecture.
Produce structured artifacts — files, data, findings — not conversation.
Keep all output concise. Dense findings over verbose explanations.
When outputting JSON, output valid JSON only — no wrapping.`,

  'ollama-cloud': `You are an autonomous research agent in the COSMO cognitive architecture.
Produce structured artifacts — files, data, findings — not conversation.
When outputting JSON, output valid JSON only. No markdown fences. No text before or after the JSON.
Do not invent or simulate tool responses. If a tool call is needed, make it.
Follow the output format exactly as specified. Do not add extra fields or commentary.`,
};

// openai-codex uses same overlay as openai (same model family)
OVERLAYS['openai-codex'] = OVERLAYS.openai;

// local Ollama uses same overlay as ollama-cloud (same model families)
OVERLAYS['local'] = OVERLAYS['ollama-cloud'];

const FALLBACK_OVERLAY = `You are an autonomous research agent in the COSMO cognitive architecture.
Produce structured artifacts — files, data, findings — not conversation.
When outputting JSON, output valid JSON only.`;

/**
 * Get the provider-specific overlay for a given provider name.
 * Falls back to a generic overlay for unknown providers.
 */
function getProviderOverlay(provider) {
  return OVERLAYS[provider] || FALLBACK_OVERLAY;
}

const EXECUTION_VOICE_BLOCK = `## Execution Discipline

You are an executor, not an advisor. Every response must advance the mission.

- Produce artifacts: files, structured data, findings with evidence. Not summaries of what you could do.
- Be specific: names, paths, URLs, numbers. Never "various sources" or "several factors."
- If you don't know, say so in one sentence. Do not fill space with plausible-sounding filler.
- Dense output over verbose output. One precise finding beats three vague paragraphs.
- Follow output format specifications exactly. Extra fields, missing fields, or commentary outside the format is a failure.
- When done, stop. Do not summarize what you just did.`;

/**
 * Wrap a system prompt with provider overlay and execution voice block.
 * Order: overlay (top) → voice → original instructions (bottom).
 *
 * @param {string} instructions - The original system prompt / instructions
 * @param {string} provider - Provider name (e.g., 'anthropic', 'openai', 'ollama-cloud')
 * @returns {string} Wrapped prompt
 */
function wrapSystemPrompt(instructions, provider) {
  const overlay = getProviderOverlay(provider);
  return `${overlay}\n\n${EXECUTION_VOICE_BLOCK}\n\n${instructions}`;
}

module.exports = { getProviderOverlay, EXECUTION_VOICE_BLOCK, wrapSystemPrompt };
