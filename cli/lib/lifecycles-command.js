import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  LIFECYCLE_NAMES,
  describeLifecycles,
  renderLifecycleReference,
} = require('../../shared/lifecycles.cjs');

const USAGE = 'Usage: home23 lifecycles [name] [--json | --markdown]';

/**
 * Print the lifecycle catalog. Read-only; needs no installation state.
 * Returns the text to print so the command stays testable.
 */
export function runLifecyclesCommand(args = []) {
  const flags = args.filter(arg => arg.startsWith('--'));
  const names = args.filter(arg => !arg.startsWith('--'));
  const unknownFlag = flags.find(flag => flag !== '--json' && flag !== '--markdown');
  if (unknownFlag) throw new Error(`Unknown option ${unknownFlag}. ${USAGE}`);
  if (flags.includes('--json') && flags.includes('--markdown')) throw new Error(`Choose one output format. ${USAGE}`);
  if (names.length > 1) throw new Error(USAGE);
  const [name] = names;
  if (name && !LIFECYCLE_NAMES.includes(name)) {
    throw new Error(`Unknown lifecycle "${name}". Known lifecycles: ${LIFECYCLE_NAMES.join(', ')}`);
  }

  const description = describeLifecycles();
  const selected = name
    ? { ...description, lifecycles: description.lifecycles.filter(entry => entry.name === name) }
    : description;

  if (flags.includes('--json')) return `${JSON.stringify(selected, null, 2)}\n`;
  if (flags.includes('--markdown')) {
    if (name) throw new Error('--markdown prints the whole reference page; omit the lifecycle name.');
    return renderLifecycleReference();
  }

  const lines = [];
  for (const entry of selected.lifecycles) {
    lines.push(`${entry.name}  ${entry.summary}`);
    lines.push(`  authority: ${entry.authority}`);
    for (const state of entry.states) {
      const kind = state.terminal ? 'final' : state.reserved ? 'reserved' : state.state === entry.initial ? 'start' : 'active';
      const next = state.next.length ? ` -> ${state.next.join(', ')}` : '';
      lines.push(`  ${state.state.padEnd(16)} ${kind.padEnd(9)}${next}`.trimEnd());
    }
    if (entry.views.length) lines.push(`  reported, never stored: ${entry.views.map(view => view.state).join(', ')}`);
    lines.push('');
  }
  lines.push('Full reference: docs/reference/LIFECYCLES.md   Machine-readable: home23 lifecycles --json');
  return `${lines.join('\n')}\n`;
}
