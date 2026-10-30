import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual server formatter, without starting its sentinel or a Seed.
const source = readFileSync(new URL('../bin/seed-observatory.ts', import.meta.url), 'utf8');
const formatter = source.match(/function ageStr\(iso: string\): string \{[\s\S]*?\n\}/)?.[0];
assert.ok(formatter, 'the production relative-time formatter is present');
const now = Date.parse('2026-10-30T13:00:00Z');
class Clock extends Date { static now() { return now; } }
const format = vm.runInNewContext(`(${formatter.replace('(iso: string): string', '(iso)')})`, { Date: Clock }) as (iso: string) => string;

test('future commitment deadlines are future, not negative seconds overdue', () => {
  assert.equal(format('2026-10-30T23:00:00Z'), 'in 10.0h');
  assert.equal(format('2026-10-30T13:01:00Z'), 'in 60s');
});
test('past deadlines retain positive elapsed ages and invalid dates stay unknown', () => {
  assert.equal(format('2026-10-30T12:00:00Z'), '60m ago');
  assert.equal(format('not-a-date'), '?');
});
