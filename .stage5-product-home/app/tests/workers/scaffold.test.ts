import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkerFromTemplate } from '../../src/workers/scaffold.js';

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-worker-scaffold-'));
  const templateDir = path.join(root, 'cli', 'templates', 'workers', 'systems', 'workspace');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(path.join(root, 'cli', 'templates', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose Home23 host/process issues.'
  ].join('\n'));
  writeFileSync(path.join(templateDir, 'IDENTITY.md'), '# Systems\n');
  return root;
}

test('createWorkerFromTemplate creates a worker without creating agent config', () => {
  const projectRoot = tempRoot();
  const result = createWorkerFromTemplate(projectRoot, {
    name: 'systems',
    template: 'systems',
    ownerAgent: 'jerry'
  });

  assert.equal(result.worker.name, 'systems');
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'workspace', 'IDENTITY.md')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'runs')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'logs')), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'config.yaml')), false);

  const text = readFileSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml'), 'utf8');
  assert.match(text, /name: systems/);
  assert.match(text, /ownerAgent: jerry/);
});

test('createWorkerFromTemplate refuses to overwrite existing worker config', () => {
  const projectRoot = tempRoot();
  createWorkerFromTemplate(projectRoot, { name: 'systems', template: 'systems', ownerAgent: 'jerry' });
  const before = statSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')).mtimeMs;
  assert.throws(
    () => createWorkerFromTemplate(projectRoot, { name: 'systems', template: 'systems', ownerAgent: 'jerry' }),
    /already exists/
  );
  const after = statSync(path.join(projectRoot, 'instances', 'workers', 'systems', 'worker.yaml')).mtimeMs;
  assert.equal(after, before);
});

test('createWorkerFromTemplate uses local primary owner when owner is omitted', () => {
  const projectRoot = tempRoot();
  mkdirSync(path.join(projectRoot, 'config'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'config', 'agents.json'), JSON.stringify([
    { name: 'forrest', isPrimary: false },
    { name: 'home', isPrimary: true }
  ], null, 2));
  writeFileSync(path.join(projectRoot, 'cli', 'templates', 'workers', 'systems', 'worker.yaml'), [
    'kind: worker',
    'name: systems',
    'displayName: Systems',
    'ownerAgent: primary',
    'class: ops',
    'purpose: Diagnose Home23 host/process issues.',
    'feedsBrains:',
    '  - primary',
    'visibleTo:',
    '  - selected-agent'
  ].join('\n'));

  const result = createWorkerFromTemplate(projectRoot, {
    name: 'systems',
    template: 'systems'
  });

  assert.equal(result.worker.ownerAgent, 'home');
  assert.deepEqual(result.worker.feedsBrains, ['home']);
  assert.deepEqual(result.worker.visibleTo, ['home']);
});
