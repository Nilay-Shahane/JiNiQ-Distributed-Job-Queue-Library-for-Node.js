local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local completeQ  = KEYS[3]

local jobId        = ARGV[1]
local workerId     = ARGV[2]
local jobKey       = ARGV[3] 

local lockKey = lockPrefix .. ":" .. jobId
local currentWorker = redis.call('GET', lockKey)

if currentWorker == workerId then
    redis.call('DEL', lockKey)

    local activePayload = jobId .. ":" .. workerId
    redis.call('LREM', activeQ, 0, activePayload)

    redis.call('RPUSH', completeQ, jobId)
    
    -- Generate timestamp in milliseconds (TIME returns [seconds, microseconds])
    local time = redis.call('TIME')
    local timestampMs = tostring((time[1] * 1000) + math.floor(time[2] / 1000))
    
    -- Update the status AND the completedAt timestamp
    redis.call('HSET', jobKey, 'status', 'completed', 'completedAt', timestampMs)

    return 1 -- Success
end

return 0 -- Lock mismatch or job expired