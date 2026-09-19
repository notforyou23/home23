import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCanonicalFixture, validateCanonicalFixture } from '../../../src/coordination/contracts/contract-pack.js';
import { consoleOversizedRawFixture } from '../../../src/coordination/contracts/console-fixture-payloads.js';
import type { ConsoleRecord } from '../../../src/coordination/console/types.js';

test('Console fixtures preserve provider text, byte lengths, and the Apple inline bound', () => {
  for (const name of ['console-records-codex', 'console-records-cursor', 'console-records-subagent', 'console-records-limits']) {
    const page = loadCanonicalFixture(name) as { records: ConsoleRecord[] };
    for (const record of page.records) {
      assert.ok(Buffer.byteLength(JSON.stringify({ record })) < 48 * 1024, `${name}: inline frame too large`);
      if (record.raw !== null) {
        assert.equal(Buffer.byteLength(record.raw), record.byteLength);
        if (record.format !== 'text') assert.doesNotThrow(() => JSON.parse(record.raw!));
      } else {
        assert.match(record.rawUrl!, /^\/api\/v1\/console\/sources\/[^/]+\/records\/[^/]+\/raw$/);
      }
    }
  }
  const page = loadCanonicalFixture('console-records-limits') as { records: ConsoleRecord[] };
  const oversized = page.records[0]!;
  assert.equal(consoleOversizedRawFixture().byteLength, oversized.byteLength);
  assert.ok(oversized.byteLength > 64 * 1024);
  assert.equal(JSON.parse(consoleOversizedRawFixture().toString()).item.aggregated_output, 'x'.repeat(65_536));
});

test('Console consumers can retain unknown records but cannot mistake missing raw content for an empty record', () => {
  const page = loadCanonicalFixture('console-records-codex') as { records: ConsoleRecord[] };
  const record = { ...page.records[0]!, format: 'future-provider', kind: 'future.output' };
  assert.equal(validateCanonicalFixture('console-records-codex', { ...page, records: [record] }).valid, true);
  assert.equal(validateCanonicalFixture('console-records-codex', {
    ...page, records: [{ ...record, raw: null, rawUrl: null }],
  }).valid, false);
  assert.equal(validateCanonicalFixture('console-records-codex', {
    ...page, records: [{ ...record, raw: null, rawUrl: 'https://untrusted.example/output' }],
  }).valid, false);
});

test('Home23 decoder examples use the actual journal and AgentEvent field names', () => {
  const page = loadCanonicalFixture('console-records-subagent') as { records: ConsoleRecord[] };
  const stream = loadCanonicalFixture('console-stream') as { events: Array<{ event: string; data: { record?: ConsoleRecord } }> };
  const records = [...page.records, ...stream.events.flatMap(event => event.data.record ? [event.data.record] : [])];
  for (const record of records.filter(record => record.format === 'home23-turn')) {
    const raw = JSON.parse(record.raw!);
    const sidecar = raw.kind.startsWith('capture_') || raw.kind === 'tool_output';
    assert.equal(record.stream, sidecar ? 'execution-output' : 'journal');
    if (raw.kind === 'tool_start') {
      assert.equal(typeof raw.data.args, 'object');
      assert.equal('input' in raw.data, false);
    }
    if (raw.kind === 'response_chunk') assert.equal(typeof raw.data.chunk, 'string');
  }
});
