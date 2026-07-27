# JobExecutor

**File:** `worker/JobExecutor.js`

`JobExecutor` is the scope of exactly one claimed job. A new instance is created per job by `Supervisor.assignJob()` and discarded once `beginWork()` settles.

## What it's given

Constructed with `(Heartbeat, jobId, workerId, ttl, maxTimeoutMs, userProcess, dbActions)` — `dbActions` is a plain object of closures (`getPayload`, `addToCompleted`, `addToFailed`, `checkAndUpdateHeartbeat`, `publishLog`) pre-bound to this job's `jobId`/`workerId` by `Supervisor`. `JobExecutor` never touches `RedisStorage` or Redis directly — this indirection is what makes it independently testable with a mock `dbActions`.

## `beginWork()` walkthrough

```js
const controller = new AbortController();
const heartbeat = new this.Heartbeat(ttl, workerId, jobId, dbActions, () => controller.abort());
```

The heartbeat is given an abort callback — if it ever loses lease ownership, it can cancel the job's in-flight execution rather than letting it run to completion pointlessly.

```js
payload = await this.dbActions.getPayload(this.jobId);
await heartbeat.startHeartbeatProcess();

const resp = await Promise.race([
    this.userProcess(payload, controller.signal),
    timeoutPromise, // rejects after maxTimeoutMs, also calls controller.abort()
]);
```

Your processor function receives `(payload, signal)` — it's expected to respect `signal.aborted` for long-running work (a fetch, a subprocess) so a timeout or lease loss can actually stop wasted work rather than merely being ignored downstream.

## Success path

```js
const completed = await this.dbActions.addToCompleted();
if (completed !== 1) {
    // Lock ownership was lost between finishing work and reporting it —
    // some other worker's sweeper already reclaimed this job.
    console.warn(`Job ${jobId} completion rejected. Ownership lost`);
    return resp;
}
await this.dbActions.publishLog('Completed', payload);
```

The `completed !== 1` check matters: your processor function can finish successfully *after* the sweeper has already decided this job is a zombie and requeued it (e.g. a very slow heartbeat renewal under Redis latency spikes). In that case the result is discarded rather than double-writing a `complete` entry for a job that's already back in the retry queue.

## Failure path

Any throw — from the user function, from the timeout race, or an abort — lands here:

```js
catch (e) {
    controller.abort();
    await this.dbActions.addToFailed(e.message);
    await this.dbActions.publishLog('Failed', payload, e.stack || e.message);
    throw e; // re-thrown so Supervisor's assignJob().catch() sees it too
}
```

The stack trace (or message, as a fallback) is sent to the log stream for observability, separate from the retry-count bookkeeping that `addToFailed` performs in Redis.

## The `finally` block

```js
finally {
    heartbeat.setStopHeartBeat(true);
}
```

This runs unconditionally — success, failure, or an exception thrown from inside the try block itself. It's the single place that guarantees a heartbeat never keeps renewing a lock for a job that's no longer being worked on. Without this, a completed job's lock would linger until natural TTL expiry instead of being released the moment work stops.