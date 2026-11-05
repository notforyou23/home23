'use strict';

/**
 * P2-16 (2026-08-11 audit): config/home.yaml.example and the live config had
 * become two different fleets — the example's chat pair failed the alias
 * filter, so a fresh install seeded from it could not build a model
 * authority (the exact MESS-1 failure the live config also had). This suite
 * is the CI check the example never had: it must build standalone, and the
 * fleet default pair every new agent is seeded with must be valid against it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { buildHome23ModelAuthority } = require('../../../engine/src/dashboard/home23-model-catalog.js');
const modelDefaults = require('../../../shared/model-defaults.cjs');

const examplePath = path.join(__dirname, '..', '..', '..', 'config', 'home.yaml.example');

function loadExample() {
  return yaml.load(fs.readFileSync(examplePath, 'utf8'));
}

test('home.yaml.example builds a model authority standalone — a fresh install must not throw', () => {
  const authority = buildHome23ModelAuthority({ homeConfig: loadExample(), agentConfig: {} });
  assert.ok(authority.executionCatalog, 'authority built from the example');
});

test('the fleet default chat pair (shared/model-defaults) is valid against the example catalog', () => {
  // agent-config-builder seeds every new agent with this pair; if the example
  // catalog cannot build it, `home23 agent create` on a fresh install
  // produces an unbuildable agent (audit MESS-11).
  buildHome23ModelAuthority({
    homeConfig: loadExample(),
    agentConfig: {
      chat: {
        defaultProvider: modelDefaults.DEFAULT_CHAT_PROVIDER,
        defaultModel: modelDefaults.DEFAULT_CHAT_MODEL,
      },
    },
  });
});
