#!/usr/bin/env node

import path from 'node:path';
import {
  canonicalDirectory,
  canonicalReceiptRow,
  failCli,
  isMain,
  one,
  parseCli,
  receiptContext,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';
import { runBrainOperationsCommand } from '../cli/lib/brain-operations-command.js';

export async function listBrainOperations({
  home23Root,
  state = 'nonterminal',
  commandRunner = runBrainOperationsCommand,
} = {}) {
  if (state !== 'nonterminal') throw typedError('state_invalid');
  const home = await canonicalDirectory(home23Root, 'Home23 root');
  const result = await commandRunner(home.path, [
    'list', '--state', 'nonterminal', '--all-requesters',
  ]);
  if (!result || !Array.isArray(result.operations) || !Array.isArray(result.requesters)
      || result.count !== result.operations.length
      || result.operations.some((operation) => !['queued', 'running'].includes(operation?.state))) {
    throw typedError('brain_operations_store_invalid');
  }
  return {
    ok: true,
    state,
    home23Root: home.path,
    checkedAt: result.checkedAt,
    requesters: result.requesters,
    count: result.count,
    operations: result.operations,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const context = await receiptContext(values, env);
  const result = await listBrainOperations({
    home23Root: path.resolve(one(values, 'home23-root', { required: true })),
    state: one(values, 'state', { defaultValue: 'nonterminal' }),
  });
  const output = one(values, 'output');
  if (!output) {
    const row = canonicalReceiptRow(context, {
      helper: 'list-brain-operations',
      ...result,
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return row;
  }
  return writeJsonReceipt(context, path.resolve(output), {
    helper: 'list-brain-operations',
    ...result,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
