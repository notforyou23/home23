const { expect } = require('chai');
const path = require('path');
const os = require('os');

// BaseAgent → UnifiedClient → GPT5Client → openai-client.js requires OPENAI_API_KEY
// at construction time. Set a dummy key so the client can be instantiated (no actual
// API calls are made in these tests).
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-unit-tests';
}

const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');
const { ExecutionBaseAgent } = require('../../src/agents/execution-base-agent');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeLogger = () => ({
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {}
});

const makeMission = (overrides = {}) => ({
  goalId: 'test_infrastructure',
  description: 'Set up a Redis cache and PostgreSQL database for the data pipeline',
  agentType: 'infrastructure',
  successCriteria: ['Redis running on port 6380', 'PostgreSQL running on port 5433'],
  maxDuration: 600000,
  ...overrides
});

const makeConfig = (overrides = {}) => ({
  logsDir: path.join(os.tmpdir(), `cosmo-infra-test-${Date.now()}`),
  architecture: {
    memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } }
  },
  ...overrides
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('InfrastructureAgent', function () {

  // ── Instantiation ──────────────────────────────────────────────────────────

  describe('instantiation', function () {
    it('should instantiate with infrastructure type', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent).to.be.instanceOf(InfrastructureAgent);
      expect(agent).to.be.instanceOf(ExecutionBaseAgent);
      expect(agent.getAgentType()).to.equal('infrastructure');
    });

    it('should have agentId matching base-agent format', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.agentId).to.match(/^agent_\d+_[a-z0-9]+$/);
    });

    it('should start with initialized status', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.status).to.equal('initialized');
    });

    it('should accept mission with infrastructure agentType', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.mission.description).to.equal('Set up a Redis cache and PostgreSQL database for the data pipeline');
      expect(agent.mission.goalId).to.equal('test_infrastructure');
    });
  });

  // ── infraManifest structure ──────────────────────────────────────────────

  describe('infraManifest', function () {
    it('should be initialized with correct structure', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const manifest = agent.infraManifest;

      expect(manifest).to.have.property('services').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('environments').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('dependencies').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('teardownScript', null);
      expect(manifest).to.have.property('healthChecks').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('startedAt', null);
      expect(manifest).to.have.property('completedAt', null);
    });
  });

  // ── Extended timeout ────────────────────────────────────────────────────────

  describe('extended timeout', function () {
    it('should enforce minimum 15-minute timeout', function () {
      const agent = new InfrastructureAgent(
        makeMission({ maxDuration: 60000 }),  // 1 minute
        makeConfig(),
        makeLogger()
      );
      // ExecutionBaseAgent sets maxDuration to at least 900000 (15 min)
      expect(agent.mission.maxDuration).to.be.at.least(900000);
    });

    it('should keep longer timeout if provided', function () {
      const agent = new InfrastructureAgent(
        makeMission({ maxDuration: 1800000 }),  // 30 minutes
        makeConfig(),
        makeLogger()
      );
      expect(agent.mission.maxDuration).to.equal(1800000);
    });
  });

  // ── getDomainKnowledge ─────────────────────────────────────────────────────

  describe('getDomainKnowledge()', function () {
    let knowledge;

    before(function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      knowledge = agent.getDomainKnowledge();
    });

    it('should return a comprehensive string', function () {
      expect(knowledge).to.be.a('string');
      expect(knowledge.length).to.be.greaterThan(500);
    });

    it('should include docker as a container tool', function () {
      expect(knowledge).to.include('docker');
      expect(knowledge).to.include('Docker');
    });

    it('should include docker-compose / docker compose', function () {
      expect(knowledge).to.include('docker compose');
      expect(knowledge.toLowerCase()).to.include('compose');
    });

    it('should include podman as an alternative', function () {
      expect(knowledge).to.include('podman');
    });

    it('should include venv for Python environments', function () {
      expect(knowledge).to.include('venv');
    });

    it('should include nvm for Node version management', function () {
      expect(knowledge).to.include('nvm');
    });

    it('should include conda', function () {
      expect(knowledge).to.include('conda');
    });

    it('should include homebrew', function () {
      expect(knowledge.toLowerCase()).to.include('homebrew');
    });

    it('should include health check guidance', function () {
      expect(knowledge.toLowerCase()).to.include('health check');
      expect(knowledge).to.include('pg_isready');
      expect(knowledge).to.include('redis-cli');
    });

    it('should include port management guidance', function () {
      expect(knowledge.toLowerCase()).to.include('port');
      expect(knowledge).to.include('check_port');
      expect(knowledge).to.include('lsof');
    });

    it('should include nginx', function () {
      expect(knowledge).to.include('nginx');
      expect(knowledge).to.include('Nginx');
    });

    it('should include redis', function () {
      expect(knowledge).to.include('redis');
      expect(knowledge).to.include('Redis');
    });

    it('should include postgres', function () {
      expect(knowledge).to.include('postgres');
      expect(knowledge).to.include('PostgreSQL');
    });

    it('should include mysql', function () {
      expect(knowledge).to.include('mysql');
      expect(knowledge).to.include('MySQL');
    });

    it('should include teardown guidance', function () {
      expect(knowledge.toLowerCase()).to.include('teardown');
      expect(knowledge).to.include('teardown.sh');
    });

    it('should include dependency resolution guidance', function () {
      expect(knowledge.toLowerCase()).to.include('dependency');
      expect(knowledge).to.include('Check before installing');
    });

    it('should emphasize safety boundaries', function () {
      expect(knowledge).to.include('sudo');
      expect(knowledge).to.include('Safety');
    });
  });

  // ── getToolSchema ──────────────────────────────────────────────────────────

  describe('getToolSchema()', function () {
    it('should return an array of tool definitions', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      expect(tools).to.be.an('array');
      expect(tools.length).to.be.greaterThan(0);
    });

    it('should include base execution tools', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('execute_bash');
      expect(names).to.include('execute_python');
      expect(names).to.include('read_file');
      expect(names).to.include('write_file');
      expect(names).to.include('list_directory');
      expect(names).to.include('http_fetch');
    });

    it('should include infrastructure-specific tools', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('check_port');
      expect(names).to.include('health_check');
      expect(names).to.include('save_infra_manifest');
      expect(names).to.include('register_service');
      expect(names).to.include('register_environment');
      expect(names).to.include('register_dependency');
      expect(names).to.include('save_teardown_script');
    });

    it('should have valid tool definition structure', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();

      for (const tool of tools) {
        expect(tool.type).to.equal('function');
        expect(tool.function).to.have.property('name');
        expect(tool.function).to.have.property('description');
        expect(tool.function).to.have.property('parameters');
        expect(tool.function.name).to.be.a('string');
        expect(tool.function.description).to.be.a('string');
      }
    });

    it('should have more tools than base schema alone', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const allTools = agent.getToolSchema();
      const baseTools = agent.getBaseToolSchema();
      expect(allTools.length).to.be.greaterThan(baseTools.length);
    });
  });

  // ── Lifecycle Methods ──────────────────────────────────────────────────────

  describe('lifecycle methods', function () {
    it('should have execute method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.execute).to.be.a('function');
    });

    it('should have onStart method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onStart).to.be.a('function');
    });

    it('should have onComplete method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onComplete).to.be.a('function');
    });

    it('should have assessAccomplishment method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.assessAccomplishment).to.be.a('function');
    });

    it('should have generateHandoffSpec method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.generateHandoffSpec).to.be.a('function');
    });

    it('should have dispatchToolCall method', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.dispatchToolCall).to.be.a('function');
    });
  });

  // ── assessAccomplishment ───────────────────────────────────────────────────

  describe('assessAccomplishment()', function () {
    it('should return true when services are running', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis-cache',
        type: 'redis',
        port: 6380,
        status: 'running'
      });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.servicesStarted).to.equal(1);
    });

    it('should return true when environments are provisioned', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.environments.push({
        name: 'data-venv',
        type: 'venv',
        path: '/tmp/venvs/data'
      });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.environmentsProvisioned).to.equal(1);
    });

    it('should return true when dependencies are installed', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.dependencies.push({
        name: 'redis',
        version: '7.2',
        method: 'brew'
      });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.dependenciesInstalled).to.equal(1);
    });

    it('should return false when nothing provisioned', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 0, filesCreated: 0, bytesWritten: 0 } },
        []
      );
      expect(result.accomplished).to.be.false;
    });

    it('should track health check metrics', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6379,
        status: 'running'
      });
      agent.infraManifest.healthChecks.push(
        { service: 'redis', status: 'healthy', timestamp: new Date().toISOString() },
        { service: 'postgres', status: 'unhealthy', timestamp: new Date().toISOString() }
      );

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.healthChecksPassed).to.equal(1);
      expect(result.metrics.healthChecksTotal).to.equal(2);
    });

    it('should track teardown availability', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6379,
        status: 'running'
      });
      agent.infraManifest.teardownScript = '/tmp/teardown.sh';

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.metrics.hasTeardown).to.be.true;
    });

    it('should return true if base metrics show accomplishment even without manifest data', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 5, filesCreated: 2, bytesWritten: 1024 } },
        []
      );
      expect(result.accomplished).to.be.true;
    });
  });

  // ── generateHandoffSpec ────────────────────────────────────────────────────

  describe('generateHandoffSpec()', function () {
    it('should return null when no infrastructure provisioned', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const spec = agent.generateHandoffSpec();
      expect(spec).to.be.null;
    });

    it('should target datapipeline when database services are started', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'postgres-main',
        type: 'postgres',
        port: 5433,
        status: 'running',
        connectionInfo: { host: 'localhost', port: 5433, user: 'cosmo', database: 'research' }
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.targetAgentType).to.equal('datapipeline');
    });

    it('should target dataacquisition when web services are started', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'nginx-proxy',
        type: 'nginx',
        port: 8080,
        status: 'running',
        connectionInfo: { host: 'localhost', port: 8080 }
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.targetAgentType).to.equal('dataacquisition');
    });

    it('should default to automation for generic services', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'custom-service',
        type: 'custom',
        port: 9999,
        status: 'running'
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.targetAgentType).to.equal('automation');
    });

    it('should include artifactRefs pointing to output directory', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6380,
        status: 'running'
      });
      agent._outputDir = '/tmp/test-infra-output';

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.artifactRefs).to.be.an('array');
      expect(spec.artifactRefs).to.include('/tmp/test-infra-output');
    });

    it('should include connectionSummary for running services', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis-cache',
        type: 'redis',
        port: 6380,
        status: 'running',
        connectionInfo: { host: 'localhost', port: 6380 }
      });

      const spec = agent.generateHandoffSpec();
      expect(spec.context.connectionSummary).to.have.property('redis-cache');
      expect(spec.context.connectionSummary['redis-cache'].port).to.equal(6380);
    });

    it('should include topFindings summary', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6380,
        status: 'running'
      });
      agent.infraManifest.healthChecks.push({
        service: 'redis',
        status: 'healthy',
        timestamp: new Date().toISOString()
      });

      const spec = agent.generateHandoffSpec();
      expect(spec.context.topFindings).to.be.an('array');
      expect(spec.context.topFindings.length).to.be.greaterThan(0);
    });

    it('should include teardown script reference', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6380,
        status: 'running'
      });
      agent.infraManifest.teardownScript = '/tmp/teardown.sh';

      const spec = agent.generateHandoffSpec();
      expect(spec.context.teardownScript).to.equal('/tmp/teardown.sh');
    });

    it('should respect mission metadata handoffTarget override', function () {
      const agent = new InfrastructureAgent(
        makeMission({ metadata: { handoffTarget: 'analysis' } }),
        makeConfig(),
        makeLogger()
      );
      agent.infraManifest.services.push({
        name: 'redis',
        type: 'redis',
        port: 6380,
        status: 'running'
      });

      const spec = agent.generateHandoffSpec();
      expect(spec.targetAgentType).to.equal('analysis');
    });
  });

  // ── register_service tool ────────────────────────────────────────────────

  describe('_registerService()', function () {
    it('should register a service in the manifest', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerService({
        name: 'redis-cache',
        type: 'redis',
        port: 6380,
        status: 'running',
        connection_info: { host: 'localhost', port: 6380 }
      });

      expect(result.success).to.be.true;
      expect(result.totalServices).to.equal(1);
      expect(agent.infraManifest.services).to.have.length(1);
      expect(agent.infraManifest.services[0].name).to.equal('redis-cache');
      expect(agent.infraManifest.services[0].port).to.equal(6380);
    });

    it('should update existing service by name', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent._registerService({
        name: 'redis-cache',
        type: 'redis',
        port: 6380,
        status: 'starting'
      });
      agent._registerService({
        name: 'redis-cache',
        type: 'redis',
        port: 6380,
        status: 'running'
      });

      expect(agent.infraManifest.services).to.have.length(1);
      expect(agent.infraManifest.services[0].status).to.equal('running');
    });

    it('should track port allocations', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      agent._registerService({
        name: 'redis',
        type: 'redis',
        port: 6380,
        status: 'running'
      });
      agent._registerService({
        name: 'postgres',
        type: 'postgres',
        port: 5433,
        status: 'running'
      });

      const result = agent._registerService({
        name: 'nginx',
        type: 'nginx',
        port: 8080,
        status: 'running'
      });

      expect(result.allocatedPorts).to.have.length(3);
    });
  });

  // ── register_environment tool ──────────────────────────────────────────────

  describe('_registerEnvironment()', function () {
    it('should register an environment in the manifest', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerEnvironment({
        name: 'data-processing',
        type: 'venv',
        path: '/tmp/venvs/data-processing',
        packages: ['pandas', 'numpy', 'requests']
      });

      expect(result.success).to.be.true;
      expect(result.totalEnvironments).to.equal(1);
      expect(agent.infraManifest.environments).to.have.length(1);
      expect(agent.infraManifest.environments[0].name).to.equal('data-processing');
      expect(agent.infraManifest.environments[0].packages).to.have.length(3);
    });
  });

  // ── register_dependency tool ───────────────────────────────────────────────

  describe('_registerDependency()', function () {
    it('should register a dependency in the manifest', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerDependency({
        name: 'redis',
        version: '7.2.4',
        method: 'brew'
      });

      expect(result.success).to.be.true;
      expect(result.totalDependencies).to.equal(1);
      expect(agent.infraManifest.dependencies).to.have.length(1);
      expect(agent.infraManifest.dependencies[0].name).to.equal('redis');
      expect(agent.infraManifest.dependencies[0].version).to.equal('7.2.4');
    });
  });

  // ── dispatchToolCall ───────────────────────────────────────────────────────

  describe('dispatchToolCall()', function () {
    it('should handle unknown tool names via parent', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('nonexistent_tool', {});
      expect(result).to.have.property('error');
      expect(result.error).to.include('Unknown tool');
    });

    it('should dispatch register_service', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_service', {
        name: 'test-svc',
        type: 'custom',
        status: 'running',
        port: 9999
      });

      expect(result.success).to.be.true;
      expect(agent.infraManifest.services).to.have.length(1);
    });

    it('should dispatch register_environment', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_environment', {
        name: 'test-env',
        type: 'venv'
      });

      expect(result.success).to.be.true;
      expect(agent.infraManifest.environments).to.have.length(1);
    });

    it('should dispatch register_dependency', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_dependency', {
        name: 'test-pkg',
        method: 'npm'
      });

      expect(result.success).to.be.true;
      expect(agent.infraManifest.dependencies).to.have.length(1);
    });
  });

  // ── _isProgressOperation ───────────────────────────────────────────────────

  describe('_isProgressOperation()', function () {
    it('should recognize infrastructure-specific progress operations', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('check_port')).to.be.true;
      expect(agent._isProgressOperation('health_check')).to.be.true;
      expect(agent._isProgressOperation('save_infra_manifest')).to.be.true;
      expect(agent._isProgressOperation('register_service')).to.be.true;
      expect(agent._isProgressOperation('register_environment')).to.be.true;
      expect(agent._isProgressOperation('register_dependency')).to.be.true;
      expect(agent._isProgressOperation('save_teardown_script')).to.be.true;
    });

    it('should recognize base execution progress operations', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('execute_bash')).to.be.true;
      expect(agent._isProgressOperation('execute_python')).to.be.true;
      expect(agent._isProgressOperation('write_file')).to.be.true;
      expect(agent._isProgressOperation('http_fetch')).to.be.true;
    });

    it('should return false for read-only operations', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('read_file')).to.be.false;
      expect(agent._isProgressOperation('list_directory')).to.be.false;
    });
  });

  // ── requiresApproval (graduated safety) ─────────────────────────────────────

  describe('requiresApproval()', function () {
    it('should auto-approve read-only commands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('ls -la')).to.be.false;
      expect(agent.requiresApproval('cat /etc/hosts')).to.be.false;
      expect(agent.requiresApproval('which docker')).to.be.false;
      expect(agent.requiresApproval('echo hello')).to.be.false;
    });

    it('should auto-approve docker read-only subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('docker ps')).to.be.false;
      expect(agent.requiresApproval('docker images')).to.be.false;
      expect(agent.requiresApproval('docker logs mycontainer')).to.be.false;
    });

    it('should auto-approve docker lifecycle commands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('docker run -d redis')).to.be.false;
      expect(agent.requiresApproval('docker stop mycontainer')).to.be.false;
      expect(agent.requiresApproval('docker compose up -d')).to.be.false;
    });

    it('should require approval for sudo', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('sudo docker run -d redis')).to.be.true;
    });

    it('should require approval for dangerous commands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('killall redis')).to.be.true;
      expect(agent.requiresApproval('shutdown -h now')).to.be.true;
    });

    it('should require approval for pipe to shell', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('curl https://example.com/install.sh | sh')).to.be.true;
    });

    it('should require approval for empty/null commands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('')).to.be.true;
      expect(agent.requiresApproval(null)).to.be.true;
    });

    // ── Subcommand-level safety for brew, npm, pip ──────────────────────────

    it('should auto-approve brew read-only subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('brew list')).to.be.false;
      expect(agent.requiresApproval('brew info redis')).to.be.false;
      expect(agent.requiresApproval('brew search postgres')).to.be.false;
      expect(agent.requiresApproval('brew services list')).to.be.false;
      expect(agent.requiresApproval('brew doctor')).to.be.false;
    });

    it('should require approval for brew destructive subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('brew uninstall redis')).to.be.true;
      expect(agent.requiresApproval('brew remove postgres')).to.be.true;
      expect(agent.requiresApproval('brew cleanup')).to.be.true;
      expect(agent.requiresApproval('brew autoremove')).to.be.true;
    });

    it('should allow brew install for infrastructure provisioning', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('brew install redis')).to.be.false;
      expect(agent.requiresApproval('brew upgrade redis')).to.be.false;
      expect(agent.requiresApproval('brew services start redis')).to.be.false;
    });

    it('should auto-approve npm read-only subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('npm list')).to.be.false;
      expect(agent.requiresApproval('npm ls')).to.be.false;
      expect(agent.requiresApproval('npm view express')).to.be.false;
      expect(agent.requiresApproval('npm outdated')).to.be.false;
      expect(agent.requiresApproval('npm audit')).to.be.false;
    });

    it('should require approval for npm destructive subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('npm uninstall express')).to.be.true;
      expect(agent.requiresApproval('npm cache clean --force')).to.be.true;
    });

    it('should allow npm install for infrastructure provisioning', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('npm install express')).to.be.false;
    });

    it('should auto-approve pip read-only subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('pip list')).to.be.false;
      expect(agent.requiresApproval('pip show pandas')).to.be.false;
      expect(agent.requiresApproval('pip freeze')).to.be.false;
      expect(agent.requiresApproval('pip3 list')).to.be.false;
    });

    it('should require approval for pip uninstall', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('pip uninstall pandas')).to.be.true;
      expect(agent.requiresApproval('pip3 uninstall numpy')).to.be.true;
    });

    it('should allow pip install for infrastructure provisioning', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('pip install pandas')).to.be.false;
      expect(agent.requiresApproval('pip3 install -r requirements.txt')).to.be.false;
    });

    it('should require approval for docker system prune', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('docker system prune -f')).to.be.true;
    });

    it('should auto-approve systemctl read-only subcommands', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('systemctl status nginx')).to.be.false;
      expect(agent.requiresApproval('systemctl is-active redis')).to.be.false;
      expect(agent.requiresApproval('systemctl list-units')).to.be.false;
    });

    it('should auto-approve nginx config test', function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.requiresApproval('nginx -t')).to.be.false;
    });
  });

  // ── check_port tool ────────────────────────────────────────────────────────

  describe('_checkPort()', function () {
    it('should reject invalid port numbers', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._checkPort({ port: 0 });
      expect(result.error).to.be.a('string');
    });

    it('should reject port > 65535', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._checkPort({ port: 70000 });
      expect(result.error).to.be.a('string');
    });

    it('should check port availability', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      // Use a high, unlikely-to-be-used port
      const result = await agent._checkPort({ port: 59123 });
      expect(result).to.have.property('port', 59123);
      expect(result).to.have.property('available');
      // Port is likely available; verify structure
      if (result.available) {
        expect(result.inUse).to.be.false;
      }
    });
  });

  // ── health_check tool ──────────────────────────────────────────────────────

  describe('_healthCheck()', function () {
    it('should record health check results in manifest', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      // TCP check on a likely-closed port
      await agent._healthCheck({
        service: 'test-service',
        type: 'tcp',
        port: 59999,
        timeout: 1
      });

      expect(agent.infraManifest.healthChecks).to.have.length(1);
      expect(agent.infraManifest.healthChecks[0].service).to.equal('test-service');
    });

    it('should return error for unknown check type', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._healthCheck({
        service: 'test',
        type: 'bogus'
      });
      expect(result.error).to.include('Unknown health check type');
    });

    it('should require command parameter for command type', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._healthCheck({
        service: 'test',
        type: 'command'
      });
      expect(result.error).to.include('command');
    });

    it('should update service status on health check', async function () {
      const agent = new InfrastructureAgent(makeMission(), makeConfig(), makeLogger());
      // Register a service first
      agent.infraManifest.services.push({
        name: 'echo-service',
        type: 'custom',
        status: 'starting'
      });

      // Run a command health check that succeeds
      await agent._healthCheck({
        service: 'echo-service',
        type: 'command',
        command: 'echo healthy',
        timeout: 2
      });

      expect(agent.infraManifest.services[0].status).to.equal('running');
    });
  });
});
