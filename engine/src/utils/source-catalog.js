/**
 * Source Code Catalog
 * 
 * Builds and maintains an index of source files for efficient lookup.
 * Used by DocumentAnalysisAgent to quickly resolve file paths without parsing missions.
 * 
 * Usage:
 *   const catalog = new SourceCatalog(mcpBridge, logger);
 *   await catalog.initialize();
 *   const file = catalog.findFile('orchestrator.js');
 *   // Returns: { path: 'src/core/orchestrator.js', size: 150KB, ... }
 */

const path = require('path');

class SourceCatalog {
  constructor(mcpBridge, logger) {
    this.mcp = mcpBridge;
    this.logger = logger;
    this.files = new Map(); // filename -> full path
    this.directories = new Map(); // directory -> files[]
    this.initialized = false;
  }

  /**
   * Build catalog of all source files
   * Call this at agent initialization or system startup
   */
  async initialize(basePaths = ['src', 'lib', 'mcp', 'scripts']) {
    if (this.initialized) {
      return;
    }

    this.logger?.info('📇 Building source catalog...', { basePaths });

    for (const basePath of basePaths) {
      await this.indexDirectory(basePath);
    }

    this.initialized = true;
    
    this.logger?.info('✅ Source catalog built', {
      totalFiles: this.files.size,
      directories: this.directories.size
    });
  }

  /**
   * Recursively index a directory
   */
  async indexDirectory(dirPath, depth = 0, maxDepth = 50) {
    if (depth >= maxDepth) return;
    if (!this.mcp?.callMCPTool) return;

    try {
      const result = await this.mcp.callMCPTool('filesystem', 'list_directory', {
        path: dirPath
      });

      if (!result?.content?.[0]) return;

      const data = JSON.parse(result.content[0].text);
      if (!data.items) return;

      const filesInDir = [];

      for (const item of data.items) {
        const fullPath = path.join(dirPath, item.name);

        if (item.type === 'file') {
          // Index file
          const ext = path.extname(item.name).toLowerCase();
          if (this.isSourceFile(ext)) {
            this.files.set(item.name, fullPath);
            filesInDir.push(fullPath);
          }
        } else if (item.type === 'directory') {
          // Recurse into subdirectory
          await this.indexDirectory(fullPath, depth + 1, maxDepth);
        }
      }

      this.directories.set(dirPath, filesInDir);
      
    } catch (error) {
      this.logger?.debug(`Failed to index directory: ${dirPath}`, { error: error.message });
    }
  }

  /**
   * Check if file extension is source code
   */
  isSourceFile(ext) {
    const sourceExtensions = [
      '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
      '.py', '.pyi', '.go', '.rs', '.java',
      '.c', '.cpp', '.cc', '.h', '.hpp',
      '.rb', '.php', '.sh', '.bash', '.zsh',
      '.json', '.yaml', '.yml', '.toml', '.md'
    ];
    return sourceExtensions.includes(ext);
  }

  /**
   * Find file by name (returns first match)
   */
  findFile(filename) {
    const fullPath = this.files.get(filename);
    if (fullPath) {
      return { path: fullPath, filename };
    }
    return null;
  }

  /**
   * Find all files matching pattern
   */
  findFiles(pattern) {
    const regex = new RegExp(pattern, 'i');
    const matches = [];

    for (const [filename, fullPath] of this.files) {
      if (regex.test(filename) || regex.test(fullPath)) {
        matches.push({ filename, path: fullPath });
      }
    }

    return matches;
  }

  /**
   * Get all files in directory (non-recursive)
   */
  getFilesInDirectory(dirPath) {
    return this.directories.get(dirPath) || [];
  }

  /**
   * Get all files (entire catalog)
   */
  getAllFiles() {
    return Array.from(this.files.entries()).map(([filename, fullPath]) => ({
      filename,
      path: fullPath
    }));
  }

  /**
   * Smart file resolution from mission text
   * Handles various formats:
   * - "orchestrator.js" -> finds src/core/orchestrator.js
   * - "src/core/orchestrator.js" -> exact match
   * - "core/orchestrator" -> finds src/core/orchestrator.js
   */
  resolveFile(text) {
    if (!text) return null;

    // Try exact path first
    if (this.files.has(text)) {
      return this.files.get(text);
    }

    // Try as filename
    const asFilename = path.basename(text);
    if (this.files.has(asFilename)) {
      return this.files.get(asFilename);
    }

    // Try partial path match
    for (const [filename, fullPath] of this.files) {
      if (fullPath.includes(text) || fullPath.endsWith(text)) {
        return fullPath;
      }
    }

    return null;
  }
}

module.exports = { SourceCatalog };

