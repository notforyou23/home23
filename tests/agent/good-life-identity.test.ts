import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { createRequire } from 'node:module';

const HOME23_ROOT = process.cwd();
const require = createRequire(import.meta.url);
const { buildAgentConfig } = require('../../cli/lib/agent-config-builder.cjs');

test('configured local full agents load Good Life doctrine as identity context', (t) => {
  const missingLocalConfig = ['jerry', 'forrest']
    .map((agentName) => join(HOME23_ROOT, 'instances', agentName, 'config.yaml'))
    .some((configPath) => !existsSync(configPath));
  if (missingLocalConfig) {
    t.skip('local Home23 agent instances are not present in this checkout');
    return;
  }

  for (const agentName of ['jerry', 'forrest']) {
    const configPath = join(HOME23_ROOT, 'instances', agentName, 'config.yaml');
    const workspacePath = join(HOME23_ROOT, 'instances', agentName, 'workspace');
    let config: any;
    try {
      config = yaml.load(readFileSync(configPath, 'utf8')) as any;
    } catch (error: any) {
      t.skip(`ignored local ${agentName} config is not parseable in this checkout: ${error.message}`);
      return;
    }

    assert.ok(
      config?.chat?.identityFiles?.includes('GOOD_LIFE.md'),
      `${agentName} config should include GOOD_LIFE.md in chat.identityFiles`
    );
    assert.ok(
      existsSync(join(workspacePath, 'GOOD_LIFE.md')),
      `${agentName} workspace should contain GOOD_LIFE.md`
    );
  }
});

test('dashboard agent creation seeds Good Life doctrine for new agents', () => {
  const source = readFileSync(join(HOME23_ROOT, 'engine/src/dashboard/home23-settings-api.js'), 'utf8');
  const config = buildAgentConfig({
    name: 'ada',
    displayName: 'Ada',
    ownerName: 'JTR',
    purpose: 'Test Good Life doctrine.',
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
    instanceDir: join(HOME23_ROOT, 'instances', 'ada'),
  });

  assert.ok(config.chat.identityFiles.includes('GOOD_LIFE.md'));
  assert.match(source, /for \(const file of \[[^\]]*'GOOD_LIFE\.md'/s);
});
