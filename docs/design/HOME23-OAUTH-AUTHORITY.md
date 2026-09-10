# Home23 OAuth authority

**Status:** Current
**Date:** 2026-09-10

Home23 owns Anthropic and OpenAI Codex OAuth directly. Setup and Settings do
not need a second local service, database, or IDE to sign in, retain access, or
refresh a credential.

## Product flow

1. The owner selects **Sign in with Anthropic** or **Sign in with ChatGPT**.
2. Home23 creates a fresh PKCE verifier, challenge, and independent state.
3. Home23 stores the verifier and state in the locked local secret store and
   immediately returns the provider authorization URL.
4. The browser authorizes the account. The owner pastes the complete final
   callback URL into Home23. This works when the house runs locally or on a
   headless Linux host.
5. Home23 validates state and expiry, exchanges the code, and atomically
   replaces the pending flow with access and refresh credentials.
6. Agents read the access credential at use. A near-expiry token refreshes
   proactively. A 401 permits one forced refresh and one retry.

The official Claude and Codex CLIs are optional one-time import sources. Their
files are never runtime authorities.

## Storage

OAuth data lives in the gitignored, mode-0600 `config/secrets.yaml` file:

```yaml
providers:
  openai-codex:
    apiKey: "<access credential>"
    oauthManaged: true
    oauth:
      refreshToken: "<refresh credential>"
      expiresAt: "<ISO timestamp>"
      updatedAt: "<ISO timestamp>"
      accountId: "<ChatGPT account id>"
```

Anthropic uses the same shape without `accountId`. An in-progress sign-in uses
an `oauthPending` block under the provider. It expires after ten minutes and is
removed after successful completion or logout.

All writes use `shared/home23-secrets.cjs`. Its cross-process lock and atomic
rename preserve unrelated secrets, the brain-operations capability boundary,
and mode 0600. Refresh occurs inside that transaction. If several residents
encounter the same expired credential, the first process rotates it and later
processes reuse the new access credential instead of spending the old refresh
credential again.

## Runtime contract

- `shared/home23-oauth.cjs` owns provider definitions, PKCE, callback parsing,
  code exchange, refresh, status, import, and logout.
- Setup and Settings expose the broker through
  `/home23/api/settings/oauth/<provider>/*`.
- The harness and engine resolve `config/secrets.yaml` at use. Rotation does
  not require ecosystem regeneration or a PM2 restart.
- The dashboard performs a quiet ten-minute readiness sweep for idle homes.
  Live calls do not wait for that sweep.
- Provider responses and logs never contain access tokens, refresh tokens,
  authorization codes, or PKCE verifiers.

## Existing installations

An access-only `oauthManaged` entry is shown as **Sign in again** even while its
current access token still works; it does not satisfy first-run readiness.
Before removing an older credential source, use **Import from Codex
CLI**, **Import from Claude CLI**, or complete a fresh Home23 sign-in so the
house has its own refresh credential. Confirm Settings shows **Connected** and
`refreshable: true` through the OAuth status API.

Static API keys keep their existing precedence and are never converted into
managed OAuth credentials.
