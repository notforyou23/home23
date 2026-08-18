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
      'drill-lifecycle', 'drill-workers-count', 'drill-sources-count',
      'drill-brain-count', 'drill-writeups-count', 'drill-files-count',
      'drill-goal', 'drill-phases', 'drill-workers'
    ]) {
      expect(html).to.include(`id="${id}"`);
    }
    expect(app).to.include('renderDrillStatus');
    expect(app).to.include('phase.writeups');
    expect(app).to.include('worker.turns');
    expect(app).to.include("lifecycle === 'completed'");
    expect(app).to.include('canSteer = status.canSteer === true');
  });

  it('shows the Brain tape with provenance from the disk-backed status route', () => {
    const html = read('index.html');
    const app = read('app.js');
    expect(html).to.include('id="drill-brain-ledger"');
    expect(app).to.include("replaceLedger('drill-brain-ledger'");
    expect(app).to.include('entry.brain');
    expect(app).to.include('phaseNumber');
    expect(app).to.include("this.api('/api/drill/status')");
  });

  it('provides a read-only file list with metadata and bounded preview', () => {
    const html = read('index.html');
    const app = read('app.js');
    const server = fs.readFileSync(serverFile, 'utf8');
    expect(html).to.include('id="drill-files-ledger"');
    expect(html).to.include('id="drill-file-preview"');
    expect(app).to.include('/api/drill/file?path=');
    expect(app).to.include('previewDrillFile');
    expect(server).to.include("app.get('/api/drill/files'");
    expect(server).to.include("app.get('/api/drill/file'");
    expect(server).to.include("app.get('/api/drill/tape'");
  });

  it('shows all research fetch paths in one Sources ledger', () => {
    const html = read('index.html');
    const app = read('app.js');
    expect(html).to.include('id="drill-sources-ledger"');
    expect(app).to.include("replaceLedger('drill-sources-ledger'");
    expect(app).to.include('entry.urls');
    expect(app).to.include('entry.workerId');
  });

  it('uses the existing files and tapes — no UI-only Brain or Sources store', () => {
    const app = read('app.js');
    const server = fs.readFileSync(serverFile, 'utf8');
    expect(server).to.include("readJsonlTape(runPath, 'stream'");
    expect(server).to.include("readJsonlTape(runPath, 'sources'");
    expect(app).to.not.include('localStorage.setItem(\'cosmo.drill');
    expect(app).to.not.include('/api/drill/delete');
    expect(app).to.not.include('/api/drill/write');
  });

  it('preserves Query, Brains, Map, and Intelligence while making Watch the desk', () => {
    const html = read('index.html');
    for (const id of ['view-watch', 'view-query', 'view-brains', 'view-map', 'view-intelligence']) {
      expect(html).to.include(`id="${id}"`);
    }
  });

  it('reflows the desk and evidence columns on narrower screens', () => {
    const css = read('styles.css');
    expect(css).to.include('.drill-pulse');
    expect(css).to.include('.drill-evidence-grid');
    expect(css).to.match(/@media \(max-width: 1200px\)[\s\S]*\.drill-pulse/);
    expect(css).to.match(/@media \(max-width: 900px\)[\s\S]*\.drill-evidence-grid/);
  });
});
