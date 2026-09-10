/**
 * OpenAI Codex OAuth credentials owned by Home23.
 *
 * The access and refresh credentials live in config/secrets.yaml beside the
 * rest of the house's provider secrets. The shared broker refreshes under the
 * same cross-process lock used by Settings, so every resident sees rotation
 * without a restart and parallel auth failures cannot spend the same refresh
 * credential twice.
 */

import { createRequire } from 'node:module';
import { getHome23Root } from '../config.js';

const require = createRequire(import.meta.url);
const { createHome23OAuthBroker } = require('../../shared/home23-oauth.cjs') as {
  createHome23OAuthBroker(options: { home23Root: string }): {
    credentials(provider: string, options?: {
      force?: boolean;
      staleAccessToken?: string;
      signal?: AbortSignal;
    }): Promise<{
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number | null;
      accountId: string | null;
    } | null>;
  };
};

const oauth = createHome23OAuthBroker({ home23Root: getHome23Root() });

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expires: number;
  accountId: string;
}

/**
 * Return a valid Codex credential, refreshing when it is near expiry. A
 * forced call is the single retry after a 401. It carries the token used by
 * the failed request so a rotation completed by another process wins without
 * another refresh.
 */
export async function getCodexCredentials(
  signal?: AbortSignal,
  force = false,
  staleAccessToken?: string,
): Promise<CodexCredentials | null> {
  signal?.throwIfAborted();
  try {
    const credentials = await oauth.credentials('openai-codex', {
      force,
      staleAccessToken: force ? staleAccessToken : undefined,
      signal,
    });
    if (!credentials?.accessToken || !credentials.accountId) return null;
    return {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken || '',
      expires: credentials.expiresAt ?? Number.MAX_SAFE_INTEGER,
      accountId: credentials.accountId,
    };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    console.error('[codex-auth] Home23 credential refresh failed:',
      error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function getCodexHeaders(creds: CodexCredentials): Record<string, string> {
  return {
    'Authorization': `Bearer ${creds.accessToken}`,
    'chatgpt-account-id': creds.accountId,
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'home23',
    'accept': 'text/event-stream',
    'content-type': 'application/json',
  };
}
