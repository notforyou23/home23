'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('IngestionManifest', () => {
  let IngestionManifest, manifest;
  let tmpDir, mockMemory, mockEmbeddingFn;

  before(() => {
    ({ IngestionManifest } = require('../../src/ingestion/ingestion-manifest'));
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
    const fakeEmbed = new Array(512).fill(0.1);

    let nodeIdCounter = 100;
    mockMemory = {
      addNode: sinon.stub().callsFake(async (concept, tag, embedding) => {
        const id = nodeIdCounter++;
        return { id, concept, tag, embedding };
      }),
      addEdge: sinon.stub(),
      removeNode: sinon.stub(),
      cosineSimilarity: sinon.stub().returns(0.3),
      nodes: new Map()
    };

    mockEmbeddingFn = sinon.stub().resolves(fakeEmbed);

    manifest = new IngestionManifest({
      runPath: tmpDir,
      memory: mockMemory,
      embeddingFn: mockEmbeddingFn,
      config: { batchSize: 20, intervalSeconds: 300 },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    });
  });

  afterEach(() => {
    sinon.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isStale()', () => {
    it('should return true for new files not in manifest', async () => {
      expect(await manifest.isStale('/new/file.md', 'abc123')).to.be.true;
    });

    it('should return false when hash matches', async () => {
      manifest._manifest['/old/file.md'] = { hash: 'abc123', nodeIds: [1] };
      expect(await manifest.isStale('/old/file.md', 'abc123')).to.be.false;
    });

    it('should return true when hash differs', async () => {
      manifest._manifest['/old/file.md'] = { hash: 'abc123', nodeIds: [1] };
      expect(await manifest.isStale('/old/file.md', 'def456')).to.be.true;
    });
  });

  describe('enqueue()', () => {
    it('should add chunks to the pending queue', async () => {
      const chunks = [
        { text: 'chunk one', index: 0, totalChunks: 2, heading: null, depth: 0, strategy: 'semantic' },
        { text: 'chunk two', index: 1, totalChunks: 2, heading: null, depth: 0, strategy: 'semantic' }
      ];
      const relationships = [{ from: 0, to: 1, type: 'FOLLOWS' }];

      await manifest.enqueue('/test/file.md', 'test-label', 'fullhash', chunks, relationships);

      expect(manifest._pending.length).to.equal(2);
      expect(manifest._pending[0].filePath).to.equal('/test/file.md');
      expect(manifest._pending[0].label).to.equal('test-label');
      expect(manifest._pending[1].chunkIndex).to.equal(1);
    });

    it('should upsert — replace existing entries for the same file', async () => {
      const chunks1 = [{ text: 'old', index: 0, totalChunks: 1, heading: null, depth: 0, strategy: 'semantic' }];
      const chunks2 = [{ text: 'new', index: 0, totalChunks: 1, heading: null, depth: 0, strategy: 'semantic' }];

      await manifest.enqueue('/test/file.md', 'label', 'hash1', chunks1, []);
      await manifest.enqueue('/test/file.md', 'label', 'hash2', chunks2, []);

      expect(manifest._pending.length).to.equal(1);
      expect(manifest._pending[0].content).to.equal('new');
    });
  });

  describe('flush()', () => {
    it('should embed pending items and create nodes in memory', async () => {
      const chunks = [{ text: 'content here', index: 0, totalChunks: 1, heading: null, depth: 0, strategy: 'semantic' }];
      await manifest.enqueue('/test/file.md', 'docs', 'hash123', chunks, []);

      await manifest.flush('test');

      expect(mockEmbeddingFn.calledOnce).to.be.true;
      expect(mockMemory.addNode.calledOnce).to.be.true;
      expect(manifest._pending.length).to.equal(0);
      expect(manifest._manifest['/test/file.md']).to.exist;
      expect(manifest._manifest['/test/file.md'].hash).to.equal('hash123');
      expect(manifest._manifest['/test/file.md'].nodeIds).to.have.length(1);
    });

    it('should remove stale nodes when re-ingesting a file', async () => {
      // Simulate existing manifest entry
      manifest._manifest['/test/file.md'] = { hash: 'oldhash', nodeIds: [50, 51], totalChunks: 2 };

      const chunks = [{ text: 'updated content', index: 0, totalChunks: 1, heading: null, depth: 0, strategy: 'semantic' }];
      await manifest.enqueue('/test/file.md', 'docs', 'newhash', chunks, []);

      await manifest.flush('test');

      expect(mockMemory.removeNode.calledWith(50)).to.be.true;
      expect(mockMemory.removeNode.calledWith(51)).to.be.true;
      expect(manifest._manifest['/test/file.md'].hash).to.equal('newhash');
    });

    it('should create structural edges from relationships', async () => {
      const chunks = [
        { text: 'chunk A', index: 0, totalChunks: 2, heading: '## Intro', depth: 2, strategy: 'semantic' },
        { text: 'chunk B', index: 1, totalChunks: 2, heading: '## Body', depth: 2, strategy: 'semantic' }
      ];
      const relationships = [
        { from: 0, to: 1, type: 'FOLLOWS' },
        { from: 0, to: 1, type: 'CONTAINS', parent: 'document' }
      ];

      await manifest.enqueue('/test/file.md', 'docs', 'hash', chunks, relationships);
      await manifest.flush('test');

      // Two chunks = two addNode calls, and edges for FOLLOWS + CONTAINS
      expect(mockMemory.addNode.calledTwice).to.be.true;
      expect(mockMemory.addEdge.called).to.be.true;
    });

    it('should persist manifest to disk after flush', async () => {
      const chunks = [{ text: 'content', index: 0, totalChunks: 1, heading: null, depth: 0, strategy: 'semantic' }];
      await manifest.enqueue('/test/file.md', 'docs', 'hash', chunks, []);
      await manifest.flush('test');

      const manifestPath = path.join(tmpDir, 'ingestion-manifest.json');
      expect(fs.existsSync(manifestPath)).to.be.true;
      const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(saved['/test/file.md']).to.exist;
    });
  });

  describe('removeFile()', () => {
    it('should remove nodes and manifest entry for a file', async () => {
      manifest._manifest['/test/file.md'] = { hash: 'abc', nodeIds: [10, 11], totalChunks: 2 };

      await manifest.removeFile('/test/file.md');

      expect(mockMemory.removeNode.calledWith(10)).to.be.true;
      expect(mockMemory.removeNode.calledWith(11)).to.be.true;
      expect(manifest._manifest['/test/file.md']).to.be.undefined;
    });
  });
});
