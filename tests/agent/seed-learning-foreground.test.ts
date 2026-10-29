import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleContext } from '../../src/agent/context-assembly.js';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { relationshipNoteTool } from '../../src/agent/tools/relationship.js';
import { SeedProcess } from '../../substrate/src/seed.js';
import { EventLedgerTailAdapter } from '../../substrate/src/adapters/event-ledger-tail.js';
import { readSeedLearning } from '../../src/substrate/learning-state.js';

test('foreground status selection changes after actual authenticated learning while pursuit context and history remain available', async t => {
  const root = mkdtempSync(join(tmpdir(), 'seed-foreground-learning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspacePath = join(root, 'instances', 'resident', 'workspace');
  const brainDir = join(root, 'instances', 'resident', 'brain');
  const agency = join(brainDir, 'agency');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(agency, { recursive: true });
  writeFileSync(join(agency, 'state.json'), JSON.stringify({ schema: 'home23.agency.state.v1',
    agent: 'resident', mode: 'dry_run', attention: { currentPursuitId: 'active', queueDepth: 2 } }));
  writeFileSync(join(agency, 'pursuits.jsonl'), JSON.stringify({ type: 'created', pursuit: {
    id: 'active', status: 'active', title: 'Optional operational digression', authorityLevel: 'L2', nextMove: 'advance_one_step',
  } }) + '\n');
  const seedDir = join(root, 'seed');
  let seed = SeedProcess.initialize(seedDir);
  const axis = (index: number) => Array.from({ length: 16 }, (_, i) => i === index ? 1 : 0);
  const semanticEmbed = (text: string) => /AGENCY:|WORKERS:|drawing your attention|interesting directions|agency pursuit|concrete progress/i.test(text) ? axis(0) : axis(1);
  const config = { workspacePath, brainDir, substrateStateDir: seedDir, enginePort: 0, sessionId: 'owner-chat',
    signal: new AbortController().signal, semanticEmbed,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }) };
  const events = new EventLedger(brainDir);
  const original = await assembleContext('Which directions are drawing your attention lately?', 'owner-chat', [], config, events);
  assert.ok(original.surfacesLoaded.includes('AGENCY'), 'a semantically relevant optional candidate is initially eligible');
  assert.ok(original.surfacesLoaded.includes('AGENCY_STATUS'));
  const choice = original.events.find(event => event.event_type === 'LearningDecisionObserved'
    && (event.payload.sourceRefs as string[]).includes('surface:AGENCY_STATUS'))!;
  const adapter = new EventLedgerTailAdapter({ sourcePath: join(brainDir, 'event-ledger.jsonl'),
    cursorDir: join(root, 'event-cursor'), fromEnd: false });
  for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
  seed.checkpoint();
  const statement = 'Keep routine machine status out of personal conversations unless I ask.';
  const ingress = { chatId: 'owner-chat', messageRef: 'owner:conduct-feedback', userText: statement };
  const relationshipLedger = new RelationshipLedger(brainDir, {
    validateCorrectionIngress: candidate => JSON.stringify(candidate) === JSON.stringify(ingress),
  });
  const taught = await relationshipNoteTool.execute({ type: 'attenuation', title: 'Routine machine status', statement,
    learning: { schema: 'home23.learning-feedback.v1', decisionId: choice.payload.decisionId,
      scope: 'foreground.context', direction: 'attenuate', tags: ['operational', 'agency', 'agency_status', 'automatic'],
      excludes: ['requested'], evidenceRefs: [ingress.messageRef], basis: 'owner-feedback' } },
  { chatId: ingress.chatId, seedStateDir: seedDir, authenticatedUserMessage: { chatId: ingress.chatId, messageRef: ingress.messageRef, text: statement }, relationshipLedger } as never);
  assert.equal(taught.is_error, undefined, taught.content);
  const teaching = new EventLedgerTailAdapter({ sourcePath: join(brainDir, 'relationship-ledger.events.jsonl'),
    sourceType: 'relationship-ledger', cursorDir: join(root, 'teaching-cursor'), fromEnd: false });
  for (const event of teaching.pullSync()) { seed.transition(event); teaching.commit(event.endOffset); }
  seed.checkpoint(); seed = SeedProcess.restore(seedDir);
  const learned = readSeedLearning(seedDir);
  assert.equal(learned.lessons.length, 1);
  const history = readFileSync(join(seedDir, 'seed-ledger.jsonl'), 'utf8');
  const query = 'What interesting directions are drawing your attention?';
  const actual = await assembleContext(query, 'owner-chat', [], config);
  const control = await assembleContext(query, 'owner-chat', [], { ...config,
    readLearning: () => ({ ...learned, lessons: [] }) });
  assert.ok(!actual.surfacesLoaded.includes('AGENCY_STATUS'), 'the learned contribution changes actual status selection');
  assert.ok(control.surfacesLoaded.includes('AGENCY_STATUS'), 'removing only learning restores the otherwise eligible status');
  assert.ok(actual.surfacesLoaded.includes('AGENCY'), 'status teaching preserves the substance of pursuits');
  assert.doesNotMatch(actual.block, /Stored planning queue depth: 2/);
  assert.match(control.block, /Stored planning queue depth: 2/);
  assert.match(actual.block, /Optional operational digression/);
  assert.match(control.block, /Optional operational digression/);
  const requested = await assembleContext('Show the agency pursuit and next move', 'owner-chat', [], config);
  assert.ok(requested.surfacesLoaded.includes('AGENCY'), 'a direct request remains eligible');
  assert.ok(requested.surfacesLoaded.includes('AGENCY_STATUS'), 'a direct request still admits routine status');
  const paraphrased = await assembleContext('What concrete progress have you made?', 'owner-chat', [], config);
  assert.ok(paraphrased.surfacesLoaded.includes('AGENCY'), 'a relevant direct result request needs no literal surface anchor');
  for (const query of ['Please show me your concrete progress so far', 'Summarize the concrete progress you have made']) {
    const polite = await assembleContext(query, 'owner-chat', [], config);
    assert.ok(polite.surfacesLoaded.includes('AGENCY'), 'politeness and paraphrase cannot turn a direct request into optional context');
  }
  assert.equal(readFileSync(join(seedDir, 'seed-ledger.jsonl'), 'utf8'), history, 'read-only probes preserve history exactly');

  // Positive teaching must also reach actual ranking, rather than becoming an
  // unused score. Keep the same competing context and recorded model behavior.
  const worker = join(root, 'instances', 'workers', 'systems');
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, 'worker.yaml'), 'kind: worker\nname: systems\nownerAgent: resident\nclass: ops\npurpose: Inspect host evidence.\nvisibleTo:\n  - resident\n');
  writeFileSync(join(workspacePath, 'REFERENCE.md'), 'A fixed competing reference.');
  const positiveConfig = { ...config, semanticEmbed: () => axis(0),
    triggeredSurfaces: [{ file: 'REFERENCE.md', label: 'REFERENCE', keywords: ['directions'], budget: 200 }] };
  const positiveQuery = 'Consider the meaningful directions that might be interesting for us to explore';
  const beforePositive = await assembleContext(positiveQuery, 'owner-chat', [], positiveConfig, events);
  assert.ok(beforePositive.surfacesLoaded.includes('WORKERS'), JSON.stringify(beforePositive.surfacesLoaded));
  assert.ok(beforePositive.block.indexOf('Relevant context (REFERENCE)') < beforePositive.block.indexOf('Relevant context (WORKERS)'));
  const workerChoice = beforePositive.events.find(event => event.event_type === 'LearningDecisionObserved'
    && (event.payload.tags as string[]).includes('workers'))!;
  for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
  seed.checkpoint();
  const praise = 'That was useful. Keep bringing that optional context when it is relevant.';
  const positiveRef = 'owner:positive-feedback';
  const positiveLedger = new RelationshipLedger(brainDir, { validateCorrectionIngress: candidate => candidate.messageRef === positiveRef && candidate.userText === praise });
  const reinforced = await relationshipNoteTool.execute({ type: 'correction', title: 'Useful optional context', statement: praise,
    learning: { schema: 'home23.learning-feedback.v1', decisionId: workerChoice.payload.decisionId,
      scope: 'foreground.context', direction: 'reinforce', tags: ['operational', 'workers', 'automatic'],
      evidenceRefs: [positiveRef], basis: 'owner-feedback' } },
  { chatId: 'owner-chat', seedStateDir: seedDir, authenticatedUserMessage: { chatId: 'owner-chat', messageRef: positiveRef, text: praise }, relationshipLedger: positiveLedger } as never);
  assert.equal(reinforced.is_error, undefined, reinforced.content);
  for (const event of teaching.pullSync()) { seed.transition(event); teaching.commit(event.endOffset); }
  seed.checkpoint();
  const positiveSnapshot = readSeedLearning(seedDir);
  const afterPositive = await assembleContext(positiveQuery, 'owner-chat', [], positiveConfig);
  const positiveControl = await assembleContext(positiveQuery, 'owner-chat', [], { ...positiveConfig,
    readLearning: () => ({ ...positiveSnapshot, lessons: positiveSnapshot.lessons.filter(lesson => !lesson.tags.includes('workers')) }) });
  assert.ok(afterPositive.block.indexOf('Relevant context (WORKERS)') < afterPositive.block.indexOf('Relevant context (REFERENCE)'),
    'a positive contribution changes actual context priority');
  assert.ok(positiveControl.block.indexOf('Relevant context (REFERENCE)') < positiveControl.block.indexOf('Relevant context (WORKERS)'),
    'removing only positive learning restores the old order');
});
