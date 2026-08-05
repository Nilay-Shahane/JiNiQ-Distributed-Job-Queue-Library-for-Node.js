-- KEYS[1]: jobKey (e.g., jiniq-draft:video-queue:main:job_123)
-- KEYS[2]: priority zset
-- KEYS[3]: normal list
-- KEYS[4]: delay zset
--KEYS[5] : notification channel 

-- ARGV[1]: jobId
-- ARGV[2]: priorityString ("high", "normal")
-- ARGV[3]: delay (milliseconds)
-- ARGV[4]: timestamp (current time)
-- ARGV[5]: priorityOffset (e.g., 10000ms)
--ARGV[6] : maxQueueSize
-- ARGV[7...]: hash fields and values

local jobKey = KEYS[1]
local priorityKey = KEYS[2]
local normalKey = KEYS[3]
local delayKey = KEYS[4]


local jobId = ARGV[1]
local priorityString = ARGV[2]
local delay = tonumber(ARGV[3])
local timestamp = tonumber(ARGV[4])
local priorityOffset = tonumber(ARGV[5])
local maxQueueSize = tonumber(ARGV[6]) or 0

if redis.call("EXISTS", jobKey) == 1 then 
    return 0 
end

if maxQueueSize > 0 then
   local currentNormalSize = redis.call("ZCARD", normalKey)
   local currentPrioritySize = redis.call("ZCARD", priorityKey)
    if (currentNormalSize + currentPrioritySize) >= maxQueueSize then
        return -1
    end
end

redis.call("HSET", jobKey, unpack(ARGV, 7))


-- ... (top part remains the same) ...

if delay > 0 then
    local runAt = timestamp + delay
    redis.call("ZADD", delayKey, runAt, jobId)
    redis.call("HSET", jobKey, "runAt", runAt)
    
elseif priorityString == "high" then
    local score = timestamp - priorityOffset
    redis.call("ZADD", priorityKey, score, jobId)
    
else
    -- [THE FIX]: Use ZADD instead of RPUSH for the normal queue!
    redis.call("ZADD", normalKey, timestamp, jobId)
end
 

return 1