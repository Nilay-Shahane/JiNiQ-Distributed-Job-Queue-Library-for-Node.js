# Lua Scripts: Overview

JiNiQ has five Lua scripts, each registered as a custom `ioredis` command. This page covers why Lua is used at all and the conventions all five scripts follow. Each script gets its own page with the exact `KEYS`/`ARGV` contract and return codes.

## Why Lua

Redis executes a Lua script as a single atomic unit — no other client's commands can interleave with it, even though the script itself issues multiple Redis commands internally. JiNiQ leans on this heavily: "check if a lock is owned by me, and if so, delete it and move the job to the complete list" is three logical Redis operations (`GET`, `DEL`, `RPUSH`) that need to happen as if they were one, or two workers racing on the same job could both believe they succeeded. See [`decisions/lua-over-transactions.md`](../decisions/lua-over-transactions.md) for why this was chosen over `MULTI`/`EXEC` or `WATCH`-based optimistic locking.

## Scripts at a glance

| Script file | Registered as | Purpose |
|---|---|---|
| `AddJobLua.lua` | `addJobtoQueue` | Insert a new job, dedup, enforce capacity, route to the right waiting queue |
| `ClaimNextJob.lua` | `claimNextJob` | Atomically pick and claim the next eligible job |
| `CheckAndUpdateHeartbeat.lua` | `renewJobLease` | Renew a lock's TTL, verifying ownership first |
| `CheckAndComplete.lua` | `checkAndComplete` | Mark a job completed, verifying ownership first |
| `AddToDelayedOrDeadLua.lua` | `addToDelayedOrDead` | Route a failed job to retry or dead-letter, verifying ownership first |
| `Sweeper.lua` | `sweeper` | Scan for zombie jobs (expired locks) and recover them |

## Conventions used across all five

- **Ownership checks come first.** Every script that touches an already-claimed job (`renewJobLease`, `checkAndComplete`, `addToDelayedOrDead`) starts by comparing the lock's stored value against the calling `workerId`. If they don't match, the script returns immediately without mutating anything else — this is the single mechanism that prevents two workers from both successfully acting on the same job.
- **Return codes are small integers, not strings.** `1` generally means "success," `0` means "no-op / not found / mismatch," `-1` means a distinct failure condition (e.g. queue full, lock mismatch). Each script's own page documents its exact codes — they are **not** consistent in meaning across scripts, so don't assume `0` always means the same thing.
- **`KEYS[]` vs `ARGV[]` is deliberate.** Anything that's an actual Redis key name goes in `KEYS[]` (required for Redis Cluster compatibility — Lua scripts in cluster mode need to declare their keys upfront for slot routing). Everything else (job IDs, timestamps, TTLs, worker IDs) goes in `ARGV[]`.
- **No script calls another script.** Each is self-contained; composition happens at the `RedisStorage` / application level, not inside Lua.

## A note on schema changes

Because `numberOfKeys` and argument order are hardcoded in both `RedisDB.js` (the `defineCommand` calls) and `RedisStorage.js` (the calls that build the `keys`/`args` arrays), changing a script's signature means updating both files in lockstep — there's no schema validation layer in between. If you add a key or argument to a script, grep for its `defineCommand` name in `RedisDB.js` and its call site in `RedisStorage.js` before assuming the change is complete.