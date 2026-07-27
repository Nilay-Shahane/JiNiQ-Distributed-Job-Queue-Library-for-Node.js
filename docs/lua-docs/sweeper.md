# `sweeper` (`Sweeper.lua` → `sweeper`)

Scans the entire `active` list for jobs whose lock has expired and recovers them — this is the script that makes worker crashes non-fatal to job durability. Called on a fixed interval by every worker's `Sweeper`, not tied to any specific job.

## Contract

**KEYS**
1. `active` list
2. `delay` ZSET
3. `dead` list

**ARGV**
1. `lockPrefix`
2. `jobHashPrefix` (i.e. `main`)

**Returns:** `sweptCount` (integer — how many zombie jobs were recovered this pass)

## Logic

```lua
local activeJobs = redis.call('LRANGE', activeQ, 0, -1)
local sweptCount = 0

for _, payload in ipairs(activeJobs) do
    local jobId = string.sub(payload, 1, string.find(payload, ":") - 1)
    local lockKey = lockPrefix .. ":" .. jobId
    local jobHashKey = jobHashPrefix .. ":" .. jobId

    if redis.call('EXISTS', lockKey) == 0 then
        redis.call('LREM', activeQ, 0, payload)
        local attempt = redis.call('HINCRBY', jobHashKey, 'attempt', 1)
        local maxAttempt = tonumber(redis.call('HGET', jobHashKey, 'maxAttempts') or 0)

        if attempt <= maxAttempt then
            redis.call('ZADD', delayQ, 0, jobId)
            redis.call('HSET', jobHashKey, 'status', 'delayed')
        else
            redis.call('RPUSH', deadQ, jobId)
            redis.call('HSET', jobHashKey, 'status', 'dead')
        end
        sweptCount = sweptCount + 1
    end
end

return sweptCount
```

## The core signal: `EXISTS(lockKey) == 0`

This is the entire failure-detection mechanism. A job in `active` should always have a corresponding `lock:<jobId>` key while it's genuinely being worked on — that lock is kept alive by the owning worker's `HeartBeat`. If the lock is gone but the job is still listed in `active`, the only explanation is that the lock expired naturally (its TTL ran out) without being renewed — which happens when the owning worker died, was network-partitioned from Redis, or hung badly enough to miss every renewal window before expiry.

## Retry logic is identical to the explicit-failure path

Notice this script increments `attempt` and routes to `delay`/`dead` using the exact same `HINCRBY` + threshold-comparison logic as `AddToDelayedOrDeadLua.lua` (the explicit failure path called from `JobExecutor`). This isn't a coincidence — it's what makes a job's total `attempt` count meaningful regardless of *why* it failed. A job doesn't know or care whether its 3rd failure came from its processor throwing an error or from its worker crashing silently; both consume one retry.

## `ZADD delayQ 0 jobId` — why score `0`?

A swept job is pushed into the delay queue with score `0`, meaning "the required delay has already elapsed as of any `now`." The next `claimNextJob` call's delayed-job migration step (`ZRANGEBYSCORE delayQ -inf now`) will pick it up immediately on the very next claim cycle, rather than waiting for a fixed backoff. Whether you want instant retry vs. a backoff delay for zombie-recovered jobs specifically is a design choice worth revisiting — right now it's "retry immediately," same urgency as a fresh non-delayed job.

## Cost consideration

This script is `O(n)` in the size of the `active` list per invocation — every sweep interval, it walks every currently-active job, not just ones that might be zombies. For queues with very high concurrency (thousands of simultaneously active jobs), this cost scales with `maxConcurrency × numberOfWorkers`, and is worth keeping in mind when tuning `sweeperInterval` — too frequent, and you're doing a full active-list scan more often than necessary; too infrequent, and zombie jobs sit undetected longer.