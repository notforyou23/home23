import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResidentInitiationDriver } from '../../../engine/src/agency/resident-initiation.js';
import { AuthorityPolicy } from '../../../engine/src/agency/authority-policy.js';
import { AgencyEditor } from '../../../engine/src/agency/editor.js';
import { AgencyKernel } from '../../../engine/src/agency/resident-kernel.js';

function pursuit(id, fields = {}) {
  return { id, status: 'active', purpose: 'exploration', scope: 'private_research',
    authorityLevel: 'L1', title: 'A real musical question', summary: 'Garcia kept recognizable phrasing across different timbres.',
    nextMove: 'Compare the MIDI guitar recording with an earlier guitar performance; note what makes the phrasing recognizable.',
    stopCondition: 'A sourced comparison or a specific unanswered question is recorded.',
    evidence: ['memory:garcia-midi-recording'], ...fields };
}

function fixture(t, rows = []) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-resident-initiation-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const pursuits = new Map(rows.map(row => [row.id, row]));
  const receipts = [];
  const kernel = { agentName: 'jerry', config: { enabled: true, mode: 'live' },
    authority: new AuthorityPolicy({ mode: 'live' }), editor: new AgencyEditor(),
    store: { listPursuits: ({ status, limit }) => [...pursuits.values()].filter(row => !status || status.includes(row.status)).slice(0, limit),
      getPursuit: id => pursuits.get(id), appendReceipt: receipt => receipts.push(receipt) } };
  let clock = 1_000_000;
  const requests = [];
  const options = { kernel, brainDir, isPrimaryResident: () => true, now: () => clock,
    sendInitiation: async request => { requests.push(request); return { initiationId: request.initiationId, state: 'succeeded', workId: 'work-one' }; } };
  return { kernel, pursuits, receipts, requests, options, statePath: path.join(brainDir, 'agency', 'resident-initiation.json'),
    advance: () => { clock += 60_000; } };
}

const tick = id => ({ selected: { pursuitId: id }, editor: { verdict: 'allow', action: 'advance_one_step' },
  nextAction: { kind: 'advance_one_step', pursuitId: id, dryRun: false } });

test('first enable baselines the whole backlog and timestamps alone cannot execute it', async t => {
  const f = fixture(t, Array.from({ length: 19_000 }, (_, i) => pursuit(`legacy-${i}`, {
    evidence: [{ sourceRef: 'memory:2026-09-27T12:00:00Z', pressureFreePct: 70, producedAt: '2026-09-27T12:00:00Z' }],
  })));
  const driver = new ResidentInitiationDriver(f.options);
  assert.equal((await driver.consume(tick('legacy-0'))).count, 19_000);
  f.pursuits.get('legacy-0').updatedAt = '2026-09-29T12:00:00Z';
  f.pursuits.get('legacy-0').evidence = [{ sourceRef: 'memory:2026-09-29T12:00:00Z', pressureFreePct: 70, producedAt: '2026-09-29T12:00:00Z' }];
  assert.equal((await driver.consume(tick('legacy-0'))).state, 'idle');
  assert.equal(f.requests.length, 0);
  f.pursuits.get('legacy-0').nextMove = 'Compare a newly supplied Garcia performance against the previous recording.';
  assert.equal((await driver.consume(tick('legacy-0'))).state, 'succeeded');
  assert.equal(f.requests.length, 1);
});

test('new material action uses fresh editor and current authority, never a generic tick', async t => {
  const f = fixture(t);
  const driver = new ResidentInitiationDriver(f.options);
  driver.initialize();
  for (const [id, fields] of [['unknown-purpose', { purpose: undefined }], ['unknown-scope', { scope: undefined }],
    ['generic', { nextMove: 'advance_one_step' }], ['public', { nextMove: 'Publish the draft publicly.' }],
    ['spend', { nextMove: 'Buy the hotel room for the trip.' }], ['destructive', { nextMove: 'Delete the old project directory.' }],
    ['L4', { authorityLevel: 'L4' }], ['no-evidence', { evidence: [] }]]) {
    f.pursuits.set(id, pursuit(id, fields));
    assert.equal((await driver.consume(tick(id))).state, 'idle');
  }
  f.pursuits.set('valid', pursuit('valid', { purpose: 'action', scope: 'verification', authorityLevel: 'L2',
    nextMove: 'Verify the reported hotel quote against its source and save a private receipt.' }));
  f.kernel.authority.mode = 'dry_run';
  assert.equal((await driver.consume(tick('valid'))).state, 'idle');
  f.kernel.authority.mode = 'live';
  assert.equal((await driver.consume(tick('valid'))).state, 'succeeded');
  assert.equal(f.requests.length, 1);
  assert.ok(f.receipts.every(receipt => !JSON.stringify(receipt).includes('reported hotel quote')));
});

test('the exact pending request is durable before effect and replays unchanged after uncertain acknowledgement and restart', async t => {
  const f = fixture(t);
  let unknown = true;
  f.options.sendInitiation = async request => {
    f.requests.push(request);
    const saved = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
    assert.deepEqual(saved.admissions[request.initiationId].request, request);
    if (unknown) throw new Error('Connection disappeared after the server admitted work');
    return { initiationId: request.initiationId, state: 'running', workId: 'work-existing' };
  };
  const driver = new ResidentInitiationDriver(f.options);
  driver.initialize();
  f.pursuits.set('new', pursuit('new'));
  assert.equal((await driver.consume(tick('new'))).reason, 'bridge_ack_unavailable');
  const restored = new ResidentInitiationDriver(f.options);
  assert.equal((await restored.consume(tick('new'))).reason, 'admission_backoff');
  assert.equal(f.requests.length, 1);
  f.advance(); unknown = false;
  assert.equal((await restored.consume(tick('new'))).workId, 'work-existing');
  assert.deepEqual(f.requests[0], f.requests[1]);
});

test('resident busy defers the same admission with backoff; concurrent consumes cannot duplicate effects', async t => {
  const f = fixture(t);
  f.options.sendInitiation = async request => { f.requests.push(request); return { state: 'deferred', reason: 'resident_busy' }; };
  const driver = new ResidentInitiationDriver(f.options); driver.initialize();
  f.pursuits.set('new', pursuit('new'));
  await Promise.all([driver.consume(tick('new')), driver.consume(tick('new'))]);
  assert.equal(f.requests.length, 1);
  await driver.consume(tick('new')); assert.equal(f.requests.length, 1);
  f.advance(); await driver.consume(tick('new')); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1]);
});

for (const terminal of ['succeeded', 'failed', 'cancelled']) {
  test(`${terminal} is sticky across restart and fresh telemetry timestamps; another valid inquiry can proceed`, async t => {
    const f = fixture(t);
    f.options.sendInitiation = async request => { f.requests.push(request); return { initiationId: request.initiationId, state: terminal }; };
    const driver = new ResidentInitiationDriver(f.options); driver.initialize();
    f.pursuits.set('new', pursuit('new', { evidence: ['memory:2026-09-27T12:00:00Z'] }));
    await driver.consume(tick('new'));
    f.pursuits.get('new').evidence = ['memory:2026-09-29T12:00:00Z'];
    f.pursuits.get('new').updatedAt = '2026-09-29T12:00:00Z';
    const restored = new ResidentInitiationDriver(f.options);
    assert.equal((await restored.consume(tick('new'))).state, 'idle');
    assert.equal(f.requests.length, 1);
    f.pursuits.set('next', pursuit('next', { purpose: 'question', nextMove: 'Explore whether a melody can be recognized by timing alone.' }));
    await restored.consume(tick('new')); assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].purpose, 'question');
    assert.equal(f.pursuits.get('new').status, 'active', 'execution completion is not invented objective verification');
  });
}

test('disabled, dry-run and nonprimary residents never admit or record a baseline; corrupted state fails closed', async t => {
  const f = fixture(t, [pursuit('new')]);
  f.kernel.config.enabled = false;
  assert.equal((await new ResidentInitiationDriver(f.options).consume(tick('new'))).state, 'inactive');
  f.kernel.config.enabled = true; f.kernel.config.mode = 'dry_run';
  await new ResidentInitiationDriver(f.options).consume(tick('new'));
  f.kernel.config.mode = 'live';
  await new ResidentInitiationDriver({ ...f.options, isPrimaryResident: () => false }).consume(tick('new'));
  assert.equal(fs.existsSync(f.statePath), false); assert.equal(f.requests.length, 0);
  fs.mkdirSync(path.dirname(f.statePath), { recursive: true }); fs.writeFileSync(f.statePath, '{broken state');
  await assert.rejects(new ResidentInitiationDriver(f.options).consume(tick('new')));
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), '{broken state'); assert.equal(f.requests.length, 0);
});

test('canonical proposals establish baseline first, preserve full old attention records and yield capacity after terminal execution', async t => {
  const f = fixture(t);
  const kernel = new AgencyKernel({ brainDir: f.options.brainDir, agentName: 'jerry', config: { enabled: true, mode: 'live',
    charter: { attention: { maxActivePursuits: 1, maxWatchItems: 1 } } }, initializeState: false });
  kernel.store.createPursuit(pursuit('legacy-active', { dedupeKey: 'legacy-active' }), { route: 'pursue', reason: 'preserved existing home' });
  kernel.store.createPursuit(pursuit('legacy-watch', { dedupeKey: 'legacy-watch' }), { route: 'watch', reason: 'preserved existing home' });
  const driver = new ResidentInitiationDriver({ ...f.options, kernel });
  driver.initialize(); kernel.ensureState();
  const proposal = { purpose: 'exploration', scope: 'private_research', why: 'An unresolved personal musical connection is worth exploring.',
    nextMove: 'Compare the Garcia MIDI performance with an earlier recording to examine recognizable phrasing.',
    stopCondition: 'A sourced comparison or an honest unresolved question is recorded.', evidenceRefs: ['memory:garcia-midi'] };
  const first = await driver.propose(proposal, { cycleSessionId: 'cycle-one', evidenceRefs: proposal.evidenceRefs });
  assert.ok(first.pursuit); assert.equal(first.pursuit.purpose, 'exploration'); assert.equal(first.pursuit.scope, 'private_research');
  assert.equal((await driver.consume(await kernel.tick())).state, 'succeeded');
  const next = await driver.propose({ ...proposal, purpose: 'question', nextMove: 'Examine whether timing alone preserves a melody through changed timbre.' },
    { cycleSessionId: 'cycle-two', evidenceRefs: proposal.evidenceRefs });
  assert.ok(next.pursuit); assert.equal(next.pursuit.status, 'active');
  await driver.consume(await kernel.tick()); assert.equal(f.requests.length, 2);
  const rows = kernel.store.listPursuits({ limit: 100 });
  assert.equal(rows.length, 4); assert.ok(rows.every(row => ['active', 'watch'].includes(row.status)),
    JSON.stringify(rows.map(row => ({ id: row.id, status: row.status, history: row.history.at(-1) }))));
  const restartedKernel = new AgencyKernel({ brainDir: f.options.brainDir, agentName: 'jerry', initializeState: false,
    config: { enabled: true, mode: 'live', charter: { attention: { maxActivePursuits: 1, maxWatchItems: 1 } } } });
  const restartedDriver = new ResidentInitiationDriver({ ...f.options, kernel: restartedKernel });
  restartedDriver.initialize(); restartedKernel.ensureState();
  assert.deepEqual(restartedKernel.store.listPursuits({ limit: 100 }).map(row => [row.id, row.status]).sort(),
    rows.map(row => [row.id, row.status]).sort(), 'restored boundary precedes attention reconciliation');
  assert.equal((await driver.propose({ ...proposal, evidenceRefs: ['invented:evidence'] }, { evidenceRefs: proposal.evidenceRefs })).reason, 'unsupplied_evidence');
});

test('a cancelled responsibility cannot be revived by rewording its move or stop; new owner evidence can open inquiry', async t => {
  const f = fixture(t);
  const kernel = new AgencyKernel({ brainDir: f.options.brainDir, agentName: 'jerry', config: { enabled: true, mode: 'live' } });
  f.options.sendInitiation = async request => { f.requests.push(request); return { initiationId: request.initiationId, state: 'cancelled' }; };
  const driver = new ResidentInitiationDriver({ ...f.options, kernel });
  const original = { purpose: 'exploration', scope: 'private_research', why: 'The recognizable musical voice remains an open question.',
    nextMove: 'Compare Garcia MIDI phrasing with the earlier guitar recording.', stopCondition: 'One grounded connection or an unresolved question is recorded.',
    evidenceRefs: ['message:owner-music-one'] };
  const first = await driver.propose(original, { evidenceRefs: original.evidenceRefs });
  await driver.consume(await kernel.tick());
  const restored = new ResidentInitiationDriver({ ...f.options, kernel });
  const repeated = await restored.propose({ ...original, nextMove: 'Study the old guitar recording against Garcia MIDI timing.',
    stopCondition: 'Save an honest question or one supported musical connection.' }, { evidenceRefs: original.evidenceRefs });
  assert.equal(repeated.state, 'already_considered'); assert.equal(repeated.pursuit.id, first.pursuit.id);
  kernel.store.updatePursuit(first.pursuit.id, { nextMove: 'Compare the timbre change in a differently worded private note.' });
  assert.equal((await restored.consume(await kernel.tick())).state, 'idle'); assert.equal(f.requests.length, 1);
  const context = restored.getContext(); assert.ok(context.length <= 4000); assert.match(context, /cancelled/);
  assert.match(context, /Same responsibility and supplied evidence/);
  const fresh = { ...original, evidenceRefs: ['message:owner-music-two'] };
  const newInquiry = await restored.propose(fresh, { evidenceRefs: fresh.evidenceRefs });
  assert.notEqual(newInquiry.pursuit.id, first.pursuit.id);
  await restored.consume(await kernel.tick()); assert.equal(f.requests.length, 2);
});

test('Stop progresses through existing running/cancelling/cancelled state and never reinitiates that responsibility', async t => {
  const f = fixture(t);
  const states = ['running', 'cancelling', 'cancelled'];
  f.options.sendInitiation = async request => { f.requests.push(request); return { initiationId: request.initiationId, state: states.shift(), workId: 'existing-work' }; };
  const driver = new ResidentInitiationDriver(f.options); driver.initialize(); f.pursuits.set('new', pursuit('new'));
  assert.equal((await driver.consume(tick('new'))).state, 'running');
  f.advance(); assert.equal((await driver.consume(tick('new'))).state, 'cancelling');
  f.advance(); assert.equal((await driver.consume(tick('new'))).state, 'cancelled');
  f.advance(); assert.equal((await driver.consume(tick('new'))).state, 'idle');
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.initiationId === f.requests[0].initiationId));
});

test('a failed pending-state write never permits a later memory-only bridge effect', async t => {
  const f = fixture(t); const driver = new ResidentInitiationDriver(f.options); driver.initialize();
  const savedPath = `${f.statePath}.saved`; fs.renameSync(f.statePath, savedPath); fs.mkdirSync(f.statePath);
  f.pursuits.set('new', pursuit('new'));
  await assert.rejects(driver.consume(tick('new'))); assert.equal(f.requests.length, 0);
  await assert.rejects(driver.consume(tick('new'))); assert.equal(f.requests.length, 0);
  fs.rmdirSync(f.statePath); fs.renameSync(savedPath, f.statePath);
  assert.equal((await driver.consume(tick('new'))).state, 'succeeded'); assert.equal(f.requests.length, 1);
});

test('private inquiry can discuss higher-risk histories while actual action directives remain outside scope', async t => {
  for (const [move, allowed] of [
    ['Compare the decision to publish the Garcia recording with its earlier private circulation.', true],
    ['Research the guitar purchase history and its effect on musical phrasing.', true],
    ['Examine the old deletion history against the source log.', true],
    ['Compare the recordings, then publish the result publicly.', false],
    ['Review the source and buy the replacement instrument.', false],
    ['Read the ledger. Delete the old project directory.', false],
  ]) {
    const f = fixture(t); const driver = new ResidentInitiationDriver(f.options); driver.initialize();
    f.pursuits.set('new', pursuit('new', { nextMove: move }));
    assert.equal((await driver.consume(tick('new'))).state, allowed ? 'succeeded' : 'idle', move);
  }
});

test('driver emits only Core-supported effort values and bounded model aliases', async t => {
  for (const fields of [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'ultra' }, { modelAlias: 'a'.repeat(129) }, { modelAlias: 'bad\0alias' }]) {
    const f = fixture(t); const driver = new ResidentInitiationDriver(f.options); driver.initialize();
    f.pursuits.set('new', pursuit('new', fields));
    assert.equal((await driver.consume(tick('new'))).state, 'idle'); assert.equal(f.requests.length, 0);
  }
  const f = fixture(t); const driver = new ResidentInitiationDriver({ ...f.options, reasoningEffort: 'max', modelAlias: 'frontier' }); driver.initialize();
  f.pursuits.set('new', pursuit('new')); await driver.consume(tick('new'));
  assert.equal(f.requests[0].reasoningEffort, 'max'); assert.equal(f.requests[0].modelAlias, 'frontier');
});

test('all bounded resident initiative evidence survives canonical latest-three projection and responsibility replay', async t => {
  const f = fixture(t);
  const kernel = new AgencyKernel({ brainDir: f.options.brainDir, agentName: 'jerry', initializeState: false,
    config: { enabled: true, mode: 'live' } });
  const driver = new ResidentInitiationDriver({ ...f.options, kernel }); driver.initialize(); kernel.ensureState();
  const refs = ['message:owner-cold', 'watch:oxygen-reading', 'memory:health-history', 'memory:guitar-evening', 'artifact:source-notes'];
  const proposal = { purpose: 'exploration', scope: 'private_research', why: 'A grounded association deserves inquiry.',
    nextMove: 'Compare the remembered context with the current observation and record a bounded question.',
    stopCondition: 'A sourced association or an honest unresolved question is recorded.', evidenceRefs: refs };
  const result = await driver.propose(proposal, { evidenceRefs: refs });
  assert.equal(result.pursuit.latestEvidence.length, 3); assert.deepEqual(result.pursuit.evidence, refs);
  await driver.consume(await kernel.tick()); assert.deepEqual(f.requests[0].evidenceRefs, refs);
  const restored = new ResidentInitiationDriver({ ...f.options, kernel });
  const repeated = await restored.propose({ ...proposal, nextMove: 'Examine the current observation against remembered context.' }, { evidenceRefs: refs });
  assert.equal(repeated.state, 'already_considered'); assert.equal(repeated.initiationState, 'succeeded');
  kernel.store.updatePursuit(result.pursuit.id, { nextMove: 'Save a newly phrased version of the same question.' });
  assert.equal((await restored.consume(await kernel.tick())).state, 'idle'); assert.equal(f.requests.length, 1);
});

test('withdrawn pursuit reads actual Core settlement without replaying an effect or jamming later inquiry', async t => {
  const f = fixture(t);
  let canonicalState = 'running'; const statusReads = [];
  const driver = new ResidentInitiationDriver({ ...f.options,
    sendInitiation: async request => { f.requests.push(request); return { initiationId: request.initiationId, state: 'running', workId: 'work-one' }; },
    getInitiationStatus: async request => { statusReads.push(request); return { ...request, state: canonicalState, workId: 'work-one' }; },
  });
  driver.initialize(); f.pursuits.set('first', pursuit('first'));
  const admitted = await driver.consume(tick('first')); assert.equal(admitted.state, 'running');
  f.pursuits.get('first').status = 'deferred'; f.advance();
  assert.equal((await driver.consume(tick('first'))).reason, 'pending_authority_or_pursuit_unavailable');
  assert.equal(f.requests.length, 1, 'withdrawal must not replay an admission effect');
  assert.equal(statusReads.length, 1);
  canonicalState = 'cancelled'; f.advance();
  assert.equal((await driver.consume(tick('first'))).state, 'cancelled');
  assert.equal(f.requests.length, 1);
  f.pursuits.set('next', pursuit('next', { evidence: ['message:new-owner-question'] }));
  assert.equal((await driver.consume(tick('next'))).state, 'running'); assert.equal(f.requests.length, 2);
});

test('withdrawn pending proposal settles confirmed absence and survives restart without blocking new work', async t => {
  const f = fixture(t);
  const options = { ...f.options,
    sendInitiation: async request => { f.requests.push(request); return { state: 'deferred', reason: 'resident_busy' }; },
    getInitiationStatus: async request => ({ ...request, state: 'not_admitted' }),
  };
  const driver = new ResidentInitiationDriver(options); driver.initialize();
  f.pursuits.set('first', pursuit('first')); await driver.consume(tick('first'));
  f.pursuits.get('first').status = 'deferred'; f.advance();
  assert.equal((await driver.consume(tick('first'))).state, 'withdrawn');
  assert.equal(f.requests.length, 1);
  const restored = new ResidentInitiationDriver({ ...options, sendInitiation: f.options.sendInitiation });
  f.pursuits.set('next', pursuit('next', { evidence: ['message:new-private-question'] }));
  assert.equal((await restored.consume(tick('next'))).state, 'succeeded');
  assert.equal(f.requests.length, 2);
  f.pursuits.get('first').status = 'active';
  assert.equal((await restored.consume(tick('first'))).state, 'idle', 'withdrawal remains sticky');
  assert.match(restored.getContext(), /Core confirmed no admission at the status read/);
});

test('trusted changed readings reopen inquiry while clocks, model claims and raw RAM cannot', async t => {
  const f = fixture(t);
  const kernel = new AgencyKernel({ brainDir: f.options.brainDir, agentName: 'jerry', initializeState: false,
    config: { enabled: true, mode: 'live' } });
  const driver = new ResidentInitiationDriver({ ...f.options, kernel }); driver.initialize(); kernel.ensureState();
  const propose = async (sourceRef, payload, channelId = 'domain.health', supplied = true) => {
    const refs = [sourceRef, 'message:owner-cold'];
    return driver.propose({ purpose: 'question', scope: 'private_research', why: 'An existing contextual connection needs a bounded check.',
      nextMove: 'Check the sourced reading against the owner context and record one honest question.',
      stopCondition: 'One grounded contextual question or the missing evidence is recorded.', evidenceRefs: refs },
    { evidenceRefs: refs, observation: { channelId, sourceRef: supplied ? sourceRef : 'invented:unrelated', payload, flag: 'COLLECTED' } });
  };
  const first = await propose('health:2026-09-29T12:00:00Z', { oxygenSat: 94.5, ts: '2026-09-29T12:00:00Z', healthDataAgeDays: 0 });
  assert.match(first.pursuit.observationDigest, /^[a-f0-9]{64}$/);
  await driver.consume(await kernel.tick());
  const repeated = await propose('health:2026-09-30T12:00:00Z', { oxygenSat: 94.5, ts: '2026-09-30T12:00:00Z', healthDataAgeDays: 1 });
  assert.equal(repeated.state, 'already_considered');
  const changed = await propose('health:2026-09-30T12:00:00Z', { oxygenSat: 96.5, ts: '2026-09-30T12:00:00Z' });
  assert.notEqual(changed.pursuit.id, first.pursuit.id);
  await driver.consume(await kernel.tick()); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].evidenceRefs, ['health:2026-09-30T12:00:00Z', 'message:owner-cold'], 'Core still receives exact supplied references');
  const memory = await propose('memory:2026-09-30T12:00:00Z', { freePct: 3 }, 'machine.memory');
  assert.equal(memory.pursuit.observationDigest, null); await driver.consume(await kernel.tick());
  const rawChange = await propose('memory:2026-09-30T13:00:00Z', { freePct: 1 }, 'machine.memory');
  assert.equal(rawChange.state, 'already_considered');
  const unsupplied = await propose('health:2026-09-30T12:00:00Z', { oxygenSat: 80 }, 'domain.health', false);
  assert.equal(unsupplied.pursuit.observationDigest, null, 'unsupplied observation cannot supply a reading');
});
