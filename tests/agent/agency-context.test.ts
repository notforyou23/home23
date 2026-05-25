import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildAgencyContextSection } from '../../src/agent/context-assembly.js';

test('buildAgencyContextSection exposes active resident pursuits without raw inbox flood', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-agency-context-'));
  const agencyDir = path.join(root, 'instances', 'jerry', 'brain', 'agency');
  mkdirSync(agencyDir, { recursive: true });
  writeFileSync(path.join(agencyDir, 'state.json'), JSON.stringify({
    schema: 'home23.agency.state.v1',
    agent: 'jerry',
    mode: 'dry_run',
    attention: { currentPursuitId: 'ap_1', queueDepth: 4 },
    organs: {
      crons: {
        kind: 'scheduler',
        canSense: ['cron reports'],
        canChange: ['bounded schedules'],
        reports: ['scheduler receipts'],
        mustNeverDoAlone: ['create recurring work without pursuit binding'],
        failureSurface: 'cron run receipts',
        commandSurface: 'cron tools',
      },
    },
  }));
  writeFileSync(path.join(agencyDir, 'pursuits.jsonl'), [
    JSON.stringify({
      type: 'created',
      pursuit: {
        id: 'ap_1',
        status: 'active',
        title: 'Verify dashboard publish loop',
        authorityLevel: 'L2',
        desiredChangedFuture: 'Dashboard publish loop has a verifier receipt.',
        nextCheckAt: '2026-05-25T12:00:00.000Z',
      },
    }),
    JSON.stringify({
      type: 'created',
      pursuit: {
        id: 'ap_closed',
        status: 'closed',
        title: 'Old closed item',
        authorityLevel: 'L1',
      },
    }),
  ].join('\n') + '\n');

  const section = buildAgencyContextSection(root, 'jerry');
  assert.match(section, /Resident Agency/);
  assert.match(section, /dry_run/);
  assert.match(section, /Verify dashboard publish loop/);
  assert.match(section, /Body organs/);
  assert.match(section, /crons/);
  assert.match(section, /cron reports/);
  assert.match(section, /L2/);
  assert.doesNotMatch(section, /Old closed item/);
  assert.doesNotMatch(section, /inbox/);
});
