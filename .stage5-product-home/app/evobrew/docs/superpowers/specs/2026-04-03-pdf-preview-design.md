# PDF Preview — Design Spec

**Date:** 2026-04-03
**Scope:** Add inline PDF rendering to the existing preview pane

## Summary

The preview pane already handles images, markdown, HTML, CSS, JSON, SVG, and Office files. PDF is the one common file type that falls through with a "download to view" message. This adds PDF.js-based rendering inline in the same preview pane.

## Changes

### Backend: Fix MIME type (`server/server.js`)

In the `/api/serve-file` endpoint (~line 1115-1173), add `application/pdf` to the MIME map for `.pdf` files. Currently PDFs fall through to `text/plain`, which causes the browser to try to render raw binary as text.

```js
'.pdf': 'application/pdf',
```

### Frontend: PDF preview branch (`public/index.html`)

In `updatePreview()` (~line 8300), add a PDF case after the existing image/office/markdown branches:

1. **Load PDF.js from CDN** — `cdnjs.cloudflare.com/ajax/libs/pdf.js/4.x/pdf.min.mjs` (ES module). Load once, cache the import.
2. **Fetch PDF binary** via `/api/serve-file?path=<encodedPath>` as `ArrayBuffer`.
3. **Render pages** into `<canvas>` elements inside the preview pane container. Start with page 1, render additional pages as user navigates.
4. **Page navigation controls** — simple prev/next buttons and page count indicator (`Page 1 of N`) inserted at the top of the preview pane. Style to match existing preview header.
5. **Zoom** — fit-to-width by default (match preview pane width). Optional zoom in/out buttons.

### Error handling

- If PDF.js CDN fails to load, fall back to showing a download link (current behavior).
- If the PDF is corrupted or password-protected, show an error message in the preview pane.

### No new files

All changes are edits to `server/server.js` and `public/index.html`.

## Out of scope

- PDF text search (PDF.js supports it but not needed for v1)
- PDF annotation or editing
- Thumbnail page sidebar
