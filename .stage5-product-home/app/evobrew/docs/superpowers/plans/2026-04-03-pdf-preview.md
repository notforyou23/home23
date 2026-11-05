# PDF Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline PDF rendering to the existing preview pane using PDF.js from CDN.

**Architecture:** Add `.pdf` to the serve-file MIME map so PDFs are served as binary, then replace the "download to view" placeholder in `updatePreview()` with a PDF.js canvas renderer. Page navigation controls at the top.

**Tech Stack:** PDF.js (pdfjs-dist) from jsdelivr CDN, canvas rendering.

---

### Task 1: Add PDF MIME type to serve-file endpoint

**Files:**
- Modify: `server/server.js:1132-1150` (MIME map object)

- [ ] **Step 1: Add `.pdf` to the MIME map**

In `server/server.js`, the MIME map at line 1132 is missing `.pdf`. Add it after the image entries:

```js
// In the mimeTypes object at line 1132:
'.ico': 'image/x-icon',
// ADD:
'.pdf': 'application/pdf'
```

- [ ] **Step 2: Handle PDF as binary (like images)**

The serve-file endpoint currently checks `contentType.startsWith('image/')` to decide binary vs text. PDFs are also binary. Update the `isImage` check at line 1154 to also cover PDFs:

```js
// Replace line 1154-1155:
const isImage = contentType.startsWith('image/');

// With:
const isBinary = contentType.startsWith('image/') || contentType === 'application/pdf';
```

Then update the `if (isImage)` branch at line 1157 to use `isBinary`:

```js
if (isBinary) {
  // Serve as binary
  const buffer = await fs.readFile(resolvedFilePath);
  console.log(`[SERVE] ✅ Binary served: ${path.basename(resolvedFilePath)} (${buffer.length} bytes)`);
  res.type(contentType).send(buffer);
} else {
```

- [ ] **Step 3: Syntax check**

Run: `node --check server/server.js`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "fix: add PDF MIME type to serve-file endpoint"
```

---

### Task 2: Add PDF.js CDN script

**Files:**
- Modify: `public/index.html:11-16` (CDN script tags)

- [ ] **Step 1: Add PDF.js script tag**

After the existing CDN scripts (line 16), add PDF.js. Follow the existing pattern of `cdn.jsdelivr.net`:

```html
<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs" type="module"></script>
```

Note: PDF.js 4.x is ESM-only. Since we need it in the inline script (not a module), we'll load it differently — via a dynamic import inside `updatePreview()`. So instead of a script tag, we'll handle the import lazily in the next task. **Skip this step** — no script tag needed.

- [ ] **Step 2: No action needed — PDF.js will be loaded dynamically in Task 3**

---

### Task 3: Replace PDF preview placeholder with PDF.js renderer

**Files:**
- Modify: `public/index.html:8379-8390` (PDF branch in `updatePreview()`)

- [ ] **Step 1: Add PDF.js module cache variable**

Before the `updatePreview()` function (around line 8265), add a module-level cache for the PDF.js library:

```js
let _pdfJsLib = null;
async function loadPdfJs() {
    if (_pdfJsLib) return _pdfJsLib;
    try {
        _pdfJsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
        _pdfJsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
        return _pdfJsLib;
    } catch (e) {
        console.error('Failed to load PDF.js:', e);
        return null;
    }
}
```

- [ ] **Step 2: Replace the PDF branch in updatePreview()**

Replace lines 8379-8390 (the current PDF placeholder) with:

```js
} else if (fileName.endsWith('.pdf')) {
    // PDF preview via PDF.js
    previewContent.innerHTML = `
        <div id="pdf-preview-container" style="height: 100%; display: flex; flex-direction: column; background: var(--bg-primary);">
            <div id="pdf-controls" style="padding: 8px 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary);">
                <button onclick="pdfPrevPage()" class="btn btn-icon" style="padding: 4px 8px;">◀</button>
                <span id="pdf-page-info" style="font-size: 12px; color: var(--text-secondary); min-width: 80px; text-align: center;">Loading...</span>
                <button onclick="pdfNextPage()" class="btn btn-icon" style="padding: 4px 8px;">▶</button>
                <div style="flex:1;"></div>
                <button onclick="pdfZoomOut()" class="btn btn-icon" style="padding: 4px 8px;">−</button>
                <span id="pdf-zoom-info" style="font-size: 12px; color: var(--text-secondary); min-width: 50px; text-align: center;">100%</span>
                <button onclick="pdfZoomIn()" class="btn btn-icon" style="padding: 4px 8px;">+</button>
            </div>
            <div id="pdf-canvas-container" style="flex: 1; overflow: auto; display: flex; justify-content: center; padding: 16px;">
                <canvas id="pdf-canvas"></canvas>
            </div>
        </div>
    `;

    // Load and render PDF
    (async () => {
        const pdfjsLib = await loadPdfJs();
        if (!pdfjsLib) {
            document.getElementById('pdf-page-info').textContent = 'PDF.js failed to load';
            return;
        }
        try {
            const pdfUrl = '/api/serve-file?path=' + encodeURIComponent(activeFile);
            const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
            window._pdfDoc = pdf;
            window._pdfPage = 1;
            window._pdfScale = 1.0;
            renderPdfPage(1);
        } catch (err) {
            document.getElementById('pdf-page-info').textContent = 'Error: ' + err.message;
        }
    })();
```

- [ ] **Step 3: Add PDF rendering and navigation functions**

After the `updatePreview()` function, add these helper functions:

```js
async function renderPdfPage(pageNum) {
    const pdf = window._pdfDoc;
    if (!pdf) return;
    const page = await pdf.getPage(pageNum);
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Fit to container width by default
    const container = document.getElementById('pdf-canvas-container');
    const baseScale = (container.clientWidth - 32) / page.getViewport({ scale: 1 }).width;
    const scale = baseScale * window._pdfScale;
    const viewport = page.getViewport({ scale });
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    document.getElementById('pdf-page-info').textContent = 
        'Page ' + pageNum + ' of ' + pdf.numPages;
    document.getElementById('pdf-zoom-info').textContent = 
        Math.round(window._pdfScale * 100) + '%';
}

function pdfPrevPage() {
    if (window._pdfPage <= 1) return;
    window._pdfPage--;
    renderPdfPage(window._pdfPage);
}

function pdfNextPage() {
    if (!window._pdfDoc || window._pdfPage >= window._pdfDoc.numPages) return;
    window._pdfPage++;
    renderPdfPage(window._pdfPage);
}

function pdfZoomIn() {
    window._pdfScale = Math.min(3.0, window._pdfScale + 0.25);
    renderPdfPage(window._pdfPage);
}

function pdfZoomOut() {
    window._pdfScale = Math.max(0.25, window._pdfScale - 0.25);
    renderPdfPage(window._pdfPage);
}
```

- [ ] **Step 4: Test manually**

1. Start the server: `node server/server.js`
2. Open the app in a browser
3. Navigate to a folder containing a PDF file
4. Click the PDF file to open it
5. Click the preview button (or Cmd+K V)
6. Verify: PDF renders in the preview pane with page nav and zoom controls

- [ ] **Step 5: Commit**

```bash
git add server/server.js public/index.html
git commit -m "feat: add inline PDF preview via PDF.js"
```
