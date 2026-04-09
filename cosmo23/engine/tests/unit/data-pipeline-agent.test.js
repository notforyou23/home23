const { expect } = require('chai');
const path = require('path');
const os = require('os');

// BaseAgent → UnifiedClient → GPT5Client → openai-client.js requires OPENAI_API_KEY
// at construction time. Set a dummy key so the client can be instantiated (no actual
// API calls are made in these tests).
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-unit-tests';
}

const { DataPipelineAgent } = require('../../src/agents/data-pipeline-agent');
const { ExecutionBaseAgent } = require('../../src/agents/execution-base-agent');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeLogger = () => ({
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {}
});

const makeMission = (overrides = {}) => ({
  goalId: 'test_pipeline',
  description: 'Transform acquired product data into a queryable SQLite database',
  agentType: 'datapipeline',
  successCriteria: ['Database created with all product records loaded'],
  maxDuration: 600000,
  ...overrides
});

const makeConfig = (overrides = {}) => ({
  logsDir: path.join(os.tmpdir(), `cosmo-dpipe-test-${Date.now()}`),
  architecture: {
    memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } }
  },
  ...overrides
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('DataPipelineAgent', function () {

  // ── Instantiation ──────────────────────────────────────────────────────────

  describe('instantiation', function () {
    it('should instantiate with datapipeline type', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent).to.be.instanceOf(DataPipelineAgent);
      expect(agent).to.be.instanceOf(ExecutionBaseAgent);
      expect(agent.getAgentType()).to.equal('datapipeline');
    });

    it('should have agentId matching base-agent format', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.agentId).to.match(/^agent_\d+_[a-z0-9]+$/);
    });

    it('should start with initialized status', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.status).to.equal('initialized');
    });

    it('should accept mission with datapipeline agentType', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.mission.description).to.equal('Transform acquired product data into a queryable SQLite database');
      expect(agent.mission.goalId).to.equal('test_pipeline');
    });
  });

  // ── pipelineManifest structure ─────────────────────────────────────────────

  describe('pipelineManifest', function () {
    it('should be initialized with correct structure', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const manifest = agent.pipelineManifest;

      expect(manifest).to.have.property('inputSources').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('database', null);
      expect(manifest).to.have.property('tables').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('transforms').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('validationResults', null);
      expect(manifest).to.have.property('exports').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('dataProfile', null);
      expect(manifest).to.have.property('startedAt', null);
      expect(manifest).to.have.property('completedAt', null);
    });
  });

  // ── Extended timeout ────────────────────────────────────────────────────────

  describe('extended timeout', function () {
    it('should enforce minimum 15-minute timeout', function () {
      const agent = new DataPipelineAgent(
        makeMission({ maxDuration: 60000 }),  // 1 minute
        makeConfig(),
        makeLogger()
      );
      // ExecutionBaseAgent sets maxDuration to at least 900000 (15 min)
      expect(agent.mission.maxDuration).to.be.at.least(900000);
    });

    it('should keep longer timeout if provided', function () {
      const agent = new DataPipelineAgent(
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
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      knowledge = agent.getDomainKnowledge();
    });

    it('should return a comprehensive string', function () {
      expect(knowledge).to.be.a('string');
      expect(knowledge.length).to.be.greaterThan(500);
    });

    it('should include sqlite3 as primary database target', function () {
      expect(knowledge).to.include('sqlite3');
      expect(knowledge).to.include('CREATE TABLE');
      expect(knowledge).to.include('.import');
    });

    it('should include jq for JSON pipelines', function () {
      expect(knowledge).to.include('jq');
      expect(knowledge.toLowerCase()).to.include('json');
    });

    it('should include pandas for DataFrame operations', function () {
      expect(knowledge).to.include('pandas');
      expect(knowledge).to.include('DataFrame');
    });

    it('should include csvkit tools', function () {
      expect(knowledge).to.include('csvkit');
      expect(knowledge).to.include('csvstat');
      expect(knowledge).to.include('csvsql');
      expect(knowledge).to.include('csvjoin');
    });

    it('should include miller for structured data transforms', function () {
      expect(knowledge).to.include('miller');
      expect(knowledge).to.include('mlr');
    });

    it('should include schema inference guidance', function () {
      expect(knowledge.toLowerCase()).to.include('schema');
      expect(knowledge.toLowerCase()).to.include('infer');
    });

    it('should include validation guidance', function () {
      expect(knowledge.toLowerCase()).to.include('validat');
      expect(knowledge).to.include('row count');
      expect(knowledge.toLowerCase()).to.include('constraint');
    });

    it('should include ETL patterns', function () {
      expect(knowledge.toLowerCase()).to.include('transform');
      expect(knowledge.toLowerCase()).to.include('clean');
      expect(knowledge.toLowerCase()).to.include('dedup');
    });

    it('should include data profiling guidance', function () {
      expect(knowledge.toLowerCase()).to.include('profile');
      expect(knowledge.toLowerCase()).to.include('null');
      expect(knowledge.toLowerCase()).to.include('distribution');
    });

    it('should include index optimization guidance', function () {
      expect(knowledge).to.include('CREATE INDEX');
      expect(knowledge.toLowerCase()).to.include('index');
    });

    it('should include duckdb as an alternative', function () {
      expect(knowledge).to.include('duckdb');
    });

    it('should emphasize profiling before transforming', function () {
      expect(knowledge).to.include('profile data BEFORE transforming');
    });

    it('should emphasize preserving raw data', function () {
      expect(knowledge).to.include('Preserve raw data');
      expect(knowledge).to.include('NEVER modify inputs');
    });

    it('should include awk/sed for text processing', function () {
      expect(knowledge).to.include('awk');
      expect(knowledge).to.include('sed');
    });
  });

  // ── getToolSchema ──────────────────────────────────────────────────────────

  describe('getToolSchema()', function () {
    it('should return an array of tool definitions', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      expect(tools).to.be.an('array');
      expect(tools.length).to.be.greaterThan(0);
    });

    it('should include base execution tools', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('execute_bash');
      expect(names).to.include('execute_python');
      expect(names).to.include('read_file');
      expect(names).to.include('write_file');
      expect(names).to.include('list_directory');
      expect(names).to.include('http_fetch');
      expect(names).to.include('sqlite_exec');
    });

    it('should include pipeline-specific tools', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('profile_data');
      expect(names).to.include('infer_schema');
      expect(names).to.include('save_pipeline_manifest');
      expect(names).to.include('validate_database');
    });

    it('should include manifest registration tools', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('register_input_source');
      expect(names).to.include('register_transform');
      expect(names).to.include('register_table');
      expect(names).to.include('register_export');
    });

    it('should have valid tool definition structure', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
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
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const allTools = agent.getToolSchema();
      const baseTools = agent.getBaseToolSchema();
      expect(allTools.length).to.be.greaterThan(baseTools.length);
    });
  });

  // ── Lifecycle Methods ──────────────────────────────────────────────────────

  describe('lifecycle methods', function () {
    it('should have execute method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.execute).to.be.a('function');
    });

    it('should have onStart method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onStart).to.be.a('function');
    });

    it('should have onComplete method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onComplete).to.be.a('function');
    });

    it('should have assessAccomplishment method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.assessAccomplishment).to.be.a('function');
    });

    it('should have generateHandoffSpec method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.generateHandoffSpec).to.be.a('function');
    });

    it('should have dispatchToolCall method', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.dispatchToolCall).to.be.a('function');
    });
  });

  // ── assessAccomplishment ───────────────────────────────────────────────────

  describe('assessAccomplishment()', function () {
    it('should return true when database created and tables loaded', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/database.sqlite';
      agent.pipelineManifest.tables.push({ name: 'products', rowCount: 100 });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.databaseCreated).to.be.true;
      expect(result.metrics.tableCount).to.equal(1);
      expect(result.metrics.totalRows).to.equal(100);
    });

    it('should return true when exports generated', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.exports.push({
        path: '/tmp/test/exports/data.csv',
        format: 'csv',
        rowCount: 500
      });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.exportCount).to.equal(1);
    });

    it('should return true when transforms applied with rows', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.transforms.push({
        name: 'clean_nulls',
        description: 'Remove null rows'
      });
      agent.pipelineManifest.tables.push({ name: 'cleaned', rowCount: 50 });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
    });

    it('should return false when nothing produced', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 0, filesCreated: 0, bytesWritten: 0 } },
        []
      );
      expect(result.accomplished).to.be.false;
      expect(result.reason).to.include('No pipeline output');
    });

    it('should return true if base metrics show accomplishment even without manifest data', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 5, filesCreated: 2, bytesWritten: 1024 } },
        []
      );
      expect(result.accomplished).to.be.true;
    });

    it('should include validation status in metrics', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/db.sqlite';
      agent.pipelineManifest.tables.push({ name: 'data', rowCount: 10 });
      agent.pipelineManifest.validationResults = { passed: true, checks: [] };

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.metrics.validationPassed).to.be.true;
    });
  });

  // ── generateHandoffSpec ────────────────────────────────────────────────────

  describe('generateHandoffSpec()', function () {
    it('should return null when nothing produced', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const spec = agent.generateHandoffSpec();
      expect(spec).to.be.null;
    });

    it('should target analysis when database created', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/database.sqlite';
      agent.pipelineManifest.tables.push({
        name: 'products',
        rowCount: 1000,
        columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }]
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.targetAgentType).to.equal('analysis');
    });

    it('should include artifactRefs pointing to database', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/database.sqlite';
      agent.pipelineManifest.tables.push({ name: 'data', rowCount: 100 });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.artifactRefs).to.be.an('array');
      expect(spec.artifactRefs).to.include('/tmp/test/database.sqlite');
    });

    it('should include export files in artifactRefs', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.exports.push({
        path: '/tmp/test/exports/data.csv',
        format: 'csv'
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.artifactRefs).to.include('/tmp/test/exports/data.csv');
    });

    it('should include schema with table structure', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/db.sqlite';
      agent.pipelineManifest.tables.push({
        name: 'products',
        rowCount: 500,
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name: 'name', type: 'TEXT' },
          { name: 'price', type: 'REAL' }
        ]
      });

      const spec = agent.generateHandoffSpec();
      expect(spec.context.schema).to.have.property('products');
      expect(spec.context.schema.products.rowCount).to.equal(500);
      expect(spec.context.schema.products.columns).to.have.length(3);
    });

    it('should include dataProfile when available', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/db.sqlite';
      agent.pipelineManifest.tables.push({ name: 'data', rowCount: 200 });
      agent.pipelineManifest.dataProfile = {
        rowCount: 200,
        columnCount: 5,
        format: 'csv',
        tool: 'csvstat'
      };

      const spec = agent.generateHandoffSpec();
      expect(spec.context.dataProfile).to.not.be.null;
      expect(spec.context.dataProfile.rowCount).to.equal(200);
      expect(spec.context.dataProfile.columnCount).to.equal(5);
    });

    it('should include rowCount and tableCount', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/db.sqlite';
      agent.pipelineManifest.tables.push(
        { name: 'products', rowCount: 1000 },
        { name: 'categories', rowCount: 50 }
      );

      const spec = agent.generateHandoffSpec();
      expect(spec.context.rowCount).to.equal(1050);
      expect(spec.context.tableCount).to.equal(2);
    });

    it('should include topFindings summary', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent.pipelineManifest.database = '/tmp/test/db.sqlite';
      agent.pipelineManifest.tables.push({ name: 'products', rowCount: 100 });
      agent.pipelineManifest.transforms.push({ name: 'clean', description: 'Clean data' });
      agent.pipelineManifest.exports.push({ path: '/tmp/test/data.csv', format: 'csv' });

      const spec = agent.generateHandoffSpec();
      expect(spec.context.topFindings).to.be.an('array');
      expect(spec.context.topFindings.length).to.be.greaterThan(0);
    });
  });

  // ── Tool dispatch — registration tools ─────────────────────────────────────

  describe('register tools', function () {
    it('should register input source', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerInputSource({
        path: '/tmp/raw/data.csv',
        format: 'csv',
        record_count: 1000,
        description: 'Product listing CSV'
      });

      expect(result.success).to.be.true;
      expect(result.totalInputSources).to.equal(1);
      expect(agent.pipelineManifest.inputSources).to.have.length(1);
      expect(agent.pipelineManifest.inputSources[0].path).to.equal('/tmp/raw/data.csv');
      expect(agent.pipelineManifest.inputSources[0].recordCount).to.equal(1000);
    });

    it('should register transform', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerTransform({
        name: 'normalize_dates',
        description: 'Convert all date fields to ISO 8601',
        input: 'raw_data',
        output: 'cleaned_data',
        rows_in: 1000,
        rows_out: 998
      });

      expect(result.success).to.be.true;
      expect(result.totalTransforms).to.equal(1);
      expect(agent.pipelineManifest.transforms[0].name).to.equal('normalize_dates');
      expect(agent.pipelineManifest.transforms[0].rowsIn).to.equal(1000);
      expect(agent.pipelineManifest.transforms[0].rowsOut).to.equal(998);
    });

    it('should register table', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerTable({
        name: 'products',
        row_count: 500,
        columns: [
          { name: 'id', type: 'INTEGER', primary_key: true },
          { name: 'name', type: 'TEXT' },
          { name: 'price', type: 'REAL' }
        ],
        indexes: ['idx_products_name']
      });

      expect(result.success).to.be.true;
      expect(result.totalTables).to.equal(1);
      expect(agent.pipelineManifest.tables[0].name).to.equal('products');
      expect(agent.pipelineManifest.tables[0].rowCount).to.equal(500);
      expect(agent.pipelineManifest.tables[0].columns).to.have.length(3);
    });

    it('should update table when re-registered with same name', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      agent._registerTable({ name: 'products', row_count: 100 });
      agent._registerTable({ name: 'products', row_count: 500 });

      expect(agent.pipelineManifest.tables).to.have.length(1);
      expect(agent.pipelineManifest.tables[0].rowCount).to.equal(500);
    });

    it('should register export', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._registerExport({
        path: '/tmp/exports/products.csv',
        format: 'csv',
        description: 'Full product listing export',
        row_count: 1000,
        size_bytes: 50000
      });

      expect(result.success).to.be.true;
      expect(result.totalExports).to.equal(1);
      expect(agent.pipelineManifest.exports[0].path).to.equal('/tmp/exports/products.csv');
      expect(agent.pipelineManifest.exports[0].format).to.equal('csv');
      expect(agent.pipelineManifest.exports[0].rowCount).to.equal(1000);
    });
  });

  // ── Schema inference ───────────────────────────────────────────────────────

  describe('_inferSchema()', function () {
    it('should infer schema from JSON array', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([
        { id: 1, name: 'Product A', price: 10.99, inStock: true },
        { id: 2, name: 'Product B', price: 24.50, inStock: false }
      ]);

      const result = await agent._inferSchema({ data, table_name: 'products' });
      expect(result.success).to.be.true;
      expect(result.schema.tableName).to.equal('products');
      expect(result.schema.columns.length).to.be.greaterThan(0);
      expect(result.ddl).to.include('CREATE TABLE');
      expect(result.ddl).to.include('products');
    });

    it('should infer schema from CSV', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const data = 'name,price,category\nWidget A,9.99,tools\nWidget B,14.50,hardware';

      const result = await agent._inferSchema({ data, format: 'csv' });
      expect(result.success).to.be.true;
      expect(result.schema.columns.length).to.equal(3);
      expect(result.ddl).to.include('CREATE TABLE');
    });

    it('should return error for empty data', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._inferSchema({ data: '' });
      expect(result.error).to.be.a('string');
    });

    it('should generate valid DDL', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([
        { id: 1, name: 'Test', value: 3.14 }
      ]);

      const result = await agent._inferSchema({ data, table_name: 'test_table' });
      expect(result.ddl).to.include('CREATE TABLE IF NOT EXISTS');
      expect(result.ddl).to.include('"test_table"');
      expect(result.ddl).to.include('"id"');
      expect(result.ddl).to.include('"name"');
    });

    it('should auto-detect id column as primary key', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' }
      ]);

      const result = await agent._inferSchema({ data });
      const idCol = result.schema.columns.find(c => c.name === 'id');
      expect(idCol.primaryKey).to.be.true;
    });

    it('should apply hints for primary key', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([
        { product_id: 1, name: 'A' },
        { product_id: 2, name: 'B' }
      ]);

      const result = await agent._inferSchema({
        data,
        hints: 'product_id is primary key'
      });
      const pkCol = result.schema.columns.find(c => c.name === 'product_id');
      expect(pkCol.primaryKey).to.be.true;
    });
  });

  // ── Format detection ───────────────────────────────────────────────────────

  describe('format detection', function () {
    it('should detect CSV from file extension', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._detectFormatFromPath('/data/file.csv')).to.equal('csv');
      expect(agent._detectFormatFromPath('/data/file.tsv')).to.equal('csv');
    });

    it('should detect JSON from file extension', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._detectFormatFromPath('/data/file.json')).to.equal('json');
      expect(agent._detectFormatFromPath('/data/file.jsonl')).to.equal('json');
    });

    it('should detect SQLite from file extension', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._detectFormatFromPath('/data/file.sqlite')).to.equal('sqlite');
      expect(agent._detectFormatFromPath('/data/file.db')).to.equal('sqlite');
    });

    it('should detect JSON from content', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._detectFormatFromContent('[{"a":1}]')).to.equal('json');
      expect(agent._detectFormatFromContent('{"key":"value"}')).to.equal('json');
    });

    it('should detect CSV from content', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._detectFormatFromContent('a,b,c\n1,2,3')).to.equal('csv');
    });
  });

  // ── DDL generation ─────────────────────────────────────────────────────────

  describe('_generateDDL()', function () {
    it('should generate valid CREATE TABLE statement', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const ddl = agent._generateDDL('test_table', [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false, unique: false },
        { name: 'name', type: 'TEXT', primaryKey: false, nullable: false, unique: false },
        { name: 'price', type: 'REAL', primaryKey: false, nullable: true, unique: false }
      ]);

      expect(ddl).to.include('CREATE TABLE IF NOT EXISTS "test_table"');
      expect(ddl).to.include('"id" INTEGER PRIMARY KEY');
      expect(ddl).to.include('"name" TEXT NOT NULL');
      expect(ddl).to.include('"price" REAL');
      // price is nullable, so should NOT have NOT NULL
      expect(ddl).to.not.match(/"price" REAL NOT NULL/);
    });

    it('should handle UNIQUE constraint', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const ddl = agent._generateDDL('t', [
        { name: 'email', type: 'TEXT', primaryKey: false, nullable: false, unique: true }
      ]);

      expect(ddl).to.include('UNIQUE');
    });
  });

  // ── _isProgressOperation ───────────────────────────────────────────────────

  describe('_isProgressOperation()', function () {
    it('should recognize pipeline-specific progress operations', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('profile_data')).to.be.true;
      expect(agent._isProgressOperation('infer_schema')).to.be.true;
      expect(agent._isProgressOperation('save_pipeline_manifest')).to.be.true;
      expect(agent._isProgressOperation('validate_database')).to.be.true;
      expect(agent._isProgressOperation('register_input_source')).to.be.true;
      expect(agent._isProgressOperation('register_transform')).to.be.true;
      expect(agent._isProgressOperation('register_table')).to.be.true;
      expect(agent._isProgressOperation('register_export')).to.be.true;
    });

    it('should recognize base execution progress operations', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('execute_bash')).to.be.true;
      expect(agent._isProgressOperation('execute_python')).to.be.true;
      expect(agent._isProgressOperation('write_file')).to.be.true;
      expect(agent._isProgressOperation('sqlite_exec')).to.be.true;
    });

    it('should return false for read-only operations', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('read_file')).to.be.false;
      expect(agent._isProgressOperation('list_directory')).to.be.false;
    });
  });

  // ── dispatchToolCall ───────────────────────────────────────────────────────

  describe('dispatchToolCall()', function () {
    it('should handle unknown tool names via parent', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('nonexistent_tool', {});
      expect(result).to.have.property('error');
      expect(result.error).to.include('Unknown tool');
    });

    it('should dispatch register_input_source', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_input_source', {
        path: '/tmp/data.csv',
        format: 'csv'
      });
      expect(result.success).to.be.true;
    });

    it('should dispatch register_transform', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_transform', {
        name: 'clean',
        description: 'Clean data'
      });
      expect(result.success).to.be.true;
    });

    it('should dispatch register_table', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_table', {
        name: 'products',
        row_count: 100
      });
      expect(result.success).to.be.true;
    });

    it('should dispatch register_export', async function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('register_export', {
        path: '/tmp/export.csv',
        format: 'csv'
      });
      expect(result.success).to.be.true;
    });
  });

  // ── _formatBytes ───────────────────────────────────────────────────────────

  describe('_formatBytes()', function () {
    it('should format bytes correctly', function () {
      const agent = new DataPipelineAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._formatBytes(0)).to.equal('0 B');
      expect(agent._formatBytes(1024)).to.equal('1.0 KB');
      expect(agent._formatBytes(1048576)).to.equal('1.0 MB');
      expect(agent._formatBytes(500)).to.equal('500 B');
    });
  });
});
