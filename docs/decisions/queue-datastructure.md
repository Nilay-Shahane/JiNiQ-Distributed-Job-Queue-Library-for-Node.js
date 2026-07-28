# ADR: Redis Native Data Structures for Queue State Management over Application Memory Structures

## Context

A distributed job queue (JiNiQ) needs to store different categories of jobs:

* **Waiting jobs**
* **Priority jobs**
* **Delayed jobs**
* **Active jobs**
* **Completed jobs**
* **Failed/dead jobs**
* **Job metadata**
* **Ownership locks**
* **Lifecycle events**

The storage model directly affects scheduling correctness, recovery after crashes, horizontal scaling, ordering guarantees, and operational visibility.

There are two possible approaches:

### 1. In-Memory Application State (Rejected)

```javascript
const priorityQueue = new Heap();
const delayedTimers = new Map();
const activeJobs = [];
```

### 2. Persistent Redis-Native Data Structures (Chosen)

- Hash → Job metadata
- ZSET → Priority queue
- ZSET → Delayed jobs
- List → Active jobs
- String TTL → Worker ownership lock
- Stream → Lifecycle events

JiNiQ chooses Redis-native structures because queue state is a distributed system concern, not a single-process concern. All Redis keys are defined once inside the `RedisStorage` constructor. No other component constructs Redis key names manually.

### Key Naming Scheme

```
jiniq:<queue>:main:<jobId>
jiniq:<queue>:priority
jiniq:<queue>:normal
jiniq:<queue>:delay
jiniq:<queue>:active
jiniq:<queue>:lock:<jobId>
jiniq:<queue>:complete
jiniq:<queue>:dead
jiniq:<queue>:notify
jiniq:<queue>:logs
```

This ensures the storage layout remains centralized and prevents inconsistent key generation.

## Decision

Use Redis-native data structures as the authoritative queue state. The queue state is divided into specialized structures instead of one generic collection.

### 1. Job Metadata Stored Using Redis Hash

**Structure:** `jiniq:<queue>:main:<jobId>`
**Type:** HASH

**Example:**

```json
{
  "name": "sendEmail",
  "payload": "{...}",
  "status": "ACTIVE",
  "attempts": 2,
  "maxAttempts": 5
}
```

**Justification**

Queue scheduling structures should only answer which job should execute next. They should not store large payloads. Storing metadata in a dedicated Hash provides:

- **Single source of truth:** Every queue references the same job record. No duplicate copies exist.
- **Efficient updates:** Changing attempt count (`HSET main:123 attempts 3`) is cheaper than rewriting an entire queue entry.
- **Lifecycle persistence:** The job Hash survives movement across queues (priority → active → complete). The job remains the same logical entity.

**Trade-offs**

- Positive: Avoids data duplication, simplifies recovery and debugging, enables O(1) metadata updates.
- Negative: Requires an additional Redis lookup when fetching jobs; increases total key count.

### 2. Priority Queue Using Redis ZSET

**Structure:** `jiniq:<queue>:priority`
**Type:** SORTED SET
**Score:** `timestamp - priorityOffset`

**Justification**

- **Why not a LIST?** A LIST only preserves insertion order. High-priority jobs submitted later must jump ahead of low-priority jobs submitted earlier, which a LIST cannot model.
- **Why not an in-memory Heap?** An in-memory heap exists only within a single worker process. Multiple workers would maintain isolated heaps without global ordering, leading to lost jobs on crashes and inability to coordinate execution.
- **Why ZSET?** Redis Sorted Sets provide dynamic priority execution (lowest score executes first), cross-worker ordering, O(log N + M) lookups, and flexible range queries for pagination and monitoring.

**Trade-offs**

- Positive: Global ordering across workers, persistent state, efficient scheduling.
- Negative: Slightly higher memory usage than LIST; score calculations must be designed carefully to prevent starvation.

### 3. Normal Waiting Queue Using ZSET

**Structure:** `jiniq:<queue>:normal`
**Type:** SORTED SET
**Score:** submission timestamp

**Justification**

While LIST works for pure FIFO execution, using a ZSET for normal jobs keeps the scheduler API unified across both priority and standard queues. It also enables range queries, atomic claiming mechanisms, and direct monitoring parity.

**Trade-offs**

- Positive: Unified scheduler interface; simplified recovery logic and operational tooling.
- Negative: Marginally higher memory consumption compared to a pure FIFO LIST.

### 4. Delayed Jobs Using Redis ZSET

**Structure:** `jiniq:<queue>:delay`
**Type:** SORTED SET
**Score:** `runAt` (Unix timestamp in milliseconds)

**Justification**

Application-level timers (`setTimeout`) fail in distributed settings: worker restarts drop pending timers, and multiple instances cannot synchronize schedules safely.

With a ZSET, Redis holds `jobId -> runAt`. Workers or background schedulers evaluate ready tasks via `ZRANGEBYSCORE delay -inf <currentTime>` and move runnable entries into active or priority pipelines.

**Trade-offs**

- Positive: Survives worker restarts, scales across cluster nodes, easily queries future workloads.
- Negative: Depends on a polling/sweeper routine; introduces scheduling latency bounded by the poll interval.

### 5. Active Queue Using Redis LIST

**Structure:** `jiniq:<queue>:active`
**Type:** LIST
**Format:** `jobId:workerId`

**Justification**

Active jobs do not require priority sort orders—their purpose is tracking worker ownership, execution heartbeats, and handling recovery. A sweeper thread iterates active tracking entries to match them against associated lock keys (`lock:<jobId>`).

**Trade-offs**

- Positive: Straightforward push/pop tracking mechanics; easy append and removal operations.
- Negative: Searching or removing arbitrary elements inside a LIST is an O(N) operation.

### 6. Ownership Lock Using Redis String TTL

**Structure:** `jiniq:<queue>:lock:<jobId>`
**Type:** STRING
**Value:** `workerId`
**TTL:** Heartbeat expiration window

**Justification**

Instead of requiring manual lock release step chains during worker failures, workers continuously refresh a key's TTL while processing. If a worker dies, its heartbeat ceases, the TTL naturally expires, and the recovery sweeper re-enqueues or marks the stranded job as failed.

**Trade-offs**

- Positive: Automatic crash detection without abandoned processing locks.
- Negative: Requires tuning the heartbeat rate against network jitter to avoid false-positive worker reclaims.

### 7. Completed and Dead Queues Using LIST

**Structures:**

- `jiniq:<queue>:complete` → LIST
- `jiniq:<queue>:dead` → LIST

**Justification**

Finished and dead-lettered jobs form append-only historical records. Because they do not participate in active scheduling decisions, LIST structures provide lightweight audit logging.

**Trade-offs**

- Positive: Simple lifecycle record-keeping and sequential inspection.
- Negative: High-volume queues require explicit retention limits or trim policies (e.g., `LTRIM`) to avoid unbounded memory growth.

### 8. Notification Channel Using Pub/Sub

**Structure:** `jiniq:<queue>:notify`
**Type:** Redis Pub/Sub

**Justification**

Pub/Sub provides real-time worker signaling to wake up sleeping consumers without relying purely on tight polling loops. Because Pub/Sub lacks delivery guarantees (at-most-once delivery), it serves exclusively as an optimization overlay while periodic storage polling remains the source of truth.

**Trade-offs**

- Positive: Reduces idle polling overhead and job consumption latency.
- Negative: Requires fallback polling logic for network partitions or unacknowledged messages.

### 9. Lifecycle Logs Using Redis Streams

**Structure:** `jiniq:<queue>:logs`
**Type:** Redis Stream
**Events Captured:** `started`, `completed`, `failed`, `retry`

**Justification**

Execution stream logs are decoupled from core queue correctness. Redis Streams provide append-only event recording with replay capabilities, enabling live tracing and UI analytics dashboard integrations without mutating operational state keys.

**Trade-offs**

- Positive: Immutable event audit log, stream replay, structured observability.
- Negative: Additional storage footprint requiring stream capping max-length policies (`MAXLEN`).

## Architectural Layout

```
                   Job Hash
                      |
          -------------------------
          |           |           |
      Priority     Normal       Delay
        ZSET        ZSET        ZSET
          |           |           |
          -------------------------
                      |
                    Active
                     LIST
                      |
                 TTL Lock String

Terminal:
  Complete -> LIST
  Dead     -> LIST

Observability:
  Logs     -> STREAM

Optimization:
  Notify   -> PUB/SUB
```

## Final Decision Summary

| Requirement | Redis Structure | Core Motivation |
|---|---|---|
| Job Metadata | HASH | Centralized single source of truth |
| Priority Scheduling | ZSET | Dynamic ordering + priority score semantics |
| Normal Waiting | ZSET | Unifies scheduling implementation with priority paths |
| Delayed Execution | ZSET | Reliable execution timers, surviving worker restarts |
| Active Jobs | LIST | Processing ownership tracking |
| Worker Ownership | TTL STRING | Automatic failure detection via lease expiration |
| Completed Jobs | LIST | Simple append-only history |
| Dead-letter Jobs | LIST | Failed job isolation and manual inspection |
| Notifications | PUB/SUB | Wake-up signaling to minimize consumer latency |
| Lifecycle Event Logs | STREAM | Immutable audit trail and real-time telemetry |

