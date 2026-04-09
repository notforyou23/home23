const { expect } = require('chai');
const { MemoryStorage, SessionManager } = require('../src/session');

describe('MemoryStorage', () => {
  it('should write and read data', async () => {
    const storage = new MemoryStorage();
    await storage.write('key1', 'value1');
    const result = await storage.read('key1');
    expect(result).to.equal('value1');
  });

  it('should return null for missing key', async () => {
    const storage = new MemoryStorage();
    const result = await storage.read('nonexistent');
    expect(result).to.be.null;
  });

  it('should overwrite existing data', async () => {
    const storage = new MemoryStorage();
    await storage.write('key1', 'original');
    await storage.write('key1', 'updated');
    const result = await storage.read('key1');
    expect(result).to.equal('updated');
  });
});

describe('SessionManager', () => {
  it('should return null when loading from empty storage', async () => {
    const mgr = new SessionManager();
    const result = await mgr.load('empty');
    expect(result).to.be.null;
  });

  it('should save and load round-trip', async () => {
    const mgr = new SessionManager();
    const data = { query: 'test query', mode: 'full' };
    await mgr.save('s1', data);
    const loaded = await mgr.load('s1');
    expect(loaded).to.deep.equal(data);
  });

  it('should preserve all session schema fields', async () => {
    const mgr = new SessionManager();
    const data = {
      query: 'quantum entanglement effects',
      mode: 'continue',
      searchedPartitionIds: [0, 2, 5],
      totalPartitions: 8,
      timestamp: '2026-03-17T12:00:00.000Z'
    };
    await mgr.save('schema-test', data);
    const loaded = await mgr.load('schema-test');
    expect(loaded.query).to.equal('quantum entanglement effects');
    expect(loaded.mode).to.equal('continue');
    expect(loaded.searchedPartitionIds).to.deep.equal([0, 2, 5]);
    expect(loaded.totalPartitions).to.equal(8);
    expect(loaded.timestamp).to.equal('2026-03-17T12:00:00.000Z');
  });

  it('should handle multiple independent sessions', async () => {
    const mgr = new SessionManager();
    const data1 = { query: 'first query', mode: 'full' };
    const data2 = { query: 'second query', mode: 'targeted' };
    await mgr.save('session-a', data1);
    await mgr.save('session-b', data2);
    const loaded1 = await mgr.load('session-a');
    const loaded2 = await mgr.load('session-b');
    expect(loaded1).to.deep.equal(data1);
    expect(loaded2).to.deep.equal(data2);
  });

  it('should work with a custom storage provider', async () => {
    const calls = { read: [], write: [] };
    const customStorage = {
      async read(key) {
        calls.read.push(key);
        return key === 'session:custom-id' ? JSON.stringify({ query: 'hi' }) : null;
      },
      async write(key, data) {
        calls.write.push(key);
      }
    };
    const mgr = new SessionManager(customStorage);
    await mgr.save('custom-id', { query: 'saved' });
    await mgr.load('custom-id');
    expect(calls.write).to.include('session:custom-id');
    expect(calls.read).to.include('session:custom-id');
  });

  it('should return null for corrupted data', async () => {
    const badStorage = {
      async read() { return '{not valid json!!!'; },
      async write() {}
    };
    const mgr = new SessionManager(badStorage);
    const result = await mgr.load('broken');
    expect(result).to.be.null;
  });

  it('should use "session:default" key when no session ID provided', async () => {
    const keys = { read: null, write: null };
    const spyStorage = {
      async read(key) { keys.read = key; return null; },
      async write(key, data) { keys.write = key; }
    };
    const mgr = new SessionManager(spyStorage);
    await mgr.save(undefined, { query: 'test' });
    await mgr.load();
    expect(keys.write).to.equal('session:default');
    expect(keys.read).to.equal('session:default');
  });
});
