'use strict';

/**
 * The control center is an operational interface into the run, its files,
 * and its Brain — not three short lists and a console.
 */

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../../../public');
const serverFile = path.join(__dirname, '../../../server/index.js');

function read(name) {
  return fs.readFileSync(path.join(publicDir, name), 'utf8');
}

describe('Expanded drill control center', () => {
  it('has one unique DOM id per control and inspector surface', () => {
    const html = read('index.html');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(ids.length).to.be.greaterThan(50);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('shows a run pulse, richer phases, workers, and durable live activity', () => {
    const html = read('index.html');
    const app = read('app.js');
    for (const id of [
      'pulse-workers', 'pulse-tape', 'pulse-sources', 'pulse-files', 'pulse-brain',
      'phase-list', 'worker-strip', 'drill-feed', 'drill-activity-panel'
    ]) {
      expect(html).to.include(`id="${id}"`);
    }
    expect(app).to.include('renderPulse');
    expect(app).to.include('renderLiveActivity');
    expect(app).to.include('phase.evidence?.streamed');
    expect(app).to.include('hidden-work close');
    expect(app).to.include('worker.turns');
    expect(app).to.include('stopButton.hidden = !running');
    expect(app).to.include('noteSubmit.disabled = !running');
    expect(app).to.include("drill.mode === 'done'");
  });

  it('makes the Brain tape filterable, searchable, inspectable, and pageable', () => {
    const html = read('index.html');
    const app = read('app.js');
    for (const kind of ['goal', 'phase', 'thought', 'harvest', 'offshoot', 'finding']) {
      expect(html).to.include(`data-stream-kind="${kind}"`);
    }
    for (const id of [
      'brain-stream-search', 'brain-kind-summary', 'finding-list',
      'brain-entry-detail', 'brain-load-more'
    ]) {
      expect(html).to.include(`id="${id}"`);
    }
    expect(app).to.include('renderBrainStream');
    expect(app).to.include('renderBrainEntryDetail');
    expect(app).to.include('/api/drill/tape?channel=stream');
    expect(app).to.include('entry.brain');
    expect(app).to.include('goalNumber');
    expect(app).to.include('phaseNumber');
  });

  it('provides a read-only file browser with search, kinds, metadata, and preview', () => {
    const html = read('index.html');
    const app = read('app.js');
    const server = fs.readFileSync(serverFile, 'utf8');
    for (const id of [
      'file-search', 'file-kind-filter', 'file-refresh-btn', 'file-summary',
      'writeup-list', 'writeup-viewer', 'writeup-viewer-body', 'file-viewer-meta'
    ]) {
      expect(html).to.include(`id="${id}"`);
    }
    expect(app).to.include("this.api('/api/drill/files?limit=1000&depth=12')");
    expect(app).to.include('/api/drill/file?path=');
    expect(app).to.include('The file browser is read-only');
    expect(server).to.include("app.get('/api/drill/files'");
    expect(server).to.include("app.get('/api/drill/file'");
    expect(server).to.include("app.get('/api/drill/tape'");
  });

  it('shows all research fetch paths in one Sources ledger', () => {
    const html = read('index.html');
    const app = read('app.js');
    for (const tool of ['web_search', 'run_command', 'coding_run', 'write_file']) {
      expect(html).to.include(`data-source-tool="${tool}"`);
    }
    expect(html).to.include('Curl, archives, forums, scripts, and coding runs');
    expect(app).to.include('renderSources');
    expect(app).to.include('/api/drill/tape?channel=sources');
    expect(app).to.include('source.urls');
    expect(app).to.include('source.workerId');
  });

  it('uses the existing files and tapes — no UI-only Brain or Sources store', () => {
    const app = read('app.js');
    expect(app).to.include('outputs/stream.jsonl');
    expect(app).to.include('outputs/sources.jsonl');
    expect(app).to.include('payload.stream');
    expect(app).to.include('payload?.sources');
    expect(app).to.not.include('localStorage.setItem(\'cosmo.drill');
    expect(app).to.not.include('/api/drill/delete');
    expect(app).to.not.include('/api/drill/write');
  });

  it('reflows the operational view and inspector on narrower screens', () => {
    const css = read('styles.css');
    expect(css).to.include('[hidden] { display: none !important; }');
    expect(css).to.include('.drill-pulse-grid');
    expect(css).to.include('.drill-operations-grid');
    expect(css).to.match(/\.drill-operations-grid > \.drill-goal-panel[\s\S]*grid-area: auto/);
    expect(css).to.include('.drill-inspector-panel');
    expect(css).to.include('.inspector-split');
    expect(css).to.match(/@media \(max-width: 1220px\)[\s\S]*\.drill-operations-grid/);
    expect(css).to.match(/@media \(max-width: 900px\)[\s\S]*\.inspector-split/);
    expect(css).to.match(/@media \(max-width: 560px\)[\s\S]*\.drill-pulse-grid/);
  });

  it('has a self-contained favicon and no cosmetic favicon request', () => {
    const html = read('index.html');
    expect(html).to.include('<link rel="icon" href="data:image/svg+xml');
  });
});
