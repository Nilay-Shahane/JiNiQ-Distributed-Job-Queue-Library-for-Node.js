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

while simultaneously keeping the