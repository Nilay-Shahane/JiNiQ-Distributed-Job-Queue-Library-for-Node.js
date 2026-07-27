# `complete-job` (`CheckAndComplete.lua` → `checkAndComplete`)

Marks a job as successfully completed — but only if the caller still holds its lock.

## Contract

**KEYS**
1. `lock` prefix
2. `active` list
3. `complete` list

**ARGV**
1. `jobId`
2. `workerId`
3. `jobKey` (`main:<jobId>` — used to update the status field)

**Returns:** `1` (completed) · `0` (lock mismatch or already expired — no-op)

## Logic

```lua
local lockKey = lockPrefix .. ":" .. jobId
local currentWorker = redis.call('GET', lockKey)

if currentWorker == workerId then
    redis.call('DEL', lockKey)
    redis.call('LREM', activeQ, 0, jobId .. ":" .. workerId)
    redis.call('RPUSH', completeQ, jobId)
    redis.call('HSET', jobKey, 'status', 'completed')
    return 1
end

return 0
```

Note `currentWorker == workerId` here — if `currentWorker` is `false` (Lua's representation of a missing key from `redis.call('GET', ...)`), this comparison is also false, so a missing lock and a mismatched lock both correctly fall through to `return 0` without needing a separate branch.

## Why the ownership check matters here specifically

This is the completion path — the point where `JobExecutor` believes the user's processor function succeeded. Without the lock check, a worker whose lock already expired (heartbeat fell behind, sweeper already reclaimed and requeued the job for someone else) could still successfully report completion for a job that's simultaneously being retried or is already claimed by another worker. That would mean the job shows up in `complete` while *also* potentially running again elsewhere — a duplicate-completion / phantom-success bug that would be very hard to trace back to its root cause. Gating on lock ownership makes this exact scenario a clean no-op (`return 0`) instead: `JobExecutor` sees `completed !== 1`, logs a warning, and moves on without touching Redis state further.

## The `LREM` count argument

`LREM activeQ 0 payload` — `0` as the count means "remove all matching occurrences," not "remove the first one only." In practice there should only ever be one `jobId:workerId` entry in `active` at a time, but using `0` here is a defensive choice rather than assuming that invariant always holds perfectly.

## Note on TTLs and the `complete` list

The script's own comments call this out explicitly: you cannot set a TTL on an individual list element in Redis. `PEXPIRE` on `completeQ` would apply to the *entire* list, not just this job's entry — so `complete` grows unboundedly unless something else (a separate cleanup job, or switching to a capped structure) trims it. This is a known operational gap, not an oversight in this script specifically.