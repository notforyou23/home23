const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSynthesisCommitBlock,
  parseSynthesisCommitReceipt,
  resolveSynthesisCommitConfig
} = require('../../lib/synthesis-commit');

test('resolves commit-step defaults and per-mode overrides', () => {
  const dive = resolveSynthesisCommitConfig(null, 'dive');
  assert.equal(dive.applied, true);
  assert.equal(dive.spineCap, 5);
  assert.deepEqual(dive.bucketNames, {
    spine: 'SPINE',
    facet: 'FACET',
    artifact: 'ARTIFACT'
  });

  const explore = resolveSynthesisCommitConfig(null, 'explore');
  assert.equal(explore.applied, false);
  assert.equal(explore.reason, 'mode override disabled commit step');

  const pgs = resolveSynthesisCommitConfig({
    commitStep: true,
    spineCap: 3,
    modeOverrides: { pgs: false }
  }, 'pgs');
  assert.equal(pgs.applied, false);
  assert.equal(pgs.spineCap, 3);
});

test('builds commit-step prompt with cap, bucket names, and body-level pressure', () => {
  const cfg = resolveSynthesisCommitConfig({
    spineCap: 4,
    bucketNames: {
      spine: 'PRIMARY',
      facet: 'SUPPORTING',
      artifact: 'CONTEXT'
    }
  }, 'dive');

  const block = buildSynthesisCommitBlock(cfg);

  assert.match(block, /Commit Step \(Required\)/);
  assert.match(block, /PRIMARY bucket has a hard cap of 4/);
  assert.match(block, /SUPPORTING/);
  assert.match(block, /CONTEXT/);
  assert.match(block, /applied throughout, not as an appendix/i);
});

test('parses bucket counts, spine names, cannot-classify, and ranked experiments', () => {
  const markdown = `
# Committed Verdict

## SPINE
1. retrieve_and_fill - substrate anchored.
2. parametric_recall - transferable.
3. constraint_propagation - dissociable.
4. projection - validated across partitions.

## FACET
- induction_head_retrieval - facet of retrieve_and_fill.
- vector_arithmetic_probe - facet of projection.
- template_completion - facet of parametric_recall.

## ARTIFACT
- benchmark_shell - surface label.
- product_taxonomy - output shell.

## Cannot classify
- missing_ablation - term appears in no available partition.

## Ranked Experiments
1. ablate induction heads + function-vector heads under matched tests
   Moves: retrieve_and_fill stays one spine vs fractures into two
   Cost-to-information: high info, moderate cost
2. compare projection failures across analogy and coreference
   Moves: projection moves to artifact if it only tracks benchmark labels
   Cost-to-information: medium info, low cost
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 5,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.applied, true);
  assert.equal(receipt.spine_cap, 5);
  assert.equal(receipt.spine_count, 4);
  assert.deepEqual(receipt.spine_names, [
    'retrieve_and_fill',
    'parametric_recall',
    'constraint_propagation',
    'projection'
  ]);
  assert.equal(receipt.facet_count, 3);
  assert.equal(receipt.artifact_count, 2);
  assert.equal(receipt.cannot_classify_count, 1);
  assert.equal(receipt.experiments_ranked.length, 2);
  assert.equal(receipt.experiments_ranked[0].experiment, 'ablate induction heads + function-vector heads under matched tests');
  assert.equal(receipt.experiments_ranked[0].moves_what_between_what, 'retrieve_and_fill stays one spine vs fractures into two');
  assert.equal(receipt.experiments_ranked[0].cost_to_information, 'high info, moderate cost');
  assert.equal(receipt.parse_status, 'ok');
});

test('parses committed prose with final-spine headings, tables, and artifact paragraphs', () => {
  const markdown = `
## Committed Synthesis

### Final Spine (<=5 moves, hard cap enforced)

**SPINE-1: Parametric recall** - cue-conditioned reconstruction.

**SPINE-2: Binding under interference** - role maintenance.

**SPINE-3: Retrieve-and-fill** - slot matching.

**SPINE-4: Constraint propagation** - requirement threading.

### FACET bucket (perturbation regimes of spine)

| Facet | Parent spine |
|-------|-------------|
| Role-filler binding | Binding under interference |
| Cue-conditioned activation | Parametric recall |

### ARTIFACT bucket (benchmark/output-shell names)

Reasoning, memory, coding, math - all are package labels for bundled moves, not substrate operations.

## Ranked Experiment List

| Rank | Experiment | What it resolves | Estimated cost |
|------|-----------|------------------|----------------|
| 1 | Paired dissociations for SPINE-1 vs SPINE-3 | Confirms separability. | Low |
| 2 | Binding-load stress test for SPINE-2 | Validates binding under interference. | Medium |
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 5,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.spine_count, 4);
  assert.deepEqual(receipt.spine_names, [
    'Parametric recall',
    'Binding under interference',
    'Retrieve-and-fill',
    'Constraint propagation'
  ]);
  assert.equal(receipt.facet_count, 2);
  assert.equal(receipt.artifact_count, 4);
  assert.equal(receipt.experiments_ranked.length, 2);
  assert.equal(receipt.experiments_ranked[0].moves_what_between_what, 'Confirms separability.');
  assert.equal(receipt.experiments_ranked[0].cost_to_information, 'Low');
});

test('parses spine vocabulary tables and bold ranked experiment paragraphs', () => {
  const markdown = `
## Spine Vocabulary (SPINE bucket, <=4 cap)

| Canonical Name | Evidence | Substrate |
|---|---|---|
| **cue-addressed latent reconstruction** | Function-vector transfer | residual directions |

## Facet Bucket

- **role-binding failure** (FACET of cue-addressed reconstruction)

## Artifact Bucket

- **scratchpads, CoT, RAG, tools**: scaffolding artifacts.

## Ranked Experiment List (cost-to-information order)

**Rank 1 - Dissociation probe for binding under interference (cost: low; information: high)**
Build paired minimal-pair probes where surface format is held constant but binding load varies.
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 4,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.spine_count, 1);
  assert.deepEqual(receipt.spine_names, ['cue-addressed latent reconstruction']);
  assert.equal(receipt.facet_count, 1);
  assert.equal(receipt.artifact_count, 1);
  assert.equal(receipt.experiments_ranked.length, 1);
  assert.equal(receipt.experiments_ranked[0].experiment, 'Dissociation probe for binding under interference');
  assert.equal(receipt.experiments_ranked[0].moves_what_between_what, 'Build paired minimal-pair probes where surface format is held constant but binding load varies.');
  assert.equal(receipt.experiments_ranked[0].cost_to_information, 'high info, low');
});

test('parses plural bucket headings with bold numbered spine and experiment entries', () => {
  const markdown = `
### SPINE (<=4)

**1. retrieve-and-fill** - strongest convergence.
- **Localizable substrate**: mid-layer patching.
- **Transferable activation**: function vectors.

**2. binding under interference** - second candidate.
- **Localizable substrate**: induction heads.

### FACETS

**Binding under interference facets:**
- coreference resolution, entity tracking

### ARTIFACTS

"reasoning," "memory," "math," "coding" are package labels.

### RANKED EXPERIMENTS

**1. Causal patching test (Cost: B)**
Directly tests retrieve-and-fill substrate.
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 4,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.spine_count, 2);
  assert.deepEqual(receipt.spine_names, ['retrieve-and-fill', 'binding under interference']);
  assert.equal(receipt.facet_count, 1);
  assert.equal(receipt.artifact_count, 4);
  assert.equal(receipt.experiments_ranked.length, 1);
  assert.equal(receipt.experiments_ranked[0].experiment, 'Causal patching test');
  assert.equal(receipt.experiments_ranked[0].cost_to_information, 'B');
});

test('parses bold-only numbered spine labels followed by prose', () => {
  const markdown = `
## SPINE

**S-1: retrieve-and-fill**
Locatable via induction-head circuits.

**S-2: binding under interference**
Maintains slot-filler alignment.

## FACET

**F-1: cue-to-latent-binding** - facet of S-1.

## ARTIFACT

- benchmark labels

## Ranked Experiments

1. Probe binding load
   Moves: S-2 vs F-1
   Cost-to-information: Low
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 4,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.spine_count, 2);
  assert.deepEqual(receipt.spine_names, ['retrieve-and-fill', 'binding under interference']);
  assert.equal(receipt.facet_count, 1);
  assert.equal(receipt.experiments_ranked.length, 1);
});

test('parses nested heading entries inside bucket sections', () => {
  const markdown = `
## SPINE

#### 1. \`retrieve-and-fill\` - SPINE
Evidence paragraph.

#### 2. \`binding-under-interference\` - SPINE
Evidence paragraph.

## FACET

#### 1. \`cue-to-latent-binding\` - FACET of retrieve-and-fill

## ARTIFACT

#### 1. \`benchmark shell\` - ARTIFACT

## Ranked Experiments

1. Probe nested headings
   Moves: heading parsing
   Cost-to-information: Low
`;

  const receipt = parseSynthesisCommitReceipt(markdown, {
    applied: true,
    spineCap: 4,
    bucketNames: { spine: 'SPINE', facet: 'FACET', artifact: 'ARTIFACT' }
  });

  assert.equal(receipt.spine_count, 2);
  assert.deepEqual(receipt.spine_names, ['retrieve-and-fill', 'binding-under-interference']);
  assert.equal(receipt.facet_count, 1);
  assert.equal(receipt.artifact_count, 1);
});

test('returns disabled receipt shape when commit step is off', () => {
  const cfg = resolveSynthesisCommitConfig({ commitStep: false }, 'dive');
  const receipt = parseSynthesisCommitReceipt('# Normal synthesis', cfg);

  assert.deepEqual(receipt, {
    applied: false,
    spine_cap: 5,
    reason: 'commitStep disabled'
  });
});
