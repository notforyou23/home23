const fs = require('fs').promises;
const path = require('path');

/**
 * FileSystemAgent - Local file operations
 */
class FileSystemAgent {
  constructor(sandbox, logger) {
    // sandbox is kept for backward compatibility in constructor but unused
    this.logger = logger;
  }
  
  /**
   * Read file contents
   */
  async readFile(filePath) {
    const absPath = path.resolve(filePath);
    
    try {
      const content = await fs.readFile(absPath, 'utf8');
      this.logger.info('📖 File read', {
        path: absPath,
        length: content.length
      });
      return content;
    } catch (error) {
      this.logger.error('File read failed', {
        path: absPath,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Write file with mode (overwrite, append, prepend)
   */
  async writeFile(filePath, content, mode = 'overwrite') {
    const absPath = path.resolve(filePath);
    
    let finalContent = content;
    
    if (mode === 'append' || mode === 'prepend') {
      try {
        const existing = await fs.readFile(absPath, 'utf8');
        if (mode === 'append') {
          finalContent = existing + content;
        } else {
          finalContent = content + existing;
        }
      } catch (error) {
        // File doesn't exist, just write new content
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    
    await fs.writeFile(absPath, finalContent, 'utf8');
    
    this.logger.info('✏️ File written', {
      path: absPath,
      mode,
      length: finalContent.length
    });
    
    return {
      success: true,
      path: absPath,
      mode,
      length: finalContent.length
    };
  }
}

module.exports = { FileSystemAgent };
