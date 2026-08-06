const { expect } = require('chai');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { StateCompression } = require('../../src/core/state-compression');

describe('DashboardServer force-wake route', () => {
  let tempRunDir;
  let httpServer;
  let port;
  let savedEnv;

  beforeEach(async () => {
    savedEnv = {
      COSMO_RUNTIME_PATH: process.env.COSMO_RUNTIME_PATH,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };

    tempRunDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-force-wake-'));
    process.env.COSMO_RUNTIME_PATH = tempRunDir;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

    await fs.writeFile(
      path.join(tempRunDir, 'state.json'),
      JSON.stringify({
        cognitiveState: { mode: 'sleeping', energy: 0.1 },
        temporal: { state: 'sleeping' }
      })
    );

    const { DashboardServer } = require('../../src/dashboard/server');
    const server = new DashboardServer(0);
    httpServer = server.app.listen(0);
    await new Promise((resolve) => httpServer.once('listening', resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await fs.rm(tempRunDir, { recursive: true, force: true });
  });

  it('wakes a sleeping run and persists the awake state', async () => {
    const response = await fetch(`http://localhost:${port}/api/operations/force-wake`, {
      method: 'POST'
    });

    expect(response.status).to.equal(200);
    const json = await response.json();
    expect(json.success).to.equal(true);

    const state = await StateCompression.loadCompressed(path.join(tempRunDir, 'state.json'));
    expect(state.cognitiveState.mode).to.equal('active');
    expect(state.cognitiveState.energy).to.equal(0.9);
    expect(state.temporal.state).to.equal('awake');
  });

  it('reports not-sleeping without error when the run is awake', async () => {
    await fs.writeFile(
      path.join(tempRunDir, 'state.json'),
      JSON.stringify({
        cognitiveState: { mode: 'active', energy: 0.8 },
        temporal: { state: 'awake' }
      })
    );

    const response = await fetch(`http://localhost:${port}/api/operations/force-wake`, {
      method: 'POST'
    });

    expect(response.status).to.equal(200);
    const json = await response.json();
    expect(json.success).to.equal(false);
    expect(json.message).to.include('not currently sleeping');
  });
});
