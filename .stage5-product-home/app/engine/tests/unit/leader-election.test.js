/**
 * Unit tests for LeaderElection (Filesystem)
 */

const { expect } = require('chai');
const { LeaderElection } = require('../../src/cluster/fs/leader-election');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

describe('LeaderElection (Filesystem)', () => {
  let election;
  let mockConfig;
  let mockLogger;
  let testRoot;

  beforeEach(async () => {
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {}
    };
    mockConfig = {
      leaseMs: 1000,
      renewMs: 300,
      graceMs: 500
    };
    
    testRoot = path.join(os.tmpdir(), `leader-test-${Date.now()}`);
    await fs.mkdir(testRoot, { recursive: true });
    
    election = new LeaderElection(mockConfig, testRoot, 'test-instance-1', mockLogger);
    await election.initialize();
  });

  afterEach(async () => {
    await election.cleanup();
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
  });

  describe('tryAcquireLeadership', () => {
    it('should acquire leadership when no leader exists', async () => {
      const acquired = await election.tryAcquireLeadership();
      expect(acquired).to.be.true;
      expect(election.isCurrentLeader()).to.be.true;
    });

    it('should fail to acquire when leader exists', async () => {
      // Use a fresh test root for this test
      const sharedRoot = path.join(os.tmpdir(), `leader-shared-${Date.now()}`);
      
      const election1 = new LeaderElection(mockConfig, sharedRoot, 'instance-1', mockLogger);
      await election1.initialize();
      
      const acquired1 = await election1.tryAcquireLeadership();
      expect(acquired1).to.be.true;
      
      const election2 = new LeaderElection(mockConfig, sharedRoot, 'instance-2', mockLogger);
      await election2.initialize();
      
      const acquired2 = await election2.tryAcquireLeadership();
      expect(acquired2).to.be.false;
      
      await election1.cleanup();
      await election2.cleanup();
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {});
    });

    it('should increment term on acquisition', async () => {
      const initialTerm = election.getCurrentTerm();
      
      await election.tryAcquireLeadership();
      
      const newTerm = election.getCurrentTerm();
      expect(newTerm).to.be.above(initialTerm);
    });

    it('should acquire after lease expires', async function() {
      this.timeout(5000);
      
      const expireRoot = path.join(os.tmpdir(), `leader-expire-${Date.now()}`);
      
      const election1 = new LeaderElection(
        { leaseMs: 500, renewMs: 300, graceMs: 200 },
        expireRoot,
        'instance-1',
        mockLogger
      );
      await election1.initialize();
      await election1.tryAcquireLeadership();
      election1.stopRenewalTimer(); // Prevent renewal
      
      // Wait for lease + grace to expire
      await new Promise(resolve => setTimeout(resolve, 800)); // 500ms lease + 200ms grace + margin
      
      const election2 = new LeaderElection(
        { leaseMs: 500, renewMs: 300, graceMs: 200 },
        expireRoot,
        'instance-2',
        mockLogger
      );
      await election2.initialize();
      const acquired = await election2.tryAcquireLeadership();
      expect(acquired).to.be.true;
      
      await election1.cleanup();
      await election2.cleanup();
      await fs.rm(expireRoot, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe('renewLease', () => {
    it('should renew active lease', async () => {
      await election.tryAcquireLeadership();
      
      const renewed = await election.renewLease();
      expect(renewed).to.be.true;
    });

    it('should fail to renew if not leader', async () => {
      const renewed = await election.renewLease();
      expect(renewed).to.be.false;
    });
  });

  describe('releaseLeadership', () => {
    it('should release leadership', async () => {
      await election.tryAcquireLeadership();
      expect(election.isCurrentLeader()).to.be.true;
      
      await election.releaseLeadership();
      expect(election.isCurrentLeader()).to.be.false;
    });

    it('should stop renewal timer on release', async () => {
      await election.tryAcquireLeadership();
      expect(election.renewalTimer).to.not.be.null;
      
      await election.releaseLeadership();
      expect(election.renewalTimer).to.be.null;
    });
  });

  describe('getCurrentLeader', () => {
    it('should return null when no leader', async () => {
      const leader = await election.getCurrentLeader();
      expect(leader).to.be.null;
    });

    it('should return leader data when leader exists', async () => {
      await election.tryAcquireLeadership();
      
      const leader = await election.getCurrentLeader();
      expect(leader).to.not.be.null;
      expect(leader.leaderId).to.equal('test-instance-1');
      expect(leader.term).to.be.above(0);
    });

    it('should return null for expired lease', async function() {
      this.timeout(3000);
      
      const shortLease = new LeaderElection(
        { leaseMs: 500, renewMs: 300, graceMs: 200 },
        testRoot,
        'short',
        mockLogger
      );
      await shortLease.initialize();
      await shortLease.tryAcquireLeadership();
      shortLease.stopRenewalTimer();
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 600));
      
      const leader = await shortLease.getCurrentLeader();
      expect(leader).to.be.null;
      
      await shortLease.cleanup();
    });
  });
});

