# Redis Data Model

Every key JiNiQ uses is namespaced under `jiniq:<queueName>:*`. This document is the ground truth for what each key is, its type, and who writes to it.

## Key map

Defined once in `RedisStorage`'s constructor and reused everywhere else in the class — no other component ever constructs a key name itself.

| Key | Type | Purpose |
|---|---|---|
| `jiniq:<q>:main:<jobId>` | Hash | The job itself — payload, name, status, attempt count, maxAttempts, etc. One hash per job, lives for the job's entire life. |
| `jiniq:<q>:priority` | ZSET | Waiting high-priority jobs. Score = `timestamp - priorityOffset` (see below). |
| `jiniq:<q>:normal` | ZSET | Waiting normal-priority jobs. Score = `timestamp` (submission time — older jobs sort first). |
| `jiniq:<q>:delay` | ZSET | Jobs scheduled for the future. Score = `runAt` (`timestamp + delay`). |
| `jiniq:<q>:active` | List | Currently-claimed jobs, entries formatted as `"jobId:workerId"`. |
| `jiniq:<q>:lock:<jobId>` | String, TTL | Ownership lock for an active job. Value is the owning `workerId`. Expires automatically if the heartbeat stops renewing it — this expiry is what the sweeper detects. |
| `jiniq:<q>:complete` | List | Job IDs that finished successfully. |
| `jiniq:<q>:dead` | List | Job IDs that exhausted `maxAttempts`. |
| `jiniq:<q>:logs` | Stream | Append-only lifecycle log (`started`/`completed`/`failed` events with payload snapshots), capped with `MAXLEN ~ 1000`. Intended for dashboards/observability, not for correctness. |

## Why priority and normal are separate ZSETs, not one

A single ZSET with a combined "priority + time" score would let old normal jobs get buried indefinitely by a steady stream of new high-priority ones. Keeping them separate and merging *at claim-time* (comparing `priorityScore - offset` against `normalScore`) means a normal job that's been waiting long enough will still win the comparison against a freshly-submitted priority job. This is what "anti-starvation" means concretely — see [`architecture/execution-flow.md`](./execution-flow.md) for the exact comparison logic.

## Why the job hash is separate from the queue ZSETs

The ZSETs and the `active`/`complete`/`dead` lists only ever store a job's **ID** — never its payload. The payload and metadata live once, in the `main:<jobId>` hash, and every queue structure just references that ID. This keeps the hot-path ZSET/list operations cheap (fixed-size ID strings) regardless of payload size, and means moving a job between states never requires copying its payload.

## Payload encoding

Payloads are `JSON.stringify`'d before being written into the hash (`HSET main:<jobId> payload <json>`) and parsed back out on read (`getPayload`), with a fallback to the raw string if parsing fails — this covers jobs whose payload was a plain string rather than an object.