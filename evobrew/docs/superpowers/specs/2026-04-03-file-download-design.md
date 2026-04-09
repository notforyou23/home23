# File Download Enhancements — Design Spec

**Date:** 2026-04-03
**Scope:** Download button visibility, file tree context menu, folder-as-ZIP download

## Summary

The download button exists but was hidden due to the UI refresh shell not initializing (fixed separately). This spec covers the remaining gaps: a right-click context menu on file tree items and a folder-as-ZIP endpoint.

## Changes

### 1. Download button visibility (already fixed)

The `initUIRefresh(true)` call was added after `ui-shell.js` loads, which restores the overflow menu and all responsive-hidden buttons including Download. No further work needed here.

### 2. Backend: ZIP download endpoint (`server/server.js`)

New endpoint: `GET /api/folder/download-zip?path=<encodedPath>`

- **Path validation:** Uses existing `resolveAndValidatePath()` + `isPathAllowed()`.
- **Size check:** Walk the directory tree first, sum file sizes. If total exceeds 500MB, return `413 Payload Too Large` with a message.
- **ZIP creation:** Use the `archiver` npm package. Create a ZIP stream, pipe directory contents into it, pipe the output to the response.
- **Response headers:**
  ```
  Content-Type: application/zip
  Content-Disposition: attachment; filename="<folder-name>.zip"
  ```
- **Exclusions:** Skip `node_modules/`, `.git/`, and any dotfiles/dirs that start with `.` (configurable via query param `includeHidden=true`).
- **Streaming:** ZIP is streamed directly to the response (no temp file). `archiver` handles this natively.

**Dependency:** Add `archiver` to `package.json`.

### 3. Frontend: File tree context menu

Add a `contextmenu` event listener to file tree items. The context menu is a simple positioned `<div>` with menu items, styled to match the existing header overflow menu.

**On right-click of a file:**
| Item | Action |
|------|--------|
| Download | Fetch via `/api/serve-file?path=...`, trigger browser download |

**On right-click of a folder:**
| Item | Action |
|------|--------|
| Download as ZIP | Fetch via `/api/folder/download-zip?path=...`, trigger browser download |

**Implementation location:** The file tree is rendered in `public/index.html` (inline script) or `public/js/file-tree.js`. Add the context menu markup to `index.html` (hidden by default), and wire the `contextmenu` event in whichever file renders tree items.

**Behavior:**
- Right-click shows the menu at cursor position.
- Click outside or press Escape dismisses.
- Only one context menu open at a time.
- Menu items call existing download logic (for files) or the new ZIP endpoint (for folders).

### Error handling

- ZIP endpoint: if a file in the directory can't be read (permissions), skip it and continue. Log a warning.
- ZIP endpoint: if the path doesn't exist or isn't a directory, return 404.
- Frontend: show a toast on download failure.

### No new files

Edits to `server/server.js` (ZIP endpoint), `public/index.html` (context menu markup + event wiring), `package.json` (archiver dependency).

## Out of scope

- Multi-select file download (select several files, download as ZIP)
- Drag-and-drop download
- Progress indicator for large ZIP downloads
