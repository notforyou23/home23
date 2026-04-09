/**
 * Domain Anchor Utility
 * 
 * Provides domain context anchoring for coordinator and planning prompts.
 * Prevents meta-pollution by ensuring all prompts stay focused on the user's research domain.
 * 
 * @module utils/domain-anchor
 */

const fs = require('fs').promises;
const path = require('path');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/**
 * Get the domain anchor block for inclusion in prompts.
 * This ensures all LLM prompts stay focused on the user's research domain
 * rather than spiraling into meta-concerns about COSMO's internal operation.
 * 
 * @param {Object} config - The configuration object
 * @param {Object} [options] - Additional options
 * @param {string} [options.logsDir] - Override logs directory for reading run-metadata.json
 * @returns {string} The domain anchor block to prepend to prompts
 */
function getDomainAnchor(config, options = {}) {
  // Try multiple paths to get domain/context
  let domain = 'research';
  let context = '';
  const guidedFocus = config?.architecture?.roleSystem?.guidedFocus || config?.guidedFocus || null;
  
  // Path 1: From guidedFocus in config
  if (guidedFocus) {
    domain = firstNonEmpty(
      guidedFocus.researchDomain,
      guidedFocus.originalDomain,
      guidedFocus.domain
    ) || domain;
    context = firstNonEmpty(
      guidedFocus.researchContext,
      guidedFocus.originalContext,
      guidedFocus.context
    );
  }
  // Path 2: From guidedFocus at root of config (some configs structure it differently)
  else if (config?.guidedFocus?.domain) {
    domain = config.guidedFocus.domain;
    context = config.guidedFocus.context || '';
  }
  // Path 3: From domain/context at root
  else if (config?.domain) {
    domain = config.domain;
    context = config.context || '';
  }
  
  return `
═══════════════════════════════════════════════════════════════════════════════
DOMAIN ANCHOR - YOUR PRIMARY OBJECTIVE (DO NOT DEVIATE)

**Research Domain:** ${domain}
**Context:** ${context}

CRITICAL INSTRUCTIONS:
1. ALL analysis, goals, insights, and directives MUST advance this domain research
2. IGNORE meta-concerns about COSMO's internal operation (QA gates, probes, CLI tools)
3. BUILD ON prior research outputs - enhance existing work, don't reinvent
4. FILTER OUT any thoughts, goals, or insights that don't relate to this domain

Domain Relevance Test - Before including ANY goal/insight/directive, ask:
"Does this help answer the research question or produce domain deliverables for the USER?"
- YES → Include it
- NO → Discard it (it's meta-pollution about system internals)
═══════════════════════════════════════════════════════════════════════════════
`;
}

/**
 * Get domain anchor asynchronously, with fallback to run-metadata.json
 * Use this when you need to ensure domain is loaded from persistent storage.
 * 
 * @param {Object} config - The configuration object
 * @param {string} [logsDir] - The logs directory path
 * @returns {Promise<string>} The domain anchor block
 */
async function getDomainAnchorAsync(config, logsDir) {
  let domain = 'research';
  let context = '';
  const guidedFocus = config?.architecture?.roleSystem?.guidedFocus || config?.guidedFocus || null;
  
  // Try config first
  if (guidedFocus) {
    domain = firstNonEmpty(
      guidedFocus.researchDomain,
      guidedFocus.originalDomain,
      guidedFocus.domain
    ) || domain;
    context = firstNonEmpty(
      guidedFocus.researchContext,
      guidedFocus.originalContext,
      guidedFocus.context
    );
  } else if (config?.domain) {
    domain = config.domain;
    context = config.context || '';
  }
  
  // If still default, try run-metadata.json
  if (domain === 'research' && logsDir) {
    try {
      const metadataPath = path.join(logsDir, 'run-metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);
      const metadataDomain = firstNonEmpty(
        metadata.researchDomain,
        metadata.domain,
        metadata.topic
      );
      const metadataContext = firstNonEmpty(
        metadata.researchContext,
        metadata.context
      );
      if (metadataDomain) {
        domain = metadataDomain;
        context = metadataContext;
      }
    } catch (err) {
      // Metadata file not found or not readable, use defaults
    }
  }
  
  return getDomainAnchor({ domain, context });
}

/**
 * Filter an array of items to only include domain-relevant ones.
 * Uses simple heuristics to detect meta-pollution.
 * 
 * @param {Array} items - Array of items (goals, insights, thoughts)
 * @param {string} domain - The research domain
 * @returns {Array} Filtered array with meta-pollution removed
 */
function filterDomainRelevant(items, domain) {
  if (!Array.isArray(items)) return items;
  
  const metaPatterns = [
    /\bQA gate\b/i,
    /\bprobe\b/i,
    /\bhardened writer\b/i,
    /\bCLI tool\b/i,
    /\bbuild system\b/i,
    /\bexecution infrastructure\b/i,
    /\brelease engineering\b/i,
    /\bvalidation system\b/i,
    /\bCOSMO.*(internal|itself|operation)\b/i,
    /\bmanifest.*diagnostic\b/i,
    /\batomic.*write\b/i,
    /\bfsync\b/i,
    /\bpath.*resolver\b/i,
    /\b@outputs.*probe\b/i,
  ];
  
  return items.filter(item => {
    const text = typeof item === 'string' 
      ? item 
      : (item?.content || item?.description || item?.title || JSON.stringify(item));
    
    // Check if any meta pattern matches
    for (const pattern of metaPatterns) {
      if (pattern.test(text)) {
        return false; // Filter out meta-pollution
      }
    }
    return true;
  });
}

/**
 * Check if a single item is domain-relevant (not meta-pollution)
 * 
 * @param {string|Object} item - The item to check
 * @returns {boolean} True if domain-relevant, false if meta-pollution
 */
function isDomainRelevant(item) {
  const filtered = filterDomainRelevant([item], '');
  return filtered.length > 0;
}

module.exports = {
  getDomainAnchor,
  getDomainAnchorAsync,
  filterDomainRelevant,
  isDomainRelevant
};
