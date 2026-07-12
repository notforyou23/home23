'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const {
  OWN_BRAIN_DIAGNOSTIC_TOOL_NAMES,
  createOwnBrainMCPServer,
  isPathAllowedForRoots,
} = require('../../../engine/mcp/http-server.js');

test('Claude Desktop example names the real canonical stdio entrypoint and required identity', async () => {
  const examplePath = path.join(REPO_ROOT, 'engine/mcp/claude_desktop_config_example.json');
  const example = JSON.parse(await fsp.readFile(examplePath, 'utf8'));
  const config = example.mcpServers['home23-own-brain'];

  assert.equal(config.command, 'node');
  assert.deepEqual(config.args, ['/path/to/home23/engine/mcp/stdio-server.js']);
  assert.deepEqual(config.env, {
    HOME23_ROOT: '/path/to/home23',
    HOME23_AGENT: 'your-agent-id',
    COSMO_RUNTIME_DIR: '/path/to/home23/instances/your-agent-id/brain',
  });
  const localEntrypoint = config.args[0].replace('/path/to/home23', REPO_ROOT);
  assert.equal((await fsp.stat(localEntrypoint)).isFile(), true);
});

test('stdio entrypoint delegates to the canonical MCP runtime instead of legacy state', async () => {
  const source = await fsp.readFile(path.join(REPO_ROOT, 'engine/mcp/stdio-server.js'), 'utf8');

  assert.match(source, /createDefaultMcpMemoryTools/);
  assert.match(source, /createSnapshotScalarStateReader/);
  assert.match(source, /createOwnBrainMCPServer/);
  assert.match(source, /require\.main === module/);
  assert.doesNotMatch(source, /state\.json\.gz/);
  assert.match(source, /own-brain read-only diagnostics/i);
  assert.match(source, /durable brain operations/i);
});

test('stdio MCP factory advertises only strict own-brain read-only diagnostics', async () => {
  const listSchema = Symbol('list-tools');
  const callSchema = Symbol('call-tool');
  class FakeServer {
    constructor() { this.handlers = new Map(); }
    setRequestHandler(schema, handler) { this.handlers.set(schema, handler); }
  }
  const server = createOwnBrainMCPServer({
    memoryTools: {
      async queryMemory() { return { ok: true }; },
      async getMemoryStatistics() { return { ok: true }; },
      async getMemoryGraph() { return { ok: true }; },
      async getSystemState() { return { ok: true }; },
    },
    readScalarState: async () => ({
      scalarProjection: { sourceHealth: 'degraded', capabilities: {} },
    }),
    sdk: {
      Server: FakeServer,
      ListToolsRequestSchema: listSchema,
      CallToolRequestSchema: callSchema,
    },
  });

  const listed = await server.handlers.get(listSchema)();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...OWN_BRAIN_DIAGNOSTIC_TOOL_NAMES].sort());
  for (const forbidden of [
    'inject_topic', 'spawn_agent', 'create_goal', 'generate_code',
    'write_file', 'read_file', 'list_directory', 'web_search',
  ]) {
    assert.equal(names.includes(forbidden), false, forbidden);
  }

  const rejected = await server.handlers.get(callSchema)({
    params: { name: 'write_file', arguments: { path: 'x', content: 'x' } },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /not available/i);
});

test('MCP allowed roots require exact path-segment containment', () => {
  assert.equal(isPathAllowedForRoots('/safe/path', ['/safe/path']), true);
  assert.equal(isPathAllowedForRoots('/safe/path/child.txt', ['/safe/path']), true);
  assert.equal(isPathAllowedForRoots('/safe/path-escape/child.txt', ['/safe/path']), false);
  assert.equal(isPathAllowedForRoots('/safe/pathology', ['/safe/path']), false);
});
