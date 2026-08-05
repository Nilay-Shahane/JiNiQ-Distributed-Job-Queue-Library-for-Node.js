# Graceful Shutdown

## What `Worker.stop()` does, in order

```javascript
async stop() {
    await this.supervisor.stop();
    await RedisFactory.release();
}
```

1. **`supervisor.stop()`** — sets `#forceShutdown = true` (so the claim loop's `while` condition exits and no new claims are attempted), clears the pending poll `#timeoutId` (so no dangling timer keeps the process alive), and stops the `Sweeper`'s interval.
2. **`RedisFactory.release()`** — decrements a process-level reference count. The shared `manager`/`fetcher` connections are only actually disconnected once every `Worker` sharing them has called `stop()` and the count reaches zero — so stopping one worker in a multi-queue process does *not* disrupt the others still running. See "Connection-sharing implication" below.

## What this does *not* do: wait for in-flight jobs

`Supervisor.stop()` prevents new claims but does **not** await currently-running `JobExecutor.beginWork()` calls that were already in progress. If jobs are actively executing when `stop()` is called and this was the last worker sharing its connections, `RedisFactory.release()` can disconnect the Redis clients those jobs' `dbActions` (heartbeat renewal, completion reporting) depend on — meaning an in-flight job's heartbeat renewal or final `addToCompleted`/`addToFailed` call could fail with a connection error partway through shutdown.

**In practice, this is recoverable but not silent:** if a job's heartbeat can't renew because the connection is gone, that job's lock will simply expire on its normal TTL schedule and get picked up by the sweeper on another (still-running) worker, going through the standard zombie-recovery path — see [`failure-recovery.md`](./failure-recovery.md). No job is permanently lost, but a shutdown mid-job does mean that job pays the full crash-recovery latency cost rather than completing cleanly.

**If your workload can't tolerate this latency on every deploy:** track active jobs via the `job:completed`/`job:failed` events and delay calling `stop()` until in-flight work drains, or accept that a hard stop means affected jobs pay the full sweeper-recovery cost.

## Connection-sharing implication (multi-worker processes)

`RedisFactory`'s `manager`/`fetcher` pair is a **process-level static**, shared across every `Worker` instance in the same process, and **reference-counted**. Each `Worker` construction calls `RedisFactory.initialize()` (incrementing the count); each `Worker.stop()` calls `RedisFactory.release()` (decrementing it). The underlying Redis connections are only torn down when the count hits zero — i.e. when the *last* worker sharing them stops.

**Practical implication:** if a single process runs multiple `Worker` instances (e.g. one process consuming several distinct queues), you can safely call `.stop()` on an individual worker — it decrements the shared refcount without disconnecting the pool out from under the others. The connections are only closed once every worker sharing them has stopped.

## Signal handling

JiNiQ doesn't register its own `SIGTERM`/`SIGINT` handlers — this is left to the integrator, as shown in the top-level README's quick-start example:

```javascript
process.on("SIGTERM", async () => {
    await worker.stop();
    process.exit(0);
});
```