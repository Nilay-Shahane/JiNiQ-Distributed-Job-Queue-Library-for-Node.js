# Architecture Decision Records

Each ADR here documents one specific tradeoff: what was chosen, what the realistic alternatives were, and why the alternatives lost. These aren't meant to claim the choice is objectively "best" — only that it was made deliberately, with the tradeoffs understood.

## Index

- [Redis over Streams](./redis-over-streams.md) — why Redis's core data structures (ZSET/List/Hash) rather than Redis Streams as the primary queue mechanism
- [Lua over Transactions](./lua-over-transactions.md) — why server-side Lua scripting rather than `MULTI`/`EXEC` or `WATCH`-based optimistic locking
- [Supervisor Design](./supervisor-design.md) — why a single polling orchestrator per worker rather than one poller per concurrency slot
- [Polling over Pub/Sub](./polling-over-pubsub.md) — why claim polling is the source of truth and the `notify` pub/sub channel is only a hint
- [Heartbeat Leases](./heartbeat-leases.md) — why TTL-based leases rather than an explicit "still alive" acknowledgment protocol
- [Job State Machine](./jobstate-machine.md) — why an explicit finite state machine rather than independent boolean flags
- [Separate Queues](./seperate-queues.md) — why separate Redis data structures per queue state rather than one global job store with status fields
- [Redis over Database](./redis-reasoning.md) — why Redis as the queue state engine over traditional relational or document databases
- [Queue Data Structures](./queue-datastructure.md) — why native Redis data structures rather than application memory structures

## Format

Each ADR follows: **Context** (what problem existed) → **Decision** (what was chosen) → **Alternatives considered** (and why they lost) → **Consequences** (what this costs, honestly).