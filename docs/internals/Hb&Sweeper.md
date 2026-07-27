# Heartbeat & Sweeper

These two components are two halves of the same failure-detection mechanism: `HeartBeat` proves a worker is still alive to Redis; `Sweeper` acts on the absence of that proof. Neither knows about the other directly — they only interact through the `lock:<jobId>` key's TTL.

## HeartBeat

**File:** `worker/HeartBeat.js`

One `HeartBeat` instance per active job, created by `JobExecutor`. Its only responsibility is renewing `lock:<jobId>`'s TTL before it expires.

### Startup jitter

```js
randomOffset = async () => { await this.sleep(Math.random() * 50) }
startHeartbeatProcess = async () => {
    await this.randomOffset();
    let resp = await this.dbActions.checkAndUpdateHeartbeat();
    if (resp !== 1) { this.setStopHeartBeat(true); this.abortFn?.(); return; }
    this.runHeartbeat();
}
```

The random 0–50ms delay before the *first* renewal exists so that a burst of jobs claimed in the same tick (common right after a Supervisor's claim loop drains a backlog) don't all hit Redis with a renewal call in the exact same millisecond. It's a small jitter, but it smooths out an otherwise synchronized spike.

### The renewal loop

```js
runHeartbeat = async () => {
    while (!this.#stopHeartbeat) {
        await this.sleep(this.ttl / 3);
        if (this.#stopHeartbeat) break;
        const resp = await this.dbActions.checkAndUpdateHeartbeat();
        if (resp !== 1) { this.setStopHeartBeat(true); this.abortFn?.(); break; }
    }
}
```

Renewing at `ttl / 3` means a lock with a 30s TTL gets a renewal attempt every 10s — three chances to succeed before the lock would actually expire, giving real margin against a single slow/dropped Redis call.

### Interruptible sleep

```js
sleep = (ms) => new Promise(resolve => {
    this.#resolveSleep = resolve;
    this.#timeoutId = setTimeout(() => { ...; resolve() }, ms);
})
```

`setStopHeartBeat(true)` clears the pending timeout *and* resolves the sleep promise immediately if one is in flight. This is what lets `JobExecutor`'s `finally` block stop a heartbeat instantly when a job finishes, instead of waiting up to `ttl / 3` for the current sleep to naturally expire — important because a lingering heartbeat renewal after a job completes would otherwise keep a stale lock alive for no reason.

### Ownership loss → abort

If `checkAndUpdateHeartbeat` (the `renewJobLease` Lua script) ever returns anything other than `1` — meaning the lock's current owner in Redis isn't this `workerId` anymore — the heartbeat stops itself and calls `abortFn()`, which triggers the `AbortController` that `JobExecutor` passed in `userProcess(payload, signal)`. This is the mechanism that turns "the sweeper decided this job was a zombie" into "the original worker's in-flight execution actually stops," rather than two workers silently processing the same job to completion.

## Sweeper

**File:** `worker/Sweeper.js`

Runs independently of any specific job, on its own `setInterval` (default 30s, configurable). Each tick calls `RedisStorage.sweepZombies()`, which runs the `sweeper` Lua script — see [`lua/sweeper.md`](../lua/sweeper.md) for the exact logic. Conceptually: scan the `active` list, and for every entry whose `lock:<jobId>` key no longer exists (expired — no heartbeat renewal arrived in time), treat it exactly like an explicit failure: increment `attempt`, and route to retry or dead-letter based on `maxAttempts`.

`Sweeper.start()`'s interval is `unref()`'d, so a lone sweeper timer never keeps the Node process alive by itself if everything else has shut down.

### Why this has to be a separate process/timer, not part of `JobExecutor`

`JobExecutor` only exists for jobs *this* worker is actively running. A worker that crashes doesn't get to run any of its own cleanup code — `finally` blocks don't execute on `kill -9` or an OOM kill. The sweeper has to be able to detect and recover jobs claimed by a worker that no longer exists at all, which means it must be capable of running on any live worker, independent of who originally claimed the job.