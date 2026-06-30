const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  buildInteractiveLiveStatus,
  isInteractiveSessionRequestValid,
  shouldReuseInteractiveSession
} = require('../../../server/lib/interactive-live-status');

describe('interactive live status helpers', () => {
  it('does not reuse an active interactive session attached to a different run path', () => {
    expect(shouldReuseInteractiveSession(
      { active: true, runtimePath: '/runs/old' },
      '/runs/old'
    )).to.equal(true);

    expect(shouldReuseInteractiveSession(
      { active: true, runtimePath: '/runs/old' },
      '/runs/new'
    )).to.equal(false);

    expect(shouldReuseInteractiveSession(null, '/runs/new')).to.equal(false);
  });

  it('rejects stale interactive message session ids', () => {
    const session = { active: true, sessionId: 'current-session' };

    expect(isInteractiveSessionRequestValid(session, 'current-session')).to.equal(true);
    expect(isInteractiveSessionRequestValid(session, '')).to.equal(true);
    expect(isInteractiveSessionRequestValid(session, null)).to.equal(true);
    expect(isInteractiveSessionRequestValid(session, 'old-session')).to.equal(false);
    expect(isInteractiveSessionRequestValid(null, 'old-session')).to.equal(false);
  });

  it('combines live process health with the freshest persisted run counters', () => {
    const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-live-status-'));
    fs.writeFileSync(
      path.join(runPath, 'state.json.gz'),
      zlib.gzipSync(JSON.stringify({
        cycleCount: 7,
        memory: {
          nodes: Array.from({ length: 43 }, (_, index) => ({ id: `node_${index}` })),
          edges: Array.from({ length: 132 }, (_, index) => ({ source: `node_${index}`, target: `node_${index + 1}` }))
        }
      }))
    );
    fs.writeFileSync(
      path.join(runPath, 'metrics.json'),
      JSON.stringify({
        timestamp: '2026-06-30T15:31:00.000Z',
        metrics: {
          'cycle.time': {
            count: 9,
            tags: { cycle: 9 },
            values: [
              { value: 1, timestamp: '2026-06-30T15:16:00.000Z', tags: { cycle: 7 } },
              { value: 1, timestamp: '2026-06-30T15:31:00.000Z', tags: { cycle: 9 } }
            ]
          }
        }
      })
    );

    const status = buildInteractiveLiveStatus({
      runPath,
      activeContext: {
        runPath,
        runName: 'jerrynotes',
        topic: 'very garcia side project anecdotes'
      },
      processStatus: {
        running: [{ name: 'cosmo-main' }],
        count: 1
      },
      now: new Date('2026-06-30T15:32:00.000Z')
    });

    expect(status.running).to.equal(true);
    expect(status.lifecycle).to.equal('running');
    expect(status.runName).to.equal('jerrynotes');
    expect(status.cycle).to.equal(9);
    expect(status.memoryNodes).to.equal(43);
    expect(status.memoryEdges).to.equal(132);
    expect(status.generatedAt).to.equal('2026-06-30T15:32:00.000Z');
    expect(status.source).to.equal('live_status');
  });
});
