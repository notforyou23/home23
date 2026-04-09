'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('DocumentFeeder — integration', function () {
  this.timeout(30000);

  let DocumentFeeder, tmpDir, feeder, mockMemory;

  before(() => {
    ({ DocumentFeeder } = require('../../src/ingestion/document-feeder'));
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-integ-'));

    let nodeIdCounter = 1;
    const fakeEmbed = new Array(512).fill(0.1);

    mockMemory = {
      addNode: sinon.stub().callsFake(async (concept, tag, embedding) => {
        const id = nodeIdCounter++;
        const node = { id, concept, tag, embedding };
        mockMemory.nodes.set(id, node);
        return node;
      }),
      addEdge: sinon.stub(),
      removeNode: sinon.stub().callsFake((id) => {
        mockMemory.nodes.delete(id);
      }),
      embed: sinon.stub().resolves(fakeEmbed),
      cosineSimilarity: sinon.stub().returns(0.3),
      nodes: new Map()
    };

    feeder = new DocumentFeeder({
      memory: mockMemory,
      config: {
        flush: { batchSize: 5, intervalSeconds: 9999 }, // Don't auto-flush
        chunking: { maxChunkSize: 3000, overlap: 300 },
        converter: { enabled: true }
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      embeddingFn: () => Promise.resolve(fakeEmbed)
    });
  });

  afterEach(async () => {
    await feeder.shutdown();
    sinon.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create ingestion/documents/ directory on start', async () => {
    await feeder.start(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'ingestion', 'documents'))).to.be.true;
  });

  it('should ingest a markdown file via ingestFile()', async () => {
    await feeder.start(tmpDir);

    // Create a test file
    const testFile = path.join(tmpDir, 'test-doc.md');
    fs.writeFileSync(testFile, '# Test Document\n\nThis is test content for ingestion.');

    await feeder.ingestFile(testFile, 'test-docs');

    // Should have created at least one node
    expect(mockMemory.addNode.called).to.be.true;

    // Should be in manifest
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'ingestion-manifest.json'), 'utf8'));
    expect(manifest[testFile]).to.exist;
    expect(manifest[testFile].nodeIds.length).to.be.greaterThan(0);
  });

  it('should skip unchanged files on re-ingestion', async () => {
    await feeder.start(tmpDir);

    const testFile = path.join(tmpDir, 'test-doc.md');
    fs.writeFileSync(testFile, '# Same Content\n\nThis will not change.');

    await feeder.ingestFile(testFile, 'docs');
    const callCount1 = mockMemory.addNode.callCount;

    await feeder.ingestFile(testFile, 'docs');
    const callCount2 = mockMemory.addNode.callCount;

    expect(callCount2).to.equal(callCount1); // No new nodes
  });

  it('should re-ingest when file content changes', async () => {
    await feeder.start(tmpDir);

    const testFile = path.join(tmpDir, 'test-doc.md');
    fs.writeFileSync(testFile, '# Version 1\n\nOriginal content.');
    await feeder.ingestFile(testFile, 'docs');
    const firstNodeCount = mockMemory.addNode.callCount;

    fs.writeFileSync(testFile, '# Version 2\n\nUpdated content.');
    await feeder.ingestFile(testFile, 'docs');

    // Should have created new nodes AND removed old ones
    expect(mockMemory.addNode.callCount).to.be.greaterThan(firstNodeCount);
    expect(mockMemory.removeNode.called).to.be.true;
  });

  it('should ingest a whole directory via ingestDirectory()', async () => {
    await feeder.start(tmpDir);

    const dir = path.join(tmpDir, 'batch');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), '# File A\n\nContent A.');
    fs.writeFileSync(path.join(dir, 'b.md'), '# File B\n\nContent B.');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'Plain text content.');

    await feeder.ingestDirectory(dir, 'batch-test');

    // Each file produces multiple blocks (heading + paragraph), so total > 3
    expect(mockMemory.addNode.callCount).to.be.at.least(3);
  });

  it('should return accurate status', async () => {
    await feeder.start(tmpDir);

    const testFile = path.join(tmpDir, 'status-test.md');
    fs.writeFileSync(testFile, '# Status Test\n\nContent.');
    await feeder.ingestFile(testFile, 'status');

    const status = await feeder.getStatus();
    expect(status.enabled).to.be.true;
    expect(status.started).to.be.true;
    expect(status.manifest.fileCount).to.equal(1);
    expect(status.manifest.nodeCount).to.be.greaterThan(0);
  });

  it('should remove file nodes via removeFile()', async () => {
    await feeder.start(tmpDir);

    const testFile = path.join(tmpDir, 'remove-test.md');
    fs.writeFileSync(testFile, '# Remove Test\n\nContent to remove.');
    await feeder.ingestFile(testFile, 'remove');

    expect(mockMemory.addNode.called).to.be.true;

    await feeder.removeFile(testFile);

    expect(mockMemory.removeNode.called).to.be.true;
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'ingestion-manifest.json'), 'utf8'));
    expect(manifest[testFile]).to.be.undefined;
  });

  it('should pick up files dropped in ingestion/documents/ via watcher', async function () {
    await feeder.start(tmpDir);

    // Drop a file into the watched directory
    const ingestDir = path.join(tmpDir, 'ingestion', 'documents');
    const testFile = path.join(ingestDir, 'dropped.md');
    fs.writeFileSync(testFile, '# Dropped File\n\nContent from drop zone.');

    // Wait for chokidar to detect + stabilityThreshold (500ms) + processing time
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Manually trigger flush since auto-flush interval is set very high
    await feeder.manifest.flush('test');

    expect(mockMemory.addNode.called).to.be.true;
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'ingestion-manifest.json'), 'utf8'));
    expect(manifest[testFile]).to.exist;
  });
});
