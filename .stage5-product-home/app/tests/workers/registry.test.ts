import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listWorkerTemplates, listWorkers, loadWorker } from '../../src/workers/registry.js';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'home23-workers-'));
}

test('listWorkerTemplates reads packaged worker templates', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'workers.json'), JSON.stringify({
    templates: {
      systems: {
        displayName: 'Systems',
        class: 'ops',
        ownerAgent: 'jerry',
        purpose: 'Diagnose Home23 host and PM2 issues.'
      }
    }
  }, null, 2));

  const templates = listWorkerTemplates(root);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].name, 'systems');
  assert.equal(templates[0].ownerAgent, 'jerry');
});

test('listWorkers ignores full agents and loads only instances/workers configs', () => {
  const root = tempRoot();
  mkdirSync(path.join(root, 'instances', 'jerry'), { recursive: true });
  mkdirSync(path.join(root, 'instances', 'workers', 'systems'), { recursive: true });
  writeFileSync(path.join(root, 'instances', 'jerry', 'config.yaml'), 'name: jerry\n');
  writeFileSync(path.join(root, 'instances', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose Home23 host/process issues.',
    'tools:',
    '  shell: true',
    'limits:',
    '  maxRuntimeMinutes: 45'
  ].join('\n'));

  const workers = listWorkers(root);
  assert.deepEqual(workers.map(w => w.name), ['systems']);

  const loaded = loadWorker(root, 'systems');
  assert.equal(loaded.name, 'systems');
  assert.equal(loaded.ownerAgent, 'jerry');
  assert.equal(loaded.rootPath.endsWith(path.join('instances', 'workers', 'systems')), true);
});
