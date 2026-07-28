# ADR: Explicit Job State Machine over Independent Boolean Flags


---

## Context

Every job in a distributed queue progresses through a well-defined lifecycle.

For JiNiQ, that lifecycle is:

```
WAITING
    ↓
ACTIVE
    ↓
COMPLETED
```

or

```
WAITING
    ↓
ACTIVE
    ↓
FAILED
    ↓
(DELAYED retry) OR (DEAD)
```

At first glance, it may seem simpler to represent a job using several independent boolean fields:

```json
{
    "active": true,
    "completed": false,
    "failed": false,
    "retryCount": 1
}
```

instead of storing one explicit state:

```json
{
    "state": "ACTIVE",
    "attempt": 1
}
```

Many systems begin with boolean flags because they appear straightforward.

However, distributed systems rarely remain simple.

Workers crash.

Retries happen.

Jobs get delayed.

Heartbeats expire.

Recovery logic must determine exactly where a job belongs.

The architecture therefore requires deciding whether job lifecycle should be represented by:

- Multiple independent flags
- A single explicit state machine

---

## Decision

JiNiQ models every job using a **single explicit finite state machine (FSM)**.

A job can exist in **exactly one state** at any point in time.

Supported states are:

```
WAITING
ACTIVE
COMPLETED
FAILED
DELAYED
DEAD
```

Every transition is performed atomically inside a Lua script.

No transition partially succeeds.

No job can exist between two states.

---

# State Diagram

```text
            +-----------+
            | WAITING   |
            +-----------+
                  |
          claimNextJob()
                  |
                  v
            +-----------+
            | ACTIVE    |
            +-----------+
             |        |
             |        |
       success()   failure()
             |        |
             |        v
             |   +-----------+
             |   | FAILED    |
             |   +-----------+
             |        |
             |   retry left?
             |    /       \
             |   /         \
             | yes          no
             | |             |
             | v             v
             |DELAYED      DEAD
             | |
             |retry time
             |expires
             | |
             +-+
               |
               v
            WAITING

```

---

# Why not Boolean Flags?

Suppose the job is represented like this:

```json
{
    "active": true,
    "completed": true,
    "failed": false
}
```

Immediately questions appear.

Is the job completed?

Is it still active?

Should heartbeat continue?

Should sweeper recover it?

Should retry happen?

The data itself cannot answer.

The application now needs complicated validation logic.

Instead, with

```json
{
    "state": "COMPLETED"
}
```

there is only one interpretation.

---

# Why a Finite State Machine?

A job lifecycle is naturally a state machine.

Each state defines:

- what the worker may do
- what Redis structures contain the job
- what transitions are legal
- what recovery logic is valid

Example:

```
WAITING
```

Allowed:

- claim

Not allowed:

- heartbeat
- complete
- fail

---

```
ACTIVE
```

Allowed:

- heartbeat
- complete
- fail

Not allowed:

- claim again

---

```
COMPLETED
```

Allowed:

Nothing.

Terminal state.

---

The current state itself becomes the source of truth.

---

# Benefits

---

## 1. Impossible States Cannot Exist

Independent flags allow combinations that make no sense.

Example

```text
active=true
completed=true
failed=true
```

What does this mean?

Nobody knows.

Even if validation exists, bugs, partial writes, race conditions, or future feature additions can accidentally produce such states.

With an FSM:

```
ACTIVE
```

or

```
COMPLETED
```

or

```
FAILED
```

Exactly one exists.

Impossible states are structurally prevented rather than detected later.

---

## 2. Single Source of Truth

Instead of asking

```
if(active && !failed && !completed)
```

the system simply checks

```
state == ACTIVE
```

Every subsystem uses the same representation.

Examples:

Supervisor

```
ACTIVE?
→ heartbeat required
```

Sweeper

```
ACTIVE?
→ lease expired?
→ recover
```

Dashboard

```
state
```

Metrics

```
count by state
```

Everyone agrees.

---

## 3. Easier Recovery

Suppose a worker crashes.

Recovery only needs to answer

```
Current state?
```

If

```
ACTIVE
```

and lease expired

→ move back to WAITING.

If

```
COMPLETED
```

ignore.

If

```
DEAD
```

ignore.

Recovery becomes deterministic.

No flag combinations need interpretation.

---

## 4. Simpler Lua Scripts

Each Lua script performs

```
Current State

↓

Validate Transition

↓

Move to New State
```

Instead of validating dozens of booleans.

Example:

```
ACTIVE
↓

COMPLETE
```

Allowed.

---

```
WAITING
↓

COMPLETE
```

Rejected.

---

This makes scripts easier to reason about and much safer.

---

## 5. Better Observability

Operations teams naturally ask

```
How many ACTIVE jobs?
```

```
How many FAILED?
```

```
How many DEAD?
```

```
How many WAITING?
```

State-based metrics are trivial.

Boolean metrics require combining multiple fields and still risk inconsistent counts.

---

## 6. Easier Feature Growth

Later JiNiQ may support

```
PAUSED

CANCELLED

SCHEDULED

TIMED_OUT

WAITING_DEPENDENCY
```

With an FSM:

```
Add state

↓

Define transitions
```

Done.

With booleans, every feature adds more combinations.

```
paused=true

cancelled=false

completed=false

waiting=true
```

Validation complexity grows exponentially.

---

## 7. Matches How Distributed Systems Think

Distributed systems don't ask

```
Is completed?
Is failed?
Is active?
```

They ask

```
Current lifecycle state?
```

This mirrors operating systems, workflow engines, Kubernetes, Airflow, Temporal, and workflow orchestration frameworks where resources always occupy one lifecycle phase.

JiNiQ follows the same philosophy.

---

# Alternative Considered

## Alternative 1 — Independent Boolean Flags

Example

```json
{
    "active": true,
    "completed": false,
    "failed": false
}
```

### Advantages

Very easy to implement initially.

Flexible.

Minimal schema.

---

### Disadvantages

Impossible states become possible.

```
active=true
completed=true
```

Validation logic grows.

Recovery becomes ambiguous.

Lua scripts become more complicated.

Future features multiply state combinations.

Harder to reason about correctness.

Rejected.

---

## Alternative 2 — Multiple Status Flags + Validation Layer

Instead of preventing invalid states, maintain validation logic:

```
assert(!(completed && active))
```

This moves correctness into application code.

Every new feature requires updating validators.

Missing one validation introduces bugs.

Distributed systems should make invalid states impossible rather than rely on developers remembering validation rules.

Rejected.

---

## Alternative 3 — Event-Sourced Lifecycle

Represent the lifecycle as an append-only event log:

```
Created

↓

Claimed

↓

Heartbeat

↓

Failed

↓

Retried

↓

Completed
```

Current state is reconstructed by replaying events.

### Advantages

Excellent audit history.

Time-travel debugging.

Complete lifecycle trace.

### Disadvantages

Requires replay or snapshots to determine current state.

Increases storage.

Adds complexity to every state lookup.

Current-state queries become slower.

For JiNiQ, the operational need is to know the current state efficiently, not reconstruct history.

Rejected.

---

# User Questions 

### Q: Why not simply keep `completed`, `failed`, and `active` booleans?

Because booleans can contradict each other. A job can accidentally become both active and completed. An FSM guarantees that only one valid lifecycle state exists at a time, eliminating an entire class of bugs.

---

### Q: Couldn't validation logic prevent invalid flag combinations?

It could, but every write path must remember to execute that validation correctly. As the system evolves, missing one validation introduces subtle bugs. The state machine makes invalid states structurally impossible rather than relying on discipline.

---

### Q: Doesn't an enum limit flexibility?

No. Adding a new lifecycle phase is straightforward: introduce a new state and define its allowed transitions. With booleans, each new feature creates exponentially more possible combinations to validate.

---

### Q: Why is a state machine particularly important in distributed systems?

Failures, retries, crashes, and recovery all depend on knowing the exact lifecycle of a job. A single state provides an unambiguous answer, allowing supervisors, sweepers, and workers to make deterministic decisions without interpreting multiple flags.

---

### Q: Why not derive the state from Redis data structures instead of storing it?

A job may temporarily exist in multiple Redis structures for operational reasons (e.g., metadata plus queues). Deriving state from storage layout couples business logic to implementation details. An explicit state provides a stable, authoritative source of truth independent of internal storage.

---

# Consequences

## Positive

- Impossible lifecycle combinations cannot occur.
- Every job has exactly one authoritative state.
- Recovery logic becomes deterministic.
- Lua scripts are simpler and easier to verify.
- Metrics and dashboards become straightforward.
- Easier to extend with future lifecycle states.
- Better aligns with distributed systems and workflow engine design.

---

## Negative

- Every new state requires carefully defining legal transitions.
- Transition rules must be maintained as the system evolves.
- Some metadata (attempt count, retry delay, timestamps) still exists alongside the state because it describes attributes rather than lifecycle phases.

---

## Conclusion

JiNiQ models every job as a finite state machine because lifecycle is inherently exclusive: a job cannot be waiting, active, and completed simultaneously. Representing that lifecycle as a single explicit state eliminates impossible combinations, simplifies recovery, centralizes correctness, and makes the behavior of the queue predictable under crashes, retries, and concurrent execution. This approach favors correctness and maintainability over the apparent simplicity of independent boolean flags.