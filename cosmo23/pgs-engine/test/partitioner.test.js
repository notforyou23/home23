const { expect } = require('chai');
const {
  computeCentroid,
  extractKeywords,
  findAdjacentPartitions,
  generateQuickSummary,
  enrichPartitions
} = require('../src/partitioner');

describe('partitioner', () => {

  // ── computeCentroid ───────────────────────────────────────────────

  describe('computeCentroid', () => {
    it('computes element-wise mean of 3 known embeddings', () => {
      const nodeMap = new Map([
        ['1', { id: '1', embedding: [1, 0, 0, 0] }],
        ['2', { id: '2', embedding: [0, 1, 0, 0] }],
        ['3', { id: '3', embedding: [0, 0, 1, 0] }]
      ]);
      const centroid = computeCentroid(['1', '2', '3'], nodeMap);
      expect(centroid).to.deep.equal([1/3, 1/3, 1/3, 0]);
    });

    it('skips nodes without valid array embeddings', () => {
      const nodeMap = new Map([
        ['1', { id: '1', embedding: [4, 0] }],
        ['2', { id: '2', embedding: null }],
        ['3', { id: '3', embedding: [0, 6] }],
        ['4', { id: '4' }] // no embedding key at all
      ]);
      const centroid = computeCentroid(['1', '2', '3', '4'], nodeMap);
      // mean of [4,0] and [0,6] → [2, 3]
      expect(centroid).to.deep.equal([2, 3]);
    });

    it('returns null when all nodes lack embeddings', () => {
      const nodeMap = new Map([
        ['1', { id: '1', embedding: null }],
        ['2', { id: '2' }]
      ]);
      const centroid = computeCentroid(['1', '2'], nodeMap);
      expect(centroid).to.be.null;
    });

    it('returns the embedding itself for a single node', () => {
      const emb = [0.5, 0.3, 0.9, 0.1];
      const nodeMap = new Map([
        ['1', { id: '1', embedding: emb }]
      ]);
      const centroid = computeCentroid(['1'], nodeMap);
      expect(centroid).to.deep.equal(emb);
    });
  });

  // ── extractKeywords ───────────────────────────────────────────────

  describe('extractKeywords', () => {
    it('returns top terms from node concepts', () => {
      const nodeMap = new Map([
        ['1', { id: '1', concept: 'Quantum computing breakthrough in error correction' }],
        ['2', { id: '2', concept: 'Quantum entanglement used for secure communication' }],
        ['3', { id: '3', concept: 'Error correction codes improve quantum stability' }],
        ['4', { id: '4', concept: 'Topological quantum computing approaches' }],
        ['5', { id: '5', concept: 'Quantum advantage demonstrated in optimization' }]
      ]);
      const keywords = extractKeywords(['1', '2', '3', '4', '5'], nodeMap);
      expect(keywords).to.include('quantum');
      expect(keywords).to.not.include('the');
      expect(keywords).to.not.include('in');
      expect(keywords.length).to.be.greaterThan(0);
    });

    it('ranks by document frequency — term in more nodes wins', () => {
      // "quantum" appears once in each of 5 nodes → df=5
      // "physics" appears 10 times but only in 1 node → df=1
      const nodes = [];
      for (let i = 1; i <= 5; i++) {
        nodes.push([String(i), { id: String(i), concept: `quantum research topic ${i}` }]);
      }
      nodes.push(['6', { id: '6', concept: 'physics '.repeat(10).trim() }]);
      const nodeMap = new Map(nodes);
      const ids = nodes.map(([id]) => id);
      const keywords = extractKeywords(ids, nodeMap);
      const qIdx = keywords.indexOf('quantum');
      const pIdx = keywords.indexOf('physics');
      expect(qIdx).to.be.lessThan(pIdx);
    });

    it('excludes all stop words', () => {
      const nodeMap = new Map([
        ['1', { id: '1', concept: 'the a an is are was were be been being have has had do does did will would could should may might shall can need dare ought used to of in for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very just because but and or if while that this these those it its they them their we our you your he she his her what which who also about up down new one two three first' }]
      ]);
      const keywords = extractKeywords(['1'], nodeMap);
      expect(keywords).to.have.length(0);
    });

    it('filters out words with 2 or fewer characters', () => {
      const nodeMap = new Map([
        ['1', { id: '1', concept: 'AI ML NLP quantum computing deep learning' }]
      ]);
      const keywords = extractKeywords(['1'], nodeMap);
      expect(keywords).to.not.include('ai');
      expect(keywords).to.not.include('ml');
      expect(keywords).to.include('quantum');
      expect(keywords).to.include('computing');
    });
  });

  // ── findAdjacentPartitions ────────────────────────────────────────

  describe('findAdjacentPartitions', () => {
    it('finds adjacent partitions with correct shared edge counts', () => {
      const partitions = [
        { id: 0, nodeIds: ['1', '2', '3'] },
        { id: 1, nodeIds: ['4', '5', '6'] },
        { id: 2, nodeIds: ['7', '8'] }
      ];
      const edges = [
        { source: '1', target: '4' },
        { source: '2', target: '5' },
        { source: '3', target: '7' }
      ];
      const adj = findAdjacentPartitions(partitions[0], partitions, edges);
      expect(adj).to.have.length(2);
      // Partition 1 has 2 shared edges (1→4, 2→5)
      const adjB = adj.find(a => a.id === 1);
      expect(adjB.sharedEdges).to.equal(2);
      // Partition 2 has 1 shared edge (3→7)
      const adjC = adj.find(a => a.id === 2);
      expect(adjC.sharedEdges).to.equal(1);
      // Sorted descending by sharedEdges
      expect(adj[0].id).to.equal(1);
      expect(adj[1].id).to.equal(2);
    });

    it('returns empty array when all edges are within the partition', () => {
      const partitions = [
        { id: 0, nodeIds: ['1', '2', '3'] },
        { id: 1, nodeIds: ['4', '5'] }
      ];
      const edges = [
        { source: '1', target: '2' },
        { source: '2', target: '3' }
      ];
      const adj = findAdjacentPartitions(partitions[0], partitions, edges);
      expect(adj).to.deep.equal([]);
    });

    it('limits results to top 5 adjacent partitions', () => {
      // Create 8 adjacent partitions, each with 1 cross edge except one with 2
      const partitions = [{ id: 0, nodeIds: ['0'] }];
      const edges = [];
      for (let i = 1; i <= 8; i++) {
        partitions.push({ id: i, nodeIds: [String(i * 10)] });
        edges.push({ source: '0', target: String(i * 10) });
      }
      // Give partition 1 an extra edge
      partitions[1].nodeIds.push('11');
      edges.push({ source: '0', target: '11' });

      const adj = findAdjacentPartitions(partitions[0], partitions, edges);
      expect(adj).to.have.length(5);
      // Partition 1 should be first (2 shared edges)
      expect(adj[0].id).to.equal(1);
      expect(adj[0].sharedEdges).to.equal(2);
    });
  });

  // ── generateQuickSummary ──────────────────────────────────────────

  describe('generateQuickSummary', () => {
    it('formats summary with keywords and top finding snippet', () => {
      const nodeMap = new Map([
        ['1', { id: '1', concept: 'Neural networks enable pattern recognition in complex datasets', weight: 0.9 }],
        ['2', { id: '2', concept: 'Deep learning architectures scale with data', weight: 0.5 }]
      ]);
      const keywords = ['neural', 'networks', 'pattern', 'recognition', 'deep', 'learning', 'architectures', 'datasets'];
      const summary = generateQuickSummary(['1', '2'], nodeMap, keywords);
      expect(summary).to.include('neural, networks, pattern, recognition');
      expect(summary).to.include('Top finding:');
      expect(summary).to.include('Neural networks');
    });

    it('returns fallback for empty partition', () => {
      const nodeMap = new Map();
      const summary = generateQuickSummary([], nodeMap, []);
      expect(summary).to.equal('Partition with 0 nodes');
    });
  });

  // ── enrichPartitions ──────────────────────────────────────────────

  describe('enrichPartitions', () => {
    it('produces fully enriched partitions from raw communities', () => {
      const nodes = [
        { id: '1', concept: 'Quantum computing fundamentals', embedding: [1, 0, 0], weight: 0.8 },
        { id: '2', concept: 'Quantum error correction methods', embedding: [0, 1, 0], weight: 0.6 },
        { id: '3', concept: 'Classical optimization algorithms', embedding: [0, 0, 1], weight: 0.7 },
        { id: '4', concept: 'Optimization convergence analysis', embedding: [0, 0.5, 0.5], weight: 0.5 }
      ];
      const communities = [
        { id: 0, nodeIds: ['1', '2'] },
        { id: 1, nodeIds: ['3', '4'] }
      ];
      const edges = [
        { source: '1', target: '2', weight: 0.8, type: 'ASSOCIATIVE' },
        { source: '2', target: '3', weight: 0.4, type: 'BRIDGE' }
      ];

      const partitions = enrichPartitions(communities, nodes, edges);

      expect(partitions).to.have.length(2);

      // First partition
      const p0 = partitions[0];
      expect(p0.id).to.equal(0);
      expect(p0.nodeIds).to.deep.equal(['1', '2']);
      expect(p0.nodeCount).to.equal(2);
      expect(p0.summary).to.be.a('string').and.not.be.empty;
      expect(p0.keywords).to.be.an('array');
      expect(p0.centroidEmbedding).to.be.an('array').with.length(3);
      // Centroid of [1,0,0] and [0,1,0] → [0.5, 0.5, 0]
      expect(p0.centroidEmbedding).to.deep.equal([0.5, 0.5, 0]);
      expect(p0.adjacentPartitions).to.be.an('array');

      // Second partition
      const p1 = partitions[1];
      expect(p1.id).to.equal(1);
      expect(p1.nodeCount).to.equal(2);
      expect(p1.centroidEmbedding).to.deep.equal([0, 0.25, 0.75]);

      // Adjacency: p0 → p1 via edge 2→3
      expect(p0.adjacentPartitions.length).to.be.greaterThan(0);
      expect(p0.adjacentPartitions[0].id).to.equal(1);
      expect(p0.adjacentPartitions[0].sharedEdges).to.equal(1);
    });
  });
});
