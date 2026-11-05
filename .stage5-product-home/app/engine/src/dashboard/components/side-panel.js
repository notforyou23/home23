/**
 * SidePanel Component
 * Sliding panel for detail views
 */
class SidePanel {
  constructor(panelId) {
    this.panel = document.getElementById(panelId);
    this.contentArea = this.panel ? this.panel.querySelector('.side-panel-content') : null;
    this.isOpen = false;
    
    if (!this.panel) {
      console.error(`SidePanel element not found: #${panelId}`);
      return;
    }
    
    this.setupCloseHandlers();
  }
  
  setupCloseHandlers() {
    // Close button
    const closeBtn = this.panel.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    // Click outside to close
    this.panel.addEventListener('click', (e) => {
      if (e.target === this.panel) {
        this.close();
      }
    });
    
    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }
  
  open(content) {
    if (typeof content === 'string') {
      this.setContent(content);
    } else if (content instanceof HTMLElement) {
      this.contentArea.innerHTML = '';
      this.contentArea.appendChild(content);
    }
    
    this.panel.classList.add('open');
    this.isOpen = true;
    document.body.style.overflow = 'hidden'; // Prevent background scroll
  }
  
  close() {
    this.panel.classList.remove('open');
    this.isOpen = false;
    document.body.style.overflow = ''; // Restore scroll
  }
  
  setContent(html) {
    if (this.contentArea) {
      this.contentArea.innerHTML = html;
    }
  }
  
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open('');
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SidePanel;
}

