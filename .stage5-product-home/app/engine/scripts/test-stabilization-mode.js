#!/usr/bin/env node

/**
 * Stabilization Mode Integration Test
 * Verifies config generation works correctly with stabilization enabled/disabled
 */

const { ConfigGenerator } = require('../src/launcher/config-generator.js');

console.log('\n=== Stabilization Mode Integration Test ===\n');

const gen = new ConfigGenerator('.', { info: () => {}, error: console.error });

// Test 1: Stabilization ON
console.log('Test 1: Stabilization Mode ENABLED');
const settingsOn = {
  exploration_mode: 'autonomous',
  domain: '',
  max_cycles: '100',
  enable_stabilization: true,
  review_period: 20,
  max_concurrent: 4
};

gen.generateConfig(settingsOn).then(configYaml => {
  const checks = {
    curiosityAllowed: configYaml.match(/curiosityAllowed: (true|false)/)?.[1],
    parallelBranches: configYaml.match(/parallelBranches: (\d+)/)?.[1],
    tunnelingProbability: configYaml.match(/tunnelingProbability: ([\d.]+)/)?.[1],
    chaosEnabled: configYaml.match(/chaosEnabled: (true|false)/)?.[1],
    mutationsEnabled: configYaml.match(/mutations:\s+enabled: (true|false)/)?.[1],
    mutationRate: configYaml.match(/mutationRate: ([\d.]+)/)?.[1],
    curiosityEnabled: configYaml.match(/curiosityEnabled: (true|false)/)?.[1],
    moodEnabled: configYaml.match(/moodEnabled: (true|false)/)?.[1],
    reviewCyclePeriod: configYaml.match(/reviewCyclePeriod: (\d+)/)?.[1]
  };
  
  const expected = {
    curiosityAllowed: 'false',
    parallelBranches: '3',
    tunnelingProbability: '0',
    chaosEnabled: 'false',
    mutationsEnabled: 'false',
    mutationRate: '0',
    curiosityEnabled: 'false',
    moodEnabled: 'false',
    reviewCyclePeriod: '5'
  };
  
  let passed = 0;
  let failed = 0;
  
  for (const [key, actual] of Object.entries(checks)) {
    const exp = expected[key];
    if (actual === exp) {
      console.log(`  ✓ ${key}: ${actual}`);
      passed++;
    } else {
      console.log(`  ✗ ${key}: expected ${exp}, got ${actual}`);
      failed++;
    }
  }
  
  console.log(`\n  Result: ${passed} passed, ${failed} failed\n`);
  
  // Test 2: Stabilization OFF
  console.log('Test 2: Stabilization Mode DISABLED');
  settingsOn.enable_stabilization = false;
  return gen.generateConfig(settingsOn);
}).then(configYaml => {
  const checks = {
    curiosityAllowed: configYaml.match(/curiosityAllowed: (true|false)/)?.[1],
    parallelBranches: configYaml.match(/parallelBranches: (\d+)/)?.[1],
    tunnelingProbability: configYaml.match(/tunnelingProbability: ([\d.]+)/)?.[1],
    chaosEnabled: configYaml.match(/chaosEnabled: (true|false)/)?.[1],
    mutationsEnabled: configYaml.match(/mutations:\s+enabled: (true|false)/)?.[1],
    mutationRate: configYaml.match(/mutationRate: ([\d.]+)/)?.[1],
    curiosityEnabled: configYaml.match(/curiosityEnabled: (true|false)/)?.[1],
    moodEnabled: configYaml.match(/moodEnabled: (true|false)/)?.[1],
    reviewCyclePeriod: configYaml.match(/reviewCyclePeriod: (\d+)/)?.[1]
  };
  
  const expected = {
    curiosityAllowed: 'true',
    parallelBranches: '5',
    tunnelingProbability: '0.02',
    chaosEnabled: 'true',
    mutationsEnabled: 'true',
    mutationRate: '0.1',
    curiosityEnabled: 'true',
    moodEnabled: 'true',
    reviewCyclePeriod: '20'
  };
  
  let passed = 0;
  let failed = 0;
  
  for (const [key, actual] of Object.entries(checks)) {
    const exp = expected[key];
    if (actual === exp) {
      console.log(`  ✓ ${key}: ${actual}`);
      passed++;
    } else {
      console.log(`  ✗ ${key}: expected ${exp}, got ${actual}`);
      failed++;
    }
  }
  
  console.log(`\n  Result: ${passed} passed, ${failed} failed\n`);
  
  // Test 3: Metadata generation
  console.log('Test 3: Metadata Generation');
  const metadataOn = gen.generateMetadata({ enable_stabilization: true }, false);
  const metadataOff = gen.generateMetadata({ enable_stabilization: false }, false);
  
  console.log(`  Stabilization ON:  enableStabilization = ${metadataOn.enableStabilization}`);
  console.log(`  Stabilization OFF: enableStabilization = ${metadataOff.enableStabilization}`);
  
  if (metadataOn.enableStabilization === true && metadataOff.enableStabilization === false) {
    console.log('  ✓ Metadata correctly stores stabilization flag\n');
  } else {
    console.log('  ✗ Metadata stabilization flag incorrect\n');
  }
  
  console.log('=== All Tests Complete ===\n');
}).catch(err => {
  console.error('✗ Test failed:', err);
  process.exit(1);
});

