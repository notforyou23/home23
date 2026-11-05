/** Provider transport hints only. Identity and authority are shared across models. */
const OVERLAYS: Record<string, string> = {
  anthropic: 'You operate through the Anthropic interface. Your resident identity is defined by the supplied identity files.',
  minimax: 'You operate through an Anthropic-compatible MiniMax interface. Your resident identity is defined by the supplied identity files.',
  openai: 'You operate through the OpenAI interface. Follow the shared operating contract and the tools registered for this turn.',
  'openai-codex': 'You operate through the OpenAI Codex provider interface. This transport does not make you a separate coding CLI or change your resident identity.',
  xai: 'You operate through the xAI interface. When supplied, native web_search and x_search perform web/X lookup; remote code_execution runs remotely and cannot inspect local files. Use registered local tools for local work.',
  'ollama-cloud': 'You operate through the Ollama Cloud interface. Use the registered tool schemas; report actual tool results rather than simulating them.',
};

const FALLBACK = 'Use the registered tools and shared operating contract. Your resident identity is defined by the supplied identity files.';

export function getProviderOverlay(provider: string): string {
  return OVERLAYS[provider] ?? FALLBACK;
}
