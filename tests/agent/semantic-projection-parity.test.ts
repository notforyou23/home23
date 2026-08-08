/**
 * The harness's projection mirror MUST equal the substrate's projection —
 * both packages perceive through the same species-level retina. If you
 * change one, this test forces you to change both. Never change the seed:
 * events already on chains were perceived through it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectEmbedding as harnessProject,
  SEMANTIC_PROJECTION_SEED as harnessSeed,
  SEM_DIM as harnessDim,
} from '../../src/substrate/embed-at-contact.js';
import {
  projectEmbedding as substrateProject,
  SEMANTIC_PROJECTION_SEED as substrateSeed,
  SEM_DIM as substrateDim,
} from '../../substrate/src/semantic-projection.js';

test('harness and substrate projections are the same retina', () => {
  assert.equal(harnessSeed, substrateSeed, 'same published seed');
  assert.equal(harnessDim, substrateDim, 'same output dimensionality');
  for (const w of [1, 2.5, 40, 777]) {
    const embedding = Array.from({ length: 768 }, (_, i) => Math.sin(w * 0.7 + i * 0.13));
    assert.deepEqual(harnessProject(embedding), substrateProject(embedding),
      `identical projection for probe ${w}`);
  }
});
