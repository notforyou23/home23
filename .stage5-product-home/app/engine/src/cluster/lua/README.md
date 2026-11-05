# Lua Scripts for Redis Clustering

These Lua scripts provide atomic server-side operations for COSMO's Redis backend.

---

## Scripts

### 1. `apply_merge.lua` (Phase B-R/D-R)

**Purpose**: Atomic diff application for CRDT merge

**Parameters**:
- `ARGV[1]`: cycle number
- `ARGV[2]`: leader token (for fencing)

**Returns**: JSON stats `{ applied: N, rejected: M, conflicts: K }`

**Behavior**:
1. Verifies leader token (fencing)
2. Fetches all diffs for cycle (`cosmo:diff:{cycle}:*`)
3. Sorts deterministically by diff_id
4. For each diff: checks idempotency via `cosmo:applied:diffs` set
5. Marks applied diffs (with 7-day TTL)
6. Deletes processed diff keys
7. Returns application stats

**Atomicity**: Single Lua script execution is atomic in Redis

---

### 2. `goal_claim.lua` (Phase B-R/C)

**Purpose**: Atomic goal claiming with TTL for work allocation

**Parameters**:
- `KEYS[1]`: goal key (e.g., `cosmo:goal:goal_123`)
- `ARGV[1]`: instance ID attempting to claim
- `ARGV[2]`: claim TTL in milliseconds
- `ARGV[3]`: current timestamp (ms)

**Returns**:
- `1` = claim successful (goal is yours)
- `0` = claim failed (already claimed)

**Behavior**:
1. Checks if goal is completed (immutable, cannot reclaim)
2. Checks if goal is unclaimed OR claim expired
3. If claimable: sets `claimed_by`, `claim_expires`, increments `claim_count`
4. If already claimed: returns failure

**Atomicity**: Compare-and-set semantics prevent duplicate claims

---

### 3. `leader_renew.lua` (Phase D-R)

**Purpose**: Atomic leader lease renewal with fencing token

**Parameters**:
- `ARGV[1]`: leader token (fencing token)
- `ARGV[2]`: lease duration in milliseconds

**Returns**:
- `1` = renewal successful (lease extended)
- `0` = renewal failed (token mismatch, leader lost)

**Behavior**:
1. Fetches current leader token from `cosmo:leader:token`
2. Compares with provided token
3. If match: extends lease TTL on `cosmo:leader:holder` and `cosmo:leader:token`
4. If mismatch: returns failure (leader is stale/fenced)

**Atomicity**: Token check + renewal is atomic; prevents split-brain

---

## Usage

### Loading Scripts

```javascript
const fs = require('fs').promises;
const path = require('path');

// Load Lua script
const applyMergeScript = await fs.readFile(
  path.join(__dirname, 'lua/apply_merge.lua'),
  'utf8'
);

// Register with Redis
const applyMergeSHA = await redisClient.scriptLoad(applyMergeScript);

// Execute
const result = await redisClient.evalsha(
  applyMergeSHA,
  0, // num keys
  cycle,
  leaderToken
);
```

### Calling from RedisStateStore

```javascript
// In RedisStateStore.applyMerge()
async applyMerge(cycle, leaderToken) {
  const result = await this.client.evalsha(
    this.applyMergeSHA,
    0,
    cycle.toString(),
    leaderToken.toString()
  );
  
  const stats = JSON.parse(result);
  return stats;
}
```

---

## Testing

### Unit Tests

Lua scripts are tested via:
1. Unit tests: `tests/unit/lua-scripts.test.js` (mock Redis)
2. Integration tests: `tests/integration/redis-state-store.test.js` (real Redis)
3. Fuzzing: `tests/multi-instance/crdt-determinism.fuzz.js` (1000× scenarios)

### Validation

All scripts must pass:
- **Idempotency**: Running twice produces same result
- **Atomicity**: No partial updates on error
- **Determinism**: Same inputs always produce same output
- **Fencing**: Stale tokens rejected

---

## Maintenance

**When modifying scripts**:
1. Update this README
2. Update corresponding tests
3. Verify atomicity properties
4. Test with multi-instance fuzzing
5. Document any breaking changes

---

## References

- [Redis Lua Scripting](https://redis.io/docs/manual/programmability/eval-intro/)
- [CRDT Specification](https://crdt.tech/)
- COSMO Implementation Roadmap (Phase B-R, Phase D-R)

