import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentConverter, PYTHON_FORMATS } = require('../../../engine/src/ingestion/document-converter');
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder');

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

// Vision OCR resolves the configured model's provider; tests pin a
// credentialed OpenAI target so health does not depend on this machine.
const openaiTarget = (model = 'gpt-4o-mini') => ({
  model, provider: 'openai', api: 'openai', baseURL: 'https://api.openai.com/v1',
  apiKey: 'test-key', credential: 'test-key', hasCredentials: true, listed: false,
});
const visionOk = { logger: silentLogger, visionResolver: () => openaiTarget(), visionCall: async () => 'ocr text' };

const ALL_MODULES = [...new Set(Object.values(PYTHON_FORMATS).flatMap(spec => spec.modules))];

function probeOutput({ markitdown = true, missing = [] } = {}) {
  return JSON.stringify({
    python: '3.12.4',
    markitdown,
    error: markitdown ? null : "ModuleNotFoundError: No module named 'markitdown'",
    modules: Object.fromEntries(ALL_MODULES.map(m => [m, !missing.includes(m)])),
  });
}

// A stand-in "python": answers the health probe (-c ...) with canned JSON
// and converts by sleeping, then printing markdown. No real python needed.
function stubPython(t, { convertSleepSeconds = 0, probe = probeOutput(), convertStderr = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-converter-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'python-stub');
  fs.writeFileSync(path.join(dir, 'probe.json'), probe);
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then',
    `  cat "${path.join(dir, 'probe.json')}"`,
    '  exit 0',
    'fi',
    `sleep ${convertSleepSeconds}`,
    ...(convertStderr ? [`echo "${convertStderr}" >&2`, 'exit 1'] : ['echo "# converted"']),
    '',
  ].join('\n'), { mode: 0o755 });
  const doc = path.join(dir, 'report.pdf');
  fs.writeFileSync(doc, 'pdf bytes');
  return { dir, script, doc };
}

test('the converter never uses a synchronous child process', () => {
  const source = fs.readFileSync(new URL('../../../engine/src/ingestion/document-converter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFileSync|execSync|spawnSync/);
});

test('a slow conversion leaves the event loop free', async (t) => {
  const { script, doc } = stubPython(t, { convertSleepSeconds: 1 });
  const converter = new DocumentConverter({ ...visionOk, pythonPath: script });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    const result = await converter.convertDetailed(doc);
    assert.equal(result.ok, true);
    assert.match(result.text, /# converted/);
  } finally {
    clearInterval(timer);
  }
  // The old execFileSync path allowed zero ticks for the whole second.
  assert.ok(ticks >= 20, `expected the interval to keep firing, saw ${ticks} ticks`);
});

test('conversions run one at a time', async (t) => {
  const { script, doc } = stubPython(t);
  let active = 0;
  let maxActive = 0;
  const execFileImpl = (file, args, options, callback) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active -= 1;
      callback(null, args[0] === '-c' ? probeOutput() : '# converted\n', '');
    }, 30);
  };
  const converter = new DocumentConverter({ ...visionOk, pythonPath: script, execFileImpl });

  const results = await Promise.all([doc, doc, doc].map(file => converter.convertDetailed(file)));

  assert.equal(results.every(result => result.ok), true);
  assert.equal(maxActive, 1);
});

test('closing the converter cancels an in-flight conversion promptly and retryably', async (t) => {
  const { script, doc } = stubPython(t, { convertSleepSeconds: 5 });
  const converter = new DocumentConverter({ ...visionOk, pythonPath: script });
  await converter.checkHealth();

  const started = Date.now();
  const pending = converter.convertDetailed(doc);
  setTimeout(() => converter.close(), 100);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.status, 'conversion_aborted');
  assert.equal(result.retryable, true);
  assert.ok(Date.now() - started < 2000, 'cancellation must not wait for the child to finish');
  assert.equal((await converter.convertDetailed(doc)).status, 'conversion_aborted');
});

test('feeder shutdown closes the converter', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-close-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const feeder = new DocumentFeeder({
    memory: { embed: async () => null },
    config: { compiler: { enabled: false } },
    logger: silentLogger,
  });
  feeder._scanDirectory = async () => {};
  await feeder.start(runPath);
  let closed = 0;
  const close = feeder.converter.close.bind(feeder.converter);
  feeder.converter.close = () => { closed += 1; close(); };

  await feeder.shutdown();

  assert.equal(closed, 1);
});

test('the health probe is async, cached, and re-probes early while MarkItDown is missing', async (t) => {
  const { script } = stubPython(t);
  let probes = 0;
  let installed = false;
  let clock = 0;
  const execFileImpl = (file, args, options, callback) => {
    probes += 1;
    setImmediate(() => callback(null, probeOutput({ markitdown: installed }), ''));
  };
  const converter = new DocumentConverter({ ...visionOk, pythonPath: script, execFileImpl, now: () => clock });

  assert.equal(converter.available, false, 'reading availability never spawns');
  assert.equal(probes, 0);
  assert.equal((await converter.checkHealth()).state, 'unavailable');
  assert.equal((await converter.checkHealth()).state, 'unavailable');
  assert.equal(probes, 1, 'cached within the unavailable TTL');

  installed = true;
  clock += 61_000;
  assert.equal((await converter.checkHealth()).state, 'ready', 'installing MarkItDown needs no restart');
  assert.equal(converter.available, true);
  clock += 61_000;
  await converter.checkHealth();
  assert.equal(probes, 2, 'a working converter is cached longer');
  await converter.checkHealth({ force: true });
  assert.equal(probes, 3);
});

test('health reports ready, missing extras, missing PDF support, and a missing runtime', async (t) => {
  const ready = await new DocumentConverter({ ...visionOk, pythonPath: stubPython(t).script }).checkHealth();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.available, true);
  assert.equal(ready.python, '3.12.4');
  assert.equal(ready.runtime.source, 'config');
  assert.equal(ready.formats.docx, true);
  assert.deepEqual(ready.unavailableFormats, []);

  const extras = await new DocumentConverter({
    ...visionOk,
    pythonPath: stubPython(t, { probe: probeOutput({ missing: ['mammoth', 'pptx', 'openpyxl', 'xlrd', 'pydub'] }) }).script,
  }).checkHealth();
  assert.equal(extras.state, 'ready');
  assert.equal(extras.formats.pdf, true);
  assert.equal(extras.formats.docx, false);
  assert.deepEqual(extras.unavailableFormats, ['docx', 'pptx', 'xlsx', 'xls', 'audio']);
  assert.match(extras.remedy, /markitdown\[docx,pptx,xlsx,xls,audio-transcription\]/);

  const noPdf = await new DocumentConverter({
    ...visionOk,
    pythonPath: stubPython(t, { probe: probeOutput({ missing: ['pdfplumber'] }) }).script,
  }).checkHealth();
  assert.equal(noPdf.state, 'degraded');
  assert.match(noPdf.reason, /PDF support/);

  const missing = await new DocumentConverter({ ...visionOk, pythonPath: '/nonexistent/home23/python3' }).checkHealth();
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.available, false);
  assert.match(missing.reason, /python runtime not found/);
  assert.match(missing.remedy, /cli\/home23\.js init/);
});

test('a format whose extras are missing waits instead of failing, and so does a missing-module traceback', async (t) => {
  const { script, dir } = stubPython(t, { probe: probeOutput({ missing: ['mammoth'] }) });
  const converter = new DocumentConverter({ ...visionOk, pythonPath: script });
  const docx = path.join(dir, 'notes.docx');
  fs.writeFileSync(docx, 'docx bytes');

  const result = await converter.convertDetailed(docx);
  assert.equal(result.status, 'converter_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(result.needs, 'docx');
  assert.equal(converter.canConvertNow(docx), false);
  assert.equal(converter.canConvertNow(path.join(dir, 'report.pdf')), true);

  const traceback = stubPython(t, { convertStderr: 'markitdown._exceptions.MissingDependencyException: PdfConverter needs pdfminer' });
  const failing = new DocumentConverter({ ...visionOk, pythonPath: traceback.script });
  const pdf = await failing.convertDetailed(traceback.doc);
  assert.equal(pdf.status, 'converter_unavailable');
  assert.equal(pdf.retryable, true);
});

test('unsupported formats are named as such, and a disabled converter never spawns', async (t) => {
  let spawns = 0;
  const execFileImpl = (file, args, options, callback) => { spawns += 1; callback(null, probeOutput(), ''); };
  const { dir, script } = stubPython(t);
  const pages = path.join(dir, 'plan.pages');
  fs.writeFileSync(pages, 'pages bytes');

  const converter = new DocumentConverter({ ...visionOk, pythonPath: script, execFileImpl });
  const unsupported = await converter.convertDetailed(pages);
  assert.equal(unsupported.status, 'unsupported_format');
  assert.equal(unsupported.retryable, false);
  assert.match(unsupported.error, /\.pages/);
  assert.equal(spawns, 0);

  const disabled = new DocumentConverter({ ...visionOk, pythonPath: script, execFileImpl, enabled: false });
  const result = await disabled.convertDetailed(path.join(dir, 'report.pdf'));
  assert.equal(result.status, 'converter_disabled');
  assert.equal(result.retryable, true);
  assert.equal((await disabled.checkHealth()).state, 'disabled');
  assert.equal(disabled.canConvertNow(path.join(dir, 'report.pdf')), false);
  assert.equal(spawns, 0);
});
