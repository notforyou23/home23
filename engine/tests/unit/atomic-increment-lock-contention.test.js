const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FilesystemHelpers } = require('../../src/cluster/fs/helpers.js');

// Regression guard for the atomicIncrement lock bug found 2026-08-02.
//
// The original code hoisted `acquired` inside the try block and released the
// lock unconditionally from the catch. A caller that FAILED to acquire the
// lock therefore deleted the lock the winning caller was still holding —
// a failed contender destroying the winner's mutex, which silently breaks
// every mutual-exclusion guarantee built on atomicIncrement.
describe('FilesystemHelpers.atomicIncrement lock contention', () => {
  let dir;
  let helpers;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-increment-'));
    helpers = new FilesystemHelpers({ basePath: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the holder\'s lock intact when a contender cannot acquire it', async () => {
    const counterPath = path.join(dir, 'counter');
    const lockPath = `${counterPath}.lock`;

    const held = await helpers.tryAcquireLock(lockPath, { pid: 999999 });
    assert.strictEqual(held, true, 'test setup: holder must acquire the lock');

    await assert.rejects(
      () => helpers.atomicIncrement(counterPath, 1),
      /Failed to acquire counter lock/,
      'a contender that cannot acquire the lock must throw'
    );

    assert.strictEqual(
      fs.existsSync(lockPath),
      true,
      'the holder\'s lock must survive a failed contender'
    );
  });

  it('releases its own lock on success so the next caller can proceed', async () => {
    const counterPath = path.join(dir, 'counter');
    const lockPath = `${counterPath}.lock`;

    assert.strictEqual(await helpers.atomicIncrement(counterPath, 1), 1);
    assert.strictEqual(
      fs.existsSync(lockPath),
      false,
      'a successful increment must not leak its lock'
    );
    assert.strictEqual(await helpers.atomicIncrement(counterPath, 2), 3);
  });

  it('serializes concurrent increments without losing any', async () => {
    const counterPath = path.join(dir, 'counter');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => helpers.atomicIncrement(counterPath, 1))
    );

    assert.deepStrictEqual(
      [...results].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'every concurrent increment must observe a distinct value'
    );
  });
});
