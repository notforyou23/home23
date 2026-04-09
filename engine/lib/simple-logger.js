/**
 * Enhanced Console Logger with TUI Support
 * Always on by default, opt-out with COSMO_TUI=false
 * Non-breaking - falls back gracefully if libraries unavailable
 */

class SimpleLogger {
  constructor(level = 'info') {
    this.level = level;
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    
    // TUI enhancement (always on unless explicitly disabled)
    this.tuiEnabled = process.env.COSMO_TUI !== 'false';
    this.splitScreenEnabled = process.env.COSMO_TUI_SPLIT === 'true';
    
    // Load TUI libraries with graceful fallback
    this.chalk = null;
    this.ora = null;
    this.Table = null;
    
    if (this.tuiEnabled) {
      try {
        this.chalk = require('chalk');
        this.ora = require('ora');
        this.Table = require('cli-table3');
      } catch (e) {
        // Graceful fallback - TUI disabled if libraries not available
        this.tuiEnabled = false;
      }
    }
    
    // Active spinners tracking
    this.activeSpinners = new Map();
    
    // TUI Dashboard (optional split-screen)
    this.dashboard = null;
    
    // Web Dashboard (for console streaming)
    this.webDashboard = null;
    
    // Statistics for dashboard
    this.stats = {
      totalLogs: 0,
      errors: 0,
      warnings: 0,
      infos: 0
    };
  }

  /**
   * Attach TUI dashboard for split-screen mode
   */
  attachDashboard(dashboard) {
    this.dashboard = dashboard;
    if (this.dashboard) {
      this.splitScreenEnabled = true;
    }
  }

  /**
   * Attach web dashboard for console streaming
   */
  attachWebDashboard(webDashboard) {
    this.webDashboard = webDashboard;
  }

  shouldLog(level) {
    return this.levels[level] >= this.levels[this.level];
  }

  /**
   * Format message for plain text output (fallback)
   */
  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
  }

  /**
   * Format message with colors (TUI mode)
   */
  formatMessageTUI(level, message, meta = {}) {
    if (!this.chalk) {
      return this.formatMessage(level, message, meta);
    }
    
    const timestamp = new Date().toISOString();
    const timeColor = this.chalk.gray(`[${timestamp.substring(11, 19)}]`);
    
    let levelColor;
    switch (level) {
      case 'debug':
        levelColor = this.chalk.gray('DEBUG');
        break;
      case 'info':
        levelColor = this.chalk.cyan('INFO');
        break;
      case 'warn':
        levelColor = this.chalk.yellow('WARN');
        break;
      case 'error':
        levelColor = this.chalk.red('ERROR');
        break;
      default:
        levelColor = level.toUpperCase();
    }
    
    // Detect and colorize special markers in message
    let coloredMessage = message;
    if (this.chalk) {
      // Colorize emojis and special markers
      coloredMessage = message
        .replace(/✅/g, this.chalk.green('✅'))
        .replace(/❌/g, this.chalk.red('❌'))
        .replace(/⚠️/g, this.chalk.yellow('⚠️'))
        .replace(/🚀/g, this.chalk.cyan('🚀'))
        .replace(/🧠/g, this.chalk.magenta('🧠'))
        .replace(/🤖/g, this.chalk.blue('🤖'))
        .replace(/🎯/g, this.chalk.yellow('🎯'))
        .replace(/💭/g, this.chalk.gray('💭'))
        .replace(/🔍/g, this.chalk.cyan('🔍'))
        .replace(/⚡/g, this.chalk.yellow('⚡'))
        .replace(/💡/g, this.chalk.yellow('💡'))
        .replace(/🌐/g, this.chalk.blue('🌐'))
        .replace(/🏁/g, this.chalk.green('🏁'))
        .replace(/═══/g, this.chalk.cyan('═══'));
    }
    
    // Format meta data
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      if (this.chalk) {
        metaStr = ' ' + this.chalk.gray(JSON.stringify(meta));
      } else {
        metaStr = ' ' + JSON.stringify(meta);
      }
    }
    
    return `${timeColor} ${levelColor}: ${coloredMessage}${metaStr}`;
  }

  /**
   * Check if message should use spinner
   */
  isSpinnerMessage(message) {
    const spinnerPhrases = [
      'Loading', 'Processing', 'Generating', 'Analyzing', 'Searching',
      'Building', 'Creating', 'Compiling', 'Executing', 'Running',
      'Initializing', 'Starting', 'Waiting', 'Fetching'
    ];
    
    return spinnerPhrases.some(phrase => 
      message.toLowerCase().includes(phrase.toLowerCase())
    );
  }

  /**
   * Start a spinner for long operations
   */
  startSpinner(key, message) {
    if (!this.tuiEnabled || !this.ora || this.splitScreenEnabled) {
      return null;
    }
    
    // Stop any existing spinner with this key
    if (this.activeSpinners.has(key)) {
      this.activeSpinners.get(key).stop();
    }
    
    const spinner = this.ora({
      text: message,
      color: 'cyan'
    }).start();
    
    this.activeSpinners.set(key, spinner);
    return spinner;
  }

  /**
   * Stop a spinner
   */
  stopSpinner(key, success = true, finalMessage = null) {
    if (!this.activeSpinners.has(key)) {
      return;
    }
    
    const spinner = this.activeSpinners.get(key);
    if (finalMessage) {
      spinner.text = finalMessage;
    }
    
    if (success) {
      spinner.succeed();
    } else {
      spinner.fail();
    }
    
    this.activeSpinners.delete(key);
  }

  /**
   * Create a table
   */
  createTable(options = {}) {
    if (!this.tuiEnabled || !this.Table) {
      return null;
    }
    
    return new this.Table({
      style: { head: [], border: ['gray'] },
      ...options
    });
  }

  debug(message, meta) {
    if (!this.shouldLog('debug')) return;
    
    this.stats.totalLogs++;
    
    // Send to web dashboard if available
    if (this.webDashboard) {
      this.webDashboard.broadcastLog('debug', message, meta || {});
    }
    
    // Send to TUI dashboard if available
    if (this.dashboard) {
      this.dashboard.addLog('debug', message, meta);
      return; // Dashboard handles display
    }
    
    // TUI mode
    if (this.tuiEnabled) {
      console.log(this.formatMessageTUI('debug', message, meta));
    } else {
      console.log(this.formatMessage('debug', message, meta));
    }
  }

  info(message, meta) {
    if (!this.shouldLog('info')) return;
    
    this.stats.totalLogs++;
    this.stats.infos++;
    
    // Send to web dashboard if available
    if (this.webDashboard) {
      this.webDashboard.broadcastLog('info', message, meta || {});
    }
    
    // Send to TUI dashboard if available
    if (this.dashboard) {
      this.dashboard.addLog('info', message, meta);
      return; // Dashboard handles display
    }
    
    // TUI mode with enhanced formatting
    if (this.tuiEnabled) {
      console.log(this.formatMessageTUI('info', message, meta));
    } else {
      console.log(this.formatMessage('info', message, meta));
    }
  }

  warn(message, meta) {
    if (!this.shouldLog('warn')) return;
    
    this.stats.totalLogs++;
    this.stats.warnings++;
    
    // Send to web dashboard if available
    if (this.webDashboard) {
      this.webDashboard.broadcastLog('warn', message, meta || {});
    }
    
    // Send to TUI dashboard if available
    if (this.dashboard) {
      this.dashboard.addLog('warn', message, meta);
      return; // Dashboard handles display
    }
    
    // TUI mode
    if (this.tuiEnabled) {
      console.warn(this.formatMessageTUI('warn', message, meta));
    } else {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message, meta) {
    if (!this.shouldLog('error')) return;
    
    this.stats.totalLogs++;
    this.stats.errors++;
    
    // Send to web dashboard if available
    if (this.webDashboard) {
      this.webDashboard.broadcastLog('error', message, meta || {});
    }
    
    // Send to TUI dashboard if available
    if (this.dashboard) {
      this.dashboard.addLog('error', message, meta);
      return; // Dashboard handles display
    }
    
    // TUI mode
    if (this.tuiEnabled) {
      console.error(this.formatMessageTUI('error', message, meta));
    } else {
      console.error(this.formatMessage('error', message, meta));
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Check if TUI is enabled
   */
  isTUIEnabled() {
    return this.tuiEnabled;
  }

  /**
   * Check if split-screen dashboard is active
   */
  hasDashboard() {
    return this.dashboard !== null;
  }
}

module.exports = { SimpleLogger };
