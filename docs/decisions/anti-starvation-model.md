# ADR: Two-Queue Anti-Starvation Scheduling over Strict Priority Queues

## Context

In a job queue that supports priority levels (e.g., "high" vs. "normal"), a common problem is **starvation**.

If the system processes jobs using a strict priority model (always execute high-priority jobs before any normal jobs), a continuous influx of high-priority jobs will cause normal-priority jobs to sit in the queue forever. They will "starve."

There are a few ways to solve this:

1. **Strict Priority:** Accept starvation as a feature. High priority always wins.
2. **Single ZSET with Aging:** Put all jobs in one Redis Sorted Set. Calculate a complex score based on priority level and submission time, periodically updating older jobs so their score increases over time.
3. **The Offset Model (Two Queues):** Keep priority and normal jobs in separate queues, score them purely by submission timestamp, and subtract an "offset" from priority jobs to give them a head start.

## Decision

JiNiQ uses the **Two-Queue Offset Model**.

We maintain two distinct Sorted Sets (`ZSET`):

* `jiniq:<queue>:normal`
* `jiniq:<queue>:priority`

Both queues score jobs using their exact submission timestamp (`Date.now()`). However, when a priority job is inserted, JiNiQ subtracts a configurable `priorityOffset` (default: 10,000 ms) from its timestamp.

At claim time, the `claimNextJob` Lua script peeks at the oldest job in both queues and asks:
`if (priorityScore <= normalScore) then claim Priority else claim Normal`

## Alternatives considered

### Strict Priority (One Queue per Tier)

Always drain the `priority` queue completely before looking at the `normal` queue.

* **Why rejected:** It provides zero guarantees for normal jobs. A sudden spike in priority traffic would effectively halt all normal background processing, breaking SLAs and causing silent system failures.

### Single ZSET with Complex Math

Assign priorities as integers (High = 1, Normal = 10) and combine them with timestamps: `Score = (Priority * 10000000000) + Timestamp`.

* **Why rejected:** This is just Strict Priority in disguise. The priority multiplier dominates the timestamp, meaning a new high-priority job will always have a lower score than a 5-day-old normal job. Starvation still occurs.

### Periodic Score Updates (Cron-based Aging)

Run a background script every minute that decreases the score of old normal jobs so they eventually "bubble up" to priority status.

* **Why rejected:** Highly inefficient. It requires continuous `ZSCAN` and `ZADD` operations across potentially millions of waiting jobs, wasting CPU and Redis I/O.

## Consequences

### Positive

* **Provable Fairness:** A priority job gets exactly `priorityOffset` milliseconds of a head start. If a normal job has been waiting longer than that offset, it is mathematically guaranteed to beat a freshly submitted priority job. Starvation is impossible.
* **Zero Maintenance Overhead:** Scores are calculated exactly once at insertion time. No background aging scripts are required.
* **Tunable:** Developers can configure `priorityOffset` per queue to decide exactly how aggressive priority jumping should be.

### Negative

* **Claim-Time Complexity:** The Lua script has to read from two ZSETs and compare them on every poll cycle, which is slightly more expensive than popping from a single list.