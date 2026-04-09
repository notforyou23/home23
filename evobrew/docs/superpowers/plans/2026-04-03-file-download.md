# File Download Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Download" and "Download as ZIP" options to the file tree context menu, plus a ZIP download endpoint for folders.

**Architecture:** Add `archiver` dependency for streaming ZIP creation. New `GET /api/folder/download-zip` endpoint. Extend the existing `showContextMenu()` function to include download actions for both files and folders.

**Tech Stack:** archiver (npm), existing Express routes, existing context menu system.

---

### Task 1: Install archiver dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install archiver**

```bash
cd /Users/jtr/_JTR23_/evobrew && npm install archiver
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('archiver'); console.log('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add archiver dependency for ZIP downloads"
```

---

### Task 2: Add ZIP download endpoint

**Files:**
- Modify: `server/server.js:1092` (after upload-binary, before delete endpoint)

- [ ] **Step 1: Add the ZIP endpoint**

Insert after the `/api/folder/upload-binary` endpoint (around line 1092) and before the `/api/folder/delete` endpoint:

```js
// Download folder as ZIP
app.get('/api/folder/download-zip', async (req, res) => {
  try {
    const { path: folderPath, includeHidden } = req.query;
    if (!folderPath) {
      return res.status(400).json({ error: 'path parameter required' });
    }

    const resolvedPath = resolveAndValidatePath(folderPath, req.allowedRoot || process.cwd(), {
      expectFile: false
    });

    // Verify it's a directory
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    // Size check — walk tree, cap at 500MB
    const MAX_ZIP_SIZE = 500 * 1024 * 1024;
    let totalSize = 0;
    const skipDirs = new Set(['node_modules', '.git']);

    async function calcSize(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (skipDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await calcSize(fullPath);
        } else if (entry.isFile()) {
          const s = await fs.stat(fullPath);
          totalSize += s.size;
          if (totalSize > MAX_ZIP_SIZE) throw new Error('TOO_LARGE');
        }
      }
    }

    try {
      await calcSize(resolvedPath);
    } catch (sizeErr) {
      if (sizeErr.message === 'TOO_LARGE') {
        return res.status(413).json({ error: 'Folder exceeds 500MB size limit for ZIP download' });
      }
      throw sizeErr;
    }

    const archiver = require('archiver');
    const folderName = path.basename(resolvedPath);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', (err) => {
      console.error('[ZIP] Archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'ZIP creation failed' });
    });
    archive.pipe(res);

    // Add directory contents, excluding node_modules, .git, and hidden files
    archive.glob('**/*', {
      cwd: resolvedPath,
      dot: !!includeHidden,
      ignore: ['node_modules/**', '.git/**']
    });

    await archive.finalize();
    console.log(`[ZIP] ✅ Sent ${folderName}.zip (${totalSize} bytes uncompressed)`);

  } catch (error) {
    console.error('[ZIP] ❌ Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP: ' + error.message });
    }
  }
});
```

- [ ] **Step 2: Syntax check**

Run: `node --check server/server.js`
Expected: No errors

- [ ] **Step 3: Test manually**

```bash
# Start server
node server/server.js &
# Test ZIP download
curl -o /tmp/test.zip "http://localhost:3405/api/folder/download-zip?path=$(node -e "console.log(encodeURIComponent('$PWD/public'))")"
# Verify ZIP
unzip -l /tmp/test.zip | head -20
```

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "feat: add folder-as-ZIP download endpoint"
```

---

### Task 3: Add download options to context menu

**Files:**
- Modify: `public/index.html:12720-12732` (menuItems array in showContextMenu)

- [ ] **Step 1: Detect if path is a directory**

The `showContextMenu()` function at line 12713 receives a `filePath`. We need to know if it's a file or directory to show the right menu items. The file tree items in `index.html` have `item.isDirectory` available, but by the time we reach `showContextMenu`, we only have the path.

Add an `isDirectory` parameter to `showContextMenu`:

```js
// Change line 12713 from:
function showContextMenu(x, y, filePath) {

// To:
function showContextMenu(x, y, filePath, isDirectory) {
```

- [ ] **Step 2: Update context menu call sites to pass isDirectory**

At line 7208-7211 (folder contextmenu):
```js
folderHeader.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, item.path, true);
});
```

At line 7234-7237 (file contextmenu):
```js
fileItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, item.path, false);
});
```

At line 7851 (tab contextmenu) — add `false` as 4th arg:
```js
showContextMenu(e.clientX, e.clientY, filePath, false);
```

- [ ] **Step 3: Add download items to the menuItems array**

In `showContextMenu()`, add download entries to the `menuItems` array. Insert after the "Copy Relative Path" item (line 12725) and before the separator + Rename:

```js
{ icon: '📋', label: 'Copy Relative Path', action: () => copyRelativePath(filePath) },
// ADD these lines:
{ separator: true },
{ icon: '⬇️', label: isDirectory ? 'Download as ZIP' : 'Download', action: () => isDirectory ? downloadFolderAsZip(filePath) : downloadFileByPath(filePath) },
```

- [ ] **Step 4: Add downloadFileByPath and downloadFolderAsZip functions**

Add these near `downloadCurrentFile()` (around line 11817):

```js
function downloadFileByPath(filePath) {
    const fileName = filePath.split('/').pop();
    const url = '/api/serve-file?path=' + encodeURIComponent(filePath);
    fetch(url)
        .then(resp => {
            if (!resp.ok) throw new Error('Download failed');
            return resp.blob();
        })
        .then(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Downloaded: ' + fileName);
        })
        .catch(err => showToast('Download failed: ' + err.message, 'error'));
}

function downloadFolderAsZip(folderPath) {
    const folderName = folderPath.split('/').pop();
    showToast('Preparing ZIP download...');
    const url = '/api/folder/download-zip?path=' + encodeURIComponent(folderPath);
    fetch(url)
        .then(resp => {
            if (!resp.ok) {
                return resp.json().then(body => { throw new Error(body.error || 'Download failed'); });
            }
            return resp.blob();
        })
        .then(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = folderName + '.zip';
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Downloaded: ' + folderName + '.zip');
        })
        .catch(err => showToast('ZIP download failed: ' + err.message, 'error'));
}
```

- [ ] **Step 5: Test manually**

1. Start the server
2. Open a folder in the file tree
3. Right-click a file → verify "Download" appears → click it → verify file downloads
4. Right-click a folder → verify "Download as ZIP" appears → click it → verify ZIP downloads
5. Right-click a file tab → verify "Download" appears

- [ ] **Step 6: Commit**

```bash
git add server/server.js public/index.html
git commit -m "feat: add download and ZIP download to file tree context menu"
```
