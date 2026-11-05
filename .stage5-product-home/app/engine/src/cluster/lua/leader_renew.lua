--[[
  leader_renew.lua
  
  Atomic leader lease renewal with fencing token check.
  Prevents stale leaders from renewing their lease.
  
  Phase D-R: Redis Leader Election + Fencing
  
  KEYS: none
  ARGV[1]: leader token (fencing token)
  ARGV[2]: lease duration in milliseconds
  
  Returns:
    1 = renewal successful (lease extended)
    0 = renewal failed (token mismatch, leader lost)
]]

local leaderToken = ARGV[1]
local leaseDuration = tonumber(ARGV[2])

-- Get current leader token
local currentToken = redis.call('GET', 'cosmo:leader:token')

-- Check token match (fencing)
if currentToken == leaderToken then
  -- Token matches: renew the lease
  redis.call('PEXPIRE', 'cosmo:leader:holder', leaseDuration)
  redis.call('PEXPIRE', 'cosmo:leader:token', leaseDuration)
  
  -- Update last renewal timestamp
  redis.call('SET', 'cosmo:leader:last_renewal', ARGV[3] or redis.call('TIME')[1])
  
  return 1  -- Renewal successful
end

-- Token mismatch: this leader is stale (fenced)
return 0  -- Renewal failed

