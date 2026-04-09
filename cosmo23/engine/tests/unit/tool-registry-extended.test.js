const { expect } = require('chai');

const { ToolRegistry } = require('../../src/execution/tool-registry');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

describe('ToolRegistry — Extended scan list', function () {
  let registry;

  before(async function () {
    registry = new ToolRegistry({}, silentLogger);
    await registry.discover();
  });

  // All 27 tool IDs that should be in the scan targets (7 original + 20 new)
  const EXPECTED_TOOL_IDS = [
    'tool:python',
    'tool:node',
    'tool:docker',
    'tool:git',
    'tool:curl',
    'tool:npm',
    'tool:pip',
    'tool:jq',
    'tool:sqlite3',
    'tool:wget',
    'tool:ffmpeg',
    'tool:pandoc',
    'tool:duckdb',
    'tool:httpie',
    'tool:rsync',
    'tool:gh',
    'tool:aria2c',
    'tool:csvkit',
    'tool:miller',
    'tool:exiftool',
    'tool:imagemagick',
    'tool:osascript',
    'tool:playwright',
    'tool:yt-dlp',
    'tool:aws',
    'tool:gcloud',
    'tool:az'
  ];

  describe('getScannedToolIds()', function () {
    it('should return all 27 tool IDs as scan targets', function () {
      const scannedIds = registry.getScannedToolIds();
      expect(scannedIds).to.be.an('array');
      expect(scannedIds).to.have.length.at.least(27);
    });

    it('should include every expected tool ID', function () {
      const scannedIds = registry.getScannedToolIds();
      for (const id of EXPECTED_TOOL_IDS) {
        expect(scannedIds, `missing scan target: ${id}`).to.include(id);
      }
    });

    it('should return a copy, not the internal array', function () {
      const a = registry.getScannedToolIds();
      const b = registry.getScannedToolIds();
      expect(a).to.not.equal(b);
      expect(a).to.deep.equal(b);
    });
  });

  describe('getSnapshot()', function () {
    it('should return available tools with node at minimum', function () {
      const snapshot = registry.getSnapshot();
      expect(snapshot).to.be.an('array').with.length.at.least(1);
      const nodeEntry = snapshot.find(t => t.id === 'tool:node');
      expect(nodeEntry, 'node should be available').to.exist;
    });

    it('should include id and available fields on each entry', function () {
      const snapshot = registry.getSnapshot();
      for (const entry of snapshot) {
        expect(entry).to.have.property('id').that.is.a('string');
        expect(entry).to.have.property('available', true);
      }
    });
  });

  describe('new tool definitions', function () {
    const NEW_TOOL_IDS = EXPECTED_TOOL_IDS.slice(7); // After the original 7

    it('should have 20 new tool IDs beyond the original 7', function () {
      expect(NEW_TOOL_IDS).to.have.lengthOf(20);
    });

    it('all new tool IDs appear in scanned targets', function () {
      const scannedIds = registry.getScannedToolIds();
      for (const id of NEW_TOOL_IDS) {
        expect(scannedIds, `missing new tool: ${id}`).to.include(id);
      }
    });
  });
});
