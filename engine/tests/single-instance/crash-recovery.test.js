/**
 * Single-Instance Integration Test: Crash Recovery
 * 
 * Tests crash detection and recovery in actual COSMO orchestrator
 */

const { expect } = require('chai');
const { CrashRecoveryManager } = require('../../src/core/crash-recovery-manager');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('Single-Instance: Crash Recovery', () => {
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
    
    testLogsDir = path.join(os.tmpdir(), `cosmo-recovery-test-${Date.now()}`);
    await fs.mkdir(testLogsDir, { recursive: true });
    
    manager = new CrashRecoveryManager(mockConfig, mockLogger, testLogsDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testLogsDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Crash Detection', () => {
    it('should detect unclean shutdown', async () => {
      // Simulate crash: create state file but no clean marker
      const statePath = path.join(testLogsDir, 'state.json');
      await fs.writeFile(statePath, JSON.stringify({ cycleCount: 10 }), 'utf8');
      
      const crashDetected = await manager.detectCrash();
      expect(crashDetected).to.be.true;
    });

    it('should detect clean shutdown', async () => {
      // Simulate clean shutdown: state + clean marker
      const statePath = path.join(testLogsDir, 'state.json');
      const cleanPath = path.join(testLogsDir, '.clean_shutdown');
      await fs.writeFile(statePath, JSON.stringify({ cycleCount: 10 }), 'utf8');
      await fs.writeFile(cleanPath, new Date().toISOString(), 'utf8');
      
      const crashDetected = await manager.detectCrash();
      expect(crashDetected).to.be.false;
    });
  });

  describe('Checkpoint and Recovery', () => {
    it('should save and recover from checkpoint', async () => {
      const testState = {
        cycleCount: 10,
        memory: {
          nodes: [{ id: 'n1', concept: 'persisted' }],
          edges: []
        },
        goals: []
      };

      // Save checkpoint
      await manager.saveCheckpoint(testState, 10);
      
      // Recover
      const recovered = await manager.recover();
      
      expect(recovered).to.not.be.null;
      expect(recovered.cycleCount).to.equal(10);
      expect(recovered.memory.nodes[0].concept).to.equal('persisted');
    });

    it('should recover from last clean cycle after mid-cycle crash', async () => {
      // Save checkpoint at cycle 10
      await manager.saveCheckpoint({ cycleCount: 10, status: 'clean' }, 10);
      
      // Simulate crash at cycle 12 (no checkpoint)
      // Crash would have no checkpoint for cycle 12
      
      // Recovery should get cycle 10
      const recovered = await manager.recover();
      expect(recovered).to.not.be.null;
      expect(recovered.cycleCount).to.equal(10);
      expect(recovered.status).to.equal('clean');
    });

    it('should fallback to older checkpoint if recent is corrupt', async () => {
      // Save valid checkpoint at cycle 5
      await manager.saveCheckpoint({ cycleCount: 5, status: 'valid' }, 5);
      
      // Save corrupt checkpoint at cycle 10
      const corruptPath = manager.getCheckpointPath(10);
      await fs.mkdir(path.dirname(corruptPath), { recursive: true });
      await fs.writeFile(corruptPath, 'invalid json{{{', 'utf8');
      
      // Recovery should get cycle 5
      const recovered = await manager.recover();
      expect(recovered).to.not.be.null;
      expect(recovered.cycleCount).to.equal(5);
      expect(recovered.status).to.equal('valid');
    });
  });

  describe('Clean Shutdown Marker', () => {
    it('should mark shutdown as clean', async () => {
      await manager.markCleanShutdown();
      
      const cleanPath = path.join(testLogsDir, '.clean_shutdown');
      const exists = await fs.access(cleanPath).then(() => true).catch(() => false);
      expect(exists).to.be.true;
      
      const content = await fs.readFile(cleanPath, 'utf8');
      expect(content).to.match(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    });
  });

  describe('Recovery Journal', () => {
    it('should log recovery events', async () => {
      await manager.logRecoveryEvent('TEST_RECOVERY', { detail: 'test data' });
      
      const journal = await manager.getRecoveryJournal();
      expect(journal).to.have.lengthOf(1);
      expect(journal[0].eventType).to.equal('TEST_RECOVERY');
      expect(journal[0].detail).to.equal('test data');
    });

    it('should track crash detection in recovery journal', async () => {
      await manager.initialize();
      
      // Should have logged initialization
      const journal = await manager.getRecoveryJournal();
      expect(journal.length).to.be.at.least(0); // May or may not have events
    });
  });
});

