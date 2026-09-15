import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildAgencyContextSection,
  buildOperatorObligationContextSection,
} from '../../src/agent/context-assembly.js';

function writeAgencyState(root: string, obligations: Array<Record<string, unknown>>): string {
  const agencyDir = path.join(root, 'instances', 'jerry', 'brain', 'agency');
  mkdirSync(agencyDir, { recursive: true });
  writeFileSync(path.join(agencyDir, 'state.json'), JSON.stringify({
    schema: 'home23.agency.state.v1',
    agent: 'jerry',
    obligations,
  }));
  return agencyDir;
}

function obligationLines(section: string): string[] {
  return section.split('\n').filter((line) => line.startsWith('- '));
}

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

test('buildAgencyContextSection exposes resident prompt contracts from canonical state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-agency-context-'));
  const agencyDir = path.join(root, 'instances', 'jerry', 'brain', 'agency');
  mkdirSync(agencyDir, { recursive: true });
  writeFileSync(path.join(agencyDir, 'state.json'), JSON.stringify({
    schema: 'home23.agency.state.v1',
    agent: 'jerry',
    mode: 'dry_run',
    attention: { currentPursuitId: null, queueDepth: 0 },
    governance: {
      promptContracts: {
        agency_bootcamp_reports: {
          promptScope: 'agency_bootcamp_reports',
          target: 'chat.agency_context',
          promptText: 'Reports must state discard, no-change, watch, pursuit, task, or claim outcome before delivery.',
          reason: 'Curriculum digestion changed future report prompting.',
        },
      },
    },
  }));

  const section = buildAgencyContextSection(root, 'jerry');
  assert.match(section, /Prompt contracts/);
  assert.match(section, /agency_bootcamp_reports/);
  assert.match(section, /Reports must state discard, no-change, watch, pursuit, task, or claim outcome before delivery/);
});

test('operator obligation context renders nothing when no pending operator obligation exists', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-operator-obligations-'));
  writeAgencyState(root, [
    {
      obligationId: 'open_task:task_self',
      kind: 'open_task',
      audience: 'self',
      status: 'open',
      at: '2026-09-01T12:00:00.000Z',
      reason: 'Finish the resident-owned follow-up.',
    },
    {
      obligationId: 'operator_question:q_already_surfaced',
      kind: 'operator_question',
      audience: 'operator',
      status: 'open',
      surfacedAt: '2026-09-14T12:00:00.000Z',
      at: '2026-09-01T12:00:00.000Z',
      reason: 'This was already voiced.',
    },
  ]);

  assert.equal(buildOperatorObligationContextSection(root, 'jerry'), '');
});

test('operator obligation context renders all three pending items oldest first', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-operator-obligations-'));
  writeAgencyState(root, [
    {
      obligationId: 'operator_question:q_newest',
      kind: 'operator_question',
      audience: 'operator',
      status: 'open',
      at: '2026-09-14T12:00:00.000Z',
      reason: 'Choose the newest option.',
    },
    {
      obligationId: 'authority_request:ar_oldest',
      kind: 'authority_request',
      audience: 'operator',
      status: 'open',
      at: '2026-09-10T12:00:00.000Z',
      reason: 'Authorize the oldest bounded action.',
    },
    {
      obligationId: 'blocked_pursuit:ap_middle',
      kind: 'blocked_pursuit',
      audience: 'operator',
      status: 'open',
      at: '2026-09-12T12:00:00.000Z',
      reason: 'Decide which operator-owned route to take.',
    },
  ]);

  const section = buildOperatorObligationContextSection(
    root,
    'jerry',
    Date.parse('2026-09-15T12:00:00.000Z'),
  );
  const lines = obligationLines(section);

  assert.equal(lines.length, 3);
  assert.match(section, /^## OWED TO JTR — surface these in conversation, do not let them sit\./);
  assert.match(lines[0], /authority_request \| age=5d/);
  assert.match(lines[1], /blocked_pursuit \| age=3d/);
  assert.match(lines[2], /operator_question \| age=1d/);
});

test('operator obligation context caps eight pending items at five and reports overflow', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-operator-obligations-'));
  writeAgencyState(root, Array.from({ length: 8 }, (_, index) => ({
    obligationId: `operator_question:q_${index + 1}`,
    kind: 'operator_question',
    audience: 'operator',
    status: 'open',
    at: `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
    reason: `Decision ${index + 1}`,
  })));

  const section = buildOperatorObligationContextSection(
    root,
    'jerry',
    Date.parse('2026-09-15T12:00:00.000Z'),
  );

  assert.equal(obligationLines(section).length, 5);
  assert.match(section, /Decision 1/);
  assert.match(section, /Decision 5/);
  assert.doesNotMatch(section, /Decision 6/);
  assert.match(section, /Overflow: 3 more operator obligations\./);
});

test('operator obligation context ignores unreadable agency state without throwing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-operator-obligations-'));
  const agencyDir = path.join(root, 'instances', 'jerry', 'brain', 'agency');
  mkdirSync(agencyDir, { recursive: true });
  writeFileSync(path.join(agencyDir, 'state.json'), '{not json');

  assert.doesNotThrow(() => buildOperatorObligationContextSection(root, 'jerry'));
  assert.equal(buildOperatorObligationContextSection(root, 'jerry'), '');
});
