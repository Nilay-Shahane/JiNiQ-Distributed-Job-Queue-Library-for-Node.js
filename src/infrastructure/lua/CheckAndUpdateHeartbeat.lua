-- KEYS[1] = Lock
-- ARGV[1] = jobId
-- ARGV[2] = workerId
-- ARGV[3] = heartbeat (TTL in ms)
local jobKey = KEYS[1]..":"..ARGV[1]
local currentWorker = redis.call("GET", jobKey)

if not currentWorker then
    return 0 -- No lock exists
end

if currentWorker == ARGV[2] then
    redis.call("PEXPIRE", jobKey, ARGV[3])
    return 1 -- Success
else
    return -1 -- Zombie/Ownership mismatch
end