import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const HOME23_ROOT = process.cwd();

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
    const config = yaml.load(readFileSync(configPath, 'utf8')) as any;

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

  assert.match(source, /identityFiles:\s*\[[^\]]*'GOOD_LIFE\.md'/s);
  assert.match(source, /for \(const file of \[[^\]]*'GOOD_LIFE\.md'/s);
});
