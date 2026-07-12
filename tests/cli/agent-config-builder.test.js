import test from 'node:test';
import assert from 'node:assert/strict';
import builder from '../../cli/lib/agent-config-builder.cjs';

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
