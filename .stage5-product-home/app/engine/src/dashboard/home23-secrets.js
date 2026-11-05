'use strict';

const {
  updateHome23Secrets,
} = require('../../../shared/home23-secrets.cjs');

function updateSettingsSecrets(home23Root, mutator, options = {}) {
  return updateHome23Secrets(home23Root, mutator, options);
}

module.exports = {
  updateSettingsSecrets,
};
