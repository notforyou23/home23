import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { createPersistentResidentProvisioner } from '../../cli/lib/bot-lifecycle-resident-adapter.js';
import { createExactNameProcessController } from '../../cli/lib/bot-lifecycle-process-adapter.js';
import { createBotLifecycleService, BotLifecycleError } from '../../src/coordination/bot-lifecycle/index.ts';
import { classifyPolicy } from '../../src/coordination/policy/index.ts';

const NOW = '2026-08-25T16:00:00.000Z';

function makeInstallation() {
  const root = mkdtempSync(join(tmpdir(), 'home23-m28-adapter-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'primary'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({ home: { primaryAgent: 'primary' } }));
  writeFileSync(join(root, 'instances', 'primary', 'config.yaml'), yaml.dump({
    agent: { name: 'primary', displayName: 'Primary', owner: { name: 'owner' } },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
    mcp: { enabled: false },
  }));
  return root;
}

function standingPolicy(operation, target) {
  return {
    action: { actorPrincipalId: 'user_owner', operation, target, parameters: {} },
    factSource: { kind: 'trusted_policy_boundary', reference: 'fixture:standing-scope' },
    standing: { scope: 'within', delegation: 'within', budget: 'within', audience: 'within', allowlist: 'within' },
    impactClasses: [],
    contextAccess: { kind: 'none' },
  };
}

function createRequest(binding = 'fixture-bot', requestId = 'request_create_1') {
  return {
    requestId,
    correlationId: `correlation_${requestId}`,
    actorPrincipalId: 'user_owner',
    residentBinding: binding,
    displayName: 'Fixture Bot',
    purpose: 'A disposable persistent specialist',
    requiredCapabilities: ['chat'],
    expectedAuthorityEpoch: 7,
    policy: standingPolicy('bot_lifecycle.create', binding),
  };
}

function controlRequest(operation, botId) {
  return {
    requestId: `request_${operation}`,
    correlationId: `correlation_${operation}`,
    actorPrincipalId: 'user_owner', botId, operation,
    expectedAuthorityEpoch: 7,
    policy: standingPolicy(`bot_lifecycle.${operation}`, botId),
  };
}

function harness(root, { failBinding = false } = {}) {
  const bots = new Map();
  const receipts = new Map();
  const processInvocations = [];
  let bindCalls = 0;
  const provisioner = createPersistentResidentProvisioner({
    installationRoot: root,
    ownerName: 'fixture-owner',
    now: () => new Date(NOW),
  });
  const processes = createExactNameProcessController({
    installationRoot: root,
    env: {},
    execFile: (file, args) => {
      processInvocations.push({ file, args: [...args] });
      return '';
    },
  });
  const mailboxBinder = {
    bindAfterResidentCreated: async (input) => {
      bindCalls += 1;
      assert.ok(readFileSync(join(root, 'instances', input.residentBinding, 'config.yaml'), 'utf8'));
      if (failBinding) throw Object.assign(new Error('fixture mailbox failure'), { code: 'db_unavailable' });
      const existing = [...bots.values()].find((bot) => bot.residentBinding === input.residentBinding);
      if (existing) return existing;
      const bot = Object.freeze({
        id: `bot_${input.residentBinding.replaceAll('-', '_')}`,
        principalId: `bot_${input.residentBinding.replaceAll('-', '_')}`,
        name: input.displayName, purpose: input.purpose, lifecycle: 'active', availability: 'offline',
        conversationId: `cnv_${input.residentBinding.replaceAll('-', '_')}`,
        residentBinding: input.residentBinding, version: 1, createdAt: NOW, updatedAt: NOW,
      });
      bots.set(bot.id, bot);
      return bot;
    },
    getByBotId: async (botId) => bots.get(botId) || null,
  };
  const options = {
    authority: {
      enabled: () => true,
      currentEpoch: async () => ({
        capability: 'bot_lifecycle', epoch: 7, mode: 'canonical', writer: 'home23-coordination',
        effectiveAtEventSequence: 41, rollbackEpoch: 1,
      }),
      decide: (request) => classifyPolicy(request, new Date(NOW)),
    },
    provisioner, mailboxBinder, processes,
    receipts: {
      get: async (id) => receipts.get(id) || null,
      putIfAbsent: async (receipt) => {
        const prior = receipts.get(receipt.requestId);
        if (prior) return prior;
        receipts.set(receipt.requestId, receipt);
        return receipt;
      },
    },
    canonicalWriter: 'home23-coordination', now: () => new Date(NOW),
  };
  return {
    service: () => createBotLifecycleService(options),
    processInvocations, bots, receipts,
    bindCalls: () => bindCalls,
  };
}

test('M28 adapters provision in a disposable installation and preserve identity across exact lifecycle', async () => {
  const root = makeInstallation();
  try {
    const before = readdirSync(join(root, 'instances')).sort();
    const fixture = harness(root);
    const firstService = fixture.service();
    const created = await firstService.create(createRequest());
    const duplicate = await firstService.create(createRequest());
    assert.deepEqual(duplicate, created);
    assert.equal(fixture.bindCalls(), 1);

    // Recompose the service as a process restart would; durable ports retain identity.
    const restartedService = fixture.service();
    for (const operation of ['stop', 'start', 'restart']) {
      const receipt = await restartedService.control(controlRequest(operation, created.botId));
      assert.equal(receipt.botId, created.botId);
      assert.equal(receipt.mailboxId, created.mailboxId);
    }

    const expectedNames = [
      'home23-fixture-bot', 'home23-fixture-bot-dash',
      'home23-fixture-bot-mcp', 'home23-fixture-bot-harness',
    ];
    const stopCalls = fixture.processInvocations.filter((call) => call.file === 'pm2');
    assert.deepEqual(stopCalls.map((call) => call.args), expectedNames.map((name) => ['stop', name]));
    const ecosystemCalls = fixture.processInvocations.filter((call) => call.file === 'env');
    assert.equal(ecosystemCalls.length, 2);
    assert.ok(ecosystemCalls[0].args.includes('start'));
    assert.ok(ecosystemCalls[1].args.includes('restart'));
    assert.ok(ecosystemCalls.every((call) => call.args.includes(expectedNames.join(','))));
    assert.ok(fixture.processInvocations.every((call) => !call.args.includes('all')));

    const after = readdirSync(join(root, 'instances')).sort();
    assert.deepEqual(before, ['primary']);
    assert.deepEqual(after, ['fixture-bot', 'primary']);
    const config = yaml.load(readFileSync(join(root, 'instances', 'fixture-bot', 'config.yaml'), 'utf8'));
    assert.equal(config.agent.owner.name, 'fixture-owner');
    assert.equal(config.agent.owner.facts, undefined);
    assert.deepEqual(config.feeder.additionalWatchPaths.filter((entry) => !entry.path.startsWith(join(root, 'instances', 'fixture-bot'))), []);
    const personal = readFileSync(join(root, 'instances', 'fixture-bot', 'workspace', 'PERSONAL.md'), 'utf8');
    assert.match(personal, /No additional personal context provided/);
    const manifest = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
    assert.equal(manifest.some((agent) => /temporary|hand/i.test(agent.name)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M28 adapter archives a partial resident, regenerates the manifest, and keeps a failure receipt', async () => {
  const root = makeInstallation();
  try {
    const fixture = harness(root, { failBinding: true });
    const request = createRequest('partial-bot', 'request_partial');
    await assert.rejects(fixture.service().create(request), (error) => {
      assert.ok(error instanceof BotLifecycleError);
      assert.equal(error.code, 'operation_failed');
      assert.deepEqual(error.receipt.failure, {
        phase: 'mailbox_bind', code: 'db_unavailable', partialResidentArchived: true,
      });
      return true;
    });
    assert.equal(fixture.receipts.get('request_partial').outcome, 'failed');
    assert.equal(readdirSync(join(root, 'instances')).includes('partial-bot'), false);
    const archived = readdirSync(join(root, 'instances', '.house', 'bot-lifecycle-archive'));
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^partial-bot-20260825160000000-mailbox_bind_failed$/);
    const manifest = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
    assert.equal(manifest.some((agent) => agent.name === 'partial-bot'), false);
    assert.equal(fixture.bots.size, 0);
    const retry = await fixture.service().create(request);
    assert.equal(retry.outcome, 'failed');
    assert.equal(fixture.bindCalls(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provisioning adapter archives files left by an agent-create failure', async () => {
  const root = makeInstallation();
  try {
    const provisioner = createPersistentResidentProvisioner({
      installationRoot: root,
      now: () => new Date(NOW),
      createAgent: async (installationRoot, name) => {
        mkdirSync(join(installationRoot, 'instances', name), { recursive: true });
        writeFileSync(join(installationRoot, 'instances', name, 'config.yaml'), 'partial: true\n');
        throw Object.assign(new Error('template write failed'), { code: 'template_write_failed' });
      },
    });
    await assert.rejects(provisioner.create({
      residentBinding: 'create-failure', displayName: 'Failure', purpose: 'Fixture failure',
      requiredCapabilities: [], copyPrivateMemory: false,
    }), { code: 'template_write_failed' });
    assert.equal(readdirSync(join(root, 'instances')).includes('create-failure'), false);
    assert.deepEqual(readdirSync(join(root, 'instances', '.house', 'bot-lifecycle-archive')), [
      'create-failure-20260825160000000-resident_create_failed',
    ]);
    const manifest = JSON.parse(readFileSync(join(root, 'config', 'agents.json'), 'utf8'));
    assert.equal(manifest.some((agent) => agent.name === 'create-failure'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact process adapter rejects broad and duplicate targets before invoking PM2', async () => {
  const calls = [];
  const controller = createExactNameProcessController({
    installationRoot: '/disposable/home23',
    execFile: (...args) => calls.push(args),
  });
  await assert.rejects(controller.stopExact(['all']), { code: 'process_names_invalid' });
  await assert.rejects(controller.startExact(['home23-bot', 'home23-bot']), { code: 'process_names_invalid' });
  assert.equal(calls.length, 0);
});
