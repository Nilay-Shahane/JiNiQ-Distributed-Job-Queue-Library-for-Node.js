# ADR: Piggybacking Delayed Job Migration on the Claim Script

## Context

Jobs can be scheduled to run in the future using the `delay` option. These jobs are stored in the `delay` Redis Sorted Set (ZSET), scored by their scheduled execution timestamp (`runAt`).

When that timestamp arrives, the job needs to be moved from the `delay` queue into the `normal` queue so workers can execute it.

We had to decide **when and how** to perform this migration. The two primary options were:

1. **Dedicated Background Poller:** Run a separate timer (e.g., every 1 second) that executes a distinct Lua script to sweep the `delay` queue and move due jobs to `normal`.
2. **Piggyback on Claim (Inline Lua):** Add the migration logic directly into the existing `claimNextJob` Lua script, so the check happens automatically right before a worker claims a job.

## Decision

JiNiQ uses **Piggybacked Migration inside the `claimNextJob` Lua script**.

Every time a `Supervisor` polls for a new job, the `ClaimNextJob.lua` script executes in three steps:

1. **Migrate:** `ZRANGEBYSCORE delay -inf <now>`. Move any results to the `normal` queue.
2. **Evaluate:** Compare the top of the `priority` queue vs. the `normal` queue (using the anti-starvation offset).
3. **Claim:** Pop the winner and lock it.

## Alternatives considered

### Dedicated Background Poller (Separate Lua Script)

Create a `DelaySweeper` running on a `setInterval` that periodically calls a new `migrateDelayedJobs` Lua script.

* **Why rejected:** It introduces unnecessary artificial latency and Redis traffic. If the poller runs every 5 seconds, a delayed job might sit ready for 4.9 seconds before being promoted. It also requires managing another background timer in the Node.js process, duplicating the traffic pattern of the `Supervisor` claim loop.

### Direct Claiming (No Migration)

Instead of moving due jobs to the `normal` queue, the `claimNextJob` script could just look at three queues (`priority`, `normal`, and `delay`) and pick the winner directly.

* **Why rejected:** It complicates the anti-starvation math. By moving a due delayed job into the `normal` queue and scoring it with the current timestamp, it instantly acts like a freshly submitted normal job. It falls perfectly into the existing priority vs. normal comparison logic without requiring a massive, complex three-way `if/else` block inside Lua.

## Consequences

### Positive

* **Zero Extra Redis Traffic:** Migration costs zero additional network round-trips. It leverages the continuous polling traffic the workers are already generating.
* **Lowest Possible Latency:** A delayed job is promoted at the exact millisecond a worker is ready to take it (Just-In-Time promotion).
* **Fewer Moving Parts:** No extra timers or background loops to manage, start, or stop in the Node.js application.

### Negative

* **Slight Overhead on Every Claim:** Even if you never use delayed jobs, every single `claimNextJob` execution performs a fast `ZRANGEBYSCORE` check on the delay queue. (However, since Redis executes this in sub-microseconds on an empty ZSET, the cost is negligible).
* **Dependent on Worker Liveness:** If a queue has exactly zero workers running, delayed jobs will sit in the `delay` ZSET past their `runAt` time and won't be moved to the `normal` queue until a worker boots up and polls. (This is generally acceptable, as an empty worker pool means the job couldn't be executed anyway).