# ADR: Pipelined Chunking over Single-Execution Bulk Inserts

## Context

Producers often need to insert thousands of jobs at once (e.g., a nightly cron job dispatching 100,000 emails).

Calling `queue.addJob()` inside a `for` loop 100,000 times requires 100,000 separate TCP network round-trips to Redis. This is unacceptably slow and heavily blocks the Node.js event loop.

To build `addBulk()`, we had to decide how to batch these requests efficiently into Redis.

## Decision

JiNiQ implements `addBulk()` using **Redis Pipelining with fixed Chunk Sizes**.

Instead of iterating normally, JiNiQ groups jobs into arrays (default chunk size: 1,000). It opens an `ioredis.pipeline()`, queues up 1,000 `addJobToQueue` Lua executions, and sends them to Redis in a single TCP packet. It then processes the results array, mapping individual failures and successes, before moving to the next chunk.

## Alternatives considered

### A Single Mega-Lua Script

Write a new Lua script that accepts an array of 100,000 jobs, parses them, and inserts all of them in one massive atomic block.

* **Why rejected:** Redis executes Lua scripts synchronously. A script processing 100,000 jobs would block the entire Redis server for several seconds. During this time, all other JiNiQ workers attempting to claim jobs, renew heartbeats, or complete tasks would time out and crash.

### Unbounded Pipelining

Pipeline all 100,000 jobs in one massive TCP request.

* **Why rejected:** Pipelining requires Node.js and Redis to hold the entire request and response array in RAM. Unbounded pipelining causes massive memory spikes, potentially triggering Out-Of-Memory (OOM) kills on smaller Redis instances.

## Consequences

### Positive

* **High Throughput with Low Latency:** Network round-trips are reduced by 99.9% (from 100k to 100), maximizing ingestion speed.
* **Redis Stability:** By chunking at 1,000 jobs, the pipeline yields back to the Redis event loop frequently, allowing worker heartbeats and claims to interleave smoothly without timing out.
* **Partial Success Handling:** Because the pipeline executes individual Lua scripts, a failure on job 499 (e.g., `QueueFullError`) does not roll back or crash the successful insertion of the other 999 jobs in the chunk.

### Negative

* **Loss of Absolute Atomicity:** A bulk insert of 10,000 jobs is not a single ACID transaction. If the Node process crashes after chunk 2, 2,000 jobs will be in Redis and 8,000 will be lost. Producers must design their bulk-generation logic to be safely retryable.