# Step 14: Dashboard Vibe Tile + Gallery

Home23 now has a real `Vibe` system on the dashboard. The center tile is no longer a placeholder. It follows the live `:3508` pattern closely:

- gallery-first display on the dashboard
- archive rotation instead of constant regeneration
- hidden manual trigger via triple-click on the `Vibe` header
- per-agent storage under the agent workspace
- remote-only text generation path for prompt assembly (`ollama-cloud` or `openai`)
- final image generation through OpenAI `gpt-image-1`

This document is the implementation handoff for finishing the feature cleanly and wiring it into onboarding/settings.

## Ground Truth

The reference implementation is the CHAOS MODE flow from the original dashboard system.

What the algorithm is based on:

- CHAOS MODE random category assembly with latest-thought thematic guidance
- Not weighted semantic brain seeding

The live `3508` tile uses:

1. `/api/gallery` as the primary tile data source
2. slideshow rotation every `45s`
3. gallery refresh every `30 min`
4. hidden triple-click on `#vibe-trigger`
5. a prompt built from random category picks plus the latest thought as subtle thematic guidance

## Files Added And Modified

### New files

| File | Purpose |
|---|---|
| `engine/src/dashboard/home23-vibe/service.js` | Home23 Vibe service: archive, policy, generation orchestration, manifest management |
| `engine/src/dashboard/home23-vibe/gallery.html` | Standalone gallery/history page for the current agent |
| `docs/design/STEP14-VIBE-INTEGRATION-DESIGN.md` | This handoff note |

### Existing files modified

| File | What changed |
|---|---|
| `engine/src/dashboard/server.js` | Instantiates the Vibe service and mounts `/home23/api/vibe/*` plus `/home23/vibe-gallery` |
| `engine/src/dashboard/home23-dashboard.html` | Makes the `Vibe` header the hidden trigger target and adds the tile action area |
| `engine/src/dashboard/home23-dashboard.css` | Adds tile/gallery interaction styling |
| `engine/src/dashboard/home23-dashboard.js` | Loads current Vibe state, renders rotated archive images, and handles triple-click generation |
| `engine/src/dashboard/home23-vibe/gallery.html` | Renders a view-only gallery and shows live policy metadata |
| `engine/src/core/image-provider.js` | Switched Home23 Vibe to the real CHAOS MODE path and enforced remote-only text engines |
| `engine/config/image.json` | Vibe image pipeline defaults: remote text engines plus OpenAI image generation |
| `config/home.yaml` | Vibe timing/archive policy in real config |
| `CLAUDE.md` | Project-level pointer to the corrected Step 14 behavior |

### Runtime-generated files

Per-agent Vibe state now lives at:

```text
instances/<agent>/workspace/vibe/
  manifest.json
  images/
    <uuid>.png
    <uuid>.json
```

Per-agent vibe artifacts are stored under `instances/<agent>/workspace/vibe/` with a manifest and image files.

New generations use the CHAOS MODE metadata shape.

## Runtime Architecture

The dashboard server constructs:

```js
this.home23Vibe = new Home23VibeService({
  home23Root: this.getHome23Root(),
  agentName: this.getHome23AgentName(),
  loadState: () => this.loadState(),
  getRecentThoughts: (limit) => this.getRecentThoughts(limit),
  logger: this.logger,
});
```

The Vibe service is scoped to the dashboard process and the active agent. That keeps history, policy, and storage agent-specific.

## Actual Algorithm

### 1. Thematic input

Home23 reads the latest thought via `DashboardServer.getRecentThoughts(1)`.

That thought is not turned into a literal subject. It is passed into CHAOS MODE as a subtle thematic layer.

### 2. CHAOS MODE composition

The actual generator is `createImageProvider().generateChaos(...)` in `engine/src/core/image-provider.js`.

For each generation it picks:

- one random `subject`
- one random `style`
- one random `lighting`
- one random `mood`
- one random `composition`

It also adds up to four optional overlays, each with `40%` chance:

- time context
- evocative weather phrase
- location context
- atmosphere context

Subject reuse is guarded by the in-memory history in `image-provider.js`, matching the original live pattern.

### 3. Prompt assembly

CHAOS MODE sends those components to the `CHAOS PROMPT ENGINE` prompt in `image-provider.js`.

Expected JSON return shape:

```json
{
  "prompt": "scene description",
  "emphasis": "visual detail to emphasize"
}
```

If that LLM step fails, Home23 falls back to a simple direct assembled prompt.

### 4. Text-engine provider path

For prompt assembly and commentary, Home23 Vibe is now remote-only.

It will use:

1. the current agent `chat.provider` / `chat.defaultProvider` if it is `ollama-cloud` or `openai`
2. otherwise the home-level `chat.provider` / `chat.defaultProvider` if it is `ollama-cloud` or `openai`
3. otherwise the defaults from `engine/config/image.json`

Local Ollama is explicitly rejected for Home23 Vibe.

This matters because onboarding/settings already own the provider choice and credentials. Vibe now follows that system path instead of quietly relying on local Ollama.

### 5. Final image generation

The final image still goes through OpenAI:

- provider: `openai`
- model: `gpt-image-1`

The prompt-engine model can be `ollama-cloud` or `openai`, but the image call itself is OpenAI.

### 6. Storage and manifest entry

The raw image provider writes its first output into `engine/data/images/`.
The Vibe service then copies that file into the per-agent Vibe archive and writes its own metadata.

New-style item shape:

```json
{
  "id": "uuid",
  "agentName": "<agent-name>",
  "imagePath": "/abs/path/to/file.png",
  "generatedAt": "2026-04-09T16:22:48.246Z",
  "createdAt": "2026-04-09T16:22:48.265Z",
  "caption": "final prompt or fallback caption",
  "prompt": "full final prompt sent to image generation",
  "thought": "same as prompt for tile/gallery compatibility",
  "promptTemplate": "CHAOS MODE random category assembly plus latest-thought theme",
  "provider": "openai",
  "model": "gpt-image-1",
  "algorithm": "chaos-mode",
  "themeThought": "latest thought excerpt"
}
```

Legacy items may still contain `seed`, `adjacency`, and `recentThought`. Those are historical artifacts from the earlier incorrect pass, not the target design.

## Tile Behavior

### Dashboard tile

`engine/src/dashboard/home23-dashboard.js` now does this:

1. fetch `/home23/api/vibe/current`
2. show the selected archive item, not always the newest item
3. rotate through the archive based on `rotationIntervalSeconds`
4. keep showing archive images while a new generation is in flight
5. open the gallery from the tile image/action row
6. trigger manual generation only via triple-click on `#vibe-trigger`

The visible “generate” buttons were removed on purpose to reduce spend.

### Gallery page

`engine/src/dashboard/home23-vibe/gallery.html` is now view-only.

It fetches `/home23/api/vibe/gallery`, renders the archive grid, and shows:

- archive size
- generation interval
- rotation interval
- current generation status
- per-image details in the lightbox

## API Surface

All routes are mounted by `engine/src/dashboard/server.js`.

### `GET /home23/api/vibe/current`

Returns:

- `agentName`
- `generating`
- `status`
- `total`
- `generationDue`
- `policy`
- `latestItem`
- `item`

Important distinction:

- `latestItem` = newest generated file
- `item` = currently displayed archive item

### `POST /home23/api/vibe/generate`

Starts a generation if none is already running. Requests are serialized per dashboard process through `this.generationPromise`.

This route is intended for the hidden triple-click path.

### `GET /home23/api/vibe/gallery`

Returns the current archive list plus the live policy block.

### `GET /home23/vibe-gallery`

Serves the gallery UI page.

## Policy And Config

Current real config lives in:

- `config/home.yaml`
- optional override in `instances/<name>/config.yaml`

Current shape:

```yaml
dashboard:
  vibe:
    autoGenerate: true
    generationIntervalHours: 12
    rotationIntervalSeconds: 45
    galleryLimit: 60
```

Current behavior:

1. rotate through existing images
2. only auto-generate when the newest image is older than `generationIntervalHours`
3. keep a retry backoff so failed auto-generation does not retrigger constantly
4. allow hidden manual override via triple-click

Prompt-engine defaults live in `engine/config/image.json`, but Home23 Vibe now resolves the active remote text provider from the real Home23 config path described above.

## Verification

Verified during implementation:

- syntax checks:
  - `node -c engine/src/core/image-provider.js`
  - `node -c engine/src/dashboard/home23-vibe/service.js`
  - `node -c engine/src/dashboard/home23-dashboard.js`
  - `node -c engine/src/dashboard/server.js`
- dashboard process restart only:
  - `pm2 restart home23-<name>-dash`
- live URLs:
  - `http://localhost:5002/home23`
  - `http://localhost:5002/home23/vibe-gallery`
- hidden trigger:
  - triple-click on the Vibe header generated a new archive image during validation
- post-fix direct API verification:
  - `POST /home23/api/vibe/generate` created `499b4294-6942-4a42-9819-986052bc4bb4`
  - `GET /home23/api/vibe/current` now returns that item as `latestItem` with `algorithm: "chaos-mode"` and `themeThought`

## Remaining Work

### Onboarding/settings wiring

The runtime behavior exists, but the dedicated Vibe controls are not yet exposed in `/home23/settings`.

The next clean settings fields are:

1. `dashboard.vibe.autoGenerate`
2. `dashboard.vibe.generationIntervalHours`
3. `dashboard.vibe.rotationIntervalSeconds`
4. `dashboard.vibe.galleryLimit`
5. optional toggle for hidden manual generation

### Provider/image tuning

If you want user-facing image tuning later, add settings for:

1. Vibe prompt-engine provider override
2. Vibe prompt-engine model override
3. OpenAI image model/size/quality override

That is optional. The current implementation already follows the system remote provider path and avoids local Ollama.

### Cleanup

The manifest is capped, but there is no pruning job yet for orphaned old image files on disk.

## Read First Next Time

If this feature needs more work, start here:

1. `docs/design/STEP14-VIBE-INTEGRATION-DESIGN.md`
2. `engine/src/dashboard/home23-vibe/service.js`
3. `engine/src/core/image-provider.js`
4. `engine/src/dashboard/server.js`
5. `engine/src/dashboard/home23-dashboard.js`
6. `engine/src/dashboard/home23-vibe/gallery.html`
