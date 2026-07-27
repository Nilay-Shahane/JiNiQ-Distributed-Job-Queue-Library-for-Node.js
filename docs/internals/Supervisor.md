# Supervisor

**File:** `worker/Supervisor.js`

The `Supervisor` is the polling loop and concurrency governor for a single worker process. It doesn't execute jobs itself — it claims them and hands them to `JobExecutor`, then goes right back to polling.

## State it tracks

- `activeWorkers: Set<workerId>` — currently in-flight jobs. Its size vs `maxConcurrency` is the only thing that decides whether there's a free slot.
- `#activeClaim: boolean` — a private re-entrancy guard. `claimHandler()` bails immediately if a claim cycle is already running, so overlapping triggers (e.g. a job finishing while a poll timer also fires) never run two claim loops concurrently.
- `#pollInterval` — the current backoff delay, starts at 50ms, caps at 2000ms.
- `#timeoutId` — the pending `setTimeout` handle for the next poll, tracked explicitly so `stop()` can cancel it and let the process exit cleanly instead of hanging on a dangling timer.

## The claim loop

```js
claimHandler = async () => {
    if (this.#forceShutdown || this.#activeClaim) return;
    this.#activeClaim = true;
    let foundWork = false;
    try {
        while (!this.#forceShutdown && this.hasSlot()) {
            const claimed = await this.fetchJob();
            if (!claimed) break;
            foundWork = true;
            this.assignJob(claimed).catch(err => { /* slot cleanup on assignment failure */ });
        }
    } finally {
        this.#activeClaim = false;
        if (foundWork) {
            this.#pollInterval = 50;
            this.emit('claimNextJob');
        } else {
            this.#pollInterval = Math.min(this.#pollInterval * 1.5, 2000);
            this.#timeoutId = setTimeout(() => this.emit('claimNextJob'), this.#pollInterval);
        }
    }
}
```

Notice `assignJob()` is **not awaited** inside the `while` loop — it's fired and the loop immediately tries to claim the *next* job if another slot is free. This is what lets a single `Supervisor` keep up to `maxConcurrency` jobs running concurrently rather than processing one at a time.

## Backoff behavior

- Every claim attempt that finds work resets `#pollInterval` to 50ms — an active queue gets polled aggressively.
- Every claim attempt that finds nothing multiplies the interval by 1.5, capped at 2000ms — an idle queue is polled less and less often instead of hammering Redis.
- The moment *any* job finishes (`assignJob`'s `.finally()`), `#pollInterval` is reset to 50ms and — if no claim cycle is currently running — `claimHandler()` is triggered immediately. This means a freed slot gets refilled right away, not on the next backoff tick.

## Why `assignJob` returns immediately (fire-and-forget)

`assignJob()` constructs the `JobExecutor`, kicks off `beginWork()`, adds the `workerId` to `activeWorkers`, and returns without waiting for the job to finish. The actual completion handling — emitting `job:completed`/`job:failed`, removing the worker from `activeWorkers`, clearing the poll timeout, and re-triggering `claimHandler()` — happens in `.then()/.catch()/.finally()` chained onto the execution promise. This is what decouples "how many jobs are running" from "how many jobs the claim loop has looked at" — the loop's only concern is slot availability, not job outcomes.

## Event-driven, not purely timer-driven

`callClaimHandler()` subscribes `claimHandler` to a `'claimNextJob'` event on the `Supervisor` itself (it extends `EventEmitter`). Both the backoff timer *and* a job finishing early emit this same event — so the loop is really "poll again whenever something suggests it's worth polling," not a fixed-interval timer.