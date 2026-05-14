const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { ArtifactRegistry } = require('./artifact-registry');
const { ArtifactIngestor } = require('./artifact-ingestor');
const { ArtifactLifecycleManager } = require('./artifact-lifecycle');
const { auditArtifactLoop } = require('./artifact-audit');
const { Capabilities } = require('../core/capabilities');
const { AgentExecutor } = require('../agents/agent-executor');

async function verifyArtifactLoop(options = {}) {
  const logger = options.logger || quietLogger();
  const runDir = options.runDir || await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-loop-verify-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true });

  const memory = createMemoryProbe();
  const registry = new ArtifactRegistry({ runDir, memory, logger });
  const ingestor = new ArtifactIngestor({ registry, logger });
  const lifecycle = new ArtifactLifecycleManager({ registry, logger });

  const sourcePath = path.join(runDir, 'outputs', 'source.md');
  await fs.writeFile(sourcePath, '# Source Substrate\n\nThe artifact loop must load lineage before semantic memory.\n', 'utf8');

  const sourceRecord = await registry.registerArtifact({
    taskId: 'task:source',
    goalId: 'goal:artifact-loop-verify',
    producer: { type: 'agent', id: 'agent_source' },
    path: 'outputs/source.md',
    kind: 'research_summary'
  });
  await ingestor.ingest(sourceRecord);
  await lifecycle.promoteCommitted(sourceRecord.artifactId, {
    changedBy: 'artifact-loop-verifier',
    reason: 'Seed source artifact is verifier-controlled validation fixture',
    validationResults: [{
      type: 'fixture_validation',
      confidence: 1,
      taskId: 'task:source'
    }]
  });

  const executor = Object.create(AgentExecutor.prototype);
  executor.config = { logsDir: runDir };
  executor.logger = logger;
  executor.artifactRegistry = registry;
  executor.clusterStateStore = { async getTask() { return null; } };

  const mission = {
    missionId: 'mission:followup',
    agentType: 'ide',
    taskId: 'task:followup',
    goalId: 'goal:artifact-loop-verify',
    description: 'Continue artifact loop verification by reusing lineage substrate',
    metadata: {}
  };
  await executor.enrichMissionWithArtifacts(mission);
  assert(mission.lineagePacket?.requiredArtifacts?.some(a => a.artifactId === sourceRecord.artifactId), 'lineage packet did not require committed source artifact');

  const capabilities = new Capabilities({
    capabilities: { enabled: true, executiveGating: false, useFrontierGate: false },
    cluster: { enabled: false }
  }, logger, null, null, {
    resolve(filePath) {
      return path.isAbsolute(filePath) ? filePath : path.join(runDir, filePath);
    }
  });
  capabilities.setArtifactLoop({ registry, ingestor });

  const followup = await capabilities.writeFile('outputs/followup.md', '# Followup\n\nReused source lineage and produced a new substrate artifact.\n', {
    agentId: 'agent_followup',
    agentType: 'ide',
    taskId: 'task:followup',
    goalId: 'goal:artifact-loop-verify',
    kind: 'research_summary',
    enforceReadBeforeWrite: true,
    consumedArtifactIds: [sourceRecord.artifactId],
    lineagePacket: mission.lineagePacket
  });
  assert(followup.success, `capabilities write failed: ${followup.reason || followup.error || 'unknown'}`);
  assert(followup.artifactId, 'followup write did not return artifactId');

  await lifecycle.markReused(sourceRecord.artifactId, {
    taskId: 'task:followup',
    changedBy: 'agent_followup',
    supportingArtifacts: [followup.artifactId],
    validationResults: [{ type: 'read_before_write_gate', passed: true }]
  });
  await lifecycle.promoteCommitted(followup.artifactId, {
    changedBy: 'artifact-loop-verifier',
    reason: 'Followup artifact passed read-before-write and reuse verification',
    validationResults: [{
      type: 'artifact_loop_verifier',
      confidence: 1,
      taskId: 'task:followup'
    }],
    supportingArtifacts: [sourceRecord.artifactId]
  });

  await fs.writeFile(path.join(runDir, 'tasks', 'task:followup.json'), JSON.stringify({
    id: 'task:followup',
    state: 'DONE',
    completedAt: Date.now(),
    consumedArtifacts: [{ artifactId: sourceRecord.artifactId, role: 'required_input' }],
    producedArtifacts: [{ artifactId: followup.artifactId, role: 'primary_output', path: 'outputs/followup.md' }],
    artifacts: [{ artifactId: followup.artifactId, path: 'outputs/followup.md' }],
    artifactClosure: {
      status: 'completed_cleanly',
      artifactCount: 1,
      consumedCount: 1,
      source: 'artifact_loop_verifier'
    }
  }, null, 2), 'utf8');

  const audit = await auditArtifactLoop(runDir);
  assert(audit.totals.unregisteredFiles === 0, `expected 0 unregistered files, got ${audit.totals.unregisteredFiles}`);
  assert(audit.totals.committedArtifacts >= 1, 'expected at least one committed artifact');
  assert(audit.totals.reusedArtifacts + audit.totals.committedArtifacts >= 2, 'expected reused/committed artifacts');
  assert(audit.totals.completedTasksWithoutProducedArtifacts === 0, 'expected no completed tasks without produced artifacts');
  assert(memory.edges.some(edge => edge.type === 'task_consumed'), 'expected TASK_CONSUMED graph edge');

  const report = {
    schema: 'cosmo23.artifact_loop_verification.v1',
    runDir,
    passed: true,
    sourceArtifactId: sourceRecord.artifactId,
    followupArtifactId: followup.artifactId,
    lineageRequiredArtifacts: mission.lineagePacket.requiredArtifacts.map(a => a.artifactId || a.path),
    auditTotals: audit.totals,
    graphEdges: memory.edges.map(edge => edge.type)
  };

  const reportPath = path.join(runDir, 'coordinator', 'artifact_loop_verification_report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return { ...report, reportPath };
}

function createMemoryProbe() {
  return {
    nodes: new Map(),
    edges: [],
    async addNode(concept, tag, _embedding, metadata) {
      const existing = [...this.nodes.values()].find(node => node.tag === tag);
      if (existing) return existing;
      const node = { id: `node_${this.nodes.size + 1}`, concept, tag, metadata };
      this.nodes.set(node.id, node);
      return node;
    },
    addEdge(source, target, weight, type) {
      this.edges.push({ source, target, weight, type });
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Artifact loop verification failed: ${message}`);
  }
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };
}

module.exports = { verifyArtifactLoop };
