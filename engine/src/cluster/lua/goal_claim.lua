--[[
  goal_claim.lua
  
  Atomic goal claiming with TTL for distributed work allocation.
  
  Phase B-R/C: Redis State Store + Goal Allocation
  
  KEYS[1]: goal key (e.g., cosmo:goal:goal_123)
  ARGV[1]: instance ID attempting to claim
  ARGV[2]: claim TTL in milliseconds
  ARGV[3]: current timestamp (ms)
  
  Returns:
    1 = claim successful (goal is now yours)
    0 = claim failed (already claimed by another)
]]

local goalKey = KEYS[1]
local instanceId = ARGV[1]
local claimTtl = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Get current goal state
local claimedBy = redis.call('HGET', goalKey, 'claimed_by')
local claimExpires = tonumber(redis.call('HGET', goalKey, 'claim_expires') or '0')
local completed = redis.call('HGET', goalKey, 'completed')

-- Check if goal is completed (immutable)
if completed == 'true' then
  return 0  -- Cannot claim completed goals
end

-- Check if goal is unclaimed or claim has expired
if (not claimedBy) or (claimExpires <= now) then
  -- Claim the goal
  local claimCount = tonumber(redis.call('HGET', goalKey, 'claim_count') or '0')
  
  redis.call('HMSET', goalKey,
    'claimed_by', instanceId,
    'claim_expires', now + claimTtl,
    'claim_count', claimCount + 1,
    'last_claimed_at', now
  )
  
  return 1  -- Claim successful
end

-- Goal is currently claimed by another instance
return 0  -- Claim failed

