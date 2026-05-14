const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ArtifactRegistry } = require('../../cosmo23/engine/src/artifacts/artifact-registry');
const { ArtifactIngestor } = require('../../cosmo23/engine/src/artifacts/artifact-ingestor');
const { auditArtifactLoop } = require('../../cosmo23/engine/src/artifacts/artifact-audit');
const { migrateExistingOutputs } = require('../../cosmo23/engine/src/artifacts/artifact-migration');
const { ArtifactLifecycleManager } = require('../../cosmo23/engine/src/artifacts/artifact-lifecycle');
const { verifyArtifactLoop } = require('../../cosmo23/engine/src/artifacts/artifact-loop-verifier');
const { TaskStateQueue } = require('../../cosmo23/engine/src/cluster/task-state-queue');
const FilesystemStateStore = require('../../cosmo23/engine/src/cluster/backends/filesystem-state-store');
const { AgentExecutor } = require('../../cosmo23/engine/src/agents/agent-executor');
const { Capabilities } = require('../../cosmo23/engine/src/core/capabilities');
const { QueryEngine } = require('../../cosmo23/lib/query-engine');

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

test('artifact registry gives created files stable graph-native identity', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-registry-'));
  const outputsDir = path.join(runDir, 'outputs');
  await fs.mkdir(outputsDir, { recursive: true });
  const artifactPath = path.join(outputsDir, 'research_summary.md');
  await fs.writeFile(artifactPath, '# Current Verdict\n\nUse lineage before semantic memory.\n', 'utf8');

  const addedNodes = [];
  const addedEdges = [];
  const memory = {
    nodes: new Map(),
    async addNode(concept, tag, _embedding, metadata) {
      const node = { id: `node_${addedNodes.length + 1}`, concept, tag, metadata };
      this.nodes.set(node.id, node);
      addedNodes.push(node);
      return node;
    },
    addEdge(source, target, weight, type) {
      addedEdges.push({ source, target, weight, type });
    }
  };

  const registry = new ArtifactRegistry({ runDir, memory, logger });
  const record = await registry.registerArtifact({
    taskId: 'task:phase1',
    goalId: 'goal:alpha',
    producer: { type: 'agent', id: 'agent_1' },
    path: 'outputs/research_summary.md',
    kind: 'research_summary'
  });

  assert.match(record.artifactId, /^artifact_[a-f0-9]{16}$/);
  assert.equal(record.runId, path.basename(runDir));
  assert.equal(record.taskId, 'task:phase1');
  assert.equal(record.producer.id, 'agent_1');
  assert.equal(record.path, 'outputs/research_summary.md');
  assert.match(record.hash, /^sha256:/);
  assert.equal(record.kind, 'research_summary');
  assert.equal(record.lifecycleState, 'registered');
  assert.equal(record.missingBindings.length, 0);
  assert.ok(record.graphNodeId);
  assert.ok(addedNodes.some(node => node.metadata?.type === 'artifact'));
  assert.ok(addedEdges.some(edge => edge.type === 'task_produced'));
  assert.ok(addedEdges.some(edge => edge.type === 'agent_produced'));

  const registryJson = JSON.parse(await fs.readFile(path.join(runDir, 'coordinator', 'artifact_registry.json'), 'utf8'));
  assert.equal(registryJson.schema, 'cosmo23.graph_native_artifacts.v1');
  assert.equal(registryJson.artifacts.length, 1);
  assert.equal(registryJson.artifacts[0].artifactId, record.artifactId);
  assert.equal(registry.getArtifactByPath('outputs/research_summary.md').artifactId, record.artifactId);
  assert.equal(registry.getArtifactsByHash(record.hash)[0].artifactId, record.artifactId);
  assert.equal(registry.getArtifactsByTask('task:phase1')[0].artifactId, record.artifactId);
  assert.equal(registry.getArtifactsByProducer('agent_1')[0].artifactId, record.artifactId);
  assert.equal(registry.getArtifactsByLifecycle('registered')[0].artifactId, record.artifactId);
});

test('task state queue completion persists artifact IDs, not only counts', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-task-closure-'));
  const fsRoot = path.join(runDir, 'cluster');
  const tasksDir = path.join(fsRoot, 'tasks');
  const logsDir = path.join(fsRoot, 'logs');
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const store = new FilesystemStateStore({ fsRoot, instanceId: 'test' }, logger);
  store.tasksDir = tasksDir;
  store.logsDir = logsDir;
  await store.upsertTask({
    id: 'task:phase1',
    state: 'IN_PROGRESS',
    artifacts: []
  });

  const queue = new TaskStateQueue(runDir, logger);
  await queue.initialize();
  await queue.enqueue({
    type: 'COMPLETE_TASK',
    taskId: 'task:phase1',
    artifactCount: 1,
    producedArtifacts: [{
      artifactId: 'artifact_abc',
      role: 'primary_output',
      path: 'outputs/verdict.md',
      kind: 'committed_verdict',
      hash: 'sha256:abc'
    }],
    consumedArtifacts: [{
      artifactId: 'artifact_input',
      role: 'required_input'
    }],
    closureStatus: 'completed_cleanly',
    source: 'test'
  });

  await queue.processAll(store, null);
  const task = await store.getTask('task:phase1');

  assert.equal(task.state, 'DONE');
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].artifactId, 'artifact_abc');
  assert.equal(task.producedArtifacts[0].artifactId, 'artifact_abc');
  assert.equal(task.consumedArtifacts[0].artifactId, 'artifact_input');
  assert.equal(task.artifactClosure.status, 'completed_cleanly');
  assert.equal(task.artifactClosure.artifactCount, 1);
});

test('artifact ingestor parses research summaries into reusable structure', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-ingest-'));
  await fs.mkdir(path.join(runDir, 'outputs', 'research', 'agent_1'), { recursive: true });
  const summaryPath = path.join(runDir, 'outputs', 'research', 'agent_1', 'research_summary.md');
  await fs.writeFile(summaryPath, `# Artifact Loop Summary

## Verdict

The loop should load lineage before semantic memory.

## Recommendations

- Implement artifact IDs for every durable output.
- Verify future agents consume required artifacts.

What remains open?
`, 'utf8');

  const edges = [];
  const memory = {
    nodes: new Map(),
    async addNode(concept, tag, _embedding, metadata) {
      const node = { id: `node_${this.nodes.size + 1}`, concept, tag, metadata };
      this.nodes.set(node.id, node);
      return node;
    },
    addEdge(source, target, weight, type) {
      edges.push({ source, target, weight, type });
    }
  };
  const registry = new ArtifactRegistry({ runDir, logger, memory });
  const record = await registry.registerArtifact({
    taskId: 'task:phase2',
    producer: { type: 'agent', id: 'agent_1' },
    path: 'outputs/research/agent_1/research_summary.md',
    kind: 'research_summary'
  });

  const ingestor = new ArtifactIngestor({ registry, logger });
  const parsed = await ingestor.ingest(record);

  assert.equal(parsed.parseStatus, 'parsed');
  assert.equal(parsed.lifecycleState, 'parsed');
  assert.equal(parsed.structured.title, 'Artifact Loop Summary');
  assert.deepEqual(parsed.structured.headings, ['Verdict', 'Recommendations']);
  assert.equal(parsed.structured.reuseContract.recommendedUse, 'candidate_synthesis');
  assert.ok(parsed.structured.canonicalClaims.some(claim => claim.text.includes('lineage before semantic memory')));
  assert.ok(parsed.structured.canonicalClaims.every(claim => /^claim_[a-f0-9]{16}$/.test(claim.claimId)));
  assert.ok(parsed.structured.recommendations.some(item => item.includes('artifact IDs')));
  assert.ok([...memory.nodes.values()].some(node => node.metadata?.type === 'claim'));
  assert.ok(edges.some(edge => edge.type === 'artifact_supports'));
});

test('lineage packet separates required and superseded artifacts before semantic memory', () => {
  const executor = Object.create(AgentExecutor.prototype);
  executor.config = { logsDir: '/tmp/cosmo-run-alpha' };

  const packet = executor.buildLineagePacket({
    taskId: 'task:phase2',
    goalId: 'goal:alpha',
    description: 'continue the artifact loop'
  }, [{
    artifactId: 'artifact_current',
    workspacePath: 'outputs/verdict.md',
    hash: 'sha256:current',
    kind: 'committed_verdict',
    sourceTaskId: 'task:phase1',
    sourceAgentId: 'agent_1',
    lifecycleState: 'committed',
    tag: 'task_artifact_lineage'
  }, {
    artifactId: 'artifact_old',
    workspacePath: 'outputs/old.md',
    hash: 'sha256:old',
    kind: 'summary',
    sourceTaskId: 'task:phase0',
    sourceAgentId: 'agent_0',
    lifecycleState: 'superseded',
    supersededBy: 'artifact_current'
  }]);

  assert.equal(packet.taskId, 'task:phase2');
  assert.equal(packet.goalId, 'goal:alpha');
  assert.equal(packet.requiredArtifacts.length, 1);
  assert.equal(packet.requiredArtifacts[0].artifactId, 'artifact_current');
  assert.equal(packet.supersededArtifacts.length, 1);
  assert.equal(packet.supersededArtifacts[0].supersededBy, 'artifact_current');
  assert.equal(packet.recommendedReadOrder[0], 'artifact_current');
  assert.equal(packet.semanticMemoryFallbackQuery, 'continue the artifact loop');
});

test('registry selects current reusable artifacts for mission topic', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-reusable-artifacts-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'artifact-loop.md'), '# Artifact Loop\n\nThe artifact loop should load lineage before semantic memory.\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'outputs', 'old.md'), '# Old\n\nSuperseded notes.\n', 'utf8');

  const registry = new ArtifactRegistry({ runDir, logger });
  const current = await registry.registerArtifact({
    taskId: 'task:source',
    goalId: 'goal:artifact-loop',
    producer: { type: 'agent', id: 'agent_source' },
    path: 'outputs/artifact-loop.md',
    kind: 'research_summary'
  });
  await registry.updateArtifact(current.artifactId, {
    lifecycleState: 'committed',
    parseStatus: 'parsed',
    structured: {
      title: 'Artifact Loop',
      headings: ['Lineage'],
      recommendations: ['Load lineage before semantic memory'],
      openQuestions: [],
      canonicalClaims: [{ text: 'The artifact loop should load lineage before semantic memory.' }]
    }
  });

  const old = await registry.registerArtifact({
    taskId: 'task:old',
    producer: { type: 'agent', id: 'agent_old' },
    path: 'outputs/old.md'
  });
  await registry.updateArtifact(old.artifactId, { lifecycleState: 'superseded' });

  const matches = registry.findReusableArtifacts('continue artifact loop lineage work', {
    goalId: 'goal:artifact-loop'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].artifactId, current.artifactId);
  assert.equal(matches[0].tag, 'current_committed_artifact');
  assert.ok(matches[0].reuseScore > 0);
});

test('mission enrichment adds current committed artifacts when predecessor tasks are absent', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-current-lineage-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'committed.md'), '# Committed\n\nThe artifact loop needs reusable lineage.\n', 'utf8');

  const registry = new ArtifactRegistry({ runDir, logger });
  const record = await registry.registerArtifact({
    taskId: 'task:source',
    goalId: 'goal:artifact-loop',
    producer: { type: 'agent', id: 'agent_source' },
    path: 'outputs/committed.md',
    kind: 'research_summary'
  });
  await registry.updateArtifact(record.artifactId, {
    lifecycleState: 'committed',
    parseStatus: 'parsed',
    structured: {
      title: 'Committed Artifact Loop',
      headings: [],
      recommendations: ['Reuse lineage artifacts'],
      openQuestions: [],
      canonicalClaims: [{ text: 'The artifact loop needs reusable lineage.' }]
    }
  });

  const executor = Object.create(AgentExecutor.prototype);
  executor.config = { logsDir: runDir };
  executor.logger = logger;
  executor.artifactRegistry = registry;
  executor.clusterStateStore = { async getTask() { return null; } };

  const mission = {
    missionId: 'mission:next',
    agentType: 'ide',
    taskId: 'task:next',
    goalId: 'goal:artifact-loop',
    description: 'Continue the artifact loop lineage implementation',
    metadata: {}
  };

  await executor.enrichMissionWithArtifacts(mission);

  assert.equal(mission.lineagePacket.requiredArtifacts.length, 1);
  assert.equal(mission.lineagePacket.requiredArtifacts[0].artifactId, record.artifactId);
  assert.match(mission.description, /Available Predecessor Artifacts/);
  assert.match(mission.description, /outputs\/committed\.md/);
});

test('agent executor merges consumed lineage artifacts without duplicates', () => {
  const executor = Object.create(AgentExecutor.prototype);
  const merged = executor.mergeArtifactRefs([{
    artifactId: 'artifact_a',
    role: 'required_input'
  }], [{
    artifactId: 'artifact_a',
    role: 'required_input'
  }, {
    artifactId: 'artifact_b',
    role: 'required_input'
  }]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(a => a.artifactId), ['artifact_a', 'artifact_b']);
});

test('artifact context is injected into mission description only once', () => {
  const executor = Object.create(AgentExecutor.prototype);
  const mission = {
    description: 'Continue the work.',
    metadata: {}
  };
  mission.artifactContext = executor.buildArtifactContext([{
    artifactId: 'artifact_a',
    workspacePath: 'outputs/a.md',
    sourceAgentId: 'agent_a',
    size: 1024
  }]);

  mission.description = `${mission.description}${mission.artifactContext}`;
  mission.metadata.artifactContextInjected = true;
  const baseAgent = {
    mission,
    _uploadedArtifacts: [],
    getMissionWithArtifactContext: require('../../cosmo23/engine/src/agents/base-agent').BaseAgent.prototype.getMissionWithArtifactContext
  };

  const text = baseAgent.getMissionWithArtifactContext();
  assert.equal((text.match(/Available Predecessor Artifacts/g) || []).length, 1);
  assert.match(text, /outputs\/a\.md/);
});

test('artifact audit reports unregistered and orphan output files', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-audit-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'registered.md'), 'registered', 'utf8');
  await fs.writeFile(path.join(runDir, 'outputs', 'unregistered.md'), 'unregistered', 'utf8');
  await fs.writeFile(path.join(runDir, 'tasks', 'task:empty.json'), JSON.stringify({
    id: 'task:empty',
    state: 'DONE',
    completedAt: Date.now(),
    artifacts: []
  }), 'utf8');

  const registry = new ArtifactRegistry({ runDir, logger });
  await registry.registerArtifact({
    path: 'outputs/registered.md',
    producer: { type: 'agent', id: 'agent_1' }
  });

  const audit = await auditArtifactLoop(runDir);

  assert.equal(audit.schema, 'cosmo23.artifact_audit.v1');
  assert.equal(audit.totals.outputFiles, 2);
  assert.equal(audit.totals.registeredArtifacts, 1);
  assert.equal(audit.totals.unregisteredFiles, 1);
  assert.equal(audit.unregisteredFiles[0].path, 'outputs/unregistered.md');
  assert.equal(audit.totals.orphanArtifacts, 1);
  assert.equal(audit.totals.completedTasksWithoutProducedArtifacts, 1);
  assert.equal(audit.completedTasksWithoutProducedArtifacts[0].taskId, 'task:empty');
});

test('migration registers existing outputs without inventing lineage', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-migrate-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'legacy.md'), '# Legacy\n\nThe loop should preserve lineage.\n', 'utf8');
  await fs.writeFile(path.join(runDir, 'tasks', 'task:legacy.json'), JSON.stringify({
    id: 'task:legacy',
    state: 'DONE',
    completedAt: Date.now(),
    artifacts: [],
    metadata: {
      expectedOutput: '@outputs/legacy.md'
    }
  }), 'utf8');

  const migration = await migrateExistingOutputs(runDir, { logger });
  const audit = await auditArtifactLoop(runDir);

  assert.equal(migration.schema, 'cosmo23.artifact_migration.v1');
  assert.equal(migration.scanned, 1);
  assert.equal(migration.migrated, 1);
  assert.equal(migration.failed, 0);
  assert.equal(migration.taskBindings, 1);
  assert.equal(audit.totals.unregisteredFiles, 0);
  assert.equal(audit.totals.registeredArtifacts, 1);
  assert.equal(audit.totals.completedTasksWithoutProducedArtifacts, 0);
  assert.equal(audit.currentArtifacts[0].producer.id, 'migration');
  assert.equal(audit.currentArtifacts[0].taskId, 'task:legacy');
  assert.ok(audit.currentArtifacts[0].registrationWarnings.some(w => w.type === 'migrated_without_lineage'));
  assert.ok(audit.currentArtifacts[0].registrationWarnings.some(w => w.type === 'bound_from_task_declared_output'));
  assert.equal(audit.totals.parsedArtifacts, 1);
});

test('lifecycle manager records supersession and removes old artifact from current audit', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-life-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'old.md'), 'old verdict', 'utf8');
  await fs.writeFile(path.join(runDir, 'outputs', 'new.md'), 'new verdict', 'utf8');

  const edges = [];
  const memory = {
    nodes: new Map(),
    async addNode(concept, tag, _embedding, metadata) {
      const node = { id: `node_${this.nodes.size + 1}`, concept, tag, metadata };
      this.nodes.set(node.id, node);
      return node;
    },
    addEdge(source, target, weight, type) {
      edges.push({ source, target, weight, type });
    }
  };
  const registry = new ArtifactRegistry({ runDir, memory, logger });
  const oldRecord = await registry.registerArtifact({
    taskId: 'task:old',
    producer: { type: 'agent', id: 'agent_old' },
    path: 'outputs/old.md'
  });
  const newRecord = await registry.registerArtifact({
    taskId: 'task:new',
    producer: { type: 'agent', id: 'agent_new' },
    path: 'outputs/new.md'
  });

  const lifecycle = new ArtifactLifecycleManager({ registry, logger });
  const result = await lifecycle.supersede(oldRecord.artifactId, newRecord.artifactId, {
    changedBy: 'test',
    reason: 'new verdict replaces old'
  });
  const audit = await auditArtifactLoop(runDir);

  assert.equal(result.oldArtifact.lifecycleState, 'superseded');
  assert.equal(result.oldArtifact.supersededBy, newRecord.artifactId);
  assert.ok(result.oldArtifact.lifecycleTransitions.some(t => t.toState === 'superseded'));
  assert.ok(result.newArtifact.supersedes.artifactIds.includes(oldRecord.artifactId));
  assert.equal(audit.totals.supersededArtifacts, 1);
  assert.equal(audit.totals.currentArtifacts, 1);
  assert.ok(edges.some(edge => edge.type === 'artifact_supersedes'));
});

test('lifecycle manager records task consumption edge when artifact is reused', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-consumed-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'input.md'), 'input substrate', 'utf8');

  const edges = [];
  const memory = {
    nodes: new Map(),
    async addNode(concept, tag, _embedding, metadata) {
      const node = { id: `node_${this.nodes.size + 1}`, concept, tag, metadata };
      this.nodes.set(node.id, node);
      return node;
    },
    addEdge(source, target, weight, type) {
      edges.push({ source, target, weight, type });
    }
  };
  const registry = new ArtifactRegistry({ runDir, memory, logger });
  const record = await registry.registerArtifact({
    taskId: 'task:source',
    producer: { type: 'agent', id: 'agent_source' },
    path: 'outputs/input.md'
  });

  const lifecycle = new ArtifactLifecycleManager({ registry, logger });
  const reused = await lifecycle.markReused(record.artifactId, {
    taskId: 'task:followup',
    changedBy: 'agent_followup'
  });

  assert.equal(reused.lifecycleState, 'reused');
  assert.ok(edges.some(edge => edge.type === 'task_consumed'));
});

test('lifecycle promotion requires reuse or validation evidence', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-promote-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'candidate.md'), 'candidate verdict', 'utf8');

  const registry = new ArtifactRegistry({ runDir, logger });
  const record = await registry.registerArtifact({
    taskId: 'task:candidate',
    producer: { type: 'agent', id: 'agent_candidate' },
    path: 'outputs/candidate.md'
  });
  const lifecycle = new ArtifactLifecycleManager({ registry, logger });

  await assert.rejects(
    () => lifecycle.promoteCommitted(record.artifactId, { changedBy: 'test' }),
    /without causal reuse or validation evidence/
  );

  await lifecycle.markReused(record.artifactId, {
    taskId: 'task:reuse',
    changedBy: 'agent_reuse'
  });
  const committed = await lifecycle.promoteCommitted(record.artifactId, {
    changedBy: 'test',
    reason: 'verified by reuse'
  });

  assert.equal(committed.lifecycleState, 'committed');
  assert.ok(committed.lifecycleTransitions.some(t => t.toState === 'reused'));
  assert.ok(committed.lifecycleTransitions.some(t => t.toState === 'committed'));
});

test('agent executor promotes validated primary artifacts to committed substrate', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-validated-promotion-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'summary.md'), '# Summary\n\nThe artifact loop is ready for reuse.\n', 'utf8');

  const registry = new ArtifactRegistry({ runDir, logger });
  const record = await registry.registerArtifact({
    taskId: 'task:validated',
    producer: { type: 'agent', id: 'agent_validated' },
    path: 'outputs/summary.md',
    kind: 'research_summary'
  });

  const executor = Object.create(AgentExecutor.prototype);
  executor.logger = logger;
  executor.artifactLifecycle = new ArtifactLifecycleManager({ registry, logger });

  const promoted = await executor.promoteValidatedProducedArtifacts([{
    artifactId: record.artifactId,
    role: 'primary_output',
    kind: 'research_summary'
  }], {
    agentId: 'agent_validated',
    taskId: 'task:validated',
    goalId: 'goal:validated',
    qaMetadata: {
      validation: 'heuristic_pass',
      confidence: 0.9,
      reason: 'QA passed'
    }
  });

  const committed = registry.getArtifact(record.artifactId);
  assert.deepEqual(promoted, [record.artifactId]);
  assert.equal(committed.lifecycleState, 'committed');
  assert.ok(committed.lifecycleTransitions.some(t => t.toState === 'committed'));
});

test('capabilities write hook registers durable output artifacts', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-capabilities-artifact-'));
  const registry = new ArtifactRegistry({ runDir, logger });
  const capabilities = new Capabilities({
    capabilities: { enabled: true, executiveGating: false, useFrontierGate: false },
    cluster: { enabled: false }
  }, logger, null, null, {
    resolve(filePath) {
      return path.isAbsolute(filePath) ? filePath : path.join(runDir, filePath);
    }
  });
  capabilities.setArtifactLoop({ registry });

  const result = await capabilities.writeFile('outputs/from-capabilities.md', '# Output\n', {
    agentId: 'agent_cap',
    agentType: 'TestAgent',
    missionGoal: 'goal:cap',
    taskId: 'task:cap'
  });
  const audit = await auditArtifactLoop(runDir);

  assert.equal(result.success, true);
  assert.match(result.artifactId, /^artifact_/);
  assert.equal(audit.totals.registeredArtifacts, 1);
  assert.equal(audit.currentArtifacts[0].taskId, 'task:cap');
  assert.equal(audit.currentArtifacts[0].producer.id, 'agent_cap');
});

test('capabilities read-before-write gate blocks undeclared lineage writes', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-read-gate-'));
  const capabilities = new Capabilities({
    capabilities: { enabled: true, executiveGating: false, useFrontierGate: false },
    cluster: { enabled: false }
  }, logger, null, null, {
    resolve(filePath) {
      return path.isAbsolute(filePath) ? filePath : path.join(runDir, filePath);
    }
  });

  const blocked = await capabilities.writeFile('outputs/blocked.md', '# Blocked\n', {
    agentId: 'agent_gate',
    taskId: 'task:gate',
    enforceReadBeforeWrite: true,
    lineagePacket: {
      requiredArtifacts: [{ artifactId: 'artifact_required', path: 'outputs/required.md' }]
    }
  });

  assert.equal(blocked.success, false);
  assert.equal(blocked.readBeforeWriteBlocked, true);
  await assert.rejects(
    () => fs.stat(path.join(runDir, 'outputs', 'blocked.md')),
    /ENOENT/
  );
});

test('capabilities read-before-write gate allows declared consumed lineage writes', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-read-gate-ok-'));
  const registry = new ArtifactRegistry({ runDir, logger });
  const capabilities = new Capabilities({
    capabilities: { enabled: true, executiveGating: false, useFrontierGate: false },
    cluster: { enabled: false }
  }, logger, null, null, {
    resolve(filePath) {
      return path.isAbsolute(filePath) ? filePath : path.join(runDir, filePath);
    }
  });
  capabilities.setArtifactLoop({ registry });

  const written = await capabilities.writeFile('outputs/allowed.md', '# Allowed\n', {
    agentId: 'agent_gate',
    taskId: 'task:gate',
    enforceReadBeforeWrite: true,
    consumedArtifactIds: ['artifact_required'],
    lineagePacket: {
      requiredArtifacts: [{ artifactId: 'artifact_required', path: 'outputs/required.md' }]
    }
  });

  assert.equal(written.success, true);
  assert.match(written.artifactId, /^artifact_/);
});

test('query export registers artifact identity', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-query-artifact-'));
  const qe = new QueryEngine(runDir, null);

  const exported = await qe.exportResult('what is the loop?', '# Answer\n\nThe loop creates reusable state.', 'markdown', {
    timestamp: '2026-05-10T00:00:00.000Z',
    model: 'test-model',
    mode: 'dive'
  });
  const audit = await auditArtifactLoop(runDir);

  assert.equal(exported.endsWith('.md'), true);
  assert.equal(audit.totals.registeredArtifacts, 1);
  assert.equal(audit.totals.unregisteredFiles, 0);
  assert.equal(audit.currentArtifacts[0].producer.id, 'query_engine');
  assert.equal(audit.currentArtifacts[0].kind, 'query_export_markdown');
});

test('artifact loop verifier exercises closed-loop substrate path', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-artifact-loop-e2e-'));
  const report = await verifyArtifactLoop({ runDir, logger });

  assert.equal(report.passed, true);
  assert.match(report.sourceArtifactId, /^artifact_/);
  assert.match(report.followupArtifactId, /^artifact_/);
  assert.equal(report.auditTotals.unregisteredFiles, 0);
  assert.equal(report.auditTotals.completedTasksWithoutProducedArtifacts, 0);
  assert.ok(report.graphEdges.includes('task_consumed'));

  const saved = JSON.parse(await fs.readFile(report.reportPath, 'utf8'));
  assert.equal(saved.schema, 'cosmo23.artifact_loop_verification.v1');
  assert.equal(saved.passed, true);
});

test('guided deliverable artifacts are promotable with acceptance evidence', async () => {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-guided-promote-'));
  await fs.mkdir(path.join(runDir, 'outputs'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'outputs', 'report.md'), '# Report\n\nA committed answer.\n', 'utf8');

  const executor = Object.create(AgentExecutor.prototype);
  executor.config = { logsDir: runDir };
  executor.logger = logger;
  executor.artifactRegistry = new ArtifactRegistry({ runDir, logger });
  executor.artifactIngestor = new ArtifactIngestor({ registry: executor.artifactRegistry, logger });
  executor.artifactLifecycle = new ArtifactLifecycleManager({ registry: executor.artifactRegistry, logger });
  await executor.artifactRegistry.initialize();

  const record = await executor.artifactRegistry.registerArtifact({
    taskId: 'task:final',
    producer: { type: 'agent', id: 'agent_final' },
    path: 'outputs/report.md',
    kind: 'deliverable'
  });
  await executor.artifactIngestor.ingest(record);

  const promoted = await executor.promoteValidatedProducedArtifacts([{
    artifactId: record.artifactId,
    role: 'primary_output',
    kind: 'deliverable'
  }], {
    agentId: 'agent_final',
    taskId: 'task:final',
    goalId: 'goal:final',
    qaMetadata: {
      validation: 'acceptance_pass',
      confidence: 0.75,
      reason: 'Task acceptance criteria satisfied'
    }
  });

  assert.deepEqual(promoted, [record.artifactId]);
  assert.equal(executor.artifactRegistry.getArtifact(record.artifactId).lifecycleState, 'committed');
});
