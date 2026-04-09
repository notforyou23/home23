const { expect } = require('chai');

describe('DocumentValidator', () => {
  let DocumentValidator, validator;

  before(() => {
    ({ DocumentValidator } = require('../../src/ingestion/document-validator'));
  });

  beforeEach(() => {
    validator = new DocumentValidator({
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    });
  });

  const makeBlocks = (types) => types.map((t, i) => ({
    type: t,
    level: t === 'heading' ? 2 : 0,
    path: [],
    text: 'x'.repeat(100),
    index: i,
    totalBlocks: types.length
  }));

  describe('truncation detection', () => {
    it('should detect text ending mid-word', () => {
      const text = 'This is a normal sentence that ends abruptly mid wor';
      const blocks = makeBlocks(['paragraph']);
      blocks[0].text = text;

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('truncated mid-word'))
      );
      expect(result.status).to.equal('suspect_truncation');
    });

    it('should not flag text that ends with punctuation', () => {
      const text = 'This is a normal sentence that ends properly.';
      const blocks = makeBlocks(['paragraph']);
      blocks[0].text = text;

      const result = validator.validate(text, blocks);
      const truncationIssues = result.issues.filter(i => i.includes('truncated'));
      expect(truncationIssues).to.have.length(0);
    });

    it('should detect unmatched parentheses', () => {
      const text = 'Start (open paren (another open (and another one and no close';
      const blocks = makeBlocks(['paragraph']);
      blocks[0].text = text;

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('unmatched parentheses'))
      );
    });

    it('should not flag balanced parentheses', () => {
      const text = 'This (has) balanced (parentheses) throughout (the text).';
      const blocks = makeBlocks(['paragraph']);
      blocks[0].text = text;

      const result = validator.validate(text, blocks);
      const parenIssues = result.issues.filter(i => i.includes('parentheses'));
      expect(parenIssues).to.have.length(0);
    });

    it('should detect unclosed code fences', () => {
      const text = 'Some text\n\n```python\ndef broken():\n    pass\n\nMore text after.';
      const blocks = makeBlocks(['paragraph', 'code', 'paragraph']);

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('unclosed code fence'))
      );
    });

    it('should not flag properly closed code fences', () => {
      const text = 'Some text\n\n```python\ndef ok():\n    pass\n```\n\nMore text.';
      const blocks = makeBlocks(['paragraph', 'code', 'paragraph']);

      const result = validator.validate(text, blocks);
      const fenceIssues = result.issues.filter(i => i.includes('code fence'));
      expect(fenceIssues).to.have.length(0);
    });

    it('should detect document ending with a heading', () => {
      const text = '## Intro\n\nContent.\n\n## Unfinished Section';
      const blocks = [
        { type: 'heading', level: 2, path: ['Intro'], text: '## Intro', index: 0, totalBlocks: 3 },
        { type: 'paragraph', level: 0, path: ['Intro'], text: 'Content.', index: 1, totalBlocks: 3 },
        { type: 'heading', level: 2, path: ['Unfinished Section'], text: '## Unfinished Section', index: 2, totalBlocks: 3 }
      ];

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('ends with a heading'))
      );
    });
  });

  describe('low quality detection', () => {
    it('should flag when majority of blocks are unknown type', () => {
      const blocks = makeBlocks(['unknown', 'unknown', 'unknown', 'paragraph']);
      const text = 'Some text that has poor parsing quality.';

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('unknown'))
      );
      expect(result.status).to.equal('low_quality');
    });

    it('should flag very short average block text length', () => {
      const blocks = Array.from({ length: 10 }, (_, i) => ({
        type: 'paragraph',
        level: 0,
        path: [],
        text: 'ab',
        index: i,
        totalBlocks: 10
      }));
      const text = 'ab '.repeat(10);

      const result = validator.validate(text, blocks);
      expect(result.issues).to.satisfy(issues =>
        issues.some(i => i.includes('very short'))
      );
    });
  });

  describe('normal documents pass', () => {
    it('should return ok for a well-formed document', () => {
      const text = [
        '# Introduction',
        '',
        'This document covers the analysis of market trends in Q4 2025.',
        '',
        '## Methodology',
        '',
        'We used a combination of quantitative and qualitative methods.',
        '',
        '## Findings',
        '',
        'The results indicate a significant upward trend in revenue.',
        '',
        '## Conclusion',
        '',
        'Based on our findings, we recommend continued investment.'
      ].join('\n');

      const blocks = [
        { type: 'heading', level: 1, path: ['Introduction'], text: '# Introduction', index: 0, totalBlocks: 8 },
        { type: 'paragraph', level: 0, path: ['Introduction'], text: 'This document covers the analysis of market trends in Q4 2025.', index: 1, totalBlocks: 8 },
        { type: 'heading', level: 2, path: ['Introduction', 'Methodology'], text: '## Methodology', index: 2, totalBlocks: 8 },
        { type: 'paragraph', level: 0, path: ['Introduction', 'Methodology'], text: 'We used a combination of quantitative and qualitative methods.', index: 3, totalBlocks: 8 },
        { type: 'heading', level: 2, path: ['Introduction', 'Findings'], text: '## Findings', index: 4, totalBlocks: 8 },
        { type: 'paragraph', level: 0, path: ['Introduction', 'Findings'], text: 'The results indicate a significant upward trend in revenue.', index: 5, totalBlocks: 8 },
        { type: 'heading', level: 2, path: ['Introduction', 'Conclusion'], text: '## Conclusion', index: 6, totalBlocks: 8 },
        { type: 'paragraph', level: 0, path: ['Introduction', 'Conclusion'], text: 'Based on our findings, we recommend continued investment.', index: 7, totalBlocks: 8 }
      ];

      const result = validator.validate(text, blocks);
      expect(result.status).to.equal('ok');
      expect(result.issues).to.have.length(0);
    });

    it('should return ok for empty blocks', () => {
      const result = validator.validate('Short text.', []);
      expect(result.status).to.equal('ok');
    });
  });

  describe('structural signature', () => {
    it('should compute correct structural signature', () => {
      const blocks = [
        { type: 'heading', level: 1, path: [], text: '# Title', index: 0, totalBlocks: 5 },
        { type: 'paragraph', level: 0, path: [], text: 'Content here.', index: 1, totalBlocks: 5 },
        { type: 'table', level: 0, path: [], text: '| a | b |\n|---|---|', index: 2, totalBlocks: 5 },
        { type: 'definition', level: 0, path: [], text: '"Term" means something.', index: 3, totalBlocks: 5 },
        { type: 'signature', level: 0, path: [], text: 'Name: John', index: 4, totalBlocks: 5 }
      ];

      const result = validator.validate('Some text with enough content.', blocks);
      const sig = result.structuralSignature;

      expect(sig.nBlocks).to.equal(5);
      expect(sig.typeCounts.heading).to.equal(1);
      expect(sig.typeCounts.paragraph).to.equal(1);
      expect(sig.typeCounts.table).to.equal(1);
      expect(sig.hasTables).to.be.true;
      expect(sig.hasSignatures).to.be.true;
      expect(sig.hasDefinitions).to.be.true;
      expect(sig.levelCounts[1]).to.equal(1);
    });

    it('should always include divergenceScore as null', () => {
      const result = validator.validate('text.', makeBlocks(['paragraph']));
      expect(result.divergenceScore).to.be.null;
    });
  });

  describe('status determination', () => {
    it('should return un_normalizable when both truncation and quality issues exist', () => {
      // Unclosed code fence (truncation) + majority unknown (quality)
      const text = 'Short\n```python\ndef x():';
      const blocks = makeBlocks(['unknown', 'unknown', 'unknown', 'paragraph']);

      const result = validator.validate(text, blocks);
      expect(result.status).to.equal('un_normalizable');
    });
  });
});
