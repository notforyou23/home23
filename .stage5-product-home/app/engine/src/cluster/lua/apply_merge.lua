--[[
  apply_merge.lua
  
  Atomic diff application for CRDT merge in Redis.
  Applies all diffs for a cycle in deterministic order.
  
  Phase B-R: Redis State Store + CRDT Merge
  
  KEYS: none
  ARGV[1]: cycle number
  ARGV[2]: leader token (for fencing)
  
  Returns: { applied: count, rejected: count, conflicts: count }
]]

local cycle = ARGV[1]
local leaderToken = ARGV[2]

-- Verify leader token (fencing)
local currentToken = redis.call('GET', 'cosmo:leader:token')
if currentToken ~= leaderToken then
  return redis.error_reply('INVALID_LEADER_TOKEN: Token mismatch')
end

-- Get all diff keys for this cycle
local diffPattern = 'cosmo:diff:' .. cycle .. ':*'
local diffKeys = redis.call('KEYS', diffPattern)

-- Sort deterministically (by diff_id)
table.sort(diffKeys)

local stats = {
  applied = 0,
  rejected = 0,
  conflicts = 0
}

-- Apply each diff
for _, diffKey in ipairs(diffKeys) do
  -- Get diff data
  local diffData = redis.call('HGETALL', diffKey)
  if #diffData > 0 then
    -- Convert array to table
    local diff = {}
    for i = 1, #diffData, 2 do
      diff[diffData[i]] = diffData[i + 1]
    end
    
    local diffId = diff.diff_id
    
    -- Check idempotency: has this diff already been applied?
    local isApplied = redis.call('SISMEMBER', 'cosmo:applied:diffs', diffId)
    if isApplied == 1 then
      stats.rejected = stats.rejected + 1
    else
      -- Apply diff (CRDT merge logic handled in application layer)
      -- Here we just mark as applied and track it
      redis.call('SADD', 'cosmo:applied:diffs', diffId)
      
      -- Set TTL on applied set (7 days retention)
      redis.call('EXPIRE', 'cosmo:applied:diffs', 604800)
      
      stats.applied = stats.applied + 1
    end
  end
end

-- Cleanup diff keys for this cycle
for _, diffKey in ipairs(diffKeys) do
  redis.call('DEL', diffKey)
end

-- Return stats
return cjson.encode(stats)

