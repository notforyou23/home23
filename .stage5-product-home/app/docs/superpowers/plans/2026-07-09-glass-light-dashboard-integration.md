# Home23 Glass Light Dashboard Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Home23 dashboard to match the approved Glass Light handoff while retaining every current production route, data source, action, degradation path, and local runtime artifact.

**Architecture:** Preserve the existing vanilla-JS dashboard machinery and restructure only its presentation boundaries. The main dashboard gets a floating native-tab top bar, fixed Jerry/sensor/chat-first Home composition, light-glass native panels, and unified overlays; Chat, full Settings, Vibe gallery, Welcome, Setup, COSMO, and Brain Map keep their current functional owners and consume scoped shared design tokens.

**Tech Stack:** Semantic HTML, CSS custom properties/responsive CSS, vanilla JavaScript, Node test runner, TypeScript build/contracts, Home23 dashboard APIs/WebSocket, existing Chat SSE client, existing 3d-force-graph integration, in-app browser QA.

## Global Constraints

- `/Users/jtr/Downloads/design_handoff_glass_dashboard/` is the visual authority; `docs/superpowers/specs/2026-07-09-glass-light-dashboard-integration-design.md` is the production integration authority.
- Do not ship the Design Component prototype, `support.js`, React runtime, sample data, or inert prototype controls.
- Preserve all production IDs, renderers, independent pollers, WebSocket events, hash routes, Chat slot movement, image attachments, COSMO lazy iframe/offline controls, WebGL Brain Map/fallback, Problems, Good Life, Agency evidence, Workers, Briefs, and full Settings functionality unless this plan explicitly replaces a presentation-only contract.
- Do not modify or delete `instances/`, local config, secrets, PM2 state, caches, logs, runtime receipts, or generated ecosystem state.
- Do not run Settings write/lifecycle actions or `HOME23_LIVE_CONTRACTS_ACTIONS=1` during QA.
- Avoid `engine/src/dashboard/server.js`, `engine/src/dashboard/home23-settings-api.js`, and `engine/src/dashboard/home23-settings.js`; they contain overlapping user work and are not required for the frontend redesign.
- Avoid broad PM2 operations. If live validation eventually needs a restart, restart only the isolated verification server or the exact dashboard process after explicit integration review.
- Implement on `codex/glass-light-dashboard` in an isolated worktree created from commit `26e9e06` or its descendant; do not implement on `main`.
- Keep Home feed loading independent; one rejected or slow request must not blank successful sibling cards.
- Keep the runtime's alert prominence while also rendering the handoff's always-visible top-bar state/cycle summary.
- Home move/resize/hide applies only to Weather, Sauna, and Pool within the sensor strip; stored layout entries for fixed modules are not deleted.
- The full `/home23/settings` page remains authoritative; the in-dashboard Settings panel is a read-only overview with links into the full control surface.
- Brain Storage is green only for exact equality, amber for explicitly expected unflushed working-memory delta, and red for unexplained/negative mismatch.
- No emoji in dashboard navigation, headings, or controls; approved text glyphs remain. The attachment control keeps its accessible name and existing behavior.
- Primary fidelity target is 1200px and wider; 1024, 768, 390, and 320px must remain fully usable with no horizontal document overflow.
- Use semantic controls, visible `:focus-visible`, dialog labels, Escape close, focus restoration, reduced motion, and contrast-safe small text.
- Preserve host-relative URLs for LAN/Tailscale operation; do not introduce hard-coded `localhost` production URLs.
- The final durable report must distinguish read-only proof from intentionally unexercised live-write actions.

---

### Task 1: Lock the redesign and preservation contracts in tests

**Files:**
- Modify: `tests/dashboard/operator-ui.test.js`
- Create: `tests/dashboard/glass-light-dashboard.test.js`
- Reference: `engine/src/dashboard/home23-dashboard.html`
- Reference: `engine/src/dashboard/home23-dashboard.js`
- Reference: `engine/src/dashboard/home23-dashboard.css`
- Reference: `engine/src/dashboard/home23-chat.css`

**Interfaces:**
- Consumes: the approved design spec and current source contracts.
- Produces: failing source-level contracts for the shell, Home hierarchy, native Settings panel, scoped tile controls, six overlays, accessibility, token layer, and preservation of current production IDs/functions.

- [ ] **Step 1: Add failing structural tests for the new shell and Home hierarchy**

Add exact assertions that require:

```js
assert.match(html, /class="h23-topbar"/);
assert.doesNotMatch(html, /class="h23-sidebar"/);
assert.doesNotMatch(html, /class="h23-system-rail"/);
assert.match(html, /id="panel-settings"/);
assert.match(html, /class="h23-human-hero-copy"/);
assert.match(html, /class="h23-human-sensor-strip"/);
assert.match(html, /class="h23-human-main-grid"/);
assert.match(html, /data-home-sensor-layout="true"/);
```

Assert that all route labels/targets remain present: Home, Agency, Briefs, Workers, Query, Brain Map, Chat, Settings, cosmo23, and evobrew.

- [ ] **Step 2: Add failing production-preservation tests**

Require the existing Chat and operator contracts:

```js
for (const id of [
  'chat-shared-template', 'chat-slot-tile', 'chat-slot-overlay',
  'chat-attach-btn', 'chat-attach-input', 'chat-conv-panel',
  'problems-overlay', 'goodlife-overlay', 'brain-storage-overlay',
  'home-vibe-detail-modal', 'chat-overlay', 'problem-editor-overlay',
  'cosmo23-frame-wrap', 'brain-map-container',
]) assert.match(html, new RegExp(`id="${id}"`));

for (const fn of [
  'renderProblemsList', 'renderBrainStoragePanel', 'openGoodLifeOperator',
  'setSaunaPreset', 'runHumanSaunaAction', 'showCosmoFrame',
]) assert.match(js, new RegExp(`function ${fn}\\b`));
```

Require that `server.js`, settings API, and runtime files are not part of the intended redesign file list in the test fixture/documentation contract.

- [ ] **Step 3: Add failing scoped-layout, Settings, and overlay accessibility tests**

Require:

```js
assert.match(js, /HOME_LAYOUT_MANAGED_SENSOR_IDS/);
assert.match(js, /loadSettingsOverview/);
assert.match(js, /setupDashboardOverlayAccessibility/);
assert.match(js, /closeTopmostDashboardOverlay/);
assert.match(html, /role="dialog"/);
assert.match(html, /aria-modal="true"/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /:focus-visible/);
```

Also assert the dashboard Settings overview contains read-only section links to `/home23/settings#agents`, `#feeder`, `#models`, and `#vibe` and contains no inline Save/Start/Stop/Delete controls.

- [ ] **Step 4: Add failing design-token and dark-shell tests**

Require the approved token names/values in `home23-dashboard.css`, Instrument Sans in the dashboard head, and absence of the old grid/star shell from the new dashboard-scoped section. Avoid a global ban on every legacy color because Settings/Chat compatibility may temporarily retain aliases; assert rendered selectors use the new tokens.

- [ ] **Step 5: Run the new tests and confirm failure for missing redesign contracts**

Run:

```bash
node --test --test-concurrency=1 \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/dashboard/operator-ui.test.js
```

Expected: failures name the missing top bar, Home regions, native Settings panel, scoped sensor layout, overlay accessibility helpers, and light token layer; existing production-preservation assertions remain green.

- [ ] **Step 6: Commit the contract tests**

```bash
git add tests/dashboard/operator-ui.test.js tests/dashboard/glass-light-dashboard.test.js
git commit -m "test: lock glass light dashboard contracts"
```

---

### Task 2: Rebuild the semantic dashboard shell and Home markup

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Test: `tests/dashboard/glass-light-dashboard.test.js`
- Test: `tests/dashboard/operator-ui.test.js`

**Interfaces:**
- Consumes: unchanged IDs/functions used by `home23-dashboard.js`, `home23-chat.js`, `home23-query.js`, and `home23-brain-map.js`.
- Produces: `.h23-topbar`, `.h23-human-hero`, `.h23-human-sensor-strip`, `.h23-human-main-grid`, `#panel-settings`, and semantic overlay shells without changing backend interfaces.

- [ ] **Step 1: Replace sidebar/system rail with the top bar while retaining routing hooks**

The bar must use actual buttons/anchors and preserve the existing selectors:

```html
<header class="h23-topbar" aria-label="Home23 navigation">
  <a class="h23-topbar-brand" href="#home" aria-label="Home23 home">
    <span class="h23-logo">Home23</span>
    <span class="h23-topbar-agent" id="header-agent-name">Agent</span>
  </a>
  <nav class="h23-tabs h23-tabs-primary" aria-label="Dashboard sections">
    <button class="h23-tab active" data-tab="home" data-tab-label="Home" type="button">Home</button>
    <button class="h23-tab" data-tab="agency" data-tab-label="Agency" type="button">Agency</button>
    <button class="h23-tab" data-tab="briefs" data-tab-label="Briefs" type="button">Briefs</button>
    <button class="h23-tab" data-tab="workers" data-tab-label="Workers" type="button">Workers</button>
    <button class="h23-tab" data-tab="query" data-tab-label="Query" type="button">Query</button>
    <button class="h23-tab" data-tab="brain-map" data-tab-label="Brain Map" type="button">Brain Map</button>
  </nav>
  <nav class="h23-linked-tabs" aria-label="Home23 surfaces">
    <a class="h23-tab h23-tab-external" href="/home23/chat" data-scope-tab="chat" data-tab-label="Chat">Chat <span aria-hidden="true">↗</span></a>
    <button class="h23-tab h23-tab-settings" id="settings-btn" data-scope-tab="settings" data-tab-label="Settings" type="button">Settings</button>
    <button class="h23-tab h23-tab-cosmo23" id="cosmo23-btn" data-scope-tab="cosmo23" data-tab-label="cosmo23" type="button">cosmo23</button>
    <a class="h23-tab h23-tab-external h23-tab-evobrew" id="evobrew-btn" href="#" target="_blank" rel="noreferrer" data-scope-tab="evobrew" data-tab-label="evobrew">evobrew <span aria-hidden="true">↗</span></a>
  </nav>
  <div class="h23-topbar-runtime" id="engine-pulse" aria-live="polite">
    <span class="h23-pulse-dot" id="pulse-dot" aria-hidden="true"></span>
    <span class="h23-pulse-state" id="pulse-state">connecting</span>
    <span class="h23-pulse-cycle" id="pulse-cycle">cycle —</span>
    <time class="h23-topbar-time" id="header-local-time">--:--</time>
  </div>
</header>
```

Keep `#tz1-time` in the hero and use `#header-local-time` for the compact top-bar clock; both are updated by `updateClocks()` and no ID is duplicated.

- [ ] **Step 2: Recompose Home around existing data IDs**

Move, do not duplicate, the current Vibe, Chat, sensor, Problems, Good Life, Jerry, clocks, and Briefs elements into:

```html
<section class="h23-human-home" id="human-home">
  <section class="h23-human-hero" aria-labelledby="human-jerry-remark">
    <div class="h23-human-hero-copy">
      <p class="h23-human-hero-kicker" id="human-jerry-kicker">JERRY · LISTENING</p>
      <h1 class="h23-human-jerry-remark" id="human-jerry-remark">Loading Home23 signal…</h1>
      <button class="h23-human-jerry-status" id="human-jerry-status" type="button">Loading brain status…</button>
      <p class="h23-human-jerry-context" id="human-jerry-context"></p>
    </div>
    <div class="h23-human-hero-clocks">
      <div class="h23-human-clock"><div class="h23-human-time" id="tz1-time">--:--</div><div class="h23-human-place" id="tz1-label">New York</div></div>
      <div class="h23-human-clock secondary" id="tz2-container" hidden><div class="h23-human-time" id="tz2-time">--:--</div><div class="h23-human-place" id="tz2-label">Florence</div></div>
    </div>
  </section>
  <section class="h23-human-sensor-strip" data-home-sensor-layout="true" aria-label="House sensors and status">
    <section class="h23-human-card h23-human-card-sensor" data-home-tile-id="outside-weather"></section>
    <section class="h23-human-card h23-human-card-sauna" data-home-tile-id="sauna-control"></section>
    <section class="h23-human-card h23-human-card-sensor" data-home-tile-id="pool-screenlogic"></section>
    <button class="h23-human-card h23-human-card-button" type="button" onclick="openProblemsPanel()"></button>
    <button class="h23-human-card h23-human-card-button" type="button" onclick="openGoodLifeOperator('home')"></button>
  </section>
  <section class="h23-human-main-grid" aria-label="Chat, vibe, and briefs">
    <section class="h23-human-card h23-human-card-chat h23-tile-chat" aria-label="Chat with Home23 agents"><div class="h23-chat-slot" id="chat-slot-tile" data-slot="tile"></div></section>
    <div class="h23-human-main-side"><section class="h23-human-card h23-human-card-vibe"></section><section class="h23-human-card h23-human-briefs"></section></div>
  </section>
</section>
```

Weather, Sauna, and Pool keep `data-home-tile-id`. Problems and Good Life remain buttons but are not layout-managed. Jerry, Vibe, Chat, and Briefs lose layout-management attributes while retaining their render IDs and actions.

- [ ] **Step 3: Replace the sauna gauge/raw editor with semantic presets and hidden integration fields**

Keep `#human-sauna-target`, `#human-sauna-duration`, and `#human-sauna-actions` for current action plumbing, but present the target/duration inputs as visually hidden integration state. Add a readable state line and a preset container that the JS renderer owns. The Start/Stop confirmation and action endpoint remain unchanged.

- [ ] **Step 4: Add the native read-only Settings overview**

Create `#panel-settings` with four glass sections and stable containers:

```html
<div class="h23-panel" id="panel-settings">
  <div class="h23-page-header"><div><h2>Settings</h2><p>House and agent status with links to the full control surface.</p></div><a href="/home23/settings">Open full settings <span aria-hidden="true">↗</span></a></div>
  <div class="h23-settings-overview-grid">
    <section class="h23-settings-overview-panel" aria-labelledby="settings-overview-agents-title">
      <h3 id="settings-overview-agents-title">Agents</h3>
      <div id="settings-overview-agents"></div>
      <a href="/home23/settings#agents">Open agents settings ›</a>
    </section>
    <section class="h23-settings-overview-panel" aria-labelledby="settings-overview-feeds-title"><h3 id="settings-overview-feeds-title">Data feeds</h3><div id="settings-overview-feeds"></div><a href="/home23/settings#feeder">Open data feeds ›</a></section>
    <section class="h23-settings-overview-panel" aria-labelledby="settings-overview-operations-title"><h3 id="settings-overview-operations-title">Operations</h3><div id="settings-overview-operations"></div><a href="/home23/settings#models">Open model settings ›</a><a href="/home23/settings#agency">Open agency settings ›</a></section>
    <section class="h23-settings-overview-panel" aria-labelledby="settings-overview-house-title"><h3 id="settings-overview-house-title">House</h3><div id="settings-overview-house"></div><a href="/home23/settings#vibe">Open house settings ›</a></section>
  </div>
</div>
```

Every section links to the existing full Settings page. Do not add write controls.

- [ ] **Step 5: Add semantic COSMO header and upgrade the six overlay shells**

Keep the lazy iframe and offline/restart hooks. Add the handoff's title/status/reload/new-tab header around `#cosmo23-frame-wrap`.

For each overlay, add `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, a stable labelled heading, and a close button with an accessible name. Keep all existing production body containers and inline action handlers.

- [ ] **Step 6: Replace the attachment emoji without changing Chat IDs**

Use an accessible paperclip-like text/SVG treatment inside `#chat-attach-btn`; preserve its ID, `aria-label="Attach image"`, file input, paste/drop handlers, and all current Chat markup contracts.

- [ ] **Step 7: Run structural tests**

Run the Task 1 command. Expected: shell/Home/Settings/overlay structure assertions pass; CSS/JS assertions remain failing until later tasks.

- [ ] **Step 8: Commit semantic markup**

```bash
git add engine/src/dashboard/home23-dashboard.html tests/dashboard/operator-ui.test.js tests/dashboard/glass-light-dashboard.test.js
git commit -m "feat: restructure dashboard for glass light layout"
```

---

### Task 3: Install the light-glass design system and responsive layouts

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.css`
- Modify: `engine/src/dashboard/home23-chat.css`
- Test: `tests/dashboard/glass-light-dashboard.test.js`
- Test: `tests/dashboard/operator-ui.test.js`

**Interfaces:**
- Consumes: Task 2 semantic class structure and all existing dynamically generated class names.
- Produces: approved `--h23-*` tokens, dashboard-scoped shell/Home/native-panel/overlay rules, light Chat presentation, responsive breakpoints, focus/reduced-motion behavior.

- [ ] **Step 1: Add the approved token layer and compatibility aliases**

Use the exact token values from `glass-theme-tokens.css`, including:

```css
:root {
  --h23-bg: linear-gradient(160deg, #EAEEF4 0%, #E4EAF2 40%, #E9EDF0 100%);
  --h23-glass-card: rgba(255, 255, 255, 0.58);
  --h23-glass-panel: rgba(255, 255, 255, 0.62);
  --h23-glass-overlay: rgba(255, 255, 255, 0.9);
  --h23-text-primary: #1b2028;
  --h23-text-body: #333b48;
  --h23-text-secondary: #5a6474;
  --h23-text-muted: #8a93a3;
  --h23-accent: #3e7be0;
  --h23-green: #1e9e6f;
  --h23-amber: #d9762b;
  --h23-red: #c94f4f;
  --h23-text-muted-aa: #697384;
  --h23-green-aa: #177f5b;
  --h23-amber-aa: #a9571c;
  --h23-red-aa: #b53f3f;
}
```

Use the valid background value `linear-gradient(160deg, #EAEEF4 0%, #E4EAF2 40%, #E9EDF0 100%)`. Keep the supplied tokens exact and use the explicit `*-aa` variants above only for small text/status labels that need additional contrast.

- [ ] **Step 2: Style the page atmosphere and top bar**

Implement the approved background gradient, two fixed radial washes, floating 60px+ top bar, pill tabs, wrap behavior, runtime dot/state/cycle/time, active/hover/focus states, and alert emphasis. Remove the grid/star body treatment from the dashboard page.

- [ ] **Step 3: Style Home hero, sensor strip, and main grid**

Match the handoff's 29px Jerry headline, dual-clock hierarchy, five-card auto-fit strip, mini metrics, three sauna target chips, Problems/Good Life states, `1.45fr / 0.9fr` Chat-first layout, 16:9 Vibe, and compact Brief rows. Keep functional controls visible at 44px touch size where practical.

- [ ] **Step 4: Style all native panels and dynamic renderer classes**

Cover the existing classes emitted for Agency, Briefs, Workers, Query, Brain Map, Good Life, Problems, receipts, drawers, empty/error/loading states, and COSMO offline UI. Existing below-fold content must remain readable; do not hide it to match the simpler prototype.

- [ ] **Step 5: Style the unified overlay recipe**

Apply the specified backdrop, blur, panel widths, max heights, radii, shadows, headers, status pills, row dividers, body overflow, and mobile full-screen behavior to all six overlays. Keep the Good Life internal grid scroll contracts required by `operator-ui.test.js`.

- [ ] **Step 6: Restyle Chat tile and expanded overlay**

In `home23-chat.css`, preserve flex/scroll/state behavior while matching the handoff: plain agent replies, blue user bubbles, light composer, glass pills/menu/conversations, 880×760 overlay target, attachment tray/drop overlay, tool/thinking/subagent events, and standalone compatibility.

- [ ] **Step 7: Add responsive, focus, and reduced-motion rules**

Required breakpoints/outcomes:

```css
@media (max-width: 1000px) { /* Home main stack, hero adapts */ }
@media (max-width: 900px) { /* panel grids and overlays stack/fill */ }
@media (max-width: 640px) { /* top bar, clocks, controls, readers */ }
@media (max-width: 390px) { /* no overflow; compact but reachable */ }
@media (prefers-reduced-motion: reduce) { /* disable pulse/transitions */ }
```

Add strong `:focus-visible` rings and `@supports not (backdrop-filter: blur(1px))` opaque fallbacks.

- [ ] **Step 8: Run focused tests and source checks**

```bash
node --test --test-concurrency=1 \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/dashboard/operator-ui.test.js
git diff --check
```

Expected: design-token, selector, preservation, and operator contracts pass. Visual fidelity remains for browser QA.

- [ ] **Step 9: Commit the design system**

```bash
git add engine/src/dashboard/home23-dashboard.css engine/src/dashboard/home23-chat.css tests/dashboard/glass-light-dashboard.test.js
git commit -m "style: apply glass light dashboard system"
```

---

### Task 4: Integrate runtime behavior with the new composition

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.js`
- Modify: `tests/dashboard/glass-light-dashboard.test.js`
- Modify: `tests/dashboard/operator-ui.test.js`

**Interfaces:**
- Consumes: current dashboard APIs, WebSocket engine events, existing Home renderers/action endpoints, Task 2 DOM.
- Produces: native Settings/COSMO routing, current-agent WebSocket initialization, hero metadata, scoped sensor controls, sauna target state, safe Settings overview reads, overlay keyboard/focus lifecycle.

- [ ] **Step 1: Initialize agent identity before the engine WebSocket**

Change initialization order so `loadAgents()` resolves before `connectEnginePulse()`, then render Home. Preserve the current fallback when discovery fails. This fixes the existing secondary-agent port race without changing the WebSocket protocol.

- [ ] **Step 2: Make Settings a native hash-routed panel**

Register `settings-btn` through the same panel selection path as other native tabs. `#settings` activates `#panel-settings`; full control-surface links still navigate to `/home23/settings#...`. Keep COSMO's lazy behavior and Evobrew's external target.

- [ ] **Step 3: Render top-bar status and one-second clocks**

Always update `pulse-state`, `pulse-cycle`, `pulse-dot`, and primary time in the top bar. Add an alert class/label for blocked/error/failed/offline states rather than hiding the runtime in normal states. Change clock cadence to one second, clear the old ten-second assumption, and keep the optional second timezone.

- [ ] **Step 4: Scope Home layout persistence to environmental sensors**

Define:

```js
const HOME_LAYOUT_MANAGED_SENSOR_IDS = new Set([
  'outside-weather',
  'sauna-control',
  'pool-screenlogic',
]);
```

`applyHomeTileLayout()` and inline controls may reorder/resize/hide only these cards inside `[data-home-sensor-layout="true"]`. Fixed modules ignore stored layout entries without deleting them. BroadcastChannel synchronization remains.

- [ ] **Step 5: Adapt sauna rendering without changing the action endpoint**

Render 170/180/190 target chips with active state, derive heating/running state from existing payload metrics/actions, keep the hidden target/duration fields as the request source, and keep confirmation before the live action. `setSaunaPreset(target, 180)` remains the integration interface.

- [ ] **Step 6: Render hero metadata and brain-storage affordance from live data**

Keep `#human-jerry-remark`, status, and context renderers. Derive a readable `JERRY · N AGO` kicker and footer with node/problem/verification context from the data already fetched during `loadHumanHomeSurface()`. Do not add a new backend call. The node affordance calls `openBrainStoragePanel()`.

- [ ] **Step 7: Implement the safe Settings overview loader**

`loadSettingsOverview()` performs only GET requests to current endpoints such as `/home23/api/settings/agents`, `/home23/api/settings/feeder`, `/home23/api/settings/vibe`, and current sensor/status endpoints. Each section uses independent settled results. Render real values when present and honest unavailable text when absent; never substitute prototype sample values.

- [ ] **Step 8: Add unified overlay keyboard/focus lifecycle**

Implement `setupDashboardOverlayAccessibility()` and `closeTopmostDashboardOverlay()` to:

- track the invoking element,
- close the top visible Problems/Good Life/Brain Storage/Vibe/Chat/invariant overlay on Escape,
- focus the first meaningful control on open,
- restore focus on close,
- prevent background scroll while any overlay is visible,
- leave Chat's existing Escape handler compatible and idempotent.

- [ ] **Step 9: Add Brain Storage status classes without changing data semantics**

Map exact equality to `in-sync`, expected positive working delta to `pending`, and unexplained/negative mismatch to `mismatch`. If the API already supplies an authoritative state, prefer it. Do not label unequal values green.

- [ ] **Step 10: Run focused syntax and dashboard tests**

```bash
node --check engine/src/dashboard/home23-dashboard.js
node --test --test-concurrency=1 \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/dashboard/operator-ui.test.js \
  tests/dashboard/briefs.test.js \
  tests/dashboard/forrest-feel-route.test.js
```

Expected: all pass.

- [ ] **Step 11: Commit runtime integration**

```bash
git add engine/src/dashboard/home23-dashboard.js tests/dashboard/glass-light-dashboard.test.js tests/dashboard/operator-ui.test.js
git commit -m "feat: wire glass dashboard runtime behavior"
```

---

### Task 5: Complete the full Settings, Chat, gallery, welcome, and setup light-theme surfaces

**Files:**
- Modify: `engine/src/dashboard/home23-settings.css`
- Modify: `engine/src/dashboard/home23-settings.html`
- Modify: `engine/src/dashboard/home23-chat.html`
- Modify: `engine/src/dashboard/home23-vibe/gallery.html`
- Modify: `engine/src/dashboard/home23-welcome.html`
- Modify only if markup binding requires it: `engine/src/dashboard/home23-chat.js`
- Test: `tests/dashboard/glass-light-dashboard.test.js`
- Test: `tests/dashboard/chat-state.test.ts`
- Test: `tests/engine/dashboard/vibe-image-settings.test.js`

**Interfaces:**
- Consumes: shared `--h23-*` tokens and the existing full-page forms/actions/routes.
- Produces: visual continuity across the full control surface and related pages without altering Settings API calls, lifecycle actions, provider/model data, Chat protocol, or Vibe service.

- [ ] **Step 1: Add explicit page-scope classes**

Use body/page classes such as `h23-settings-page`, `h23-chat-page`, `h23-vibe-page`, and `h23-welcome-page` so dashboard structural rules never leak. Keep existing script and control IDs.

- [ ] **Step 2: Reskin full Settings without changing behavior**

Apply the light background, Instrument Sans/IBM Plex Mono type, glass sidebar/cards/forms, status pills, buttons, tables, dialogs, onboarding steps, and responsive behavior. Preserve Providers, Agents, Workers, Models, Query, Feeder, Skills, Vibe, Tiles, Agency, System, setup, OAuth, selected-agent scope, validation, and error banners.

Do not edit `home23-settings.js` or settings APIs for styling. Do not trigger live Save, Start, Stop, Restart, Delete, Install, Build, OAuth, or provider-test actions during QA.

- [ ] **Step 3: Complete standalone Chat styling**

Make `/home23/chat` visually consistent while preserving its mobile-first layout, persistent/collapsible conversation UI, image attachments, agent/model controls, history, resumable turns, and existing ChatState. Any `home23-chat.js` edit must be limited to changed semantic markup bindings and covered by chat tests.

- [ ] **Step 4: Reskin Vibe gallery and Welcome/Setup entry**

Apply the same token language to gallery grid/lightbox/policy metadata and first-run welcome/setup shell. Do not change generation policy, hidden triple-click behavior, onboarding logic, or provider readiness behavior.

- [ ] **Step 5: Add/extend source contracts for page scoping and preserved controls**

Assert page-scope classes, new font link, retained Settings tab/control IDs, retained standalone Chat IDs, and absence of the prototype runtime. Keep existing Vibe settings tests unchanged unless an actual style-only fixture needs updating.

- [ ] **Step 6: Run focused page tests**

```bash
node --check engine/src/dashboard/home23-chat.js
node --import tsx --test --test-concurrency=1 tests/dashboard/chat-state.test.ts
node --test --test-concurrency=1 \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/engine/dashboard/vibe-image-settings.test.js \
  tests/engine/cli-onboarding.test.js
```

Expected: all pass with no Settings API/server modifications.

- [ ] **Step 7: Commit related page styling**

```bash
git add \
  engine/src/dashboard/home23-settings.css \
  engine/src/dashboard/home23-settings.html \
  engine/src/dashboard/home23-chat.html \
  engine/src/dashboard/home23-vibe/gallery.html \
  engine/src/dashboard/home23-welcome.html \
  engine/src/dashboard/home23-chat.js \
  tests/dashboard/glass-light-dashboard.test.js
git commit -m "style: extend glass light theme across Home23 pages"
```

Only add `home23-chat.js` if it changed.

---

### Task 6: Run integrated automated verification and repair regressions

**Files:**
- Modify as findings require: only the dashboard/page/test files in Tasks 1–5
- Create: `.superpowers/sdd/glass-light-automated-verification.md` (ignored scratch evidence)

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: green focused/broad suites and a command-by-command verification record.

- [ ] **Step 1: Run syntax and focused dashboard suites**

```bash
node --check engine/src/dashboard/home23-dashboard.js
node --check engine/src/dashboard/home23-chat.js
node --test --test-concurrency=1 \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/dashboard/operator-ui.test.js \
  tests/dashboard/briefs.test.js \
  tests/dashboard/forrest-feel-route.test.js
node --import tsx --test --test-concurrency=1 tests/dashboard/chat-state.test.ts
```

Record exact totals and failures.

- [ ] **Step 2: Run broad build and tests**

```bash
npm run build
npm test
npm run test:contracts
```

Fix only regressions caused by the redesign. Do not absorb or overwrite unrelated work.

- [ ] **Step 3: Run read-only live contracts from the verification environment**

```bash
npm run test:contracts:live
```

Do not set `HOME23_LIVE_CONTRACTS_ACTIONS=1`.

- [ ] **Step 4: Run repository hygiene checks**

```bash
git diff --check
git status --short --branch
git diff --name-only "$(git merge-base main HEAD)"...HEAD
```

Confirm no runtime/config/secret/instance/server/settings-API files changed.

- [ ] **Step 5: Write the automated verification scratch report**

Record commands, timestamps, exit codes, totals, any pre-existing caveats, and exact changed-file scope in `.superpowers/sdd/glass-light-automated-verification.md`.

- [ ] **Step 6: Commit any integration fixes**

If fixes were required:

```bash
git add \
  engine/src/dashboard/home23-dashboard.html \
  engine/src/dashboard/home23-dashboard.css \
  engine/src/dashboard/home23-dashboard.js \
  engine/src/dashboard/home23-chat.css \
  engine/src/dashboard/home23-chat.html \
  engine/src/dashboard/home23-settings.css \
  engine/src/dashboard/home23-settings.html \
  engine/src/dashboard/home23-vibe/gallery.html \
  engine/src/dashboard/home23-welcome.html \
  tests/dashboard/glass-light-dashboard.test.js \
  tests/dashboard/operator-ui.test.js
git commit -m "fix: close glass dashboard integration regressions"
```

If no fixes were required, do not create an empty commit.

---

### Task 7: Perform high-fidelity browser verification, responsive, and accessibility QA

**Files:**
- Modify as findings require: only the dashboard/page/test files in Tasks 1–5
- Create: `docs/superpowers/reports/2026-07-09-glass-light-dashboard-verification.md`
- Create screenshots under: `docs/superpowers/reports/assets/glass-light-dashboard/`

**Interfaces:**
- Consumes: a safe isolated dashboard server serving the implementation worktree and the approved handoff screenshots/source.
- Produces: visual/functional proof at required widths, console evidence, screenshots, and repaired findings.

- [ ] **Step 1: Start a non-conflicting verification server**

Use the dashboard's supported startup path with an alternate dashboard port and read-only access to existing data, or another verified non-conflicting local method. Do not replace/restart the live `home23-jerry-dash` process and do not bind ports 5001–5004, 3415, or 43210. Record the exact command and port.

- [ ] **Step 2: Verify primary desktop fidelity at 1440 and 1200px**

Capture full-page Home screenshots and compare against the handoff's hierarchy and tokens:

- floating top bar and pill routing,
- Jerry headline/clocks/footer,
- five-card strip,
- Chat-first main area,
- Vibe/Briefs right rail,
- no dark shell/grid remnants.

Fix material spacing, typography, color, radius, shadow, or overflow differences.

- [ ] **Step 3: Verify every native/external surface**

Exercise Home, Agency, Briefs, Workers, Query, Brain Map, Settings overview, COSMO, standalone Chat, full Settings, Vibe gallery, and Welcome/Setup read-only rendering. Verify hash deep links, refresh, back/forward, external href targets, and COSMO lazy preservation. Do not start COSMO or submit a real Query.

- [ ] **Step 4: Verify Home live-data and action presentation**

Confirm real weather/sauna/pool/problems/Good Life/pulse/brief data, independent loading/offline behavior, and sensor-only layout controls. Inspect the sauna request state and confirmations without approving Start/Stop.

- [ ] **Step 5: Verify Chat behavior safely**

Use a non-destructive test message if the isolated verification environment can target a disposable test conversation. Verify send/stream/stop, conversation UI, agent/model controls, attachment tray/drop/paste, and tile↔overlay DOM/state preservation. If a live send would affect the user's durable conversation state, restrict QA to DOM/state controls and document the intentionally unexercised send.

- [ ] **Step 6: Verify all six overlays**

For Problems, Good Life, Brain Storage, Vibe, Chat, and invariant editor, verify open, backdrop, close control, Escape, focus movement/restoration, scroll containment, real production content, and intact action controls without issuing write actions.

- [ ] **Step 7: Verify responsive widths**

At 1024, 768, 390, and 320px verify:

- no horizontal document overflow,
- top bar wrap and reachable controls,
- hero/clock adaptation,
- sensor auto-fit,
- stacked Home main,
- readable Agency/Workers/Briefs/Brain Map/Settings,
- full-screen mobile Chat/Good Life overlays,
- software-keyboard-safe composer at phone widths where browser emulation permits.

- [ ] **Step 8: Verify accessibility basics and console cleanliness**

Run keyboard-only traversal, visible focus, Escape, labelled dialog/control inspection, 200% zoom, reduced-motion emulation, and contrast spot checks. Record browser console errors/warnings after each major surface; fix redesign-caused issues.

- [ ] **Step 9: Write the durable verification report and save screenshots**

The report must include:

- authority files and tested commit,
- exact server command/port,
- automated command results,
- viewport matrix,
- surface/interaction matrix,
- console results,
- screenshots with absolute repository paths,
- changed-file scope,
- intentionally unexercised live-write actions,
- remaining caveats only if they do not violate acceptance criteria.

- [ ] **Step 10: Commit QA fixes and evidence**

```bash
git add \
  engine/src/dashboard/ \
  tests/dashboard/ \
  docs/superpowers/reports/2026-07-09-glass-light-dashboard-verification.md \
  docs/superpowers/reports/assets/glass-light-dashboard/
git commit -m "test: verify glass light dashboard end to end"
```

Review the staged file list before committing and exclude any unrelated dashboard/backend/user changes.

---

### Task 8: Final review, completion audit, and integration handoff

**Files:**
- Review: `docs/superpowers/specs/2026-07-09-glass-light-dashboard-integration-design.md`
- Review: `docs/superpowers/plans/2026-07-09-glass-light-dashboard-integration.md`
- Review: `docs/superpowers/reports/2026-07-09-glass-light-dashboard-verification.md`
- Review: all branch changes from merge base

**Interfaces:**
- Consumes: all implementation/review/verification artifacts.
- Produces: clean final code review, requirement-by-requirement completion proof, and a safe branch handoff that does not disturb the user's active main-worktree changes.

- [ ] **Step 1: Run the final whole-branch review package**

Use the subagent-driven-development review-package helper from merge base to HEAD and dispatch the highest-capability final reviewer. The reviewer must check the full design spec, preservation constraints, browser evidence, responsive/accessibility evidence, and changed-file boundaries.

- [ ] **Step 2: Repair all Critical and Important findings in one fix wave**

Re-run covering focused tests and re-review. Record Minor findings and either fix them or justify them in the durable report; do not silently discard them.

- [ ] **Step 3: Re-run the final verification gate**

```bash
npm run build
npm test
node --test --test-concurrency=1 \
  tests/dashboard/briefs.test.js \
  tests/dashboard/forrest-feel-route.test.js \
  tests/dashboard/glass-light-dashboard.test.js
npm run test:contracts
npm run test:contracts:live
git diff --check
```

Refresh the browser console and primary screenshots after final fixes.

- [ ] **Step 4: Audit every acceptance criterion against current evidence**

Create a table in the verification report mapping each design-spec acceptance criterion to exact source, test output, live readback, and screenshot evidence. Any missing or indirect evidence means the task is still incomplete.

- [ ] **Step 5: Prepare integration without disturbing main**

Because the live `main` worktree contains user changes, do not auto-merge, stash, reset, or cherry-pick over it. Report the verified branch name, commit range, and the exact non-overlapping frontend files. Offer a safe merge/cherry-pick path only after current main changes are reconciled.

- [ ] **Step 6: Complete the development branch workflow**

Use `superpowers:finishing-a-development-branch` to present the verified integration options. Push/open a PR only if authorized by the current workflow and after branch completion checks.
