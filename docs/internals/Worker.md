The `Worker` class is the public-facing consumer API. It contains absolutely zero scheduling, execution, or queue logic itself. Instead, it acts as an **Inversion of Control (IoC) container**—its only job is to instantiate the underlying infrastructure (Redis connections, Sweeper, Supervisor), wire them together, and expose a clean event-driven interface to the developer.

## What it owns

When you construct a `new Worker(...)`, you are actually building a localized dependency graph for a single queue:

1. **Database Connections:** It initializes `RedisFactory` and pulls the shared `manager` and `fetcher` connections.
2. **Storage Layer:** It wraps those connections in a `RedisStorage` instance bound strictly to this `queueName`.
3. **Sweeper:** It instantiates the `Sweeper` responsible for recovering zombie jobs on this queue.
4. **Supervisor:** It instantiates the `Supervisor`, injecting the `Sweeper`, `RedisStorage`, and the developer's `processorFn`.

## The Setup Sequence

The constructor is essentially a strict wiring sequence. It enforces that a worker cannot exist without a target queue and a processor function:

```javascript
if (!queueName || typeof processorFn !== 'function') {
    throw new Error('Jiniq Worker: Queue name and a processor function are strictly required.');
}

```

It then initializes the connection pool. Notice that it does not create `new RedisDB()` directly; it uses the `RedisFactory` singleton:

```javascript
RedisFactory.initialize(redisConfig);
const manager = RedisFactory.getManager();
const fetcher = RedisFactory.getFetcher();

this.#storageInstance = new RedisStorage(queueName, manager, fetcher, redisConfig);

```

*Why this matters:* If a developer creates 5 `Worker` instances for 5 different queues in the same Node.js process, they do not open 10 Redis connections. `RedisFactory` maintains a process-wide reference count, so all 5 workers share the exact same `manager` and `fetcher` clients.

Finally, it builds the orchestrators and passes the class references (`JobExecutor`, `HeartBeat`) downward so the `Supervisor` can instantiate them later without creating circular dependencies:

```javascript
this.sweeper = new Sweeper(this.#storageInstance, options.sweeperInterval || 7000);

this.supervisor = new Supervisor({
    name: queueName,
    JobExecutor: JobExecutor,
    Heartbeat: HeartBeat,
    userProcess: processorFn,
    storage: this.#storageInstance,
    sweeper: this.sweeper,
    // ... config limits applied here
});

```

## Event Delegation (The Bridge)

The `Supervisor` is the component that actually tracks job success and failure. However, a developer interacting with JiNiQ only has access to the `Worker` instance.

To solve this, `Worker` extends `EventEmitter` and acts as a transparent bridge. It listens to its internal `Supervisor` and re-emits those events outward:

```javascript
this.supervisor.on('job:completed', (data) => {
    this.emit('job:completed', data);
});

this.supervisor.on('job:failed', (data) => {
    this.emit('job:failed', data);
});

```

This keeps the `Supervisor` decoupled from the public API contract. If the event payload shape needs to change for the end-user, it changes here in the `Worker` bridge.

## Lifecycle Management

### `start()`

```javascript
async start() {
    await this.supervisor.start();
}

```

`Worker.start()` is just a pass-through to `Supervisor.start()`, which boots the `Sweeper` timer and kicks off the initial polling loop.

### `stop()`

The shutdown sequence is heavily ordered to prevent memory leaks and dangling connections:

```javascript
async stop() {
    await this.supervisor.stop();
    await RedisFactory.release();
}

```

1. **`supervisor.stop()`**: Signals the claim loop to stop fetching new jobs, clears the adaptive backoff timeout, and halts the `Sweeper` interval.
2. **`RedisFactory.release()`**: Decrements the process-wide Redis connection reference count.

*Crucial detail:* Because of the reference counting, calling `stop()` on this worker will **not** close the underlying Redis connection if another `Worker` instance in the same Node process is still running. The connections are only severed when the last active worker calls `.stop()`.