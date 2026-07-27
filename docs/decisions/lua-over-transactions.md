# ADR: Lua scripting over `MULTI`/`EXEC` or `WATCH`-based optimistic locking

## Context

Redis offers three broad mechanisms for making a sequence of operations behave atomically: server-side Lua scripting (`EVAL`/`EVALSHA`, or `defineCommand` via `ioredis`), client-side `MULTI`/`EXEC` transactions, and `WATCH`-based optimistic concurrency control. JiNiQ uses Lua exclusively for every multi-step state transition (claim, complete, fail, heartbeat, sweep).

## Decision

Every operation that reads state and conditionally writes based on it (e.g. "if I still own this lock, complete the job") is a single Lua script executed server-side.

## Alternatives considered

**`MULTI`/`EXEC`.** A Redis transaction queues commands and executes them atomically — but it cannot make a *decision* based on a value read during the transaction. You can't `GET` a lock's owner inside a `MULTI` block and conditionally skip the rest of the transaction based on that read; by the time `EXEC` runs, all queued commands execute unconditionally. Every operation JiNiQ needs ("only do this *if* I still own the lock") is exactly the kind of conditional logic `MULTI`/`EXEC` can't express without help.

**`WATCH` + `MULTI`/`EXEC` (optimistic locking).** This can express "abort the transaction if the watched key changed since I read it," which gets closer — but it requires a `GET` (to read current owner), then `WATCH` that key, then `MULTI`/queue commands/`EXEC`, and a retry loop if the `EXEC` aborts due to a concurrent modification. That's multiple round trips per operation versus Lua's one, real added latency on the hottest paths (claim, heartbeat), and application-level retry logic to get right in every call site instead of once inside a script.

## Consequences

- **One network round trip per state transition**, regardless of how many internal steps it involves — meaningfully cheaper than `WATCH`-based retry loops under contention, which is exactly when contention is highest (many workers claiming from the same queue simultaneously).
- **No retry logic needed in application code.** A claim either succeeds or doesn't, atomically, in one call — `Supervisor` doesn't need to handle "someone else claimed it between my read and my write" as a distinct case to retry.
- **Cost: Lua scripts are a second language embedded in a JS codebase.** They're harder to unit test in isolation compared to plain JS, require a Redis instance (or `redis-cli --eval`) to exercise directly, and a bug in one is a bug that ships as a string blob loaded from disk (`fs.readFileSync`) rather than something the JS type system or linter can catch.
- **Cost: `numberOfKeys` and argument order are a manual contract.** As noted in [`lua/overview.md`](../lua/overview.md), there's no schema layer enforcing that `RedisDB.js`'s `defineCommand` calls and `RedisStorage.js`'s call sites stay in sync — this is a real place bugs can hide, especially across refactors.
- **Correctness benefit compounds with scale.** The more concurrent workers hit the same queue, the more this decision pays for itself — it's precisely the high-contention case where round-trip-heavy alternatives degrade.