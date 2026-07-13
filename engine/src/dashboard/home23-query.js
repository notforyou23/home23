/**
 * Home23 Query Tab — scoped to the current dashboard agent's brain.
 *
 * Ported verbatim from cosmo23/public/js/query-tab.js (the reference impl used
 * by cosmo23's Query view and evobrew's Research view) with these home23-
 * specific changes:
 *   - brain is fixed to the current dashboard agent (no picker)
 *   - catalog, run, stream, and export use Home23's durable Query facade
 *   - every model selection retains its exact provider/model pair
 *   - panel id is `panel-query` (home23 tab shell), not `query-tab-panel`
 *
 * Every deviation from the upstream file is tagged with `HOME23`.
 */

let lastQueryResult = null;
let queryHistory = [];
let _queryTabInitialized = false;

let QT_BRAIN_ID = null;
let QT_BRAIN_DISPLAY = '';
let QT_AGENT_NAME = '';
let QT_QUERY_CATALOG = null;
let QT_ACTIVE_OPERATION_ID = null;

const QT_PGS_LEVELS = Object.freeze({
  skim: 0.10,
  sample: 0.25,
  deep: 0.50,
  full: 1,
});
const QT_PGS_MODES = new Set(['fresh', 'continue', 'targeted']);
const QT_OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const QT_PARTITION_ID_PATTERN = /^(?:c|h)-[A-Za-z0-9._-]{1,253}$/;
const QT_MAX_TARGET_PARTITIONS = 256;

// HOME23 — stubs for the cosmo23-style picker API. The rest of this file was
// written against them, so keeping the signatures means fewer call-site edits.
function getBrainSelector() { return null; }
function getSelectedBrainId() { return QT_BRAIN_ID || ''; }
function requireSelectedBrainId() {
  if (!QT_BRAIN_ID) throw new Error('Current agent brain not loaded yet');
  return QT_BRAIN_ID;
}
function exactModelPair(pair, label = 'model') {
  if (!pair || typeof pair.provider !== 'string' || !pair.provider.trim()
      || typeof pair.model !== 'string' || !pair.model.trim()) {
    throw new Error(`Select an exact provider and ${label}`);
  }
  return { provider: pair.provider.trim(), model: pair.model.trim() };
}

function encodeModelPair(pair) {
  const exact = exactModelPair(pair);
  return `${encodeURIComponent(exact.provider)}::${encodeURIComponent(exact.model)}`;
}

function decodeModelPair(value) {
  if (typeof value !== 'string') throw new Error('Select an exact provider and model');
  const splitAt = value.indexOf('::');
  if (splitAt < 1) throw new Error('Select an exact provider and model');
  return exactModelPair({
    provider: decodeURIComponent(value.slice(0, splitAt)),
    model: decodeURIComponent(value.slice(splitAt + 2)),
  });
}

function selectedModelPair(select, label = 'model') {
  if (!select) throw new Error(`Select an exact provider and ${label}`);
  return exactModelPair(decodeModelPair(select.value), label);
}

function selectExactModelPair(select, pair) {
  if (!select || !pair?.provider || !pair?.model) return false;
  const value = encodeModelPair(pair);
  const option = Array.from(select.options || []).find((candidate) => candidate.value === value);
  if (!option) return false;
  select.value = value;
  return true;
}

function queryModelConfigurationError(label, pair) {
  const requested = pair?.provider && pair?.model
    ? `${pair.provider}/${pair.model}`
    : 'an incomplete provider/model pair';
  const error = new Error(`Query configuration error: ${label} requires ${requested}, but that exact pair is unavailable`);
  error.code = 'query_model_configuration_invalid';
  return error;
}

function queryFacadeEndpoint(catalog, kind, agent) {
  const endpoint = catalog?.endpoints?.[kind];
  if (typeof endpoint !== 'string' || !endpoint) {
    throw new Error(`Query ${kind} endpoint is unavailable`);
  }
  if (!agent) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}agent=${encodeURIComponent(agent)}`;
}

function requireOperationId(value, label = 'operation') {
  if (typeof value !== 'string' || !QT_OPERATION_ID_PATTERN.test(value)) {
    throw new Error(`Select a valid prior PGS ${label}`);
  }
  return value;
}

function parseTargetPartitionIds(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,]+/);
  const targets = [];
  const seen = new Set();
  for (const entry of raw) {
    const partitionId = String(entry || '').trim();
    if (!partitionId || seen.has(partitionId)) continue;
    if (!QT_PARTITION_ID_PATTERN.test(partitionId)) {
      throw new Error(`Invalid target partition ID: ${partitionId}`);
    }
    seen.add(partitionId);
    targets.push(partitionId);
  }
  if (!targets.length) throw new Error('Targeted PGS requires at least one partition ID');
  if (targets.length > QT_MAX_TARGET_PARTITIONS) {
    throw new Error(`Targeted PGS supports at most ${QT_MAX_TARGET_PARTITIONS} partition IDs`);
  }
  return targets;
}

function buildPgsPartitionsRequest({ agent, brainId }) {
  if (typeof agent !== 'string' || !agent.trim()) throw new Error('Current agent is unavailable');
  if (typeof brainId !== 'string' || !brainId.trim()) throw new Error('Current brain is unavailable');
  return { agent: agent.trim(), brainId: brainId.trim() };
}

function buildFacadeQueryRequest(input) {
  const request = {
    agent: input.agent,
    brainId: input.brainId,
    query: input.query,
    enablePGS: input.enablePGS === true,
  };
  if (input.enablePGS === true) {
    if (Object.hasOwn(input, 'mode')) {
      throw new Error('Direct Query mode is not accepted for PGS');
    }
    if (Object.hasOwn(input, 'priorContext')) {
      throw new Error('Prior query context is available only for Direct Query');
    }
    if (!QT_PGS_MODES.has(input.pgsMode)) {
      throw new Error('PGS mode must be fresh, continue, or targeted');
    }
    if (!Object.hasOwn(QT_PGS_LEVELS, input.pgsLevel)) {
      throw new Error('PGS level must be skim, sample, deep, or full');
    }
    if (Object.hasOwn(input, 'pgsConfig')) {
      throw new Error('PGS uses named levels; raw PGS configuration is not accepted');
    }
    request.pgsMode = input.pgsMode;
    request.pgsLevel = input.pgsLevel;
    const hasContinuation = input.continueFromOperationId !== undefined
      && input.continueFromOperationId !== null
      && input.continueFromOperationId !== '';
    const hasTargets = input.targetPartitionIds !== undefined
      && input.targetPartitionIds !== null;
    if (input.pgsMode === 'fresh') {
      if (hasContinuation || hasTargets) {
        throw new Error('Fresh PGS cannot include a prior operation or target partitions');
      }
    } else if (input.pgsMode === 'continue') {
      if (!hasContinuation || hasTargets) {
        throw new Error('Continue PGS requires one prior operation and no target partitions');
      }
      request.continueFromOperationId = requireOperationId(input.continueFromOperationId);
    } else {
      if (!hasTargets) throw new Error('Targeted PGS requires target partition IDs');
      request.targetPartitionIds = parseTargetPartitionIds(input.targetPartitionIds);
      if (hasContinuation) {
        request.continueFromOperationId = requireOperationId(input.continueFromOperationId);
      }
    }
    request.pgsSweep = exactModelPair(input.pgsSweep, 'PGS sweep model');
    request.pgsSynth = exactModelPair(input.pgsSynth, 'PGS synthesis model');
  } else {
    request.mode = input.mode;
    request.modelSelection = exactModelPair(input.modelSelection);
    for (const field of [
      'enableSynthesis', 'includeOutputs', 'includeThoughts',
      'includeCoordinatorInsights', 'allowActions',
    ]) {
      if (input[field] !== undefined) request[field] = input[field];
    }
  }
  if (input.enablePGS !== true && input.priorContext !== undefined) {
    request.priorContext = input.priorContext;
  }
  return request;
}

function isDetachedFacadePayload(payload) {
  return payload?.detached === true
    && payload?.attachmentState === 'detached'
    && typeof payload?.operationId === 'string';
}

function queryResultFromFacadePayload(payload, fallbackQuery = '') {
  const result = payload?.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Query facade returned no durable result');
  }
  const normalized = {
    ...result,
    query: result.query || payload.query || fallbackQuery,
    answer: result.answer ?? payload.answer ?? null,
    operationId: payload.operationId || null,
    resultHandle: payload.resultHandle || null,
    operationState: payload.state || null,
    attachmentState: payload.attachmentState || null,
    sourceEvidence: payload.sourceEvidence || null,
  };
  const session = pgsSessionIdentity(normalized);
  return { ...normalized, ...session };
}

function pgsMetadata(result) {
  return result?.metadata?.pgs || result?.pgs || null;
}

function pgsSessionIdentity(result) {
  const pgs = pgsMetadata(result) || {};
  return {
    pgsSessionId: pgs.sessionId || null,
    sourceOperationId: pgs.sourceOperationId || null,
    continuableUntil: pgs.continuableUntil || null,
    canContinue: typeof pgs.canContinue === 'boolean' ? pgs.canContinue : null,
  };
}

function historyItemForQueryResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Query history item is invalid');
  }
  return { ...result, ...pgsSessionIdentity(result) };
}

function brainOperationEndpoint(operationId, action = '') {
  const id = requireOperationId(operationId);
  const base = `/home23/api/brain-operations/${encodeURIComponent(id)}`;
  return action ? `${base}/${encodeURIComponent(action)}` : base;
}

function nextPGSLevel(level) {
  const levels = ['skim', 'sample', 'deep', 'full'];
  const index = levels.indexOf(level);
  if (index < 0) return 'sample';
  return levels[Math.min(index + 1, levels.length - 1)];
}

function isPGSContinuable(result, now = Date.now()) {
  const pgs = pgsMetadata(result) || {};
  const identity = pgsSessionIdentity(result);
  if (pgs.canContinue !== true) return false;
  if (identity.continuableUntil) {
    const expires = Date.parse(identity.continuableUntil);
    if (!Number.isFinite(expires) || expires <= now) return false;
  }
  return true;
}

function escapeHtmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function countOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function buildPGSCoverageHTML(pgs, result = {}) {
  if (!pgs || typeof pgs !== 'object') return '';
  const level = Object.hasOwn(QT_PGS_LEVELS, pgs.coverageLevel)
    ? pgs.coverageLevel
    : null;
  const fraction = Number.isFinite(pgs.coverageFraction)
    ? pgs.coverageFraction
    : (level ? QT_PGS_LEVELS[level] : null);
  const levelName = level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Requested';
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const scopeSuccessful = countOrNull(pgs.scopeSuccessfulWorkUnits);
  const scopePending = countOrNull(pgs.scopePendingWorkUnits);
  const scopeTotal = countOrNull(pgs.scopeWorkUnits)
    ?? (scopeSuccessful !== null && scopePending !== null ? scopeSuccessful + scopePending : null);
  const globalCovered = countOrNull(pgs.globalCoveredWorkUnits);
  const globalPending = countOrNull(pgs.globalPendingWorkUnits);
  const globalTotal = countOrNull(pgs.globalWorkUnits)
    ?? (globalCovered !== null && globalPending !== null ? globalCovered + globalPending : null);
  const reused = countOrNull(pgs.reusedWorkUnits);
  const newlySwept = countOrNull(pgs.newWorkUnits);
  const identity = pgsSessionIdentity({ ...result, metadata: { pgs } });
  const lines = [];
  lines.push(`<span>Coverage level: ${escapeHtmlText(levelName)}${percent === null ? '' : ` (${percent}%)`}</span>`);
  lines.push(`<span>Requested scope: ${scopeSuccessful ?? '?'}${scopeTotal === null ? '' : `/${scopeTotal}`} complete; ${scopePending ?? '?'} pending${pgs.scopeComplete === true ? ' · scope complete' : ''}</span>`);
  lines.push(`<span>Global coverage: ${globalCovered ?? '?'}${globalTotal === null ? '' : `/${globalTotal}`}; ${globalPending ?? '?'} pending</span>`);
  lines.push(`<span>${pgs.fullCoverage === true ? 'Full graph coverage: complete' : 'Full graph coverage: not yet complete'}</span>`);
  lines.push(`<span>This operation: ${reused ?? '?'} reused; ${newlySwept ?? '?'} new</span>`);
  if (Array.isArray(pgs.targetPartitionIds) && pgs.targetPartitionIds.length) {
    lines.push(`<span>Target partitions: ${pgs.targetPartitionIds.map(escapeHtmlText).join(', ')}</span>`);
  }
  if (result.operationId) lines.push(`<span>Operation: <code>${escapeHtmlText(result.operationId)}</code></span>`);
  if (identity.pgsSessionId) lines.push(`<span>Session: <code>${escapeHtmlText(identity.pgsSessionId)}</code></span>`);
  if (identity.continuableUntil) {
    lines.push(`<span>Continuable until: ${escapeHtmlText(identity.continuableUntil)}</span>`);
  }
  return `<div class="qt-pgs-coverage">${lines.join('')}</div>`;
}

function buildFacadeExportRequest(result, format, agent) {
  if (result?.operationId) {
    return {
      agent,
      operationId: result.operationId,
      ...(result.resultHandle ? { resultHandle: result.resultHandle } : {}),
      format,
    };
  }
  return {
    agent,
    query: result?.query || '',
    answer: result?.answer || '',
    format,
    metadata: result?.metadata || {},
  };
}

function facadeErrorMessage(payload, fallback = 'Query failed') {
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message || payload?.message || fallback;
}

/* ═══════════════════════════════════════════════════════
   Init — builds HTML, injects CSS, binds events
   ═══════════════════════════════════════════════════════ */

function initQueryTab() {
  // HOME23 — panel id is `panel-query` in the home23 shell.
  const panel = document.getElementById('panel-query');
  if (!panel || _queryTabInitialized) return;
  _queryTabInitialized = true;

  // Inject styles
  if (!document.getElementById('query-tab-styles')) {
    const style = document.createElement('style');
    style.id = 'query-tab-styles';
    style.textContent = getQueryTabStyles();
    document.head.appendChild(style);
  }

  panel.innerHTML = `
    <div class="qt-container">
      <!-- HOME23 — fixed-brain header -->
      <div class="qt-header">
        <span class="qt-header-label">Querying <strong id="qt-brain-label">current agent</strong> brain</span>
      </div>

      <!-- Query Input Section -->
      <div class="qt-input-section">
        <textarea id="qt-input" class="qt-textarea" placeholder="Ask a question about this brain's knowledge..."></textarea>

        <div class="qt-actions-compact">
          <button id="qt-submit" class="qt-btn qt-btn-primary">Execute Query</button>
          <button id="qt-clear" class="qt-btn qt-btn-outline qt-btn-sm">Clear</button>
          <button id="qt-followup" class="qt-btn qt-btn-outline qt-btn-sm" disabled>Follow-up</button>
          <span id="qt-context-indicator" class="qt-context-indicator qt-hidden">
            <span class="qt-context-dot"></span>
            <span>Using context</span>
          </span>
        </div>
      </div>

      <!-- Collapsible Options -->
      <details class="qt-options-section">
        <summary class="qt-options-toggle">
          <span class="qt-toggle-icon">▶</span>
          <span>Query Options</span>
          <span class="qt-options-summary" id="qt-options-summary">Full mode · Loading models...</span>
        </summary>
        <div class="qt-options-content">

          <!-- Quick Prompts -->
          <div class="qt-quick-prompts">
            <div class="qt-quick-label">Quick Prompts:</div>
            <div class="qt-quick-grid">
              <button class="qt-quick-btn" data-prompt="summarize the main findings from this research">📋 Summary</button>
              <button class="qt-quick-btn" data-prompt="we are looking for novelty. concepts that aren't out in the mainstream that we can test and build on">🔬 Novel Concepts</button>
              <button class="qt-quick-btn" data-prompt="what insights are most actionable - things we can test and build on?">⚡ Actionable</button>
              <button class="qt-quick-btn" data-prompt="what are the strategic recommendations from the latest coordinator review?">🎯 Strategic</button>
              <button class="qt-quick-btn" data-prompt="what did the synthesis agents discover?">🔗 Synthesis</button>
              <button class="qt-quick-btn" data-prompt="identify the top 3-5 ideas with the strongest competitive moat or defensibility">🛡️ Defensible</button>
              <button class="qt-quick-btn" data-prompt="which findings have immediate monetization potential with existing customers?">💵 Quick Wins</button>
              <button class="qt-quick-btn" data-prompt="we are looking for valuable opportunities that are within reach and not too novel. find those with TAM, SAM, and typical budget size">💰 Market Fit</button>
            </div>
          </div>

          <!-- Options Grid -->
          <div class="qt-options-grid">
            <div class="qt-option-group">
              <label>Model:</label>
              <select id="qt-model" class="qt-select"></select>
            </div>
            <div class="qt-option-group">
              <label>Depth:</label>
              <select id="qt-mode" class="qt-select">
                <option value="quick">Quick (Fast answers)</option>
                <option value="full" selected>Full (Comprehensive)</option>
                <option value="expert">Expert (Maximum depth)</option>
                <option value="dive">🏊 Dive (Exploratory synthesis)</option>
              </select>
            </div>
            <div class="qt-option-group">
              <label class="qt-checkbox-label">
                <input type="checkbox" id="qt-stream" checked>
                <span>Show live progress</span>
              </label>
            </div>
          </div>

          <!-- Mode Hint -->
          <div id="qt-mode-hint" class="qt-mode-hint">Comprehensive analysis with full brain access</div>

          <!-- Enhancement Toggles -->
          <div class="qt-enhancements">
            <label class="qt-toggle-label"><input type="checkbox" id="qt-synthesis" checked> Synthesis</label>
            <label class="qt-toggle-label"><input type="checkbox" id="qt-coordinator" checked> Coordinator Insights</label>
          </div>

          <!-- Context Options -->
          <div class="qt-context-options">
            <label class="qt-toggle-label"><input type="checkbox" id="qt-outputs" checked> Include Output Files</label>
            <label class="qt-toggle-label"><input type="checkbox" id="qt-thoughts" checked> Include Thoughts</label>
            <label class="qt-toggle-label" title="Allow query to create files, read full contents, and take actions">
              <input type="checkbox" id="qt-allow-actions"> Allow Actions
            </label>
            <label class="qt-toggle-label qt-pgs-label" title="Partitioned Graph Synthesis: durable cumulative or targeted coverage with reusable sweeps; large runs may take hours">
              <input type="checkbox" id="qt-pgs"> 🧬 PGS
            </label>
          </div>

          <div id="qt-pgs-controls" class="qt-pgs-controls qt-hidden">
            <div class="qt-option-group">
              <label>Coverage Level:</label>
              <div class="qt-pgs-depth-chips">
                <button type="button" class="qt-depth-chip" data-level="skim">Skim (10%)</button>
                <button type="button" class="qt-depth-chip qt-depth-active" data-level="sample">Sample (25%)</button>
                <button type="button" class="qt-depth-chip" data-level="deep">Deep (50%)</button>
                <button type="button" class="qt-depth-chip" data-level="full">Full (100%)</button>
              </div>
              <input type="hidden" id="qt-pgs-level" value="sample" />
            </div>
            <div class="qt-pgs-model-row">
              <div class="qt-option-group">
                <label>Sweep Model:</label>
                <select id="qt-pgs-sweep-model" class="qt-select" title="Model for partition sweeps (runs many times, cheaper is better)"></select>
              </div>
              <div class="qt-option-group">
                <label>Synthesis Model:</label>
                <select id="qt-pgs-synth-model" class="qt-select" title="Model for final synthesis (runs once, quality matters)"></select>
              </div>
            </div>
            <div class="qt-option-group">
              <label>Session Mode:</label>
              <select id="qt-pgs-mode" class="qt-select">
                <option value="fresh" selected>Start fresh session</option>
                <option value="continue">Continue prior session</option>
                <option value="targeted">Target partitions</option>
              </select>
            </div>
            <div id="qt-pgs-continuation-group" class="qt-option-group qt-hidden">
              <label>Prior PGS Operation:</label>
              <select id="qt-pgs-continue-operation" class="qt-select">
                <option value="">Select a continuable PGS result</option>
              </select>
              <div class="qt-option-help">Continue reuses compatible successful sweeps. A mismatch is shown as an error and never starts over silently.</div>
            </div>
            <div id="qt-pgs-target-group" class="qt-option-group qt-hidden">
              <label>Target Partition IDs:</label>
              <textarea id="qt-pgs-targets" class="qt-input-inline" rows="3" placeholder="Load canonical partitions, then keep the ones you want"></textarea>
              <button type="button" id="qt-pgs-load-partitions" class="qt-btn qt-btn-outline qt-btn-sm">Load canonical partitions</button>
              <div id="qt-pgs-partitions-status" class="qt-option-help">Target IDs must come from the current pinned brain source. The selected level still applies within these targets.</div>
            </div>
          </div>
        </div>
      </details>

      <!-- Response Section -->
      <div class="qt-response-section">
        <!-- Loading -->
        <div id="qt-loading" class="qt-loading qt-hidden">
          <div class="qt-spinner"></div>
          <div id="qt-loading-msg">Searching knowledge graph and synthesizing answer...</div>
          <div class="qt-loading-hint" id="qt-loading-hint">This may take 10-30 seconds</div>
        </div>

        <!-- Results — always visible -->
        <div id="qt-result" class="qt-result">
          <div class="qt-result-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <path d="M12 17h.01"/>
            </svg>
            <p>Ask a question above to query this brain's knowledge</p>
            <p class="qt-hint">Responses will appear here with full context and citations</p>
          </div>
        </div>

        <!-- History -->
        <details id="qt-history" class="qt-history-section qt-hidden">
          <summary class="qt-history-toggle">
            <span>Query History</span>
            <button class="qt-btn-text" id="qt-clear-history">Clear</button>
          </summary>
          <div id="qt-history-list" class="qt-history-list"></div>
        </details>
      </div>
    </div>
  `;

  // Bind events
  bindQueryTabEvents();
  // HOME23 — load the durable facade catalog for this dashboard agent.
  resolveCurrentAgentBrainThenLoad().catch(err => {
    console.error('[home23-query] Failed to resolve current agent brain:', err);
    const ph = document.querySelector('.qt-result-placeholder p');
    if (ph) ph.textContent = `Could not load current agent brain: ${err.message}`;
  });
}

// HOME23 — resolve the dashboard agent, then let the Home23 Query facade supply
// its canonical resident brain and exact provider/model catalog.
async function resolveCurrentAgentBrainThenLoad() {
  // Prefer explicit URL override, then the dashboard's own agent, then primary.
  let dashboardAgent = '';
  const urlAgent = new URLSearchParams(window.location.search).get('agent');
  try {
    const brainRes = await fetch('/home23/api/brain/current');
    if (brainRes.ok) {
      const currentBrainMeta = await brainRes.json();
      if (currentBrainMeta?.agent) {
        dashboardAgent = String(currentBrainMeta.agent).trim();
      }
    }
  } catch { /* fall through */ }
  try {
    const agRes = await fetch('/home23/api/settings/agents');
    if (agRes.ok) {
      const payload = await agRes.json();
      const list = Array.isArray(payload) ? payload : (payload.agents || []);
      if (urlAgent && list.some(agent => agent.name === urlAgent)) {
        dashboardAgent = urlAgent;
      } else {
        dashboardAgent = (payload.currentAgent || '').trim()
          || (payload.primaryAgent || '').trim()
          || (list[0]?.name || list[0]?.agentName || '').trim();
      }
    }
  } catch { /* fall through */ }
  if (!dashboardAgent) {
    try {
      const statusRes = await fetch('/home23/api/settings/status');
      if (statusRes.ok) {
        const s = await statusRes.json();
        dashboardAgent = (urlAgent || s.currentAgent || s.primaryAgent || '').trim();
      }
    } catch { /* try fallback */ }
  }
  if (!dashboardAgent) throw new Error('No agents configured in home23');
  QT_AGENT_NAME = dashboardAgent;

  const catalogRes = await fetch(`/home23/api/query/catalog?agent=${encodeURIComponent(dashboardAgent)}`);
  const catalog = await catalogRes.json();
  if (!catalogRes.ok) throw new Error(facadeErrorMessage(catalog, `Query catalog HTTP ${catalogRes.status}`));
  if (!catalog.available) throw new Error(catalog.reason || 'Query is unavailable');
  if (!catalog.selectedBrain?.id) throw new Error('Current agent canonical brain is unavailable');
  QT_QUERY_CATALOG = catalog;
  QT_BRAIN_ID = catalog.selectedBrain.id;
  QT_BRAIN_DISPLAY = catalog.selectedBrain.displayName || dashboardAgent;

  populateQueryModels(catalog);
  const qDefaults = catalog.defaults || {};
  if (qDefaults.mode) {
    const s = document.getElementById('qt-mode');
    if (s) s.value = qDefaults.mode;
  }
  if (qDefaults.enablePGSByDefault) {
    const chk = document.getElementById('qt-pgs');
    if (chk) {
      chk.checked = true;
      document.getElementById('qt-pgs-controls')?.classList.remove('qt-hidden');
    }
  }
  if (typeof qDefaults.pgsDepth === 'number') {
    const level = ({ 0.1: 'skim', 0.25: 'sample', 0.5: 'deep', 1: 'full' })[qDefaults.pgsDepth] || 'sample';
    const hidden = document.getElementById('qt-pgs-level');
    if (hidden) hidden.value = level;
    document.querySelectorAll('.qt-depth-chip').forEach((chip) => {
      chip.classList.toggle('qt-depth-active', chip.dataset.level === level);
    });
  }
  updatePGSModeControls();
  updateQueryOptionsSummary();

  // Header label (if present) + placeholder text.
  const label = document.getElementById('qt-brain-label');
  if (label) label.textContent = dashboardAgent;

  loadQueryHistory();
  checkBrainStatus();
}

function populateQueryModels(catalog) {
  const models = (catalog?.models || []).filter((model) => model?.id && model?.provider);
  if (!models.length) throw new Error('No exact Query provider/model pairs are available');
  const defaults = catalog.defaults || {};
  const fill = (select, selectedPair, label) => {
    if (!select) return;
    const byProvider = new Map();
    for (const model of models) {
      if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
      byProvider.get(model.provider).push(model);
    }
    select.innerHTML = '';
    for (const [provider, providerModels] of byProvider) {
      const group = document.createElement('optgroup');
      group.label = providerModels[0].providerLabel || provider;
      for (const model of providerModels) {
        const option = document.createElement('option');
        option.value = encodeModelPair({ provider, model: model.id });
        option.textContent = model.name || model.id;
        option.dataset.provider = provider;
        option.dataset.model = model.id;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    if (!selectExactModelPair(select, selectedPair)) {
      throw queryModelConfigurationError(label, selectedPair);
    }
  };

  fill(document.getElementById('qt-model'), {
    provider: defaults.provider,
    model: defaults.model,
  }, 'Direct Query model');
  fill(document.getElementById('qt-pgs-sweep-model'), {
    provider: defaults.pgsSweepProvider,
    model: defaults.pgsSweepModel,
  }, 'PGS sweep model');
  fill(document.getElementById('qt-pgs-synth-model'), {
    provider: defaults.pgsSynthProvider,
    model: defaults.pgsSynthModel,
  }, 'PGS synthesis model');
}

/* ═══════════════════════════════════════════════════════
   Event Binding
   ═══════════════════════════════════════════════════════ */

function bindQueryTabEvents() {
  const submitBtn = document.getElementById('qt-submit');
  const clearBtn = document.getElementById('qt-clear');
  const followupBtn = document.getElementById('qt-followup');
  const input = document.getElementById('qt-input');
  const modeSelect = document.getElementById('qt-mode');
  const modelSelect = document.getElementById('qt-model');
  const clearHistoryBtn = document.getElementById('qt-clear-history');
  // HOME23 — no brain picker; current dashboard agent is resolved once at init.

  submitBtn?.addEventListener('click', () => executeQuery());

  clearBtn?.addEventListener('click', () => clearQuery());

  followupBtn?.addEventListener('click', () => {
    if (!lastQueryResult) return;
    const inp = document.getElementById('qt-input');
    if (inp) {
      inp.value = '';
      inp.placeholder = `Follow-up on: "${(lastQueryResult.query || '').slice(0, 60)}..."`;
      inp.focus();
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      executeQuery();
    }
  });

  // Update options summary
  const updateSummary = updateQueryOptionsSummary;
  modeSelect?.addEventListener('change', updateSummary);
  modelSelect?.addEventListener('change', () => {
    // Sync PGS synthesis model with main model unless user has diverged
    const synthSelect = document.getElementById('qt-pgs-synth-model');
    if (synthSelect && !synthSelect.dataset.userChanged) {
      synthSelect.value = modelSelect.value;
    }
    updateSummary();
  });
  document.getElementById('qt-pgs-synth-model')?.addEventListener('change', (e) => {
    e.target.dataset.userChanged = '1';
  });
  document.getElementById('qt-pgs-mode')?.addEventListener('change', () => {
    updatePGSModeControls();
    updateSummary();
  });
  document.getElementById('qt-pgs-load-partitions')?.addEventListener('click', () => {
    loadPgsPartitionInventory();
  });

  const pgsToggle = document.getElementById('qt-pgs');
  pgsToggle?.addEventListener('change', () => {
    const controls = document.getElementById('qt-pgs-controls');
    if (controls) controls.classList.toggle('qt-hidden', !pgsToggle.checked);
    updateSummary();
  });

  // PGS named cumulative coverage selection.
  document.querySelectorAll('.qt-depth-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.qt-depth-chip').forEach(c => c.classList.remove('qt-depth-active'));
      chip.classList.add('qt-depth-active');
      document.getElementById('qt-pgs-level').value = chip.dataset.level;
      updateSummary();
    });
  });

  // Mode hints
  const modeHints = {
    quick: 'Fast extraction — brief answers',
    full: 'Comprehensive analysis with full brain access',
    expert: 'Maximum depth — thorough multi-pass analysis',
    dive: 'Exploratory synthesis — creative cross-domain connections'
  };
  modeSelect?.addEventListener('change', () => {
    const hint = document.getElementById('qt-mode-hint');
    if (hint) hint.textContent = modeHints[modeSelect.value] || '';
  });

  // Quick prompts
  document.querySelectorAll('.qt-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('qt-input');
      if (inp) { inp.value = btn.dataset.prompt; inp.focus(); }
    });
  });

  // Clear history
  clearHistoryBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    queryHistory = [];
    saveQueryHistory();
    updateQueryHistoryUI();
  });

  // Details toggle icon
  document.querySelector('.qt-options-section')?.addEventListener('toggle', function() {
    const icon = this.querySelector('.qt-toggle-icon');
    if (icon) icon.textContent = this.open ? '▼' : '▶';
  });

  // HOME23 — no brain picker to wire; brain is fixed once per page load.
}

function updatePGSModeControls() {
  const mode = document.getElementById('qt-pgs-mode')?.value || 'fresh';
  document.getElementById('qt-pgs-continuation-group')?.classList.toggle(
    'qt-hidden', mode === 'fresh',
  );
  document.getElementById('qt-pgs-target-group')?.classList.toggle(
    'qt-hidden', mode !== 'targeted',
  );
}

async function loadPgsPartitionInventory() {
  const button = document.getElementById('qt-pgs-load-partitions');
  const status = document.getElementById('qt-pgs-partitions-status');
  const targetInput = document.getElementById('qt-pgs-targets');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Reading canonical partitions from the pinned brain source…';
  try {
    const endpoint = queryFacadeEndpoint(QT_QUERY_CATALOG, 'pgsPartitions', QT_AGENT_NAME);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPgsPartitionsRequest({
        agent: QT_AGENT_NAME,
        brainId: requireSelectedBrainId(),
      })),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.partitions)) {
      throw new Error(payload?.error?.message || payload?.error?.code || 'Partition inventory failed');
    }
    const ids = parseTargetPartitionIds(payload.partitions.map((row) => row.partitionId));
    if (targetInput) targetInput.value = ids.join('\n');
    if (status) {
      status.textContent = `${ids.length} canonical partitions · ${payload.totalNodes ?? '?'} nodes · ${payload.estimatedWorkUnits ?? '?'} estimated work units. Remove any partitions you do not want.`;
    }
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (button) button.disabled = false;
  }
}

function queryOptionsSummaryText({
  enablePGS,
  directMode = 'full',
  directModel = 'model unavailable',
  pgsLevel = 'sample',
  pgsMode = 'fresh',
  pgsSweep = 'sweep model unavailable',
  pgsSynth = 'synthesis model unavailable',
}) {
  if (enablePGS) {
    const levelName = pgsLevel.charAt(0).toUpperCase() + pgsLevel.slice(1);
    const percent = Math.round((QT_PGS_LEVELS[pgsLevel] || QT_PGS_LEVELS.sample) * 100);
    return `PGS ${levelName} (${percent}%) · ${pgsMode} · ${pgsSweep} → ${pgsSynth}`;
  }
  const modeName = directMode.charAt(0).toUpperCase() + directMode.slice(1);
  return `${modeName} mode · ${directModel}`;
}

function updateQueryOptionsSummary() {
  const summary = document.getElementById('qt-options-summary');
  if (!summary) return;
  const modeSelect = document.getElementById('qt-mode');
  const modelSelect = document.getElementById('qt-model');
  const mode = modeSelect?.value || 'full';
  const model = modelSelect?.selectedOptions?.[0]?.textContent || modelSelect?.value || 'model unavailable';
  const pgsOn = document.getElementById('qt-pgs')?.checked;
  const pgsLevel = document.getElementById('qt-pgs-level')?.value || 'sample';
  const pgsMode = document.getElementById('qt-pgs-mode')?.value || 'fresh';
  const sweepSelect = document.getElementById('qt-pgs-sweep-model');
  const synthSelect = document.getElementById('qt-pgs-synth-model');
  summary.textContent = queryOptionsSummaryText({
    enablePGS: pgsOn,
    directMode: mode,
    directModel: model,
    pgsLevel,
    pgsMode,
    pgsSweep: sweepSelect?.selectedOptions?.[0]?.textContent || sweepSelect?.value,
    pgsSynth: synthSelect?.selectedOptions?.[0]?.textContent || synthSelect?.value,
  });
}

/* ═══════════════════════════════════════════════════════
   Model Population
   ═══════════════════════════════════════════════════════ */

// Model population removed — handled by app.js renderModelOptions() (single source of truth).
// All model selects (qt-model, qt-pgs-sweep-model, qt-pgs-synth-model) are populated
// from the same data as launch/continue/catalog selects.

/* ═══════════════════════════════════════════════════════
   Brain Status Check
   ═══════════════════════════════════════════════════════ */

async function checkBrainStatus() {
  const ph = document.querySelector('.qt-result-placeholder p');
  if (!ph) return;
  if (!getSelectedBrainId()) {
    ph.textContent = 'Resolving current agent brain...';
    return;
  }
  // HOME23 — brain is fixed to the current dashboard agent; no picker.
  ph.textContent = `Ask a question to query ${QT_AGENT_NAME || 'the current agent'}'s brain`;
}

/* ═══════════════════════════════════════════════════════
   Execute Query — dispatch to streaming or non-streaming
   ═══════════════════════════════════════════════════════ */

async function executeQuery() {
  const input = document.getElementById('qt-input');
  const query = input?.value?.trim();
  if (!query) return;

  const enablePGS = document.getElementById('qt-pgs')?.checked || false;
  const mode = document.getElementById('qt-mode')?.value || 'full';
  const pgsMode = document.getElementById('qt-pgs-mode')?.value || 'fresh';
  const pgsLevel = document.getElementById('qt-pgs-level')?.value || 'sample';
  const continuationOperationId = document.getElementById('qt-pgs-continue-operation')?.value || '';
  const targetPartitionText = document.getElementById('qt-pgs-targets')?.value || '';
  const priorContext = lastQueryResult?.query && typeof lastQueryResult?.answer === 'string'
    ? { query: lastQueryResult.query, answer: lastQueryResult.answer }
    : undefined;
  let request;
  try {
    request = buildFacadeQueryRequest({
      agent: QT_AGENT_NAME,
      brainId: requireSelectedBrainId(),
      query,
      enablePGS,
      ...(enablePGS ? {
        pgsMode,
        pgsLevel,
        ...(pgsMode === 'continue' ? {
          continueFromOperationId: continuationOperationId,
        } : {}),
        ...(pgsMode === 'targeted' ? {
          targetPartitionIds: targetPartitionText,
          ...(continuationOperationId ? { continueFromOperationId: continuationOperationId } : {}),
        } : {}),
        pgsSweep: selectedModelPair(document.getElementById('qt-pgs-sweep-model'), 'PGS sweep model'),
        pgsSynth: selectedModelPair(document.getElementById('qt-pgs-synth-model'), 'PGS synthesis model'),
      } : {
        mode,
        modelSelection: selectedModelPair(document.getElementById('qt-model')),
        enableSynthesis: document.getElementById('qt-synthesis')?.checked ?? true,
        includeCoordinatorInsights: document.getElementById('qt-coordinator')?.checked ?? true,
        includeOutputs: document.getElementById('qt-outputs')?.checked ?? true,
        includeThoughts: document.getElementById('qt-thoughts')?.checked ?? true,
        allowActions: document.getElementById('qt-allow-actions')?.checked || false,
        ...(priorContext !== undefined ? { priorContext } : {}),
      }),
    });
  } catch (error) {
    showQueryToast(error.message);
    return;
  }

  const useStreaming = document.getElementById('qt-stream')?.checked ?? true;

  const submitBtn = document.getElementById('qt-submit');
  const loadingDiv = document.getElementById('qt-loading');
  const resultDiv = document.getElementById('qt-result');

  submitBtn.disabled = true;
  loadingDiv.classList.remove('qt-hidden');

  // Update loading hint for PGS
  const levelLabel = pgsLevel.charAt(0).toUpperCase() + pgsLevel.slice(1);
  const levelPercent = Math.round((QT_PGS_LEVELS[pgsLevel] || 0.25) * 100);
  const hintEl = document.getElementById('qt-loading-hint');
  if (hintEl) {
    hintEl.textContent = enablePGS
      ? `Durable PGS ${levelLabel} (${levelPercent}% requested coverage, ${pgsMode}) — large runs may take hours; progress and results remain reattachable by operation ID`
      : 'Durable query — keep this view open for live progress; provider work may take longer than a quick response';
  }

  try {
    if (useStreaming) {
      await executeQueryStreaming(request, submitBtn, loadingDiv, resultDiv);
      return;
    }

    // Non-streaming path
    resultDiv.style.display = 'none';

    const res = await fetch(queryFacadeEndpoint(QT_QUERY_CATALOG, 'run', QT_AGENT_NAME), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'respond-async',
      },
      body: JSON.stringify(request),
    });

    const data = await res.json();
    if (isDetachedFacadePayload(data)) {
      renderDetachedQuery({ ...data, query }, resultDiv);
      return;
    }
    if (!res.ok || data.ok !== true) {
      if (data.operationId && QT_OPERATION_ID_PATTERN.test(data.operationId)) {
        saveToHistory({
          query,
          answer: null,
          metadata: {},
          operationId: data.operationId,
          resultHandle: data.resultHandle || null,
          operationState: data.state || 'failed',
          attachmentState: data.attachmentState || 'closed',
        });
      }
      throw new Error(facadeErrorMessage(data));
    }

    const result = queryResultFromFacadePayload(data, query);
    lastQueryResult = { ...result, fullResult: data };
    enableFollowUp();
    displayQueryResult(result);
    saveToHistory(result);

  } catch (error) {
    console.error('Query failed:', error);
    resultDiv.innerHTML = `<div class="qt-error">Query failed: ${escapeHtml(error.message)}</div>`;
    resultDiv.style.display = '';
  } finally {
    submitBtn.disabled = false;
    loadingDiv.classList.add('qt-hidden');
  }
}

/* ═══════════════════════════════════════════════════════
   Streaming Query — SSE with PGS progress
   ═══════════════════════════════════════════════════════ */

async function executeQueryStreaming(request, submitBtn, loadingDiv, resultDiv) {
  const isPGS = request.enablePGS || false;
  const query = request.query;
  let pgsTimerInterval = null;
  const pgsStartTime = Date.now();

  try {
    const response = await fetch(queryFacadeEndpoint(QT_QUERY_CATALOG, 'stream', QT_AGENT_NAME), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* keep HTTP fallback */ }
      throw new Error(facadeErrorMessage(payload, `HTTP ${response.status}: ${text}`));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedAnswer = '';
    let finalResult = null;
    let detachedResult = null;

    // Show result div for streaming
    resultDiv.style.display = '';

    if (isPGS) {
      resultDiv.innerHTML = buildPGSProgressHTML();
      // Start timer
      const timerEl = resultDiv.querySelector('.pgs-timer');
      pgsTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - pgsStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        if (timerEl) timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      }, 1000);
    } else {
      resultDiv.innerHTML = `
        <div class="qt-streaming-progress" style="display:none;"></div>
        <div class="qt-streaming-container"></div>
      `;
    }

    loadingDiv.classList.add('qt-hidden');

    const containerDiv = resultDiv.querySelector('.qt-streaming-container');
    const progressDiv = resultDiv.querySelector('.qt-streaming-progress');

    // PGS state
    const pgsPhases = ['partitioning', 'routing', 'sweeping', 'synthesizing'];
    let pgsCurrentPhaseIndex = -1;

    const pgsUpdatePhase = (phase) => {
      if (!resultDiv) return;
      // Mark prior phases done
      for (let i = 0; i <= pgsCurrentPhaseIndex; i++) {
        const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${pgsPhases[i]}"]`);
        if (el) { el.classList.remove('pgs-active'); el.classList.add('pgs-done'); }
      }
      const newIdx = pgsPhases.indexOf(phase);
      if (newIdx >= 0) {
        pgsCurrentPhaseIndex = newIdx;
        const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${phase}"]`);
        if (el) el.classList.add('pgs-active');
      } else if (phase === 'done') {
        for (const p of pgsPhases) {
          const el = resultDiv.querySelector(`.pgs-phase-step[data-phase="${p}"]`);
          if (el) { el.classList.remove('pgs-active'); el.classList.add('pgs-done'); }
        }
      }
    };

    const pgsSetStatus = (msg) => {
      const el = resultDiv.querySelector('.pgs-status');
      if (el) el.textContent = msg;
    };

    const pgsAddLog = (msg) => {
      const logEl = resultDiv.querySelector('.pgs-log');
      if (!logEl) return;
      const entry = document.createElement('div');
      const elapsed = Math.floor((Date.now() - pgsStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      entry.textContent = `[${mins}:${secs.toString().padStart(2, '0')}] ${msg}`;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const pgsBuildSweepTracker = (partitions) => {
      const tracker = resultDiv.querySelector('.pgs-sweep-tracker');
      if (!tracker) return;
      tracker.style.display = '';
      tracker.innerHTML = `<div class="pgs-sweep-header">Sweep Progress</div>` +
        partitions.map(p => `
          <div class="pgs-sweep-row" data-partition="${p.id}">
            <span class="pgs-sweep-status">○</span>
            <span class="pgs-sweep-name">${escapeHtml(p.summary)}</span>
            <span class="pgs-sweep-meta">${p.nodeCount} nodes</span>
          </div>
        `).join('');
    };

    const pgsUpdateSweepRow = (partitionId, status) => {
      const row = resultDiv.querySelector(`.pgs-sweep-row[data-partition="${partitionId}"]`);
      if (!row) return;
      const statusEl = row.querySelector('.pgs-sweep-status');
      if (statusEl) {
        if (status === 'active') { statusEl.textContent = '◉'; statusEl.style.color = '#a78bfa'; }
        else if (status === 'done') { statusEl.textContent = '✓'; statusEl.style.color = '#4ade80'; }
        else if (status === 'failed') { statusEl.textContent = '✗'; statusEl.style.color = '#f87171'; }
      }
      if (status === 'active') row.style.color = 'var(--text-primary)';
      else if (status === 'done') row.style.color = 'var(--text-secondary)';
    };

    // Process SSE stream
    // Server sends: event: <type>\ndata: <json>\n\n
    let currentEventType = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEventType = line.slice(7).trim();
          continue;
        }

        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            const type = currentEventType || event.type || 'progress';
            currentEventType = null; // Reset after consuming

            handleSSEEvent(type, event, {
              isPGS, containerDiv, progressDiv, resultDiv,
              pgsUpdatePhase, pgsSetStatus, pgsAddLog,
              pgsBuildSweepTracker, pgsUpdateSweepRow,
              pgsStartTime, pgsTimerInterval,
              accumulatedAnswer: () => accumulatedAnswer,
              setAccumulatedAnswer: (v) => { accumulatedAnswer = v; },
              setFinalResult: (v) => { finalResult = v; },
              setDetachedResult: (v) => { detachedResult = v; },
              query,
              clearPgsTimer: () => {
                if (pgsTimerInterval) { clearInterval(pgsTimerInterval); pgsTimerInterval = null; }
              }
            });
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) {
              // Real error from server (thrown by handleSSEEvent), not a parse error
              throw parseErr;
            }
            console.warn('[QueryTab] SSE parse error:', parseErr);
          }
        }

        // Reset event type on empty lines (event boundary)
        if (line.trim() === '') {
          currentEventType = null;
        }
      }
    }

    if (detachedResult) {
      renderDetachedQuery({ ...detachedResult, query }, resultDiv);
    } else if (finalResult) {
      lastQueryResult = { ...finalResult, fullResult: finalResult };
      enableFollowUp();

      // Smooth transition
      resultDiv.style.opacity = '0.5';
      resultDiv.style.transition = 'opacity 0.2s ease-in-out';
      setTimeout(() => {
        displayQueryResult(finalResult);
        resultDiv.style.opacity = '1';
      }, 200);

      saveToHistory(finalResult);
    } else {
      throw new Error('Query stream ended before a terminal result or durable detach receipt');
    }

  } catch (error) {
    console.error('Streaming query failed:', error);
    resultDiv.innerHTML = `<div class="qt-error">Query failed: ${escapeHtml(error.message)}</div>`;
    resultDiv.style.display = '';
  } finally {
    submitBtn.disabled = false;
    loadingDiv.classList.add('qt-hidden');
    if (pgsTimerInterval) { clearInterval(pgsTimerInterval); pgsTimerInterval = null; }
  }
}

/* ═══════════════════════════════════════════════════════
   SSE Event Handler
   ═══════════════════════════════════════════════════════ */

function handleSSEEvent(type, event, ctx) {
  const { isPGS, containerDiv, progressDiv, resultDiv } = ctx;

  if (event?.operationId && QT_OPERATION_ID_PATTERN.test(event.operationId)) {
    QT_ACTIVE_OPERATION_ID = event.operationId;
    showActiveOperationActions(event.operationId, resultDiv);
  }

  switch (type) {
    case 'error':
      throw new Error(facadeErrorMessage(event, 'Unknown query error'));

    case 'status': {
      const message = [event.state, event.phase].filter(Boolean).join(' · ') || 'Query operation is running';
      if (isPGS) {
        if (event.phase) ctx.pgsUpdatePhase(event.phase);
        ctx.pgsSetStatus(message);
        ctx.pgsAddLog(message);
      } else if (progressDiv) {
        progressDiv.textContent = `⚡ ${message}`;
        progressDiv.style.display = '';
      }
      break;
    }

    case 'thinking':
    case 'progress': {
      const message = event.message || [event.state, event.phase].filter(Boolean).join(' · ') || 'Query operation is running';
      if (isPGS) {
        if (event.phase) ctx.pgsUpdatePhase(event.phase);
        ctx.pgsSetStatus(message);
        ctx.pgsAddLog(message);
      } else if (progressDiv) {
        progressDiv.textContent = `💭 ${message}`;
        progressDiv.style.display = '';
      }
      break;
    }

    case 'response_chunk':
    case 'chunk': {
      const text = event.chunk || event.text || '';
      const newAnswer = ctx.accumulatedAnswer() + text;
      ctx.setAccumulatedAnswer(newAnswer);
      if (containerDiv && containerDiv.textContent !== newAnswer) {
        containerDiv.textContent = newAnswer;
        if (!isPGS && progressDiv) progressDiv.style.display = 'none';
        // Auto-scroll if near bottom
        if (resultDiv) {
          const nearBottom = resultDiv.scrollHeight - resultDiv.scrollTop - resultDiv.clientHeight < 200;
          if (nearBottom) resultDiv.scrollTop = resultDiv.scrollHeight;
        }
      }
      break;
    }

    case 'pgs_init':
      if (isPGS) {
        ctx.pgsSetStatus(`Brain: ${event.totalNodes?.toLocaleString()} nodes, ${event.totalEdges?.toLocaleString()} edges`);
        ctx.pgsAddLog(`Brain loaded: ${event.totalNodes?.toLocaleString()} nodes, ${event.totalEdges?.toLocaleString()} edges`);
      }
      break;

    case 'pgs_phase':
      if (isPGS) {
        ctx.pgsUpdatePhase(event.phase);
        ctx.pgsSetStatus(event.message);
        ctx.pgsAddLog(event.message);
      } else if (progressDiv) {
        const icons = { loading: '📂', partitioning: '🧩', routing: '🔀', sweeping: '🔬', synthesizing: '🧬' };
        progressDiv.textContent = `${icons[event.phase] || '⚡'} PGS: ${event.message}`;
        progressDiv.style.display = '';
      }
      break;

    case 'pgs_session':
      if (isPGS) {
        ctx.pgsAddLog(`Session ${event.sessionId || 'default'} · searched ${event.searched}/${event.total} · remaining ${event.remaining}`);
      }
      break;

    case 'pgs_session_updated':
      if (isPGS) {
        ctx.pgsAddLog(`Session updated · searched ${event.searched}/${event.total} · remaining ${event.remaining}`);
      }
      break;

    case 'pgs_routed':
      if (isPGS && event.partitions) {
        ctx.pgsBuildSweepTracker(event.partitions);
        ctx.pgsAddLog(`Routed to ${event.partitions.length}/${event.totalPartitions} partitions`);
      }
      break;

    case 'pgs_sweep_progress':
      if (isPGS) {
        if (event.status === 'started') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'active');
          ctx.pgsSetStatus(`Sweeping: ${event.summary} (${event.nodeCount} nodes)`);
        } else if (event.status === 'complete') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'done');
          ctx.pgsSetStatus(`Sweep ${event.completed}/${event.total} complete`);
        } else if (event.status === 'failed') {
          ctx.pgsUpdateSweepRow(event.partitionId, 'failed');
          ctx.pgsSetStatus(`Sweep failed: ${event.summary}`);
        }
        ctx.pgsAddLog(event.message);
      } else if (progressDiv) {
        progressDiv.textContent = `🔬 ${event.message}`;
        progressDiv.style.display = '';
      }
      break;

    case 'tool_call':
      if (isPGS) ctx.pgsAddLog(`Tool: ${event.tool || 'unknown'}`);
      else if (progressDiv) { progressDiv.textContent = `🔧 Executing: ${event.tool || 'tool'}...`; progressDiv.style.display = ''; }
      break;

    case 'tool_result':
      if (isPGS) ctx.pgsAddLog(`Tool complete: ${event.tool || 'unknown'}`);
      else if (progressDiv) { progressDiv.textContent = `✅ Completed: ${event.tool || 'tool'}`; progressDiv.style.display = ''; }
      break;

    case 'result':
    case 'complete':
      ctx.setFinalResult(queryResultFromFacadePayload(event, ctx.query));
      ctx.clearPgsTimer();
      if (isPGS) {
        ctx.pgsUpdatePhase('done');
        const elapsed = Math.floor((Date.now() - ctx.pgsStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        ctx.pgsSetStatus(`Complete in ${mins}:${secs.toString().padStart(2, '0')}`);
        const statusEl = resultDiv?.querySelector('.pgs-status');
        if (statusEl) statusEl.style.animation = 'none';
      } else if (progressDiv) {
        progressDiv.style.display = 'none';
      }
      break;

    case 'detached':
      if (!isDetachedFacadePayload(event)) {
        throw new Error('Query facade returned an invalid detach receipt');
      }
      ctx.setDetachedResult(event);
      ctx.clearPgsTimer();
      break;
  }
}

function renderDetachedQuery(payload, resultDiv = document.getElementById('qt-result')) {
  if (!resultDiv) return;
  const guidance = payload.guidance || {};
  const detachedHistory = historyItemForQueryResult({
    query: payload.query || '',
    answer: null,
    metadata: payload.metadata || {},
    operationId: payload.operationId,
    resultHandle: payload.resultHandle || null,
    operationState: payload.state || 'running',
    attachmentState: 'detached',
  });
  saveToHistory(detachedHistory);
  resultDiv.innerHTML = `
    <div class="qt-panel qt-detached">
      <div class="qt-panel-title">⏳ Query continues durably</div>
      <p>This view detached from operation <code>${escapeHtml(payload.operationId)}</code>. The operation was not cancelled.</p>
      ${guidance.result ? `<p>${escapeHtml(guidance.resume || 'Reconnect with the operation ID to retrieve the result.')}</p>` : ''}
      ${guidance.status ? `<code>${escapeHtml(guidance.status)}</code>` : ''}
      <div class="qt-operation-actions">
        <button class="qt-btn qt-btn-primary qt-btn-sm" onclick="reattachQueryOperation('${escapeHtmlText(payload.operationId)}')">Reattach</button>
        <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="cancelQueryOperation('${escapeHtmlText(payload.operationId)}')">Cancel</button>
      </div>
    </div>
  `;
  resultDiv.style.display = '';
}

/* ═══════════════════════════════════════════════════════
   Display Query Result (final formatted view)
   ═══════════════════════════════════════════════════════ */

function displayQueryResult(result) {
  const resultDiv = document.getElementById('qt-result');
  if (!resultDiv) return;

  const sourceCount = result.metadata?.sources?.memoryNodes || 0;
  const thoughtCount = result.metadata?.sources?.thoughts || 0;
  const liveNodes = result.metadata?.sources?.liveJournalNodes || 0;

  const answerHtml = renderMarkdownSafe(result.answer || '');

  let html = `
    <div class="qt-answer-card">
      <div class="qt-answer-header">📝 ${escapeHtml(result.query || '')}</div>
      <div class="qt-answer-content">${answerHtml}</div>
  `;

  // Action results
  if (result.actionSuggestion) {
    html += `<div class="qt-action-suggestion">
      <div class="qt-action-title">💡 Action Detected</div>
      <div>${escapeHtml(result.actionSuggestion.message)}</div>
      <div class="qt-action-hint">Enable "Allow Actions" checkbox to execute.</div>
    </div>`;
  }

  if (result.actionExecuted && result.actionResult?.success) {
    const files = result.actionResult.filesCreated || [];
    if (files.length > 0) {
      html += `<div class="qt-action-success">
        <div class="qt-action-title">✅ Files Created</div>
        <div>${escapeHtml(result.actionResult.message || 'Files created successfully')}</div>
        <div class="qt-files-list">${files.map(f =>
          `<div class="qt-file-item">📄 ${escapeHtml(f.path)} <span class="qt-file-size">${(f.size / 1024).toFixed(1)} KB</span></div>`
        ).join('')}</div>
      </div>`;
    }
  }

  if (result.actionError) {
    html += `<div class="qt-action-error">
      <div class="qt-action-title">❌ Action Failed</div>
      <div>${escapeHtml(result.actionError)}</div>
    </div>`;
  }

  // PGS metadata
  const pgs = result.metadata?.pgs;
  if (pgs) {
    html += buildPGSCoverageHTML(pgs, result);
  }

  if (result.operationId) {
    html += `<div class="qt-operation-identity">Durable operation: <code>${escapeHtml(result.operationId)}</code></div>`;
  }

  // Standard metadata
  html += `<div class="qt-metadata">
    <span>📊 ${sourceCount} memory nodes</span>
    <span>💭 ${thoughtCount} thoughts</span>
    ${liveNodes > 0 ? `<span>🔴 ${liveNodes} live</span>` : ''}
    <span>⚡ ${escapeHtml(result.metadata?.model || 'unknown')}</span>
    <span>🎯 ${escapeHtml(result.metadata?.mode || 'normal')}</span>
    <span>🕐 ${result.metadata?.timestamp ? new Date(result.metadata.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()}</span>
  </div>`;

  // Evidence quality
  if (result.metadata?.evidenceQuality) {
    const eq = result.metadata.evidenceQuality;
    html += `<div class="qt-panel">
      <div class="qt-panel-title">📊 Evidence Quality</div>
      <div>Summary: ${escapeHtml(eq.summary || eq.quality || 'N/A')}</div>
      <div>Coverage: ${eq.coverage?.rating || 'N/A'} (${Math.round((eq.coverage?.percentage || eq.confidence || 0) * 100)}%)</div>
      ${eq.confidence?.rating ? `<div>Confidence: ${eq.confidence.rating} (${Math.round((eq.confidence.score || 0) * 100)}%)</div>` : ''}
    </div>`;
  }

  // Synthesis
  if (result.metadata?.synthesis) {
    html += `<div class="qt-panel">
      <div class="qt-panel-title">🔬 Synthesis</div>
      <div>${escapeHtml(result.metadata.synthesis.summary || 'Included in response')}</div>
    </div>`;
  }

  // Auto-save confirmation + export controls
  const exportedTo = result.exportedTo || (result.metadata && result.metadata.exportedTo);
  html += `<div class="qt-export-actions">`;
  if (exportedTo) {
    html += `<span class="qt-auto-saved">✅ Auto-saved to <code>${escapeHtml(exportedTo.split('/').slice(-3).join('/'))}</code></span>`;
  }
  html += `
    <button class="qt-btn qt-btn-primary qt-btn-sm" onclick="exportToWorkspace()">💾 Export to Workspace</button>
    <select id="qt-export-format" class="qt-select-sm">
      <option value="markdown">Markdown</option>
      <option value="json">JSON</option>
    </select>
    <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="downloadQueryResult()">⬇ Download</button>
    <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="copyQueryResult()">📋 Copy</button>
  </div>`;

  if (pgs && result.operationId) {
    const continuationAllowed = isPGSContinuable(result);
    html += `<div class="qt-operation-actions">
      ${continuationAllowed ? `<button class="qt-btn qt-btn-primary qt-btn-sm" onclick="preparePGSContinuation('${escapeHtmlText(result.operationId)}')">Continue</button>` : ''}
      <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="reattachQueryOperation('${escapeHtmlText(result.operationId)}')">Reattach</button>
      <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="startFreshPGS()">Start Fresh</button>
    </div>`;
  }

  html += `</div>`; // close answer card

  resultDiv.innerHTML = html;
  resultDiv.style.display = '';
  resultDiv.scrollTop = 0;
}

/* ═══════════════════════════════════════════════════════
   PGS Progress Panel HTML
   ═══════════════════════════════════════════════════════ */

function buildPGSProgressHTML() {
  return `
    <div class="pgs-progress-panel">
      <div class="pgs-status-row">
        <span class="pgs-title">🧬 Partitioned Graph Synthesis</span>
        <span class="pgs-timer">0:00</span>
        <span class="qt-operation-live-actions"></span>
      </div>
      <div class="pgs-status">Initializing...</div>
      <div class="pgs-phases">
        ${['partitioning', 'routing', 'sweeping', 'synthesizing'].map((p, i, arr) => `
          <div class="pgs-phase-step" data-phase="${p}">
            <span class="pgs-step-dot"></span>
            <span>${p.charAt(0).toUpperCase() + p.slice(1).replace('ing', '')}</span>
          </div>
          ${i < arr.length - 1 ? '<div class="pgs-phase-connector"></div>' : ''}
        `).join('')}
      </div>
      <div class="pgs-sweep-tracker" style="display:none;"></div>
      <div class="pgs-log-section">
        <div class="pgs-log"></div>
      </div>
    </div>
    <div class="qt-streaming-container"></div>
  `;
}

function showActiveOperationActions(operationId, resultDiv = document.getElementById('qt-result')) {
  if (!resultDiv || !QT_OPERATION_ID_PATTERN.test(operationId)) return;
  let host = resultDiv.querySelector('.qt-operation-live-actions');
  if (!host) {
    host = document.createElement('div');
    host.className = 'qt-operation-live-actions';
    resultDiv.prepend(host);
  }
  host.innerHTML = `
    <code>${escapeHtml(operationId)}</code>
    <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="cancelQueryOperation('${escapeHtmlText(operationId)}')">Cancel</button>
  `;
}

function preparePGSContinuation(operationId) {
  const id = requireOperationId(operationId);
  const source = [lastQueryResult, ...queryHistory].find((item) => item?.operationId === id) || {};
  const pgs = pgsMetadata(source) || {};
  const currentLevel = pgs.coverageLevel || 'sample';
  const selectedLevel = pgs.scopeComplete === false ? currentLevel : nextPGSLevel(currentLevel);
  const targets = Array.isArray(pgs.targetPartitionIds) ? pgs.targetPartitionIds : [];

  const pgsToggle = document.getElementById('qt-pgs');
  if (pgsToggle) pgsToggle.checked = true;
  document.getElementById('qt-pgs-controls')?.classList.remove('qt-hidden');
  const mode = document.getElementById('qt-pgs-mode');
  if (mode) mode.value = targets.length ? 'targeted' : 'continue';
  const prior = document.getElementById('qt-pgs-continue-operation');
  if (prior) {
    ensureContinuationOption(prior, source);
    prior.value = id;
  }
  const level = document.getElementById('qt-pgs-level');
  if (level) level.value = selectedLevel;
  document.querySelectorAll('.qt-depth-chip').forEach((chip) => {
    chip.classList.toggle('qt-depth-active', chip.dataset.level === selectedLevel);
  });
  const targetInput = document.getElementById('qt-pgs-targets');
  if (targetInput && targets.length) targetInput.value = targets.join(', ');
  const queryInput = document.getElementById('qt-input');
  if (queryInput && source.query) queryInput.value = source.query;
  updatePGSModeControls();
  updateQueryOptionsSummary();
  showQueryToast(`Ready to continue ${id}`);
}

function startFreshPGS() {
  const pgsToggle = document.getElementById('qt-pgs');
  if (pgsToggle) pgsToggle.checked = true;
  document.getElementById('qt-pgs-controls')?.classList.remove('qt-hidden');
  const mode = document.getElementById('qt-pgs-mode');
  if (mode) mode.value = 'fresh';
  const prior = document.getElementById('qt-pgs-continue-operation');
  if (prior) prior.value = '';
  const targets = document.getElementById('qt-pgs-targets');
  if (targets) targets.value = '';
  updatePGSModeControls();
  updateQueryOptionsSummary();
}

function ensureContinuationOption(select, item) {
  if (!select || !item?.operationId || !QT_OPERATION_ID_PATTERN.test(item.operationId)) return;
  const existing = Array.from(select.options || []).find((option) => option.value === item.operationId);
  if (existing) return;
  const option = document.createElement('option');
  option.value = item.operationId;
  option.textContent = `${String(item.query || 'PGS').slice(0, 54)} · ${item.operationId}`;
  select.appendChild(option);
}

async function fetchBrainOperationJson(operationId, action = '', init = {}) {
  const response = await fetch(brainOperationEndpoint(operationId, action), init);
  const payload = await response.json();
  if (!response.ok) throw new Error(facadeErrorMessage(payload, `Operation ${action || 'status'} failed`));
  return payload;
}

async function reattachQueryOperation(operationId) {
  const id = requireOperationId(operationId);
  const resultDiv = document.getElementById('qt-result');
  if (!resultDiv) return;
  QT_ACTIVE_OPERATION_ID = id;
  resultDiv.innerHTML = `<div class="qt-panel qt-detached">
    <div class="qt-panel-title">Reattached to durable operation</div>
    <p id="qt-reattach-status">Checking <code>${escapeHtml(id)}</code>…</p>
    <div class="qt-operation-actions">
      <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="cancelQueryOperation('${escapeHtmlText(id)}')">Cancel</button>
    </div>
  </div>`;
  resultDiv.style.display = '';
  try {
    let status = await fetchBrainOperationJson(id);
    if (status.state === 'queued' || status.state === 'running') {
      const attachmentId = `qt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const eventsUrl = `${brainOperationEndpoint(id, 'events')}?after=0&attachmentId=${encodeURIComponent(attachmentId)}`;
      const response = await fetch(eventsUrl, { headers: { Accept: 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`Reattach stream HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          const statusEl = document.getElementById('qt-reattach-status');
          if (statusEl) statusEl.textContent = [event.state, event.phase].filter(Boolean).join(' · ') || 'Running';
        }
      }
      status = await fetchBrainOperationJson(id);
    }
    if (status.state === 'queued' || status.state === 'running') {
      renderDetachedQuery({
        operationId: id,
        state: status.state,
        query: queryHistory.find((item) => item.operationId === id)?.query || '',
        guidance: { resume: 'The durable operation is still running.' },
      }, resultDiv);
      return;
    }
    const envelope = await fetchBrainOperationJson(id, 'result');
    if (!['complete', 'partial'].includes(envelope.state) || !envelope.result) {
      throw Object.assign(new Error(facadeErrorMessage(envelope, `Operation ended ${envelope.state}`)), { envelope });
    }
    const result = queryResultFromFacadePayload(envelope, queryHistory.find((item) => item.operationId === id)?.query || '');
    lastQueryResult = { ...result, fullResult: envelope };
    displayQueryResult(result);
    saveToHistory(result);
  } catch (error) {
    const envelope = error.envelope || {};
    resultDiv.innerHTML = `<div class="qt-error">
      <div>${escapeHtml(error.message)}</div>
      <div>Operation: <code>${escapeHtml(id)}</code></div>
      <div class="qt-operation-actions">
        <button class="qt-btn qt-btn-primary qt-btn-sm" onclick="reattachQueryOperation('${escapeHtmlText(id)}')">Reattach</button>
        <button class="qt-btn qt-btn-outline qt-btn-sm" onclick="startFreshPGS()">Start Fresh</button>
      </div>
      ${envelope.state ? `<div>State: ${escapeHtml(envelope.state)}</div>` : ''}
    </div>`;
  }
}

async function cancelQueryOperation(operationId) {
  const id = requireOperationId(operationId);
  try {
    const payload = await fetchBrainOperationJson(id, 'cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const item = queryHistory.find((candidate) => candidate.operationId === id);
    if (item) item.operationState = payload.state || 'cancelled';
    saveQueryHistory();
    updateQueryHistoryUI();
    showQueryToast(`Cancelled ${id}`);
    return payload;
  } catch (error) {
    showQueryToast(`Cancel failed: ${error.message}`);
    throw error;
  }
}

/* ═══════════════════════════════════════════════════════
   Export / Copy
   ═══════════════════════════════════════════════════════ */

function copyQueryResult() {
  if (!lastQueryResult?.answer) { showQueryToast('No result to copy'); return; }
  navigator.clipboard.writeText(lastQueryResult.answer)
    .then(() => showQueryToast('✅ Copied to clipboard'))
    .catch(() => showQueryToast('❌ Copy failed'));
}

async function exportToWorkspace() {
  if (!lastQueryResult) { showQueryToast('No result to export'); return; }
  const fmt = document.getElementById('qt-export-format')?.value || 'markdown';
  try {
    const res = await fetch(queryFacadeEndpoint(QT_QUERY_CATALOG, 'export', QT_AGENT_NAME), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildFacadeExportRequest(lastQueryResult, fmt, QT_AGENT_NAME)),
    });
    const data = await res.json();
    if (res.ok && data.success === true && data.exportedTo) {
      showQueryToast(`✅ Exported: ${data.exportedTo.split('/').slice(-2).join('/')}`);
    } else {
      showQueryToast(`❌ ${facadeErrorMessage(data, 'Export failed')}`);
    }
  } catch (err) {
    showQueryToast(`❌ ${err.message}`);
  }
}

function downloadQueryResult() {
  if (!lastQueryResult) { showQueryToast('No result to export'); return; }
  const fmt = document.getElementById('qt-export-format')?.value || 'markdown';
  const ts = Date.now();

  if (fmt === 'json') {
    const data = lastQueryResult.fullResult || lastQueryResult;
    downloadFile(`query-${ts}.json`, JSON.stringify(data, null, 2), 'application/json');
  } else {
    const meta = lastQueryResult.metadata || {};
    let md = `# ${lastQueryResult.query}\n\n`;
    md += `> ⚡ ${meta.model || '?'} · 🎯 ${meta.mode || '?'} · ${new Date().toLocaleString()}\n\n`;
    md += lastQueryResult.answer || '';
    downloadFile(`query-${ts}.md`, md, 'text/markdown');
  }
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════════════════════
   Follow-Up & Context
   ═══════════════════════════════════════════════════════ */

function enableFollowUp() {
  const btn = document.getElementById('qt-followup');
  if (btn) btn.disabled = false;
  const indicator = document.getElementById('qt-context-indicator');
  if (indicator) indicator.classList.remove('qt-hidden');
}

/* ═══════════════════════════════════════════════════════
   History
   ═══════════════════════════════════════════════════════ */

function getHistoryKey() {
  return `cosmo.queryHistory.${getSelectedBrainId() || 'global'}`;
}

function saveToHistory(item) {
  const historyItem = historyItemForQueryResult(item);
  if (historyItem.operationId) {
    queryHistory = queryHistory.filter((existing) => existing?.operationId !== historyItem.operationId);
  }
  queryHistory.unshift(historyItem);
  queryHistory = queryHistory.slice(0, 50);
  saveQueryHistory();
  updateQueryHistoryUI();
}

function saveQueryHistory() {
  try { localStorage.setItem(getHistoryKey(), JSON.stringify(queryHistory.slice(0, 50))); } catch {}
}

function loadQueryHistory() {
  try {
    const saved = localStorage.getItem(getHistoryKey());
    const parsed = saved ? JSON.parse(saved) : [];
    queryHistory = Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item === 'object').map(historyItemForQueryResult)
      : [];
  } catch {
    queryHistory = [];
  }
  updateQueryHistoryUI();
}

function updateQueryHistoryUI() {
  const section = document.getElementById('qt-history');
  const list = document.getElementById('qt-history-list');
  if (!section || !list) return;

  updatePGSContinuationOptions();

  if (queryHistory.length === 0) {
    section.classList.add('qt-hidden');
    return;
  }

  section.classList.remove('qt-hidden');
  list.innerHTML = queryHistory.slice(0, 20).map((item, i) => `
    <div class="qt-history-item" onclick="loadHistoryItem(${i})">
      <div class="qt-history-query">${escapeHtml(item.query || '')}</div>
      <div class="qt-history-meta">${item.metadata?.mode || item.operationState || '?'} · ${item.operationId ? escapeHtml(item.operationId) : ''} · ${item.metadata?.timestamp ? new Date(item.metadata.timestamp).toLocaleString() : ''}</div>
    </div>
  `).join('');
}

function updatePGSContinuationOptions() {
  const select = document.getElementById('qt-pgs-continue-operation');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">Select a continuable PGS result</option>';
  const now = Date.now();
  for (const item of queryHistory) {
    const pgs = pgsMetadata(item);
    if (!pgs || !item.operationId || !isPGSContinuable(item, now)) continue;
    ensureContinuationOption(select, item);
  }
  if (Array.from(select.options).some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function loadHistoryItem(index) {
  const item = queryHistory[index];
  if (!item) return;
  document.getElementById('qt-input').value = item.query || '';
  lastQueryResult = { ...item, fullResult: item };
  if (typeof item.answer === 'string') {
    enableFollowUp();
    displayQueryResult(item);
  } else if (item.operationId) {
    reattachQueryOperation(item.operationId);
  }
}

/* ═══════════════════════════════════════════════════════
   Clear
   ═══════════════════════════════════════════════════════ */

function clearQuery() {
  const input = document.getElementById('qt-input');
  if (input) { input.value = ''; input.placeholder = "Ask a question about this brain's knowledge..."; }

  const resultDiv = document.getElementById('qt-result');
  if (resultDiv) {
    resultDiv.innerHTML = `
      <div class="qt-result-placeholder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
          <path d="M12 17h.01"/>
        </svg>
        <p>Ask a question above to query this brain's knowledge</p>
        <p class="qt-hint">Responses will appear here with full context and citations</p>
      </div>
    `;
  }

  lastQueryResult = null;
  const btn = document.getElementById('qt-followup');
  if (btn) btn.disabled = true;
  const indicator = document.getElementById('qt-context-indicator');
  if (indicator) indicator.classList.add('qt-hidden');
}

/* ═══════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════ */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizeRenderedHtml(html) {
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }
  return escapeHtml(String(html || ''));
}

function renderMarkdownSafe(markdown) {
  if (typeof marked !== 'undefined' && marked.parse) {
    return sanitizeRenderedHtml(marked.parse(markdown || ''));
  }
  return `<pre style="white-space:pre-wrap;">${escapeHtml(markdown || '(no answer)')}</pre>`;
}

function showQueryToast(msg, duration = 3000) {
  if (typeof showToast === 'function') { showToast(msg, 'info'); return; }
  let t = document.getElementById('qt-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'qt-toast';
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:6px;background:#333;color:#eee;font-size:13px;z-index:10000;opacity:0;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, duration);
}

/* ═══════════════════════════════════════════════════════
   CSS — Self-Contained
   ═══════════════════════════════════════════════════════ */

function getQueryTabStyles() {
  return `
  /* HOME23 — scoped design-token fallbacks so the ported cosmo23 styles work
     against home23's dashboard theme (dark/translucent on gradient bg). */
  .qt-container {
    --bg-primary: rgba(20, 24, 36, 0.55);
    --bg-secondary: rgba(30, 36, 52, 0.60);
    --bg-tertiary: rgba(255, 255, 255, 0.06);
    --accent-primary: var(--accent-blue, #0A84FF);
    --border-color: rgba(255, 255, 255, 0.12);
    --text-primary: var(--text-primary, rgba(255,255,255,0.98));
    --text-secondary: var(--text-secondary, rgba(255,255,255,0.82));
    --text-muted: var(--text-muted, rgba(255,255,255,0.55));
  }

  /* HOME23 — fixed-brain header strip */
  .qt-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 14px;
    background: rgba(10, 132, 255, 0.12);
    border: 1px solid rgba(10, 132, 255, 0.25);
    border-radius: 10px;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .qt-header-label strong { color: var(--text-primary); }

  /* ── Container ── */
  .qt-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 20px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    background: var(--bg-primary);
    gap: 14px;
  }

  .qt-hidden { display: none !important; }

  /* ── Input Section ── */
  .qt-input-section {
    flex-shrink: 0;
  }

  .qt-textarea {
    width: 100%;
    min-height: 80px;
    max-height: 200px;
    padding: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 16px;
    resize: vertical;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .qt-textarea:focus { outline: none; border-color: var(--accent-primary); }

  .qt-actions-compact {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  /* ── Buttons ── */
  .qt-btn {
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    min-height: 44px;
    padding: 10px 20px;
    transition: all 0.15s;
  }
  .qt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .qt-btn-primary { background: var(--accent-primary); color: white; }
  .qt-btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
  .qt-btn-outline {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }
  .qt-btn-outline:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
  .qt-btn-sm { padding: 6px 14px; font-size: 12px; min-height: 36px; }
  .qt-btn-text {
    background: none; border: none; color: var(--text-muted, var(--text-secondary));
    font-size: 12px; cursor: pointer; padding: 4px 8px;
  }
  .qt-btn-text:hover { color: var(--text-primary); }

  /* ── Context Indicator ── */
  .qt-context-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent-primary);
    margin-left: auto;
  }
  .qt-context-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent-primary);
    animation: qt-pulse 2s ease-in-out infinite;
  }

  /* ── Collapsible Options ── */
  .qt-options-section {
    flex-shrink: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .qt-options-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    min-height: 44px;
    user-select: none;
    list-style: none;
  }
  .qt-options-toggle::-webkit-details-marker { display: none; }
  .qt-toggle-icon { font-size: 10px; opacity: 0.6; transition: transform 0.2s; }
  .qt-options-summary { margin-left: auto; font-size: 12px; opacity: 0.7; }

  .qt-options-content {
    padding: 0 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Quick Prompts ── */
  .qt-quick-prompts { }
  .qt-quick-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; margin-bottom: 8px; }
  .qt-quick-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .qt-quick-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary, rgba(255,255,255,0.05));
    border: 1px solid var(--border-color);
    border-radius: 16px;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    min-height: 32px;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .qt-quick-btn:hover { border-color: var(--accent-primary); color: var(--text-primary); }

  /* ── Options Grid ── */
  .qt-options-grid {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 14px;
    align-items: end;
  }
  .qt-option-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qt-option-group label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }

  .qt-select, .qt-select-sm {
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    min-height: 36px;
  }
  .qt-select-sm { padding: 6px 10px; font-size: 12px; min-height: 30px; }

  .qt-checkbox-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; cursor: pointer; min-height: 44px;
  }

  /* ── Mode Hint ── */
  .qt-mode-hint {
    font-size: 12px;
    color: var(--text-muted, var(--text-secondary));
    font-style: italic;
  }

  /* ── Enhancement & Context Toggles ── */
  .qt-enhancements, .qt-context-options {
    display: flex; gap: 16px; flex-wrap: wrap;
  }
  .qt-toggle-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-primary);
    cursor: pointer; min-height: 44px;
  }
  .qt-pgs-label { color: #a78bfa; font-weight: 600; }
  .qt-pgs-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 10px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
  }
  .qt-pgs-model-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    grid-column: span 2;
  }
  .qt-pgs-model-row .qt-select {
    width: 100%;
  }
  .qt-pgs-depth-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .qt-depth-chip {
    padding: 5px 12px;
    border: 1px solid var(--border-color);
    border-radius: 16px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .qt-depth-chip:hover {
    border-color: var(--accent-color, #d4a843);
    color: var(--text-primary);
  }
  .qt-depth-chip.qt-depth-active {
    background: rgba(212, 168, 67, 0.2);
    border-color: var(--accent-color, #d4a843);
    color: var(--accent-color, #d4a843);
  }
  .qt-input-inline {
    padding: 8px 12px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 13px;
    min-height: 36px;
  }
  textarea.qt-input-inline { width: 100%; resize: vertical; font-family: inherit; }
  #qt-pgs-continuation-group, #qt-pgs-target-group { grid-column: span 2; }
  .qt-option-help { color: var(--text-muted, var(--text-secondary)); font-size: 11px; line-height: 1.4; }
  .qt-pgs-coverage {
    display: grid;
    gap: 5px;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid rgba(167, 139, 250, 0.35);
    border-radius: 8px;
    background: rgba(167, 139, 250, 0.08);
    font-size: 12px;
  }
  .qt-operation-identity { margin-top: 8px; color: var(--text-secondary); font-size: 12px; }
  .qt-operation-actions, .qt-operation-live-actions {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;
  }
  .qt-operation-live-actions { margin: 0 0 0 auto; }

  /* ── Response Section ── */
  .qt-response-section {
    flex: 1;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* ── Loading ── */
  .qt-loading {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 40px;
    text-align: center;
    color: var(--text-secondary);
  }
  .qt-spinner {
    width: 36px; height: 36px;
    border: 3px solid var(--border-color);
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    animation: qt-spin 1s linear infinite;
    margin: 0 auto 16px;
  }
  .qt-loading-hint { font-size: 12px; opacity: 0.7; margin-top: 8px; }
  @keyframes qt-spin { to { transform: rotate(360deg); } }
  @keyframes qt-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* ── Result Area ── */
  .qt-result {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 20px;
    min-height: 120px;
    overflow-y: auto;
  }

  .qt-result-placeholder {
    text-align: center;
    color: var(--text-secondary);
    padding: 40px 20px;
  }
  .qt-result-placeholder svg { opacity: 0.3; margin-bottom: 12px; }
  .qt-result-placeholder p { margin: 4px 0; }
  .qt-hint { font-size: 12px; opacity: 0.6; }

  /* ── Streaming ── */
  .qt-streaming-progress {
    color: var(--text-muted, var(--text-secondary));
    font-style: italic;
    padding: 12px;
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
    border-radius: 6px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  .qt-streaming-container {
    white-space: pre-wrap;
    font-family: inherit;
    line-height: 1.6;
    font-size: 14px;
    color: var(--text-primary);
  }

  /* ── Answer Card ── */
  .qt-answer-card { }
  .qt-answer-header {
    font-weight: 600; font-size: 14px;
    margin-bottom: 12px; padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-primary);
  }
  .qt-answer-content {
    font-size: 14px; line-height: 1.7;
    color: var(--text-primary); overflow-x: auto;
  }
  .qt-answer-content h1, .qt-answer-content h2, .qt-answer-content h3 { margin-top: 16px; margin-bottom: 8px; }
  .qt-answer-content pre {
    background: var(--bg-tertiary, #1a1a1a);
    padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px;
  }
  .qt-answer-content code { font-size: 12px; }
  .qt-answer-content ul, .qt-answer-content ol { padding-left: 20px; }
  .qt-answer-content blockquote {
    border-left: 3px solid var(--accent-primary);
    margin: 8px 0; padding: 4px 12px;
    color: var(--text-secondary);
  }

  /* ── Metadata ── */
  .qt-metadata {
    display: flex; gap: 14px; flex-wrap: wrap;
    padding-top: 12px; margin-top: 12px;
    border-top: 1px solid var(--border-color);
    font-size: 12px; color: var(--text-secondary);
  }
  .qt-pgs-meta {
    background: rgba(167, 139, 250, 0.08);
    border: 1px solid rgba(167, 139, 250, 0.2);
    border-radius: 6px;
    padding: 10px 14px;
    margin-top: 12px;
  }

  /* ── Panels ── */
  .qt-panel {
    margin-top: 12px; padding: 10px 14px;
    border-radius: 6px; font-size: 12px;
    color: var(--text-secondary);
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
    border: 1px solid var(--border-color);
  }
  .qt-panel-title { font-weight: 600; margin-bottom: 4px; }

  /* ── Actions (suggestion/success/error) ── */
  .qt-action-suggestion, .qt-action-success, .qt-action-error {
    margin-top: 12px; padding: 10px 14px; border-radius: 6px; font-size: 13px;
  }
  .qt-action-suggestion { background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.2); }
  .qt-action-success { background: rgba(40,167,69,0.08); border: 1px solid rgba(40,167,69,0.2); }
  .qt-action-error { background: rgba(220,53,69,0.08); border: 1px solid rgba(220,53,69,0.2); }
  .qt-action-title { font-weight: 600; margin-bottom: 4px; }
  .qt-action-hint { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
  .qt-files-list { margin-top: 6px; }
  .qt-file-item { padding: 2px 0; font-size: 12px; }
  .qt-file-size { opacity: 0.6; font-size: 11px; }

  /* ── Export inside card ── */
  .qt-export-actions {
    margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border-color);
    display: flex; gap: 8px; align-items: center;
  }
  .qt-export-label { font-size: 12px; color: var(--text-muted, var(--text-secondary)); margin-right: 4px; }
  .qt-auto-saved { font-size: 11px; color: #4caf50; margin-right: 8px; width: 100%; margin-bottom: 6px; }
  .qt-auto-saved code { font-size: 10px; background: rgba(76,175,80,0.1); padding: 1px 4px; border-radius: 3px; }
  .qt-btn-primary { background: var(--accent, #4a9eff); color: #fff; border: none; font-weight: 600; }
  .qt-btn-primary:hover { opacity: 0.9; }

  /* ── Error ── */
  .qt-error {
    padding: 16px; color: #ff6b6b; text-align: center;
  }

  /* ── PGS Progress Panel ── */
  .pgs-progress-panel {
    margin-bottom: 16px;
    padding: 16px;
    background: rgba(167, 139, 250, 0.05);
    border: 1px solid rgba(167, 139, 250, 0.15);
    border-radius: 8px;
  }
  .pgs-status-row {
    display: flex; justify-content: space-between; align-items: center;
  }
  .pgs-title { font-weight: 600; color: #a78bfa; }
  .pgs-timer { font-variant-numeric: tabular-nums; opacity: 0.6; font-size: 12px; }
  .pgs-status {
    font-size: 13px; color: var(--text-muted, var(--text-secondary));
    margin: 8px 0; animation: qt-pulse 2s ease-in-out infinite;
  }
  .pgs-phases {
    display: flex; gap: 4px; align-items: center; margin: 12px 0; flex-wrap: wrap;
  }
  .pgs-phase-step {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 12px; font-size: 11px;
    background: var(--bg-tertiary, rgba(255,255,255,0.05));
    color: var(--text-muted, var(--text-secondary));
    transition: all 0.3s;
  }
  .pgs-step-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-muted, var(--text-secondary));
    transition: background 0.3s;
  }
  .pgs-phase-step.pgs-active {
    background: rgba(167, 139, 250, 0.2); color: #a78bfa;
  }
  .pgs-phase-step.pgs-active .pgs-step-dot { background: #a78bfa; }
  .pgs-phase-step.pgs-done {
    background: rgba(74, 222, 128, 0.15); color: #4ade80;
  }
  .pgs-phase-step.pgs-done .pgs-step-dot { background: #4ade80; }
  .pgs-phase-connector {
    width: 16px; height: 1px; background: var(--border-color);
  }

  /* ── Sweep Tracker ── */
  .pgs-sweep-header { font-weight: 600; margin-bottom: 6px; }
  .pgs-sweep-row {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 0; font-size: 12px;
    color: var(--text-muted, var(--text-secondary));
    transition: color 0.2s;
  }
  .pgs-sweep-status { width: 14px; text-align: center; }
  .pgs-sweep-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pgs-sweep-meta { font-size: 11px; opacity: 0.6; }

  /* ── PGS Log ── */
  .pgs-log-section {
    margin-top: 12px; border-top: 1px solid var(--border-color); padding-top: 8px;
  }
  .pgs-log {
    max-height: 120px; overflow-y: auto;
    font-size: 11px; font-family: monospace;
    color: var(--text-muted, var(--text-secondary));
  }

  /* ── History ── */
  .qt-history-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .qt-history-toggle {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    cursor: pointer; font-size: 13px;
    color: var(--text-secondary);
    min-height: 44px;
    list-style: none;
  }
  .qt-history-toggle::-webkit-details-marker { display: none; }
  .qt-history-list { padding: 0 12px 12px; }
  .qt-history-item {
    padding: 10px 12px; margin-bottom: 4px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer; transition: border-color 0.15s;
    min-height: 44px;
    display: flex; flex-direction: column; justify-content: center;
  }
  .qt-history-item:hover { border-color: var(--accent-primary); }
  .qt-history-query {
    font-size: 13px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    color: var(--text-primary);
  }
  .qt-history-meta { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

  /* ── Mobile ── */
  @media (max-width: 900px) {
    .qt-container { padding: 12px; gap: 10px; }
    .qt-options-grid { grid-template-columns: 1fr; }
    .qt-quick-grid { gap: 4px; }
    .qt-quick-btn { font-size: 11px; padding: 5px 10px; }
    .qt-enhancements, .qt-context-options { gap: 8px; }
    .qt-metadata { flex-direction: column; gap: 4px; }
    .qt-export-actions { flex-wrap: wrap; }
    .pgs-phases { flex-wrap: wrap; }
  }
  `;
}
