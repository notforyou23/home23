# CLAUDE.md — Frontend UI/UX (public/)

This file provides guidance to Claude Code (claude.ai/code) when working on the COSMO 2.3 frontend.

---

## Technology Stack

**No framework. No build step. No npm.** The frontend is plain HTML + vanilla JavaScript + a single CSS file, served directly as static files.

- `public/index.html` — single HTML document; contains all six view sections in the DOM at once
- `public/styles.css` — complete design system (Instrument Serif, DM Sans, JetBrains Mono; petrol accent; warm parchment ground)
- `public/app.js` — one ES6 class (`CosmoStandaloneApp`) that controls everything except query/map/intel logic
- `public/js/query-tab.js` — self-contained query/research module with PGS dual model selectors
- `public/js/brain-map.js` — 3D knowledge graph visualization (IIFE, exposes `window.BrainMap`)
- `public/js/intelligence-tab.js` — brain data explorer with 8 sub-tabs (IIFE, exposes `window.IntelligenceTab`)

Script load order: `3d-force-graph` CDN → `brain-map.js` → `intelligence-tab.js` → `query-tab.js` → `app.js`

State management is entirely in-memory inside the `CosmoStandaloneApp` class instance (assigned to `window.cosmoStandaloneApp`). The query tab, brain map, and intelligence tab maintain their own module-level state. Query history is persisted to `localStorage` keyed by brain ID.

Brain selectors in Query, Map, and Intelligence tabs are synced bidirectionally with the Brains view selection via `syncSelectedBrainInto*()` methods and `populateBrainSelect()` shared helper (groups by `sourceLabel` in `<optgroup>` elements).

---

## View Architecture

All six view sections exist in the DOM simultaneously. Visibility is controlled by toggling the `active` class. Only the active view has `display: block`.

```
#view-launch        — new run setup + provider configuration + brain directories
#view-brains        — brain library sidebar (scroll-contained, compact rows, location dropdown) + detail panel
#view-watch         — live execution monitoring (WebSocket events + console log polling)
#view-query         — query/research interface with PGS dual model selectors
#view-map           — 3D force-directed brain map (own brain selector, full-width dark canvas)
#view-intelligence  — brain data explorer (sidebar sub-tabs + content area, own brain selector)
```

### Tab Switching — `switchView(viewName)`

Called from nav button clicks (`.top-nav-btn[data-view]`), `[data-view-target]` buttons, and programmatically after launch/continue. Side effect: switching to `'watch'` starts log polling; switching away stops it. `applyInitialView()` goes to `'brains'` if brains exist, otherwise `'launch'`.

---

## Launch View (`#view-launch`)

### Layout

Two-column grid (`.launch-layout`): left = launch form (~1.3fr), right = Providers & Models setup panel (fixed ~320–420px). Collapses to single column at 1200px.

### Launch Form (`#launch-form`)

Fields read by `collectFormSettings('launch-form')` which iterates `FORM_FIELD_TYPES` (defined at top of `app.js`, lines 1–29). All field names match exactly.

**Main fields:** `topic`, `context`, `runName`, `explorationMode` (guided|autonomous), `analysisDepth`, `cycles` (default 80), `maxRuntimeMinutes`, `reviewPeriod` (default 20), `maxConcurrent` (default 4), `primaryModel`, `fastModel`, `strategicModel`.

**Advanced Run Settings** — inside `<details class="section-disclosure">`: `localLlmBaseUrl`, `searxngUrl`, and 13 boolean toggle chips (`enableWebSearch`, `enableSleep`, `enableCodingAgents`, etc.)

**Submit:** `POST /api/launch`. When `explorationMode === 'guided'`, the payload sets `executionMode: 'guided-exclusive'` (see `gatherLaunchSettings()`, line 953). After success, switches to Watch view.

Default values are in `FORM_DEFAULTS` (lines 31–59). Applied once via `applyFormSettings('launch-form', ...)`.

### Setup / Providers Panel (`#setup-form`)

- Summary grid (`#setup-summary`): dynamically built `.summary-card` elements showing Config, Database, OpenAI, Anthropic OAuth, Reference Brains
- Provider toggles (`.provider-grid`): OpenAI, Anthropic (OAuth-only: CLI import + manual OAuth flow), xAI, Ollama, LM Studio
- Model Catalog: textarea per provider for model IDs, selects for query/PGS/local defaults
- Anthropic OAuth: Import from CLI → `POST /api/oauth/anthropic/import-cli`. Manual: Start → `POST /api/oauth/anthropic/start` → opens auth URL. Complete → `GET /api/oauth/anthropic/callback?callbackUrl=<encoded>`. Logout → `POST /api/oauth/anthropic/logout`. No API key input.

### Model Select Population

`renderModelOptions()` populates all six model selects (3 launch, 3 continue) with `<optgroup>` per provider. Embedding models are filtered out. If current value is not in model list, a `(custom)` option is prepended.

---

## Brains View (`#view-brains`)

### Two-Column Layout

Left sidebar (`brain-library-panel`) + right detail panel. Sidebar has search input, filter pills (all|local|reference|active), brain card list.

### Brain Cards

`<article class="brain-card">` built by `renderBrainLibrary()`. Shows displayName, topic/domain, source badge, chip row (cycles, nodes, edges, snapshots), meta row. Clicking calls `selectBrain(brain.routeKey, { syncQuery: true })`.

### Brain Detail Panel

Three sub-tabs (`data-brain-tab` / `data-brain-panel`):
1. **overview** — run identity, source, topic, mode, model stack, snapshots
2. **continue** — continuation form (same fields as launch, pre-populated from `effectiveContinueSettings`)
3. **map** — placeholder scaffold

### Continue Form (`#continue-form`)

Pre-populated from `detail.effectiveContinueSettings`. Button label changes to "Import + Continue" for reference brains. Submit → `POST /api/continue/:brainId` → switches to Watch view.

---

## Query / Research View (`#view-query`)

### Brain Selector

`#query-brain` select populated by `renderQueryBrains()`. Changing selection syncs with Brains view (guarded by `syncingQueryBrain` flag to prevent infinite loops).

### Query Input

- `#qt-input` — free-form question; `Cmd/Ctrl+Enter` submits
- `#qt-followup` — sets context for follow-up queries using `lastQueryResult`
- `#qt-context-indicator` — pulsing dot when prior context active

### Query Options

- Model select (`#qt-model`), mode select (`#qt-mode`: quick|full|expert|dive), stream toggle
- Enhancement toggles: evidence, synthesis, coordinator insights
- Context toggles: outputs, thoughts, allow-actions
- PGS toggle with depth chips (0.10/0.25/0.50/1.0), mode select, session ID

### Streaming Query (default path)

Uses `fetch()` + `response.body.getReader()` (NOT `EventSource`). Manually parses SSE wire format: `event: <type>\ndata: <json>\n\n`.

**SSE event types:** `error`, `thinking`/`progress`, `response_chunk`/`chunk`, `pgs_init`, `pgs_phase`, `pgs_session`, `pgs_routed`, `pgs_sweep_progress`, `tool_call`/`tool_result`, `result`/`complete`.

PGS mode shows a specialized progress panel with live timer, 4-step phase stepper, sweep tracker rows, and scrollable log.

### Result Display

Answer rendered via `renderMarkdownSafe()` (uses `marked.parse` if available, falls back to `<pre>`). Includes metadata, evidence quality, synthesis panels. Export bar: Save to Brain (`POST /api/brain/:brainId/export-query`), Download (client-side Blob), Copy to clipboard.

### Query History

`localStorage` at `cosmo.queryHistory.<brainId>`. Max 50 entries. Shown in collapsible `#qt-history`. Each item restores query and re-renders result.

---

## Watch View (`#view-watch`)

Three-column grid (`.watch-layout`):

1. **Status panel** — run name, topic, socket status, started-at, dashboard link, stop button
2. **Activity Feed** (`#activity-feed`) — WebSocket events, newest first (`.prepend()`), max 250 items
3. **Console Feed** (`#console-feed`) — HTTP log polling, max 400 items, dark console style

### WebSocket

`connectWebSocket(wsUrl)` → `new WebSocket(wsUrl)`. On close, retries after 2s if `activeContext` still set.

### Log Polling

1500ms interval calling `GET /api/watch/logs?after=<cursor>&limit=250`. Duplicate detection by `dataset.source + dataset.level + dataset.message`. Active only while Watch view is visible.

---

## API Interaction Patterns

### Central `api()` Method

All non-streaming calls use `this.api(url, options)` which adds `Content-Type: application/json`, parses response, throws on non-OK status. Errors surfaced via `this.showToast(msg, 'error')`.

### Streaming SSE Pattern

Uses `fetch()` + `ReadableStream`, NOT `EventSource`. Manually parses named events. Server uses `event: <type>\ndata: <json>` format.

---

## CSS Architecture

### Design Tokens (`:root` custom properties)

- `--bg: #f6f4ee` (warm off-white), `--accent: #2f6b5d` (forest green), `--danger: #9e4638`
- `--console-bg: #16211d`, `--console-text: #edf6f1`
- `--sans: "Avenir Next"...`, `--serif: "Iowan Old Style"...`, `--mono: "IBM Plex Mono"...`
- Border radii: `--radius-lg: 24px`, `--radius-md: 16px`, `--radius-sm: 12px`

The query tab uses a parallel set of CSS variables (`--bg-primary`, `--accent-primary`, etc.) injected via `getQueryTabStyles()` — a porting artifact from the hosted app.

### Key Layout Classes

| Class | What it does |
|---|---|
| `.app-shell` | Max-width 1520px, auto margins |
| `.panel` | White glass card, `backdrop-filter: blur(10px)` |
| `.form-grid` | 2-column form grid |
| `.toggle-chip` | Pill-shaped checkbox + label |
| `.brain-card` | Clickable brain entry; `.active` = green gradient |
| `.section-disclosure` | `<details>` with Show/Hide pseudo-content |

### Button Variants

`.top-nav-btn`, `.primary-btn` (green gradient), `.ghost-btn`, `.danger-btn`, `.filter-pill`

### Responsive Breakpoints

1200px → single column layouts. 900px → masthead stacks. 720px → reduced padding, form collapse. 480px → full-width everything.

---

## State Management

### `CosmoStandaloneApp` Instance Properties

Key state: `this.brains`, `this.selectedBrainId`, `this.selectedBrainDetail`, `this.models`, `this.modelCatalog`, `this.activeContext`, `this.ws`, `this.activeView`, `this.watchLogCursor`.

### Brain ↔ Query Sync

1. User clicks brain card → `selectBrain(routeKey, { syncQuery: true })` → `syncSelectedBrainIntoQuery()` sets `#query-brain` value with `syncingQueryBrain = true`
2. `handleQueryBrainChange()` ignores because guard is true
3. Changing `#query-brain` manually → `handleQueryBrainChange()` → `selectBrain(brainId, { syncQuery: false })`

---

## UX Patterns

- **Toasts:** `showToast(message, type)` appends to `#toast-stack` (fixed bottom-right). Auto-removes after 3800ms.
- **Loading:** No global indicator. Buttons disabled during calls. Query shows `.qt-spinner` or PGS progress panel.
- **Errors:** API errors → toast. Streaming errors → inline `.qt-error` div.
- **Empty states:** Brain detail placeholder, query result placeholder with SVG icon.
- **No confirmation dialogs.** Stop run is a single button press.
