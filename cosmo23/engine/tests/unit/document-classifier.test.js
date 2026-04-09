const { expect } = require('chai');

describe('DocumentClassifier', () => {
  let DocumentClassifier, classifier;

  before(() => {
    ({ DocumentClassifier } = require('../../src/ingestion/document-classifier'));
  });

  beforeEach(() => {
    classifier = new DocumentClassifier({
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    });
  });

  const makeBlocks = (types) => types.map((t, i) => ({
    type: t,
    level: t === 'heading' ? 2 : 0,
    path: [],
    text: 'block content ' + i,
    index: i,
    totalBlocks: types.length
  }));

  describe('contract classification', () => {
    it('should classify contract text as contract', () => {
      const text = [
        '# Master Service Agreement',
        '',
        '## Article 1 - Definitions',
        '',
        'WHEREAS the parties wish to enter into this agreement.',
        '"Affiliate" means any entity that directly or indirectly controls.',
        '"Confidential Information" shall mean all proprietary information.',
        '',
        '## Article 2 - Term',
        '',
        'The Term of this Agreement shall commence on the Effective Date.',
        '',
        '## Article 3 - Indemnification',
        '',
        'Each party hereby agrees to indemnify the other party.',
        '',
        '## Article 4 - Governing Law',
        '',
        'This Agreement shall be governed by the laws of the State of Delaware.',
        '',
        '_______________',
        'Name: John Smith',
        'Title: CEO',
        'Date: January 1, 2025'
      ].join('\n');

      const blocks = [
        ...makeBlocks(['heading', 'heading', 'paragraph', 'definition', 'definition',
          'heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph', 'signature'])
      ];
      // Set article headings
      blocks[1].text = '## Article 1 - Definitions';
      blocks[5].text = '## Article 2 - Term';
      blocks[7].text = '## Article 3 - Indemnification';
      blocks[9].text = '## Article 4 - Governing Law';

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('contract');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('transcript classification', () => {
    it('should classify transcript text as transcript', () => {
      const text = [
        'Interview Transcript - January 15, 2025',
        '',
        'Speaker 1: Good morning, thank you for joining us today.',
        '00:00:05',
        'Speaker 2: Thank you for having me.',
        '00:00:10',
        'Speaker 1: Let us start with your background.',
        '00:00:15',
        'Speaker 2: Sure. I have been working in technology for twenty years.',
        '00:00:22',
        'Q: What are the biggest challenges you face?',
        '00:00:30',
        'A: The main challenge is keeping up with rapid changes in AI.',
        '00:00:45',
        'Speaker 1: That is very interesting. Can you elaborate?',
        '00:01:02',
        'Speaker 2: Of course. The pace of innovation is unprecedented.'
      ].join('\n');

      const blocks = makeBlocks(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('transcript');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('technical classification', () => {
    it('should classify code-heavy text as technical', () => {
      const text = [
        '# API Documentation',
        '',
        '## Authentication',
        '',
        'All API requests require a Bearer token.',
        '',
        '```javascript',
        'const client = new APIClient({',
        '  endpoint: "https://api.example.com",',
        '  async: true',
        '});',
        'await client.authenticate(token);',
        '```',
        '',
        '## Endpoints',
        '',
        'GET /api/users - List all users',
        'POST /api/users - Create a new user',
        '',
        '```python',
        'import requests',
        'response = requests.get("/api/users")',
        '```',
        '',
        '## Configuration',
        '',
        'npm install @example/sdk',
        '',
        '```bash',
        'export API_KEY=your_key',
        '```'
      ].join('\n');

      const blocks = makeBlocks(['heading', 'heading', 'paragraph', 'code', 'heading', 'paragraph', 'code', 'heading', 'paragraph', 'code']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('technical');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('report classification', () => {
    it('should classify report text as report', () => {
      const text = [
        '# Q4 2025 Market Analysis Report',
        '',
        '## Executive Summary',
        '',
        'This report presents the findings from our comprehensive market analysis.',
        '',
        '## Methodology',
        '',
        'We employed mixed methods including surveys and data analysis.',
        '',
        '## Findings',
        '',
        'Our research reveals several key trends in the market.',
        '',
        '## Recommendations',
        '',
        'Based on our findings, we recommend the following actions.',
        '',
        '## Conclusion',
        '',
        'The market outlook remains positive for the coming quarter.',
        '',
        '## Appendix',
        '',
        'Additional data tables and references.'
      ].join('\n');

      const blocks = makeBlocks(['heading', 'heading', 'paragraph', 'heading', 'paragraph',
        'heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('report');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('project classification', () => {
    it('should classify project text as project', () => {
      const text = [
        '# Project Kickoff - COSMO 3.0',
        '',
        '## Agenda',
        '',
        '1. Team introductions',
        '2. Project overview',
        '3. Timeline review',
        '',
        '## Milestones',
        '',
        'Sprint 1: Setup and scaffolding',
        'Sprint 2: Core features',
        '',
        '## Action Items',
        '',
        'TODO: Set up CI pipeline',
        'TODO: Create project plan',
        '',
        '## Deliverables',
        '',
        'Final deliverable due by end of Q2.',
        '',
        '## Stakeholder Review',
        '',
        'Review with stakeholders scheduled for next week.'
      ].join('\n');

      const blocks = makeBlocks(['heading', 'heading', 'list_item', 'heading', 'paragraph',
        'heading', 'paragraph', 'heading', 'paragraph', 'heading', 'paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('project');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('system log classification', () => {
    it('should classify log output as system_log', () => {
      const text = [
        '2025-01-15T10:30:00 INFO Starting application on /usr/local/bin/app',
        '2025-01-15T10:30:01 INFO Connected to database at /var/lib/db/main.sqlite',
        '2025-01-15T10:30:02 WARN High memory usage detected',
        '2025-01-15T10:30:03 ERROR Failed to connect to /api/external/service',
        '2025-01-15T10:30:03 DEBUG Retrying connection attempt 2',
        '2025-01-15T10:30:04 INFO Retry successful',
        '2025-01-15T10:30:05 ERROR Uncaught exception:',
        '  at Server.listen (/usr/local/src/server.js:42:5)',
        '  at process.startup (/usr/local/src/index.js:10:3)',
        '$ systemctl restart app',
        '2025-01-15T10:31:00 INFO Application restarted'
      ].join('\n');

      const blocks = makeBlocks(['paragraph', 'paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('system_log');
      expect(result.confidence).to.be.greaterThan(0.5);
    });
  });

  describe('other classification', () => {
    it('should classify mixed/generic text as other with low confidence', () => {
      const text = 'Just some random short text with nothing special about it.';
      const blocks = makeBlocks(['paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.family).to.equal('other');
      expect(result.confidence).to.be.at.most(0.5);
    });
  });

  describe('confidence calculation', () => {
    it('should return confidence between 0.3 and 0.99', () => {
      const text = 'WHEREAS hereby WHEREAS hereby indemnification governing law';
      const blocks = makeBlocks(['paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result.confidence).to.be.at.least(0.3);
      expect(result.confidence).to.be.at.most(0.99);
    });

    it('should return a family string and numeric confidence', () => {
      const text = 'Some generic text.';
      const blocks = makeBlocks(['paragraph']);

      const result = classifier.classify(text, blocks);
      expect(result).to.have.property('family');
      expect(result).to.have.property('confidence');
      expect(typeof result.family).to.equal('string');
      expect(typeof result.confidence).to.equal('number');
    });
  });
});
