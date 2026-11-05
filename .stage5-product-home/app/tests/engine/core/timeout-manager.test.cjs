const assert = require('node:assert/strict');
const test = require('node:test');

const { TimeoutManager } = require('../../../engine/src/core/timeout-manager');

function createLogger() {
  const entries = [];
  return {
    entries,
    debug(message, meta) {
      entries.push({ level: 'debug', message, meta });
    },
    error(message, meta) {
      entries.push({ level: 'error', message, meta });
    },
    warn(message, meta) {
      entries.push({ level: 'warn', message, meta });
    },
  };
}

test('startCycleTimer invokes timeout callback with elapsed context', async () => {
  const logger = createLogger();
  const manager = new TimeoutManager({ timeouts: { cycleTimeoutMs: 10 } }, logger);

  const callback = await new Promise((resolve) => {
    manager.startCycleTimer(42, 10, (cycle, elapsedMs) => {
      resolve({ cycle, elapsedMs });
    });
  });

  assert.equal(callback.cycle, 42);
  assert.ok(callback.elapsedMs >= 0);
  assert.equal(manager.isCycleActive(), false);
  assert.ok(
    logger.entries.some((entry) => entry.message === '[TimeoutManager] Cycle timeout exceeded'),
    'expected cycle timeout log entry'
  );
});
