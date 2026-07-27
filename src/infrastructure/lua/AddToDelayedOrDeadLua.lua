local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local delayQ     = KEYS[3]
local deadQ      = KEYS[4]

local jobId      = ARGV[1]
local workerId   = ARGV[2]
local jobKey     = ARGV[3] -- Holds the "main:jobId" string

local lockKey = lockPrefix .. ":" .. jobId

-- 1. Verify Lock Ownership (Zombie Protection)
local currentWorker = redis.call("GET", lockKey)
if currentWorker ~= workerId then
    return -1 -- Lock mismatch or expired
end

-- 2. Atomically increment the attempt counter on the correct hash
local currAttempt = redis.call("HINCRBY", jobKey, "attempt", 1)
local maxAttempt  = tonumber(redis.call("HGET", jobKey, "maxAttempts") or 0)

-- 3. Clean up lock and active queue
redis.call("DEL", lockKey)
local activePayload = jobId .. ":" .. workerId
redis.call("LREM", activeQ, 0, activePayload)

-- 4. Route and UPDATE STATUS based on attempts
if currAttempt <= maxAttempt then
    -- Pushed to delayed queue using ZADD (score 0 means retry ASAP)
    redis.call("ZADD", delayQ, 0, jobId)
    redis.call("HSET", jobKey, "status", "delayed")
    return 1 -- Retrying
else
    -- Pushed to dead queue
    redis.call("RPUSH", deadQ, jobId)
    redis.call("HSET", jobKey, "status", "dead")
    return 2 -- Dead
end