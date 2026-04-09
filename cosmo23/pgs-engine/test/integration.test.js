const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { PGSEngine, PGS_DEFAULTS, cosineSimilarity, runLouvain } = require('../src/index');

// Load real physics2 brain for integration tests
const brainPath = path.join(__dirname, '..', 'examples', 'data', 'physics2.json.gz');
let realGraph;

before(function () {
  this.timeout(5000);
  const gz = fs.readFileSync(brainPath);
  const data = JSON.parse(zlib.gunzipSync(gz).toString());
  realGraph = { nodes: data.nodes, edges: data.edges };
});

describe('PGSEngine — Integration', () => {
  let sweepProvider;
  let synthesisProvider;

  beforeEach(() => {
    let sweepCallCount = 0;
    sweepProvider = {
      generate: sinon.stub().callsFake(async ({ instructions, input }) => {
        sweepCallCount++;
        // Return structured sweep response
        return {
          content: `## Domain State\nPartition ${sweepCallCount} covers conformal field theory research.\n\n## Findings\nKey finding about operator dimensions.\n\n## Outbound Flags\nConnects to bootstrap methods in adjacent partitions.\n\n## Absences\nNo findings on holographic duality in this partition.`
        };
      })
    };

    synthesisProvider = {
      generate: sinon.stub().callsFake(async ({ instructions, input, onChunk }) => {
        const content = `# Cross-Domain Synthesis\n\nAnalysis of ${sweepCallCount} partitions reveals convergent findings on conformal bootstrap methods. Key absence: holographic duality is underrepresented across all examined partitions.`;
        if (onChunk) onChunk(content);
        return { content };
      })
    };
  });

  describe('constructor', () => {
    it('should require sweepProvider', () => {
      expect(() => new PGSEngine({ synthesisProvider: {} }))
        .to.throw('sweepProvider');
    });

    it('should require synthesisProvider', () => {
      expect(() => new PGSEngine({ sweepProvider: {} }))
        .to.throw('synthesisProvider');
    });

    it('should accept all options', () => {
      const engine = new PGSEngine({
        sweepProvider: { generate: async () => ({}) },
        synthesisProvider: { generate: async () => ({}) },
        embeddingProvider: { embed: async () => [], dimensions: 512 },
        config: { maxConcurrentSweeps: 3 },
        onEvent: () => {}
      });
      expect(engine.config.maxConcurrentSweeps).to.equal(3);
      expect(engine.config.sweepMaxTokens).to.equal(PGS_DEFAULTS.sweepMaxTokens);
    });
  });

  describe('computeGraphHash', () => {
    it('should produce consistent hashes for the same graph', () => {
      const h1 = PGSEngine.computeGraphHash(realGraph);
      const h2 = PGSEngine.computeGraphHash(realGraph);
      expect(h1).to.equal(h2);
    });

    it('should include node and edge counts', () => {
      const hash = PGSEngine.computeGraphHash(realGraph);
      expect(hash).to.include('586');
      expect(hash).to.include('1931');
    });

    it('should produce different hashes for different graphs', () => {
      const small = { nodes: [{ id: 1 }], edges: [] };
      const h1 = PGSEngine.computeGraphHash(realGraph);
      const h2 = PGSEngine.computeGraphHash(small);
      expect(h1).to.not.equal(h2);
    });
  });

  describe('partition (real physics2 brain)', () => {
    it('should partition the real brain into multiple communities', () => {
      const engine = new PGSEngine({ sweepProvider, synthesisProvider });
      const partitions = engine.partition(realGraph);

      expect(partitions).to.be.an('array');
      expect(partitions.length).to.be.at.least(2);

      // All nodes should be accounted for
      const totalNodes = partitions.reduce((sum, p) => sum + p.nodeIds.length, 0);
      expect(totalNodes).to.equal(586);
    });

    it('should produce enriched partitions with all required fields', () => {
      const engine = new PGSEngine({ sweepProvider, synthesisProvider });
      const partitions = engine.partition(realGraph);

      for (const p of partitions) {
        expect(p).to.have.property('id');
        expect(p).to.have.property('nodeIds').that.is.an('array');
        expect(p).to.have.property('nodeCount');
        expect(p).to.have.property('summary').that.is.a('string');
        expect(p).to.have.property('keywords').that.is.an('array');
        expect(p).to.have.property('centroidEmbedding');
        expect(p).to.have.property('adjacentPartitions').that.is.an('array');
        expect(p.nodeCount).to.equal(p.nodeIds.length);
      }
    });

    it('should produce centroids with correct dimensions', () => {
      const engine = new PGSEngine({ sweepProvider, synthesisProvider });
      const partitions = engine.partition(realGraph);

      for (const p of partitions) {
        if (p.centroidEmbedding) {
          expect(p.centroidEmbedding).to.have.lengthOf(512);
        }
      }
    });

    it('should produce partitions with adjacency fields', () => {
      const engine = new PGSEngine({ sweepProvider, synthesisProvider });
      const partitions = engine.partition(realGraph);

      // All partitions should have the adjacentPartitions field
      for (const p of partitions) {
        expect(p.adjacentPartitions).to.be.an('array');
      }

      // physics2 has a supercluster pattern (576/586 nodes in one partition)
      // Singletons may not have adjacencies, but the field should always exist
      const mainPartition = partitions.reduce((a, b) => a.nodeCount > b.nodeCount ? a : b);
      expect(mainPartition.nodeCount).to.be.greaterThan(500);
    });
  });

  describe('route', () => {
    it('should return all partitions when no embedding provider', async () => {
      const engine = new PGSEngine({ sweepProvider, synthesisProvider });
      const partitions = engine.partition(realGraph);
      const routed = await engine.route('test query', realGraph, partitions);

      // Without embedding, should return up to maxSweepPartitions
      expect(routed.length).to.be.at.most(PGS_DEFAULTS.maxSweepPartitions);
    });

    it('should route with mock embedding provider', async () => {
      // Use the centroid of partition 0 as the query embedding
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        embeddingProvider: {
          embed: async () => null, // Simulate embedding failure
          dimensions: 512
        }
      });
      const partitions = engine.partition(realGraph);
      const routed = await engine.route('test', realGraph, partitions);

      // With null embedding, should return all up to max
      expect(routed.length).to.be.at.most(PGS_DEFAULTS.maxSweepPartitions);
    });
  });

  describe('execute (full pipeline)', function () {
    this.timeout(15000);

    it('should run the full pipeline and return structured result', async () => {
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 3, maxConcurrentSweeps: 3 }
      });

      const result = await engine.execute('What are the key findings about conformal bootstrap?', realGraph);

      expect(result).to.have.property('answer').that.is.a('string');
      expect(result.answer.length).to.be.greaterThan(0);
      expect(result).to.have.property('metadata');
      expect(result.metadata).to.have.property('mode', 'pgs');
      expect(result.metadata.pgs).to.have.property('totalNodes', 586);
      expect(result.metadata.pgs).to.have.property('totalEdges', 1931);
      expect(result.metadata.pgs).to.have.property('sweptPartitions');
      expect(result.metadata.pgs).to.have.property('successfulSweeps');
      expect(result.metadata.pgs).to.have.property('elapsed');
      expect(result.metadata.pgs.sweptPartitions).to.be.at.most(3);
    });

    it('should call sweep provider for each partition', async () => {
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      await engine.execute('test query', realGraph);

      // Should have called sweep at least once
      expect(sweepProvider.generate.callCount).to.be.at.least(1);
      // Should have called synthesis exactly once
      expect(synthesisProvider.generate.calledOnce).to.be.true;
    });

    it('should emit events during execution', async () => {
      const events = [];
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      await engine.execute('test', realGraph, {
        onEvent: (e) => events.push(e)
      });

      const types = events.map(e => e.type);
      expect(types).to.include('partitioning');
      expect(types).to.include('routing');
      expect(types).to.include('session');
      expect(types).to.include('sweeping');
      expect(types).to.include('sweep_started');
      expect(types).to.include('sweep_complete');
      expect(types).to.include('synthesizing');
      expect(types).to.include('complete');
    });

    it('should throw when all sweeps fail', async () => {
      const failProvider = {
        generate: async () => { throw new Error('Provider down'); }
      };

      const engine = new PGSEngine({
        sweepProvider: failProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      try {
        await engine.execute('test', realGraph);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('All sweeps failed');
      }
    });
  });

  describe('session continuation', function () {
    this.timeout(15000);

    it('should track searched partitions across sessions', async () => {
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      // First query — full mode
      const result1 = await engine.execute('test', realGraph, { sessionId: 'test-session' });
      const searched1 = result1.metadata.pgs.searched;

      // Second query — continue mode
      const result2 = await engine.execute('test', realGraph, { sessionId: 'test-session', mode: 'continue' });
      const searched2 = result2.metadata.pgs.searched;

      // Should have searched more partitions in total
      expect(searched2).to.be.greaterThan(searched1);
    });
  });

  describe('layeredSearch', function () {
    this.timeout(15000);

    it('should run standard query then PGS pass', async () => {
      const mockEmbed = sinon.stub().resolves(realGraph.nodes[0].embedding);
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        embeddingProvider: { embed: mockEmbed, dimensions: 512 },
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      const result = await engine.layeredSearch('What is surprising?', realGraph, { topK: 10 });

      expect(result).to.have.property('answer').that.is.a('string');
      expect(result).to.have.property('standardAnswer').that.is.a('string');
      expect(result.standardAnswer.length).to.be.greaterThan(0);
      expect(result.metadata.layered).to.have.property('standardNodesUsed', 10);
    });

    it('should inject standard context into sweep prompts', async () => {
      const mockEmbed = sinon.stub().resolves(realGraph.nodes[0].embedding);
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        embeddingProvider: { embed: mockEmbed, dimensions: 512 },
        config: { maxSweepPartitions: 2, maxConcurrentSweeps: 2 }
      });

      await engine.layeredSearch('test', realGraph, { topK: 5 });

      // Sweep calls should include the standard query context
      const sweepInput = sweepProvider.generate.firstCall.args[0].input;
      expect(sweepInput).to.include('PRIOR STANDARD QUERY RESULTS');
      expect(sweepInput).to.include('find what it MISSED');
    });
  });

  describe('composable API', function () {
    this.timeout(15000);

    it('should allow step-by-step execution', async () => {
      const engine = new PGSEngine({
        sweepProvider,
        synthesisProvider,
        config: { maxSweepPartitions: 2 }
      });

      // Step 1: Partition
      const partitions = engine.partition(realGraph);
      expect(partitions.length).to.be.at.least(2);

      // Step 2: Route
      const routed = await engine.route('conformal bootstrap', realGraph, partitions);
      expect(routed.length).to.be.at.least(1);

      // Step 3: Sweep one partition
      const sweepResult = await engine.sweepPartition('conformal bootstrap', routed[0], realGraph, partitions);
      expect(sweepResult).to.have.property('sweepOutput');
      expect(sweepResult).to.have.property('partitionId');

      // Step 4: Synthesize
      const synthesis = await engine.synthesize('conformal bootstrap', [sweepResult], {
        totalNodes: 586, totalEdges: 1931, totalPartitions: partitions.length, selectedPartitions: 1
      });
      expect(synthesis).to.be.a('string');
      expect(synthesis.length).to.be.greaterThan(0);
    });
  });

  describe('exports', () => {
    it('should export PGSEngine class', () => {
      expect(PGSEngine).to.be.a('function');
    });

    it('should export PGS_DEFAULTS', () => {
      expect(PGS_DEFAULTS).to.be.an('object');
      expect(PGS_DEFAULTS).to.have.property('maxConcurrentSweeps');
    });

    it('should export cosineSimilarity', () => {
      expect(cosineSimilarity).to.be.a('function');
      expect(cosineSimilarity([1, 0], [0, 1])).to.equal(0);
    });

    it('should export runLouvain', () => {
      expect(runLouvain).to.be.a('function');
    });
  });
});
