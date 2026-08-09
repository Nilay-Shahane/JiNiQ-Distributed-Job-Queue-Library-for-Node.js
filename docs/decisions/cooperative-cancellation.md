# ADR: Cooperative Cancellation (AbortController) over Thread Killing

## Context

When a job executes, it is racing against two clocks:

1. **The Execution Timeout (`maxTimeoutMs`)**
2. **The Heartbeat Lease (The Sweeper)**

If a job runs too long, or if the worker loses network connectivity and its Redis lock expires, the `JobExecutor` must halt the processing of that job immediately.

However, Node.js is single-threaded. If the user's `processorFn` is executing an asynchronous task (like a heavy database query or an external API fetch), Node.js has no built-in way to forcefully "kill" that specific function from the outside without terminating the entire Node process.

We had two choices for stopping runaway jobs:

1. **Process/Thread Isolation:** Run every job in a separate Child Process or Worker Thread and `process.kill()` it.
2. **Cooperative Cancellation:** Pass a signal to the job and require the user's code to listen for it.

## Decision

JiNiQ uses **Cooperative Cancellation via standard Web `AbortController**`.

When `Supervisor` hands a job to `JobExecutor`, it creates an `AbortController`. The executor passes `controller.signal` into the user's `processorFn(payload, signal)`.

If the job times out, or if `HeartBeat` detects that the lock was stolen/lost, JiNiQ calls `controller.abort()`.

## Alternatives considered

### Worker Threads / Child Processes

Spin up a new `Worker Thread` for every claimed job. If it times out, call `thread.terminate()`.

* **Why rejected:** Spawning threads in Node.js is incredibly expensive (memory and CPU). Since Node.js excels at I/O-bound tasks, forcing users to pay the overhead of multi-threading just to gain "force kill" capabilities would drastically reduce JiNiQ's maximum concurrency and throughput.

### Silent Abandonment (Orphaned Promises)

Just let the timeout reject the Promise, log an error, and let the user's function keep running invisibly in the background.

* **Why rejected:** This causes dangerous side effects. If a job loses its lease, the Sweeper will re-assign it to Worker B. If Worker A's abandoned promise is still running in the background, both workers might charge a customer's credit card or send the same email. Execution *must* be halted.

## Consequences

### Positive

* **Maximum Performance:** Jobs run in the main event loop, allowing thousands of concurrent I/O jobs with negligible overhead.
* **Standard Web APIs:** `AbortSignal` is natively supported by modern `fetch`, `axios`, and most Node.js core modules (`fs`, `stream`), making it easy for developers to plug the signal directly into their long-running tasks.

### Negative

* **Developer Responsibility:** JiNiQ cannot magically stop a `while(true)` loop. The developer *must* actively respect the `signal` in their code (e.g., passing it to their API calls or checking `signal.aborted` in loops). If they ignore it, the job will continue consuming memory in the background even after JiNiQ marks it as Failed.

---

Let me know when you're ready for the third and final one (Pipelined Bulk Chunking)!