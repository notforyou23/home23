import test from 'node:test';
import assert from 'node:assert/strict';
import builder from '../../cli/lib/agent-config-builder.cjs';

test('agent creation and the feeder config share one default workspace folder list', () => {
  const config = builder.buildAgentConfig({ name: 'jerry', displayName: 'Jerry', instanceDir: '/opt/home23/instances/jerry' });
  assert.deepEqual(
    config.feeder.additionalWatchPaths.map(entry => entry.path),
    builder.DEFAULT_WORKSPACE_WATCH_DIRS.map(({ dir }) => `/opt/home23/instances/jerry/workspace/${dir}`),
  );
  assert.deepEqual(
    builder.DEFAULT_WORKSPACE_WATCH_DIRS.map(({ dir }) => dir),
    ['sessions', 'memory', 'projects', 'reports', 'research-runs', 'research'],
  );
});

test('generated feeder watch paths include bounded compiled research artifacts', () => {
  const config = builder.buildAgentConfig({
    name: 'jerry',
    displayName: 'Jerry',
    instanceDir: '/opt/home23/instances/jerry',
  });
  assert.deepEqual(
    config.feeder.additionalWatchPaths.find((entry) => entry.label === 'compiled_research'),
    {
      path: '/opt/home23/instances/jerry/workspace/research',
      label: 'compiled_research',
    },
  );
});
