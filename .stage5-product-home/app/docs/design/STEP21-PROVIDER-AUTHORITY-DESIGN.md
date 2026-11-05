# Step 21: Provider Authority — Home23 Owns All Provider Configuration

**Date:** 2026-04-13
**Status:** Design approved, ready for implementation

## Problem

Home23 bundles three systems that each have their own provider/API key configuration:
- **Home23 Settings UI** — API key inputs, OAuth sign-in cards, connectivity tests
- **Evobrew** — 6-step setup wizard, Live Settings Panel with per-provider API key fields, OAuth terminal-launch buttons
- **Cosmo23** — setup/bootstrap UI, provider configuration in its web interface

This creates confusion, duplication, and fragility:
- Users encounter provider setup in three different places
- Cosmo23's OAuth broker (PKCE, Prisma, encrypted token storage) works — but the wiring from Home23 is broken: `ENCRYPTION_KEY` and `DATABASE_URL` aren't flowing via PM2 env vars
- Two separate encryption keys get generated (one by `cosmo23-config.js` in config.json, one by `generate-ecosystem.js` in secrets.yaml) and they don't match
- `home23 init` overwrites secrets.yaml with a fixed template that clobbers the cosmo23 encryption key section
- Prisma database doesn't exist at the expected path
- Evobrew's setup wizard runs on first boot even though all keys arrive via PM2 env vars
- Init prompts for API keys in the terminal when OAuth is the preferred path and the web UI is the right place for setup

## Design Principle

**Home23 is the single authority for all provider configuration.** Cosmo23 and evobrew are consumers — they receive keys via PM2 environment variables and never manage them.

- Home23 owns: "which providers are configured and what credentials they use"
- Cosmo23 owns: "which model to use for each research phase"
- Evobrew owns: "which model to chat/query with"

The cosmo23 and evobrew directories bundled inside home23/ are Home23's copies. They are always Home23-managed. Standalone versions of evobrew or cosmo23 installed elsewhere are completely separate. The `HOME23_MANAGED` env var (set in ecosystem.config.cjs) is an implementation mechanism to keep vendored code update-safe — not a conceptual choice about modes.

## Section 1: Single Encryption Key, Single DB Path, Always Ready

### Problem
Two competing key generation sites:
- `cosmo23-config.js` generates a key in `cosmo23/.cosmo23-config/config.json` under `security.encryption_key`
- `generate-ecosystem.js` generates a separate key in `secrets.yaml` under `cosmo23.encryptionKey`

Right now the cosmo23 config.json has a key, but secrets.yaml has no cosmo23 section, so the ecosystem passes empty `ENCRYPTION_KEY` to PM2. OAuth token storage fails on startup.

### Fix
**One key, one source:**

1. `home23 init` generates the encryption key (`crypto.randomBytes(32).toString('hex')`), writes it to `secrets.yaml` under `cosmo23.encryptionKey`.
2. `cosmo23-config.js` reads from `secrets.yaml` — never generates its own. Writes the same key to cosmo23's config.json for the bootstrap path.
3. `generate-ecosystem.js` reads from `secrets.yaml` — never generates its own. Passes it via PM2 env as `ENCRYPTION_KEY`.

One key flows everywhere: secrets.yaml → cosmo23 config.json → PM2 env → cosmo23 process.

### Init changes
- Init creates secrets.yaml by **merging**, not overwriting. If the file exists, read it, merge in changes, preserve everything else. If it doesn't exist, create it with just the cosmo23 section.
- Init creates the Prisma DB at `cosmo23/prisma/dev.db` and verifies it exists before proceeding.
- Init calls `seedCosmo23Config()` and `generateEcosystem()` at the end — so by the time the user runs `start`, everything is wired.

### Result
Fresh clone → `home23 init` → encryption key, Prisma DB, cosmo23 config, and ecosystem env vars are all ready before the first `start`.

## Section 2: Home23 Settings UI is the Only Provider Interface

### Home23 Settings → Providers
The single place you configure providers. Already exists, already works:
- API key input fields with test connectivity
- OAuth sign-in cards (Anthropic + OpenAI Codex) proxying to cosmo23's PKCE endpoints
- Sync pipeline: secrets.yaml → generateEcosystem() → PM2 env → restart processes

No functional changes to this UI. It just becomes the **only** provider configuration interface.

### Evobrew — Provider UI Gutted
The bundled evobrew's provider configuration surfaces are removed/replaced under Home23:

1. **Setup wizard** (`lib/setup-wizard.js`): Skipped entirely when `HOME23_MANAGED` env var is set. Evobrew boots straight to the IDE. Keys arrive via PM2 env vars.

2. **Live Settings Panel** (`public/js/ui-live-settings.js`): All per-provider API key input fields (OpenAI, Anthropic, xAI, Ollama Cloud, Ollama) with their Test/Save/Disable buttons are blown away when `HOME23_MANAGED`. Replaced with a clean read-only provider status grid: green/red dots showing which providers are connected (derived from `/api/providers/models` — if a provider returns models, it's connected). One line: "Providers managed by Home23 — [open Settings]" linking to the dashboard Settings page.

3. **Provider setup API routes** (server.js): PUT and DELETE routes for provider keys return 403 when `HOME23_MANAGED`. GET routes (status, model catalog) stay — they're read-only and the model picker needs them.

### Evobrew — What Stays Untouched
- **Runtime Manager Modal** (`ui-runtime-settings.js`) — model curation: favorites, catalog browse, pin/unpin, set defaults
- **Main chat model selector** (`#ai-model-select`) + "Manage" button
- **Query tab model selector**
- **All provider adapters** — code that calls Anthropic/OpenAI/etc APIs, reading keys from env vars
- **Editor settings** (theme, font, tab size, etc.)

### Cosmo23 — Provider UI Suppressed
Detected via `HOME23_MANAGED` env var in ecosystem.config.cjs:

1. **`/api/setup/status`**: Reports all providers with env-var keys as configured. Setup banner never appears.
2. **Provider key fields in UI**: Hidden. Read-only status + "Managed by Home23" link.
3. **Model pickers for research phases**: Untouched — cosmo23's domain.
4. **OAuth API endpoints**: Stay active — Home23 proxies to them.

## Section 3: Web Onboarding — Provider Setup as Step 2

### Current State
Welcome screen → click "Get Started" → lands on Settings page. User figures out Providers and Agents tabs themselves.

### New Guided Onboarding
The existing Settings tab content restructured as a wizard flow:

1. **Welcome screen** — same as today, "Get Started" button
2. **Providers step** — OAuth cards prominent (Anthropic, OpenAI Codex — these are the recommended paths). "Or enter API keys manually" collapsed below. Test connectivity inline. Gate: at least one working provider required to proceed.
3. **Create Agent step** — existing agent wizard (name, owner, model, Telegram token). Model picker only shows models from providers configured in step 2.
4. **Start** — launches the agent, switches to dashboard home screen.

### Init CLI Changes
Init stops prompting for API keys entirely. It does the plumbing (deps, build, encryption key, Prisma DB, ecosystem) and tells you to open the browser. The web onboarding handles provider setup.

## Section 4: The Wiring — What Flows Where

### Single Flow, One Direction
```
User configures in Settings UI
    ↓
secrets.yaml (SOT for all credentials)
    ↓
generateEcosystem() → ecosystem.config.cjs
    ↓
PM2 env vars → every process gets what it needs
```

### PM2 Environment Variables

| Env Var | Recipients | Source in secrets.yaml |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | engine, dashboard, harness, evobrew, cosmo23 | `providers.anthropic.apiKey` |
| `OPENAI_API_KEY` | engine, dashboard, harness, evobrew, cosmo23 | `providers.openai.apiKey` |
| `OLLAMA_CLOUD_API_KEY` | engine, dashboard, harness, evobrew, cosmo23 | `providers['ollama-cloud'].apiKey` |
| `XAI_API_KEY` | engine, dashboard, harness, evobrew, cosmo23 | `providers.xai.apiKey` |
| `ENCRYPTION_KEY` | cosmo23 | `cosmo23.encryptionKey` |
| `DATABASE_URL` | cosmo23 | `file:<home23>/cosmo23/prisma/dev.db` (computed) |
| `HOME23_MANAGED` | cosmo23, evobrew | `'true'` (always set) |

### OAuth Token Lifecycle (unchanged, just wired correctly)

1. User clicks "Sign in" in Home23 Settings
2. Settings API proxies to cosmo23's OAuth endpoints
3. cosmo23 does PKCE, stores encrypted token in Prisma DB
4. Settings API calls cosmo23's `/api/oauth/*/raw-token`, gets plaintext token
5. Writes to `secrets.providers.<provider>.apiKey`, sets `oauthManaged: true`
6. Calls `generateEcosystem()` → new ecosystem with updated key
7. Restarts PM2 processes with `--update-env`
8. 30-minute poller catches cosmo23-side token refreshes, repeats 5-7

### What Doesn't Change
- cosmo23 PKCE implementation — untouched
- Settings API OAuth endpoints — untouched
- 30-minute refresh poller — untouched
- Raw-token admin endpoints — untouched
- How engine, harness, and evobrew read keys from env — untouched

## Section 5: Evobrew and Cosmo23 — Detailed Changes

### Evobrew Files Affected

| File | Change |
|---|---|
| `lib/setup-wizard.js` | Skip entirely when `HOME23_MANAGED` env var is set |
| `public/js/ui-live-settings.js` | Replace provider key cards with read-only status grid + "Managed by Home23" link |
| `server/server.js` (setup routes) | PUT/DELETE provider routes return 403 when `HOME23_MANAGED`. GET routes unchanged. |
| `public/index.html` | No changes — model selector and Runtime Manager button untouched |
| `public/js/ui-runtime-settings.js` | No changes — model curation UI stays |
| `server/providers/adapters/*` | No changes — read keys from env as before |

### Cosmo23 Files Affected

| File | Change |
|---|---|
| `server/index.js` | Add `HOME23_MANAGED` env var check to `/api/setup/status` response |
| UI files (if cosmo23 has provider config screens) | Hide key fields when `HOME23_MANAGED`, show "Managed by Home23" |

### Vendored Patch Tracking
All changes to cosmo23/ must be documented in `docs/design/COSMO23-VENDORED-PATCHES.md` and re-verified after any `home23 cosmo23 update`. Evobrew changes similarly tracked for `home23 evobrew update`.

## Section 6: Init — Silent Plumbing, No Key Prompts

### New Init Flow

1. **Prerequisites check** — Node 20+, PM2, Python 3, Ollama. Unchanged.
2. **Install dependencies** — engine, harness, evobrew, cosmo23, prisma generate. Unchanged.
3. **Create Prisma DB** — at `cosmo23/prisma/dev.db`. Verify exists. Clear error if fails.
4. **Generate encryption key** — `crypto.randomBytes(32).toString('hex')`. Merge into secrets.yaml under `cosmo23.encryptionKey`. If secrets.yaml exists, read and merge. If not, create with just cosmo23 section.
5. **Seed cosmo23 config** — `seedCosmo23Config()` reads encryption key from secrets.yaml, writes to cosmo23's config.json.
6. **Generate ecosystem (if agents exist)** — calls `generateEcosystem()` which wires ENCRYPTION_KEY, DATABASE_URL, HOME23_MANAGED into PM2 env. On first-ever init, no agents exist yet so this is a no-op — ecosystem generation happens when the first agent is created via the web onboarding wizard (agent create already calls `generateEcosystem()`). The encryption key and cosmo23 config are ready and waiting.
7. **Build TypeScript** — unchanged.
8. **Python venv for MarkItDown** — unchanged.
9. **Done** — tells user to run `home23 start` and open browser.

### What's Removed
- All API key prompts (ollama-cloud, anthropic, openai, xai). Gone.
- Fixed-template secrets.yaml writer that clobbers the file. Replaced with merge.

### secrets.yaml After Fresh Init
```yaml
# Home23 secrets — API keys and tokens
# This file is gitignored. Never commit it.

cosmo23:
  encryptionKey: "<64 hex chars>"
```

No empty provider entries. Keys arrive later via web onboarding.

### secrets.yaml After Web Onboarding + OAuth
```yaml
cosmo23:
  encryptionKey: "<64 hex chars>"

providers:
  anthropic:
    apiKey: "sk-ant-oauth..."
    oauthManaged: true
  openai:
    apiKey: "<codex JWT>"
    oauthManaged: true
```

Written by Settings API's `syncOAuthTokenToSecrets()`, which does proper yaml merge.

## Files Changed (Complete List)

### Home23 Core
| File | Change |
|---|---|
| `cli/lib/init.js` | Remove API key prompts, add encryption key generation, merge secrets.yaml, call seedCosmo23Config + generateEcosystem |
| `cli/lib/generate-ecosystem.js` | Add `HOME23_MANAGED: 'true'` to evobrew + cosmo23 env blocks. Remove self-contained encryption key generation (read from secrets.yaml only). |
| `cli/lib/cosmo23-config.js` | Read encryption key from secrets.yaml instead of generating own. Fail clearly if not found. |
| `engine/src/dashboard/home23-settings.js` | Restructure Settings page as guided onboarding wizard (welcome → providers → agent create → start) |
| `engine/src/dashboard/home23-settings.html` | Wizard step HTML structure |
| `engine/src/dashboard/home23-welcome.html` | Point "Get Started" to onboarding wizard |

### Evobrew (vendored)
| File | Change |
|---|---|
| `lib/setup-wizard.js` | Skip when HOME23_MANAGED |
| `public/js/ui-live-settings.js` | Replace provider cards with read-only status + "Managed by Home23" link |
| `server/server.js` | PUT/DELETE provider routes return 403 when HOME23_MANAGED |

### Cosmo23 (vendored)
| File | Change |
|---|---|
| `server/index.js` | HOME23_MANAGED check on `/api/setup/status` |

### Documentation
| File | Change |
|---|---|
| `docs/design/COSMO23-VENDORED-PATCHES.md` | Add Patch 5: HOME23_MANAGED provider suppression |
| `README.md` | Update install flow to reflect no-key init + web onboarding |
| `CLAUDE.md` | Update architecture section with provider authority model |
