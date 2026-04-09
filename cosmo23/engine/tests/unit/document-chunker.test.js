const { expect } = require('chai');

describe('DocumentChunker', () => {
  let DocumentChunker, chunker;

  before(() => {
    ({ DocumentChunker } = require('../../src/ingestion/document-chunker'));
  });

  beforeEach(() => {
    chunker = new DocumentChunker({
      maxChunkSize: 3000,
      overlap: 300,
      logger: { info: () => {}, warn: () => {}, debug: () => {} }
    });
  });

  describe('canonical block output format', () => {
    it('should produce blocks with blockId, type, path, and level fields', () => {
      const text = '## Methods\n\nSome methods here.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      expect(result.chunks.length).to.be.greaterThan(0);
      const block = result.chunks[0];
      expect(block).to.have.property('blockId');
      expect(block.blockId).to.match(/^b_[0-9a-f]{12}$/);
      expect(block).to.have.property('type');
      expect(block).to.have.property('level');
      expect(block).to.have.property('path');
      expect(block.path).to.be.an('array');
      expect(block).to.have.property('index');
      expect(block).to.have.property('totalBlocks');
      expect(block).to.have.property('strategy');
    });

    it('should maintain backward-compat fields: totalChunks, heading, depth', () => {
      const text = '## Methods\n\nSome methods here.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const block = result.chunks[0];
      expect(block).to.have.property('totalChunks');
      expect(block).to.have.property('heading');
      expect(block).to.have.property('depth');
      expect(block.totalChunks).to.equal(block.totalBlocks);
    });
  });

  describe('block type detection', () => {
    it('should detect heading blocks', () => {
      const text = '## Section Title\n\nContent here.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const headingBlock = result.chunks.find(c => c.type === 'heading');
      expect(headingBlock).to.exist;
      expect(headingBlock.level).to.equal(2);
    });

    it('should detect code blocks', () => {
      const text = '## Code\n\n```python\ndef hello():\n    print("hi")\n```\n\nAfter code.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const codeBlock = result.chunks.find(c => c.type === 'code');
      expect(codeBlock).to.exist;
      expect(codeBlock.text).to.include('def hello');
    });

    it('should detect list_item blocks', () => {
      const text = '## Lists\n\n- Item one\n- Item two\n- Item three\n\nParagraph after.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const listBlock = result.chunks.find(c => c.type === 'list_item');
      expect(listBlock).to.exist;
      expect(listBlock.text).to.include('Item one');
    });

    it('should detect numbered list items', () => {
      const text = '## Steps\n\n1. First step\n2. Second step\n3. Third step';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const listBlock = result.chunks.find(c => c.type === 'list_item');
      expect(listBlock).to.exist;
      expect(listBlock.text).to.include('First step');
    });

    it('should detect table blocks', () => {
      const text = '## Data\n\n| Name | Value |\n|------|-------|\n| A    | 1     |\n| B    | 2     |\n\nAfter table.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const tableBlock = result.chunks.find(c => c.type === 'table');
      expect(tableBlock).to.exist;
      expect(tableBlock.text).to.include('Name');
    });

    it('should detect definition blocks', () => {
      const text = '## Definitions\n\n"Affiliate" means any entity that controls.\n\n"Term" means the period.\n\nRegular paragraph.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const defBlock = result.chunks.find(c => c.type === 'definition');
      expect(defBlock).to.exist;
      expect(defBlock.text).to.include('means');
    });

    it('should detect signature blocks near end of document', () => {
      const text = 'Some content.\n\n' +
        'More content here that is the body of the document.\n\n' +
        'Even more content for bulk.\n\n' +
        'Final paragraph of body.\n\n' +
        '_______________\nName: John Doe\nTitle: CEO\nDate: 2025-01-01';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const sigBlock = result.chunks.find(c => c.type === 'signature');
      expect(sigBlock).to.exist;
      expect(sigBlock.text).to.include('Name:');
    });

    it('should detect paragraph blocks for normal text', () => {
      const text = '## Intro\n\nThis is a normal paragraph of text that does not match any special pattern.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const paraBlock = result.chunks.find(c => c.type === 'paragraph');
      expect(paraBlock).to.exist;
      expect(paraBlock.text).to.include('normal paragraph');
    });
  });

  describe('hierarchical path construction', () => {
    it('should build paths from heading hierarchy', () => {
      const text = [
        '# Document',
        '',
        'Intro.',
        '',
        '## Article 2',
        '',
        '### 2.1 Definitions',
        '',
        'Some definitions here.'
      ].join('\n');

      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const defPara = result.chunks.find(c => c.text.includes('Some definitions'));
      expect(defPara).to.exist;
      expect(defPara.path).to.deep.equal(['Document', 'Article 2', '2.1 Definitions']);
    });

    it('should pop heading stack when same-level heading appears', () => {
      const text = [
        '## Section A',
        '',
        'Content A.',
        '',
        '## Section B',
        '',
        'Content B.'
      ].join('\n');

      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const contentB = result.chunks.find(c => c.text.includes('Content B'));
      expect(contentB).to.exist;
      expect(contentB.path).to.deep.equal(['Section B']);
    });

    it('should handle deep nesting and reset properly', () => {
      const text = [
        '# Top',
        '',
        '## Mid',
        '',
        '### Deep',
        '',
        'Deep content.',
        '',
        '## Another Mid',
        '',
        'Another mid content.'
      ].join('\n');

      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const deepContent = result.chunks.find(c => c.text.includes('Deep content'));
      expect(deepContent).to.exist;
      expect(deepContent.path).to.deep.equal(['Top', 'Mid', 'Deep']);

      const anotherMid = result.chunks.find(c => c.text.includes('Another mid content'));
      expect(anotherMid).to.exist;
      expect(anotherMid.path).to.deep.equal(['Top', 'Another Mid']);
    });
  });

  describe('semantic chunking on markdown headings', () => {
    it('should split on H2 headings keeping sections intact', () => {
      const text = [
        '# Main Title',
        '',
        'Intro paragraph.',
        '',
        '## Section One',
        '',
        'Content for section one.',
        '',
        '## Section Two',
        '',
        'Content for section two.'
      ].join('\n');

      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      expect(result.chunks.length).to.be.greaterThan(1);
      expect(result.chunks[0].text).to.include('Main Title');
      const sectionOneChunk = result.chunks.find(c => c.text.includes('Content for section one'));
      const sectionTwoChunk = result.chunks.find(c => c.text.includes('Content for section two'));
      expect(sectionOneChunk).to.exist;
      expect(sectionTwoChunk).to.exist;
    });

    it('should set heading and depth metadata on chunks', () => {
      const text = '## Methods\n\nSome methods here.\n\n### Sub Method\n\nDetails.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const methodsChunk = result.chunks.find(c => c.type === 'heading' && c.text.includes('Methods') && c.level === 2);
      expect(methodsChunk).to.exist;
      expect(methodsChunk.depth).to.equal(2);
    });
  });

  describe('sliding window fallback', () => {
    it('should use sliding window for unstructured text', () => {
      const text = 'A'.repeat(7000);
      const result = chunker.chunk(text, { filePath: '/flat.txt', format: 'txt' });

      expect(result.chunks.length).to.equal(3);
      expect(result.chunks[0].strategy).to.equal('sliding-window');
      expect(result.chunks[0].text.length).to.equal(3000);
    });

    it('should apply overlap between sliding window chunks', () => {
      const text = 'ABCDEFGHIJ'.repeat(500);
      const result = chunker.chunk(text, { filePath: '/flat.txt', format: 'txt' });

      const firstEnd = result.chunks[0].text.slice(-300);
      const secondStart = result.chunks[1].text.slice(0, 300);
      expect(firstEnd).to.equal(secondStart);
    });
  });

  describe('oversized sections fall back to paragraph splitting', () => {
    it('should split large sections by paragraphs, not sliding window', () => {
      const bigSection = Array.from({ length: 20 }, (_, i) =>
        `Paragraph ${i}. ${'X'.repeat(200)}`
      ).join('\n\n');
      const text = `## Big Section\n\n${bigSection}`;
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      expect(result.chunks.length).to.be.greaterThan(1);
      result.chunks.forEach(c => {
        if (c.type !== 'heading') {
          expect(c.text.length).to.be.at.most(3000);
        }
      });
    });

    it('should paragraph-split a single oversized section (no other headings)', () => {
      const paragraphs = Array.from({ length: 15 }, (_, i) =>
        `Paragraph ${i}. ${'Y'.repeat(250)}`
      ).join('\n\n');
      const text = `## Only Section\n\n${paragraphs}`;
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      expect(result.chunks.length).to.be.greaterThan(1);
      const semanticChunks = result.chunks.filter(c => c.strategy === 'semantic');
      expect(semanticChunks.length).to.equal(result.chunks.length);
    });
  });

  describe('structural relationships', () => {
    it('should generate FOLLOWS relationships for sequential chunks', () => {
      const text = '## A\n\nContent A.\n\n## B\n\nContent B.\n\n## C\n\nContent C.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const follows = result.relationships.filter(r => r.type === 'FOLLOWS');
      expect(follows.length).to.be.greaterThan(0);
      follows.forEach(r => {
        expect(r.to).to.equal(r.from + 1);
      });
    });

    it('should generate CONTAINS relationships with parent context', () => {
      const text = '## Methods\n\nContent A.\n\n## Results\n\nContent B.';
      const result = chunker.chunk(text, { filePath: '/test.md', format: 'md' });

      const contains = result.relationships.filter(r => r.type === 'CONTAINS');
      expect(contains.length).to.be.greaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty text', () => {
      const result = chunker.chunk('', { filePath: '/empty.md', format: 'md' });
      expect(result.chunks).to.have.length(0);
      expect(result.relationships).to.have.length(0);
    });

    it('should handle single short paragraph', () => {
      const result = chunker.chunk('Hello world.', { filePath: '/tiny.md', format: 'md' });
      expect(result.chunks).to.have.length(1);
      expect(result.chunks[0].text).to.equal('Hello world.');
      expect(result.chunks[0].index).to.equal(0);
      expect(result.chunks[0].totalChunks).to.equal(1);
      expect(result.chunks[0].totalBlocks).to.equal(1);
    });

    it('should not split inside code fences', () => {
      const text = [
        '## Code Example',
        '',
        '```python',
        'def hello():',
        '    print("hello")',
        '```',
        '',
        'After the code.'
      ].join('\n');
      const result = chunker.chunk(text, { filePath: '/code.md', format: 'md' });

      const codeChunk = result.chunks.find(c => c.text.includes('```python'));
      expect(codeChunk.text).to.include('print("hello")');
      expect(codeChunk.text).to.include('```');
    });

    it('should keep oversized code fences intact (never split mid-fence)', () => {
      const smallChunker = new DocumentChunker({ maxChunkSize: 200, overlap: 30, logger: { info: () => {}, warn: () => {}, debug: () => {} } });
      const bigFence = '```python\n' + Array.from({ length: 30 }, (_, i) => `print("line ${i}")`).join('\n') + '\n```';
      const text = `## Code\n\nBefore.\n\n${bigFence}\n\nAfter.`;
      const result = smallChunker.chunk(text, { filePath: '/code.md', format: 'md' });

      const fenceChunk = result.chunks.find(c => c.text.includes('```python'));
      expect(fenceChunk).to.exist;
      const fenceLines = fenceChunk.text.split('\n');
      const openings = fenceLines.filter(l => l.trimStart().startsWith('```'));
      expect(openings.length).to.be.at.least(2);
    });
  });
});
