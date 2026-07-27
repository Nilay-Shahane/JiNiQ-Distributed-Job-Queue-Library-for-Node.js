# ADR: Polling (with backoff) as the source of truth; Pub/Sub as a hint only

## Context

`addJobtoQueue` publishes the new job's ID to a `notify` Pub/Sub channel on every successful insert. It would be possible to make this the *primary* claim-triggering mechanism — subscribe every idle worker to `notify` and have them attempt a claim immediately on message receipt, eliminating most polling latency. JiNiQ doesn't do this; `notify` is published but nothing currently subscribes to drive claims from it. Claiming is driven entirely by `Supervisor`'s poll-with-backoff loop.

## Decision

Polling (with exponential backoff, 50ms–2000ms) is the only mechanism that actually triggers a claim attempt. The `notify` channel exists in the data model but is not wired into the claim path.

## Alternatives considered

**Pub/Sub-driven claiming as the primary mechanism.** Genuinely lower latency for the common case — a worker sitting idle at the top of its backoff curve (up to 2000ms) would otherwise wait out that interval instead of reacting instantly to a `PUBLISH`. This wasn't adopted as the *primary* path for a specific reason: **Redis Pub/Sub delivers at-most-once, to currently-subscribed clients only.** A worker that's briefly disconnected, mid-reconnect, or just hasn't subscribed yet when a message is published simply never receives it — there's no replay, no queue, no delivery guarantee. Relying on it as the *only* trigger would mean a job could sit unclaimed indefinitely if its `notify` message was published into a gap with no active subscriber, even though the job is sitting perfectly claimable in its ZSET the whole time.

**Pub/Sub as a supplementary fast-path, polling as the guaranteed fallback.** This is closer to the eventual right answer, and is a reasonable next iteration: subscribe to `notify` and trigger an out-of-cycle `claimHandler()` call on message receipt (the same event the backoff timer already fires), *without* removing the poll loop itself. Not yet implemented — flagged here as a known, deliberate gap rather than an oversight, since the channel is already being published to and the wiring cost is small.

## Consequences

- **Correctness never depends on Pub/Sub delivery.** Every job that lands in a waiting ZSET *will* eventually be claimed by ordinary polling, with a worst-case latency bound of the current backoff interval — never "possibly never," regardless of subscriber timing.
- **Cost: idle-queue-to-first-claim latency is bounded by the backoff ceiling (2000ms) rather than near-instant.** For workloads sensitive to that latency, wiring `notify` as a supplementary trigger (per the alternative above) is the direct fix.
- **The `notify` channel currently has no consumer**, which is worth being upfront about — it's published, unused, and represents a specific, scoped piece of unfinished work rather than a fully-realized feature.