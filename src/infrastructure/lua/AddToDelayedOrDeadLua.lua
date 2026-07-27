local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local delayQ     = KEYS[3]
local deadQ      = KEYS[4]

local jobId      = ARGV[1]
local workerId   = ARGV[2]
local jobKey     = ARGV[3]
local errorMsg   = ARGV[4]

local lockKey = lockPrefix .. ":" .. jobId

-- Verify lock ownership


local currentWorker = redis.call("GET", lockKey)

if currentWorker ~= workerId then
    return -1
end

-- Increment attempt counter


local currAttempt = redis.call("HINCRBY", jobKey, "attempt", 1)
local maxAttempt  = tonumber(redis.call("HGET", jobKey, "maxAttempts") or 0)

-- Remove lock and active entry


redis.call("DEL", lockKey)

local activePayload = jobId .. ":" .. workerId
redis.call("LREM", activeQ, 0, activePayload)

-- Retry


if currAttempt <= maxAttempt then

    redis.call("ZADD", delayQ, 0, jobId)

    redis.call(
        "HSET",
        jobKey,
        "status", "delayed",
        "lastError", errorMsg,
        "lastWorker", workerId,
        "lastFailedAt", tostring(redis.call("TIME")[1])
    )

    return 1
end


-- Dead


redis.call("RPUSH", deadQ, jobId)

redis.call(
    "HSET",
    jobKey,
    "status", "dead",
    "lastError", errorMsg,
    "lastWorker", workerId,
    "lastFailedAt", tostring(redis.call("TIME")[1])
)

return 2