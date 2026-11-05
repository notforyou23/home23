import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const {
  countYamlCommentLines,
  makeBackupPath,
  writeYamlSafely,
} = require('../../engine/src/dashboard/yaml-write-safety');

test('countYamlCommentLines detects full-line YAML comments', () => {
  assert.equal(countYamlCommentLines('# top\nkey: value\n  # nested\nnotacomment: "# value"'), 2);
});

test('writeYamlSafely snapshots comment-bearing YAML before overwrite', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-yaml-safe-'));
  const filePath = path.join(rootDir, 'config', 'home.yaml');
  const backupRoot = path.join(rootDir, 'backups');
  const now = new Date('2026-04-24T12:00:00.000Z');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# operator note\nhome:\n  primaryAgent: jerry\n', 'utf8');

  const result = writeYamlSafely(filePath, { home: { primaryAgent: 'jerry2' } }, {
    yaml,
    rootDir,
    backupRoot,
    now,
    logger: { warn() {} },
  });

  assert.equal(result.commentsDetected, true);
  assert.equal(result.commentLines, 1);
  assert.equal(result.backupPath, path.join(backupRoot, '2026-04-24T12-00-00-000Z', 'config', 'home.yaml'));
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '# operator note\nhome:\n  primaryAgent: jerry\n');
  assert.match(fs.readFileSync(filePath, 'utf8'), /primaryAgent: jerry2/);
});

test('writeYamlSafely skips backup when YAML has no comments', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-yaml-safe-'));
  const filePath = path.join(rootDir, 'instances', 'jerry', 'config.yaml');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'chat:\n  model: old\n', 'utf8');

  const result = writeYamlSafely(filePath, { chat: { model: 'new' } }, {
    yaml,
    rootDir,
    backupRoot: path.join(rootDir, 'backups'),
  });

  assert.equal(result.commentsDetected, false);
  assert.equal(result.commentLines, 0);
  assert.equal(result.backupPath, null);
  assert.match(fs.readFileSync(filePath, 'utf8'), /model: new/);
});

test('makeBackupPath keeps out-of-root files inside backup root', () => {
  const rootDir = '/repo';
  const backupPath = makeBackupPath('/tmp/secrets.yaml', {
    rootDir,
    backupRoot: '/repo/engine/.backups/yaml-write-safety',
    now: new Date('2026-04-24T12:00:00.000Z'),
  });

  assert.equal(backupPath, '/repo/engine/.backups/yaml-write-safety/2026-04-24T12-00-00-000Z/secrets.yaml');
});
