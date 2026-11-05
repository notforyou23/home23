#!/usr/bin/env node
const { verifyArtifactLoop } = require('../src/artifacts/artifact-loop-verifier');

async function main() {
  const command = process.argv[2] || 'verify';
  if (command !== 'verify') {
    console.error(`Unknown command: ${command}`);
    process.exit(2);
  }
  const result = await verifyArtifactLoop();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'pass') process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
