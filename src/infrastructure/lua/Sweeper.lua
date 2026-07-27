local activeQ = KEYS[1]
local delayQ = KEYS[2]
local deadQ = KEYS[3]

local lockPrefix = ARGV[1]
local jobHashPrefix = ARGV[2]

-- Get all jobs currently in the active queue
local activeJobs = redis.call('LRANGE', activeQ, 0, -1)
local sweptCount = 0

for _, payload in ipairs(activeJobs) do
    -- Extract jobId from the "jobId:workerId" payload
    local splitIndex = string.find(payload, ":")
    
    if splitIndex then
        local jobId = string.sub(payload, 1, splitIndex - 1)
        
        local lockKey = lockPrefix .. ":" .. jobId
        local jobHashKey = jobHashPrefix .. ":" .. jobId
        
        -- If the lock is missing, the heartbeat flatlined (Worker crashed or stalled)
        if redis.call('EXISTS', lockKey) == 0 then
            
            -- 1. Remove from active queue
            redis.call('LREM', activeQ, 0, payload)
            
            -- 2. Atomically increment the attempt counter
            local currAttempt = redis.call('HINCRBY', jobHashKey, 'attempt', 1)
            
            -- Safely parse maxAttempts
            local maxAttemptRaw = redis.call('HGET', jobHashKey, 'maxAttempts')
            local maxAttempt = 0
            if maxAttemptRaw then
                maxAttempt = tonumber(maxAttemptRaw) or 0
            end
            
            -- 3. Route and UPDATE STATUS based on attempts
            if currAttempt <= maxAttempt then
                -- Move to delayed queue
                redis.call('ZADD', delayQ, 0, jobId)
                redis.call('HSET', jobHashKey, 'status', 'delayed')
            else
                -- Max attempts reached, push to dead letter list
                redis.call('RPUSH', deadQ, jobId)
                redis.call('HSET', jobHashKey, 'status', 'dead')
            end
            
            sweptCount = sweptCount + 1
        end
    end
end

return sweptCount