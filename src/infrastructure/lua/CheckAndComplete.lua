local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local completeQ  = KEYS[3]

local jobId        = ARGV[1]
local workerId     = ARGV[2]
local jobKey       = ARGV[3] -- NEW: Added so we can update the status hash

local lockKey = lockPrefix .. ":" .. jobId
local currentWorker = redis.call('GET', lockKey)

if currentWorker == workerId then
    redis.call('DEL', lockKey)

    local activePayload = jobId .. ":" .. workerId
    redis.call('LREM', activeQ, 0, activePayload)

    redis.call('RPUSH', completeQ, jobId)
    
    -- [THE FIX]: Update the status in the main job hash
    redis.call('HSET', jobKey, 'status', 'completed')

    -- Note on TTLs: You cannot set a TTL on a specific list element in Redis.
    -- If you run PEXPIRE here, it will set the TTL for the ENTIRE complete queue.
    -- redis.call('PEXPIRE', completeQ, ttlCompleted)

    return 1 -- Success
end

return 0 -- Lock mismatch or job expired