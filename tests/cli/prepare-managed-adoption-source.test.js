import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareManagedAdoptionSource } from '../../cli/lib/prepare-managed-adoption-source.js';
import { planManagedSourceAdoption } from '../../cli/lib/product-update.js';
import { OWNED_RECIPE_HASH } from '../../cli/lib/product-embedder.js';

test('prepareManagedAdoptionSource births two residents without copying a live home', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-managed-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const prepared = await prepareManagedAdoptionSource({
    root: source,
    residents: [
      { name: 'ada', ownerName: 'Fixture Owner', purpose: 'Adoption proof', provider: 'ollama-local', model: 'fixture', note: 'Ada local note.' },
      { name: 'zed', ownerName: 'Fixture Owner', purpose: 'Adoption proof', provider: 'ollama-local', model: 'fixture', note: 'Zed local note.' },
    ],
  });
  assert.equal(prepared.births.length, 2);
  for (const birth of prepared.births) {
    const receipt = JSON.parse(fs.readFileSync(path.join(source, 'instances', birth.name, 'substrate/seed-01/birth-receipt.json'), 'utf8'));
    assert.equal(receipt.schema, 'home23.seed-birth.v1');
    assert.equal(receipt.seedId, birth.seedId);
    assert.equal(receipt.runtimeStarted, false);
    assert.equal(receipt.modelInvocations, 0);
    const history = fs.readFileSync(path.join(source, 'instances', birth.name, 'conversations', `${birth.name}__local-note.jsonl`), 'utf8');
    assert.match(history, /"role":"user"/);
  }
  const prep = JSON.parse(fs.readFileSync(path.join(source, 'runtime/semantic-prep.json'), 'utf8'));
  assert.equal(prep.recipeId, OWNED_RECIPE_HASH);
  assert.notEqual(prep.phase, 'ready');
  const plan = planManagedSourceAdoption(source);
  assert.equal(plan.layout, 'managed');
  assert.equal(plan.canAdopt, true);
  assert.equal(plan.plan.homeBirth, 'not_run');
  assert.deepEqual(plan.identity.residents, ['ada', 'zed']);
});

test('prepareManagedAdoptionSource refuses a nonempty root before writing', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-managed-source-')));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'keep.txt'), 'already here\n');
  await assert.rejects(
    () => prepareManagedAdoptionSource({
      root: source,
      residents: [
        { name: 'ada', ownerName: 'Fixture Owner', purpose: 'Adoption proof', provider: 'ollama-local', model: 'fixture', note: 'Ada local note.' },
        { name: 'zed', ownerName: 'Fixture Owner', purpose: 'Adoption proof', provider: 'ollama-local', model: 'fixture', note: 'Zed local note.' },
      ],
    }),
    /not an empty directory/,
  );
  assert.deepEqual(fs.readdirSync(source), ['keep.txt']);
  assert.equal(fs.existsSync(path.join(source, 'instances')), false);
  fs.rmSync(root, { recursive: true, force: true });
});
