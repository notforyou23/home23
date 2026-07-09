import test from 'node:test';
import assert from 'node:assert/strict';

import { runRemediator } from '../../engine/src/live-problems/remediators.js';

test('shared-service live-problem restarts use the startup coordinator', async () => {
  let received;
  const result = await runRemediator(
    { type: 'pm2_restart', args: { name: 'home23-cosmo23' } },
    {
      home23Root: '/tmp/home23',
      sharedService: { name: 'home23-cosmo23', label: 'COSMO 2.3' },
      coordinateSharedServiceStartup: async (options) => {
        received = options;
        return { ok: true };
      },
    },
  );

  assert.deepEqual(result, {
    outcome: 'success',
    detail: 'coordinated restart for home23-cosmo23',
  });
  assert.equal(received.home23Root, '/tmp/home23');
  assert.equal(received.restartOnline, true);
  assert.deepEqual(received.services, [{ name: 'home23-cosmo23', label: 'COSMO 2.3' }]);
});
