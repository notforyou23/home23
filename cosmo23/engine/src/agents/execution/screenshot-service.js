const screenshotDesktop = require('screenshot-desktop');
const path = require('path');
const fs = require('fs').promises;

/**
 * ScreenshotService - Screen capture functionality
 */
class ScreenshotService {
  constructor(logger, config = {}) {
    this.logger = logger;
    this.backend = 'screenshot-desktop';
    // CRITICAL: Use config.logsDir for multi-tenant isolation
    const baseDir = config.logsDir || path.resolve('runtime');
    this.outputDir = path.join(baseDir, 'outputs', 'screenshots');
  }
  
  async initialize() {
    await fs.mkdir(this.outputDir, { recursive: true });
    this.logger.info('✅ Screenshot: screenshot-desktop', {
      outputDir: this.outputDir
    });
  }
  
  async capture() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(this.outputDir, `screenshot-${timestamp}.png`);
    
    try {
      await screenshotDesktop({ filename: filePath });
      
      // Read the file to get base64
      const data = await fs.readFile(filePath);
      const base64 = data.toString('base64');
      
      this.logger.info('📸 Screenshot captured', { filePath });
      
      return {
        path: filePath,
        base64
      };
    } catch (err) {
      this.logger.error('Screenshot failed', { error: err.message });
      throw err;
    }
  }
  
  getBackend() {
    return this.backend;
  }
}

module.exports = { ScreenshotService };

