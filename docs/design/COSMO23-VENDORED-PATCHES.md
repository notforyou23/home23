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
  - primary: `MiniMax-M3`
  - fast: `nemotron-3-nano:30b`
  - strategic: `kimi-k2.6`
  - query/PGS: `MiniMax-M3`

**Effect under Home23:** the COSMO23 app opens to the local run workspace
instead of a 293-run archive dump, Launch defaults match known-good Home23
research settings, and Query follows the selected local run with accurate
node/edge counts.

**Effect under standalone COSMO:** non-managed mode keeps the existing setup
flow; only the static masthead copy is more neutral.

**Verification:** browser audit on `http://localhost:43210` after restarting
`home23-cosmo23`: Brains defaulted to `Cosmo Home23 (5)`, selected `trail-running`
with `229 nodes / 718 edges`, Query selected `trail-running`, and Launch
selected `MiniMax-M3`, `Nemotron 3 Nano 30B`, `Kimi K2.6`.

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

When a Home23 agent picked MiniMax as Primary (e.g. `MiniMax-M3` in
`runs/trail-running/config.yaml`), `generateMiniMax` would pass
`{ model: 'MiniMax-M3' }` into the adapter, the model got rewritten to
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
(e.g. `MiniMax-M3`) to MiniMax's endpoint instead of `claude-sonnet-4-5`.
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
the `claude-opus-4-8` model cap of 900 nodes.

---

## Patch 18 — Claude Opus 4.8 request shape for Anthropic clients

**Files touched:**
- `cosmo23/lib/anthropic-client.js`
- `cosmo23/engine/src/core/anthropic-client.js`

**Problem:** agent chat `brain_query` defaulted back to `claude-opus-4-8` after
Quick mode was bounded, but COSMO23's Anthropic adapters still sent the legacy
`temperature` field on every Messages API call. Opus 4.8 rejects that sampling
parameter, so the live query path failed before answering even with a small
context.

The native web-search path had the same inline `temperature` field, and
reasoning requests still used the older `thinking: { type: 'enabled',
budget_tokens: ... }` shape rather than Opus 4.8's adaptive thinking shape.

**Fix:** add a greppable model guard for `claude-opus-4-8`, omit legacy sampling
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
query model without tripping Anthropic's Opus 4.8 request validation. The xAI
fallback is no longer needed for ordinary agent-chat queries.

**Effect under standalone COSMO:** Opus 4.8 requests become valid there too;
non-Opus behavior is unchanged.

**Verification:** `tests/cosmo23/anthropic-client-request.test.cjs` captures the
request bodies for both COSMO23 client copies and proves Opus 4.8 omits
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
- `tests/cosmo23/query-engine-provider-routing.test.cjs`

**Problem:** the Home23/COSMO catalog default query model is `MiniMax-M3`, but
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

**Effect under Home23:** dashboard/default query model `MiniMax-M3` now reaches
MiniMax instead of OpenAI. Agent `brain_query` can stay aligned with catalog
defaults and only force the chat-safe `quick` mode.

**Effect under standalone COSMO:** MiniMax query defaults work when the provider
is configured; missing credentials now fail clearly instead of silently routing
to OpenAI.

**Verification:** after provisioning the declared standalone dependencies with
`npm --prefix cosmo23 ci`, `npm run test:brain-provider-task1` includes
`tests/cosmo23/query-engine-provider-routing.test.cjs`, which proves
`MiniMax-M3` resolves to the MiniMax query client and fails clearly when that
client is absent. The required aggregate also preserves the Codex input-item
regression.

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

## Patch 25 — Query depth restoration for current model families

**Files touched:**
- `cosmo23/lib/query-engine.js`
- `tests/cosmo23/query-engine-context.test.cjs`

**Problem:** the dashboard Query tab kept the newer PGS/provider/model surface,
but the effective answer contract drifted away from the original deep-query
behavior. The `full` UI mode was labeled comprehensive while using the lighter
standard prompt, medium reasoning, and a smaller output budget. New visible
Anthropic model IDs also received hard low node caps (`claude-opus-4-8` at 900
nodes, `claude-sonnet-4-7` at 800 nodes), far below the older Opus/Sonnet
query profiles. Current OpenAI and xAI model IDs not listed exactly could fall
through to generic defaults instead of inheriting their family profile.

**Fix:** `full` mode is again the dashboard successor to the original `deep`
query contract: it uses the complete deep-access prompt, high reasoning, high
verbosity, and the 25k-token output budget. Query context sizing now resolves
model capacity through exact IDs plus family fallback rules for GPT-5, Claude
4 Opus/Sonnet/Haiku, and Grok 4 families, so catalog refreshes do not silently
downgrade depth. Claude 4 family caps now match the established family profiles
instead of the temporary safety caps.

PGS behavior is unchanged: small-run direct fallback, provider/model selection,
and PGS sweep/synthesis options remain intact.

**Follow-up completion guardrail:** live logs showed that the restored large
node profiles could still build direct-query contexts far beyond the provider
window, for example `claude-opus-4-8` at ~524k estimated input tokens against a
200k window and `gpt-5.5` at ~404k estimated input tokens against a 128k window.
That shape could stream partial text but never reach the final Query `complete`
event, so the dashboard never saved the query or enabled follow-up. Direct Query
now enforces a provider-family input budget before the model call and records a
`Context budget reached` marker in the context. PGS remains the path for broader
full-graph coverage.

**Direct-query contract restoration:** the provider-family node profiles were
still too broad for direct Query because they turned ordinary `full`, `deep`,
`report`, `expert`, and `dive` requests into accidental large-context scans.
Direct Query now uses the old bounded evidence contract again: `quick` stays at
50 nodes, `normal` at 200, `full`/`deep` at 400, `report` at 600, `expert` at
800, and `dive` at 1000. The larger provider context windows are kept for answer
quality and completion safety, not for inflating direct-query retrieval. PGS is
the thousands-of-nodes and full-graph coverage path.

**Verification:** `node --test --test-concurrency=1
tests/cosmo23/query-engine-context.test.cjs tests/cosmo23/query-engine-runtime.test.cjs
tests/cosmo23/anthropic-client-request.test.cjs tests/cosmo23/pgs-engine.test.cjs`
passed with 32 tests. Syntax checks passed for `cosmo23/lib/query-engine.js`,
`cosmo23/lib/pgs-engine.js`, and `cosmo23/lib/anthropic-client.js`.

---

## Patch 26 — CodeCreationAgent Requires Real Artifact Metadata

**Files:**
- `cosmo23/engine/src/agents/code-creation-agent.js`

**Problem:** the vendored CodeCreationAgent accepted `FILE_WRITTEN:<path>`
console logs as proof that an artifact existed. A code-interpreter run could
therefore report success even when the response had no returned file metadata
and no container-listing hit. Downstream goal tracking then believed the file
was produced while the substrate had no durable artifact.

**Fix:** `FILE_WRITTEN` markers are no longer a success path. Completion now
requires either returned file metadata (`codeResults.files`) or a real
container listing from `findContainerFileMetadata()`.

**Verification:** `node --test --test-concurrency=1
tests/engine/agents/code-creation-agent-metadata.test.js`

---

## Patch 27 — Guided task output contracts and source-required research fail-closed

**Files touched:**
- `cosmo23/engine/src/core/plan-executor.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`

**Problem:** the `jerrysideshows` run proved COSMO23 could diagnose the exact
next action and still not do it. `task:synthesis_final` was marked `DONE` even
though the required `@outputs/jerry-garcia-side-projects-shows.md` deliverable
did not exist, and its current task record carried `producedArtifacts: []`.
An older archived completion had the same shape in a subtler form: unrelated
agent logs and summaries satisfied the task while the named markdown file was
absent. The same run also showed source-required research missions converting
failed/empty web-search activity into successful-looking knowledge fallback,
leaving the graph rich in meta-diagnosis but empty of the requested anecdotes.

**Fix:** `PlanExecutor.validateTaskOutput()` now treats explicit output
contracts as binding. It reads `metadata.expectedOutput`,
`metadata.deliverableSpec`, task-level deliverables, and `@outputs/...` paths
named in acceptance criteria, resolves them through the run path resolver, and
fails validation when any required file is missing or empty. Generic files in
`outputs/` no longer satisfy a task that names a specific deliverable. When a
validated task completes through `TaskStateQueue`, `completeTask()` now forwards
the validated `artifacts` and `producedArtifacts` arrays instead of reducing
completion to an artifact count.

`ResearchAgent` now fails closed for missions whose text or success criteria
require source-backed retrieval (`source_url`, citations, forum/anecdote
collection, Archive.org/review-thread work, `web_search`, etc.). If every
search fails, or if searches complete without any source URLs, the agent returns
`success: false` with `status: blocked_search_failed` or
`blocked_no_sources` and the attempted query/error evidence. General
exploratory missions can still use the older LLM-knowledge fallback, but
source-required missions can no longer treat fallback prose as evidence.

**Effect under Home23:** guided COSMO23 runs stop crediting required artifact
tasks until the named files actually exist. Source-driven research lanes now
surface the true blocker for Home23 agency/live-problem routing instead of
producing more self-referential absence analysis.

**Effect under standalone COSMO:** the stricter task validation and
source-required fail-closed behavior apply to standalone guided runs as well.
Runs without explicit output contracts retain the existing generic artifact
validation behavior.

**Verification:** `npx mocha
cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
cosmo23/engine/tests/unit/research-agent-handoff.test.js` passed with 18 tests.
`node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs
tests/cosmo23/query-engine-context.test.cjs
tests/cosmo23/query-engine-runtime.test.cjs` passed with 33 tests. Syntax
checks passed for the two patched source files.

---

## Patch 28 — Contract-first research governance spine

**Files touched:**
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/src/core/guided-mode-planner.js`
- `cosmo23/engine/src/core/plan-executor.js`
- `cosmo23/engine/src/core/run-commitment-governor.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/src/agents/data-acquisition-agent.js`
- `cosmo23/engine/src/agents/execution-base-agent.js`
- `cosmo23/engine/tests/unit/research-contract.test.js`
- `cosmo23/engine/tests/unit/execution-base-agent.test.js`
- `cosmo23/engine/tests/unit/data-acquisition-agent.test.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`
- `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`
- `cosmo23/engine/tests/unit/run-commitment-governor.test.js`
- `cosmo23/engine/tests/unit/guided-mode-planner.test.js`

**Problem:** Patch 27 made final task output contracts and ResearchAgent
source-required search fail closed, but `jerrysideshows` exposed a wider
pipeline failure. Source/search requirements were still mostly prose:
`sourceScope`, `webPolicy`, expected-output text, and agent prompts. Execution
agents could run commands, write manifests/logs, contact zero sources, and still
look productive because progress and accomplishment were activity-based. After
retries, blocked phases were reported as events but the plan itself did not
become a blocked run. The commitment governor could log stop/repair intent, but
it did not recognize PlanExecutor's `COMPLETED` status or blocked guided plans
as first-class stop states.

**Fix:** added a pure research-contract module that derives a
machine-readable source contract from task/mission text, tools, source scope,
acceptance criteria, and existing metadata. Guided planning stores this contract
on generated missions and persisted tasks, and PlanExecutor derives it for
older/resumed tasks before agent spawn. Completion validation now checks source
evidence for source-required tasks in addition to expected files: generic files,
manifests, command counts, and logs cannot satisfy source research by
themselves. Null-result receipts are still allowed when there is real source
contact, so "searched and found no anecdotes" remains distinct from "never
searched."

ResearchAgent now treats explicit `researchContract.required` metadata as
source-required even when the mission wording is underspecified. DataAcquisition
no longer ORs command/file activity into accomplishment for source-required
work; it must show successful source contact, acquired pages/files, or acquired
bytes. ExecutionBaseAgent's stuck detector now counts only successful progress
results, so failed shell commands, 404/0 HTTP results, timeouts, blocked
commands, and `{error}` tool results do not reset no-progress detection.

PlanExecutor now marks exhausted failed phases and the plan itself as
`BLOCKED`, with blocker receipts. RunCommitmentGovernor recognizes blocked
guided plans with `shouldStopForBlockedRun`, emits `repair_blocked_research`
and `stop_unproductive_run` next actions, and accepts both `DONE` and
`COMPLETED` plan statuses for committed-answer stopping.

**Effect under Home23:** source-driven COSMO23 runs now have a beginning,
middle, and end stop line. The beginning produces a contract; the middle refuses
command-only/searchless accomplishment; the end blocks the plan and reports a
repair/stop state instead of looping through more synthesis or continuation
plans.

**Verification:** focused Mocha coverage passed with 185 tests:
`npx mocha cosmo23/engine/tests/unit/research-contract.test.js
cosmo23/engine/tests/unit/execution-base-agent.test.js
cosmo23/engine/tests/unit/data-acquisition-agent.test.js
cosmo23/engine/tests/unit/research-agent-handoff.test.js
cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
cosmo23/engine/tests/unit/run-commitment-governor.test.js
cosmo23/engine/tests/unit/guided-mode-planner.test.js --timeout 20000`.

---

## Patch 29 — Search and write substrate repair

**Files touched:**
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/src/agents/base-agent.js`
- `cosmo23/engine/src/tools/web-search-free.js`
- `cosmo23/engine/tests/unit/research-contract.test.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`
- `cosmo23/engine/tests/unit/web-search-free.test.js`

**Problem:** Patch 28 made source obligations enforceable, but it still
assumed the underlying source machinery was healthy. It was not. The
`jerrysideshows` mission handed ResearchAgent five exact `web_search for ...`
queries, but `generateResearchQueries()` discarded that execution input and
asked a model for only 2-3 broad queries. The explicit query parser also
truncated searches containing nested quote types such as `"I'll Take a
Melody"`. COSMO23's free search tool did not default to Home23's running local
SearXNG service, so Ollama/local research could silently fall through to
DuckDuckGo HTML. DuckDuckGo/SearXNG result quality was accepted too loosely,
polluting `sourcesFound` with generic archive pages. Separately,
`BaseAgent.writeFileAtomic()` shadowed the promise-based `fs` import with
callback-style `fs`, so non-capabilities agent writes could fail at the
primitive write layer.

**Fix:** ResearchAgent now preserves exact quoted `web_search` directives
before any LLM query generation, including nested quote/contraction cases. The
local search path records raw search evidence, scores result relevance, repairs
low-quality query forms, validates discovered source URLs with real fetches,
rejects verification/captcha interstitials, and for source-required missions
counts only relevant, fetchable URLs as source evidence while retaining the
full backend response in the raw ledger. Mission-requested `@outputs/...`
research files are written directly from the captured search evidence instead
of relying only on generic `research_summary.md` and `research_findings.json`.

`FreeWebSearch` now follows the Home23 agent pattern: default to
`http://localhost:8888` SearXNG, accept both `BRAVE_API_KEY` and
`BRAVE_SEARCH_API_KEY`, and support strict mode where DuckDuckGo fallback is
disabled for source-required research. `BaseAgent.writeFileAtomic()` now uses
the module's promise-based `fs` again and reserves sync `fs` only for the
debug append.

**Effect under Home23:** a source-required Ollama/local COSMO23 research run
now executes the operator/planner's exact searches, reaches the running local
SearXNG backend without requiring `SEARXNG_URL` in PM2, records raw backend
evidence, filters irrelevant search hits out of source proof, validates source
URLs before counting them, writes requested raw evidence deliverables, and
fails closed if authoritative search backends cannot produce usable, fetchable
results.

**Verification:** focused Mocha coverage passed with 193 tests:
`npx mocha cosmo23/engine/tests/unit/web-search-free.test.js
cosmo23/engine/tests/unit/research-contract.test.js
cosmo23/engine/tests/unit/execution-base-agent.test.js
cosmo23/engine/tests/unit/data-acquisition-agent.test.js
cosmo23/engine/tests/unit/research-agent-handoff.test.js
cosmo23/engine/tests/unit/plan-executor-execution-types.test.js
cosmo23/engine/tests/unit/run-commitment-governor.test.js
cosmo23/engine/tests/unit/guided-mode-planner.test.js --timeout 30000`.
`node --test --test-concurrency=1 tests/cosmo23/artifact-loop.test.cjs
tests/cosmo23/query-engine-context.test.cjs
tests/cosmo23/query-engine-runtime.test.cjs tests/cosmo23/pgs-engine.test.cjs
tests/cosmo23/anthropic-client-request.test.cjs` passed with 53 tests. Syntax
checks passed for the patched source files. Live checks proved local SearXNG
is reachable, ResearchAgent now extracts all five original `jerrysideshows`
web-search queries intact, rejects Reddit verification interstitials, repairs
the query, and counts the fetchable Lost Live Dead source URL.

---

## Patch 30 — Source backbone fan-out and proof receipts

**Files touched:**
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/src/tools/web-search-free.js`
- `cosmo23/engine/mcp/http-server.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`
- `cosmo23/engine/tests/unit/web-search-free.test.js`

**Problem:** Patch 29 repaired the local search substrate, but COSMO23 still
had fragmented acquisition paths. Provider-native model search could terminate
the route before SearXNG/Brave ran. Provider-native citations were accepted
without fetch validation for source-required work. Explicit source URLs in a
mission were treated as text to search rather than sources to contact. The
source gate was run-global, so a later failed query could pass if an earlier
query had already populated `sourcesFound`. MCP `web_search` could not receive
strict/source-required policy, letting weak fallback bypass the direct
ResearchAgent path. `FreeWebSearch` also stopped at the first authoritative
backend with results, so Brave and SearXNG did not supplement each other.

The `jerrysideshows` exports exposed the confirmation problem too: planned
queries were not all executed, URL bags were written without crossing proof,
and a zero-node/zero-partition assessment still produced prose. A fixed system
needs receipts that prove route attempts, result crossings, validation, and
stop/continue state.

**Fix:** ResearchAgent now treats acquisition as a fan-out backbone:

- explicit URLs in a query are fetched and validated directly before search;
- provider-native web search still runs, but its sources/citations/text URLs are
  normalized into search evidence and fetch-validated when sources are required;
- SearXNG/Brave/local search supplements provider-native search by default;
- source-required success is evaluated per query from the evidence created by
  that query, not from older `sourcesFound` state;
- failed provider-native validation can be rescued by local/metasearch results,
  but invalid native URLs do not count;
- MCP `web_search` receives `sourceRequired` and
  `allowDuckDuckGoFallback:false` for source-required missions;
- the MCP server schema/handler honors strict source-required search policy;
  and
- `FreeWebSearch` aggregates Brave plus SearXNG authoritative results with URL
  dedupe before considering DuckDuckGo fallback.

Research export now always writes source-backbone proof receipts under
`outputs/research/<agentId>/`:

- `source_attempts.jsonl`
- `source_crossing.jsonl`
- `extraction_receipts.jsonl`
- `planned_vs_executed.json`
- `source_backbone_status.json`

These receipts include route/backend, strict-mode status, result counts,
validation status, content bytes/hash when fetched, missing planned queries,
missing required outputs, failed routes, productive source URLs, and the next
allowed action (`continue` or `stop_and_repair_source_acquisition`).

**Effect under Home23:** modern models keep their built-in web search, but it
is no longer the sole authority. COSMO23 now supplements provider-native search
with Home23's local search infrastructure and direct URL fetches, preserves the
evidence chain, validates what crossed into fetched content, and gives the
confirmation layer concrete files to stop unproductive runs before they turn
route failure into confident absence prose.

**Verification:** focused source-backbone tests passed with 17 tests:
`npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js
cosmo23/engine/tests/unit/web-search-free.test.js --timeout 30000`.
The broader research/governance regression set passed with 200 tests, and the
COSMO23 query/artifact/PGS/provider node tests passed with 53 tests. Syntax
checks passed for the touched runtime files. A live SearXNG/ResearchAgent probe
found and fetch-validated the Lost Live Dead source URL, recording HTTP 200,
134,948 bytes, and a content hash.

---

## Patch 31 — Typed source provider registry

**Files touched:**
- `cosmo23/engine/src/core/source-provider-registry.js`
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/tests/unit/source-provider-registry.test.js`
- `cosmo23/engine/tests/unit/research-contract.test.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`

**Problem:** Patch 30 gave COSMO23 a stronger source-acquisition backbone, but
the backbone still treated "search" as the main primitive. The subagent review
showed that serious research needs typed routes, not only query strings:
Internet Archive item/review/file APIs, Wayback availability and CDX, Common
Crawl CDX, Wikidata, OpenAlex, Crossref, Semantic Scholar, arXiv, PubMed,
RSS/Atom feeds, and sitemaps. Without these routes, the system could ask a
modern model to search well while still missing canonical databases, historical
captures, metadata APIs, feed entries, and archive file manifests.

**Fix:** Added `SourceProviderRegistry`, a typed provider fan-out layer used by
`ResearchAgent` after direct URL acquisition and provider-native search, and
before local search fallback:

- provider IDs are first-class route names such as `archive.advancedsearch`,
  `archive.reviews`, `archive.files`, `wayback.cdx`, `commoncrawl.cdx`,
  `wikidata.entity_search`, `wikidata.sparql`, `openalex.works`,
  `crossref.works`, `semantic_scholar.paper_search`, `arxiv.query`,
  `pubmed.esearch_summary`, `rss.feed`, and `feed.sitemap`;
- candidates are normalized with `provider`, `sourceType`, URL, snippet, and
  provider metadata;
- provider attempts are preserved as research evidence with route, status,
  result count, URL count, duration, and error state;
- archive file candidates use metadata-only validation when archive metadata
  supplies file size/hash, avoiding accidental large binary downloads;
- source-required missions validate provider candidates just like native/local
  search candidates; and
- research contracts now emit `sourceProviderHints`, so a planner/governor can
  name executable provider obligations instead of leaving them as prose.

The first registry layer intentionally keeps browser-rendered/video/social
providers out of runtime execution. Those families are now named in the design
review, but they need separate credential, rate-limit, transcript, and rendered
receipt semantics before they should be allowed to run automatically.

**Effect under Home23:** COSMO23 can now acquire source candidates from typed
source systems even when generic search is weak or unavailable. The route that
produced a candidate is explicit, metadata-only evidence is represented without
fake downloads, and the contract layer can force providers when query text is
too generic to infer the route.

**Verification:** focused registry tests cover Archive, Wayback, Common Crawl,
Wikidata, OpenAlex, Crossref, Semantic Scholar, arXiv, PubMed, feed, sitemap,
failure preservation, and metadata-only archive files. ResearchAgent tests
prove typed providers run for source-required work, local-search mode does not
return before the registry, metadata-only candidates avoid fetch validation, and
contract `sourceProviderHints` are honored when query text has no provider cues.
The focused governance/source regression suite passed with 212 tests, syntax
checks passed for the touched runtime files, and a live-safe provider probe
returned accepted attempts from Archive, Wikidata, Wayback, and OpenAlex.

---

## Patch 32 — Home23 skill providers in the source backbone

**Files touched:**
- `cosmo23/engine/src/core/source-provider-registry.js`
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/tests/unit/source-provider-registry.test.js`
- `cosmo23/engine/tests/unit/research-contract.test.js`
- `docs/design/COSMO23-VENDORED-PATCHES.md`
- `docs/receipts/2026-06-21-cosmo23-research-governance-spine-receipt.md`

**Problem:** Patch 31 added typed external providers, but COSMO23 still did not
use Home23's own first-class skill substrate. That left existing read-only
research skills such as `x-research` outside the source backbone even though
Home23 already knows how to run them, cache them, apply host defaults, and keep
skill credentials out of COSMO-specific code.

**Fix:** `SourceProviderRegistry` can now execute Home23 shared skills through
`workspace/skills/index.js` as typed source providers. The first enabled skill
family is read-only X/Twitter research:

- `home23.skill.x_research.search`
- `home23.skill.x_research.thread`
- `home23.skill.x_research.profile`
- `home23.skill.x_research.tweet`

The registry dynamically imports the Home23 shared skills runtime from the
project root, passes a bounded execution context, and normalizes returned
tweets into source candidates with route, source type, tweet URL, text,
created-at, metrics, expanded URLs, and optional saved artifact path. It does
not duplicate X API credential handling inside COSMO23.

Research contracts now map X/Twitter discourse language to
`home23.skill.x_research.search`, so prompts like "what are people saying on
X/Twitter" become executable provider hints instead of generic social-search
prose.

**Effect under Home23:** COSMO23 now uses Home23's built-in research machinery
as part of the same source-acquisition backbone as Archive, Wayback, scholarly
APIs, and search. This keeps source acquisition extensible: additional
operational skills can be added as provider adapters without rewriting COSMO's
research agent or copying credentials into vendored code.

**Verification:** TDD covered provider selection, injected skill-runtime
execution, execution context propagation, tweet normalization, and contract
hint derivation. Focused source/backbone tests passed with 34 tests, the full
focused governance/source suite passed with 214 tests, the COSMO23
artifact/query/PGS/provider regression suite passed with 53 tests, syntax
checks passed for the touched runtime files, and a live-safe `x-research`
provider probe returned an accepted X source through the real shared skills
runtime.

---

## Patch 33 — Interactive live-status truth and source-scope planning repair

**Files touched:**
- `cosmo23/server/lib/interactive-live-status.js`
- `cosmo23/server/index.js`
- `cosmo23/engine/src/interactive/interactive-session.js`
- `cosmo23/engine/src/interactive/interactive-tools.js`
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/src/core/guided-mode-planner.js`
- `cosmo23/engine/tests/unit/interactive-session.test.js`
- `cosmo23/engine/tests/unit/interactive-live-status.test.js`
- `cosmo23/engine/tests/unit/research-contract.test.js`
- `cosmo23/engine/tests/unit/guided-mode-planner.test.js`

**Problem:** The `jerrynotes` run exposed two beginning-of-run truth failures
and one interactive confirmation failure. The Interactive tab reused a
server-global `interactiveSession` without checking the active run path, then
built its prompt and `get_run_status` answer from a one-time `state.json.gz`
hydrated orchestrator stub. Because that stub had no `running` field, the tool
reported `running:false` and stale cycle/memory counts while `/api/status`
correctly showed the run live. Separately, the planner misread "Avoid all
primary sources - search secondary and forums" as "web search is prohibited,"
so a fresh source-acquisition run became a local-memory plan. The research
contract layer then compounded the contradiction by attaching source-required
provider hints to tasks whose `sourceScope` explicitly said local memory or no
source acquisition.

**Fix:** Interactive mode now has a live-status helper that combines the
status-contract truth (`activeContext` + `cosmo-main`) with the freshest run
counters from `metrics.json` / `state.json.gz`. `/api/interactive/start`
refreshes that provider when resuming the same run and invalidates the old
session when the active run path changes. `/api/interactive/message` validates
the posted `sessionId`, and `/api/interactive/status` exposes the current
live context. The interactive prompt, `get_run_status`, and `brain_stats` now
prefer the live provider and label the status source/timestamp instead of
silently presenting a stale snapshot as current.

`deriveResearchContract()` now treats local/no-acquisition scope as a hard
override, including malformed supplied contracts on resumed tasks, so local
memory queries and gap inventories cannot schedule Archive/X providers or fail
source-contact validation. Guided planning now distinguishes "avoid primary
sources" from "avoid web search," recognizes secondary/forum search requests as
external evidence work, and its fallback missions honor secondary/forum source
preferences instead of defaulting to primary-source research.

**Effect under Home23:** Interactive chat can no longer confidently tell the
user a live run is stopped because of a stale prompt block or hydrated snapshot
tool result. Fresh runs that ask for secondary/forum acquisition remain web/source
research runs, while genuinely local continuations stay local and cannot carry
external provider hints by accident.

**Verification:** TDD covered stale interactive prompt/tool status,
session-run mismatch, stale session IDs, live run counter construction,
local-only contract override, malformed persisted contract override, and the
primary-source/source-preference planner regression. The focused COSMO
governance/source suite passed with 239 tests, the COSMO query/PGS/provider
regression suite passed with 38 tests, server helper tests passed with 13
tests, and syntax checks passed for the touched runtime files.

---

## Patch 37 — Verified research execution closeout and Archive.org acceptance proof

**Files touched:**
- `cosmo23/engine/src/core/guided-mode-planner.js`
- `cosmo23/engine/src/core/research-contract.js`
- `cosmo23/engine/src/core/source-provider-registry.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/src/core/task-completion-validator.js`
- `cosmo23/engine/src/core/plan-executor.js`
- `cosmo23/engine/src/cluster/task-state-queue.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/index.js`
- `cosmo23/engine/src/agents/results-queue.js`
- `cosmo23/engine/src/agents/agent-executor.js`
- focused unit tests under `cosmo23/engine/tests/unit/`

**Problem:** Patch 36 installed acceptance validation, but the live
Archive.org proof still exposed execution-chain failures. Strict guided plans
could create a good-looking task map yet add a redundant generic synthesis
task, Archive route receipts could be polluted by unrelated identifiers or
later weaker attempts, pending assigned tasks could sit in `PENDING` even after
their required artifact existed, verified task completion could leave the next
milestone locked until a later executor sweep, and a completed guided plan
could leave `cosmo-main` running with `activeContext` still set until the cycle
limit. The commitment governor also recorded `commit_artifacts` as if it had
done work even though no executor existed.

**Fix:** Guided planning now treats an explicit final deliverable phase as the
synthesis contract and suppresses the old extra `task:synthesis_final`.
Archive.org acquisition detects bare Archive identifiers, runs per-identifier
metadata/review routes, scopes `archive-org-comments.json` statuses to required
identifiers, and keeps a typed route accepted if an earlier acceptable attempt
succeeded. Local validation/synthesis tasks no longer inherit source-acquisition
contracts from upstream raw-data phases.

The executor path now closes the loop instead of waiting for incidental later
cycles: assigned `PENDING` tasks with valid expected outputs complete without a
redundant respawn, the task-state queue atomically completes the current
milestone and activates the next one after a verified `COMPLETE_TASK`, and
guided pending tiers are serviced every cycle after task-state processing
instead of behind meta-review or commitment gates. Startup drains planning-agent
results before declaring the plan ready, results-queue history survives
integration, and guided-exclusive handoffs are suppressed unless they are
explicitly part of the guided plan.

Strict guided completion is now terminal by default. A persisted
`plan:main.status === COMPLETED` with all tasks `DONE`, all milestones
`COMPLETED`, no active agents, and no pending injected plan runs through the
same completion lifecycle as a direct `PLAN_COMPLETED` executor action. COSMO23
then emits completion status, stops the run lifecycle, and clears the active
context. Automatic continuation remains available only when explicitly
configured with guided auto-continue. `commit_artifacts` receipts now record
`applied:false` until a real artifact-commit executor exists.

**Effect under Home23:** COSMO23 can now prove the full beginning/middle/end
contract for a small hard research objective: create the intended phase plan,
fetch source data through typed routes, validate named artifacts, synthesize the
final markdown from those artifacts, mark the plan complete, and stop the run
instead of spinning with stale active-run state. Interactive/query surfaces see
an answerable artifact substrate after completion rather than a still-running
graph-only session.

**Verification:** Focused unit coverage passed with 110 Mocha tests across
orchestrator guided continuation, task-state queue, plan executor execution
types, research-agent handoff, guided planner, source-provider registry,
research contracts, agent-executor guided behavior, startup planning wait, and
results-queue history. Live proof run
`cosmo23-acceptance-archive-reviews-closeout-20260630215506` launched through
`POST /api/launch` with the three-phase Archive.org contract. It produced
`outputs/raw-anecdotes/archive-org-comments.json`,
`outputs/validation/archive-org-comments-validation.json`, and
`outputs/final/archive-org-comments-report.md`; all three tasks ended `DONE`,
all three milestones ended `COMPLETED`, `plan:main` ended `COMPLETED`, the
artifact validator returned `problems: []`, and `/api/status` returned
`running:false`, `lifecycle:"idle"`, and `activeContext:null` after completion.

---

## Patch 38 — Dashboard query run-root alignment

**Files touched:**
- `cosmo23/engine/src/dashboard/server.js`
- `cosmo23/engine/tests/unit/dashboard-run-root.test.js`
- `docs/design/COSMO23-VENDORED-PATCHES.md`

**Problem:** After Patch 37 proved completed-run closeout, the dashboard query
route still looked for named runs under `cosmo23/engine/runs/<runName>`. Home23
managed launches write runs to `cosmo23/runs/<runName>` and also export
`COSMO_RUNS_PATH`, so a completed run could be visible in the always-on brain
list but dashboard `/api/query` failed with `ENOENT ... cosmo23/engine/runs/.../state.json.gz`.

**Fix:** `DashboardServer` now honors `COSMO_RUNS_PATH` and otherwise falls
back to the Home23-managed `cosmo23/runs` directory when it exists, preserving
the standalone `cosmo23/engine/runs` fallback for non-Home23 use.

**Effect under Home23:** Query surfaces resolve the same run root as launch,
brain listing, and the status contract. Completed or active Home23-managed runs
are no longer sent to a stale standalone path before artifact/query grounding
can even begin.

**Verification:** Syntax checks passed for the dashboard server and new unit
test. Focused Mocha coverage passed with 65 tests across dashboard run-root,
orchestrator guided continuation, task-state queue, plan executor execution
types, source-provider registry, and research contracts. The always-on
`/api/brain/:name/query` endpoint then queried
`cosmo23-acceptance-archive-reviews-closeout-20260630215506` and answered from
the completed run artifacts, naming `outputs/raw-anecdotes/archive-org-comments.json`,
the source receipt files, `archive.metadata`, `archive.reviews`, and the
extracted anecdote text.

---

## Patch 39 — Per-identifier Archive negative receipt proof

**Files touched:**
- `cosmo23/engine/src/core/source-provider-registry.js`
- `cosmo23/engine/src/agents/research-agent.js`
- `cosmo23/engine/src/core/task-completion-validator.js`
- `cosmo23/engine/tests/unit/source-provider-registry.test.js`
- `cosmo23/engine/tests/unit/research-agent-handoff.test.js`
- `cosmo23/engine/tests/unit/plan-executor-execution-types.test.js`
- `docs/design/COSMO23-VENDORED-PATCHES.md`

**Problem:** Patch 37 proved the positive flow, but the no-review identifier in
the live proof still had `review_route:"missing"`. Archive metadata reported
zero reviews, which was true, but the receipt did not distinguish
"review route checked and empty" from "review route never checked." The
completion validator also accepted a no-entry required identifier when only
`metadata_route:"accepted"` was present.

**Fix:** `archive.reviews` now emits a typed `archive_review_status` candidate
for each identifier whose metadata reviews array is empty. The research agent
records that candidate as `review_route:"accepted"` and `status:"no_reviews_found"`
without turning it into an extracted anecdote entry. The archive comments
validator now rejects any required identifier without either a real entry or a
per-identifier negative receipt with both `metadata_route:"accepted"` and
`review_route:"accepted"`.

**Effect under Home23:** Empty source results are now first-class receipts, not
implicit absence. COSMO23 can complete a no-review branch only after proving the
typed review route was checked for that identifier; otherwise the expected
artifact is invalid and the task cannot close as `DONE`.

**Verification:** Syntax checks passed for the patched files. Focused Mocha
coverage passed with 76 tests across source-provider registry, research-agent
handoff, plan-executor completion validation, research contracts, and task-state
queue. Live proof run
`cosmo23-acceptance-archive-reviews-negative-receipts-20260630221609` produced
`outputs/raw-anecdotes/archive-org-comments.json` with both required identifiers
showing `review_route:"accepted"`; the stricter artifact validator returned
`problems: []`, all tasks and milestones ended complete, `/api/status` returned
idle with no active context, and the always-on brain query summarized the
negative receipt plus `archive.metadata` / `archive.reviews` routes from the
completed run artifacts.

---

## Patch 47 — Canonical brain catalog and protected worker boundary

**Files touched:**
- `cosmo23/server/lib/brain-registry.js`
- `cosmo23/server/lib/brains-router.js`
- `cosmo23/server/lib/brain-operation-worker.js`
- `cosmo23/server/lib/brain-operation-routes.js`
- `cosmo23/server/index.js`
- `contracts/schemas/brain-operations.schema.json`
- canonical catalog and protected worker contract tests

**Problem:** The legacy Brains picker used scan-path-derived identifiers and
display names. Symlink spellings could represent the same brain more than once,
empty configured residents disappeared instead of remaining known unavailable
targets, and route input did not have a single server-derived identity or
mutation-boundary contract.

**Fix:** The Home23-managed server now builds a SHA-256-revisioned catalog from
real roots, exact ignored `config/agents.json` agent names, canonical resident
and research lifecycle metadata, and exactly seven server-derived mutation
boundaries. Resident ownership comes only from exact configured
`instances/<agent>/brain` roots. Research completion requires canonical
`plans/plan:main.json` status `COMPLETED` plus numeric `completedAt`; active,
unavailable, ambiguous, mismatched, malformed, and unknown selectors remain
distinct fail-closed outcomes. Canonical IDs resolve through the existing
detail and query surfaces, while legacy picker fields and route keys remain
additive compatibility aliases rather than authorization identities.

Catalog inspection bounds state-summary input and decompression; corrupt or
oversized state is reported as an unknown summary instead of a false zero.
Boundary realpaths must remain within their own catalog entry, preventing a
resident subtree symlink from escaping into another configured brain.

The internal worker boundary now verifies a fresh signed one-use capability on
every start, status, events, result, and cancel call; re-resolves and authorizes
the complete canonical target before first execution; and dispatches only an
exact operation-type executor. Equivalent concurrent/lost-response starts share
one process-local worker and source pin, while a different canonical fingerprint
fails closed. Source operations accept only digest-bound numeric-v1 descriptors
and reopen through the shared requester-owned pin provider; source-free run and
requester operations cannot open a pin. Worker cancellation is per operation,
provider activity retains validated call correlation, events are count/byte
bounded with explicit authenticated gaps, graph artifacts are scratch-confined
identity NDJSON, and terminal cleanup shares one cached pin-release promise.
Observed and unread terminal workers have bounded retry retention; the dashboard
durable store remains authoritative and canonical stored-result export stays
dashboard-local. `server/index.js` now composes the canonical Home23 provider
registry and operation-mode QueryEngine, mounts the query/PGS worker routes
before COSMO's broad JSON middleware whenever the generated capability is
present, and stops the worker during scoped process shutdown. The worker also
arms the caller's long hard deadline itself, so a lost dashboard coordinator
cannot leave a provider operation running forever. Research executors remain an
explicit later Patch 50 registration and are never substituted by query.

The protected worker derives its requester-owned scratch and shared quota from
the exact BrainOperationStore durable directory
`instances/<requester>/runtime/brain-operations/operations/<operationId>/`.
This keeps COSMO query/PGS process pins, projections, scratch accounting, and
dashboard status/result authority inside one operation root; the older flat
layout remains discovery-compatible only for standalone or legacy contexts.

Scratch descendants are fail-closed as well. Graph exports require an exact
nonsymlink `scratch/results` directory and publish only an owned private inode;
an existing destination or extra hard link is rejected without replacement.
Pinned PGS holds no-follow identities for the operation root, `scratch`,
`scratch/pgs`, the revision directory, and its SQLite file. A new projection is
built under a private temporary database inode, fsynced, renamed, reopened, and
identity-checked before use. Successful PGS receipts apply the same rule to
`scratch/pgs-receipts` and verify a bounded streaming readback. Pre-existing
symlinked `results`, `pgs`, revision, or `pgs-receipts` paths fail as
`invalid_request` before they can create or replace a file outside scratch.

**Verification:** `tests/cosmo23/brain-operation-worker.test.cjs` covers
capability binding/replay, 32-way idempotent start, authority/source matrices,
real native and legacy source pins, event/provider bounds, artifacts, GC,
release-once cleanup, exact durable operation-root alignment, and all five
internal route handlers. `tests/engine/dashboard/brain-source-executors.test.js`,
`tests/cosmo23/pinned-pgs-store.test.cjs`, and
`tests/cosmo23/pgs-source-pin.test.cjs` cover redirected child paths,
no-replace publication, exact inode cleanup, SQLite reuse, cancellation, and
receipt readback. The existing brains
router and shared capability/authority/source suites remain part of the patch
acceptance command.

**Phase boundary:** Patch 47 contains its canonical-catalog authority,
capability-protected worker, and production query/PGS activation phases. Patch
48 remains source-truth authority, Patch 49 supplies provider execution, and
Patch 50 remains agent/research tool integration; this entry does not claim the
research rollout is complete.

---

## Patch 48 — Source-truth bounded brain routes

**Files touched:**
- `cosmo23/lib/memory-source-adapter.js`
- `cosmo23/server/lib/brain-source-router.js`
- `cosmo23/server/index.js`
- `tests/cosmo23/memory-sidecar.test.cjs`
- `tests/evobrew/memory-sidecar.test.cjs`
- `tests/cosmo23/brain-source-router.test.cjs`
- `tests/engine/dashboard/brain-source-request-abort.test.js`

**Problem:** The legacy COSMO graph route resolved a selected brain and then
called the QueryEngine `loadBrainState()` compatibility loader before mapping
arrays into a response. That reintroduced the exact unbounded materialization
path the Home23 source-truth work is removing, and it let graph read behavior
drift away from the shared memory-source limits and evidence contract.

**Fix:** COSMO now mounts a Home23 brain-source router before the legacy graph
handler. The router derives identity only from the canonical catalog and server
runtime, rejects caller-supplied source roots/requesters/operation paths, opens a
requester-owned ephemeral source outside the target brain, and serves
`/api/brain/:name/status` plus bounded `/api/brain/:name/graph` through
`shared/memory-source` sampling and evidence. The old inline graph route remains
only as a compatibility fallback for non-mounted contexts and is not reached by
the Home23-managed COSMO server.

**Verification:** Focused Task 6 route/source tests passed:
`node --test --test-concurrency=1 tests/cosmo23/brain-source-router.test.cjs
tests/shared/memory-source-graph.test.js
tests/engine/dashboard/brain-source-executors.test.js
tests/engine/dashboard/brain-source-api.test.js`. The COSMO route test mounts a
trap legacy handler that would throw if `loadBrainState()` were invoked and
proves the bounded router handles the request first.

**2026-07-10 disconnect follow-up:** The shared source-route cancellation helper
previously treated every Node `IncomingMessage` `close` event as a client
disconnect. A normally parsed request also closes with `req.complete === true`,
so delayed source reads could be cancelled and surfaced as HTTP 499 after a
fully received request. The dashboard and vendored COSMO helpers now cancel only
for an aborted/incomplete request or when the response closes before
`res.writableEnded`. Real HTTP/socket regressions cover a completed POST,
incomplete request body, and premature response close for both implementations.
Focused verification passed with 37 tests across the lifecycle regression,
dashboard source/search compatibility, and COSMO bounded source route suites.

**2026-07-10 exact-root follow-up:** After source projections began enforcing
their logical evidence root, the COSMO/Evobrew compatibility adapter reopened
the scratch projection as though its physical scratch directory were the target
brain. The supplied target identity then failed closed with
`source evidence root mismatch`, breaking legacy sidecar hydration. The adapter
now binds the validated projected manifest to the original canonical brain root
and retains the legacy resident fingerprint used by `isCurrent()`. Focused
COSMO, Evobrew, and legacy-research projection verification passed with 10
tests.

---

## Patch 49 — Durable provider execution and import-time isolation

**Files touched:**
- `cosmo23/engine/src/core/openai-client.js`
- `cosmo23/engine/src/core/gpt5-client.js`
- `cosmo23/engine/src/core/unified-client.js`
- `cosmo23/engine/src/core/chat-completions-client.js`
- `cosmo23/engine/src/core/mcp-client.js`
- `cosmo23/engine/src/services/codex-oauth-engine.js`
- `cosmo23/lib/bounded-json.js`
- `cosmo23/lib/brain-provider-client-registry.js`
- `cosmo23/lib/provider-completion.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/pgs-engine/src/pinned-operation.js`
- `cosmo23/pgs-engine/src/pinned-store.js`
- `cosmo23/server/lib/legacy-query-operation-adapter.js`
- `cosmo23/server/index.js`

**Problem:** Provider and OAuth support modules imported optional runtime
packages such as `openai`, `dotenv`, `node-fetch`, and Prisma during module
load. In Home23's isolated verification worktree that prevented unrelated
Codex/provider tests from importing COSMO clients even when the tested route
used env-backed Codex credentials and never needed those optional packages.

**Fix:** COSMO provider clients now lazy-load optional packages only on the code
paths that need them. GPT/OpenAI construction is deferred until actual
OpenAI-path calls, xAI construction loads the OpenAI SDK only when xAI is
enabled, Anthropic/MiniMax load their adapter only when selected, HTTP MCP uses
global `fetch` before `node-fetch`, and the Codex OAuth engine defers Prisma
until database credentials are required. Env-backed Codex credentials remain
usable without a generated Prisma client.

**Verification:** Focused provider import/routing tests passed:
`node --test --test-concurrency=1 tests/engine/core/gpt5-client-complete.test.cjs
tests/engine/core/unified-client-codex-oauth.test.cjs
tests/cosmo23/codex-unified-client-request.test.cjs`.

**2026-07-11 durable-execution follow-up:** Operation-mode Query and PGS now
resolve only an exact catalog provider/model pair through the injected registry.
Provider clients expose an immutable `providerId`, every terminal completion is
checked against the selected provider and model, and Query prompt/result
serialization is bounded before the provider or durable-result boundary. The
live legacy `/api/brain/:name/query` and streaming routes are compatibility
adapters over the canonical dashboard operation protocol; they validate the
requester, target brain, selected pair, terminal state, and result identity.
They copy frozen durable results before adding legacy response fields and bound
best-effort detach cleanup. All other live COSMO `QueryEngine` callers are
audited non-provider utilities (`loadBrainState`, suggestions, and explicit
result export).

Pinned PGS retries remain bound to one immutable source descriptor, exact sweep
pair, requester operation scratch, and trusted `{sweepFraction}`. Concurrency is
an internal fixed bound rather than a caller override. Failed and cancelled work
stays pending; validated successes are reused on the next attempt. SQLite retry
and success listings stream through explicit scalar/result caps, and every
successful-sweep commit counts canonical `{output}` JSON bytes together with
all prior durable rows before the transaction can cross the 16 MiB aggregate
ceiling. Receipt publication uses a private no-follow temporary inode plus an
atomic no-replace hard link, fsync, identity check, and bounded readback. Query
and PGS read-only runs were exercised against resident and completed-research
target trees containing unknown files, nested directories, and symlinks; only
requester scratch changed.

**Verification:** The focused Home23 matrix passed 59/59 across exact provider
identity, legacy adaptation, retry state, cancellation, canonical byte ceilings,
receipt publication, Query mutation boundaries, and cross-brain read-only
tests. The four required exact-path suites report 3 tests in
`cross-brain-readonly.test.cjs`, 3 in `pgs-cancellation.test.cjs`, 3 in
`pgs-retry-state.test.cjs`, and 2 in
`query-engine-mutation-boundary.test.cjs`. The standalone package's fixture-free
unit command passed 84/84; its historical integration file still requires the
untracked `examples/data/physics2.json.gz` fixture and is not claimed by that
receipt.

---

## Patch 50 — Durable research operation backend

**Files touched:**
- `cosmo23/server/lib/research-run-operation-adapter.js`
- `cosmo23/server/lib/research-run-metadata.js`
- `cosmo23/server/lib/research-pinned-source-reader.js`
- `cosmo23/server/lib/research-requester-output-writer.js`
- `cosmo23/server/lib/research-compile-provider-adapter.js`
- `cosmo23/server/lib/research-operation-executors.js`
- `cosmo23/server/config/model-catalog.js`
- `cosmo23/lib/brain-provider-client-registry.js`
- `cosmo23/server/providers/registry.js`
- `cosmo23/server/index.js`
- `shared/brain-operations/research-run-target.cjs`
- `engine/src/dashboard/brain-operations/research-run-target-resolver.js`
- `engine/src/dashboard/server.js`
- `tests/cosmo23/research-run-operation-adapter.test.cjs`
- `tests/cosmo23/research-run-metadata.test.cjs`
- `tests/cosmo23/research-pinned-source-reader.test.cjs`
- `tests/cosmo23/research-requester-output-writer.test.cjs`
- `tests/cosmo23/research-compile-provider-adapter.test.cjs`
- `tests/cosmo23/research-operation-executors.test.cjs`
- `tests/cosmo23/model-catalog-exact-pair.test.cjs`
- `tests/cosmo23/brain-provider-client-registry.test.cjs`
- `tests/cosmo23/brain-operation-server-activation.test.cjs`
- `tests/shared/research-run-target.test.cjs`
- `tests/engine/dashboard/research-run-target-resolver.test.js`

**Problem:** The durable brain-operation backend could not safely drive COSMO
research runs through the real launcher. The legacy HTTP routes accepted
caller-provided run roots/owners, kept lifecycle truth mainly in process-local
`activeContext`, cleared that context even when stop failed, and exposed one
global process log buffer. A long stop, cancellation, concurrent mutation, or
different active run could therefore produce a false stopped result, duplicate
spawn, stale metadata write, or logs from the wrong run.

**Fix:** Added an owner-scoped adapter over the existing `RunManager` and
`ProcessManager` methods. It derives
`instances/<requester>/workspace/research-runs/<runId>` server-side, rejects
path escapes and symlinked components, persists and reloads canonical run
metadata around every lifecycle transition, and uses a nonblocking per-run lock
for launch/continue/stop mutations. Continue is limited to
`paused|failed|completed`; stop requires the exact active run, writes
`stopping` before `stopAll()`, waits for `getStatus()` to prove every child is
down, and writes `stopped` before clearing active context. Cancellation never
claims stopped. Watch maintains a bounded per-run cursor ring and never falls
back to another active run's global logs.

`server/index.js` now exposes `launchPreparedResearch(brain,payload,req)`, the
single config/runtime-link/metadata/process-start path used by both the legacy
`/api/launch` flow and the durable adapter; there is no parallel launcher. The
protected worker registers exactly `research_launch`, `research_continue`,
`research_stop`, `research_watch`, `research_intelligence`, and
`research_compile`. Run selectors are re-read from owner-scoped canonical
metadata. Intelligence reads only the pinned completed source and never mutates
agency or the target brain. Compile uses the exact configured provider/model
pair, writes only through a prevalidated requester-workspace capability, and
cannot be relabeled as a public query operation.

**Verification:** With `NODE_PATH` pointed at the existing COSMO dependency
install while running from the isolated integration worktree, these three
focused commands passed on 2026-07-10:

```bash
node --test --test-concurrency=1 tests/cosmo23/research-run-operation-adapter.test.cjs tests/cosmo23/research-run-metadata.test.cjs tests/shared/research-run-target.test.cjs
# 26/26 passed

node --test --test-concurrency=1 tests/cosmo23/research-pinned-source-reader.test.cjs tests/cosmo23/research-requester-output-writer.test.cjs tests/cosmo23/research-compile-provider-adapter.test.cjs tests/cosmo23/research-operation-executors.test.cjs tests/cosmo23/model-catalog-exact-pair.test.cjs tests/cosmo23/brain-provider-client-registry.test.cjs
# 37/37 passed

node --test --test-concurrency=1 tests/cosmo23/brain-operation-server-activation.test.cjs tests/engine/dashboard/research-run-target-resolver.test.js
# 5/5 passed
```

The coverage includes server-derived roots, symlink/escape refusal,
write-before-spawn ordering, durable lifecycle transitions, exact provider
selection, bounded pinned reads, requester-only atomic output, stop
cancellation truth, exact-run cursor isolation, production executor
registration, and deterministic concurrent mutation conflicts. These focused
receipts do not claim Task 8 live acceptance or that the full reliability spec
is implemented.

---

## Patch 52 — Source-honest in-process MCP bridge

**Files touched:**
- `shared/memory-source/mcp-bridge-adapter.cjs`
- `engine/src/agents/mcp-bridge.js`
- `cosmo23/engine/src/agents/mcp-bridge.js`
- `engine/src/agents/agent-executor.js`
- `engine/src/index.js`
- `cosmo23/engine/src/agents/agent-executor.js`
- `cosmo23/engine/src/core/orchestrator-manager.js`
- `cosmo23/engine/src/index.js`
- `cosmo23/engine/src/worker/orchestrator-worker.js`
- `cosmo23/engine/src/worker/worker-manager.js`
- `tests/engine/agents/mcp-bridge-memory.test.js`
- `tests/engine/agents/agent-executor-memory-context.test.js`
- `tests/cosmo23/agent-executor-memory-context.test.cjs`

**Problem:** The agent-facing in-process MCP bridges still answered system,
query, statistics, and graph memory calls by parsing the legacy state snapshot.
The resident bridge also hydrated every node and edge sidecar into arrays. On a
large live brain this could exhaust the V8 heap; on an empty inline shell or a
failed read it instead reported zero nodes as if zero were authoritative.
`get_memory_graph(0)` additionally exposed an unbounded full-graph path.

**Fix:** Both bridges now delegate memory reads to the shared canonical
base-plus-delta tools through one trusted adapter. The adapter binds requester
and target context at construction, rejects caller-provided identity, forwards
abort signals and supported tag filters, preserves bounded positive node/edge
limits, and adds compatibility graph statistics from authoritative source
metadata. Missing context or unavailable source returns null totals with
`sourceHealth:unavailable` and `matchOutcome:unknown`, never false zero. Scalar
state remains separate and is constrained to an 8 MiB compressed / 32 MiB
decompressed read, so it cannot reintroduce sidecar hydration or an unbounded
legacy snapshot parse. The COSMO constructor still accepts its legacy positional
`ClusterStateStore` while also supporting named source context.
Production `AgentExecutor` call sites now construct that context from the exact
resident or explicitly owned-run root and fail source-unavailable when it is
missing. Evidence retains requester, target, brain, catalog, kind, source type,
access mode, and operation identity. Recent thought/dream reads use the shared
bounded reverse JSONL tail instead of whole-file hydration.

**Verification:** `node --test --test-concurrency=1
tests/engine/agents/mcp-bridge-memory.test.js` passed 11/11 parity,
source-failure, limit, cancellation, authority, evidence-identity,
bounded-tail, and constructor-compatibility tests across both engine copies.
`node --test --test-concurrency=1
tests/engine/agents/agent-executor-memory-context.test.js
tests/cosmo23/agent-executor-memory-context.test.cjs` passed 9/9 across
resident, unavailable, cross-layout, and explicitly owned-run paths on
2026-07-10.

---

## Patch 53 — Durable brain transport, bounded providers, and research memory generations

**Vendored production files touched:**
- `cosmo23/server/lib/brain-operation-worker.js`
- `cosmo23/server/lib/brain-operation-routes.js`
- `cosmo23/server/lib/provider-pair-probe.js`
- `cosmo23/server/lib/legacy-query-operation-adapter.js`
- `cosmo23/server/lib/research-compile-provider-adapter.js`
- `cosmo23/server/lib/research-operation-executors.js`
- `cosmo23/server/index.js`
- `cosmo23/lib/provider-execution.js`
- `cosmo23/lib/provider-completion.js`
- `cosmo23/lib/bounded-json.js`
- `cosmo23/lib/gpt5-client.js`
- `cosmo23/lib/anthropic-client.js`
- `cosmo23/lib/codex-responses-client.js`
- `cosmo23/lib/query-engine.js`
- `cosmo23/lib/pgs-engine.js`
- `cosmo23/lib/brain-provider-client-registry.js`
- `cosmo23/lib/memory-sidecar.js`
- `cosmo23/lib/memory-source-adapter.js`
- `cosmo23/engine/src/core/chat-completions-client.js`
- `cosmo23/engine/src/core/guided-mode-planner.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/merge/merge-engine.js`
- `cosmo23/pgs-engine/src/pinned-operation.js`
- `cosmo23/pgs-engine/src/pinned-store.js`

**Integration companion:** `shared/memory-source/jsonl.cjs` now quiesces an
owned JSONL stream before its file handle is closed when a consumer returns
early. This shared source-reader lifecycle is used by the vendored bounded
memory paths but is intentionally not a COSMO fork.

**Problem:** The protected worker could coalesce a noisy provider-activity
event and then describe the resulting missing prefix as a gap through the
operation's latest sequence. That discarded retained provider-terminal and
operation-terminal frames that followed the gap. The events HTTP route could
also stop pulling merely because a normally completed request emitted
`close`, even though its response was still writable. Together those races
made a completed long operation look detached or permanently running.

Provider transports had a second unbounded layer: retained streamed content,
reasoning, tool arguments, citations, and response metadata could grow until
V8 exhausted its heap before the durable result ceiling ran. Several callers
also failed to pass their narrower operation budget. Legacy guided PGS could
combine provider and model fields from different configuration sources, while
retry rows, receipts, and synthesis input needed one exact source/pair and
bounded durable readback throughout.

Finally, normal and merged research saves could publish a compressed state
without first making the base/delta manifest generation authoritative. An
interrupted sidecar write could therefore leave an empty inline shell without
a complete recoverable graph. Early termination of a shared JSONL iterator
could race its still-active stream against file-handle close as well.

**Fix — terminal transport:** `brain-operation-worker.js` now emits an
authenticated gap only for the actually missing prefix through the first
retained sequence minus one, then replays every retained frame in order. It
advances to the record sequence only when no retained event exists.
`brain-operation-routes.js` continues draining after a normally completed
request and stops only for a real aborted/incomplete request or closed
response. The durable status and protected result routes remain terminal
authority; SSE is resumable notification, not a substitute result. Research
compile now reports progress only from the real provider/source lifecycle.
The COSMO server also mounts the shared internal runtime-metrics route so
acceptance can distinguish request-time V8/RSS samples from the process-level
RSS high-water mark without treating a sparse sample as a measured peak.

**Fix — provider and PGS bounds:** GPT Responses, Anthropic, Codex Responses,
and Chat Completions share `provider-execution.js` byte accounting and bounded
JSON helpers. The default retained-output limit is 8 MiB, an explicit trusted
caller ceiling is validated up to the 64 MiB transport maximum, and each
operation passes its narrower bound. Overflow is the non-retryable typed error
`result_too_large`; the
clients preserve exact caller abort identity, cancel readers/iterators, and do
not retry or fall back after overflow. Requested provider/model identity stays
canonical, while any bounded observed model is diagnostic only.

The concrete caller limits are 8 MiB for Direct Query and research compile,
256 KiB for each PGS sweep, 2 MiB for PGS synthesis, and 4 KiB for the
protected provider-pair probe. `query-engine.js`, both PGS layers, the research
compile adapter, and the Home23 synthesis registry propagate those trusted
limits instead of relying on a transport default. The pair probe accepts only
an exact configured pair through the protected client, validates requested and
observed identity, rejects browser-origin access before provider work, and has
its own abortable deadline.

Pinned PGS keeps one immutable source descriptor and exact sweep/synthesis
pair across retries. It retains validated successes, leaves failed/cancelled
partitions pending, bounds SQLite result/listing reads, counts canonical
`{output}` JSON bytes across all durable successes, and publishes receipts
through scratch-confined no-follow/no-replace inode checks. Guided-mode
assessment now passes distinct exact persisted sweep and synthesis pairs and
never infers or cross-combines a provider from a model-only configuration.

**Fix — research memory generations and source cleanup:**
`memory-sidecar.js` captures one frozen memory revision and publishes its
numeric manifest, base, and empty delta before replacing the compressed state
with an empty memory shell. Both `Orchestrator.saveState()` and merged-run
publication call this shared path. If manifest publication fails, the
compressed state retains the complete captured inline graph with degraded
diagnostics, so recovery never depends on a manifest that did not commit.
The COSMO memory-source adapter now carries the already validated projected
manifest, logical canonical target root, and legacy resident fingerprint into
the shared pin. Reopening a legacy projection therefore proves the original
target identity instead of misidentifying requester scratch as the brain.
`shared/memory-source/jsonl.cjs` now awaits stream destruction/quiescence before
closing an owned handle and leaves borrowed handles to their owner.

**Focused verification (offline only):**

- Provider streaming, bounded serialization, terminal identity, overflow,
  abort, and cleanup coverage passed 73/73.
- Exact provider identity, PGS retry/cancellation/receipt bounds, Query mutation
  boundaries, and cross-brain read-only coverage passed 59/59; the standalone
  fixture-free PGS package command passed 84/84.
- Guided-mode exact-pair assessment passed 17/17. The worker, provider-probe,
  and compatibility PGS node suites passed 42/42 in a focused rerun.
- Normal save, merged save, single-capture ordering, and manifest-failure
  recovery passed 4/4 in `research-memory-manifest.test.cjs`.
- Shared base/delta/source-reader coverage, including owned and borrowed early
  iterator return, passed 11/11.

**2026-07-11 canonical retrieval-evidence follow-up:** Protected Direct Query
and PGS now derive `returnedTotals`, `completeCoverage`, and filtering facts
only after the bounded pinned projection or PGS store has opened and completed
its source scan. A provider/child result can no longer supply authoritative
brain identity, health, freshness, watermarks, match outcome, or coerced totals.
The worker reloads those claims through the authenticated pinned source,
requires safe nonnegative exact node/edge counts, binds requester/brain/route,
and rejects disagreement between terminal-level and result-level evidence.
Positive legacy coverage can therefore report the exact degraded
`freshness: unknown` match without turning a degraded zero result into a
`no_match` or `corpus_empty` claim. Failed null-result operations retain an
honest unknown canonical baseline, while any non-null result must carry
consistent retrieval facts. Focused pinned Query projection, Query worker, and
PGS source-pin verification passed 33/33 at commit `8d917ca`; the wider PGS
source/retry/cancellation/store slice passed 36/36. This remains offline proof,
not live rollout acceptance.

The original Patch 53 receipts run through branch commit `b6a44f7`; the
canonical retrieval-evidence follow-up is verified at `8d917ca`. They do not
claim deployment, process restart, live Jerry/Forrest acceptance, MCP runtime
availability, or completion of the full Brain Operations Reliability rollout.

---

## Patch 54 — Atomic memory mutation and persistence parity

**Vendored production files touched:**
- `cosmo23/engine/src/cluster/cluster-aware-memory.js`
- `cosmo23/engine/src/cluster/memory-merger.js`
- `cosmo23/engine/src/core/orchestrator.js`
- `cosmo23/engine/src/ingestion/ingestion-manifest.js`
- `cosmo23/engine/src/memory/network-memory.js`
- `cosmo23/engine/src/memory/summarizer.js`

**Vendored and Home23 parity coverage:**
- `cosmo23/engine/tests/multi-instance/cluster-memory-sync.test.js`
- `cosmo23/engine/tests/single-instance/cluster-memory-regression.test.js`
- `cosmo23/engine/tests/unit/cluster-aware-memory.test.js`
- `cosmo23/engine/tests/unit/ingestion-manifest.test.js`
- `cosmo23/engine/tests/unit/memory-summarizer-mutation-api.test.js`
- `cosmo23/engine/tests/unit/orchestrator-consolidation-honesty.test.js`
- `tests/cosmo23/cluster-aware-memory-persistence.test.cjs`
- `tests/cosmo23/cluster-snapshot-merger-parity.test.cjs`
- the matching root-engine persistence, merger, ingestion, recluster,
  orchestrator, and summarizer tests

**Shared integration companion:**
`shared/memory-source/legacy-snapshot.cjs` now uses the shared
quota-backpressured JSONL writer and bounded cluster counter, reserves exact
manifest growth before zero-growth publication, and reconciles an externally
owned scratch quota after a failed attempt is removed. This code serves both
root and vendored legacy-source projections; it is not a second COSMO fork.

**Problem:** Network-memory callers could mutate live node, edge, access,
embedding, cluster, and consolidation state without advancing the persistence
generation. Delta capture could then mark a graph clean even though an
intervening mutation existed. Import, merge, and legacy load paths also lost
record extensions or typed identities, reserved non-durable cluster IDs,
rewired string endpoints through numeric coercion, or partially mutated maps
before discovering malformed/accessor-backed input. A crash or retry could
therefore publish incomplete memory truth or echo a peer's imported diff.

**Fix — one mutation boundary:** Root and vendored `NetworkMemory` now expose
the same synchronous persistence barrier and generation CAS. Accepted node,
edge, access, activation, embedding, topology, decay, pruning, import, and
removal mutations invalidate the current clean generation exactly once; read-
only and rejected work does not. The barrier rejects async callbacks before
invocation, contains returned thenables, and captures a deep detached frozen
revision without invoking record accessors. Orchestrator, ingestion,
reclustering, and summarization callers use those APIs instead of writing maps
directly. Consolidation stamps the stored summary and exact source lineage
atomically, revalidates source identities after provider work, and removes only
the source records that still match.

**Fix — exact graph and cluster identity:** Imports preserve exact numeric and
string IDs, enumerable record extensions, executable timestamps, and typed edge
endpoints. Allocation floors advance only from accepted live or tombstoned
identities and probe occupied counter collisions without inventing cluster
state. Cluster projections and diff merges inspect descriptors before values,
reject accessors, redirected operations, duplicate/ambiguous identities, and
non-scalar members, then apply a fully detached validated diff atomically.
Imported peer changes suppress outbound echo. Tombstones win set/delete
overlap, node removal cascades incident edge tombstones, and merge round-trips
preserve full node/edge extensions.

**Fix — durable save/load compatibility:** Change-only saves no longer clone
the full graph merely to publish a delta. Legacy save/load remains barrier-
backed, in-place, clean-on-success, and dirty-safe on failure. Its authoritative
cluster envelope must be complete and exact; forged membership, duplicate IDs,
ambiguous omitted endpoints, wrapper payloads, and descriptor hazards fail
before mutation. Empty clusters and exact typed IDs survive a valid reload.
Failed legacy research projection attempts remove their owned bytes and restore
scratch-quota accounting even when the quota signal is already aborted.

**Focused verification (offline only):** On frozen branch commit `11c1994`, the
combined persistence, cluster-merger, mutation-callsite, ingestion,
reclustering, consolidation, and legacy-load slice passed 148/148. The exact
prerequisite matrices then passed A 367/367, B 178/178, and C 244/244 with no
failure, cancellation, or skip. The abort-independent projection cleanup also
passed its 8/8 legacy-research suite and the broader writer/counter/resident/
scratch-quota matrix passed 72/72. These receipts do not claim live engine
restart or Jerry/Forrest acceptance; those remain guarded rollout work.

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
  defaults (`MiniMax-M3`, `nemotron-3-nano:30b`, `kimi-k2.6`).
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
  failure: `claude-opus-4-8` rejects `temperature`. COSMO23's Anthropic clients
  now omit deprecated sampling params for Opus 4.8 and use adaptive thinking.
- **2026-05-03** — Patch 19 added after agent `brain_query` revealed that the
  current catalog query default, `MiniMax-M3`, was inferred as provider
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
- **2026-05-23** — Patch 25 restored the original deep-query answer contract
  for dashboard `full` mode, replaced brittle exact-model query sizing with
  family profiles for current GPT-5, Claude 4, and Grok 4 model IDs, and then
  restored direct Query's bounded node contract so PGS owns thousands-of-nodes
  and full-graph coverage.
- **2026-05-24** — Patch 26 removed `FILE_WRITTEN` log-marker trust from the
  vendored CodeCreationAgent so artifact completion requires real file metadata
  or a discoverable container file.
- **2026-06-21** — Patch 27 added after `jerrysideshows` showed the
  plan/action closure failure: final synthesis marked done with no named
  markdown deliverable, source-required research returning absence prose after
  failed searches, and validated artifacts being dropped on queued completion.
- **2026-06-21** — Patch 28 added the contract-first research governance spine
  after the same run showed the broader beginning/middle/end failure: source
  obligations were prose, execution progress counted failed/no-op activity, and
  exhausted source work did not become a blocked guided run.
- **2026-06-21** — Patch 29 repaired the underlying search/write substrate:
  exact searches were being regenerated/truncated, local SearXNG was not wired
  as the default authoritative backend, DuckDuckGo fallback could masquerade as
  source research, and direct agent file writes could fail at the atomic write
  primitive.
- **2026-06-21** — Patch 30 modernized the source backbone so provider-native
  search, direct URL fetches, SearXNG/Brave, and MCP strict search supplement
  each other while writing route/crossing/status receipts for confirmation.
- **2026-06-21** — Patch 31 added a typed source provider registry for Archive,
  Wayback/CDX, Common Crawl, Wikidata, scholarly APIs, PubMed, feeds, and
  sitemaps, plus contract-level provider hints and metadata-only archive file
  validation.
- **2026-06-21** — Patch 32 connected COSMO23's source provider registry to
  Home23's shared skills runtime, starting with read-only `x-research` search,
  thread, profile, and tweet providers plus contract-level X/Twitter discourse
  hints.
- **2026-06-30** — Patch 33 fixed Interactive tab live-run truth and
  beginning-of-run source-scope planning. Interactive status now prefers the
  live status contract over hydrated snapshots, stale sessions are invalidated
  by run path/session id, local-only contracts cannot carry external provider
  hints, and "avoid primary sources" no longer disables secondary/forum web
  acquisition.
- **2026-06-30** — Patch 34 repaired COSMO23's autonomous execution chain after
  `jerrynotes` reproduced the same systemic failure as `jerrysideshows`:
  reused `task:phaseN` ids let stale agents from old plan generations satisfy
  fresh tasks, guided tier spawning launched dependency-blocked phase agents,
  action agents could finish after text-only "I will..." responses, bytes-only
  acquisition counted as source proof, zero-node PGS prose was treated as local
  knowledge, and the commitment governor wrote `stop_unproductive_run` receipts
  without halting the run. Fixes span `AgentRegistry`, `PlanExecutor`,
  `GuidedModePlanner`, `MetaCoordinator`, `ExecutionBaseAgent`,
  `research-contract`, `SourceProviderRegistry`, `Orchestrator`, and the COSMO
  status contract. Focused verification: 211 Mocha tests plus 6 status-contract
  node tests passed; COSMO-specific node regressions passed with 53 tests.
- **2026-06-30** — Patch 35 completed the broad COSMO23 stabilization sweep
  after the full engine suite exposed remaining autonomy-support failures.
  Specialist execution agents had been stripped down to generic domain prompts,
  so Automation/DataPipeline/Infrastructure now carry concrete tool vocabulary,
  safety discipline, and action patterns in their base `getDomainKnowledge()`
  prompts. SpawnGate now scores prior mission/reason/finding fields separately
  and blocks a non-guided duplicate when high-confidence memory and productive
  result history both match. Telemetry writes lifecycle events to the compatible
  `events.log` path and creates its log directory before flushing. Document
  Feeder startup now awaits chokidar readiness before returning, eliminating
  immediate-drop races. RedisStateStore gained configurable key/channel
  namespaces so tests and clustered runs do not collide with live `cosmo:*`
  state; heartbeat pub/sub now reads MessagePack payloads via `messageBuffer`.
  Regression tests were repaired for the current memory quality gate, Redis
  isolation, structural agent setup, API-backed skip behavior, and idle MCP
  smoke checks. Verification passed: `npm test` (1005 unit + 75 integration),
  COSMO root/server node regressions (59), `test:single-instance`,
  `test:multi-instance` (8), `test:acceptance` (56), `test:agents` (15), and
  `test:agents:execution` with 1 local test passing / 10 provider-backed tests
  pending because no real OpenAI API key was available in the shell; `test:mcp`
  exits cleanly with an explicit idle-runtime skip when no `runtime/state.json.gz`
  exists.
- **2026-06-30** — Patch 36 added the research acceptance layer that Patch 35
  deliberately did not prove. Task completion is now hard-gated through a shared
  validator: expected files must exist, parse, and have substance; source-
  required tasks must carry source evidence; and both queue and filesystem/Redis
  backends reject unverified `DONE` transitions. The source provider registry now
  broadens source-required research into a route mesh instead of leaving generic
  tasks on a single route, with explicit fan-anecdote routing through web search
  plus Archive.org item/review routes. Interactive/query status now carries an
  artifact-first filesystem inventory so the UI and LLM distinguish source URLs,
  route receipts, query exports, raw-anecdote records, extracted records, invalid
  JSON, and missing named deliverables before graph synthesis. Verification
  passed: focused Mocha source/completion/contract suite (52), server artifact
  and status node tests (9), syntax checks for patched COSMO files, and a live
  Archive.org probe against two `jerrysideshows` identifiers that wrote
  `outputs/acceptance-probe/archive-org-comments-live-probe.json`; the completion
  validator accepted that source-backed probe while rejecting the missing
  `@outputs/raw-anecdotes/archive-org-comments.json` deliverable.
- **2026-06-30** — Patch 37 closed the verified execution loop. Strict guided
  Archive.org acceptance now plans exact phases, acquires typed route receipts,
  validates/synthesizes named artifacts, advances milestones immediately after
  verified task completion, treats persisted completed plans as lifecycle
  completion, and stops/clears the active run after proof. Live proof:
  `cosmo23-acceptance-archive-reviews-closeout-20260630215506` passed with
  `problems: []` and `/api/status` idle.
- **2026-06-30** — Patch 38 aligned dashboard query run-root resolution with
  Home23-managed launches by honoring `COSMO_RUNS_PATH` and defaulting to
  `cosmo23/runs` when present. The completed acceptance run was queryable from
  the always-on brain route and answered from artifact files/routes.
- **2026-06-30** — Patch 39 tightened Archive.org negative receipts. Empty
  review arrays now emit per-identifier `archive_review_status` candidates, and
  no-review completion requires both metadata-route and review-route proof.
  Live proof `cosmo23-acceptance-archive-reviews-negative-receipts-20260630221609`
  passed with `problems: []` and queryable artifact-backed negative status.
- **2026-06-30** — Patch 40 generalized route-level research acceptance beyond
  Archive.org and hardened artifact-first query answers. Research evidence now
  carries required, attempted, successful, accepted-empty, and failed source
  routes; completion fails when required `sourceProviderHints` or receipt-declared
  `required_routes` were never attempted, or when they failed without an accepted
  receipt. Query cache keys now include artifact fingerprints and prior-context
  hashes, and follow-up answers treat prior replies as historical context below
  the current artifact inventory. Both public and legacy dashboard query routes
  pass artifact inventory/fingerprint into the query engine, while interactive
  `brain_query` now prefixes graph-memory results with the current artifact
  substrate and receipt counts. Verification passed: focused route/completion
  Mocha suite (80), artifact/query cache node tests (5), interactive artifact
  grounding test, and syntax checks for patched COSMO query/server/validator
  files.
- **2026-06-30** — Patch 41 moved source-route failure detection earlier in
  the autonomous loop. `source_backbone_status.json` now records attempted,
  accepted, accepted-empty, missing-required, and failed-required routes, and
  sets route-specific repair actions instead of generic continue/stop signals.
  Artifact audit reads blocked source-backbone receipts, and the commitment
  governor closes spawn budgets with a `repair_source_routes` action before the
  run spends more cycles on synthesis or unrelated agents. Verification passed:
  research/completion/audit/governor/orchestrator Mocha suite (89) plus syntax
  checks for the patched agent, audit, governor, validator, and orchestrator
  files.
- **2026-06-30** — Patch 42 repaired the first-cycle guided execution failure
  reproduced by `jerry-side-project-anecdotes-live-202606302304`. Explicit
  `PHASE N - Title` headers without trailing colons are now parsed as
  structured phases, PlanExecutor starts and assigns the first ready task in the
  same tick, guided-exclusive runs yield after plan-executor service instead of
  spending cycles on background introspection/quantum/forking while artifacts
  are missing, and launcher `enable_sleep=false` now emits short non-adaptive
  polling. Verification passed: focused guided-planner and PlanExecutor Mocha
  suite (47), launcher config node tests (4), and syntax checks for the patched
  planner, executor, orchestrator, and launcher config generators.
- **2026-07-01** — Patch 43 repaired evidence acquisition quality in the Jerry
  Garcia side-project anecdote run. Research query sanitization now rewrites
  instruction-style source missions into targeted Jerry side-project searches,
  direct URL fetches extract readable page text instead of raw HTML head bytes,
  candidate extraction rejects status-only/raw-HTML excerpts, and source-required
  local-search fallbacks can use DuckDuckGo when local search is otherwise blind.
  The source contract also keeps Archive-only routes out of secondary/forum/social
  phases while still preserving optional Home23 `x-research` attempts.
- **2026-07-01** — Patch 44 hardened the middle/end of guided research
  execution. Artifact-only evidence reports are routed to the IDE/file-writing
  agent instead of a non-writing document phase, local artifact synthesis phases
  carry `required:false` research contracts, completion retry prompts include the
  validator failure reason, and markdown report validation now checks requested
  section headings such as confirmed anecdotes, negative receipts, useful routes,
  failed/empty routes, and next source families before a task can become `DONE`.
- **2026-07-01** — Patch 45 proved the repaired loop with a real Jerry
  side-project anecdotes run:
  `jerry-side-project-anecdotes-live-202607010014` / brain
  `970a2f4b2653d663`. The run produced
  `outputs/raw-anecdotes/archive-org-comments.json` with two extracted
  Archive.org review records plus accepted no-review receipts for the LOM and
  NRPS identifiers, `outputs/raw-anecdotes/forum-social-candidates.json` with
  nine direct/Wayback blog candidates from Lost Live Dead and JGMF, and
  `outputs/jerry-side-project-anecdotes.md` with the required evidence report
  sections. All phase tasks reached verified `DONE`, the run completed, and the
  artifact inventory reported zero invalid JSON files.
- **2026-07-01** — Patch 46 fixed completed-run Query readback for structured
  research artifacts. `run-artifact-inventory` now adds an authoritative
  structured truth section to `artifactContext`: exact raw-artifact counts,
  Archive identifier status receipts, extracted entries, forum/blog candidates,
  route outcomes, and markdown report headings/previews. This prevents Query
  from confusing source URL counts with candidate counts or missing named
  candidates such as the Legion of Mary / Lucky Strike Lost Live Dead source.
  Verification passed: `node --test --test-concurrency=1
  cosmo23/server/lib/run-artifact-inventory.test.js`, live artifact-context
  probe for `jerry-side-project-anecdotes-live-202607010014`, targeted restart
  of `home23-cosmo23`, and the completed-run query now reports two extracted
  Archive records, nine forum/blog candidates, Legion of Mary present, and zero
  invalid JSON files.
- **2026-07-10** — Patch 47 completed its two-part authority boundary: the
  canonical catalog supplies server-derived identity/lifecycle/mutation truth,
  and the internal COSMO worker now enforces fresh one-use capabilities, exact
  executor dispatch, digest-bound process-local source pins, per-operation
  cancellation, bounded resumable events, validated provider correlation,
  terminal result retention, and release-once cleanup. Canonical stored-result
  export remains dashboard-owned; this does not claim the later source,
  provider, or agent-tool rollouts are complete.
- **2026-07-10** — Patch 47's protected query/PGS worker was activated in the
  production COSMO server ahead of broad body parsing, using the canonical
  provider registry and exact model-pair QueryEngine. Worker hard deadlines are
  now independently armed and typed, and scoped SIGINT/SIGTERM shutdown aborts
  and joins active operations.
- **2026-07-10** — Patch 50 completed the durable research-operation backend.
  The concrete run adapter and single prepared-run launcher now feed all six
  protected research executors; exact configured provider/model resolution,
  pinned read-only intelligence, requester-owned atomic compile output,
  canonical owned-run targets, and production worker registration are covered
  by the three focused command receipts in the patch entry. This is backend
  verification only and does not claim Task 8 live acceptance.
- **2026-07-10** — Patch 51 made the vendored MCP HTTP runtime source-honest.
  Health remains unavailable until a real canonical memory-source readiness
  check completes, missing MCP SDK dependencies fail startup instead of yielding
  a false-green listener, and system/search/statistics/graph tools use bounded
  agent-scoped source adapters rather than decompressing the legacy full state.
  The per-agent `COSMO_RUNTIME_DIR` contract is now honored ahead of the legacy
  unified-server runtime path. Focused protocol, readiness, bounded-snapshot,
  and canonical-source tests pass for both engine copies.
- **2026-07-10** — Patch 52 moved the agent-facing in-process MCP bridge onto
  the same canonical bounded memory-source contract. Empty inline state shells,
  missing source context, and read failures can no longer become authoritative
  zero-node answers, and graph requests can no longer use `limit=0` to request
  the whole graph. Both production executor families now inject exact trusted
  resident or explicitly owned-run source context; the root and vendored COSMO
  executor-context regressions are registered in the aggregate test command.
- **2026-07-11** — Patch 53 closed the post-worker reliability gaps in the
  vendored brain path: retained events now replay after the exact missing gap,
  provider streams and every operation caller enforce typed byte ceilings,
  protected probes and guided PGS preserve exact configured pairs, research
  saves publish recoverable manifest generations, and early source iteration
  quiesces before an owned file handle closes. Its follow-up binds Direct Query
  and PGS retrieval totals and match outcomes to the opened pinned source rather
  than child/provider assertions. This records offline focused verification
  only; live rollout acceptance remains pending.
- **2026-07-11** — Patch 54 put root and vendored memory mutation, cluster
  merge, consolidation, and legacy save/load paths behind the same atomic
  persistence contract. Exact typed identities, extensions, tombstones,
  generations, source lineage, and failed-projection quota accounting now
  survive save, import, merge, retry, and reload without partial publication or
  outbound echo. Offline A/B/C and focused persistence matrices are green;
  live rollout acceptance remains pending.
