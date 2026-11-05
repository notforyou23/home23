const path = require('path');

/**
 * SafetySandbox - (DEPRECATED) Execution restrictions and validation
 * 
 * This component is being removed per user request. 
 * All validation logic is disabled.
 */
class SafetySandbox {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.allowedDirs = [];
    this.forbiddenPatterns = [];
  }
  
  /**
   * Validate command for execution - (NO-OP)
   */
  validateCommand(command) {
    return true;
  }
  
  /**
   * Get allowed working directory (default)
   */
  getAllowedCwd() {
    return path.resolve('runtime/outputs');
  }
  
  /**
   * Validate file path is within allowed directories - (NO-OP)
   */
  validatePath(filePath) {
    return path.resolve(filePath);
  }
  
  /**
   * Check if path is allowed - (NO-OP)
   */
  isPathAllowed(filePath) {
    return true;
  }
}

module.exports = { SafetySandbox };
