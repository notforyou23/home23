/**
 * Query Tab
 * Intelligence Dashboard style query interface
 */

function initQueryTab() {
  const panel = document.getElementById('query-tab-panel');
  
  panel.innerHTML = `
    <div class="query-container">
      <!-- Query Input -->
      <div class="query-input-section">
        <textarea 
          id="queryInput" 
          placeholder="Ask a question about this brain's knowledge..."
          class="query-textarea"
        ></textarea>

        <!-- Options Grid -->
        <div class="query-options">
          <div class="option-group">
            <label>Model:</label>
            <select id="queryModel" class="query-select">
              <option value="gpt-5.1" selected>GPT-5.1 (Default - Fast with 24h Caching)</option>
              <option value="gpt-5">GPT-5 (Maximum Reasoning Depth)</option>
              <option value="gpt-5-mini">GPT-5 Mini (Ultra Fast & Economical)</option>
            </select>
          </div>

          <div class="option-group">
            <label>Reasoning Mode:</label>
            <select id="queryMode" class="query-select">
              <option value="fast">Fast (Quick Extraction)</option>
              <option value="normal" selected>Normal (Balanced Depth)</option>
              <option value="deep">Deep (Maximum Analysis)</option>
              <option value="grounded">Grounded (Evidence-Focused)</option>
              <option value="raw">🔓 Raw (No Formatting)</option>
              <option value="report">Report (Academic Style)</option>
              <option value="innovation">💡 Innovation (Creative Synthesis)</option>
              <option value="consulting">📊 Consulting (Strategic)</option>
              <option value="executive">📊 Executive Summary</option>
            </select>
            <div id="modeHint" class="option-hint">
              Balanced depth mode - comprehensive answers with source citations
            </div>
          </div>
        </div>

        <!-- Enhancement Checkboxes -->
        <div class="query-enhancements">
          <label><input type="checkbox" id="evidenceMetrics"> Evidence Metrics</label>
          <label><input type="checkbox" id="enableSynthesis" checked> Synthesis</label>
          <label><input type="checkbox" id="coordinatorInsights" checked> Coordinator Insights</label>
        </div>

        <!-- Context Options -->
        <div class="query-context-options">
          <label><input type="checkbox" id="includeOutputs" checked> 📁 Include Output Files</label>
          <label><input type="checkbox" id="includeThoughts" checked> 💭 Include Thought Stream</label>
        </div>

        <!-- Action Buttons -->
        <div class="query-actions">
          <button id="executeQueryBtn" class="btn-primary" onclick="executeQuery()">🔍 Execute Query</button>
          <button onclick="clearQuery()" class="btn-secondary">Clear</button>
          
          <div class="export-controls">
            <label>Export:</label>
            <select id="exportFormat" class="query-select-sm">
              <option value="none">None</option>
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Loading State -->
      <div id="queryLoading" class="query-loading" style="display: none;">
        <div class="loading-spinner"></div>
        <div>Searching knowledge graph and synthesizing answer...</div>
        <div class="loading-hint">This may take 10-30 seconds</div>
      </div>

      <!-- Results -->
      <div id="queryResults" style="display: none;"></div>

      <!-- History -->
      <div id="queryHistory" style="display: none;">
        <h3>Query History</h3>
        <div id="historyList"></div>
      </div>
    </div>
  `;
}

// Query state
let lastQueryResult = null;
let queryHistory = [];

async function executeQuery() {
  const input = document.getElementById('queryInput');
  const query = input.value.trim();
  if (!query) return;

  const model = document.getElementById('queryModel').value;
  const mode = document.getElementById('queryMode').value;
  const evidenceMetrics = document.getElementById('evidenceMetrics').checked;
  const synthesis = document.getElementById('enableSynthesis').checked;
  const coordinatorInsights = document.getElementById('coordinatorInsights').checked;
  const includeOutputs = document.getElementById('includeOutputs').checked;
  const includeThoughts = document.getElementById('includeThoughts').checked;
  const exportFormat = document.getElementById('exportFormat').value;

  const btn = document.getElementById('executeQueryBtn');
  const resultsDiv = document.getElementById('queryResults');
  const loadingDiv = document.getElementById('queryLoading');

  // Show loading
  resultsDiv.style.display = 'none';
  loadingDiv.style.display = 'block';
  btn.disabled = true;

  try {
    const response = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        model,
        mode,
        includeEvidenceMetrics: evidenceMetrics,
        enableSynthesis: synthesis,
        includeCoordinatorInsights: coordinatorInsights,
        includeOutputs,
        includeThoughts,
        exportFormat: exportFormat !== 'none' ? exportFormat : null,
        priorContext: lastQueryResult ? {
          query: lastQueryResult.query,
          answer: lastQueryResult.answer
        } : null
      })
    });

    const result = await response.json();
    
    if (result.error) {
      throw new Error(result.error);
    }

    // Save for follow-ups
    lastQueryResult = { query, answer: result.answer };
    queryHistory.unshift({ query, ...result });

    // Display result
    displayQueryResult(result);
    updateQueryHistory();

  } catch (error) {
    resultsDiv.innerHTML = `<div class="error-message">❌ Error: ${error.message}</div>`;
    resultsDiv.style.display = 'block';
  }

  loadingDiv.style.display = 'none';
  btn.disabled = false;
}

function displayQueryResult(result) {
  const resultsDiv = document.getElementById('queryResults');
  
  const sourceCount = result.metadata?.sources?.memoryNodes || 0;
  const thoughtCount = result.metadata?.sources?.thoughts || 0;
  
  const html = `
    <div class="answer-card">
      <div class="answer-header">📝 ${escapeHtml(result.query || 'Query')}</div>
      <div class="answer-content">${marked.parse(result.answer)}</div>
      
      <div class="answer-metadata">
        <span>📊 ${sourceCount} memory nodes, ${thoughtCount} thoughts</span>
        <span>⚡ ${result.metadata.model}</span>
        <span>🎯 ${result.metadata.mode}</span>
        <span>🕐 ${new Date(result.metadata.timestamp).toLocaleTimeString()}</span>
      </div>
      
      ${result.metadata?.evidenceQuality ? `
        <div class="evidence-panel">
          <div class="panel-title">📊 Evidence Quality</div>
          <div>Quality: ${result.metadata.evidenceQuality.quality}</div>
          <div>Confidence: ${((result.metadata.evidenceQuality.confidence || 0) * 100).toFixed(0)}%</div>
        </div>
      ` : ''}
      
      ${result.metadata?.synthesis ? `
        <div class="synthesis-panel">
          <div class="panel-title">🔬 Synthesis</div>
          <div>${result.metadata.synthesis.summary || 'Included in response'}</div>
        </div>
      ` : ''}
    </div>
  `;
  
  resultsDiv.innerHTML = html;
  resultsDiv.style.display = 'block';
  resultsDiv.scrollIntoView({ behavior: 'smooth' });
}

function updateQueryHistory() {
  if (queryHistory.length === 0) return;
  
  const historyDiv = document.getElementById('queryHistory');
  const listDiv = document.getElementById('historyList');
  
  listDiv.innerHTML = queryHistory.map((item, i) => `
    <div class="history-item" onclick="loadHistoryItem(${i})">
      <div class="history-query">${escapeHtml(item.query || '')}</div>
      <div class="history-meta">${item.metadata?.mode} · ${new Date(item.metadata?.timestamp).toLocaleString()}</div>
    </div>
  `).join('');
  
  historyDiv.style.display = 'block';
}

function loadHistoryItem(index) {
  const item = queryHistory[index];
  document.getElementById('queryInput').value = item.query || '';
  displayQueryResult(item);
}

function clearQuery() {
  document.getElementById('queryInput').value = '';
  document.getElementById('queryResults').style.display = 'none';
  lastQueryResult = null;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

