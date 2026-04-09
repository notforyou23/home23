const path = require('path');
const { expect } = require('chai');

const { MissionTracer } = require('../../scripts/TRACE_RESEARCH_MISSIONS');

describe('MissionTracer standalone paths', () => {
  it('resolves runs and runtime from the repo root', () => {
    const previousRuntime = process.env.COSMO_RUNTIME_PATH;
    delete process.env.COSMO_RUNTIME_PATH;
    const tracer = new MissionTracer();
    const repoRoot = path.resolve(__dirname, '../../..');

    expect(tracer.runsDir).to.equal(path.join(repoRoot, 'runs'));
    expect(tracer.runtimeDir).to.equal(path.join(repoRoot, 'runtime'));
    if (previousRuntime === undefined) {
      delete process.env.COSMO_RUNTIME_PATH;
    } else {
      process.env.COSMO_RUNTIME_PATH = previousRuntime;
    }
  });
});
