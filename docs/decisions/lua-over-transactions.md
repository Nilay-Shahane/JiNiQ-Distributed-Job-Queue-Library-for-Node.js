# ADR: Lua scripting over `MULTI`/`EXEC` or `WATCH`-based optimistic locking

## Context

Redis provides three primary ways to make multiple operations execute atomically:

1. **Server-side Lua scripting** (`EVAL`/`EVALSHA`, or `defineCommand` via `ioredis`)
2. **`MULTI`/`EXEC` transactions**
3. **`WATCH` + `MULTI`/`EXEC` optimistic locking**

JiNiQ is a distributed job queue where every job moves through a strict state machine:

```
WAITING
    │
    ▼
ACTIVE
    │
    ├──► COMPLETED
    ├──► DELAYED
    └──► DEAD
```

Every transition modifies multiple Redis data structures simultaneously.

For example, claiming a job requires:

- selecting the next eligible job
- removing it from the waiting queue
- adding it to the active queue
- creating a lock with a TTL
- recording ownership
- returning the job to the worker

Similarly, completing a job requires:

- verifying lock ownership
- removing from active
- deleting the lock
- marking completed
- publishing notifications (if applicable)

These are **not simply multiple writes**.

They are **conditional state transitions**.

Almost every critical operation in JiNiQ follows the pattern:

```
Read state
      │
      ▼
Make a decision
      │
      ▼
Update multiple keys atomically
```

Examples include:

- claim job
- renew heartbeat
- complete job
- retry job
- move to delayed queue
- move to dead queue
- sweeper reconciliation

Because correctness is more important than raw throughput in a job queue, JiNiQ requires these decisions to execute without any race window.

---

## Decision

Every multi-step state transition is implemented as a **single Lua script executed inside Redis**.

Instead of moving state into the application, Redis executes the entire operation itself.

A Lua script can:

- read existing values
- make decisions using normal programming constructs (`if`, loops, comparisons)
- execute any number of Redis commands
- return a result

all while Redis guarantees that **no other client can execute commands until the script finishes**.

For JiNiQ, this means operations such as:

```
if I still own this lock
    complete the job
else
    reject the completion
```

execute entirely inside Redis without exposing intermediate states.

---

## Alternatives considered

### `MULTI` / `EXEC`

`MULTI`/`EXEC` is frequently misunderstood.

It guarantees that queued commands execute atomically, **but it does not provide conditional execution**.

For example:

```text
MULTI

GET lock
DEL active
SET completed

EXEC
```

This does **not** mean:

```
if GET lock == workerId
    execute remaining commands
```

Instead, Redis simply queues:

```
GET
DEL
SET
```

and executes them in order.

The result of `GET` cannot influence the later commands inside the transaction.

In other words:

```
MULTI/EXEC

=

Atomic batch execution

≠

Atomic decision making
```

Most JiNiQ operations require logic such as:

```
if lock owner == worker
    perform transition
else
    abort
```

This cannot be expressed using `MULTI`/`EXEC` alone.

---

### `WATCH` + `MULTI` / `EXEC`

Redis optimistic locking solves this limitation.

Typical workflow:

```
GET current owner

↓

WATCH lock

↓

MULTI

↓

queue commands

↓

EXEC

↓

if transaction aborted
    retry
```

This works correctly.

However, it introduces several costs.

#### Multiple network round trips

Instead of one request:

```
EVAL
```

the operation becomes:

```
GET

↓

WATCH

↓

MULTI

↓

EXEC
```

Under contention this can repeat multiple times.

---

#### Retry logic

If another worker modifies the watched key:

```
EXEC
```

returns failure.

The application must:

```
retry

↓

read again

↓

watch again

↓

rebuild transaction

↓

execute again
```

Every operation must implement retry logic correctly.

JiNiQ would need this for:

- claiming jobs
- completing jobs
- heartbeats
- retries
- sweeper operations

This increases both code complexity and latency.

---

#### High contention becomes expensive

JiNiQ is intentionally designed for concurrent workers.

Multiple workers may simultaneously attempt to:

- claim jobs
- heartbeat
- complete work
- retry failures

During exactly these moments, optimistic locking experiences the highest retry rate.

Lua does not.

Each worker simply sends:

```
EVAL
```

Redis executes scripts one at a time.

One succeeds.

The others receive deterministic failure results without retrying optimistic transactions.

---

## Why Lua fits JiNiQ particularly well

JiNiQ continuously performs state transitions.

Typical workload:

```
Supervisor

claim()

claim()

claim()

claim()

Heartbeat

renew()

renew()

renew()

Worker

complete()

retry()

fail()

Sweeper

recover()

recover()
```

These are the hottest code paths in the system.

Adding optimistic retry loops around every operation would significantly increase:

- network traffic
- latency
- application complexity

Lua keeps every transition:

```
One request

↓

One execution

↓

One response
```

regardless of how many Redis commands are executed internally.

---

### Example: Claim Job

Claiming a job is not simply removing an item from a queue.

Worker A and Worker B may both attempt:

```
Priority Queue

A
B
C
```

Both see:

```
A
```

Only one worker must receive it.

The operation becomes:

```
if job still exists

↓

remove from waiting

↓

push to active

↓

create lock

↓

assign owner

↓

return job
```

This entire sequence executes as one Lua script.

No worker can observe an intermediate state.

---

### Example: Complete Job

Consider:

```
Worker A crashes

↓

Lock expires

↓

Sweeper reclaims job

↓

Worker B receives same job

↓

Worker A wakes up
```

Worker A attempts:

```
complete(job)
```

The system must verify:

```
if lock owner == Worker A

↓

complete

else

↓

reject
```

Otherwise an old worker could incorrectly complete work already reassigned.

Lua performs both verification and update atomically.

---

### Example: Heartbeat

Heartbeat is not merely:

```
EXPIRE lock
```

It is:

```
if I still own this lock

↓

extend TTL

else

↓

return LOST_LOCK
```

Without Lua:

```
GET owner

↓

compare

↓

EXPIRE
```

Another worker could obtain ownership between the `GET` and `EXPIRE`.

Lua removes that race entirely.

---

### Example: Sweeper

The sweeper periodically examines active jobs.

For each job it must determine:

```
lock exists?

↓

yes → skip

↓

no

↓

move back to waiting

or

↓

move to delayed

or

↓

move to dead
```

All of these decisions modify multiple Redis keys.

Lua guarantees reconciliation is performed atomically.

---

## Consequences

### Benefits

- Every state transition executes atomically.
- Conditional logic executes inside Redis.
- No race window exists between reads and writes.
- Exactly one network round trip per transition.
- No optimistic retry loops.
- Simpler application code.
- Better behaviour under high contention.
- Queue invariants remain consistent even during worker crashes.
- All concurrency logic is centralized inside a small set of scripts instead of being duplicated across JavaScript call sites.

---

### Costs

#### Lua introduces another language

Business logic now exists in:

- JavaScript
- Lua

Developers must understand both.

---

#### Harder testing

Lua cannot be unit tested like ordinary JavaScript.

Scripts generally require:

- Redis
- integration tests
- `redis-cli --eval`

---

#### Manual interface contract

`defineCommand()` requires:

- `numberOfKeys`
- exact key ordering
- exact argument ordering

There is no compiler enforcing that:

```
RedisStorage.js

↓

matches

↓

Lua script
```

Refactoring requires care.

---

#### Debugging

Lua errors occur inside Redis.

Stack traces are generally less informative than ordinary JavaScript exceptions.

---

## Why not Redis Streams?

Redis Streams solve a different problem.

Streams provide:

- append-only logs
- consumer groups
- acknowledgements
- offsets
- durable event streaming

JiNiQ requires:

- strict priority scheduling
- delayed jobs
- lease ownership
- heartbeat TTLs
- dead-letter queues
- conditional state transitions

Redis Streams do not natively provide these semantics.

Even with Streams, JiNiQ would still require:

- ownership validation
- heartbeat logic
- retry scheduling
- delayed execution
- dead queue handling

which means Lua would still be required for correctness.

---


### "Isn't `MULTI` atomic?"

Yes.

But atomic **execution** is different from atomic **decision making**.

`MULTI` guarantees:

```
all queued commands execute together
```

It does **not** allow:

```
if GET returned X

then execute these commands

else execute something else
```

Lua is effectively a small program executed atomically.

`MULTI` is only an atomic batch.

---

### "Couldn't you use `WATCH`?"

Yes.

It would work.

JiNiQ deliberately avoids it because:

- additional network round trips
- retry loops
- higher latency
- duplicated optimistic locking code
- poorer behaviour under contention

Lua expresses the same logic more naturally.

---

### "Lua blocks Redis."

Correct.

Redis is single-threaded.

While Lua executes, Redis cannot process other commands.

JiNiQ mitigates this by keeping every script intentionally small.

Scripts only perform state transitions.

They do **not**:

- scan entire queues
- iterate thousands of jobs
- perform expensive computation

Execution time is typically well below a millisecond.

The simplicity of the scripts makes the temporary blocking negligible compared to the correctness benefits.

---

### "Lua is harder to maintain."

Agreed.

This is the largest tradeoff.

However, queue correctness is significantly more valuable than slightly easier application code.

A concurrency bug inside a job queue can produce:

- duplicate execution
- lost jobs
- stuck jobs
- corrupted queue state

JiNiQ accepts slightly more complex implementation in exchange for stronger correctness guarantees.

---

### "Why not use distributed locks?"

A distributed lock alone is insufficient.

Completing a job still requires:

```
verify owner

↓

remove active

↓

delete lock

↓

mark completed
```

Those operations must themselves execute atomically.

Lua coordinates both ownership validation and state transition together.

---

### "What if Lua has a bug?"

This is a valid concern.

JiNiQ minimizes this risk by:

- keeping each script focused on one responsibility
- keeping scripts small
- loading scripts through `defineCommand`
- integration testing against Redis
- maintaining a documented `KEYS`/`ARGV` contract between JavaScript and Lua

---

## Consequences at scale

The more workers compete for the same queue, the more valuable this decision becomes.

Higher concurrency increases the probability of:

- races
- retries
- contention

Lua keeps every transition deterministic regardless of worker count.

Instead of many workers repeatedly failing optimistic transactions, Redis serializes each state transition internally.

As contention increases, the simplicity and predictability of Lua become increasingly valuable.

---

## Summary

JiNiQ does not use Lua merely because it is atomic.

It uses Lua because JiNiQ's core operations are **conditional state transitions**, not simple batches of writes.

`MULTI` can execute commands together, but it cannot express decisions.

`WATCH` can express those decisions, but requires additional round trips, retries, and duplicated concurrency logic.

Lua allows Redis to execute the entire operation—read, decide, update, and return—as a single atomic program.

For a distributed job queue where correctness under failure is the primary design goal, Lua provides the simplest and most reliable concurrency model.
