const path = require('path');
const fs = require('fs').promises;

/**
 * PathResolver - Centralized path resolution for COSMO
 * 
 * Purpose:
 * - Provide single source of truth for all file paths in the system
 * - Ensure deliverables land where coordinators and MCP can access them
 * - Support logical path prefixes (@outputs/, @exports/, etc.)
 * - Validate MCP accessibility before agents write files
 * - Enable run isolation while maintaining discoverability
 * 
 * Design Principles:
 * - All paths are resolved relative to runtimeRoot
 * - Logical prefixes map to well-known directories
 * - MCP accessibility is enforced when required
 * - Absolute paths are validated against allowed paths
 * 
 * Usage:
 * ```javascript
 * const paths = pathResolver.getDeliverablePath({
 *   deliverableSpec: mission.deliverable,
 *   agentType: 'document-creation',
 *   agentId: this.agentId,
 *   fallbackName: 'output.md'
 * });
 * await fs.writeFile(paths.fullPath, content);
 * ```
 */
class PathResolver {
  constructor(config, logger) {
    this.logger = logger;
    
    // Anchor: where this run's runtime lives
    // Default to runtime/ in the workspace root
    this.runtimeRoot = config.runtimeRoot || path.resolve(process.cwd(), 'runtime');
    
    // What MCP can access (absolute paths)
    // These should be set during initialization to match MCP server config
    // Extract from correct config structure: mcp.client.servers[0].allowedPaths
    const mcpServers = config.mcp?.client?.servers;
    const filesystemServer = mcpServers?.find(s => s.label === 'filesystem') || mcpServers?.[0];
    this.mcpAllowedPaths = filesystemServer?.allowedPaths || [];
    
    // Convert relative paths to absolute if needed
    this.mcpAllowedPaths = this.mcpAllowedPaths.map(p => {
      if (path.isAbsolute(p)) {
        return p;
      }
      return path.resolve(process.cwd(), p);
    });
    
    // Logical prefixes that map to well-known directories
    // These provide a stable API for components to reference locations
    this.prefixes = {
      '@outputs': path.join(this.runtimeRoot, 'outputs'),
      '@exports': path.join(this.runtimeRoot, 'exports'),
      '@coordinator': path.join(this.runtimeRoot, 'coordinator'),
      '@state': this.runtimeRoot,
      '@logs': config.logsDir || this.runtimeRoot,
      '@binary-cache': path.join(this.runtimeRoot, 'binary-data')
    };
    
    this.logger?.debug?.('PathResolver initialized', {
      runtimeRoot: this.runtimeRoot,
      mcpAllowedPaths: this.mcpAllowedPaths,
      prefixes: Object.keys(this.prefixes)
    });
  }
  
  /**
   * Resolve a logical or relative path to an absolute path
   * 
   * @param {string} logicalPath - Path with optional logical prefix (@outputs/file.md)
   * @returns {string} Absolute path
   * 
   * Examples:
   * - '@outputs/file.md' → '/abs/path/to/runtime/outputs/file.md'
   * - 'outputs/file.md' → '/abs/path/to/runtime/outputs/file.md'
   * - '/abs/path' → '/abs/path' (unchanged)
   */
  resolve(logicalPath) {
    if (!logicalPath) {
      return this.runtimeRoot;
    }
    
    // Check for logical prefix
    for (const [prefix, absPath] of Object.entries(this.prefixes)) {
      if (logicalPath.startsWith(prefix)) {
        const remainder = logicalPath.slice(prefix.length);
        // Handle both @outputs/file and @outputs/./file
        const cleanRemainder = remainder.replace(/^\//, '');
        return path.join(absPath, cleanRemainder);
      }
    }
    
    // If already absolute, return as-is
    if (path.isAbsolute(logicalPath)) {
      return logicalPath;
    }
    
    // Strip leading 'runtime/' if present (GPT-5.2 sometimes generates "runtime/outputs/" instead of "@outputs/")
    // This prevents double-pathing when runtimeRoot already includes runtime
    let cleanPath = logicalPath;
    if (cleanPath.startsWith('runtime/')) {
      cleanPath = cleanPath.slice('runtime/'.length);
    }
    
    // Otherwise resolve relative to runtimeRoot
    return path.join(this.runtimeRoot, cleanPath);
  }
  
  /**
   * Get the path for a deliverable, ensuring it's accessible
   * 
   * @param {Object} options
   * @param {Object} options.deliverableSpec - Deliverable specification from mission
   * @param {string} options.agentType - Type of agent creating deliverable
   * @param {string} options.agentId - Unique agent identifier
   * @param {string} options.fallbackName - Default filename if not specified
   * @returns {Object} Path information
   */
  getDeliverablePath({ deliverableSpec, agentType, agentId, fallbackName }) {
    // Determine location
    // Default to @outputs/ if not specified
    const location = deliverableSpec?.location || '@outputs/';
    
    // Determine filename
    let filename = deliverableSpec?.filename || fallbackName || `${agentId}_output.txt`;
    
    // BUGFIX: Strip redundant path prefixes from filename
    // If filename starts with runtime/outputs/ or runtime/exports/, strip it
    // This prevents path duplication when location is @outputs/ or @exports/
    const redundantPrefixes = [
      'runtime/outputs/',
      'runtime/exports/',
      'runtime/coordinator/',
      'outputs/',
      'exports/',
      'coordinator/'
    ];
    
    for (const prefix of redundantPrefixes) {
      if (filename.startsWith(prefix)) {
        const strippedFilename = filename.substring(prefix.length);
        this.logger?.debug('Stripped redundant prefix from filename', {
          original: filename,
          prefix,
          result: strippedFilename
        });
        filename = strippedFilename;
        break;
      }
    }
    
    // Resolve directory
    const dir = this.resolve(location);
    
    // Build full path
    const fullPath = path.join(dir, filename);
    
    // Check MCP accessibility
    const requiresAccess = deliverableSpec?.accessibility === 'mcp-required';
    const isAccessible = this.isPathAccessibleViaMCP(fullPath);
    
    // Enforce accessibility if required
    if (requiresAccess && !isAccessible) {
      this.logger?.error('Deliverable path not accessible via MCP', {
        path: fullPath,
        allowedPaths: this.mcpAllowedPaths,
        deliverableSpec
      });
      
      // Try to suggest a fix
      const suggestedPath = path.join(this.prefixes['@outputs'], filename);
      this.logger?.warn('Suggested alternative path', { suggestedPath });
      
      throw new Error(
        `Deliverable path ${fullPath} is not accessible via MCP. ` +
        `Consider using @outputs/ or @exports/ as the location.`
      );
    }
    
    // Warn if not accessible but not required
    if (!requiresAccess && !isAccessible) {
      this.logger?.warn('Deliverable not accessible via MCP', {
        path: fullPath,
        hint: 'Downstream agents may not be able to access this file'
      });
    }
    
    return {
      fullPath,
      relativePath: path.relative(process.cwd(), fullPath),
      directory: dir,
      filename,
      isAccessible,
      logicalLocation: location
    };
  }
  
  /**
   * Check if a path is accessible via MCP
   * 
   * @param {string} targetPath - Path to check
   * @returns {boolean} True if path is within MCP allowed paths
   */
  isPathAccessibleViaMCP(targetPath) {
    if (this.mcpAllowedPaths.length === 0) {
      // If no restrictions, assume accessible
      return true;
    }
    
    const absolutePath = path.isAbsolute(targetPath) 
      ? targetPath 
      : path.resolve(process.cwd(), targetPath);
    
    return this.mcpAllowedPaths.some(allowed => {
      // Normalize both paths for comparison
      const normalizedAllowed = path.normalize(allowed);
      const normalizedTarget = path.normalize(absolutePath);
      
      // Check if target is within or equal to allowed path
      return normalizedTarget.startsWith(normalizedAllowed);
    });
  }
  
  /**
   * Get the root directory for outputs
   * Used by coordinator for deliverable audits
   * 
   * @returns {string} Absolute path to outputs directory
   */
  getOutputsRoot() {
    return this.prefixes['@outputs'];
  }
  
  /**
   * Get the root directory for exports
   * 
   * @returns {string} Absolute path to exports directory
   */
  getExportsRoot() {
    return this.prefixes['@exports'];
  }
  
  /**
   * Get the coordinator directory
   * 
   * @returns {string} Absolute path to coordinator directory
   */
  getCoordinatorDir() {
    return this.prefixes['@coordinator'];
  }
  
  /**
   * Get the runtime root directory
   * 
   * @returns {string} Absolute path to runtime root
   */
  getRuntimeRoot() {
    return this.runtimeRoot;
  }
  
  /**
   * Get shared workspace for a phase/milestone
   * P5: Enables agents in same phase to collaborate in shared directory
   * 
   * @param {string} milestoneId - Milestone/phase identifier (e.g., 'ms:phase2')
   * @returns {string} Absolute path to phase workspace
   * 
   * Example: getPhaseWorkspace('ms:phase2') → '/runtime/outputs/phases/ms:phase2/'
   */
  getPhaseWorkspace(milestoneId) {
    return path.join(this.getOutputsRoot(), 'phases', milestoneId);
  }
  
  /**
   * Ensure a directory exists, creating it if necessary
   * 
   * @param {string} dirPath - Directory path (can be logical)
   * @returns {Promise<string>} Absolute path to created directory
   */
  async ensureDirectory(dirPath) {
    const absolutePath = this.resolve(dirPath);
    await fs.mkdir(absolutePath, { recursive: true });
    return absolutePath;
  }
  
  /**
   * Get diagnostic information about path configuration
   * Useful for debugging and validation
   * 
   * @returns {Object} Diagnostic information
   */
  getDiagnostics() {
    return {
      runtimeRoot: this.runtimeRoot,
      mcpAllowedPaths: this.mcpAllowedPaths,
      prefixes: this.prefixes,
      mcpAccessible: {
        outputs: this.isPathAccessibleViaMCP(this.prefixes['@outputs']),
        exports: this.isPathAccessibleViaMCP(this.prefixes['@exports']),
        coordinator: this.isPathAccessibleViaMCP(this.prefixes['@coordinator'])
      }
    };
  }
}

module.exports = { PathResolver };

