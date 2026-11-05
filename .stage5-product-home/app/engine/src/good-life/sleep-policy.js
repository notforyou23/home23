'use strict';

const fs = require('fs');
const path = require('path');

function readGoodLifeSleepPolicy(brainDir) {
  const state = readJson(path.join(brainDir || '', 'good-life-state.json'));
  const mode = state?.policy?.mode || 'observe';
  const lanes = state?.lanes || {};
  const frictionStrained = lanes.friction?.status === 'strained' || lanes.friction?.status === 'critical';
  const recoveryCritical = lanes.recovery?.status === 'critical';
  const viabilityCritical = lanes.viability?.status === 'critical';

  if (mode === 'rest') {
    return {
      mode,
      forceSleep: true,
      suppressNewSleep: false,
      minimumCycles: 4,
      wakeThreshold: 0.5,
      reason: state.summary || 'Good Life rest policy',
    };
  }

  if (mode === 'recover' || recoveryCritical || frictionStrained) {
    return {
      mode,
      forceSleep: false,
      suppressNewSleep: false,
      minimumCycles: 4,
      wakeThreshold: 0.45,
      reason: state?.summary || 'Good Life recovery/friction policy',
    };
  }

  if ((mode === 'repair' || mode === 'help') && viabilityCritical) {
    return {
      mode,
      forceSleep: false,
      suppressNewSleep: true,
      minimumCycles: 0,
      wakeThreshold: null,
      reason: state?.summary || 'Good Life repair/help policy keeps loop awake',
    };
  }

  return { mode, forceSleep: false, suppressNewSleep: false, minimumCycles: 0, wakeThreshold: null, reason: null };
}

function readJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { readGoodLifeSleepPolicy };
