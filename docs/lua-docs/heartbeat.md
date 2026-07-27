# `heartbeat` (`CheckAndUpdateHeartbeat.lua` → `renewJobLease`)

The smallest script in the system, and the one called most frequently per-job over its lifetime (every `ttl / 3` while active). Renews a lock's TTL — but only if the caller still owns it.

## Contract

**KEYS**
1. `lock` prefix

**ARGV**
1. `jobId`
2. `workerId`
3. `heartbeat` (new TTL in ms)

**Returns:** `1` (renewed) · `0` (no lock exists — nothing to renew) · `-1` (lock exists but is owned by a different worker)

## Logic

```lua
local jobKey = KEYS[1] .. ":" .. ARGV[1]
local currentWorker = redis.call("GET", jobKey)

if not currentWorker then return 0 end
if currentWorker == ARGV[2] then
    redis.call("PEXPIRE", jobKey, ARGV[3])
    return 1
else
    return -1
end
```

## Why this needs to be atomic at all

A naive implementation might do `GET` then `PEXPIRE` as two separate round trips from Node. The race that creates: between the `GET` and the `PEXPIRE`, the lock could expire, get swept, and get re-claimed by a *different* worker — and the original worker's `PEXPIRE` would then extend a lock it no longer legitimately owns, silently stealing the job back out from under the new claimant with no error on either side. Wrapping both in one Lua execution closes that window entirely: the ownership check and the renewal happen as one indivisible step.

## The three return codes, and what each means operationally

- **`1`** — normal case. `HeartBeat.runHeartbeat()` loops and sleeps again.
- **`0`** — the lock is simply gone. This can legitimately happen if the sweeper already reclaimed the job (heartbeat renewal arrived too late, past the TTL) — the `HeartBeat` treats this the same as `-1`: stop, and abort the in-flight job via `abortFn()`.
- **`-1`** — the lock exists but belongs to someone else, meaning another worker has already claimed this job (via the sweeper's recovery path). This is the clearest possible signal of a zombie/ownership handoff, and gets the same abort treatment.

`HeartBeat` doesn't distinguish `0` from `-1` in its handling today — both stop the heartbeat and abort. The distinction exists in the Lua return value for anyone building more granular observability on top (e.g. logging "lock expired" vs "lock stolen" differently) without needing to change the script itself.