#!/usr/bin/env node
/**
 * Enhanced dream finder that creates a consolidated, updatable dream database
 * with browsing capabilities
 * 
 * Dreams are stored as:
 * 1. Goals with source='dream_gpt5' or source='dream' in state.json.gz
 * 2. Memory nodes with tag='dream' in state.json.gz
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

const runsDir = path.join(__dirname, '..', 'runs');
const runtimeDir = path.join(__dirname, '..', 'runtime');
const dreamsDbPath = path.join(__dirname, '..', 'dreams_database.json');
const htmlViewerPath = path.join(__dirname, '..', 'dreams_viewer.html');

async function loadState(runPath) {
  const stateFile = path.join(runPath, 'state.json.gz');
  const stateFileUncompressed = path.join(runPath, 'state.json');
  
  try {
    let content;
    if (fs.existsSync(stateFile)) {
      const compressed = fs.readFileSync(stateFile);
      content = await gunzip(compressed);
    } else if (fs.existsSync(stateFileUncompressed)) {
      content = fs.readFileSync(stateFileUncompressed);
    } else {
      return null;
    }
    
    return JSON.parse(content.toString());
  } catch (error) {
    console.error(`  Error loading state for ${runPath}:`, error.message);
    return null;
  }
}

function extractDreams(state) {
  const dreams = {
    fromGoals: [],
    fromMemory: []
  };
  
  // Extract dreams from goals
  if (state.goals) {
    const allGoals = [
      ...(Array.isArray(state.goals.active) ? state.goals.active : []),
      ...(state.goals.completed || []),
      ...(state.goals.archived || [])
    ];
    
    allGoals.forEach(goalEntry => {
      const goal = Array.isArray(goalEntry) ? goalEntry[1] : goalEntry;
      if (!goal) return;
      
      if (goal.source === 'dream_gpt5' || goal.source === 'dream') {
        dreams.fromGoals.push({
          id: goal.id,
          description: goal.description,
          timestamp: goal.created || goal.lastPursued,
          completed: !!goal.completedAt,
          source: goal.source
        });
      }
    });
  }
  
  // Extract dreams from memory nodes
  if (state.memory && state.memory.nodes) {
    state.memory.nodes.forEach(node => {
      if (node.tag === 'dream' || (node.tags && node.tags.includes('dream'))) {
        dreams.fromMemory.push({
          id: node.id,
          concept: node.concept,
          timestamp: node.created || node.accessed,
          activation: node.activation
        });
      }
    });
  }
  
  return dreams;
}

async function loadExistingDreamsDb() {
  try {
    if (fs.existsSync(dreamsDbPath)) {
      const data = JSON.parse(fs.readFileSync(dreamsDbPath, 'utf8'));
      return data;
    }
  } catch (error) {
    console.warn('Could not load existing dreams database:', error.message);
  }
  return { dreams: [], lastScanned: {}, metadata: {} };
}

function shouldScanRun(runName, runPath, existingDb) {
  const lastScanned = existingDb.lastScanned[runName];
  if (!lastScanned) return true;
  
  try {
    const stateFile = path.join(runPath, 'state.json.gz');
    const stateFileUncompressed = path.join(runPath, 'state.json');
    const filePath = fs.existsSync(stateFile) ? stateFile : 
                    fs.existsSync(stateFileUncompressed) ? stateFileUncompressed : null;
    
    if (!filePath) return false;
    
    const stats = fs.statSync(filePath);
    return stats.mtime.getTime() > lastScanned;
  } catch (error) {
    return true; // If we can't check, better to scan
  }
}

async function scanRun(runName, runPath) {
  const state = await loadState(runPath);
  if (!state) return null;
  
  const dreams = extractDreams(state);
  const totalDreams = dreams.fromGoals.length + dreams.fromMemory.length;
  
  if (totalDreams === 0) return null;
  
  // Flatten dreams for the database
  const allDreams = [
    ...dreams.fromGoals.map(d => ({ ...d, runName, type: 'goal' })),
    ...dreams.fromMemory.map(d => ({ ...d, runName, type: 'memory' }))
  ];
  
  return {
    runName,
    runPath,
    dreams: allDreams,
    summary: {
      total: totalDreams,
      fromGoals: dreams.fromGoals.length,
      fromMemory: dreams.fromMemory.length
    }
  };
}

async function updateDreamsDatabase(forceRescan = false) {
  console.log('🔍 Updating dreams database...\n');
  
  const existingDb = forceRescan ? { dreams: [], lastScanned: {}, metadata: {} } : await loadExistingDreamsDb();
  const allDreams = [...existingDb.dreams];
  const runsToScan = [];
  
  // Check which runs need scanning
  console.log('📁 Checking runtime...');
  if (forceRescan || shouldScanRun('runtime', runtimeDir, existingDb)) {
    runsToScan.push({ name: 'runtime', path: runtimeDir });
  }
  
  if (fs.existsSync(runsDir)) {
    const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    console.log(`📁 Checking ${runDirs.length} runs...`);
    
    for (const runName of runDirs) {
      const runPath = path.join(runsDir, runName);
      if (forceRescan || shouldScanRun(runName, runPath, existingDb)) {
        runsToScan.push({ name: runName, path: runPath });
      }
    }
  }
  
  console.log(`\n🔄 Scanning ${runsToScan.length} runs that need updates...\n`);
  
  // Remove existing dreams from runs we're rescanning
  const runsBeingScanned = new Set(runsToScan.map(r => r.name));
  const filteredDreams = allDreams.filter(dream => !runsBeingScanned.has(dream.runName));
  
  // Scan new/changed runs
  let scannedCount = 0;
  for (const { name: runName, path: runPath } of runsToScan) {
    const result = await scanRun(runName, runPath);
    if (result) {
      filteredDreams.push(...result.dreams);
      scannedCount++;
      console.log(`✅ ${runName}: ${result.summary.total} dreams (${result.summary.fromGoals} goals, ${result.summary.fromMemory} memory)`);
    }
  }
  
  // Sort dreams by timestamp (newest first)
  filteredDreams.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  // Update database
  const updatedDb = {
    dreams: filteredDreams,
    lastScanned: { ...existingDb.lastScanned },
    metadata: {
      totalDreams: filteredDreams.length,
      lastUpdated: Date.now(),
      totalRuns: new Set(filteredDreams.map(d => d.runName)).size,
      runsScannedThisUpdate: scannedCount
    }
  };
  
  // Mark scanned runs with current timestamp
  runsToScan.forEach(({ name }) => {
    updatedDb.lastScanned[name] = Date.now();
  });
  
  return updatedDb;
}

function generateHtmlViewer(dreamsDb) {
  const goalDreams = dreamsDb.dreams.filter(d => d.type === 'goal');
  const memoryDreams = dreamsDb.dreams.filter(d => d.type === 'memory');
  const completedDreams = dreamsDb.dreams.filter(d => d.completed);
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>COSMO Dreams Database</title>
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
            background: white; 
            padding: 30px; 
            border-radius: 12px; 
            box-shadow: 0 10px 40px rgba(0,0,0,0.2); 
        }
        .header { 
            text-align: center; 
            margin-bottom: 30px; 
            padding-bottom: 20px;
            border-bottom: 3px solid #667eea;
        }
        .header h1 { 
            margin: 0 0 10px 0; 
            color: #333; 
            font-size: 2.5em;
        }
        .header p { 
            color: #666; 
            margin: 5px 0;
        }
        .stats { 
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px; 
            padding: 20px; 
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-radius: 8px; 
        }
        .stat-item {
            text-align: center;
            padding: 15px;
            background: white;
            border-radius: 6px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .stat-item strong {
            display: block;
            font-size: 2em;
            color: #667eea;
            margin-bottom: 5px;
        }
        .stat-item span {
            color: #666;
            font-size: 0.9em;
        }
        .controls {
            margin-bottom: 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: center;
        }
        .search-box { 
            flex: 1;
            min-width: 300px;
            padding: 12px 15px; 
            border: 2px solid #e1e4e8; 
            border-radius: 6px; 
            font-size: 16px;
            transition: border-color 0.3s;
        }
        .search-box:focus {
            outline: none;
            border-color: #667eea;
        }
        .filter-buttons {
            display: flex;
            gap: 10px;
        }
        .filter-btn {
            padding: 10px 20px;
            border: 2px solid #667eea;
            background: white;
            color: #667eea;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s;
        }
        .filter-btn:hover {
            background: #667eea;
            color: white;
        }
        .filter-btn.active {
            background: #667eea;
            color: white;
        }
        .dream-card { 
            border: 1px solid #e1e4e8; 
            border-left: 4px solid #667eea;
            border-radius: 8px; 
            padding: 20px; 
            margin-bottom: 15px; 
            background: white;
            transition: all 0.3s;
        }
        .dream-card:hover {
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
            transform: translateY(-2px);
        }
        .dream-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 12px; 
            flex-wrap: wrap;
            gap: 10px;
        }
        .dream-type { 
            padding: 4px 12px; 
            border-radius: 12px; 
            font-size: 12px; 
            font-weight: bold;
            text-transform: uppercase;
        }
        .goal { 
            background: #28a745; 
            color: white; 
        }
        .memory { 
            background: #007bff; 
            color: white; 
        }
        .dream-content { 
            line-height: 1.6; 
            color: #333;
            font-size: 1.05em;
        }
        .dream-meta { 
            font-size: 12px; 
            color: #586069; 
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid #e1e4e8;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
        }
        .dream-meta span {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .completed { 
            opacity: 0.7; 
        }
        .completed .dream-content {
            text-decoration: line-through;
        }
        .results-info {
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
            margin-bottom: 20px;
            text-align: center;
            color: #666;
        }
        .no-results {
            text-align: center;
            padding: 60px 20px;
            color: #999;
        }
        .no-results h2 {
            margin: 0 0 10px 0;
        }
        .loader {
            text-align: center;
            padding: 40px;
            color: #667eea;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🛌 COSMO Dreams Database</h1>
            <p><strong>Last updated:</strong> ${new Date(dreamsDb.metadata.lastUpdated).toLocaleString()}</p>
            <p>Exploring the subconscious of COSMO through ${dreamsDb.metadata.totalDreams.toLocaleString()} dreams</p>
        </div>
        
        <div class="stats">
            <div class="stat-item">
                <strong>${dreamsDb.metadata.totalDreams.toLocaleString()}</strong>
                <span>Total Dreams</span>
            </div>
            <div class="stat-item">
                <strong>${dreamsDb.metadata.totalRuns}</strong>
                <span>Runs</span>
            </div>
            <div class="stat-item">
                <strong>${goalDreams.length.toLocaleString()}</strong>
                <span>Goal Dreams</span>
            </div>
            <div class="stat-item">
                <strong>${memoryDreams.length.toLocaleString()}</strong>
                <span>Memory Dreams</span>
            </div>
            <div class="stat-item">
                <strong>${completedDreams.length.toLocaleString()}</strong>
                <span>Completed</span>
            </div>
        </div>
        
        <div class="controls">
            <input type="text" class="search-box" placeholder="🔍 Search dreams by content or run name..." id="searchInput">
            <div class="filter-buttons">
                <button class="filter-btn active" data-filter="all">All</button>
                <button class="filter-btn" data-filter="goal">Goals</button>
                <button class="filter-btn" data-filter="memory">Memory</button>
                <button class="filter-btn" data-filter="completed">Completed</button>
                <button class="filter-btn" data-filter="active">Active</button>
            </div>
        </div>
        
        <div class="results-info" id="resultsInfo"></div>
        
        <div id="dreamsContainer">
            <div class="loader">Loading dreams...</div>
        </div>
    </div>

    <script>
        const searchInput = document.getElementById('searchInput');
        const dreamsContainer = document.getElementById('dreamsContainer');
        const resultsInfo = document.getElementById('resultsInfo');
        const filterButtons = document.querySelectorAll('.filter-btn');
        
        // Load all dreams (chunked for large datasets)
        const allDreams = ${JSON.stringify(dreamsDb.dreams)};
        
        let currentFilter = 'all';
        let currentSearch = '';
        
        function renderDreams(dreams, limit = 100) {
            if (dreams.length === 0) {
                dreamsContainer.innerHTML = \`
                    <div class="no-results">
                        <h2>No dreams found</h2>
                        <p>Try adjusting your search or filter</p>
                    </div>
                \`;
                resultsInfo.textContent = '';
                return;
            }
            
            const displayDreams = dreams.slice(0, limit);
            
            dreamsContainer.innerHTML = displayDreams.map(dream => {
                const content = dream.description || dream.concept || 'No content';
                const date = dream.timestamp ? new Date(dream.timestamp).toLocaleString() : 'No date';
                const source = dream.source || 'unknown';
                
                return \`
                    <div class="dream-card \${dream.completed ? 'completed' : ''}" data-run="\${dream.runName}" data-type="\${dream.type}">
                        <div class="dream-header">
                            <span class="dream-type \${dream.type}">\${dream.type}</span>
                            <span style="color: #666; font-size: 0.9em;">\${dream.runName} • \${date}</span>
                        </div>
                        <div class="dream-content">
                            \${content}
                        </div>
                        <div class="dream-meta">
                            <span>📍 \${dream.id}</span>
                            \${dream.source ? \`<span>🔮 \${dream.source}</span>\` : ''}
                            \${dream.completed ? '<span>✅ Completed</span>' : '<span>⏳ Active</span>'}
                            \${dream.activation ? \`<span>⚡ Activation: \${dream.activation.toFixed(2)}</span>\` : ''}
                        </div>
                    </div>
                \`;
            }).join('');
            
            resultsInfo.innerHTML = \`
                Showing <strong>\${displayDreams.length.toLocaleString()}</strong> of <strong>\${dreams.length.toLocaleString()}</strong> dreams
                \${dreams.length > limit ? \`<br><em>(Limited to first \${limit} for performance)</em>\` : ''}
            \`;
        }
        
        function filterDreams() {
            let filtered = allDreams;
            
            // Apply type filter
            if (currentFilter === 'goal') {
                filtered = filtered.filter(d => d.type === 'goal');
            } else if (currentFilter === 'memory') {
                filtered = filtered.filter(d => d.type === 'memory');
            } else if (currentFilter === 'completed') {
                filtered = filtered.filter(d => d.completed);
            } else if (currentFilter === 'active') {
                filtered = filtered.filter(d => !d.completed);
            }
            
            // Apply search filter
            if (currentSearch) {
                const query = currentSearch.toLowerCase();
                filtered = filtered.filter(dream => 
                    (dream.description || dream.concept || '').toLowerCase().includes(query) ||
                    dream.runName.toLowerCase().includes(query) ||
                    (dream.id || '').toLowerCase().includes(query)
                );
            }
            
            renderDreams(filtered);
        }
        
        // Search handler with debounce
        let searchTimeout;
        searchInput.addEventListener('input', function(e) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                currentSearch = e.target.value;
                filterDreams();
            }, 300);
        });
        
        // Filter button handlers
        filterButtons.forEach(btn => {
            btn.addEventListener('click', function() {
                filterButtons.forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentFilter = this.dataset.filter;
                filterDreams();
            });
        });
        
        // Initial render
        renderDreams(allDreams);
    </script>
</body>
</html>`;
  
  fs.writeFileSync(htmlViewerPath, html);
}

async function main() {
  const args = process.argv.slice(2);
  const forceRescan = args.includes('--force') || args.includes('-f');
  
  if (forceRescan) {
    console.log('🔄 Force rescanning all runs...\n');
  }
  
  const dreamsDb = await updateDreamsDatabase(forceRescan);
  
  // Save consolidated database
  fs.writeFileSync(dreamsDbPath, JSON.stringify(dreamsDb, null, 2));
  
  // Generate HTML viewer
  generateHtmlViewer(dreamsDb);
  
  console.log('\n' + '='.repeat(70));
  console.log('\n📊 DATABASE SUMMARY\n');
  console.log(`Total dreams: ${dreamsDb.metadata.totalDreams.toLocaleString()}`);
  console.log(`From goals: ${dreamsDb.dreams.filter(d => d.type === 'goal').length.toLocaleString()}`);
  console.log(`From memory: ${dreamsDb.dreams.filter(d => d.type === 'memory').length.toLocaleString()}`);
  console.log(`Runs with dreams: ${dreamsDb.metadata.totalRuns}`);
  console.log(`Runs scanned this update: ${dreamsDb.metadata.runsScannedThisUpdate}`);
  
  console.log('\n💾 Files saved:');
  console.log(`  • Database: ${dreamsDbPath}`);
  console.log(`  • HTML Viewer: ${htmlViewerPath}`);
  
  console.log('\n🌐 Open dreams_viewer.html in your browser to browse dreams');
  console.log('\n💡 Usage tips:');
  console.log('  • Run without args for smart incremental updates');
  console.log('  • Use --force or -f to rescan everything');
  console.log('  • Search and filter dreams in the HTML viewer');
  console.log('  • Dreams are sorted by timestamp (newest first)');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});

