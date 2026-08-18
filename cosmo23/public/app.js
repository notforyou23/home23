// COSMO drill control center.
//
// Launch starts a DRILL: goal -> phases -> next goal, for the cycles or time
// set. This controller starts it, shows it (current goal, phase, next goal,
// remaining cycles/time, sources, writeups, Brain), and steers it (stop,
// continue, add a note). Query asks the Brain. Chat (Interactive) is a chat
// add-on only — never the product loop.

const RESEARCH_LAUNCH_VIEW = 'drill';

// Engine settings the control center does not surface as controls: sent with
// every launch so run behavior stays explicit and stable.
const LAUNCH_ENGINE_DEFAULTS = {
  explorationMode: 'guided',
  analysisDepth: 'normal',
  reviewPeriod: 20,
  maxConcurrent: 4,
  localLlmBaseUrl: 'http://localhost:11434/v1',
  enableWebSearch: true,
  enableSleep: true,
  enableCodingAgents: true,
  enableIntrospection: true,
  enableAgentRouting: true,
  enableRecursiveMode: true,
  enableMemoryGovernance: true,
  enableFrontier: true,
  enableIDEFirst: true,
  enableDirectAction: false,
  enableStabilization: false,
  enableConsolidationMode: false,
  synthesisCommitStep: true,
  synthesisSpineCap: 5,
  enableExperimental: false
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function populateBrainSelect(select, brains, selectedId) {
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '';

  const groups = {};
  brains.forEach(b => {
    const label = b.sourceLabel || (b.sourceType === 'local' ? 'Local' : 'Reference');
    if (!groups[label]) groups[label] = [];
    groups[label].push(b);
  });

  for (const [label, items] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `${label} (${items.length})`;
    items.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.routeKey;
      const meta = [];
      if (b.isActive) meta.push('Running');
      if (b.topic || b.domain) meta.push(b.topic || b.domain);
      opt.textContent = meta.length > 0
        ? `${b.displayName} (${meta.join(' · ')})`
        : b.displayName;
      optgroup.appendChild(opt);
    });
    select.appendChild(optgroup);
  }

  const target = selectedId && brains.some(b => b.routeKey === selectedId)
    ? selectedId
    : prev && brains.some(b => b.routeKey === prev) ? prev : brains[0]?.routeKey || '';
  if (target) select.value = target;
}

function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

class CosmoStandaloneApp {
  constructor() {
    this.viewTabs = [...document.querySelectorAll('.cc-nav-btn[data-view]')];
    this.views = new Map([
      ['drill', document.getElementById('view-drill')],
      ['query', document.getElementById('view-query')],
      ['chat', document.getElementById('view-chat')],
      ['setup', document.getElementById('view-setup')]
    ]);
    this.toastStack = document.getElementById('toast-stack');
    this.activeView = 'drill';

    this.models = [];
    this.modelCatalog = null;
    this.modelDefaults = { queryModel: null, pgsSweepModel: null, launch: {}, local: {} };
    this.queryDefaults = null;
    this.queryModelConfigurationNotified = false;
    this.launchDefaultsApplied = false;
    this.managedByHome23 = false;
    this.home23DashboardPort = '5002';

    this.brains = [];
    this.selectedBrainId = null;
    this.syncingQueryBrain = false;

    this.activeContext = null;
    this.ws = null;
    this.wsUrl = null;
    this.wsRetryTimer = null;

    this.lastDrill = null;
    this.showIdleOverride = false;
    this.drillPollTimer = null;
    this.drillTickTimer = null;
    this.consoleCursor = 0;
    this.consoleTimer = null;

    // Client-side windows over the existing disk tapes. The workspace never
    // creates a second record; it reads outputs/stream.jsonl,
    // outputs/sources.jsonl, outputs/, and drill/.
    this.inspectorTab = 'brain';
    this.inspectorRunName = null;
    this.brainStream = [];
    this.brainStreamBefore = null;
    this.brainStreamHasMore = true;
    this.brainKindFilter = 'all';
    this.brainSearch = '';
    this.selectedBrainEntryKey = null;
    this.sourceReceipts = [];
    this.sourcesBefore = null;
    this.sourcesHaveMore = true;
    this.sourceToolFilter = 'all';
    this.sourceSearch = '';
    this.drillFiles = [];
    this.drillFileSummary = null;
    this.filesLoadedForRun = null;
    this.filesLoading = false;
    this.fileKindFilter = 'all';
    this.fileSearch = '';
    this.selectedFilePath = null;
    this.liveEvents = [];
  }

  async init() {
    this.bindEvents();
    await Promise.all([
      this.loadSetupStatus(),
      this.loadModels(),
      this.loadModelCatalog(),
      this.loadStatus()
    ]);
    await this.loadBrains();
    this.startDrillPolling();
    this.switchView('drill');
  }

  bindEvents() {
    const onClick = (id, handler) => {
      const element = document.getElementById(id);
      if (element) element.addEventListener('click', handler);
    };

    this.viewTabs.forEach(tab => {
      tab.addEventListener('click', () => this.switchView(tab.dataset.view));
    });

    document.getElementById('launch-form').addEventListener('submit', event => {
      event.preventDefault();
      this.startDrill();
    });

    document.getElementById('continue-form').addEventListener('submit', event => {
      event.preventDefault();
      this.continueDrill();
    });

    document.getElementById('note-form').addEventListener('submit', event => {
      event.preventDefault();
      this.sendNote();
    });

    document.getElementById('setup-form').addEventListener('submit', event => {
      event.preventDefault();
      this.saveSetup();
    });

    onClick('stop-run-btn', () => this.stopDrill());
    onClick('refresh-app-btn', async () => {
      await Promise.all([
        this.loadSetupStatus(),
        this.loadModels(),
        this.loadStatus(),
        this.loadBrains(),
        this.loadDrillStatus()
      ]);
      this.showToast('Control center refreshed');
    });
    onClick('refresh-setup-btn', () => this.loadSetupStatus());
    onClick('import-oauth-btn', () => this.importOAuthFromCLI());
    onClick('start-oauth-btn', () => this.startOAuth());
    onClick('complete-oauth-btn', () => this.completeOAuth());
    onClick('start-codex-oauth-btn', () => this.startOpenAICodexOAuth());
    onClick('import-codex-oauth-btn', () => this.importOpenAICodexOAuth());
    onClick('refresh-catalog-btn', () => this.loadModelCatalog());
    onClick('save-catalog-btn', () => this.saveModelCatalog());
    onClick('open-query-btn', () => this.switchView('query'));
    onClick('brain-query-workspace-btn', () => this.switchView('query'));
    onClick('drill-query-btn', () => this.switchView('query'));
    onClick('drill-new-btn', () => {
      this.showIdleOverride = true;
      this.renderDrill();
    });
    onClick('writeup-viewer-close', () => {
      this.clearFileViewer();
    });

    document.getElementById('writeup-list').addEventListener('click', event => {
      const row = event.target.closest('[data-drill-file], [data-writeup]');
      if (!row) return;
      this.openRunFile(row.dataset.drillFile || `outputs/${row.dataset.writeup}`);
    });

    document.getElementById('finding-list').addEventListener('click', event => {
      const row = event.target.closest('[data-brain-entry]');
      if (row) this.selectBrainEntry(row.dataset.brainEntry);
    });

    document.getElementById('source-list').addEventListener('click', event => {
      const file = event.target.closest('[data-drill-file]');
      if (file) this.openRunFile(file.dataset.drillFile);
    });

    document.querySelectorAll('[data-inspector-tab]').forEach(button => {
      button.addEventListener('click', () => this.openInspector(button.dataset.inspectorTab));
    });
    document.querySelectorAll('[data-inspector-target]').forEach(button => {
      button.addEventListener('click', () => {
        const target = button.dataset.inspectorTarget;
        if (target === 'activity') {
          document.getElementById('drill-activity-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        this.openInspector(target, { scroll: true });
      });
    });

    document.getElementById('brain-kind-filters').addEventListener('click', event => {
      const button = event.target.closest('[data-stream-kind]');
      if (!button) return;
      this.brainKindFilter = button.dataset.streamKind;
      this.renderBrainStream();
    });
    document.getElementById('brain-stream-search').addEventListener('input', event => {
      this.brainSearch = event.target.value || '';
      this.renderBrainStream();
    });
    onClick('brain-load-more', () => this.loadEarlierBrain());

    document.getElementById('source-tool-filters').addEventListener('click', event => {
      const button = event.target.closest('[data-source-tool]');
      if (!button) return;
      this.sourceToolFilter = button.dataset.sourceTool;
      this.renderSources();
    });
    document.getElementById('source-search').addEventListener('input', event => {
      this.sourceSearch = event.target.value || '';
      this.renderSources();
    });
    onClick('sources-load-more', () => this.loadEarlierSources());

    document.getElementById('file-search').addEventListener('input', event => {
      this.fileSearch = event.target.value || '';
      this.renderFiles();
    });
    document.getElementById('file-kind-filter').addEventListener('change', event => {
      this.fileKindFilter = event.target.value || 'all';
      this.renderFiles();
    });
    onClick('file-refresh-btn', () => this.loadDrillFiles({ force: true }));

    document.querySelectorAll('.provider-section').forEach(section => {
      const toggle = section.querySelector('.toggle-chip input[type="checkbox"]');
      if (toggle) {
        toggle.addEventListener('change', () => this.updateProviderSectionVisibility());
      }
    });
    this.updateProviderSectionVisibility();

    const queryBrain = document.getElementById('query-brain');
    if (queryBrain) {
      queryBrain.addEventListener('change', event => this.handleQueryBrainChange(event));
    }
  }

  async api(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const body = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(body?.error || body?.message || response.statusText);
    }
    return body;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : ''}`.trim();
    toast.textContent = message;
    this.toastStack.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3800);
  }

  switchView(viewName) {
    this.activeView = viewName;
    this.viewTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === viewName));
    this.views.forEach((view, key) => view.classList.toggle('active', key === viewName));

    if (viewName === 'chat' && window.InteractiveTab) {
      window.InteractiveTab.init(this.selectedBrainId);
    }
  }

  // ── The drill: start, see, steer ─────────────────────────────────────

  getSelectedProvider(formId, fieldName) {
    const select = document.querySelector(`#${formId} [name="${fieldName}"]`);
    if (!select) return '';
    const selected = select.options[select.selectedIndex];
    return selected?.dataset?.provider || '';
  }

  gatherLaunchSettings() {
    const form = document.getElementById('launch-form');
    const read = name => form.querySelector(`[name="${name}"]`)?.value || '';
    return {
      ...LAUNCH_ENGINE_DEFAULTS,
      topic: read('topic').trim(),
      context: read('context').trim(),
      runName: read('runName').trim(),
      cycles: Number.parseInt(read('cycles') || '24', 10),
      maxRuntimeMinutes: Number.parseInt(read('maxRuntimeMinutes') || '0', 10),
      primaryModel: read('primaryModel'),
      fastModel: read('fastModel'),
      strategicModel: read('strategicModel'),
      primaryProvider: this.getSelectedProvider('launch-form', 'primaryModel'),
      fastProvider: this.getSelectedProvider('launch-form', 'fastModel'),
      strategicProvider: this.getSelectedProvider('launch-form', 'strategicModel'),
      executionMode: 'guided-exclusive'
    };
  }

  async startDrill() {
    try {
      const payload = this.gatherLaunchSettings();
      if (!payload.topic) {
        this.showToast('The drill needs a question', 'error');
        return;
      }
      const result = await this.api('/api/launch', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.activeContext = {
        runName: result.runName,
        brainId: result.brainId,
        topic: payload.topic,
        startedAt: new Date().toISOString(),
        wsUrl: result.wsUrl
      };
      this.showIdleOverride = false;
      this.resetDrillFeeds();
      this.showToast(`Drilling: ${result.runName}`);
      this.switchView(RESEARCH_LAUNCH_VIEW);
      await Promise.all([this.loadStatus(), this.loadDrillStatus(), this.loadBrains()]);
    } catch (error) {
      this.showToast(`Launch failed: ${error.message}`, 'error');
    }
  }

  async continueDrill() {
    const brainId = document.getElementById('continue-brain')?.value;
    if (!brainId) {
      this.showToast('Pick a brain to continue', 'error');
      return;
    }
    try {
      const form = document.getElementById('continue-form');
      const read = name => form.querySelector(`[name="${name}"]`)?.value || '';
      const payload = {
        cycles: Number.parseInt(read('cycles') || '24', 10),
        maxRuntimeMinutes: Number.parseInt(read('maxRuntimeMinutes') || '0', 10)
      };
      const result = await this.api(`/api/continue/${encodeURIComponent(brainId)}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.activeContext = {
        runName: result.runName,
        brainId: result.brainId,
        topic: result.runName,
        startedAt: new Date().toISOString(),
        wsUrl: result.wsUrl
      };
      this.showIdleOverride = false;
      this.resetDrillFeeds();
      this.showToast(`Drilling again: ${result.runName}`);
      this.switchView(RESEARCH_LAUNCH_VIEW);
      await Promise.all([this.loadStatus(), this.loadDrillStatus(), this.loadBrains()]);
    } catch (error) {
      this.showToast(`Continue failed: ${error.message}`, 'error');
    }
  }

  async stopDrill() {
    try {
      const result = await this.api('/api/stop', { method: 'POST', body: JSON.stringify({}) });
      this.disconnectWebSocket();
      this.activeContext = null;
      this.showToast(result.message || 'Drill stopped');
      await Promise.all([this.loadStatus(), this.loadDrillStatus(), this.loadBrains()]);
    } catch (error) {
      this.showToast(`Stop failed: ${error.message}`, 'error');
    }
  }

  async sendNote() {
    const input = document.getElementById('note-input');
    const text = (input.value || '').trim();
    if (!text) return;
    try {
      await this.api('/api/drill/note', {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      input.value = '';
      this.showToast('Note queued — the drill reads it next cycle');
      await this.loadDrillStatus();
    } catch (error) {
      this.showToast(`Note failed: ${error.message}`, 'error');
    }
  }

  startDrillPolling() {
    if (!this.drillPollTimer) {
      this.loadDrillStatus();
      this.drillPollTimer = window.setInterval(() => this.loadDrillStatus(), 2500);
    }
    if (!this.drillTickTimer) {
      this.drillTickTimer = window.setInterval(() => this.renderBudgets(), 1000);
    }
  }

  async loadDrillStatus() {
    try {
      const result = await this.api('/api/drill/status');
      this.lastDrill = result;
      this.renderDrill();
    } catch {
      // Transient — keep the last rendered board.
    }
  }

  resetDrillFeeds() {
    const feed = document.getElementById('drill-feed');
    if (feed) feed.innerHTML = '';
    const consoleFeed = document.getElementById('console-feed');
    if (consoleFeed) consoleFeed.innerHTML = '';
    this.consoleCursor = 0;
    this.inspectorRunName = null;
    this.brainStream = [];
    this.brainStreamBefore = null;
    this.brainStreamHasMore = true;
    this.selectedBrainEntryKey = null;
    this.sourceReceipts = [];
    this.sourcesBefore = null;
    this.sourcesHaveMore = true;
    this.drillFiles = [];
    this.drillFileSummary = null;
    this.filesLoadedForRun = null;
    this.selectedFilePath = null;
    this.liveEvents = [];
  }

  openInspector(tab, { scroll = false } = {}) {
    if (!['brain', 'files', 'sources'].includes(tab)) return;
    this.inspectorTab = tab;
    document.querySelectorAll('[data-inspector-tab]').forEach(button => {
      const active = button.dataset.inspectorTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-inspector-pane]').forEach(pane => {
      const active = pane.dataset.inspectorPane === tab;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
    if (tab === 'files') this.loadDrillFiles();
    if (scroll) {
      document.getElementById('drill-inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  streamEntryKey(entry) {
    return [
      Number(entry?.at) || 0,
      entry?.kind || entry?.tool || 'entry',
      entry?.workerId || '-',
      String(entry?.content || entry?.query || '').slice(0, 120)
    ].join('|');
  }

  mergeTapeEntries(current, incoming, max = 700) {
    const merged = new Map();
    for (const entry of [...current, ...(incoming || [])]) {
      if (!entry || typeof entry !== 'object') continue;
      merged.set(this.streamEntryKey(entry), entry);
    }
    return [...merged.values()]
      .sort((left, right) => (Number(right.at) || 0) - (Number(left.at) || 0))
      .slice(0, max);
  }

  absorbDrillPayload(payload) {
    const runName = payload?.runName || null;
    if (runName && this.inspectorRunName && this.inspectorRunName !== runName) {
      this.resetDrillFeeds();
    }
    if (runName) this.inspectorRunName = runName;

    const firstBrainWindow = this.brainStream.length === 0;
    const firstSourceWindow = this.sourceReceipts.length === 0;
    const fallbackFindings = (payload?.findings || []).map(finding => ({
      ...finding,
      kind: 'finding',
      brain: finding.brain || (finding.promoted ? 'live' : 'journaled')
    }));
    this.brainStream = this.mergeTapeEntries(
      this.brainStream,
      (payload?.stream || []).length > 0 ? payload.stream : fallbackFindings
    );
    this.sourceReceipts = this.mergeTapeEntries(this.sourceReceipts, payload?.sources || []);
    if (firstBrainWindow) this.brainStreamHasMore = (payload?.stream || []).length >= 40;
    if (firstSourceWindow) this.sourcesHaveMore = (payload?.sources || []).length >= 20;

    const streamTimes = this.brainStream.map(entry => Number(entry.at)).filter(Number.isFinite);
    const sourceTimes = this.sourceReceipts.map(entry => Number(entry.at)).filter(Number.isFinite);
    if (streamTimes.length > 0) this.brainStreamBefore = Math.min(...streamTimes);
    if (sourceTimes.length > 0) this.sourcesBefore = Math.min(...sourceTimes);
  }

  renderPulse(drill) {
    const workers = Array.isArray(drill?.activeWorkers) ? drill.activeWorkers : [];
    document.getElementById('pulse-workers').textContent = String(workers.length);
    document.getElementById('pulse-workers-note').textContent = workers.length > 0
      ? `${workers.length} of ${drill.maxConcurrent || workers.length} slots active`
      : 'No bits in flight';
    document.getElementById('pulse-tape').textContent = String(this.brainStream.length);
    document.getElementById('pulse-sources').textContent = String(this.sourceReceipts.length);
    document.getElementById('pulse-brain').textContent = String(drill?.counts?.brainWrites ?? 0);
    document.getElementById('brain-writes-count').textContent =
      `${drill?.counts?.brainWrites ?? 0} live writes`;
    document.getElementById('pulse-files').textContent =
      this.drillFileSummary ? String(this.drillFileSummary.totalFiles) : '—';
    document.getElementById('pulse-files-note').textContent = this.drillFileSummary
      ? `${formatBytes(this.drillFileSummary.totalBytes)} on disk`
      : 'Inspect the run directory';
  }

  renderDrill() {
    const payload = this.lastDrill;
    const idle = document.getElementById('drill-idle');
    const live = document.getElementById('drill-live');
    const doneBanner = document.getElementById('drill-done-banner');
    if (!idle || !live) return;

    const drill = payload?.drill || null;
    const running = payload?.running === true;
    const hasBoard = drill && !this.showIdleOverride;

    idle.hidden = Boolean(hasBoard);
    live.hidden = !hasBoard;
    // Any board without a live engine gets the banner — done, stopped,
    // errored, or interrupted mid-drill — so New drill / Continue / Query
    // are always reachable.
    doneBanner.hidden = !(hasBoard && !running);

    if (!hasBoard) return;

    this.absorbDrillPayload(payload);
    document.getElementById('drill-question-text').textContent = drill.question || payload.topic || '—';
    document.getElementById('drill-run-meta').textContent = [
      payload.runName ? `Run ${payload.runName}` : null,
      drill.mode === 'drilling' && running ? 'drilling' : drill.mode,
      drill.fatalError ? drill.fatalError : null
    ].filter(Boolean).join(' · ');
    const stopButton = document.getElementById('stop-run-btn');
    const noteInput = document.getElementById('note-input');
    const noteSubmit = document.getElementById('note-submit-btn');
    stopButton.hidden = !running;
    noteInput.disabled = !running;
    noteSubmit.disabled = !running;
    document.getElementById('operator-state-note').textContent = running
      ? 'Notes are durable and picked up by the next worker cycle.'
      : 'This run is not active. Continue the brain to steer another descent.';

    this.renderBudgets();
    this.renderPulse(drill);
    this.renderGoal(drill);
    this.renderSteerAndFeeds(payload);
    if (this.filesLoadedForRun !== payload.runName && !this.filesLoading) {
      this.loadDrillFiles();
    }

    if (!running) {
      const title = document.getElementById('drill-done-title');
      const detail = document.getElementById('drill-done-detail');
      if (drill.fatalError) {
        title.textContent = 'Drill stopped on a fatal error';
        detail.textContent = drill.fatalError;
      } else if (drill.mode === 'done') {
        title.textContent = `Drill done — ${String(drill.doneReason || '').replace(/_/g, ' ')}`;
        detail.textContent = `${drill.budgets?.cyclesUsed ?? 0} cycles, ${drill.counts?.goalsCompleted ?? 0} goals completed. The Brain stays queryable from Query.`;
      } else if (drill.mode === 'drilling') {
        title.textContent = 'Drill interrupted — the engine is not running';
        detail.textContent = 'Continue this brain with a fresh budget to resume the goal chain, or query what it learned.';
      } else {
        title.textContent = 'Drill stopped';
        detail.textContent = 'Continue it with a fresh budget, or query what it learned.';
      }
    }
  }

  renderBudgets() {
    const drill = this.lastDrill?.drill;
    if (!drill?.budgets) return;
    const running = this.lastDrill?.running === true && drill.mode === 'drilling';
    const budgets = drill.budgets;

    const cyclesEl = document.getElementById('budget-cycles');
    const cyclesFill = document.getElementById('budget-cycles-fill');
    if (budgets.cyclesTotal) {
      cyclesEl.textContent = drill.mode === 'done'
        ? `${budgets.cyclesUsed} of ${budgets.cyclesTotal} used`
        : `${budgets.cyclesRemaining} of ${budgets.cyclesTotal} left`;
      cyclesFill.style.width = `${Math.min(100, (budgets.cyclesUsed / budgets.cyclesTotal) * 100)}%`;
    } else {
      cyclesEl.textContent = `${budgets.cyclesUsed} used · no cycle limit`;
      cyclesFill.style.width = '0%';
    }

    const timeEl = document.getElementById('budget-time');
    const timeFill = document.getElementById('budget-time-fill');
    if (budgets.timeBudgetMs) {
      // Interpolate between polls so the countdown moves.
      const staleness = running && drill.updatedAt ? Math.max(0, Date.now() - drill.updatedAt) : 0;
      const remaining = Math.max(0, (budgets.timeRemainingMs ?? 0) - staleness);
      timeEl.textContent = `${formatMs(remaining)} left`;
      timeFill.style.width = `${Math.min(100, ((budgets.timeBudgetMs - remaining) / budgets.timeBudgetMs) * 100)}%`;
    } else {
      const staleness = running && drill.updatedAt ? Math.max(0, Date.now() - drill.updatedAt) : 0;
      timeEl.textContent = `${formatMs((budgets.elapsedMs ?? 0) + staleness)} elapsed · no time limit`;
      timeFill.style.width = '0%';
    }
  }

  renderGoal(drill) {
    const goal = drill.goal;
    document.getElementById('goal-number-chip').textContent = goal ? `Goal ${goal.number}` : '—';
    document.getElementById('goal-title').textContent = goal ? goal.title : 'Waiting for the first goal…';
    document.getElementById('goal-why').textContent = goal?.why || '';

    const phaseList = document.getElementById('phase-list');
    phaseList.innerHTML = '';
    for (const phase of goal?.phases || []) {
      const item = document.createElement('li');
      item.className = `phase-item phase-${phase.status}`;
      const evidence = Number(phase.evidence?.streamed) || 0;
      const rejections = Number(phase.rejections) || 0;
      const evidenceWidth = Math.min(100, Math.log2(evidence + 1) * 22);
      const workerChip = phase.workerId
        ? `<span class="phase-worker-chip">${escapeHtml(phase.workerId)}</span>`
        : '';
      item.innerHTML = `
        <span class="phase-marker"></span>
        <div class="phase-body">
          <strong>${escapeHtml(phase.title)}${workerChip}</strong>
          ${phase.status === 'done' && phase.summary
            ? `<small>${escapeHtml(String(phase.summary).slice(0, 140))}</small>`
            : phase.status === 'active'
              ? `<small>${phase.workerId ? `worker ${escapeHtml(phase.workerId)} is drilling this phase now` : 'drilling this phase now'}</small>`
              : ''}
          <span class="phase-metrics">
            <span>${escapeHtml(String(phase.cyclesUsed || 0))} descent${Number(phase.cyclesUsed) === 1 ? '' : 's'}</span>
            <span>${escapeHtml(String(evidence))} tape entr${evidence === 1 ? 'y' : 'ies'}</span>
            ${rejections > 0 ? `<span class="phase-rejection">${escapeHtml(String(rejections))} hidden-work close${rejections === 1 ? '' : 's'} rejected</span>` : ''}
          </span>
        </div>
        <span class="phase-status">${escapeHtml(phase.status)}</span>
        <span class="phase-evidence-track" aria-hidden="true"><span class="phase-evidence-fill" style="width:${evidenceWidth}%"></span></span>
      `;
      phaseList.appendChild(item);
    }

    const history = document.getElementById('goal-history-list');
    history.innerHTML = '';
    for (const past of drill.goalHistory || []) {
      const item = document.createElement('li');
      item.innerHTML = `<span>Goal ${past.number}</span> ${escapeHtml(past.title)} <em>done</em>`;
      history.appendChild(item);
    }
    const nextNote = document.getElementById('goal-next-note');
    if (drill.mode === 'drilling') {
      nextNote.textContent = 'When this goal is done, the drill creates the next one — until cycles or time run out.';
    } else if (drill.mode === 'done') {
      nextNote.textContent = 'Budget spent. Continue this brain to keep the goal chain going.';
    } else {
      nextNote.textContent = '';
    }

    this.renderWorkers(drill);
  }

  renderWorkers(drill) {
    const workers = Array.isArray(drill.activeWorkers) ? drill.activeWorkers : [];
    const now = document.getElementById('activity-now');
    if (drill.mode === 'drilling' && workers.length > 0) {
      now.textContent = workers.length === 1
        ? `1 worker in flight (of ${drill.maxConcurrent || 1})`
        : `${workers.length} workers in flight (of ${drill.maxConcurrent || workers.length})`;
    } else {
      now.textContent = '—';
    }

    const strip = document.getElementById('worker-strip');
    strip.innerHTML = workers.map(worker => `
      <div class="worker-chip">
        <span class="worker-chip-id">${escapeHtml(worker.workerId)}</span>
        <span class="worker-chip-detail">cycle ${escapeHtml(String(worker.cycle))} · goal ${escapeHtml(String(worker.goalNumber))} phase ${escapeHtml(String(worker.phaseNumber))} — ${escapeHtml(String(worker.phaseTitle).slice(0, 48))}</span>
        <span class="worker-chip-turns">${escapeHtml(String(worker.turns || 0))} turns</span>
      </div>`).join('');
  }

  renderSteerAndFeeds(payload) {
    const notes = payload.notes || [];
    const noteList = document.getElementById('note-list');
    noteList.innerHTML = notes.length === 0
      ? '<p class="cc-empty">No notes yet.</p>'
      : notes.map(note => `
          <div class="note-item">
            <span>${escapeHtml(note.text)}</span>
            <small>${escapeHtml(new Date(note.at).toLocaleTimeString())}</small>
          </div>`).join('');

    this.renderLiveActivity();
    this.renderBrainStream();
    this.renderSources();
    this.renderFiles();
  }

  renderLiveActivity() {
    const feed = document.getElementById('drill-feed');
    if (!feed) return;
    const socketEntries = this.liveEvents.map(event => ({
      at: Number(event.timestamp) || Number(event.at) || Date.now(),
      kind: String(event.type || 'event').replace(/^drill_/, ''),
      content: this.formatEvent(event),
      workerId: event.workerId || null,
      cycle: event.cycle ?? null,
      source: 'socket'
    }));
    const entries = this.mergeTapeEntries(this.brainStream.slice(0, 35), socketEntries, 45)
      .filter(entry => entry.content);
    feed.innerHTML = entries.length === 0
      ? '<p class="cc-empty">Waiting for the first durable event…</p>'
      : entries.map(entry => {
        const at = Number(entry.at);
        const time = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleTimeString() : '—';
        const kind = String(entry.kind || 'event').replace(/^drill_/, '');
        const meta = [
          entry.workerId || null,
          entry.cycle ? `cycle ${entry.cycle}` : null
        ].filter(Boolean).join(' · ');
        return `
          <div class="feed-item ${entry.source === 'socket' ? 'feed-drill' : ''}">
            <span class="feed-time">${escapeHtml(time)}</span>
            <span class="feed-kind">${escapeHtml(kind.slice(0, 14))}</span>
            <span class="feed-body">${escapeHtml(String(entry.content).slice(0, 260))}${meta ? `<small> · ${escapeHtml(meta)}</small>` : ''}</span>
          </div>`;
      }).join('');
  }

  renderBrainStream() {
    document.querySelectorAll('[data-stream-kind]').forEach(button => {
      button.classList.toggle('active', button.dataset.streamKind === this.brainKindFilter);
    });

    const summary = this.brainStream.reduce((counts, entry) => {
      const kind = entry.kind || 'finding';
      counts[kind] = (counts[kind] || 0) + 1;
      return counts;
    }, {});
    const summaryOrder = ['goal', 'phase', 'thought', 'harvest', 'offshoot', 'finding'];
    document.getElementById('brain-kind-summary').innerHTML = summaryOrder
      .filter(kind => summary[kind])
      .map(kind => `<span class="brain-summary-chip">${escapeHtml(kind)} <strong>${summary[kind]}</strong></span>`)
      .join('');

    const needle = this.brainSearch.trim().toLowerCase();
    const filtered = this.brainStream.filter(entry => {
      if (this.brainKindFilter !== 'all' && entry.kind !== this.brainKindFilter) return false;
      if (needle && !JSON.stringify(entry).toLowerCase().includes(needle)) return false;
      return true;
    });
    const keys = new Set(filtered.map(entry => encodeURIComponent(this.streamEntryKey(entry))));
    if (!this.selectedBrainEntryKey || !keys.has(this.selectedBrainEntryKey)) {
      this.selectedBrainEntryKey = filtered[0]
        ? encodeURIComponent(this.streamEntryKey(filtered[0]))
        : null;
    }

    const list = document.getElementById('finding-list');
    list.innerHTML = filtered.length === 0
      ? `<p class="cc-empty">${this.brainStream.length === 0 ? 'Nothing on the tape yet.' : 'No tape entries match this view.'}</p>`
      : filtered.map(entry => {
        const key = encodeURIComponent(this.streamEntryKey(entry));
        const state = entry.brain || 'journaled';
        const at = Number(entry.at);
        const time = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'time unknown';
        const meta = [
          entry.workerId || null,
          entry.goalNumber ? `goal ${entry.goalNumber}` : null,
          entry.phaseNumber ? `phase ${entry.phaseNumber}` : null,
          entry.cycle ? `cycle ${entry.cycle}` : null
        ].filter(Boolean);
        return `
          <button type="button" class="brain-entry ${key === this.selectedBrainEntryKey ? 'active' : ''}" data-brain-entry="${escapeHtml(key)}">
            <span class="brain-entry-head">
              <span class="brain-entry-kind">${escapeHtml(entry.kind || 'finding')}</span>
              <span class="brain-state ${escapeHtml(state)}">${escapeHtml(state)}</span>
            </span>
            <span class="brain-entry-copy">${escapeHtml(String(entry.content || '').slice(0, 240))}</span>
            <span class="brain-entry-meta">
              <span>${escapeHtml(time)}</span>
              ${meta.map(value => `<span>${escapeHtml(value)}</span>`).join('')}
            </span>
          </button>`;
      }).join('');

    const selected = filtered.find(entry =>
      encodeURIComponent(this.streamEntryKey(entry)) === this.selectedBrainEntryKey);
    this.renderBrainEntryDetail(selected);
    document.getElementById('brain-load-more').hidden = !this.brainStreamHasMore;
  }

  renderBrainEntryDetail(entry) {
    const detail = document.getElementById('brain-entry-detail');
    if (!entry) {
      detail.innerHTML = '<p class="cc-empty">Select a tape entry to inspect its full content and provenance.</p>';
      return;
    }
    const values = [
      ['Time', entry.at ? new Date(entry.at).toLocaleString() : 'unknown'],
      ['Brain', entry.brain || 'journaled'],
      ['Worker', entry.workerId || 'coordinator'],
      ['Cycle', entry.cycle ?? '—'],
      ['Goal', entry.goalNumber ?? '—'],
      ['Phase', entry.phaseNumber ?? '—']
    ];
    detail.innerHTML = `
      <div class="detail-kicker">
        <span class="brain-entry-kind">${escapeHtml(entry.kind || 'finding')}</span>
        <span class="brain-state ${escapeHtml(entry.brain || 'journaled')}">${escapeHtml(entry.brain || 'journaled')}</span>
      </div>
      <p class="detail-content">${escapeHtml(String(entry.content || ''))}</p>
      <div class="detail-provenance">
        ${values.map(([label, value]) => `
          <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
      </div>`;
  }

  selectBrainEntry(key) {
    this.selectedBrainEntryKey = key;
    this.renderBrainStream();
  }

  async loadEarlierBrain() {
    const button = document.getElementById('brain-load-more');
    if (!this.brainStreamBefore || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Loading earlier tape…';
    try {
      const result = await this.api(
        `/api/drill/tape?channel=stream&before=${encodeURIComponent(this.brainStreamBefore)}&limit=150`
      );
      this.brainStream = this.mergeTapeEntries(this.brainStream, result.entries || []);
      const times = this.brainStream.map(entry => Number(entry.at)).filter(Number.isFinite);
      if (times.length > 0) this.brainStreamBefore = Math.min(...times);
      this.brainStreamHasMore = result.hasMore === true && (result.entries || []).length > 0;
      this.renderBrainStream();
      this.renderPulse(this.lastDrill?.drill);
    } catch (error) {
      this.showToast(`Tape load failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Load earlier tape';
    }
  }

  renderSources() {
    document.querySelectorAll('[data-source-tool]').forEach(button => {
      button.classList.toggle('active', button.dataset.sourceTool === this.sourceToolFilter);
    });
    const needle = this.sourceSearch.trim().toLowerCase();
    const filtered = this.sourceReceipts.filter(receipt => {
      if (this.sourceToolFilter !== 'all' && receipt.tool !== this.sourceToolFilter) return false;
      if (needle && !JSON.stringify(receipt).toLowerCase().includes(needle)) return false;
      return true;
    });
    document.getElementById('sources-count').textContent = String(filtered.length);
    document.getElementById('source-list').innerHTML = filtered.length === 0
      ? `<p class="cc-empty">${this.sourceReceipts.length === 0 ? 'No fetches yet.' : 'No fetch receipts match this view.'}</p>`
      : filtered.map(source => {
        const at = Number(source.at);
        const time = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'time unknown';
        const provenance = [
          source.workerId || null,
          source.goalNumber ? `g${source.goalNumber}` : null,
          source.phaseNumber ? `p${source.phaseNumber}` : null,
          source.cycle ? `cycle ${source.cycle}` : null
        ].filter(Boolean).join(' · ');
        const query = String(source.query || '');
        const filePath = /^(outputs|drill)\//.test(query) ? query : null;
        return `
          <article class="source-item">
            <div class="source-item-head">
              <span class="source-tool">${escapeHtml(source.tool || 'fetch')}</span>
              <span class="source-provenance">${escapeHtml(provenance || time)}</span>
            </div>
            <div class="source-query">${escapeHtml(query)}</div>
            ${(source.urls || []).slice(0, 8).map(url =>
              `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
            ).join('')}
            ${filePath ? `<button class="source-file-link" type="button" data-drill-file="${escapeHtml(filePath)}">Open ${escapeHtml(filePath)}</button>` : ''}
            <span class="brain-entry-meta"><span>${escapeHtml(time)}</span></span>
          </article>`;
      }).join('');
    document.getElementById('sources-load-more').hidden = !this.sourcesHaveMore;
  }

  async loadEarlierSources() {
    const button = document.getElementById('sources-load-more');
    if (!this.sourcesBefore || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Loading earlier receipts…';
    try {
      const result = await this.api(
        `/api/drill/tape?channel=sources&before=${encodeURIComponent(this.sourcesBefore)}&limit=150`
      );
      this.sourceReceipts = this.mergeTapeEntries(this.sourceReceipts, result.entries || []);
      const times = this.sourceReceipts.map(entry => Number(entry.at)).filter(Number.isFinite);
      if (times.length > 0) this.sourcesBefore = Math.min(...times);
      this.sourcesHaveMore = result.hasMore === true && (result.entries || []).length > 0;
      this.renderSources();
      this.renderPulse(this.lastDrill?.drill);
    } catch (error) {
      this.showToast(`Receipt load failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Load earlier receipts';
    }
  }

  async loadDrillFiles({ force = false } = {}) {
    const runName = this.lastDrill?.runName;
    if (!runName || this.filesLoading) return;
    if (!force && this.filesLoadedForRun === runName) return;
    this.filesLoading = true;
    document.getElementById('file-summary').textContent = 'Reading outputs/ and drill/…';
    try {
      const result = await this.api('/api/drill/files?limit=1000&depth=12');
      this.drillFiles = result.files || [];
      this.drillFileSummary = {
        totalFiles: result.totalFiles || 0,
        totalBytes: result.totalBytes || 0,
        counts: result.counts || {},
        truncated: result.truncated === true
      };
      this.filesLoadedForRun = runName;
      this.renderFiles();
      this.renderPulse(this.lastDrill?.drill);
    } catch (error) {
      document.getElementById('file-summary').textContent = `Files unavailable: ${error.message}`;
    } finally {
      this.filesLoading = false;
    }
  }

  fileMatchesKind(file) {
    if (this.fileKindFilter === 'all') return true;
    if (this.fileKindFilter === 'writeup') return file.kind === 'writeup';
    if (this.fileKindFilter === 'data') return ['data', 'findings', 'artifact'].includes(file.kind) && file.root === 'outputs';
    if (this.fileKindFilter === 'tape') return ['brain_tape', 'source_tape', 'findings', 'drill_tape'].includes(file.kind);
    if (this.fileKindFilter === 'drill') return file.root === 'drill';
    return true;
  }

  renderFiles() {
    const list = document.getElementById('writeup-list');
    if (!list) return;
    const needle = this.fileSearch.trim().toLowerCase();
    const files = this.drillFiles.filter(file =>
      this.fileMatchesKind(file)
      && (!needle || String(file.path).toLowerCase().includes(needle))
    );
    const summary = this.drillFileSummary;
    document.getElementById('file-summary').textContent = summary
      ? `${files.length} shown · ${summary.totalFiles} files · ${formatBytes(summary.totalBytes)}${summary.truncated ? ' · listing capped' : ''}`
      : 'Loading run files…';
    list.innerHTML = files.length === 0
      ? '<p class="cc-empty">No run files match this view.</p>'
      : files.map(file => `
          <button type="button" class="file-row ${file.path === this.selectedFilePath ? 'active' : ''}" data-drill-file="${escapeHtml(file.path)}">
            <span class="file-row-head">
              <span class="file-row-path">${escapeHtml(file.path)}</span>
              <span class="file-kind">${escapeHtml(String(file.kind).replace(/_/g, ' '))}</span>
            </span>
            <span class="file-row-meta">
              <span>${formatBytes(file.size)}</span>
              <span>${escapeHtml(new Date(file.modified).toLocaleString())}</span>
              ${file.previewable ? '<span>preview</span>' : '<span>binary</span>'}
            </span>
          </button>`).join('');
  }

  async openRunFile(file) {
    if (!file) return;
    this.openInspector('files', { scroll: true });
    this.selectedFilePath = file;
    this.renderFiles();
    const name = document.getElementById('writeup-viewer-name');
    const meta = document.getElementById('file-viewer-meta');
    const body = document.getElementById('writeup-viewer-body');
    name.textContent = file;
    meta.textContent = 'Loading preview…';
    body.textContent = '';
    try {
      const result = await this.api(`/api/drill/file?path=${encodeURIComponent(file)}`);
      name.textContent = result.path;
      meta.textContent = [
        String(result.kind || '').replace(/_/g, ' '),
        formatBytes(result.size),
        result.modified ? new Date(result.modified).toLocaleString() : null,
        result.truncated ? 'preview truncated at 512 KB' : null
      ].filter(Boolean).join(' · ');
      body.textContent = result.previewable
        ? (result.content || '(empty file)')
        : 'This file is binary. The control center lists it but does not render binary data inline.';
    } catch (error) {
      meta.textContent = 'Preview failed';
      body.textContent = error.message;
      this.showToast(`Open failed: ${error.message}`, 'error');
    }
  }

  async openWriteup(file) {
    return this.openRunFile(file.startsWith('outputs/') ? file : `outputs/${file}`);
  }

  clearFileViewer() {
    this.selectedFilePath = null;
    document.getElementById('writeup-viewer-name').textContent = 'Select a file';
    document.getElementById('file-viewer-meta').textContent = 'Text files can be previewed here.';
    document.getElementById('writeup-viewer-body').textContent =
      'The file browser is read-only. It exposes outputs/ and drill/ without opening run configuration or secrets.';
    this.renderFiles();
  }

  // ── Status + live event feed ──────────────────────────────────────────

  async loadStatus() {
    try {
      const status = await this.api('/api/status');
      const running = !!status.running;
      this.activeContext = status.activeContext || null;

      const chip = document.getElementById('cc-run-chip');
      if (running) {
        chip.textContent = `Drilling · ${status.activeContext.runName}`;
        chip.dataset.state = 'running';
      } else {
        chip.textContent = 'Idle';
        chip.dataset.state = 'idle';
      }

      if (running && status.wsUrl) {
        this.connectWebSocket(status.wsUrl);
        this.startConsolePolling();
      } else {
        this.disconnectWebSocket();
        this.stopConsolePolling();
      }
    } catch (error) {
      this.showToast(`Status load failed: ${error.message}`, 'error');
    }
  }

  getActiveBrainId() {
    if (!this.activeContext || this.brains.length === 0) return null;
    const byId = this.activeContext.brainId
      && this.brains.find(brain => brain.routeKey === this.activeContext.brainId);
    if (byId) return byId.routeKey;
    const byName = this.activeContext.runName
      && this.brains.find(brain => brain.name === this.activeContext.runName);
    return byName?.routeKey || null;
  }

  connectWebSocket(wsUrl) {
    this.wsUrl = wsUrl;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          this.appendEvent(data);
        } catch { /* non-JSON frame */ }
      };
      this.ws.onclose = () => {
        this.ws = null;
        if (this.activeContext && !this.wsRetryTimer) {
          this.wsRetryTimer = window.setTimeout(() => {
            this.wsRetryTimer = null;
            if (this.activeContext && this.wsUrl) this.connectWebSocket(this.wsUrl);
          }, 2000);
        }
      };
      this.ws.onerror = () => { /* onclose handles retry */ };
    } catch { /* board still updates from polling */ }
  }

  disconnectWebSocket() {
    if (this.wsRetryTimer) {
      window.clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  appendEvent(event) {
    const text = this.formatEvent(event);
    if (!text) return;
    this.liveEvents = [event, ...this.liveEvents].slice(0, 120);
    this.renderLiveActivity();
    if (String(event.type || '').startsWith('drill_')) {
      this.loadDrillStatus();
    }
  }

  formatEvent(event) {
    if (event.message) return event.message;
    const parts = [event.type || 'event'];
    if (event.cycle !== undefined) parts.push(`cycle ${event.cycle}`);
    if (event.tool) parts.push(event.tool);
    if (event.agentType) parts.push(event.agentType);
    if (event.summary) parts.push(event.summary);
    else if (event.goal) parts.push(event.goal);
    return parts.join(' · ');
  }

  startConsolePolling() {
    if (!this.consoleTimer) {
      this.consoleTimer = window.setInterval(() => this.loadConsoleLogs(), 2000);
    }
  }

  stopConsolePolling() {
    if (this.consoleTimer) {
      window.clearInterval(this.consoleTimer);
      this.consoleTimer = null;
    }
  }

  async loadConsoleLogs() {
    try {
      const query = this.consoleCursor > 0
        ? `/api/watch/logs?after=${this.consoleCursor}&limit=250`
        : '/api/watch/logs?limit=250';
      const result = await this.api(query);
      const feed = document.getElementById('console-feed');
      for (const log of result.logs || []) {
        const line = document.createElement('div');
        line.className = `console-line ${log.level === 'error' ? 'error' : ''}`.trim();
        line.textContent = `${new Date(log.timestamp || Date.now()).toLocaleTimeString()} ${log.source || ''} ${log.message || ''}`;
        feed.appendChild(line);
      }
      while (feed.children.length > 400) {
        feed.removeChild(feed.firstChild);
      }
      if (typeof result.cursor === 'number') this.consoleCursor = result.cursor;
    } catch { /* console is a best-effort drawer */ }
  }

  // ── Brains (pickers for continue, query, chat) ────────────────────────

  async loadBrains() {
    try {
      const result = await this.api('/api/brains');
      this.brains = result.brains || [];
      const activeBrainId = this.getActiveBrainId();
      if (activeBrainId) {
        this.selectedBrainId = activeBrainId;
      } else if (!this.selectedBrainId || !this.brains.some(brain => brain.routeKey === this.selectedBrainId)) {
        this.selectedBrainId = this.brains[0]?.routeKey || null;
      }
      populateBrainSelect(document.getElementById('continue-brain'), this.brains, this.selectedBrainId);
      this.renderQueryBrains();
    } catch (error) {
      this.showToast(`Brain scan failed: ${error.message}`, 'error');
    }
  }

  renderQueryBrains() {
    populateBrainSelect(document.getElementById('query-brain'), this.brains, this.selectedBrainId);
    this.updateQueryBrainNote();
    if (typeof window.refreshCosmoQueryTabState === 'function') {
      window.refreshCosmoQueryTabState();
    }
  }

  handleQueryBrainChange(event) {
    const brainId = event.target.value;
    this.updateQueryBrainNote();
    if (this.syncingQueryBrain || !brainId) return;
    this.selectedBrainId = brainId;
  }

  updateQueryBrainNote() {
    const select = document.getElementById('query-brain');
    const note = document.getElementById('query-brain-note');
    if (!select || !note) return;
    const brain = this.brains.find(entry => entry.routeKey === select.value);
    if (!brain) {
      note.textContent = 'Select a brain to query.';
      return;
    }
    const isActiveRun = this.activeContext && (
      brain.name === this.activeContext.runName ||
      brain.routeKey === this.activeContext.brainId
    );
    const nodeLabel = Number.isFinite(brain.nodes) ? `${brain.nodes} nodes` : 'stats on open';
    note.textContent = `${brain.displayName}${isActiveRun ? ' · Drilling now' : ''} · ${nodeLabel}`;
  }

  // ── Models (exact managed pairs for Query; role selects for the drill) ─

  async loadModels() {
    try {
      const result = await this.api('/api/providers/models');
      this.models = result.models || [];
      this.modelDefaults = result.defaults || this.modelDefaults;
      this.queryDefaults = result.queryDefaults || null;
      this.renderModelOptions();
    } catch (error) {
      this.showToast(`Model load failed: ${error.message}`, 'error');
    }
  }

  getChatModels() {
    return this.models.filter(model => model.kind !== 'embedding');
  }

  getLocalModels(kind = null) {
    return this.models.filter(model => {
      const isLocal = model.provider === 'ollama';
      return isLocal && (!kind || model.kind === kind);
    });
  }

  populateModelSelect(selectOrId, models, preferredValue = null) {
    const select = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
    if (!select) return;

    const currentValue = preferredValue || select.value;
    select.innerHTML = '';

    const grouped = models.reduce((acc, model) => {
      const key = model.provider;
      if (!acc[key]) {
        acc[key] = { label: model.providerLabel || model.provider, models: [] };
      }
      acc[key].models.push(model);
      return acc;
    }, {});

    Object.values(grouped).forEach(groupInfo => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupInfo.label;
      groupInfo.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.dataset.provider = model.provider || '';
        option.textContent = model.label || model.id;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });

    if (currentValue && models.some(model => model.id === currentValue)) {
      select.value = currentValue;
    } else if (currentValue) {
      const customOption = document.createElement('option');
      customOption.value = currentValue;
      customOption.textContent = `${currentValue} (custom)`;
      select.insertBefore(customOption, select.firstChild);
      select.value = currentValue;
    } else if (models[0]) {
      select.value = models[0].id;
    }
  }

  // HOME23 PATCH — Query options are exact managed pairs. Launch/catalog
  // controls retain their historical model-only values for compatibility.
  populateQueryModelSelect(selectOrId, models, preferredPair) {
    const select = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
    if (!select) return true;

    select.innerHTML = '';
    select.disabled = true;
    const grouped = new Map();
    for (const model of models) {
      if (!model?.provider || !model?.id) continue;
      if (!grouped.has(model.provider)) grouped.set(model.provider, []);
      grouped.get(model.provider).push(model);
    }
    for (const [provider, providerModels] of grouped) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = providerModels[0].providerLabel || provider;
      for (const model of providerModels) {
        const option = document.createElement('option');
        option.value = encodeQueryModelPair({ provider, model: model.id });
        option.dataset.provider = provider;
        option.dataset.model = model.id;
        option.textContent = model.label || model.id;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }

    let preferredValue = null;
    try {
      preferredValue = encodeQueryModelPair({
        provider: preferredPair?.provider,
        model: preferredPair?.model,
      });
    } catch {
      return false;
    }
    if (!Array.from(select.options || []).some(option => option.value === preferredValue)) {
      return false;
    }
    select.value = preferredValue;
    select.disabled = false;
    return true;
  }

  renderModelOptions() {
    const chatModels = this.getChatModels();
    const localChatModels = this.getLocalModels('chat');

    const launchForm = document.getElementById('launch-form');
    if (launchForm) {
      this.populateModelSelect(launchForm.querySelector('[name="primaryModel"]'), chatModels,
        launchForm.querySelector('[name="primaryModel"]')?.value || this.modelDefaults.launch?.primary);
      this.populateModelSelect(launchForm.querySelector('[name="fastModel"]'), chatModels,
        launchForm.querySelector('[name="fastModel"]')?.value || this.modelDefaults.launch?.fast);
      this.populateModelSelect(launchForm.querySelector('[name="strategicModel"]'), chatModels,
        launchForm.querySelector('[name="strategicModel"]')?.value || this.modelDefaults.launch?.strategic);
    }

    this.populateModelSelect('catalog-query-model', chatModels, this.modelDefaults.queryModel);
    this.populateModelSelect('catalog-pgs-model', chatModels, this.modelDefaults.pgsSweepModel);
    this.populateModelSelect('catalog-local-primary', localChatModels, this.modelDefaults.local?.primary);
    this.populateModelSelect('catalog-local-fast', localChatModels, this.modelDefaults.local?.fast);

    // Query selectors retain the exact managed provider/model pairs. Missing or
    // stale defaults disable Query instead of inventing a model-only fallback.
    const queryDefaults = this.queryDefaults || {};
    const queryModelsReady = [
      this.populateQueryModelSelect('qt-model', chatModels, {
        provider: queryDefaults.defaultProvider,
        model: queryDefaults.defaultModel,
      }),
      this.populateQueryModelSelect('qt-pgs-sweep-model', chatModels, {
        provider: queryDefaults.pgsSweepProvider,
        model: queryDefaults.pgsSweepModel,
      }),
      this.populateQueryModelSelect('qt-pgs-synth-model', chatModels, {
        provider: queryDefaults.pgsSynthProvider,
        model: queryDefaults.pgsSynthModel,
      }),
    ].every(Boolean);
    if (!queryModelsReady && !this.queryModelConfigurationNotified) {
      this.queryModelConfigurationNotified = true;
      this.showToast('Query models are unavailable: managed exact provider/model defaults are incomplete', 'error');
    } else if (queryModelsReady) {
      this.queryModelConfigurationNotified = false;
    }
    if (typeof window.refreshCosmoQueryTabState === 'function') {
      window.refreshCosmoQueryTabState();
    }

    // Chat (Interactive) model select
    this.populateModelSelect('interactive-model', chatModels);

    if (this.modelCatalog) {
      this.applyCatalogFormValues();
    }
  }

  applyCatalogFormValues() {
    if (!this.modelCatalog) return;

    const setLines = (id, providerId) => {
      const element = document.getElementById(id);
      if (!element) return;
      const models = this.modelCatalog.providers?.[providerId]?.models || [];
      element.value = models.map(model => model.id || model.name || '').filter(Boolean).join('\n');
    };

    setLines('catalog-openai-models', 'openai');
    setLines('catalog-anthropic-models', 'anthropic');
    setLines('catalog-xai-models', 'xai');

    const codexContainer = document.getElementById('catalog-codex-models');
    if (codexContainer) {
      const codexModels = this.models.filter(m => m.provider === 'openai-codex');
      codexContainer.innerHTML = '';
      if (codexModels.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'catalog-codex-empty field-note';
        empty.textContent = 'No Codex models available — connect OpenAI Codex OAuth above.';
        codexContainer.appendChild(empty);
      } else {
        codexModels.forEach(model => {
          const chip = document.createElement('span');
          chip.className = 'catalog-codex-chip';
          chip.textContent = model.id;
          chip.title = model.label || model.id;
          codexContainer.appendChild(chip);
        });
      }
    }

    const defaults = this.modelCatalog.defaults || {};
    const setValue = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.value = value || '';
    };
    setValue('catalog-query-model', defaults.queryModel);
    setValue('catalog-pgs-model', defaults.pgsSweepModel);
    setValue('catalog-local-primary', defaults.local?.primary);
    setValue('catalog-local-fast', defaults.local?.fast);
  }

  async loadModelCatalog() {
    try {
      const result = await this.api('/api/models/catalog');
      this.modelCatalog = result.catalog || null;
      if (result.defaults) {
        this.modelDefaults = result.defaults;
      }
      this.applyCatalogFormValues();
      this.renderModelOptions();
    } catch (error) {
      this.showToast(`Model catalog load failed: ${error.message}`, 'error');
    }
  }

  parseCatalogLines(id) {
    return (document.getElementById(id)?.value || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  async saveModelCatalog() {
    try {
      const existingCatalog = this.modelCatalog || {};
      const payload = {
        catalog: {
          ...existingCatalog,
          providers: {
            ...(existingCatalog.providers || {}),
            openai: { ...(existingCatalog.providers?.openai || {}), models: this.parseCatalogLines('catalog-openai-models') },
            anthropic: { ...(existingCatalog.providers?.anthropic || {}), models: this.parseCatalogLines('catalog-anthropic-models') },
            xai: { ...(existingCatalog.providers?.xai || {}), models: this.parseCatalogLines('catalog-xai-models') }
          },
          defaults: {
            ...(existingCatalog.defaults || {}),
            queryModel: document.getElementById('catalog-query-model').value,
            pgsSweepModel: document.getElementById('catalog-pgs-model').value,
            local: {
              ...(existingCatalog.defaults?.local || {}),
              primary: document.getElementById('catalog-local-primary').value,
              fast: document.getElementById('catalog-local-fast').value
            }
          }
        }
      };

      await this.api('/api/models/catalog', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.showToast('Model catalog saved');
      await Promise.all([this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Model catalog save failed: ${error.message}`, 'error');
    }
  }

  // ── Setup / providers (ported surface) ────────────────────────────────

  getFormField(formId, name) {
    return document.querySelector(`#${formId} [name="${name}"]`);
  }

  setSetupValue(name, value) {
    const field = this.getFormField('setup-form', name);
    if (!field) return;
    if (field.type === 'checkbox') {
      field.checked = !!value;
    } else {
      field.value = value ?? '';
    }
  }

  getSetupValue(name, fallback = '') {
    const field = this.getFormField('setup-form', name);
    if (!field) return fallback;
    if (field.type === 'checkbox') return !!field.checked;
    return field.value;
  }

  async loadSetupStatus() {
    try {
      const setupStatus = await this.api('/api/setup/status');

      if (setupStatus.managed_by_home23) {
        this.managedByHome23 = true;
        this.home23DashboardPort = setupStatus.home23_dashboard_port || '5002';
        this.renderManagedMode(setupStatus);
        return;
      }

      const [providerStatus, oauthStatus, codexOAuthStatus] = await Promise.all([
        this.api('/api/providers/status').catch(() => ({ providers: [] })),
        this.api('/api/oauth/anthropic/status').catch(() => ({ oauth: { configured: false } })),
        this.api('/api/oauth/openai-codex/status').catch(() => ({ oauth: { configured: false } }))
      ]);

      const setup = setupStatus.setup;
      this.renderProviderStatusBar(setup, providerStatus, oauthStatus, codexOAuthStatus);
      this.renderAnthropicOAuthStatus(oauthStatus);
      this.renderCodexOAuthStatus(codexOAuthStatus);

      this.setSetupValue('enableAnthropic', !!setup.providers.anthropic.enabled);
      this.setSetupValue('enableOpenAI', !!setup.providers.openai.enabled);
      this.setSetupValue('enableOpenAICodex', !!setup.providers['openai-codex']?.enabled);
      this.setSetupValue('enableXAI', !!setup.providers.xai.enabled);
      this.setSetupValue('enableOllama', !!setup.providers.ollama.enabled);
      this.setSetupValue('enableOllamaCloud', !!setup.providers['ollama-cloud']?.enabled);
      this.setSetupValue('ollamaBaseUrl', setup.providers.ollama.baseUrl || 'http://localhost:11434');

      const brainDirsTextarea = document.getElementById('brain-directories');
      if (brainDirsTextarea && setup.brainDirectories?.length) {
        brainDirsTextarea.value = setup.brainDirectories.join('\n');
      }

      this.updateProviderSectionVisibility();
    } catch (error) {
      this.showToast(`Setup status failed: ${error.message}`, 'error');
    }
  }

  renderManagedMode(setupStatus) {
    const setup = setupStatus.setup;
    const providers = setup.providers || {};
    const settingsUrl = `${window.location.protocol}//${window.location.hostname}:${this.home23DashboardPort}/home23/settings`;

    const allProviders = [
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'minimax', label: 'MiniMax' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'openai-codex', label: 'Codex' },
      { id: 'xai', label: 'xAI' },
      { id: 'ollama', label: 'Ollama' },
      { id: 'ollama-cloud', label: 'Cloud' }
    ];
    const bar = document.getElementById('setup-summary');
    if (bar) {
      bar.innerHTML = '';
      allProviders.forEach(p => {
        const isConfigured = !!providers[p.id]?.configured;
        const dot = document.createElement('span');
        dot.className = 'provider-status-dot';
        dot.dataset.state = isConfigured ? 'connected' : 'disabled';
        dot.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.label)}</span>`;
        bar.appendChild(dot);
      });
    }

    const form = document.getElementById('setup-form');
    if (!form) return;
    const providerGridHtml = allProviders.map(p => {
      const isConfigured = !!providers[p.id]?.configured;
      const state = isConfigured ? 'connected' : 'disabled';
      const stateLabel = isConfigured ? 'Connected' : 'Not configured';
      return `<div class="managed-provider-row">
        <span class="provider-status-dot" data-state="${state}">
          <span class="dot"></span>
          <span>${escapeHtml(p.label)}</span>
        </span>
        <span class="managed-provider-state ${state}">${stateLabel}</span>
      </div>`;
    }).join('');

    form.innerHTML = `
      <div class="managed-mode-banner">
        <strong>Managed by Home23</strong>
        <span>Providers are configured in <a href="${escapeHtml(settingsUrl)}" target="_top">Home23 Settings</a></span>
      </div>
      <div class="managed-provider-grid">${providerGridHtml}</div>
    `;
  }

  renderProviderStatusBar(setup, providerStatus, oauthStatus, codexOAuthStatus) {
    const bar = document.getElementById('setup-summary');
    if (!bar) return;
    bar.innerHTML = '';
    const healthMap = {};
    (providerStatus.providers || []).forEach(p => { healthMap[p.provider] = p.healthy; });

    const providers = [
      { id: 'anthropic', label: 'Anthropic', state: this.getProviderState(setup.providers.anthropic, healthMap.anthropic, oauthStatus.oauth) },
      { id: 'openai', label: 'OpenAI', state: this.getProviderState(setup.providers.openai, healthMap.openai) },
      { id: 'openai-codex', label: 'Codex', state: this.getProviderState(setup.providers['openai-codex'], healthMap['openai-codex'], codexOAuthStatus.oauth) },
      { id: 'xai', label: 'xAI', state: this.getProviderState(setup.providers.xai, healthMap.xai) },
      { id: 'ollama', label: 'Ollama', state: setup.providers.ollama.enabled ? (healthMap.ollama ? 'connected' : 'partial') : 'disabled' },
      { id: 'ollama-cloud', label: 'Cloud', state: this.getProviderState(setup.providers['ollama-cloud'], healthMap['ollama-cloud']) }
    ];

    providers.forEach(p => {
      const dot = document.createElement('span');
      dot.className = 'provider-status-dot';
      dot.dataset.state = p.state;
      dot.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.label)}</span>`;
      bar.appendChild(dot);
    });
  }

  getProviderState(providerSetup, healthy, oauthState) {
    if (!providerSetup?.enabled) return 'disabled';
    const hasCredentials = providerSetup.configured || oauthState?.configured;
    if (!hasCredentials) return 'missing';
    if (healthy === false) return 'partial';
    return 'connected';
  }

  renderAnthropicOAuthStatus(oauthStatus) {
    const container = document.getElementById('anthropic-oauth-status');
    if (!container) return;
    const oauth = oauthStatus.oauth;
    if (!oauth?.configured) {
      container.innerHTML = '';
      return;
    }
    const isExpired = oauth.valid === false;
    const expiry = oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleDateString() : 'unknown';
    container.innerHTML = `
      <div class="oauth-status ${isExpired ? 'expired' : ''}">
        <span class="dot"></span>
        <span class="oauth-info">${isExpired ? 'Expired' : 'Connected'} via ${escapeHtml(oauth.source || 'oauth')} · expires ${escapeHtml(expiry)}</span>
        <button type="button" class="ghost-btn oauth-logout-btn" id="logout-oauth-btn">Logout</button>
      </div>
    `;
    document.getElementById('logout-oauth-btn')?.addEventListener('click', () => this.logoutOAuth());
  }

  renderCodexOAuthStatus(codexOAuthStatus) {
    const container = document.getElementById('codex-oauth-status');
    if (!container) return;
    const oauth = codexOAuthStatus.oauth;
    if (!oauth?.configured) {
      container.innerHTML = '';
      return;
    }
    const isExpired = oauth.valid === false;
    const expiry = oauth.expiresAt ? new Date(oauth.expiresAt).toLocaleDateString() : 'unknown';
    container.innerHTML = `
      <div class="oauth-status ${isExpired ? 'expired' : ''}">
        <span class="dot"></span>
        <span class="oauth-info">${isExpired ? 'Expired' : 'Connected'} · expires ${escapeHtml(expiry)}</span>
        <button type="button" class="ghost-btn oauth-logout-btn" id="logout-codex-oauth-btn">Logout</button>
      </div>
    `;
    document.getElementById('logout-codex-oauth-btn')?.addEventListener('click', () => this.logoutOpenAICodexOAuth());
  }

  updateProviderSectionVisibility() {
    document.querySelectorAll('.provider-section').forEach(section => {
      const toggle = section.querySelector('.toggle-chip input[type="checkbox"]');
      const body = section.querySelector('.provider-section-body');
      if (toggle && body) {
        body.hidden = !toggle.checked;
      }
    });
  }

  async saveSetup() {
    if (this.managedByHome23) return;
    try {
      const payload = {
        enableAnthropic: this.getSetupValue('enableAnthropic', false),
        enableOpenAI: this.getSetupValue('enableOpenAI', false),
        openaiApiKey: this.getSetupValue('openaiApiKey', ''),
        enableOpenAICodex: this.getSetupValue('enableOpenAICodex', false),
        enableXAI: this.getSetupValue('enableXAI', false),
        xaiApiKey: this.getSetupValue('xaiApiKey', ''),
        enableOllama: this.getSetupValue('enableOllama', true),
        ollamaBaseUrl: this.getSetupValue('ollamaBaseUrl', ''),
        enableOllamaCloud: this.getSetupValue('enableOllamaCloud', false),
        ollamaCloudApiKey: this.getSetupValue('ollamaCloudApiKey', ''),
        brainDirectories: (document.getElementById('brain-directories')?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
      };

      await this.api('/api/setup/bootstrap', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      this.setSetupValue('openaiApiKey', '');
      this.setSetupValue('xaiApiKey', '');
      this.setSetupValue('ollamaCloudApiKey', '');
      this.showToast('Setup saved');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Setup save failed: ${error.message}`, 'error');
    }
  }

  async importOAuthFromCLI() {
    try {
      await this.api('/api/oauth/anthropic/import-cli', { method: 'POST' });
      this.showToast('Anthropic OAuth imported from Claude CLI');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OAuth import failed: ${error.message}`, 'error');
    }
  }

  async startOAuth() {
    try {
      const result = await this.api('/api/oauth/anthropic/start');
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      this.showToast('Anthropic OAuth opened in a new tab');
    } catch (error) {
      this.showToast(`OAuth start failed: ${error.message}`, 'error');
    }
  }

  async completeOAuth() {
    try {
      const callbackUrl = this.getSetupValue('anthropicCallbackUrl', '').trim();
      if (!callbackUrl) {
        this.showToast('Paste the Anthropic callback URL first', 'error');
        return;
      }
      const encoded = encodeURIComponent(callbackUrl);
      await this.api(`/api/oauth/anthropic/callback?callbackUrl=${encoded}`);
      this.setSetupValue('anthropicCallbackUrl', '');
      this.showToast('Anthropic OAuth saved');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OAuth completion failed: ${error.message}`, 'error');
    }
  }

  async logoutOAuth() {
    try {
      await this.api('/api/oauth/anthropic/logout', { method: 'POST' });
      this.showToast('Anthropic OAuth cleared');
      await Promise.all([this.loadSetupStatus(), this.loadModels()]);
    } catch (error) {
      this.showToast(`OAuth logout failed: ${error.message}`, 'error');
    }
  }

  async startOpenAICodexOAuth() {
    try {
      this.showToast('Starting OpenAI OAuth — check your browser...');
      await this.api('/api/oauth/openai-codex/start', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth connected');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`OpenAI OAuth failed: ${error.message}`, 'error');
    }
  }

  async importOpenAICodexOAuth() {
    try {
      await this.api('/api/oauth/openai-codex/import', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth imported from evobrew');
      await Promise.all([this.loadSetupStatus(), this.loadModels(), this.loadModelCatalog()]);
    } catch (error) {
      this.showToast(`Codex import failed: ${error.message}`, 'error');
    }
  }

  async logoutOpenAICodexOAuth() {
    try {
      await this.api('/api/oauth/openai-codex/logout', { method: 'POST' });
      this.showToast('OpenAI Codex OAuth cleared');
      await Promise.all([this.loadSetupStatus(), this.loadModels()]);
    } catch (error) {
      this.showToast(`Codex logout failed: ${error.message}`, 'error');
    }
  }

  formatDate(value) {
    if (!value) return '-';
    return new Date(value).toLocaleString();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new CosmoStandaloneApp();
  window.cosmoStandaloneApp = app;
  if (typeof window.initQueryTab === 'function') {
    window.initQueryTab();
  }
  app.init().catch(error => {
    console.error(error);
  });
});
