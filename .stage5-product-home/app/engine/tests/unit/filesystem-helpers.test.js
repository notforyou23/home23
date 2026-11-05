/**
 * Unit tests for FilesystemHelpers
 */

const { expect } = require('chai');
const { FilesystemHelpers } = require('../../src/cluster/fs/helpers');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('FilesystemHelpers', () => {
  let helpers;
  let mockLogger;
  let testDir;

  beforeEach(async () => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    helpers = new FilesystemHelpers(mockLogger);
    
    testDir = path.join(os.tmpdir(), `fs-helpers-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('atomicWrite', () => {
    it('should write file atomically', async () => {
      const filePath = path.join(testDir, 'test.txt');
      await helpers.atomicWrite(filePath, 'test content');
      
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).to.equal('test content');
    });

    it('should create parent directories', async () => {
      const filePath = path.join(testDir, 'deep/nested/file.txt');
      await helpers.atomicWrite(filePath, 'nested content');
      
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
    });

    it('should overwrite existing file', async () => {
      const filePath = path.join(testDir, 'overwrite.txt');
      
      await helpers.atomicWrite(filePath, 'old');
      await helpers.atomicWrite(filePath, 'new');
      
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).to.equal('new');
    });
  });

  describe('atomicRead', () => {
    it('should read existing file', async () => {
      const filePath = path.join(testDir, 'read.txt');
      await fs.writeFile(filePath, 'test data', 'utf8');
      
      const content = await helpers.atomicRead(filePath);
      expect(content).to.equal('test data');
    });

    it('should return default for non-existent file', async () => {
      const content = await helpers.atomicRead(
        path.join(testDir, 'nonexistent.txt'),
        { defaultValue: 'default' }
      );
      expect(content).to.equal('default');
    });
  });

  describe('atomicWriteJSON / atomicReadJSON', () => {
    it('should write and read JSON', async () => {
      const filePath = path.join(testDir, 'data.json');
      const data = { test: 'data', number: 42, nested: { key: 'value' } };
      
      await helpers.atomicWriteJSON(filePath, data);
      const read = await helpers.atomicReadJSON(filePath);
      
      expect(read).to.deep.equal(data);
    });

    it('should return default for missing JSON file', async () => {
      const read = await helpers.atomicReadJSON(
        path.join(testDir, 'missing.json'),
        { default: true }
      );
      expect(read).to.deep.equal({ default: true });
    });
  });

  describe('Lock Operations', () => {
    it('should acquire lock successfully', async () => {
      const lockPath = path.join(testDir, 'test.lock');
      const lockData = { owner: 'test', timestamp: Date.now() };
      
      const acquired = await helpers.tryAcquireLock(lockPath, lockData);
      expect(acquired).to.be.true;
      
      const stored = await helpers.readLock(lockPath);
      expect(stored.owner).to.equal('test');
    });

    it('should fail to acquire existing lock', async () => {
      const lockPath = path.join(testDir, 'existing.lock');
      
      const first = await helpers.tryAcquireLock(lockPath, { owner: 'first' });
      expect(first).to.be.true;
      
      const second = await helpers.tryAcquireLock(lockPath, { owner: 'second' });
      expect(second).to.be.false;
    });

    it('should release lock', async () => {
      const lockPath = path.join(testDir, 'release.lock');
      
      await helpers.tryAcquireLock(lockPath, { owner: 'test' });
      const released = await helpers.releaseLock(lockPath);
      expect(released).to.be.true;
      
      const exists = await fs.access(lockPath).then(() => true).catch(() => false);
      expect(exists).to.be.false;
    });

    it('should read lock data', async () => {
      const lockPath = path.join(testDir, 'read.lock');
      const lockData = { owner: 'reader', pid: 12345 };
      
      await helpers.tryAcquireLock(lockPath, lockData);
      const read = await helpers.readLock(lockPath);
      
      expect(read.owner).to.equal('reader');
      expect(read.pid).to.equal(12345);
    });
  });

  describe('appendToLog', () => {
    it('should append lines to log', async () => {
      const logPath = path.join(testDir, 'test.log');
      
      await helpers.appendToLog(logPath, 'line 1');
      await helpers.appendToLog(logPath, 'line 2');
      await helpers.appendToLog(logPath, 'line 3');
      
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.trim().split('\n');
      
      expect(lines).to.have.lengthOf(3);
      expect(lines[0]).to.equal('line 1');
      expect(lines[1]).to.equal('line 2');
      expect(lines[2]).to.equal('line 3');
    });

    it('should create log file if missing', async () => {
      const logPath = path.join(testDir, 'logs/new.log');
      await helpers.appendToLog(logPath, 'first entry');
      
      const exists = await fs.access(logPath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
    });
  });

  describe('listDirectory', () => {
    it('should list directory contents', async () => {
      const dir = path.join(testDir, 'list');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'file1.txt'), 'data');
      await fs.writeFile(path.join(dir, 'file2.txt'), 'data');
      await fs.writeFile(path.join(dir, 'file3.txt'), 'data');
      
      const files = await helpers.listDirectory(dir);
      expect(files).to.have.lengthOf(3);
      expect(files).to.include('file1.txt');
    });

    it('should filter with custom function', async () => {
      const dir = path.join(testDir, 'filtered');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'keep.json'), 'data');
      await fs.writeFile(path.join(dir, 'skip.txt'), 'data');
      
      const files = await helpers.listDirectory(dir, f => f.endsWith('.json'));
      expect(files).to.have.lengthOf(1);
      expect(files[0]).to.equal('keep.json');
    });

    it('should return empty array for non-existent directory', async () => {
      const files = await helpers.listDirectory(path.join(testDir, 'nonexistent'));
      expect(files).to.be.an('array').that.is.empty;
    });
  });

  describe('fileExists', () => {
    it('should detect existing file', async () => {
      const filePath = path.join(testDir, 'exists.txt');
      await fs.writeFile(filePath, 'data');
      
      const exists = await helpers.fileExists(filePath);
      expect(exists).to.be.true;
    });

    it('should detect non-existing file', async () => {
      const exists = await helpers.fileExists(path.join(testDir, 'nope.txt'));
      expect(exists).to.be.false;
    });
  });

  describe('atomicIncrement', () => {
    it('should increment counter', async () => {
      const counterPath = path.join(testDir, 'counter.txt');
      
      const val1 = await helpers.atomicIncrement(counterPath);
      expect(val1).to.equal(1);
      
      const val2 = await helpers.atomicIncrement(counterPath);
      expect(val2).to.equal(2);
      
      const val3 = await helpers.atomicIncrement(counterPath, 5);
      expect(val3).to.equal(7);
    });

    it('should handle concurrent increments safely', async () => {
      const counterPath = path.join(testDir, 'concurrent.txt');
      
      // Simulate concurrent increments
      const results = await Promise.all([
        helpers.atomicIncrement(counterPath),
        helpers.atomicIncrement(counterPath),
        helpers.atomicIncrement(counterPath)
      ]);
      
      // Final value should be 3
      const final = await helpers.atomicRead(counterPath, { encoding: 'utf8' });
      expect(parseInt(final)).to.equal(3);
    });
  });

  describe('calculateFileHash', () => {
    it('should calculate SHA256 hash', async () => {
      const filePath = path.join(testDir, 'hash.txt');
      await fs.writeFile(filePath, 'test content for hashing', 'utf8');
      
      const hash = await helpers.calculateFileHash(filePath);
      expect(hash).to.be.a('string');
      expect(hash).to.have.lengthOf(64); // SHA256 = 64 hex chars
    });

    it('should produce same hash for same content', async () => {
      const file1 = path.join(testDir, 'hash1.txt');
      const file2 = path.join(testDir, 'hash2.txt');
      
      await fs.writeFile(file1, 'identical', 'utf8');
      await fs.writeFile(file2, 'identical', 'utf8');
      
      const hash1 = await helpers.calculateFileHash(file1);
      const hash2 = await helpers.calculateFileHash(file2);
      
      expect(hash1).to.equal(hash2);
    });
  });
});

