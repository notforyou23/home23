const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { ArtifactRegistry } = require('./artifact-registry');
const { ArtifactIngestor } = require('./artifact-ingestor');
const { ArtifactLifecycle } = require('./artifact-lifecycle');
const { ArtifactAudit } = require('./artifact-audit');
const promoteToMemory = require('../cognition/actions/promote-to-memory');

class FakeMemory {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.next = 1;
  }
  async addNode(input, tag = 'general') {
    const id = `n${this.next++}`;
    const concept = typeof input === 'object' ? input.concept : String(input || '');
    const node = {
      id,
      concept,
      tag: typeof input === 'object' ? input.tag || tag : tag,
      type: typeof input === 'object' ? input.type || null : null,
      metadata: typeof input === 'object' ? input.metadata || {} : {}
    };
    this.nodes.set(id, node);
    return node;
  }
  addEdge(a, b, weight = 0.1, type = 'associative') {
    this.edges.set(`${a}->${b}->${type}`, { source: a, target: b, weight, type });
  }
}

async function verifyArtifactLoop(options = {}) {
  const tmp = options.logsDir || await fs.mkdtemp(path.join(os.tmpdir(), 'home23-artifact-loop-'));
  const memory = options.memory || new FakeMemory();
  const registry = new ArtifactRegistry({ logsDir: tmp, memory, logger: options.logger });
  await registry.initialize();
  const ingestor = new ArtifactIngestor({ registry, memory, logger: options.logger });
  const lifecycle = new ArtifactLifecycle({ registry, memory, logger: options.logger });
  const audit = new ArtifactAudit({ registry, logger: options.logger });

  const outputDir = path.join(tmp, 'outputs', 'document-creation', 'agent_verifier');
  await fs.mkdir(outputDir, { recursive: true });
  const sourcePath = path.join(outputDir, 'source.md');
  const derivedPath = path.join(outputDir, 'derived.md');
  await fs.writeFile(sourcePath, '# Source\n\nA reusable Home23 cognition artifact.', 'utf8');
  await fs.writeFile(derivedPath, '# Derived\n\nBuilt from the reusable source artifact.', 'utf8');

  const source = await ingestor.ingestFile(sourcePath, {
    kind: 'document',
    agentId: 'agent_verifier',
    agentType: 'document_creation',
    goalId: 'goal_artifact_loop',
    taskId: 'task_source'
  });
  const derived = await registry.registerFile({
    absolutePath: derivedPath,
    kind: 'document',
    status: 'created',
    agentId: 'agent_verifier_2',
    agentType: 'synthesis',
    goalId: 'goal_artifact_loop',
    taskId: 'task_derived',
    derivedFrom: [source.id]
  });
  await lifecycle.markConsumed(source.id, {
    agentId: 'agent_verifier_2',
    agentType: 'synthesis',
    goalId: 'goal_artifact_loop',
    taskId: 'task_derived',
    reason: 'verifier derived output'
  });
  await lifecycle.linkSupports(source.id, derived.id, { relation: 'source_to_derived' });
  await lifecycle.commit(derived.id, { verifier: true });

  const promoted = await promoteToMemory.run({
    action: {
      content: 'Reusable artifact loop verified: file artifacts can become memory artifacts and graph edges.',
      tag: 'artifact_loop_verification'
    },
    memory,
    cycle: 1,
    role: 'verifier',
    artifactRegistry: registry
  });
  const auditResult = await audit.run({
    roots: [outputDir],
    maxDepth: 2
  });

  return {
    status: promoted.status === 'success' &&
      auditResult.status === 'pass' &&
      registry.find({ status: 'committed' }).length >= 1 &&
      registry.find({ type: 'memory' }).length >= 1
      ? 'pass'
      : 'fail',
    logsDir: tmp,
    sourceArtifactId: source.id,
    derivedArtifactId: derived.id,
    promoted,
    audit: auditResult,
    memoryNodes: memory.nodes.size,
    memoryEdges: memory.edges.size,
    registryPath: registry.registryPath
  };
}

module.exports = { verifyArtifactLoop, FakeMemory };
