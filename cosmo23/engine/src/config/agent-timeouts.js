/**
 * Enterprise-Grade Agent Timeout Configuration
 * 
 * Centralized timeout management to ensure consistency across all agent spawning methods.
 * Timeouts are calibrated for production workloads, not artificial speed limits.
 * 
 * Guidelines:
 * - Complex multi-step workflows (code generation, testing): 60 minutes
 * - Document/research tasks with external calls: 30 minutes
 * - Analysis and exploration: 20 minutes
 * - Quick validation checks: 10 minutes
 */

const AGENT_TIMEOUTS = {
  // Heavy workflows - 60 minutes
  'code_execution': 3600000,    // Comprehensive testing with 20+ files
  'code_creation': 3600000,     // Multi-file projects with plan mode stages
  'dataacquisition': 3600000,   // Web scraping, API consumption — network-bound, long-running
  'datapipeline': 3600000,      // ETL, database creation — CPU-bound for large datasets

  // Medium workflows - 30 minutes
  'ide': 1800000,               // Codebase modification with safety checks
  'infrastructure': 1800000,    // Environment provisioning, package installation
  'automation': 1800000,        // OS automation, file operations, process management
  'synthesis': 1800000,         // Comprehensive multi-section reports
  'research': 1800000,          // Deep web search with multiple queries
  'document_creation': 1800000, // Complex document generation
  'document_analysis': 1800000, // Repository scanning and analysis
  'specialized_binary': 1800000, // Large PDF/Office file processing
  
  // Standard workflows - 20 minutes
  'analysis': 1200000,          // Multi-perspective deep analysis
  'exploration': 1200000,       // Creative hypothesis generation
  'planning': 1200000,          // Goal decomposition and planning
  'integration': 1200000,       // Cross-agent pattern discovery
  
  // Quick workflows - 10 minutes
  'quality_assurance': 600000,  // Validation and QA checks
  'consistency': 600000,        // Consistency and coherence reviews
  'completion': 600000,         // System oversight and monitoring
  'document_compiler': 600000,  // Documentation compilation (3 docs, dual-substrate)
  
  // Default fallback
  'default': 900000             // 15 minutes for unknown types
};

/**
 * Get timeout duration for agent type
 * @param {string} agentType - Agent type identifier
 * @returns {number} Timeout in milliseconds
 */
function getAgentTimeout(agentType) {
  return AGENT_TIMEOUTS[agentType] || AGENT_TIMEOUTS.default;
}

/**
 * Get all configured timeouts (for diagnostics/config display)
 * @returns {Object} Map of agent types to timeout durations
 */
function getAllTimeouts() {
  return { ...AGENT_TIMEOUTS };
}

module.exports = {
  AGENT_TIMEOUTS,
  getAgentTimeout,
  getAllTimeouts
};

