const { expect } = require('chai');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { auditArtifactLoop } = require('../../src/artifacts/artifact-audit');

describe('artifact-audit source backbone status', () => {
  it('surfaces blocked source route receipts in the artifact audit summary', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-audit-'));
    const proofDir = path.join(runDir, 'outputs', 'research', 'agent_1');
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(path.join(proofDir, 'source_backbone_status.json'), JSON.stringify({
      can_continue: false,
      next_allowed_action: 'attempt_missing_required_source_routes',
      required_routes: ['crossref.works'],
      attempted_routes: ['web.search'],
      missing_required_routes: ['crossref.works'],
      failed_required_routes: [],
      productive_sources: 1,
      source_required: true
    }, null, 2));

    const audit = await auditArtifactLoop(runDir);

    expect(audit.totals.sourceBackboneStatusFiles).to.equal(1);
    expect(audit.totals.sourceBackboneBlockCount).to.equal(1);
    expect(audit.sourceBackboneBlocks[0]).to.include({
      nextAllowedAction: 'attempt_missing_required_source_routes',
      productiveSources: 1,
      sourceRequired: true
    });
    expect(audit.sourceBackboneBlocks[0].missingRequiredRoutes).to.deep.equal(['crossref.works']);
  });
});
