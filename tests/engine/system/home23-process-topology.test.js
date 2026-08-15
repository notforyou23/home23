import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyHome23Process,
  annotateHome23ProcessList,
} = require('../../../engine/src/system/home23-process-topology.js');

const ROOT = '/Users/jtr/_JTR23_/release/home23';

test('classifies arbitrary Home23 sibling triplets without hardcoding Jerry', () => {
  const agentNames = ['jerry', 'forrest', 'mabel'];

  for (const agentName of agentNames) {
    assert.equal(
      classifyHome23Process({
        name: `home23-${agentName}`,
        script: `${ROOT}/engine/src/index.js`,
      }).role,
      'agent-engine'
    );
    assert.equal(
      classifyHome23Process({
        name: `home23-${agentName}-dash`,
        script: `${ROOT}/engine/src/dashboard/server.js`,
      }).role,
      'agent-dashboard'
    );
    assert.equal(
      classifyHome23Process({
        name: `home23-${agentName}-harness`,
        script: `${ROOT}/dist/home.js`,
      }).role,
      'agent-harness'
    );
  }
});

test('classifies conditional mcp and seed processes as agent roles, not phantom agents', () => {
  const mcp = classifyHome23Process({
    name: 'home23-jerry-mcp',
    script: `${ROOT}/engine/mcp/http-server.js`,
  });
  assert.equal(mcp.role, 'agent-mcp');
  assert.equal(mcp.agentName, 'jerry');
  assert.equal(mcp.topologyWarning, null);

  const seed = classifyHome23Process({
    name: 'home23-jerry-seed',
    script: `${ROOT}/substrate/bin/seed-runner.ts`,
  });
  assert.equal(seed.role, 'agent-seed');
  assert.equal(seed.agentName, 'jerry');
  assert.equal(seed.category, 'agent');
  assert.equal(seed.topologyWarning, null);
  assert.match(seed.interpretation, /seed runner/i);
});

test('two seed processes for one agent are duplicate candidates — never two live instances', () => {
  const annotated = annotateHome23ProcessList([
    { name: 'home23-jerry-seed', script: `${ROOT}/substrate/bin/seed-runner.ts` },
    { name: 'home23-jerry-seed', script: `${ROOT}/substrate/bin/seed-runner.ts` },
    { name: 'home23-forrest-seed', script: `${ROOT}/substrate/bin/seed-runner.ts` },
  ]);

  assert.equal(annotated[0].topology.duplicateCandidate, true);
  assert.equal(annotated[1].topology.duplicateCandidate, true);
  assert.equal(annotated[2].topology.duplicateCandidate, false);
});

test('side-by-side agents using the same role scripts are expected, not duplicates', () => {
  const annotated = annotateHome23ProcessList([
    { name: 'home23-jerry', script: `${ROOT}/engine/src/index.js` },
    { name: 'home23-forrest', script: `${ROOT}/engine/src/index.js` },
    { name: 'home23-jerry-harness', script: `${ROOT}/dist/home.js` },
    { name: 'home23-forrest-harness', script: `${ROOT}/dist/home.js` },
  ]);

  assert.deepEqual(
    annotated.map((p) => [p.name, p.topology.agentName, p.topology.role, p.topology.duplicateCandidate]),
    [
      ['home23-jerry', 'jerry', 'agent-engine', false],
      ['home23-forrest', 'forrest', 'agent-engine', false],
      ['home23-jerry-harness', 'jerry', 'agent-harness', false],
      ['home23-forrest-harness', 'forrest', 'agent-harness', false],
    ]
  );
});

test('same-agent same-role processes are duplicate candidates', () => {
  const annotated = annotateHome23ProcessList([
    { name: 'home23-jerry', script: `${ROOT}/engine/src/index.js` },
    { name: 'home23-jerry', script: `${ROOT}/engine/src/index.js` },
    { name: 'home23-jerry-harness', script: `${ROOT}/dist/home.js` },
  ]);

  assert.equal(annotated[0].topology.duplicateCandidate, true);
  assert.equal(annotated[1].topology.duplicateCandidate, true);
  assert.equal(annotated[2].topology.duplicateCandidate, false);
});

test('flags name and script role mismatches', () => {
  const topology = classifyHome23Process({
    name: 'home23-jerry',
    script: `${ROOT}/dist/home.js`,
  });

  assert.equal(topology.role, 'agent-engine');
  assert.equal(topology.topologyWarning, 'name-script-role-mismatch');
  assert.match(topology.interpretation, /name says agent-engine/i);
});

test('classifies shared and support services separately from agent roles', () => {
  assert.equal(
    classifyHome23Process({
      name: 'home23-cosmo23',
      script: `${ROOT}/cosmo23/server/index.js`,
    }).role,
    'shared-service'
  );
  assert.equal(
    classifyHome23Process({
      name: 'home23-screenlogic',
      script: `${ROOT}/scripts/screenlogic_bridge.py`,
    }).role,
    'support-service'
  );
  assert.equal(
    classifyHome23Process({
      name: 'openclaw-node',
      command: 'openclaw-node',
    }).role,
    'external-workload'
  );
});
