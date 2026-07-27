# Retries & Dead Jobs

## The `attempt` / `maxAttempts` mechanism

Every job hash carries an `attempt` counter (starts unset/0, incremented atomically via `HINCRBY` — never a read-modify-write from application code) and a `maxAttempts` value (set at job-creation time via job options, read fresh from the hash on every failure/sweep). On any failure — explicit (`addToDelayedOrDead`) or implicit (sweeper-detected zombie) — the same comparison runs:

```
attempt <= maxAttempts  →  route to `delay` ZSET, status = "delayed"   (will retry)
attempt >  maxAttempts  →  route to `dead` list,  status = "dead"      (exhausted)
```

Because `HINCRBY` is atomic and both failure paths (explicit and sweeper) run through the exact same increment-then-compare logic inside their respective Lua scripts, a job's `attempt` count is accurate and race-free regardless of which mechanism caused each individual failure — you can't have a sweeper-caused failure and an explicit-failure both increment based on a stale read of the same counter.

## Retry delay/backoff

Both failure paths currently push the retried job into `delay` with score `0` — meaning "eligible immediately," picked up on the very next `claimNextJob`'s delayed-job migration step (see [`lua/claim-job.md`](../lua/claim-job.md)). There is currently no built-in exponential backoff *between* retry attempts — a job that fails 3 times in a row will be reclaimed and retried up to 3 times in rapid succession, not with increasing delay.

**If your workload needs backoff between retries** (recommended for anything hitting an external API that might be rate-limiting or degraded), the place to add it is the `ZADD delayQ, <score>, jobId` calls in both `AddToDelayedOrDeadLua.lua` and `Sweeper.lua` — computing `now + backoffFn(attempt)` instead of a flat `0`. This is a known, scoped gap rather than something silently broken.

## Dead-letter queue: what it is and isn't

`dead` is a plain Redis List (`RPUSH`) of job IDs that exhausted `maxAttempts`. It is:
- **A durable record** — dead jobs aren't deleted, their job hash (`main:<jobId>`) still exists with `status = "dead"` and full payload/attempt history intact for inspection.
- **Not automatically retried, alerted on, or expired.** JiNiQ doesn't currently ship a "replay from dead letter" helper, a size-based alert, or a TTL on dead entries — operational tooling around the `dead` list (monitoring its length, building a manual/scripted replay path) is left to the integrator today.

## Duplicate submission (idempotency at insert time)

`addJobtoQueue`'s dedup check (`EXISTS jobKey`) means submitting a job with the same `jobId` twice is a safe no-op on the second call — useful for at-least-once producers that might retry an `addJob` call after an ambiguous network failure. This is insert-time idempotency only; it does not protect against a job being processed twice after a successful claim (see [`consistency.md`](./consistency.md) for that distinction).