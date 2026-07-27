# ADR: One `Supervisor` polling loop per worker, not one poller per slot

## Context

A worker needs to run up to `maxConcurrency` jobs at once. Two broad shapes for this: (a) a single orchestrator that polls, claims, and dispatches jobs whenever a slot frees up, tracking all active work itself; or (b) `maxConcurrency` independent "lanes," each with its own poll loop, each responsible for claiming and running exactly one job at a time before claiming its next.

## Decision

A single `Supervisor` per `Worker`, owning one `activeWorkers` set and one claim loop, that claims jobs one at a time in a `while (hasSlot())` loop and fires each off without waiting for it to finish.

## Alternatives considered

**N independent lane pollers.** Each lane would claim a job, await its completion, then claim its next — conceptually simpler per-lane, and arguably easier to reason about in isolation. It loses out for two reasons:
- **Uneven slot utilization.** If lane 3 claims a job that takes 10 seconds while lanes 1, 2, and 4 finish theirs in 200ms, those three lanes sit idle rather than picking up more work, unless each lane also implements the same backoff-and-poll logic the shared `Supervisor` already has — at which point you've just reimplemented the shared loop N times with more code, not less.
- **N times the poll traffic under load.** N independent pollers each running their own backoff timer means N times the Redis round trips for claim attempts, compared to one loop that claims up to N jobs per cycle whenever slots are free.

**A single `Supervisor` that awaits each job before claiming the next (fully sequential).** This defeats the purpose of `maxConcurrency` entirely — it's a concurrency-1 worker regardless of the configured limit. Rejected immediately, included here only because it's the version you'd accidentally write if you `await assignJob()` inside the claim loop instead of firing it and continuing.

## Consequences

- **Slot utilization stays high regardless of individual job duration** — a fast-finishing job's slot gets refilled on the very next `claimHandler()` trigger (fired directly from that job's own `.finally()`), not on a fixed timer tick.
- **Single point of concurrency bookkeeping.** `activeWorkers.size` is the one source of truth for "how many jobs are running," which is simpler to reason about (and debug) than reconciling state across N independent lane objects.
- **Cost: the claim loop and job execution are more tightly coupled than a lane-based design would be.** `Supervisor` needs to know about `JobExecutor` construction directly (`assignJob` builds the executor), rather than lanes being a clean, swappable abstraction boundary. For JiNiQ's current scope this is an acceptable coupling; it would be worth revisiting if `JobExecutor` construction needed to vary significantly per-job-type in the future.