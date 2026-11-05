import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { Home23VibeService } = require('../../../engine/src/dashboard/home23-vibe/service.js');

function writeTinyPng(filePath) {
  writeFileSync(filePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ));
}

function makeVibeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'home23-vibe-gallery-'));
  const agent = 'jerry';
  const vibeImages = join(root, 'instances', agent, 'workspace', 'vibe', 'images');
  const sourceOne = join(root, 'external-one', 'images');
  const sourceTwo = join(root, 'external-two', 'images');

  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(vibeImages, { recursive: true });
  mkdirSync(sourceOne, { recursive: true });
  mkdirSync(sourceTwo, { recursive: true });

  writeFileSync(join(root, 'config', 'home.yaml'), `
dashboard:
  vibe:
    autoGenerate: false
    galleryLimit: 2
    sourcePaths:
      - ${sourceOne}
      - ${sourceTwo}
`, 'utf8');

  const storedItems = [
    {
      id: 'stored-new',
      agentName: agent,
      imagePath: join(vibeImages, 'stored-new.png'),
      generatedAt: '2026-05-03T12:00:00.000Z',
      caption: 'Stored newest',
      prompt: 'Stored prompt newest',
    },
    {
      id: 'stored-old',
      agentName: agent,
      imagePath: join(vibeImages, 'stored-old.png'),
      generatedAt: '2026-05-02T12:00:00.000Z',
      caption: 'Stored oldest',
      prompt: 'Stored prompt oldest',
    },
  ];
  for (const item of storedItems) writeTinyPng(item.imagePath);
  writeFileSync(join(root, 'instances', agent, 'workspace', 'vibe', 'manifest.json'), JSON.stringify({
    version: 1,
    agentName: agent,
    items: storedItems,
  }, null, 2), 'utf8');

  writeTinyPng(join(sourceOne, 'external-new.png'));
  writeFileSync(join(root, 'external-one', 'manifest.json'), JSON.stringify({
    items: [{
      id: 'external-new',
      generatedAt: '2026-05-04T12:00:00.000Z',
      prompt: 'External source prompt newest',
      caption: 'External source caption newest',
      thought: 'External source thought newest',
    }],
  }, null, 2), 'utf8');

  writeTinyPng(join(sourceTwo, 'external-old.png'));
  writeFileSync(join(root, 'external-two', 'manifest.json'), JSON.stringify({
    items: [{
      id: 'external-old',
      generatedAt: '2026-05-01T12:00:00.000Z',
      prompt: 'External source prompt oldest',
      caption: 'External source caption oldest',
      thought: 'External source thought oldest',
    }],
  }, null, 2), 'utf8');

  const service = new Home23VibeService({
    home23Root: root,
    agentName: agent,
    loadState: async () => ({}),
    logger: { info() {}, warn() {} },
  });

  return { root, service };
}

test('Vibe full-gallery mode returns generated and all configured source images', async () => {
  const { root, service } = makeVibeFixture();
  try {
    const gallery = await service.listGallery('all');

    assert.equal(gallery.total, 4);
    assert.equal(gallery.storedTotal, 2);
    assert.equal(gallery.externalTotal, 2);
    assert.equal(gallery.images.length, 4);
    assert.deepEqual(gallery.images.map((item) => item.caption), [
      'External source caption newest',
      'Stored newest',
      'Stored oldest',
      'External source caption oldest',
    ]);
    assert.equal(gallery.images.filter((item) => item.source === 'external').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vibe can resolve a displayed source image directly with prompt metadata', async () => {
  const { root, service } = makeVibeFixture();
  try {
    const gallery = await service.listGallery('all');
    const sourceItem = gallery.images.find((item) => item.source === 'external');
    assert.ok(sourceItem, 'fixture should expose a source image');
    assert.equal(sourceItem.caption, 'External source caption newest');

    const detail = await service.getGalleryItem(sourceItem.id);
    assert.equal(detail.id, sourceItem.id);
    assert.equal(detail.source, 'external');
    assert.equal(detail.prompt, 'External source prompt newest');
    assert.match(detail.url, /\/home23\/api\/media\?path=/);
    assert.equal(detail.galleryUrl, `/home23/vibe-gallery?image=${encodeURIComponent(detail.id)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
