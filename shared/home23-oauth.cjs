'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readHome23Secrets,
  updateHome23Secrets,
} = require('./home23-secrets.cjs');

const FLOW_TTL_MS = 10 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
// Short on purpose: the providers panel waits on it, and an unreachable provider is not a revoked grant.
const VERIFY_TIMEOUT_MS = 6_000;

const PROVIDERS = Object.freeze({
  anthropic: Object.freeze({
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference',
    tokenEncoding: 'json',
    probeUrl: 'https://api.anthropic.com/v1/models?limit=1',
  }),
  'openai-codex': Object.freeze({
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    tokenEncoding: 'form',
    probeUrl: 'https://chatgpt.com/backend-api/codex/models?client_version=0.50.0',
  }),
});

class Home23OAuthError extends Error {
  constructor(code, message = code, statusCode = 400, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'Home23OAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function assertProvider(provider) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Home23OAuthError('oauth_provider_unsupported', 'OAuth provider is not supported', 404);
  return definition;
}

function asObject(value) {
  return value && !Array.isArray(value) && typeof value === 'object' ? value : {};
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseExpiry(value, fallbackAccessToken) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const payload = decodeJwtPayload(fallbackAccessToken);
  return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function extractOpenAIAccountId(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  return asNonEmptyString(payload?.['https://api.openai.com/auth']?.chatgpt_account_id)
    || asNonEmptyString(payload?.https?.['api.openai.com/auth']?.chatgpt_account_id)
    || asNonEmptyString(payload?.chatgpt_account_id)
    || asNonEmptyString(payload?.sub);
}

function publicCredentials(provider, entry) {
  const accessToken = asNonEmptyString(entry?.apiKey);
  const oauth = asObject(entry?.oauth);
  if (entry?.oauthManaged !== true || !accessToken) return null;
  return {
    provider,
    accessToken,
    refreshToken: asNonEmptyString(oauth.refreshToken),
    expiresAt: parseExpiry(oauth.expiresAt, accessToken),
    accountId: provider === 'openai-codex'
      ? asNonEmptyString(oauth.accountId) || extractOpenAIAccountId(accessToken)
      : null,
  };
}

function credentialsStatus(provider, entry, now) {
  const credentials = publicCredentials(provider, entry);
  const expiresAt = credentials?.expiresAt ?? null;
  return {
    configured: credentials !== null,
    valid: credentials !== null && (expiresAt === null || expiresAt > now),
    refreshable: credentials?.refreshToken !== null && credentials?.refreshToken !== undefined,
    source: credentials ? 'home23' : 'none',
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    accountId: credentials?.accountId ?? null,
  };
}

// The cheapest authenticated read each provider offers. Anthropic only honours a managed OAuth bearer
// when the request looks like its own CLI, so those headers are part of the probe, not decoration.
function probeRequest(provider, definition, credentials) {
  const headers = { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json' };
  if (provider === 'anthropic') {
    Object.assign(headers, {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'claude-cli/2.1.32 (external, cli)',
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
  } else if (credentials.accountId) {
    headers['chatgpt-account-id'] = credentials.accountId;
  }
  return { url: definition.probeUrl, headers };
}

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function parseCallback(provider, input) {
  const text = asNonEmptyString(input);
  if (!text) throw new Home23OAuthError('oauth_callback_required', 'Paste the complete OAuth callback URL');

  let code = null;
  let state = null;
  let providerError = null;
  let decodedByParser = false;
  try {
    const parsed = new URL(text);
    decodedByParser = true;
    code = parsed.searchParams.get('code');
    state = parsed.searchParams.get('state');
    providerError = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
    if (!state && parsed.hash) {
      const hash = parsed.hash.slice(1);
      const hashParams = new URLSearchParams(hash);
      state = hashParams.get('state') || (hash.includes('=') ? null : hash);
    }
  } catch {
    const separator = text.indexOf('#');
    if (separator > 0) {
      code = text.slice(0, separator);
      state = text.slice(separator + 1);
    } else {
      const params = new URLSearchParams(text.replace(/^\?/, ''));
      code = params.get('code');
      state = params.get('state');
    }
  }
  if (providerError) throw new Home23OAuthError('oauth_authorization_denied', `OAuth authorization failed: ${providerError}`);
  code = asNonEmptyString(code);
  state = asNonEmptyString(state);
  if (!code || !state) {
    throw new Home23OAuthError(
      'oauth_callback_invalid',
      `Could not read the authorization code and state from the ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} callback`,
    );
  }
  if (!decodedByParser) {
    try { code = decodeURIComponent(code); } catch { /* input is already literal */ }
    try { state = decodeURIComponent(state); } catch { /* input is already literal */ }
  }
  return { code, state };
}

function sanitizeProviderError(status, text) {
  let message = '';
  try {
    const parsed = JSON.parse(text);
    message = asNonEmptyString(parsed?.error_description)
      || asNonEmptyString(parsed?.error?.message)
      || asNonEmptyString(parsed?.error);
  } catch { /* provider returned non-JSON */ }
  const safe = message && !/token|code|secret|verifier/i.test(message)
    ? `: ${message.slice(0, 160)}`
    : '';
  return `OAuth provider returned HTTP ${status}${safe}`;
}

async function postToken(definition, fields, fetchImpl, signal, now = Date.now) {
  const headers = {};
  let body;
  if (definition.tokenEncoding === 'json') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(fields);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(fields);
  }

  let response;
  try {
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    response = await fetchImpl(definition.tokenUrl, {
      method: 'POST',
      headers,
      body,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    });
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Home23OAuthError('oauth_provider_unreachable', 'Could not reach the OAuth provider', 502, error);
  }

  const text = await readBoundedResponseText(response);
  if (!response.ok) {
    throw new Home23OAuthError(
      'oauth_provider_rejected',
      sanitizeProviderError(response.status, text),
      response.status >= 500 ? 502 : 400,
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Home23OAuthError('oauth_provider_response_invalid', 'OAuth provider returned an invalid response', 502, error);
  }
  const accessToken = asNonEmptyString(data?.access_token);
  const refreshToken = asNonEmptyString(data?.refresh_token);
  const expiresIn = Number(data?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Home23OAuthError('oauth_provider_response_invalid', 'OAuth provider did not return usable credentials', 502);
  }
  return { accessToken, refreshToken, expiresAt: now() + expiresIn * 1000 };
}

async function readBoundedResponseText(response, maxBytes = 64 * 1024) {
  if (!response?.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Home23OAuthError('oauth_provider_response_too_large', 'OAuth provider returned an oversized response', 502);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Home23OAuthError('oauth_provider_response_too_large', 'OAuth provider returned an oversized response', 502);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveHome23Root({ home23Root, secretsPath } = {}) {
  const explicit = asNonEmptyString(home23Root) || asNonEmptyString(process.env.HOME23_ROOT);
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Home23OAuthError('oauth_home_root_invalid', 'HOME23_ROOT must be absolute', 500);
    return path.resolve(explicit);
  }
  const configuredSecrets = asNonEmptyString(secretsPath) || asNonEmptyString(process.env.HOME23_SECRETS_PATH);
  if (configuredSecrets && path.isAbsolute(configuredSecrets)) {
    return path.dirname(path.dirname(path.resolve(configuredSecrets)));
  }
  return path.resolve(__dirname, '..');
}

function providerEntry(secrets, provider) {
  return asObject(asObject(secrets?.providers)[provider]);
}

function importCandidates(provider, userHome) {
  if (provider === 'openai-codex') {
    return [path.join(userHome, '.codex', 'auth.json')];
  }
  return [
    path.join(userHome, '.claude', '.credentials.json'),
    path.join(userHome, '.claude', 'auth.json'),
  ];
}

function importedCredentials(provider, data) {
  const sources = provider === 'openai-codex'
    ? [data?.tokens, data?.oauth, data]
    : [data?.claudeAiOauth, data?.oauth, data];
  for (const source of sources) {
    const value = asObject(source);
    const accessToken = asNonEmptyString(value.accessToken) || asNonEmptyString(value.access_token);
    const refreshToken = asNonEmptyString(value.refreshToken) || asNonEmptyString(value.refresh_token);
    if (!accessToken || !refreshToken) continue;
    const expiresAt = parseExpiry(
      value.expiresAt ?? value.expires_at ?? value.expires,
      accessToken,
    );
    const accountId = provider === 'openai-codex'
      ? asNonEmptyString(value.accountId) || asNonEmptyString(value.account_id) || extractOpenAIAccountId(accessToken)
      : null;
    if (provider === 'openai-codex' && !accountId) continue;
    return { accessToken, refreshToken, expiresAt, accountId };
  }
  return null;
}

function createHome23OAuthBroker(options = {}) {
  const home23Root = resolveHome23Root(options);
  const configuredSecretsPath = asNonEmptyString(options.secretsPath)
    || asNonEmptyString(process.env.HOME23_SECRETS_PATH);
  if (configuredSecretsPath && !path.isAbsolute(configuredSecretsPath)) {
    throw new Home23OAuthError('oauth_secrets_path_invalid', 'HOME23_SECRETS_PATH must be absolute', 500);
  }
  const secretOptions = configuredSecretsPath
    ? { secretsPath: path.resolve(configuredSecretsPath) }
    : {};
  const readSecrets = () => readHome23Secrets(home23Root, secretOptions);
  const updateSecrets = (mutator) => updateHome23Secrets(home23Root, mutator, secretOptions);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const userHome = asNonEmptyString(options.userHome) || os.homedir();
  if (typeof fetchImpl !== 'function') throw new Home23OAuthError('oauth_fetch_unavailable', 'OAuth networking is unavailable', 500);

  async function begin(provider) {
    const definition = assertProvider(provider);
    const { verifier, challenge } = generatePkce();
    const state = crypto.randomBytes(24).toString('base64url');
    const createdAt = now();
    const expiresAt = createdAt + FLOW_TTL_MS;
    await updateSecrets((secrets) => {
      if (!secrets.providers || typeof secrets.providers !== 'object' || Array.isArray(secrets.providers)) secrets.providers = {};
      const current = asObject(secrets.providers[provider]);
      current.oauthPending = {
        verifier,
        state,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
      secrets.providers[provider] = current;
      return { changed: true };
    });

    const authUrl = new URL(definition.authorizeUrl);
    const params = {
      response_type: 'code',
      client_id: definition.clientId,
      redirect_uri: definition.redirectUri,
      scope: definition.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    };
    if (provider === 'anthropic') params.code = 'true';
    if (provider === 'openai-codex') {
      params.id_token_add_organizations = 'true';
      params.codex_cli_simplified_flow = 'true';
      params.originator = 'home23';
    }
    for (const [key, value] of Object.entries(params)) authUrl.searchParams.set(key, value);
    return { authUrl: authUrl.toString(), expiresInSeconds: Math.floor(FLOW_TTL_MS / 1000) };
  }

  async function complete(provider, callbackUrl, optionsForCall = {}) {
    const definition = assertProvider(provider);
    const { code, state } = parseCallback(provider, callbackUrl);
    const secrets = await readSecrets();
    const pending = asObject(providerEntry(secrets, provider).oauthPending);
    const verifier = asNonEmptyString(pending.verifier);
    const expectedState = asNonEmptyString(pending.state);
    const pendingExpiresAt = parseExpiry(pending.expiresAt);
    if (!verifier || !expectedState || !pendingExpiresAt) {
      throw new Home23OAuthError('oauth_flow_missing', 'Start a new OAuth flow before completing it');
    }
    if (pendingExpiresAt <= now()) {
      throw new Home23OAuthError('oauth_flow_expired', 'This OAuth flow expired; start a new one');
    }
    const supplied = Buffer.from(state);
    const expected = Buffer.from(expectedState);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw new Home23OAuthError('oauth_state_mismatch', 'OAuth state did not match; start a new flow');
    }

    const tokenFields = {
      grant_type: 'authorization_code',
      client_id: definition.clientId,
      code,
      state,
      redirect_uri: definition.redirectUri,
      code_verifier: verifier,
    };
    const tokens = await postToken(definition, tokenFields, fetchImpl, optionsForCall.signal, now);
    const accountId = provider === 'openai-codex' ? extractOpenAIAccountId(tokens.accessToken) : null;
    if (provider === 'openai-codex' && !accountId) {
      throw new Home23OAuthError('oauth_account_missing', 'OpenAI did not return a usable ChatGPT account identity', 502);
    }
    if (!tokens.refreshToken) {
      throw new Home23OAuthError('oauth_refresh_missing', 'OAuth provider did not return a refresh credential', 502);
    }

    await updateSecrets((nextSecrets) => {
      const entry = providerEntry(nextSecrets, provider);
      const currentPending = asObject(entry.oauthPending);
      if (currentPending.state !== expectedState || currentPending.verifier !== verifier) {
        throw new Home23OAuthError('oauth_flow_changed', 'A newer OAuth flow has started; complete that flow instead');
      }
      if (!nextSecrets.providers || typeof nextSecrets.providers !== 'object') nextSecrets.providers = {};
      entry.apiKey = tokens.accessToken;
      entry.oauthManaged = true;
      entry.oauth = {
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        updatedAt: new Date(now()).toISOString(),
        ...(accountId ? { accountId } : {}),
      };
      delete entry.oauthPending;
      nextSecrets.providers[provider] = entry;
      return { changed: true };
    });
    return status(provider);
  }

  async function credentials(provider, optionsForCall = {}) {
    const definition = assertProvider(provider);
    const initial = publicCredentials(provider, providerEntry(await readSecrets(), provider));
    if (!initial) return null;
    const force = optionsForCall.force === true;
    const staleAccessToken = asNonEmptyString(optionsForCall.staleAccessToken) || initial.accessToken;
    if (!force && (initial.expiresAt === null || initial.expiresAt - now() > REFRESH_THRESHOLD_MS)) return initial;
    if (!initial.refreshToken) return initial.expiresAt === null || initial.expiresAt > now() ? initial : null;

    const outcome = await updateSecrets(async (secrets) => {
      const entry = providerEntry(secrets, provider);
      const current = publicCredentials(provider, entry);
      if (!current) return { changed: false, value: null };
      if (force && current.accessToken !== staleAccessToken) {
        return { changed: false, value: current };
      }
      if (!force && (current.expiresAt === null || current.expiresAt - now() > REFRESH_THRESHOLD_MS)) {
        return { changed: false, value: current };
      }
      if (!current.refreshToken) {
        return { changed: false, value: current.expiresAt === null || current.expiresAt > now() ? current : null };
      }
      const refreshed = await postToken(definition, {
        grant_type: 'refresh_token',
        client_id: definition.clientId,
        refresh_token: current.refreshToken,
      }, fetchImpl, optionsForCall.signal, now);
      const accountId = provider === 'openai-codex'
        ? extractOpenAIAccountId(refreshed.accessToken) || current.accountId
        : null;
      entry.apiKey = refreshed.accessToken;
      entry.oauthManaged = true;
      entry.oauth = {
        refreshToken: refreshed.refreshToken || current.refreshToken,
        expiresAt: new Date(refreshed.expiresAt).toISOString(),
        updatedAt: new Date(now()).toISOString(),
        ...(accountId ? { accountId } : {}),
      };
      return { changed: true, value: publicCredentials(provider, entry) };
    });
    return outcome.value ?? null;
  }

  async function status(provider) {
    assertProvider(provider);
    const secrets = await readSecrets();
    return credentialsStatus(provider, providerEntry(secrets, provider), now());
  }

  // status() trusts expiry, which cannot see a grant the provider revoked. verify() asks the provider,
  // read-only: it never rotates tokens, and neither the bearer nor the provider's reply leaves this call.
  async function verify(provider, optionsForCall = {}) {
    const definition = assertProvider(provider);
    const entry = providerEntry(await readSecrets(), provider);
    const current = credentialsStatus(provider, entry, now());
    const credentials = publicCredentials(provider, entry);
    if (!credentials) return current;
    const unverified = (verificationError) => ({ ...current, verified: false, revoked: false, verificationError });
    // An expired access token would 401 whether or not the grant lives; only the refresh path can tell.
    if (!current.valid) return unverified('expired');

    const { url, headers } = probeRequest(provider, definition, credentials);
    let response;
    try {
      const signals = [AbortSignal.timeout(VERIFY_TIMEOUT_MS)];
      if (optionsForCall.signal) signals.push(optionsForCall.signal);
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      });
    } catch (error) {
      if (optionsForCall.signal?.aborted) optionsForCall.signal.throwIfAborted();
      return unverified(error?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    // The body only tells an authentication 403 from a policy 403; an unreadable body is treated as empty.
    const text = await readBoundedResponseText(response).catch(() => '');
    if (response.ok) return { ...current, valid: true, verified: true, revoked: false, verificationError: null };
    if (response.status === 401 || (response.status === 403 && text.includes('authentication_error'))) {
      return { ...current, valid: false, verified: true, revoked: true, verificationError: null };
    }
    return unverified(`provider_error:${response.status}`);
  }

  async function clear(provider) {
    assertProvider(provider);
    const outcome = await updateSecrets((secrets) => {
      const entry = providerEntry(secrets, provider);
      const changed = entry.oauthManaged === true || entry.oauth !== undefined || entry.oauthPending !== undefined;
      if (!changed) return { changed: false };
      if (entry.oauthManaged === true) delete entry.apiKey;
      delete entry.oauthManaged;
      delete entry.oauth;
      delete entry.oauthPending;
      return { changed: true };
    });
    return { cleared: outcome.changed };
  }

  async function importCli(provider) {
    assertProvider(provider);
    let imported = null;
    let sourcePath = null;
    for (const candidate of importCandidates(provider, userHome)) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        imported = importedCredentials(provider, JSON.parse(fs.readFileSync(candidate, 'utf8')));
        if (imported) { sourcePath = candidate; break; }
      } catch { /* try the next known CLI location */ }
    }
    if (!imported || !sourcePath) {
      const label = provider === 'anthropic' ? 'Claude CLI' : 'Codex CLI';
      throw new Home23OAuthError('oauth_cli_credentials_missing', `No usable ${label} OAuth credentials were found`, 404);
    }
    await updateSecrets((secrets) => {
      if (!secrets.providers || typeof secrets.providers !== 'object') secrets.providers = {};
      const entry = providerEntry(secrets, provider);
      entry.apiKey = imported.accessToken;
      entry.oauthManaged = true;
      entry.oauth = {
        refreshToken: imported.refreshToken,
        ...(imported.expiresAt ? { expiresAt: new Date(imported.expiresAt).toISOString() } : {}),
        updatedAt: new Date(now()).toISOString(),
        ...(imported.accountId ? { accountId: imported.accountId } : {}),
      };
      delete entry.oauthPending;
      secrets.providers[provider] = entry;
      return { changed: true };
    });
    return { ...(await status(provider)), importedFrom: sourcePath };
  }

  return Object.freeze({
    begin,
    clear,
    complete,
    credentials,
    home23Root,
    importCli,
    status,
    verify,
  });
}

module.exports = {
  FLOW_TTL_MS,
  Home23OAuthError,
  PROVIDERS,
  REFRESH_THRESHOLD_MS,
  createHome23OAuthBroker,
  decodeJwtPayload,
  extractOpenAIAccountId,
  parseCallback,
  resolveHome23Root,
};
