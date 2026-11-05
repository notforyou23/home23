import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ErrorMonitor } = require('../../../engine/src/coordinator/executive-coordinator.js');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test('ErrorMonitor classifies missing intake as a precondition failure', () => {
  const monitor = new ErrorMonitor(logger);
  const errors = monitor.classifyFailure({
    agentId: 'agent_doc',
    agentType: 'document_creation',
    status: 'needs_intake',
    reason: 'missing_claim',
    accomplishment: { accomplished: false },
    results: [{
      type: 'diagnostic',
      status: 'needs_intake',
      reason: 'missing_claim',
      requirement: 'claim_text'
    }]
  }, {
    violations: [{
      field: 'filesCreated',
      actual: 0,
      reason: 'must be at least 1'
    }]
  });

  assert.deepEqual(errors, ['E_PRECONDITION']);
});
