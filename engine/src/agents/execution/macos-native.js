const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);

/**
 * MacOSNative - AppleScript/JXA automation for macOS
 */
class MacOSNative {
  constructor(logger) {
    this.logger = logger;
    this.enabled = process.platform === 'darwin';
  }
  
  async openApp(appName) {
    if (!this.enabled) {
      throw new Error('macOS-specific features only available on macOS');
    }
    
    const script = `tell application "${appName}" to activate`;
    
    try {
      await execPromise(`osascript -e '${script}'`);
      this.logger.info('🍎 macOS app opened', { app: appName });
    } catch (error) {
      this.logger.error('Failed to open app', {
        app: appName,
        error: error.message
      });
      throw error;
    }
  }
  
  async focusApp(appName) {
    if (!this.enabled) {
      throw new Error('macOS-specific features only available on macOS');
    }
    
    const script = `tell application "${appName}" to activate`;
    
    try {
      await execPromise(`osascript -e '${script}'`);
      this.logger.info('🍎 macOS app focused', { app: appName });
    } catch (error) {
      this.logger.error('Failed to focus app', {
        app: appName,
        error: error.message
      });
      throw error;
    }
  }
  
  async getWindowTitle() {
    if (!this.enabled) return null;
    
    const script = `
      tell application "System Events"
        return name of first process whose frontmost is true
      end tell
    `;
    
    try {
      const { stdout } = await execPromise(`osascript -e '${script}'`);
      return stdout.trim();
    } catch {
      return null;
    }
  }
}

module.exports = { MacOSNative };

