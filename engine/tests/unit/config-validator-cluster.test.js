const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const { ConfigValidator } = require('../../src/core/config-validator');

const loadConfig = () => {
  const configPath = path.join(__dirname, '../../src/config.yaml');
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
};

const createLogger = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {}
});

describe('ConfigValidator - Cluster Settings', () => {
  it('reports informational message when cluster disabled', () => {
    const config = loadConfig();
    config.cluster = { ...config.cluster, enabled: false };

    const validator = new ConfigValidator(config, createLogger());
    const result = validator.validate();

    expect(result.errors.filter(e => e.includes('cluster'))).to.be.empty;
    expect(result.info.some(msg => msg.includes('Cluster disabled'))).to.be.true;
  });

  it('flags invalid cluster backend configuration', () => {
    const config = loadConfig();
    config.cluster = {
      ...config.cluster,
      enabled: true,
      backend: 'unknown-backend'
    };

    const validator = new ConfigValidator(config, createLogger());
    const result = validator.validate();

    expect(result.errors.some(msg => msg.includes('Invalid cluster backend'))).to.be.true;
  });

  it('accepts filesystem backend when required fields present', () => {
    const config = loadConfig();
    config.cluster = {
      enabled: true,
      backend: 'filesystem',
      instanceCount: 3,
      filesystem: { root: '/tmp/cosmo_cluster_test' }
    };

    const validator = new ConfigValidator(config, createLogger());
    const result = validator.validate();
    const clusterErrors = result.errors.filter(msg => msg.includes('cluster'));

    expect(clusterErrors).to.be.empty;
    expect(result.info.some(msg => msg.includes('Filesystem cluster root'))).to.be.true;
  });
});
