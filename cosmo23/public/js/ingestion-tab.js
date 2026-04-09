(function () {
  'use strict';

  let pollTimer = null;
  let initialized = false;
  let lastManifestSnapshot = null; // track manifest changes for real progress

  // ── Init / Destroy ────────────────────────────────────────

  function init() {
    if (!window.cosmoStandaloneApp?.activeContext) {
      showNoRun(true);
      return;
    }
    showNoRun(false);

    if (initialized) {
      startPolling();
      refreshStatus();
      return;
    }
    initialized = true;

    bindEvents();
    startPolling();
    refreshStatus();
  }

  function destroy() {
    stopPolling();
  }

  function showNoRun(show) {
    const el = document.getElementById('ingest-no-run');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  // ── Drag & Drop + Browse ──────────────────────────────────

  function bindEvents() {
    const dropzone = document.getElementById('ingest-dropzone');
    const fileInput = document.getElementById('ingest-file-input');
    const browseBtn = document.getElementById('ingest-browse-btn');

    if (!dropzone || !fileInput || !browseBtn) return;

    // Prevent default on the whole view to stop browser opening dropped files
    const view = document.getElementById('view-ingest');
    if (view) {
      view.addEventListener('dragover', e => e.preventDefault());
      view.addEventListener('drop', e => e.preventDefault());
    }

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Only remove if actually leaving the dropzone (not entering a child)
      if (!dropzone.contains(e.relatedTarget)) {
        dropzone.classList.remove('drag-over');
      }
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) uploadFiles(files);
    });

    dropzone.addEventListener('click', (e) => {
      if (e.target === browseBtn || browseBtn.contains(e.target)) return;
      fileInput.click();
    });

    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        uploadFiles(fileInput.files);
        fileInput.value = '';
      }
    });
  }

  // ── Upload ────────────────────────────────────────────────

  async function uploadFiles(fileList) {
    const label = (document.getElementById('ingest-label')?.value || 'documents').trim() || 'documents';
    const uploadListEl = document.getElementById('ingest-upload-list');

    for (const file of fileList) {
      const itemEl = document.createElement('div');
      itemEl.className = 'ingest-upload-item';
      const sizeStr = formatSize(file.size);
      itemEl.innerHTML = `
        <span class="ingest-upload-name">${esc(file.name)}</span>
        <span class="ingest-upload-size">${sizeStr}</span>
        <span class="ingest-upload-status status-pending">uploading&hellip;</span>
      `;
      uploadListEl.prepend(itemEl);

      const statusEl = itemEl.querySelector('.ingest-upload-status');

      try {
        const formData = new FormData();
        formData.append('files', file);
        formData.append('label', label);

        const res = await fetch('/api/feeder/upload', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
          statusEl.className = 'ingest-upload-status status-uploaded';
          statusEl.textContent = 'uploaded \u2713';
          // Now track ingestion progress for this file
          trackIngestion(itemEl, statusEl, file.name);
        } else {
          statusEl.className = 'ingest-upload-status status-err';
          statusEl.textContent = data.error || 'upload failed';
        }
      } catch (err) {
        statusEl.className = 'ingest-upload-status status-err';
        statusEl.textContent = err.message || 'network error';
      }
    }
  }

  /**
   * After upload succeeds, poll until the file appears in the manifest
   * with nodeIds — showing real ingestion progress, not theatre.
   */
  async function trackIngestion(itemEl, statusEl, fileName) {
    statusEl.className = 'ingest-upload-status status-ingesting';
    statusEl.textContent = 'ingesting\u2026';

    let attempts = 0;
    const maxAttempts = 60; // 60 * 2s = 2 minutes max wait

    const check = async () => {
      attempts++;
      try {
        const res = await fetch('/api/feeder/status');
        const data = await res.json();
        if (!data.success) return;

        const files = data.status?.manifest?.files || {};
        // Find this file in the manifest (match by filename at end of path)
        const entry = Object.entries(files).find(([fp]) => fp.endsWith('/' + fileName) || fp.endsWith(fileName));

        if (entry && entry[1].nodeIds && entry[1].nodeIds.length > 0) {
          const nodeCount = entry[1].nodeIds.length;
          statusEl.className = 'ingest-upload-status status-ok';
          statusEl.textContent = `ingested \u2713 ${nodeCount} node${nodeCount !== 1 ? 's' : ''}`;
          refreshStatus(); // update the right panel
          return; // done tracking
        }

        // Check pending queue
        const pending = data.status?.pending?.queueLength || 0;
        if (pending > 0) {
          statusEl.textContent = `ingesting\u2026 (${pending} pending)`;
        }
      } catch {
        // ignore polling errors
      }

      if (attempts < maxAttempts) {
        setTimeout(check, 2000);
      } else {
        statusEl.className = 'ingest-upload-status status-warn';
        statusEl.textContent = 'uploaded (ingestion pending)';
      }
    };

    // Start checking after a short delay to let the watcher pick up the file
    setTimeout(check, 1500);
  }

  // ── Status Polling ────────────────────────────────────────

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshStatus, 5000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/feeder/status');
      if (!res.ok) {
        updateStatsDisplay(0, 0, 0, 'error');
        return;
      }
      const data = await res.json();
      if (!data.success || !data.status?.enabled) {
        updateStatsDisplay(0, 0, 0, data.status?.reason || 'offline');
        return;
      }

      const status = data.status;
      const fileCount = status.manifest?.fileCount ?? 0;
      const nodeCount = status.manifest?.nodeCount ?? 0;
      const pendingCount = status.pending?.queueLength ?? 0;
      updateStatsDisplay(fileCount, nodeCount, pendingCount);

      renderFileList(status.manifest?.files || {});
      lastManifestSnapshot = status.manifest?.files || {};
    } catch {
      updateStatsDisplay(0, 0, 0, 'offline');
    }
  }

  function updateStatsDisplay(files, nodes, pending, error) {
    const fc = document.getElementById('ingest-file-count');
    const nc = document.getElementById('ingest-node-count');
    const pc = document.getElementById('ingest-pending-count');
    if (fc) fc.textContent = error || files;
    if (nc) nc.textContent = error ? '--' : nodes;
    if (pc) pc.textContent = error ? '--' : pending;
  }

  // ── File List ─────────────────────────────────────────────

  function renderFileList(files) {
    const listEl = document.getElementById('ingest-file-list');
    const emptyEl = document.getElementById('ingest-empty-state');
    if (!listEl) return;

    const entries = Object.entries(files);

    if (entries.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      listEl.querySelectorAll('.ingest-file-row').forEach(r => r.remove());
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    listEl.querySelectorAll('.ingest-file-row').forEach(r => r.remove());

    // Sort by ingestedAt descending (newest first)
    entries.sort((a, b) => {
      const ta = a[1].ingestedAt || '';
      const tb = b[1].ingestedAt || '';
      return tb.localeCompare(ta);
    });

    for (const [filePath, meta] of entries) {
      const fileName = filePath.split('/').pop();
      const label = meta.label || 'documents';
      const nodeCount = (meta.nodeIds || []).length;
      const timeAgo = meta.ingestedAt ? formatTimeAgo(meta.ingestedAt) : '';

      const row = document.createElement('div');
      row.className = 'ingest-file-row';
      row.innerHTML = `
        <span class="ingest-file-name" title="${esc(filePath)}">${esc(fileName)}</span>
        <span class="ingest-file-label">${esc(label)}</span>
        <span class="ingest-file-nodes">${nodeCount} node${nodeCount !== 1 ? 's' : ''}</span>
        <span class="ingest-file-time">${timeAgo}</span>
        <button class="ingest-file-remove" title="Remove from memory" data-path="${esc(filePath)}">&times;</button>
      `;

      const removeBtn = row.querySelector('.ingest-file-remove');
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Remove "${fileName}" and its ${nodeCount} node${nodeCount !== 1 ? 's' : ''} from memory?`)) return;
        removeBtn.disabled = true;
        removeBtn.textContent = '...';
        try {
          await fetch('/api/feeder/file', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath })
          });
          row.remove();
          setTimeout(refreshStatus, 500);
        } catch {
          removeBtn.disabled = false;
          removeBtn.textContent = '\u00d7';
        }
      });

      listEl.appendChild(row);
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTimeAgo(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // ── Expose ────────────────────────────────────────────────

  window.IngestionTab = { init, destroy };
})();
