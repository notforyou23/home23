const { expect } = require('chai');
const path = require('path');
const os = require('os');

// BaseAgent → UnifiedClient → GPT5Client → openai-client.js requires OPENAI_API_KEY
// at construction time. Set a dummy key so the client can be instantiated (no actual
// API calls are made in these tests).
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'sk-test-dummy-key-for-unit-tests';
}

const { DataAcquisitionAgent } = require('../../src/agents/data-acquisition-agent');
const { ExecutionBaseAgent } = require('../../src/agents/execution-base-agent');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeLogger = () => ({
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {}
});

const makeMission = (overrides = {}) => ({
  goalId: 'test_acquisition',
  description: 'Scrape product listings from example.com',
  agentType: 'dataacquisition',
  successCriteria: ['At least 100 product records acquired'],
  maxDuration: 600000,
  ...overrides
});

const makeConfig = (overrides = {}) => ({
  logsDir: path.join(os.tmpdir(), `cosmo-dacq-test-${Date.now()}`),
  architecture: {
    memory: { embedding: { model: 'text-embedding-3-small', dimensions: 512 } }
  },
  ...overrides
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('DataAcquisitionAgent', function () {

  // ── Instantiation ──────────────────────────────────────────────────────────

  describe('instantiation', function () {
    it('should instantiate with dataacquisition type', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent).to.be.instanceOf(DataAcquisitionAgent);
      expect(agent).to.be.instanceOf(ExecutionBaseAgent);
      expect(agent.getAgentType()).to.equal('dataacquisition');
    });

    it('should have agentId matching base-agent format', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.agentId).to.match(/^agent_\d+_[a-z0-9]+$/);
    });

    it('should start with initialized status', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.status).to.equal('initialized');
    });

    it('should accept mission with dataacquisition agentType', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.mission.description).to.equal('Scrape product listings from example.com');
      expect(agent.mission.goalId).to.equal('test_acquisition');
    });
  });

  // ── acquisitionManifest structure ──────────────────────────────────────────

  describe('acquisitionManifest', function () {
    it('should be initialized with correct structure', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const manifest = agent.acquisitionManifest;

      expect(manifest).to.have.property('sources').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('pagesAcquired', 0);
      expect(manifest).to.have.property('filesDownloaded', 0);
      expect(manifest).to.have.property('bytesAcquired', 0);
      expect(manifest).to.have.property('discoveredSchema', null);
      expect(manifest).to.have.property('qualityAssessment', null);
      expect(manifest).to.have.property('errors').that.is.an('array').with.length(0);
      expect(manifest).to.have.property('startedAt', null);
      expect(manifest).to.have.property('completedAt', null);
    });
  });

  // ── Extended timeout ────────────────────────────────────────────────────────

  describe('extended timeout', function () {
    it('should enforce minimum 15-minute timeout', function () {
      const agent = new DataAcquisitionAgent(
        makeMission({ maxDuration: 60000 }),  // 1 minute
        makeConfig(),
        makeLogger()
      );
      // ExecutionBaseAgent sets maxDuration to at least 900000 (15 min)
      expect(agent.mission.maxDuration).to.be.at.least(900000);
    });

    it('should keep longer timeout if provided', function () {
      const agent = new DataAcquisitionAgent(
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
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      knowledge = agent.getDomainKnowledge();
    });

    it('should return a comprehensive string', function () {
      expect(knowledge).to.be.a('string');
      expect(knowledge.length).to.be.greaterThan(500);
    });

    it('should include curl as the primary tool', function () {
      expect(knowledge).to.include('curl');
    });

    it('should include playwright for JS-rendered content', function () {
      expect(knowledge).to.include('playwright');
    });

    it('should include scrapy for large-scale crawling', function () {
      expect(knowledge).to.include('scrapy');
    });

    it('should include pagination strategies', function () {
      expect(knowledge.toLowerCase()).to.include('pagination');
      expect(knowledge).to.include('cursor');
      expect(knowledge).to.include('offset');
    });

    it('should include rate limiting guidance', function () {
      expect(knowledge.toLowerCase()).to.include('rate limit');
      expect(knowledge).to.include('Retry-After');
      expect(knowledge).to.include('429');
    });

    it('should include robots.txt guidance', function () {
      expect(knowledge).to.include('robots.txt');
      expect(knowledge).to.include('Disallow');
    });

    it('should include wget for recursive downloads', function () {
      expect(knowledge).to.include('wget');
    });

    it('should include cheerio for HTML parsing', function () {
      expect(knowledge).to.include('cheerio');
    });

    it('should include beautiful-soup', function () {
      expect(knowledge.toLowerCase()).to.include('beautiful-soup');
    });

    it('should include yt-dlp for video downloading', function () {
      expect(knowledge).to.include('yt-dlp');
    });

    it('should include aria2c for parallel downloads', function () {
      expect(knowledge).to.include('aria2c');
    });

    it('should include authentication patterns', function () {
      expect(knowledge).to.include('Bearer');
      expect(knowledge).to.include('API key');
    });

    it('should include deduplication guidance', function () {
      expect(knowledge.toLowerCase()).to.include('dedup');
    });

    it('should emphasize starting simple', function () {
      expect(knowledge).to.include('Start simple');
    });
  });

  // ── getToolSchema ──────────────────────────────────────────────────────────

  describe('getToolSchema()', function () {
    it('should return an array of tool definitions', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      expect(tools).to.be.an('array');
      expect(tools.length).to.be.greaterThan(0);
    });

    it('should include base execution tools', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('execute_bash');
      expect(names).to.include('execute_python');
      expect(names).to.include('read_file');
      expect(names).to.include('write_file');
      expect(names).to.include('list_directory');
      expect(names).to.include('http_fetch');
    });

    it('should include acquisition-specific tools', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const tools = agent.getToolSchema();
      const names = tools.map(t => t.function.name);

      expect(names).to.include('discover_schema');
      expect(names).to.include('check_robots_txt');
      expect(names).to.include('save_manifest');
      expect(names).to.include('log_source');
      expect(names).to.include('update_manifest_stats');
      expect(names).to.include('set_discovered_schema');
    });

    it('should have valid tool definition structure', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
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
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const allTools = agent.getToolSchema();
      const baseTools = agent.getBaseToolSchema();
      expect(allTools.length).to.be.greaterThan(baseTools.length);
    });
  });

  // ── Lifecycle Methods ──────────────────────────────────────────────────────

  describe('lifecycle methods', function () {
    it('should have execute method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.execute).to.be.a('function');
    });

    it('should have onStart method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onStart).to.be.a('function');
    });

    it('should have onComplete method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.onComplete).to.be.a('function');
    });

    it('should have assessAccomplishment method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.assessAccomplishment).to.be.a('function');
    });

    it('should have generateHandoffSpec method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.generateHandoffSpec).to.be.a('function');
    });

    it('should have dispatchToolCall method', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent.dispatchToolCall).to.be.a('function');
    });
  });

  // ── assessAccomplishment ───────────────────────────────────────────────────

  describe('assessAccomplishment()', function () {
    it('should return true when pages acquired', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 50;

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.pagesAcquired).to.equal(50);
    });

    it('should return true when files downloaded', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.filesDownloaded = 10;

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
      expect(result.metrics.filesDownloaded).to.equal(10);
    });

    it('should return true when bytes acquired', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.bytesAcquired = 1024;

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
    });

    it('should return true for partial acquisition (500 of 1000 pages)', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 500;
      agent.acquisitionManifest.bytesAcquired = 5 * 1024 * 1024;
      agent.acquisitionManifest.errors.push({ url: 'http://example.com/page/501', error: 'timeout' });

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.accomplished).to.be.true;
    });

    it('should return false when nothing acquired', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 0, filesCreated: 0, bytesWritten: 0 } },
        []
      );
      expect(result.accomplished).to.be.false;
    });

    it('should return true if base metrics show accomplishment even without manifest data', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());

      const result = agent.assessAccomplishment(
        { metadata: { commandsRun: 5, filesCreated: 2, bytesWritten: 1024 } },
        []
      );
      expect(result.accomplished).to.be.true;
    });

    it('should include schema discovery in metrics', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.discoveredSchema = {
        fields: ['name', 'price'],
        types: { name: 'string', price: 'number' }
      };
      agent.acquisitionManifest.pagesAcquired = 10;

      const result = agent.assessAccomplishment({ metadata: {} }, []);
      expect(result.metrics.schemaDiscovered).to.be.true;
    });
  });

  // ── generateHandoffSpec ────────────────────────────────────────────────────

  describe('generateHandoffSpec()', function () {
    it('should return null when no data acquired', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const spec = agent.generateHandoffSpec();
      expect(spec).to.be.null;
    });

    it('should target datapipeline when data acquired', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 100;
      agent.acquisitionManifest.bytesAcquired = 50000;
      agent.acquisitionManifest.sources.push({
        url: 'https://example.com/page/1',
        status: 200,
        timestamp: new Date().toISOString()
      });

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.targetAgentType).to.equal('datapipeline');
    });

    it('should include artifactRefs pointing to output directory', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 10;
      agent._outputDir = '/tmp/test-output';

      const spec = agent.generateHandoffSpec();
      expect(spec).to.not.be.null;
      expect(spec.artifactRefs).to.be.an('array');
      expect(spec.artifactRefs).to.include('/tmp/test-output');
    });

    it('should include discoveredSchema when available', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 10;
      agent.acquisitionManifest.discoveredSchema = {
        fields: ['name', 'price', 'url'],
        types: { name: 'string', price: 'number', url: 'string' }
      };

      const spec = agent.generateHandoffSpec();
      expect(spec.context.discoveredSchema).to.deep.equal(agent.acquisitionManifest.discoveredSchema);
    });

    it('should include topFindings summary', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 100;
      agent.acquisitionManifest.sources.push({
        url: 'https://example.com',
        status: 200,
        timestamp: new Date().toISOString()
      });

      const spec = agent.generateHandoffSpec();
      expect(spec.context.topFindings).to.be.an('array');
      expect(spec.context.topFindings.length).to.be.greaterThan(0);
    });

    it('should include sourceUrls from successful requests', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent.acquisitionManifest.pagesAcquired = 2;
      agent.acquisitionManifest.sources.push(
        { url: 'https://example.com/page/1', status: 200, timestamp: new Date().toISOString() },
        { url: 'https://example.com/page/2', status: 200, timestamp: new Date().toISOString() },
        { url: 'https://example.com/page/3', status: 404, timestamp: new Date().toISOString() }
      );

      const spec = agent.generateHandoffSpec();
      expect(spec.context.sourceUrls).to.include('https://example.com/page/1');
      expect(spec.context.sourceUrls).to.include('https://example.com/page/2');
      expect(spec.context.sourceUrls).to.not.include('https://example.com/page/3');
    });
  });

  // ── dispatchToolCall ───────────────────────────────────────────────────────

  describe('dispatchToolCall()', function () {
    it('should handle unknown tool names via parent', async function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent.dispatchToolCall('nonexistent_tool', {});
      expect(result).to.have.property('error');
      expect(result.error).to.include('Unknown tool');
    });

    it('should handle log_source tool', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._logSource({
        url: 'https://example.com/api/data',
        status: 200,
        content_hash: 'abc123',
        bytes: 1024
      });

      expect(result.success).to.be.true;
      expect(result.totalSources).to.equal(1);
      expect(agent.acquisitionManifest.sources).to.have.length(1);
      expect(agent.acquisitionManifest.bytesAcquired).to.equal(1024);
    });

    it('should track errors in log_source', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      agent._logSource({
        url: 'https://example.com/broken',
        status: 500,
        error: 'Internal Server Error'
      });

      expect(agent.acquisitionManifest.errors).to.have.length(1);
      expect(agent.acquisitionManifest.errors[0].url).to.equal('https://example.com/broken');
    });

    it('should handle update_manifest_stats tool', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._updateManifestStats({
        pages_acquired: 50,
        files_downloaded: 5,
        bytes_acquired: 10000,
        quality_notes: 'Good coverage, 3 pages returned 404'
      });

      expect(result.success).to.be.true;
      expect(agent.acquisitionManifest.pagesAcquired).to.equal(50);
      expect(agent.acquisitionManifest.filesDownloaded).to.equal(5);
      expect(agent.acquisitionManifest.bytesAcquired).to.equal(10000);
      expect(agent.acquisitionManifest.qualityAssessment).to.not.be.null;
      expect(agent.acquisitionManifest.qualityAssessment.notes).to.include('Good coverage');
    });

    it('should handle set_discovered_schema tool', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const result = agent._setDiscoveredSchema({
        fields: ['name', 'price', 'category'],
        types: { name: 'string', price: 'number', category: 'string' },
        sample_count: 25,
        notes: 'Price field is sometimes null'
      });

      expect(result.success).to.be.true;
      expect(agent.acquisitionManifest.discoveredSchema).to.not.be.null;
      expect(agent.acquisitionManifest.discoveredSchema.fields).to.deep.equal(['name', 'price', 'category']);
      expect(agent.acquisitionManifest.discoveredSchema.sampleCount).to.equal(25);
    });
  });

  // ── discover_schema ─────────────────────────────────────────────────────────

  describe('_discoverSchema()', function () {
    it('should discover schema from JSON array', async function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([
        { name: 'Product A', price: 10.99, inStock: true },
        { name: 'Product B', price: 24.50, inStock: false, category: 'electronics' }
      ]);

      const result = await agent._discoverSchema({ data });
      expect(result.success).to.be.true;
      expect(result.schema.fields).to.include('name');
      expect(result.schema.fields).to.include('price');
      expect(result.schema.types.name).to.equal('string');
      expect(result.schema.types.price).to.equal('number');
      expect(result.schema.sampleSize).to.equal(2);
    });

    it('should discover schema from CSV', async function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const data = 'name,price,category\nWidget A,9.99,tools\nWidget B,14.50,hardware';

      const result = await agent._discoverSchema({ data, format: 'csv' });
      expect(result.success).to.be.true;
      expect(result.schema.fields).to.include('name');
      expect(result.schema.fields).to.include('price');
      expect(result.schema.types.price).to.equal('number');
    });

    it('should return error for empty data', async function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const result = await agent._discoverSchema({ data: '' });
      expect(result.error).to.be.a('string');
    });

    it('should store discovered schema in manifest', async function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const data = JSON.stringify([{ id: 1, title: 'Test' }]);

      await agent._discoverSchema({ data });
      expect(agent.acquisitionManifest.discoveredSchema).to.not.be.null;
      expect(agent.acquisitionManifest.discoveredSchema.fields).to.include('id');
    });
  });

  // ── robots.txt parsing ─────────────────────────────────────────────────────

  describe('_parseRobotsTxt()', function () {
    it('should parse disallow directives', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const robotsTxt = `User-agent: *
Disallow: /private/
Disallow: /admin/
Allow: /public/
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml`;

      const result = agent._parseRobotsTxt(robotsTxt, '*');
      expect(result.disallowed).to.include('/private/');
      expect(result.disallowed).to.include('/admin/');
      expect(result.allowed).to.include('/public/');
      expect(result.crawlDelay).to.equal(2);
      expect(result.sitemaps).to.include('https://example.com/sitemap.xml');
    });

    it('should handle user-agent specific rules', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      const robotsTxt = `User-agent: Googlebot
Disallow: /google-only/

User-agent: *
Disallow: /secret/`;

      const result = agent._parseRobotsTxt(robotsTxt, '*');
      expect(result.disallowed).to.include('/secret/');
      expect(result.disallowed).to.not.include('/google-only/');
    });
  });

  // ── _isProgressOperation ───────────────────────────────────────────────────

  describe('_isProgressOperation()', function () {
    it('should recognize acquisition-specific progress operations', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('discover_schema')).to.be.true;
      expect(agent._isProgressOperation('check_robots_txt')).to.be.true;
      expect(agent._isProgressOperation('save_manifest')).to.be.true;
      expect(agent._isProgressOperation('log_source')).to.be.true;
      expect(agent._isProgressOperation('update_manifest_stats')).to.be.true;
      expect(agent._isProgressOperation('set_discovered_schema')).to.be.true;
    });

    it('should recognize base execution progress operations', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('execute_bash')).to.be.true;
      expect(agent._isProgressOperation('execute_python')).to.be.true;
      expect(agent._isProgressOperation('write_file')).to.be.true;
      expect(agent._isProgressOperation('http_fetch')).to.be.true;
    });

    it('should return false for read-only operations', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._isProgressOperation('read_file')).to.be.false;
      expect(agent._isProgressOperation('list_directory')).to.be.false;
    });
  });

  // ── _formatBytes ──────────────────────────────────────────────────────────

  describe('_formatBytes()', function () {
    it('should format bytes correctly', function () {
      const agent = new DataAcquisitionAgent(makeMission(), makeConfig(), makeLogger());
      expect(agent._formatBytes(0)).to.equal('0 B');
      expect(agent._formatBytes(1024)).to.equal('1.0 KB');
      expect(agent._formatBytes(1048576)).to.equal('1.0 MB');
      expect(agent._formatBytes(500)).to.equal('500 B');
    });
  });
});
