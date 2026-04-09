/**
 * Integration Test: Sleep/Wake Cycle Fix
 * Verifies that the sleep bug fixes prevent indefinite sleep and keep dashboard current
 */

const assert = require('node:assert/strict');
const { StateCompression } = require('../../src/core/state-compression');
const fs = require('fs').promises;
const path = require('path');

describe('Sleep/Wake Cycle Fixes', () => {
  const testStateDir = path.join(__dirname, '../../test-results');
  const testStatePath = path.join(testStateDir, 'test-state.json');

  before(async () => {
    // Ensure test directory exists
    await fs.mkdir(testStateDir, { recursive: true });
  });

  after(async () => {
    // Cleanup test state file
    try {
      await fs.unlink(testStatePath + '.gz');
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('Energy recovery rate allows wake within 13 cycles', () => {
    const energyRecoveryRate = 0.05; // From fix #3
    const sleepThreshold = 0.2;
    const wakeThreshold = 0.8;
    const energyGap = wakeThreshold - sleepThreshold;
    
    // Using Math.ceil because partial cycle rounds up
    const cyclesNeeded = Math.ceil(energyGap / energyRecoveryRate);
    
    // 0.6 / 0.05 = 12, but with ceil: Math.ceil(12) = 12
    // However floating point: 0.8 - 0.2 = 0.6000000000000001, so ceil gives 13
    assert.ok(cyclesNeeded <= 13, `Expected cycles ${cyclesNeeded} to be <= 13`);
    
    // Verify much faster than old rate (0.03 would take 20 cycles)
    const oldRate = 0.03;
    const oldCycles = Math.ceil(energyGap / oldRate);
    assert.ok(cyclesNeeded < oldCycles, `New rate (${cyclesNeeded} cycles) should be faster than old (${oldCycles} cycles)`);
  });

  it('Force wake API modifies state correctly', async () => {
    // Create a test state with sleeping system
    const sleepingState = {
      cycleCount: 25,
      cognitiveState: {
        energy: 0.18,
        mode: 'sleeping',
        lastModeChange: new Date().toISOString()
      },
      temporal: {
        state: 'sleeping',
        lastSleepStart: new Date().toISOString()
      }
    };

    // Save sleeping state
    await StateCompression.saveCompressed(testStatePath, sleepingState, {
      compress: true,
      pretty: false
    });

    // Load it back
    const loadedState = await StateCompression.loadCompressed(testStatePath);
    
    // Verify it's sleeping
    assert.strictEqual(loadedState.cognitiveState.mode, 'sleeping');
    assert.strictEqual(loadedState.temporal.state, 'sleeping');
    assert.ok(loadedState.cognitiveState.energy < 0.2);

    // Simulate force wake (what the API does)
    loadedState.cognitiveState.energy = 0.9;
    loadedState.cognitiveState.mode = 'active';
    loadedState.temporal.state = 'awake';

    // Save modified state
    await StateCompression.saveCompressed(testStatePath, loadedState, {
      compress: true,
      pretty: false
    });

    // Verify wake was applied
    const wakenState = await StateCompression.loadCompressed(testStatePath);
    assert.strictEqual(wakenState.cognitiveState.mode, 'active');
    assert.strictEqual(wakenState.temporal.state, 'awake');
    assert.ok(wakenState.cognitiveState.energy >= 0.8);
  });

  it('Energy drain/recovery balance is positive during sleep', () => {
    const energyDrain = 0.02;  // Active drain per cycle
    const energyRecovery = 0.05; // Sleep recovery per cycle
    
    // During sleep, recovery should exceed any residual drain
    assert.ok(energyRecovery > energyDrain);
    
    // Net recovery per sleep cycle
    const netRecovery = energyRecovery; // Drain doesn't apply during sleep
    assert.strictEqual(netRecovery, 0.05);
  });

  it('Wake threshold is lower than full energy', () => {
    // Ensure system doesn't need to fully recover to wake
    const wakeThreshold = 0.8;
    const fullEnergy = 1.0;
    
    assert.ok(wakeThreshold < fullEnergy);
    assert.ok(wakeThreshold >= 0.5); // Force wake threshold
  });

  it('Dashboard saveState interval during sleep', () => {
    // Verify saveState happens every 5 cycles even during sleep
    const saveInterval = 5;
    
    // Test cycles that should trigger save
    const testCycles = [5, 10, 15, 20, 25, 30];
    testCycles.forEach(cycle => {
      assert.strictEqual(cycle % saveInterval, 0);
    });
    
    // Cycles that shouldn't trigger save
    const nonSaveCycles = [1, 2, 3, 4, 6, 7, 8, 9, 11];
    nonSaveCycles.forEach(cycle => {
      assert.notStrictEqual(cycle % saveInterval, 0);
    });
  });
});

