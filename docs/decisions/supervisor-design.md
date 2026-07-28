# ADR: One `Supervisor` polling loop per worker, not one poller per slot

## Context

A worker needs to execute up to `maxConcurrency` jobs concurrently. There are two common ways to structure this:

1. A single orchestrator that polls Redis, claims jobs, tracks currently running work, and dispatches new jobs whenever execution capacity becomes available.
2. `maxConcurrency` independent "lanes," where each lane owns one execution slot, continuously polling Redis, claiming one job, executing it, and then polling again for the next.

Both approaches can achieve the same maximum throughput in theory, but they differ significantly in Redis traffic, scheduling complexity, slot utilization, observability, and maintainability.

The question is not *whether multiple jobs can execute concurrently*—both designs support that—but *who should be responsible for deciding when new work is claimed.*

## Decision

JiNiQ uses a single `Supervisor` instance per `Worker`.

The `Supervisor` owns:

- one adaptive polling loop
- one `activeWorkers` set
- all concurrency bookkeeping
- all scheduling decisions

Whenever capacity exists (`activeWorkers.size < maxConcurrency`), the `Supervisor` enters a `while (hasSlot())` loop and repeatedly attempts to claim work from Redis.

Each successfully claimed job is immediately handed to a `JobExecutor` without waiting for previous jobs to complete. The `Supervisor` continues claiming until either:

- no execution slots remain, or
- Redis reports that no jobs are available.

When a job finishes, its `.finally()` handler removes it from `activeWorkers` and immediately triggers another claim cycle, allowing the freed slot to be refilled without waiting for the next polling interval.

The `Supervisor` itself never executes user code—it only schedules work.

## Alternatives considered

### N independent lane pollers

Each execution slot owns its own lifecycle:

```
poll → claim → execute → repeat
```

This is conceptually simple because every lane behaves like a miniature worker.

However, this design was rejected for several reasons.

#### Uneven slot utilization

Consider:

```
maxConcurrency = 4

Job A = 10 seconds
Job B = 200 ms
Job C = 200 ms
Job D = 200 ms
```

Initially all four lanes receive work.

After 200 ms:

- Lane 1 is still executing Job A.
- Lanes 2–4 have finished.

Those lanes cannot immediately receive more work unless each lane independently wakes up and polls Redis again.

During this idle period, available worker capacity exists but remains unused.

In JiNiQ, completion of any job immediately triggers another claim cycle, allowing the freed slot to be reused almost instantly instead of waiting for a polling timer.

---

#### Poll traffic scales with concurrency

Each lane owns:

- its own polling timer
- its own adaptive backoff
- its own retry logic
- its own wake-up logic

As concurrency increases, Redis receives proportionally more polling requests.

For example:

```
maxConcurrency = 100
```

Lane architecture:

```
100 poll loops
↓

100 Redis claim attempts
```

JiNiQ:

```
1 poll loop

↓

claim until worker is full
```

The amount of useful work remains identical while significantly reducing unnecessary Redis round trips, timers, and duplicated scheduling logic.

---

#### Scheduling logic becomes duplicated

Each lane must independently implement:

- polling
- adaptive backoff
- retry handling
- shutdown coordination
- Redis error handling
- wake-up logic

The scheduling algorithm becomes duplicated across every execution slot.

JiNiQ centralizes this responsibility inside one component, reducing implementation complexity and ensuring all execution slots follow identical scheduling behavior.

---

#### Harder global scheduling

A lane only knows whether *its own* slot is busy.

It has no awareness of:

- total worker utilization
- overall concurrency
- scheduler state
- global polling behavior

As scheduling policies become more sophisticated (priorities, fairness, quotas, tenant isolation, rate limiting), coordinating many independent schedulers becomes increasingly complex.

A centralized scheduler naturally becomes the single place where these policies can evolve.

---

### A single `Supervisor` that waits for every job

Another possibility is:

```
claim

↓

execute

↓

await completion

↓

claim next
```

Although this uses one polling loop, it effectively limits the worker to executing one job at a time regardless of `maxConcurrency`.

This completely defeats the purpose of configurable concurrency and was rejected.

## Consequences

### High slot utilization

Whenever a job completes, the freed slot is immediately eligible for another claim.

The worker spends far less time with idle execution capacity compared to timer-driven lane polling.

### Lower Redis traffic

Only one scheduler communicates with Redis to discover new work.

Instead of many independent pollers asking the same question simultaneously, one scheduler fills every available slot in a single claim cycle.

This reduces:

- Redis round trips
- timer wake-ups
- unnecessary claim attempts

especially for workers with high concurrency.

### Centralized concurrency bookkeeping

`activeWorkers` becomes the single source of truth for worker state.

The `Supervisor` always knows:

- running job count
- available execution slots
- scheduler activity
- shutdown readiness

No state reconciliation between independent lane objects is required.

### Simpler observability

Because all scheduling decisions pass through one component, metrics become easier to expose.

Examples include:

- current concurrency
- scheduler utilization
- claim latency
- empty poll frequency
- claim failures
- worker idle time

No aggregation across multiple schedulers is necessary.

### Simpler graceful shutdown

Stopping a worker becomes straightforward:

1. Stop accepting new work.
2. Allow active jobs to finish.
3. Exit once `activeWorkers` becomes empty.

With independent lanes, shutdown coordination must occur across every lane individually.

### Future scheduling policies have a single implementation point

Features such as:

- priority scheduling
- fairness improvements
- tenant quotas
- execution throttling
- adaptive polling strategies

can all be implemented inside one scheduler instead of being duplicated across every execution lane.

### The `Supervisor` is not a runtime bottleneck

Although all scheduling passes through the `Supervisor`, it performs very little work.

Its responsibilities are limited to:

- claiming jobs
- constructing `JobExecutor`s
- tracking active executions

Actual job execution occurs asynchronously inside separate `JobExecutor` instances.

The `Supervisor` dispatches work but never performs the work itself.

### Cost: tighter coupling between scheduling and execution

The `Supervisor` directly constructs `JobExecutor` instances.

This couples scheduling with executor creation more tightly than a lane-based abstraction would.

For JiNiQ's current scope, this keeps the implementation considerably simpler.

If future versions support multiple execution backends (for example, sandboxed runtimes, remote executors, or specialized execution engines), introducing an `ExecutorFactory` or similar abstraction would likely become worthwhile.

### Cost: the `Supervisor` becomes the scheduling authority

The scheduler is intentionally responsible for all claim decisions.

This centralization increases the importance of keeping the scheduling loop small, deterministic, and non-blocking.

JiNiQ ensures this by limiting the `Supervisor` to coordination responsibilities only; user job execution always occurs asynchronously outside the scheduler.

## Rationale

The core observation behind this decision is that **execution slots are not independent workers—they are simply available capacity within the same worker process.**

Since scheduling decisions depend on shared state (`maxConcurrency`, currently running jobs, polling state, and Redis availability), centralizing scheduling avoids duplicated coordination logic while improving slot utilization, reducing Redis traffic, simplifying observability, and providing a single foundation for future scheduling policies.

The result is a worker architecture that remains fully concurrent while keeping scheduling deterministic, efficient, and easy to reason about.