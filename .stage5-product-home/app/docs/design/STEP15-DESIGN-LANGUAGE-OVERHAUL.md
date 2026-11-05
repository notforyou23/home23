# Step 15: ReginaCosmo Design Language for Home23

Bring the visual personality from the ReginaCosmo dashboard (`:3508`) into every Home23 page. CSS-focused overhaul — no new functionality, no new tiles, same HTML structure.

## Reference

The live ReginaCosmo dashboard at `http://192.168.7.131:3508` is the source of truth. Match it exactly — don't invent new styles.

## Scope

All pages under `/home23`:
- Home tab (tiles, header, pills, brain log)
- Intelligence tab
- Settings tab
- Chat (tile, overlay, standalone page)
- Vibe gallery
- Welcome/onboarding screen

## Changes

### 1. Background & Atmosphere

Replace flat `#0a1628` body background with the ReginaCosmo space gradient:

- Deep navy gradient at ~135deg with subtle teal/blue variation
- Fixed-position star field — tiny dots at varying opacities (0.2–0.5), scattered across the viewport
- CSS-only implementation: `background` gradient on body + pseudo-element or inline SVG for stars
- No canvas, no animation, no JS

### 2. Glass-Morphism Tiles

Replace opaque solid tiles with translucent glass:

| Property | Current | Target |
|---|---|---|
| Background | `#111d33` (solid) | `rgba(17, 29, 51, 0.7)` (translucent) |
| Backdrop | none | `backdrop-filter: blur(12px)` |
| Border | `1px solid #1a2a44` | `1px solid rgba(88, 166, 255, 0.15)` |
| Border-radius | 12px | 12px (unchanged) |
| Padding | 20px | 20px (unchanged) |

Applies to:
- `.h23-tile` (all tile variants)
- `.h23-tile-brainlog`
- Intelligence cards (`.h23-intel-card`, `.h23-intel-insight`, `.h23-intel-stat`)
- Settings cards/sections
- Chat container
- Gallery items

### 3. Header

Match ReginaCosmo header layout:

- **Left side:**
  - `● Home23` — logo with dot prefix, bold, white
  - Subtitle line: `<AGENT_NAME> · AUTONOMOUS INTELLIGENCE · 🎨GALLERY · 🌐OPERATIONS REGISTRY`
  - Gallery link points to `/home23/vibe-gallery`
- **Right side:**
  - Dual timezone clocks with flag emojis — primary from agent config timezone, secondary from `dashboard.secondaryTimezone` in home.yaml (optional — single clock if not configured)
  - Large time numbers (32px), lightweight font weight
  - Location labels next to each clock (e.g., "NJ", "FLORENCE")
  - `● COSMO active` status indicator below clocks

### 4. Status Pills

Add emoji prefixes to match ReginaCosmo sensor bar:

- `🌡 48°F · 66%` — weather (if available, otherwise omit)
- `🧖 50°F Off` — sauna (if available, otherwise omit)  
- `🧠 cycle 3667 · qwen3` — brain cycle + current model (always shown)
- `sensors 1m ago` — last update timestamp

For the public release, only the brain pill ships (cycle + model). Weather/sauna are personal tiles — future feature.

### 5. Tab Bar

Add emoji prefixes to tab labels:

- `Home` (active tab, no emoji needed — it's the default)
- `Intelligence`
- `🐢 Terrapin` → becomes agent-specific tab, using agent displayName
- Settings tab (gear icon or text)
- COSMO tab
- Evobrew button

### 6. Tile Headers

Change from plain uppercase to emoji-prefixed:

| Current | Target |
|---|---|
| `COSMO` (or `THOUGHTS`) | `🌊 Cosmo` |
| `VIBE` | `🎨 Vibe` |
| `SYSTEM` | `⚡ System` |
| `BRAIN LOG` | `🧠 BRAIN LOG` |
| `FEEDER` | `📡 Feeder` |

### 7. Brain Log

Match ReginaCosmo brain log style:
- Dark translucent background (same glass treatment)
- `🧠 BRAIN LOG` header with timestamp on the right
- Monospace font for log entries
- Same layout as current (time, role, text)

### 8. Other Pages

**Settings:** Glass cards for each settings section. Same border/blur treatment. Form inputs get subtle glass backgrounds.

**Intelligence:** Glass cards for insights and vitals. The purple accent color for insight borders stays.

**Chat:** Chat container gets glass background. Message bubbles stay readable with slightly higher opacity. Input area gets glass treatment.

**Gallery:** Space background, glass grid items for images.

**Welcome/Onboarding:** Space background, glass card for the welcome message.

## Files Modified

All changes are CSS-focused. Files that need editing:

| File | What changes |
|---|---|
| `engine/src/dashboard/home23-dashboard.css` | Primary: background, tile styles, header, pills, tabs, tile headers, brain log |
| `engine/src/dashboard/home23-dashboard.html` | Header markup (dual clocks, subtitle links), emoji in tile headers, emoji in pills |
| `engine/src/dashboard/home23-dashboard.js` | Populate dual clocks, format pills with emoji |
| `engine/src/dashboard/home23-settings.css` | Glass treatment for settings cards |
| `engine/src/dashboard/home23-settings.html` | Minor: add glass classes if needed |
| `engine/src/dashboard/home23-chat.css` | Glass treatment for chat container |
| `engine/src/dashboard/home23-chat.html` | Minor: glass classes |
| `engine/src/dashboard/home23-vibe/gallery.html` | Glass treatment, space background |
| `engine/src/dashboard/home23-welcome.html` | Glass treatment, space background |

## What Does NOT Change

- HTML layout structure (3-column grid, tile arrangement)
- Functionality (no new features, no new API calls)
- Tab switching behavior
- Chat functionality
- Settings save/load behavior
- Any JS logic beyond clock display and pill formatting

## Design Principle

Match the reference exactly. The ReginaCosmo dashboard has soul — it feels alive, personal, atmospheric. The goal is to bring that same feeling to Home23 without changing what the system does, only how it looks.
