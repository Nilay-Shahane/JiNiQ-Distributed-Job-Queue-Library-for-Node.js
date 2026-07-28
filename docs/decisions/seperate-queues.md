# ADR: Separate Redis Data Structures per Queue State Instead of One Global Job Store with Status Fields

## Context

One of the earliest architectural decisions in a distributed job queue is **how jobs are represented throughout their lifecycle**.

A straightforward implementation is to store every job inside one large Redis Hash (or similar structure), where each job contains a `status` field.

Example:

```text
job:123
{
    status: "waiting",
    priority: 10,
    delayUntil: ...,
    retries: ...
}

job:124
{
    status: "active",
    ...
}

job:125
{
    status: "completed",
    ...
}
```

Every scheduler, worker, sweeper, or monitoring component would then search through this global collection looking for jobs matching a particular status.

JiNiQ instead separates jobs into dedicated Redis structures, where each queue represents exactly one lifecycle state.

Example:

```text
waiting
priority
active
delay
completed
dead
```

Jobs physically move between these structures as their state changes.

---

## Decision

JiNiQ stores queue states in separate Redis data structures rather than maintaining one large collection with a mutable `status` field.

Each state has a dedicated responsibility.

| Queue | Responsibility |
|---------|---------------|
| waiting | FIFO jobs ready to execute |
| priority | Priority scheduling |
| active | Currently leased jobs |
| delay | Future jobs waiting for activation |
| completed | Successfully finished jobs |
| dead | Permanently failed jobs |

The actual job payload exists once, while queue structures primarily maintain scheduling metadata and ownership.

---

# Why not one global job store?

At first glance, a single data structure appears simpler.

```
jobs
 ├── job1 (status=waiting)
 ├── job2 (status=waiting)
 ├── job3 (status=active)
 ├── job4 (status=completed)
 ├── job5 (status=dead)
```

Workers would simply search for:

```
status == waiting
```

Unfortunately, this simplicity disappears as the queue grows.

---

## Problem 1 — Scheduling becomes filtering

With one global structure, every scheduler needs to answer questions like:

```
Find the highest priority waiting job
```

or

```
Find waiting jobs whose delay expired
```

or

```
Find jobs that are active but whose lease expired
```

These become filtering operations over a mixed dataset.

The scheduler spends time identifying eligible jobs instead of immediately retrieving them.

Separate queues eliminate filtering entirely.

The scheduler already knows where eligible jobs live.

```
Waiting Queue
↓

Pop next job
```

No scanning.

No searching.

No filtering.

---

## Problem 2 — Different states require different algorithms

Not every queue behaves the same.

Waiting jobs need FIFO ordering.

Priority jobs need score ordering.

Delayed jobs need time ordering.

Completed jobs need archival.

Dead jobs need diagnostics.

Trying to represent every state inside one generic collection forces one structure to serve many unrelated purposes.

Instead, JiNiQ chooses the data structure most appropriate for each responsibility.

For example,

```
waiting  → FIFO list
priority → Sorted Set
delay    → Sorted Set
active   → Hash / Set
completed→ Archive
dead     → Archive
```

Each queue is optimized for its workload instead of compromising for every workload.

---

## Problem 3 — Recovery becomes complicated

Imagine a worker crashes.

The sweeper must recover expired jobs.

With one global structure:

```
Find every job
↓

Filter active

↓

Check lease

↓

Recover
```

Recovery cost increases with total job count.

With separate queues:

```
Look only at active queue
↓

Recover expired leases
```

Only active jobs participate.

Recovery work scales with currently running jobs rather than historical jobs.

---

## Problem 4 — Different lifecycles need different retention

Completed jobs might be deleted after one hour.

Dead jobs may stay for days.

Delayed jobs expire naturally.

Waiting jobs should never expire.

One global structure mixes every retention policy together.

Separate queues allow independent cleanup.

For example,

```
Delete completed

without touching

dead jobs
```

Each lifecycle is managed independently.

---

## Problem 5 — Operational visibility becomes clearer

Operators often ask:

```
How many waiting jobs?

How many active jobs?

How many dead jobs?

How many delayed jobs?
```

With one global structure,

these become aggregation queries.

With separate queues,

queue size directly represents system state.

Monitoring becomes inexpensive and intuitive.

---

## Problem 6 — Components become naturally isolated

Different JiNiQ components interact with different queues.

Worker:

```
waiting
priority
active
```

Sweeper:

```
active
delay
```

Dashboard:

```
completed
dead
waiting
```

No component needs awareness of every job in the system.

Responsibilities remain localized.

---

# Why separate queues scale better

Suppose a production system contains

```
20 million completed jobs

50,000 waiting jobs

8,000 active jobs

700 dead jobs
```

A scheduler only needs

```
50,000 waiting jobs
```

A sweeper only needs

```
8,000 active jobs
```

Completed history never slows scheduling.

Historical data remains isolated from live traffic.

---

# Why not simply index the status field?

A common suggestion is:

> "Why not create an index on status?"

Indexes certainly improve lookup performance.

However, they do not remove the architectural coupling.

You still have one logical collection trying to satisfy fundamentally different access patterns.

Priority scheduling, delayed execution, lease recovery, cleanup, monitoring, retries, and archival all continue sharing the same storage model.

Separate queues express those responsibilities explicitly instead of relying on increasingly complex indexing logic.

---

# Consequences

## Positive

- Scheduling operates directly on runnable jobs instead of filtering a global collection.
- Each queue can use the Redis data structure best suited to its access pattern.
- Recovery touches only active jobs, making crash recovery proportional to running work rather than total history.
- Monitoring is simpler because queue sizes directly reflect system state.
- Cleanup policies can differ across completed, delayed, and dead jobs without affecting live traffic.
- Individual queue implementations can evolve independently as requirements change.
- Historical jobs do not interfere with scheduling performance.

---

## Negative

- Jobs transition between multiple Redis structures during their lifecycle.
- More Redis keys must be managed.
- State transitions require careful atomic movement between queues.
- Debugging requires understanding the complete lifecycle rather than inspecting a single collection.
- Maintaining consistency across queues requires atomic operations (implemented via Lua scripts in JiNiQ).

---

# Common Questions

### Why not store everything in one Hash and filter by status?

Because scheduling should retrieve runnable jobs directly, not repeatedly search a mixed collection. Filtering work grows with dataset size, while dedicated queues always expose only relevant jobs.

---

### Doesn't moving jobs between queues add overhead?

Yes, but each transition is a small atomic operation. In return, scheduling, recovery, monitoring, and cleanup remain fast and predictable throughout the job lifecycle.

---

### Why not maintain one collection with secondary indexes?

Secondary indexes improve lookup performance but do not eliminate the complexity of supporting multiple unrelated access patterns in one logical model. Separate queues align the storage layout with each lifecycle responsibility.

---

### Why have both `waiting` and `priority` instead of one queue?

Priority scheduling requires ordered access by score, whereas normal jobs require FIFO ordering. Separate queues allow each to use the most appropriate data structure without compromising the other.

---

### Why separate `completed` and `dead`?

They represent different operational outcomes. Completed jobs are useful for auditing and short-term history, while dead jobs require investigation, retries, or alerting. Independent queues allow different retention and operational policies.

---

### Doesn't this create more Redis keys?

Yes, but Redis is designed to manage large numbers of lightweight keys efficiently. The additional keys improve clarity, isolation, and operational performance.

---

### How does this help crash recovery?

The recovery process only inspects the `active` queue, where leased jobs reside. It does not waste time examining waiting, completed, or dead jobs that are irrelevant to recovery.

---

### What happens if a queue becomes very large?

Each queue scales independently. A large completed archive does not affect scheduling latency, and a large waiting queue does not slow monitoring of completed or dead jobs. This isolation prevents one workload from degrading another.