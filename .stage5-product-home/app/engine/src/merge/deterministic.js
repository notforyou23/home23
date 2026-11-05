/**
 * COSMO Merge V2 - Deterministic Utilities
 * 
 * Provides seeded RNG and stable ordering functions to ensure
 * identical inputs produce identical outputs.
 */

const crypto = require('crypto');

/**
 * Create a seeded pseudo-random number generator
 * Uses a simple but effective xorshift128+ algorithm seeded from SHA256
 * 
 * @param {string} seed - Seed string
 * @returns {function} - RNG function returning values in [0, 1)
 */
function createSeededRng(seed) {
  // Convert seed to 128-bit state via SHA256
  const hash = crypto.createHash('sha256').update(seed).digest();
  
  // Initialize state from hash bytes
  let s0 = hash.readBigUInt64LE(0);
  let s1 = hash.readBigUInt64LE(8);
  
  // Ensure non-zero state
  if (s0 === 0n && s1 === 0n) {
    s0 = 1n;
  }
  
  return function() {
    // xorshift128+
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23n;
    x ^= x >> 17n;
    x ^= y ^ (y >> 26n);
    s1 = x;
    
    // Convert to [0, 1) float
    const result = (s0 + s1) & ((1n << 53n) - 1n);
    return Number(result) / Number(1n << 53n);
  };
}

/**
 * Derive a deterministic seed from run names
 * 
 * @param {string[]} runNames - Array of run names
 * @returns {string} - Deterministic seed string
 */
function deriveSeedFromRuns(runNames) {
  const sorted = [...runNames].sort();
  return crypto.createHash('sha256').update(sorted.join('|')).digest('hex');
}

/**
 * Stable sort comparator for nodes
 * Sorts by id, then origin.run, then origin.id
 * 
 * @param {object} a - First node
 * @param {object} b - Second node
 * @returns {number} - Comparison result
 */
function stableNodeComparator(a, b) {
  // Primary: by id
  const idA = String(a.id);
  const idB = String(b.id);
  if (idA !== idB) {
    return idA.localeCompare(idB);
  }
  
  // Secondary: by origin.run (if provenance exists)
  const runA = a.provenance?.origin?.run || '';
  const runB = b.provenance?.origin?.run || '';
  if (runA !== runB) {
    return runA.localeCompare(runB);
  }
  
  // Tertiary: by origin.id
  const originIdA = String(a.provenance?.origin?.id || '');
  const originIdB = String(b.provenance?.origin?.id || '');
  return originIdA.localeCompare(originIdB);
}

/**
 * Stable sort comparator for edges
 * Sorts by source, then target, then type
 * 
 * @param {object} a - First edge
 * @param {object} b - Second edge
 * @returns {number} - Comparison result
 */
function stableEdgeComparator(a, b) {
  const sourceA = String(a.source || a.from || '');
  const sourceB = String(b.source || b.from || '');
  if (sourceA !== sourceB) {
    return sourceA.localeCompare(sourceB);
  }
  
  const targetA = String(a.target || a.to || '');
  const targetB = String(b.target || b.to || '');
  if (targetA !== targetB) {
    return targetA.localeCompare(targetB);
  }
  
  const typeA = String(a.type || '');
  const typeB = String(b.type || '');
  return typeA.localeCompare(typeB);
}

/**
 * Deterministic sampling - takes evenly spaced samples
 * Used ONLY in fallback exact-search mode for cluster statistics
 * 
 * @param {Array} items - Items to sample from (must be pre-sorted)
 * @param {number} sampleSize - Number of samples to take
 * @returns {Array} - Sampled items
 */
function deterministicSample(items, sampleSize) {
  if (!items || items.length === 0) return [];
  if (items.length <= sampleSize) return items;
  
  const result = [];
  const step = items.length / sampleSize;
  for (let i = 0; i < sampleSize; i++) {
    const index = Math.floor(i * step);
    result.push(items[index]);
  }
  return result;
}

/**
 * Sort nodes in stable order for serialization
 * 
 * @param {Array} nodes - Nodes to sort
 * @returns {Array} - Sorted nodes (new array)
 */
function sortNodesStable(nodes) {
  return [...nodes].sort(stableNodeComparator);
}

/**
 * Sort edges in stable order for serialization
 * 
 * @param {Array} edges - Edges to sort
 * @returns {Array} - Sorted edges (new array)
 */
function sortEdgesStable(edges) {
  return [...edges].sort(stableEdgeComparator);
}

/**
 * Sort domains alphabetically for stable serialization
 * 
 * @param {string[]} domains - Domain strings
 * @returns {string[]} - Sorted domains (new array)
 */
function sortDomainsStable(domains) {
  return [...domains].sort((a, b) => a.localeCompare(b));
}

module.exports = {
  createSeededRng,
  deriveSeedFromRuns,
  stableNodeComparator,
  stableEdgeComparator,
  deterministicSample,
  sortNodesStable,
  sortEdgesStable,
  sortDomainsStable
};

