import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgendaStore } = require('../../../engine/src/cognition/agenda-store.js');

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'home23-agenda-'));
  try {
    return fn(new AgendaStore({
      brainDir: dir,
      logger: { info() {}, warn() {}, error() {} },
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('agenda policy rejects theory cards that only borrow operational words', () => {
  withStore((store) => {
    assert.equal(store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: "Check whether the autobiographical reasoning work on 'mother at seventeen' has an explicit stance on resource-expenditure-as-evidence that could constrain or inform the health bridge design.",
      topicTags: ['autobiographical-reasoning', 'health-bridge'],
    }), null);

    assert.equal(store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Resolve whether the security architecture thinking (goal_217 controls, adversarial robustness) and the phenomenological investigation are parallel investigations or aspects of the same underlying concern.',
      topicTags: ['home23', 'architecture', 'security'],
    }), null);

    assert.equal(store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Audit what was cut in the memory regression from ~34k to ~30.5k nodes — ask jtr what triggered the prune and whether anything important was lost.',
      topicTags: ['home23', 'memory'],
    }), null);
  });
});

test('agenda policy keeps bounded operational investigations', () => {
  withStore((store) => {
    const fieldReport = store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Investigate the 182-second field report cycle — it was unusually long and may indicate a slow partition or stalled agent.',
      topicTags: ['fleet', 'cron', 'performance'],
    });
    assert.ok(fieldReport);

    const recent = store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: "Investigate why RECENT.md hasn't auto-generated in 9 days — is the generation trigger present but failing silently, or is the trigger condition no longer being met?",
      topicTags: ['operational', 'recent.md', 'meta-infrastructure'],
    });
    assert.ok(recent);

    const fallback = store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Verify whether the synthesis report failure for cross-cutting sections is reproducible — if "All fallbacks exhausted" is consistent, it is a specific infrastructure bug.',
      topicTags: ['synthesis-failure', 'fallback-exhaustion', 'infrastructure'],
    });
    assert.ok(fallback);

    const counts = store.counts();
    assert.equal(counts.total, 3);
    assert.equal(counts.stale, 0);
    assert.equal(counts.candidate + counts.surfaced, 3);
  });
});

test('agenda policy keeps bounded Good Life regulator cards', () => {
  withStore((store) => {
    const rec = store.add({
      sourceSignal: 'good-life',
      kind: 'idea',
      content: 'Diagnose Good Life repair drift using instances/jerry/brain/good-life-state.json, instances/jerry/brain/good-life-ledger.jsonl, and engine logs; restore verified Home23 engine evidence.',
      topicTags: ['good-life', 'good-life:repair'],
    });

    assert.ok(rec);
    assert.equal(rec.sourceSignal, 'good-life');
  });
});

test('agenda policy caps the surfaced working set', () => {
  withStore((store) => {
    for (const content of [
      'Investigate the 182-second field report cycle — it was unusually long and may indicate a slow partition or stalled agent.',
      "Investigate why RECENT.md hasn't auto-generated in 9 days — is the generation trigger present but failing silently?",
      'Verify whether the synthesis report failure is reproducible — "All fallbacks exhausted" appears consistently.',
      'Check status of the single disabled cron agent — was it intentional or a failure?',
      'Verify pressure log at ~/.pressure_log.jsonl — confirm whether it is actively written and what data shape it has.',
      'Investigate whether brain-housekeeping crossed its 12-second action threshold in cron history.',
    ]) {
      assert.ok(store.add({ sourceSignal: 'novelty', kind: 'question', content, topicTags: ['ops'] }));
    }

    assert.ok(store.counts().surfaced <= 5);
    assert.equal(store.counts().candidate, 0);
  });
});

test('agenda surface dedupes related RECENT.md work', () => {
  withStore((store) => {
    assert.ok(store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: "Investigate why RECENT.md hasn't auto-generated in 9 days — is the generation trigger present but failing silently?",
      topicTags: ['operational', 'recent.md'],
    }));
    assert.ok(store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Check RECENT.md at the filesystem level — is it actually frozen or just not yet processed by the brain-housekeeping pipeline?',
      topicTags: ['recent-md', 'ingestion'],
    }));

    assert.equal(store.counts().surfaced, 1);
    assert.equal(store.counts().candidate, 0);
    assert.equal(store.counts().stale, 1);
  });
});

test('agenda groups each multi-topic record once so group counts match visible rows', () => {
  withStore((store) => {
    const record = store.add({
      sourceSignal: 'novelty',
      kind: 'question',
      content: 'Investigate why the live dashboard reports a stale resident while its engine pulse remains healthy.',
      topicTags: ['dashboard', 'runtime', 'presence'],
    });
    assert.ok(record);

    const groups = store.groupedByTopic({ status: ['candidate', 'surfaced'] });
    const visible = groups.flatMap((group) => group.records);
    assert.equal(visible.filter((item) => item.id === record.id).length, 1);
    assert.equal(groups.reduce((sum, group) => sum + group.count, 0), visible.length);
    assert.equal(groups.find((group) => group.records.some((item) => item.id === record.id))?.topic, 'dashboard');
  });
});
