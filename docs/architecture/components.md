# Components

Each component has exactly one job. This page is the map; see [`internals/`](../internals/) for the deep dive on the non-trivial ones.

## `Jiniq` (producer)
**File:** `queue/Jiniq.js`
Public API for adding jobs. Owns its own pair of `RedisDB` connections (independent from any worker's). Validates input, enforces the 1MB payload cap, generates job IDs when not supplied, serializes jobs to a Redis hash shape, and delegates the actual write to `RedisStorage`. Emits `job:submitted` / `jobs:submitted:bulk` locally.See [`internals/Jiniq.md`](../internals/Supervisor.md).


## `Worker` (consumer entry point)
**File:** `worker/Worker.js`
Wires everything together for the consuming side: gets shared Redis connections from `RedisFactory`, constructs a `RedisStorage`, a `Sweeper`, and a `Supervisor`, and re-emits the supervisor's `job:completed` / `job:failed` events on itself. `start()` and `stop()` are the only two lifecycle calls a user needs.See [`internals/Worker.md`](../internals/Worker.md).


## `Supervisor` (orchestrator)
**File:** `worker/Supervisor.js`
The polling and concurrency-management brain. Tracks `activeWorkers` (a `Set` of workerIds currently running), decides when there's a free slot (`hasSlot()`), claims jobs one at a time up to that slot count, and hands each claim off to a `JobExecutor` without waiting for it to finish (fire-and-continue-polling). Backs off its own poll interval exponentially (50ms → up to 2000ms) when the queue is empty, and resets to 50ms immediately on any activity. See [`internals/Supervisor.md`](../internals/Supervisor.md).

## `JobExecutor` (single-job runner)
**File:** `worker/JobExecutor.js`
Everything that happens to *one* claimed job: fetch its payload (injecting the `jobId` into the payload object for developer convenience), start its heartbeat, race the user's processor function against a timeout, report completion or failure, and guarantee the heartbeat is stopped no matter what. See [`internals/JobExecutor.md`](../internals/JobExecutor.md).

## `HeartBeat` (lease renewal)
**File:** `worker/HeartBeat.js`
Keeps a job's Redis lock alive while it's being processed, renewing at roughly `ttl / 3` intervals with a small random jitter on startup (to avoid thundering-herd renewal patterns across many jobs claimed at once). If a renewal is ever rejected (ownership lost — the sweeper decided this job was a zombie and reassigned it), it aborts the in-flight job via an `AbortController`. See [`internals/Hb&Sweeper.md`](../internals/Hb&Sweeper.md).

## `Sweeper` (zombie recovery)
**File:** `worker/Sweeper.js`
Runs on its own `setInterval`, independent of any specific job or worker. Scans the active queue for jobs whose lock has expired and routes them to retry or dead-letter. This is what makes crash recovery work even when the crashed worker never gets a chance to run any cleanup code. See [`internals/Hb&Sweeper.md`](../internals/Hb&Sweeper.md).

## `Job` (domain model)
**File:** `domain/Job.js`
The universal data structure for a job. Handles parsing to and from the Redis Hash format (`toRedisHash()`, `fromRedisHash()`) and encapsulates default values for retries, priority offsets, and TTLs.

## `RedisStorage` (Redis abstraction)
**File:** `infrastructure/db/RedisStorage.js`
The only place that knows the actual Redis key names and Lua script argument order. Every other component calls semantic methods (`addJobToQueue`, `fromWaitingToActive`, `checkAndUpdateHeartbeat`, ...) without knowing they're backed by Lua. See [`internals/RedisStorage.md`](../internals/RedisStorage.md).

## `RedisDB` / `RedisFactory` (connection layer)
**Files:** `infrastructure/db/RedisDB.js`, `infrastructure/db/RedisFactory.js`
`RedisDB` wraps an `ioredis` client, loads and registers all five Lua scripts as custom commands, and exposes `run()`, `pipeline()`, `disconnect()`. `RedisFactory` provides shared manager/fetcher connections for the worker side enforcing the Singleton pattern.