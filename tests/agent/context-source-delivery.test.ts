import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {ContextManager} from '../../src/agent/context.js';

test('configured bootstrap paths appear only in fresh dynamic context, not static identity', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'context-source-'));
  try {
    writeFileSync(join(workspace, 'SOUL.md'), 'Enduring individual.');
    writeFileSync(join(workspace, 'NOW.md'), 'old machine snapshot');
    const context = new ContextManager({workspacePath: workspace, identityFiles: ['SOUL.md', 'NOW.md'],
      dynamicContextFiles: ['NOW.md'], heartbeatRefreshMs: 60000, enginePort: 1});
    const prompt = context.getSystemPrompt();
    assert.match(prompt, /Enduring individual/);
    assert.doesNotMatch(prompt, /old machine snapshot/);
    const now = context.getPromptSourceInfo().loadedFiles.find(row => row.filename === 'NOW.md')!;
    assert.equal(now.included, false);
    assert.equal(now.deferredReason, 'session_bootstrap');
    assert.match(prompt, /fresh session bootstrap on each turn/i);
  } finally {rmSync(workspace, {recursive: true, force: true});}
});

test('repeated identity paths do not give the same source additional weight', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'context-duplicate-'));
  try {
    writeFileSync(join(workspace, 'SOUL.md'), 'UNIQUE_AUTHORED_IDENTITY_MARKER');
    const context = new ContextManager({workspacePath: workspace, identityFiles: ['SOUL.md', 'SOUL.md'],
      heartbeatRefreshMs: 60000, enginePort: 1});
    assert.equal(context.getSystemPrompt().split('UNIQUE_AUTHORED_IDENTITY_MARKER').length - 1, 1);
    assert.equal(context.getPromptSourceInfo().loadedFiles[1]?.deferredReason, 'duplicate_source');
  } finally {rmSync(workspace, {recursive: true, force: true});}
});

test('generated historical status is recoverable context, not an active owner obligation', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'context-status-'));
  try {
    const status = '# Project Status\nGenerated 2000-01-01T00:00:00.000Z by status.mjs.\nNEEDS YOU: old pending request\nDROPPED by owner: old distribution\n';
    writeFileSync(join(workspace, 'SHAKEDOWN_STATUS.md'), status);
    const context = new ContextManager({workspacePath: workspace, identityFiles: ['SHAKEDOWN_STATUS.md'],
      heartbeatRefreshMs: 60000, enginePort: 1});
    const prompt = context.getSystemPrompt();
    assert.doesNotMatch(prompt, /NEEDS YOU: old pending request/);
    assert.match(prompt, /historical status/i);
    assert.match(prompt, /2000-01-01T00:00:00.000Z/);
    assert.ok(prompt.includes(join(workspace, 'SHAKEDOWN_STATUS.md')));
    assert.match(prompt, /DROPPED by owner: old distribution/);
    const row = context.getPromptSourceInfo().loadedFiles[0]!;
    assert.equal(row.included, false);
    assert.equal(row.deferredReason, 'historical_status');
    assert.equal(row.sourceRecordedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(row.sourceSHA256, createHash('sha256').update(status).digest('hex'));
    assert.equal(row.layer, 'world_state');
  } finally {rmSync(workspace, {recursive: true, force: true});}
});

test('a cached generated status loses current authority when its timestamp ages out', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'context-status-age-'));
  let clock = Date.parse('2000-01-01T23:00:00.000Z');
  t.mock.method(Date, 'now', () => clock);
  try {
    writeFileSync(join(workspace, 'SHAKEDOWN_STATUS.md'), '# Status\nGenerated 2000-01-01T00:00:00.000Z by status.mjs.\nNEEDS YOU: dated request');
    const context = new ContextManager({workspacePath: workspace, identityFiles: ['SHAKEDOWN_STATUS.md'],
      heartbeatRefreshMs: 60000, enginePort: 1});
    assert.match(context.getSystemPrompt(), /NEEDS YOU: dated request/);
    clock = Date.parse('2000-01-02T01:00:00.000Z');
    assert.doesNotMatch(context.getSystemPrompt(), /NEEDS YOU: dated request/);
    assert.equal(context.getPromptSourceInfo().loadedFiles[0]?.deferredReason, 'historical_status');
  } finally {rmSync(workspace, {recursive: true, force: true});}
});
