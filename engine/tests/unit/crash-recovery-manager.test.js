/**
 * Unit tests for CrashRecoveryManager
 */

const { expect } = require('chai');
const { CrashRecoveryManager } = require('../../src/core/crash-recovery-manager');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('CrashRecoveryManager', () => {
  let manager;
  let mockLogger;
  let mockConfig;
  let testLogsDir;

  beforeEach(async () => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    mockConfig = {
      recovery: {
        checkpointInterval: 5,
        maxCheckpoints: 3
      }
    };
    
    // Create temp directory for tests
    testLogsDir = path.join(os.tmpdir(), `cosmo-test-${Date.now()}`);
    await fs.mkdir(testLogsDir, { recursive: true });
    
    manager = new CrashRecoveryManager(mockConfig, mockLogger, testLogsDir);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testLogsDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('detectCrash', () => {
    it('should detect no crash on first run', async () => {
      const crashDetected = await manager.detectCrash();
      expect(crashDetected).to.be.false;
    });

    it('should detect crash when state exists but no clean marker', async () => {
      // Create state file
      const statePath = path.join(testLogsDir, 'state.json');
      await fs.writeFile(statePath, '{"cycleCount":10}', 'utf8');
      
      // No clean shutdown marker
      const crashDetected = await manager.detectCrash();
      expect(crashDetected).to.be.true;
    });

    it('should detect clean shutdown when marker exists', async () => {
      // Create both state and clean marker
      const statePath = path.join(testLogsDir, 'state.json');
      const cleanPath = path.join(testLogsDir, '.clean_shutdown');
      await fs.writeFile(statePath, '{"cycleCount":10}', 'utf8');
      await fs.writeFile(cleanPath, new Date().toISOString(), 'utf8');
      
      const crashDetected = await manager.detectCrash();
      expect(crashDetected).to.be.false;
    });
  });

  describe('saveCheckpoint', () => {
    it('should save checkpoint at interval', async () => {
      const state = { cycleCount: 5, test: 'data' };
      await manager.saveCheckpoint(state, 5);
      
      const checkpointPath = manager.getCheckpointPath(5);
      const exists = await fs.access(checkpointPath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
      
      const content = await fs.readFile(checkpointPath, 'utf8');
      const checkpoint = JSON.parse(content);
      expect(checkpoint.cycle).to.equal(5);
      expect(checkpoint.state.test).to.equal('data');
    });

    it('should not save checkpoint if not at interval', async () => {
      const state = { cycleCount: 3 };
      await manager.saveCheckpoint(state, 3); // Not divisible by 5
      
      const checkpointsDir = path.join(testLogsDir, 'checkpoints');
      try {
        const files = await fs.readdir(checkpointsDir);
        expect(files).to.be.empty;
      } catch (error) {
        // Directory might not exist, which is fine
        expect(error.code).to.equal('ENOENT');
      }
    });

    it('should cleanup old checkpoints', async () => {
      // Save 5 checkpoints (max is 3)
      for (let i = 1; i <= 5; i++) {
        const cycle = i * 5;
        await manager.saveCheckpoint({ cycleCount: cycle }, cycle);
      }
      
      const checkpoints = await manager.listCheckpoints();
      expect(checkpoints.length).to.be.at.most(3);
      
      // Should have most recent checkpoints
      expect(checkpoints[checkpoints.length - 1]).to.include('checkpoint-25');
    });
  });

  describe('recover', () => {
    it('should return null when no checkpoints exist', async () => {
      const recovered = await manager.recover();
      expect(recovered).to.be.null;
    });

    it('should recover from most recent checkpoint', async () => {
      // Save checkpoints
      await manager.saveCheckpoint({ cycleCount: 5, data: 'old' }, 5);
      await manager.saveCheckpoint({ cycleCount: 10, data: 'recent' }, 10);
      
      const recovered = await manager.recover();
      expect(recovered).to.not.be.null;
      expect(recovered.data).to.equal('recent');
    });

    it('should try older checkpoint if recent one fails', async () => {
      // Save valid checkpoint
      await manager.saveCheckpoint({ cycleCount: 5, data: 'valid' }, 5);
      
      // Save corrupt checkpoint
      const corruptPath = manager.getCheckpointPath(10);
      await fs.mkdir(path.dirname(corruptPath), { recursive: true });
      await fs.writeFile(corruptPath, 'invalid json{{{', 'utf8');
      
      const recovered = await manager.recover();
      expect(recovered).to.not.be.null;
      expect(recovered.data).to.equal('valid');
    });
  });

  describe('markCleanShutdown', () => {
    it('should create clean shutdown marker', async () => {
      await manager.markCleanShutdown();
      
      const cleanPath = path.join(testLogsDir, '.clean_shutdown');
      const exists = await fs.access(cleanPath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
    });
  });

  describe('getStats', () => {
    it('should return recovery stats', () => {
      const stats = manager.getStats();
      
      expect(stats).to.have.property('crashDetected');
      expect(stats).to.have.property('recoveryAttempts');
      expect(stats).to.have.property('lastCheckpointCycle');
      expect(stats).to.have.property('checkpointInterval');
      expect(stats).to.have.property('maxCheckpoints');
    });
  });

  describe('logRecoveryEvent', () => {
    it('should log recovery events to journal', async () => {
      await manager.logRecoveryEvent('TEST_EVENT', { detail: 'test data' });
      
      const journal = await manager.getRecoveryJournal();
      expect(journal).to.have.lengthOf(1);
      expect(journal[0].eventType).to.equal('TEST_EVENT');
      expect(journal[0].detail).to.equal('test data');
    });

    it('should return empty journal if file missing', async () => {
      const journal = await manager.getRecoveryJournal();
      expect(journal).to.be.an('array').that.is.empty;
    });
  });
});

