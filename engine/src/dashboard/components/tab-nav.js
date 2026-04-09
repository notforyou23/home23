/**
 * TabNav Component
 * Manages tab navigation with URL routing
 */
class TabNav {
  constructor(containerSelector, tabs, options = {}) {
    this.container = document.querySelector(containerSelector);
    this.tabs = tabs; // Array of { id, label }
    this.currentTab = null;
    this.onTabChange = options.onTabChange || (() => {});
    
    if (!this.container) {
      console.error(`TabNav container not found: ${containerSelector}`);
      return;
    }
    
    this.render();
    this.setupURLHandler();
    
    // Load initial tab from URL or default to first tab
    const urlTab = this.getTabFromURL();
    const initialTab = urlTab || tabs[0].id;
    this.switchTo(initialTab);
  }
  
  render() {
    const nav = document.createElement('nav');
    nav.className = 'tab-nav';
    
    this.tabs.forEach(tab => {
      const button = document.createElement('button');
      button.className = 'tab-btn';
      button.dataset.tab = tab.id;
      button.textContent = tab.label;
      button.addEventListener('click', () => this.switchTo(tab.id));
      nav.appendChild(button);
    });
    
    this.container.appendChild(nav);
  }
  
  switchTo(tabId) {
    if (this.currentTab === tabId) return;
    
    // Hide all panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    
    // Remove active from all buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    
    // Show selected panel
    const panel = document.getElementById(`tab-${tabId}`);
    if (panel) {
      panel.classList.add('active');
    }
    
    // Set active button
    const button = document.querySelector(`[data-tab="${tabId}"]`);
    if (button) {
      button.classList.add('active');
    }
    
    // Update URL
    this.updateURL(tabId);
    
    // Update state
    this.currentTab = tabId;
    
    // Call callback
    this.onTabChange(tabId);
  }
  
  updateURL(tabId) {
    const url = new URL(window.location);
    url.searchParams.set('tab', tabId);
    window.history.pushState({}, '', url);
  }
  
  getTabFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('tab');
  }
  
  setupURLHandler() {
    // Handle back/forward navigation
    window.addEventListener('popstate', () => {
      const tab = this.getTabFromURL();
      if (tab && this.tabs.find(t => t.id === tab)) {
        this.switchTo(tab);
      }
    });
  }
  
  getActiveTab() {
    return this.currentTab;
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TabNav;
}

