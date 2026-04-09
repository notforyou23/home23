#!/usr/bin/env node
/**
 * Test script for the Evobrew config system
 * 
 * Tests:
 * 1. Directory initialization
 * 2. Config save/load with encryption
 * 3. Migration from .env
 * 4. Environment variable bridge
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Test directory (use a temp dir to avoid touching real config)
const TEST_DIR = path.join(os.tmpdir(), `evobrew-config-test-${Date.now()}`);
const ORIG_HOMEDIR = os.homedir;

console.log('🧪 Evobrew Config System Tests\n');
console.log(`   Test directory: ${TEST_DIR}\n`);

// Create test directory
fs.mkdirSync(TEST_DIR, { recursive: true });

// Temporarily override homedir for testing
os.homedir = () => TEST_DIR;

// Now require the modules (they'll use our test directory)
const encryption = require('../lib/encryption');
const configManager = require('../lib/config-manager');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`   ❌ ${name}`);
    console.log(`      Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}Expected "${expected}", got "${actual}"`);
  }
}

function assertTrue(value, msg = '') {
  if (!value) {
    throw new Error(`${msg}Expected truthy value, got "${value}"`);
  }
}

async function runTests() {
  // ============================================================================
  // Encryption Tests
  // ============================================================================

  console.log('📦 Encryption Module');

  await test('encrypt and decrypt roundtrip', async () => {
    const secret = 'sk-ant-api01-test-key-12345';
    const encrypted = encryption.encrypt(secret);
    const decrypted = encryption.decrypt(encrypted);
    assertEqual(decrypted, secret);
  });

  await test('encrypted values have correct prefix', async () => {
    const encrypted = encryption.encrypt('test');
    assertTrue(encrypted.startsWith('encrypted:'), 'Should start with encrypted: ');
  });

  await test('isEncrypted detects encrypted values', async () => {
    const encrypted = encryption.encrypt('test');
    assertTrue(encryption.isEncrypted(encrypted), 'Should detect encrypted value');
    assertTrue(!encryption.isEncrypted('plain text'), 'Should not detect plain text');
  });

  await test('double encryption prevented', async () => {
    const encrypted = encryption.encrypt('test');
    const doubleEncrypted = encryption.encrypt(encrypted);
    assertEqual(encrypted, doubleEncrypted, 'Double encryption should be prevented');
  });

  await test('mask hides secrets', async () => {
    const masked = encryption.mask('sk-ant-api01-secretkey-12345');
    assertTrue(masked.includes('...'), 'Should contain ...');
    assertTrue(!masked.includes('secretkey'), 'Should not contain full secret');
  });

  // ============================================================================
  // Config Manager Tests
  // ============================================================================

  console.log('\n📁 Config Manager Module');

  await test('getConfigDir returns correct path', async () => {
    const dir = configManager.getConfigDir();
    assertEqual(dir, path.join(TEST_DIR, '.evobrew'));
  });

  await test('initConfigDir creates directories', async () => {
    const result = await configManager.initConfigDir();
    assertTrue(result.created, 'Should report created');
    assertTrue(fs.existsSync(configManager.getConfigDir()), 'Config dir should exist');
    assertTrue(fs.existsSync(configManager.getLogsDir()), 'Logs dir should exist');
    assertTrue(fs.existsSync(configManager.getSslDir()), 'SSL dir should exist');
  });

  await test('saveConfig and loadConfig roundtrip', async () => {
    const config = configManager.getDefaultConfig();
    config.providers.openai.api_key = 'sk-test-key-12345';
    config.providers.openai.enabled = true;
    
    await configManager.saveConfig(config);
    
    // Verify file exists and secrets are encrypted in storage
    const raw = fs.readFileSync(configManager.getConfigPath(), 'utf-8');
    const stored = JSON.parse(raw);
    assertTrue(stored.providers.openai.api_key.startsWith('encrypted:'), 
      'API key should be encrypted in storage');
    
    // Load and verify decryption
    const loaded = await configManager.loadConfig();
    assertEqual(loaded.providers.openai.api_key, 'sk-test-key-12345', 
      'API key should be decrypted on load');
  });

  await test('getConfigValue gets nested values', async () => {
    const config = { server: { http_port: 3405 } };
    assertEqual(configManager.getConfigValue(config, 'server.http_port'), 3405);
    assertEqual(configManager.getConfigValue(config, 'nonexistent', 'default'), 'default');
  });

  await test('setConfigValue sets nested values', async () => {
    const config = {};
    configManager.setConfigValue(config, 'server.http_port', 3405);
    assertEqual(config.server.http_port, 3405);
  });

  await test('validateConfig catches missing providers', async () => {
    const config = configManager.getDefaultConfig();
    const result = configManager.validateConfig(config);
    assertTrue(!result.valid, 'Should be invalid without providers');
    assertTrue(result.errors.some(e => e.includes('provider')), 
      'Should mention provider error');
  });

  // ============================================================================
  // Environment Bridge Tests
  // ============================================================================

  console.log('\n🌍 Environment Bridge');

  await test('configToEnv converts config to env vars', async () => {
    const config = configManager.getDefaultConfig();
    config.providers.openai.api_key = 'sk-test-key';
    config.server.http_port = 4000;
    
    const env = configManager.configToEnv(config);
    assertEqual(env.OPENAI_API_KEY, 'sk-test-key');
    assertEqual(env.PORT, '4000');
  });

  // ============================================================================
  // Summary
  // ============================================================================

  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  // ============================================================================
  // Cleanup
  // ============================================================================

  console.log('🧹 Cleaning up...');

  // Restore homedir before cleanup to prevent module cache issues
  os.homedir = ORIG_HOMEDIR;

  // Clean up test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('   Test directory removed.\n');
  } catch (e) {
    console.log(`   Warning: Could not remove test dir: ${e.message}\n`);
  }

  if (failed > 0) {
    process.exit(1);
  }
}

// Run all tests
runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
