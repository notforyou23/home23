/**
 * COSMO Clean & Elegant TUI
 * Simple, focused log viewer with status bar and controls
 * Not cluttered - just what you need to see
 */

const blessed = require('blessed');
const { TUIRenderer } = require('./tui-renderer');

class TUIDashboard {
  constructor(logger) {
    this.logger = logger;
    this.renderer = new TUIRenderer();
    
    // State
    this.currentCycle = 0;
    this.currentRole = null;
    this.oscillatorMode = 'active';
    this.cognitiveState = {};
    this.memoryNodes = 0;
    this.memoryEdges = 0;
    this.activeAgentCount = 0;
    this.goalsCreated = 0;
    this.goalsPursued = 0;
    this.isPaused = false;
    this.startTime = Date.now();
    this.errorCount = 0;
    
    // Log buffer
    this.logBuffer = [];
    this.maxLogs = 1000;
    
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'COSMO - Autonomous Research Brain',
      fullUnicode: true,
      dockBorders: true,
      // Don't use alternate screen - stay in main buffer so logs remain after exit
      forceUnicode: true,
      // Leave cursor at bottom on exit
      cursor: {
        artificial: false,
        shape: 'line',
        blink: true,
        color: null
      }
    });
    
    this.setupLayout();
    this.setupKeyboardControls();
    this.startUpdateLoop();
  }

  /**
   * Setup clean layout: status bar + log viewer + controls
   */
  setupLayout() {
    // Top status bar - single line with key stats
    this.statusBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue'
      }
    });

    // Main log viewer - scrollable console output
    this.logBox = blessed.log({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        border: { fg: 'cyan' }
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '█',
        track: {
          bg: 'black'
        },
        style: {
          inverse: false,
          bg: 'cyan'
        }
      },
      mouse: true,
      keys: true,
      vi: true
    });

    // Bottom controls bar
    this.controlsBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        fg: 'white',
        bg: 'black'
      },
      content: ' {cyan-fg}[Space]{/cyan-fg} Pause  {cyan-fg}[↑↓]{/cyan-fg} Scroll  {cyan-fg}[Home/End]{/cyan-fg} Jump  {cyan-fg}[Q]{/cyan-fg} Quit  {cyan-fg}[H]{/cyan-fg} Help '
    });

    // Help overlay (hidden by default)
    this.helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 16,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
        bg: 'black'
      },
      tags: true,
      hidden: true,
      label: ' {bold}COSMO TUI Help{/bold} '
    });

    const helpContent = `
{bold}{cyan-fg}Keyboard Controls:{/cyan-fg}{/bold}

  {bold}Space{/bold}       Pause/Resume cognitive loop
  {bold}↑/↓{/bold}         Scroll through logs
  {bold}Page Up/Dn{/bold}  Fast scroll
  {bold}Home/End{/bold}    Jump to top/bottom
  {bold}H or ?{/bold}      Toggle this help
  {bold}Q{/bold}           Quit (with confirmation)
  {bold}Ctrl+C{/bold}      Force quit

{gray-fg}Press any key to close this help...{/gray-fg}
`;
    
    this.helpBox.setContent(helpContent);

    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Setup keyboard controls
   */
  setupKeyboardControls() {
    // Quit
    this.screen.key(['q', 'Q'], () => {
      this.showConfirmQuit();
    });

    // Force quit
    this.screen.key(['C-c'], () => {
      this.cleanup();
      process.exit(0);
    });

    // Pause/Resume
    this.screen.key(['space'], () => {
      this.togglePause();
    });

    // Help
    this.screen.key(['h', 'H', '?'], () => {
      this.toggleHelp();
    });

    // Close help
    this.helpBox.key(['escape', 'q', 'enter', 'space', 'h'], () => {
      this.helpBox.hide();
      this.screen.render();
    });

    // Scroll controls (handled by blessed.log automatically)
    // Arrow keys, Page Up/Down, Home/End work out of the box
  }

  /**
   * Update status bar with current stats
   */
  updateStatusBar() {
    const uptime = this.renderer.formatDuration(Date.now() - this.startTime);
    const status = this.isPaused ? '{black-bg}{yellow-fg} PAUSED {/yellow-fg}{/black-bg}' : '{black-bg}{green-fg} RUNNING {/green-fg}{/black-bg}';
    const errors = this.errorCount > 0 ? ` {red-fg}${this.errorCount} errors{/red-fg}` : '';
    
    const content = ` {bold}COSMO{/bold} • Cycle ${this.currentCycle} • ${status} • ${this.oscillatorMode.toUpperCase()} • ${uptime} • ${this.memoryNodes} nodes • ${this.activeAgentCount} agents${errors} `;
    
    this.statusBar.setContent(content);
  }

  /**
   * Add log entry
   */
  addLog(level, message, meta = {}) {
    // Track errors
    if (level === 'error') {
      this.errorCount++;
    }
    
    // Format the log entry
    const timestamp = new Date().toISOString().substring(11, 19);
    
    // Color code by level
    let levelColor;
    switch (level) {
      case 'debug':
        levelColor = '{gray-fg}DEBUG{/gray-fg}';
        break;
      case 'info':
        levelColor = '{cyan-fg}INFO{/cyan-fg}';
        break;
      case 'warn':
        levelColor = '{yellow-fg}WARN{/yellow-fg}';
        break;
      case 'error':
        levelColor = '{red-fg}ERROR{/red-fg}';
        break;
      default:
        levelColor = level.toUpperCase();
    }
    
    // Colorize special markers in message
    let coloredMessage = message
      .replace(/✅/g, '{green-fg}✅{/green-fg}')
      .replace(/❌/g, '{red-fg}❌{/red-fg}')
      .replace(/⚠️/g, '{yellow-fg}⚠️{/yellow-fg}')
      .replace(/🚀/g, '{cyan-fg}🚀{/cyan-fg}')
      .replace(/🧠/g, '{magenta-fg}🧠{/magenta-fg}')
      .replace(/🤖/g, '{blue-fg}🤖{/blue-fg}')
      .replace(/🎯/g, '{yellow-fg}🎯{/yellow-fg}')
      .replace(/💭/g, '{gray-fg}💭{/gray-fg}')
      .replace(/🔍/g, '{cyan-fg}🔍{/cyan-fg}')
      .replace(/⚡/g, '{yellow-fg}⚡{/yellow-fg}')
      .replace(/💡/g, '{yellow-fg}💡{/yellow-fg}')
      .replace(/🌐/g, '{blue-fg}🌐{/blue-fg}')
      .replace(/🏁/g, '{green-fg}🏁{/green-fg}')
      .replace(/═══/g, '{cyan-fg}═══{/cyan-fg}');
    
    // Format meta data
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      metaStr = ' {gray-fg}' + JSON.stringify(meta) + '{/gray-fg}';
    }
    
    const logLine = `{gray-fg}[${timestamp}]{/gray-fg} ${levelColor}: ${coloredMessage}${metaStr}`;
    
    // Check scroll position BEFORE adding log
    const wasAtBottom = this.logBox.getScrollPerc() >= 95 || this.logBox.getScroll() === this.logBox.getScrollHeight() - this.logBox.height;
    
    // Add to log box
    this.logBox.log(logLine);
    
    // Update status bar
    this.updateStatusBar();
    
    // Only auto-scroll if user was already at bottom (like normal terminal)
    // This prevents jarring scroll-downs when user is reading older logs
    if (wasAtBottom) {
      this.logBox.setScrollPerc(100);
    }
    // If user scrolled up, they stay where they are
    
    this.screen.render();
  }

  /**
   * Update cycle information
   */
  updateCycle(cycleData) {
    this.currentCycle = cycleData.cycle || this.currentCycle;
    this.currentRole = cycleData.role;
    this.oscillatorMode = cycleData.oscillatorMode || 'active';
    this.cognitiveState = cycleData.cognitiveState || {};
    
    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Update memory statistics
   */
  updateMemory(memoryData) {
    this.memoryNodes = memoryData.nodes || 0;
    this.memoryEdges = memoryData.edges || 0;
    
    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Update goals progress
   */
  updateGoals(goalsData) {
    this.goalsCreated = goalsData.created || 0;
    this.goalsPursued = goalsData.pursued || 0;
    
    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Update agents status
   */
  updateAgents(agents) {
    this.activeAgentCount = agents ? agents.length : 0;
    
    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Toggle pause state
   */
  togglePause() {
    this.isPaused = !this.isPaused;
    
    const message = this.isPaused 
      ? '{black-bg}{yellow-fg} PAUSED {/yellow-fg}{/black-bg} - Press Space to resume'
      : '{black-bg}{green-fg} RESUMED {/green-fg}{/black-bg}';
    
    this.showNotification(message);
    this.updateStatusBar();
    this.screen.render();
  }

  /**
   * Check if paused (orchestrator checks this)
   */
  isPausedState() {
    return this.isPaused;
  }

  /**
   * Toggle help
   */
  toggleHelp() {
    if (this.helpBox.hidden) {
      this.helpBox.show();
      this.helpBox.focus();
    } else {
      this.helpBox.hide();
      this.logBox.focus();
    }
    this.screen.render();
  }

  /**
   * Show quit confirmation
   */
  showConfirmQuit() {
    const confirmBox = blessed.question({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 9,
      border: { type: 'line' },
      style: {
        border: { fg: 'red' },
        fg: 'white',
        bg: 'black'
      },
      tags: true
    });
    
    confirmBox.ask('{red-fg}{bold}Quit COSMO?{/bold}{/red-fg}\n\nThis will stop the cognitive loop.\nA summary will be shown after exit.\n\nContinue? (y/n)', (err, value) => {
      // value can be string, boolean, or undefined - handle all cases
      const answer = value ? String(value).toLowerCase() : '';
      
      if (answer === 'y' || answer === 'yes' || answer === 'true') {
        // Trigger SIGINT for graceful orchestrator shutdown
        process.kill(process.pid, 'SIGINT');
      } else {
        this.screen.render();
      }
    });
  }

  /**
   * Show notification
   */
  showNotification(message) {
    const notifBox = blessed.box({
      parent: this.screen,
      top: 2,
      right: 2,
      width: 50,
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'yellow' },
        bg: 'black'
      },
      tags: true,
      content: ` ${message}`
    });
    
    this.screen.render();
    
    setTimeout(() => {
      notifBox.destroy();
      this.screen.render();
    }, 2000);
  }

  /**
   * Start update loop for status bar
   */
  startUpdateLoop() {
    // Update status bar every second
    setInterval(() => {
      this.updateStatusBar();
      this.screen.render();
    }, 1000);
  }

  /**
   * Render screen
   */
  render() {
    this.screen.render();
  }

  /**
   * Cleanup on exit
   */
  cleanup() {
    if (!this.screen) return;
    
    // Store stats before destroying
    const uptime = this.renderer.formatDuration(Date.now() - this.startTime);
    const stats = {
      cycles: this.currentCycle,
      uptime: uptime,
      nodes: this.memoryNodes,
      edges: this.memoryEdges,
      goalsCreated: this.goalsCreated,
      goalsPursued: this.goalsPursued,
      errors: this.errorCount
    };
    
    // Destroy screen and return to normal terminal
    this.screen.destroy();
    
    // Print plain-text summary AFTER TUI exits (so user sees remnant)
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              COSMO Session Ended                             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Total Cycles: ${stats.cycles}`);
    console.log(`  Uptime: ${stats.uptime}`);
    console.log(`  Memory: ${stats.nodes} nodes, ${stats.edges} edges`);
    console.log(`  Goals: ${stats.goalsCreated} created, ${stats.goalsPursued} pursued`);
    console.log(`  Errors: ${stats.errors}`);
    console.log('');
    console.log(`  Ended: ${new Date().toISOString()}`);
    console.log('');
    console.log('  💾 All data saved in runtime/');
    console.log('  📊 State: runtime/state.json.gz');
    console.log('  💭 Thoughts: runtime/thoughts.jsonl');
    console.log('  📈 Metrics: runtime/evaluation-metrics.json');
    console.log('');
    console.log('  Query your brain: ./ask "your question"');
    console.log('  View metrics: ./ask --metrics');
    console.log('  See timeline: ./ask --timeline');
    console.log('');
  }
}

module.exports = { TUIDashboard };
