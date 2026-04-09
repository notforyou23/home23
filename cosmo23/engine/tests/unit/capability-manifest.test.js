const { expect } = require('chai');
const { CapabilityManifest, CAPABILITIES } = require('../../src/execution/capability-manifest');

describe('CapabilityManifest', function () {
  let manifest;

  before(function () {
    manifest = new CapabilityManifest();
  });

  // ── getCapabilities() ───────────────────────────────────────────────────

  describe('getCapabilities()', function () {
    it('should return all four agent types', function () {
      const caps = manifest.getCapabilities();
      expect(caps).to.have.all.keys('dataacquisition', 'datapipeline', 'infrastructure', 'automation');
    });

    it('should return a deep copy (not the original object)', function () {
      const caps1 = manifest.getCapabilities();
      const caps2 = manifest.getCapabilities();
      caps1.dataacquisition.can.push('test_mutation');
      expect(caps2.dataacquisition.can).to.not.include('test_mutation');
      expect(CAPABILITIES.dataacquisition.can).to.not.include('test_mutation');
    });

    const REQUIRED_FIELDS = ['can', 'produces', 'needs', 'typical_duration', 'tools', 'hands_off_to', 'use_when'];

    for (const agentType of ['dataacquisition', 'datapipeline', 'infrastructure', 'automation']) {
      describe(`${agentType}`, function () {
        it('should have all required fields', function () {
          const caps = manifest.getCapabilities();
          const agent = caps[agentType];
          for (const field of REQUIRED_FIELDS) {
            expect(agent, `missing field: ${field}`).to.have.property(field);
          }
        });

        it('should have non-empty arrays for can, produces, needs, tools, hands_off_to, use_when', function () {
          const caps = manifest.getCapabilities();
          const agent = caps[agentType];
          expect(agent.can).to.be.an('array').with.length.greaterThan(0);
          expect(agent.produces).to.be.an('array').with.length.greaterThan(0);
          expect(agent.needs).to.be.an('array').with.length.greaterThan(0);
          expect(agent.tools).to.be.an('array').with.length.greaterThan(0);
          expect(agent.hands_off_to).to.be.an('array').with.length.greaterThan(0);
          expect(agent.use_when).to.be.an('array').with.length.greaterThan(0);
        });

        it('should have a string typical_duration', function () {
          const caps = manifest.getCapabilities();
          expect(caps[agentType].typical_duration).to.be.a('string').that.is.not.empty;
        });
      });
    }

    it('dataacquisition should include expected capabilities', function () {
      const caps = manifest.getCapabilities();
      expect(caps.dataacquisition.can).to.include('web_scraping');
      expect(caps.dataacquisition.can).to.include('api_consumption');
      expect(caps.dataacquisition.tools).to.include('curl');
      expect(caps.dataacquisition.tools).to.include('playwright');
      expect(caps.dataacquisition.hands_off_to).to.include('datapipeline');
    });

    it('datapipeline should include expected capabilities', function () {
      const caps = manifest.getCapabilities();
      expect(caps.datapipeline.can).to.include('schema_mapping');
      expect(caps.datapipeline.can).to.include('database_creation');
      expect(caps.datapipeline.tools).to.include('sqlite3');
      expect(caps.datapipeline.tools).to.include('duckdb');
      expect(caps.datapipeline.hands_off_to).to.include('analysis');
    });

    it('infrastructure should include expected capabilities', function () {
      const caps = manifest.getCapabilities();
      expect(caps.infrastructure.can).to.include('container_management');
      expect(caps.infrastructure.can).to.include('env_provisioning');
      expect(caps.infrastructure.tools).to.include('docker');
      expect(caps.infrastructure.hands_off_to).to.include('automation');
    });

    it('automation should include expected capabilities', function () {
      const caps = manifest.getCapabilities();
      expect(caps.automation.can).to.include('file_operations');
      expect(caps.automation.can).to.include('gui_automation');
      expect(caps.automation.tools).to.include('bash');
      expect(caps.automation.tools).to.include('osascript');
      expect(caps.automation.hands_off_to).to.include('datapipeline');
    });
  });

  // ── getCoordinatorInjectionText() ─────────────────────────────────────

  describe('getCoordinatorInjectionText()', function () {
    it('should return a string', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.be.a('string');
    });

    it('should contain all agent type names', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.include('DATAACQUISITION');
      expect(text).to.include('DATAPIPELINE');
      expect(text).to.include('INFRASTRUCTURE');
      expect(text).to.include('AUTOMATION');
    });

    it('should contain capability fields for each agent type', function () {
      const text = manifest.getCoordinatorInjectionText();
      // Check that capability details appear in the text
      expect(text).to.include('web_scraping');
      expect(text).to.include('schema_mapping');
      expect(text).to.include('container_management');
      expect(text).to.include('file_operations');
    });

    it('should contain dispatch guidance', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.include('Cerebral agents');
      expect(text).to.include('Execution agents');
      expect(text).to.include('thinking');
      expect(text).to.include('doing');
    });

    it('should contain tool names', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.include('curl');
      expect(text).to.include('sqlite3');
      expect(text).to.include('docker');
      expect(text).to.include('bash');
    });

    it('should contain hands_off_to information', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.include('Hands off to');
    });

    it('should contain use_when scenarios', function () {
      const text = manifest.getCoordinatorInjectionText();
      expect(text).to.include('Use when');
    });

    it('should include learned skills when provided', function () {
      const text = manifest.getCoordinatorInjectionText({
        learnedSkills: [
          { name: 'scrape-arxiv', description: 'Scrape papers from arXiv', confidence: 0.92 },
          { id: 'convert-pdf-to-text', description: 'Extract text from PDF files' }
        ]
      });
      expect(text).to.include('LEARNED SKILLS');
      expect(text).to.include('scrape-arxiv');
      expect(text).to.include('92%');
      expect(text).to.include('convert-pdf-to-text');
      expect(text).to.include('Extract text from PDF files');
    });

    it('should not include learned skills section when array is empty', function () {
      const text = manifest.getCoordinatorInjectionText({ learnedSkills: [] });
      expect(text).to.not.include('LEARNED SKILLS');
    });

    it('should include campaign patterns when provided', function () {
      const text = manifest.getCoordinatorInjectionText({
        campaignPatterns: [
          { pattern: 'API rate limits require backoff on arxiv.org' },
          { name: 'sqlite-first for tabular data' }
        ]
      });
      expect(text).to.include('CAMPAIGN PATTERNS');
      expect(text).to.include('API rate limits require backoff on arxiv.org');
      expect(text).to.include('sqlite-first for tabular data');
    });

    it('should not include campaign patterns section when array is empty', function () {
      const text = manifest.getCoordinatorInjectionText({ campaignPatterns: [] });
      expect(text).to.not.include('CAMPAIGN PATTERNS');
    });

    it('should include both learned skills and campaign patterns together', function () {
      const text = manifest.getCoordinatorInjectionText({
        learnedSkills: [{ name: 'my-skill', confidence: 0.8 }],
        campaignPatterns: [{ pattern: 'my-pattern' }]
      });
      expect(text).to.include('LEARNED SKILLS');
      expect(text).to.include('my-skill');
      expect(text).to.include('80%');
      expect(text).to.include('CAMPAIGN PATTERNS');
      expect(text).to.include('my-pattern');
    });
  });

  // ── getPlannerInjectionText() ─────────────────────────────────────────

  describe('getPlannerInjectionText()', function () {
    const mockToolSnapshot = [
      { id: 'tool:python', name: 'python3', version: '3.11.5', capabilities: ['execute_script', 'pip_install'] },
      { id: 'tool:docker', name: 'docker', version: '24.0.6', capabilities: ['container_run', 'container_build'] },
      { id: 'tool:curl', name: 'curl', version: '8.1.2', capabilities: ['http_request', 'download'] },
      { id: 'tool:sqlite3', name: 'sqlite3', version: '3.42.0', capabilities: ['sql_query'] }
    ];

    it('should return a string', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.be.a('string');
    });

    it('should include all coordinator injection content', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('EXECUTION AGENT CAPABILITIES');
      expect(text).to.include('DATAACQUISITION');
      expect(text).to.include('DISPATCH GUIDANCE');
    });

    it('should include available tools section', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('AVAILABLE TOOLS ON THIS MACHINE');
    });

    it('should list tool names from the snapshot', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('python3');
      expect(text).to.include('docker');
      expect(text).to.include('curl');
      expect(text).to.include('sqlite3');
    });

    it('should include tool versions from the snapshot', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('3.11.5');
      expect(text).to.include('24.0.6');
    });

    it('should include tool capabilities from the snapshot', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('execute_script');
      expect(text).to.include('container_run');
    });

    it('should handle empty tool snapshot gracefully', function () {
      const text = manifest.getPlannerInjectionText([]);
      expect(text).to.include('No tools currently discovered');
    });

    it('should handle null tool snapshot gracefully', function () {
      const text = manifest.getPlannerInjectionText(null);
      expect(text).to.include('No tools currently discovered');
    });

    it('should pass through learned skills and campaign patterns', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot, {
        learnedSkills: [{ name: 'planner-skill', confidence: 0.75 }],
        campaignPatterns: [{ pattern: 'planner-pattern' }]
      });
      expect(text).to.include('LEARNED SKILLS');
      expect(text).to.include('planner-skill');
      expect(text).to.include('75%');
      expect(text).to.include('CAMPAIGN PATTERNS');
      expect(text).to.include('planner-pattern');
    });

    it('should include guidance about preferring available tools', function () {
      const text = manifest.getPlannerInjectionText(mockToolSnapshot);
      expect(text).to.include('prefer tools that are available');
    });
  });
});
