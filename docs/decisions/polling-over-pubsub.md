# ADR: Polling (with Adaptive Backoff) as the Source of Truth

## Context

One of the most important architectural decisions in a distributed job queue is **how idle workers discover new work**.

There are two common approaches:

1. **Worker-driven polling**
   - Workers periodically ask Redis whether a job is available.
   - If a job exists, they atomically claim it.

2. **Producer-driven notifications**
   - Whenever a producer inserts a new job, it publishes a message (typically using Redis Pub/Sub).
   - Idle workers wake immediately and attempt a claim.

At first glance, the second approach appears superior because it removes almost all idle latency. A worker can remain asleep indefinitely and wake only when new work arrives.

JiNiQ deliberately does **not** make notifications part of the correctness path.

Today, producers simply insert jobs into Redis. They do **not** publish notifications, and workers never wait on Pub/Sub messages before attempting a claim.

Instead, every `Supervisor` independently executes an adaptive polling loop:

- Begin polling every **50 ms**
- Continue claiming until either:
  - no work exists, or
  - all worker slots are full
- If no work exists:
  - exponentially increase the polling interval
  - cap the delay at **2000 ms**
- Whenever work is found again:
  - immediately reset polling back to **50 ms**

This makes Redis itself—not notifications—the only source of truth for job discovery.

---

## Decision

JiNiQ uses **adaptive polling as the only mechanism that guarantees job discovery**.

Every worker periodically asks Redis whether work exists by executing the atomic Lua claim script.

No notification is required for a worker to discover work.

This decision intentionally prioritizes:

- liveness
- eventual job execution
- failure tolerance
- deterministic recovery

over achieving the absolute minimum idle latency.

Notifications (Redis Pub/Sub) are intentionally treated as a future optimization rather than part of the correctness model.

---

## Alternatives considered

### Alternative 1 — Pure Pub/Sub-driven claiming

The most obvious alternative is:

```
Producer
    │
Add Job
    │
PUBLISH notify
    │
Workers wake immediately
    │
Claim until queue empty
    │
Sleep until next notification
```

This has an obvious benefit:

- almost zero idle latency
- no unnecessary polling
- workers remain asleep when queues are empty

Unfortunately, this architecture has a fundamental correctness problem.

Redis Pub/Sub provides **at-most-once delivery**.

Messages are:

- not persisted
- not acknowledged
- not replayed
- delivered only to clients currently subscribed

If a notification is missed for any reason, Redis never attempts delivery again.

For example:

```
Worker disconnects

↓

Producer inserts Job A

↓

PUBLISH notify

↓

No subscribers receive message

↓

Worker reconnects

↓

Queue contains Job A

↓

No further notifications occur

↓

Worker sleeps forever
```

The job still exists inside Redis.

The queue is healthy.

Nothing is corrupted.

Yet no worker ever attempts another claim.

The system has lost its **liveness guarantee** because discovering work depends entirely on a transient notification that no longer exists.

This violates one of JiNiQ's primary design goals:

> Every successfully inserted job should eventually execute, regardless of temporary network failures or worker restarts.

---

### Alternative 2 — Publish notifications continuously

Another possible design is:

```
Producer

Every insert

↓

PUBLISH notify
```

This still suffers from exactly the same failure mode.

The issue is not whether producers publish frequently.

The issue is:

> What happens if **one** notification is lost?

Once a notification disappears, no future event necessarily wakes sleeping workers.

The queue can remain permanently idle despite containing executable jobs.

---

### Alternative 3 — Worker sleeps forever after draining queue

An interviewer may suggest:

> "Workers can simply keep claiming until the queue becomes empty, then block waiting for the next notification."

This appears attractive because workers avoid unnecessary polling.

However, this simply shifts the dependency onto Pub/Sub.

Consider a startup race:

```
Worker starting

↓

Connecting to Redis

↓

Producer inserts Job

↓

Notification published

↓

Worker finishes startup

↓

Subscribes

↓

Waits forever
```

The notification occurred before the subscription existed.

Redis does not replay missed messages.

Polling immediately recovers from this situation.

Pure Pub/Sub does not.

---

### Alternative 4 — Hybrid model (Recommended Future Direction)

The strongest alternative combines both mechanisms:

```
Producer

↓

Insert Job

↓

PUBLISH notify

↓

Workers immediately execute claimHandler()
```

while simultaneously keeping the adaptive polling loop active in the background.

In this design, Pub/Sub is **not responsible for correctness**.

Instead, it acts purely as a latency optimization.

Whenever a notification is received, workers perform an immediate out-of-cycle claim attempt rather than waiting for the next scheduled polling interval.

If the notification is lost, nothing breaks.

The normal polling loop eventually discovers the waiting job exactly as it does today.

This gives the best characteristics of both approaches:

- Near-instant wake-up latency during normal operation.
- Guaranteed eventual job discovery even if notifications are lost.
- No dependence on Redis Pub/Sub reliability.
- No change to the correctness model.

This is the direction JiNiQ would likely evolve toward if reducing cold-start latency becomes a priority, but it is intentionally deferred because it increases architectural complexity while providing only a performance optimization—not additional correctness.

---

## Benefits

### Redis remains the single source of truth

Workers always discover work by inspecting Redis itself rather than trusting transient messages.

This means the actual queue state determines scheduling—not whether a notification happened to arrive.

---

### Strong liveness guarantees

Every successfully inserted job is eventually discovered.

Temporary failures such as:

- worker restarts
- network interruptions
- missed subscriptions
- producer restarts

cannot permanently strand jobs inside the waiting queue.

Eventually a polling worker observes the queue state and claims the job.

---

### Simpler architecture

Workers have exactly one authoritative scheduling mechanism:

```
Timer

↓

claimHandler()

↓

Atomic Lua Claim Script
```

There is no need to coordinate between multiple independent wake-up mechanisms, handle duplicate notifications, or reason about races between timers and Pub/Sub callbacks.

This simplicity makes the system easier to reason about and easier to debug.

---

### Adaptive resource usage

Polling is intentionally adaptive.

During heavy workloads:

- workers remain at the minimum polling interval
- queues are drained aggressively
- throughput remains high

During idle periods:

- polling frequency decreases automatically
- unnecessary Redis reads are significantly reduced
- idle CPU and Redis usage remain low

The system naturally adapts to workload intensity without requiring external coordination.

---

### Failure recovery is automatic

Because workers continuously reconcile against Redis state, recovery requires no special logic.

If a worker crashes, disconnects, or restarts, it simply resumes polling after reconnecting.

There is no need to replay notifications or reconstruct missed wake-up events.

---

### Producer remains intentionally simple

The producer has a single responsibility:

```
Validate job

↓

Atomically insert job

↓

Return
```

It does not need to know:

- how many workers exist
- whether workers are subscribed
- whether notifications were delivered
- whether any worker is currently alive

This keeps producers stateless and decoupled from worker scheduling.

---

## Consequences

### Increased idle-to-first-job latency

The primary trade-off is cold-start latency.

If a worker has reached the maximum polling interval (2000 ms), a newly inserted job may wait until the next scheduled polling cycle before being claimed.

For continuously busy workloads this rarely occurs because successful claims immediately reset polling back to 50 ms.

---

### Additional Redis reads during idle periods

Polling inevitably generates Redis requests even when no work exists.

Adaptive backoff significantly reduces this overhead, but it cannot eliminate it entirely.

This is an intentional trade-off made in exchange for deterministic job discovery.

---

### Lower latency is possible

A hybrid Pub/Sub + polling model would reduce cold-start latency further.

JiNiQ intentionally leaves this optimization for a future iteration because it improves performance but does not improve correctness.

---

### Slightly slower than notification-first systems

Some queue systems can react almost immediately to new work because they rely heavily on notifications.

JiNiQ accepts a small latency penalty in exchange for stronger failure tolerance and simpler correctness guarantees.

---

## Common Counter Questions

### "Polling seems inefficient. Why not just use Pub/Sub?"

Polling is the correctness mechanism.

Pub/Sub is only a notification mechanism.

Redis Pub/Sub provides **at-most-once delivery**, meaning notifications can be permanently lost.

If correctness depends on those notifications, the queue loses its liveness guarantee.

Polling ensures workers eventually reconcile with Redis itself, regardless of notification delivery.

---

### "What if the producer publishes every single job?"

That improves latency but not correctness.

The critical question is not:

> "Did the producer publish?"

The critical question is:

> "What happens if exactly one notification is lost?"

If the answer is "the job waits forever," then the architecture is fundamentally unreliable.

---

### "Workers could keep claiming until the queue is empty, then sleep forever."

This works only if every notification is delivered.

A worker that disconnects briefly, starts after the notification was published, or misses a notification due to a network partition has no mechanism to discover already-waiting jobs.

Polling periodically reconciles worker state with queue state, eliminating this failure mode.

---

### "Why not use Redis Streams instead?"

Redis Streams provide durable delivery, acknowledgements, and consumer groups.

However, JiNiQ's scheduler is built around atomic Lua transitions across multiple Redis structures (priority queues, delayed queues, retries, active queue, locks, etc.).

Migrating scheduling onto Streams would require significant architectural changes and additional indexing while providing capabilities JiNiQ already implements independently.

For JiNiQ's scheduling model, Sorted Sets plus Lua scripts remain a better fit.

---

### "Wouldn't BLPOP solve this?"

No.

`BLPOP` only works for Redis Lists.

JiNiQ schedules jobs using multiple Sorted Sets because it supports:

- priorities
- delayed jobs
- retries
- starvation prevention

Choosing the next executable job requires evaluating several queues atomically.

That decision is implemented as a Lua script, which `BLPOP` cannot express.

---

### "What happens if ten workers poll simultaneously?"

Nothing incorrect happens.

Every worker executes the same atomic Lua claim script.

Redis executes Lua scripts serially.

Only one worker can successfully transition a particular job from WAITING to ACTIVE.

The remaining workers simply receive no job and back off.

Race conditions become harmless because arbitration happens inside Redis.

---

### "Is polling expensive with hundreds of workers?"

Adaptive backoff keeps idle load manageable.

Workers that repeatedly find no work gradually reduce their polling frequency up to the configured maximum interval.

Busy queues naturally maintain short polling intervals, while idle queues generate very little Redis traffic.

The polling rate automatically follows workload intensity.

---

### "Why don't producers publish notifications today?"

Because notifications would only optimize latency.

They would **not** improve correctness.

Polling must remain regardless because missed notifications are unavoidable.

Until lower cold-start latency becomes a demonstrated requirement, JiNiQ intentionally favors a simpler architecture with fewer moving parts.

---

### "So is Pub/Sub a bad idea?"

Not at all.

Pub/Sub is an excellent optimization.

It simply should not become the mechanism that guarantees work discovery.

The recommended production architecture is:

```
Pub/Sub
      │
      ▼
Immediate claim attempt

        +

Adaptive polling
      │
      ▼
Guaranteed eventual discovery
```

In this model:

- Pub/Sub minimizes latency.
- Polling guarantees correctness.

The loss of a notification only delays execution—it never prevents it.

---

## Summary

The key architectural principle behind JiNiQ is:

> **Correctness is derived from durable queue state, not transient notifications.**

Polling periodically reconciles worker state with Redis, guaranteeing that every waiting job is eventually discovered.

Pub/Sub is valuable as a latency optimization, but because Redis Pub/Sub offers at-most-once delivery with no persistence or replay, it is intentionally excluded from the correctness path.

JiNiQ therefore accepts a small amount of additional idle latency in exchange for stronger liveness guarantees, deterministic recovery, and a significantly simpler failure model.