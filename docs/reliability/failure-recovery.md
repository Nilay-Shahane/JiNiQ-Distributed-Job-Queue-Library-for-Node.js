# Failure Recovery

What happens, concretely, for every failure mode JiNiQ is designed to survive.

## Worker process crashes mid-job

**Detection:** the crashed worker's `HeartBeat` stops renewing `lock:<jobId>`. The lock expires naturally after its TTL. The job remains listed in the `active` list (nothing removed it — the crash happened before any cleanup code could run).

**Recovery:** on its next tick, *any* live worker's `Sweeper` finds the `active` entry whose `lock:<jobId>` no longer exists, increments `attempt`, and routes the job to `delay` (retry) or `dead` (exhausted) based on `maxAttempts`. See [`lua-docs/sweeper.md`](../lua-docs/sweeper.md).

**Bound on detection time:** worst case, `ttl + sweeperInterval` — the lock has to fully expire, then a sweep cycle has to run. Tune `lockDuration` and `sweeperInterval` together based on how quickly you need crash recovery vs. how much sweep/heartbeat overhead you're willing to accept.

## Worker loses network connectivity to Redis (but the process is alive)

Same detection/recovery path as a full crash — from Redis's perspective, a partitioned worker and a dead worker look identical: the lock stops being renewed. The difference only matters locally: if the partition heals *before* the lease is lost to a sweep, the worker's own `HeartBeat.runHeartbeat()` will get a `-1` (ownership mismatch) or `0` (lock gone) response on its next renewal attempt once connectivity returns, and will call `abortFn()` to stop the in-flight job itself — see [`lua-docs/heartbeat.md`](../lua-docs/heartbeat.md). This is what prevents a "the network came back so now two workers are both finishing the same job" scenario.

## A job's processor function throws

Handled entirely within `JobExecutor`'s own catch block — no sweeper involvement needed, since the worker is alive and can report the failure itself. `addToFailed` runs `addToDelayedOrDead`, incrementing `attempt` and routing to retry or dead-letter. See [`retries-and-dead-jobs.md`](./retries-and-dead-jobs.md).

## A job's processor function hangs (never resolves, never rejects)

Bounded by `maxTimeoutMs` — `JobExecutor` races the user function against a timeout promise. When the timeout wins, it rejects with a `JOB_TIMEOUT` error and calls `controller.abort()`, landing in the same failure path as an explicit throw. The `signal` passed to your processor function is your hook to actually stop wasted work (cancel a fetch, kill a subprocess) rather than merely being ignored while the timeout fires around it.

## Redis itself becomes unavailable

`RedisDB`'s `retryStrategy` reconnects with capped exponential backoff (`min(times * 100, 3000)`ms). While disconnected: `addJob` calls will fail/reject (producers should handle this — JiNiQ doesn't currently buffer writes locally), claim attempts will error out of `claimHandler`'s try block (caught, logged, and the loop continues on its next backoff tick rather than crashing the worker process), and in-flight jobs' heartbeats will fail to renew — which, if the outage outlasts the lease TTL, means those jobs get swept and retried once Redis returns and a worker survives long enough to run the sweep. Redis unavailability that outlasts a job's TTL is treated identically to a worker crash from the queue's perspective.

## Two workers somehow both believe they hold the same job's lock

This shouldn't be reachable given the ownership checks in every Lua script that touches an active job — but if it were (e.g. a bug introduced by an incomplete script edit), the failure mode would be: both workers run the user function to completion; whichever calls `checkAndComplete`/`addToDelayedOrDead` *first* wins (Lua's atomicity guarantees exactly one `GET lockKey == workerId` check succeeds); the second gets a no-op return and its result is silently discarded. Duplicate *execution* is possible in this hypothetical; duplicate *state corruption* is not, because of the ownership gate. See [`consistency.md`](./consistency.md) for what guarantee this actually amounts to.