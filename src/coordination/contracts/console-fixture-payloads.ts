/** Reconstruct the oversized raw response without checking in repetitive output. */
export function consoleOversizedRawFixture(): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_large', type: 'command_execution', command: 'sample command',
      aggregated_output: 'x'.repeat(65_536), exit_code: 0, status: 'completed',
    },
  }), 'utf8');
}
