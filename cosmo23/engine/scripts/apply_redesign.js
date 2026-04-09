const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/dashboard/intelligence.html');
const content = fs.readFileSync(filePath, 'utf8');

// Extract the main script block (the one without src attribute)
// This regex looks for <script> tags that don't have a src attribute
const scriptRegex = /<script>\s*([\s\S]*?)<\/script>/;
const match = content.match(scriptRegex);

if (!match) {
    console.error('Could not find main script block!');
    process.exit(1);
}

const originalScript = match[1];

// Define the new HTML template
const newHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>COSMO Mission Control</title>
    <link rel="stylesheet" href="design-system.css">
    <link rel="stylesheet" href="intelligence-overrides.css">
    <script src="https://d3js.org/d3.v7.min.js"></script>
</head>
<body>

<div class="app-layout">
    
    <!-- SIDEBAR NAVIGATION -->
    <aside class="sidebar-nav">
        <div class="sidebar-header">
            <div class="sidebar-title">
                <span class="sidebar-brand-dot"></span>
                COSMO M.C.
            </div>
        </div>
        
        <div class="nav-menu">
            <a class="nav-link active" data-tab="insights">
                <span>📊 Insights</span>
            </a>
            <a class="nav-link" data-tab="deliverables">
                <span>📦 Deliverables</span>
            </a>
            <a class="nav-link" data-tab="operations">
                <span>⚙️ Operations</span>
            </a>
            <a class="nav-link" data-tab="query">
                <span>💬 Query Brain</span>
            </a>
            <a class="nav-link" data-tab="memory">
                <span>🧠 Memory Graph</span>
            </a>
            <a class="nav-link" data-tab="goals">
                <span>🎯 Goals</span>
            </a>
            <a class="nav-link" data-tab="thoughts">
                <span>💭 Stream</span>
            </a>
            <a class="nav-link" data-tab="trajectory">
                <span>🚀 Trajectory</span>
            </a>
            <a class="nav-link" data-tab="performance">
                <span>⚡ Performance</span>
            </a>
            <a class="nav-link" data-tab="dreams">
                <span>🌙 Dream Journal</span>
            </a>
            <a class="nav-link" data-tab="reports">
                <span>📑 Reports</span>
            </a>
            <a class="nav-link" data-tab="terminal">
                <span>💻 Console</span>
            </a>
        </div>

        <div class="sidebar-footer">
            <div class="run-mini-status">
                <div id="run-name" style="color: white; font-weight: 600; margin-bottom: 4px;">Loading...</div>
                <div id="run-meta" style="opacity: 0.7;">Initializing...</div>
            </div>
            <div style="margin-top: 15px;">
                <a href="/" class="btn-sm btn-secondary" style="text-decoration: none; display: block; text-align: center;">Exit to Launcher</a>
            </div>
        </div>
    </aside>

    <!-- TOP HEADER BAR -->
    <header class="top-bar">
        <div class="breadcrumb">
            <span>Mission Control</span>
            <span>/</span>
            <span class="breadcrumb-active" id="page-title">Insights</span>
        </div>
        
        <div style="display: flex; align-items: center; gap: 20px;">
            <!-- System Status Pill -->
            <div class="cycle-indicator">
                Cycle <span id="stat-cycle">0</span>
            </div>
            
            <!-- Global Controls (Pause/Stop) -->
            <div id="global-controls">
                <!-- Populated by JS in loadOperationsTab -->
            </div>
        </div>
    </header>

    <!-- MAIN CONTENT AREA -->
    <main class="main-content">
        <div class="content-wrapper">
            
            <!-- Run Config (Collapsible) -->
            <div class="run-config-card">
                <div class="run-config-header" style="margin-bottom: 0;">
                    <div class="run-config-title" style="display: flex; align-items: center; gap: 10px;">
                        <span style="color: var(--accent-blue);">ℹ️</span> 
                        Mission Parameters
                    </div>
                    <button onclick="toggleSetup()" id="toggle-setup-btn" class="btn-sm btn-secondary">Show Details</button>
                </div>
                <div id="run-setup-details" style="display: none; margin-top: 15px; border-top: 1px solid #30363d; padding-top: 15px;">
                    <table class="config-table">
                        <tr><td>Domain:</td><td id="setup-domain">Loading...</td></tr>
                        <tr><td>Context:</td><td id="setup-context">Loading...</td></tr>
                        <tr><td>Mode:</td><td id="setup-mode">Loading...</td></tr>
                        <tr><td>Started:</td><td id="setup-created">Loading...</td></tr>
                        <tr><td>Review Period:</td><td id="setup-review">Loading...</td></tr>
                        <tr><td>Max Concurrent:</td><td id="setup-concurrent">Loading...</td></tr>
                    </table>
                </div>
            </div>

            <!-- INSIGHTS TAB -->
            <div id="tab-insights" class="tab-panel active">
                <div class="stats-bar">
                    <div class="stat">
                        <span class="stat-label">Validated</span>
                        <span class="stat-value" id="stat-validated">0</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Investigating</span>
                        <span class="stat-value" id="stat-investigating">0</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Total Insights</span>
                        <span class="stat-value" id="stat-insights">0</span>
                    </div>
                </div>

                <div class="filters">
                    <div class="filter-group">
                        <span class="filter-label">Sort:</span>
                        <select id="filter-sort">
                            <option value="overall">Overall Score</option>
                            <option value="novelty">Novelty</option>
                            <option value="actionability">Actionability</option>
                            <option value="strategic">Strategic</option>
                        </select>
                    </div>
                    <div class="filter-group">
                        <span class="filter-label">Search:</span>
                        <input type="text" id="filter-search" placeholder="Filter..." class="w-300">
                    </div>
                </div>

                <div class="section-title">Key Insights</div>
                <table class="clean-table">
                    <thead>
                        <tr>
                            <th class="w-60">#</th>
                            <th>Insight</th>
                            <th class="w-100">Actionable</th>
                            <th class="w-100">Strategic</th>
                            <th class="w-100">Novelty</th>
                            <th class="w-120">Source</th>
                        </tr>
                    </thead>
                    <tbody id="insights-body">
                        <tr><td colspan="6" class="table-loading">Loading...</td></tr>
                    </tbody>
                </table>

                <div class="mt-30">
                    <div class="section-title">Breakthroughs</div>
                    <table class="clean-table">
                        <thead>
                            <tr>
                                <th class="w-80">Cycle</th>
                                <th>Description</th>
                            </tr>
                        </thead>
                        <tbody id="breakthroughs-body">
                            <tr><td colspan="2" class="table-loading">Loading...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- DELIVERABLES TAB -->
            <div id="tab-deliverables" class="tab-panel">
                <div class="stats-bar">
                    <div class="stat">
                        <span class="stat-label">Total</span>
                        <span class="stat-value" id="deliverables-total">0</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Complete</span>
                        <span class="stat-value" id="deliverables-complete">0</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Incomplete</span>
                        <span class="stat-value" id="deliverables-incomplete">0</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Size</span>
                        <span class="stat-value" id="deliverables-size">0 MB</span>
                    </div>
                </div>

                <div class="section-title">Project Artifacts</div>
                <table class="clean-table deliverables-table">
                    <thead>
                        <tr>
                            <th class="w-60">Type</th>
                            <th>Deliverable</th>
                            <th class="w-140">Created</th>
                            <th class="w-120">Agent</th>
                            <th class="w-100">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="deliverables-list">
                        <tr><td colspan="5" class="table-loading">Loading artifacts...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- OPERATIONS TAB -->
            <div id="tab-operations" class="tab-panel">
                <!-- Controls container (populated by JS) -->
                <div id="operations-controls" class="operations-controls">
                    <div class="operations-controls-inner">
                        <div class="operations-control-status" id="control-status">
                            Orchestrator Status: Checking...
                        </div>
                        <div class="operations-control-buttons" id="control-buttons">
                            <!-- Buttons injected here -->
                        </div>
                    </div>
                </div>

                <div class="main-grid">
                    <!-- Left Column -->
                    <div>
                        <div class="section-title">Mission Status</div>
                        <div class="operations-info-box mission">
                            <div class="operations-info-label">CURRENT STRATEGY</div>
                            <div class="operations-info-detail" id="mission-strategy">Loading...</div>
                            <div class="mt-15">
                                <div class="operations-info-label">PROGRESS</div>
                                <div class="operations-info-sub" id="mission-progress">Calculating...</div>
                                <div class="progress-bar mt-4"><div class="progress-fill" style="width: 0%"></div></div>
                            </div>
                        </div>

                        <div class="section-title">Active Agents</div>
                        <div id="operations-agents">
                            <div class="table-loading">Scanning agent swarm...</div>
                        </div>
                    </div>

                    <!-- Right Column -->
                    <div>
                        <div class="section-title">Current Focus</div>
                        <div class="operations-info-box current">
                            <div class="operations-info-label">GOAL</div>
                            <div class="operations-info-detail" id="current-goal">Loading...</div>
                            
                            <div class="mt-20 operations-info-label">LATEST THOUGHT</div>
                            <div class="operations-info-detail" id="latest-thought" style="font-style: italic;">Listening...</div>
                        </div>

                        <div class="section-title">System Resources</div>
                        <div class="operations-knowledge-grid" id="operations-knowledge">
                            <!-- Stats injected here -->
                        </div>
                        
                        <div class="operations-details">
                            <summary>System Diagnostics</summary>
                            <div class="operations-details-content" id="operations-system-details">
                                Loading diagnostics...
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- QUERY TAB -->
            <div id="tab-query" class="tab-panel">
                <div class="info-banner">
                    <div class="info-banner-title">⚠️ Scope: <span id="query-run-name-main" class="text-mono"></span></div>
                    <p class="info-banner-text">Interrogate the system's specific run memory and logs.</p>
                </div>

                <div class="grid-2 gap-20">
                    <div>
                        <textarea id="query-input" placeholder="Ask COSMO a question..." class="form-textarea" style="min-height: 150px; font-size: 14px;"></textarea>
                        
                        <div class="mt-15 d-flex gap-10">
                            <button onclick="executeQuery()" class="btn btn-primary">Execute Query</button>
                            <button onclick="clearQuery()" class="btn btn-secondary">Clear</button>
                        </div>
                    </div>
                    
                    <div>
                        <div class="form-group">
                            <label class="form-label">Model & Mode</label>
                            <div class="d-flex gap-10">
                                <select id="query-model" class="form-select">
                                    <option value="gpt-5.1" selected>GPT-5.1 (Default)</option>
                                    <option value="gpt-5.2">GPT-5.2 (Deep)</option>
                                    <option value="gpt-5-mini">GPT-5 Mini (Fast)</option>
                                </select>
                                <select id="query-mode" class="form-select">
                                    <option value="normal" selected>Normal</option>
                                    <option value="executive">Executive Brief</option>
                                    <option value="innovation">Innovation</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Enhancements</label>
                            <div class="d-flex gap-15 flex-wrap">
                                <label class="d-flex align-items-center gap-6 font-12"><input type="checkbox" id="evidence-check"> Evidence</label>
                                <label class="d-flex align-items-center gap-6 font-12"><input type="checkbox" id="synthesis-check" checked> Synthesis</label>
                                <label class="d-flex align-items-center gap-6 font-12"><input type="checkbox" id="coordinator-check" checked> Coordinator</label>
                                <label class="d-flex align-items-center gap-6 font-12"><input type="checkbox" id="include-files-check" checked> Output Files</label>
                            </div>
                        </div>

                        <div class="action-panel">
                            <div class="action-panel-title">⚡ Direct Intervention</div>
                            <div class="action-controls">
                                <select id="action-type" class="form-select" style="width: 140px;">
                                    <option value="">-- Action --</option>
                                    <option value="spawn_research">Spawn Research</option>
                                    <option value="spawn_code_creation">Generate Code</option>
                                    <option value="create_goal">Set Goal</option>
                                </select>
                                <input type="text" id="action-input" placeholder="Parameters..." class="form-input">
                                <button onclick="executeAction()" class="btn-sm btn-primary">Run</button>
                            </div>
                        </div>
                        
                        <div class="export-controls mt-15">
                            <label>Export:</label>
                            <select id="export-format" class="form-select">
                                <option value="none">None</option>
                                <option value="markdown">Markdown</option>
                                <option value="html">HTML</option>
                                <option value="json">JSON</option>
                            </select>
                            <button onclick="exportLastResult()" id="export-btn" disabled class="btn-sm btn-secondary cursor-not-allowed">Export</button>
                            <button onclick="executeAsExecutive()" id="exec-view-btn" class="btn-sm btn-secondary" disabled>📊 Exec View</button>
                        </div>
                    </div>
                </div>

                <div id="query-loading" class="d-none loading mt-20">
                    <div class="spinner"></div>
                    <div class="font-13">Processing Query...</div>
                </div>
                
                <div id="query-results" class="mt-20 d-none"></div>
                
                <div id="query-history-section" class="mt-30 d-none">
                    <div class="section-title">History</div>
                    <table class="clean-table">
                        <tbody id="query-history-body"></tbody>
                    </table>
                </div>
            </div>

            <!-- MEMORY TAB -->
            <div id="tab-memory" class="tab-panel">
                <div class="memory-controls">
                    <div class="memory-search-row">
                        <div class="memory-search-box">
                            <input type="text" id="memory-search" placeholder="Search concepts..." onkeyup="searchMemoryGraph()">
                        </div>
                        <div class="memory-actions">
                            <button class="memory-filter-btn active" data-filter="all" onclick="setMemoryFilter('all')">
                                All <span id="memory-count-all" class="filter-count">0</span>
                            </button>
                            <button class="memory-filter-btn" data-filter="high-activation" onclick="setMemoryFilter('high-activation')">
                                Active <span id="memory-count-high" class="filter-count">0</span>
                            </button>
                            <button class="memory-filter-btn" data-filter="agent" onclick="setMemoryFilter('agent')">
                                Agents <span id="memory-count-agent" class="filter-count">0</span>
                            </button>
                        </div>
                    </div>
                    
                    <div class="memory-toggles">
                        <label><input type="checkbox" id="memory-show-labels" onchange="toggleMemoryLabels(this.checked)"> Show Labels</label>
                        <label><input type="checkbox" id="memory-show-clusters" onchange="toggleMemoryClusters(this.checked)"> Color Clusters</label>
                    </div>
                </div>
                
                <div class="memory-graph-container">
                    <svg id="memory-network-svg"></svg>
                    <div class="memory-zoom-controls">
                        <button class="memory-zoom-btn" onclick="zoomMemoryIn()">+</button>
                        <button class="memory-zoom-btn" onclick="zoomMemoryOut()">−</button>
                        <button class="memory-zoom-btn" onclick="fitMemoryNetwork()">⛶</button>
                    </div>
                </div>
                
                <div id="memory-breadcrumb" class="mt-10 font-11 text-secondary" style="min-height: 20px;"></div>
                
                <div id="memory-stats" class="memory-stats-panel">
                    <div class="memory-stats-title">NETWORK METRICS</div>
                    <div class="memory-stats-grid">
                        <div class="memory-stat-card">
                            <div class="memory-stat-label">NODES</div>
                            <div class="memory-stat-value" id="memory-stat-nodes">0</div>
                        </div>
                        <div class="memory-stat-card">
                            <div class="memory-stat-label">EDGES</div>
                            <div class="memory-stat-value" id="memory-stat-edges">0</div>
                        </div>
                        <div class="memory-stat-card">
                            <div class="memory-stat-label">CLUSTERS</div>
                            <div class="memory-stat-value" id="memory-stat-clusters">0</div>
                        </div>
                        <div class="memory-stat-card">
                            <div class="memory-stat-label">ACTIVATION</div>
                            <div class="memory-stat-value" id="memory-stat-activation">0.00</div>
                        </div>
                        <div class="memory-stat-card">
                            <div class="memory-stat-label">SELECTED</div>
                            <div class="memory-stat-value" id="memory-stat-selected" style="font-size: 14px;">None</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- GOALS TAB -->
            <div id="tab-goals" class="tab-panel">
                <div class="filters">
                    <div class="filter-group">
                        <select id="filter-goal-status">
                            <option value="all">All Statuses</option>
                            <option value="active" selected>Active</option>
                            <option value="completed">Completed</option>
                            <option value="archived">Archived</option>
                        </select>
                        <input type="text" id="filter-goal-search" placeholder="Search goals..." class="w-300 form-input">
                    </div>
                </div>
                <div id="goals-container">
                    <div class="table-loading">Loading goals...</div>
                </div>
            </div>

            <!-- THOUGHTS TAB -->
            <div id="tab-thoughts" class="tab-panel">
                <div class="filters">
                    <div class="filter-group">
                        <select id="filter-thought-role">
                            <option value="all">All Roles</option>
                            <option value="orchestrator">Orchestrator</option>
                            <option value="coordinator">Coordinator</option>
                            <option value="analyst">Analyst</option>
                            <option value="researcher">Researcher</option>
                        </select>
                        <input type="text" id="filter-thought-search" placeholder="Search thoughts..." class="w-300 form-input">
                    </div>
                </div>
                <div id="thoughts-container">
                    <div class="table-loading">Loading stream of consciousness...</div>
                </div>
            </div>

            <!-- TRAJECTORY TAB -->
            <div id="tab-trajectory" class="tab-panel">
                <div class="section-title">Research Phases</div>
                <table id="trajectory-table" class="clean-table">
                    <thead>
                        <tr>
                            <th class="w-80">Phase</th>
                            <th class="w-200">Name</th>
                            <th class="w-120">Cycles</th>
                            <th>Description</th>
                        </tr>
                    </thead>
                    <tbody id="trajectory-body">
                        <tr><td colspan="4" class="table-loading">Loading...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- PERFORMANCE TAB -->
            <div id="tab-performance" class="tab-panel">
                <div class="section-title">Agent Impact</div>
                <table class="clean-table">
                    <thead>
                        <tr>
                            <th class="w-60">Rank</th>
                            <th>Agent Type</th>
                            <th class="w-100">Runs</th>
                            <th class="w-100">Success</th>
                            <th class="w-120">Avg Duration</th>
                            <th class="w-100">Insights</th>
                            <th>Best Use Case</th>
                        </tr>
                    </thead>
                    <tbody id="performance-body">
                        <tr><td colspan="7" class="table-loading">Loading...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- DREAMS TAB -->
            <div id="tab-dreams" class="tab-panel">
                <div class="dreams-stats">
                    <div class="dream-stat-card">
                        <div class="dream-stat-value" id="dream-stat-total">0</div>
                        <div class="dream-stat-label">Total Dreams</div>
                    </div>
                    <div class="dream-stat-card" style="border-color: #f39c12;">
                        <div class="dream-stat-value text-warning" id="dream-stat-narratives">0</div>
                        <div class="dream-stat-label">Narratives</div>
                    </div>
                    <div class="dream-stat-card">
                        <div class="dream-stat-value" id="dream-stat-goals">0</div>
                        <div class="dream-stat-label">Dream Goals</div>
                    </div>
                    <div class="dream-stat-card">
                        <div class="dream-stat-value" id="dream-stat-memory">0</div>
                        <div class="dream-stat-label">In Memory</div>
                    </div>
                    <div class="dream-stat-card">
                        <div class="dream-stat-value" id="dream-stat-completed">0</div>
                        <div class="dream-stat-label">Completed</div>
                    </div>
                </div>
                <div class="section-title mt-20">Dream Journal</div>
                <div class="dreams-grid" id="dreams-grid">
                    <div class="dreams-empty">No dreams yet.</div>
                </div>
            </div>

            <!-- REPORTS TAB -->
            <div id="tab-reports" class="tab-panel">
                <div class="section-title">Coordinator Reviews</div>
                <table class="clean-table">
                    <thead>
                        <tr>
                            <th class="w-200">Review File</th>
                            <th class="w-80">Cycles</th>
                            <th class="w-80">Goals</th>
                            <th class="w-80">Depth</th>
                            <th class="w-80">Novelty</th>
                            <th class="w-80">Coherence</th>
                            <th class="w-80">Action</th>
                        </tr>
                    </thead>
                    <tbody id="reviews-body">
                        <tr><td colspan="7" class="table-loading">Loading reports...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- TERMINAL TAB -->
            <div id="tab-terminal" class="tab-panel">
                <div class="console-header">
                    <div class="console-title">System Logs</div>
                    <div class="console-controls">
                        <span id="console-status" class="console-status">● Connecting...</span>
                        <select id="log-level-filter" class="form-select" onchange="filterLogs()" style="width: 100px;">
                            <option value="all">All Levels</option>
                            <option value="info">Info</option>
                            <option value="warn">Warn</option>
                            <option value="error">Error</option>
                        </select>
                        <button class="btn-sm btn-secondary" onclick="toggleAutoScroll()" id="autoscroll-btn">Auto-scroll: ON</button>
                        <button class="btn-sm btn-secondary" onclick="clearConsole()">Clear</button>
                    </div>
                </div>
                <div class="console-container" id="console-container">
                    <div id="console-output"></div>
                </div>
            </div>

        </div><!-- end content-wrapper -->
    </main>
</div><!-- end app-layout -->

<!-- Modals and Overlays -->
<div id="markdown-viewer" class="markdown-viewer">
    <div class="markdown-viewer-header">
        <h2 id="md-viewer-title" style="color: #c9d1d9; font-size: 18px;">Document</h2>
        <div class="markdown-viewer-actions">
            <button class="btn-sm btn-secondary" onclick="closeMarkdownViewer()">Close</button>
        </div>
    </div>
    <div class="markdown-viewer-body">
        <aside class="markdown-toc" id="markdown-toc">
            <h3>Contents</h3>
        </aside>
        <div id="markdown-content" class="markdown-content"></div>
    </div>
</div>

<!-- File Browser Modal -->
<div id="file-browser-modal" class="file-browser-modal">
    <div class="file-browser-content">
        <div class="file-browser-header">
            <h3 class="file-browser-title" id="file-browser-title">Files</h3>
            <button onclick="closeFileBrowser()" class="btn-sm btn-secondary">Close</button>
        </div>
        <div class="file-browser-body">
            <div id="file-tree" class="file-tree"></div>
        </div>
    </div>
</div>

<!-- Memory Detail Panel -->
<div id="memory-detail-panel" class="memory-detail-panel">
    <div class="memory-detail-header">
        <button class="memory-detail-close" onclick="closeMemoryDetail()">×</button>
        <div class="memory-detail-concept" id="mem-detail-name">Concept</div>
        <div class="memory-detail-type" id="mem-detail-type">Type</div>
    </div>
    <div class="memory-detail-content" id="memory-detail-content"></div>
</div>

<!-- Tooltip -->
<div id="memory-tooltip" class="memory-tooltip">
    <div class="memory-tooltip-concept" id="memory-tooltip-concept"></div>
    <div class="memory-tooltip-metrics" id="memory-tooltip-metrics"></div>
    <div class="memory-tooltip-connections" id="memory-tooltip-connections"></div>
</div>

<!-- SCRIPTS -->
<script src="utils/api.js"></script>
<script src="utils/formatters.js"></script>
<script src="utils/response-formatter.js"></script>
<script>
\${originalScript}
</script>
</body>
</html>`;

// Write the new content back to the file
fs.writeFileSync(filePath, newHtml, 'utf8');
console.log('Successfully applied dashboard redesign.');

