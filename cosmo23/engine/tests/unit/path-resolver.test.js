/**
 * PathResolver Unit Tests
 * 
 * Verifies:
 * - Logical path resolution (@outputs/, @exports/, etc.)
 * - MCP accessibility validation
 * - Deliverable path generation
 * - Fallback behavior
 */

const path = require('path');
const { expect } = require('chai');
const { PathResolver } = require('../../src/core/path-resolver');

describe('PathResolver', () => {
  let pathResolver;
  let mockLogger;
  let testConfig;
  let warnCalls;
  
  beforeEach(() => {
    warnCalls = [];
    mockLogger = {
      debug: () => {},
      info: () => {},
      warn: (...args) => warnCalls.push(args),
      error: () => {}
    };
    
    testConfig = {
      runtimeRoot: path.resolve(__dirname, '../../runtime'),
      mcp: {
        client: {
          servers: [{
            label: 'filesystem',
            allowedPaths: [
              path.resolve(__dirname, '../../runtime/outputs'),
              path.resolve(__dirname, '../../runtime/exports')
            ]
          }]
        }
      }
    };
    
    pathResolver = new PathResolver(testConfig, mockLogger);
  });
  
  describe('resolve()', () => {
    it('resolves @outputs/ prefix to outputs directory', () => {
      const result = pathResolver.resolve('@outputs/test.md');
      expect(result).to.equal(path.join(testConfig.runtimeRoot, 'outputs', 'test.md'));
    });
    
    it('resolves @exports/ prefix to exports directory', () => {
      const result = pathResolver.resolve('@exports/data.json');
      expect(result).to.equal(path.join(testConfig.runtimeRoot, 'exports', 'data.json'));
    });
    
    it('resolves @coordinator/ prefix to coordinator directory', () => {
      const result = pathResolver.resolve('@coordinator/review.json');
      expect(result).to.equal(path.join(testConfig.runtimeRoot, 'coordinator', 'review.json'));
    });
    
    it('resolves relative paths against runtimeRoot', () => {
      const result = pathResolver.resolve('outputs/file.md');
      expect(result).to.equal(path.join(testConfig.runtimeRoot, 'outputs/file.md'));
    });
    
    it('returns absolute paths unchanged', () => {
      const absolutePath = '/absolute/path/to/file.md';
      const result = pathResolver.resolve(absolutePath);
      expect(result).to.equal(absolutePath);
    });
    
    it('returns runtimeRoot for empty path', () => {
      const result = pathResolver.resolve('');
      expect(result).to.equal(testConfig.runtimeRoot);
    });
  });
  
  describe('getDeliverablePath()', () => {
    it('resolves deliverable with logical path', () => {
      const deliverableSpec = {
        location: '@outputs/',
        filename: 'test.md',
        accessibility: 'mcp-required'
      };
      
      const result = pathResolver.getDeliverablePath({
        deliverableSpec,
        agentType: 'document-creation',
        agentId: 'agent_123',
        fallbackName: 'fallback.md'
      });
      
      expect(result.filename).to.equal('test.md');
      expect(result.fullPath).to.equal(path.join(testConfig.runtimeRoot, 'outputs', 'test.md'));
      expect(result.isAccessible).to.equal(true);
    });
    
    it('uses fallback name when filename not specified', () => {
      const deliverableSpec = {
        location: '@outputs/',
        accessibility: 'mcp-required'
      };
      
      const result = pathResolver.getDeliverablePath({
        deliverableSpec,
        agentType: 'document-creation',
        agentId: 'agent_123',
        fallbackName: 'fallback.md'
      });
      
      expect(result.filename).to.equal('fallback.md');
    });
    
    it('defaults to @outputs/ when location not specified', () => {
      const deliverableSpec = {
        filename: 'test.md'
      };
      
      const result = pathResolver.getDeliverablePath({
        deliverableSpec,
        agentType: 'document-creation',
        agentId: 'agent_123',
        fallbackName: 'fallback.md'
      });
      
      expect(result.fullPath).to.equal(path.join(testConfig.runtimeRoot, 'outputs', 'test.md'));
      expect(result.isAccessible).to.equal(true);
    });
    
    it('throws error when required accessibility not met', () => {
      const deliverableSpec = {
        location: '/tmp/not-allowed',
        filename: 'test.md',
        accessibility: 'mcp-required'
      };
      
      expect(() => {
        pathResolver.getDeliverablePath({
          deliverableSpec,
          agentType: 'document-creation',
          agentId: 'agent_123',
          fallbackName: 'fallback.md'
        });
      }).to.throw(/not accessible via MCP/);
    });
    
    it('warns but does not throw when accessibility not required', () => {
      const deliverableSpec = {
        location: '/tmp/not-allowed',
        filename: 'test.md'
      };
      
      const result = pathResolver.getDeliverablePath({
        deliverableSpec,
        agentType: 'document-creation',
        agentId: 'agent_123',
        fallbackName: 'fallback.md'
      });
      
      expect(result.isAccessible).to.equal(false);
      expect(warnCalls.length).to.be.greaterThan(0);
    });
  });
  
  describe('isPathAccessibleViaMCP()', () => {
    it('returns true for paths within allowed paths', () => {
      const testPath = path.join(testConfig.runtimeRoot, 'outputs', 'test.md');
      expect(pathResolver.isPathAccessibleViaMCP(testPath)).to.equal(true);
    });
    
    it('returns false for paths outside allowed paths', () => {
      const testPath = '/tmp/outside.md';
      expect(pathResolver.isPathAccessibleViaMCP(testPath)).to.equal(false);
    });
    
    it('returns true when no restrictions set', () => {
      const unrestricted = new PathResolver({ runtimeRoot: '/test' }, mockLogger);
      expect(unrestricted.isPathAccessibleViaMCP('/any/path')).to.equal(true);
    });
  });
  
  describe('helper methods', () => {
    it('getOutputsRoot returns outputs directory', () => {
      expect(pathResolver.getOutputsRoot()).to.equal(path.join(testConfig.runtimeRoot, 'outputs'));
    });
    
    it('getExportsRoot returns exports directory', () => {
      expect(pathResolver.getExportsRoot()).to.equal(path.join(testConfig.runtimeRoot, 'exports'));
    });
    
    it('getCoordinatorDir returns coordinator directory', () => {
      expect(pathResolver.getCoordinatorDir()).to.equal(path.join(testConfig.runtimeRoot, 'coordinator'));
    });
    
    it('getRuntimeRoot returns runtime root', () => {
      expect(pathResolver.getRuntimeRoot()).to.equal(testConfig.runtimeRoot);
    });
  });
  
  describe('getDiagnostics()', () => {
    it('returns complete diagnostic information', () => {
      const diagnostics = pathResolver.getDiagnostics();
      
      expect(diagnostics).to.have.property('runtimeRoot');
      expect(diagnostics).to.have.property('mcpAllowedPaths');
      expect(diagnostics).to.have.property('prefixes');
      expect(diagnostics).to.have.property('mcpAccessible');
      
      expect(diagnostics.mcpAccessible.outputs).to.equal(true);
      expect(diagnostics.mcpAccessible.exports).to.equal(true);
    });
  });
});

