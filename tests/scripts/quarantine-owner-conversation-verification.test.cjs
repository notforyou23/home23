'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const lockfile = require('proper-lockfile');
const { quarantineOwnerConversationLedger, parseArguments } = require('../../scripts/quarantine-owner-conversation-verification.cjs');

const script = path.resolve(__dirname, '../../scripts/quarantine-owner-conversation-verification.cjs');
const NOW = '2026-10-14T18:00:00.000Z';

function entry(id, overrides = {}) {
  return {
    id, type: 'decision', statement: 'Get Trey/Billy tickets through Ticketmaster for Divided Sky in Worcester.',
    title: 'Concert tickets', status: 'active', actor: 'agent', privacy_class: 'personal',
    createdAt: NOW, updatedAt: NOW, confidence: 0.8,
    provenance: { generation_method: 'owner_conversation', session_refs: ['owner-chat'], source_refs: ['message-1'] },
    arbitrary: { preserved: ['do not alter'] }, ...overrides,
  };
}

function fixture(t, document, name = 'relationship-ledger.json') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-verification-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, name);
  const bytes = Buffer.from(typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`);
  fs.writeFileSync(ledgerPath, bytes, { mode: 0o640 });
  return { root, ledgerPath, bytes, read: () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) };
}

function mixedDocument() {
  return {
    schema: 'home23.relationship-ledger.v1', agent: 'synthetic', preservedRoot: { value: true },
    entries: [
      entry('verify-id', { provenance: { generation_method: 'owner_conversation', session_refs: ['home-verify-tickets'], source_refs: ['message-1'] } }),
      entry('meta', { statement: 'Let us test your recall of Trey/Billy tickets using brain_search.' }),
      entry('flagged', { metadata: { verification: true, untouched: 'yes' } }),
      entry('old', { provenance: { generation_method: 'owner_conversation', session_refs: ['retrieval-test-older'] }, updatedAt: '2026-10-13T23:59:59.999Z' }),
      entry('real-owner', { updatedAt: '2026-07-01T12:00:00.000Z' }),
      entry('ordinary-question', { statement: 'Can you find a hotel near Worcester for Friday lodging?' }),
      entry('recap', { metadata: { conversation_kind: 'recap' } }),
      entry('non-owner', { provenance: { generation_method: 'agent_note', session_refs: ['home-verify-existing'] } }),
    ],
  };
}

test('dry-run reports counts and leaves exact ledger bytes and directory entries untouched', (t) => {
  const fx = fixture(t, mixedDocument());
  const beforeNames = fs.readdirSync(fx.root).sort();
  const result = quarantineOwnerConversationLedger({ inputPath: fx.root, since: '2026-10-14', dryRun: true, now: NOW });
  assert.equal(result.dryRun, true);
  assert.equal(result.scanned, 8);
  assert.equal(result.ownerCandidates, 7);
  assert.equal(result.inWindow, 5);
  assert.equal(result.exclusions, 3);
  assert.equal(result.applied, 0);
  assert.equal(result.skippedBeforeSince, 2);
  assert.equal(result.skipped, 5);
  assert.equal(result.backupPath, null);
  assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), beforeNames);
});

test('apply backs up exact bytes first, preserves records, marks only verification evidence, and is idempotent', (t) => {
  const document = mixedDocument();
  const fx = fixture(t, document);
  let observedBackupBeforeReplace = false;
  const first = quarantineOwnerConversationLedger({
    inputPath: fx.ledgerPath, since: '2026-10-14', dryRun: false, now: NOW,
    hooks: { beforeReplace({ backupPath }) {
      observedBackupBeforeReplace = fs.readFileSync(backupPath).equals(fx.bytes)
        && fs.readFileSync(fx.ledgerPath).equals(fx.bytes);
    } },
  });
  assert.equal(observedBackupBeforeReplace, true);
  assert.equal(first.applied, 3);
  assert.match(path.basename(first.backupPath), /\.backup-2026-10-14T18-00-00-000Z(?:-\d+)?$/);
  assert.equal(fs.readFileSync(first.backupPath).equals(fx.bytes), true);
  assert.equal(fs.statSync(first.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fx.ledgerPath).mode & 0o777, 0o640);
  const after = fx.read();
  assert.deepEqual(after.preservedRoot, document.preservedRoot);
  assert.equal(after.entries.length, document.entries.length);
  for (let index = 0; index < after.entries.length; index++) {
    const actual = after.entries[index];
    const original = document.entries[index];
    if (index < 3) {
      assert.equal(actual.provenance.generation_method, 'agent_note');
      assert.equal(actual.provenance.verification, true);
      assert.equal(actual.provenance.owner_evidence, false);
      assert.equal(actual.provenance.conversation_kind, 'verification');
      const withoutProvenance = ({ provenance, ...other }) => other;
      assert.deepEqual(withoutProvenance(actual), withoutProvenance(original));
      assert.deepEqual(actual.provenance.source_refs, original.provenance.source_refs);
      assert.deepEqual(actual.provenance.session_refs, original.provenance.session_refs);
    } else assert.deepEqual(actual, original);
  }
  const afterBytes = fs.readFileSync(fx.ledgerPath);
  const names = fs.readdirSync(fx.root).sort();
  const second = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, since: '2026-10-14', dryRun: false, now: NOW });
  assert.equal(second.applied, 0);
  assert.equal(second.exclusions, 0);
  assert.equal(second.alreadyExcluded, 3);
  assert.equal(second.backupPath, null);
  assert.equal(fs.readFileSync(fx.ledgerPath).equals(afterBytes), true);
  assert.deepEqual(fs.readdirSync(fx.root).sort(), names);
});

test('post-fix retrieval trial heads report exact matching ids without excluding a genuine morning brain request', (t) => {
  const trial = entry('rel_20261014T125830Z_e75f', {
    title: "For this post-fix check, try the resident's retrieval and memory in practice.",
    statement: "For this post-fix check, try the resident's retrieval and memory in practice.",
    evidence_note: 'Yup. Give it a go…',
    provenance: { generation_method: 'owner_conversation',
      session_refs: ['owner-session:synthetic'], source_refs: ['coordination.message:synthetic'] },
  });
  const owner = entry('genuine-morning', { title: 'Morning discussion',
    statement: 'Check the brain. We discussed tickets and the guitar lesson this morning.',
    evidence_note: 'Can you find our earlier conversation in memory? The brain_search report is useful.' });
  const fx = fixture(t, { entries: [trial, owner] });
  const dryRun = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, since: '2026-10-14' });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.exclusions, 1);
  assert.deepEqual(dryRun.matchedIds, [trial.id]);
  assert.deepEqual(dryRun.exclusionReasons, { retrieval_meta_content: 1 });
  assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
  const applied = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false, since: '2026-10-14', now: NOW });
  assert.equal(applied.applied, 1);
  assert.deepEqual(fx.read().entries[1], owner);
  assert.equal(fx.read().entries[0].evidence_note, trial.evidence_note);
  const repeated = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false, since: '2026-10-14', now: NOW });
  assert.deepEqual(repeated.matchedIds, []);
  assert.deepEqual(repeated.exclusionReasons, {});
  assert.equal(repeated.alreadyExcluded, 1);
});

test('memory objects use their native store shape and session_id with inclusive semantic timestamps', (t) => {
  const object = {
    memory_id: 'mo-synthetic', statement: 'Synthetic ticket test', session_id: 'owner-verification-tickets',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: NOW, semantic_time: '2026-10-14T00:00:00.000Z',
    lifecycle_layer: 'durable', status: 'active', confidence: { score: 0.8 },
    provenance: { generation_method: 'owner_conversation', source_refs: ['msg-1'], session_refs: [] },
  };
  const fx = fixture(t, { schema: 'synthetic-memory-object-store', objects: [object], unrelated: 42 }, 'memory-objects.json');
  const result = quarantineOwnerConversationLedger({ inputPath: fx.root, dryRun: false, since: '2026-10-14', now: NOW });
  assert.equal(result.store, 'memory-objects');
  assert.equal(result.applied, 1);
  const after = fx.read();
  assert.equal(after.unrelated, 42);
  assert.equal(after.objects[0].memory_id, object.memory_id);
  assert.equal(after.objects[0].semantic_time, object.semantic_time);
  assert.equal(after.objects[0].provenance.generation_method, 'agent_note');
});

test('substantive facts retain nested evidence while verification notes and metadata identify their true source', (t) => {
  const variants = [
    { evidence: { grounding_note: 'Test your recall of Trey/Billy tickets.', evidence_links: ['message-1'], required: 'keep' } },
    { metadata: { chatId: 'home-verify-nested', required: 'keep' } },
    { metadata: { chat_id: 'ticket-verification', required: 'keep' } },
    { metadata: { sessionId: 'retrieval-test-nested', required: 'keep' } },
    { metadata: { session_id: 'owner-verify-nested', required: 'keep' } },
    { metadata: { sessionIds: ['owner-chat', 'home-verify-nested-array'], required: 'keep' } },
    { metadata: { session_refs: ['owner-chat', 'home-verify-nested-refs'], required: 'keep' } },
    { metadata: { verification: true, required: 'keep' } },
    { evidence: { grounding_note: 'Recorded the owner quote.', evidence_links: ['chat:home-verify-linked:message-1'], required: 'keep' } },
  ];
  const objects = variants.map((variant, index) => ({
    memory_id: `mo-nested-${index}`, statement: 'Melissa bought Trey/Billy tickets through Ticketmaster for Divided Sky in Worcester.',
    session_id: 'ordinary-owner-chat', created_at: NOW, updated_at: NOW,
    provenance: { generation_method: 'owner_conversation', session_refs: ['owner-chat'], source_refs: ['message-1'], required: 'keep' },
    reuse_count: 7, confidence: { score: 0.8 }, ...variant,
  }));
  const document = { objects, required: 'keep' };
  const fx = fixture(t, document, 'memory-objects.json');
  const dryRun = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: true, since: '2026-10-14' });
  assert.equal(dryRun.exclusions, variants.length);
  assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
  const result = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false, since: '2026-10-14', now: NOW });
  assert.equal(result.applied, variants.length);
  assert.equal(fs.readFileSync(result.backupPath).equals(fx.bytes), true);
  const after = fx.read();
  assert.equal(after.required, document.required);
  for (let index = 0; index < objects.length; index++) {
    const original = objects[index];
    const actual = after.objects[index];
    const withoutProvenance = ({ provenance, ...other }) => other;
    assert.deepEqual(withoutProvenance(actual), withoutProvenance(original));
    assert.equal(actual.provenance.required, original.provenance.required);
    assert.deepEqual(actual.provenance.session_refs, original.provenance.session_refs);
    assert.deepEqual(actual.provenance.source_refs, original.provenance.source_refs);
    assert.equal(actual.provenance.generation_method, 'agent_note');
    assert.equal(actual.provenance.verification, true);
  }
});

test('brain directory with multiple supported stores requires an explicit ledger file', (t) => {
  const fx = fixture(t, { entries: [entry('one')] });
  fs.writeFileSync(path.join(fx.root, 'memory-objects.json'), '{"objects":[]}');
  assert.throws(() => quarantineOwnerConversationLedger({ inputPath: fx.root, dryRun: false }), /ambiguous/i);
  assert.equal(fs.readdirSync(fx.root).length, 2);
});

test('malformed JSON, malformed store records, and unsupported shapes fail before backup or mutation', (t) => {
  for (const document of ['{"entries":[SYNTHETIC_PRIVATE_CONTENT}', { entries: [null] }, { entries: [{}] }, { nodes: [] }, { entries: [], objects: [] }]) {
    const fx = fixture(t, document);
    assert.throws(() => quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false }), /invalid|unsupported|ambiguous/i);
    assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
    assert.equal(fs.readdirSync(fx.root).length, 1);
  }
});

test('a candidate lacking a valid timestamp fails closed when --since is supplied', (t) => {
  const fx = fixture(t, { entries: [entry('no-time', { updatedAt: 'bad', createdAt: undefined })] });
  assert.throws(() => quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false, since: '2026-10-14' }), /timestamp/i);
  assert.equal(fs.readdirSync(fx.root).length, 1);
});

test('source changes after backup abort replacement and preserve concurrent bytes', (t) => {
  const fx = fixture(t, { entries: [entry('one', { metadata: { verification: true } })] });
  const concurrent = '{"entries":[],"concurrent":"preserve"}\n';
  assert.throws(() => quarantineOwnerConversationLedger({
    inputPath: fx.ledgerPath, dryRun: false, now: NOW,
    hooks: { beforeReplace() { fs.writeFileSync(fx.ledgerPath, concurrent); } },
  }), /changed/i);
  assert.equal(fs.readFileSync(fx.ledgerPath, 'utf8'), concurrent);
  const backups = fs.readdirSync(fx.root).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(fx.root, backups[0])).equals(fx.bytes), true);
  assert.equal(fs.readdirSync(fx.root).some(name => name.includes('.tmp-')), false);
});

test('an existing writer lock prevents apply without backup or mutation', (t) => {
  const fx = fixture(t, { entries: [entry('one', { metadata: { verification: true } })] });
  const release = lockfile.lockSync(fx.ledgerPath);
  try {
    assert.throws(() => quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false }), /lock/i);
    assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
    assert.equal(fs.readdirSync(fx.root).filter(name => name.includes('.backup-')).length, 0);
  } finally { release(); }
});

test('backup timestamp collisions create an exclusive sibling and never overwrite a backup', (t) => {
  const fx = fixture(t, { entries: [entry('one', { metadata: { verification: true } })] });
  const collision = `${fx.ledgerPath}.backup-2026-10-14T18-00-00-000Z`;
  fs.writeFileSync(collision, 'preserved-backup');
  const result = quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false, now: NOW });
  assert.equal(fs.readFileSync(collision, 'utf8'), 'preserved-backup');
  assert.notEqual(result.backupPath, collision);
  assert.equal(fs.readFileSync(result.backupPath).equals(fx.bytes), true);
});

test('symbolic link ledger files and hard links fail without touching their targets', (t) => {
  const fx = fixture(t, { entries: [entry('one', { metadata: { verification: true } })] });
  const linked = path.join(fx.root, 'linked.json');
  fs.symlinkSync(fx.ledgerPath, linked);
  assert.throws(() => quarantineOwnerConversationLedger({ inputPath: linked, dryRun: false }), /regular|symbolic/i);
  fs.unlinkSync(linked);
  fs.linkSync(fx.ledgerPath, linked);
  assert.throws(() => quarantineOwnerConversationLedger({ inputPath: fx.ledgerPath, dryRun: false }), /hard|link/i);
  assert.equal(fs.readFileSync(fx.ledgerPath).equals(fx.bytes), true);
});

test('CLI defaults to dry-run, emits counts without private content, and redacts parse errors', (t) => {
  const marker = 'SYNTHETIC_PRIVATE_CONTENT_DO_NOT_PRINT';
  const fx = fixture(t, { entries: [entry('one', { statement: marker, metadata: { verification: true } })] });
  const run = spawnSync(process.execPath, [script, fx.ledgerPath, '--since', '2026-10-14'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).dryRun, true);
  assert.equal(JSON.parse(run.stdout).exclusions, 1);
  assert.equal(`${run.stdout}${run.stderr}`.includes(marker), false);
  fs.writeFileSync(fx.ledgerPath, `{"entries":[${marker}}`);
  const malformed = spawnSync(process.execPath, [script, fx.ledgerPath, '--apply'], { encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /invalid/i);
  assert.equal(`${malformed.stdout}${malformed.stderr}`.includes(marker), false);
});

test('arguments validate --since and require unambiguous flags and a single path', () => {
  assert.deepEqual(parseArguments(['/synthetic/ledger.json', '--dry-run', '--since', '2026-10-14']), {
    inputPath: '/synthetic/ledger.json', dryRun: true, since: '2026-10-14',
  });
  assert.equal(parseArguments(['/synthetic/ledger.json', '--apply']).dryRun, false);
  for (const args of [[], ['a', 'b'], ['a', '--apply', '--dry-run'], ['a', '--since'], ['a', '--since', '2026-02-30'], ['a', '--oops']]) {
    assert.throws(() => parseArguments(args), /usage|since|flag|path|argument/i);
  }
});

test('marked stores remain loadable by the existing relationship and memory-object readers', (t) => {
  const relationship = fixture(t, { schema: 'home23.relationship-ledger.v1', entries: [entry('loadable', { verification: true })] });
  const memory = fixture(t, { objects: [{
    memory_id: 'mo-loadable', title: 'Synthetic note', statement: 'Synthetic memory',
    session_id: 'retrieval-test-load', created_at: NOW, updated_at: NOW,
    provenance: { generation_method: 'owner_conversation', session_refs: [], source_refs: [] },
  }] }, 'memory-objects.json');
  assert.equal(quarantineOwnerConversationLedger({ inputPath: relationship.ledgerPath, dryRun: false }).applied, 1);
  assert.equal(quarantineOwnerConversationLedger({ inputPath: memory.ledgerPath, dryRun: false }).applied, 1);
  const reader = `
    const { pathToFileURL } = await import('node:url');
    const { RelationshipLedger } = await import(pathToFileURL(process.argv[3]).href);
    const { MemoryObjectStore } = await import(pathToFileURL(process.argv[4]).href);
    const ledger = new RelationshipLedger(process.argv[1]);
    const store = new MemoryObjectStore(process.argv[2]);
    if (ledger.getEntry('loadable')?.provenance.generation_method !== 'agent_note'
      || store.getObject('mo-loadable')?.provenance.generation_method !== 'agent_note') process.exit(9);
    console.log('readers loaded both marked records');
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', reader,
    relationship.root, memory.root, path.resolve(__dirname, '../../src/agent/relationship-ledger.ts'),
    path.resolve(__dirname, '../../src/agent/memory-objects.ts')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /readers loaded both marked records/);
});
