import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeededToolRegistry, resolveWorkerTools } from '../../src/agent/tools/index.js';

test('worker tool grants resolve only enabled capability groups', () => {
  const tools = resolveWorkerTools({ shell: true, files: true, cron: false, brain: false, web: false });
  const names = tools.map(tool => tool.name);

  assert.deepEqual(names, ['shell', 'read_file', 'write_file', 'edit_file', 'list_files', 'search_files']);
  assert.equal(createSeededToolRegistry(tools).get('shell')?.name, 'shell');
  assert.equal(createSeededToolRegistry(tools).get('cron_list'), undefined);
});

test('worker tool grants reject unknown capability groups', () => {
  assert.throws(
    () => resolveWorkerTools({ shell: true, root_everything: true }),
    /Unknown worker tool grant group\(s\): root_everything/,
  );
});
