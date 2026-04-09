# Step 9b: Dashboard COSMO Embed — OS Home Screen

**Date:** 2026-04-07
**Status:** Approved

## Summary

Redesign the Home23 dashboard from a "tile viewer with links" to an "OS home screen with embedded apps." The COSMO tab loads the full COSMO 2.3 UI inside an iframe. The tab bar becomes the OS dock — Home (tiles), COSMO (research), Evobrew (IDE, new tab). All URLs use `window.location.hostname` instead of hardcoded localhost, fixing Tailscale/remote access.

## 1. Dashboard Tab Bar as OS Dock

| Tab | What | How |
|---|---|---|
| Home | Agent tiles, brain log, COSMO status indicator | Native HTML (existing) |
| COSMO | Full COSMO 2.3 research UI (all 9 tabs) | iframe, full content area |
| Evobrew | Opens AI IDE in new tab | Link (stays as-is, URL fix only) |

Clicking COSMO hides the Home panel and shows a full-bleed iframe. Clicking Home hides the iframe and shows tiles. Tab bar stays visible at all times. The iframe preserves state — switching away and back doesn't reload COSMO.

## 2. iframe Implementation

```html
<iframe id="cosmo23-frame"
  src=""
  style="display:none; width:100%; height:calc(100vh - 48px); border:none;">
</iframe>
```

- Starts hidden with empty src
- On first COSMO tab click: set `src` to `http://${window.location.hostname}:${cosmo23Port}`, show iframe
- On subsequent clicks: just toggle visibility (no reload — preserves COSMO state)
- On Home tab click: hide iframe, show tiles

## 3. Host-Relative URLs

All URLs constructed at runtime from `window.location.hostname` + port. Never hardcoded to localhost.

The dashboard config endpoint (`/home23/config.json`) returns ports only:
```json
{
  "evobrewPort": 3415,
  "cosmo23Port": 43210
}
```

Dashboard JS constructs full URLs:
```javascript
const host = window.location.hostname;
const cosmo23Url = `http://${host}:${config.cosmo23Port}`;
const evobrewUrl = `http://${host}:${config.evobrewPort}`;
```

This works over:
- `localhost` (local dev)
- `192.168.x.x` (LAN)
- `jtrs-mac-mini-2198.tail11290e.ts.net` (Tailscale)

Fixes the existing evobrew button URL too (currently broken over Tailscale).

## 4. COSMO Status Indicator on Home Tab

A single-line status indicator on the Home tab, alongside agent tiles:

- **Idle:** "🔬 COSMO: idle"
- **Running:** "🔬 COSMO: running — [run-name]" (with green pulse dot)
- **Offline:** "🔬 COSMO: offline" (with gray dot)

Polls `http://${host}:${cosmo23Port}/api/status` every 30 seconds. Clicking the indicator switches to the COSMO tab.

## 5. What Gets Removed

- The `cosmo23-panel` div (status dot, runs list, launch button)
- The `loadCosmoPanel()` function and all its supporting JS
- The `.h23-cosmo-panel`, `.h23-cosmo-status`, `.h23-cosmo-run-info`, `.h23-cosmo-runs-list`, `.h23-cosmo-launch-btn` CSS classes
- The `h23-cosmo-brain-link` styles
- The 30s panel refresh interval for the old panel

## 6. What Stays

- COSMO button in tab bar (changed from `<a>` link to `<button>` or click-handled `<a>` — no longer opens new tab)
- `.h23-tab-cosmo23` CSS (blue accent, may adjust slightly)
- `COSMO23_PORT` env var in dashboard processes
- `/home23/config.json` endpoint (modified to return ports not URLs)

## 7. What Changes

| File | Change |
|---|---|
| `engine/src/dashboard/home23-dashboard.html` | Remove COSMO panel, add iframe, add status indicator to Home |
| `engine/src/dashboard/home23-dashboard.css` | Remove panel styles, add iframe container + status indicator styles |
| `engine/src/dashboard/home23-dashboard.js` | Replace panel logic with iframe toggle + host-relative URLs + status polling |
| `engine/src/dashboard/server.js` | Config endpoint returns ports instead of full URLs |

## 8. Design Principles

- The dashboard IS the OS home screen. You don't leave it to use COSMO.
- COSMO's UI is mature and complete — embed it, don't rebuild it.
- Host-relative URLs so the system works from any network path.
- iframe preserves COSMO state across tab switches.
- Evobrew stays as a new-tab link — it's a full IDE that needs its own window.
