/**
 * Hub Tab — Brain Package Management
 *
 * Merge, fork, export, import brains.
 * IIFE module exposing window.HubTab with init() and destroy().
 */

(function () {
  'use strict';

  let initialized = false;
  let brains = [];
  let selectedBrains = new Set();
  let previewBrainId = null;
  let searchQuery = '';

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length <= n ? str : str.slice(0, n - 1) + '\u2026';
  }

  function statLabel(value, suffix, fallback) {
    return Number.isFinite(value) ? `${value} ${suffix}` : fallback;
  }

  function showToast(message, type = 'info') {
    if (window.cosmoStandaloneApp) {
      window.cosmoStandaloneApp.showToast(message, type);
    }
  }

  // ── API ──────────────────────────────────────────────────────────────────

  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── Brain loading ────────────────────────────────────────────────────────

  async function loadBrains() {
    try {
      const data = await apiFetch('/api/brains');
      brains = data.brains || data || [];
    } catch (e) {
      brains = [];
    }
    renderBrainList();
  }

  // ── Brain list rendering ─────────────────────────────────────────────────

  function renderBrainList() {
    const list = document.getElementById('hub-brain-list');
    if (!list) return;

    const filtered = brains.filter(b => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (b.name || '').toLowerCase().includes(q) ||
        (b.topic || '').toLowerCase().includes(q) ||
        (b.domain || '').toLowerCase().includes(q);
    });

    if (!filtered.length) {
      list.innerHTML = '<div class="hub-empty">No brains found.</div>';
      return;
    }

    list.innerHTML = filtered.map(b => {
      const checked = selectedBrains.has(b.routeKey) ? 'checked' : '';
      const active = previewBrainId === b.routeKey ? 'hub-brain-item-active' : '';
      return `<div class="hub-brain-item ${active}" data-brain-id="${esc(b.routeKey)}">
        <label class="hub-brain-check" onclick="event.stopPropagation()">
          <input type="checkbox" ${checked} data-select-brain="${esc(b.routeKey)}">
        </label>
        <div class="hub-brain-info">
          <div class="hub-brain-name">${esc(b.displayName || b.name)}</div>
          <div class="hub-brain-topic">${esc(truncate(b.topic || b.domain || '', 60))}</div>
          <div class="hub-brain-meta">
            <span>${esc(statLabel(b.nodes, 'nodes', 'Open for stats'))}</span>
            <span>${esc(statLabel(b.edges, 'edges', 'Edges on open'))}</span>
            <span>${esc(statLabel(b.cycleCount ?? b.cycles, 'cycles', 'Saved run'))}</span>
          </div>
        </div>
        <span class="source-badge">${esc(b.sourceLabel || 'Local')}</span>
      </div>`;
    }).join('');

    // Bind events
    list.querySelectorAll('.hub-brain-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.brainId;
        previewBrainId = id;
        renderBrainList();
        loadPreview(id);
      });
    });

    list.querySelectorAll('[data-select-brain]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = cb.dataset.selectBrain;
        if (e.target.checked) {
          selectedBrains.add(id);
        } else {
          selectedBrains.delete(id);
        }
        updateToolbar();
      });
    });
  }

  function updateToolbar() {
    const mergeBtn = document.getElementById('hub-merge-btn');
    if (mergeBtn) {
      mergeBtn.disabled = selectedBrains.size < 2;
      mergeBtn.textContent = selectedBrains.size > 0
        ? `Merge (${selectedBrains.size})`
        : 'Merge';
    }
  }

  // ── Preview panel ────────────────────────────────────────────────────────

  async function loadPreview(brainId) {
    const panel = document.getElementById('hub-preview-content');
    if (!panel) return;

    panel.innerHTML = '<div class="hub-empty">Loading...</div>';

    try {
      const data = await apiFetch(`/api/hub/brain/${encodeURIComponent(brainId)}/stats`);
      const s = data.stats;

      panel.innerHTML = `
        <div class="hub-preview-header">
          <h3>${esc(brains.find(b => b.routeKey === brainId)?.displayName || brainId)}</h3>
          <span class="source-badge">${esc(s.sourceLabel || 'Local')}</span>
        </div>

        <div class="hub-stats-grid">
          <div class="hub-stat-card">
            <div class="hub-stat-label">Nodes</div>
            <div class="hub-stat-value">${s.nodes}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Edges</div>
            <div class="hub-stat-value">${s.edges}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Clusters</div>
            <div class="hub-stat-value">${s.clusters}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Cycles</div>
            <div class="hub-stat-value">${s.cycles}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Active Goals</div>
            <div class="hub-stat-value">${s.activeGoals}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Done Goals</div>
            <div class="hub-stat-value">${s.completedGoals}</div>
          </div>
        </div>

        <div class="hub-preview-meta">
          ${s.topic ? `<div class="hub-meta-row"><span class="hub-meta-label">Topic</span><span class="hub-meta-value">${esc(truncate(s.topic, 120))}</span></div>` : ''}
          ${s.domain ? `<div class="hub-meta-row"><span class="hub-meta-label">Domain</span><span class="hub-meta-value">${esc(s.domain)}</span></div>` : ''}
          <div class="hub-meta-row"><span class="hub-meta-label">Mode</span><span class="hub-meta-value">${esc(s.mode)}</span></div>
          <div class="hub-meta-row"><span class="hub-meta-label">Source</span><span class="hub-meta-value">${esc(s.sourceType)}</span></div>
          <div class="hub-meta-row"><span class="hub-meta-label">Path</span><span class="hub-meta-value hub-meta-path">${esc(s.path)}</span></div>
        </div>

        <div class="hub-preview-actions">
          <button class="ghost-btn" id="hub-fork-preview-btn">Fork</button>
          <button class="ghost-btn" id="hub-dream-preview-btn">Dream Fork</button>
          <button class="ghost-btn" id="hub-export-preview-btn">Export</button>
        </div>
      `;

      document.getElementById('hub-fork-preview-btn')?.addEventListener('click', () => openForkDialog(brainId));
      document.getElementById('hub-dream-preview-btn')?.addEventListener('click', () => openForkDialog(brainId, 'dream'));
      document.getElementById('hub-export-preview-btn')?.addEventListener('click', () => openExportDialog(brainId));
    } catch (e) {
      panel.innerHTML = `<div class="hub-empty">Failed to load: ${esc(e.message)}</div>`;
    }
  }

  // ── Dialogs ──────────────────────────────────────────────────────────────

  function showModal(html) {
    let overlay = document.getElementById('hub-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hub-modal-overlay';
      overlay.className = 'hub-modal-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="hub-modal">${html}</div>`;
    overlay.classList.add('active');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    return overlay.querySelector('.hub-modal');
  }

  function closeModal() {
    const overlay = document.getElementById('hub-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // ── Merge Dialog ─────────────────────────────────────────────────────────

  function openMergeDialog() {
    if (selectedBrains.size < 2) {
      showToast('Select at least 2 brains to merge', 'error');
      return;
    }

    const selected = brains.filter(b => selectedBrains.has(b.routeKey));

    const modal = showModal(`
      <h3>Merge Brains</h3>
      <div class="hub-merge-brains">
        ${selected.map(b => `<div class="hub-merge-brain-item">
          <span>${esc(b.displayName || b.name)}</span>
          <span class="hub-merge-node-count">${b.nodes || 0} nodes</span>
        </div>`).join('')}
      </div>

      <div class="hub-merge-options">
        <label class="field">
          <span>Merged Brain Name</span>
          <input type="text" id="hub-merge-name" placeholder="merged-brain" value="merged-${Date.now().toString(36)}">
        </label>

        <label class="field">
          <span>Similarity Threshold: <strong id="hub-threshold-label">0.85</strong></span>
          <input type="range" id="hub-merge-threshold" min="0.70" max="0.95" step="0.01" value="0.85" class="hub-threshold-slider">
        </label>

        <label class="field">
          <span>Conflict Policy</span>
          <select id="hub-merge-policy">
            <option value="best-representative">Best Representative</option>
            <option value="keep-all">Keep All</option>
            <option value="newest">Newest</option>
            <option value="highest-weight">Highest Weight</option>
          </select>
        </label>
      </div>

      <div id="hub-merge-preview-area" class="hub-merge-preview-area"></div>

      <div id="hub-merge-progress-area" class="hub-merge-progress-area" style="display:none;">
        <div class="hub-merge-phase" id="hub-merge-phase">Preparing...</div>
        <div class="hub-merge-progress-bar">
          <div class="hub-merge-progress-fill" id="hub-merge-progress-fill"></div>
        </div>
        <div class="hub-merge-status" id="hub-merge-status"></div>
      </div>

      <div id="hub-merge-result-area" style="display:none;"></div>

      <div class="hub-modal-actions" id="hub-merge-actions">
        <button class="ghost-btn" id="hub-merge-preview-btn">Preview</button>
        <button class="primary-btn" id="hub-merge-execute-btn">Merge</button>
        <button class="ghost-btn" id="hub-merge-cancel-btn">Cancel</button>
      </div>
    `);

    const threshold = modal.querySelector('#hub-merge-threshold');
    const thresholdLabel = modal.querySelector('#hub-threshold-label');
    threshold.addEventListener('input', () => {
      thresholdLabel.textContent = Number(threshold.value).toFixed(2);
    });

    modal.querySelector('#hub-merge-cancel-btn').addEventListener('click', closeModal);
    modal.querySelector('#hub-merge-preview-btn').addEventListener('click', () => runMergePreview(modal));
    modal.querySelector('#hub-merge-execute-btn').addEventListener('click', () => runMerge(modal));
  }

  async function runMergePreview(modal) {
    const area = modal.querySelector('#hub-merge-preview-area');
    area.innerHTML = '<div class="hub-empty">Generating preview...</div>';

    try {
      const threshold = Number(modal.querySelector('#hub-merge-threshold').value);
      const data = await apiFetch('/api/hub/merge/preview', {
        method: 'POST',
        body: {
          brainIds: [...selectedBrains],
          threshold
        }
      });

      const p = data.preview;
      area.innerHTML = `
        <div class="hub-preview-stats">
          <div class="hub-stat-card">
            <div class="hub-stat-label">Total Nodes</div>
            <div class="hub-stat-value">${p.totalNodes}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Merged Nodes</div>
            <div class="hub-stat-value">${p.mergedNodes}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Duplicates Removed</div>
            <div class="hub-stat-value">${p.duplicatesRemoved}</div>
          </div>
          <div class="hub-stat-card">
            <div class="hub-stat-label">Dedup Rate</div>
            <div class="hub-stat-value">${Math.round((p.deduplicationRate || 0) * 100)}%</div>
          </div>
        </div>
      `;
    } catch (e) {
      area.innerHTML = `<div class="hub-empty hub-error">${esc(e.message)}</div>`;
    }
  }

  async function runMerge(modal) {
    const name = modal.querySelector('#hub-merge-name').value.trim();
    if (!name) {
      showToast('Name is required', 'error');
      return;
    }

    const threshold = Number(modal.querySelector('#hub-merge-threshold').value);
    const conflictPolicy = modal.querySelector('#hub-merge-policy').value;

    // Show progress, hide actions
    modal.querySelector('#hub-merge-progress-area').style.display = 'block';
    modal.querySelector('#hub-merge-actions').style.display = 'none';
    modal.querySelector('#hub-merge-preview-area').innerHTML = '';

    const phaseEl = modal.querySelector('#hub-merge-phase');
    const fillEl = modal.querySelector('#hub-merge-progress-fill');
    const statusEl = modal.querySelector('#hub-merge-status');

    try {
      const response = await fetch('/api/hub/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brainIds: [...selectedBrains],
          name,
          threshold,
          conflictPolicy
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleMergeEvent(eventType, data, modal);
            } catch { /* skip malformed */ }
            eventType = null;
          }
        }
      }
    } catch (e) {
      phaseEl.textContent = 'Error';
      statusEl.textContent = e.message;
      modal.querySelector('#hub-merge-actions').style.display = 'flex';
    }
  }

  function handleMergeEvent(type, data, modal) {
    const phaseEl = modal.querySelector('#hub-merge-phase');
    const fillEl = modal.querySelector('#hub-merge-progress-fill');
    const statusEl = modal.querySelector('#hub-merge-status');

    switch (type) {
      case 'phase':
        if (phaseEl) phaseEl.textContent = data.phase || '';
        if (fillEl && data.progress != null) fillEl.style.width = `${Math.round(data.progress * 100)}%`;
        break;
      case 'progress':
        if (fillEl && data.progress != null) fillEl.style.width = `${Math.round(data.progress * 100)}%`;
        if (statusEl && data.message) statusEl.textContent = data.message;
        break;
      case 'phaseComplete':
        break;
      case 'complete':
        modal.querySelector('#hub-merge-progress-area').style.display = 'none';
        const resultArea = modal.querySelector('#hub-merge-result-area');
        resultArea.style.display = 'block';
        resultArea.innerHTML = `
          <div class="hub-merge-complete">
            <h4>Merge Complete</h4>
            ${data.stats ? `<div class="hub-preview-stats">
              <div class="hub-stat-card"><div class="hub-stat-label">Total Nodes</div><div class="hub-stat-value">${data.stats.totalNodes || data.stats.mergedNodes || '?'}</div></div>
              <div class="hub-stat-card"><div class="hub-stat-label">Duplicates Removed</div><div class="hub-stat-value">${data.stats.duplicatesRemoved || '?'}</div></div>
            </div>` : ''}
            <p>Created brain: <strong>${esc(data.name)}</strong></p>
            <div class="hub-modal-actions">
              <button class="primary-btn" id="hub-merge-done-btn">Done</button>
            </div>
          </div>
        `;
        resultArea.querySelector('#hub-merge-done-btn')?.addEventListener('click', () => {
          closeModal();
          selectedBrains.clear();
          loadBrains();
        });
        break;
      case 'error':
        if (phaseEl) phaseEl.textContent = 'Error';
        if (statusEl) statusEl.textContent = data.error || 'Unknown error';
        modal.querySelector('#hub-merge-actions').style.display = 'flex';
        break;
    }
  }

  // ── Fork Dialog ──────────────────────────────────────────────────────────

  function openForkDialog(brainId, defaultType) {
    const brain = brains.find(b => b.routeKey === brainId);
    const name = brain ? brain.name : brainId;

    const modal = showModal(`
      <h3>Fork Brain</h3>
      <p class="hub-modal-desc">Create a copy of <strong>${esc(name)}</strong> with a fresh start.</p>

      <label class="field">
        <span>New Name</span>
        <input type="text" id="hub-fork-name" placeholder="my-fork" value="${esc(name)}-fork">
      </label>

      <div class="hub-fork-types">
        <label class="toggle-chip">
          <input type="radio" name="hub-fork-type" value="fork" ${defaultType !== 'dream' ? 'checked' : ''}>
          <span>Regular Fork</span>
        </label>
        <label class="toggle-chip">
          <input type="radio" name="hub-fork-type" value="dream" ${defaultType === 'dream' ? 'checked' : ''}>
          <span>Dream Fork</span>
        </label>
      </div>

      <div class="hub-modal-actions">
        <button class="primary-btn" id="hub-fork-submit-btn">Create Fork</button>
        <button class="ghost-btn" id="hub-fork-cancel-btn">Cancel</button>
      </div>
    `);

    modal.querySelector('#hub-fork-cancel-btn').addEventListener('click', closeModal);
    modal.querySelector('#hub-fork-submit-btn').addEventListener('click', async () => {
      const forkName = modal.querySelector('#hub-fork-name').value.trim();
      const forkType = modal.querySelector('input[name="hub-fork-type"]:checked')?.value || 'fork';

      if (!forkName) {
        showToast('Name is required', 'error');
        return;
      }

      try {
        modal.querySelector('#hub-fork-submit-btn').disabled = true;
        modal.querySelector('#hub-fork-submit-btn').textContent = 'Creating...';

        const data = await apiFetch('/api/hub/fork', {
          method: 'POST',
          body: { brainId, name: forkName, type: forkType }
        });

        closeModal();
        showToast(`${forkType === 'dream' ? 'Dream fork' : 'Fork'} created: ${data.name}`);
        loadBrains();
      } catch (e) {
        showToast(e.message, 'error');
        modal.querySelector('#hub-fork-submit-btn').disabled = false;
        modal.querySelector('#hub-fork-submit-btn').textContent = 'Create Fork';
      }
    });
  }

  // ── Export Dialog ────────────────────────────────────────────────────────

  function openExportDialog(brainId) {
    const brain = brains.find(b => b.routeKey === brainId);
    const name = brain ? brain.name : brainId;

    const modal = showModal(`
      <h3>Export Brain</h3>
      <p class="hub-modal-desc">Export <strong>${esc(name)}</strong> as a .brain package.</p>

      <label class="field">
        <span>Output Name</span>
        <input type="text" id="hub-export-name" placeholder="export-name" value="${esc(name)}">
      </label>

      <label class="toggle-chip">
        <input type="checkbox" id="hub-export-outputs">
        <span>Include outputs directory</span>
      </label>

      <div class="hub-modal-actions">
        <button class="primary-btn" id="hub-export-submit-btn">Export</button>
        <button class="ghost-btn" id="hub-export-cancel-btn">Cancel</button>
      </div>
    `);

    modal.querySelector('#hub-export-cancel-btn').addEventListener('click', closeModal);
    modal.querySelector('#hub-export-submit-btn').addEventListener('click', async () => {
      const outputName = modal.querySelector('#hub-export-name').value.trim();
      const includeOutputs = modal.querySelector('#hub-export-outputs').checked;

      try {
        modal.querySelector('#hub-export-submit-btn').disabled = true;
        modal.querySelector('#hub-export-submit-btn').textContent = 'Exporting...';

        const data = await apiFetch('/api/hub/export', {
          method: 'POST',
          body: { brainId, outputName, includeOutputs }
        });

        closeModal();
        showToast(`Exported to: ${data.outputPath}`);
      } catch (e) {
        showToast(e.message, 'error');
        modal.querySelector('#hub-export-submit-btn').disabled = false;
        modal.querySelector('#hub-export-submit-btn').textContent = 'Export';
      }
    });
  }

  // ── Import Dialog ────────────────────────────────────────────────────────

  function openImportDialog() {
    const modal = showModal(`
      <h3>Import Brain</h3>
      <p class="hub-modal-desc">Import a .brain package from a local path.</p>

      <label class="field">
        <span>Path to .brain directory</span>
        <input type="text" id="hub-import-path" placeholder="/path/to/exported.brain">
      </label>

      <div class="hub-modal-actions">
        <button class="primary-btn" id="hub-import-submit-btn">Import</button>
        <button class="ghost-btn" id="hub-import-cancel-btn">Cancel</button>
      </div>
    `);

    modal.querySelector('#hub-import-cancel-btn').addEventListener('click', closeModal);
    modal.querySelector('#hub-import-submit-btn').addEventListener('click', async () => {
      const importPath = modal.querySelector('#hub-import-path').value.trim();
      if (!importPath) {
        showToast('Path is required', 'error');
        return;
      }

      try {
        modal.querySelector('#hub-import-submit-btn').disabled = true;
        modal.querySelector('#hub-import-submit-btn').textContent = 'Importing...';

        const data = await apiFetch('/api/hub/import', {
          method: 'POST',
          body: { path: importPath }
        });

        closeModal();
        showToast(`Imported: ${data.runName}`);
        loadBrains();
      } catch (e) {
        showToast(e.message, 'error');
        modal.querySelector('#hub-import-submit-btn').disabled = false;
        modal.querySelector('#hub-import-submit-btn').textContent = 'Import';
      }
    });
  }

  // ── Init / Destroy ───────────────────────────────────────────────────────

  function init() {
    if (initialized) {
      loadBrains();
      return;
    }
    initialized = true;

    // Bind search
    const search = document.getElementById('hub-search');
    if (search) {
      search.addEventListener('input', () => {
        searchQuery = search.value.trim();
        renderBrainList();
      });
    }

    // Toolbar buttons
    document.getElementById('hub-merge-btn')?.addEventListener('click', openMergeDialog);
    document.getElementById('hub-import-btn')?.addEventListener('click', openImportDialog);
    document.getElementById('hub-refresh-btn')?.addEventListener('click', loadBrains);

    loadBrains();
  }

  function destroy() {
    selectedBrains.clear();
    previewBrainId = null;
    searchQuery = '';
  }

  // ── Public API ───────────────────────────────────────────────────────────

  window.HubTab = { init, destroy };
})();
