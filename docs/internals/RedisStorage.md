# RedisStorage

**File:** `infrastructure/db/RedisStorage.js`

`RedisStorage` is the single translation layer between "semantic queue operations" and "Redis keys + Lua scripts." Nothing outside this class knows a key name or a Lua script's argument order — `Jiniq`, `Supervisor`, and `JobExecutor` all call methods like `addJobToQueue()` or `checkAndUpdateHeartbeat()` without knowing what's underneath.

## Constructor

Takes a queue name and two `RedisDB` instances — `manager` and `fetcher` — and builds the full key map once (see [`architecture/redis-data-model.md`](../architecture/redis-data-model.md)). Why two separate connections rather than one is covered in [`internals/connection-management.md`](./connection-management.md); the short version is that claim polling and everything else shouldn't compete over the same client's command queue.

## Method-to-script map

| Method | Lua command | Used by |
|---|---|---|
| `addJobToQueue(job, opts)` | `addJobtoQueue` | `Jiniq.addJob` |
| `addBulkJobs(jobs, opts)` | `addJobtoQueue`, pipelined | `Jiniq.addBulk` |
| `fromWaitingToActive(opts)` | `claimNextJob` | `Supervisor.fetchJob` |
| `checkAndUpdateHeartbeat(...)` | `renewJobLease` | `HeartBeat.runHeartbeat` |
| `addToCompleted(...)` | `checkAndComplete` | `JobExecutor` (success path) |
| `addToFailed(...)` | `addToDelayedOrDead` | `JobExecutor` (failure path) |
| `sweepZombies()` | `sweeper` | `Sweeper` |
| `getPayload(jobId)` | plain `HGET` | `JobExecutor` |
| `publishLog(...)` | plain `XADD` | `JobExecutor` |

## `addBulkJobs`: pipelining, not a single Lua call

Bulk insert doesn't wrap the whole array in one Lua script — it chunks the array (`chunkSize`, default 1000) and issues each job's `addJobtoQueue` call through an `ioredis` pipeline:

```js
const pipeline = this.manager.pipeline();
for (const job of chunk) pipeline.addJobtoQueue(...keys, ...args);
const results = await pipeline.exec();
```

This trades single-job atomicity guarantees (each job's *own* add is still atomic, since it's still one Lua execution) for round-trip efficiency — 1000 jobs cost one network round trip instead of 1000. The result codes (`1`, `0`, `-1`, or anything else) are interpreted per-job afterward so a partial failure in a 5000-job bulk insert doesn't take down the other 4999; `addBulkJobs` returns `{ successCount, failedCount, failedJobs }` rather than throwing.

## `getPayload`: the one place that isn't Lua

Reading a payload doesn't need atomicity with anything else — it's a plain `HGET`, JSON-parsed with a string fallback. This is intentional: not every Redis interaction needs to go through a Lua script, only the ones with multi-step invariants to protect.

## `publishLog`: fire-and-forget observability

`XADD ... MAXLEN ~ 1000 * jobId status payload timestamp error`. The `~` makes the trim approximate (cheaper than exact trimming) — the stream is meant for dashboards and debugging, not as a source of truth for job state, so approximate retention is an acceptable tradeoff.

## `shutdown()`

Disconnects both `manager` and `fetcher` in parallel (`Promise.all`). See [`reliability/graceful-shutdown.md`](../reliability/graceful-shutdown.md) for how this fits into a worker's full stop sequence, and [`internals/connection-management.md`](./connection-management.md) for why calling this carelessly can affect more than one queue.