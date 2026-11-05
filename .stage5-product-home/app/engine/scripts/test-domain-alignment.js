#!/usr/bin/env node

/**
 * Domain Alignment Test
 * Verifies that domain-aware embedding alignment works correctly
 */

// Simple test harness
function assert(condition, message) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${message}`);
}

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    console.error(`✗ FAIL: ${message} (expected ${expected}, got ${actual})`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${message}`);
}

// Import the domain alignment functions from merge_runs.js
// Since they're not exported, we'll test the algorithm directly here

/**
 * DomainRegistry (copy from merge_runs.js for testing)
 */
class DomainRegistry {
  constructor(dimensions = 8) {
    this.dimensions = dimensions;
    this.domainToIndex = new Map();
    this.nextIndex = 0;
  }
  
  getDomainIndex(domain) {
    if (!domain || domain === 'unknown') {
      return null;
    }
    
    const normalized = domain.toLowerCase().trim();
    
    if (this.domainToIndex.has(normalized)) {
      return this.domainToIndex.get(normalized);
    }
    
    if (this.nextIndex >= this.dimensions) {
      return null;
    }
    
    const index = this.nextIndex++;
    this.domainToIndex.set(normalized, index);
    return index;
  }
  
  createDomainPrefix(domain) {
    const index = this.getDomainIndex(domain);
    
    if (index === null) {
      return null;
    }
    
    const prefix = new Array(this.dimensions).fill(0);
    prefix[index] = 1;
    return prefix;
  }
}

/**
 * Add domain prefix (copy from merge_runs.js for testing)
 */
function addDomainPrefix(embedding, domain, registry) {
  if (!embedding || !Array.isArray(embedding)) {
    return embedding;
  }
  
  const prefix = registry.createDomainPrefix(domain);
  
  if (!prefix) {
    return embedding;
  }
  
  const prefixed = [...prefix, ...embedding];
  
  const magnitude = Math.sqrt(prefixed.reduce((sum, val) => sum + val * val, 0));
  
  if (magnitude === 0) {
    return prefixed;
  }
  
  return prefixed.map(val => val / magnitude);
}

/**
 * Cosine similarity (copy from merge_runs.js for testing)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA * normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

console.log('\n=== Domain Alignment Test Suite ===\n');

// Test 1: Domain Registry
console.log('Test 1: Domain Registry');
const registry = new DomainRegistry(8);

assert(registry.getDomainIndex('mathematics') === 0, 'First domain gets index 0');
assert(registry.getDomainIndex('physics') === 1, 'Second domain gets index 1');
assert(registry.getDomainIndex('mathematics') === 0, 'Same domain returns same index');
assert(registry.getDomainIndex('chemistry') === 2, 'Third domain gets index 2');
assert(registry.getDomainIndex('unknown') === null, 'Unknown domain returns null');

// Test 2: One-hot Encoding
console.log('\nTest 2: One-hot Encoding');
const mathPrefix = registry.createDomainPrefix('mathematics');
const physicsPrefix = registry.createDomainPrefix('physics');

assert(mathPrefix.length === 8, 'Prefix has correct length');
assert(mathPrefix[0] === 1 && mathPrefix.slice(1).every(v => v === 0), 'Math prefix is one-hot at index 0');
assert(physicsPrefix[1] === 1 && physicsPrefix[0] === 0, 'Physics prefix is one-hot at index 1');

// Test 3: Embedding Prefix Addition
console.log('\nTest 3: Embedding Prefix Addition');
const originalEmbedding = [0.5, 0.5, 0.5, 0.5]; // Simple 4D embedding

const mathEmbedding = addDomainPrefix(originalEmbedding, 'mathematics', registry);
const physicsEmbedding = addDomainPrefix(originalEmbedding, 'physics', registry);

assert(mathEmbedding.length === 12, 'Prefixed embedding has correct length (8 + 4)');
assert(physicsEmbedding.length === 12, 'Prefixed embedding has correct length (8 + 4)');

// Test 4: Normalization
console.log('\nTest 4: Normalization');
const magnitude = Math.sqrt(mathEmbedding.reduce((sum, val) => sum + val * val, 0));
assertApprox(magnitude, 1.0, 0.0001, 'Prefixed embedding is normalized');

// Test 5: Within-Domain Similarity (Should Remain High)
console.log('\nTest 5: Within-Domain Similarity');

const mathNode1 = [0.8, 0.2, 0.1, 0.3];
const mathNode2 = [0.75, 0.25, 0.15, 0.28]; // Very similar to mathNode1

const mathNode1Prefixed = addDomainPrefix(mathNode1, 'mathematics', registry);
const mathNode2Prefixed = addDomainPrefix(mathNode2, 'mathematics', registry);

const originalSimilarity = cosineSimilarity(mathNode1, mathNode2);
const prefixedSimilarity = cosineSimilarity(mathNode1Prefixed, mathNode2Prefixed);

console.log(`  Original similarity: ${originalSimilarity.toFixed(4)}`);
console.log(`  Prefixed similarity: ${prefixedSimilarity.toFixed(4)}`);

assert(originalSimilarity > 0.95, 'Original nodes are similar');
assert(prefixedSimilarity > 0.95, 'Prefixed same-domain nodes remain similar');

// Test 6: Cross-Domain Isolation (Should Be Low)
console.log('\nTest 6: Cross-Domain Isolation');

const mathNodeX = [0.5, 0.5, 0.3, 0.2];
const physicsNodeY = [0.5, 0.5, 0.3, 0.2]; // Identical embedding, different domain!

const mathNodeXPrefixed = addDomainPrefix(mathNodeX, 'mathematics', registry);
const physicsNodeYPrefixed = addDomainPrefix(physicsNodeY, 'physics', registry);

const identicalSimilarity = cosineSimilarity(mathNodeX, physicsNodeY);
const crossDomainSimilarity = cosineSimilarity(mathNodeXPrefixed, physicsNodeYPrefixed);

console.log(`  Without prefix (identical embeddings): ${identicalSimilarity.toFixed(4)}`);
console.log(`  With prefix (different domains): ${crossDomainSimilarity.toFixed(4)}`);

assert(identicalSimilarity === 1.0, 'Original embeddings are identical');
assert(crossDomainSimilarity < 0.85, 'Cross-domain similarity is below dedup threshold');
assert(crossDomainSimilarity < 0.5, 'Cross-domain similarity is significantly reduced');

// Test 7: Unknown Domain Handling
console.log('\nTest 7: Unknown Domain Handling');

const unknownNode = [0.3, 0.4, 0.5, 0.6];
const unknownPrefixed = addDomainPrefix(unknownNode, 'unknown', registry);

assert(unknownPrefixed === unknownNode, 'Unknown domain returns original embedding (no prefix)');

// Test 8: Multiple Domains
console.log('\nTest 8: Multiple Domains');

const domains = ['mathematics', 'physics', 'chemistry', 'biology', 'cs', 'engineering'];
const testEmbedding = [0.5, 0.5, 0.5, 0.5];
const prefixedEmbeddings = domains.map(domain => 
  addDomainPrefix(testEmbedding, domain, registry)
);

// Check all cross-domain similarities are low
for (let i = 0; i < domains.length; i++) {
  for (let j = i + 1; j < domains.length; j++) {
    const sim = cosineSimilarity(prefixedEmbeddings[i], prefixedEmbeddings[j]);
    assert(sim < 0.85, `${domains[i]} vs ${domains[j]} similarity is below threshold (${sim.toFixed(4)})`);
  }
}

// Test 9: Realistic Scenario
console.log('\nTest 9: Realistic Scenario - False Positive Prevention');

// These are nodes that SHOULD NOT merge (different concepts, different domains)
const mathConcept = {
  concept: "lambda-weighted ESS theory",
  embedding: [-0.22, 0.45, 0.18, 0.33, -0.11],
  domain: "mathematics"
};

const physicsConcept = {
  concept: "quantum spin liquid model",
  embedding: [-0.21, 0.47, 0.15, 0.35, -0.10], // Very similar numerically!
  domain: "physics"
};

const registry2 = new DomainRegistry(8);

const mathPrefixed = addDomainPrefix(mathConcept.embedding, mathConcept.domain, registry2);
const physicsPrefixed = addDomainPrefix(physicsConcept.embedding, physicsConcept.domain, registry2);

const withoutAlignment = cosineSimilarity(mathConcept.embedding, physicsConcept.embedding);
const withAlignment = cosineSimilarity(mathPrefixed, physicsPrefixed);

console.log(`  "${mathConcept.concept}"`);
console.log(`  vs`);
console.log(`  "${physicsConcept.concept}"`);
console.log(`  Without alignment: ${withoutAlignment.toFixed(4)} (would merge!)`);
console.log(`  With alignment: ${withAlignment.toFixed(4)} (correctly separated)`);

assert(withoutAlignment > 0.85, 'Without alignment, nodes would incorrectly merge (FALSE POSITIVE)');
assert(withAlignment < 0.85, 'With alignment, nodes are correctly separated (FIXED)');

// Test 10: Performance Check
console.log('\nTest 10: Performance Check');

const startTime = Date.now();
const testRegistry = new DomainRegistry(8);
const iterations = 10000;

for (let i = 0; i < iterations; i++) {
  const embedding = [Math.random(), Math.random(), Math.random(), Math.random()];
  const domain = ['math', 'physics', 'chemistry'][i % 3];
  addDomainPrefix(embedding, domain, testRegistry);
}

const elapsed = Date.now() - startTime;
console.log(`  Processed ${iterations} embeddings in ${elapsed}ms`);
console.log(`  Average: ${(elapsed / iterations).toFixed(3)}ms per embedding`);

assert(elapsed < 1000, 'Performance is acceptable (< 1s for 10k embeddings)');

console.log('\n=== All Tests Passed! ===\n');
console.log('Domain alignment implementation is working correctly.');
console.log('✓ One-hot encoding');
console.log('✓ Embedding prefix addition');
console.log('✓ Normalization');
console.log('✓ Within-domain similarity preserved');
console.log('✓ Cross-domain isolation enforced');
console.log('✓ False positive prevention');
console.log('✓ Performance acceptable');
console.log('');

process.exit(0);

