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

The patches below are surgical Home23 integration fixes. Patches 1–3 are the
config/key plumbing fixes from the initial integration. Patch 4 is a small admin
HTTP surface that lets Home23 use cosmo23 as an OAuth broker (Step 18).

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
- `features.brains.directories` seeded from Home23 agents, configured external roots,
  and known local legacy roots such as `/Users/jtr/_JTR23_/cosmo-home_2.3/runs`
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

## Patch 4b — `cosmo23/engine/src/services/anthropic-oauth-engine.js` · Home23 env token lookup

**Problem:** Home23 successfully mirrors Anthropic OAuth into `config/secrets.yaml`
and injects `ANTHROPIC_AUTH_TOKEN` into `home23-cosmo23`, but the vendored
engine-side Anthropic OAuth service only checked cosmo23's standalone Prisma
OAuth database. Runs launched under Home23 inherited the env token but still
failed with:

```text
No Anthropic OAuth token configured. Use "Import from Claude CLI" or complete the OAuth flow.
```

**Fix:** `getAnthropicApiKey()` now checks `ANTHROPIC_AUTH_TOKEN` / OAuth-shaped
`ANTHROPIC_API_KEY` before the standalone database. `getOAuthStatus()` reports
env-backed credentials as configured. The DB flow remains the fallback for
standalone COSMO.

```js
// HOME23 PATCH
const envCredentials = getEnvCredentials();
if (envCredentials) return envCredentials;
```

**Effect under Home23:** launched COSMO23 engine subprocesses can use the
PM2-injected OAuth token directly.

**Effect under standalone COSMO:** unchanged unless the user explicitly sets
Anthropic credentials in the environment.

---

## Patch 4c — Codex OAuth env bridge + generated Prisma client (2026-05-07)

**Files touched:**
- `cosmo23/engine/src/services/codex-oauth-engine.js`
- `cosmo23/engine/src/core/unified-client.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/server/index.js`
- `cli/lib/cosmo23-config.js`
- `ecosystem.config.cjs`
- `cli/lib/generate-ecosystem.js`

**Problem:** COSMO23 server-side Codex OAuth could be configured and valid, but
launched research engine agents still failed with:

```text
No Codex OAuth credentials available. Import via server OAuth flow.
```

The engine-side reader resolved `@prisma/client` from
`cosmo23/engine/node_modules`, whose generated client was only the uninitialized
stub. The server path resolved the generated COSMO root Prisma client and
reported OAuth as valid, so setup looked correct while the actual research
engine treated Codex as missing.

**Fix:** the engine Codex OAuth reader now mirrors Patch 4b's Home23 behavior:
it first checks a Home23-injected `OPENAI_CODEX_AUTH_TOKEN`, derives expiry and
account id from the JWT when available, and only falls back to the standalone
OAuth DB when env is absent or stale. The DB fallback also prefers the generated
COSMO root Prisma client before normal module resolution. Home23's PM2 ecosystem
now injects `OPENAI_CODEX_AUTH_TOKEN` from
`config/secrets.yaml.providers.openai-codex.apiKey`, points `DATABASE_URL` at
the Home23-scoped `cosmo23/.cosmo23-config/database.db`, and managed setup
status reports `openai-codex` as OAuth-configured when that env var is present.
The COSMO engine and Query Codex call sites also normalize string/query input
into Codex Responses input-item lists; the backend rejects bare string input
with `Input must be a list`. They use the lean Home23 Codex request body and
avoid public Responses-only fields such as `max_output_tokens` / `include`,
which the ChatGPT Codex backend rejects.

**Effect under Home23:** launched COSMO23 engine subprocesses can use the same
Codex OAuth token the server/dashboard already knows is configured.

**Effect under standalone COSMO:** unchanged unless the user explicitly sets
`OPENAI_CODEX_AUTH_TOKEN`; otherwise the existing database-backed OAuth flow is
still used.

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

---

## Patch 7: `runRoot` + ownership on research-run launch

**Files touched:**
- `cosmo23/launcher/run-manager.js` — `createRun(runName, options = {})` accepts
  `options.runPath`, `options.owner`, `options.topic`
- `cosmo23/server/index.js` (`ensureLocalBrainForLaunch`) — forwards
  `payload.runRoot`, `payload.owner` / `payload.agentName`, `payload.topic`
  into `createRun` options

**Problem:** `research_launch` creates runs at `cosmo23/runs/<runName>/`. From
the launching agent's perspective they vanish — agent workspace never sees
them, the feeder never ingests them, and when jtr reorganizes brains later
everything inside `cosmo23/` gets left behind. The compiled-brain workaround
(`research_compile_brain`) is manual and lossy.

**Fix:** when a Home23 agent launches a run, it supplies `runRoot` pointing
inside its own workspace (`instances/<agent>/workspace/research-runs/<runName>/`).
cosmo23 creates the run there instead of the default location, then symlinks
`cosmo23/runs/<runName>` → `runRoot` so existing cosmo23 consumers continue to
resolve by the legacy path. Each run also writes `run.json` with
`{ owner, createdAt, topic, runName }` so later tools (and the relocation
script) know who owns it.

```js
// HOME23 PATCH
async createRun(runName, options = {}) {
  const defaultPath = path.join(this.runsDir, runName);
  const runPath = options.runPath || defaultPath;
  const needsSymlink = !!options.runPath &&
    path.resolve(options.runPath) !== path.resolve(defaultPath);
  // ... mkdir at runPath ...
  if (needsSymlink) {
    try {
      await fs.mkdir(this.runsDir, { recursive: true });
      try { await fs.unlink(defaultPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.symlink(runPath, defaultPath, 'dir');
    } catch (err) {
      // symlink is non-fatal — run still exists at runPath
    }
  }
  // ... write run.json with options.owner / options.topic ...
}
```

**Effect under Home23:** research runs live inside the launching agent's
workspace; feeder ingests markdown output naturally; symlink keeps cosmo23's
CLI/dashboard working; `run.json` carries ownership for downstream tooling.

**Effect under standalone COSMO:** unchanged — callers that don't pass
`runRoot` get the legacy `cosmo23/runs/<runName>/` layout exactly as before.
The only visible difference is a new `run.json` file in each run dir, with
`owner: null` and `topic: null` by default.

**Test coverage:** `cosmo23/launcher/run-manager.test.js` — three cases:
override path + symlink + ownership record; legacy behavior preserved;
pre-existing runPath collision refusal.

---

## Patch 10 — `cosmo23/server/lib/brain-registry.js` · symlinked run discovery

**Problem:** Patch 7 intentionally leaves
`cosmo23/runs/<runName>` as a symlink to the launching agent's workspace run
directory. But `listBrains()` only accepted `Dirent.isDirectory()` entries,
so those symlink aliases were skipped. Result: a completed Home23-launched
research run could visibly exist in `cosmo23/runs/` and still be absent from
the COSMO23 Brains library.

**Fix:** when scanning a runs root, accept symlink entries whose target is a
directory. Dedupe by real path so the same run is not double-listed if both
the workspace target and the symlink alias are configured roots.

```js
// HOME23 PATCH
if (entry.isSymbolicLink()) {
  const [stat, realPath] = await Promise.all([
    fsp.stat(runPath),
    fsp.realpath(runPath)
  ]);
  if (stat.isDirectory()) {
    return { runPath, identityPath: realPath };
  }
}
```

**Effect under Home23:** new agent-owned research runs appear in COSMO23's
Brains library through their legacy `cosmo23/runs/<runName>` alias.

**Effect under standalone COSMO:** unchanged for normal directories; broken
symlinks and symlinks to files are ignored.

**Test coverage:** `cosmo23/server/lib/brains-router.test.js` includes a
symlinked local run alias and verifies `/api/brains` plus detail lookup.

---

## Patch 11 — Home23-managed COSMO23 UI defaults

**Files touched:**
- `cosmo23/public/index.html`
- `cosmo23/public/app.js`
- `cosmo23/server/config/model-catalog.js`

**Problem:** the bundled COSMO23 web UI still behaved like standalone COSMO:
the masthead said `COSMO Standalone`, launch copy referred to generic local
setup, the provider sidebar exposed model catalog / brain directory controls
even though Home23 owns those settings, Brains defaulted to `All locations`
across hundreds of external archives, and the selected brain defaulted to the
constantly modified Jerry/Forrest agent brains instead of the latest local
COSMO research run. Launch defaults also pointed at OpenAI GPT-5.2 / GPT-5 mini,
while current Home23 COSMO runs use the MiniMax + Ollama Cloud stack.

**Fix:** when `/api/setup/status` reports `managed_by_home23`, the UI now:

- labels the shell as `Home23 COSMO`
- labels the bundled local run library as `Cosmo Home23`
- defaults the Brains library to `Cosmo Home23`
- orders Local / Jerry / Forrest before external archives
- selects the newest local COSMO run by default when no run is active
- keeps the provider panel read-only and points settings changes to Home23
- removes standalone model-catalog and brain-directory controls from the
  managed provider panel
- updates query copy and uses selected brain detail counts when available
- changes built-in launch defaults to:
  - primary: `MiniMax-M2.7`
  - fast: `nemotron-3-nano:30b`
  - strategic: `kimi-k2.6`
  - query/PGS: `MiniMax-M2.7`

**Effect under Home23:** the COSMO23 app opens to the local run workspace
instead of a 293-run archive dump, Launch defaults match known-good Home23
research settings, and Query follows the selected local run with accurate
node/edge counts.

**Effect under standalone COSMO:** non-managed mode keeps the existing setup
flow; only the static masthead copy is more neutral.

**Verification:** browser audit on `http://localhost:43210` after restarting
`home23-cosmo23`: Brains defaulted to `Cosmo Home23 (5)`, selected `trail-running`
with `229 nodes / 718 edges`, Query selected `trail-running`, and Launch
selected `MiniMax-M2.7`, `Nemotron 3 Nano 30B`, `Kimi K2.6`.

---

## Patch 8 — `cosmo23/lib/query-engine.js` · `loadBrainState` sidecar rehydration

**Why:** Home23's persistence layer was updated (V8-heap fix, ~2026-04-15)
to move the full NetworkMemory graph out of `state.json.gz` into two
sidecar files at the same brainDir:

- `memory-nodes.jsonl.gz` (one JSON node per line, 29k+ records on jerry)
- `memory-edges.jsonl.gz` (one JSON edge per line, 21k+ records on jerry)

After that fix, `state.json.gz.memory.nodes` is permanently `[]` and
`state.json.gz.memory.edges` is permanently `[]` — the full graph lives
in the sidecars only. But cosmo23's query engine `loadBrainState` only
reads `state.json.gz`, so every dive-mode query against a home23 agent
reported `sources.memoryNodes = 0, edges = 0, liveJournalNodes = 0`
even when the actual brain was 29k/21k. Users saw the brain answering
their questions using thoughts alone, never consulting memory — a real
behavioral regression disguised as a metadata bug.

**What changed:** in `loadBrainState`, after decompressing `state.json.gz`,
if `state.memory.nodes` is empty and `memory-nodes.jsonl.gz` exists in
the runtimeDir, decompress + parse it and populate `state.memory.nodes`.
Same for `memory-edges.jsonl.gz`. Logs `[QueryEngine] Rehydrated brain
from sidecars: N nodes, M edges` on successful load.

**Verified live (2026-04-21) against jerry's brain:**

```
Before: sources: { memoryNodes: 0,     edges: 0,     liveJournalNodes: 0 }
After:  sources: { memoryNodes: 19589, edges: 21035, liveJournalNodes: 0 }
```

**Effect under standalone COSMO:** unchanged — standalone COSMO runs
don't have the sidecar files, so the `existsSync` check short-circuits
and the original `state.json.gz` is returned as before.

**Survives upstream resync:** yes — the patch is purely additive,
guarded by `memory.nodes.length === 0` + `existsSync` on sidecar paths.

---

## Patch 9 — `cosmo23/server/index.js` · explicit status health contract

**Why:** `/api/status` used one legacy `running` boolean for a compound truth:
`activeContext !== null && processManager has cosmo-main`. That made it easy
for Home23 to confuse four different states:

- API server reachable but idle
- launch in progress
- active launcher context with no child process
- child process running without launcher context

**What changed:** `server/lib/status-contract.js` now builds an explicit
contract used by `/api/health`, `/api/status`, and `/api/watch/logs`.
`running` is preserved as the legacy active-run boolean, while new fields expose
the separated truths:

```js
{
  health: {
    apiReachable: true,
    lifecycle: 'idle' | 'launching' | 'running' | 'context_without_process' | 'process_without_context',
    activeRun: boolean,
    processOnline: boolean,
    hasActiveContext: boolean,
    isLaunching: boolean,
    lastHeartbeat: null,
    process: { cosmoMainOnline, count, runningNames },
    run: { runName, brainId, topic, startedAt, runPath } | null,
    ports: { app, websocket, dashboard, mcpHttp }
  },
  running: health.activeRun
}
```

**Effect under Home23:** dashboard/agent callers can distinguish “COSMO server
is alive but no research is active” from “research should be active but the
child process is gone.” `research_*` tools prefer `health.activeRun` when
present and fall back to legacy `running`.

**Effect under standalone COSMO:** backward-compatible. Existing consumers that
read `running`, `activeContext`, `processStatus`, `dashboardUrl`, or `wsUrl`
continue to work.

**Test coverage:** `cosmo23/server/lib/status-contract.test.js` covers idle,
running, launching, context-without-process, and process-without-context states.

---

## Patch 12 — Home23 COSMO workspace redesign

**Files touched:**
- `cosmo23/public/index.html`
- `cosmo23/public/app.js`
- `cosmo23/public/styles.css`
- `cosmo23/public/js/brain-map.js`

**Problem:** after Patch 11 fixed the data defaults, the bundled COSMO23 UI
still looked and behaved like a bolted-on standalone app. The launch surface
competed with the old setup panel, navigation was visually flat, and the user
could not immediately tell that this was the Home23-managed COSMO workspace.

**Fix:** the public UI now uses a Home23 shell:

- COSMO23-owned left rail with every COSMO tab in one vertical workspace nav,
  plus compact Home23 links for home/settings
- masthead card with status and active profile cards
- cleaner horizontal tab navigation
- launch form promoted as the primary workflow
- managed setup panel replaced with research-at-a-glance and recent local runs
- refresh action that reloads setup, models, status, and brain library together
- responsive rules for collapsing the rail and preserving readable launch cards
- Brains, Watch, Query, Map, Intelligence, Hub, Interactive, and Ingest share
  bounded Home23 card layouts instead of unbounded standalone stacks
- Brain Map has a no-WebGL fallback so browsers without 3D context still show
  loaded graph stats without throwing renderer errors

**Effect under Home23:** the first screen now matches the Home23 workspace
model: launch on the left, local knowledge context on the right, recent runs
visible immediately, and no standalone provider setup clutter.

**Effect under standalone COSMO:** standalone mode still has the setup form
available because the right-side replacement only runs when setup status reports
`managed_by_home23`.

---

## Patch 13 — `cosmo23/engine/src/core/anthropic-client.js` · provider-aware model passthrough

**File:** `cosmo23/engine/src/core/anthropic-client.js` (`_getModelFromOptions`)

**Problem:** `AnthropicClient` is reused as the adapter for MiniMax in
`UnifiedClient` (line 76) because MiniMax exposes an Anthropic-compatible
API at `https://api.minimax.io/anthropic`. But `_getModelFromOptions` was
written assuming the caller is always Anthropic, so any model name that is
not `claude-*` and not in `modelMapping` (which only has `gpt-5.x` keys)
silently falls through to a hardcoded `'claude-sonnet-4-5'`.

When a Home23 agent picked MiniMax as Primary (e.g. `MiniMax-M2.7` in
`runs/trail-running/config.yaml`), `generateMiniMax` would pass
`{ model: 'MiniMax-M2.7' }` into the adapter, the model got rewritten to
`'claude-sonnet-4-5'`, and the request hit MiniMax's endpoint with the
wrong body — visible in logs as:

```
[AnthropicClient] Starting generation {"model":"claude-sonnet-4-5", ...}
```

…even though no Anthropic provider was selected.

**Fix:** read `this.providerId` (already set in the constructor —
`'anthropic'` for real Anthropic, `'minimax'` for the MiniMax adapter,
or any future Anthropic-compatible provider). When the providerId is
anything other than `'anthropic'`, return the requested model unchanged.
The Claude-only fallback path is preserved for the Anthropic case.

```js
// HOME23 PATCH — non-Anthropic providers (e.g. MiniMax via the
// Anthropic-compatible endpoint) reuse this client class but must NOT
// be silently rewritten to a Claude model. Pass the requested model
// through unchanged for any providerId other than 'anthropic'.
if (this.providerId && this.providerId !== 'anthropic') {
  return requestedModel;
}
```

**Effect under Home23:** MiniMax runs send the actual selected model
(e.g. `MiniMax-M2.7`) to MiniMax's endpoint instead of `claude-sonnet-4-5`.
Logs reflect the truth — no spurious Anthropic line items when no
Anthropic provider is configured.

**Effect under standalone COSMO:** unchanged — standalone always
constructs the client with `providerId: 'anthropic'` (default), so the
new branch is never taken and the original model-mapping behavior is
preserved.

**Note on `lib/anthropic-client.js`:** the QueryEngine adapter at
`cosmo23/lib/anthropic-client.js` has the same fallback, but it is only
ever instantiated as real Anthropic (`new AnthropicClient({}, console)`
in `query-engine.js:117`) and does not track `providerId`. The fallback
there is correct for that use site and is intentionally left untouched.

---

## Patch 14 — `cosmo23/engine/src/agents/execution-base-agent.js` · execution-agent completion marker

**File:** `cosmo23/engine/src/agents/execution-base-agent.js` (finalization block,
end of `runAgenticLoop`)

**Problem:** the four CLI-first execution agents (`DataPipelineAgent`,
`DataAcquisitionAgent`, `InfrastructureAgent`, `AutomationAgent`) never
write a `.complete` JSON marker into their output directory. The dashboard's
`/api/deliverables` endpoint at `engine/src/dashboard/server.js:2025-2035`
decides `isComplete` purely from the presence of that marker, so the
Intelligence → Deliverables tab shows ⚠ Incomplete for every execution
agent run.

There IS a marker-writing path in `agent-executor.js:ensureManifestAndCompletion`,
but it's only called from `registerTaskArtifactsFromAgentRun()` which
early-returns when `this.clusterStateStore` is null (`agent-executor.js:1326`).
Cluster mode is OFF by default (`cluster.enabled: false` in standalone and
in Home23-managed runs), so single-instance runs — the normal case — never
get the marker. Other agent classes (CodeCreation, CodeExecution, Document,
Research, IDE) sidestep this by calling `writeCompletionMarker` directly in
their own code; only the execution-agent layer relies on the cluster path.

First observed on Home23's `trail-running` (single-instance, cluster disabled)
where a fully-finished `DataPipelineAgent` produced 8 real artifacts including
a populated SQLite database and a working Python module, with `manifest.json`
carrying a valid `completedAt` timestamp — yet the dashboard still showed
⚠ Datapipeline · unknown · 8 files. The agent's own `validation-report.json`
also flagged a separate row-count gap, but even when validation passes the
dashboard would have shown ⚠ for the same reason.

**Fix:** in the finalization block of `ExecutionBaseAgent.runAgenticLoop`,
after `writeAuditTrail()` and `reportProgress(100, ...)`, call the inherited
`writeCompletionMarker(this._outputDir, {...})`. Wrapped in try/catch so a
write failure can never mask a successful run.

```js
// HOME23 PATCH — Write `.complete` marker so dashboard /api/deliverables
// reports isComplete:true. Without this, single-instance runs (cluster
// disabled, the default) never get a marker — agent-executor's
// ensureManifestAndCompletion only fires when clusterStateStore is set.
if (this._outputDir) {
  try {
    await this.writeCompletionMarker(this._outputDir, {
      fileCount: this.totalFilesCreated || 0,
      totalSize: this.totalBytesWritten || 0,
      commandsRun: this.totalCommandsRun || 0,
      iterations: iteration
    });
  } catch (markerErr) {
    this.logger?.warn?.('Failed to write completion marker (non-fatal)', {
      error: markerErr.message
    });
  }
}
```

**Effect under Home23:** all four execution agents now write `.complete`
on successful finalization. The Intelligence → Deliverables tab shows ✓
DONE for completed runs and the ⚠ icon now actually means *the agent
didn't reach finalization* (timeout, exception, killed mid-loop) instead
of "single-instance mode, ignore."

**Effect under standalone COSMO:** same — the bug exists in standalone
too whenever cluster mode is off (the default). Standalone benefits from
the same fix.

**Note on the "unknown" label:** the same dashboard row also displays
`manifest.language || 'unknown'`. Execution-agent manifests don't carry
a `language` field (they're not code agents), so "unknown" still appears
beside the file count. That's a UI cosmetic in `intelligence.html:2839`,
not addressed by this patch.

---

## Patch 15 — Hub merge progress + Home23 memory sidecars

**Files touched:**
- `cosmo23/server/lib/hub-routes.js`
- `cosmo23/engine/src/merge/merge-engine.js`

**Problem:** Hub merges were executed inside the COSMO23 API process, but the
merge engine only wrote terminal progress to stdout. The Hub UI opened an SSE
request, received "Initializing merge", then sat with no useful updates while
the server spent minutes in the CPU-heavy memory merge loop. During that window
even `/api/health` timed out, so the COSMO23 session looked dead. A live
Jerry/brain merge on 2026-05-01 took 6m02s and made the app appear broken even
though the merge eventually completed.

The same path also had two Home23 correctness gaps:

- Hub state loading did not rehydrate `memory-nodes.jsonl.gz` /
  `memory-edges.jsonl.gz`, so Home23 agent brains with split persistence could
  merge as empty or partial graphs.
- Parts of `merge-engine.js` coerced edge endpoints from `edge.key` through
  `Number()`, but merged brains use string node IDs such as `abc123_1`. Those
  edges could be dropped during later merges.

**Fix:** add a progress callback to `ProgressReporter`, wire Hub's SSE sender
into `MergeEngine({ onProgress })`, and yield with `setImmediate()` after each
progress batch so Express can flush SSE updates and answer health checks. Hub
state loading now rehydrates Home23 sidecar memory files before merging, and
edge endpoint parsing preserves string IDs.

**Effect under Home23:** long Hub merges now visibly progress instead of
appearing to kill COSMO23, health checks can respond during the merge, Jerry /
Forrest sidecar brains load their real memory graph, and re-merging merged
brains preserves string-ID edges.

**Effect under standalone COSMO:** progress callbacks are opt-in; standalone
callers that do not pass `onProgress` keep the original behavior. Non-sidecar
states load unchanged.

**Verification:** `node --check` passed for both touched files. A dry-run merge
smoke test verified progress events, correct stats, and string-ID edge
preservation.

---

## Patch 16 — Streaming sidecar hydration for Query/PGS

**Files touched:**
- `cosmo23/lib/memory-sidecar.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/lib/pgs-engine.js`

**Problem:** Patch 8 taught the COSMO23 query engine that Home23 brains may
store memory in `memory-nodes.jsonl.gz` / `memory-edges.jsonl.gz`, but it
implemented hydration by gunzipping the full JSONL file and calling
`.toString().split('\n')`. That reintroduced the V8 max-string failure mode
that sidecars were designed to avoid. On Jerry's live brain, the catch block
swallowed the sidecar load failure and Query/PGS continued with
`state.json.gz`'s empty inline arrays, producing `Brain loaded: 0 nodes, 0 edges`
in the Home23 main dashboard Query tab.

**Fix:** replace the all-at-once sidecar read with a streaming JSONL reader
that parses one record per line through `readline` + `zlib.createGunzip()`.
The query engine now calls `hydrateStateMemory()` and fails loudly if
`brain-snapshot.json` says a real brain exists but hydration returns zero nodes.
PGS session accounting also clamps stale `pgs-sessions/*.json` searched IDs to
the current partition set, and routing falls back to the top partition when a
real graph has no partition above the relevance threshold.
Follow-up fix in the same patch: PGS no longer parses a huge legacy
`partitions.json` before checking staleness. It writes a tiny
`partitions.meta.json` gate, reuses near-current partition caches within 2%
node/edge drift, and coalesces thousands of singleton Louvain communities into
bounded partitions by tag.

**Effect under Home23:** Home23's main dashboard Query tab, which routes to
COSMO23 `/api/brain/:id/query/stream`, sees the real live graph for Query and
PGS instead of a one-partition empty graph. Old zero-node `default` sessions no
longer display impossible negative remaining counts, cache checks return in
milliseconds instead of parsing 100MB+ JSON, and "50% coverage" no longer
collapses to one single-node partition.

**Effect under standalone COSMO:** legacy inline `state.json.gz` brains still
load unchanged; sidecar brains load without constructing one giant string.

**Verification:** focused sidecar tests pass for both COSMO23 and Evobrew, PGS
coalescing/routing regression tests pass, and a standalone
`QueryEngine('instances/jerry/brain').loadBrainState()` loaded ~47.8k nodes /
~65.2k edges from sidecars. Direct PGS partitioning on Jerry's brain produced
76 partitions in ~5.8s; cached reload returned in ~16ms.

---

## Patch 17 — Bounded quick mode for Query/agent brain_query

**Files touched:**
- `cosmo23/lib/query-engine.js`

**Problem:** the agent `brain_query` wrapper now defaults ordinary chat queries
to the dashboard's `quick` mode, but COSMO23's adaptive context builder still
expanded quick mode by target brain coverage. On Jerry's ~56k-node brain that
meant a "quick" query could still include hundreds of nodes, build a huge
context, and outlive the agent tool timeout.

**Fix:** add `QueryEngine.calculateMemoryNodeLimit()` and make `quick` / legacy
`fast` modes use fixed small caps (`50` and `100` nodes respectively), smaller
connected/thought slices, no meta-coordinator review block, and a 2.5k output
token cap. `full`, `expert`, `dive`, and other deeper modes keep the existing
adaptive coverage behavior up to each model's maximum node cap.

**Effect under Home23:** agent chat can use `brain_search` followed by
`brain_query mode=quick` without triggering a full graph-scale query. Deeper
queries and PGS remain available when the user explicitly asks for coverage.

**Effect under standalone COSMO:** the dashboard's Quick mode is now genuinely
bounded on very large brains. Full/expert/dive behavior is unchanged.

**Verification:** `tests/cosmo23/query-engine-context.test.cjs` proves quick
mode stays at 50 nodes for a 56,210-node brain while full mode still reaches
the `claude-opus-4-7` model cap of 900 nodes.

---

## Patch 18 — Claude Opus 4.7 request shape for Anthropic clients

**Files touched:**
- `cosmo23/lib/anthropic-client.js`
- `cosmo23/engine/src/core/anthropic-client.js`

**Problem:** agent chat `brain_query` defaulted back to `claude-opus-4-7` after
Quick mode was bounded, but COSMO23's Anthropic adapters still sent the legacy
`temperature` field on every Messages API call. Opus 4.7 rejects that sampling
parameter, so the live query path failed before answering even with a small
context.

The native web-search path had the same inline `temperature` field, and
reasoning requests still used the older `thinking: { type: 'enabled',
budget_tokens: ... }` shape rather than Opus 4.7's adaptive thinking shape.

**Fix:** add a greppable model guard for `claude-opus-4-7`, omit legacy sampling
params for that model in both normal generation and native web-search requests,
and map reasoning requests to:

```js
// HOME23 PATCH
requestParams.thinking = {
  type: 'adaptive',
  display: 'summarized'
};
requestParams.output_config = {
  effort: options.reasoningEffort || 'high'
};
```

Other Claude models keep the previous temperature behavior and older thinking
shape.

**Effect under Home23:** `brain_query` can use the configured strong Claude
query model without tripping Anthropic's Opus 4.7 request validation. The xAI
fallback is no longer needed for ordinary agent-chat queries.

**Effect under standalone COSMO:** Opus 4.7 requests become valid there too;
non-Opus behavior is unchanged.

**Verification:** `tests/cosmo23/anthropic-client-request.test.cjs` captures the
request bodies for both COSMO23 client copies and proves Opus 4.7 omits
`temperature`, uses adaptive thinking, and omits sampling params for native
web search while Sonnet still keeps `temperature`.

---

## Patch 18b — Anthropic visible model names vs OAuth wire models

**Files touched:**
- `cosmo23/lib/anthropic-client.js`
- `cosmo23/engine/src/core/anthropic-client.js`

**Problem:** Home23 intentionally keeps visible Anthropic catalog names such as
`claude-sonnet-4-7`, but some OAuth accounts do not have that exact wire model
available. The standalone `cosmo23/lib/anthropic-client.js` already translated
unavailable visible names to an available same-family wire model by calling
`models.list()`, but the vendored engine client did not. COSMO23 runs therefore
reached Anthropic successfully and then failed with:

```text
404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-4-7"}}
```

**Fix:** port the same `_resolveWireModel()` fallback into the engine Anthropic
client and make both client copies tolerate SDKs that expose model listing as
`models.list()`, `beta.models.list()`, or neither. Older vendored SDKs fall back
to a direct `/v1/models` request using the already loaded Anthropic credentials.
The selected/displayed model remains unchanged; only the request payload's
`model` field is replaced when the exact visible ID is not available to the
current OAuth token.

**Effect under Home23:** Anthropic runs can keep Home23's current visible model
catalog while using a valid same-family wire model for accounts that do not
serve the exact display ID.

**Effect under standalone COSMO:** engine runs get the same fallback behavior
the standalone query client already had.

**Verification:** `tests/cosmo23/anthropic-client-request.test.cjs` proves the
engine client falls back from `claude-sonnet-4-7` to an available Sonnet wire
model while preserving normal Sonnet request shape, including SDK shapes where
`models` is absent and where no SDK model-list resource exists.

---

## Patch 19 — QueryEngine MiniMax runtime routing

**Files touched:**
- `cosmo23/lib/query-engine.js`
- `cosmo23/lib/anthropic-client.js`

**Problem:** the Home23/COSMO catalog default query model is `MiniMax-M2.7`, but
the historical `QueryEngine.resolveQueryRuntime()` only had explicit branches
for Anthropic, xAI, Ollama Cloud, local models, Codex, and OpenAI. A MiniMax
model correctly inferred `providerId=minimax`, then fell through to the OpenAI
client. Agent `brain_query` exposed this because it calls the same backend route
as the Query tab but relies on catalog defaults when no model is explicitly
provided.

**Fix:** initialize a MiniMax query client with `MINIMAX_API_KEY` or the
Home23-managed COSMO config secret, using the Anthropic-compatible endpoint
`https://api.minimax.io/anthropic`; route `providerId=minimax` to that client;
and teach `cosmo23/lib/anthropic-client.js` to pass models through unchanged for
non-Anthropic compatible providers instead of mapping them to Claude.

**Effect under Home23:** dashboard/default query model `MiniMax-M2.7` now reaches
MiniMax instead of OpenAI. Agent `brain_query` can stay aligned with catalog
defaults and only force the chat-safe `quick` mode.

**Effect under standalone COSMO:** MiniMax query defaults work when the provider
is configured; missing credentials now fail clearly instead of silently routing
to OpenAI.

**Verification:** `tests/cosmo23/query-engine-runtime.test.cjs` proves
`MiniMax-M2.7` resolves to the MiniMax query client and fails clearly when that
client is absent.

---

## Patch 20 — Small-run and single-partition Query/PGS fallback

**Files touched:**
- `cosmo23/lib/pgs-engine.js`
- `cosmo23/lib/query-engine.js`

**Problem:** PGS is a large-graph coverage architecture, but COSMO23 can also
query small completed runs. When a run has only a few dozen nodes or collapses
to one partition, PGS adds latency and then asks the synthesis model for
cross-partition insight that cannot exist. The Query tab can then produce
caveats like "only one successful partition" even though the right product
behavior is a normal full query over the small run. Because PGS branches before
`executeEnhancedQuery()` scans outputs, the one-partition path also bypasses
normal run deliverables that the standard Query path would include.

**Fix:** add a direct-query fallback for small PGS brains
(`PGS_DIRECT_QUERY_MAX_NODES`, default `200`) that re-enters
`executeEnhancedQuery()` with `enablePGS: false`, preserving output-file,
follow-up, action, and provider options. For larger graphs that still collapse
to one partition, PGS now skips the cross-partition synthesis call and returns
the single sweep output directly. Full-mode progress now reports the completed
selected partitions instead of continuing to show the whole graph as remaining
after the sweep.

**Effect under Home23:** the COSMO23 Query tab remains robust on tiny research
runs and no longer turns a 24-node / 1-partition graph into slow fake
cross-partition synthesis. Large Jerry-style PGS still uses partitioned sweeps.

**Verification:** `tests/cosmo23/pgs-engine.test.cjs` covers the small-run
direct fallback, single-partition synthesis skip, failed-sweep accounting, and
full-mode session update counts.

---

## Patch 21 — Guided continuation planning guardrails

**Files touched:**
- `cosmo23/engine/src/core/guided-mode-planner.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/cluster/task-state-queue.js`

**Problem:** guided continuations can be short imperative refinements of the
same run, for example asking for a verdict over artifacts already produced in
the active run. The planner's old domain-change check used exact normalized
text, so a same-thread continuation could archive the active plan and
regenerate from scratch. If the LLM planner then failed to produce missions,
Tier 3 generated broad web-research defaults even when the run already had
local artifacts, PGS assessment, processed sources, and a concrete
synthesis/verdict request.

**Fix:** guided planning now computes a first-class planning decision before
mission generation:
- `assessThreadRelation()` compares the active/archived plan and new request
  as thread evidence, using token relationship as a fast path and semantic
  classification only for ambiguous cases. It is not based on continuation
  trigger words.
- `buildPlanningDecision()` chooses `evidenceMode` and `webPolicy`
  (`none`, `targeted`, or `broad`) from run context, local artifacts, PGS
  assessment, review gaps, explicit local/no-web constraints, and external
  evidence gaps.
- planning prompts receive the decision as mission policy, and
  `normalizePlan()` enforces it. If the planner emits a `research` /
  `web_search` mission while `webPolicy: none`, that mission is rewritten into
  an IDE/local-artifact mission rather than trusted.
- Tier 3 fallback uses local continuation defaults for local-sufficient/local
  work, targeted gap-fill missions only for named external gaps, and broad web
  discovery only for fresh topics without usable run context.
- Action queue polling now marks selected pending actions as `processing`
  before invoking long handlers so the immediate-action poller cannot re-enter
  the same plan injection while planning is still running.
- Task-state queue processing now persists processed flags back to disk and
  skips stale task events queued before the current plan was created. Without
  this, old task-update events could replay after a plan replacement and
  overwrite the corrected local continuation task files.

**Effect under Home23:** continuing an active COSMO23 run with a refinement like
"Now apply..." stays anchored to the run instead of becoming a new generic
research campaign. Fallback plans preserve the run's local evidence, target
external search only when a real source gap requires it, and route verdict /
synthesis work to local IDE missions.

**Verification:** `cosmo23/engine/tests/unit/guided-mode-planner.test.js` and
`cosmo23/engine/tests/unit/guided-mode-planner-context-detection.test.js` cover
local continuation fallback, web-mission policy rewriting, targeted external
gap fallback, and thread relation classification without continuation-cue
matching.
`cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js` covers
pre-claiming queued actions before long handlers run.
`cosmo23/engine/tests/unit/task-state-queue.test.js` covers processed-event
restart safety and stale event suppression.

---

## Patch 22 — Synthesis commit step and receipts

**Files touched:**
- `cosmo23/lib/synthesis-commit.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/lib/pgs-engine.js`
- `cosmo23/pgs-engine/src/synthesizer.js`
- `cosmo23/engine/src/agents/document-compiler-agent.js`
- `cosmo23/launcher/config-generator.js`
- `cosmo23/server/index.js`
- `cosmo23/public/index.html`
- `cosmo23/public/app.js`

**Problem:** COSMO23 synthesis reliably accumulates named candidate entities
but does not reliably commit, merge, or demote them. Dive/PGS outputs can read
as peer-level enumerations even after critic and analyst pressure, so downstream
cycles receive pretty markdown instead of a bounded verdict.

**Fix:** synthesis prompts now have an optional commit step, enabled by
default for `dive`, `pgs`, and `compile`. The block forces every named entity
into a capped primary bucket (`SPINE` by default), a demoted bucket (`FACET`),
or an unsupported/surface bucket (`ARTIFACT`), with a ranked experiment list.
The load-bearing instruction requires the verdict to deform the body of the
synthesis rather than appear as an appendix. Run launch config now emits:
`synthesis.commitStep`, `synthesis.spineCap`, `synthesis.bucketNames`, and
`synthesis.modeOverrides`, with compact Advanced Run Settings controls for
commit enablement and spine cap.

The prompt/receipt layer is intentionally the full scope of this patch. It
does not change critic loops, graph storage, partitioning, traversal, or brain
node schemas. Query/PGS APIs accept an optional `synthesis` override, and
synthesis results include `metadata.synthesis_commit`. A run-local
`synthesis-commit-receipts.jsonl` records query, mode, model, answer hash, and
parsed bucket counts for later receipt analysis. Compile/document synthesis
gets the same commit pressure while preserving the enterprise-package JSON
envelope.

**Verification:** `node --test --test-concurrency=1
tests/cosmo23/synthesis-commit.test.cjs tests/cosmo23/pgs-engine.test.cjs
tests/cosmo23/query-engine-context.test.cjs
tests/cosmo23/query-engine-runtime.test.cjs
tests/cosmo23/anthropic-client-request.test.cjs
tests/cosmo23/synthesis-config-generator.test.cjs` covers helper defaults,
prompt interpolation, parser extraction, PGS metadata/receipts, direct dive
prompt on/off behavior, and launch YAML serialization. Syntax checks passed
for the patched query, PGS, server, config-generator, standalone synthesizer,
document compiler, and helper files.
Live smoke against `labor23` after restarting only `home23-cosmo23`: enabled
`dive` query returned `applied: true`, `spine_count: 2`, `facet_count: 3`,
`artifact_count: 4`, and five ranked experiments; disabled `dive` query
returned `applied: false` with `reason: commitStep disabled`.

---

## Patch 23 — Graph-native artifact loop substrate

**Files touched:**
- `cosmo23/engine/src/artifacts/artifact-registry.js`
- `cosmo23/engine/src/artifacts/artifact-ingestor.js`
- `cosmo23/engine/src/artifacts/artifact-audit.js`
- `cosmo23/engine/src/artifacts/artifact-migration.js`
- `cosmo23/engine/src/artifacts/artifact-lifecycle.js`
- `cosmo23/engine/src/artifacts/artifact-loop-verifier.js`
- `cosmo23/engine/scripts/artifact-loop.js`
- `cosmo23/engine/src/agents/agent-executor.js`
- `cosmo23/engine/src/core/capabilities.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/engine/src/dashboard/query-engine.js`
- `cosmo23/engine/src/cluster/task-state-queue.js`
- `cosmo23/engine/src/cluster/cluster-state-store.js`
- `cosmo23/engine/src/cluster/backends/filesystem-state-store.js`
- `cosmo23/engine/src/cluster/backends/redis-state-store.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/memory/network-memory.js`
- `tests/cosmo23/artifact-loop.test.cjs`
- `docs/design/STEP25-COSMO23-GRAPH-NATIVE-ARTIFACT-LOOP-PLAN.md`
- `docs/design/STEP25-COSMO23-ARTIFACT-LOOP-CODE-MAP.md`

**Problem:** COSMO23 produces valuable files and has a strong memory graph, but
the output layer is too lossy. Runs could complete with artifact counts while
final task records had no durable artifact IDs. IDE agents could write the real
product files into root outputs while task artifact registration only saw
per-agent manifests or logs. Introspection and memory could preserve semantic
previews without preserving artifact identity, path, hash, producer, task
binding, lifecycle, or future reuse obligation.

**Fix:** added the first graph-native artifact substrate. Durable output files
now register through an artifact registry at `coordinator/artifact_registry.json`
with stable `artifactId`, run/task/goal/producer binding, path, hash, kind,
lifecycle state, and missing-binding warnings. The registry exposes direct
lookup APIs by artifact ID, path, hash, task ID, producer, lifecycle state, and
topic-scored reusable artifact selection. Agent task artifact registration now
includes IDE `modifiedFiles`, writes registry records, records parse status,
and stores produced artifact IDs back onto tasks. Task completion now accepts
and persists consumed/produced artifact closure lists instead of reducing
completion to an artifact count. Predecessor artifact gathering loads task
artifact lineage before falling back to memory tag scraping, and mission
enrichment now attaches a lineage packet so future agents inherit required
artifacts before broad semantic memory. When direct predecessor artifacts are
absent, mission enrichment also selects current reusable artifact substrate
from the registry by mission topic, preferring committed, reused, and parsed
records while excluding superseded/deprecated records. When a task produces
new artifacts after receiving required lineage artifacts, the consumed
artifacts receive causal reuse lifecycle credit.
Capabilities writes now register durable `/outputs/` files at write time when
the artifact loop is available, giving common agent writers artifact IDs before
the end-of-run result sweep. Capabilities also enforces read-before-write when
a lineage packet declares required artifacts: durable writes are blocked unless
the agent declares those required artifacts consumed or explicitly ignored.
Standalone and dashboard Query exports/query-created files also register with
the artifact loop, so Query markdown/JSON/HTML exports are no longer invisible
to audit.
Artifact context is injected into the mission description once during mission
enrichment, so agent types that read `mission.description` directly still
receive lineage-first predecessor artifacts.

The memory graph now accepts node metadata and has explicit artifact edge types
such as `TASK_PRODUCED`, `AGENT_PRODUCED`, `ARTIFACT_DERIVED_FROM`, and
supersession/invalidation edge names for follow-on lifecycle work. Deterministic
structured ingestion covers `findings.jsonl`, `research_findings.json`,
`research_summary.md`, `sources.json`, and `bibliography.bib`; extracted claims
now receive deterministic claim IDs and `ARTIFACT_SUPPORTS` graph edges. The
audit helper reports unregistered output files, orphan artifacts, parsed and
unparsed artifacts, committed and reused artifacts, current artifacts,
superseded artifacts, never-reused artifacts, and completed tasks that still
have no produced artifact IDs.
The migration helper registers existing run outputs without inventing task
lineage. It can bind historical completed tasks back to artifacts only when
the task itself declared the exact expected output path, preserving uncertainty
while repairing explicit task-output contracts.
The verifier helper exercises the full intended loop in a fresh isolated run:
create, register, parse, select as lineage, enforce read-before-write, reuse,
promote, audit, and prove a `TASK_CONSUMED` graph edge.
The lifecycle manager records explicit transitions, marks later causal reuse,
and writes supersession state/edges so older artifacts stop loading as current.
When a reused artifact is consumed by a task, the graph records `TASK_CONSUMED`
from that task to the artifact. Promotion to `committed` is gated: an artifact
must have causal reuse or validation evidence unless an operator explicitly
forces the promotion. Agent integration now applies that gate automatically for
validated primary/deliverable-style produced artifacts, using the existing QA
decision as validation evidence.

**Verification:** `node --test --test-concurrency=1
tests/cosmo23/artifact-loop.test.cjs tests/cosmo23/pgs-engine.test.cjs
tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs
tests/cosmo23/anthropic-client-request.test.cjs` passed with 45 tests. Syntax checks passed
for the new artifact modules plus the modified agent executor, task queue,
filesystem/Redis state stores, orchestrator, and memory graph. `labor23`
migration registered 230/230 durable output/export files with 0 failures and
the follow-up audit reported 0 unregistered files. Exact declared-output
binding repaired 2 historical task-artifact closures; 4 completed historical
tasks remain unbound because their declared outputs are not present at the
declared paths. `node cosmo23/engine/scripts/artifact-loop.js verify` passed
and wrote `artifact_loop_verification_report.json` for its isolated verification
run. The stable operator entrypoint is `node cosmo23/engine/scripts/artifact-loop.js audit|migrate|verify
<run-dir>`.

---

## Patch 24 — Run commitment governor and spawn discipline

**Files touched:**
- `cosmo23/engine/src/core/run-commitment-governor.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/core/unified-client.js`
- `cosmo23/engine/src/agents/agent-executor.js`
- `cosmo23/launcher/config-generator.js`
- `cosmo23/engine/tests/unit/run-commitment-governor.test.js`
- `cosmo23/engine/tests/unit/unified-client-provider-errors.test.js`
- `cosmo23/engine/tests/unit/agent-executor-guided.test.js`
- `cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js`
- `tests/cosmo23/artifact-loop.test.cjs`
- `tests/cosmo23/synthesis-config-generator.test.cjs`

**Problem:** Guided COSMO23 runs could complete planned artifact tasks and then
continue spawning mostly generic IDE/artifact producers. Strategic and urgent
goal paths bypassed concurrency limits, provider 429s remained local generation
errors instead of run-level cooldown signals, and artifact-rich runs could
remain commitment-poor with zero committed artifacts.

**Fix:** a run-level commitment governor now evaluates provider health,
artifact commitment state, synthesis commit receipts, active agents, active
goals, and guided-run status before allowing more spawns. Strategic and urgent
bypasses require explicit governor approval and are capped to one spawn per
cycle by default. IDE-first routing preserves differentiated synthesis,
document, validation, completion, and execution roles when commitment pressure
is active. Repeated 429/rate-limit errors open a cooldown circuit. Accepted
guided deliverables can be promoted to committed artifacts with validation
evidence, so graph knowledge can become a durable artifact commitment instead
of another loose output.

**Receipts:** orchestrator decisions append to
`commitment-governor-receipts.jsonl` in the active run directory. Provider
errors are captured through `UnifiedClient` provider-error notifications and
normalized by `RunCommitmentGovernor.normalizeProviderError()`.

**Verification:** focused tests cover provider rate-limit gating, artifact
commitment gating, strategic spawn budgets, guided non-repair bypass refusal,
completion stop decisions, provider-error notification plumbing, IDE-first role
preservation, strategic bypass refusal, orchestrator spawn-gate closure, launch
YAML serialization, and acceptance-based artifact promotion. Full regression
coverage for this patch should include:
`npx mocha cosmo23/engine/tests/unit/run-commitment-governor.test.js
cosmo23/engine/tests/unit/unified-client-provider-errors.test.js
cosmo23/engine/tests/unit/agent-executor-guided.test.js
cosmo23/engine/tests/unit/orchestrator-guided-continuation.test.js` and
`node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs
tests/cosmo23/synthesis-commit.test.cjs tests/cosmo23/pgs-engine.test.cjs
tests/cosmo23/query-engine-context.test.cjs
tests/cosmo23/query-engine-runtime.test.cjs
tests/cosmo23/anthropic-client-request.test.cjs
tests/cosmo23/synthesis-config-generator.test.cjs`.

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
- **2026-05-01** — `cli/lib/cosmo23-config.js` and
  `cli/lib/evobrew-config.js` now include the sibling legacy
  `/Users/jtr/_JTR23_/cosmo-home_2.3/runs` root when present, so live
  `cosmo23-jtr` brains appear alongside older `cosmo-home` roots.
- **2026-04-19** — Patch 7 added to relocate research runs into the launching
  agent's workspace so the feeder ingests output naturally. Adds optional
  `runRoot` payload field + non-fatal symlink at legacy path + `run.json`
  ownership record.
- **2026-04-21** — Patch 8 added when jerry's dive-mode queries kept
  reporting `Memory Nodes: 0 / Edges: 0` despite a 29k-node brain. Root
  cause was the persistence split from 2026-04-15 that moved nodes/edges
  to sidecar files `memory-nodes.jsonl.gz` + `memory-edges.jsonl.gz`,
  which the query engine never learned to read. The "brain doesn't look
  at files" pathology Jerry self-diagnosed on 2026-04-21 was literally
  this reporting bug — the graph was there the whole time.
- **2026-04-24** — Patch 9 added to split COSMO status truth into an explicit
  health contract while preserving the legacy `running` boolean.
- **2026-04-27** — Patch 10 added so the Brains library follows Patch 7's
  symlink aliases in `cosmo23/runs/`. Without this, runs were present on disk
  but invisible in COSMO23.
- **2026-04-27** — Patch 11 added after browser-auditing the bundled COSMO23
  app. Home23-managed mode now defaults to local runs, selects the latest local
  COSMO run, hides standalone setup controls, and uses the Home23 run model
  defaults (`MiniMax-M2.7`, `nemotron-3-nano:30b`, `kimi-k2.6`).
- **2026-04-27** — Patch 12 added to redesign the Home23-managed COSMO23 UI
  around the Home23 shell, launch-first workflow, research-at-a-glance panel,
  and visible recent local runs.
- **2026-04-27** — Patch 13 added after a `trail-running` MiniMax run logged
  `[AnthropicClient] Starting generation {"model":"claude-sonnet-4-5", ...}`
  despite no Anthropic provider being selected. Root cause was a
  hardcoded `'claude-sonnet-4-5'` fallback in `_getModelFromOptions` that
  fired whenever the AnthropicClient adapter was reused for a non-Anthropic
  provider (MiniMax). Fix is provider-aware: pass the model through
  unchanged when `providerId !== 'anthropic'`.
- **2026-04-27** — Patch 14 added after the same `trail-running` run showed
  ⚠ Incomplete on the dashboard's Deliverables tab for a DataPipelineAgent
  that had clearly finished — 8 artifacts on disk, populated SQLite,
  manifest with `completedAt`. Root cause: the `.complete` marker that
  the dashboard checks is only written via a code path gated on
  `clusterStateStore` being set, which it isn't in single-instance mode
  (the default). The four execution agents (DataPipeline, DataAcquisition,
  Infrastructure, Automation) had no fallback — unlike CodeCreation /
  CodeExecution / Document / Research / IDE which write the marker
  themselves. Fix: write the marker from `ExecutionBaseAgent`'s
  finalization block so all four agents inherit the behavior.
- **2026-05-01** — Patch 15 added after Hub merge made COSMO23 appear dead:
  SSE only emitted the initial phase, the CPU-heavy merge loop monopolized the
  API server for 6m02s, and `/api/health` timed out during the merge. Hub now
  receives real progress events, the merge loop yields between batches, Home23
  memory sidecars are rehydrated before merge, and string-ID edges survive
  re-merges.
- **2026-05-01** — Patch 16 added after Home23's main dashboard Query tab
  still showed `Brain loaded: 0 nodes, 0 edges` for PGS. Root cause was the
  older query sidecar patch reading the entire gzipped JSONL sidecar into one
  V8 string, failing on live brain size, swallowing the error, and continuing
  with empty inline state. Query/PGS sidecar hydration now streams records; PGS
  also clamps stale session counts, avoids zero-partition routes on real
  graphs, skips giant stale cache parsing, and coalesces singleton-heavy
  partition output into usable bounded partitions.
- **2026-05-03** — Patch 17 added after agent chat `brain_query` timed out even
  in `quick` mode. Root cause was adaptive coverage turning quick mode into a
  large-context query on Jerry's 56k-node graph. Quick/fast are now fixed-cap;
  deeper modes keep adaptive coverage.
- **2026-05-03** — Patch 18 added after bounded Quick mode exposed the next live
  failure: `claude-opus-4-7` rejects `temperature`. COSMO23's Anthropic clients
  now omit deprecated sampling params for Opus 4.7 and use adaptive thinking.
- **2026-05-03** — Patch 19 added after agent `brain_query` revealed that the
  current catalog query default, `MiniMax-M2.7`, was inferred as provider
  `minimax` but routed through the OpenAI client. QueryEngine now has a real
  MiniMax Anthropic-compatible query client.
- **2026-05-07** — Patch 20 added after a 24-node COSMO23 research run routed
  through PGS, loaded one cached partition, and produced one-partition
  synthesis caveats. Small runs now use the direct Query path; larger
  one-partition PGS skips cross-partition synthesis.
- **2026-05-07** — Patch 21 added after a same-run "Now Apply..." continuation
  was misread as a fresh web-research domain. Guided planning now makes an
  explicit thread/evidence/web-policy decision, enforces it during mission
  normalization, and keeps continuation fallbacks local unless a targeted
  external evidence gap requires search. Task-state queue replay is also
  hardened so stale task events cannot overwrite replacement plans.
- **2026-05-07** — Patch 22 added after cross-run synthesis comparison showed
  dive/PGS enumeration growth without commitment. Synthesis prompts now include
  configurable SPINE/FACET/ARTIFACT commitment pressure and run-local receipts
  record parsed bucket counts without altering graph storage.
- **2026-05-10** — Patch 23 added from the Step 25 graph-native artifact loop
  blueprint. COSMO23 now has the first durable artifact registry, task closure
  artifact IDs, structured ingestion, lineage-first mission packets, and audit
  primitives.
- **2026-05-14** — Patch 24 added after a 40-cycle CrossFit-health run exposed
  horizontal artifact-agent churn, strategic spawn bypass, provider 429
  continuation, and zero committed artifacts despite a useful graph.
