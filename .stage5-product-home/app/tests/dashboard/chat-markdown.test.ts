import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderMarkdown } from '../../engine/src/dashboard/home23-chat-markdown.mjs';

describe('chat markdown', () => {
  it('escapes raw HTML before rendering', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> **ok**');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<strong>ok<\/strong>/);
  });

  it('renders fenced code with a copy control and escaped contents', () => {
    const html = renderMarkdown('```js\nconst x = "<hi>";\n```');
    assert.match(html, /class="h23-chat-code"/);
    assert.match(html, /data-copy="code"/);
    assert.match(html, /&lt;hi&gt;/);
    assert.doesNotMatch(html, /<hi>/);
  });

  it('renders links, lists, and inline code', () => {
    const html = renderMarkdown('See [docs](https://example.com) and `code`\n\n- one\n- two');
    assert.match(html, /href="https:\/\/example.com"/);
    assert.match(html, /rel="noreferrer noopener"/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<ul>/);
    assert.match(html, /<li>one<\/li>/);
  });

  it('keeps loose numbered items as one list without blank-line lis', () => {
    const html = renderMarkdown(
      'Three things:\n\n1. The house is manufacturing urgency. Queue is 4,530 deep.\n\n2. GrokBot grounding is stale.\n\n3. Nothing needs you.',
    );
    assert.match(html, /<ol>/);
    assert.equal((html.match(/<li>/g) || []).length, 3);
    assert.doesNotMatch(html, /<li><\/li>/);
    assert.match(html, /<li>The house is manufacturing urgency\. Queue is 4,530 deep\.<\/li>/);
    assert.match(html, /<li>GrokBot grounding is stale\.<\/li>/);
    assert.match(html, /<li>Nothing needs you\.<\/li>/);
    assert.match(html, /<p>Three things:<\/p><ol>/);
  });

  it('keeps loose bullet items as one list without blank-line lis', () => {
    const html = renderMarkdown('- one\n\n- two\n\n- three');
    assert.equal((html.match(/<li>/g) || []).length, 3);
    assert.doesNotMatch(html, /<li><\/li>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/);
  });

  it('keeps tight numbered items as one list', () => {
    const html = renderMarkdown('1. one\n2. two\n3. three');
    assert.equal((html.match(/<li>/g) || []).length, 3);
    assert.match(html, /<ol><li>one<\/li><li>two<\/li><li>three<\/li><\/ol>/);
  });

  it('renders tables after a header separator', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    assert.match(html, /<table class="h23-chat-table">/);
    assert.match(html, /<th>a<\/th>/);
    assert.match(html, /<td>1<\/td>/);
  });

  it('escapeHtml encodes quotes', () => {
    assert.equal(escapeHtml('a&b<"'), 'a&amp;b&lt;&quot;');
  });
});
