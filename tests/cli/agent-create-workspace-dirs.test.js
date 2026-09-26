import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentCreate } from '../../cli/lib/agent-create.js';
import builder from '../../cli/lib/agent-config-builder.cjs';

// The feeder watches six workspace folders, but creation made none of them;
// the harness made sessions/ and memory/ lazily after the engine had already
// skipped them. Creation now makes every configured folder up front.
test('agent creation makes every default feeder workspace folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-create-dirs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = console.log;
  console.log = () => {};
  try {
    await runAgentCreate(root, 'testbot', {
      profile: { displayName: 'Testbot', ownerName: 'owner', personalFacts: '', purpose: 'test', ingestPaths: '',
        ownerTelegramId: '', timezone: 'UTC', model: 'test-model', provider: 'test-provider', botToken: '' },
      prepareOnly: true,
      ports: { engine: 5101, dashboard: 5102, mcp: 5103, bridge: 5104 },
    });
  } finally {
    console.log = log;
  }

  const workspace = path.join(root, 'instances', 'testbot', 'workspace');
  for (const { dir } of builder.DEFAULT_WORKSPACE_WATCH_DIRS) {
    assert.equal(fs.statSync(path.join(workspace, dir)).isDirectory(), true, dir);
  }
});
