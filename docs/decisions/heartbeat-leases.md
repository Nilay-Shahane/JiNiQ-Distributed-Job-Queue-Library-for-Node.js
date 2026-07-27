# ADR: TTL-based heartbeat leases over explicit acknowledgment protocols

## Context

A job queue needs to detect when a worker has stopped processing a job it claimed — whether it crashed, hung, or lost network connectivity — so the job can be recovered rather than lost forever. Two broad approaches: (a) a **lease**, where the worker periodically proves liveness by renewing a TTL-bound lock, and absence of renewal is the failure signal; or (b) an **explicit protocol**, where the worker sends discrete "still working" and "done" acknowledgments that a coordinator tracks and times out.

## Decision

TTL-based leases. Claiming a job sets `lock:<jobId>` with a TTL (`PSETEX`); `HeartBeat` renews that TTL at roughly a third of its duration; absence of renewal (the key expiring naturally) is what the `Sweeper` detects and acts on. There is no separate "worker is alive" heartbeat channel independent of the lock itself — the lock's TTL *is* the liveness signal.

## Alternatives considered

**Explicit ack/nack protocol with a coordinator tracking timeouts.** Would require a stateful coordinator process maintaining a table of "job → last-seen timestamp" and its own sweep logic over that table — essentially reimplementing what Redis's native key expiry already does for free. Redis expiring the `lock` key *is* the timeout tracking; no separate bookkeeping structure needed.

**No liveness detection at all (fire-and-forget, rely only on explicit complete/fail calls).** Simplest possible option, and rejected outright — it means a crashed worker's jobs are lost permanently with no recovery path, which defeats a core purpose of having a durable queue in the first place. Not seriously considered as a real alternative, included for completeness.

**Longer TTL with less frequent renewal (e.g. renew once per TTL instead of three times).** Would reduce Redis load from heartbeat calls, but shrinks the safety margin — a single missed or slow renewal (Redis latency spike, brief GC pause) becomes much more likely to cause a false-positive zombie declaration, wrongly reclaiming a job that's actually still being processed fine. The `ttl / 3` interval specifically exists to survive one missed renewal without expiring — see [`internals/heartbeat-sweeper.md`](../internals/heartbeat-sweeper.md).

## Consequences

- **No coordinator process, no separate liveness-tracking data structure.** Redis's own key expiry mechanism does the timeout detection; `Sweeper` only needs to check `EXISTS`, not compare timestamps against a clock itself.
- **Detection latency is bounded by `ttl`, not instant.** A crashed worker's job isn't recognized as abandoned until its lock's TTL fully expires *and* a sweep cycle runs afterward — worst case, `ttl + sweeperInterval`. This is a deliberate tradeoff: a shorter `ttl` detects failures faster but increases heartbeat traffic and false-positive risk under transient slowness; see [`reliability/failure-recovery.md`](../reliability/failure-recovery.md) for tuning guidance.
- **The abort-on-lease-loss behavior (via `AbortController`) is a direct consequence of this choice** — because leases can be legitimately reclaimed by another worker while the original is still technically running, the original *must* be told to stop, which an ack-based protocol without a shared mutable lock wouldn't need to handle the same way.