# `add-job` (`AddJobLua.lua` → `addJobtoQueue`)

Inserts a new job: deduplicates, enforces the optional queue-size cap, writes the job hash, and routes it into the correct waiting structure.

## Contract

**KEYS**
1. `jobKey` — `main:<jobId>`
2. `priority` ZSET
3. `normal` ZSET
4. `delay` ZSET
5. `notify` pub/sub channel

**ARGV**
1. `jobId`
2. `priorityString` (`"high"` or `"normal"`)
3. `delay` (ms; `0` if not delayed)
4. `timestamp` (submission time, ms)
5. `priorityOffset` (ms — how much of a head start priority jobs get; see [`claim-job.md`](./claim-job.md))
6. `maxQueueSize` (`0` = unlimited)
7...N. flattened `field, value` pairs for the job hash

**Returns:** `1` (added) · `0` (duplicate — job ID already exists, no-op) · `-1` (queue full)

## Logic, in order

```lua
if redis.call("EXISTS", jobKey) == 1 then return 0 end
```
Dedup check first, before anything else — a duplicate `jobId` (e.g. a retried client-side submission) is a safe no-op rather than an error, matching at-least-once producer semantics without corrupting queue depth.

```lua
if maxQueueSize > 0 then
    local size = redis.call("LLEN", normalKey) + redis.call("ZCARD", priorityKey)
    -- wait, actually: ZCARD normal + ZCARD priority, both are ZSETs
    if size >= maxQueueSize then return -1 end
end
```
Capacity is checked *before* writing anything, and checked atomically alongside the write (both happen inside the same Lua execution) — a burst of concurrent `addJob` calls can't collectively overshoot `maxQueueSize` the way a check-then-write done from Node (two separate round trips) could.

```lua
redis.call("HSET", jobKey, unpack(ARGV, 7))
```
Writes every job field in one `HSET` call using the flattened `ARGV` tail.

```lua
if delay > 0 then
    redis.call("ZADD", delayKey, timestamp + delay, jobId)
elseif priorityString == "high" then
    redis.call("ZADD", priorityKey, timestamp - priorityOffset, jobId)
else
    redis.call("ZADD", normalKey, timestamp, jobId)
end
redis.call("PUBLISH", notifyChannel, jobId)
```
Routing is mutually exclusive — a job is delayed, high-priority, or normal, never more than one. The `PUBLISH` fires regardless of which queue it landed in (delayed jobs aren't claimable yet, but the notify channel is intentionally a low-cost hint, not a claim guarantee — see [`decisions/polling-over-pubsub.md`](../decisions/polling-over-pubsub.md)).

## Why the priority score is `timestamp - priorityOffset`

Subtracting a fixed offset from a priority job's score means it sorts as if it had been submitted `priorityOffset` milliseconds earlier than it actually was — a deliberate, bounded head start rather than an unconditional "always first." This is what makes the anti-starvation comparison in `claim-job` possible: an old-enough normal job can still out-rank a brand-new priority job once the normal job's actual wait time exceeds the offset.