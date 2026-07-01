const { expect } = require('chai');
const path = require('path');

const { DashboardServer } = require('../../src/dashboard/server');

describe('DashboardServer run root resolution', () => {
  it('defaults to the Home23-managed cosmo23/runs directory when present', () => {
    const expected = path.resolve(__dirname, '..', '..', '..', 'runs');

    expect(DashboardServer.prototype.detectRunsDirectory()).to.equal(expected);
  });
});
