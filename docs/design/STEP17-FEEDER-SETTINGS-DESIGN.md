# Step 17: Feeder Settings Tab Design

**Date:** 2026-04-10
**Status:** Draft → implementation pending

## Summary

Make the document compiler / feeder a first-class configurable subsystem
with a dedicated **Feeder** tab in the Settings UI. Users can:

1. See and edit **what to ingest**: watch paths, glob include patterns, recursive flag
2. Tune **how to ingest**: flush interval, batch size, chunking, compiler model, converter
3. Drop files directly via a **drop zone** (single or multi-file, auto-tagged)
4. See **live ingestion status**: manifest stats, last flush, file counts
5. Get clear **restart notices** for settings that can't hot-reload

## Source-of-truth cleanup

**Important up-front fix:** `instances/<agent>/feeder.yaml` is legacy from
the standalone feeder process that's been stopped since Session 2026-04-10.
The real feeder config lives in `configs/base-engine.yaml` under the
`feeder:` block. The settings API still writes `feeder.yaml` on
agent-create (line ~298), but nothing reads it.

**Decision:** For Step 17, the new Feeder tab reads/writes the `feeder:` block
in `configs/base-engine.yaml` — which is the file the orchestrator actually
consumes at startup. We also leave the dead `feeder.yaml` write in place for
now (it's harmless clutter) and flag it as a follow-up cleanup.

This means **feeder settings are engine-wide**, not per-agent — matching the
current runtime reality. Multiple agents on the same host share the same
feeder behavior. That's a trade-off we're explicitly making: simpler model
vs. per-agent customization. Per-agent feeder config can be added later if a
real use case emerges.

## Tab layout — 5 sections

### 1. Paths & Patterns

- **Active watch paths** list with:
  - Path (editable)
  - Label (editable) — tags all files ingested from this path
  - Include glob (default: `*.{md,txt,json,jsonl,yaml,yml,csv,py,js,bib}`)
  - Recursive checkbox (default: on)
  - Remove button

- **Built-in paths** (read-only, always-on):
  - `<runPath>/ingestion/documents/` — the drop zone (always watched)
  - `COSMO_WORKSPACE_PATH` (if set) — the agent's workspace dir, auto-added by orchestrator

- **Add path** button — opens a row for a new path entry. Shows "Requires restart" badge because `_startWatcher` is bound to the initial scan at startup; the runtime API `addWatchPath()` is available but only adds the watcher, doesn't persist to config. We'll offer a "Save & Restart Engine" action.

- **Exclusions** textarea — list of glob patterns to skip (e.g., `node_modules/**`, `.git/**`, `*.pyc`). Currently chokidar's `ignored` option supports this but the config doesn't expose it — we'll add `config.feeder.excludePatterns` and wire it through to `_startWatcher`.

### 2. Frequency & Batching

- **Flush interval** — number input, seconds (default 30). Drives the setInterval that calls `manifest.flush('interval')`. Requires restart — warns user.
- **Batch size** — number input (default 20). Max items per flush.
- **Chunking**:
  - Max chunk size (chars, default 3000)
  - Overlap (chars, default 300)

### 3. Compiler

- **Enabled** toggle (default on)
- **Model** — dropdown populated from `home.yaml providers.*.defaultModels`. Default: `MiniMax-M3`. The compiler uses this LLM to synthesize raw documents into structured knowledge before brain insertion.
- **Help text** — explains the compiler's role: raw text → concept extraction → BRAIN_INDEX.md update → memory node. Warns that disabling means documents go in as raw chunks (lower quality, more noise).

### 4. Converter (binary formats)

- **Enabled** toggle (default on)
- **Vision model** — text input (default `gpt-4o-mini`). Used by MarkItDown's vision OCR for PDFs with embedded images, scanned documents, etc.
- **Python path** — text input (default `python3`). For the MarkItDown wrapper.
- **Status indicator** — live check of `DocumentConverter.available` (Python + markitdown pip package present). Show "✓ Available" or "✗ markitdown not installed — run `pip install markitdown`".
- **Warning if vision model needs OpenAI but OpenAI provider not configured.**

### 5. Drop Zone

- **Multi-file upload area** (drag-and-drop + file picker, mirrors COSMO 2.3's `#ingest-dropzone` pattern)
- **Label input** — optional tag for the upload batch (default: `dropzone`)
- **Target path** — read-only, shows `<runPath>/ingestion/documents/<label>/` so the user knows where files land
- **Accepted types** — any (feeder handles text directly, binary via converter)
- **Max file size** — 100MB per file (matches COSMO)
- **Upload progress** — per-file progress bars, then ingestion polling (poll `/home23/feeder-status` every 2s for up to 2min to show manifest growth)
- **Recent uploads** — last 10 files uploaded via this tab with status chips (pending, compiled, ingested, error)

### 6. Live status footer (visible on the tab always)

- Watcher count
- Total files in manifest
- Files with `compiled=true`
- Pending / in-flight
- Last flush time
- "Force flush now" button → calls `POST /home23/feeder/flush`

## Backend — new endpoints

All under the existing settings router at `/home23/api/settings/` and the
dashboard at `/home23/`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/home23/api/settings/feeder` | Return current feeder config from `configs/base-engine.yaml` + live runtime status |
| `PUT` | `/home23/api/settings/feeder` | Write new feeder config; return hot-applicable vs restart-required split |
| `POST` | `/home23/feeder/upload` | Multipart upload, multer disk storage → `<runPath>/ingestion/documents/<label>/` |
| `POST` | `/home23/feeder/flush` | Force an immediate manifest flush (useful after a drop-zone upload) |
| `GET` | `/home23/feeder/status` | **Already exists** at `/home23/feeder-status` — augment with more detail (in-flight, last-flush) |

### Save semantics

`PUT /home23/api/settings/feeder` always writes to `configs/base-engine.yaml`.
Classifies each field:

**Hot-reloadable** (applied immediately via engine API if available):
- Adding a new watch path → `feeder.addWatchPath(path, label)`
- Changing `compiler.enabled` / `compiler.model` → we can set on the live feeder instance
- Drop zone uploads (don't need config change)

**Restart-required** (written to yaml, engine restart must happen):
- Flush interval
- Batch size
- Chunking dimensions
- Converter settings
- Removing watch paths (chokidar `unwatch`)
- Exclusion patterns

Response shape:
```json
{
  "ok": true,
  "applied": ["compiler.model"],
  "requiresRestart": ["flush.intervalSeconds", "converter.visionModel"]
}
```

Frontend shows a yellow "Restart required — click to apply" banner when
`requiresRestart` is non-empty. Button runs `pm2 restart home23-<agent>`.

### Upload endpoint

Multer config mirrors COSMO's:
```js
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const label = sanitize(req.body.label || 'dropzone');
      const dir = path.join(runPath, 'ingestion', 'documents', label);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});
app.post('/home23/feeder/upload', upload.array('files', 20), handler);
```

`runPath` = `process.env.COSMO_RUNTIME_DIR` (the engine dashboard already
has this; it's where the manifest lives).

The files land in a chokidar-watched directory (the default drop zone
watcher started at `_startWatcher(ingestDir, null)` in `document-feeder.js:97`),
so the feeder picks them up automatically within ~500ms via file-event flush.

No explicit post-upload registration needed — the watcher handles it.

## Frontend — new tab

- Add a 5th tab button in `engine/src/dashboard/home23-settings.html`:
  `<button class="h23s-tab" data-stab="feeder">Feeder</button>`
- Add a matching panel `<div class="h23s-panel" id="panel-feeder">`
- Follow the existing pattern: sections → field rows → save button at bottom
- Drop zone: reuse COSMO's drag-drop CSS and behavior almost verbatim — just
  point at `/home23/feeder/upload` instead of `/api/feeder/upload`
- Hook up tab switching in `home23-settings.js:setupSubTabs()` — it's already
  data-attribute driven, so adding the new tab just needs a matching `render`
  + `save` function

## Edge cases & decisions

- **Absolute vs relative paths in watch list**: current `additionalWatchPaths`
  accepts relative paths (resolved from cwd) or absolute. We'll normalize to
  absolute on save to avoid the cwd-dependency footgun that bit us earlier
  with evobrew config.

- **Default watch paths**: the UI lists the orchestrator's auto-added paths
  (`ingestion/documents/` and `COSMO_WORKSPACE_PATH`) as read-only entries
  so users understand they're always-on. To disable them they'd need to
  unset `COSMO_WORKSPACE_PATH`, which is an env var — not UI-editable.

- **Per-agent drop zone targeting**: home23 currently runs one engine per
  agent (e.g., `home23-jerry`), so the dashboard on port 5002 is tied to
  jerry's runPath. Multi-agent hosts have one dashboard per agent, so the
  drop zone naturally targets the right agent. No agent-selector needed.

- **Feeder config applies globally**: `configs/base-engine.yaml` is shared
  across all agent engines on this host. A setting change affects all of
  them. The UI shows a single agent's stats in the live status footer
  (the one the dashboard is tied to), but the edit is global. Document
  this clearly in the tab header: "These settings apply to all Home23
  agents on this host."

- **Force flush button**: calls the live feeder's `manifest.flush('manual')`.
  Engine needs a new HTTP route `POST /home23/feeder/flush` (added to
  dashboard `server.js`) that grabs the running orchestrator's `feeder`
  instance and calls flush. Non-destructive; useful for debugging.

## Implementation plan

1. **Design doc** (this file) — done
2. **Backend endpoints** in `engine/src/dashboard/home23-settings-api.js`:
   - `GET /home23/api/settings/feeder` — read base-engine.yaml feeder block + normalize paths + return
   - `PUT /home23/api/settings/feeder` — validate, classify hot vs restart, write yaml, return result
3. **Backend endpoints** in `engine/src/dashboard/server.js`:
   - `POST /home23/feeder/upload` — multer multipart, write to active runPath's ingestion/documents/<label>/
   - `POST /home23/feeder/flush` — call live feeder instance if available
   - Augment `/home23/feeder-status` — return more detail (in-flight count, last flush timestamp)
4. **Frontend tab HTML** in `home23-settings.html` — 5 sections + live footer
5. **Frontend JS** in `home23-settings.js` — `renderFeeder()`, `saveFeeder()`, upload handler, polling
6. **Exclusion pattern plumbing** in `document-feeder.js:_startWatcher` — pass through `excludePatterns` to chokidar `ignored` option
7. **Install multer** if not already installed (COSMO has it, home23 engine might not)
8. **Smoke test**:
   - Load current config, verify UI reflects base-engine.yaml values
   - Change flush interval to 60s, save, verify file + restart banner
   - Add a new watch path, save, verify hot-apply via addWatchPath
   - Drag a .md file to the drop zone, verify it lands in ingestion/documents/dropzone/ and gets ingested
   - Drop a .pdf to verify converter path works (if markitdown installed)
9. **Commit + push + README section**

## Key files

- `configs/base-engine.yaml` — real feeder config (SOT)
- `engine/src/ingestion/document-feeder.js` — the feeder class + runtime API
- `engine/src/core/orchestrator.js:314-340` — where feeder is constructed and started
- `engine/src/dashboard/server.js` — where new HTTP endpoints land
- `engine/src/dashboard/home23-settings-api.js` — where new settings routes land
- `engine/src/dashboard/home23-settings.html` — new tab
- `engine/src/dashboard/home23-settings.js` — new render/save/upload JS
- `cosmo23/public/js/ingestion-tab.js` — reference for drop zone pattern
- `cosmo23/server/index.js:1420-1467` — reference for multer upload handler

## Risks

- **multer dependency**: home23 engine may not have it. Check and `npm install --save multer` if needed.
- **Restart flow destructiveness**: `pm2 restart home23-<agent>` during an active chat or research-in-flight is disruptive. UI should warn clearly and offer a dismiss.
- **base-engine.yaml is shared**: editing this file affects all agents simultaneously. If someone has multiple home23 agents running, a feeder setting change hits all of them. Documented, but worth repeating in the UI.
- **Exclusion pattern order**: chokidar's `ignored` is matched before `include` glob. Adding `node_modules/**` doesn't hurt but we should test a few common cases.
- **Runtime API gap**: `addWatchPath` exists but there's no `removeWatchPath` on the feeder. For now, removing a watch path = "requires restart". Adding `removeWatchPath` to the feeder is a small upstream patch we'll do as part of this work.
