'use strict';

/**
 * Fleet model floors — the single source (2026-08-11, audit P2-13).
 *
 * Before this file the "default chat model" lived in seven places
 * (agent-config-builder, agent-create, home.ts hardcoded floor, two config
 * keys, the create wizard, runtime persistModel) and they disagreed — the
 * builder was still seeding kimi-k2.6, a model the live catalog no longer
 * declares. Consumers: cli/lib/agent-config-builder.cjs, cli/lib/
 * agent-create.js, src/home.ts (via createRequire), src/agent/
 * text-generation.ts (via createRequire).
 *
 * Rule: values here must be pairs the model authority actually builds —
 * declared in home.yaml.example defaultModels AND aliased, so a fresh agent
 * created from defaults always passes buildHome23ModelAuthority.
 */

const DEFAULT_CHAT_PROVIDER = 'ollama-cloud';
const DEFAULT_CHAT_MODEL = 'kimi-k3:cloud';
const DEFAULT_ENGINE_MODEL = 'MiniMax-M3';

/** Last-resort model per provider when a caller has a provider but no model. */
const DEFAULT_MODEL_BY_PROVIDER = Object.freeze({
  anthropic: 'claude-haiku-4-5',
  minimax: 'MiniMax-M3',
  openai: 'gpt-5.4-mini',
  'openai-codex': 'gpt-5.6-luna',
  xai: 'grok-4.5',
  'ollama-cloud': DEFAULT_CHAT_MODEL,
});

module.exports = {
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_CHAT_MODEL,
  DEFAULT_ENGINE_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
};
