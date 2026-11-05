const { expect } = require('chai');

const { AgentExecutor } = require('../../src/agents/agent-executor');

class MemoryReviewStore {
  constructor() {
    this.artifacts = new Map();
    this.events = [];
  }

  async getReviewArtifacts(cycle) {
    return this.artifacts.get(cycle) || [];
  }

  async recordReviewArtifact(cycle, artifact) {
    const list = this.artifacts.get(cycle) || [];
    const filtered = list.filter((item) => item.artifactId !== artifact.artifactId);
    this.artifacts.set(cycle, [...filtered, artifact]);
    return artifact;
  }

  async appendReviewEvent(cycle, event) {
    this.events.push({ cycle, ...event });
    return true;
  }
}

describe('AgentExecutor review pipeline integration', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  it('updates critique artifact when review mission completes', async () => {
    const reviewStore = new MemoryReviewStore();
    const cycle = 42;
    const artifactId = 'critique_cosmo-1';

    await reviewStore.recordReviewArtifact(cycle, {
      artifactId,
      artifactType: 'critique',
      status: 'in_progress',
      instanceId: 'cosmo-1',
      planId: 'plan-42',
      draftArtifactId: 'draft_cosmo-1',
      summary: { recommendations: [] },
      mission: {
        missionId: 'mission_review_critique_42_seed',
        agentType: 'quality_assurance',
        agentId: 'agent-seed',
        spawnedAt: new Date().toISOString(),
        status: 'in_progress'
      }
    });

    const executor = new AgentExecutor({ memory: null, goals: null }, { logsDir: '.' }, logger);
    executor.setClusterReviewContext(reviewStore, 'cosmo-1');

    const agentResults = {
      agentId: 'agent-critique-1',
      agentType: 'QualityAssuranceAgent',
      status: 'completed',
      duration: 120000,
      mission: {
        missionId: 'mission_review_critique_42_next',
        goalId: 'review_critique_42_cosmo-1',
        agentType: 'quality_assurance',
        reviewPipeline: {
          role: 'critic',
          planId: 'plan-42',
          artifactId,
          draftArtifactId: 'draft_cosmo-1',
          cycle
        },
        spawnCycle: cycle
      },
      results: [
        { type: 'finding', content: 'Goal coverage is uneven across research domains.' },
        { type: 'recommendation', content: 'Assign cosmo-2 to red-team the synthesis directives.' }
      ]
    };

    await executor.updateReviewPipelineArtifacts(agentResults, { confidence: 0.88 });

    const storedArtifacts = await reviewStore.getReviewArtifacts(cycle);
    const updated = storedArtifacts.find((item) => item.artifactId === artifactId);

    expect(updated).to.exist;
    expect(updated.status).to.equal('complete');
    expect(updated.summary).to.be.an('object');
    expect(updated.summary.keyFindings).to.include('Goal coverage is uneven across research domains.');
    expect(updated.summary.qa).to.deep.equal({ confidence: 0.88 });
    expect(updated.mission.status).to.equal('completed');

    const event = reviewStore.events.find((entry) => entry.artifactId === artifactId);
    expect(event).to.exist;
    expect(event.event).to.equal('review_artifact_updated');
  });
});
