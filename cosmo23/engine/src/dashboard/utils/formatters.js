/**
 * Formatters
 * Data formatting utilities for display
 */
const Formatters = {
  /**
   * Format duration in milliseconds to human-readable string
   * Examples: "14m 23s", "2h 5m", "5d 8h"
   */
  duration(ms) {
    if (!ms || ms < 0) return '0s';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      const remainingHours = hours % 24;
      return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    
    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }
    
    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    
    return `${seconds}s`;
  },

  /**
   * Format number with commas
   * Example: 1847 → "1,847"
   */
  number(n) {
    if (n === null || n === undefined) return '0';
    return n.toLocaleString();
  },

  /**
   * Format as percentage
   * Example: 0.65 → "65%"
   */
  percent(n, decimals = 0) {
    if (n === null || n === undefined) return '0%';
    return (n * 100).toFixed(decimals) + '%';
  },

  /**
   * Format timestamp to readable date
   * Example: "Oct 27, 14:02"
   */
  date(timestamp, options = {}) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    
    const showTime = options.showTime !== false;
    const showYear = options.showYear || false;
    
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear();
    const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    let formatted = `${month} ${day}`;
    if (showYear) formatted += `, ${year}`;
    if (showTime) formatted += ` ${time}`;
    
    return formatted;
  },

  /**
   * Format relative time
   * Example: "2 hours ago", "3 days ago"
   */
  relativeTime(timestamp) {
    if (!timestamp) return '';
    
    const now = Date.now();
    const date = new Date(timestamp).getTime();
    const diff = now - date;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
  },

  /**
   * Format agent type with icon
   * Example: "ResearchAgent" → "🔍 Research"
   */
  agentType(type) {
    const icons = {
      'ResearchAgent': '🔍',
      'AnalysisAgent': '📊',
      'SynthesisAgent': '🧬',
      'ConsistencyAgent': '⚖️',
      'CodeExecutionAgent': '💻',
      'ExplorationAgent': '🌍',
      'DocumentAnalysisAgent': '📄',
      'CriticAgent': '🔎',
      'CreativeAgent': '🎨'
    };
    
    const icon = icons[type] || '🤖';
    const name = type.replace('Agent', '');
    
    return `${icon} ${name}`;
  },

  /**
   * Format status with badge
   * Example: "completed" → "✅ Done"
   */
  status(status) {
    const badges = {
      'completed': { icon: '✅', text: 'Done', class: 'status-success' },
      'failed': { icon: '❌', text: 'Failed', class: 'status-error' },
      'timeout': { icon: '⏱️', text: 'Timeout', class: 'status-warning' },
      'running': { icon: '⏳', text: 'Running', class: 'status-info' },
      'active': { icon: '🟢', text: 'Active', class: 'status-success' },
      'paused': { icon: '⏸️', text: 'Paused', class: 'status-warning' },
      'error': { icon: '🔴', text: 'Error', class: 'status-error' }
    };
    
    const badge = badges[status] || { icon: '⚪', text: status, class: 'status-default' };
    return `<span class="status-badge ${badge.class}">${badge.icon} ${badge.text}</span>`;
  },

  /**
   * Format file size
   * Example: 1024 → "1 KB"
   */
  fileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  },

  /**
   * Truncate text with ellipsis
   * Example: "Long text..." (max 50 chars)
   */
  truncate(text, maxLength = 50) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  },

  /**
   * Format progress bar
   * Example: 0.65 → "████░░░░░░ 65%"
   */
  progressBar(progress, width = 10) {
    if (progress === null || progress === undefined) return '';
    
    const filled = Math.round(progress * width);
    const empty = width - filled;
    
    return '█'.repeat(filled) + '░'.repeat(empty);
  },

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Formatters;
}

