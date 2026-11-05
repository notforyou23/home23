# Fix 1.3 — graceful-shutdown honesty in cosmo23 engine (structured saveState result, re-entrancy lock, bounded shutdown save, conditional markCleanShutdown)

## Target current state

BUG CHAIN (all line refs verified by reading the CURRENT worktree, which already contains the concurrent crash-recovery fix — lines shifted +60 vs the task brief):

1. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js:8087 — `async saveState() {` has NO re-entrancy lock (`grep _saveStatePromise` → zero hits in this file) and returns nothing on every path:
   - :8148-8154 guard refusal is a bare return:
     ```
            if (existingNodes > totalNodes) {
              this.logger.warn('Preventing overwrite of merged state (cycle <= 1 only)', { ... });
              return; // Don't save, preserve the merged state
            }
     ```
   - :8200-8202 errors are swallowed:
     ```
          } catch (error) {
            this.logger.error('Save failed', { error: error.message });
          }
     ```
   Callers cannot distinguish saved / refused / failed.

2. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js:9121-9172 — stop() shutdown branch saves and unconditionally marks clean:
   ```
       if (this.shutdownHandler) {
         ...
         await this.saveState();          // outcome discarded (9166)
         await this.telemetry.cleanup();  // unbounded, between save and marker (9167)
         await this.crashRecovery.markCleanShutdown();  // ALWAYS (9168)
   ```

3. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/graceful-shutdown-handler.js:194-208 — shutdown() Step 1 awaits `this.orchestrator.stop()` (which already saved + marked clean, see #2), then Step 2 saves AGAIN and Step 3 marks clean AGAIN unconditionally:
   ```
         // Step 2: Save final state
         this.logger.info('[GracefulShutdown] Dumping final state...');
         await this.dumpState();

         // Step 3: Mark clean shutdown (for crash recovery)
         this.logger.info('[GracefulShutdown] Marking clean shutdown...');
         if (this.orchestrator.crashRecovery) {
           await this.orchestrator.crashRecovery.markCleanShutdown();
         }
   ```

4. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/graceful-shutdown-handler.js:249-261 — dumpState() discards the saveState outcome:
   ```
         await this.orchestrator.saveState();
         this.logger.info('[GracefulShutdown] State dumped successfully');
   ```

Net effect: a refused or failed final save still writes the `.clean_shutdown` marker, so the next boot skips crash recovery and trusts a state file that was never written — the engine continues as if the brain persisted when it did not.

DONOR (already fixed): /Users/jtr/_JTR23_/release/home23/engine/src/core/graceful-shutdown-handler.js:200-222 (shutdownStateHandled/shutdownStateResult/shutdownCleanMarked + dirty-on-failure), :263-287 (dumpState returns structured result); /Users/jtr/_JTR23_/release/home23/engine/src/core/orchestrator.js:7201-7213 (_saveStatePromise lock), :8498-8566 (hasDurableStateArtifact + saveStateForShutdown bounded save: 60s default, 15s bounded grace when joining an in-progress save with a durable artifact), :8467-8496 (cleanupTelemetryForShutdown 5s bound), :8616-8636 (stop() records outcome, marks clean only on success).

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a)+(b) Wrap saveState in a _saveStatePromise re-entrancy lock; rename the existing body to _saveStateUnlocked. Concurrent callers join the in-flight save and receive the same structured result.

### Anchor
```
  async saveState() {
    // Save evaluation metrics
    if (this.evaluation) {
      await this.evaluation.save();
    }
```

### Code
```js
  async saveState() {
    if (this._saveStatePromise) {
      this.logger?.warn?.('💾 State save already in progress — joining existing save');
      return this._saveStatePromise;
    }

    this._saveStatePromise = this._saveStateUnlocked();
    try {
      return await this._saveStatePromise;
    } finally {
      this._saveStatePromise = null;
    }
  }

  async _saveStateUnlocked() {
    // Save evaluation metrics
    if (this.evaluation) {
      await this.evaluation.save();
    }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a) Guard refusal returns the structured result per contract #1 (reason 'catastrophic_node_drop') instead of a bare `return;`. Also records this.lastSaveResult for observability.

### Anchor
```
          if (existingNodes > totalNodes) {
            this.logger.warn('Preventing overwrite of merged state (cycle <= 1 only)', {
              currentNodes: totalNodes,
              existingNodes,
              cycle: this.cycleCount
            });
            return; // Don't save, preserve the merged state
          }
```

### Code
```js
          if (existingNodes > totalNodes) {
            this.logger.warn('⚠️ REFUSING STATE SAVE — preventing overwrite of merged state (cycle <= 1 only)', {
              currentNodes: totalNodes,
              existingNodes,
              cycle: this.cycleCount
            });
            this.lastSaveResult = {
              saved: false,
              reason: 'catastrophic_node_drop',
              currentNodes: totalNodes,
              existingNodes,
              cycle: this.cycleCount,
            };
            return this.lastSaveResult; // Don't save, preserve the merged state
          }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(a) Success and error paths return structured results per contract #1. persistResearchState itself is untouched — the wrapping is around it. NOTE: the anchor's line between `});` and `} catch` is exactly six spaces (trailing whitespace in the current file). The `saved:true` return must stay the LAST statement of the try block so Fix 1.2's brain-snapshot write (contract #2) can be inserted before it.

### Anchor
```
      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });
      
    } catch (error) {
      this.logger.error('Save failed', { error: error.message });
    }
  }
```

### Code
```js
      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });

      this.lastSaveResult = {
        saved: true,
        reason: null,
        currentNodes: totalNodes,
        existingNodes: null,
        cycle: this.cycleCount,
      };
      return this.lastSaveResult;

    } catch (error) {
      this.logger.error('Save failed', { error: error.message });
      this.lastSaveResult = {
        saved: false,
        reason: `save_error:${error.message}`,
        currentNodes: state.memory?.nodes?.length || 0,
        existingNodes: null,
        cycle: this.cycleCount,
      };
      return this.lastSaveResult;
    }
  }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(d) Port the donor's bounded shutdown-save trio (donor orchestrator.js:8467-8566): cleanupTelemetryForShutdown (5s bound), hasDurableStateArtifact, and saveStateForShutdown (60s default bound; 15s bounded grace when joining an in-progress save that already has a durable state artifact). Insert this block immediately BEFORE `async stop() {`. Uses module-scope `fs` (fs.promises) and `path`, both already imported.

### Anchor
```
  async stop() {
    this.logger.info('Stopping GPT-5.2 system...');
```

### Code
```js
  async cleanupTelemetryForShutdown() {
    if (!this.telemetry || typeof this.telemetry.cleanup !== 'function') return;

    const timeoutMs = this.config.shutdownTelemetryTimeoutMs || 5000;
    let timeoutId = null;
    const cleanupPromise = this.telemetry.cleanup()
      .then(() => ({ status: 'ok' }))
      .catch(error => ({ status: 'error', error }));

    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });

    const result = await Promise.race([cleanupPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    if (result.status === 'timeout') {
      this.logger.warn('⚠️ [Telemetry] Cleanup timed out during shutdown; continuing', { timeoutMs });
      cleanupPromise.catch(() => {});
      return;
    }

    if (result.status === 'error') {
      this.logger.warn('⚠️ [Telemetry] Cleanup failed during shutdown; continuing', {
        error: result.error?.message || String(result.error),
      });
    }
  }

  async hasDurableStateArtifact() {
    const candidates = [
      path.join(this.logsDir, 'state.json.gz'),
      path.join(this.logsDir, 'state.json'),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return true;
      } catch {}
    }
    return false;
  }

  async saveStateForShutdown() {
    const defaultTimeoutMs = this.config.shutdownSaveTimeoutMs || 60000;
    const saveAlreadyInProgress = Boolean(this._saveStatePromise);
    let durableStateBeforeWait = false;
    let timeoutMs = defaultTimeoutMs;

    if (saveAlreadyInProgress) {
      durableStateBeforeWait = await this.hasDurableStateArtifact();
      if (durableStateBeforeWait) {
        const inProgressTimeoutMs = Number(this.config.shutdownInProgressSaveTimeoutMs ?? 15000);
        timeoutMs = Math.min(defaultTimeoutMs, Math.max(1, inProgressTimeoutMs));
        this.logger.warn('💾 Shutdown joining in-progress state save with bounded grace', {
          timeoutMs,
          defaultTimeoutMs,
          hasDurableState: true,
        });
      }
    }

    let timeoutId = null;
    const savePromise = this.saveState()
      .then(result => ({ status: 'ok', result }))
      .catch(error => ({ status: 'error', error }));

    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    });

    const outcome = await Promise.race([savePromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);

    if (outcome.status === 'ok') {
      return outcome.result || { saved: true, reason: null, currentNodes: null, existingNodes: null };
    }

    if (outcome.status === 'error') {
      this.logger.error('❌ Shutdown state save failed', {
        error: outcome.error?.message || String(outcome.error),
      });
      return { saved: false, reason: 'shutdown_save_failed', currentNodes: null, existingNodes: null };
    }

    const hasDurableState = durableStateBeforeWait || await this.hasDurableStateArtifact();
    this.logger.warn('⚠️ Shutdown state save timed out', {
      timeoutMs,
      hasDurableState,
      saveAlreadyInProgress,
    });
    savePromise.catch(() => {});

    if (hasDurableState) {
      return { saved: 'existing', reason: 'shutdown_save_timeout_existing_state', currentNodes: null, existingNodes: null };
    }
    return { saved: false, reason: 'shutdown_save_timeout_no_state', currentNodes: null, existingNodes: null };
  }

  async stop() {
    this.logger.info('Stopping GPT-5.2 system...');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

(c)+(d) stop() shutdown branch: single bounded save, record shutdownStateHandled/shutdownStateResult for the handler, mark clean ONLY when saved === true (contract #5), bounded telemetry cleanup moved AFTER the marker decision so a telemetry hang can no longer block the clean marker after a good save.

### Anchor
```
    // Phase A: Use graceful shutdown handler if available
    if (this.shutdownHandler) {
      // Shutdown handler will save state, cleanup resources, etc.
      // Don't call process.exit here - let handler do it
      // For manual stop (not signal), just save state
      await this.saveState();
      await this.telemetry.cleanup();
      await this.crashRecovery.markCleanShutdown();
    } else {
      // Fallback to original behavior
      await this.saveState();
    }
```

### Code
```js
    // Phase A: Use graceful shutdown handler if available
    if (this.shutdownHandler) {
      // Shutdown handler will cleanup resources and exit — don't process.exit here.
      // Save exactly once (bounded), record the outcome for the handler, and only
      // mark the crash-recovery marker clean when the save is CONFIRMED.
      const saveResult = await this.saveStateForShutdown();
      this.shutdownStateHandled = true;
      this.shutdownStateResult = saveResult;
      if (saveResult?.saved === true) {
        await this.crashRecovery.markCleanShutdown();
        this.shutdownCleanMarked = true;
      } else {
        this.logger.warn('⚠️ Shutdown state save was not confirmed; leaving crash recovery marker dirty', {
          saved: saveResult?.saved ?? null,
          reason: saveResult?.reason || null,
        });
      }
      await this.cleanupTelemetryForShutdown();
    } else {
      // Fallback to original behavior
      await this.saveState();
    }
```

## CHANGE: cosmo23/engine/src/core/graceful-shutdown-handler.js

(c) shutdown() Steps 2-3: skip the second save when orchestrator.stop() already handled it (shutdownStateHandled/shutdownStateResult), and mark clean ONLY when result.saved === true — loud warning + dirty marker otherwise (contract #5).

### Anchor
```
      // Step 2: Save final state
      this.logger.info('[GracefulShutdown] Dumping final state...');
      await this.dumpState();

      // Step 3: Mark clean shutdown (for crash recovery)
      this.logger.info('[GracefulShutdown] Marking clean shutdown...');
      if (this.orchestrator.crashRecovery) {
        await this.orchestrator.crashRecovery.markCleanShutdown();
      }
```

### Code
```js
      // Step 2: Save final state unless orchestrator.stop() already handled it.
      let dumpResult = this.orchestrator.shutdownStateResult || null;
      if (this.orchestrator.shutdownStateHandled) {
        this.logger.info('[GracefulShutdown] Final state already handled by orchestrator stop', {
          saved: dumpResult?.saved ?? null,
          reason: dumpResult?.reason || null,
        });
      } else {
        this.logger.info('[GracefulShutdown] Dumping final state...');
        dumpResult = await this.dumpState();
      }

      // Step 3: Mark clean shutdown (for crash recovery) ONLY when the final
      // save is confirmed (saved === true). A refused, failed, or timed-out
      // save leaves the shutdown DIRTY so the next boot runs crash recovery
      // and re-hydrates the brain from the durable sidecars.
      if (dumpResult?.saved !== true) {
        this.logger.warn('[GracefulShutdown] ⚠️ Final state was NOT saved — leaving shutdown DIRTY for crash recovery', {
          saved: dumpResult?.saved ?? null,
          reason: dumpResult?.reason || null,
        });
      } else if (this.orchestrator.shutdownCleanMarked) {
        this.logger.info('[GracefulShutdown] Clean shutdown already marked by orchestrator stop');
      } else if (this.orchestrator.crashRecovery) {
        this.logger.info('[GracefulShutdown] Marking clean shutdown...');
        await this.orchestrator.crashRecovery.markCleanShutdown();
      }
```

## CHANGE: cosmo23/engine/src/core/graceful-shutdown-handler.js

(c) dumpState() captures and returns the structured saveState result instead of discarding it. Legacy compat: `result || { saved: true }` keeps old-style void saveState marking clean. Real exceptions still re-throw into the error-exit path (exit 1, marker dirty).

### Anchor
```
  async dumpState() {
    try {
      if (this.orchestrator && typeof this.orchestrator.saveState === 'function') {
        await this.orchestrator.saveState();
        this.logger.info('[GracefulShutdown] State dumped successfully');
      } else {
        this.logger.warn('[GracefulShutdown] No saveState method available');
      }
    } catch (error) {
      this.logger.error('[GracefulShutdown] Failed to dump state', { error: error.message });
      throw error; // Re-throw to trigger error shutdown
    }
  }
```

### Code
```js
  async dumpState() {
    try {
      if (this.orchestrator && typeof this.orchestrator.saveState === 'function') {
        const result = await this.orchestrator.saveState();
        if (result && result.saved !== true) {
          this.logger.warn('[GracefulShutdown] State dump was not confirmed by persistence layer', {
            saved: result.saved ?? null,
            reason: result.reason || null,
            currentNodes: result.currentNodes ?? null,
            existingNodes: result.existingNodes ?? null,
          });
          return result;
        }
        this.logger.info('[GracefulShutdown] State dumped successfully');
        return result || { saved: true };
      } else {
        this.logger.warn('[GracefulShutdown] No saveState method available');
        return { saved: false, reason: 'saveState_unavailable' };
      }
    } catch (error) {
      this.logger.error('[GracefulShutdown] Failed to dump state', { error: error.message });
      throw error; // Re-throw to trigger error shutdown
    }
  }
```

## CHANGE: package.json

Register the new test in the cosmo23 node --test chain (contract #7). String replacement inside the "test" script value.

### Anchor
```
tests/cosmo23/package-test-registration.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/package-test-registration.test.cjs tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the enforced exactly-once registration list.

### Anchor
```
    'tests/cosmo23/cross-brain-readonly.test.cjs',
```

### Code
```js
    'tests/cosmo23/cross-brain-readonly.test.cjs',
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
```

## TEST FILE: tests/cosmo23/graceful-shutdown-honesty.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { GracefulShutdownHandler } = require('../../cosmo23/engine/src/core/graceful-shutdown-handler');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function stubProcessExit(t) {
  const original = process.exit;
  const codes = [];
  process.exit = (code) => { codes.push(code ?? 0); };
  t.after(() => { process.exit = original; });
  return codes;
}

function makeFakeOrchestrator(saveResult) {
  const calls = { saveState: 0, markCleanShutdown: 0, stop: 0 };
  return {
    calls,
    async stop() { calls.stop += 1; },
    async saveState() {
      calls.saveState += 1;
      return saveResult;
    },
    crashRecovery: {
      async markCleanShutdown() { calls.markCleanShutdown += 1; },
    },
  };
}

test('shutdown does NOT mark clean when saveState reports saved:false', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: false,
    reason: 'catastrophic_node_drop',
    currentNodes: 0,
    existingNodes: 65000,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 0, 'refused save must leave shutdown dirty');
  assert.deepEqual(exitCodes, [0]);
  assert.equal(handler.shutdownComplete, true);
});

test('shutdown DOES mark clean when saveState reports saved:true', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: true,
    reason: null,
    currentNodes: 65000,
    existingNodes: null,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not save again or mark clean when stop() already handled a refused save', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: false, reason: 'shutdown_save_timeout_no_state' };
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.stop, 1);
  assert.equal(orchestrator.calls.saveState, 0, 'handler must not save a second time after stop() handled state');
  assert.equal(orchestrator.calls.markCleanShutdown, 0);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not re-mark clean when stop() already marked it', async (t) => {
  stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.calls.markCleanShutdown += 1; // stop() wrote the marker itself
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: true, reason: null };
    orchestrator.shutdownCleanMarked = true;
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 0);
  assert.equal(orchestrator.calls.markCleanShutdown, 1, 'clean marker written exactly once');
});

test('concurrent saveState calls coalesce into one underlying save', async () => {
  let underlyingSaves = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = {
    logger: quietLogger,
    _saveStatePromise: null,
    async _saveStateUnlocked() {
      underlyingSaves += 1;
      await gate;
      return { saved: true, reason: null, currentNodes: 42, existingNodes: null };
    },
  };

  const first = Orchestrator.prototype.saveState.call(fake);
  const second = Orchestrator.prototype.saveState.call(fake);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(underlyingSaves, 1, 'two concurrent saveState calls must produce one underlying save');
  assert.equal(a, b, 'joined save returns the same result object');
  assert.equal(a.saved, true);

  const third = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(underlyingSaves, 2, 'lock releases after the save completes');
  assert.equal(third.saved, true);
});

test('saveStateForShutdown bounds a hung in-progress save and never fakes saved:true', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-save-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json.gz'), 'durable');

  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 60000, shutdownInProgressSaveTimeoutMs: 40 },
    _saveStatePromise: new Promise(() => {}),
    saveState: () => new Promise(() => {}),
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, 'existing');
  assert.equal(result.reason, 'shutdown_save_timeout_existing_state');
  assert.notEqual(result.saved, true, 'timeout with durable state must not report a confirmed save');
});

test('saveStateForShutdown surfaces save errors as saved:false', async () => {
  const fake = {
    logger: quietLogger,
    logsDir: path.join(os.tmpdir(), 'cosmo23-shutdown-missing-' + process.pid),
    config: {},
    _saveStatePromise: null,
    saveState: async () => { throw new Error('disk full'); },
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, false);
  assert.equal(result.reason, 'shutdown_save_failed');
});

```

## API NOTES

CONCURRENT-EDIT WARNING: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js is being modified in this worktree RIGHT NOW by the crash-recovery fix (contract #6 — restoreFromPersistence/buildCheckpointState already present, uncommitted; the file shifted +60 lines during my analysis). Apply all changes by exact anchor text, never by line number. My anchors do not textually overlap that fix's regions and were re-verified against the post-edit file.

Donor-vs-target divergences (intentional):
1. Strictness: the donor handler treats only `saved === false` as dirty, so its `saved:'existing'` timeout result still marks clean. The cosmo23 port requires `saved === true` (contract #5), so 'existing' leaves the marker dirty. That is safe and composes with contract #6: dirty marker → crash detected → restoreFromPersistence() → loadState() always hydrates from durable sidecars; a checkpoint is only a scalar overlay.
2. Donor's guard uses brain-persistence-guard + lastSaveResult with extra fields; cosmo23 keeps its existing cycle<=1 merged-state guard but returns reason 'catastrophic_node_drop' per contract #1 canonical string, so Fix 1.2's stronger guard (if it lands in the same body) can reuse the identical refusal shape.
3. Donor stop() checks `saved === false` before marking clean; cosmo23 port checks `saved === true` (same contract-#5 reason as above).

Composition notes:
- persistResearchState (cosmo23/lib/memory-sidecar.js:181) is NOT modified — the structured result wraps around it inside _saveStateUnlocked's existing try/catch.
- The `saved:true` return must remain the LAST statement of the try block in _saveStateUnlocked; Fix 1.2's brain-snapshot.json write (contract #2) should be inserted immediately before it, best-effort (its own try/catch), and must not alter lastSaveResult.
- Return-type change is backward compatible: all 8 internal saveState() call sites in the cosmo23 orchestrator ignore the return value (verified by grep), and dumpState treats a legacy undefined result as `{ saved: true }`.
- Contract #1 edge: _saveStateUnlocked can still THROW if this.evaluation.save() or this.memory.exportGraph() fails (both run before the try block — same shape as the donor). dumpState re-throws such errors → handler error path → process.exit(1) with the marker left dirty, which is the honest outcome. Only guard refusals and persistence errors are guaranteed non-throwing structured returns.
- New config keys (all optional, defaulted, no config-file changes needed): shutdownSaveTimeoutMs=60000, shutdownInProgressSaveTimeoutMs=15000, shutdownTelemetryTimeoutMs=5000. Shutdown budget: hard-kill 180s > agent wait 150s; in the worst case (agents consume 150s) the 60s save bound is truncated by the 180s force-exit — process.exit(1) fires before markCleanShutdown, marker stays dirty, still honest.
- Telemetry ordering fix: old stop() ran unbounded telemetry.cleanup() BETWEEN the save and markCleanShutdown, so a telemetry hang could void a good save's clean marker; new order is save → mark (if confirmed) → bounded telemetry cleanup.
- Double-save fix: previously handler.shutdown() Step 1 → stop() saved+marked, then Steps 2-3 saved+marked again. Now stop() performs the single bounded save and records shutdownStateHandled/shutdownStateResult/shutdownCleanMarked; the handler honors them. The _saveStatePromise lock additionally coalesces a SIGINT landing mid-cycle-save (saveStateForShutdown detects in-flight saves via the lock and applies the 15s bounded grace only when a durable state.json[.gz] already exists).
- Tests: tests/cosmo23/graceful-shutdown-honesty.test.cjs follows repo conventions (node:test, node:assert/strict, .cjs, tmpdir + t.after cleanup, relative require of cosmo23 modules). Requiring the cosmo23 orchestrator standalone was verified to work (prints harmless dotenv noise from cosmo23/engine/.env). process.exit is stubbed/restored per-test because handler.shutdown() calls it on both paths. Registered in package.json's cosmo23 chain AND in package-test-registration.test.cjs's enforced list (both edits included in proposedChanges).
