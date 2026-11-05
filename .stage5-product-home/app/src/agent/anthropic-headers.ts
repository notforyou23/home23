/**
 * The Anthropic OAuth stealth surface — ONE harness copy (P2-18, 2026-08-11).
 * Required to use sk-ant-oat* tokens with the Anthropic SDK; impersonates the
 * Claude Code CLI. This string used to live in three harness files and two
 * engine files, maintained by hand.
 *
 * Engine twin: getAnthropicStealthHeaders / ANTHROPIC_OAUTH_BETA exported from
 * engine/src/core/unified-client.js (consumed by anthropic-oauth-engine and
 * the dashboard IDE routes). The two sides are pinned identical across the
 * ESM/CJS boundary by tests/agent/provider-credentials-parity.test.ts.
 */

export const ANTHROPIC_OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11';
export const ANTHROPIC_CLI_USER_AGENT = 'claude-cli/2.1.32 (external, cli)';

export function anthropicOAuthStealthHeaders(): Record<string, string> {
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    'user-agent': ANTHROPIC_CLI_USER_AGENT,
    'x-app': 'cli',
  };
}
