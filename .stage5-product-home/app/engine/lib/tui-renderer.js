/**
 * TUI Rendering Utilities
 * Helper functions for blessed-based dashboard rendering
 */

const chalk = require('chalk');

class TUIRenderer {
  constructor() {
    this.chalk = chalk;
  }

  /**
   * Create a sparkline for time series data
   */
  createSparkline(data, width = 40) {
    if (!data || data.length === 0) return ' '.repeat(width);
    
    const bars = '▁▂▃▄▅▆▇█';
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min;
    
    if (range === 0) {
      return bars[4].repeat(Math.min(data.length, width));
    }
    
    return data
      .slice(-width)
      .map(val => {
        const normalized = (val - min) / range;
        const index = Math.floor(normalized * (bars.length - 1));
        return bars[index];
      })
      .join('');
  }

  /**
   * Create a progress bar
   */
  createProgressBar(percent, width = 20, style = 'default') {
    const filled = Math.floor((percent / 100) * width);
    const empty = width - filled;
    
    let fillChar, emptyChar, color;
    
    switch (style) {
      case 'blocks':
        fillChar = '█';
        emptyChar = '░';
        break;
      case 'smooth':
        fillChar = '▓';
        emptyChar = '░';
        break;
      default:
        fillChar = '█';
        emptyChar = '░';
    }
    
    // Color based on percentage
    if (percent >= 75) {
      color = this.chalk.green;
    } else if (percent >= 50) {
      color = this.chalk.yellow;
    } else if (percent >= 25) {
      color = this.chalk.orange || this.chalk.yellow;
    } else {
      color = this.chalk.red;
    }
    
    const bar = color(fillChar.repeat(filled)) + this.chalk.gray(emptyChar.repeat(empty));
    return `${bar} ${percent.toFixed(0)}%`;
  }

  /**
   * Format duration
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Truncate text with ellipsis
   */
  truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Color code by role
   */
  colorizeRole(role) {
    if (!this.chalk) return role;
    
    const roleColors = {
      analyst: this.chalk.cyan,
      critic: this.chalk.yellow,
      curiosity: this.chalk.magenta,
      explorer: this.chalk.blue,
      synthesizer: this.chalk.green
    };
    
    const colorFn = roleColors[role] || this.chalk.white;
    return colorFn(role);
  }

  /**
   * Color code by agent type
   */
  colorizeAgentType(type) {
    if (!this.chalk) return type;
    
    const typeColors = {
      research: this.chalk.blue,
      analysis: this.chalk.cyan,
      synthesis: this.chalk.green,
      exploration: this.chalk.magenta,
      code_execution: this.chalk.yellow,
      quality_assurance: this.chalk.red,
      planning: this.chalk.blue,
      integration: this.chalk.cyan
    };
    
    const colorFn = typeColors[type] || this.chalk.white;
    return colorFn(type);
  }

  /**
   * Format a number with units
   */
  formatNumber(num, decimals = 0) {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(decimals)}M`;
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(decimals)}K`;
    }
    return num.toFixed(decimals);
  }

  /**
   * Create a mini bar chart
   */
  createMiniBarChart(value, max, width = 10) {
    const filled = Math.floor((value / max) * width);
    const empty = width - filled;
    return this.chalk.cyan('█'.repeat(filled)) + this.chalk.gray('░'.repeat(empty));
  }

  /**
   * Colorize status
   */
  colorizeStatus(status) {
    if (!this.chalk) return status;
    
    const statusMap = {
      completed: this.chalk.green(status),
      running: this.chalk.yellow(status),
      failed: this.chalk.red(status),
      timeout: this.chalk.red(status),
      initialized: this.chalk.gray(status),
      active: this.chalk.green(status),
      paused: this.chalk.yellow(status),
      sleeping: this.chalk.blue(status)
    };
    
    return statusMap[status] || this.chalk.white(status);
  }

  /**
   * Create a box for important messages
   */
  createBox(title, content, color = 'cyan') {
    if (!this.chalk) {
      return `\n${title}\n${'='.repeat(title.length)}\n${content}\n`;
    }
    
    const colorFn = this.chalk[color] || this.chalk.cyan;
    const width = 70;
    const border = colorFn('─'.repeat(width));
    
    return `\n${colorFn('╭' + border + '╮')}\n${colorFn('│')} ${colorFn.bold(title.padEnd(width - 2))} ${colorFn('│')}\n${colorFn('├' + border + '┤')}\n${this.wrapText(content, width - 4).map(line => `${colorFn('│')}  ${line.padEnd(width - 3)} ${colorFn('│')}`).join('\n')}\n${colorFn('╰' + border + '╯')}\n`;
  }

  /**
   * Wrap text to fit width
   */
  wrapText(text, width) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      if ((currentLine + word).length > width) {
        if (currentLine) lines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine += word + ' ';
      }
    }
    
    if (currentLine) lines.push(currentLine.trim());
    return lines;
  }

  /**
   * Color-code numeric values
   */
  colorizeValue(value, good, bad) {
    if (!this.chalk) return value.toString();
    
    if (value >= good) {
      return this.chalk.green(value.toString());
    } else if (value <= bad) {
      return this.chalk.red(value.toString());
    } else {
      return this.chalk.yellow(value.toString());
    }
  }
}

module.exports = { TUIRenderer };

