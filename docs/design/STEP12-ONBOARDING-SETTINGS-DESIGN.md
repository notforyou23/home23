# Step 12: Onboarding & Settings UI

The last sub-project. Replaces CLI prompts (`home23 init`, `agent create`) with a web interface built into the dashboard. After first-run onboarding, becomes the permanent Settings tab for managing the entire Home23 system.

## Architecture

### Entry Points

- **First run (no agents):** `/home23` shows a welcome screen with Home23 branding and a "Get Started" button that activates the Settings tab, Providers sub-tab focused.
- **Normal run:** Settings tab in the dashboard tab bar (gear icon), alongside Home, Intelligence, COSMO, evobrew.

### Settings Tab — Nested Sub-tabs

Full-page tab (no modals). Four sub-tabs within Settings:

#### 1. Providers & Keys

Manages API keys for all providers. Reads from / writes to `config/secrets.yaml`.

| Field | Provider | Notes |
|-------|----------|-------|
| Ollama Cloud API key | `ollama-cloud` | Required for most default models |
| Anthropic API key | `anthropic` | Claude models |
| OpenAI API key | `openai` | GPT models |
| xAI API key | `xai` | Grok models |

Behaviors:
- Keys masked by default (show/hide toggle per field)
- Existing keys shown as `sk-proj-...7x4Q` (first 8 + last 4 chars)
- "Test Connection" button per provider — hits the provider's models endpoint
- Connection status indicator (green/red dot) per provider
- Explicit **Save** button at bottom

#### 2. Agents

Lists existing agents as cards. Each card shows: name, display name, status (running/stopped), default model, ports.

**Agent cards:**
- Click to expand inline — shows editable fields (display name, owner, timezone, model, provider, Telegram config)
- Status badge (green=running, red=stopped, gray=never started)
- Start/Stop button per agent
- Delete button (with confirmation)

**"Create Agent" button** launches a 3-step wizard:

**Step 1 — Identity:**
- Agent name (validated: `/^[a-z0-9][a-z0-9-]*$/`, checked for uniqueness)
- Display name (defaults to capitalized agent name)
- Owner name (defaults from existing agents if any)
- Timezone (auto-detected, editable)

**Step 2 — Channel:**
- Telegram bot token (required, from BotFather)
- Owner Telegram ID (optional)
- Link to BotFather instructions

**Step 3 — Model:**
- Default provider (dropdown from configured providers)
- Default model (dropdown filtered by selected provider's available models)
- Ports shown read-only (auto-assigned)

**On completion:**
- Creates `instances/<name>/` directory structure
- Writes `config.yaml`, `feeder.yaml`
- Generates identity files from templates (SOUL.md, MISSION.md, etc.)
- Adds bot token to `secrets.yaml`
- Regenerates `ecosystem.config.cjs`
- Shows success screen with agent card and "Start Agent" button

#### 3. Models

Manages the model catalog from `config/home.yaml`.

**Sections:**
- **Defaults:** Default provider and model for chat
- **Aliases:** Table of alias -> {provider, model} mappings. Add/edit/remove rows.
- **Provider Models:** Per-provider list of available models (from `providers.*.defaultModels`)

Explicit **Save** button.

#### 4. System

Advanced configuration.

**Sections:**
- **Ports:** Evobrew port, COSMO 23 ports (app, websocket, dashboard, mcp)
- **Embeddings:** Provider fallback chain with model/endpoint/dimensions per entry
- **Chat Defaults:** Max tokens, temperature, history budget, session gap
- **Actions:**
  - "Install Dependencies" button (runs npm install across all dirs)
  - "Build TypeScript" button (runs npx tsc)
  - Status/output area for action results

Explicit **Save** button (for config changes, not actions).

## API Endpoints

All under the dashboard server, prefixed `/home23/api/settings/`.

### Providers
- `GET /home23/api/settings/providers` — returns provider config with masked keys
- `PUT /home23/api/settings/providers` — saves keys to secrets.yaml, preserves agent tokens

### Agents
- `GET /home23/api/settings/agents` — list agents with status (queries PM2)
- `POST /home23/api/settings/agents` — create agent (full wizard payload)
- `PUT /home23/api/settings/agents/:name` — update agent config
- `DELETE /home23/api/settings/agents/:name` — remove agent (stops if running, deletes instance dir)
- `POST /home23/api/settings/agents/:name/start` — start agent via PM2
- `POST /home23/api/settings/agents/:name/stop` — stop agent via PM2

### Models
- `GET /home23/api/settings/models` — model catalog, aliases, defaults
- `PUT /home23/api/settings/models` — save to home.yaml

### System
- `GET /home23/api/settings/system` — system config (ports, embeddings, chat defaults)
- `PUT /home23/api/settings/system` — save to home.yaml
- `POST /home23/api/settings/system/install` — run npm install (SSE for progress)
- `POST /home23/api/settings/system/build` — run npx tsc (SSE for progress)

### Detection
- `GET /home23/api/settings/status` — returns `{ hasAgents, agentCount, initialized }` — used by welcome screen to decide what to show

## Files

| File | Purpose |
|------|---------|
| `engine/src/dashboard/home23-welcome.html` | First-run welcome screen |
| `engine/src/dashboard/home23-settings.html` | Settings tab markup |
| `engine/src/dashboard/home23-settings.css` | Settings styles (extends `--h23-*` tokens) |
| `engine/src/dashboard/home23-settings.js` | Client logic: sub-tabs, forms, wizard, API calls |
| `engine/src/dashboard/server.js` | New routes (settings API + page serving) |

## Welcome Screen

Shown at `/home23` when `GET /home23/api/settings/status` returns `hasAgents: false`.

Content:
- Home23 logo and name
- Tagline: "Installable AI operating system"
- Brief one-liner about what it does
- "Get Started" button — switches to Settings tab, Providers sub-tab

Uses the existing `--h23-*` design tokens. Centered layout, minimal.

## Detection Logic

The dashboard HTML (`home23-dashboard.html`) fetches `/home23/api/settings/status` on load:
- If `hasAgents: false` — shows welcome screen, hides other tabs
- If `hasAgents: true` — normal dashboard with Settings tab in the tab bar

## Styling

- Extends existing `home23-dashboard.css` design tokens (`--h23-*`)
- Same dark theme, font stack, border radius conventions
- Form inputs: dark background (`--h23-bg-card`), subtle border (`--h23-border`), focus glow with `--h23-accent`
- Sub-tab bar: same style as main tab bar but slightly smaller
- Wizard: steps shown as numbered breadcrumbs, active step highlighted
- Cards: same `.h23-tile` base styling as dashboard tiles
- Save button: primary accent color (`--h23-tab-active`)
- Status dots: green (`--h23-green`), red (`--h23-red`), gray (`--h23-text-muted`)

## Config File Handling

Settings API reads/writes YAML files directly:
- `config/home.yaml` — providers (structure), models, system config
- `config/secrets.yaml` — API keys, bot tokens
- `instances/<name>/config.yaml` — per-agent config

Uses `js-yaml` for parsing and serialization (already a dependency). Writes preserve structure where possible; full rewrite on save (YAML round-trip is lossy for comments, but these files are machine-managed after onboarding).

## PM2 Integration

Agent start/stop uses the same logic as `cli/lib/pm2-commands.js`:
- `pm2 start ecosystem.config.cjs --only <process-names>`
- `pm2 stop <process-names>`
- `pm2 jlist` for status queries

The `generate-ecosystem.js` module is called after agent create/delete to regenerate `ecosystem.config.cjs`.

## Scope Boundaries

**In scope:**
- Everything the CLI `init` and `agent create` commands do, via web UI
- Editing existing agent configs
- Starting/stopping agents
- Model catalog management
- System config editing

**Out of scope:**
- Evobrew or COSMO internal settings (they have their own UIs)
- Identity file editing (SOUL.md etc. — that's evobrew's job)
- Brain management (that's the dashboard Home/Intelligence tabs)
- Log viewing (use `home23 logs` or PM2 directly)
