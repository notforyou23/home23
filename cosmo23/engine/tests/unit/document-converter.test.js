'use strict';

const { expect } = require('chai');

describe('DocumentConverter', () => {
  let DocumentConverter, converter;

  before(() => {
    ({ DocumentConverter } = require('../../src/ingestion/document-converter'));
  });

  beforeEach(() => {
    converter = new DocumentConverter({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      visionModel: 'gpt-4o-mini',
      pythonPath: 'python3'
    });
  });

  describe('isNativeText()', () => {
    it('should identify markdown as native text', () => {
      expect(converter.isNativeText('/docs/readme.md')).to.be.true;
    });

    it('should identify txt as native text', () => {
      expect(converter.isNativeText('/notes/file.txt')).to.be.true;
    });

    it('should identify json as native text', () => {
      expect(converter.isNativeText('/data/config.json')).to.be.true;
    });

    it('should identify code files as native text', () => {
      expect(converter.isNativeText('/src/app.js')).to.be.true;
      expect(converter.isNativeText('/src/main.py')).to.be.true;
      expect(converter.isNativeText('/src/lib.rs')).to.be.true;
    });

    it('should not identify PDF as native text', () => {
      expect(converter.isNativeText('/docs/paper.pdf')).to.be.false;
    });

    it('should not identify DOCX as native text', () => {
      expect(converter.isNativeText('/docs/report.docx')).to.be.false;
    });
  });

  describe('isConvertible()', () => {
    it('should identify PDF as convertible', () => {
      expect(converter.isConvertible('/docs/paper.pdf')).to.be.true;
    });

    it('should identify DOCX as convertible', () => {
      expect(converter.isConvertible('/docs/report.docx')).to.be.true;
    });

    it('should identify images as convertible', () => {
      expect(converter.isConvertible('/img/photo.jpg')).to.be.true;
      expect(converter.isConvertible('/img/scan.png')).to.be.true;
      expect(converter.isConvertible('/img/pic.heic')).to.be.true;
    });

    it('should identify audio as convertible', () => {
      expect(converter.isConvertible('/audio/recording.mp3')).to.be.true;
      expect(converter.isConvertible('/audio/note.m4a')).to.be.true;
    });

    it('should identify spreadsheets as convertible', () => {
      expect(converter.isConvertible('/data/sheet.xlsx')).to.be.true;
      expect(converter.isConvertible('/data/numbers.numbers')).to.be.true;
    });

    it('should identify presentations as convertible', () => {
      expect(converter.isConvertible('/slides/deck.pptx')).to.be.true;
      expect(converter.isConvertible('/slides/keynote.key')).to.be.true;
    });

    it('should not identify native text as convertible', () => {
      expect(converter.isConvertible('/docs/readme.md')).to.be.false;
    });

    it('should not identify unknown extensions as convertible', () => {
      expect(converter.isConvertible('/data/file.xyz')).to.be.false;
    });
  });

  describe('convert() with native text', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('should read native text files directly', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-converter-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, '# Hello\n\nWorld.');
      try {
        const result = await converter.convert(tmpFile);
        expect(result).to.not.be.null;
        expect(result.text).to.equal('# Hello\n\nWorld.');
        expect(result.format).to.equal('md');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should return null for empty files', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-converter-empty-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, '');
      try {
        const result = await converter.convert(tmpFile);
        expect(result).to.be.null;
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
