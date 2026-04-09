/**
 * Brain Studio - Main Application
 * Initializes all tabs and manages navigation
 */

let currentTab = 'query';

async function init() {
  // Load brain metadata
  const manifest = await fetch('/api/manifest').then(r => r.json());
  const stats = await fetch('/api/stats').then(r => r.json());

  document.getElementById('brainName').textContent = manifest.brain?.displayName || 'Brain Studio';
  document.getElementById('brainStats').textContent = `${stats.nodes.toLocaleString()} nodes · ${stats.edges.toLocaleString()} edges · ${stats.cycles.toLocaleString()} cycles`;
  document.title = `🧠 ${manifest.brain?.name || 'Brain'} - Brain Studio`;

  // Initialize all tabs
  initQueryTab();
  initFilesTab();
  initExploreTab();

  // Setup tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  console.log('✅ Brain Studio initialized');
}

function switchTab(tabName) {
  console.log('[TAB] Switching to:', tabName);
  
  // Update buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `${tabName}-panel`);
  });

  currentTab = tabName;

  // Initialize graph when exploring (simulation is global from explore-tab.js)
  if (tabName === 'explore' && typeof initGraph === 'function') {
    setTimeout(initGraph, 100);
  }
}

// Start app when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
