/**
 * Migration: attach doneWhen to every goal, purge audit-tumor.
 * Schema version 0 → 1.
 *
 * planMigration(goalsMap) — returns a plan object without applying.
 * applyMigration(plan, goalsSystem, opts) — performs the plan.
 */

const AUDIT_TUMOR_PATTERNS = [
  /verified output evidence schema/i,
  /state snapshot capture at handoff/i,
  /modify audit script to enumerate/i,
  /four.column evidence table/i,
  /map agent internal state variables/i,
  /data integrity feedback loop/i,
  /checkpoint receipt schema/i,
  /canonical taxonomy schema/i,
  /enforcement boundary for incomplete cycles/i,
  /audit schema with four parallel/i,
  /audit conclusions treating zero as negative evidence/i,
];

const KOAN_PATTERNS = [
  /what strange loop/i,
  /liminal pauses/i,
  /metaphysics of named days/i,
  /spoon that remembers/i,
  /artifacts.*alternative identities/i,
  /human temporal perception/i,
];

const CRDT_PATTERN = /cross.layer crdt unification|crdt.*belief revision|crdt unification/i;

function matchAny(desc, patterns) {
  return patterns.some(re => re.test(desc || ''));
}

function crdtDoneWhen() {
  return {
    version: 1,
    criteria: [
      { type: 'file_exists', path: 'crdt-unification-sketch.md' },
      {
        type: 'judged',
        criterion: 'The file outputs/crdt-unification-sketch.md contains sections on protocol predicates, version history, and belief revision, with at least one worked example linking them.',
        judgeModel: 'gpt-5-mini',
        judgedAt: null, judgedVerdict: null
      }
    ]
  };
}

function planMigration(goalsMap) {
  const plan = { archive: [], retrofit: [], llmRetrofit: [], skipped: [] };
  for (const goal of goalsMap.values()) {
    if (goal.status && goal.status !== 'active') {
      plan.skipped.push({ id: goal.id, reason: `status=${goal.status}` });
      continue;
    }
    const desc = goal.description || '';
    if (matchAny(desc, AUDIT_TUMOR_PATTERNS)) {
      plan.archive.push({ id: goal.id, reason: 'audit-tumor-purge-2026-04-17', description: desc });
      continue;
    }
    if (matchAny(desc, KOAN_PATTERNS)) {
      plan.archive.push({ id: goal.id, reason: 'no-concrete-done-when', description: desc });
      continue;
    }
    if (CRDT_PATTERN.test(desc)) {
      plan.retrofit.push({ id: goal.id, doneWhen: crdtDoneWhen(), description: desc });
      continue;
    }
    plan.llmRetrofit.push({ id: goal.id, description: desc });
  }
  return plan;
}

module.exports = {
  planMigration,
  AUDIT_TUMOR_PATTERNS,
  KOAN_PATTERNS,
  CRDT_PATTERN,
  crdtDoneWhen,
};
