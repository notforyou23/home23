'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildArc,
  renderMarkdown,
  writeArc,
} = require('../../scripts/olddeadshows-issue-arc.cjs');

function writeIssue(dir, number, title, content) {
  fs.writeFileSync(path.join(dir, `${String(number).padStart(3, '0')}.json`), JSON.stringify({
    number,
    title,
    date: '2026-05-10',
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    content,
    description: content.slice(0, 140),
  }, null, 2));
}

test('olddeadshows issue arc extractor preserves order, gaps, themes, and directives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-issues-'));
  try {
    writeIssue(dir, 1, 'Memory Is A Lie', 'The system needs correction tombstones. Memory should preserve the old claim but stop letting it govern current action.');
    writeIssue(dir, 3, 'Manifest First', 'Real work must name a manifest, a verifier, and a receipt before it claims success.');

    const arc = buildArc(dir);

    assert.equal(arc.schema, 'home23.from-the-inside.issue-arc.v1');
    assert.equal(arc.count, 2);
    assert.deepEqual(arc.range.missing, [2]);
    assert.deepEqual(arc.rows.map((row) => row.number), [1, 3]);
    assert.ok(arc.rows[0].themes.includes('memory-coherence'));
    assert.ok(arc.rows[1].themes.includes('provenance-auditability'));
    assert.ok(arc.rows[0].directives.some((line) => /correction tombstones/i.test(line)));

    const markdown = renderMarkdown(arc);
    assert.match(markdown, /#001 Memory Is A Lie/);
    assert.match(markdown, /Missing issue numbers/);
    assert.match(markdown, /manifest-first/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('olddeadshows issue arc writer emits markdown and json artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-issues-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-issue-arc-'));
  try {
    writeIssue(dir, 1, 'Auditability', 'A claim should cite evidence. The fix is receipts, not more logs.');
    const markdownOut = path.join(out, 'arc.md');
    const jsonOut = path.join(out, 'arc.json');

    const result = writeArc({ issuesDir: dir, markdownOut, jsonOut });

    assert.equal(result.arc.count, 1);
    assert.match(fs.readFileSync(markdownOut, 'utf8'), /Auditability/);
    assert.equal(JSON.parse(fs.readFileSync(jsonOut, 'utf8')).count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
