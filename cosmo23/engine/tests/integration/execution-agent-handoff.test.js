const { expect } = require('chai');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Set dummy OPENAI_API_KEY before any agent module is required.
// Agent constructors create a UnifiedClient which requires the key at init,
// but these structural tests never make actual API calls.
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-structural-only-no-api-calls';
}

describe('Execution Agent Handoff Chain', function() {
  this.timeout(30000);

  const logger = { info: ()=>{}, warn: ()=>{}, error: ()=>{}, debug: ()=>{} };
  const config = {
    logsDir: os.tmpdir(),
    architecture: { memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } } }
  };

  describe('DataAcquisition → DataPipeline handoff', function() {

    it('DataAcquisitionAgent produces handoff targeting datapipeline', function() {
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const mission = {
        goalId: 'test_acq',
        description: 'Scrape product data',
        agentType: 'dataacquisition',
        successCriteria: ['Data acquired'],
        maxDuration: 1800000
      };
      const agent = new DataAcquisitionAgent(mission, config, logger);

      // Simulate successful acquisition
      agent.acquisitionManifest = {
        sources: [{ url: 'https://example.com', status: 200 }],
        pagesAcquired: 50,
        filesDownloaded: 50,
        bytesAcquired: 1024000,
        discoveredSchema: { fields: ['title', 'price', 'url'] },
        errors: [],
        outputDir: '/tmp/test-acquisition'
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('datapipeline');
      expect(handoff.artifactRefs).to.be.an('array');
      // discoveredSchema is nested in context
      expect(handoff.context.discoveredSchema).to.exist;
      expect(handoff.context.discoveredSchema.fields).to.deep.equal(['title', 'price', 'url']);
    });

    it('DataPipelineAgent produces handoff targeting analysis', function() {
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const mission = {
        goalId: 'test_pipe',
        description: 'Build database from scraped data',
        agentType: 'datapipeline',
        successCriteria: ['Database created'],
        maxDuration: 1200000
      };
      const agent = new DataPipelineAgent(mission, config, logger);

      // Simulate successful pipeline — exports are objects with .path
      agent.pipelineManifest = {
        inputSources: ['/tmp/raw-data'],
        database: '/tmp/test.sqlite',
        tables: [{ name: 'products', rowCount: 500, columns: [{ name: 'title', type: 'TEXT' }, { name: 'price', type: 'REAL' }] }],
        transforms: [],
        validationResults: null,
        exports: [{ path: '/tmp/products.csv', format: 'csv' }],
        dataProfile: { rowCount: 500, columnCount: 3 },
        startedAt: null,
        completedAt: null
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('analysis');
      expect(handoff.artifactRefs).to.be.an('array');
      expect(handoff.artifactRefs).to.include('/tmp/test.sqlite');
    });

    it('handoff chain has compatible artifact contracts', function() {
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');

      const acqAgent = new DataAcquisitionAgent(
        { goalId: 'acq1', description: 'Scrape', agentType: 'dataacquisition', successCriteria: ['done'], maxDuration: 1800000 },
        config, logger
      );
      const pipeAgent = new DataPipelineAgent(
        { goalId: 'pipe1', description: 'Transform', agentType: 'datapipeline', successCriteria: ['done'], maxDuration: 1200000 },
        config, logger
      );

      // Set _outputDir directly (normally set in onStart, skipped for structural tests)
      acqAgent._outputDir = '/tmp/acq-output';

      // DataAcquisition output contract
      acqAgent.acquisitionManifest = {
        sources: [{ url: 'https://example.com', status: 200 }],
        pagesAcquired: 10,
        filesDownloaded: 10,
        bytesAcquired: 50000,
        discoveredSchema: { fields: ['name', 'value'] },
        errors: []
      };

      const acqHandoff = acqAgent.generateHandoffSpec();

      // The handoff spec should contain enough for DataPipeline to start
      expect(acqHandoff.targetAgentType).to.equal('datapipeline');
      expect(acqHandoff.artifactRefs).to.be.an('array');
      // DataPipeline should be able to consume the discovered schema from context
      expect(acqHandoff.context.discoveredSchema).to.exist;
      expect(acqHandoff.context.discoveredSchema.fields).to.be.an('array').with.length.greaterThan(0);
      // Should include output directory for downstream agent to find files
      expect(acqHandoff.context.outputDir).to.equal('/tmp/acq-output');
      // Should include manifest summary for pipeline planning
      expect(acqHandoff.context.manifest).to.exist;
      expect(acqHandoff.context.manifest.pagesAcquired).to.equal(10);
    });

    it('all execution agents register with correct type keys', function() {
      const { AutomationAgent } = require('../../src/agents/automation-agent');
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');

      const mission = { goalId: 'test', description: 'test', agentType: 'test', successCriteria: ['test'], maxDuration: 900000 };

      expect(new AutomationAgent(mission, config, logger).getAgentType()).to.equal('automation');
      expect(new DataAcquisitionAgent(mission, config, logger).getAgentType()).to.equal('dataacquisition');
      expect(new DataPipelineAgent(mission, config, logger).getAgentType()).to.equal('datapipeline');
      expect(new InfrastructureAgent(mission, config, logger).getAgentType()).to.equal('infrastructure');
    });

    it('all execution agents have extended timeouts', function() {
      const { AutomationAgent } = require('../../src/agents/automation-agent');
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');

      const shortMission = { goalId: 'test', description: 'test', agentType: 'test', successCriteria: ['test'], maxDuration: 60000 };

      // All should enforce at least 15 minutes regardless of mission duration
      expect(new AutomationAgent(shortMission, config, logger).mission.maxDuration).to.be.at.least(900000);
      expect(new DataAcquisitionAgent(shortMission, config, logger).mission.maxDuration).to.be.at.least(900000);
      expect(new DataPipelineAgent(shortMission, config, logger).mission.maxDuration).to.be.at.least(900000);
      expect(new InfrastructureAgent(shortMission, config, logger).mission.maxDuration).to.be.at.least(900000);
    });

    it('DataAcquisitionAgent returns null handoff when nothing acquired', function() {
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const mission = { goalId: 'empty', description: 'Empty run', agentType: 'dataacquisition', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new DataAcquisitionAgent(mission, config, logger);

      // Default manifest has zero counts
      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.be.null;
    });

    it('DataPipelineAgent returns null handoff when nothing produced', function() {
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const mission = { goalId: 'empty', description: 'Empty run', agentType: 'datapipeline', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new DataPipelineAgent(mission, config, logger);

      // Default manifest has no database/tables/exports
      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.be.null;
    });

    it('InfrastructureAgent returns null handoff when nothing provisioned', function() {
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');
      const mission = { goalId: 'empty', description: 'Empty run', agentType: 'infrastructure', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new InfrastructureAgent(mission, config, logger);

      // Default manifest has no services/environments
      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.be.null;
    });

    it('InfrastructureAgent hands off to datapipeline for database services', function() {
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');
      const mission = { goalId: 'infra_db', description: 'Set up postgres', agentType: 'infrastructure', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new InfrastructureAgent(mission, config, logger);

      agent.infraManifest = {
        services: [{ name: 'postgres', type: 'postgres', port: 5432, status: 'running', connectionInfo: { host: 'localhost', user: 'cosmo' } }],
        environments: [],
        dependencies: [],
        teardownScript: '/tmp/teardown.sh',
        healthChecks: [{ service: 'postgres', status: 'healthy', timestamp: Date.now() }],
        startedAt: Date.now(),
        completedAt: null
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('datapipeline');
      expect(handoff.context.connectionSummary).to.have.property('postgres');
      expect(handoff.context.connectionSummary.postgres.port).to.equal(5432);
    });

    it('InfrastructureAgent hands off to dataacquisition for web services', function() {
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');
      const mission = { goalId: 'infra_web', description: 'Set up nginx', agentType: 'infrastructure', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new InfrastructureAgent(mission, config, logger);

      agent.infraManifest = {
        services: [{ name: 'nginx', type: 'nginx', port: 8080, status: 'running', connectionInfo: { host: 'localhost' } }],
        environments: [],
        dependencies: [],
        teardownScript: null,
        healthChecks: [],
        startedAt: Date.now(),
        completedAt: null
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('dataacquisition');
    });

    it('AutomationAgent hands off to datapipeline when producing data files', function() {
      const { AutomationAgent } = require('../../src/agents/automation-agent');
      const mission = { goalId: 'auto_data', description: 'Scrape with curl', agentType: 'automation', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new AutomationAgent(mission, config, logger);

      // Simulate audit log with data-producing commands
      agent.auditLog = [
        { operation: 'executeBash', args: { command: 'curl -o data.json https://api.example.com/data' }, success: true },
        { operation: 'writeFile', args: { path: '/tmp/output.csv' }, success: true }
      ];

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('datapipeline');
    });

    it('AutomationAgent hands off to analysis when running analysis commands', function() {
      const { AutomationAgent } = require('../../src/agents/automation-agent');
      const mission = { goalId: 'auto_analyze', description: 'Audit directory', agentType: 'automation', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new AutomationAgent(mission, config, logger);

      // Simulate audit log with analysis-only commands
      agent.auditLog = [
        { operation: 'executeBash', args: { command: 'find /var/log -name "*.log" -mtime +30' }, success: true },
        { operation: 'executeBash', args: { command: 'du -sh /var/log/*' }, success: true }
      ];

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('analysis');
    });

    it('DataPipelineAgent handoff includes schema and data profile', function() {
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const mission = { goalId: 'pipe_schema', description: 'ETL with schema', agentType: 'datapipeline', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new DataPipelineAgent(mission, config, logger);

      agent.pipelineManifest = {
        inputSources: ['/tmp/raw'],
        database: '/tmp/analytics.sqlite',
        tables: [
          { name: 'users', rowCount: 1000, columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] },
          { name: 'orders', rowCount: 5000, columns: [{ name: 'id', type: 'INTEGER' }, { name: 'user_id', type: 'INTEGER' }, { name: 'total', type: 'REAL' }] }
        ],
        transforms: [{ name: 'normalize_names', type: 'python' }],
        validationResults: { passed: true, checks: [{ name: 'row_count', status: 'ok' }] },
        exports: [{ path: '/tmp/users.csv', format: 'csv' }, { path: '/tmp/orders.json', format: 'json' }],
        dataProfile: { rowCount: 6000, columnCount: 5, format: 'sqlite', tool: 'sqlite3' },
        startedAt: null,
        completedAt: null
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;
      expect(handoff.targetAgentType).to.equal('analysis');

      // Schema should have entries for both tables
      expect(handoff.context.schema).to.have.property('users');
      expect(handoff.context.schema).to.have.property('orders');
      expect(handoff.context.schema.users.rowCount).to.equal(1000);
      expect(handoff.context.schema.orders.columns).to.have.length(3);

      // Data profile should be included
      expect(handoff.context.dataProfile).to.exist;
      expect(handoff.context.dataProfile.rowCount).to.equal(6000);

      // Total row count aggregated
      expect(handoff.context.rowCount).to.equal(6000);

      // Artifacts should include database and exports
      expect(handoff.artifactRefs).to.include('/tmp/analytics.sqlite');
      expect(handoff.artifactRefs).to.include('/tmp/users.csv');
      expect(handoff.artifactRefs).to.include('/tmp/orders.json');
    });

    it('DataAcquisitionAgent handoff includes source URLs and manifest summary', function() {
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const mission = { goalId: 'acq_sources', description: 'Multi-source scrape', agentType: 'dataacquisition', successCriteria: ['done'], maxDuration: 900000 };
      const agent = new DataAcquisitionAgent(mission, config, logger);

      agent.acquisitionManifest = {
        sources: [
          { url: 'https://api.example.com/products', status: 200 },
          { url: 'https://api.example.com/categories', status: 200 },
          { url: 'https://api.example.com/broken', status: 500 }
        ],
        pagesAcquired: 25,
        filesDownloaded: 2,
        bytesAcquired: 512000,
        discoveredSchema: { fields: ['id', 'name', 'category', 'price'] },
        errors: [{ url: 'https://api.example.com/broken', error: 'Server error' }],
        outputDir: '/tmp/multi-source'
      };

      const handoff = agent.generateHandoffSpec();
      expect(handoff).to.not.be.null;

      // Source URLs filtered to successful only (status 200-399)
      expect(handoff.context.sourceUrls).to.be.an('array');
      expect(handoff.context.sourceUrls).to.have.length(2);
      expect(handoff.context.sourceUrls).to.not.include('https://api.example.com/broken');

      // Manifest summary
      expect(handoff.context.manifest.pagesAcquired).to.equal(25);
      expect(handoff.context.manifest.filesDownloaded).to.equal(2);
      expect(handoff.context.manifest.errors).to.equal(1);
      expect(handoff.context.manifest.sourcesContacted).to.equal(3);
    });

    it('full chain: Infrastructure → DataAcquisition → DataPipeline → Analysis', function() {
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');

      // Step 1: Infrastructure provisions a database
      const infraAgent = new InfrastructureAgent(
        { goalId: 'chain_infra', description: 'Set up postgres', agentType: 'infrastructure', successCriteria: ['done'], maxDuration: 900000 },
        config, logger
      );
      infraAgent._outputDir = '/tmp/chain/infrastructure';
      infraAgent.infraManifest = {
        services: [{ name: 'postgres', type: 'postgres', port: 5433, status: 'running', connectionInfo: { host: 'localhost', user: 'cosmo', database: 'research' } }],
        environments: [],
        dependencies: ['postgresql'],
        teardownScript: '/tmp/chain/teardown.sh',
        healthChecks: [{ service: 'postgres', status: 'healthy', timestamp: Date.now() }],
        startedAt: Date.now(),
        completedAt: null
      };

      const infraHandoff = infraAgent.generateHandoffSpec();
      expect(infraHandoff.targetAgentType).to.equal('datapipeline');

      // Step 2: DataAcquisition scrapes data
      const acqAgent = new DataAcquisitionAgent(
        { goalId: 'chain_acq', description: 'Scrape product catalog', agentType: 'dataacquisition', successCriteria: ['done'], maxDuration: 1800000 },
        config, logger
      );
      acqAgent._outputDir = '/tmp/chain/acquisition';
      acqAgent.acquisitionManifest = {
        sources: [{ url: 'https://shop.example.com/products', status: 200 }],
        pagesAcquired: 100,
        filesDownloaded: 100,
        bytesAcquired: 5000000,
        discoveredSchema: { fields: ['id', 'name', 'price', 'category', 'description', 'image_url'] },
        errors: []
      };

      const acqHandoff = acqAgent.generateHandoffSpec();
      expect(acqHandoff.targetAgentType).to.equal('datapipeline');
      expect(acqHandoff.context.discoveredSchema.fields).to.have.length(6);

      // Step 3: DataPipeline transforms and loads — consuming acquisition output
      const pipeAgent = new DataPipelineAgent(
        { goalId: 'chain_pipe', description: 'Transform and load products', agentType: 'datapipeline', successCriteria: ['done'], maxDuration: 1200000 },
        config, logger
      );
      pipeAgent._outputDir = '/tmp/chain/pipeline';
      pipeAgent.pipelineManifest = {
        inputSources: [acqHandoff.context.outputDir],
        database: '/tmp/chain/products.sqlite',
        tables: [
          { name: 'products', rowCount: 100, columns: acqHandoff.context.discoveredSchema.fields.map(f => ({ name: f, type: 'TEXT' })) }
        ],
        transforms: [{ name: 'clean_prices', type: 'jq' }],
        validationResults: { passed: true, checks: [{ name: 'row_count', status: 'ok' }] },
        exports: [{ path: '/tmp/chain/products.csv', format: 'csv' }],
        dataProfile: { rowCount: 100, columnCount: 6, format: 'sqlite', tool: 'sqlite3' },
        startedAt: null,
        completedAt: null
      };

      const pipeHandoff = pipeAgent.generateHandoffSpec();
      expect(pipeHandoff.targetAgentType).to.equal('analysis');

      // Validate the chain is coherent:
      // - Infrastructure targets datapipeline
      // - Acquisition targets datapipeline
      // - Pipeline targets analysis
      // - Each step's output directory can feed into the next
      expect(infraHandoff.context.connectionSummary.postgres).to.exist;
      expect(acqHandoff.context.outputDir).to.equal('/tmp/chain/acquisition');
      expect(pipeHandoff.context.schema.products.rowCount).to.equal(100);
      expect(pipeHandoff.context.dataProfile.columnCount).to.equal(6);

      // Verify the pipeline consumed what acquisition produced
      expect(pipeAgent.pipelineManifest.inputSources[0]).to.equal(acqHandoff.context.outputDir);
    });

    it('all execution agents have required lifecycle methods', function() {
      const { AutomationAgent } = require('../../src/agents/automation-agent');
      const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
      const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
      const { InfrastructureAgent } = require('../../src/agents/infrastructure-agent');

      const mission = { goalId: 'test', description: 'test', agentType: 'test', successCriteria: ['test'], maxDuration: 900000 };

      const agents = [
        new AutomationAgent(mission, config, logger),
        new DataAcquisitionAgent(mission, config, logger),
        new DataPipelineAgent(mission, config, logger),
        new InfrastructureAgent(mission, config, logger)
      ];

      for (const agent of agents) {
        const type = agent.getAgentType();
        expect(agent.execute, `${type} must have execute()`).to.be.a('function');
        expect(agent.onStart, `${type} must have onStart()`).to.be.a('function');
        expect(agent.generateHandoffSpec, `${type} must have generateHandoffSpec()`).to.be.a('function');
        expect(agent.getDomainKnowledge, `${type} must have getDomainKnowledge()`).to.be.a('function');
        expect(agent.getToolSchema, `${type} must have getToolSchema()`).to.be.a('function');
        expect(agent.assessAccomplishment, `${type} must have assessAccomplishment()`).to.be.a('function');

        // Domain knowledge should be non-empty
        const knowledge = agent.getDomainKnowledge();
        expect(knowledge, `${type} domain knowledge must be non-empty`).to.be.a('string').with.length.greaterThan(100);

        // Tool schema should include base tools plus domain-specific
        const tools = agent.getToolSchema();
        expect(tools, `${type} must have tool schema`).to.be.an('array').with.length.greaterThan(0);
      }
    });
  });
});
