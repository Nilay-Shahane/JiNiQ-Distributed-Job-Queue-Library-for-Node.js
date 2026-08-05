# Consistency Guarantees

Being precise about what JiNiQ actually guarantees, rather than what it might sound like it guarantees.

## Delivery semantics: at-least-once, not exactly-once

JiNiQ delivers each job **at least once** to a processor function — it does not guarantee **exactly once**. This is a direct consequence of the lease/heartbeat model described in [`decisions/heartbeat-leases.md`](../decisions/heartbeat-leases.md): detection of a dead worker happens via TTL expiry, which means there is an unavoidable window where a worker *could* still be running a job's processor function at the exact moment the sweeper decides that job is a zombie and hands it to someone else.

**Concretely, duplicate execution is possible when:**
- A worker's heartbeat renewal is delayed past the lease TTL (severe GC pause, Redis latency spike, network hiccup) while the processor function is still legitimately running — the sweeper reclaims the job and a second worker starts it, while the first worker (unaware yet) is still executing.
- The original worker's `HeartBeat` *will* eventually detect the ownership loss on its next renewal attempt and call `abortFn()` — but "eventually" isn't "instantly," and if your processor function has already caused an external side effect (sent an email, charged a card) before the abort signal arrives, that side effect has already happened once and may happen again from the second worker.

**Duplicate *state corruption* is not possible**, which is a meaningfully different (weaker but still valuable) guarantee — the ownership checks in `checkAndComplete` and `addToDelayedOrDead` (see their respective pages in [`lua-docs/`](../lua-docs/)) mean only one of the two competing workers can successfully report the job's outcome. The queue's own bookkeeping (complete/delay/dead lists, attempt counts) stays correct even when execution duplicates.

## What this means for your processor functions

**Write processor functions to be idempotent wherever the underlying operation allows it** — e.g. use the job's `jobId` as an idempotency key when calling external APIs that support one (Stripe charges, email-sending APIs with dedup keys), or make the operation naturally idempotent (`UPSERT` instead of `INSERT`). This is standard advice for *any* at-least-once queue (SQS, BullMQ, Sidekiq all carry the same caveat) — it's not a JiNiQ-specific weakness, but it is a JiNiQ-specific responsibility to hand off clearly rather than let someone assume stronger guarantees than exist.

## Ordering

JiNiQ does **not** guarantee strict FIFO ordering, even within a single priority tier. Two normal jobs submitted moments apart will *usually* be claimed in submission order (ZSET scored by timestamp), but concurrent claims across multiple worker slots mean job B can finish before job A if A's processor happens to take longer — there's no guarantee about *completion* order, only that claim order roughly follows insertion order per tier.

## What's fully consistent (no caveats)

- **A job's `attempt` count** — always accurate, atomic increments regardless of failure source (see [`retries-and-dead-jobs.md`](./retries-and-dead-jobs.md)).
- **A job's terminal state** (`completed` / `dead`) — exactly one of these is ever durably recorded per job, enforced by the lock-ownership gate in every relevant Lua script.
- **Queue capacity enforcement** (`maxQueueSize`) — checked and enforced atomically inside the same Lua execution as the insert, so it can't be overshot by concurrent producers.