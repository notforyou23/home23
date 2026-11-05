import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNeighborPeers, _test } from '../../../../engine/src/channels/neighbor/peer-config.js';

function fakeFs(configByName) {
  return {
    readdirSync: () => Object.keys(configByName),
    statSync: () => ({ isDirectory: () => true }),
    readFileSync: (filePath) => {
      const name = filePath.split('/').at(-2);
      return configByName[name] || '';
    },
  };
}

const fakeYaml = {
  load: (content) => JSON.parse(content),
};

test('resolveNeighborPeers keeps auto local peers and skips current agent', () => {
  const peers = resolveNeighborPeers({
    neighborCfg: { peers: 'auto' },
    instancesDir: '/home23/instances',
    thisAgent: 'jerry',
    fsImpl: fakeFs({
      jerry: JSON.stringify({ ports: { bridge: 5004 } }),
      forrest: JSON.stringify({ ports: { bridge: 5014 } }),
    }),
    yamlImpl: fakeYaml,
  });

  assert.deepEqual(peers, [{
    peerName: 'forrest',
    url: 'http://localhost:5014/__state/public.json',
    source: 'local',
  }]);
});

test('resolveNeighborPeers accepts remote URL strings', () => {
  const peers = resolveNeighborPeers({
    neighborCfg: { peers: ['http://jtrpi.local:5014'] },
    instancesDir: '/home23/instances',
    thisAgent: 'jerry',
    fsImpl: fakeFs({}),
    yamlImpl: fakeYaml,
  });

  assert.equal(peers.length, 1);
  assert.equal(peers[0].peerName, 'jtrpi.local');
  assert.equal(peers[0].url, 'http://jtrpi.local:5014/__state/public.json');
  assert.equal(peers[0].source, 'remote');
});

test('resolveNeighborPeers appends remotePeers to auto local discovery', () => {
  const peers = resolveNeighborPeers({
    neighborCfg: {
      peers: 'auto',
      remotePeers: [{ name: 'axiom', url: 'http://100.72.171.59:5014', token: 'secret' }],
    },
    instancesDir: '/home23/instances',
    thisAgent: 'jerry',
    fsImpl: fakeFs({
      forrest: JSON.stringify({ ports: { bridge: 5014 } }),
    }),
    yamlImpl: fakeYaml,
  });

  assert.equal(peers.length, 2);
  assert.equal(peers[0].peerName, 'forrest');
  assert.equal(peers[1].peerName, 'axiom');
  assert.equal(peers[1].url, 'http://100.72.171.59:5014/__state/public.json');
  assert.equal(peers[1].token, 'secret');
});

test('normalizePublicStateUrl preserves explicit public-state paths', () => {
  assert.equal(
    _test.normalizePublicStateUrl('http://node.local:5014/custom/state.json'),
    'http://node.local:5014/custom/state.json',
  );
});
