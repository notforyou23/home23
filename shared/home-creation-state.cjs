'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/** Starting runtime is a separate step from writing a partial new home.
 * Legacy installations have no creation receipt and retain their behavior.
 * A new home's interrupted or unreadable receipt requires setup recovery;
 * neither the CLI nor the dashboard may start its partial configuration. */
function assertHomeCreationReady(home23Root) {
  let creation;
  try {
    creation = JSON.parse(readFileSync(join(home23Root, 'instances', '.house', 'creation.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    const unavailable = new Error('Home creation receipt is unreadable. Resume setup with: node cli/home23.js setup', { cause: error });
    unavailable.code = 'home_creation_incomplete';
    throw unavailable;
  }
  if (creation?.status !== 'prepared') {
    const pending = new Error('Home creation is incomplete. Resume setup with: node cli/home23.js setup');
    pending.code = 'home_creation_incomplete';
    throw pending;
  }
}

module.exports = { assertHomeCreationReady };
