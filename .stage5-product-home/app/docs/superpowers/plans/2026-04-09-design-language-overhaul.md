# ReginaCosmo Design Language Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat dark theme with the ReginaCosmo glass-morphism design language across all Home23 dashboard pages.

**Architecture:** CSS variable overhaul + targeted HTML changes for header/emoji. The ReginaCosmo source at `the ReginaCosmo source styles.css` and `index.html` is the reference. All work happens in `$TARGET/`.

**Tech Stack:** CSS (custom properties, backdrop-filter, gradients), vanilla HTML/JS, Google Fonts (Inter)

**Reference dashboard:** `http://192.168.7.131:3508` (live, use Playwright to screenshot for comparison)

---

## Task 1: CSS Variables & Background

Replace the flat background with the ReginaCosmo space gradient and update all CSS custom properties.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.css`

- [ ] **Step 1: Replace CSS custom properties**

In `engine/src/dashboard/home23-dashboard.css`, replace the entire `:root` block (lines 3-18) with:

```css
:root {
  /* ReginaCosmo glass design system */
  --glass-primary: rgba(255, 255, 255, 0.10);
  --glass-secondary: rgba(255, 255, 255, 0.06);
  --glass-border: rgba(255, 255, 255, 0.18);
  --bg-gradient: linear-gradient(135deg,
    hsl(220, 100%, 6%) 0%,
    hsl(210, 90%, 10%) 25%,
    hsl(200, 80%, 14%) 50%,
    hsl(190, 85%, 12%) 75%,
    hsl(180, 90%, 8%) 100%);
  --text-primary: rgba(255, 255, 255, 0.98);
  --text-secondary: rgba(255, 255, 255, 0.82);
  --text-muted: rgba(255, 255, 255, 0.45);
  --text-dim: rgba(255, 255, 255, 0.25);
  --accent-blue: #0A84FF;
  --accent-green: #30D158;
  --accent-orange: #FF9F0A;
  --accent-red: #FF453A;
  --accent-purple: rgba(120, 100, 255, 0.25);
  --shadow-glass: 0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
}
```

- [ ] **Step 2: Update body styles**

Replace the existing `body` rule with:

```css
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  background: var(--bg-gradient);
  background-attachment: fixed;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
  overflow-x: hidden;
}

body::before {
  content: '';
  position: fixed;
  top: -50%; left: -50%;
  width: 200%; height: 200%;
  background: radial-gradient(ellipse at 30% 20%, rgba(0,122,255,0.08) 0%, transparent 60%),
              radial-gradient(ellipse at 70% 80%, rgba(0,199,190,0.06) 0%, transparent 60%);
  pointer-events: none;
  z-index: 0;
}
```

- [ ] **Step 3: Add particle/star canvas container CSS**

Add after the body rule:

```css
#particles-js {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  z-index: 0;
  pointer-events: none;
}
```

- [ ] **Step 4: Ensure all content sits above background**

Add z-index to the main containers:

```css
.h23-header, .h23-pills, .h23-tabs, .h23-main {
  position: relative;
  z-index: 1;
}
```

- [ ] **Step 5: Verify background renders**

Open `http://localhost:5002/home23` (or load the file locally). The background should show a deep navy-to-teal gradient with subtle radial light effects. No stars yet (particles.js added in Task 2).

- [ ] **Step 6: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-dashboard.css
git commit -m "style: ReginaCosmo CSS variables and space gradient background"
```

---

## Task 2: Particle Star Field

Add the particles.js star field matching the ReginaCosmo reference.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.js`

- [ ] **Step 1: Add particles.js CDN and canvas element to HTML**

In `engine/src/dashboard/home23-dashboard.html`, add inside `<head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
```

Add as the first child of `<body>` (before any other content):

```html
<div id="particles-js"></div>
```

Add before the closing `</body>` tag:

```html
<script src="https://cdn.jsdelivr.net/npm/particles.js@2.0.0/particles.min.js"></script>
```

- [ ] **Step 2: Initialize particles in JS**

In `engine/src/dashboard/home23-dashboard.js`, add an initialization function and call it on DOMContentLoaded:

```javascript
function initParticles() {
  if (typeof particlesJS === 'undefined') return;
  particlesJS('particles-js', {
    particles: {
      number: { value: 40, density: { enable: true, value_area: 1000 } },
      color: { value: ['#ffffff', '#007AFF', '#00C7BE', '#30D158'] },
      shape: { type: 'circle' },
      opacity: { value: 0.3, random: true, anim: { enable: true, speed: 1, opacity_min: 0.1, sync: false } },
      size: { value: 3, random: true, anim: { enable: true, speed: 2, size_min: 1, sync: false } },
      line_linked: { enable: true, distance: 200, color: '#ffffff', opacity: 0.15, width: 1 },
      move: { enable: true, speed: 0.8, direction: 'none', random: true, straight: false, out_mode: 'out', bounce: false }
    },
    interactivity: {
      detect_on: 'canvas',
      events: { onhover: { enable: true, mode: 'bubble' }, onclick: { enable: false }, resize: true },
      modes: { bubble: { distance: 200, size: 6, duration: 2, opacity: 0.6, speed: 3 } }
    },
    retina_detect: true
  });
}
```

Call `initParticles()` inside the existing DOMContentLoaded handler.

- [ ] **Step 3: Verify star field**

Reload the dashboard. Subtle animated dots should float across the background — white, blue, teal, and green. Lines connect nearby dots. Hovering causes a bubble effect. The particles should be behind all content.

- [ ] **Step 4: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-dashboard.js
git commit -m "style: particles.js star field matching ReginaCosmo"
```

---

## Task 3: Glass-Morphism Tiles

Replace opaque tiles with translucent glass cards.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.css`

- [ ] **Step 1: Update tile base styles**

Replace the `.h23-tile` rule with:

```css
.h23-tile {
  background: var(--glass-primary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-glass);
  position: relative;
  overflow: hidden;
}

.h23-tile::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
}
```

- [ ] **Step 2: Update tile header styles**

Replace `.h23-tile-header` with:

```css
.h23-tile-header {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 6px;
  letter-spacing: 0.01em;
}
```

- [ ] **Step 3: Update brain log tile**

Replace `.h23-tile-brainlog` with:

```css
.h23-tile-brainlog {
  background: var(--glass-primary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-glass);
  position: relative;
  overflow: hidden;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.h23-tile-brainlog::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
}
```

- [ ] **Step 4: Update brain log header**

Add new rules for the brain log header area:

```css
.h23-brainlog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  flex-shrink: 0;
}

.h23-brainlog-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: rgba(160,160,255,0.8);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.h23-brainlog-stamp {
  font-size: 0.7rem;
  color: var(--text-dim);
}
```

- [ ] **Step 5: Update brain log output area**

Replace `.h23-brain-log` with:

```css
.h23-brain-log {
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 0.72rem;
  line-height: 1.5;
  color: rgba(200,220,200,0.8);
  background: rgba(0,0,0,0.3);
  margin: 0;
  padding: 12px 16px;
  overflow-y: auto;
  max-height: 220px;
  white-space: pre-wrap;
  word-break: break-all;
}
```

- [ ] **Step 6: Update text colors throughout**

Replace remaining old color references:
- `var(--h23-text)` → `var(--text-primary)`
- `var(--h23-text-secondary)` → `var(--text-secondary)`
- `var(--h23-text-muted)` → `var(--text-muted)`
- `var(--h23-accent)` → `var(--accent-blue)`
- `var(--h23-green)` → `var(--accent-green)`
- `var(--h23-orange)` → `var(--accent-orange)`
- `var(--h23-red)` → `var(--accent-red)`
- `var(--h23-bg-card)` → `var(--glass-primary)`
- `var(--h23-border)` → `var(--glass-border)`
- `var(--h23-radius)` → `var(--radius-lg)`
- `var(--h23-radius-sm)` → `var(--radius-md)`
- `var(--h23-pill-bg)` → `rgba(255,255,255,0.07)`
- `var(--h23-tab-active)` → `var(--accent-purple)`

Do a full find-and-replace across the CSS file for each old variable.

- [ ] **Step 7: Verify tiles**

Reload dashboard. Tiles should be translucent with the space background visible behind them. Subtle top-edge highlight gradient. Glass shadow depth.

- [ ] **Step 8: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-dashboard.css
git commit -m "style: glass-morphism tiles with backdrop blur and shadow"
```

---

## Task 4: Header, Pills, Tabs & Tile Headers

Update the header to match ReginaCosmo layout, add emoji to pills/tabs/tiles.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.html`
- Modify: `engine/src/dashboard/home23-dashboard.css`
- Modify: `engine/src/dashboard/home23-dashboard.js`

- [ ] **Step 1: Update header HTML**

In `engine/src/dashboard/home23-dashboard.html`, replace the header section with:

```html
<div class="h23-header">
  <div class="h23-header-left">
    <div class="h23-logo">● Home23</div>
    <div class="h23-subtitle" id="header-subtitle">AUTONOMOUS INTELLIGENCE · <a href="/home23/vibe-gallery" style="color:inherit;text-decoration:none;">🎨GALLERY</a></div>
  </div>
  <div class="h23-header-right">
    <div class="time-cluster">
      <div class="time-loc">
        <span class="time-flag" id="tz1-flag">🇺🇸</span>
        <span class="time-display" id="tz1-time">--:--</span>
        <span class="time-tz" id="tz1-label">--</span>
      </div>
      <div class="time-loc" id="tz2-container" style="display:none;">
        <span class="time-flag" id="tz2-flag">🇮🇹</span>
        <span class="time-display" id="tz2-time">--:--</span>
        <span class="time-tz" id="tz2-label">--</span>
      </div>
    </div>
    <div class="cosmo-status">
      <span class="status-dot" id="cosmo-dot"></span>
      <span id="cosmo-status-text">COSMO</span>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Update header CSS**

Replace the header CSS section in `home23-dashboard.css` with:

```css
.h23-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  margin-bottom: 0.5rem;
}

.h23-logo {
  font-size: 1.8rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  background: linear-gradient(135deg, #fff 0%, rgba(255,255,255,0.7) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.h23-subtitle {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.time-cluster { display: flex; gap: 16px; align-items: center; }
.time-loc { display: flex; align-items: center; gap: 5px; }
.time-flag { font-size: 1rem; }
.time-tz { font-size: 0.7rem; color: var(--text-dim); opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
.time-display {
  font-size: 1.6rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.cosmo-status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  justify-content: flex-end;
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: rgba(255,255,255,0.3);
  transition: background 0.3s;
}

.status-dot.alive {
  background: var(--accent-green);
  box-shadow: 0 0 6px rgba(48,209,88,0.6);
  animation: pulse-dot 2s ease-in-out infinite;
}

.status-dot.dead { background: var(--accent-red); }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

- [ ] **Step 3: Update pill styles**

Replace `.h23-pill` CSS with:

```css
.h23-pill {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  white-space: nowrap;
}

.h23-pill.dim { opacity: 0.5; }
```

- [ ] **Step 4: Update tab styles**

Replace `.h23-tab` CSS with:

```css
.h23-tab {
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.6);
  padding: 6px 18px;
  border-radius: 20px;
  font-size: 0.85rem;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s;
}

.h23-tab:hover {
  background: rgba(255,255,255,0.12);
  color: var(--text-primary);
}

.h23-tab.active {
  background: var(--accent-purple);
  border-color: rgba(120,100,255,0.5);
  color: #fff;
}
```

- [ ] **Step 5: Update tile headers in HTML with emoji**

In `home23-dashboard.html`, update tile headers:
- Thoughts tile: `<div class="h23-tile-header">🌊 Cosmo</div>`
- Vibe tile: `<div class="h23-tile-header"><span id="vibe-trigger">🎨 Vibe</span></div>`
- System tile: `<div class="h23-tile-header">⚡ System</div>`
- Brain log: update to use the new `h23-brainlog-header` structure:
  ```html
  <div class="h23-brainlog-header">
    <span class="h23-brainlog-title">🧠 BRAIN LOG</span>
    <span class="h23-brainlog-stamp" id="brainlog-stamp"></span>
  </div>
  ```

- [ ] **Step 6: Add clock JS**

In `engine/src/dashboard/home23-dashboard.js`, add a clock update function:

```javascript
function updateClocks() {
  const agentTz = window.__agentTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const fmt = (tz) => now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true });
  const fmt24 = (tz) => now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });

  const tz1Time = document.getElementById('tz1-time');
  if (tz1Time) tz1Time.textContent = fmt(agentTz);

  const tz1Label = document.getElementById('tz1-label');
  if (tz1Label) tz1Label.textContent = agentTz.split('/').pop().replace(/_/g, ' ');

  // Secondary timezone (if configured)
  const secondaryTz = window.__secondaryTimezone;
  const tz2Container = document.getElementById('tz2-container');
  if (secondaryTz && tz2Container) {
    tz2Container.style.display = 'flex';
    const tz2Time = document.getElementById('tz2-time');
    if (tz2Time) tz2Time.textContent = fmt24(secondaryTz);
    const tz2Label = document.getElementById('tz2-label');
    if (tz2Label) tz2Label.textContent = secondaryTz.split('/').pop().replace(/_/g, ' ');
  }
}
```

Call `updateClocks()` on load and every 10 seconds via `setInterval(updateClocks, 10000)`.

- [ ] **Step 7: Update pill content in JS**

In the function that populates pills, add emoji prefixes:
- Brain pill: `🧠 cycle ${cycleCount} · ${modelName}`
- Sensor pill (timestamp): `sensors ${timeAgo}`

- [ ] **Step 8: Update brain log timestamp**

In the JS that renders the brain log, set `brainlog-stamp` to the current time:

```javascript
const stamp = document.getElementById('brainlog-stamp');
if (stamp) stamp.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
```

- [ ] **Step 9: Verify**

Reload dashboard. Check:
- Logo has gradient text effect
- Dual clock area shows primary timezone (secondary hidden if not configured)
- Status pills have emoji
- Tabs have glass style with purple active state
- Tile headers show emoji
- Brain log has the new header with timestamp

- [ ] **Step 10: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-dashboard.html engine/src/dashboard/home23-dashboard.css engine/src/dashboard/home23-dashboard.js
git commit -m "style: ReginaCosmo header, clocks, pills, tabs, emoji tile headers"
```

---

## Task 5: Settings Page Glass Treatment

Apply the glass design language to the settings page.

**Files:**
- Modify: `engine/src/dashboard/home23-settings.css`
- Modify: `engine/src/dashboard/home23-settings.html`

- [ ] **Step 1: Read the current settings CSS**

Read `engine/src/dashboard/home23-settings.css` to understand the current structure.

- [ ] **Step 2: Update settings page background and cards**

The settings page loads the dashboard CSS (shared variables). Update `home23-settings.css` to use glass variables:

- Replace any `background: #111d33` or similar solid backgrounds with `background: var(--glass-primary); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);`
- Replace border colors with `var(--glass-border)`
- Replace text colors with the new `--text-*` variables
- Add `box-shadow: var(--shadow-glass)` to card containers
- Add the `::before` top highlight to cards

- [ ] **Step 3: Update settings HTML if needed**

If the settings page has its own `<body>` or `<style>` block that overrides the background, update it to inherit the space gradient.

- [ ] **Step 4: Verify**

Open `http://localhost:5002/home23/settings`. Settings cards should be glass with the space background visible behind them.

- [ ] **Step 5: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-settings.css engine/src/dashboard/home23-settings.html
git commit -m "style: glass treatment for settings page"
```

---

## Task 6: Chat Page Glass Treatment

Apply glass design to the chat tile, overlay, and standalone page.

**Files:**
- Modify: `engine/src/dashboard/home23-chat.css`
- Modify: `engine/src/dashboard/home23-chat.html` (standalone page)

- [ ] **Step 1: Read the current chat CSS**

Read `engine/src/dashboard/home23-chat.css` to understand the current structure.

- [ ] **Step 2: Update chat CSS**

Apply glass treatment:
- Chat container: `background: var(--glass-primary); backdrop-filter: blur(20px);`
- Message area: `background: rgba(0,0,0,0.3)` (darker for readability)
- Input area: glass background with border
- Replace all old color variables with new ones
- Chat overlay: glass background with border

- [ ] **Step 3: Update standalone chat page**

In `home23-chat.html`, ensure it:
- Loads the Inter font
- Has the space gradient background
- Includes the particles canvas
- Loads particles.js

- [ ] **Step 4: Verify**

Check both:
- Dashboard chat tile on home page
- Standalone chat at `http://localhost:5002/home23/chat`

Both should have glass containers with space background.

- [ ] **Step 5: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-chat.css engine/src/dashboard/home23-chat.html
git commit -m "style: glass treatment for chat tile and standalone page"
```

---

## Task 7: Gallery & Welcome Page Glass Treatment

Apply glass design to remaining pages.

**Files:**
- Modify: `engine/src/dashboard/home23-vibe/gallery.html`
- Modify: `engine/src/dashboard/home23-welcome.html`

- [ ] **Step 1: Update gallery page**

In `home23-vibe/gallery.html`:
- Add Inter font import
- Add space gradient background to body
- Add particles canvas + script
- Update gallery item cards to glass style
- Update text colors to new variables

- [ ] **Step 2: Update welcome page**

In `home23-welcome.html`:
- Add Inter font import
- Add space gradient background
- Add particles canvas + script
- Update the welcome card to glass style

- [ ] **Step 3: Verify**

Check:
- `http://localhost:5002/home23/vibe-gallery` — glass grid items over space background
- Welcome page (clear instances to test, or just inspect the HTML)

- [ ] **Step 4: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-vibe/gallery.html engine/src/dashboard/home23-welcome.html
git commit -m "style: glass treatment for gallery and welcome pages"
```

---

## Task 8: Intelligence Tab Glass Treatment

Apply glass design to the intelligence tab content.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.css`

- [ ] **Step 1: Update intelligence CSS**

In the Intelligence Tab section of `home23-dashboard.css`:

```css
.h23-intel-stat {
  background: var(--glass-primary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 0.8rem;
  text-align: center;
}

.h23-intel-card {
  background: var(--glass-primary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 1rem;
  line-height: 1.6;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.h23-intel-insight {
  background: var(--glass-primary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 0.8rem 1rem;
  margin-bottom: 0.6rem;
  border-left: 3px solid rgba(139, 92, 246, 0.4);
}
```

Update all text color references in the intelligence section to use the new variables.

- [ ] **Step 2: Verify**

Click the Intelligence tab. Cards should be glass with space background visible.

- [ ] **Step 3: Commit**

```bash
cd $TARGET
git add engine/src/dashboard/home23-dashboard.css
git commit -m "style: glass treatment for intelligence tab"
```

---

## Task 9: Final Visual Polish & Cleanup

Remove any remaining old variable references, clean up, do a full visual pass.

**Files:**
- Modify: `engine/src/dashboard/home23-dashboard.css`

- [ ] **Step 1: Search for remaining old variables**

```bash
cd $TARGET
grep -n "h23-bg\|h23-text\|h23-accent\|h23-green\|h23-orange\|h23-red\|h23-pill-bg\|h23-tab-active\|h23-border\|h23-bg-card\|h23-bg-header" engine/src/dashboard/home23-dashboard.css
```

Replace any remaining references with the new variable names.

- [ ] **Step 2: Update scrollbar to match**

```css
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
```

- [ ] **Step 3: Update responsive breakpoint**

In the `@media (max-width: 900px)` section, ensure the glass styles work on smaller screens. `backdrop-filter` is GPU-intensive — consider reducing blur on mobile:

```css
@media (max-width: 900px) {
  .h23-grid-top { grid-template-columns: 1fr; }
  .time-display { font-size: 1.2rem; }
  .h23-tile { backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
}
```

- [ ] **Step 4: Full visual pass**

Open the dashboard and check every page:
1. Home tab — tiles, header, pills, brain log
2. Intelligence tab — vitals, insights, cards
3. Settings tab — all sections
4. Chat tile — messages, input
5. Standalone chat — full page
6. Gallery — grid items
7. Resize to mobile width — verify responsive

Screenshot each for comparison with the ReginaCosmo reference.

- [ ] **Step 5: Commit**

```bash
cd $TARGET
git add -A
git commit -m "style: final polish — cleanup old variables, scrollbar, responsive"
```
