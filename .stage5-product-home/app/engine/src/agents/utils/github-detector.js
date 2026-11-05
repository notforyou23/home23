/**
 * GitHub Repository Detector
 * 
 * Detects GitHub repository references in mission descriptions and extracts owner/repo.
 * Used by agents to determine if they should use github MCP to access external repositories.
 * 
 * Supports multiple text formats:
 * - Full URL: "https://github.com/django/django"
 * - GitHub syntax: "django/django GitHub repository"
 * - Repo syntax: "django/django repository"
 * - Analysis syntax: "analyze django/django"
 * - Audit syntax: "audit the django/django codebase"
 * 
 * Usage:
 *   const GitHubDetector = require('./utils/github-detector');
 *   const result = GitHubDetector.detectRepo(missionDescription);
 *   if (result.detected) {
 *     // Use github MCP with result.owner and result.repo
 *   }
 */

class GitHubDetector {
  /**
   * Detect GitHub repository reference in text
   * 
   * @param {string} text - Mission description or any text
   * @returns {Object} - { detected: boolean, owner?: string, repo?: string, pattern?: string }
   */
  static detectRepo(text) {
    if (!text || typeof text !== 'string') {
      return { detected: false };
    }

    // Pattern priority order (most specific to most general)
    const patterns = [
      // Full GitHub URL
      {
        regex: /github\.com\/([a-z0-9\-._]+)\/([a-z0-9\-._]+)/i,
        name: 'full_url'
      },
      // owner/repo followed by "GitHub" (case insensitive)
      {
        regex: /([a-z0-9\-._]+)\/([a-z0-9\-._]+)\s+GitHub\s+(repository|repo|application|codebase|project)/i,
        name: 'github_keyword'
      },
      // owner/repo followed by "repository"
      {
        regex: /([a-z0-9\-._]+)\/([a-z0-9\-._]+)\s+repository/i,
        name: 'repository_keyword'
      },
      // "analyze owner/repo" or "audit owner/repo"
      {
        regex: /(analyze|audit|review|scan|examine)\s+([a-z0-9\-._]+)\/([a-z0-9\-._]+)/i,
        name: 'action_prefix',
        ownerIndex: 2,
        repoIndex: 3
      },
      // "the owner/repo codebase"
      {
        regex: /the\s+([a-z0-9\-._]+)\/([a-z0-9\-._]+)\s+(codebase|project|application)/i,
        name: 'article_prefix'
      }
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern.regex);
      if (match) {
        const ownerIdx = pattern.ownerIndex || 1;
        const repoIdx = pattern.repoIndex || 2;
        
        return {
          detected: true,
          owner: match[ownerIdx],
          repo: match[repoIdx],
          pattern: pattern.name,
          matchedText: match[0]
        };
      }
    }

    return { detected: false };
  }

  /**
   * Validate that detected owner/repo looks reasonable
   * Prevents false positives from generic text patterns
   * 
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {boolean} - True if looks like valid GitHub repo names
   */
  static isValidRepoFormat(owner, repo) {
    if (!owner || !repo) return false;
    
    // Owner/repo should be reasonable length (GitHub limits)
    if (owner.length > 39 || repo.length > 100) return false;
    
    // Should not contain spaces
    if (/\s/.test(owner) || /\s/.test(repo)) return false;
    
    // Should match GitHub naming rules (alphanumeric, dash, underscore, dot)
    if (!/^[a-z0-9\-._]+$/i.test(owner)) return false;
    if (!/^[a-z0-9\-._]+$/i.test(repo)) return false;
    
    // Common false positives to reject
    const invalidNames = ['and', 'or', 'the', 'with', 'from', 'this', 'that'];
    if (invalidNames.includes(owner.toLowerCase()) || invalidNames.includes(repo.toLowerCase())) {
      return false;
    }
    
    // Reject filesystem paths (common false positives)
    const filesystemPaths = ['src', 'lib', 'bin', 'docs', 'tests', 'test', 'dist', 'build', 'node_modules', 'runtime', 'mcp', 'scripts'];
    if (filesystemPaths.includes(owner.toLowerCase()) || filesystemPaths.includes(repo.toLowerCase())) {
      return false;
    }
    
    return true;
  }

  /**
   * Detect and validate GitHub repository in one call
   * Combines detection and validation for convenience
   * 
   * @param {string} text - Mission description
   * @returns {Object} - { detected: boolean, owner?, repo?, pattern?, valid?: boolean }
   */
  static detectAndValidate(text) {
    const result = this.detectRepo(text);
    
    if (!result.detected) {
      return result;
    }
    
    const valid = this.isValidRepoFormat(result.owner, result.repo);
    
    return {
      ...result,
      valid
    };
  }

  /**
   * Extract multiple repository references from text
   * Useful if mission mentions comparing multiple repos
   * 
   * @param {string} text - Mission description
   * @returns {Array} - Array of { owner, repo, pattern } objects
   */
  static detectAllRepos(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const repos = [];
    const seen = new Set();

    // Try each pattern globally
    const fullUrlRegex = /github\.com\/([a-z0-9\-._]+)\/([a-z0-9\-._]+)/gi;
    let match;
    
    while ((match = fullUrlRegex.exec(text)) !== null) {
      const owner = match[1];
      const repo = match[2];
      const key = `${owner}/${repo}`;
      
      if (!seen.has(key) && this.isValidRepoFormat(owner, repo)) {
        seen.add(key);
        repos.push({ owner, repo, pattern: 'full_url' });
      }
    }

    return repos;
  }
}

module.exports = { GitHubDetector };

