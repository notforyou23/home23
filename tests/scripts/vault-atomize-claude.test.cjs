'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomizeClaudeArchive, conversationToMarkdown, conversationFilename } = require('../../scripts/vault/atomize-claude-archive.cjs');
const { classifyOrigin } = require('../../scripts/vault/vault-paths.cjs');

const FIXTURE = [{
  uuid: '11111111-2222-3333-4444-555555555555',
  name: 'Turtles All the Way Down',
  summary: 'A conversation about infinite recursion.',
  created_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-03-01T11:00:00Z',
  chat_messages: [
    { sender: 'human', text: 'What is at the bottom?' },
    { sender: 'assistant', text: 'Turtles.' },
  ],
}];

function tmpArchive(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-arch-'));
  const p = path.join(dir, 'conversations.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return { archive: p, out: path.join(dir, 'out') };
}

test('emits one markdown file per conversation, named by uuid for idempotency', () => {
  const { archive, out } = tmpArchive(FIXTURE);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 1);
  assert.deepEqual(fs.readdirSync(out), ['2026-03-01-turtles-all-the-way-down-11111111.md']);
});

test('markdown carries frontmatter with provenance and the pre-written summary', () => {
  const md = conversationToMarkdown(FIXTURE[0]);
  assert.match(md, /^---\n/);
  assert.match(md, /uuid: 11111111-2222-3333-4444-555555555555/);
  assert.match(md, /source: claude-archive/);
  assert.match(md, /# Turtles All the Way Down/);
  assert.match(md, /A conversation about infinite recursion\./);
  assert.match(md, /\*\*human:\*\*\n\nWhat is at the bottom\?/);
  assert.match(md, /\*\*assistant:\*\*\n\nTurtles\./);
});

test('is idempotent -- rerunning writes identical content', () => {
  const { archive, out } = tmpArchive(FIXTURE);
  atomizeClaudeArchive({ archivePath: archive, outDir: out });
  const first = fs.readFileSync(path.join(out, fs.readdirSync(out)[0]), 'utf8');
  atomizeClaudeArchive({ archivePath: archive, outDir: out });
  const second = fs.readFileSync(path.join(out, fs.readdirSync(out)[0]), 'utf8');
  assert.equal(first, second);
});

test('a conversation with no messages is skipped, not fabricated', () => {
  const { archive, out } = tmpArchive([{ uuid: 'aaaa', name: 'Empty', created_at: '2026-01-01T00:00:00Z', chat_messages: [] }]);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 0);
  assert.equal(result.skippedEmpty, 1);
});

// Regression test: the real Claude archive has messages whose top-level
// `text` field is empty and whose actual content lives only in the
// `content` block array (this is true for ~5% of messages in the real
// 250-conversation archive). A naive `m.text || m.content` fallback
// stringifies the array to the literal string "[object Object]" -- a
// plausible-looking file with destroyed content. None of the fixtures
// above exercise this path since they only use plain-string `text`.
test('a message with empty text but a structured content array is rendered, not stringified to [object Object]', () => {
  const convo = {
    uuid: '99999999-8888-7777-6666-555555555555',
    name: 'Structured Content Convo',
    created_at: '2026-04-01T00:00:00Z',
    chat_messages: [
      { sender: 'assistant', text: '', content: [{ type: 'text', text: 'The real reply lives in the content array.' }] },
    ],
  };
  const md = conversationToMarkdown(convo);
  assert.doesNotMatch(md, /\[object Object\]/);
  assert.match(md, /The real reply lives in the content array\./);
});

// Regression test: the real archive contains two distinct conversations
// with the same (empty) title on the same day (2024-09-20). Distinct uuid
// PREFIXES are the easy case -- an earlier version of this test used
// aaaaaaaa-/bbbbbbbb- and therefore passed against an implementation with
// no collision handling at all, since it only ever pinned "the uuid shows
// up in the filename". The uuids below deliberately SHARE their first
// segment, which is all the default filename uses, so the short names
// genuinely collide and the test fails unless collisions are resolved.
test('two conversations sharing a uuid prefix, title and day do not overwrite each other', () => {
  const { archive, out } = tmpArchive([
    { uuid: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'Same Title', created_at: '2024-09-20T01:00:00Z', chat_messages: [{ sender: 'human', text: 'first conversation' }] },
    { uuid: 'aaaaaaaa-2222-2222-2222-222222222222', name: 'Same Title', created_at: '2024-09-20T02:00:00Z', chat_messages: [{ sender: 'human', text: 'second conversation' }] },
  ]);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 2);
  const files = fs.readdirSync(out);
  assert.equal(files.length, 2, 'both conversations must exist as separate files on disk');
  const contents = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8'));
  assert.ok(contents.some((c) => c.includes('first conversation')), 'first conversation was silently overwritten');
  assert.ok(contents.some((c) => c.includes('second conversation')), 'second conversation is missing');
});

// `written` must describe what is ON DISK, not how many writes were
// attempted. The pre-fix implementation reported written:3 for the input
// below while leaving exactly one file behind.
test('written always equals the number of files actually on disk', () => {
  const { archive, out } = tmpArchive([
    { uuid: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'Dup', created_at: '2026-03-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'one' }] },
    { uuid: 'aaaaaaaa-2222-2222-2222-222222222222', name: 'Dup', created_at: '2026-03-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'two' }] },
    { uuid: 'cccccccc-3333-3333-3333-333333333333', name: 'Other', created_at: '2026-03-02T00:00:00Z', chat_messages: [{ sender: 'human', text: 'three' }] },
  ]);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, fs.readdirSync(out).length);
  assert.equal(result.written + result.skippedEmpty, result.total);
});

// The degenerate case that needs no hash luck at all: no uuid and no
// created_at means every conversation computes the same
// `undated-untitled-noid.md`, and there is nothing left to disambiguate
// with. Losing two of three conversations while reporting written:3 is the
// cardinal sin; a loud throw naming both items is the correct outcome.
test('conversations with no uuid and no created_at throw rather than overwrite', () => {
  const { archive, out } = tmpArchive([
    { name: '', chat_messages: [{ sender: 'human', text: 'conversation ONE' }] },
    { name: '', chat_messages: [{ sender: 'human', text: 'conversation TWO' }] },
  ]);
  assert.throws(
    () => atomizeClaudeArchive({ archivePath: archive, outDir: out }),
    /collision/i,
  );
  // Aborted before writing anything -- no half-clobbered output.
  assert.equal(fs.existsSync(out) ? fs.readdirSync(out).length : 0, 0);
});

// A single un-dated, un-titled conversation is NOT an error -- there is
// nothing to collide with, and refusing to emit it would itself be loss.
test('a single conversation with no uuid and no created_at is still emitted', () => {
  const { archive, out } = tmpArchive([
    { name: '', chat_messages: [{ sender: 'human', text: 'lonely conversation' }] },
  ]);
  const result = atomizeClaudeArchive({ archivePath: archive, outDir: out });
  assert.equal(result.written, 1);
  assert.equal(fs.readdirSync(out).length, 1);
});

// Filenames must not depend on the order conversations appear in the
// archive -- otherwise re-exporting the same conversations in a different
// order silently renames them, and the vault accumulates duplicates.
test('collision resolution is order-independent', () => {
  const a = { uuid: 'aaaaaaaa-1111-1111-1111-111111111111', name: 'Dup', created_at: '2026-03-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'one' }] };
  const b = { uuid: 'aaaaaaaa-2222-2222-2222-222222222222', name: 'Dup', created_at: '2026-03-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'two' }] };
  const forward = tmpArchive([a, b]);
  const reverse = tmpArchive([b, a]);
  atomizeClaudeArchive({ archivePath: forward.archive, outDir: forward.out });
  atomizeClaudeArchive({ archivePath: reverse.archive, outDir: reverse.out });
  assert.deepEqual(fs.readdirSync(forward.out).sort(), fs.readdirSync(reverse.out).sort());
});

// created_at is forwarded into a filename, and a filename is a path. An
// unvalidated token creates nested dirs ('2024/08/27'), escapes outDir
// ('../../../.'), or -- for ChatGPT's float create_time -- routes every
// conversation to notes/.
test('rejects a created_at that is not ISO-8601 rather than forwarding it into a path', () => {
  for (const bad of ['2024/08/27 10:00', 1712345678.123, '../../../../etc/passwd', 'yesterday']) {
    assert.throws(
      () => conversationFilename({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'hi', created_at: bad }),
      /unrecognised created_at/i,
      `should have rejected created_at: ${JSON.stringify(bad)}`,
    );
  }
});

test('a missing created_at is undated, not an error -- refusing to emit would itself be loss', () => {
  assert.match(conversationFilename({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'hi' }), /^undated-/);
  assert.match(conversationFilename({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'hi', created_at: null }), /^undated-/);
});

test('no emitted filename can escape outDir', () => {
  for (const c of [
    FIXTURE[0],
    { uuid: 'bbbbbbbb-1111-2222-3333-444444444444', name: '../../etc/passwd', created_at: '2026-01-01T00:00:00Z' },
  ]) {
    const name = conversationFilename(c);
    assert.equal(name.includes('/'), false, `emitted a path separator: ${name}`);
    assert.ok(path.resolve('/tmp/out', name).startsWith('/tmp/out' + path.sep), `escapes outDir: ${name}`);
  }
});

// slugify sanitises `name`, but shortId comes from String(convo.uuid) with no
// validation at all: uuid '../../../etc/passwd' produced
// '2026-01-01-hi-../../../etc/passwd.md', which resolves outside outDir.
test('a uuid containing path separators cannot reach the filename', () => {
  for (const badUuid of ['../../../etc/passwd', 'a/b', 'aaaa/../../x']) {
    for (const opts of [undefined, { fullUuid: true }]) {
      assert.throws(
        () => conversationFilename({ uuid: badUuid, name: 'hi', created_at: '2026-01-01T00:00:00Z' }, opts),
        /unsafe filename/i,
        `should have rejected uuid ${JSON.stringify(badUuid)} (fullUuid: ${!!opts})`,
      );
    }
  }
});

// The whole point of resolving names in a planning pass: an archive that
// cannot be named safely must abort having written nothing, rather than
// leave a partial vault behind.
test('an unusable archive aborts before writing anything', () => {
  const { archive, out } = tmpArchive([
    { uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Good One', created_at: '2026-01-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'good' }] },
    { uuid: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Bad One', created_at: '2024/08/27 10:00', chat_messages: [{ sender: 'human', text: 'bad' }] },
  ]);
  assert.throws(() => atomizeClaudeArchive({ archivePath: archive, outDir: out }), /unrecognised created_at/i);
  assert.equal(fs.existsSync(out) ? fs.readdirSync(out).length : 0, 0, 'must not leave a partially written vault behind');
});

// A missing updated_at must not silently borrow created_at: in a field
// labelled updated_at, a substituted value is indistinguishable from a real
// one for anything downstream.
test('a missing updated_at is null, not a laundered created_at', () => {
  const md = conversationToMarkdown({
    uuid: 'aaaaaaaa-1111-2222-3333-444444444444',
    name: 'No Update Time',
    created_at: '2026-03-01T10:00:00Z',
    chat_messages: [{ sender: 'human', text: 'hi' }],
  });
  assert.match(md, /updated_at: null/);
  assert.doesNotMatch(md, /updated_at: '2026-03-01T10:00:00Z'/);
});

// Cross-module coupling: vault-paths.cjs routes conversations with a regex
// matched against THIS module's filename format, but the two modules never
// import each other. If the format drifts, every conversation silently
// files itself into notes/ and conversations/ becomes a 0-byte directory.
test('atomizer output routes to conversations -- pins the cross-module coupling', () => {
  const name = conversationFilename(FIXTURE[0]);
  assert.equal(classifyOrigin(path.join('/Users/jtr/vault/conversations', name)), 'conversations');
});

// The full-uuid name is the collision-resolution path, so it must satisfy
// the same routing contract as the short name.
test('full-uuid collision-resolved filenames also route to conversations', () => {
  const name = conversationFilename(FIXTURE[0], { fullUuid: true });
  assert.equal(classifyOrigin(path.join('/Users/jtr/vault/conversations', name)), 'conversations');
});

// vault-paths.cjs was taught to route the literal `undated-` prefix, which
// only works while THIS module keeps emitting exactly that token. The two
// modules still never import each other, so pin the agreed spelling from
// this side: renaming it to `nodate-` or `unknown-` here would silently
// send every undated conversation back to notes/.
test('undated filenames route to conversations -- pins the agreed undated token', () => {
  const name = conversationFilename({ uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'No Date' });
  assert.match(name, /^undated-/);
  assert.equal(classifyOrigin(path.join('/Users/jtr/vault/conversations', name)), 'conversations');
});

// Regression test: the real archive has 509 messages (10.8%) carrying a
// top-level `attachments` array with pasted-file `extracted_content` --
// ~10.9M characters total, none of it duplicated in `text`/`content`. A
// version that only reads `text`/`content` silently drops every pasted
// file. `files` entries (uploaded PDFs/images with no inline content)
// must still leave a reference so the file's existence is recorded.
test('pasted-file attachments and file references are not silently dropped', () => {
  const convo = {
    uuid: '22222222-3333-4444-5555-666666666666',
    name: 'Convo With A Pasted File',
    created_at: '2026-05-01T00:00:00Z',
    chat_messages: [
      {
        sender: 'human',
        text: 'here is the log',
        attachments: [
          { file_name: 'error.log', file_size: 42, file_type: 'text/plain', extracted_content: 'FATAL: disk full at line 42' },
        ],
        files: [{ file_name: 'screenshot.png' }],
      },
    ],
  };
  const md = conversationToMarkdown(convo);
  assert.match(md, /error\.log/);
  assert.match(md, /FATAL: disk full at line 42/);
  assert.match(md, /screenshot\.png/);
});
