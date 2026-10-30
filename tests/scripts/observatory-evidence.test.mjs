import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { computeStateHash } from '../../substrate/src/checkpoint.ts';
import { productRoleEnvironment } from '../../cli/lib/product-environment.js';
import { seedOutreachDeliveryId } from '../../src/substrate/operator-outreach.ts';

const sourceRoot = new URL('../../', import.meta.url);
const hash = line => createHash('sha256').update(line).digest('hex');
const jsonl = records => records.map(row => JSON.stringify(row)).join('\n')+'\n';
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'observatory-evidence-http-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'app'), resident = join(root, 'instances/milo'), stateDir = join(resident, 'substrate/seed-01');
  for (const dir of [stateDir, join(stateDir, 'checkpoints'), join(home, 'runtime'), join(root, 'cli/lib'), join(resident, 'brain'), join(root, 'config')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(resident, 'config.yaml'), 'substrate:\n  enabled: true\nagency:\n  enabled: false\nengine:\n  architecture:\n    cognitionMode: thinking_machine\n');
  writeFileSync(join(root, 'config/home.yaml'), 'agency:\n  enabled: true\n');
  writeFileSync(join(root, 'config/base-engine.yaml'), 'architecture:\n  cognitionMode: legacy_roles\n');
  const service = { name: 'shakedown-desk', executable: join(home, 'bin/node'), cwd: root, args: [join(root, 'external.js')], env: { ROLE_MARKER: 'continuation' }, stateRoots: [], startOnHomeStart: true };
  const state = { schema: 'home23.host.v2', homeRoot: home, profile: { name: 'milo' }, encoderRequired: false,
    ports: { coordination: 24010, engine: 24011, dashboard: 24012, mcp: 24013, bridge: 24014, evobrew: 24015, observatory: 24016 }, continuationServices: [service] };
  writeFileSync(join(home, '.home23-host.json'), JSON.stringify(state), { mode: 0o600 });
  const definition = (name, env, entry = 'engine/src/index.js') => ({ name, min_uptime: 100, script: relative(root, join(home, 'bin/node')), cwd: root, args: [join(root, entry)], env: productRoleEnvironment(home, env) });
  const apps = [definition('home23-milo', { HOME23_AGENT: 'milo' }), definition('home23-milo-seed', { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir, SEED_LOBE: '' }, 'substrate/bin/seed-runner.ts'),
    { name: service.name, min_uptime: 100, script: service.executable, cwd: service.cwd, args: service.args, env: productRoleEnvironment(home, service.env) }];
  writeFileSync(join(home, 'runtime/ecosystem.config.json'), JSON.stringify({ apps }), { mode: 0o600 });
  const observed = apps.map(app => ({ name: app.name, pid: 100, pm2_env: { ...app.env, min_uptime: app.min_uptime, pm_exec_path: resolve(app.cwd, app.script), pm_cwd: app.cwd, args: app.args, status: 'online' } }));
  // This is the actual guarded client's module boundary. It accepts jlist only,
  // records requests, and never imports a supervisor or invokes a process tool.
  writeFileSync(join(root, 'cli/lib/product-supervisor.js'), `import { appendFileSync } from 'node:fs';
export async function productSupervisorCommand(home, args) {
  if (home !== ${JSON.stringify(home)} || JSON.stringify(args) !== '["jlist"]') throw new Error('Unexpected control request');
  appendFileSync(${JSON.stringify(join(home, 'commands.log'))}, JSON.stringify(args)+'\\n');
  return { stdout: ${JSON.stringify(JSON.stringify(observed))} };
}\n`);
  return { home, root, resident, stateDir };
}
function writeSeed(f, { sparse = false } = {}) {
  const now = Date.now(), at = new Date(now - 2000).toISOString();
  const witness = { schema: 'home23.learning-decision.v1', decisionId: 'context:fixture-choice', scope: 'foreground.context', tags: ['operational', 'agency_status', 'automatic'], sourceRefs: ['surface:AGENCY_STATUS'], criterion: 'owner-value', observedAt: at };
  const lesson = { lessonId: 'lesson-owner', scope: 'foreground.context', tags: ['operational', 'agency_status', 'automatic'], excludes: ['requested'], sourceRefs: ['owner-feedback:fixture'], value: -0.25, basis: 'owner-feedback', authority: 'owner', criterion: 'owner-value', createdAt: at, active: true, corroborations: 0 };
  const development = { 'world.home23': { experience: { version: 1, decisions: [witness], lessons: [lesson], seenFeedbackIds: [], watermarks: {}, pendingFeedback: [] } } };
  const makeConcern = (id, dueAt) => ({ commitmentId: id, kind: 'resolve-prediction', cellId: 'world.home23', predictionId: id, claim: id === 'future' ? 'Future obligation' : 'Closed old question', confidence: 0.8, authority: 'concern.v1', formedAt: at, formedAtSeq: 1, dueAt, qAnchor: 0, anchorAt: at, status: 'open', crossings: 0 });
  const concern = { future: makeConcern('future', new Date(now + 10 * 3600_000).toISOString()), closed: makeConcern('closed', at) };
  const stateHash = computeStateHash({ cells: [], dispositions: {}, development, concern });
  let cursor = '', seq = 0; const lines = [];
  const append = (category, sourceRef, payload, timestamp = at) => { const line = JSON.stringify({ seq: ++seq, prevHash: cursor, category, sourceRef, payload, issuedAt: timestamp, ...(seq === 1 ? { stateHashAfter: stateHash } : {}) }); lines.push(line); cursor = hash(line); return cursor; };
  const anchor = append('checkpoint', 'checkpoint', {});
  const cp = { schema: 'home23.seed.checkpoint.v1', version: 3, checkpointId: 'ckpt_fixture_00000001', ledgerSeq: 1, ledgerCursor: anchor, stateHash, createdAt: at, cells: [], dispositions: {}, development, concern };
  append('lobe', 'lobe.fixture', { provider: 'old-provider', modelId: 'old-model', appliedDeltas: [{ delta: { claim: 'Earlier successful estimate' } }] });
  append('lobe', 'lobe.fixture', { provider: 'current-provider', modelId: 'current-model', error: 'Current authentication failure' }, new Date(now).toISOString());
  append('concern', 'concern.expiry', { commitmentId: 'closed', status: 'expired', reason: 'closed in fixture' });
  append('proposal', 'growth.pressure', { op: 'crystallize', targetCellIds: ['world.home23'] });
  const proposalSeq = seq;
  append('act', 'growth.operator-decision', { proposalSeq, operatorDecision: 'declined' });
  const ledger = join(f.stateDir, 'seed-ledger.jsonl');
  writeFileSync(ledger, ''); if (sparse) truncateSync(ledger, 64 * 1024 * 1024);
  appendFileSync(ledger, (sparse ? '\n' : '') + lines.join('\n') + '\n');
  writeFileSync(join(f.stateDir, 'checkpoints', cp.checkpointId+'.json'), JSON.stringify(cp));
  writeFileSync(join(f.stateDir, 'checkpoints/CHECKPOINT_INDEX.json'), JSON.stringify({ checkpoints: [{ checkpointId: cp.checkpointId, stateHash, ledgerSeq: 1 }] }));
  const ask = { idempotencyKey: 'old-ask', actSeq: 2, commitmentId: 'closed', message: 'Already closed old request', dispatchedAt: at };
  writeFileSync(join(f.stateDir, 'outbox.jsonl'), jsonl([ask]));
  writeFileSync(join(f.stateDir, 'operator-outreach.json'), JSON.stringify({ receipts: [{ deliveryId: seedOutreachDeliveryId(ask), actSeq: ask.actSeq, commitmentId: ask.commitmentId, status: 'committed', messageIds: ['canonical-message'], at }] }));
  writeFileSync(join(f.resident, 'substrate/conversation-stream.jsonl'), jsonl([{ ts: at, role: 'user', text: 'Keep machine details out of personal conversation <img src=x onerror="bad">' }]));
  const decision = { event_id: witness.decisionId, event_type: 'LearningDecisionObserved', actor: 'assembly', session_id: 'session-fixture', timestamp: at, payload: { ...witness, choice: 'omit', relevant: true, explicit: false,
    behavior: { kind: 'context-selection', surface: 'AGENCY_STATUS', component: 'routine-operational-status', description: 'Routine status' }, learning: { available: true, adjustment: -0.25, lessonIds: ['lesson-owner'] } } };
  const retrieval = { event_id: 'retrieval-fixture', event_type: 'RetrievalExecuted', actor: 'assembly', session_id: 'session-fixture', timestamp: at, payload: { learningDecisionIds: [witness.decisionId], surfaces_selected: [], surfaces_loaded: [], surface_delivery: [] } };
  const route = { event_id: 'route-fixture', event_type: 'MotorActionRouted', timestamp: at, payload: { routingVersion: 2, status: 'no_intent', reasonCode: 'no_intent', agendaId: 'agenda-fixture', turnId: 'turn-fixture' } };
  writeFileSync(join(f.resident, 'brain/event-ledger.jsonl'), jsonl([decision, retrieval, route]));
  return { cp, proposalSeq };
}
async function server(t, f, specs) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'substrate/bin/seed-observatory.ts'], { cwd: sourceRoot,
    env: { PATH: '/usr/bin:/bin', HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: f.root, OBSERVATORY_PORT: '0', OBSERVATORY_INDIVIDUALS: JSON.stringify(specs) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit'); const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  t.after(async () => { clearTimeout(timer); child.kill('SIGKILL'); await exited; });
  const port = await new Promise((resolvePort, reject) => { child.stdout.on('data', chunk => { const match = String(chunk).match(/on :(\d+)/); if (match) resolvePort(Number(match[1])); }); child.once('error', reject); child.once('exit', () => reject(new Error(`Observatory stopped: ${stderr}`))); });
  return `http://127.0.0.1:${port}`;
}
test('actual HTTP projection separates current failure, closed ask, future due, durable learning and runtime delivery', { timeout: 8000 }, async t => {
  const f = fixture(t); const { proposalSeq } = writeSeed(f);
  const base = await server(t, f, [{ name: 'milo-seed', stateDir: f.stateDir, note: '" data-bad="escaped' }, { name: 'unavailable', stateDir: join(f.home, 'missing') }]);
  const response = await fetch(base+'/api/terrarium'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json(), d = payload.individuals[0], missing = payload.individuals[1];
  assert.equal(d.lobe.status, 'failure'); assert.equal(d.lobe.model, 'current-model'); assert.match(d.proseHTML, /Current authentication failure/); assert.match(d.proseHTML, /Earlier successful estimate/);
  assert.match(d.proseHTML, /due in 10.0h/); assert.doesNotMatch(d.proseHTML, /-\d+s ago/);
  assert.equal(d.asks.length, 0); assert.equal(d.asksHistory[0].commitmentStatus, 'expired'); assert.doesNotMatch(d.proseHTML, /he reached for you/);
  assert.equal(d.learning.available, true); assert.equal(d.learning.lessons[0].value, -0.25); assert.deepEqual(d.learning.lessons[0].excludes, ['requested']);
  assert.equal(d.learning.choices[0].evidenceStatus, 'verified'); assert.equal(d.learning.choices[0].deliveryStatus, 'observed'); assert.equal(d.learning.choices[0].deliveredChars, 0);
  assert.equal(missing.learning.available, false); assert.match(missing.freshnessHTML, /checkpoint unavailable/); assert.match(missing.chipHTML, /ledger unavailable/);
  assert.equal(d.config.agency, 'disabled'); assert.equal(d.config.cognitionMode, 'thinking_machine'); assert.equal(d.routing.events[0].reasonCode, 'no_intent');
  assert.equal(d.growthRecords[0].status, 'declined'); assert.equal(d.growthRecords[0].seq, proposalSeq); assert.match(d.freshnessHTML, /cells are 5 ledger events behind/);
  assert.match(payload.vitalsHTML, /shakedown-desk/); assert.doesNotMatch(payload.vitalsHTML, /RUNTIME BINDING DIFFERS|pm2 unreadable/);
  const htmlResponse = await fetch(base+'/'); const html = await htmlResponse.text(); assert.equal(htmlResponse.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(html, /v2 migration|Teaching channel|\d+ of 20/); assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/); assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /setHTML\(card, '\.growthmount', ni.growthHTML\)/); assert.match(html, /setHTML\(card, '\.freshnessmount', ni.freshnessHTML\)/); assert.match(html, /Projection stale:/); assert.match(html, /details\[open\]/);
  // Change a runtime source between polls. Every derived fragment is recomposed.
  appendFileSync(join(f.resident, 'brain/event-ledger.jsonl'), jsonl([{ event_id: 'execution-next', event_type: 'ExecutionOutcomeObserved', timestamp: new Date().toISOString(), payload: { schema: 'home23.execution-outcome.v1', status: 'failed', executionAttempted: true, taskOutcomeVerified: false, executionId: 'execution-next', detail: 'Actual tool boundary failure' } }]));
  const updated = await (await fetch(base+'/api/terrarium')).json(); assert.equal(updated.individuals[0].routing.events[0].status, 'failed'); assert.match(updated.individuals[0].proseHTML, /Actual tool boundary failure/); assert.ok(updated.boardHTML);
  assert.ok(readFileSync(join(f.home, 'commands.log'), 'utf8').split('\n').filter(Boolean).every(line => line === '["jlist"]'));
});
test('actual HTTP projection reads a bounded recent window from a large ledger and invalidates a changed checkpoint', { timeout: 8000 }, async t => {
  const f = fixture(t); const { cp } = writeSeed(f, { sparse: true });
  const base = await server(t, f, [{ name: 'milo-seed', stateDir: f.stateDir }]);
  const data = (await (await fetch(base+'/api/terrarium')).json()).individuals[0];
  assert.ok(data.freshness.ledgerCoverage.totalBytes > 64 * 1024 * 1024); assert.ok(data.freshness.ledgerCoverage.bytesRead <= 512 * 1024); assert.equal(data.freshness.ledgerCoverage.fullHistory, false);
  assert.equal(data.learning.available, true); assert.match(data.provHTML, /recent window only/);
  writeFileSync(join(f.stateDir, 'checkpoints', cp.checkpointId+'.json'), JSON.stringify({ ...cp, stateHash: 'invalid' }));
  const changed = (await (await fetch(base+'/api/terrarium')).json()).individuals[0];
  assert.equal(changed.freshness.checkpointAvailable, false); assert.equal(changed.learning.available, false); assert.deepEqual(changed.cells, []); assert.match(changed.freshnessHTML, /state hash or index binding mismatch/);
});

test('the actual browser poll updates only the provenance footer and preserves nested deadlines and open evidence', { timeout: 8000 }, async t => {
  const { runInNewContext } = await import('node:vm');
  const f = fixture(t); writeSeed(f);
  const base = await server(t, f, [{ name: 'milo-seed', stateDir: f.stateDir }]);
  const initial = await (await fetch(base + '/api/terrarium')).json();
  const html = await (await fetch(base + '/')).text();
  const cardHTML = html.match(/<section class="card" data-card="milo-seed">[\s\S]*?<\/section>/)?.[0];
  const client = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(cardHTML); assert.ok(client);

  // Parse the actual server card into ordered descendants. querySelector uses
  // DOM pre-order/first-match semantics, rather than independent selector maps.
  const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_whole, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);
  class Element {
    constructor(tag = 'div', text = '') { this.tag = tag; this.text = text; this.children = []; this.attrs = {}; }
    appendChild(child) { this.children.push(child); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    get dataset() { return { detailKey: this.attrs['data-detail-key'] }; }
    get classList() { return { contains: name => (this.attrs.class ?? '').split(/\s+/).includes(name), add() {}, remove() {} }; }
    set open(value) { if (value) this.attrs.open = ''; else delete this.attrs.open; }
    get open() { return Object.hasOwn(this.attrs, 'open'); }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this.text = ''; this.children = parseFragment(value).children; }
    addEventListener() {}
    matches(selector) {
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
      const attribute = selector.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attribute) return (!attribute[1] || this.tag === attribute[1]) && Object.hasOwn(this.attrs, attribute[2])
        && (attribute[3] === undefined || this.attrs[attribute[2]] === attribute[3]);
      return this.tag === selector;
    }
    querySelectorAll(selector) {
      const found = [];
      const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } };
      visit(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  function parseFragment(markup) {
    const root = new Element(), stack = [root];
    for (const token of markup.match(/<[^>]*>|[^<]+/g) ?? []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1).appendChild(new Element('#text', decode(token))); continue; }
      const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const node = new Element(tag);
      for (const attribute of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], decode(attribute[2] ?? ''));
      stack.at(-1).appendChild(node);
      if (!['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(node);
    }
    return root;
  }
  const document = parseFragment(cardHTML + '<div id="terrarium-data"></div><div id="drawer"></div><div id="connection-state"></div><div id="vitals-mount"></div><div id="board-mount"></div>');
  document.getElementById = id => document.querySelector('#' + id);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.createElement = tag => new Element(tag);
  document.getElementById('terrarium-data').textContent = JSON.stringify(initial);
  const card = document.querySelector('[data-card="milo-seed"]');
  const prose = card.querySelector('.prose'), due = prose.querySelector('.prov');
  const footer = card.children.find(child => child.classList.contains('prov'));
  assert.equal(due.tag, 'span'); assert.equal(footer.tag, 'div');
  assert.equal(card.querySelector('.prov'), due, 'a broad .prov selector must find the earlier nested deadline');
  const dueText = due.textContent, openEvidence = prose.querySelector('details');
  assert.match(dueText, /due in 10.0h/); assert.ok(openEvidence);
  const openKey = openEvidence.dataset.detailKey; openEvidence.open = true;
  const updatedCoverage = 'ledger window updated after the browser poll';
  const later = { ...initial, at: 'next-poll', individuals: initial.individuals.map(individual => ({ ...individual,
    provHTML: updatedCoverage, chipHTML: 'updated checkpoint chip', freshnessHTML: 'updated freshness evidence' })) };
  let poll;
  runInNewContext(client, { document, performance: { now: () => 0 }, requestAnimationFrame() {},
    setInterval(fn, interval) { assert.equal(interval, 5000); poll = fn; },
    fetch: async () => ({ ok: true, json: async () => later }), console });
  poll(); await new Promise(resolveDone => setImmediate(resolveDone));
  assert.equal(card.querySelector('.prose').querySelector('.prov').textContent, dueText, 'polling must not replace a commitment deadline with ledger coverage');
  assert.equal(footer.textContent, updatedCoverage, 'the card footer must receive the new ledger coverage');
  assert.equal(card.querySelector('.prose').querySelector(`details[data-detail-key="${openKey}"]`).open, true, 'open evidence survives prose refresh');
  assert.equal(card.querySelector('.chipmount').textContent, 'updated checkpoint chip');
  assert.equal(card.querySelector('.freshnessmount').textContent, 'updated freshness evidence');
  assert.match(document.getElementById('connection-state').textContent, /Projection updated next-poll/);
});

test('the actual browser poll refreshes checkpoint graph labels and associations even when cell IDs stay the same', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(new URL('../../substrate/bin/seed-observatory.ts', import.meta.url), 'utf8');
  const client = source.match(/const CLIENT_JS = String.raw`([\s\S]*?)\n`;/)?.[1]; assert.ok(client);
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.classList = { add() {}, remove() {}, contains() { return false; } }; }
    appendChild(child) { this.children.push(child); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key]; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text ?? ''; }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html ?? ''; }
    addEventListener() {}
    querySelectorAll() { return []; }
  }
  const cell = (id, gen, words) => ({ id, short: id, gen, words, pressure: .1, energy: .2, uncertainty: .3, state: [.1, .2], estimates: [], open: [], refs: [] });
  const first = { name: 'fixture', cells: [cell('a', 1, 'young'), cell('b', 2, 'calm')], assoc: [{ from: 'a', to: 'b', strength: .1 }], flows: [], maxGen: 2 };
  const later = { ...first, cells: [cell('a', 10, 'lived-in'), cell('b', 20, 'pressurized')], assoc: [{ from: 'a', to: 'b', strength: .8 }], maxGen: 20 };
  const mount = new Element(), card = new Element(), drawer = new Element(), status = new Element(), data = new Element();
  mount.setAttribute('data-body', 'fixture'); card.setAttribute('data-card', 'fixture'); data.textContent = JSON.stringify({ individuals: [first] });
  const fragments = new Map(); card.querySelector = selector => { if (!fragments.has(selector)) fragments.set(selector, new Element()); return fragments.get(selector); };
  const document = { createElementNS: (_ns, tag) => new Element(tag), createElement: tag => new Element(tag), getElementById: id => ({ 'terrarium-data': data, drawer, 'connection-state': status })[id],
    querySelectorAll: selector => selector === '[data-body]' ? [mount] : selector === '[data-card]' ? [card] : [], querySelector: () => null };
  let poll;
  runInNewContext(client, { document, performance: { now: () => 0 }, requestAnimationFrame() {}, setInterval(fn) { poll = fn; }, fetch: async () => ({ ok: true, json: async () => ({ individuals: [later], at: 'next-checkpoint' }) }), console });
  const all = node => [node, ...node.children.flatMap(all)];
  assert.ok(all(mount).some(node => node.tag === 'title' && /generation 1 ·/.test(node.textContent)));
  assert.ok(all(mount).some(node => node.tag === 'path' && node.attrs['stroke-width'] === '0.8'));
  poll(); await new Promise(resolveDone => setImmediate(resolveDone));
  assert.ok(all(mount).some(node => node.tag === 'title' && /generation 10 ·/.test(node.textContent)), 'graph title must advance with the checkpoint');
  assert.ok(all(mount).some(node => node.attrs.class === 'cellstate-svg' && node.textContent === 'lived-in'), 'computed graph labels must advance');
  assert.ok(all(mount).some(node => node.tag === 'path' && node.attrs['stroke-width'] === '2.2'), 'association evidence must advance');
});
