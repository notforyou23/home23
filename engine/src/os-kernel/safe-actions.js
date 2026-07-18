'use strict';

async function runSafeAction(spec, ctx) {
  const { runRemediator } = require('../live-problems/remediators');
  const id = spec?.id;
  if (id === 'restart_pm2') {
    const name = String(spec.args?.name || '');
    if (!/^home23-/.test(name)) throw new Error('restart_pm2 limited to home23-*');
    return runRemediator({ type: 'pm2_restart', args: { name } }, ctx);
  }
  if (id === 'reclaim_known_safe_disk') {
    return runRemediator({ type: 'exec_command', args: { name: 'reclaim_known_safe_disk' } }, ctx);
  }
  throw new Error(`safe action not in catalog: ${id}`);
}

module.exports = { runSafeAction };
