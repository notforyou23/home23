/**
 * Migration: attach doneWhen to every goal, purge audit-tumor.
 * Schema version 0 → 1.
 *
 * planMigration(goalsMap) — returns a plan object without applying.
 * applyMigration(plan, goalsSystem, opts) — performs the plan.
 */

const AUDIT_TUMOR_PATTERNS = [
  // From jerry's diagnosis (verbatim phrasings):
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

  // Tightened — catch LLM-paraphrased variants of the same self-audit patterns.
  // Scoped to Home23-internal audit targets (schema/script/enumeration/coroutine/
  // receipt/cognitive-state/memory-storage/capture-points). Does NOT match
  // external-subject research like "audit CRDT libraries against an invariant".
  /\baudit schema\b/i,
  /\baudit script\b/i,
  /\baudit coroutine\b/i,
  /audit.*\b(cognitive state|memory storage|existing conclusions|existing reports)\b/i,
  /audit.*\bcapture points\b/i,
  /audit.*\benumeration\b/i,
  /\baudit entries\b/i,
  /\bevidence schema\b/i,
  /\bcheckpoint receipt/i,
  /\bevidence taxonomy\b/i,
  /\bevidence marker/i,
  /\bpersistent artifact.*audit/i,
  /enforcement boundary.*audit/i,
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
        judgeModel: 'gpt-5.4-mini',
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

const { validateDoneWhen, validateDoneWhenResilient } = require('../done-when-gate');

async function askLlmForDoneWhen(description, llmClient) {
  const systemPrompt =
    'You produce a concrete, verifiable termination criterion for an AI-system research goal. ' +
    'Output ONLY JSON — either {"doneWhen": {"version": 1, "criteria": [ ... ]}} or ' +
    '{"decline": true, "reason": "<one sentence>"}. Allowed criterion types: file_exists, ' +
    'file_created_after, memory_node_tagged, memory_node_matches, output_count_since, judged. ' +
    'Prefer file_exists in outputs/. If the goal is too vague to have a concrete output, decline.';
  const userPrompt = `Goal: ${description}\n\nRespond with JSON only.`;

  // Support two client shapes: UnifiedClient-style generate({instructions, messages, ...})
  // and simple test-mock chat({messages}) that bundles system+user into messages.
  let content;
  try {
    if (typeof llmClient.generate === 'function') {
      const resp = await llmClient.generate({
        model: 'gpt-5.4-mini',
        instructions: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_completion_tokens: 400,
        reasoningEffort: 'low',
      });
      content = resp.content;
    } else if (typeof llmClient.chat === 'function') {
      const resp = await llmClient.chat({
        model: 'gpt-5.4-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: 400,
        temperature: 0.2,
      });
      content = resp.content;
    } else {
      return { decline: true, reason: 'llmClient has no generate or chat method' };
    }
  } catch (err) {
    return { decline: true, reason: `llm call failed: ${err.message}` };
  }

  try {
    const raw = (content || '').trim();
    // Strip potential code fences.
    const stripped = raw.replace(/^```(?:json)?\n?|```$/g, '').trim();
    const parsed = JSON.parse(stripped);
    return parsed;
  } catch (err) {
    return { decline: true, reason: `parse error: ${err.message}` };
  }
}

async function applyMigration(plan, goalsSystem, opts = {}) {
  const receipt = {
    startedAt: new Date().toISOString(),
    applied: { archive: 0, retrofit: 0, llmRetrofit: 0 },
    deferred: { llmRetrofit: 0 },
    actions: []
  };

  for (const a of plan.archive) {
    goalsSystem.archiveGoal(a.id, a.reason);
    receipt.applied.archive++;
    receipt.actions.push({ action: 'archive', ...a });
  }

  for (const r of plan.retrofit) {
    goalsSystem._applyRetrofit(r.id, r.doneWhen);
    receipt.applied.retrofit++;
    receipt.actions.push({ action: 'retrofit', id: r.id });
  }

  for (const item of plan.llmRetrofit) {
    if (!opts.llmClient) {
      receipt.deferred.llmRetrofit++;
      receipt.actions.push({ action: 'defer', id: item.id, reason: 'no llmClient' });
      continue;
    }
    const reply = await askLlmForDoneWhen(item.description, opts.llmClient);
    if (reply?.decline || !reply?.doneWhen) {
      goalsSystem.archiveGoal(item.id, `no-concrete-done-when (llm-decline: ${reply?.reason || 'unknown'})`);
      receipt.applied.archive++;
      receipt.actions.push({ action: 'archive-llm-decline', id: item.id, reason: reply?.reason });
      continue;
    }
    // Resilient validation: if ≥1 criterion is valid, keep those and drop
    // the invalid ones rather than throwing away the whole doneWhen to a
    // single LLM JSON hiccup.
    const v = validateDoneWhenResilient(reply.doneWhen);
    if (!v.valid) {
      goalsSystem.archiveGoal(item.id, `no-concrete-done-when (llm-invalid: ${v.reason})`);
      receipt.applied.archive++;
      receipt.actions.push({ action: 'archive-llm-invalid', id: item.id, reason: v.reason });
      continue;
    }
    goalsSystem._applyRetrofit(item.id, v.cleaned);
    receipt.applied.llmRetrofit++;
    receipt.actions.push({
      action: 'llm-retrofit',
      id: item.id,
      ...(v.dropped && v.dropped.length ? { droppedCriteria: v.dropped } : {})
    });
  }

  receipt.finishedAt = new Date().toISOString();
  return receipt;
}

module.exports = {
  planMigration,
  applyMigration,
  askLlmForDoneWhen,
  AUDIT_TUMOR_PATTERNS,
  KOAN_PATTERNS,
  CRDT_PATTERN,
  crdtDoneWhen,
};
