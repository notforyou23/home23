# COSMO 2.3 — Home23 Vendored Patches

This document tracks **surgical patches** applied to the bundled `cosmo23/` source
in the Home23 repo. These fix structural integration bugs that surface only when
cosmo23 runs as an embedded sub-system instead of standalone.

**Note:** cosmo23 is now fully bundled — it updates with `home23 update`, not separately.
These patches are tracked here for reference when pulling upstream changes into the bundle.

All patches are marked in-source with a `HOME23 PATCH` comment for greppability:

```bash
grep -rn 'HOME23 PATCH' cosmo23/
```

---

## Why these patches exist

Standalone COSMO 2.3 assumes:

1. Its config lives at `~/.cosmo2.3/config.json` (a single hardcoded path).
2. A human runs its web setup wizard to enter API keys.
3. Secrets are encrypted at rest and decrypted on demand.

Home23 bundles cosmo23 and needs:

1. Config at `cosmo23/.cosmo23-config/config.json` (scoped to the repo, gitignored).
2. No setup wizard — API keys come from `config/secrets.yaml` via PM2 env vars.
3. No encryption dance — PM2 injection IS the secret store.

Without the patches, reads go to `cosmo23/.cosmo23-config/` while writes go to
`~/.cosmo2.3/`, the two silently diverge, and any call through `saveConfig()`
corrupts runtime state with encrypted strings that later get shipped as literal
bearer tokens. First observed as `401 unauthorized: encrypted:...` errors during
smoke testing (2026-04-10).

There are currently **4 patches** in this file. Patches 1–3 are the config/key
plumbing fixes from the initial integration. Patch 4 is a small admin HTTP
surface that lets Home23 use cosmo23 as an OAuth broker (Step 18).

---

## Patch 1 — `cosmo23/lib/config-manager.js`

**Problem:** `getConfigDir()` hardcoded `path.join(os.homedir(), '.cosmo2.3')`,
ignoring `COSMO23_CONFIG_DIR`. Meanwhile `lib/config-loader-sync.js` already
honored the env var. Reads and writes pointed at different directories.

**Fix:** honor `COSMO23_CONFIG_DIR` (and fall back to `COSMO23_CONFIG_PATH`'s
parent). Preserves legacy behavior for standalone installs.

```js
// BEFORE
function getConfigDir() {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

// AFTER — HOME23 PATCH
function getConfigDir() {
  if (process.env.COSMO23_CONFIG_DIR) {
    return process.env.COSMO23_CONFIG_DIR;
  }
  if (process.env.COSMO23_CONFIG_PATH) {
    return path.dirname(process.env.COSMO23_CONFIG_PATH);
  }
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}
```

**Effect under Home23:** `saveConfig()` now writes to
`cosmo23/.cosmo23-config/config.json` (same file `loadConfigSafe()` reads).
Effect under standalone: unchanged (both env vars are absent, falls back to
`~/.cosmo2.3/`).

---

## Patch 2 — `cosmo23/server/index.js` · `serializeLaunchSettings`

**Problem:** Per-run `config.yaml` embeds the `ollama-cloud` API key via string
interpolation. The serializer pulled the value from `setupConfig.providers['ollama-cloud'].api_key`
**without checking** whether the string was plaintext or still encrypted. If the
config file stored `"encrypted:...:..."`, that exact string ended up in
`apiKey: "..."` in the run's config.yaml, and the engine subprocess sent it
verbatim as a bearer token → 401.

**Fix:** new helper `resolveProviderKey()` that (a) prefers `process.env`,
(b) accepts stored config only when plaintext, (c) returns empty string
otherwise so the engine falls back to its own env var path.

```js
// HOME23 PATCH — added before serializeLaunchSettings
function resolveProviderKey(providerId, setupConfig, envName) {
  const envValue = process.env[envName];
  if (envValue && String(envValue).trim()) return String(envValue).trim();
  const stored = setupConfig?.providers?.[providerId]?.api_key;
  if (typeof stored === 'string' && stored && !stored.startsWith('encrypted:')) {
    return stored;
  }
  return '';
}

// In serializeLaunchSettings, the ollama_cloud_api_key line becomes:
ollama_cloud_api_key: resolveProviderKey('ollama-cloud', setupConfig, 'OLLAMA_CLOUD_API_KEY'),
```

**Why only ollama-cloud:** it's the only provider whose key is literally
interpolated into the per-run yaml by `launcher/config-generator.js`. OpenAI,
xAI, and Anthropic keys reach the engine purely via env vars and are already
safe. If a future upstream starts embedding more keys in yaml, extend this
pattern to cover them.

---

## Patch 3 — `cosmo23/server/index.js` · `/api/setup/bootstrap` env writes

**Problem:** the bootstrap endpoint unconditionally copied stored key values
back into `process.env`:

```js
process.env.OPENAI_API_KEY = nextConfig.providers.openai.api_key || '';
```

If `saveConfig()` just encrypted those values, this line overwrote good
PM2-injected plaintext env vars with encrypted junk. Any subsequent launch
would inherit the broken env.

**Fix:** `safeAssignEnv()` helper that only writes if the value is plaintext.

```js
// HOME23 PATCH
const safeAssignEnv = (key, value) => {
  if (typeof value === 'string' && value && !value.startsWith('encrypted:')) {
    process.env[key] = value;
  }
};
safeAssignEnv('OPENAI_API_KEY', nextConfig.providers.openai.api_key);
safeAssignEnv('XAI_API_KEY', nextConfig.providers.xai.api_key);
safeAssignEnv('OLLAMA_CLOUD_API_KEY', nextConfig.providers['ollama-cloud']?.api_key);
```

---

## Non-patches — lives in Home23 code (not in `cosmo23/`)

These are not patches to vendored code but are part of the same integration
contract and must stay in sync:

### `cli/lib/cosmo23-config.js` (seeder)

Runs at first `pm2 start` via `cli/lib/pm2-commands.js`. Writes
`cosmo23/.cosmo23-config/config.json` with:

- Plaintext API keys from `config/secrets.yaml` (dir is gitignored so this is safe)
- All five relevant providers: openai, xai, ollama-cloud, anthropic (OAuth-only flag), ollama (local)
- `features.brains = { enabled: true, directories: [] }` — never inherit stale dirs
- A persistent `security.encryption_key` (generated once, preserved on re-seed)

### `ecosystem.config.cjs` (PM2 launcher)

- Sets `COSMO23_CONFIG_DIR=cosmo23/.cosmo23-config/` so both reads and writes
  resolve there (once Patch 1 is applied).
- Injects `OPENAI_API_KEY`, `XAI_API_KEY`, `OLLAMA_CLOUD_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` into the `home23-cosmo23` process env from
  `secrets.yaml`. These are the **authoritative** key source at runtime —
  cosmo23's config file entries exist only so the Web UI setup checker
  reports providers as "configured".

### `.gitignore`

`cosmo23/.cosmo23-config/` is already fully excluded. Do **not** commit any
file from this directory; it always contains plaintext keys (by design — the
dir itself is the secret boundary).

---

## Smoke test — verifying the patches

End-to-end proof the integration is healthy. Run this after any cosmo23 update:

```bash
# 1. Stop cosmo23, delete stale config, reseed, restart
pm2 stop home23-cosmo23
rm -f cosmo23/.cosmo23-config/config.json
node -e "import('./cli/lib/cosmo23-config.js').then(m => m.seedCosmo23Config('.'))"
pm2 start ecosystem.config.cjs --only home23-cosmo23

# 2. Verify cosmo23 reads the seeded file
curl -s http://localhost:43210/api/setup/status | python3 -m json.tool | grep configDir
# → should show  "configDir": ".../cosmo23/.cosmo23-config"

# 3. Launch a tiny run (5 cycles, openai/gpt-5.2)
curl -s -X POST http://localhost:43210/api/launch \
  -H 'content-type: application/json' \
  -d '{
    "topic": "brief overview of cosine similarity for semantic search",
    "explorationMode": "guided",
    "cycles": 5,
    "maxConcurrent": 6,
    "primaryModel": "gpt-5.2",   "primaryProvider": "openai",
    "fastModel": "gpt-5-mini",   "fastProvider": "openai",
    "strategicModel": "gpt-5.2", "strategicProvider": "openai"
  }'

# 4. Wait ~10 minutes. Expected final state (via /api/watch/logs):
#    - zero '401' / 'unauthorized' / 'encrypted:' in log messages
#    - 'Cycle completed' lines for cycles 1..5
#    - '✅ System stopped successfully' + 'Process exited (code: 0)'
#    - runs/<name>/state.json.gz exists (~150-300KB)
#    - runs/<name>/coordinator/ has review markdown files
```

If `/api/watch/logs` shows `encrypted:` anywhere, Patch 1 or 3 regressed.
If it shows `401 unauthorized` on ollama-cloud specifically, Patch 2 regressed.

---

## Patch 4 — `cosmo23/server/index.js` · raw-token admin endpoints

**Problem:** Home23's Settings UI needs to mirror the current decrypted
OAuth access token into `config/secrets.yaml` so it flows to the engine
and harness via PM2 env injection. cosmo23 exposes OAuth `status`
(configured, valid, expiresAt) but not the raw token itself. Adding the
decrypt path to Home23 would duplicate ~300 lines of cosmo23's Prisma +
AES-256-GCM stack.

**Fix:** two new read-only admin HTTP routes that return the current
access token by delegating to the existing `getAnthropicApiKey()` /
`getCodexCredentials()` functions (which already handle refresh-if-expired
internally). Home23's dashboard fetches these endpoints after an OAuth
import/callback and writes the result into `secrets.yaml`.

Import addition (near line 41):

```js
const {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  storeToken,
  clearToken,
  getOAuthStatus,
  importFromClaudeCLI,
  getAnthropicApiKey  // HOME23 PATCH — for /api/oauth/anthropic/raw-token
} = require('./services/anthropic-oauth');
```

Endpoints added after the existing `/api/oauth/anthropic/logout` and
`/api/oauth/openai-codex/logout` routes:

```js
// HOME23 PATCH — expose current decrypted access token so Home23 can mirror
// it into config/secrets.yaml for PM2 env injection. Localhost-only (Express
// default binding); any local process that can reach :43210 already has
// filesystem access to the same Prisma DB, so this does not lower the
// security surface. Returns 404 when no credentials are configured.
app.get('/api/oauth/anthropic/raw-token', async (_req, res) => {
  try {
    const creds = await getAnthropicApiKey();
    if (!creds || !creds.authToken) {
      return res.status(404).json({ ok: false, error: 'not configured' });
    }
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

// HOME23 PATCH — Codex equivalent
app.get('/api/oauth/openai-codex/raw-token', async (_req, res) => {
  if (!codexOAuth) {
    return res.status(404).json({ ok: false, error: 'Codex OAuth service not available' });
  }
  try {
    const creds = await codexOAuth.getCodexCredentials();
    if (!creds || !creds.accessToken) {
      return res.status(404).json({ ok: false, error: 'not configured' });
    }
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

**Security note:** These routes do NOT require an auth header. They are
localhost-only (Express default bind) and any local process that can reach
:43210 already has filesystem access to the same Prisma DB holding the
encrypted tokens. Adding a shared secret would be theater — it would not
raise the bar.

**Effect under Home23:** `engine/src/dashboard/home23-settings-api.js`
fetches these endpoints in `syncOAuthTokenToSecrets()` after every
OAuth import/callback, and `engine/src/dashboard/server.js` polls them
every 30 minutes in the background refresh poller to catch token rotations.

**Effect under standalone COSMO:** unchanged — nothing else calls them.

---

### Patch 5: HOME23_MANAGED Provider Suppression (2026-04-13)

**File:** `server/index.js`
**Location:** `/api/setup/status` endpoint (~line 734)

When `HOME23_MANAGED=true` env var is set, the setup status endpoint reports
all env-var-configured providers as ready. This prevents cosmo23's own setup
UI from showing provider configuration when running under Home23.

**Verification after update:**
```bash
curl -s http://localhost:43210/api/setup/status | python3 -m json.tool | grep managed
# Expected: "managed_by_home23": true
```

**Effect under standalone COSMO:** unchanged — env var is never set outside Home23.

---

## Patch 6 — `cosmo23/server/lib/brain-registry.js` · `listBrains`

**Problem:** `listBrains()` enumerates direct children of every configured
root and calls `inspectBrain()` on each, unconditionally adding the result to
the returned list. When Home23 passes `instances/<agent>` as a root so cosmo23
can see agent brains, every sibling of `brain/` (like `workspace/`,
`conversations/`, `logs/`, `scripts/`, `projects/`) is also surfaced as an
empty "brain" with `hasState: false`, polluting the picker.

**Fix:** skip entries where `brain.hasState === false`. The field is already
returned by `inspectBrain()`; we just act on it.

```js
// HOME23 PATCH
if (!brain.hasState) {
  continue;
}
```

**Effect under Home23:** agent picker shows one entry per agent (the real
`brain/`) instead of six. Reference runs directories still surface all their
brains since those dirs do contain state files.

**Effect under standalone COSMO:** unchanged — standalone roots contain only
real run dirs, so no entries were being filtered anyway.

---

## History

- **2026-04-10** — initial patches applied during COSMO 2.3 integration smoke test.
  Root-caused via log of a failed 5-cycle run that returned
  `401 Incorrect API key provided: encrypted:6094a213b3...`.
- **2026-04-10** — Patch 4 added during Step 18 (OAuth in Settings UI).
  Home23 now uses cosmo23 as an OAuth broker; the raw-token endpoints
  are how the two systems stay in sync.
- **2026-04-13** — Patch 5 added during Step 21 (Provider Authority).
  Suppresses cosmo23 setup UI when running under Home23.
- **2026-04-16** — Patch 6 added when the cosmo23 brain picker was expanded
  to parity with evobrew (all agent + external roots). Without the filter,
  each agent root surfaced sibling dirs (workspace, conversations, logs) as
  empty brains.
