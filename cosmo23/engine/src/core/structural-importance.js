/**
 * structural-importance.js - Node Importance Scoring
 * 
 * Scores nodes by structural position using hub degree, centrality,
 * and pillar alignment with locked weights:
 * - Foundation: 0.3
 * - Expression: 0.5  
 * - Consequence: 0.2
 * 
 * @module core/structural-importance
 */

// Locked pillar weights per spec
const PILLAR_WEIGHTS = {
  foundation: 0.3,
  expression: 0.5,
  consequence: 0.2,
};

/**
 * StructuralImportance - Scores nodes by structural position
 * 
 * @class StructuralImportance
 */
class StructuralImportance {
  /**
   * Create structural importance scorer
   */
  constructor() {
    this.weights = PILLAR_WEIGHTS;
    Object.freeze(this);
  }

  /**
   * Compute structural importance score for a node.
   * 
   * Formula:
   * hubScore = (inbound + outbound) / (2 * maxDegree)
   * centralityScore = provided centrality value [0.0, 1.0]
   * pillarScore = weights[pillarType]
   * importance = (hubScore * 0.3) + (centralityScore * 0.5) + (pillarScore * 0.2)
   * 
   * @param {string} nodeId - Node identifier
   * @param {Object} config - Scoring configuration
   * @param {number} config.inboundCount - Number of inbound references
   * @param {number} config.outboundCount - Number of outbound references
   * @param {number} [config.centrality=0] - Centrality score [0.0, 1.0]
   * @param {string} [config.pillarType='foundation'] - Pillar type
   * @param {number} [config.maxDegree=100] - Maximum possible degree
   * @returns {Object} Score result { importance, hubScore, centralityScore, pillarScore }
   * @throws {TypeError} If parameters invalid
   */
  computeScore(nodeId, config) {
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('nodeId must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
      throw new TypeError('config must be an object');
    }

    const {
      inboundCount = 0,
      outboundCount = 0,
      centrality = 0,
      pillarType = 'foundation',
      maxDegree = 100,
    } = config;

    // Validate parameters
    if (typeof inboundCount !== 'number' || inboundCount < 0) {
      throw new TypeError('inboundCount must be a non-negative number');
    }

    if (typeof outboundCount !== 'number' || outboundCount < 0) {
      throw new TypeError('outboundCount must be a non-negative number');
    }

    if (typeof centrality !== 'number' || centrality < 0 || centrality > 1) {
      throw new TypeError('centrality must be a number between 0.0 and 1.0');
    }

    if (typeof pillarType !== 'string' || !(pillarType in PILLAR_WEIGHTS)) {
      throw new TypeError(`pillarType must be one of: ${Object.keys(PILLAR_WEIGHTS).join(', ')}`);
    }

    if (typeof maxDegree !== 'number' || maxDegree <= 0) {
      throw new TypeError('maxDegree must be a positive number');
    }

    // Compute component scores
    const totalDegree = inboundCount + outboundCount;
    const hubScore = Math.min(1, totalDegree / (2 * maxDegree)); // Normalize to [0, 1]
    const centralityScore = centrality;
    const pillarScore = PILLAR_WEIGHTS[pillarType];

    // Weighted sum: 30% hub, 50% centrality, 20% pillar
    const importance =
      hubScore * 0.3 + centralityScore * 0.5 + pillarScore * 0.2;

    return {
      nodeId,
      importance: Math.max(0, Math.min(1, importance)), // Clamp to [0, 1]
      hubScore,
      centralityScore,
      pillarScore,
      components: {
        degree: totalDegree,
        inbound: inboundCount,
        outbound: outboundCount,
        centrality,
        pillarType,
      },
    };
  }

  /**
   * Get pillar weights (read-only).
   * 
   * @returns {Object} Weights { foundation, expression, consequence }
   */
  getPillarWeights() {
    return { ...PILLAR_WEIGHTS };
  }

  /**
   * Get valid pillar types.
   * 
   * @returns {string[]} Array of pillar type names
   */
  getValidPillars() {
    return Object.keys(PILLAR_WEIGHTS);
  }

  /**
   * Check if pillar type is valid.
   * 
   * @param {string} pillarType - Pillar type to check
   * @returns {boolean} True if valid
   */
  isValidPillar(pillarType) {
    return typeof pillarType === 'string' && pillarType in PILLAR_WEIGHTS;
  }
}

/**
 * Factory function to create structural importance scorer.
 * 
 * @returns {StructuralImportance} New scorer instance
 */
function createStructuralImportance() {
  return new StructuralImportance();
}

/**
 * Compute importance score for arbitrary parameters.
 * 
 * @param {Object} config - Scoring configuration
 * @param {number} config.inboundCount - Inbound reference count
 * @param {number} config.outboundCount - Outbound reference count
 * @param {number} [config.centrality=0] - Centrality score
 * @param {string} [config.pillarType='foundation'] - Pillar type
 * @param {number} [config.maxDegree=100] - Maximum degree
 * @returns {number} Importance score [0.0, 1.0]
 */
function computeScore(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('config must be an object');
  }

  const {
    inboundCount = 0,
    outboundCount = 0,
    centrality = 0,
    pillarType = 'foundation',
    maxDegree = 100,
  } = config;

  // Validate
  if (typeof inboundCount !== 'number' || inboundCount < 0) {
    throw new TypeError('inboundCount must be a non-negative number');
  }

  if (typeof outboundCount !== 'number' || outboundCount < 0) {
    throw new TypeError('outboundCount must be a non-negative number');
  }

  if (typeof centrality !== 'number' || centrality < 0 || centrality > 1) {
    throw new TypeError('centrality must be a number between 0.0 and 1.0');
  }

  if (typeof pillarType !== 'string' || !(pillarType in PILLAR_WEIGHTS)) {
    throw new TypeError(`pillarType must be one of: ${Object.keys(PILLAR_WEIGHTS).join(', ')}`);
  }

  if (typeof maxDegree !== 'number' || maxDegree <= 0) {
    throw new TypeError('maxDegree must be a positive number');
  }

  // Compute
  const totalDegree = inboundCount + outboundCount;
  const hubScore = Math.min(1, totalDegree / (2 * maxDegree));
  const centralityScore = centrality;
  const pillarScore = PILLAR_WEIGHTS[pillarType];

  const importance =
    hubScore * 0.3 + centralityScore * 0.5 + pillarScore * 0.2;

  return Math.max(0, Math.min(1, importance));
}

/**
 * Get pillar weights (global).
 * 
 * @returns {Object} Weights { foundation, expression, consequence }
 */
function getPillarWeights() {
  return { ...PILLAR_WEIGHTS };
}

/**
 * Compute hub score for node references.
 * 
 * @param {number} inboundCount - Inbound references
 * @param {number} outboundCount - Outbound references
 * @param {number} [maxDegree=100] - Maximum degree
 * @returns {number} Hub score [0.0, 1.0]
 */
function computeHubScore(inboundCount, outboundCount, maxDegree = 100) {
  if (typeof inboundCount !== 'number' || inboundCount < 0) {
    throw new TypeError('inboundCount must be a non-negative number');
  }

  if (typeof outboundCount !== 'number' || outboundCount < 0) {
    throw new TypeError('outboundCount must be a non-negative number');
  }

  if (typeof maxDegree !== 'number' || maxDegree <= 0) {
    throw new TypeError('maxDegree must be a positive number');
  }

  const totalDegree = inboundCount + outboundCount;
  return Math.min(1, totalDegree / (2 * maxDegree));
}

// Export public API
module.exports = {
  StructuralImportance,
  createStructuralImportance,
  PILLAR_WEIGHTS,
  computeScore,
  getPillarWeights,
  computeHubScore,
};
