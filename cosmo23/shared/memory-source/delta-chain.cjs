'use strict';

const { createHash } = require('node:crypto');

function emptyDeltaDigest() {
  return createHash('sha256').digest('hex');
}

function nextDeltaChainDigest(previousDigest, payload) {
  if (typeof previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(previousDigest)) {
    throw new TypeError('valid previous delta digest required');
  }
  return createHash('sha256')
    .update(`home23-delta-record-v1\0${previousDigest}\0${JSON.stringify(payload)}`)
    .digest('hex');
}

module.exports = {
  emptyDeltaDigest,
  nextDeltaChainDigest,
};
