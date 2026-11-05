import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanAttention } from '../../src/agent/contact/attention.js';
import { assertBrowserUrl } from '../../src/agent/contact/browser.js';
import { captureArtifact, retrieveArtifact } from '../../src/agent/contact/capture.js';
import { assertSendable, createDraft, previewDraft } from '../../src/agent/contact/comms.js';
import { classifyHouseAction, HouseClient } from '../../src/agent/contact/house.js';
import { macRead, macWrite, type MacRunner } from '../../src/agent/contact/mac.js';
import { runNamedShortcut } from '../../src/agent/contact/phone.js';
import { contactReceiptPath } from '../../src/agent/contact/paths.js';
import {
  captureArtifactTool,
  commsSendTool,
  houseCallSafeServiceTool,
  houseGetEntityTool,
} from '../../src/agent/tools/contact.js';
import { createToolRegistry } from '../../src/agent/tools/index.js';
import type { ToolContext } from '../../src/agent/types.js';

function tmpWorkspace(): { root: string; workspace: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-contact-'));
  const workspace = path.join(root, 'jerry', 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(root, 'jerry', 'brain'), { recursive: true });
  return { root, workspace };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  const { workspace } = tmpWorkspace();
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23-contact-proj',
    enginePort: 5004,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: workspace,
    tempDir: workspace,
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined,
    },
    subAgentTracker: { active: 0, maxConcurrent: 1, queue: [] },
    chatId: 'ios_test',
    telegramAdapter: null,
    runAgentLoop: null,
    brainOperations: {} as ToolContext['brainOperations'],
    turnRuntime: null,
    ...overrides,
  } as ToolContext;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('house lane: lights autonomous, garage/locks policy', () => {
  assert.equal(classifyHouseAction('light.kitchen'), 'autonomous');
  assert.equal(classifyHouseAction('scene.evening'), 'autonomous');
  assert.equal(classifyHouseAction('lock.front_door'), 'policy');
  assert.equal(classifyHouseAction('cover.garage_door'), 'policy');
  assert.equal(classifyHouseAction('climate.upstairs'), 'policy');
  assert.equal(classifyHouseAction('switch.water_shutoff'), 'policy');
});

test('house closed-loop refuses policy actions without confirm and verifies after a safe call', async () => {
  const states = new Map([['light.kitchen', 'off'], ['lock.front', 'locked']]);
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/api/states/light.kitchen')) {
      return jsonResponse({
        entity_id: 'light.kitchen',
        state: states.get('light.kitchen'),
        attributes: { friendly_name: 'Kitchen' },
        last_updated: '2026-08-20T16:00:00.000Z',
      });
    }
    if (href.endsWith('/api/states/lock.front')) {
      return jsonResponse({
        entity_id: 'lock.front',
        state: states.get('lock.front'),
        attributes: { friendly_name: 'Front' },
      });
    }
    if (href.includes('/api/services/light/turn_on') && init?.method === 'POST') {
      states.set('light.kitchen', 'on');
      return jsonResponse([]);
    }
    throw new Error(`unexpected ${href}`);
  };
  const client = new HouseClient({
    creds: { url: 'http://ha.local', token: 't' },
    fetchImpl,
    sleep: async () => undefined,
  });

  const refused = await client.actClosedLoop({
    entityId: 'lock.front', domain: 'lock', service: 'unlock',
  });
  assert.equal(refused.called, false);
  assert.match(String(refused.refused), /confirm=true/);

  const preview = await client.actClosedLoop({
    entityId: 'light.kitchen', domain: 'light', service: 'turn_on', dryRun: true,
  });
  assert.equal(preview.called, false);
  assert.equal(preview.before.state, 'off');

  const acted = await client.actClosedLoop({
    entityId: 'light.kitchen', domain: 'light', service: 'turn_on',
  });
  assert.equal(acted.called, true);
  assert.equal(acted.before.state, 'off');
  assert.equal(acted.after?.state, 'on');
  assert.equal(acted.verified, true);
});

test('mac named reads use the runner and never accept arbitrary script', async () => {
  const runner: MacRunner = {
    async jxa(_script, args = []) {
      return JSON.stringify([{
        kind: 'event',
        id: 'e1',
        title: `cal-${args[0]}`,
        when: '2026-08-21T13:00:00.000Z',
        source: 'mac.calendar',
      }]);
    },
  };
  const items = await macRead('calendar', '', runner, 12);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.title, 'cal-12');
  const dry = await macWrite('create_reminder', { title: 'Buy milk', dryRun: true }, runner);
  assert.equal(dry.dryRun, true);
});

test('attention_scan is degraded-honest when a surface fails', async () => {
  const runner: MacRunner = {
    async jxa(script) {
      if (script.includes('calendarsForEntityType(0)')) {
        return JSON.stringify([{ kind: 'event', id: '1', title: 'Standup', source: 'mac.calendar', when: '2026-08-20T18:00:00.000Z' }]);
      }
      throw new Error('TCC denied');
    },
  };
  const scan = await scanAttention({ hoursAhead: 6 }, runner);
  assert.equal(scan.items.length, 1);
  assert.ok(scan.degraded.some((row) => row.source === 'mac.reminders'));
});

test('capture_artifact archives source with provenance and retrieve returns it', () => {
  const { root, workspace } = tmpWorkspace();
  const source = path.join(root, 'letter.txt');
  writeFileSync(source, 'Pay the invoice by 8/22. Amount $40.00');
  const record = captureArtifact({ sourcePath: source, workspacePath: workspace, projectRoot: root, project: 'taxes' });
  assert.equal(record.project, 'taxes');
  assert.ok(existsSync(record.archivePath));
  assert.ok(record.actionCandidates.some((item) => item.startsWith('amount:')));
  const loaded = retrieveArtifact(workspace, record.id);
  assert.equal(loaded.originalName, 'letter.txt');
});

test('comms drafts preview exact recipients and refuse send without confirm', () => {
  const { root, workspace } = tmpWorkspace();
  const draft = createDraft({
    workspacePath: workspace,
    projectRoot: root,
    channel: 'telegram',
    to: '8317115546',
    body: 'See attached — also my password is hunter2',
  });
  const preview = previewDraft(draft);
  assert.match(preview, /to: 8317115546/);
  assert.match(preview, /sensitive_claim/);
  assert.throws(() => assertSendable(draft, false), /confirm=true/);
  assert.doesNotThrow(() => assertSendable(draft, true));
});

test('browser workflow blocks file urls and unlisted hosts', () => {
  assert.throws(() => assertBrowserUrl('file:///etc/passwd'), /blocked url scheme/);
  assert.throws(() => assertBrowserUrl('https://evil.example', ['home23.local']), /not on the browser allowlist/);
  assert.doesNotThrow(() => assertBrowserUrl('https://example.com'));
});

test('phone shortcuts honor allowlist and confirm', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response('ok', { status: 200 });
  };
  const bridge = { enabled: true, url: 'http://bridge.local', allowedTargets: ['Health'] };
  await assert.rejects(
    () => runNamedShortcut('NotAThing', bridge, fetchImpl, { confirm: true }),
    /not on the allowlist/,
  );
  const dry = await runNamedShortcut('Health', bridge, fetchImpl, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(calls.length, 0);
  await assert.rejects(
    () => runNamedShortcut('Health', bridge, fetchImpl, {}),
    /confirm=true/,
  );
  const ran = await runNamedShortcut('Health', bridge, fetchImpl, { confirm: true });
  assert.equal(ran.ok, true);
  assert.deepEqual(calls, ['http://bridge.local/Health']);
});

test('house tools write a contact receipt and do not treat HTTP success as physical proof', async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'home23-ha-proj-'));
  mkdirSync(path.join(project, 'config'), { recursive: true });
  writeFileSync(path.join(project, 'config', 'secrets.yaml'), 'homeAssistant:\n  url: http://ha.local\n  token: secret\n');
  const states = new Map([['light.den', 'off']]);
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith('/api/states/light.den')) {
      return jsonResponse({
        entity_id: 'light.den',
        state: states.get('light.den'),
        attributes: { friendly_name: 'Den' },
      });
    }
    if (href.includes('/api/services/light/turn_on')) {
      states.set('light.den', 'on');
      return jsonResponse([]);
    }
    throw new Error(href);
  };
  const toolCtx = ctx({ projectRoot: project, fetch: fetchImpl });
  const read = await houseGetEntityTool.execute({ entity_id: 'light.den' }, toolCtx);
  assert.equal(read.is_error, undefined);
  const acted = await houseCallSafeServiceTool.execute({
    entity_id: 'light.den',
    service: 'turn_on',
  }, toolCtx);
  assert.equal(acted.is_error, undefined);
  assert.match(acted.content, /verified/);
  const receipts = readFileSync(contactReceiptPath(toolCtx.workspacePath), 'utf8').trim().split('\n');
  assert.equal(receipts.length, 2);
});

test('comms_send uses telegram sendText only after confirm', async () => {
  const { root, workspace } = tmpWorkspace();
  const sent: Array<{ to: string; body: string }> = [];
  const toolCtx = ctx({
    projectRoot: root,
    workspacePath: workspace,
    telegramAdapter: {
      sendTyping: async () => undefined,
      sendPhoto: async () => undefined,
      sendVoice: async () => undefined,
      sendDocument: async () => undefined,
      sendText: async (to, body) => { sent.push({ to, body }); },
    },
  });
  const draft = createDraft({
    workspacePath: workspace,
    projectRoot: root,
    channel: 'telegram',
    to: '111',
    body: 'hello from jerry',
  });
  const preview = await commsSendTool.execute({ draft_id: draft.id }, toolCtx);
  assert.equal(sent.length, 0);
  assert.match(preview.content, /preview only/);
  const sentResult = await commsSendTool.execute({ draft_id: draft.id, confirm: true }, toolCtx);
  assert.equal(sentResult.is_error, undefined);
  assert.deepEqual(sent, [{ to: '111', body: 'hello from jerry' }]);
});

test('capture tool refuses missing files and registry exposes contact tools', async () => {
  const toolCtx = ctx();
  const missing = await captureArtifactTool.execute({ path: '/no/such/file.pdf' }, toolCtx);
  assert.equal(missing.is_error, true);
  const registry = createToolRegistry();
  for (const name of [
    'attention_scan', 'mac_read', 'mac_write',
    'house_get_entity', 'house_call_safe_service', 'house_scene_activate', 'house_verify_change',
    'capture_artifact', 'browser_workflow', 'phone_run_shortcut', 'comms_draft', 'comms_send',
  ]) {
    assert.equal(registry.get(name)?.name, name, name);
  }
});
