# ADR: TTL-based Heartbeat Leases over Explicit Acknowledgment Protocols

## Context

One of the hardest problems in a distributed job queue is determining **whether a worker is still legitimately processing a job or has disappeared**.

The queue cannot simply assume that a claimed job will eventually complete:

- The worker may crash.
- The machine may reboot.
- The process may be SIGKILLed.
- The network connection may disappear.
- The application may deadlock forever.
- The worker may simply stop making progress.

Without some mechanism to detect abandonment, the job remains permanently stuck in `ACTIVE`, making the queue unreliable.

There are two broad approaches:

### 1. Lease-based model

The worker owns a **time-bound lease** on the job.

When claiming a job:

- create `lock:<jobId>`
- assign ownership
- attach a TTL

The worker periodically renews the lease.

If renewal stops, Redis naturally expires the lock.

The absence of the lock becomes the failure signal.

---

### 2. Explicit acknowledgment protocol

Instead of a lease, workers periodically send messages like:

- "I'm alive"
- "Still processing"
- "Finished"

A coordinator records timestamps for every worker/job pair.

If acknowledgments stop arriving before a timeout, the coordinator declares the worker dead and recovers the job.

The coordinator therefore owns:

- timeout tracking
- timestamp storage
- failure detection
- recovery decisions

In other words, the coordinator implements its own lease system.

The fundamental question is therefore:

> Should JiNiQ build and maintain its own timeout system, or simply use Redis' existing expiration mechanism?

---

## Decision

JiNiQ adopts **TTL-based heartbeat leases**.

When a worker claims a job:

- `lock:<jobId>` is created using `PSETEX`
- the lock contains the worker ownership information
- the TTL represents the lease duration

The `HeartBeat` periodically renews the TTL.

Heartbeat interval is approximately:

```
heartbeatInterval = ttl / 3
```

If the worker:

- crashes
- freezes
- loses connectivity
- is terminated

the heartbeat naturally stops.

Redis automatically expires the lock.

The `Sweeper` periodically checks active jobs.

If:

```
ACTIVE
AND
lock missing
```

then the lease has expired.

The job is considered abandoned and is safely recovered.

There is **no second heartbeat table**.

There is **no worker-status registry**.

The lock itself is both:

- mutual exclusion
- ownership
- liveness indicator

One primitive serves all three purposes.

---

## Alternatives considered

### Explicit acknowledgment protocol with coordinator

Instead of using Redis expiration:

```
Worker
   │
"I'm alive"
   │
Coordinator
   │
updates timestamp
```

The coordinator continuously maintains:

```
jobId
lastHeartbeat
workerId
timeout
status
```

A background process periodically scans:

```
if now-lastHeartbeat > timeout
    recover job
```

#### Why rejected

This duplicates functionality Redis already provides.

Redis internally already maintains expiration timers.

Instead of storing:

```
lastHeartbeat
```

JiNiQ simply stores:

```
TTL remaining
```

Instead of writing timeout logic:

```
if now-lastHeartbeat > timeout
```

Redis performs expiration internally.

Instead of maintaining another data structure:

```
Heartbeat Table
```

JiNiQ simply checks:

```
EXISTS lock:<jobId>
```

The explicit protocol therefore adds:

- another coordinator
- another failure detector
- another clock
- another timeout implementation

without providing additional correctness.

It is effectively rebuilding Redis key expiration in application code.

---

### Separate worker heartbeat registry

Another common design is:

```
worker:1 -> alive
worker:2 -> alive
worker:3 -> alive
```

and jobs reference workers.

#### Why rejected

The queue doesn't actually care whether a worker is alive.

It only cares whether **the owner of a specific job still owns its lease.**

A worker may own:

```
Job A
Job B
Job C
```

or

```
none
```

Worker liveness alone cannot determine job ownership.

The lease already contains exactly the information required.

A worker registry introduces another source of truth.

---

### Fire-and-forget execution

Claim job.

Execute.

Eventually call complete.

No heartbeat.

No timeout.

#### Why rejected

A crash leaves:

```
ACTIVE forever
```

The queue has no recovery path.

This violates durability guarantees.

This option was never seriously considered for JiNiQ.

---

### Very long TTL with infrequent renewal

For example:

```
TTL = 90s

Heartbeat every 90s
```

instead of:

```
TTL = 90s

Heartbeat every 30s
```

#### Why rejected

A single delayed renewal becomes catastrophic.

Possible causes include:

- GC pause
- Redis latency spike
- temporary network hiccup
- CPU scheduling delay

If renewal happens once at TTL expiry:

```
miss one renewal

↓

lease expires

↓

job reclaimed
```

even though the worker may still be healthy.

Renewing every:

```
ttl / 3
```

creates two spare opportunities before expiration.

This dramatically reduces accidental lease loss.

---

## Why TTL leases are preferable

### Redis already solves timeout tracking

Redis expiration is implemented internally using optimized expiration algorithms.

Building another timeout manager would duplicate existing infrastructure.

---

### One primitive serves multiple purposes

The lock simultaneously represents:

- ownership
- exclusivity
- liveness
- timeout

Instead of maintaining several synchronized structures.

---

### Failure detection becomes extremely simple

The Sweeper asks only:

```
Does lock exist?
```

instead of:

```
What was the last heartbeat?

Has timeout elapsed?

Which worker owns it?

Has coordinator updated recently?

Did timestamps drift?
```

Less logic means fewer bugs.

---

### Automatic cleanup

Expired keys disappear automatically.

No manual deletion.

No timeout table cleanup.

No stale heartbeat records.

Redis garbage-collects abandoned leases.

---

### Stateless workers

Workers never need to know:

- current timestamps
- coordinator state
- global clocks

They simply renew one key.

---

### Better crash tolerance

If the worker dies abruptly:

```
SIGKILL

OOM

Power loss

Kernel panic

VM terminated
```

heartbeat naturally stops.

No shutdown callback is required.

No graceful exit is assumed.

Recovery still happens.

---

## Common interview questions and counter arguments

### Q1. Why not just store `lastHeartbeat` timestamps?

Because expiration already represents exactly that.

Instead of:

```
lastHeartbeat = 10:00:05

Current = 10:00:40

Timeout = 30s
```

Redis internally maintains:

```
TTL = 25s
```

The timestamp calculation is replaced by native expiration.

Less code.

Less state.

Less room for bugs.

---

### Q2. Isn't checking TTL less flexible?

Not really.

Changing timeout is simply changing the lease duration.

Redis already supports millisecond precision.

The flexibility remains while implementation becomes much simpler.

---

### Q3. What if Redis expires the key a little late?

That is acceptable.

Expiration timing is not required to be perfectly precise.

The Sweeper periodically checks for missing locks.

Correctness depends on:

```
lock exists

or

lock doesn't exist
```

—not on the exact millisecond it disappeared.

---

### Q4. Doesn't heartbeat generate Redis traffic?

Yes.

Every distributed lease system requires periodic renewal.

The question is not whether heartbeats exist.

The question is where timeout logic lives.

JiNiQ keeps timeout management inside Redis rather than implementing another coordinator.

---

### Q5. Why not detect crashed workers immediately?

Immediate detection is impossible in asynchronous distributed systems.

A machine that appears silent may simply be:

- paused
- GC stalled
- temporarily partitioned
- network delayed

Every failure detector eventually relies on waiting for some timeout.

TTL is simply that timeout.

---

### Q6. Why not have the coordinator monitor worker TCP connections?

TCP disconnects do not detect many real failures:

- frozen process
- deadlock
- event-loop blockage
- CPU starvation

The socket may remain open while the worker is no longer making progress.

Heartbeat proves useful work is still being performed.

---

### Q7. Isn't Redis now a single point of failure?

JiNiQ already relies on Redis for:

- job storage
- queue ordering
- atomic Lua execution
- locks

Lease expiration does not introduce a new dependency.

It reuses the existing one.

---

### Q8. Could another worker steal a job while the original worker is still running?

Yes.

This can happen if the original worker loses its lease due to prolonged pauses or partitions.

JiNiQ intentionally handles this using `AbortController`.

Once lease ownership is lost:

- the old worker aborts
- another worker safely continues

Ownership always follows the lease.

---

### Q9. Why not renew exactly at TTL expiry?

Because distributed systems are unpredictable.

A renewal scheduled exactly at expiration has zero safety margin.

Renewing every `ttl / 3` provides multiple opportunities before expiry and tolerates transient delays.

---

### Q10. Isn't this eventually consistent?

Yes.

Failure detection is intentionally eventual.

The maximum recovery delay is approximately:

```
ttl + sweeperInterval
```

JiNiQ prioritizes correctness over aggressive failure detection.

Premature recovery is far more dangerous than slightly delayed recovery.

---

## Consequences

### Advantages

- Redis performs timeout tracking natively.
- No coordinator process is required.
- No heartbeat timestamp table exists.
- Lock ownership and liveness remain a single source of truth.
- Crash recovery works even after abrupt process termination.
- Implementation is significantly simpler than coordinator-based protocols.
- Automatic cleanup of expired leases reduces operational complexity.
- Stateless workers only renew leases and never maintain timeout metadata.

### Trade-offs

- Failure detection is not instantaneous.
- Recovery latency is bounded by:

```
ttl + sweeperInterval
```

- Heartbeats introduce periodic Redis writes.
- Lease duration must be tuned carefully:
  - too short → higher false-positive risk during transient pauses.
  - too long → slower recovery of abandoned jobs.
- A worker that loses its lease must immediately stop processing (`AbortController`) to prevent duplicate execution.
- Temporary GC pauses or network hiccups can still cause lease expiration if they exceed the configured TTL, so TTL selection is an important operational parameter.
```