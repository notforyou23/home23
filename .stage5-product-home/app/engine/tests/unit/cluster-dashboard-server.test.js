const { expect } = require('chai');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { ClusterDashboardServer } = require('../../src/dashboard/cluster-server');

describe('ClusterDashboardServer review pipeline summary', () => {
  let tempRoot;
  let server;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-review-'));
    const cycleDir = path.join(tempRoot, 'reviews', 'cycle_10');
    await fs.mkdir(cycleDir, { recursive: true });

    const plan = {
      planId: 'plan-10',
      status: 'assigned',
      createdAt: '2025-10-19T00:00:00Z',
      createdBy: 'cosmo-1',
      assignments: {
        authors: ['cosmo-1'],
        critics: ['cosmo-2'],
        synthesizer: 'cosmo-3'
      },
      warnings: []
    };

    await fs.writeFile(path.join(cycleDir, 'plan.json'), JSON.stringify(plan, null, 2));

    const draftArtifact = {
      artifactId: 'draft_cosmo-1',
      artifactType: 'draft',
      status: 'complete',
      instanceId: 'cosmo-1',
      summary: {
        prioritizedGoals: [],
        strategicDirectives: []
      }
    };

    const critiqueArtifact = {
      artifactId: 'critique_cosmo-2',
      artifactType: 'critique',
      status: 'in_progress',
      instanceId: 'cosmo-2',
      summary: {
        recommendations: ['Verify data coverage']
      },
      mission: {
        missionId: 'mission_review_critique_10_token',
        agentType: 'quality_assurance',
        agentId: 'agent-1'
      }
    };

    await fs.writeFile(
      path.join(cycleDir, 'draft_cosmo-1.json'),
      JSON.stringify(draftArtifact, null, 2)
    );
    await fs.writeFile(
      path.join(cycleDir, 'critique_cosmo-2.json'),
      JSON.stringify(critiqueArtifact, null, 2)
    );

    server = new ClusterDashboardServer(0, { instanceCount: 3, fsRoot: tempRoot });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('summarizes review plan and artifacts from filesystem', async () => {
    const review = await server.getReviewPipelineStatus();

    expect(review).to.be.an('object');
    expect(review.cycle).to.equal(10);
    expect(review.plan.planId).to.equal('plan-10');
    expect(review.artifacts.draft).to.be.an('object');
    expect(review.artifacts.draft.artifactId).to.equal('draft_cosmo-1');
    expect(review.artifacts.critiques).to.have.lengthOf(1);
    expect(review.artifacts.critiques[0].artifactId).to.equal('critique_cosmo-2');
  });
});

describe('ClusterDashboardServer governance API', () => {
  let tempRoot;
  let server;
  let httpServer;
  let port;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-governance-'));
    server = new ClusterDashboardServer(0, {
      instanceCount: 1,
      fsRoot: tempRoot,
      backend: 'filesystem'
    });
    httpServer = server.start();
    port = httpServer.address().port;
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
    server.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('applies and clears overrides via REST API', async () => {
    const setResponse = await fetch(`http://localhost:${port}/api/cluster/governance/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'force_skip',
        reason: 'maintenance window',
        ttlMinutes: 5,
        requestedBy: 'test-suite'
      })
    });
    expect(setResponse.ok).to.equal(true);
    const setJson = await setResponse.json();
    expect(setJson.override).to.be.an('object');
    expect(setJson.override.mode).to.equal('force_skip');
    expect(setJson.override.reason).to.equal('maintenance window');

    const getResponse = await fetch(`http://localhost:${port}/api/cluster/governance/override`);
    expect(getResponse.ok).to.equal(true);
    const getJson = await getResponse.json();
    expect(getJson.override.mode).to.equal('force_skip');
    expect(getJson.override.requestedBy).to.equal('test-suite');

    const eventsResponse = await fetch(
      `http://localhost:${port}/api/cluster/governance/events?limit=5`
    );
    expect(eventsResponse.ok).to.equal(true);
    const eventsJson = await eventsResponse.json();
    expect(eventsJson.events).to.be.an('array');
    expect(eventsJson.events.length).to.be.at.least(1);
    expect(eventsJson.events[eventsJson.events.length - 1].event).to.equal('override_set');

    const clearResponse = await fetch(
      `http://localhost:${port}/api/cluster/governance/override`,
      { method: 'DELETE' }
    );
    expect(clearResponse.ok).to.equal(true);
    const clearJson = await clearResponse.json();
    expect(clearJson.cleared).to.equal(true);

    const eventsAfterClear = await fetch(
      `http://localhost:${port}/api/cluster/governance/events?limit=5`
    );
    const eventsAfterJson = await eventsAfterClear.json();
    expect(eventsAfterJson.events.length).to.be.at.least(2);
    const lastEvent = eventsAfterJson.events[eventsAfterJson.events.length - 1];
    expect(lastEvent.event).to.equal('override_cleared');
  });
});
