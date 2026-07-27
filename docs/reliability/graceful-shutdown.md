# Graceful Shutdown

## What `Worker.stop()` does, in order

```js
async stop() {
    await this.supervisor.stop();
    await this.#storageInstance.shutdown();
}
```

1. **`supervisor.stop()`** — sets `#forceShutdown = true` (so the claim loop's `while` condition exits and no new claims are attempted), clears the pending poll `#timeoutId` (so no dangling timer keeps the process alive), and stops the `Sweeper`'s interval.
2. **`storageInstance.shutdown()`** — disconnects the `manager` and `fetcher` Redis connections (`Promise.all([manager.disconnect(), fetcher.disconnect()])`).

## What this does *not* do: wait for in-flight jobs

`Supervisor.stop()` prevents new claims but does **not** await currently-running `JobExecutor.beginWork()` calls that were already in progress. If jobs are actively executing when `stop()` is called, `storage.shutdown()` can disconnect the Redis clients those jobs' `dbActions` (heartbeat renewal, completion reporting) depend on — meaning an in-flight job's heartbeat renewal or final `addToCompleted`/`addToFailed` call could fail with a connection error partway through shutdown.

**In practice, this is recoverable but not silent:** if a job's heartbeat can't renew because the connection is gone, that job's lock will simply expire on its normal TTL schedule and get picked up by the sweeper on another (still-running) worker, going through the standard zombie-recovery path — see [`failure-recovery.md`](./failure-recovery.md). No job is permanently lost, but a shutdown mid-job does mean that job pays the full crash-recovery latency cost rather than completing cleanly.

**If your workload can't tolerate that latency on every deploy,** track `activeWorkers` (or listen for `job:completed`/`job:failed` events and count down from a known in-flight count) before calling `worker.stop()`, and give the process a drain window — stop claiming new work, wait for `activeWorkers.size === 0` (or a timeout), *then* call `stop()`. This isn't built into `Worker` today; it's an integration-level concern currently left to the caller.

## Connection-sharing implication (multi-worker processes)

As covered in [`internals/connection-management.md`](../internals/connection-management.md), `RedisFactory`'s `manager`/`fetcher` pair is a **process-level static**, shared across every `Worker` instance in the same process. `Worker.stop()` calling `storageInstance.shutdown()` disconnects those shared connections — which means calling `stop()` on *one* `Worker` in a multi-queue process will disrupt every other `Worker` sharing that connection pool, not just the one being stopped.

**Practical implication:** if a single process runs multiple `Worker` instances (e.g. one process consuming several distinct queues), don't call `.stop()` on an individual worker expecting it to be isolated — either stop all workers in that process together as a unit, or restructure connection ownership so each worker's storage layer doesn't share a connection pool with others you don't intend to also shut down.

## Signal handling

JiNiQ doesn't register its own `SIGTERM`/`SIGINT` handlers — this is left to the integrator, as shown in the [top-level README](../../README.md)'s quick-start example:

```js
process.on("SIGTERM", async () => {
    await worker.stop();
    process.exit(0);
});
```

Worth pairing this with the drain-then-stop pattern above rather than calling `stop()` immediately on signal receipt, if avoiding zombie-recovery latency on every deploy matters for your workload.