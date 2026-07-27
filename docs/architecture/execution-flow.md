# Execution Flow: Producer → Worker → Completion

This traces one job through the entire system, call by call.

## 1. Producer adds the job

```js
await queue.addJob("resize-image", { imageId: 42 }, { priority: "high" });
```

`Jiniq.addJob()`:
1. Validates `jobName` and payload size (1MB cap).
2. Builds a `Job` domain object with a generated (or supplied) `jobId`.
3. Serializes it to a flat hash shape (`job.toRedisHash()`).
4. Calls `RedisStorage.addJobToQueue()`, which runs the `addJobtoQueue` Lua script.

Inside the script: dedup check (`EXISTS`), capacity check (`maxQueueSize`), `HSET` the job hash, then route into `priority` / `normal` / `delay` ZSET based on the job's `delay` and `priority` fields, and `PUBLISH` the job ID to the `notify` channel. Returns `1` (added), `0` (duplicate, no-op), or the script throws a `QueueFullError` if `-1` comes back.

`Jiniq` emits a local `job:submitted` event and returns the domain `Job` object to the caller.

## 2. Worker claims the job

A `Supervisor` is continuously polling (see [`internals/supervisor.md`](../internals/supervisor.md)). Whenever `hasSlot()` is true, it calls `fetchJob()`:

```js
const jobId = await this.storage.fromWaitingToActive({ ttl, priorityOffset, workerId });
```

This runs `claimNextJob` Lua, which:
1. Migrates any due delayed jobs from `delay` ZSET into `normal` ZSET.
2. Peeks the lowest-scored member of both `priority` and `normal` ZSETs.
3. Compares `priorityScore - offset` vs `normalScore` to decide which one actually wins the claim (see [`lua/claim-job.md`](../lua/claim-job.md) for the exact comparison).
4. `RPUSH`es `"jobId:workerId"` onto the `active` list, `PSETEX`s the `lock:<jobId>` key with the given TTL, and `ZREM`s the job from wherever it came from.
5. Returns the claimed `jobId` (or `nil` if nothing was available).

## 3. Job execution begins

`Supervisor.assignJob()` constructs a `JobExecutor` for the claimed `{ jobId, workerId }`, bundling a `dbActions` object (closures over `jobId`/`workerId` bound to the relevant `RedisStorage` methods) so the executor never needs to know Redis exists.

`JobExecutor.beginWork()`:
1. Fetches the payload (`dbActions.getPayload()`).
2. Starts the heartbeat (`HeartBeat.startHeartbeatProcess()`) — see [`internals/heartbeat-sweeper.md`](../internals/heartbeat-sweeper.md).
3. Races your processor function against a `maxTimeoutMs` timer, both wired to a shared `AbortController` so a timeout (or a lost heartbeat) can cancel the user function via `signal`.

## 4. Completion or failure is reported

**On success:** `dbActions.addToCompleted()` runs `checkAndComplete` Lua (verifies lock ownership, `DEL`s the lock, `LREM`s from `active`, `RPUSH`es to `complete`, sets `status=completed`). Then `publishLog('Completed', payload)` writes to the log stream.

**On failure (or timeout, or abort):** `dbActions.addToFailed()` runs `addToDelayedOrDead` Lua (verifies lock ownership, `HINCRBY`s the attempt counter, routes to `delay` ZSET for retry or `dead` list based on `attempt` vs `maxAttempts`). Then `publishLog('Failed', payload, errorStack)`.

**Always:** the heartbeat is stopped in a `finally` block, and `Supervisor` removes the worker slot and immediately triggers another `claimHandler()` cycle — so a finished slot is refilled without waiting for the next poll tick.

## 5. Independently: the sweeper

None of the above assumes the worker survives. If it doesn't, the `Sweeper` (running on its own timer, on any live worker) finds the orphaned `active` entry once its lock has expired and performs the same retry/dead routing itself. See [`reliability/failure-recovery.md`](../reliability/failure-recovery.md).