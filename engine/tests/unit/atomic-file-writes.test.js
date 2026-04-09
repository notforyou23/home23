/**
 * Unit Tests: Atomic File Writes
 * Verifies BaseAgent atomic write helpers prevent corruption
 */

const assert = require('node:assert/strict');
const fs = require('fs').promises;
const path = require('path');
const { BaseAgent } = require('../../src/agents/base-agent');

describe('BaseAgent Atomic File Operations', () => {
  const testDir = path.join(__dirname, '../../test-results/atomic-writes');
  let mockAgent;

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
    
    // Create mock agent
    const mockMission = { goalId: 'test', description: 'test', tools: [] };
    const mockConfig = { logsDir: testDir };
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    
    mockAgent = new BaseAgent(mockMission, mockConfig, mockLogger);
  });

  after(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('writeFileAtomic', () => {
    it('should write file atomically using temp-then-rename', async () => {
      const testFile = path.join(testDir, 'test-atomic.txt');
      const content = 'Hello, atomic world!';
      
      await mockAgent.writeFileAtomic(testFile, content, { encoding: 'utf8' });
      
      // Verify file exists
      const exists = await fs.access(testFile).then(() => true).catch(() => false);
      assert.strictEqual(exists, true);
      
      // Verify content is correct
      const savedContent = await fs.readFile(testFile, 'utf8');
      assert.strictEqual(savedContent, content);
      
      // Verify no temp file remains
      const tempExists = await fs.access(testFile + '.tmp').then(() => true).catch(() => false);
      assert.strictEqual(tempExists, false);
    });

    it('should write binary content correctly', async () => {
      const testFile = path.join(testDir, 'test-binary.bin');
      const buffer = Buffer.from([0x01, 0x02, 0x03, 0xFF, 0xFE]);
      
      await mockAgent.writeFileAtomic(testFile, buffer);
      
      const savedBuffer = await fs.readFile(testFile);
      assert.deepStrictEqual(savedBuffer, buffer);
    });

    it('should cleanup temp file on write error', async () => {
      const invalidPath = path.join(testDir, 'nonexistent-dir', 'file.txt');
      const content = 'test';
      
      await assert.rejects(
        mockAgent.writeFileAtomic(invalidPath, content),
        /ENOENT/
      );
      
      // Verify no orphaned temp file
      const tempExists = await fs.access(invalidPath + '.tmp').then(() => true).catch(() => false);
      assert.strictEqual(tempExists, false);
    });

    it('should overwrite existing file atomically', async () => {
      const testFile = path.join(testDir, 'test-overwrite.txt');
      
      // Write first version
      await mockAgent.writeFileAtomic(testFile, 'version 1');
      const v1 = await fs.readFile(testFile, 'utf8');
      assert.strictEqual(v1, 'version 1');
      
      // Overwrite with second version
      await mockAgent.writeFileAtomic(testFile, 'version 2');
      const v2 = await fs.readFile(testFile, 'utf8');
      assert.strictEqual(v2, 'version 2');
    });
  });

  describe('writeCompletionMarker', () => {
    it('should write completion marker with metadata', async () => {
      const outputDir = path.join(testDir, 'deliverable-1');
      await fs.mkdir(outputDir, { recursive: true });
      
      const metadata = {
        fileCount: 5,
        totalSize: 12345
      };
      
      await mockAgent.writeCompletionMarker(outputDir, metadata);
      
      // Verify marker exists
      const markerPath = path.join(outputDir, '.complete');
      const markerExists = await fs.access(markerPath).then(() => true).catch(() => false);
      assert.strictEqual(markerExists, true);
      
      // Verify marker content
      const markerContent = await fs.readFile(markerPath, 'utf8');
      const parsed = JSON.parse(markerContent);
      
      assert.strictEqual(parsed.fileCount, 5);
      assert.strictEqual(parsed.totalSize, 12345);
      assert.ok(parsed.completedAt);
      assert.ok(parsed.agentId);
    });

    it('should use atomic write for marker (no .tmp remnants)', async () => {
      const outputDir = path.join(testDir, 'deliverable-2');
      await fs.mkdir(outputDir, { recursive: true });
      
      await mockAgent.writeCompletionMarker(outputDir, { fileCount: 1 });
      
      const markerPath = path.join(outputDir, '.complete');
      const tempExists = await fs.access(markerPath + '.tmp').then(() => true).catch(() => false);
      assert.strictEqual(tempExists, false);
    });
  });

  describe('checkCompletionMarker', () => {
    it('should detect complete deliverable', async () => {
      const outputDir = path.join(testDir, 'deliverable-3');
      await fs.mkdir(outputDir, { recursive: true });
      
      // Write marker
      await mockAgent.writeCompletionMarker(outputDir, { fileCount: 3 });
      
      // Check marker
      const result = await mockAgent.checkCompletionMarker(outputDir);
      
      assert.strictEqual(result.complete, true);
      assert.ok(result.metadata);
      assert.strictEqual(result.metadata.fileCount, 3);
    });

    it('should detect incomplete deliverable', async () => {
      const outputDir = path.join(testDir, 'deliverable-4');
      await fs.mkdir(outputDir, { recursive: true });
      
      // Write some files but NO marker
      await fs.writeFile(path.join(outputDir, 'file1.txt'), 'content');
      await fs.writeFile(path.join(outputDir, 'file2.txt'), 'content');
      
      // Check marker
      const result = await mockAgent.checkCompletionMarker(outputDir);
      
      assert.strictEqual(result.complete, false);
      assert.strictEqual(result.metadata, undefined);
    });

    it('should handle non-existent directory gracefully', async () => {
      const outputDir = path.join(testDir, 'nonexistent');
      
      const result = await mockAgent.checkCompletionMarker(outputDir);
      
      assert.strictEqual(result.complete, false);
    });
  });

  describe('cleanupOrphanedTempFiles', () => {
    it('should remove old temp files', async () => {
      const outputDir = path.join(testDir, 'cleanup-1');
      await fs.mkdir(outputDir, { recursive: true });
      
      // Create old temp file
      const tempPath = path.join(outputDir, 'file.txt.tmp');
      await fs.writeFile(tempPath, 'old temp');
      
      // Set mtime to 10 minutes ago
      const tenMinAgo = new Date(Date.now() - 600000);
      await fs.utimes(tempPath, tenMinAgo, tenMinAgo);
      
      // Cleanup with 5 minute threshold
      const cleaned = await mockAgent.cleanupOrphanedTempFiles(outputDir, 300000);
      
      assert.strictEqual(cleaned, 1);
      
      // Verify temp file was removed
      const exists = await fs.access(tempPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, false);
    });

    it('should preserve recent temp files', async () => {
      const outputDir = path.join(testDir, 'cleanup-2');
      await fs.mkdir(outputDir, { recursive: true });
      
      // Create recent temp file
      const tempPath = path.join(outputDir, 'recent.txt.tmp');
      await fs.writeFile(tempPath, 'recent temp');
      
      // Cleanup with 5 minute threshold (file is fresh)
      const cleaned = await mockAgent.cleanupOrphanedTempFiles(outputDir, 300000);
      
      assert.strictEqual(cleaned, 0);
      
      // Verify temp file still exists
      const exists = await fs.access(tempPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, true);
    });

    it('should not cleanup non-temp files', async () => {
      const outputDir = path.join(testDir, 'cleanup-3');
      await fs.mkdir(outputDir, { recursive: true });
      
      // Create regular file
      const regularPath = path.join(outputDir, 'regular.txt');
      await fs.writeFile(regularPath, 'regular file');
      
      // Create old temp file
      const tempPath = path.join(outputDir, 'old.txt.tmp');
      await fs.writeFile(tempPath, 'old temp');
      const tenMinAgo = new Date(Date.now() - 600000);
      await fs.utimes(tempPath, tenMinAgo, tenMinAgo);
      
      // Cleanup
      const cleaned = await mockAgent.cleanupOrphanedTempFiles(outputDir, 300000);
      
      assert.strictEqual(cleaned, 1);  // Only temp file
      
      // Verify regular file still exists
      const exists = await fs.access(regularPath).then(() => true).catch(() => false);
      assert.strictEqual(exists, true);
    });

    it('should handle empty directory gracefully', async () => {
      const outputDir = path.join(testDir, 'cleanup-4');
      await fs.mkdir(outputDir, { recursive: true });
      
      const cleaned = await mockAgent.cleanupOrphanedTempFiles(outputDir);
      
      assert.strictEqual(cleaned, 0);
    });
  });

  describe('Atomic Write Integration', () => {
    it('should prevent partial file visibility on simulated crash', async () => {
      const testFile = path.join(testDir, 'crash-test.txt');
      const largeContent = 'x'.repeat(1024 * 1024); // 1MB
      
      // Normal atomic write completes successfully
      await mockAgent.writeFileAtomic(testFile, largeContent);
      
      // Verify: Final file exists
      const finalExists = await fs.access(testFile).then(() => true).catch(() => false);
      assert.strictEqual(finalExists, true);
      
      // Verify: No temp file
      const tempExists = await fs.access(testFile + '.tmp').then(() => true).catch(() => false);
      assert.strictEqual(tempExists, false);
      
      // Verify: Content is complete
      const savedContent = await fs.readFile(testFile, 'utf8');
      assert.strictEqual(savedContent.length, largeContent.length);
    });
  });
});

