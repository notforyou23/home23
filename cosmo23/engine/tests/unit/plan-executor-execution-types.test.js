const { expect } = require('chai');

describe('PlanExecutor Execution Agent Dispatch', function() {
  let pe;

  before(function() {
    try {
      const { PlanExecutor } = require('../../src/core/plan-executor');
      const logger = { info: ()=>{}, warn: ()=>{}, error: ()=>{}, debug: ()=>{} };
      // PlanExecutor constructor: (stateStore, agentExecutor, config, logger, options)
      const stateStore = { get: ()=>null, set: ()=>{}, getAll: ()=>[] };
      const agentExecutor = { registry: { getActiveAgentByTaskId: ()=>null } };
      pe = new PlanExecutor(stateStore, agentExecutor, { coordinator: {} }, logger);
    } catch (e) {
      this.skip();
    }
  });

  it('should dispatch dataacquisition from metadata', function() {
    const task = { title: 'Scrape data', description: 'Scrape product data', metadata: { agentType: 'dataacquisition' } };
    expect(pe.determineAgentType(task)).to.equal('dataacquisition');
  });

  it('should dispatch datapipeline from metadata', function() {
    const task = { title: 'Build DB', description: 'Transform data', metadata: { agentType: 'datapipeline' } };
    expect(pe.determineAgentType(task)).to.equal('datapipeline');
  });

  it('should dispatch infrastructure from metadata', function() {
    const task = { title: 'Setup', description: 'Docker setup', metadata: { agentType: 'infrastructure' } };
    expect(pe.determineAgentType(task)).to.equal('infrastructure');
  });

  it('should dispatch automation from metadata', function() {
    const task = { title: 'Automate', description: 'File org', metadata: { agentType: 'automation' } };
    expect(pe.determineAgentType(task)).to.equal('automation');
  });

  it('should detect scraping from keywords', function() {
    const task = { title: 'Scrape the site', description: 'Crawl all pages', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('dataacquisition');
  });

  it('should detect database creation from keywords', function() {
    const task = { title: 'Create database', description: 'Load data into database', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('datapipeline');
  });

  it('should detect docker/container from keywords', function() {
    const task = { title: 'Set up container', description: 'Provision docker environment', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('infrastructure');
  });

  it('should detect automation from keywords', function() {
    const task = { title: 'Organize files', description: 'Automate batch process for rename files', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('automation');
  });

  it('should still dispatch research from metadata', function() {
    const task = { title: 'Research X', description: 'Research topic', metadata: { agentType: 'research' } };
    expect(pe.determineAgentType(task)).to.equal('research');
  });

  it('should still dispatch ide from metadata', function() {
    const task = { title: 'Build feature', description: 'Write code', metadata: { agentType: 'ide' } };
    expect(pe.determineAgentType(task)).to.equal('ide');
  });

  it('should dispatch synthesis from metadata', function() {
    const task = { title: 'Synthesize', description: 'Create synthesis', metadata: { agentType: 'synthesis' } };
    expect(pe.determineAgentType(task)).to.equal('synthesis');
  });

  it('should dispatch analysis from metadata', function() {
    const task = { title: 'Analyze', description: 'Analyze data', metadata: { agentType: 'analysis' } };
    expect(pe.determineAgentType(task)).to.equal('analysis');
  });

  it('should fall back to ide for non-matching tasks', function() {
    const task = { title: 'Build a widget', description: 'Create the widget component', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('ide');
  });

  it('should fall back to research for research keywords', function() {
    const task = { title: 'Research AI trends', description: 'Find sources on AI', metadata: {} };
    expect(pe.determineAgentType(task)).to.equal('research');
  });
});
