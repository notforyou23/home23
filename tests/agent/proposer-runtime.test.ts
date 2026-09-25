// Release 186 defect D10: the proposer's operational roots must come from the
// environment or the app's own location, never a baked-in developer path —
// src/ ships hash-verified, so an owner cannot edit such a default.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveProposerRoots } from '../../src/agent/proposer-runtime.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ROOT_VARS = ['HOME23_ROOT', 'SHAKEDOWN_SITE_ROOT', 'JERRY_COLLECTION_ROOT'] as const;

function withEnv(values: Partial<Record<(typeof ROOT_VARS)[number], string>>, fn: () => void): void {
  const saved = new Map(ROOT_VARS.map((name) => [name, process.env[name]] as const));
  for (const name of ROOT_VARS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('proposer roots follow HOME23_ROOT, SHAKEDOWN_SITE_ROOT and JERRY_COLLECTION_ROOT', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'home23-proposer-'));
  try {
    const home23 = path.join(base, 'home23');
    const site = path.join(base, 'site');
    const collection = path.join(base, 'collection');
    withEnv({ HOME23_ROOT: home23, SHAKEDOWN_SITE_ROOT: site, JERRY_COLLECTION_ROOT: collection }, () => {
      const roots = resolveProposerRoots();
      assert.equal(roots.home23, home23);
      assert.equal(roots.site, site);
      assert.equal(roots.jerryCollection, collection);
      assert.equal(roots.workerWorkspace, path.join(home23, 'instances/workers/shakedown-jerry/workspace'));
      assert.equal(roots.contentDir, path.join(home23, 'instances/jerry/workspace/projects/shakedownshuffle'));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('with nothing configured, roots derive from the packaged app root and the user home', () => {
  withEnv({}, () => {
    const roots = resolveProposerRoots();
    assert.equal(roots.home23, REPO_ROOT);
    assert.equal(roots.site, path.join(os.homedir(), 'websites', 'shakedownshuffle.com'));
    assert.equal(roots.jerryCollection, path.resolve(REPO_ROOT, '..', '..', 'jerry-collection'));
    assert.equal(roots.workerWorkspace, path.join(REPO_ROOT, 'instances/workers/shakedown-jerry/workspace'));
  });
});
