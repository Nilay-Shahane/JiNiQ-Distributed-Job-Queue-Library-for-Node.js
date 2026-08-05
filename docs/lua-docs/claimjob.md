# `claim-job` (`ClaimNextJob.lua` → `claimNextJob`)

The busiest script in the system — every `Supervisor` poll cycle calls this once per available slot. It migrates due delayed jobs, decides which waiting job wins (priority vs normal, with anti-starvation), and atomically claims it.

## Contract

**KEYS**
1. `priority` ZSET
2. `normal` ZSET
3. `active` list
4. `lock` prefix
5. `delay` ZSET

**ARGV**
1. `ttl` (ms — how long the claimed lock lasts before it's considered expired)
2. `now` (current timestamp, ms)
3. `offset` (priority offset, ms — same value used at insert time)
4. `workerId`

**Returns:** the claimed `jobId` (string) · `nil` (nothing eligible) · `0` (eligible job found, but its lock already exists — see caveat below)

## Step 1: migrate ready delayed jobs

```lua
local ready = redis.call('ZRANGEBYSCORE', delayQ, '-inf', now)
for _, dJobId in ipairs(ready) do
    redis.call('ZADD', normalQ, now, dJobId)
    redis.call('ZREM', delayQ, dJobId)
end

```

Every claim attempt first sweeps the delay queue for anything now due, promoting it into `normal` scored at the current time. This means delayed jobs don't need their own separate poller — claiming piggybacks the promotion, so a delayed job becomes eligible on the very next claim cycle after it's due, with no additional latency source.

## Step 2: pick a winner between priority and normal

```lua
local prio = ZRANGE(priorityQ, 0, 0, WITHSCORES)  -- lowest score = oldest/highest-priority
local norm = ZRANGE(normalQ, 0, 0, WITHSCORES)

if both exist then
    if (prioScore - offset) <= normScore then
        jobId = prioId
    else
        jobId = normId
    end
elseif only prio exists then jobId = prioId
elseif only norm exists then jobId = normId
end

```

This is the anti-starvation comparison, applied at claim time rather than baked permanently into a single shared score. A normal job that's been waiting longer than `offset` milliseconds will have a `normScore` low enough to beat an incoming priority job's `prioScore - offset` — so priority jobs get preferential treatment, but not at the cost of normal jobs waiting forever.

## Step 3: claim it and update metadata

```lua
local jobScore = tonumber(ZSCORE(source, jobId))
if jobScore > now then return nil end  -- safety: shouldn't be claimable yet

if EXISTS(lockKey) == 1 then return 0 end

RPUSH(activeQ, jobId .. ":" .. workerId)
PSETEX(lockKey, ttl, workerId)
ZREM(source, jobId)
HSET("main:" .. jobId, "status", "active", "workerId", workerId, "startedAt", now)
return jobId

```

The `jobScore > now` check is a defensive guard, not expected to trigger in normal operation — everything routed into `priority`/`normal` should already be eligible by the time it's there.

Updating the job hash (`status='active'`, `workerId`, `startedAt`) guarantees that any state query or dashboard inspection sees accurate real-time metadata immediately upon claim.

## ⚠️ Known caveat: the `EXISTS(lockKey) == 1` branch

If a job is found in a waiting ZSET but its lock key *already exists* (this shouldn't normally happen — a job in a waiting ZSET shouldn't simultaneously have an active lock — but could indicate a bug elsewhere, or a race during a schema migration), the script returns `0` **without removing the job from its source ZSET**. That means the exact same job will be re-selected and re-rejected on every subsequent poll cycle until the lock naturally expires — a tight, silent loop rather than a self-healing one. If you hit this in practice, the fix is a defensive `ZREM(source, jobId)` alongside the `return 0`. Flagging this here rather than silently "fixing" it in the doc, since it's a real edge case worth being deliberate about (should it retry, dead-letter, or just log and skip?).

```
