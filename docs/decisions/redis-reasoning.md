# ADR: Redis as the Queue State Engine over Traditional Databases

## Context

JiNiQ is a distributed Redis-backed job queue designed to handle:

- Waiting jobs
- Priority jobs
- Delayed jobs
- Active jobs
- Completed jobs
- Failed / dead jobs
- Worker ownership locks
- Heartbeat leases
- Job lifecycle transitions

The queue requires a storage system that can provide:

- Very low latency job operations
- Atomic state transitions
- High throughput under heavy enqueue/dequeue workloads
- Efficient priority scheduling
- Distributed worker coordination
- Fast recovery after worker crashes
- Temporary state management with TTLs
- Horizontal scalability

Possible storage choices:

1. Traditional relational databases (PostgreSQL / MySQL)
2. Document databases (MongoDB)
3. Message brokers (RabbitMQ / Kafka)
4. Redis

The decision is whether JiNiQ should use a general-purpose database as the source of truth for queue state or use Redis-native data structures.

---

## Decision

Use Redis as the primary storage engine for JiNiQ queue state.

Redis is used because queue systems require **fast mutable state management**, not just durable data storage.

JiNiQ uses Redis capabilities:

- Lists / Streams for queue ordering
- Sorted Sets for priority and delayed jobs
- Hashes for job metadata
- Strings for distributed locks
- TTL-based expiration for heartbeat leases
- Lua scripts for atomic state transitions

Redis becomes the coordination layer between producers and workers.

---

## Why Redis over PostgreSQL / MySQL?

**User Question:** "Why not store jobs in a relational database? Databases provide durability and consistency."

**Answer:**

Relational databases are optimized for:

- Complex queries
- Relationships
- Long-lived business data
- Transactions across multiple entities

A queue requires:

- Millions of small writes
- Constant state transitions
- Fast polling
- Temporary ownership information
- Frequent updates

A job lifecycle can look like:

```
WAITING
  |
  v
ACTIVE
  |
  +----> COMPLETED
  |
  +----> FAILED
  |
  v
RETRY
```

Every transition requires updates:

```
Update job status
Acquire/release lock
Update heartbeat
Move between queues
Update retry count
```

Doing this using SQL rows creates:

- Heavy index updates
- Row locking contention
- Frequent disk writes
- Expensive scans for available jobs

Example — finding the next available job:

```sql
SELECT *
FROM jobs
WHERE status='WAITING'
ORDER BY priority DESC, created_at
LIMIT 1;
```

At high scale this requires:

- Index maintenance
- Row locking
- Transaction coordination

Redis performs the same operation using optimized in-memory structures.

---

## Why Redis over MongoDB?

**User Question:** "MongoDB is flexible and can store job documents. Why not use it?"

**Answer:**

MongoDB is good for:

- Document storage
- Flexible schemas
- Application data

However, queue scheduling requires:

- Ordered retrieval
- Atomic claiming
- Frequent mutations

A MongoDB document update:

```
job.status = ACTIVE
job.workerId = worker123
job.lockExpiry = timestamp
```

requires document updates and concurrency handling.

Redis provides these operations directly:

```
ZPOPMAX priority_queue
SET lock jobId NX EX 30
HSET job metadata
```

The operations map naturally to queue behavior.

---

## Why Redis over Kafka?

**User Question:** "Kafka handles huge throughput. Why not use Kafka as the queue backend?"

**Answer:**

Kafka is designed for:

- Event streaming
- Append-only logs
- Data pipelines
- Replayable events

A job queue requires:

- Removing claimed jobs
- Dynamic priorities
- Delayed execution
- Lock ownership
- Retry management

Kafka does not naturally support:

- Priority queues
- Delayed jobs
- Expiring ownership locks
- Removing individual messages

Example — a delayed job ("Run email job after 10 minutes"):

Redis:

```
ZADD delayed_queue timestamp jobId
```

Worker checks:

```
ZRANGEBYSCORE delayed_queue 0 currentTime
```

Kafka would require additional scheduling infrastructure.

---

## Why Redis over RabbitMQ?

**User Question:** "RabbitMQ is already a message queue. Why build JiNiQ on Redis?"

**Answer:**

RabbitMQ provides:

- Message delivery
- Routing
- Acknowledgment

JiNiQ requires more control over:

- Priority scheduling
- Custom retry policies
- Delayed jobs
- Worker leases
- Queue state inspection
- Custom lifecycle management

Redis allows JiNiQ to build queue primitives directly.

Instead of:

```
Producer
   |
RabbitMQ
   |
Consumer
```

JiNiQ manages:

```
Producer
   |
Redis State Machine
   |
Supervisor
   |
Workers
```

This gives full control over scheduling decisions.

---

## Redis Data Structures Mapping

### Waiting Queue

**Requirement:** FIFO job processing.

**Redis:** `LIST`

**Operations:** `LPUSH`, `RPOP`

**Complexity:** O(1)

### Priority Queue

**Requirement:** Higher priority jobs execute first.

**Redis:** `SORTED SET`

Example — `priority_queue`:

```
jobA -> score 10
jobB -> score 50
jobC -> score 20
```

Highest score executes first.

**Benefits:**

- Dynamic priority updates
- Ordered retrieval
- Range queries

**Complexity:** O(log N)

### Delayed Jobs

**Requirement:** Execute jobs after a timestamp.

**Redis:** `SORTED SET`

Example — `delayed_queue`:

```
job1 -> 1730000000
```

Worker moves expired jobs to waiting queue.

**Advantages:**

- Survives worker restart
- No millions of timers
- Distributed scheduling

### Active Jobs

**Requirement:** Track currently executing jobs.

**Redis:** `HASH`

Stores:

```
jobId:
{
  workerId,
  startedAt,
  heartbeat
}
```

### Worker Locks

**Requirement:** Only one worker owns a job.

**Redis:** `SET key value NX EX ttl`

Provides:

- Atomic acquisition
- Expiration
- Crash recovery

---

## Atomicity Requirement

**User Question:** "Why not handle concurrency inside application memory?"

**Answer:**

Multiple workers can run on different servers.

```
Worker A
    |
    |
 Redis

Worker B
    |
    |
 Redis
```

Application memory cannot coordinate between machines.

Redis provides:

- Shared state
- Atomic commands
- Lua scripting

Example — claim job operation:

```
Check job exists
Remove from waiting queue
Add to active queue
Create lock
```

must happen atomically.

Redis Lua script executes all operations as one transaction.

---

## Consequences

### Positive Consequences

**1. Low Latency**

Queue operations happen in memory.

Typical operations (enqueue, dequeue, lock acquire, heartbeat update) complete in microseconds to milliseconds.

**2. Natural Queue Primitives**

Redis structures directly represent queue concepts:

```
LIST       -> FIFO queue
ZSET       -> Priority / Delay queue
HASH       -> Metadata
STRING     -> Locks
TTL        -> Lease expiration
```

Less custom infrastructure is required.

**3. Better Distributed Coordination**

Multiple workers can safely coordinate through Redis.

Supports:

- Horizontal scaling
- Worker recovery
- Lock ownership
- Leaderless execution

**4. Efficient Scheduling**

Priority and delayed jobs do not require expensive database queries.

Redis performs ordered retrieval using sorted structures.

**5. Operational Visibility**

Queue state can be inspected directly:

- Waiting jobs
- Active jobs
- Failed jobs
- Delayed jobs
- Worker locks

### Negative Consequences

**1. Memory Requirement**

Redis stores active queue state in RAM.

Large queues require:

- Memory planning
- Eviction configuration
- Persistence strategy

**2. Durability Tradeoff**

Redis is not primarily a long-term database.

JiNiQ must configure:

- AOF persistence
- Snapshots
- Backup strategy

**3. Additional Responsibility**

Using Redis as a queue engine means JiNiQ owns:

- Retry handling
- Scheduling
- Recovery logic
- State transitions

Unlike managed message brokers, these features are implemented by JiNiQ.

**4. Operational Dependency**

Redis becomes a critical component.

Failure handling requires:

- Redis replication
- Monitoring
- Recovery procedures

---

## Alternatives Considered

| Storage | Why Not Selected |
|---|---|
| PostgreSQL | Strong durability but slower for high-frequency queue mutations |
| MySQL | Similar limitations; locking overhead under heavy concurrency |
| MongoDB | Flexible storage but weaker fit for ordered scheduling |
| Kafka | Excellent event streaming but not designed for job lifecycle management |
| RabbitMQ | Good messaging system but less flexible for custom scheduling state |

---

## Final Rationale

JiNiQ is not primarily storing business data; it is managing rapidly changing distributed execution state.

Redis provides the required primitives:

- Fast queue operations
- Atomic state transitions
- Distributed locks
- TTL-based recovery
- Priority scheduling
- Delayed execution

Therefore Redis is chosen as the queue state engine because its data structures align directly with JiNiQ's distributed job execution model.