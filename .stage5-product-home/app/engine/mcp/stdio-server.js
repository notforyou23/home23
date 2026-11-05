#!/usr/bin/env node

'use strict';

/**
 * Canonical Home23 MCP stdio transport.
 *
 * This entrypoint exposes bounded own-brain read-only diagnostics through the
 * same canonical memory runtime as the HTTP transport. Direct queries,
 * cross-brain reads, and PGS belong to durable brain operations, not MCP.
 */

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  createSnapshotScalarStateReader,
} = require('../../shared/memory-source/mcp-http-runtime.cjs');
const {
  createOwnBrainMCPServer,
  createProductionMcpMemoryTools,
} = require('./http-server.js');

async function startMcpStdioServer(options = {}) {
  const brainDir = options.brainDir
    || process.env.COSMO_RUNTIME_DIR
    || process.env.COSMO_RUNTIME_PATH;
  const memoryTools = options.memoryTools || createProductionMcpMemoryTools({
    brainDir,
    home23Root: options.home23Root || process.env.HOME23_ROOT,
    requesterAgent: options.requesterAgent || process.env.HOME23_AGENT,
    logger: options.logger || console,
  });
  const readScalarState = options.readScalarState
    || createSnapshotScalarStateReader({ brainDir });
  const abortController = new AbortController();
  const server = createOwnBrainMCPServer({
    memoryTools,
    readScalarState,
    signal: abortController.signal,
    ...(options.sdk ? { sdk: options.sdk } : {}),
  });
  const transport = options.transport || new StdioServerTransport();
  await server.connect(transport);
  let closePromise = null;
  return Object.freeze({
    server,
    transport,
    close: () => {
      closePromise ||= (async () => {
        abortController.abort(Object.assign(new Error('MCP stdio server closed'), {
          name: 'AbortError',
          code: 'cancelled',
        }));
        try {
          await server.close();
        } finally {
          await memoryTools.close?.();
        }
      })();
      return closePromise;
    },
  });
}

async function main() {
  await startMcpStdioServer();
  console.error('Home23 canonical MCP running over stdio (own-brain diagnostics only)');
  console.error('Use durable brain operations for direct, cross-brain, or PGS work');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal MCP stdio error:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  startMcpStdioServer,
};
