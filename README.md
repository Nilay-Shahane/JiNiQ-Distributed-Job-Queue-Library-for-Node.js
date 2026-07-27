# JiNiQ (Consumer/Worker Node)

JiNiQ is a high-performance, distributed, Redis-backed job queue for Node.js. This repository contains the **Consumer/Worker** ecosystem of JiNiQ, designed to process background jobs reliably at scale.

Designed with distributed systems principles, JiNiQ ensures at-least-once delivery, prevents race conditions using atomic Lua scripts, and features a robust lease-based heartbeat mechanism to safely recover from worker crashes.

## Features

* **Atomic State Transitions:** All critical state changes (Claiming, Completing, Failing) are executed via Redis Lua scripts, guaranteeing atomicity and eliminating race conditions.
* **Distributed Locking & Heartbeats:** Workers claim jobs using a lease-based locking mechanism. A background heartbeat process extends the lease, allowing safe detection of crashed or partitioned workers.
* **Zombie Recovery (Sweeper):** An automated Sweeper process detects jobs whose owners have died (expired locks) and safely re-routes them for retry or to a Dead Letter Queue (DLQ).
* **Strict Timeouts:** Job execution is bounded by an `AbortController`-backed timeout mechanism, preventing infinite hangs from rogue user code.
* **Dynamic Concurrency Polling:** The Supervisor intelligently scales its Redis polling intervals using dynamic backoff to minimize database load when idle.
* **Priority & Delayed Jobs:** Native support for delayed execution and prioritized fetching using Redis Sorted Sets (`ZSET`).
* **Persistent Event Logging:** Utilizes Redis Streams (capped for memory safety) to provide a durable, queryable history of job states, ensuring monitoring dashboards never miss an event even during network disconnects.

## Architecture Overview

At a high level, the system consists of a `Worker` that initializes a `Supervisor`. The `Supervisor` polls Redis for available jobs and spawns `JobExecutor` instances up to a defined `maxConcurrency`. Each `JobExecutor` wraps the user's processing logic, bounds it with an `AbortController`, and spawns a `HeartBeat` daemon to maintain ownership of the job in Redis.

## Quick Start

```javascript
const { Worker } = require('jiniq');

// Define your processing logic
const myProcessor = async (payload, abortSignal) => {
    // abortSignal is triggered if maxTimeoutMs is reached
    console.log("Processing:", payload);
    await someHeavyTask(payload);
    return { success: true };
};

// Initialize the Worker
const worker = new Worker('video-processing-queue', myProcessor, {
    concurrency: 5,           // Process 5 jobs concurrently
    lockDuration: 30000,      // Heartbeat TTL (30s)
    maxTimeoutMs: 300000,     // Hard kill job after 5 minutes
    sweeperInterval: 30000,   // Check for crashed workers every 30s
    redisConfig: { host: '127.0.0.1', port: 6379 }
});

// Start consuming
worker.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
    await worker.stop();
    process.exit(0);
});