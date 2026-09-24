'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const check = require('../../src/diagnostic/checks/crash-loops');

describe('crash-loop diagnostic', () => {
  let binDir;
  let originalPath;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-crash-loops-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function fakePm2(script) {
    const executable = path.join(binDir, 'pm2');
    fs.writeFileSync(executable, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  it('keeps the event loop responsive while PM2 is slow and reports restarts', async () => {
    fakePm2('sleep 1\nprintf \'[{"name":"home23-core","pm2_env":{"restart_time":6}},{"name":"other","pm2_env":{"restart_time":30}}]\'');

    const startedAt = Date.now();
    let timerAt;
    const timer = new Promise(resolve => setTimeout(() => {
      timerAt = Date.now();
      resolve();
    }, 20));

    const resultPromise = check.run({});
    await timer;
    assert.ok(timerAt - startedAt < 800, 'PM2 lookup blocked the event loop');

    const result = await resultPromise;
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.findings.map(finding => finding.code), ['pm2_restart_count_exceeded']);
    assert.strictEqual(result.findings[0].evidence.restartCount, 6);
  });

  it('returns the established error result when PM2 fails', async () => {
    fakePm2('echo unavailable >&2\nexit 7');

    const result = await check.run({});
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /pm2 jlist failed:/);
    assert.deepStrictEqual(result.findings, []);
  });
});
