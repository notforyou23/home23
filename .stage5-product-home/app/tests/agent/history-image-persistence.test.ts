import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistory, type StoredMessage } from '../../src/agent/history.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('image blocks survive append→load roundtrip via image_ref + rehydrate', () => {
  const root = join(tmpdir(), `history-image-${Date.now()}`);
  const historyDir = join(root, 'conversations');
  mkdirSync(historyDir, { recursive: true });
  const imgPath = join(root, 'pic.png');
  writeFileSync(imgPath, TINY_PNG);

  const history = new ConversationHistory(historyDir, 400_000, 'test');

  // Append a user message with a full image block (path on the block).
  const userMsg: StoredMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'check this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: TINY_PNG.toString('base64') },
        path: imgPath,
        fileName: 'pic.png',
      },
    ],
  };
  history.append('chat-1', [userMsg]);

  // On disk, the image block must be replaced by image_ref (no base64 in JSONL).
  const filePath = join(historyDir, 'test__chat-1.jsonl');
  const onDisk = readFileSync(filePath, 'utf-8');
  assert.ok(!onDisk.includes(TINY_PNG.toString('base64')), 'base64 must not be persisted');
  assert.ok(onDisk.includes('"type":"image_ref"'), 'image_ref pointer must be persisted');
  assert.ok(onDisk.includes(imgPath), 'persisted image_ref must include the disk path');

  // load() must rehydrate the image_ref back into a full image block.
  const loaded = history.load('chat-1') as StoredMessage[];
  assert.equal(loaded.length, 1);
  const blocks = loaded[0]!.content as any[];
  const imgBlock = blocks.find(b => b.type === 'image');
  assert.ok(imgBlock, 'image block must be rehydrated');
  assert.equal(imgBlock.source.type, 'base64');
  assert.equal(imgBlock.source.media_type, 'image/png');
  assert.equal(imgBlock.source.data, TINY_PNG.toString('base64'));
  assert.equal(imgBlock.path, imgPath);

  rmSync(root, { recursive: true, force: true });
});

test('missing image file falls back to text placeholder on load', () => {
  const root = join(tmpdir(), `history-image-missing-${Date.now()}`);
  const historyDir = join(root, 'conversations');
  mkdirSync(historyDir, { recursive: true });
  const imgPath = join(root, 'gone.png');
  writeFileSync(imgPath, TINY_PNG);

  const history = new ConversationHistory(historyDir, 400_000, 'test');
  history.append('chat-2', [{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG.toString('base64') },
      path: imgPath,
    }],
  }]);

  // Delete the file before reload.
  rmSync(imgPath);

  const loaded = history.load('chat-2') as StoredMessage[];
  const blocks = loaded[0]!.content as any[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /file unavailable/);

  rmSync(root, { recursive: true, force: true });
});
