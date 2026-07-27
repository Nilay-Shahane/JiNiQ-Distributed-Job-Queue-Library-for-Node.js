# ADR: Redis core data structures over Redis Streams

## Context

Redis offers a purpose-built structure for queue-like workloads: Streams (`XADD`/`XREADGROUP`/`XACK`), with consumer groups that natively handle claiming, acknowledgment, and pending-entry tracking. JiNiQ instead builds its queue out of plain ZSETs, Lists, and Hashes, orchestrated entirely through custom Lua scripts. This needs justifying, since Streams look like the "obvious" native fit.

## Decision

Use ZSETs for waiting/delayed jobs, a List for the active set, String keys with TTL for locks, and Lua scripts for every state transition. Redis Streams are used only for the `logs` stream — a genuinely append-only, ack-free observability feed — not for the job queue itself.

## Alternatives considered

**Redis Streams with consumer groups.** `XREADGROUP` gives claiming and pending-entry-list tracking for free, and `XCLAIM` handles reassigning stuck messages — on paper, a lot of what JiNiQ hand-builds with Lua. It loses out here for a few concrete reasons:
- **No native priority.** Streams are strictly ordered by entry ID (insertion order). JiNiQ's two-queue priority/normal split with anti-starvation scoring has no equivalent in a single stream — you'd need multiple streams and application-level merging anyway, which erodes most of the "it's native" advantage.
- **No native delay/scheduling.** A delayed job in Streams still requires an external mechanism (a separate ZSET, or a second consumer pass) to hold it until due — the exact same delay-ZSET pattern JiNiQ already uses, so Streams wouldn't remove that complexity, only add a second structure alongside it.
- **Consumer-group claim semantics don't map cleanly onto "capacity-limited waiting queues."** `maxQueueSize` enforcement (reject new jobs once full) isn't a Streams-native concept — Streams are unbounded by design (or trimmed by count/time, not by a hard capacity gate at write time).

**A single sorted structure for everything.** Rejected for the reason covered in [`redis-data-model.md`](../architecture/redis-data-model.md): a combined score can't express "prioritize this, but don't let it starve everything else" as cleanly as two structures merged at claim-time can.

## Consequences

- **More moving parts to reason about** — five Lua scripts and eight-ish keys, versus a smaller Streams-based surface. This is the direct cost of building priority + delay + capacity semantics that Streams don't offer out of the box.
- **No free `XPENDING`/`XCLAIM` tooling** — zombie detection is entirely custom (the `Sweeper` script), rather than inspectable via Streams' built-in pending-entries introspection commands.
- **Full control over scheduling semantics** — the tradeoff's upside: priority scoring, capacity limits, and delay handling are exactly as JiNiQ needs them, not shaped by what a general-purpose stream primitive happens to support.