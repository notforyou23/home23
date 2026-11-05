'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isFuseBoxNotify } = require('../../../engine/src/live-problems/loop.js');

test('isFuseBoxNotify allows explicit fuseBox and critical severity only', () => {
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { fuseBox: true, severity: 'normal' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'critical' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'emergency' } }), true);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'alert' } }), false);
  assert.equal(isFuseBoxNotify({ type: 'notify_jtr', args: { severity: 'normal' } }), false);
  assert.equal(isFuseBoxNotify({ type: 'dispatch_to_agent', args: { fuseBox: true } }), false);
});
