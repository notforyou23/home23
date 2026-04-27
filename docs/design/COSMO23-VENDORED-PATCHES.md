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

There are currently **12 patches** in this file. Patches 1–3 are the config/key
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
- defaults the Brains library to `Local`
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
`home23-cosmo23`: Brains defaulted to `Local (5)`, selected `trail-running`
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
