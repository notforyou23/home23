const { expect } = require('chai');
const { planMigration, AUDIT_TUMOR_PATTERNS } =
  require('../../src/goals/migrations/2026-04-17-done-when');

function mkGoals(list) {
  const goals = new Map();
  list.forEach((g, i) => goals.set(`goal_${i + 1}`, { id: `goal_${i + 1}`, status: 'active', ...g }));
  return goals;
}

describe('migration planner', () => {
  it('marks audit-tumor goals for archive', () => {
    const goals = mkGoals([
      { description: 'Design a verified output evidence schema with five columns' },
      { description: 'Draft a canonical taxonomy schema for agent outputs' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(2);
    expect(plan.archive[0].reason).to.equal('audit-tumor-purge-2026-04-17');
  });

  it('marks philosophical-koan goals for archive with no-concrete reason', () => {
    const goals = mkGoals([
      { description: 'What strange loop have you walked today?' },
      { description: 'Phenomenology of liminal pauses in thought' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(2);
    expect(plan.archive[0].reason).to.equal('no-concrete-done-when');
  });

  it('preserves goal 6 (CRDT) with a retrofit plan', () => {
    const goals = mkGoals([
      { description: 'Cross-Layer CRDT Unification of protocol predicates, version history, and belief revision' }
    ]);
    const plan = planMigration(goals);
    expect(plan.retrofit).to.have.length(1);
    expect(plan.retrofit[0].doneWhen.criteria).to.have.length.greaterThan(0);
  });

  it('falls through to llm-retrofit for uncategorized goals', () => {
    const goals = mkGoals([
      { description: 'Study ion channel cognitive capacity across species' }
    ]);
    const plan = planMigration(goals);
    expect(plan.llmRetrofit).to.have.length(1);
  });

  it('skips completed and archived goals', () => {
    const goals = mkGoals([
      { description: 'Design a canonical taxonomy schema', status: 'completed' },
      { description: 'What strange loop', status: 'archived' }
    ]);
    const plan = planMigration(goals);
    expect(plan.archive).to.have.length(0);
    expect(plan.retrofit).to.have.length(0);
    expect(plan.llmRetrofit).to.have.length(0);
    expect(plan.skipped).to.have.length(2);
  });
});

describe('migration applier', () => {
  const { applyMigration } = require('../../src/goals/migrations/2026-04-17-done-when');

  function fakeSystem() {
    const archived = [];
    const retrofitted = [];
    return {
      archiveGoal(id, reason) { archived.push({ id, reason }); return true; },
      _applyRetrofit(id, dw) { retrofitted.push({ id, dw }); return true; },
      _archived: archived,
      _retrofitted: retrofitted,
    };
  }

  it('applies archive and retrofit actions; skips llmRetrofit when no llmClient', async () => {
    const sys = fakeSystem();
    const plan = {
      archive: [{ id: 'g1', reason: 'audit-tumor-purge-2026-04-17' }],
      retrofit: [{ id: 'g6', doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] } }],
      llmRetrofit: [{ id: 'g99', description: 'pending' }],
      skipped: []
    };
    const receipt = await applyMigration(plan, sys, {});
    expect(sys._archived).to.have.length(1);
    expect(sys._retrofitted).to.have.length(1);
    expect(receipt.applied.archive).to.equal(1);
    expect(receipt.applied.retrofit).to.equal(1);
    expect(receipt.applied.llmRetrofit).to.equal(0);
    expect(receipt.deferred.llmRetrofit).to.equal(1);
  });

  it('calls llmClient per llmRetrofit goal and archives when LLM declines', async () => {
    const sys = fakeSystem();
    const llmClient = {
      async chat({ messages }) {
        const userText = messages.find(m => m.role === 'user').content;
        if (userText.includes('pending')) return { content: JSON.stringify({ decline: true, reason: 'no concrete termination' }) };
        return { content: JSON.stringify({ doneWhen: { version: 1, criteria: [{ type: 'file_exists', path: 'x.md' }] } }) };
      }
    };
    const plan = {
      archive: [], retrofit: [],
      llmRetrofit: [
        { id: 'g99', description: 'pending forever' },
        { id: 'g100', description: 'ship the sketch' }
      ],
      skipped: []
    };
    const receipt = await applyMigration(plan, sys, { llmClient });
    expect(sys._archived.find(a => a.id === 'g99')).to.exist;
    expect(sys._retrofitted.find(r => r.id === 'g100')).to.exist;
    expect(receipt.applied.llmRetrofit).to.equal(1);
    expect(receipt.applied.archive).to.equal(1);
  });
});
