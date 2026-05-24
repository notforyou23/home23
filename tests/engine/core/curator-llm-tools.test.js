import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateRecentDigest } = require('../../../engine/src/core/curator-llm-tools.js');

test('generateRecentDigest writes RECENT.md through durable fsync path', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'home23-recent-workspace-'));
  const brainDir = mkdtempSync(join(tmpdir(), 'home23-recent-brain-'));
  const client = {
    async generate() {
      return { text: '**Last 24h**\n- event recorded\n\n**Open threads**\n- none\n\n**State changes**\n- RECENT refreshed' };
    },
  };

  const result = await generateRecentDigest({
    workspacePath,
    brainDir,
    journal: [{ cycle: 1, role: 'curator', thought: 'RECENT should refresh.' }],
    client,
    cadenceMs: 0,
  });

  const recentPath = join(workspacePath, 'RECENT.md');
  const content = readFileSync(recentPath, 'utf8');
  assert.equal(result.written, true);
  assert.match(content, /# Recent Activity/);
  assert.match(content, /RECENT refreshed/);
  assert.ok(statSync(recentPath).size > 0);
});
