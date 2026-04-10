# Step 18: OAuth Setup in Settings UI

**Date:** 2026-04-10
**Status:** Approved → implementation pending

## Summary

Expose Anthropic (claude.ai PKCE) and OpenAI Codex (ChatGPT JWT) OAuth flows
directly from the Home23 Settings UI. OAuth is the preferred authentication
path for both providers — it's free for users with a Claude Max plan or a
ChatGPT Plus/Pro subscription, and it avoids the API key billing surface.

Home23 does NOT reimplement the OAuth flows. The bundled cosmo23 server
already has a battle-tested, fully-functional OAuth stack (PKCE, token
storage in Prisma/SQLite, AES-256-GCM encryption, auto-refresh, stealth
headers). Home23 uses cosmo23 as an **OAuth broker**: the Settings UI proxies
through to cosmo23's existing `/api/oauth/*` routes, and a small token-bridge
path pulls the resulting token into `config/secrets.yaml` so it flows to the
Home23 harness + engine via the standard PM2 env-injection pipeline.

One small vendored patch to cosmo23 adds a read-only admin endpoint
exposing the current decrypted token, so Home23 can fetch and inject it
after OAuth completion.

## Design principles

1. **Don't reimplement what cosmo23 already does right.** COSMO 2.3 has ~1000
   lines of working OAuth code (PKCE flow, token storage, encryption, refresh,
   Claude CLI import, Evobrew import, stealth headers). Duplicating it in
   Home23 would be ~2 weeks of work and create a long-tail maintenance burden
   of keeping two OAuth stacks in sync.
2. **cosmo23 is always running when Home23 is running.** Home23 starts the
   cosmo23 process unconditionally — OAuth dependency on cosmo23 is zero
   additional fragility.
3. **OAuth is one-time setup.** After the user authorizes once, refresh
   happens silently in the background. The hot path is "read token from
   secrets.yaml" — the OAuth dance is a cold path.
4. **Secrets.yaml is the source of truth for Home23.** All runtime token
   consumption goes through `config/secrets.yaml` → `ecosystem.config.cjs`
   → PM2 env vars. OAuth doesn't change that contract; it just becomes a
   new way to populate those fields.
5. **Token refresh is cosmo23's job, not Home23's.** cosmo23 handles PKCE
   refresh internally. Home23 polls cosmo23 periodically for the current
   token and writes it to secrets.yaml if it's changed. Self-healing.

## The OAuth broker pattern

```
┌─────────────────────────────────────────────────────────────────┐
│ Home23 Dashboard (5002)                                          │
│  Settings → Providers → OAuth cards                              │
│  └─► /home23/api/settings/oauth/anthropic/import-cli              │
│      /home23/api/settings/oauth/anthropic/start                   │
│      /home23/api/settings/oauth/anthropic/callback                │
│      /home23/api/settings/oauth/anthropic/status                  │
│      /home23/api/settings/oauth/anthropic/logout                  │
│      (same 5 for openai-codex)                                    │
└────────────────┬────────────────────────────────────────────────┘
                 │ HTTP proxy (localhost)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ cosmo23 server (43210)                                           │
│  /api/oauth/anthropic/{start,callback,status,import-cli,logout}  │
│  /api/oauth/openai-codex/{start,callback,status,import,logout}   │
│  /api/oauth/anthropic/raw-token      ← HOME23 PATCH               │
│  /api/oauth/openai-codex/raw-token   ← HOME23 PATCH               │
│                                                                  │
│  SystemConfig table (Prisma/SQLite, AES-256-GCM)                 │
│  Token cache + refresh logic (anthropic-oauth.js, codex-oauth.js)│
└────────────────┬────────────────────────────────────────────────┘
                 │ After OAuth success, dashboard polls raw-token
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Home23 Dashboard token-bridge                                    │
│  1. Fetch raw token from cosmo23 /api/oauth/*/raw-token           │
│  2. Write to config/secrets.yaml (providers.anthropic.apiKey,    │
│     providers.openai-codex.apiKey)                                │
│  3. Regenerate ecosystem.config.cjs                              │
│  4. Trigger pm2 restart home23-<agent> home23-<agent>-harness    │
│     so the new env vars flow through                             │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ home23-<agent> + home23-<agent>-harness                          │
│  process.env.ANTHROPIC_AUTH_TOKEN = <OAuth access token>          │
│  process.env.OPENAI_CODEX_AUTH_TOKEN = <JWT access token>         │
│                                                                  │
│  Engine anthropic-oauth-engine.js reads env → passes to SDK      │
│  Harness src/home.ts + src/agent/loop.ts already have the        │
│  stealth headers and authToken pathway (pre-existing)             │
└─────────────────────────────────────────────────────────────────┘
```

## Vendored patch — new cosmo23 admin endpoint

**Why:** cosmo23 exposes OAuth status (configured, valid, expiresAt) but not
the raw decrypted token. Home23 needs the raw token to write into
`secrets.yaml`. Adding a new read-only admin endpoint is the minimum change.

**Location:** `cosmo23/server/index.js`, near the other oauth routes (~line 906).

**New routes:**

```js
// HOME23 PATCH — expose raw decrypted token for secrets.yaml sync
// These routes are for Home23's OAuth broker — they return the current
// access token so Home23 can inject it into its own env vars. Localhost-only
// via Express default binding; not exposed over any remote interface.
app.get('/api/oauth/anthropic/raw-token', async (_req, res) => {
  try {
    const creds = await getAnthropicApiKey();  // returns { authToken, isOAuth, ... }
    if (!creds?.authToken) return res.status(404).json({ ok: false, error: 'not configured' });
    res.json({
      ok: true,
      token: creds.authToken,
      isOAuth: creds.isOAuth === true,
      source: creds.source || 'db',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/oauth/openai-codex/raw-token', async (_req, res) => {
  try {
    const { getCodexCredentials } = require('./services/openai-codex-oauth');
    const creds = await getCodexCredentials();
    if (!creds?.accessToken) return res.status(404).json({ ok: false, error: 'not configured' });
    res.json({
      ok: true,
      token: creds.accessToken,
      accountId: creds.accountId || null,
      expiresAt: creds.expiresAt || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

Both endpoints delegate to the existing `getAnthropicApiKey()` /
`getCodexCredentials()` functions that handle refresh-if-expired internally.
So Home23 always gets a fresh token just by calling `raw-token`.

**Security note:** These endpoints are localhost-only (Express default bind).
They do NOT require an auth header. Any process that can reach 43210 on
localhost can retrieve the token — which is fine because any such process
already has filesystem access to the same Prisma DB. This does not lower the
security bar; it just avoids reimplementing the decrypt path in Home23.

This patch goes into `docs/design/COSMO23-VENDORED-PATCHES.md` as Patch 4 and
must survive future `cli/home23.js cosmo23 update` runs.

## Home23 layer — new proxy routes

All in `engine/src/dashboard/home23-settings-api.js`, following the same
pattern as existing settings routes:

```
GET  /home23/api/settings/oauth/status
     → returns { anthropic: {configured, expiresAt}, openaiCodex: {...} }
     → aggregates both cosmo23 /status endpoints in one call for the UI

POST /home23/api/settings/oauth/anthropic/import-cli
     → proxies to cosmo23 /api/oauth/anthropic/import-cli
     → on success: fetch raw-token, write to secrets.yaml, restart engine+harness
     → returns { ok, imported: bool, source: 'cli', error? }

GET  /home23/api/settings/oauth/anthropic/start
     → proxies to cosmo23 /api/oauth/anthropic/start
     → returns { ok, authUrl, verifier } so UI can open in new tab

POST /home23/api/settings/oauth/anthropic/callback
     → body: { callbackUrl: "https://console.anthropic.com/oauth/code/callback?code=...&state=..." }
     → proxies to cosmo23 /api/oauth/anthropic/callback
     → on success: fetch raw-token, sync secrets.yaml, restart
     → returns { ok, error? }

POST /home23/api/settings/oauth/anthropic/logout
     → proxies to cosmo23 /api/oauth/anthropic/logout
     → clears secrets.yaml entry too (set providers.anthropic.apiKey to empty)
     → returns { ok }

# Same 5 routes for openaiCodex/*:
POST /home23/api/settings/oauth/openai-codex/import-evobrew
GET  /home23/api/settings/oauth/openai-codex/start
POST /home23/api/settings/oauth/openai-codex/callback
POST /home23/api/settings/oauth/openai-codex/logout
```

### Token-bridge helper

```js
async function syncOAuthTokenToSecrets(provider) {
  // provider: 'anthropic' | 'openai-codex'
  const endpointProvider = provider === 'anthropic' ? 'anthropic' : 'openai-codex';
  const r = await fetch(`http://localhost:43210/api/oauth/${endpointProvider}/raw-token`);
  if (!r.ok) return { ok: false, error: `cosmo23 returned ${r.status}` };
  const { token } = await r.json();
  if (!token) return { ok: false, error: 'no token returned' };

  // Write to secrets.yaml under the correct provider key
  const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
  const secrets = loadYaml(secretsPath);
  if (!secrets.providers) secrets.providers = {};
  const providerKey = provider === 'anthropic' ? 'anthropic' : 'openai-codex';
  if (!secrets.providers[providerKey]) secrets.providers[providerKey] = {};
  secrets.providers[providerKey].apiKey = token;
  secrets.providers[providerKey].oauthManaged = true; // marker so regenerate knows
  saveYaml(secretsPath, secrets);

  // Regenerate ecosystem + restart the engine + harness processes
  regenerateEcosystem();
  const { execSync } = require('child_process');
  try {
    // Find the primary agent from home.yaml
    const homeCfg = loadYaml(path.join(home23Root, 'config', 'home.yaml'));
    const agentName = homeCfg.home?.primaryAgent;
    if (agentName) {
      execSync(`pm2 restart home23-${agentName} home23-${agentName}-harness --update-env`,
               { stdio: 'pipe', timeout: 30000 });
    }
  } catch (err) {
    return { ok: true, warn: `token written but restart failed: ${err.message}` };
  }
  return { ok: true };
}
```

### Background refresh poller

In `engine/src/dashboard/server.js`, add to the dashboard's startup:

```js
// OAuth token refresh poller — checks cosmo23 every 30 min for updated tokens.
// cosmo23 handles PKCE refresh internally; we just need to catch the new
// token and sync it into secrets.yaml when it rotates.
setInterval(async () => {
  for (const provider of ['anthropic', 'openai-codex']) {
    try {
      const r = await fetch(`http://localhost:43210/api/oauth/${provider}/raw-token`,
                            { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const { token } = await r.json();
      if (!token) continue;

      const secrets = loadYaml(secretsPath);
      const currentProviderKey = provider === 'anthropic' ? 'anthropic' : 'openai-codex';
      const current = secrets.providers?.[currentProviderKey]?.apiKey;
      if (current !== token) {
        // Token rotated — sync
        await syncOAuthTokenToSecrets(provider);
        console.log(`[OAuth refresh] synced new ${provider} token to secrets.yaml`);
      }
    } catch { /* silent */ }
  }
}, 30 * 60 * 1000); // 30 min
```

Only fires if the user has OAuth configured (we skip silently on 404). Cheap
one HTTP call per provider every 30 min.

## Frontend — OAuth cards on the Providers tab

The Providers tab already has a card layout for each provider with an API
key input. Add two new cards at the top (OAuth-first) for Anthropic and
OpenAI Codex. Each card:

```html
<div class="h23s-oauth-card">
  <h3>Anthropic — OAuth <span class="h23s-oauth-badge">recommended</span></h3>
  <p class="h23s-panel-desc">
    Authenticate with your Claude account (claude.ai). Requires a Claude Max
    plan for the API. Tokens refresh automatically.
  </p>
  <div id="anthropic-oauth-status">—</div>
  <div class="h23s-action-row">
    <button class="h23s-btn-primary" id="btn-anthropic-oauth-import">
      Import from Claude CLI
    </button>
    <button class="h23s-btn-secondary" id="btn-anthropic-oauth-start">
      Start OAuth Flow
    </button>
    <button class="h23s-btn-secondary" id="btn-anthropic-oauth-logout" hidden>
      Logout
    </button>
  </div>
  <div class="h23s-oauth-flow" id="anthropic-oauth-flow" hidden>
    <p>Click the link below to open Anthropic's OAuth page. After authorizing,
    copy the full callback URL from your browser and paste it here.</p>
    <a id="anthropic-oauth-link" target="_blank" rel="noopener">Open OAuth page</a>
    <textarea id="anthropic-oauth-callback" placeholder="https://console.anthropic.com/oauth/code/callback?code=...&state=..."></textarea>
    <button class="h23s-btn-primary" id="btn-anthropic-oauth-complete">
      Complete OAuth
    </button>
  </div>
</div>
```

OpenAI Codex card is the same structure, swap "Import from Claude CLI" for
"Import from Evobrew" and swap all the IDs.

### Status rendering

```js
async function renderOAuthStatus() {
  const res = await fetch(`${API}/oauth/status`);
  const data = await res.json();

  // Anthropic
  const a = data.anthropic || {};
  const aStatus = document.getElementById('anthropic-oauth-status');
  if (a.configured) {
    const expiry = a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleDateString()}` : '';
    aStatus.innerHTML = `<span class="h23s-oauth-connected">✓ Connected${expiry}</span>`;
    document.getElementById('btn-anthropic-oauth-logout').hidden = false;
  } else {
    aStatus.innerHTML = '<span class="h23s-oauth-disconnected">Not configured</span>';
    document.getElementById('btn-anthropic-oauth-logout').hidden = true;
  }

  // Codex — same pattern
  const c = data.openaiCodex || {};
  const cStatus = document.getElementById('codex-oauth-status');
  if (c.configured) {
    const expiry = c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : '';
    cStatus.innerHTML = `<span class="h23s-oauth-connected">✓ Connected${expiry}</span>`;
    document.getElementById('btn-codex-oauth-logout').hidden = false;
  } else {
    cStatus.innerHTML = '<span class="h23s-oauth-disconnected">Not configured</span>';
    document.getElementById('btn-codex-oauth-logout').hidden = true;
  }
}
```

### Button handlers

```js
async function anthropicOAuthImportCli() {
  const r = await fetch(`${API}/oauth/anthropic/import-cli`, { method: 'POST' });
  const data = await r.json();
  if (data.ok) {
    renderOAuthStatus();
    showStatus('Imported from Claude CLI — engine restarting with new credentials');
  } else {
    showStatus('Import failed: ' + data.error);
  }
}

async function anthropicOAuthStart() {
  const r = await fetch(`${API}/oauth/anthropic/start`);
  const data = await r.json();
  if (data.authUrl) {
    document.getElementById('anthropic-oauth-link').href = data.authUrl;
    document.getElementById('anthropic-oauth-flow').hidden = false;
  }
}

async function anthropicOAuthComplete() {
  const callbackUrl = document.getElementById('anthropic-oauth-callback').value.trim();
  if (!callbackUrl) return;
  const r = await fetch(`${API}/oauth/anthropic/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl }),
  });
  const data = await r.json();
  if (data.ok) {
    document.getElementById('anthropic-oauth-flow').hidden = true;
    document.getElementById('anthropic-oauth-callback').value = '';
    renderOAuthStatus();
    showStatus('OAuth complete — engine restarting with new credentials');
  } else {
    showStatus('OAuth failed: ' + data.error);
  }
}

async function anthropicOAuthLogout() {
  if (!confirm('Log out of Anthropic OAuth? The agent will lose access until re-configured.')) return;
  const r = await fetch(`${API}/oauth/anthropic/logout`, { method: 'POST' });
  const data = await r.json();
  if (data.ok) {
    renderOAuthStatus();
    showStatus('Logged out');
  }
}

// Same 4 handlers for openaiCodex — swap the provider in the URL
```

## Edge cases

- **User has an API key already:** If `secrets.yaml` has `providers.anthropic.apiKey`
  set via the existing API key flow, and then does an OAuth import, the OAuth
  token replaces the API key. We set `oauthManaged: true` on the provider so
  the ecosystem generator and any future "which auth source" logic can
  distinguish. On logout, we clear both the apiKey AND the oauthManaged flag.

- **cosmo23 down during OAuth:** The Import/Start buttons will fail gracefully
  because the proxy returns 502 when cosmo23 is unreachable. UI shows the
  error. User can retry after `pm2 restart home23-cosmo23`.

- **Token refresh during a run:** The background poller fires every 30 min.
  If a research run is in progress when a refresh happens, restarting the
  engine would kill it. We should skip the restart if a research run is
  active (check `/api/status` first). This is a small but real gotcha.

- **Callback URL paste format:** Users paste the FULL URL from their browser
  including query string. cosmo23's `extractCallbackParams()` already handles
  this; we just forward the string as-is.

- **Claude CLI not installed:** The import-cli flow returns a clear error if
  `~/.claude/.credentials.json` doesn't exist. UI should surface this.

- **Evobrew profiles not present:** Same as above for the Codex import-evobrew
  path, reads from `~/.evobrew/auth-profiles.json`.

## Smoke test plan

1. **Fresh state:** stop cosmo23, delete its DB, start it, verify no OAuth configured
2. **Anthropic Import from CLI:** If `~/.claude/.credentials.json` exists, click Import → expect status to flip to "Connected" → verify `secrets.yaml` has the token → verify `pm2 env home23-jerry` shows `ANTHROPIC_AUTH_TOKEN` is set
3. **Anthropic OAuth flow:** Click Start → new tab opens → authorize → copy callback URL → paste → click Complete → verify same as above
4. **Status roundtrip:** Reload the Settings page → status pulls from cosmo23 `/api/oauth/anthropic/status` → shows Connected
5. **Logout:** Click Logout → confirm → verify cosmo23 DB record cleared, secrets.yaml cleared, processes restarted without the token
6. **Codex Import from Evobrew:** If `~/.evobrew/auth-profiles.json` has `openai-codex:default`, import → status → secrets.yaml → env var check
7. **Background poller:** Manually rotate a cosmo23 token (sqlite3 update) → wait 30 min OR trigger the poll → verify secrets.yaml updates
8. **Active-run protection:** Start a COSMO research run → trigger poll with a fake-rotated token → verify the restart is skipped → run completes → poller fires after → restart happens

## Risks

- **pm2 restart during active work is disruptive.** The 30-min poll + active-run skip mitigates most of this, but a pathological case is rapid token rotation + long-running chat. Accept; user can always do a manual `pm2 restart` on their schedule.

- **cosmo23 vendored patch count growing.** We're at 3 now (config dir, env-first keys, bootstrap safe-assign) and this adds a 4th (raw-token endpoints). Each one is small and well-documented. Total vendored drift is still ~30 lines of code across ~3k lines of cosmo23 server. Acceptable.

- **Token visible in secrets.yaml on disk.** This is identical to the existing API key model — `secrets.yaml` is already the source of truth for all keys. Gitignored, file mode 0600. No new risk surface.

- **Claude CLI credentials file format may change.** cosmo23's import-cli handler already handles both `~/.claude/.credentials.json` (current) and `~/.claude/auth.json` (legacy). If Claude changes the format again, cosmo23 needs a patch — not a Home23 concern.

## Implementation order

1. Add the 2 raw-token endpoints to cosmo23 (~40 lines)
2. Add the new proxy routes to Home23 settings-api.js (~200 lines)
3. Add the token-bridge helper + background poller (~80 lines)
4. Add the OAuth cards HTML + JS + CSS to settings page (~250 lines)
5. Smoke test all 8 scenarios
6. Update README + CLAUDE.md + COSMO23-VENDORED-PATCHES.md
7. Commit + push

## Key files

- `cosmo23/server/index.js` — 2 new endpoints (vendored patch)
- `engine/src/dashboard/home23-settings-api.js` — new proxy routes + token bridge
- `engine/src/dashboard/server.js` — background refresh poller
- `engine/src/dashboard/home23-settings.html` — OAuth cards on Providers tab
- `engine/src/dashboard/home23-settings.js` — render + handlers
- `engine/src/dashboard/home23-settings.css` — OAuth card styles
- `docs/design/COSMO23-VENDORED-PATCHES.md` — new Patch 4 entry
- `README.md` — OAuth setup section
- `CLAUDE.md` — mention OAuth broker pattern
