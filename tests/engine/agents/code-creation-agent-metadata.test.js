import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodeCreationAgent: HomeCodeCreationAgent } = require('../../../engine/src/agents/code-creation-agent.js');
const { CodeCreationAgent: CosmoCodeCreationAgent } = require('../../../cosmo23/engine/src/agents/code-creation-agent.js');

function makeAgent(AgentClass) {
  return Object.create(AgentClass.prototype);
}

for (const [label, AgentClass] of [
  ['home engine', HomeCodeCreationAgent],
  ['cosmo23 vendored engine', CosmoCodeCreationAgent],
]) {
  test(`${label} does not treat FILE_WRITTEN logs as artifact metadata`, () => {
    const agent = makeAgent(AgentClass);
    const response = {
      output: [
        {
          outputs: [
            { logs: 'FILE_WRITTEN:brain/index.js\nDIR_STATE:["brain/index.js"]\n' },
          ],
        },
      ],
      content: 'FILE_WRITTEN:brain/index.js\n',
    };

    const metadata = agent.extractFileMetadataFromResponse(response, {
      path: 'brain/index.js',
    });

    assert.equal(metadata, null);
  });
}
