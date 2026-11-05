const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const {
  normalizeOutputsRelativePath,
  extractFileDeliverablesFromGoal,
  buildDeliverableSpecFromPath,
  isWritePathRecoveryTheme,
  isGoalAboutGoalTheme,
  isGoalTheatreTheme,
  shouldRejectGoalAboutGoal,
  collapseWritePathSwarm,
  pruneWritePathRecoverySwarm,
  coerceJsonFileContent,
  recoveryArtifactsPresent,
  enrichDoneWhenWithFileExists,
} = require('../../src/goals/deliverable-paths');
const { checkCriterion } = require('../../src/goals/done-when');

describe('deliverable-paths', () => {
  it('normalizes outputs/ prefixes and absolute outputs paths', () => {
    expect(normalizeOutputsRelativePath('outputs/recovery_report.json')).to.equal(
      'recovery_report.json'
    );
    expect(normalizeOutputsRelativePath('@outputs/recovery_status.json')).to.equal(
      'recovery_status.json'
    );
    expect(
      normalizeOutputsRelativePath(
        '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/outputs/recovery_report.json'
      )
    ).to.equal('recovery_report.json');
  });

  it('extracts file deliverables from doneWhen and description', () => {
    const paths = extractFileDeliverablesFromGoal({
      description: 'Create outputs/recovery_report.json and recovery_status.json',
      doneWhen: {
        mode: 'all',
        criteria: [{ type: 'file_exists', path: 'outputs/recovery_report.json' }],
      },
    });
    expect(paths).to.include('recovery_report.json');
    expect(paths).to.include('recovery_status.json');
  });

  it('builds PathResolver deliverable specs', () => {
    const spec = buildDeliverableSpecFromPath('outputs/recovery_report.json');
    expect(spec).to.deep.include({
      location: '@outputs/',
      filename: 'recovery_report.json',
      format: 'json',
      type: 'json',
    });
  });

  it('detects write-path recovery theme', () => {
    expect(
      isWritePathRecoveryTheme(
        'Inspect and fix the write_path stub in brain/index.js so writes persist'
      )
    ).to.equal(true);
    expect(isWritePathRecoveryTheme('Write a newsletter draft about sauna')).to.equal(false);
  });

  it('detects recovery_gate / write-myth and goal-about-goal theatre', () => {
    expect(
      isWritePathRecoveryTheme(
        'Lift the exact phrase write pipeline is dead into the recovery_gate preamble'
      )
    ).to.equal(true);
    expect(
      isGoalAboutGoalTheme(
        "Paste insight 10's clause text verbatim into the recovery_gate spec draft for goal_15139"
      )
    ).to.equal(true);
    expect(
      isGoalTheatreTheme(
        'Codify insight 1 as the verification step in goal_15402 recovery_gate'
      )
    ).to.equal(true);
    expect(
      shouldRejectGoalAboutGoal({
        description:
          "Immediately paste insight 10's clause text verbatim into goal_15139 recovery_gate",
      })
    ).to.equal(true);
    expect(
      shouldRejectGoalAboutGoal({
        description:
          'Write outputs/recovery_gate_spec.md documenting the recovery protocol',
        doneWhen: {
          criteria: [{ type: 'file_exists', path: 'outputs/recovery_gate_spec.md' }],
        },
      })
    ).to.equal(false);
  });

  it('enriches judged-only doneWhen with file_exists when paths are named', () => {
    const enriched = enrichDoneWhenWithFileExists({
      description: 'Create outputs/recovery_report.json summarizing write health',
      doneWhen: {
        version: 1,
        criteria: [
          {
            type: 'judged',
            criterion:
              'The goal is satisfied when recovery_report.json exists under outputs/ and documents a concrete resolution with evidence.',
          },
        ],
      },
    });
    expect(enriched._doneWhenEnrichedWithFileExists).to.equal(true);
    expect(enriched.doneWhen.criteria[0]).to.deep.include({
      type: 'file_exists',
      path: 'outputs/recovery_report.json',
    });
    expect(enriched.doneWhen.criteria.some((c) => c.type === 'judged')).to.equal(true);
  });

  it('does not double-enrich doneWhen that already has file_exists', () => {
    const original = {
      description: 'Create outputs/recovery_report.json',
      doneWhen: {
        criteria: [{ type: 'file_exists', path: 'outputs/recovery_report.json' }],
      },
    };
    const enriched = enrichDoneWhenWithFileExists(original);
    expect(enriched._doneWhenEnrichedWithFileExists).to.equal(undefined);
    expect(enriched.doneWhen.criteria).to.have.length(1);
  });

  it('collapses swarms of 3+ write-path goals to one keep', () => {
    const goals = [
      { id: 'g1', description: 'fix write_path', priority: 0.4, created: 1, status: 'active' },
      { id: 'g2', description: 'create recovery_report.json', priority: 0.9, created: 2, status: 'active' },
      { id: 'g3', description: 'exec stub persistence', priority: 0.5, created: 3, status: 'active' },
      { id: 'g4', description: 'unrelated research', priority: 1, created: 4, status: 'active' },
    ];
    const result = collapseWritePathSwarm(goals, { maxKeep: 1, maxCluster: 3 });
    expect(result.keep.map((g) => g.id)).to.deep.equal(['g2']);
    expect(result.archive.map((g) => g.id).sort()).to.deep.equal(['g1', 'g3']);
  });

  it('prunes swarm when recovery artifacts already exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-paths-'));
    fs.writeFileSync(path.join(dir, 'recovery_report.json'), '{}');
    fs.writeFileSync(path.join(dir, 'recovery_status.json'), '{}');
    expect(recoveryArtifactsPresent(dir)).to.equal(true);

    const goals = new Map([
      ['a', { id: 'a', description: 'write_path fix', status: 'active' }],
      ['b', { id: 'b', description: 'recovery_report.json', status: 'active' }],
    ]);
    const system = {
      getGoals: () => Array.from(goals.values()),
      archiveGoal(id) {
        const g = goals.get(id);
        if (!g || g.status === 'archived') return false;
        g.status = 'archived';
        return true;
      },
    };

    const result = pruneWritePathRecoverySwarm(system, dir);
    expect(result.archived).to.equal(2);
    expect(result.reason).to.equal('artifacts_present');
  });

  it('coerces markdown-wrapped JSON for .json filenames', () => {
    const raw = 'Here is the file:\n```json\n{"ok":true}\n```\n';
    expect(coerceJsonFileContent(raw, 'recovery_report.json')).to.equal('{"ok":true}');
    expect(coerceJsonFileContent('{"ok":true}', 'recovery_report.json')).to.equal('{"ok":true}');
    expect(coerceJsonFileContent(raw, 'report.md')).to.equal(raw);
  });
});

describe('done-when file_exists path normalization', () => {
  it('passes for outputs/foo.json when file is at outputsDir/foo.json', async () => {
    const outputsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-when-norm-'));
    fs.writeFileSync(path.join(outputsDir, 'recovery_report.json'), '{"ok":true}');
    const env = {
      outputsDir,
      brainDir: outputsDir,
      memory: { nodes: new Map() },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    const result = await checkCriterion(
      { type: 'file_exists', path: 'outputs/recovery_report.json' },
      env
    );
    expect(result.passed).to.equal(true);
  });
});
