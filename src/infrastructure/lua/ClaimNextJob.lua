-- KEYS[1] = priority zset
-- KEYS[2] = normal zset
-- KEYS[3] = active list
-- KEYS[4] = lock prefix
-- KEYS[5] = delay zset  <-- [NEW] We need to pass the delay queue key!

-- ARGV[1] = ttl (ms)
-- ARGV[2] = now (timestamp)
-- ARGV[3] = offset (priority offset)
-- ARGV[4] = workerId

local priorityQ = KEYS[1]
local normalQ   = KEYS[2]
local activeQ   = KEYS[3]
local lockPrefix = KEYS[4]
local delayQ    = KEYS[5]

local ttl       = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])
local offset    = tonumber(ARGV[3]) or 10000   
local workerId  = ARGV[4]

-- ==========================================
-- STEP 1: MIGRATE READY DELAYED JOBS
-- ==========================================
-- Find any jobs in delayQ whose timestamp is in the past (<= now)
local readyDelayed = redis.call('ZRANGEBYSCORE', delayQ, '-inf', now)

if #readyDelayed > 0 then
    for _, dJobId in ipairs(readyDelayed) do
        -- Move them to the normal queue so they can be processed
        redis.call('ZADD', normalQ, now, dJobId)
        redis.call('ZREM', delayQ, dJobId)
    end
end

-- ==========================================
-- STEP 2: FETCH THE HIGHEST PRIORITY JOB
-- ==========================================
local prioData = redis.call('ZRANGE', priorityQ, 0, 0, 'WITHSCORES')
local normData = redis.call('ZRANGE', normalQ, 0, 0, 'WITHSCORES')

local jobId = nil
local source = nil

if #prioData > 0 and #normData > 0 then
    local prioId    = prioData[1]
    local prioScore = tonumber(prioData[2])

    local normId    = normData[1]
    local normScore = tonumber(normData[2])

    if (prioScore - offset) <= normScore then
        jobId = prioId
        source = priorityQ
    else
        jobId = normId
        source = normalQ
    end
elseif #prioData > 0 then
    jobId = prioData[1]
    source = priorityQ
elseif #normData > 0 then
    jobId = normData[1]
    source = normalQ
end

-- ==========================================
-- STEP 3: CLAIM THE JOB AND SET LOCKS
-- ==========================================
if jobId then
    local jobScore = tonumber(redis.call('ZSCORE', source, jobId))
    
    -- Safety check: ensure the job isn't scheduled for the future
    if jobScore > now then
        return nil
    end

    local jobKey = lockPrefix .. ":" .. jobId 

    if redis.call('EXISTS', jobKey) == 1 then
        return 0
    end

    -- Move to active queue
    redis.call('RPUSH', activeQ, jobId .. ":" .. workerId) 

    -- Set lock with TTL
    redis.call('PSETEX', jobKey, ttl, workerId)  

    -- Remove from source queue
    redis.call('ZREM', source, jobId)

    return jobId
end

return nil