const { expect } = require('chai');

const { DashboardServer } = require('../../src/dashboard/server');

describe('DashboardServer auto-next gating', () => {
  it('rejects blocked or active plans before generating a continuation', () => {
    const blocked = DashboardServer.prototype.validateAutoNextPlanStatus({
      status: 'BLOCKED',
      blockedReason: 'Research contract failed'
    });
    const active = DashboardServer.prototype.validateAutoNextPlanStatus({
      status: 'ACTIVE'
    });

    expect(blocked.ok).to.equal(false);
    expect(blocked.error).to.include('current plan status is BLOCKED');
    expect(active.ok).to.equal(false);
    expect(active.error).to.include('current plan status is ACTIVE');
  });

  it('allows completed plan statuses', () => {
    expect(DashboardServer.prototype.validateAutoNextPlanStatus({ status: 'COMPLETED' }).ok).to.equal(true);
    expect(DashboardServer.prototype.validateAutoNextPlanStatus({ status: 'DONE' }).ok).to.equal(true);
  });
});
