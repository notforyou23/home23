# Home23 Glass Light Dashboard Integration Design

**Date:** 2026-07-09
**Status:** Approved design handoff translated into a production integration contract
**Authority:** `/Users/jtr/Downloads/design_handoff_glass_dashboard/`

## Summary

Home23's dashboard will move from the current dark sidebar-and-grid presentation to the supplied light frosted-glass design while preserving the existing dashboard's live data, routes, actions, polling, chat, settings, overlays, COSMO embed, Brain Map, and local runtime state.

This is a presentation and information-architecture overhaul over the current production machinery. The Design Component prototype and `support.js` are visual references only. Production continues to use the existing vanilla HTML, CSS, and JavaScript under `engine/src/dashboard/`.

## Goals

- Reproduce the handoff's light glass visual language at high fidelity: tokens, typography, spacing, radii, shadows, background washes, navigation, Home hierarchy, tab layouts, and overlays.
- Preserve every currently working route and operator action, including production-only behaviors omitted from the prototype.
- Keep Home useful when individual data feeds are slow or offline.
- Keep Chat stateful across tile and expanded modes, including streaming turns and image attachments.
- Keep the full Settings control surface available and visually consistent.
- Add keyboard, focus, dialog, contrast, and reduced-motion safeguards missing from the prototype.
- Avoid `server.js`, settings API, PM2, secret, config, and runtime-state changes unless a verified frontend requirement cannot be met without them.

## Non-goals

- Replacing Home23's data model, dashboard APIs, WebSocket protocol, chat turn protocol, COSMO UI, or WebGL Brain Map.
- Copying or shipping the prototype HTML, React runtime, `support.js`, sample data, or inert prototype controls.
- Simplifying or deleting production-only Good Life, Problems, invariant editor, Agency, Workers, Settings, offline, or mismatch behavior.
- Exercising live Settings write actions during visual QA.
- Refactoring unrelated engine or harness code.

## Approaches Considered

### 1. Prototype transplant

Replace the production dashboard with the Design Component HTML and recreate data access around it.

Rejected. It would discard production IDs, renderers, chat slot movement, offline handling, operator actions, and accessibility semantics, and it would ship a generated reference runtime that the handoff explicitly marks reference-only.

### 2. CSS-only skin

Keep the current markup and append a light theme override.

Rejected as incomplete. It is the lowest-risk visual change, but it cannot produce the requested top navigation, hero/sensor/main composition, in-dashboard Settings overview, or overlay hierarchy.

### 3. Preserve machinery, restructure presentation

Rebuild the shell and Home markup around current IDs, keep existing panels and render functions, add narrowly scoped presentation adapters where the new composition requires them, and apply the new design system across dashboard, Chat, Settings, gallery, and onboarding surfaces.

Selected. This matches the handoff and preserves the functional contracts already proven in production.

## Locked Integration Decisions

### Home customization

The hero, Chat, Vibe, Briefs, Problems, and Good Life composition is fixed so the supplied hierarchy remains coherent. Existing move/resize/hide behavior remains available for the three environmental sensor cards—Weather, Sauna, and Pool—inside the sensor strip. Existing stored layout data is not deleted. Unsupported old layout entries remain intact in settings data but no longer reorder the fixed modules.

The two operator status cards, Problems and Good Life, stay fixed in the strip because their placement is part of the front-door safety contract.

### Settings

The dashboard gains a `#panel-settings` overview matching the handoff's Agents, Data Feeds, Notifications, and House panels. The overview uses safe read-only data already available to the dashboard and links each section into the existing full `/home23/settings` control surface.

The full Settings page remains authoritative for provider credentials, agent lifecycle, workers, model routing, Query, Feeder, Skills, Vibe, Tiles, OAuth, and system actions. It is reskinned with the same tokens but is not duplicated inside the dashboard. No settings action is made implicit or automatic.

### Brain Storage mismatch

Disk/live mismatch is never presented as green `IN SYNC`. Exact equality is green. A positive unflushed delta can be presented as amber `PENDING FLUSH` when the existing API identifies it as expected working memory. Any unexplained or negative mismatch is red. Existing mismatch semantics and actions remain authoritative.

### Typography and icon conflicts

Instrument Sans uses the available 400/500/600/700 weights; prototype weights 450, 550, and 650 normalize to 500, 600, and 700 respectively. IBM Plex Mono remains the metadata/data face.

Emoji are removed from dashboard navigation, headings, and controls. The attachment control uses an accessible text/SVG-style paperclip treatment rather than an emoji. Approved text glyphs such as `›`, `↗`, `×`, `↑`, `⌕`, `⟳`, `‹`, `▾`, and `●` remain.

## Architecture

### Shell

`home23-dashboard.html` replaces the sidebar and system rail with one floating top bar. The bar keeps `.h23-tab[data-tab]` for native panels and the existing IDs for Settings, COSMO, Evobrew, pulse state, agent identity, and primary clock.

The top bar contains:

- Home23 brand and current dashboard agent label.
- Native tab buttons: Home, Agency, Briefs, Workers, Query, Brain Map.
- Chat and Evobrew external links.
- Settings and COSMO native tab buttons.
- Always-visible engine state, cycle, and primary local time.

Hash routing remains canonical for native panels. `#settings` and `#cosmo23` behave like other native dashboard tabs. The standalone Settings and Chat routes remain directly reachable.

### Design system

The supplied variables are merged into `home23-dashboard.css` under the `--h23-*` namespace. Compatibility aliases remain only where other Home23 pages consume legacy variables. Dashboard-specific shell rules are scoped beneath `.h23-dashboard-page` or `.h23-app-shell` so Settings and standalone Chat do not inherit structural grid rules accidentally.

The body uses the approved page gradient and two fixed radial washes. Glass cards use the supplied opacity, border, blur, radius, and shadow values. Text colors are adjusted only where required to meet WCAG AA for the actual small type size; visual hue relationships remain unchanged.

`home23-chat.css` owns Chat-specific surfaces and responsive behavior. `home23-settings.css` owns the full Settings page layout while consuming shared color/type tokens.

### Home composition

`#panel-home` contains three explicit regions:

1. **Jerry hero**
   - `#human-jerry-remark` is the headline.
   - `#human-jerry-status` supplies age/cycle/node context.
   - `#human-jerry-context` supplies supporting voice/focus metadata.
   - `#tz1-*` and `#tz2-*` remain the live clocks.
   - A brain-node affordance opens `#brain-storage-overlay`.

2. **Sensor strip**
   - Weather, Sauna, Pool, Problems, and Good Life cards.
   - Weather and Pool keep `renderHumanSensor()` output.
   - Sauna keeps the existing action endpoint but presents 170/180/190-degree target chips, one duration default, and Start/Stop state as readable text.
   - Weather, Sauna, and Pool retain optional move/resize/hide controls within this strip.
   - Problems and Good Life remain fixed operator cards.

3. **Chat-first main area**
   - Chat occupies the left panel.
   - Vibe and recent Briefs stack on the right.
   - `#chat-shared-template`, `#chat-slot-tile`, and `#chat-slot-overlay` continue to move the same DOM subtree.
   - Home brief rows keep their deep link into the Briefs reader.

Each feed continues to load independently. One failed request cannot blank or reset unrelated cards.

### Native panels

- **Agency:** existing stats, Resident Brief, Pursuit Ledger, and Latest Route Receipts receive the new hierarchy. Production evidence drawers remain below the primary panels.
- **Briefs:** current filters and refresh remain real controls; list/reader become the handoff's two-column glass layout.
- **Workers:** current stats, starter actions, specialist form, Proof Trail, Proof Receipt, roster, and capability guide remain.
- **Query:** existing `home23-query.js` markup is styled into the centered 760px composition. No query protocol changes.
- **Brain Map:** current 3d-force-graph remains mounted in `#brain-map-container`; search, reset, stats, and detail panel remain.
- **COSMO:** current lazy iframe, offline panel, restart action, Home23 drawer toggle, reload, and new-tab path remain. The wrapper gains the handoff header and glass container.
- **Settings overview:** read-only summary cards route into the authoritative full Settings page.

### Overlays

Problems, Good Life, Brain Storage, Vibe, expanded Chat, and invariant editor use one glass modal recipe:

- Fixed blurred backdrop.
- Bounded, scrollable glass panel.
- Semantic `role="dialog"`, `aria-modal="true"`, and labelled title.
- Close through backdrop, close button, and Escape.
- Focus moves into the opened overlay and returns to the invoking control.
- Body scrolling is suppressed while an overlay is open.

Production contents and actions stay intact:

- Problems keeps operator summary, active/resolved separation, verifier evidence, user intervention, and re-verification.
- Good Life keeps tabs, list/detail workspace, worker routes, refresh, and re-verification.
- Brain Storage keeps disk/live detail and mismatch semantics.
- Vibe keeps image, prompt, metadata, direct image/gallery links, and archive navigation where data supports it.
- Chat keeps state, conversations, attachments, streaming, and stop behavior.
- Invariant editor keeps technical verifier/remediation JSON editing and delete/save actions; its new list shell is an entry point, not a replacement.

### Full Settings and related pages

The full Settings page, standalone Chat, Vibe gallery, Welcome, and Setup surfaces consume the light token layer without inheriting dashboard-only navigation or layout rules. Their routes, forms, and actions remain unchanged.

## Data Flow and State

Existing data ownership remains unchanged:

- `loadHumanHomeSurface()` fans out to weather, sauna, pool, live problems, Good Life, state, agency, pulse, home summary, and briefs.
- WebSocket engine events update the top-bar pulse state and cycle.
- Chat owns its existing singleton state and SSE/turn lifecycle.
- Brief selection remains in `briefsState`.
- Overlay renderers continue to use their current fetched payloads.
- Settings overview performs read-only GETs and never calls write or PM2 lifecycle routes.

Presentation adapters may derive:

- Hero kicker and footer text from existing pulse/status/context values.
- Sauna heating state and active preset from current metrics/action fields.
- Settings summary rows from agents, feeder, vibe/system config, and safe dashboard sensor state.
- Brain mismatch status from current disk/live values and existing API status.

No sample value from the prototype is used as a production fallback.

## Error and Offline Behavior

- Existing `offlineTilePayload()` behavior remains and receives readable light-theme styling.
- Failed Home feeds show local offline text without replacing successful sibling data.
- COSMO offline retains Start/Retry and status feedback.
- Query unavailable/error states remain visible.
- Chat connection/turn errors remain inline and do not discard the draft or selected conversation.
- Overlay fetch failures render inside the panel with a close path still available.
- External font failure falls back to the existing system font stack.
- Missing second timezone collapses cleanly without leaving layout gaps.

## Responsive Behavior

Primary fidelity target is 1200px and wider.

- Top bar wraps without clipping or losing controls.
- Hero type and spacing clamp; clocks move below the remark when necessary.
- Sensor strip auto-fits cards and never requires horizontal scrolling.
- Home main area stacks below approximately 1000px.
- Agency/Workers/Settings two-column groups stack below approximately 900px.
- Briefs and Brain Map collapse to list-first/detail-second layouts.
- Chat overlay fills small viewports while keeping its composer reachable above the software keyboard.
- At 390px and 320px, all primary actions remain reachable, touch targets are at least 44px where practical, and the document has no horizontal overflow.

## Accessibility

- Native buttons, anchors, inputs, selects, and textareas replace clickable generic elements.
- Tab controls expose `role="tab"`, `aria-selected`, and `aria-controls` or equivalent button semantics.
- All icon-only controls have accessible names.
- `:focus-visible` styling is obvious against glass surfaces.
- Overlay focus is contained and restored.
- Status updates use appropriate live regions without announcing every poll.
- Reduced-motion disables pulse animation and modal transition.
- Small muted/status text uses contrast-adjusted variants where the supplied token does not meet AA.
- Zoom to 200% remains usable.

## File Boundaries

Expected production changes:

- `engine/src/dashboard/home23-dashboard.html` — shell, Home composition, Settings overview, overlay semantics, COSMO header.
- `engine/src/dashboard/home23-dashboard.css` — light tokens and dashboard/native-panel/overlay presentation.
- `engine/src/dashboard/home23-dashboard.js` — settings native tab, derived hero/sauna/settings state, scoped tile controls, global overlay Escape/focus behavior, one-second clock cadence.
- `engine/src/dashboard/home23-chat.css` — light Chat tile/overlay/standalone styling.
- `engine/src/dashboard/home23-chat.js` — only accessibility or presentation bindings required by changed markup; no protocol rewrite.
- `engine/src/dashboard/home23-settings.css` — full Settings light theme.
- `engine/src/dashboard/home23-settings.html` — font/token/body class and shell-level semantics only if needed.
- `engine/src/dashboard/home23-vibe/gallery.html` and `engine/src/dashboard/home23-welcome.html` — consistent light treatment where current inline styling prevents token reuse.
- `tests/dashboard/operator-ui.test.js` plus focused new dashboard presentation tests — structural and preservation contracts.

Avoid unless proven necessary:

- `engine/src/dashboard/server.js`
- `engine/src/dashboard/home23-settings-api.js`
- `engine/src/dashboard/home23-settings.js`
- engine, harness, PM2, config, secret, and instance files

## Test Strategy

### Automated preservation contracts

- Top bar contains every required route and native panel target.
- Core production IDs and render functions remain.
- Home contains hero, five-card strip, Chat/Vibe/Briefs main area, and only sensor cards are layout-managed.
- Chat shared-template and slot-move contracts remain.
- All six overlays retain their production actions and gain Escape/dialog semantics.
- Settings full route remains linked and no dashboard overview control invokes write routes.
- Dark shell/sidebar markup is absent from the dashboard.
- No prototype runtime or sample data is shipped.

### Focused commands

```bash
node --check engine/src/dashboard/home23-dashboard.js
node --check engine/src/dashboard/home23-chat.js
node --test --test-concurrency=1 tests/dashboard/operator-ui.test.js
node --import tsx --test --test-concurrency=1 tests/dashboard/chat-state.test.ts
node --test --test-concurrency=1 tests/dashboard/briefs.test.js tests/dashboard/forrest-feel-route.test.js
```

### Broad commands

```bash
npm run build
npm test
npm run test:contracts
npm run test:contracts:live
git diff --check
```

Live contracts remain read-only. `HOME23_LIVE_CONTRACTS_ACTIONS=1` is not used for this visual overhaul.

### Browser verification

Validate the live dashboard at 1440, 1200, 1024, 768, 390, and 320px:

- Every tab and hash deep link.
- Home live data, independent offline states, and polling stability.
- Chat send/stream/stop, conversations, agent/model controls, attachments, and tile-to-overlay state.
- Sauna presets and action request shape without issuing a live start/stop unless explicitly approved.
- Problems, Good Life, Brain Storage, Vibe, Chat, and invariant editor open/close/focus/Escape behavior.
- COSMO iframe/offline treatment without restarting it during QA.
- Brief selection/deep links, Worker form rendering, Query states, and Brain Map mount.
- Settings overview links and full Settings page rendering without write actions.
- No console errors, horizontal overflow, invisible focus, clipped controls, or dark-theme remnants.

## Acceptance Criteria

The update is complete only when:

1. The dashboard visually matches the supplied light-glass handoff at the primary laptop target.
2. All documented dashboard surfaces and six overlays use the new design language.
3. Every existing functional route, data source, action, and production-only detail remains reachable.
4. Stored runtime/config/instance data is untouched.
5. Focused and broad automated checks pass.
6. Read-only live contracts pass.
7. Browser checks prove navigation, live rendering, responsive behavior, accessibility basics, Chat state preservation, and clean console output.
8. A durable verification report records exact commands, results, screenshots, and any intentionally unexercised live-write actions.
